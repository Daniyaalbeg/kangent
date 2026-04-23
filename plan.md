# Kangent — Agent-Native Kanban Boards

> A real-time Kanban board that lives at a URL. Give an agent a skill file, it gets full access. No login required. Built on Cloudflare Workers + Durable Objects + Effect.

---

## 1. What We're Building

Kangent is an open-source Kanban board designed for agents and humans to collaborate on tasks. It applies the "skill file → instant agent access" pattern to task management.

**Core idea:** An agent reads a single SKILL.md file and learns how to create boards, manage cards, and collaborate with humans — all through a simple HTTP API. Humans get a real-time drag-and-drop board in the browser. Both see each other's changes instantly.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   Cloudflare Worker                      │
│                                                          │
│  ┌──────────────┐   ┌─────────────────────────────────┐ │
│  │ TanStack Start│   │    @effect/platform HttpApi      │ │
│  │  (SSR + App)  │   │                                  │ │
│  │               │   │  POST /api/boards                │ │
│  │  /b/:id       │   │  GET  /api/boards/:id/state      │ │
│  │               │   │  POST /api/boards/:id/columns    │ │
│  └──────────────┘   │  POST /api/boards/:id/cards      │ │
│                      │  PATCH /api/boards/:id/cards/:cid │ │
│                      │  ...                              │ │
│                      └──────────┬──────────────────────┘ │
│                                 │                        │
│                      ┌──────────▼──────────────────────┐ │
│                      │     Durable Object (per board)   │ │
│                      │                                  │ │
│                      │  - Board state in DO storage     │ │
│                      │  - WebSocket hub for real-time   │ │
│                      │  - Single-threaded = no conflicts│ │
│                      │  - HTTP fetch handler for agents │ │
│                      │  - Effect runtime inside the DO  │ │
│                      └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘

