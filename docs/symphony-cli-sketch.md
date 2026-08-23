# Kangent Symphony CLI — Design Sketch

> Status: design sketch (no code yet). Companion to the Symphony spec under
> "Option B" in the conversation that produced this doc. This file fixes
> shape and naming before we start writing the daemon.

The CLI is a Node binary that conforms to OpenAI's Symphony spec with
`tracker.kind: kangent`. Users install it, drop a `WORKFLOW.md` next to
their repo, point it at one of their Kangent boards, and the daemon spawns
`codex app-server` per ready card in isolated workspaces.

> **Stack note: Effect v4 beta.** The CLI targets `effect@4.0.0-beta.64`
> and `@effect/platform-node@4.0.0-beta.64`. Both packages **must match
> exactly** — v4 is single-versioned and minor beta bumps may break APIs
> under `effect/unstable/*` by policy. Pin exact versions in `package.json`
> and CI; do not use the `beta` dist-tag for reproducible builds. The
> existing `board-core` and `agent-sdk` packages are already on v4, so
> the CLI imports `KangentApi` directly and gets a fully-typed
> `HttpApiClient` for free.

---

## 1. Naming & install

- **npm package:** `@kangent/cli` (matches the workspace convention:
  `@kangent/board-core`, `@kangent/agent-sdk`, …).
- **Binary:** `kangent`. Subcommand for the orchestrator: `kangent run`.
  Other subcommands (`doctor`, `workflow`, `status`) below.
- **Install:** `npm i -g @kangent/cli` or `npx @kangent/cli run`.

## 2. `WORKFLOW.md` — full sketch

Symphony's spec mandates YAML front matter + Markdown prompt body. The
fields below are the Symphony-spec ones (kept verbatim where defined), plus
a `tracker.kangent` extension block that's specific to this implementation.

```markdown
---
# === Symphony-spec keys =====================================================

tracker:
  kind: kangent                          # extension: Kangent adapter
  active_states: ["Todo", "In Progress"] # column titles on the board.
                                         # Compared lower-case, so "todo"
                                         # matches "Todo" matches "TODO".
  terminal_states: ["Done"]              # Symphony default also accepts
                                         # ["Closed","Cancelled","Canceled","Duplicate","Done"]
                                         # — pick what your board uses.

  # Kangent-specific config under the tracker.kangent key. Symphony's spec
  # explicitly says unknown keys SHOULD be ignored (§5.3 forward-compat),
  # so we nest our extension here.
  kangent:
    endpoint: https://kangent-kangent-web-daniyaalbeg.danyaalbeg.workers.dev
    # The board this daemon runs against. Three resolution strategies, in
    # order — first match wins:
    #   1. explicit `board_id` here
    #   2. URL in this front matter (e.g. board_url: https://.../b/abc123)
    #   3. lookup via @kangent/agent-sdk → ~/.kangent/state.yaml using cwd
    board_id: abc123xyz789
    # Optional: only dispatch cards whose label set intersects this list.
    # Lower-cased. Empty/omitted means "all labels are eligible".
    label_filter: ["agent-ready"]
    # Optional: never dispatch cards carrying any of these labels. Useful
    # for `manual`, `do-not-touch`, etc.
    label_exclude: ["wip", "human-only"]
    # X-Agent-Id used by the daemon when polling /changes. Defaults to
    # `kangent-symphony-${agentId from state.yaml}` so multiple installs
    # don't share a cursor.
    agent_id: $KANGENT_AGENT_ID

polling:
  interval_ms: 30000

workspace:
  root: ~/.kangent/workspaces           # `~` expanded; per-issue subdir under here

hooks:
  after_create: |
    git clone git@github.com:acme/repo.git . || true
    pnpm install --frozen-lockfile
  before_run: |
    git fetch origin && git reset --hard origin/main
  after_run: |
    pnpm typecheck
  timeout_ms: 300000

agent:
  max_concurrent_agents: 3
  max_turns: 20
  max_retry_backoff_ms: 300000
  # Symphony §5.3.5: per-state concurrency override
  max_concurrent_agents_by_state:
    in progress: 2

codex:
  command: codex app-server
  approval_policy: never                 # high-trust default; see §15 of spec
  thread_sandbox: workspace-write
  turn_sandbox_policy: workspace-write
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000

# === Optional HTTP dashboard (Symphony §13.7) =================================
server:
  port: 7777                             # `0` for ephemeral; CLI --port wins
---

You are working on a Kangent card.

**{{ issue.identifier }} — {{ issue.title }}**
{% if issue.priority %}Priority: {{ issue.priority }}{% endif %}
{% if issue.dueDate %}Due: {{ issue.dueDate }}{% endif %}
{% if issue.labels.size > 0 %}Labels: {{ issue.labels | join: ", " }}{% endif %}

{{ issue.description }}

{% if attempt %}
This is attempt {{ attempt }} on this card. Previous attempts left context
in the workspace; check `git status` and the changelog before redoing work.
{% endif %}

When you finish, use the `kangent_card` tool to move this card to "Human
Review" with a one-line summary. If you need clarification, leave the card
in its current column and add a comment using the same tool.
```

