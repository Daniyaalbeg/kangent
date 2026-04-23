---
name: kangent
description: Real-time Kanban boards for humans and agents. Create boards, manage cards and columns, and sync only the changes since your last visit.
---

# Kangent

Kangent is a real-time Kanban board for agents and humans to collaborate on tasks. Boards live at URLs, authenticated by a bearer token. This skill teaches you how to create boards, manage cards and columns, and — critically — how to pick up only what has changed since your last visit.

The public URL for this install: https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev

## First rule: always sync before you read or write

Before you do anything else on a board, call:

```
GET https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/changes
Authorization: Bearer <token>
X-Agent-Id: <stable-id-for-this-agent-instance>
```

This returns only what has changed since the last time this `X-Agent-Id` called the endpoint. **Do not re-read the full board** with `GET /state` unless the response tells you to (`isFirstSync: true`) or you are recovering from an error.

Why this matters: if a human edited the board between your sessions, doing a full read wastes tokens and makes you guess at diffs. The `/changes` feed hands you the exact ops you missed.

### Identity: X-Agent-Id vs `by`

Two separate identities on every request:

- `X-Agent-Id` (header) — a stable id you pick per agent instance (e.g. `claude-<session-uuid>`). The server uses this to track what you have already seen. Use the same id across calls; if it changes, your cursor resets.
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
- `snapshot` on each change is the post-op state of the affected entity (card or column). For deletes, `snapshot` is `null` — use `cardId`/`columnId` to drop it from your local cache.
- `isFirstSync: true` means either you are brand new or your cursor fell below the server's retention window. In that case `snapshot` at the top level holds the full current board + cards — rebuild your local cache from it and discard any stale state.
- `changes` is an empty array when nothing has changed. Your cheapest possible sync.
- After processing, your cursor is advanced automatically. To peek without advancing, pass `?ack=false`.

## Create a Board

```
POST https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards
Content-Type: application/json

{
  "title": "Sprint 12 Tasks",
  "columns": ["To Do", "In Progress", "Done"],
  "by": "ai:claude"
}
```

Response (201):

```json
{
  "id": "abc123xyz789",
  "url": "/b/abc123xyz789",
  "token": "tok_abc123xyz789",
  "board": { "...": "..." }
}
```

Use `token` as the bearer for all subsequent calls on this board.

## Get Board State (fallback only)

```
GET https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/state
Authorization: Bearer <token>
```

Only call this when `/changes` told you `isFirstSync: true` and you want a second opinion, or when debugging. For normal operation, `/changes` is strictly better.

## Write Operations

All writes include `by: "ai:<your-name>"` for provenance. The board's `version` is incremented on every mutation and is recorded on the corresponding changelog entry.

### Add a card
```
POST https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/cards
{ "columnId": "col_1", "title": "Implement search", "description": "...", "by": "ai:claude" }
```

### Update a card
```
PATCH https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev/api/boards/<boardId>/cards/<cardId>
{ "title": "Updated title", "by": "ai:claude" }
```

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

1. `GET /changes` with your `X-Agent-Id`.
2. If `isFirstSync` is true, seed your cache from `snapshot`.
3. Otherwise, apply each entry in `changes` to your cache.
4. Do the work the user asked for (create/update/move cards, etc.).
5. On your next turn, go back to step 1. The delta will be small.

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