Browser (Human)                    Agent (AI)
   │                                  │
   │  WebSocket ◄──────────────────►  │  HTTP fetch
   │  /api/boards/:id/ws              │  /api/boards/:id/*
   │                                  │
   │  Real-time drag & drop           │  Reads SKILL.md
   │  ProseMirror rich text           │  Creates/manages cards
   │  Live cursors & presence         │  Polls or fetches state
```

### Why Durable Objects

Each board is a single Durable Object. This gives us:

- **Single-threaded execution** — no race conditions, no CRDTs needed. Operations are serialized by the runtime.
- **Co-located state + compute** — board data lives in DO storage, right next to the code that processes it.
- **Native WebSocket support** — the DO accepts WebSocket connections and broadcasts changes. No separate pub/sub layer.
- **Auto-scaling** — Cloudflare handles placement, hibernation, and wake-up. Zero boards = zero cost.
- **No database to manage** — DO storage is durable, transactional, and automatically replicated.

---

## 3. Why Effect — and How We Use It

### The Problem Effect Solves

Without Effect, a Cloudflare Worker project accumulates untyped errors, hand-rolled validation, manual dependency threading, and scattered try/catch blocks. Effect gives us a disciplined foundation:

1. **Typed errors everywhere** — every function signature tells you exactly what can go wrong (`BoardNotFound`, `CardNotFound`, `ValidationError`) at the type level. No more `catch (e: unknown)`.
2. **Schema replaces Zod** — `@effect/schema` gives us the same runtime validation *plus* bidirectional encoding/decoding that integrates with Effect's error channel. Define a schema once, use it for API validation, WebSocket message parsing, and DO storage serialization.
3. **Services & Layers = testable architecture** — the Durable Object storage, WebSocket broadcaster, and board state engine are all Effect Services. In production, they bind to real DO storage. In tests, you swap in in-memory implementations. No mocking libraries needed.
4. **`@effect/platform` HttpApi = define once, get everything** — this is the biggest win. We define the entire HTTP API (routes, request/response schemas, error types, auth) in one place. From that single definition we get:
   - A type-safe server implementation (handlers are fully typed)
   - An auto-generated typed client (the `agent-sdk` package gets this for free)
   - Auto-generated OpenAPI/Swagger docs
   - Request validation, error serialization, and content negotiation — all handled
5. **Resource safety** — WebSocket connections, DO storage transactions, and the Effect runtime itself are managed with `Scope` and `addFinalizer`. Connections always clean up, even on errors.

### Effect in 5 Minutes (for this project)

#### The Core Type: `Effect<Success, Error, Requirements>`

Every operation in Kangent returns an `Effect`. Think of it as a *description* of a computation — it doesn't run until you explicitly execute it.

```typescript
// A function that might fail with BoardNotFound, needs BoardStorage to run,
// and returns a Board on success
const getBoard: (id: string) => Effect<Board, BoardNotFound, BoardStorage>
```

- **Success** (`Board`) — what you get when it works
- **Error** (`BoardNotFound`) — what can go wrong (tracked in types!)
- **Requirements** (`BoardStorage`) — what dependencies it needs (dependency injection)

#### Writing Effect Code with Generators

`Effect.gen` lets you write sequential code that looks like async/await:

```typescript
const moveCard = (cardId: string, toColumnId: string) =>
  Effect.gen(function* () {
    // yield* "unwraps" an Effect — like await for promises
    const card = yield* getCard(cardId)            // might fail with CardNotFound
    const column = yield* getColumn(toColumnId)    // might fail with ColumnNotFound
    const updated = yield* updateCard(card, { columnId: column.id })
    yield* broadcastOp({ type: "card:move", card: updated })
    return updated
  })
// Inferred type: Effect<Card, CardNotFound | ColumnNotFound, BoardStorage | Broadcaster>
```

TypeScript automatically unions the errors and requirements from each step. If `getCard` can fail with `CardNotFound` and `getColumn` with `ColumnNotFound`, the composed function can fail with either.

#### Creating Effects

```typescript
// From a value (always succeeds)
Effect.succeed(42)                           // Effect<number, never, never>

// From an error (always fails)
Effect.fail(new BoardNotFound({ boardId }))  // Effect<never, BoardNotFound, never>

// From synchronous code that might throw
Effect.try(() => JSON.parse(raw))            // Effect<any, UnknownException, never>

// From a promise
Effect.tryPromise(() => fetch(url))          // Effect<Response, UnknownException, never>

// From synchronous side effects (won't throw)
Effect.sync(() => Date.now())                // Effect<number, never, never>
```

#### Typed Errors with TaggedError

Errors are values, not thrown exceptions. We define them with schemas so they auto-serialize to HTTP responses:

```typescript
import { Schema } from "effect"
import { HttpApiSchema } from "@effect/platform"

class BoardNotFound extends Schema.TaggedError<BoardNotFound>()(
  "BoardNotFound",
  { boardId: Schema.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

class CardNotFound extends Schema.TaggedError<CardNotFound>()(
  "CardNotFound",
  { cardId: Schema.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

class ColumnNotEmpty extends Schema.TaggedError<ColumnNotEmpty>()(
  "ColumnNotEmpty",
  { columnId: Schema.String, cardCount: Schema.Number },
  HttpApiSchema.annotations({ status: 409 })
) {}
```

When a handler returns `Effect.fail(new CardNotFound({ cardId: "abc" }))`, the platform serializes it to a `404` response with the JSON body `{ "_tag": "CardNotFound", "cardId": "abc" }`. No manual error mapping.

#### Services & Layers (Dependency Injection)

A **Service** declares *what* something does. A **Layer** provides *how* it does it.

```typescript
import { Context, Effect, Layer } from "effect"

// Declare the service interface
class BoardStorage extends Context.Tag("BoardStorage")<
  BoardStorage,
  {
    readonly getBoard: (id: string) => Effect.Effect<Board, BoardNotFound>
    readonly saveBoard: (board: Board) => Effect.Effect<void>
    readonly getCard: (id: string) => Effect.Effect<Card, CardNotFound>
    readonly saveCard: (card: Card) => Effect.Effect<void>
  }
>() {}

// Production implementation — backed by Durable Object storage
const BoardStorageLive = (storage: DurableObjectStorage) =>
  Layer.succeed(BoardStorage, {
    getBoard: (id) =>
      Effect.tryPromise(() => storage.get(`board:${id}`)).pipe(
        Effect.flatMap((data) =>
          data ? Effect.succeed(data as Board) : Effect.fail(new BoardNotFound({ boardId: id }))
        )
      ),
    saveBoard: (board) =>
      Effect.tryPromise(() => storage.put(`board:${board.id}`, board)),
    // ... etc
  })

// Test implementation — in-memory Map
const BoardStorageTest = Layer.succeed(BoardStorage, {
  getBoard: (id) => {
    const board = testBoards.get(id)
    return board ? Effect.succeed(board) : Effect.fail(new BoardNotFound({ boardId: id }))
  },
  // ... etc
})
```

Business logic depends on the *interface*, not the implementation:

```typescript
const moveCard = (cardId: string, toColumnId: string) =>
  Effect.gen(function* () {
    const storage = yield* BoardStorage         // get the service
    const card = yield* storage.getCard(cardId) // use it
    // ...
  })
```

In production, you provide `BoardStorageLive`. In tests, you provide `BoardStorageTest`. The business logic is identical either way.

#### Running Effects

At the edges of the system (Worker fetch handler, DO message handler), we run Effects:

```typescript
// In the Cloudflare Worker — runs the Effect and returns a Promise<Response>
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handler(request)  // handler from HttpApiBuilder.toWebHandler()
  }
}

// Inside the DO — run an Effect for each operation
async webSocketMessage(ws: WebSocket, message: string) {
  const result = await Effect.runPromise(
    processOperation(message).pipe(
      Effect.provide(this.layers)  // provide DO-specific services
    )
  )
  this.broadcast(result, ws)
}
```

### The `@effect/platform` HttpApi System

This is the centerpiece for the agent-facing HTTP API. We define the API declaratively, and get server, client, and docs from one definition.

#### Step 1: Define the API (in `board-core`)

```typescript
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"

// --- Schemas ---
class Board extends Schema.Class<Board>("Board")({
  id: Schema.String,
  title: Schema.String,
  version: Schema.Number,
  columns: Schema.Array(Column),
  // ...
}) {}

class CreateBoardPayload extends Schema.Class<CreateBoardPayload>("CreateBoardPayload")({
  title: Schema.String,
  description: Schema.optional(Schema.String),
  columns: Schema.optional(Schema.Array(Schema.String)),
  by: Schema.String,
}) {}

class CreateBoardResponse extends Schema.Class<CreateBoardResponse>("CreateBoardResponse")({
  id: Schema.String,
  url: Schema.String,
  token: Schema.String,
  board: Board,
}) {}

// --- Endpoints ---
const createBoard = HttpApiEndpoint.post("createBoard", "/api/boards")
  .setPayload(CreateBoardPayload)
  .addSuccess(CreateBoardResponse, { status: 201 })

const getBoardState = HttpApiEndpoint
  .get("getBoardState")`/api/boards/${HttpApiSchema.Param("boardId", Schema.String)}/state`
  .addSuccess(BoardStateResponse)
  .addError(BoardNotFound)

const addCard = HttpApiEndpoint
  .post("addCard")`/api/boards/${HttpApiSchema.Param("boardId", Schema.String)}/cards`
  .setPayload(AddCardPayload)
  .addSuccess(AddCardResponse, { status: 201 })
  .addError(BoardNotFound)
  .addError(ColumnNotFound)

// --- Groups ---
class BoardsGroup extends HttpApiGroup.make("boards")
  .add(createBoard)
  .add(getBoardState)
  .add(addCard)
  .add(updateCard)
  .add(moveCard)
  .add(deleteCard)
  .add(addColumn)
  .add(updateColumn)
  .add(deleteColumn)
  .add(updatePresence) {}

// --- Top-level API ---
class KangentApi extends HttpApi.make("KangentApi")
  .add(BoardsGroup) {}
```

#### Step 2: Implement Handlers (in `board-worker`)

```typescript
import { HttpApiBuilder } from "@effect/platform"

const BoardsGroupLive = HttpApiBuilder.group(KangentApi, "boards", (handlers) =>
  handlers
    .handle("createBoard", ({ payload }) =>
      Effect.gen(function* () {
        const storage = yield* BoardStorage
        const board = yield* storage.createBoard(payload)
        return new CreateBoardResponse({
          id: board.id,
          url: `https://kangent.dev/b/${board.id}`,
          token: board.token,
          board,
        })
      })
    )
    .handle("getBoardState", ({ path }) =>
      Effect.gen(function* () {
        const storage = yield* BoardStorage
        const board = yield* storage.getBoard(path.boardId)
        return new BoardStateResponse({ board })
      })
    )
    .handle("addCard", ({ path, payload }) =>
      Effect.gen(function* () {
        const storage = yield* BoardStorage
        const board = yield* storage.getBoard(path.boardId)
        const card = yield* storage.addCard(board, payload)
        const broadcaster = yield* Broadcaster
        yield* broadcaster.broadcast(board.id, { type: "card:add", card })
        return new AddCardResponse({ card, version: board.version + 1 })
      })
    )
    // ... all other handlers
)
```

#### Step 3: Serve via `toWebHandler` (Cloudflare Workers)

```typescript
import { HttpApiBuilder, HttpServer } from "@effect/platform"
import { Layer } from "effect"

const { handler } = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(
    HttpApiBuilder.api(KangentApi),
    BoardsGroupLive,
    BoardStorageLive,
    HttpServer.layerContext,   // no-op FileSystem for Workers (no Node.js needed)
  )
)

// Cloudflare Worker entry point
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route to DO for board-specific requests, or handle directly
    return handler(request)
  }
}
```

#### Step 4: Auto-Generated Client (in `agent-sdk`)

```typescript
import { HttpApiClient } from "@effect/platform"

// One line — full typed client derived from the API definition
const client = yield* HttpApiClient.make(KangentApi, {
  baseUrl: "https://kangent.dev",
})

// Fully typed! IDE autocomplete for everything.
const { board, token } = yield* client.boards.createBoard({
  payload: { title: "Sprint 12", by: "ai:claude" }
})

const state = yield* client.boards.getBoardState({
  path: { boardId: board.id }
})

const { card } = yield* client.boards.addCard({
  path: { boardId: board.id },
  payload: { columnId: "col_1", title: "Fix auth", by: "ai:claude" }
})
```

The agent-sdk *also* ships a plain HTTP wrapper for agents that can't run TypeScript (the SKILL.md documents raw HTTP). But any TypeScript agent gets a free typed client.

### How Effect Flows Through the System

```
┌─────────────────────────────────────────────────────────────────┐
│                        board-core                                │
│                                                                  │
│  Schema definitions (Board, Card, Column, operations)            │
│  HttpApi definition (KangentApi, BoardsGroup, endpoints)         │
│  Error types (BoardNotFound, CardNotFound, ...)                  │
│  Service interfaces (BoardStorage, Broadcaster)                  │
│                                                                  │
│  → Used by board-worker (handlers), agent-sdk (client), web app  │
└─────────────────────────────────────────────────────────────────┘
           │                    │                    │
           ▼                    ▼                    ▼
┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  board-worker    │  │    agent-sdk     │  │    apps/web      │
│                  │  │                  │  │                  │
│  HttpApiBuilder  │  │  HttpApiClient   │  │  Imports schemas │
│  .group() impl   │  │  .make() auto    │  │  for WS message  │
│                  │  │  typed client    │  │  validation      │
│  Layer provides: │  │                  │  │                  │
│  - BoardStorage  │  │  Also: plain     │  │  Uses same types │
│    (DO-backed)   │  │  HTTP client for │  │  for optimistic  │
│  - Broadcaster   │  │  non-TS agents   │  │  updates         │
│    (WS hub)      │  │                  │  │                  │
│                  │  │  SKILL.md docs   │  │                  │
│  toWebHandler()  │  │  raw HTTP too    │  │                  │
│  for CF Workers  │  │                  │  │                  │
└─────────────────┘  └──────────────────┘  └──────────────────┘
```

### Effect Packages We Use

| Package | Purpose |
| --- | --- |
| `effect` | Core — `Effect`, `Layer`, `Context`, `Schema`, `Stream`, `Fiber` |
| `@effect/platform` | `HttpApi`, `HttpApiBuilder`, `HttpApiClient`, `HttpApiSchema`, `HttpApiSecurity`, `HttpApiSwagger`, `HttpServer` |

That's it — two packages. `effect` is the core runtime, `@effect/platform` is the HTTP layer. No Express, no Zod, no separate validation library, no separate HTTP client library.

---

## 4. Monorepo Structure

```
kangent/
├── apps/
│   └── web/                      # TanStack Start app — the full web experience
│       ├── src/
│       │   ├── routes/           # TanStack Router file-based routes
│       │   │   ├── __root.tsx
│       │   │   ├── index.tsx     # Landing / create board
│       │   │   └── b/
│       │   │       └── $boardId.tsx  # Board view
│       │   ├── components/       # All UI components (board, column, card, etc.)
│       │   │   ├── Board.tsx
│       │   │   ├── Column.tsx
│       │   │   ├── Card.tsx
│       │   │   ├── CardDetail.tsx
│       │   │   ├── RichTextEditor.tsx   # ProseMirror wrapper
│       │   │   ├── Presence.tsx
│       │   │   └── DragOverlay.tsx
│       │   ├── hooks/            # WebSocket, board state, drag-and-drop
│       │   ├── lib/              # Utilities, WebSocket client, types re-exports
│       │   └── styles/
│       ├── app.config.ts         # TanStack Start config (Cloudflare preset)
│       ├── wrangler.toml         # Cloudflare Worker + DO bindings
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   ├── board-core/               # Shared: schemas, API definition, service interfaces
│   │   ├── src/
│   │   │   ├── schemas/          # Effect Schema definitions
│   │   │   │   ├── board.ts      # Board, Column, Card schemas
│   │   │   │   ├── operations.ts # WebSocket operation message schemas
│   │   │   │   └── api.ts        # Request/response payload schemas
│   │   │   ├── api.ts            # HttpApi + HttpApiGroup + HttpApiEndpoint definitions
│   │   │   ├── errors.ts         # TaggedError types (BoardNotFound, CardNotFound, etc.)
│   │   │   ├── services.ts       # Service interfaces (BoardStorage, Broadcaster)
│   │   │   ├── constants.ts      # Limits, defaults
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── board-worker/             # Durable Object + service implementations
│   │   ├── src/
│   │   │   ├── BoardDO.ts        # The Durable Object class
│   │   │   ├── handlers.ts       # HttpApiBuilder.group() — endpoint implementations
│   │   │   ├── storage.ts        # BoardStorage Layer (backed by DO storage)
│   │   │   ├── broadcaster.ts    # Broadcaster Layer (WebSocket hub)
│   │   │   ├── websocket.ts      # WebSocket upgrade + message handling
│   │   │   ├── presence.ts       # Presence tracking
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── agent-sdk/                # Agent HTTP client + skill file
│       ├── src/
│       │   ├── client.ts         # HttpApiClient.make(KangentApi) wrapper
│       │   ├── http.ts           # Plain fetch-based client (for non-TS agents)
│       │   └── index.ts
│       ├── SKILL.md              # The skill file agents read to learn the API
│       ├── package.json
│       └── tsconfig.json
│
├── docs/
│   └── SKILL.md                  # Canonical copy (also in agent-sdk)
│
├── turbo.json                    # Turborepo task config
├── pnpm-workspace.yaml
├── package.json                  # Root — workspace scripts
├── tsconfig.base.json            # Shared TS config
├── .gitignore
├── LICENSE                       # MIT
└── README.md
```

### Why This Split

- **`apps/web`** — Single deployment unit. Contains all UI components, routes, styles. No separate UI package because the only consumer is this app. Deploys to Cloudflare Workers via TanStack Start's Cloudflare adapter. The `wrangler.toml` lives here because this is what gets deployed.
- **`packages/board-core`** — The shared contract. Effect Schemas, the `HttpApi` definition, error types, and service interfaces. Imported by board-worker (for handler implementations), agent-sdk (for auto-generated client), and apps/web (for type-safe WebSocket messages). Zero runtime dependencies beyond `effect` and `@effect/platform`.
- **`packages/board-worker`** — The Durable Object class and Layer implementations. `BoardStorage` backed by DO storage, `Broadcaster` backed by WebSocket connections. Imported by `apps/web` (which re-exports the DO class for Cloudflare). Kept separate so the DO logic is testable in isolation.
- **`packages/agent-sdk`** — Standalone package an agent (or developer) can use to interact with boards. The typed client is auto-generated from the `HttpApi` definition via `HttpApiClient.make()`. Also includes a plain HTTP wrapper and the SKILL.md file. Could be published to npm independently.

### Tooling

- **pnpm** — workspace package manager
- **Turborepo** — task orchestration (`build`, `dev`, `typecheck`, `test`)
- **TypeScript** — strict mode, project references
- **Vitest** — testing (Effect programs are testable by swapping Layers)
- **Biome** — linting + formatting (fast, single tool)

---

## 5. Data Model (Effect Schemas)

All data types are defined as Effect Schemas. This means each type is simultaneously a:
- TypeScript type (for compile-time safety)
- Runtime validator (for parsing incoming data)
- Encoder (for serializing to JSON / DO storage)
- Decoder (for deserializing from JSON / DO storage)

### Board

```typescript
import { Schema } from "effect"

const ActorId = Schema.String.pipe(Schema.brand("ActorId"))
// e.g. "human:daniya", "ai:claude", "ai:codex"

class Board extends Schema.Class<Board>("Board")({
  id: Schema.String,                        // nanoid, 12 chars
  title: Schema.String,
  description: Schema.optional(Schema.String),
  columns: Schema.Array(Schema.suspend(() => Column)),
  createdAt: Schema.DateFromString,          // ISO 8601 ↔ Date
  updatedAt: Schema.DateFromString,
  createdBy: ActorId,
  version: Schema.Number,                    // Incrementing revision
}) {}
```

### Column

```typescript
class Column extends Schema.Class<Column>("Column")({
  id: Schema.String,
  title: Schema.String,
  position: Schema.Number,                   // Float-based ordering
  cardIds: Schema.Array(Schema.String),      // Ordered card IDs
}) {}
```

### Card

```typescript
class Card extends Schema.Class<Card>("Card")({
  id: Schema.String,
  columnId: Schema.String,
  title: Schema.String,
  description: Schema.Unknown,               // ProseMirror JSON document
  position: Schema.Number,                   // Float-based ordering
  createdBy: ActorId,
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString,
}) {}
```

### Rich Text (ProseMirror)

Card descriptions use ProseMirror's document model. This gives us:
- Headings, bold, italic, code, links
- Checklists (task lists)
- Bullet/numbered lists
- Mentions (future: @agent, @human)
- Inline labels, due dates (via custom marks/nodes — future)

Stored as ProseMirror JSON in DO storage. The web app renders it with a ProseMirror editor. Agents can read/write it as markdown (the API handles conversion).

### WebSocket Operation Schemas

```typescript
const BaseOp = Schema.Struct({
  opId: Schema.String,
  by: ActorId,
})

const CardAddOp = Schema.extend(BaseOp, Schema.Struct({
  type: Schema.Literal("card:add"),
  columnId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.Unknown),
}))

const CardMoveOp = Schema.extend(BaseOp, Schema.Struct({
  type: Schema.Literal("card:move"),
  cardId: Schema.String,
  toColumnId: Schema.String,
  position: Schema.Number,
}))

const CardUpdateOp = Schema.extend(BaseOp, Schema.Struct({
  type: Schema.Literal("card:update"),
  cardId: Schema.String,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.Unknown),
}))

const CardDeleteOp = Schema.extend(BaseOp, Schema.Struct({
  type: Schema.Literal("card:delete"),
  cardId: Schema.String,
}))

// ... ColumnAddOp, ColumnUpdateOp, ColumnDeleteOp, ColumnReorderOp, PresenceUpdateOp

const ClientOperation = Schema.Union(
  CardAddOp, CardMoveOp, CardUpdateOp, CardDeleteOp,
  ColumnAddOp, ColumnUpdateOp, ColumnDeleteOp, ColumnReorderOp,
  PresenceUpdateOp,
)
```

These schemas validate incoming WebSocket messages in the DO *and* structure outgoing messages in the frontend. Same types, both sides.

---

## 6. Service Interfaces (Effect Services)

Defined in `board-core`, implemented in `board-worker`, consumed everywhere.

### BoardStorage

```typescript
class BoardStorage extends Context.Tag("BoardStorage")<
  BoardStorage,
  {
    readonly getBoard: (id: string) => Effect.Effect<Board, BoardNotFound>
    readonly createBoard: (params: CreateBoardParams) => Effect.Effect<Board>
    readonly updateBoardMeta: (id: string, meta: Partial<BoardMeta>) => Effect.Effect<Board, BoardNotFound>
    readonly getCard: (boardId: string, cardId: string) => Effect.Effect<Card, CardNotFound>
    readonly addCard: (boardId: string, params: AddCardParams) => Effect.Effect<Card, ColumnNotFound>
    readonly updateCard: (boardId: string, cardId: string, updates: CardUpdates) => Effect.Effect<Card, CardNotFound>
    readonly moveCard: (boardId: string, cardId: string, toColumnId: string, position: number) => Effect.Effect<Card, CardNotFound | ColumnNotFound>
    readonly deleteCard: (boardId: string, cardId: string) => Effect.Effect<void, CardNotFound>
    readonly addColumn: (boardId: string, title: string) => Effect.Effect<Column>
    readonly updateColumn: (boardId: string, columnId: string, title: string) => Effect.Effect<Column, ColumnNotFound>
    readonly deleteColumn: (boardId: string, columnId: string, moveCardsTo?: string) => Effect.Effect<void, ColumnNotFound | ColumnNotEmpty>
    readonly reorderColumns: (boardId: string, columnIds: string[]) => Effect.Effect<void>
    readonly incrementVersion: (boardId: string) => Effect.Effect<number>
  }
>() {}
```

### Broadcaster

```typescript
class Broadcaster extends Context.Tag("Broadcaster")<
  Broadcaster,
  {
    readonly broadcast: (boardId: string, message: unknown, exclude?: WebSocket) => Effect.Effect<void>
    readonly broadcastPresence: (boardId: string) => Effect.Effect<void>
    readonly getConnections: (boardId: string) => Effect.Effect<readonly WebSocket[]>
  }
>() {}
```

---

## 7. Durable Object Design

### State Storage

Each board DO stores its state across multiple keys in DO storage:

```
board:meta       → { id, title, description, createdAt, updatedAt, createdBy, version }
board:columns    → Column[]  (ordered)
card:<id>        → Card      (one key per card)
```

Presence is transient (tracked in-memory on the DO, not persisted).

### Single-Threaded Guarantees

The Durable Object processes one request/message at a time. This means:
- No race conditions when two people move cards simultaneously
- No need for CRDTs or OT — just apply operations sequentially
- The `version` counter increments atomically with each mutation
- WebSocket broadcasts happen after state is committed

### Effect Runtime in the DO

Each DO instance holds an Effect runtime pre-configured with its service Layers:

```typescript
class BoardDO implements DurableObject {
  private runtime: Runtime.Runtime<BoardStorage | Broadcaster>

  constructor(state: DurableObjectState, env: Env) {
    // Build the runtime once per DO instance
    this.runtime = Runtime.make(
      Layer.mergeAll(
        BoardStorageLive(state.storage),
        BroadcasterLive(this.connections),
      )
    )
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request)
    }
    // Agent HTTP API — run Effect programs against this DO's runtime
    return this.runtime.runPromise(handleApiRequest(request))
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    const result = await this.runtime.runPromise(
      processOperation(message)
    )
    // broadcast handled inside the Effect via Broadcaster service
  }
}
```

### Hibernation

Use Cloudflare's WebSocket Hibernation API for cost efficiency:
- When no messages are flowing, the DO hibernates (no charge)
- Incoming messages wake it up automatically
- State is reconstructed from DO storage on wake
- The Effect runtime is rebuilt on wake (lightweight — just Layer composition)

---

## 8. WebSocket Protocol (Browser ↔ DO)

### Connection

```
GET /api/boards/:id/ws
Upgrade: websocket
```

On connect, server sends:

```json
{ "type": "board:state", "board": { /* full board state */ } }
```

### Client → Server Messages (Operations)

All operations include an `opId` (client-generated UUID) for deduplication and ack tracking, plus a `by` field for provenance. All messages are validated against the `ClientOperation` Effect Schema in the DO.

```jsonc
// Add a column
{ "type": "column:add", "opId": "...", "by": "human:daniya", "title": "In Progress" }