### What the daemon reads vs. what the agent reads

- The **daemon** reads `tracker`, `polling`, `workspace`, `hooks`, `agent`,
  `codex`, `server` — i.e. everything in the front matter.
- The **agent** (Codex) sees only the rendered prompt body. The `issue`
  object passed to the template is the Symphony-normalized shape:

  | Symphony field       | Source on Kangent                                  |
  |----------------------|----------------------------------------------------|
  | `id`                 | `card.id` (opaque nanoid)                          |
  | `identifier`         | `card.identifier` (`<boardId>-<seq>`, server-stamped) |
  | `title`              | `card.title`                                       |
  | `description`        | `card.description` flattened to markdown by CLI    |
  | `priority`           | `card.priority` mapped: urgent→1, high→2, medium→3, low→4 |
  | `state`              | title of the column the card is in                 |
  | `branch_name`        | synthesised: `kangent/<identifier>` (no schema change) |
  | `url`                | `<endpoint>/b/<boardId>?card=<id>` (deep-link)     |
  | `labels`             | `card.labels`, lower-cased per Symphony §11.3      |
  | `blocked_by`         | `card.blockedBy` resolved against board state      |
  | `created_at`         | `card.createdAt`                                   |
  | `updated_at`         | `card.updatedAt`                                   |

### `kangent_card` — Symphony-style client-side tool

Symphony's spec ships a `linear_graphql` client-side tool extension
(§10.5). Our equivalent is `kangent_card`, advertised to the Codex session
when `tracker.kind: kangent`. It exposes a small, scoped surface so the
agent doesn't need raw HTTP credentials:

```json
{
  "name": "kangent_card",
  "input_schema": {
    "type": "object",
    "oneOf": [
      { "properties": { "action": { "const": "move" }, "to_state": { "type": "string" }, "comment": { "type": "string" } } },
      { "properties": { "action": { "const": "comment" }, "body": { "type": "string" } } },
      { "properties": { "action": { "const": "set_labels" }, "labels": { "type": "array", "items": { "type": "string" } } } },
      { "properties": { "action": { "const": "set_blocked_by" }, "identifiers": { "type": "array", "items": { "type": "string" } } } }
    ]
  }
}
```

Each call is scoped to **the card this session is working on** — no
cross-card writes from the agent side. The CLI uses the existing
`@kangent/agent-sdk` `KangentHttpClient` to perform the operation, so
nothing on the server side has to know about Symphony.

> Comments aren't a Kangent primitive yet — for v1, "comment" appends to
> `card.description` with a `> [agent] …` block. If we add a true comment
> entity later, this swaps over without changing the tool surface.

---

## 3. CLI directory layout

Adds **one new app** under `apps/` and reuses everything else through the
existing workspace packages.

