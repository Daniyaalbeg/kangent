/**
 * Orchestrates one issue end-to-end: state transition → codex session →
 * exit handling. Symphony §10.7.
 *
 * MVP scope (matches the option-1 plan in the design grilling):
 *
 *   1. Move card Todo → In Progress (or whichever active-non-terminal
 *      state the workflow names first). Symphony §10.7 step 1.
 *   2. Hand the issue to `CodexProcess.start`. In real life this attaches
 *      a JSON-RPC turn loop; in the MVP the test layer just succeeds
 *      after a short delay so we can exercise the rest of the flow.
 *   3. On codex success, leave the card where it is — the real codex is
 *      expected to move the card into a terminal state via a tool call
 *      during the turn, so the orchestrator MUST NOT also move it
 *      (would race the agent and produce dueling changelog entries).
 *   4. On codex failure, move the card back to Todo so it gets picked
 *      up on the next tick. Symphony §10.7 step 4.
 *
 * Out of scope for this MVP: retry queue, per-state concurrency caps,
 * stall detection, reconciliation. Those land alongside the daemon loop.
 */

import { Context, Effect, Layer } from "effect";
import { OrchestratorError } from "../domain/errors.js";
import type { Issue } from "../domain/Issue.js";
import { CodexProcess } from "./CodexProcess.js";
import { renderPrompt } from "./PromptRenderer.js";
import { Tracker, type TrackerImpl } from "./Tracker.js";
import { WorkflowConfig } from "./WorkflowLoader.js";
import { WorkspaceManager } from "./WorkspaceManager.js";

export interface DispatchOutcome {
	readonly issue: Issue;
	readonly outcome: "completed" | "failed";
	/** Reason text for `failed`; `undefined` for `completed`. */
	readonly reason?: string;
}

export interface AgentRunnerImpl {
	readonly run: (
		issue: Issue,
	) => Effect.Effect<
		DispatchOutcome,
		OrchestratorError,
		Tracker | CodexProcess | WorkflowConfig | WorkspaceManager
	>;
}

export class AgentRunner extends Context.Service<AgentRunner, AgentRunnerImpl>()(
	"orchestrator/AgentRunner",
) {}

/**
 * Pick the "working" state — the first active state that isn't the entry
 * state and isn't a terminal state. Symphony's mental model:
 *
 *   active_states[0]      = entry  (cards wait here for dispatch)
 *   active_states[1..]    = working (cards in flight — codex is on them)
 *   terminal_states[*]    = done   (cards exit the dispatch pool)
 *
 * For the default `["Todo", "In Progress"]` that's `"In Progress"`. For
 * `["Backlog", "Doing"]` that's `"Doing"`. If the workflow only has one
 * active state (no working column at all), we return null and dispatch
 * fails fast with a helpful message.
 */
function resolveWorkingState(
	active: readonly string[],
	terminal: readonly string[],
): string | null {
	if (active.length < 2) return null;
	const entryLc = active[0]?.toLowerCase() ?? "";
	const terminalLc = new Set(terminal.map((s) => s.toLowerCase()));
	return (
		active.slice(1).find((s) => {
			const lc = s.toLowerCase();
			return lc !== entryLc && !terminalLc.has(lc);
		}) ?? null
	);
}

/** Stable actor id used on every write the orchestrator authors. */
const ORCHESTRATOR_ACTOR = "ai:kangent-orchestrator";

/**
 * Translate the workflow's free-form `codex.approval_policy` string into
 * the constrained set codex's protocol accepts. Unknown values → undefined
 * (let codex pick its own default rather than rejecting the turn).
 */
function mapApprovalPolicy(
	raw: string | undefined,
): "untrusted" | "on-failure" | "on-request" | "never" | undefined {
	switch (raw) {
		case "untrusted":
		case "on-failure":
		case "on-request":
		case "never":
			return raw;
		default:
			return undefined;
	}
}