// Rename a column
{ "type": "column:update", "opId": "...", "by": "human:daniya", "columnId": "col_1", "title": "Done" }

// Delete a column (moves cards to another column, or deletes them)
{ "type": "column:delete", "opId": "...", "by": "human:daniya", "columnId": "col_1", "moveCardsTo": "col_2" }

// Reorder columns
{ "type": "column:reorder", "opId": "...", "by": "human:daniya", "columnIds": ["col_2", "col_1", "col_3"] }

// Add a card
{ "type": "card:add", "opId": "...", "by": "human:daniya", "columnId": "col_1", "title": "Fix auth bug", "description": "..." }

// Update a card
{ "type": "card:update", "opId": "...", "by": "ai:claude", "cardId": "card_1", "title": "...", "description": "..." }

// Move a card (between columns or reorder within)
{ "type": "card:move", "opId": "...", "by": "human:daniya", "cardId": "card_1", "toColumnId": "col_2", "position": 1.5 }

// Delete a card
{ "type": "card:delete", "opId": "...", "by": "human:daniya", "cardId": "card_1" }

// Presence update
{ "type": "presence:update", "by": "human:daniya", "cursor": { "cardId": "card_1" }, "status": "viewing" }
```

### Server → Client Messages

```jsonc
// Full state (on connect, or on request)
{ "type": "board:state", "board": { /* ... */ }, "version": 42 }