```
kangent/
├── apps/
│   ├── web/                           # existing
│   └── orchestrator/                  # NEW — the daemon CLI
│       ├── package.json               # "bin": { "kangent": "./dist/cli/main.js" }
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       ├── src/
│       │   ├── cli/
│       │   │   ├── main.ts            # effect/unstable/cli entry, sets up Layers
│       │   │   └── commands/
│       │   │       ├── run.ts         # `kangent run [./WORKFLOW.md]` — daemon
│       │   │       ├── doctor.ts      # `kangent doctor` — preflight (auth, codex bin, board)
│       │   │       ├── workflow.ts    # `kangent workflow validate|show`
│       │   │       └── status.ts      # `kangent status` — talks to dashboard
│       │   ├── domain/
│       │   │   ├── Workflow.ts        # Schema for WORKFLOW.md frontmatter + body
│       │   │   ├── Issue.ts           # Symphony-shaped Issue (Schema.Struct)
│       │   │   ├── RunState.ts        # orchestrator state (running/claimed/retries)
│       │   │   └── errors.ts          # tagged errors (Schema.TaggedErrorClass)
│       │   ├── services/
│       │   │   ├── Tracker.ts         # tracker interface (Context.Service)
│       │   │   ├── TrackerKangent.ts  # the kangent adapter (Layer.effect)
│       │   │   ├── WorkflowLoader.ts  # reads + parses WORKFLOW.md, watches for changes
│       │   │   ├── WorkspaceManager.ts# per-issue dirs, sanitisation, hooks
│       │   │   ├── CodexProcess.ts    # spawns codex app-server, parses jsonrpc
│       │   │   ├── AgentRunner.ts     # workspace + prompt + codex glue
│       │   │   ├── Orchestrator.ts    # poll loop, dispatch, retry, reconcile
│       │   │   └── Dashboard.ts       # optional HTTP server (Symphony §13.7)
│       │   ├── layers/
│       │   │   ├── AppLayer.ts        # composes Live impls for prod
│       │   │   └── TestLayer.ts       # composes test impls
│       │   └── runtime/
│       │       ├── Logger.ts          # JSON-to-stderr structured logger
│       │       └── Telemetry.ts       # OPTIONAL: @effect/opentelemetry wiring
│       └── test/
│           └── services/*.test.ts
├── packages/
│   ├── board-core/                    # existing — REUSED for KangentApi typed client
│   ├── board-worker/                  # existing
│   └── agent-sdk/                     # existing — REUSED for state.yaml + http client
└── ...
```

### Why this shape

- **One app, not a package.** The CLI is a leaf binary; nothing else
  imports it. Apps are the right home for executables in this monorepo.
- **`@kangent/agent-sdk` already does the per-cwd → board resolution.**
  We don't reinvent `~/.kangent/state.yaml`; the orchestrator reuses
  `getBoardForProject(cwd)` and `getAgentId()`. The state-file helpers
  are pure `node:fs` + `yaml` (no Effect runtime), and the
  `makeClient(baseUrl)` factory uses v4's `HttpApiClient.make` against
  the shared `KangentApi`.
- **`Tracker.ts` is the adapter seam.** Today the only impl is
  `TrackerKangent.ts`; if/when we add another tracker (Linear, GitHub
  Issues), it's a new Layer that satisfies the same `Context.Service`.
- **`KangentApi` reuse is end-to-end typed.** Both `board-core` and the
  CLI app are on Effect v4, so the CLI imports `KangentApi` directly
  and gets a fully-typed client for free — exactly the pattern v4's
  `effect/unstable/httpapi` is built around.

## 4. Effect v4 beta stack

The CLI targets **Effect v4 beta** end-to-end. v4 consolidates the
ecosystem into two npm packages — everything that used to live in
`@effect/platform`, `@effect/cli`, `@effect/schema`, `@effect/rpc`,
`@effect/cluster` is now under `effect/unstable/*`. Only platform-specific
runtimes (`@effect/platform-node`, `@effect/platform-bun`, etc.) remain
separate.

### Direct dependencies — `apps/orchestrator/package.json`

```jsonc
{
  "name": "@kangent/cli",
  "type": "module",
  "bin": { "kangent": "./dist/cli/main.js" },
  "dependencies": {
    "@kangent/board-core":    "workspace:*",
    "@kangent/agent-sdk":     "workspace:*",
    "effect":                 "4.0.0-beta.64",
    "@effect/platform-node":  "4.0.0-beta.64",
    "yaml":                   "^2",
    "gray-matter":            "^4"
  },
  "devDependencies": {
    "typescript": "^5.6",
    "tsx":        "^4",
    "vitest":     "^2"
  }
}
```

Notes:

- **`effect` and `@effect/platform-node` versions MUST match exactly.**
  v4 is single-versioned. The `beta` dist-tag rolls forward and breaks
  between minor releases under `effect/unstable/*` are explicitly allowed
  by policy. Pin exact versions in CI.
