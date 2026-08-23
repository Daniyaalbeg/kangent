---
name: kangent
description: Real-time Kanban boards for humans and agents. Create boards, manage cards and columns, and sync only the changes since your last visit.
---

# Kangent

Kangent is a real-time Kanban board for agents and humans to collaborate on tasks. Boards live at URLs. This skill teaches you how to create boards, manage cards and columns, and — critically — how to pick up only what has changed since your last visit.

The public URL for this install: https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev

## First step: figure out which board you're on

A new chat has no memory of boards from a previous chat. Before doing anything else, resolve the board id using this order:

1. **Did the user mention a URL or id?** If their message contains `…/b/<id>` or `…/api/boards/<id>`, extract that id. Use it.
2. **Is there a recent board for this project?** Read `~/.kangent/state.yaml` (see shape below). Find entries whose `project` matches the current working directory, sort by `lastAccessedAt` descending, and use the most recent. If multiple match, tell the user which one you picked and offer to switch.
3. **Is there an `activeBoardId` set?** If `activeBoardId` is present at the top of `state.yaml`, use it.
4. **Otherwise**: list the recent boards from `state.yaml`'s `boards` map and ask the user which one to use, or whether to create a new one.

After resolving, **always record the access** (see "Recording board access" below). That keeps the registry accurate for the next chat.

### `~/.kangent/state.yaml` — the local board registry

A single YAML file shared by every Kangent agent on this machine (Codex, Claude Code, Cursor, etc.). Read it before touching any board, write to it after every successful create/visit. Permissions are `0600` (owner-readable only) — treat URLs in there as semi-secret since Kangent boards are auth-less.

YAML over JSON because agents (and you) read this file directly: comments are allowed, fields are in a stable order, and titles with punctuation don't need escaping. Strings are double-quoted on write to keep round-trips clean.

```yaml
# Kangent agent state — managed by any agent that follows this convention.
# Safe to read by hand; safe to edit if you know what you're doing.
version: 1
agentId: "agent-7e2c4f9a-..."
activeBoardId: "abc123xyz789"
boards:
  abc123xyz789:
    id: "abc123xyz789"
    url: "https://kangent.dev/b/abc123xyz789"
    title: "Sprint 12 Tasks"
    origin: "created"
    project: "/Users/bavan/Documents/Developer/projects/kangent"
    firstAccessedAt: "2026-04-22T09:42:01.123Z"
    lastAccessedAt: "2026-04-27T14:11:08.004Z"
    visitCount: 5
  q9z8y7x6w5v4:
    id: "q9z8y7x6w5v4"
    url: "https://kangent.dev/b/q9z8y7x6w5v4"
    title: "Marketing site relaunch"
    origin: "visited"
    project: "/Users/bavan/Documents/Developer/projects/marketing-site"
    firstAccessedAt: "2026-04-25T11:02:14.880Z"
    lastAccessedAt: "2026-04-26T17:30:00.001Z"
    visitCount: 2
```

Field rules:

- `agentId` — stable per machine. Compose your `X-Agent-Id` header as `<tool>-<agentId>` (e.g. `claude-agent-7e2c…`, `codex-agent-7e2c…`) so different tools get separate change-feed cursors on the same machine.
- `activeBoardId` — last board you recorded. Treat as a soft default; the project lookup wins if both are set.
- `boards[id].project` — the absolute cwd at record time, **not** a free-form name. Compare with resolved-path semantics so trailing slashes and `..` differences don't cause false misses.
- `boards[id].origin` — first-write-wins. If a board already has `origin: "created"`, never downgrade it to `"visited"`.
- All timestamps are ISO-8601 strings so a lexicographic sort matches a chronological sort.

### Recording board access

After **any** successful interaction with a board (creating, reading, writing), upsert its entry:

