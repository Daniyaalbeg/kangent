/**
 * Tracker interface — the seam Symphony §11.1 defines for issue-tracker
 * adapters. Today the only impl is `TrackerKangent`; another tracker
 * (Linear, GitHub Issues, …) is a new Layer satisfying this contract.
 *
 * The orchestrator only ever holds a `Tracker`, never a concrete adapter,
 * so it stays tracker-agnostic.
 */

import { Context, type Effect } from "effect";
import type { TrackerError } from "../domain/errors.js";
import type { Issue } from "../domain/Issue.js";

export interface TrackerImpl {
	/**
	 * Issues currently in any of the workflow's `tracker.active_states`.
	 * Filtered for dispatch eligibility (label allow/deny lists, etc.).
	 * Symphony §11.1.1.
	 */
	readonly fetchCandidateIssues: () => Effect.Effect<readonly Issue[], TrackerError>;

	/**
	 * Issues currently in any of the supplied `state_names`. Used by the
	 * startup terminal-cleanup pass (§8.6). Returns minimal records — the
	 * caller only needs identifiers to walk workspace dirs.
	 */
	readonly fetchIssuesByStates: (
		stateNames: readonly string[],
	) => Effect.Effect<readonly Issue[], TrackerError>;

	/**
	 * Current state for a known set of issue ids. Used by active-run
	 * reconciliation (§8.5). Returns minimal records too — only `state`
	 * must be present for the caller to act on it.
	 */
	readonly fetchIssueStatesByIds: (
		ids: readonly string[],
	) => Effect.Effect<readonly Issue[], TrackerError>;

	/**
	 * Transition an issue to a new state. Symphony §11.1.2 — the
	 * orchestrator owns "Todo → In Progress" at dispatch start and "any
	 * active → Todo" on failure; agents move cards into terminal states
	 * themselves via tool calls. `stateName` is matched case-insensitively
	 * against the tracker's native states (column titles for Kangent).
	 */
	readonly moveIssueToState: (
		params: {
			readonly issue: Issue;
			readonly toState: string;
			readonly by: string;
		},
	) => Effect.Effect<void, TrackerError>;
}

export class Tracker extends Context.Service<Tracker, TrackerImpl>()(
	"orchestrator/Tracker",
) {}