- **Do not install `@effect/cli`** — that npm package is frozen on v3
  (latest `0.75.1`). The v4 CLI lives at `effect/unstable/cli`.
- **`@kangent/board-core` is consumed for `KangentApi`** — the existing
  workspace package was already migrated to v4, so the CLI gets a typed
  `HttpApiClient` from it directly.

### Imports — every v4 import the CLI needs

```ts
// Stable, top-level
import {
  Effect, Layer, Schema, Stream, Queue, FiberSet,
  Schedule, Duration, Context, ManagedRuntime, Console,
} from "effect"

// CLI (formerly @effect/cli)
import { Command, Argument, Flag, Prompt } from "effect/unstable/cli"

// Subprocess (formerly @effect/platform Command/CommandExecutor)
import { ChildProcess } from "effect/unstable/process"

// HttpApi + client (formerly @effect/platform)
import {
  HttpApi, HttpApiClient, HttpApiEndpoint,
  HttpApiGroup, HttpApiSchema,
} from "effect/unstable/httpapi"
import { HttpClient, FetchHttpClient } from "effect/unstable/http"

// Node platform
import {
  NodeRuntime,        // runMain
  NodeServices,       // FS + Path + Stdio + Terminal + ChildProcessSpawner
  NodeFileSystem,
  NodePath,
  NodeHttpClient,
} from "@effect/platform-node"
```

Heads-up on renames:
- `Args` → `Argument`, `Options` → `Flag` (CLI)
- `NodeContext.layer` → `NodeServices.layer`
- `Command.start` → `ChildProcess.make` (template-literal)
- `Schema.Literal("a", "b")` → `Schema.Literals(["a", "b"])`
- `Schema.Union(A, B)` → `Schema.Union([A, B])`
- `Schema.TaggedError` → `Schema.TaggedErrorClass`
- `Effect.Service` is deprecated; use `Context.Service` (no auto-`.Default`
  layer in v4 — write it yourself).

### CLI entry — full minimal v4 shape

```ts
// apps/orchestrator/src/cli/main.ts
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { AppLayer } from "../layers/AppLayer.js"
import { run } from "./commands/run.js"
import { doctor } from "./commands/doctor.js"
import { workflow } from "./commands/workflow.js"
import { status } from "./commands/status.js"

const root = Command.make("kangent").pipe(
  Command.withSubcommands([run, doctor, workflow, status]),
)

const cli = Command.run(root, { version: "0.1.0" })

cli(process.argv).pipe(
  Effect.provide(AppLayer),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
```

`Command.run` no longer takes `name` (it comes from `Command.make`). The
required services for any v4 CLI — `FileSystem | Path | Terminal |
ChildProcessSpawner | Stdio` — are all provided by `NodeServices.layer`.

### A subcommand with options + an argument

```ts
// apps/orchestrator/src/cli/commands/run.ts
import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Orchestrator } from "../../services/Orchestrator.js"

const workflowPath = Argument.path("workflow", { exists: "yes" }).pipe(
  Argument.optional,
  Argument.withDefault("./WORKFLOW.md"),
)
const port = Flag.integer("port").pipe(
  Flag.optional,
  Flag.withDescription("Bind the local dashboard on this port"),
)
const once = Flag.boolean("once").pipe(
  Flag.withDescription("Drain the ready queue and exit instead of looping"),
)

export const run = Command.make(
  "run",
  { workflowPath, port, once },
  ({ workflowPath, port, once }) =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator
      yield* orch.start({ workflowPath, port, once })
    }),
)
```

### Service definition — `Context.Service` (the v4-canonical pattern)

```ts
// apps/orchestrator/src/services/Tracker.ts
import { Context, Effect } from "effect"
import type { Issue } from "../domain/Issue.js"
import type { TrackerError } from "../domain/errors.js"

export interface TrackerImpl {
  readonly fetchCandidateIssues: () => Effect.Effect<readonly Issue[], TrackerError>
  readonly fetchIssuesByStates: (states: readonly string[]) => Effect.Effect<readonly Issue[], TrackerError>
  readonly fetchIssueStatesByIds: (ids: readonly string[]) => Effect.Effect<readonly Issue[], TrackerError>
}

export class Tracker extends Context.Service<Tracker>()("app/Tracker", {
  // `make` is the canonical Effect that builds the service. The `layer`
  // exposes it; in v4 you write the layer explicitly (no auto-`.Default`).
  make: Effect.die("Tracker has no default; provide a concrete impl") as Effect.Effect<TrackerImpl>,
}) {}
```