// Operation applied (broadcast to others)
{ "type": "op:applied", "op": { /* the original operation */ }, "version": 43 }

// Ack (sent to the client that sent the operation)
{ "type": "op:ack", "opId": "...", "version": 43 }

// Presence (broadcast)
{ "type": "presence:state", "actors": [{ "id": "human:daniya", "cursor": {...}, "status": "viewing" }] }

// Error
{ "type": "op:error", "opId": "...", "code": "CARD_NOT_FOUND", "message": "..." }
```

### Optimistic Updates

The web app applies operations optimistically:
1. User drags a card → UI updates immediately
2. Operation sent to DO via WebSocket
3. DO validates message against Effect Schema, applies via `BoardStorage` service, increments version
4. Sender receives `op:ack` with new version → confirms optimistic update
5. If error, sender receives `op:error` → reverts optimistic update

---

## 9. HTTP API (Agent-Facing)

Defined declaratively via `@effect/platform` HttpApi in `board-core`. Implemented via `HttpApiBuilder` in `board-worker`. Served via `toWebHandler()` on Cloudflare Workers.

All endpoints are under `/api/boards`. Authentication is via `Authorization: Bearer <token>` header.

### Create a Board

```
POST /api/boards
Content-Type: application/json

{
  "title": "Sprint 12 Tasks",
  "description": "Tasks for the current sprint",
  "columns": ["To Do", "In Progress", "Done"],   // Optional, defaults to these three
  "by": "ai:claude"
}

