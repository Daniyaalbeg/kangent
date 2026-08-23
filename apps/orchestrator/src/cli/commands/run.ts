/**
 * `kangent run [path]` — load WORKFLOW.md and either:
 *   - poll once and exit (`--once`, the old behaviour), or
 *   - poll forever every `polling.interval_ms` until SIGINT/SIGTERM
 *     (the default — the daemon mode).
 *
 * Flags:
 *   --once        Single poll + dispatch, then exit. The cron-friendly mode.
 *   --dry-run     Print the dispatch plan; never touch the tracker. Implies
 *                 nothing about --once vs. daemon; daemon-with-dry-run is
 *                 useful for watching what would be dispatched.
 *   --fake-codex  Swap CodexProcessLayer for the fake (synthetic 200ms
 *                 turn) so cards visibly move Todo → In Progress without
 *                 a real codex install.
 *
 * The dispatcher (`services/Dispatcher.ts`) filters out issues already
 * in-flight in this process, so the daemon loop never re-claims a card
 * it already started — even if the prior tick's codex is still running
 * when the next tick fires.
 */

import { Console, Effect, Layer, Schedule } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { WorkflowDependentLayer } from "../../layers/AppLayer.js";
import type { DispatchOutcome } from "../../services/AgentRunner.js";
import {
	CodexProcess,
	CodexProcessFakeLayer,
	CodexProcessLayer,
} from "../../services/CodexProcess.js";
import { Dispatcher } from "../../services/Dispatcher.js";
import { Orchestrator } from "../../services/Orchestrator.js";
import {
	WorkflowConfigOf,
	WorkflowLoader,
} from "../../services/WorkflowLoader.js";
import type { LoadedWorkflow } from "../../domain/Workflow.js";

const workflowPath = Argument.path("workflow", {
	pathType: "file",
	mustExist: true,
}).pipe(
	Argument.withDefault("./WORKFLOW.md"),
	Argument.withDescription("Path to the WORKFLOW.md to run"),
);

const once = Flag.boolean("once").pipe(
	Flag.withDescription(
		"Drain one poll cycle and exit. Without this flag, run as a daemon polling on polling.interval_ms.",
	),
);

const dryRun = Flag.boolean("dry-run").pipe(
	Flag.withDescription(
		"Print the dispatch plan and skip tracker writes.",
	),
);

const fakeCodex = Flag.boolean("fake-codex").pipe(
	Flag.withDescription(
		"Use the fake CodexProcess that simulates a successful turn (~200ms).",
	),
);