- **Create** (`POST /api/boards`): insert a new entry with `origin: "created"`, `project: <cwd>`, `firstAccessedAt = lastAccessedAt = now`, `visitCount: 1`. Set `activeBoardId` to the new id.
- **Visit** (any subsequent op on a board you didn't create): if no entry exists, insert one with `origin: "visited"`. If an entry exists, bump `lastAccessedAt` and `visitCount` and **leave `origin` alone** — sticky.

Atomic write recipe (avoids half-written files if the agent crashes mid-write):

```
write   ~/.kangent/state.yaml.tmp   (full YAML, mode 0600)
rename  ~/.kangent/state.yaml.tmp → ~/.kangent/state.yaml
```

Read and write the file with your built-in tools — the format above is the contract.

## First rule: always sync before you read or write

Before you do anything else on a board, call:

```
GET https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/changes
X-Agent-Id: <stable-id-for-this-agent-instance>
```

This returns only what has changed since the last time this `X-Agent-Id` called the endpoint. **Do not re-read the full board** with `GET /state` unless the response tells you to (`isFirstSync: true`) or you are recovering from an error.

Why this matters: if a human edited the board between your sessions, doing a full read wastes time and makes you guess at diffs. The `/changes` feed hands you the exact ops you missed.

### Identity: X-Agent-Id vs `by`

Two separate identities on every request:

- `X-Agent-Id` (header) — a stable id derived from the per-machine `agentId` in `~/.kangent/state.yaml`, prefixed by your tool name (e.g. `claude-agent-7e2c…`, `codex-agent-7e2c…`). The server uses this to track what you have already seen. Keep it stable across chats so the change-feed cursor advances naturally; if it changes, your cursor resets.
- `by` (body field) — write authorship (e.g. `"ai:claude"`, `"ai:codex"`). Goes on every write and shows up in the changelog so humans can see who did what.

### `/changes` response shape

```json
{
  "toVersion": 27,
  "fromVersion": 15,
  "isFirstSync": false,
  "snapshot": null,
  "changes": [
    {
      "version": 15,
      "op": "card:move",
      "cardId": "c_ab12",
      "columnId": "col_doing",
      "fromColumnId": "col_todo",
      "snapshot": { "id": "c_ab12", "title": "...", "columnId": "col_doing", "...": "..." },
      "by": "human:anonymous",
      "at": "2026-04-22T09:42:01.123Z"
    },
    { "version": 16, "op": "card:add", "...": "..." }
  ]
}
```

Rules:

- `changes` is ordered oldest-first. Apply in sequence.
- `snapshot` on each change is the post-op state of the affected entity (`Board` for `board:update`, `Card` for card ops, `Column` for column add/update). For deletes and reorders, `snapshot` is `null` — use `cardId` / `columnId` / `columnIds` to update your local cache.
- `isFirstSync: true` means either you are brand new or your cursor fell below the server's retention window. In that case `snapshot` at the top level holds the full current board + cards — rebuild your local cache from it and discard any stale state.
- `changes` is an empty array when nothing has changed. Your cheapest possible sync.
- After processing, your cursor is advanced automatically. To peek without advancing, pass `?ack=false`.

## Create a Board

```
POST https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards
Content-Type: application/json

{
  "title": "Sprint 12 Tasks",
  "columns": ["Todo", "In Progress", "Done"],
  "by": "ai:claude"
}
```

Response (201):

```json
{
  "id": "abc123xyz789",
  "url": "/b/abc123xyz789",
  "board": { "...": "..." }
}
```

Use the returned `id` / `url` for all subsequent calls on this board, and **immediately upsert it into `~/.kangent/state.yaml`** with `origin: "created"` and `project` set to the current working directory. That's how the next chat finds it.

## Edit Board Metadata (rename / update description)

```
PATCH https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>
{ "title": "Sprint 12 — wrap-up", "description": "Carry-over and bugfixes only.", "by": "ai:claude" }
```

Response (200):

```json
{
  "board": { "id": "abc123xyz789", "title": "Sprint 12 — wrap-up", "...": "..." },
  "version": 28
}
```

Rules:

- Both `title` and `description` are optional. Send only the fields you want to change. Sending neither is a no-op (the server will return the current board without bumping `version`).
- Empty `title` (after trim) is rejected with `400 ValidationError`.
- Pass `description: null` to **clear** the description; pass a string to set it; omit to leave it alone.
- Emits a `board:update` change with the full new `Board` as the snapshot. Update the title in `~/.kangent/state.yaml` for this board id when you observe one.

## Get Board State (fallback only)

```
GET https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/state
```

Response (200):

```json
{
  "board": {
    "id": "abc123xyz789",
    "title": "Sprint 12 Tasks",
    "columns": [{ "id": "col_1", "title": "Todo", "cardIds": ["c_ab12"], "...": "..." }],
    "nextCardSeq": 8,
    "version": 27,
    "...": "..."
  },
  "cards": [
    { "id": "c_ab12", "identifier": "abc123xyz789-1", "columnId": "col_1", "title": "...", "...": "..." }
  ],
  "presence": [
    { "id": "ai:claude", "status": "working", "message": "Adding tasks" }
  ]
}
```

`cards` is a sibling of `board` (not nested under it). Each `Column.cardIds` references the cards by their opaque `id`; cross-reference into the `cards` array to materialise the column's contents.

Only call this when `/changes` told you `isFirstSync: true` and you want a second opinion, or when debugging. For normal operation, `/changes` is strictly better.

## Write Operations

All writes include `by: "ai:<your-name>"` for provenance. The board's `version` is incremented on every mutation and is recorded on the corresponding changelog entry.

### Add a card
```
POST https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/cards
{
  "columnId": "col_1",
  "title": "Implement search",
  "description": "...",
  "priority": "high",
  "dueDate": "2026-05-20",
  "labels": ["backend", "search"],
  "blockedBy": ["<boardId>-3"],
  "by": "ai:claude"
}
```

`labels` and `blockedBy` are optional lists. The server rejects empty strings and duplicates within the list and preserves case. `blockedBy` entries are card **identifiers** (see "Card identifier" below), not internal `id`s — easier to read in logs and stable across deletes/recreates.

### Update a card
```
PATCH https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/cards/<cardId>
{ "title": "Updated title", "labels": ["backend"], "by": "ai:claude" }
```

`labels` and `blockedBy` use **full-replace** semantics: omit them to leave the existing list alone, pass `[]` to clear, pass a list to overwrite.

### Card identifier

Every card has both an opaque `id` (used in URL paths) and a human-readable `identifier` of the form `<boardId>-<seq>` (e.g. `f3a2b1c4d5e6-1`). The identifier is server-stamped on creation, never reused, and survives deletes — quote it in logs and `blockedBy` lists. Cards created before identifiers existed are backfilled lazily on first access.

### Move a card
```
POST https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/cards/<cardId>/move
{ "toColumnId": "col_2", "position": 0, "by": "ai:claude" }
```

### Delete a card
```
DELETE https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/cards/<cardId>?by=ai:claude
```

### Columns
```
POST   https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/columns          { "title": "QA", "by": "ai:claude" }
PATCH  https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/columns/<colId>  { "title": "Done", "by": "ai:claude" }
DELETE https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/columns/<colId>?moveCardsTo=col_2&by=ai:claude
```

Deleting a non-empty column without `moveCardsTo` returns `409 ColumnNotEmpty`.

## Presence

Tell humans you're there:

```
POST https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/presence
{ "by": "ai:claude", "status": "working", "message": "Adding tasks" }
```

Statuses: `viewing`, `working`, `idle`.

## Typical agent loop

1. **Resolve the board id** (URL in user message → `~/.kangent/state.yaml` project lookup → `activeBoardId` → ask).
2. `GET /changes` with your `X-Agent-Id` (`<tool>-<agentId>` from `state.yaml`).
3. If `isFirstSync` is true, seed your cache from `snapshot`.
4. Otherwise, apply each entry in `changes` to your cache.
5. Do the work the user asked for (create/update/move cards, etc.).
6. **Upsert this board's entry** in `~/.kangent/state.yaml` (bump `lastAccessedAt`, set `activeBoardId`).
7. On your next turn, go back to step 1. The delta will be small.

## Error Handling

| Status | Body `_tag`       | Meaning                              |
|--------|--------------------|--------------------------------------|
| 400    | —                  | Missing/invalid params (incl. missing `X-Agent-Id` on `/changes`) |
| 404    | `BoardNotFound`  | `boardId` doesn't exist             |
| 404    | `CardNotFound`   | `cardId` doesn't exist              |
| 404    | `ColumnNotFound` | `columnId` doesn't exist            |
| 409    | `ColumnNotEmpty` | Deleting a non-empty column; pass `moveCardsTo` |

## Tips

- Use the same `X-Agent-Id` for the whole session so the cursor stays correct.
- Always include `"by": "ai:<your-name>"` on writes.
- If you think the server is wrong, the changelog entry has `by` and `at` — check who did what before assuming bugs.