→ 201 Created
{
  "id": "abc123xyz789",
  "url": "https://kangent.dev/b/abc123xyz789",
  "token": "tok_...",
  "board": { /* full board state */ }
}
```

### Get Board State

```
GET /api/boards/:id/state
Authorization: Bearer tok_...

→ 200 OK
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
        "cards": [
          {
            "id": "card_1",
            "title": "Fix auth bug",
            "description": "The login flow breaks when...",
            "createdBy": "human:daniya",
            "createdAt": "2026-04-16T10:00:00Z",
            "updatedAt": "2026-04-16T10:30:00Z"
          }
        ]
      }
    ]
  },
  "presence": [
    { "id": "human:daniya", "status": "active", "cursor": { "cardId": "card_1" } }
  ]
}
```

### Add a Column

```
POST /api/boards/:id/columns
Authorization: Bearer tok_...
Idempotency-Key: <uuid>

{ "title": "QA Review", "by": "ai:claude" }

→ 201 Created
{ "column": { "id": "col_4", "title": "QA Review", "position": 3 }, "version": 43 }
```

### Add a Card

```
POST /api/boards/:id/cards
Authorization: Bearer tok_...
Idempotency-Key: <uuid>

{
  "columnId": "col_1",
  "title": "Implement search",
  "description": "Add full-text search to the dashboard.\n\n- [ ] Index existing data\n- [ ] Build query API\n- [ ] Add UI",
  "by": "ai:claude"
}

