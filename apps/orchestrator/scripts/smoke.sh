#!/usr/bin/env bash
# End-to-end smoke test for the @kangent/cli orchestrator.
#
# Exercises the full dispatch pipeline against a running Kangent worker:
#
#   Phase 0 — build packages + run unit tests
#   Phase 1 — seed a board with three cards (1 ready, 1 blocked, 1 filtered)
#   Phase 2 — `kangent doctor` preflight
#   Phase 3 — `kangent run --dry-run` (no writes, verifies blocker rule)
#   Phase 4 — `kangent run --fake-codex --once` (workspace + hooks + tracker write)
#   Phase 5 — Regression: non-"Todo" entry state (`Backlog/Doing/Done` board)
#   Phase 6 — Daemon loop (optional, behind WITH_DAEMON=1)
#   Phase 7 — Real codex turn (optional, behind WITH_REAL_CODEX=1)
#
# Prerequisites:
#   - `pnpm dev` running in another terminal (the Kangent worker)
#   - `jq` on PATH
#   - For Phase 7: `codex` on PATH, authenticated (`codex auth status` clean)
#
# Env knobs:
#   KANGENT=<url>          Worker URL (default http://localhost:8787)
#   TMP_ROOT=<dir>         Where workspaces + WORKFLOW.md fixtures land
#                          (default /tmp/kangent-smoke)
#   SKIP_BUILD=1           Don't rebuild before running
#   SKIP_UNIT=1            Don't run the vitest suite
#   WITH_DAEMON=1          Run the daemon-loop phase (adds ~15s)
#   WITH_REAL_CODEX=1      Run the real-codex phase (adds ~30-60s + uses model credits)
#
# Exit: 0 on full success, 1 if any phase failed.

set -uo pipefail

# ---------------------------------------------------------------- config ---

KANGENT="${KANGENT:-http://localhost:8787}"
TMP_ROOT="${TMP_ROOT:-/tmp/kangent-smoke}"
ACTOR="human:smoke-test"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_UNIT="${SKIP_UNIT:-0}"
WITH_DAEMON="${WITH_DAEMON:-0}"
WITH_REAL_CODEX="${WITH_REAL_CODEX:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI_DIST="$REPO_ROOT/apps/orchestrator/dist/cli/main.js"
CLI=(node "$CLI_DIST")

FAIL_COUNT=0
PHASE="<no phase>"

# Boards created so we can show them in the summary (Kangent has no
# delete-board endpoint today, so we accept the leak).
CREATED_BOARDS=()

# ----------------------------------------------------------------- ui ---

c_red()    { printf '\033[31m%s\033[0m' "$1"; }
c_green()  { printf '\033[32m%s\033[0m' "$1"; }
c_yellow() { printf '\033[33m%s\033[0m' "$1"; }
c_blue()   { printf '\033[34m%s\033[0m' "$1"; }
c_bold()   { printf '\033[1m%s\033[0m' "$1"; }

log_phase() {
	echo
	c_bold "── $1 ──"
	echo
	PHASE="$1"
}
pass() { echo "  $(c_green '✓') $1"; }
fail() {
	echo "  $(c_red '✗') $1"
	FAIL_COUNT=$((FAIL_COUNT + 1))
}
skip() { echo "  $(c_yellow '—') $1"; }
info() { echo "  $(c_blue '·') $1"; }

# ---------------------------------------------------------- assertions ---

assert_contains() {
	# $1 haystack, $2 needle, $3 desc
	local haystack="$1" needle="$2" desc="$3"
	if printf '%s' "$haystack" | grep -qF "$needle"; then
		pass "$desc"
	else
		fail "$desc — expected substring: $needle"
		printf '%s' "$haystack" | head -10 | sed 's/^/      | /'
	fi
}

assert_not_contains() {
	local haystack="$1" needle="$2" desc="$3"
	if printf '%s' "$haystack" | grep -qF "$needle"; then
		fail "$desc — unwanted substring present: $needle"
		printf '%s' "$haystack" | head -10 | sed 's/^/      | /'
	else
		pass "$desc"
	fi
}

assert_eq() {
	# $1 actual, $2 expected, $3 desc
	if [ "$1" = "$2" ]; then
		pass "$3"
	else
		fail "$3 — expected '$2', got '$1'"
	fi
}

