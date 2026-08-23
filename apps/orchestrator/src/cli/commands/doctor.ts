/**
 * `kangent doctor` — preflight checks. Loads the workflow, validates it,
 * and pings the configured tracker. Prints a green/red checklist so the
 * user can see what would fail before `kangent run` is invoked.
 */

import { Console, Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { WorkflowDependentLayer } from "../../layers/AppLayer.js";
import { WorkflowError } from "../../domain/errors.js";
import { Tracker } from "../../services/Tracker.js";
import { WorkflowConfigOf, WorkflowLoader } from "../../services/WorkflowLoader.js";

const workflowPath = Argument.path("workflow", {
	pathType: "file",
	mustExist: true,
}).pipe(
	Argument.withDefault("./WORKFLOW.md"),
	Argument.withDescription("Path to the WORKFLOW.md to check"),
);

export const doctor = Command.make(
	"doctor",
	{ workflowPath },
	({ workflowPath }) =>
		Effect.gen(function* () {
			let allGreen = true;

			// 1. Workflow loads. We pivot the error/success branches into a
			// plain discriminated union so the rest of the function can
			// continue to log/mutate `allGreen` regardless of outcome.
			const loader = yield* WorkflowLoader;
			const loadOutcome = yield* loader.load(workflowPath).pipe(
				Effect.matchEffect({
					onFailure: (err) =>
						Effect.succeed({ ok: false as const, err }),
					onSuccess: (loaded) =>
						Effect.succeed({ ok: true as const, loaded }),
				}),
			);
			if (!loadOutcome.ok) {
				yield* Console.log(
					`✗ workflow load — ${loadOutcome.err.kind}: ${loadOutcome.err.message}`,
				);
				return yield* Effect.fail(loadOutcome.err);
			}
			const loaded = loadOutcome.loaded;
			yield* Console.log(`✓ workflow load — ${loaded.path}`);

			// 2. Tracker config sanity
			const tcfg = loaded.config.tracker;
			yield* Console.log(`  tracker.kind = ${tcfg.kind}`);
			yield* Console.log(
				`  tracker.active_states = [${tcfg.active_states.join(", ")}]`,
			);
			yield* Console.log(
				`  tracker.terminal_states = [${tcfg.terminal_states.join(", ")}]`,
			);

			if (tcfg.kind !== "kangent") {
				yield* Console.log(
					`✗ tracker.kind '${tcfg.kind}' — only 'kangent' is supported in this CLI today`,
				);
				allGreen = false;
			} else {
				const k = tcfg.kangent;
				if (!k.endpoint) {
					yield* Console.log(
						"✗ tracker.kangent.endpoint missing (set in WORKFLOW.md or via $KANGENT_ENDPOINT)",
					);
					allGreen = false;
				} else {
					yield* Console.log(`✓ tracker.kangent.endpoint = ${k.endpoint}`);
				}
				if (!k.board_id && !k.board_url) {
					yield* Console.log(
						"✗ tracker.kangent.board_id or board_url required",
					);
					allGreen = false;
				} else {
					yield* Console.log(
						`✓ tracker.kangent.board_id = ${k.board_id ?? "(from board_url)"}`,
					);
				}
			}

			// 3. Live tracker ping (only if config looks plausible)
			if (allGreen) {
				const probe = yield* Effect.gen(function* () {
					const tracker = yield* Tracker;
					return yield* tracker.fetchCandidateIssues();
				}).pipe(
					Effect.provide(WorkflowDependentLayer),
					Effect.provide(WorkflowConfigOf(loaded)),
					Effect.matchEffect({
						onFailure: (err) =>
							Effect.succeed({ ok: false as const, err }),
						onSuccess: (issues) =>
							Effect.succeed({ ok: true as const, issues }),
					}),
				);
				if (!probe.ok) {
					yield* Console.log(`✗ tracker probe — ${probe.err.message}`);
					allGreen = false;
				} else {
					yield* Console.log(
						`✓ tracker probe — ${probe.issues.length} candidate issue(s)`,
					);
				}
			}

			// 4. Codex availability — TODO once CodexProcess is real.
			yield* Console.log(
				"· codex availability — skipped (CodexProcess stubbed in MVP)",
			);

			yield* Console.log("");
			yield* Console.log(
				allGreen
					? "All checks passed."
					: "One or more checks failed; see above.",
			);
			if (!allGreen) {
				return yield* Effect.fail(
					new WorkflowError({
						kind: "validation_error",
						path: loaded.path,
						message: "doctor: one or more checks failed",
					}),
				);
			}
		}),
);
