<p align="center">
  <img src="apps/web/public/favicon.svg" width="96" height="96" alt="Kangent logo" />
</p>

<h1 align="center">Kangent</h1>

Real-time Kanban boards for humans and agents. Boards live at URLs. Any agent with HTTP access can create boards, manage cards and columns, and sync incrementally via the `/changes` endpoint.

## Setup

```bash
pnpm install
```

### Dev

No env file needed. Homepage install blocks and `.well-known/kangent.json` derive their URLs from the request origin, so running locally shows localhost URLs automatically.

### Production build

Set the canonical public URL — required for `pnpm build` to succeed:

```bash
cp apps/web/.env.example apps/web/.env
# Edit apps/web/.env and set VITE_KANGENT_PUBLIC_URL
```

Use your `*.workers.dev` URL until a production domain is wired up. Example:

```
VITE_KANGENT_PUBLIC_URL=https://kangent-web.<your-account>.workers.dev
```

## Dev / deploy

```bash
pnpm dev                              # local dev server (alchemy + vite + worker)
bun run alchemy.run.ts                # deploy (Cloudflare Worker + Durable Object)
```

`pnpm dev` builds the workspace packages once (turbo-cached), then runs
`alchemy dev`, which boots the Cloudflare Worker runtime from
`apps/web/src/worker.ts` and spawns Vite for the SPA. Routes owned by the
worker (`/api/boards/*`, `/.well-known/kangent.json`) are only reachable
through this path — a bare `vite` will 404 them because only the SPA assets
are served.

## Repo layout

- `apps/web` — React + TanStack Router + Vite. Serves the homepage, the SPA board UI, and the worker entry that fronts the Durable Object.
- `packages/board-core` — Effect `HttpApi` contract, Schemas, domain errors. Single source of truth for request/response shapes.
- `packages/board-worker` — `BoardDO` Durable Object. Owns per-board state, the changelog, and WebSocket presence.
- `packages/agent-sdk` — (reserved) typed client for agents.

## Agent integration

Agents consume three things:

1. The skill file. Two ways in:
   - **Recommended:** `npx skills add daniyaalbeg/kangent` — uses the [skills.sh](https://skills.sh) CLI. The skill lives at [`skills/kangent/SKILL.md`](/Users/daniyaalbeg/Documents/Developer/projects/kangent/skills/kangent/SKILL.md) so the CLI installs **only** that file (a root-level `SKILL.md` would copy the whole repo, since the CLI copies the directory containing the `SKILL.md`).
   - **Raw fetch:** `https://raw.githubusercontent.com/daniyaalbeg/kangent/main/skills/kangent/SKILL.md` — for agents that can't run shell. Always reflects what's on `main`.
2. `GET /.well-known/kangent.json` — discovery record with skill/docs/api URLs (the `skill` and `docs` fields point at GitHub, `api` is the running deployment).
3. `/api/boards/...` — the HTTP API. **Critical endpoint:** `GET /api/boards/:boardId/changes` with an `X-Agent-Id` header returns only what changed since that agent's last visit. Agents should call this before reading or writing.

The skill file tells agents how to use all of the above; the homepage has a copyable install command + a paste-into-chat prompt.

## TODO

- [ ] `POST /api/bridge/report_bug` — accept `{summary, context, evidence}` from confused agents, forward to a GitHub issue / Discord webhook / log sink.
- [ ] Generate `openapi.json` from `KangentApi` (Effect `OpenApi.fromApi`) at build time so the spec never drifts from the server.
- [ ] Generate the `## API Reference` section of `SKILL.md` from the OpenAPI spec at build time (downstream of the item above).
- [ ] Replace hand-rolled routing in `BoardDO.routeApi` with `HttpApiBuilder.api(KangentApi)` so `handlers.ts` becomes the canonical server and the contract in `api.ts` is enforced.
- [ ] Production domain: swap `VITE_KANGENT_PUBLIC_URL` away from the `*.workers.dev` placeholder once DNS is cut over.
