/**
 * Per-process dispatch coordinator.
 *
 * Two responsibilities:
 *
 *   1. Filter out issues that are already in-flight in this process. The
 *      daemon's poll cycle fires every `polling.interval_ms` regardless
 *      of run duration, so on the second tick we'd otherwise re-claim
 *      cards we already moved into `In Progress` and re-spawn codex on
 *      them. The active set is the smallest correct fix: track issue ids
 *      currently being run, skip dispatch if already present.
 *
 *   2. Drive `AgentRunner.run` per issue with bounded concurrency, swallowing
 *      per-issue failures into `DispatchOutcome { outcome: "failed" }` so
 *      one bad card never aborts the rest of the tick.
 *
 * The active set is in-memory. Cards orphaned by a crash (claimed into
 * `In Progress` by a previous process and never reconciled) are a
 * separate concern — Symphony §8.6 startup reconciliation, "next phase".
 */

import { Context, Effect, Layer, Ref } from "effect";
import type { OrchestratorError } from "../domain/errors.js";
import type { Issue } from "../domain/Issue.js";
import { AgentRunner, type DispatchOutcome } from "./AgentRunner.js";
import { CodexProcess } from "./CodexProcess.js";
import type { DispatchPlan } from "./Orchestrator.js";
import { Tracker } from "./Tracker.js";
import { WorkflowConfig } from "./WorkflowLoader.js";
import { WorkspaceManager } from "./WorkspaceManager.js";

export interface DispatchPlanResult {
	/** Outcomes for issues this call actually started — excludes the ones
	 * filtered out because they were already in flight. */
	readonly outcomes: readonly DispatchOutcome[];
	/** Issues skipped because they were already in the active set. The
	 * daemon loop logs these at debug level so it's visible when a poll
	 * tick was a no-op. */
	readonly skipped: readonly Issue[];
}

export interface DispatcherImpl {
	/**
	 * Dispatch the ready issues in `plan` whose ids aren't currently in
	 * the active set. The active set is updated atomically per-issue at
	 * the boundary of `AgentRunner.run`, so a card's id is added before
	 * codex starts and removed after the outcome is recorded — including
	 * on interrupt, via `Effect.ensuring`.
	 *
	 * `concurrency` caps simultaneous AgentRunners (Symphony agent.max_concurrent_agents).
	 */
	readonly dispatchPlan: (
		plan: DispatchPlan,
		options: { readonly concurrency: number },
	) => Effect.Effect<
		DispatchPlanResult,
		never,
		AgentRunner | Tracker | CodexProcess | WorkflowConfig | WorkspaceManager
	>;

	/** Snapshot of currently-running issue ids. For tests + future `status`. */
	readonly activeIssueIds: () => Effect.Effect<ReadonlySet<string>>;
}

export class Dispatcher extends Context.Service<Dispatcher, DispatcherImpl>()(
	"orchestrator/Dispatcher",
) {}

export const DispatcherLayer = Layer.effect(
	Dispatcher,
	Effect.gen(function* () {
		const active = yield* Ref.make<ReadonlySet<string>>(new Set());

		// Try-claim: returns `true` if the issue was already in the set
		// (caller should skip), `false` if we just added it (caller proceeds
		// and must call `release` in a `finally`-equivalent).
		const tryClaim = (id: string): Effect.Effect<boolean> =>
			Ref.modify(active, (set) => {
				if (set.has(id)) return [true, set];
				const next = new Set(set);
				next.add(id);
				return [false, next];
			});

		const release = (id: string): Effect.Effect<void> =>
			Ref.update(active, (set) => {
				if (!set.has(id)) return set;
				const next = new Set(set);
				next.delete(id);
				return next;
			});

		// Per-issue: claim, run, release. Returns `null` for skipped, or
		// the DispatchOutcome. The outer `Effect.forEach` filters out nulls.
		const dispatchOne = (
			issue: Issue,
		): Effect.Effect<
			DispatchOutcome | { readonly skipped: Issue },
			never,
			AgentRunner | Tracker | CodexProcess | WorkflowConfig | WorkspaceManager
		> =>
			Effect.gen(function* () {
				const alreadyRunning = yield* tryClaim(issue.id);
				if (alreadyRunning) {
					return { skipped: issue } as const;
				}
				const runner = yield* AgentRunner;
				return yield* runner.run(issue).pipe(
					// Convert per-issue OrchestratorError → "failed" outcome so
					// one bad card doesn't fail the whole tick. The reason
					// flows into the outcome string for visibility.
					Effect.matchEffect({
						onFailure: (cause: OrchestratorError) =>
							Effect.succeed({
								issue,
								outcome: "failed" as const,
								reason: cause.message,
							} satisfies DispatchOutcome),
						onSuccess: (result) => Effect.succeed(result),
					}),
					// Always release on the way out — success, failure, or interrupt.
					Effect.ensuring(release(issue.id)),
				);
			});

		const dispatchPlan: DispatcherImpl["dispatchPlan"] = (plan, { concurrency }) =>
			Effect.forEach(plan.ready, dispatchOne, { concurrency }).pipe(
				Effect.map((results) => {
					const outcomes: DispatchOutcome[] = [];
					const skipped: Issue[] = [];
					for (const r of results) {
						if ("skipped" in r) skipped.push(r.skipped);
						else outcomes.push(r);
					}
					return { outcomes, skipped } satisfies DispatchPlanResult;
				}),
			);

		return {
			dispatchPlan,
			activeIssueIds: () => Ref.get(active),
		};
	}),
);