```ts
// apps/orchestrator/src/services/TrackerKangent.ts — the kangent adapter
import { Effect, Layer } from "effect"
import { HttpApiClient } from "effect/unstable/httpapi"
import { NodeHttpClient } from "@effect/platform-node"
import { KangentApi } from "@kangent/board-core"     // shared workspace package
import { Tracker } from "./Tracker.js"
import { WorkflowConfig } from "./WorkflowLoader.js"
import { mapCardToIssue } from "../domain/Issue.js"

export const TrackerKangentLayer = Layer.effect(
  Tracker,
  Effect.gen(function* () {
    const cfg     = yield* WorkflowConfig
    const client  = yield* HttpApiClient.make(KangentApi, { baseUrl: cfg.kangent.endpoint })
    const boardId = cfg.kangent.boardId

    return {
      fetchCandidateIssues: () =>
        client.boards.getBoardState({ path: { boardId } }).pipe(
          Effect.map((res) =>
            res.board.cards
              .map(mapCardToIssue(cfg.kangent.endpoint, boardId))
              .filter((i) => isActiveState(cfg, i.state))
              .filter((i) => passesLabelFilter(cfg, i)),
          ),
        ),
      fetchIssueStatesByIds: (ids) =>
        client.boards.getBoardState({ path: { boardId } }).pipe(
          Effect.map((res) =>
            res.board.cards
              .filter((c) => ids.includes(c.id))
              .map(mapCardToIssue(cfg.kangent.endpoint, boardId)),
          ),
        ),
      fetchIssuesByStates: (states) =>
        client.boards.getBoardState({ path: { boardId } }).pipe(
          Effect.map((res) =>
            res.board.cards
              .map(mapCardToIssue(cfg.kangent.endpoint, boardId))
              .filter((i) => states.some((s) => s.toLowerCase() === i.state.toLowerCase())),
          ),
        ),
    }
  }),
).pipe(Layer.provide(NodeHttpClient.layerUndici))
```

> v1 polls `/state` per tick and filters in-memory — cheap because Kangent
> caps at 500 cards/column. When that hurts, add the server-side
> `GET /api/boards/:id/cards?states=...` endpoint and swap the method body.
> Tracker interface is unchanged.

### Subprocess — `ChildProcess.make` template literals

```ts
// apps/orchestrator/src/services/CodexProcess.ts (excerpt)
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"

export const startCodex = (workspace: string) =>
  Effect.gen(function* () {
    // Template-literal builds the command lazily. `yield*` spawns it
    // inside the surrounding Scope.
    const handle = yield* ChildProcess.make({
      cwd: workspace,
      stdin: "pipe",
    })`bash -lc "codex app-server"`

    const events = handle.stdout.pipe(
      Stream.decodeText("utf8"),
      Stream.splitLines,
      Stream.mapEffect((line) => Effect.try(() => JSON.parse(line))),
    )

    return { handle, events, exit: handle.exitCode }
  }).pipe(Effect.scoped)   // ← finalizer kills the child on interrupt
```

`Effect.scoped` is still the safety story: SIGINT propagates through the
fiber tree, finalizers run in reverse order, every spawned codex gets
reaped before the orchestrator exits. The platform implementation comes
from `NodeChildProcessSpawner.layer`, which is bundled into
`NodeServices.layer`.

### Concurrent worker pool — same primitives, top-level imports

```ts
// apps/orchestrator/src/services/Orchestrator.ts (sketch)
import { Duration, Effect, FiberSet, Queue, Schedule } from "effect"

export const orchestrate = (n: number) =>
  Effect.gen(function* () {
    const tasks  = yield* Queue.bounded<Issue>(256)
    const fibers = yield* FiberSet.make()

    yield* FiberSet.run(fibers, reconcileLoop(tasks))   // poll-and-enqueue

    yield* Effect.forEach(
      Array.from({ length: n }),
      () =>
        FiberSet.run(
          fibers,
          Effect.forever(
            Queue.take(tasks).pipe(
              Effect.flatMap(runOneTurn),
              Effect.retry({
                schedule: Schedule.exponential("10 seconds", 2)
                  .pipe(Schedule.jittered, Schedule.upTo("5 minutes")),
                while: (e) => e._tag === "Transient",
              }),
              Effect.timeout(Duration.minutes(60)),     // turn timeout
              Effect.catchAll(reportFailure),
            ),
          ),
        ),
      { discard: true },
    )

    yield* FiberSet.join(fibers)
  }).pipe(Effect.scoped)
```