→ 201 Created
{ "card": { "id": "card_7", ... }, "version": 44 }
```

### Update a Card

```
PATCH /api/boards/:id/cards/:cardId
Authorization: Bearer tok_...
Idempotency-Key: <uuid>

{
  "title": "Implement search (v2)",
  "description": "Updated requirements...",
  "by": "ai:claude"
}

→ 200 OK
{ "card": { "id": "card_7", ... }, "version": 45 }
```

### Move a Card

```
POST /api/boards/:id/cards/:cardId/move
Authorization: Bearer tok_...
Idempotency-Key: <uuid>

{
  "toColumnId": "col_2",
  "position": 0,
  "by": "ai:claude"
}

→ 200 OK
{ "card": { "id": "card_7", "columnId": "col_2", ... }, "version": 46 }
```

### Delete a Card

```
DELETE /api/boards/:id/cards/:cardId
Authorization: Bearer tok_...
Idempotency-Key: <uuid>

→ 200 OK
{ "deleted": "card_7", "version": 47 }
```

### Update a Column

```
PATCH /api/boards/:id/columns/:columnId
Authorization: Bearer tok_...
Idempotency-Key: <uuid>

{ "title": "Done (Verified)", "by": "ai:claude" }

→ 200 OK
{ "column": { "id": "col_3", "title": "Done (Verified)", ... }, "version": 48 }
```

### Delete a Column

```
DELETE /api/boards/:id/columns/:columnId?moveCardsTo=col_2
Authorization: Bearer tok_...
Idempotency-Key: <uuid>

