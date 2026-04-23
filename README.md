# Kangent

Real-time Kanban boards for humans and agents. Boards live at URLs, authenticated by a bearer token. Any agent with HTTP access can create boards, manage cards and columns, and sync incrementally via the `/changes` endpoint.

## Setup

```bash
pnpm install
```

### Dev

No env file needed. Homepage install blocks, SKILL.md, `.well-known/kangent.json`, and `/agent-docs` all derive their URLs from the request origin, so running locally shows localhost URLs automatically.

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
worker (`/kangent.SKILL.md`, `/api/boards/*`, `/.well-known/kangent.json`,
`/agent-docs`) are only reachable through this path — a bare `vite` will 404
them because only the SPA assets are served.

## Repo layout

- `apps/web` — React + TanStack Router + Vite. Serves the homepage, the SPA board UI, and the worker entry that fronts the Durable Object.
- `packages/board-core` — Effect `HttpApi` contract, Schemas, domain errors. Single source of truth for request/response shapes.
- `packages/board-worker` — `BoardDO` Durable Object. Owns per-board state, the changelog, and WebSocket presence.
- `packages/agent-sdk` — (reserved) typed client for agents.

## Agent integration

Agents consume three things:

1. The skill file. Two ways in:
   - **Recommended:** `npx skills add daniyaalbeg/kangent` — uses the [skills.sh](https://skills.sh) CLI, which handles Claude Code / Codex / other agent-family routing for you. Requires the GitHub repo to be published (see TODO).
   - **Live from a running instance:** `GET /kangent.SKILL.md` — dynamic, always matches the current deployment's URLs (localhost in dev, prod host in prod). Also mirrored at `/agent-docs` as HTML.
2. `GET /.well-known/kangent.json` — discovery record with skill/api/docs URLs.
3. `/api/boards/...` — the HTTP API. **Critical endpoint:** `GET /api/boards/:boardId/changes` with an `X-Agent-Id` header returns only what changed since that agent's last visit. Agents should call this before reading or writing.

The skill file tells agents how to use all of the above; the homepage has a copyable install command + a paste-into-chat prompt.

## TODO

- [ ] **Publish a skill repo so `npx skills add daniyaalbeg/kangent` works.** The homepage install command hardcodes the slug `daniyaalbeg/kangent`; change it in `apps/web/src/components/InstallBlock.tsx` (`SKILL_REPO`) if you pick a different owner/name. The repo needs `SKILL.md` at the root with production URLs baked in — simplest path is a dedicated repo with a CI job that regenerates it from `buildSkillMd(<prod-url>)` on each main-branch push so it never drifts.
- [ ] `POST /api/bridge/report_bug` — accept `{summary, context, evidence}` from confused agents, forward to a GitHub issue / Discord webhook / log sink.
- [ ] Generate `openapi.json` from `KangentApi` (Effect `OpenApi.fromApi`) at build time so the spec never drifts from the server.
- [ ] Generate the `## API Reference` section of `SKILL.md` from the OpenAPI spec at build time (downstream of the item above).
- [ ] Replace hand-rolled routing in `BoardDO.routeApi` with `HttpApiBuilder.api(KangentApi)` so `handlers.ts` becomes the canonical server and the contract in `api.ts` is enforced.
- [ ] Production domain: swap `VITE_KANGENT_PUBLIC_URL` away from the `*.workers.dev` placeholder once DNS is cut over.
