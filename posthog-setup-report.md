<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog into the Kangent project. `posthog-node` was installed in both `apps/web` and `packages/board-worker`. A `PostHog` client is instantiated per-request with `flushAt: 1` and `flushInterval: 0` (appropriate for Cloudflare Workers / serverless environments), and events are sent immediately using `captureImmediate` followed by `shutdown()`. The `POSTHOG_API_KEY` and `POSTHOG_HOST` environment variables are read from the Cloudflare Worker `Env` bindings and stored in `apps/web/.dev.vars` for local development.

The `actor_type` property (derived from the `by` field, e.g. `human` or `ai`) is included on every event so you can filter and compare human-driven vs agent-driven activity across all insights.

| Event | Description | File |
|-------|-------------|------|
| `board created` | A new Kanban board was created (by a human or an agent) | `apps/web/src/worker.ts` |
| `board viewed` | A board's full state was fetched (first access or state sync) | `packages/board-worker/src/BoardAgent.ts` |
| `board updated` | A board's title or description was changed | `packages/board-worker/src/BoardAgent.ts` |
| `card added` | A new card was added to a column | `packages/board-worker/src/BoardAgent.ts` |
| `card updated` | A card's title, description, priority, or due date was changed | `packages/board-worker/src/BoardAgent.ts` |
| `card moved` | A card was moved to a different column or position | `packages/board-worker/src/BoardAgent.ts` |
| `card deleted` | A card was deleted from a board | `packages/board-worker/src/BoardAgent.ts` |
| `column added` | A new column was added to a board | `packages/board-worker/src/BoardAgent.ts` |
| `column deleted` | A column was deleted from a board (with cards moved count) | `packages/board-worker/src/BoardAgent.ts` |

Error tracking using `captureExceptionImmediate` was added to the `handleError` method in `BoardAgent.ts` to capture unexpected 500-level errors.

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- 📊 **Dashboard — Analytics basics**: https://eu.posthog.com/project/170812/dashboard/656235
- 📈 **Board creations over time** (daily line chart): https://eu.posthog.com/project/170812/insights/Qe6a9boB
- 📊 **Card activity: human vs agent** (bar chart broken down by actor_type): https://eu.posthog.com/project/170812/insights/7sfyOKGP
- 🔻 **Board activation funnel** (board created → card added → card moved): https://eu.posthog.com/project/170812/insights/ij7gN0T4
- 📉 **Total board & card activity** (area chart of all key events): https://eu.posthog.com/project/170812/insights/vBZ9rQFL
- 📊 **Card retention: add vs delete ratio** (weekly add vs delete trend): https://eu.posthog.com/project/170812/insights/cMXp4bXv

**Production deployment note:** Add `POSTHOG_API_KEY` and `POSTHOG_HOST` as Cloudflare Worker secrets via `wrangler secret put POSTHOG_API_KEY` before deploying to production.

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