export const AgentRunnerLayer = Layer.succeed(AgentRunner, {
	run: (issue: Issue) =>
		Effect.gen(function* () {
			const tracker = yield* Tracker;
			const codex = yield* CodexProcess;
			const workspace = yield* WorkspaceManager;
			const cfg = yield* WorkflowConfig;
			// Entry state = active_states[0] (Symphony §8.2 mental model:
			// the queue that cards wait in). Falls back to "Todo" only if
			// the workflow has no active states configured at all, which is
			// already a misconfiguration the rollback below will surface.
			const entryState =
				cfg.config.tracker.active_states[0] ?? "Todo";
			const workingState = resolveWorkingState(
				cfg.config.tracker.active_states,
				cfg.config.tracker.terminal_states,
			);
			if (!workingState) {
				return yield* Effect.fail(
					new OrchestratorError({
						message: `Cannot dispatch ${issue.identifier}: workflow has no non-terminal active state besides "${entryState}". Add a working state (e.g. "In Progress") to tracker.active_states.`,
					}),
				);
			}

			// Step 1: claim the card into the working state. If the move
			// itself fails (e.g. card was deleted between the poll and now)
			// abort the dispatch cleanly — the next tick will surface the
			// missing card via fetchCandidateIssues returning a different
			// set.
			yield* tracker
				.moveIssueToState({
					issue,
					toState: workingState,
					by: ORCHESTRATOR_ACTOR,
				})
				.pipe(
					Effect.mapError(
						(cause) =>
							new OrchestratorError({
								message: `Failed to claim ${issue.identifier} into ${workingState}: ${cause.message}`,
								cause,
							}),
					),
				);

			// Step 2: acquire the workspace (mkdir + after_create on first
			// dispatch, before_run on every dispatch). On hook failure,
			// roll the card back to the entry state so it gets re-queued
			// — the user's `after_create` may have transient issues (network
			// flake during `git clone`) that succeed on a retry.
			const acquired = yield* workspace.acquire(issue).pipe(
				Effect.matchEffect({
					onFailure: (cause) =>
						Effect.succeed({ ok: false as const, cause }),
					onSuccess: (path) => Effect.succeed({ ok: true as const, path }),
				}),
			);
			if (!acquired.ok) {
				yield* rollbackClaim(tracker, issue, entryState);
				return {
					issue,
					outcome: "failed" as const,
					reason: `workspace ${acquired.cause.hook ?? "setup"}: ${acquired.cause.message}`,
				};
			}

			// Step 3: hand off to codex with the workspace as cwd. On
			// success, we leave the card where it is — codex's tool call
			// is the source of truth for post-completion state. On failure,
			// step 4 puts the card back.
			const prompt = renderPrompt(cfg.promptTemplate, { issue });
			const approvalPolicy = mapApprovalPolicy(
				cfg.config.codex.approval_policy,
			);
			const codexResult = yield* codex
				.start({
					workspacePath: acquired.path,
					command: cfg.config.codex.command,
					prompt,
					timeoutMs: cfg.config.codex.turn_timeout_ms,
					...(approvalPolicy ? { approvalPolicy } : {}),
				})
				.pipe(
					Effect.matchEffect({
						onFailure: (cause) =>
							Effect.succeed({
								ok: false as const,
								reason: cause.message,
							}),
						onSuccess: () => Effect.succeed({ ok: true as const }),
					}),
				);

			// Step 4: after_run hook runs regardless of codex outcome — it
			// might want to capture logs or report telemetry whether or not
			// the turn succeeded. Failures here are logged but don't change
			// the dispatch outcome; the card has already either succeeded
			// or failed via codex.
			yield* workspace.release(issue, acquired.path).pipe(
				Effect.matchEffect({
					onFailure: () => Effect.void,
					onSuccess: () => Effect.void,
				}),
			);

			if (codexResult.ok) {
				return { issue, outcome: "completed" as const };
			}

			// Step 5: codex failed — undo the claim. Best-effort; logs
			// inside `rollbackClaim` if the rollback itself fails.
			yield* rollbackClaim(tracker, issue, entryState);

			return {
				issue,
				outcome: "failed" as const,
				reason: codexResult.reason,
			};
		}),
});

/**
 * Best-effort: move the card back to the entry state when something
 * downstream of the initial claim failed. The real failure has already
 * been reported to the caller; we don't surface a second error here.
 *
 * BUT — we DO log to stderr when rollback fails, because that's a stuck-
 * card scenario (claimed into the working state, can't return to entry,
 * will sit forever waiting for a human). Silently swallowing it would
 * mean operators have no signal that their board is degraded.
 */
function rollbackClaim(
	tracker: TrackerImpl,
	issue: Issue,
	entryState: string,
): Effect.Effect<void> {
	return tracker
		.moveIssueToState({
			issue,
			toState: entryState,
			by: ORCHESTRATOR_ACTOR,
		})
		.pipe(
			Effect.matchEffect({
				onFailure: (cause) =>
					Effect.sync(() => {
						console.error(
							`[orchestrator] rollback failed for ${issue.identifier} -> ${entryState}: ${cause.message}. Card may be stuck in working state and will need manual fixup.`,
						);
					}),
				onSuccess: () => Effect.void,
			}),
		);
}
