/**
 * Kangent tracker adapter. Implements the `Tracker` interface against the
 * shared `KangentApi` definition exported by `@kangent/board-core`. Both
 * server and CLI are on Effect v4, so the typed client comes for free.
 *
 * The adapter is intentionally simple for v1: every fetch hits
 * `GET /state` and filters in-memory. Kangent caps at 500 cards/column,
 * so this is cheap. When that hurts (or when we add a `cards?states=...`
 * server-side filter), swap method bodies — the `Tracker` interface
 * doesn't change.
 */

import { type ActorId, KangentApi } from "@kangent/board-core";
import { Effect, Layer } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { TrackerError } from "../domain/errors.js";
import {
	type Issue,
	makeMapCardContext,
	mapCardToIssue,
} from "../domain/Issue.js";
import { Tracker } from "./Tracker.js";
import { WorkflowConfig } from "./WorkflowLoader.js";

// --- Error formatting helper -------------------------------------------

/**
 * Render an unknown failure (typically an `HttpApi` error class — tagged
 * but not necessarily an `Error` subclass) into a single line. Preserves
 * `_tag` and any other own enumerable fields so server-side
 * `BoardNotFound` / `CardNotFound` show up clearly in CLI output.
 */
function formatCause(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	if (cause && typeof cause === "object") {
		try {
			const obj = cause as Record<string, unknown>;
			const tag = obj._tag ? String(obj._tag) : null;
			const rest: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(obj)) {
				if (k === "_tag") continue;
				rest[k] = v;
			}
			const tail =
				Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
			return tag ? `${tag}${tail}` : JSON.stringify(obj);
		} catch {
			return String(cause);
		}
	}
	return String(cause);
}

// --- URL → board-id helper ----------------------------------------------

/**
 * Resolve the configured board id from `tracker.kangent.board_id` or
 * `tracker.kangent.board_url`. The CLI may also resolve from
 * `~/.kangent/state.yaml` ahead of time — that's a CLI concern, not a
 * tracker one.
 */
function resolveBoardId(
	board_id: string | undefined,
	board_url: string | undefined,
): string | null {
	if (board_id) return board_id;
	if (!board_url) return null;
	const m = board_url.match(/\/b\/([A-Za-z0-9_-]+)/);
	return m?.[1] ?? null;
}

// --- Filtering helpers --------------------------------------------------

function matchesState(needle: string, haystack: readonly string[]) {
	const n = needle.toLowerCase();
	return haystack.some((h) => h.toLowerCase() === n);
}

function passesLabelFilter(
	issue: Issue,
	allow: readonly string[],
	deny: readonly string[],
): boolean {
	if (deny.some((label) => issue.labels.includes(label))) return false;
	if (allow.length === 0) return true;
	return allow.some((label) => issue.labels.includes(label));
}

// --- Live layer ---------------------------------------------------------

/**
 * Tracker layer for `tracker.kind: kangent`. Requires `WorkflowConfig`
 * (for endpoint + board id + filters) and `HttpClient.HttpClient` (for
 * the underlying transport — usually `NodeHttpClient.layerUndici` or
 * `FetchHttpClient.layer` from `effect/unstable/http`, provided at the
 * AppLayer level).
 */
export const TrackerKangentLayer = Layer.effect(
	Tracker,
	Effect.gen(function* () {
		const loaded = yield* WorkflowConfig;
		const cfg = loaded.config.tracker.kangent;

		if (!cfg.endpoint) {
			return yield* Effect.fail(
				new TrackerError({
					code: "missing_tracker_endpoint",
					message:
						"tracker.kangent.endpoint is required (set it in WORKFLOW.md or via $KANGENT_ENDPOINT).",
				}),
			);
		}

		const boardId = resolveBoardId(cfg.board_id, cfg.board_url);
		if (!boardId) {
			return yield* Effect.fail(
				new TrackerError({
					code: "missing_tracker_board_id",
					message:
						"tracker.kangent.board_id (or board_url) is required to dispatch work.",
				}),
			);
		}

		const client = yield* HttpApiClient.make(KangentApi, {
			baseUrl: cfg.endpoint,
		});

		// --- Internal: one /state fetch -> {board, issues} ---
		//
		// Returns the raw `board` alongside the mapped issues so write
		// methods (moveIssueToState) can resolve "state name → column id"
		// without re-fetching. Symphony §11.1.2 expects writes to be
		// reasonably current; one extra fetch per write would double the
		// round-trips with no real benefit on a board capped at 500 cards.
		const fetchBoardAndIssues = () =>
			client.boards.getBoardState({ params: { boardId } }).pipe(
				Effect.map((res) => {
					const ctx = makeMapCardContext(
						cfg.endpoint as string,
						res.board,
						res.cards,
					);
					return {
						board: res.board,
						issues: res.cards.map((c) => mapCardToIssue(ctx, c)),
					};
				}),
				Effect.mapError(
					(cause) =>
						new TrackerError({
							code: "transport",
							message: formatCause(cause),
						}),
				),
			);

		const fetchAllIssues = (): Effect.Effect<readonly Issue[], TrackerError> =>
			fetchBoardAndIssues().pipe(Effect.map((r) => r.issues));

		const active = loaded.config.tracker.active_states;
		const terminal = loaded.config.tracker.terminal_states;

		return {
			fetchCandidateIssues: () =>
				fetchAllIssues().pipe(
					Effect.map((all) =>
						all
							.filter((i) => matchesState(i.state, active))
							.filter((i) => !matchesState(i.state, terminal))
							.filter((i) =>
								passesLabelFilter(i, cfg.label_filter, cfg.label_exclude),
							),
					),
				),

			fetchIssuesByStates: (states) =>
				fetchAllIssues().pipe(
					Effect.map((all) => all.filter((i) => matchesState(i.state, states))),
				),

			fetchIssueStatesByIds: (ids) =>
				fetchAllIssues().pipe(
					Effect.map((all) => all.filter((i) => ids.includes(i.id))),
				),

			moveIssueToState: ({ issue, toState, by }) =>
				fetchBoardAndIssues().pipe(
					Effect.flatMap(({ board }) => {
						const target = board.columns.find(
							(col) => col.title.toLowerCase() === toState.toLowerCase(),
						);
						if (!target) {
							return Effect.fail(
								new TrackerError({
									code: "unknown",
									message: `moveIssueToState: no column titled "${toState}" on board ${boardId}`,
								}),
							);
						}
						// Append to the end of the destination column. The
						// orchestrator doesn't care about per-column ordering;
						// humans can re-order in the UI.
						return client.boards
							.moveCard({
								params: { boardId, cardId: issue.id },
								payload: {
									toColumnId: target.id,
									position: target.cardIds.length,
									// The board-core ActorId brand is "any string" at
									// runtime; the brand only exists to prevent
									// accidental cross-use in callers. The cast keeps
									// the boundary explicit.
									by: by as ActorId,
								},
							})
							.pipe(
								Effect.asVoid,
								Effect.mapError(
									(cause) =>
										new TrackerError({
											code: "transport",
											message: formatCause(cause),
										}),
								),
							);
					}),
				),
		};
	}),
);
