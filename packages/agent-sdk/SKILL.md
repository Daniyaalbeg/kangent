# Kangent — Agent Skill File

Kangent is a real-time Kanban board for agents and humans to collaborate on tasks. Boards live at URLs. This skill file teaches you how to create boards, manage cards and columns, and collaborate with humans — all through a simple HTTP API.

## Create a Board

```
POST /api/boards
Content-Type: application/json

{
  "title": "Sprint 12 Tasks",
  "description": "Tasks for the current sprint",
  "columns": ["To Do", "In Progress", "Done"],
  "by": "ai:claude"
}
```

Response (201):
```json
{
  "id": "abc123xyz789",
  "url": "/b/abc123xyz789",
  "board": { ... }
}
```

Columns default to `["To Do", "In Progress", "Done"]` if omitted.

## Get Board State

```
GET /api/boards/:boardId/state
```

Response (200):
```json
{
  "board": {
    "id": "abc123xyz789",
    "title": "Sprint 12 Tasks",
    "version": 42,
    "columns": [
      {
        "id": "col_1",
        "title": "To Do",
        "position": 0,
        "cardIds": ["card_1", "card_2"]
      }
    ]
  },
  "presence": []
}
```

## Add a Card

```
POST /api/boards/:boardId/cards
Content-Type: application/json

{
  "columnId": "col_1",
  "title": "Implement search",
  "description": "Add full-text search to the dashboard.",
  "by": "ai:claude"
}
```

Response (201):
```json
{ "card": { "id": "card_7", ... }, "version": 44 }
```

## Update a Card

```
PATCH /api/boards/:boardId/cards/:cardId
Content-Type: application/json

{
  "title": "Implement search (v2)",
  "description": "Updated requirements...",
  "by": "ai:claude"
}
```

Response (200):
```json
{ "card": { "id": "card_7", ... }, "version": 45 }
```

## Move a Card

```
POST /api/boards/:boardId/cards/:cardId/move
Content-Type: application/json

{
  "toColumnId": "col_2",
  "position": 0,
  "by": "ai:claude"
}
```

Response (200):
```json
{ "card": { "id": "card_7", "columnId": "col_2", ... }, "version": 46 }
```

## Delete a Card

```
DELETE /api/boards/:boardId/cards/:cardId
```

Response (200):
```json
{ "deleted": "card_7", "version": 47 }
```

## Add a Column

```
POST /api/boards/:boardId/columns
Content-Type: application/json

{ "title": "QA Review", "by": "ai:claude" }
```

Response (201):
```json
{ "column": { "id": "col_4", "title": "QA Review", "position": 3 }, "version": 43 }
```

## Update a Column

```
PATCH /api/boards/:boardId/columns/:columnId
Content-Type: application/json

{ "title": "Done (Verified)", "by": "ai:claude" }
```

## Delete a Column

```
DELETE /api/boards/:boardId/columns/:columnId
```

If the column has cards, pass `moveCardsTo` header with the target column ID.

## Agent Presence

```
POST /api/boards/:boardId/presence
Content-Type: application/json

{
  "by": "ai:claude",
  "status": "working",
  "message": "Adding tasks for the auth module"
}
```

## Error Responses

```json
{ "_tag": "BoardNotFound", "boardId": "abc123" }       // 404
{ "_tag": "CardNotFound", "cardId": "card_99" }         // 404
{ "_tag": "ColumnNotFound", "columnId": "col_99" }      // 404
{ "_tag": "ColumnNotEmpty", "columnId": "col_1", "cardCount": 5 }  // 409
```

## Tips

- Always include `"by": "ai:<your-name>"` in payloads for provenance tracking.
- Use `GET /api/boards/:id/state` to read current board state before making changes.
- Cards have a `description` field that supports plain text (rich text/ProseMirror JSON in future).
- The board `version` increments with each mutation — use it to detect if you're out of date.