export const run = Command.make(
	"run",
	{ workflowPath, once, dryRun, fakeCodex },
	({ workflowPath, once, dryRun, fakeCodex }) =>
		Effect.gen(function* () {
			const loader = yield* WorkflowLoader;
			const loaded = yield* loader.load(workflowPath);

			yield* Console.log(`▶ loaded ${loaded.path}`);
			yield* Console.log(
				`▶ tracker.kangent.board_id = ${loaded.config.tracker.kangent.board_id ?? "(unset)"}`,
			);
			const modeLabel = dryRun ? "dry-run" : "dispatch";
			const loopLabel = once ? "once" : `daemon (every ${loaded.config.polling.interval_ms}ms)`;
			yield* Console.log(`▶ mode: ${modeLabel} · ${loopLabel}`);
			yield* Console.log(
				`▶ codex: ${fakeCodex ? "fake (synthetic turn)" : "real (stubbed in this build)"}`,
			);

			const codexLayer: Layer.Layer<CodexProcess> = fakeCodex
				? CodexProcessFakeLayer(200)
				: CodexProcessLayer;

			// One iteration: poll, print plan, dispatch (unless dry-run),
			// print outcomes. The same function runs once for `--once` and
			// on every interval for the daemon mode.
			const tick = (tickNumber: number) =>
				Effect.gen(function* () {
					if (!once) {
						yield* Console.log("");
						yield* Console.log(
							`──── tick #${tickNumber} @ ${new Date().toISOString()} ────`,
						);
					}

					const orch = yield* Orchestrator;
					const plan = yield* orch.pollOnce();

					yield* Console.log(
						`Poll: ${plan.totalCandidates} candidates, ${plan.ready.length} ready, ${plan.blocked.length} blocked`,
					);

					if (plan.ready.length > 0) {
						yield* Console.log(
							dryRun ? "Would dispatch (sorted):" : "Dispatching (sorted):",
						);
						for (const issue of plan.ready) {
							const labelTag =
								issue.labels.length > 0
									? ` [${issue.labels.join(", ")}]`
									: "";
							yield* Console.log(
								`  · ${issue.identifier} — ${issue.title} (${issue.state})${labelTag}`,
							);
						}
					}

					if (plan.blocked.length > 0) {
						yield* Console.log("Blocked by non-terminal blockers:");
						for (const issue of plan.blocked) {
							const blockers = issue.blocked_by
								.map((b) => `${b.identifier ?? "?"}@${b.state ?? "?"}`)
								.join(", ");
							yield* Console.log(
								`  · ${issue.identifier} — ${issue.title} ← ${blockers}`,
							);
						}
					}

					if (dryRun || plan.ready.length === 0) {
						return;
					}

					const dispatcher = yield* Dispatcher;
					const { outcomes, skipped } = yield* dispatcher.dispatchPlan(plan, {
						concurrency: loaded.config.agent.max_concurrent_agents,
					});

					if (skipped.length > 0) {
						yield* Console.log(
							`Skipped ${skipped.length} (already in flight this process): ${skipped.map((i) => i.identifier).join(", ")}`,
						);
					}

					yield* logOutcomes(outcomes);
				});

			// Provide everything once at the outer scope so each tick reuses
			// the same Dispatcher (and therefore the same active set). If we
			// provided per-tick, the active-set Ref would reset every interval
			// and the in-flight filter would break.
			const provided = (tickNumber: number) =>
				tick(tickNumber).pipe(
					Effect.provide(WorkflowDependentLayer),
					Effect.provide(WorkflowConfigOf(loaded)),
					Effect.provide(codexLayer),
				);

			if (once) {
				yield* provided(1);
				return;
			}

			// Daemon loop. `Schedule.spaced(interval)` re-runs after a delay
			// of `interval` ms following the previous run's completion. Per-
			// tick errors are caught inside `tick` (failed dispatches become
			// "failed" outcomes), so the only thing that can interrupt the
			// loop is SIGINT/SIGTERM via NodeRuntime.runMain.
			yield* daemonLoop(provided, loaded);
		}),
);

function daemonLoop<E, R>(
	provided: (tickNumber: number) => Effect.Effect<void, E, R>,
	loaded: LoadedWorkflow,
): Effect.Effect<void, E, R> {
	const interval = loaded.config.polling.interval_ms;
	// Counter ref. Live outside the Effect so it survives across each
	// schedule firing without a Ref + state.
	let tickNumber = 0;
	const fire = Effect.suspend(() => {
		tickNumber += 1;
		return provided(tickNumber);
	});
	return fire.pipe(
		// Run `fire` once now, then wait `interval`, then fire again, ad infinitum.
		Effect.repeat(Schedule.spaced(`${interval} millis`)),
		// `repeat` returns `Effect<never, ...>` (it never completes normally) —
		// `asVoid` smooths the type to `void` for return.
		Effect.asVoid,
	);
}

function logOutcomes(outcomes: readonly DispatchOutcome[]) {
	return Effect.gen(function* () {
		const completed = outcomes.filter((o) => o.outcome === "completed");
		const failed = outcomes.filter((o) => o.outcome === "failed");
		if (outcomes.length === 0) return;
		yield* Console.log("Outcomes:");
		for (const o of completed) {
			yield* Console.log(`  ✓ ${o.issue.identifier} — ${o.issue.title}`);
		}
		for (const o of failed) {
			yield* Console.log(
				`  ✗ ${o.issue.identifier} — ${o.issue.title}${o.reason ? ` (${o.reason})` : ""}`,
			);
		}
		yield* Console.log(
			`Summary: ${completed.length} completed, ${failed.length} failed.`,
		);
	});
}