→ 200 OK
{ "deleted": "col_4", "cardsMoved": 3, "version": 49 }
```

### Agent Presence

```
POST /api/boards/:id/presence
Authorization: Bearer tok_...

{
  "by": "ai:claude",
  "status": "working",
  "message": "Adding implementation tasks for the auth module"
}

→ 200 OK
```

### Error Responses

All errors are TaggedError instances serialized to JSON with the correct HTTP status code (handled automatically by `@effect/platform`):

```json
// 404
{ "_tag": "BoardNotFound", "boardId": "abc123" }

// 404
{ "_tag": "CardNotFound", "cardId": "card_99" }

// 409
{ "_tag": "ColumnNotEmpty", "columnId": "col_1", "cardCount": 5 }

// 400 (automatic from schema validation failure)
{ "_tag": "HttpApiDecodeError", "issues": [...] }
```

---

## 10. SKILL.md (Agent Skill File)

The skill file is a self-contained markdown document that teaches any agent how to use Kangent. It includes:

1. **What Kangent is** — one paragraph
2. **Authentication** — how to use the token
3. **Create a board** — POST endpoint, what you get back
4. **Read board state** — GET endpoint, response shape
5. **Operations** — add/update/move/delete cards and columns
6. **Presence** — how to show the agent is active
7. **Error handling** — common errors and how to retry
8. **Examples** — complete request/response pairs for each operation

The skill file lives at:
- `https://kangent.dev/SKILL.md` (served by the worker)
- `packages/agent-sdk/SKILL.md` (in the repo)
- Installable to `~/.claude/skills/kangent/SKILL.md` or `~/.codex/skills/kangent/SKILL.md`

### Installer Prompt

```
Install Kangent for me.

Kangent is a real-time Kanban board for agents and humans to collaborate on tasks.
Read https://kangent.dev/SKILL.md and install Kangent for this agent.

During setup, ask me exactly one question:
When should I create new boards in Kangent?
1. For all task lists
2. For collaborative project planning
3. Only when I explicitly ask
```

---

## 11. TanStack Start App

### Tech Stack

- **TanStack Start** — full-stack React framework, SSR on Cloudflare Workers
- **TanStack Router** — file-based routing, type-safe
- **ProseMirror** — rich text editing in card descriptions
- **@dnd-kit** — drag and drop for cards and columns (accessible, performant)
- **Tailwind CSS v4** — styling
- **Zustand** — client-side board state (optimistic updates, WebSocket sync)

### Routes

```
/                    → Landing page, "Create a Board" button
/b/:boardId          → Board view (the main Kanban UI)
```

### Key Components

```
Board.tsx            → Full board layout. Renders columns in a horizontal scroll container.
Column.tsx           → Single column. Header with title, list of cards, "Add card" button.
Card.tsx             → Card preview in the column. Title, truncated description, metadata.
CardDetail.tsx       → Modal/drawer. Full card view with ProseMirror editor for description.
RichTextEditor.tsx   → ProseMirror editor configured for card descriptions (checklists, etc.)
Presence.tsx         → Shows who's on the board (avatars, agent indicators).
DragOverlay.tsx      → Visual feedback while dragging cards/columns.
CreateBoardDialog.tsx→ Form to create a new board (title, optional columns).
```

