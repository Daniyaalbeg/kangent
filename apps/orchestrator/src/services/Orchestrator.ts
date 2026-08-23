/**
 * The dispatch authority. Symphony §7-§8.
 *
 * MVP scope: `pollOnce()` performs one tick — fetch candidates, apply
 * Symphony's blocker rule and sort order, and return the issues that
 * would be dispatched. No worker spawn, no retry queue, no reconciliation
 * loop. The full state machine lands in the next phase, once
 * `AgentRunner` and `CodexProcess` are real.
 */

import { Context, Effect, Layer, Order } from "effect";
import type { Issue } from "../domain/Issue.js";
import { Tracker } from "./Tracker.js";
import { WorkflowConfig } from "./WorkflowLoader.js";

export interface DispatchPlan {
	/** Candidate issues for this tick, sorted by Symphony's dispatch order. */
	readonly ready: readonly Issue[];
	/** Issues filtered out by the blocker rule (Symphony §8.2). */
	readonly blocked: readonly Issue[];
	/** Total candidates returned by the tracker before filtering. */
	readonly totalCandidates: number;
}

export interface OrchestratorImpl {
	readonly pollOnce: () => Effect.Effect<DispatchPlan, never, Tracker | WorkflowConfig>;
}

export class Orchestrator extends Context.Service<
	Orchestrator,
	OrchestratorImpl
>()("orchestrator/Orchestrator") {}

// --- Symphony §8.2 dispatch sort ---------------------------------------

/**
 * Lower priority numbers sort first. Symphony §8.2 also says null/unknown
 * priorities sort last, then ties break on `created_at` oldest first,
 * then on `identifier` lexicographic.
 */
export const dispatchOrder: Order.Order<Issue> = (a, b) => {
	const ap = a.priority ?? Number.MAX_SAFE_INTEGER;
	const bp = b.priority ?? Number.MAX_SAFE_INTEGER;
	if (ap !== bp) return ap < bp ? -1 : 1;

	const at = a.created_at ?? "";
	const bt = b.created_at ?? "";
	if (at !== bt) return at < bt ? -1 : 1;

	return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
};

// --- Symphony §8.2 blocker rule ----------------------------------------

/**
 * Issues in the entry state are not eligible while any blocker is non-
 * terminal. Issues in other active states (e.g. `In Progress`) are
 * dispatched regardless of blockers — the agent is presumed already working.
 *
 * Symphony §8.2 defines the entry state as the first of `active_states`,
 * NOT the literal column name "Todo" — so this takes it as a parameter.
 * For the default Symphony config (`active_states: ["Todo", "In Progress"]`)
 * that resolves to "Todo"; for a board with `active_states: ["Backlog",
 * "Doing"]` it resolves to "Backlog".
 */
export function isBlocked(
	issue: Issue,
	entryState: string,
	terminalStates: readonly string[],
): boolean {
	if (issue.state.toLowerCase() !== entryState.toLowerCase()) return false;
	const terminal = new Set(terminalStates.map((s) => s.toLowerCase()));
	return issue.blocked_by.some(
		(b) => b.state === null || !terminal.has(b.state.toLowerCase()),
	);
}

// --- Layer -------------------------------------------------------------

export const OrchestratorLayer = Layer.succeed(Orchestrator, {
	pollOnce: () =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const cfg = yield* WorkflowConfig;
			const all = yield* tracker.fetchCandidateIssues().pipe(
				// Tracker errors get swallowed for the MVP — the CLI
				// command surfaces them through its own error handling.
				// Real orchestrator skips the tick on tracker failure
				// (Symphony §8.1 sequence step 3).
				Effect.match({
					onFailure: () => [] as readonly Issue[],
					onSuccess: (issues) => issues,
				}),
			);

			// Entry state is the first of active_states (Symphony §8.2).
			// Fall back to "Todo" only if the workflow explicitly configured
			// an empty active_states list (which would also fail isBlocked
			// elsewhere; this just gives a clean no-op).
			const entryState =
				cfg.config.tracker.active_states[0] ?? "Todo";
			const blocked: Issue[] = [];
			const ready: Issue[] = [];
			for (const issue of all) {
				if (
					isBlocked(
						issue,
						entryState,
						cfg.config.tracker.terminal_states,
					)
				) {
					blocked.push(issue);
				} else {
					ready.push(issue);
				}
			}

			ready.sort((a, b) => dispatchOrder(a, b));
			return {
				ready,
				blocked,
				totalCandidates: all.length,
			};
		}),
});