assert_card_in_column() {
	# $1 board id, $2 card identifier, $3 expected column title
	local board="$1" ident="$2" expected="$3"
	local state cid actual
	state=$(curl -sf "$KANGENT/api/boards/$board/state") || {
		fail "could not GET /state for board $board"
		return
	}
	cid=$(printf '%s' "$state" | jq -r --arg id "$ident" \
		'.cards[] | select(.identifier==$id) | .columnId')
	if [ -z "$cid" ] || [ "$cid" = "null" ]; then
		fail "card $ident not found on board $board"
		return
	fi
	actual=$(printf '%s' "$state" | jq -r --arg cid "$cid" \
		'.board.columns[] | select(.id==$cid) | .title')
	if [ "$actual" = "$expected" ]; then
		pass "$ident is in column \"$expected\""
	else
		fail "$ident expected in \"$expected\", was in \"$actual\""
	fi
}

# ----------------------------------------------------------- helpers ---

require_cmd() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "$(c_red 'ERROR'): \`$1\` is required but not on PATH."
		[ -n "${2:-}" ] && echo "       $2"
		exit 2
	fi
}

worker_alive() {
	curl -sf --max-time 2 "$KANGENT/.well-known/kangent.json" >/dev/null 2>&1
}

create_board() {
	# $1 title, $2... column titles (optional)
	local title="$1"
	shift
	local cols_json="null"
	if [ "$#" -gt 0 ]; then
		cols_json=$(printf '%s\n' "$@" | jq -R . | jq -s .)
	fi
	local body
	body=$(jq -n --arg title "$title" --argjson cols "$cols_json" --arg by "$ACTOR" \
		'{title: $title, columns: ($cols // null), by: $by}
		 | with_entries(select(.value != null))')
	local res
	res=$(curl -sf -X POST "$KANGENT/api/boards" \
		-H 'Content-Type: application/json' \
		-d "$body") || {
		fail "POST /api/boards failed (title=$title)"
		return 1
	}
	local id
	id=$(printf '%s' "$res" | jq -r '.id')
	CREATED_BOARDS+=("$id|$title")
	echo "$id"
}

create_card() {
	# $1 board id, $2 column id, $3 title, $4 labels-json, $5 blockedBy-json
	local board="$1" col="$2" title="$3" labels="${4:-[]}" blockedBy="${5:-[]}"
	local body
	body=$(jq -n \
		--arg col "$col" --arg title "$title" --argjson labels "$labels" \
		--argjson blockedBy "$blockedBy" --arg by "$ACTOR" \
		'{columnId: $col, title: $title, labels: $labels, blockedBy: $blockedBy, by: $by}')
	curl -sf -X POST "$KANGENT/api/boards/$board/cards" \
		-H 'Content-Type: application/json' \
		-d "$body" | jq -r '.card.identifier'
}

move_card_by_identifier() {
	# $1 board id, $2 card identifier, $3 destination column title
	local board="$1" ident="$2" dest_title="$3"
	local state cid dest_col card_id
	state=$(curl -sf "$KANGENT/api/boards/$board/state")
	card_id=$(printf '%s' "$state" | jq -r --arg id "$ident" \
		'.cards[] | select(.identifier==$id) | .id')
	dest_col=$(printf '%s' "$state" | jq -r --arg t "$dest_title" \
		'.board.columns[] | select(.title==$t) | .id')
	curl -sf -X POST "$KANGENT/api/boards/$board/cards/$card_id/move" \
		-H 'Content-Type: application/json' \
		-d "{\"toColumnId\":\"$dest_col\",\"position\":0,\"by\":\"$ACTOR\"}" \
		>/dev/null
}

write_workflow() {
	# $1 path, $2 board id, $3 (optional) active_states YAML array, $4 (optional) terminal YAML array
	local path="$1" board="$2"
	local active_arr="${3:-[\"Todo\", \"In Progress\"]}"
	local terminal_arr="${4:-[\"Done\"]}"
	local ws="$TMP_ROOT/workspaces/$board"
	mkdir -p "$ws"
	cat >"$path" <<EOF
---
tracker:
  kind: kangent
  active_states: $active_arr
  terminal_states: $terminal_arr
  kangent:
    endpoint: $KANGENT
    board_id: $board
    label_filter: ["agent-ready"]
    label_exclude: ["wip"]

workspace:
  root: $ws

hooks:
  after_create: |
    echo "[after_create] \$KANGENT_ISSUE_IDENTIFIER"
    touch FRESHLY_CREATED
  before_run: echo "[before_run] \$KANGENT_ISSUE_IDENTIFIER"
  after_run: echo "[after_run] \$KANGENT_ISSUE_IDENTIFIER"
  timeout_ms: 30000

polling:
  interval_ms: 3000

codex:
  command: codex app-server
  turn_timeout_ms: 120000
---

You are working on **{{ issue.identifier }} — {{ issue.title }}**.
Reply with the word "done" and stop.
EOF
}

cleanup() {
	if [ -d "$TMP_ROOT" ]; then
		rm -rf "$TMP_ROOT" 2>/dev/null || true
	fi
}
trap cleanup EXIT

# --------------------------------------------------------------- phases ---

phase_0_setup() {
	log_phase "Phase 0 — Setup"

	require_cmd jq "Install with: brew install jq  /  apt install jq"
	require_cmd node
	require_cmd pnpm "Install with: npm i -g pnpm"

	if ! worker_alive; then
		echo "$(c_red 'ERROR'): no Kangent worker reachable at $KANGENT"
		echo "       start it first in another terminal:"
		echo "         pnpm dev"
		echo "       (or override KANGENT=<url>)"
		exit 2
	fi
	pass "kangent worker reachable at $KANGENT"

	if [ "$SKIP_BUILD" = "1" ]; then
		if [ ! -f "$CLI_DIST" ]; then
			echo "$(c_red 'ERROR'): SKIP_BUILD=1 but $CLI_DIST is missing."
			exit 2
		fi
		skip "build (SKIP_BUILD=1)"
	else
		(cd "$REPO_ROOT" && pnpm --filter @kangent/cli build) >/dev/null
		pass "CLI built"
	fi

	if [ "$SKIP_UNIT" = "1" ]; then
		skip "unit tests (SKIP_UNIT=1)"
	else
		local out
		if out=$(cd "$REPO_ROOT" && pnpm --filter @kangent/cli test 2>&1); then
			local count
			count=$(printf '%s' "$out" | grep -oE 'Tests +[0-9]+ passed' | tail -1)
			pass "unit tests pass ($count)"
		else
			fail "unit tests failed"
			printf '%s' "$out" | tail -20 | sed 's/^/      | /'
		fi
	fi

	rm -rf "$TMP_ROOT"
	mkdir -p "$TMP_ROOT"
	info "fixtures: $TMP_ROOT"
}

phase_1_seed() {
	log_phase "Phase 1 — Seed test board"

	BOARD_DEFAULT=$(create_board "smoke-default") || return
	pass "created default board $BOARD_DEFAULT"

	local state todo
	state=$(curl -sf "$KANGENT/api/boards/$BOARD_DEFAULT/state")
	todo=$(printf '%s' "$state" | jq -r '.board.columns[0].id')

	C1=$(create_card "$BOARD_DEFAULT" "$todo" "ready card" '["agent-ready"]')
	C2=$(create_card "$BOARD_DEFAULT" "$todo" "blocked card" \
		'["agent-ready"]' "[\"$C1\"]")
	C3=$(create_card "$BOARD_DEFAULT" "$todo" "wip card" '["wip"]')

	pass "ready=$C1  blocked=$C2  filtered=$C3"

	write_workflow "$TMP_ROOT/default.md" "$BOARD_DEFAULT"
	info "workflow: $TMP_ROOT/default.md"
}

phase_2_doctor() {
	log_phase "Phase 2 — kangent doctor"

	local out
	if ! out=$("${CLI[@]}" doctor "$TMP_ROOT/default.md" 2>&1); then
		fail "doctor exited non-zero"
		printf '%s' "$out" | sed 's/^/      | /'
		return
	fi
	assert_contains "$out" "✓ workflow load" "loads the workflow"
	assert_contains "$out" "✓ tracker.kangent.endpoint" "validates endpoint"
	assert_contains "$out" "✓ tracker.kangent.board_id" "validates board id"
	# 2 candidates expected — card 3 ("wip") filtered by label_exclude.
	# Note doctor calls fetchCandidateIssues which already excludes
	# blocked cards from the count.
	assert_contains "$out" "tracker probe — 2 candidate" "label_exclude works"
	assert_contains "$out" "All checks passed" "all checks green"
}

phase_3_dry_run() {
	log_phase "Phase 3 — Dry-run dispatch"

	local out
	out=$("${CLI[@]}" run "$TMP_ROOT/default.md" --dry-run --once 2>&1) || {
		fail "run --dry-run exited non-zero"
		printf '%s' "$out" | sed 's/^/      | /'
		return
	}
	assert_contains "$out" "Poll: 2 candidates, 1 ready, 1 blocked" \
		"blocker rule classifies cards correctly"
	assert_contains "$out" "Would dispatch (sorted):" \
		"dry-run prints intent without dispatching"
	assert_contains "$out" "$C1" "ready card $C1 listed"
	assert_contains "$out" "Blocked by non-terminal blockers:" \
		"prints the blocked section"
	assert_contains "$out" "$C2" "blocked card $C2 listed"
	assert_contains "$out" "dry-run: no tracker writes attempted" \
		"dry-run announces no-write mode"

	# Verify NO writes happened — cards should all still be in the entry state.
	assert_card_in_column "$BOARD_DEFAULT" "$C1" "Todo"
	assert_card_in_column "$BOARD_DEFAULT" "$C2" "Todo"
}

phase_4_fake_codex() {
	log_phase "Phase 4 — Fake codex dispatch (workspace + hooks + write)"

	local out
	out=$("${CLI[@]}" run "$TMP_ROOT/default.md" --fake-codex --once 2>&1) || {
		fail "run --fake-codex exited non-zero"
		printf '%s' "$out" | sed 's/^/      | /'
		return
	}

	assert_contains "$out" "[after_create] $C1" "after_create ran for $C1"
	assert_contains "$out" "[before_run] $C1" "before_run ran for $C1"
	assert_contains "$out" "[after_run] $C1" "after_run ran for $C1"
	assert_contains "$out" "✓ $C1" "$C1 reports completed outcome"
	assert_contains "$out" "1 completed, 0 failed" "summary matches"

	# The fake codex succeeds → orchestrator leaves the card in working state.
	# (Real codex would move it to a terminal state via tool call.)
	assert_card_in_column "$BOARD_DEFAULT" "$C1" "In Progress"

	# Filesystem assertions: workspace + sentinel exist.
	local ws="$TMP_ROOT/workspaces/$BOARD_DEFAULT/$C1"
	if [ -d "$ws" ]; then
		pass "workspace created at $ws"
	else
		fail "workspace dir missing: $ws"
	fi
	if [ -f "$ws/.kangent-ready" ]; then
		pass "sentinel .kangent-ready written"
	else
		fail "sentinel missing — after_create rollback fired?"
	fi
	if [ -f "$ws/FRESHLY_CREATED" ]; then
		pass "after_create touched FRESHLY_CREATED"
	else
		fail "after_create didn't run the touch"
	fi

	# Idempotency: re-running shouldn't re-fire after_create.
	rm -f "$ws/FRESHLY_CREATED"  # remove the marker
	# Move card 1 back to entry so it's re-eligible.
	move_card_by_identifier "$BOARD_DEFAULT" "$C1" "Todo"
	local out2
	out2=$("${CLI[@]}" run "$TMP_ROOT/default.md" --fake-codex --once 2>&1)
	assert_not_contains "$out2" "[after_create] $C1" \
		"after_create skipped on second dispatch (sentinel works)"
	assert_contains "$out2" "[before_run] $C1" "before_run fires every dispatch"
	if [ ! -f "$ws/FRESHLY_CREATED" ]; then
		pass "FRESHLY_CREATED not re-created (after_create didn't re-fire)"
	else
		fail "after_create re-ran on already-prepared workspace"
	fi
}

phase_5_regression_entry_state() {
	log_phase "Phase 5 — Regression: non-'Todo' entry state"

	BOARD_BACKLOG=$(create_board "smoke-backlog" "Backlog" "Doing" "Done") || return
	pass "created Backlog/Doing/Done board $BOARD_BACKLOG"

	local state backlog
	state=$(curl -sf "$KANGENT/api/boards/$BOARD_BACKLOG/state")
	backlog=$(printf '%s' "$state" | jq -r '.board.columns[0].id')

	local BACK_C1
	BACK_C1=$(create_card "$BOARD_BACKLOG" "$backlog" "backlog smoke" '["agent-ready"]')
	pass "card $BACK_C1 created in Backlog"

	write_workflow "$TMP_ROOT/backlog.md" "$BOARD_BACKLOG" \
		'["Backlog", "Doing"]' '["Done"]'

	# Happy path: fake codex succeeds, card moves Backlog → Doing.
	# Before the fix, AgentRunner's `resolveWorkingState` filtered out
	# "todo" — but "Backlog" doesn't match that filter, so it would have
	# picked Backlog itself as the working state (no-op) or thrown.
	local out
	out=$("${CLI[@]}" run "$TMP_ROOT/backlog.md" --fake-codex --once 2>&1)
	assert_contains "$out" "✓ $BACK_C1" "fake codex succeeded on Backlog board"
	assert_card_in_column "$BOARD_BACKLOG" "$BACK_C1" "Doing"

	# Failure path: real (stubbed) codex fails → card should roll back to
	# Backlog (the configured entry), NOT to a literal "Todo".
	# Move it back first.
	move_card_by_identifier "$BOARD_BACKLOG" "$BACK_C1" "Backlog"
	out=$("${CLI[@]}" run "$TMP_ROOT/backlog.md" --once 2>&1 || true)
	assert_contains "$out" "✗ $BACK_C1" "$BACK_C1 reported failed (codex stubbed)"
	assert_card_in_column "$BOARD_BACKLOG" "$BACK_C1" "Backlog"
}

phase_6_daemon() {
	if [ "$WITH_DAEMON" != "1" ]; then
		skip "daemon-loop phase (set WITH_DAEMON=1 to enable, adds ~15s)"
		return
	fi
	log_phase "Phase 6 — Daemon loop"

	# Reset C1 to Todo so the first daemon tick has something to dispatch.
	move_card_by_identifier "$BOARD_DEFAULT" "$C1" "Todo"

	local logfile="$TMP_ROOT/daemon.log"
	local pid
	"${CLI[@]}" run "$TMP_ROOT/default.md" --fake-codex >"$logfile" 2>&1 &
	pid=$!
	# Wait long enough for ≥2 ticks (polling.interval_ms=3000).
	sleep 8
	if kill -INT "$pid" 2>/dev/null; then
		wait "$pid" 2>/dev/null || true
		pass "daemon accepted SIGINT and exited"
	else
		fail "could not signal daemon pid=$pid (did it crash?)"
	fi

	local daemon_out
	daemon_out=$(cat "$logfile")
	local ticks
	ticks=$(printf '%s' "$daemon_out" | grep -c '──── tick #' || true)
	if [ "$ticks" -ge 2 ]; then
		pass "daemon fired $ticks ticks"
	else
		fail "daemon fired only $ticks ticks (expected ≥2)"
		printf '%s' "$daemon_out" | tail -20 | sed 's/^/      | /'
	fi
	assert_contains "$daemon_out" "tick #1" "tick #1 logged"
	assert_contains "$daemon_out" "tick #2" "tick #2 logged"
}

phase_7_real_codex() {
	if [ "$WITH_REAL_CODEX" != "1" ]; then
		skip "real-codex phase (set WITH_REAL_CODEX=1 to enable)"
		return
	fi
	if ! command -v codex >/dev/null 2>&1; then
		skip "real-codex phase — codex binary not on PATH"
		return
	fi
	log_phase "Phase 7 — Real codex turn"

	# Reset C1 if it's not in entry already.
	move_card_by_identifier "$BOARD_DEFAULT" "$C1" "Todo" 2>/dev/null || true

	local out
	if out=$("${CLI[@]}" run "$TMP_ROOT/default.md" --once 2>&1); then
		assert_contains "$out" "✓ $C1" "real codex completed turn for $C1"
		assert_card_in_column "$BOARD_DEFAULT" "$C1" "In Progress"
	else
		fail "real codex run exited non-zero (auth issue? quota?)"
		printf '%s' "$out" | tail -15 | sed 's/^/      | /'
	fi
}

# --------------------------------------------------------------- main ---

main() {
	echo "$(c_bold '@kangent/cli — orchestrator smoke test')"
	echo "  worker:   $KANGENT"
	echo "  fixtures: $TMP_ROOT"

	phase_0_setup
	phase_1_seed
	phase_2_doctor
	phase_3_dry_run
	phase_4_fake_codex
	phase_5_regression_entry_state
	phase_6_daemon
	phase_7_real_codex

	echo
	c_bold "── Summary ──"
	echo
	if [ "${#CREATED_BOARDS[@]}" -gt 0 ]; then
		info "boards created (Kangent has no delete endpoint; you can leave them):"
		for entry in "${CREATED_BOARDS[@]}"; do
			local id="${entry%%|*}" title="${entry#*|}"
			echo "    $KANGENT/b/$id  ($title)"
		done
	fi
	echo
	if [ "$FAIL_COUNT" -eq 0 ]; then
		echo "$(c_green '✓ all phases passed')"
		exit 0
	else
		echo "$(c_red "✗ $FAIL_COUNT assertion(s) failed")"
		echo "  Last phase: $PHASE"
		exit 1
	fi
}

main "$@"