`Queue`, `FiberSet`, `Schedule`, `Duration` all live at the top of `effect`
in v4 — same import paths as v3.

### Logging

`Effect.log*` everywhere; replace the default logger with a JSON-to-stderr
formatter so stdout stays clean for `--json`-mode subcommands. v4 keeps
`Logger` and `LogLevel` at the top level (`import { Logger, LogLevel } from "effect"`).
OpenTelemetry spans piggy-back via `Effect.withSpan` once we wire
`@effect/opentelemetry@4.x` (also single-version-pinned).

### v4 beta caveats — read before merging the build PR

- **Pin exact beta versions.** `effect` and `@effect/platform-node` are
  jointly versioned and beta-tagged releases break under
  `effect/unstable/*`. Use `4.0.0-beta.64` (or whatever the latest is at
  build time) — do not use `^4.0.0-beta` or the `beta` dist-tag in
  committed lockfiles. Bumping is a manual, intentional step.
- **`effect/unstable/*` is unstable on purpose.** CLI, HttpApi, ChildProcess,
  RPC live there. Expect breakage between betas; budget time to chase
  renames/signature shifts at every bump until v4 promotes them out of
  unstable.
- **Workspace is single-version v4.** `board-core`, `board-worker`,
  `agent-sdk` are all on `effect@4.0.0-beta.64`. Bumping the beta is a
  whole-monorepo change — keep all four packages on the exact same
  version in lockstep.
- **Deprecated patterns to avoid in new code.** Do not use `Effect.Service`,
  `Context.Tag`, `NodeContext`, `Args`, `Options`, `Schema.Literal` with
  multiple positional args, `Schema.TaggedError`, `Schema.Union(A, B)`
  (variadic), `Runtime<R>`, `addError(E, { status })`, the
  `setPayload`/`addSuccess`/`addError` builder chain on
  `HttpApiEndpoint`. They either fail to import or fail at compile time
  in v4.

---

## 5. Resolved decisions (this round)

- **Identifier scheme:** `<boardId>-<seq>`, server-stamped on creation,
  per-board monotonic, never recycled. Backfilled lazily on first access
  for legacy cards. Implemented in this commit.
- **Default columns:** `["Todo", "In Progress", "Done"]` to match
  Symphony's default `tracker.active_states` / `terminal_states`.
- **Labels & blockedBy:** added to `Card`, full-replace semantics on
  update, server preserves case + rejects empties + dedupes.

## 6. Deferred decisions (TODOs)

- **Auth.** Boards remain URL-as-secret for v1. Add scoped agent tokens
  (`X-Agent-Token` plus a tokens DO) once the orchestrator is in real use.
- **Multi-agent runtime.** Spec is Codex-shaped (`codex app-server`). To
  support Claude Code / Cursor later, generalise `codex.command` into an
  "agent app-server command" and document the protocol shim. TODO.
- **Server-side Symphony view.** Optional `/api/boards/:id/symphony/*`
  endpoints that return already-normalised Symphony Issue shapes.
  Speeds up other-language Symphony runners; the CLI doesn't strictly
  need it.
- **Server-side filter endpoint.** `GET /api/boards/:id/cards?states=...&labels=...`
  for efficient polling on large boards.
- **Comment primitive.** Promote `kangent_card` → `comment` from
  description-append to a real comment entity once we have one.

## 7. Open questions for the build phase

1. Where does the daemon write logs by default? `~/.kangent/logs/` per board?
2. Workspace cleanup — Symphony preserves on success. Do we surface a
   `kangent gc` subcommand to wipe finished workspaces older than N days?
3. `kangent run --once` for CI / scheduled-run modes vs the default
   long-lived loop?
4. Does the dashboard share the homepage's design system or stay
   text-only / pure JSON for v1?