### State Management

```typescript
// Zustand store — single source of truth for the board on the client
interface BoardStore {
  board: Board | null;
  version: number;
  connected: boolean;
  presence: Actor[];

  // WebSocket
  connect: (boardId: string) => void;
  disconnect: () => void;

  // Optimistic operations (sends via WebSocket, applies locally immediately)
  addCard: (columnId: string, title: string, description?: string) => void;
  updateCard: (cardId: string, updates: Partial<Card>) => void;
  moveCard: (cardId: string, toColumnId: string, position: number) => void;
  deleteCard: (cardId: string) => void;
  addColumn: (title: string) => void;
  updateColumn: (columnId: string, title: string) => void;
  deleteColumn: (columnId: string, moveCardsTo?: string) => void;
  reorderColumns: (columnIds: string[]) => void;

  // Internal — called by WebSocket message handlers
  applyRemoteOp: (op: Operation) => void;
  rollbackOp: (opId: string) => void;
}
```

### Drag and Drop

Using `@dnd-kit` for accessible drag-and-drop:
- Cards are draggable within and between columns
- Columns are draggable to reorder
- Visual placeholder shows where the card will land
- On drop: optimistic update + send `card:move` or `column:reorder` via WebSocket

---

## 12. Deployment

### Cloudflare Configuration

```toml
# apps/web/wrangler.toml
name = "kangent"
compatibility_date = "2024-12-01"

[durable_objects]
bindings = [
  { name = "BOARD", class_name = "BoardDO" }
]

[[migrations]]
tag = "v1"
new_classes = ["BoardDO"]
```

TanStack Start's Cloudflare adapter handles:
- SSR via the Worker
- Static asset serving via Cloudflare's asset pipeline
- The Worker also handles API routes and WebSocket upgrades

### URL Structure

```
https://kangent.dev/                       → Landing page
https://kangent.dev/b/<boardId>            → Board UI
https://kangent.dev/api/boards             → Create board (POST)
https://kangent.dev/api/boards/:id/state   → Board state (GET)
https://kangent.dev/api/boards/:id/ws      → WebSocket
https://kangent.dev/api/boards/:id/*       → Other API endpoints
https://kangent.dev/SKILL.md               → Agent skill file
```

---

## 13. Implementation Phases

### Phase 1 — Foundation (what we build first)

1. **Monorepo setup** — pnpm, Turborepo, TypeScript project references, Biome, `effect` + `@effect/platform`
2. **`board-core`** — Effect Schemas, HttpApi definition, error types, service interfaces
3. **`board-worker`** — Durable Object with Effect runtime, BoardStorage Layer, Broadcaster Layer, WebSocket hub
4. **`apps/web`** — TanStack Start app with Cloudflare adapter, basic routing
5. **Board UI** — Columns, cards, drag-and-drop, create board flow
6. **Real-time sync** — WebSocket connection, optimistic updates, broadcast
7. **ProseMirror editor** — Rich text card descriptions
8. **Agent HTTP API** — All CRUD endpoints via HttpApiBuilder, served via `toWebHandler()`
9. **SKILL.md** — Complete skill file with examples
10. **Deploy** — Cloudflare Workers, wrangler, custom domain

### Phase 2 — Polish

- Presence indicators (who's viewing, agent activity)
- Card detail modal with full ProseMirror editing
- Board-level description / header
- Auto-generated Swagger docs via `HttpApiSwagger.layer()`
- Error handling and retry logic in agent SDK
- Rate limiting
- Board TTL / auto-cleanup for abandoned boards
- Loading states, empty states, animations

### Phase 3 — Growth

- Agent SDK npm package (with auto-generated typed client)
- CLI installer (`curl` one-liner)
- Board templates (sprint board, project tracker, etc.)

---

## 14. Future Editions (TODO)

- [ ] **Bulk populate** — Agent sends a full project plan, Kangent creates all cards/columns in one operation
- [ ] **Board claiming** — Anonymous boards can be claimed by a user (email, passkey, or secret token). Claimed boards get access control (viewer/commenter/editor roles)
- [ ] **Access control** — Viewer, editor, admin roles. Token-scoped permissions via `HttpApiSecurity`
- [ ] **Agent WebSocket API** — Let agents connect via WebSocket for real-time event streaming instead of polling
- [ ] **Card labels and colors** — Visual categorization
- [ ] **Due dates** — With calendar view
- [ ] **Card assignees** — Assign to humans or agents
- [ ] **Activity log** — Full history of who did what and when (provenance)
- [ ] **Search** — Full-text search across all cards on a board
- [ ] **Multiple boards** — Workspace concept, list of boards
- [ ] **Card attachments** — Files, images (R2 storage)
- [ ] **Filters and views** — Filter by label, assignee, due date
- [ ] **Notifications** — Webhook or polling endpoint for agent event subscriptions
- [ ] **Export** — Export board as markdown, JSON, CSV
- [ ] **Import** — Import from Trello, Linear, GitHub Projects JSON
- [ ] **Collaborative card editing** — Yjs integration for real-time co-editing of card descriptions
- [ ] **Board templates via SKILL.md** — Agent can create boards from predefined templates
- [ ] **Native apps** — macOS app; consider mobile PWA
