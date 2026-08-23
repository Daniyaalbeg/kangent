import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { LoadedWorkflow } from "../domain/Workflow.js";
import type { Issue } from "../domain/Issue.js";
import { AgentRunner, type DispatchOutcome } from "../services/AgentRunner.js";
import { CodexProcess } from "../services/CodexProcess.js";
import { Dispatcher, DispatcherLayer } from "../services/Dispatcher.js";
import type { DispatchPlan } from "../services/Orchestrator.js";
import { Tracker } from "../services/Tracker.js";
import { WorkflowConfigOf } from "../services/WorkflowLoader.js";
import { WorkspaceManager } from "../services/WorkspaceManager.js";

// --- Fixtures -----------------------------------------------------------

function makeIssue(id: string, identifier = `b1-${id}`): Issue {
	return {
		id,
		identifier,
		title: `card ${id}`,
		description: null,
		priority: 2,
		state: "Todo",
		branch_name: `kangent/${identifier}`,
		url: null,
		labels: [],
		blocked_by: [],
		created_at: "2026-05-01T00:00:00.000Z",
		updated_at: "2026-05-01T00:00:00.000Z",
	};
}

function plan(issues: readonly Issue[]): DispatchPlan {
	return { ready: issues, blocked: [], totalCandidates: issues.length };
}

function makeWorkflow(): LoadedWorkflow {
	return {
		path: "/tmp/W.md",
		promptTemplate: "",
		raw: {} as LoadedWorkflow["raw"],
		config: {
			tracker: {
				kind: "kangent",
				active_states: ["Todo", "In Progress"],
				terminal_states: ["Done"],
				kangent: {
					endpoint: "https://k",
					board_id: "b1",
					board_url: undefined,
					label_filter: [],
					label_exclude: [],
					agent_id: undefined,
				},
			},
			polling: { interval_ms: 30_000 },
			workspace: { root: "/tmp/ws" },
			hooks: {
				after_create: undefined,
				before_run: undefined,
				after_run: undefined,
				before_remove: undefined,
				timeout_ms: 60_000,
			},
			agent: {
				max_concurrent_agents: 10,
				max_turns: 20,
				max_retry_backoff_ms: 300_000,
				max_concurrent_agents_by_state: {},
			},
			codex: {
				command: "codex app-server",
				approval_policy: undefined,
				thread_sandbox: undefined,
				turn_sandbox_policy: undefined,
				turn_timeout_ms: 3_600_000,
				read_timeout_ms: 5_000,
				stall_timeout_ms: 300_000,
			},
			server: { port: undefined },
		},
	};
}

// --- Test doubles -------------------------------------------------------

// A fake AgentRunner that records which issues ran and lets the test
// install a latch (Effect.never) on specific ids so we can drive timing.
function makeRunnerRecorder(opts: {
	readonly latchIds?: ReadonlySet<string>;
	readonly failIds?: ReadonlySet<string>;
} = {}): {
	readonly layer: Layer.Layer<AgentRunner>;
	readonly runs: string[];
} {
	const runs: string[] = [];
	const layer = Layer.succeed(AgentRunner, {
		run: (issue: Issue) =>
			Effect.gen(function* () {
				runs.push(issue.id);
				if (opts.failIds?.has(issue.id)) {
					return yield* Effect.fail(
						// OrchestratorError shape — only `.message` matters here.
						new (class extends Error {
							readonly _tag = "OrchestratorError" as const;
						})(`synthetic failure for ${issue.id}`) as never,
					);
				}
				if (opts.latchIds?.has(issue.id)) {
					yield* Effect.never;
				}
				return {
					issue,
					outcome: "completed" as const,
				} satisfies DispatchOutcome;
			}),
	});
	return { layer, runs };
}

const NoopTrackerLayer = Layer.succeed(Tracker, {
	fetchCandidateIssues: () => Effect.succeed([]),
	fetchIssuesByStates: () => Effect.succeed([]),
	fetchIssueStatesByIds: () => Effect.succeed([]),
	moveIssueToState: () => Effect.succeed(undefined),
});

const NoopCodexLayer = Layer.succeed(CodexProcess, {
	start: () => Effect.void,
});

const NoopWorkspaceLayer = Layer.succeed(WorkspaceManager, {
	acquire: () => Effect.succeed("/fake/workspace"),
	release: () => Effect.void,
});

const TestEnv = (runner: Layer.Layer<AgentRunner>) =>
	Layer.mergeAll(
		DispatcherLayer,
		runner,
		NoopTrackerLayer,
		NoopCodexLayer,
		NoopWorkspaceLayer,
		WorkflowConfigOf(makeWorkflow()),
	);

// --- Tests --------------------------------------------------------------

describe("Dispatcher", () => {
	it("dispatches every ready issue once, returns one outcome per issue", async () => {
		const recorder = makeRunnerRecorder();
		const issues = [makeIssue("a"), makeIssue("b"), makeIssue("c")];

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const dispatcher = yield* Dispatcher;
				return yield* dispatcher.dispatchPlan(plan(issues), { concurrency: 4 });
			}).pipe(Effect.provide(TestEnv(recorder.layer))),
		);

		expect(result.outcomes).toHaveLength(3);
		expect(result.skipped).toHaveLength(0);
		expect(recorder.runs.sort()).toEqual(["a", "b", "c"]);
		expect(result.outcomes.map((o) => o.outcome)).toEqual([
			"completed",
			"completed",
			"completed",
		]);
	});

	it("active-set filter: skips issues currently in flight on the second call", async () => {
		// First call: latch issue 'a' so it never completes. The dispatch
		// kicks 'a' off (active set now has 'a'). Concurrently, fire a
		// second dispatch with 'a' + 'b' — 'a' should be skipped, 'b'
		// should run normally.
		const recorder = makeRunnerRecorder({ latchIds: new Set(["a"]) });
		const issueA = makeIssue("a");
		const issueB = makeIssue("b");

		// We run both dispatches inside a single Effect program (and thus a
		// single Dispatcher instance, which is the whole point — the active
		// Ref is per-Layer, and DispatcherLayer is constructed once per Env
		// per `runPromise` call).
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const dispatcher = yield* Dispatcher;
				// Fire the latched dispatch in a background fiber — we don't
				// await it because 'a' will never complete.
				yield* Effect.forkChild(
					dispatcher.dispatchPlan(plan([issueA]), { concurrency: 4 }),
				);
				// Give the forked fiber a moment to enter the active set.
				yield* Effect.sleep("1 millis");
				// Second dispatch — 'a' should hit the skip branch.
				return yield* dispatcher.dispatchPlan(plan([issueA, issueB]), {
					concurrency: 4,
				});
			}).pipe(Effect.provide(TestEnv(recorder.layer))),
		);

		expect(result.skipped.map((i) => i.id)).toEqual(["a"]);
		expect(result.outcomes.map((o) => o.issue.id)).toEqual(["b"]);
		// 'a' was started exactly once (the first call); 'b' once (the second).
		expect(recorder.runs.sort()).toEqual(["a", "b"]);
	});

	it("releases the active slot after a successful completion (so a later tick can re-dispatch the same id)", async () => {
		// Same issue id dispatched twice, sequentially. First completes →
		// slot released → second runs.
		const recorder = makeRunnerRecorder();
		const issue = makeIssue("a");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const dispatcher = yield* Dispatcher;
				const r1 = yield* dispatcher.dispatchPlan(plan([issue]), {
					concurrency: 4,
				});
				const r2 = yield* dispatcher.dispatchPlan(plan([issue]), {
					concurrency: 4,
				});
				return { r1, r2 };
			}).pipe(Effect.provide(TestEnv(recorder.layer))),
		);

		// Each call saw exactly one outcome — the second wasn't skipped.
		expect(result.r1.outcomes).toHaveLength(1);
		expect(result.r1.skipped).toHaveLength(0);
		expect(result.r2.outcomes).toHaveLength(1);
		expect(result.r2.skipped).toHaveLength(0);
		// AgentRunner.run fired twice on the same id.
		expect(recorder.runs).toEqual(["a", "a"]);
	});

	it("releases the active slot after a failure (per-issue OrchestratorError → failed outcome, slot freed)", async () => {
		const recorder = makeRunnerRecorder({ failIds: new Set(["a"]) });
		const issue = makeIssue("a");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const dispatcher = yield* Dispatcher;
				const r1 = yield* dispatcher.dispatchPlan(plan([issue]), {
					concurrency: 4,
				});
				// After r1 fails, the active set should be empty again.
				const stillActive = yield* dispatcher.activeIssueIds();
				return { r1, stillActive };
			}).pipe(Effect.provide(TestEnv(recorder.layer))),
		);

		expect(result.r1.outcomes).toHaveLength(1);
		expect(result.r1.outcomes[0]?.outcome).toBe("failed");
		expect(result.stillActive.size).toBe(0);
	});

	it("activeIssueIds() reflects in-flight runs in real time", async () => {
		const recorder = makeRunnerRecorder({ latchIds: new Set(["a"]) });
		const issue = makeIssue("a");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const dispatcher = yield* Dispatcher;
				yield* Effect.forkChild(
					dispatcher.dispatchPlan(plan([issue]), { concurrency: 4 }),
				);
				yield* Effect.sleep("1 millis");
				return yield* dispatcher.activeIssueIds();
			}).pipe(Effect.provide(TestEnv(recorder.layer))),
		);

		expect([...result]).toEqual(["a"]);
	});

	it("respects concurrency: at most N AgentRunners in flight at once", async () => {
		// Latch all 5 issues. Concurrency 2 → only 2 should start before
		// the others queue. We assert via activeIssueIds() peek mid-flight.
		const ids = ["a", "b", "c", "d", "e"];
		const recorder = makeRunnerRecorder({ latchIds: new Set(ids) });
		const issues = ids.map((id) => makeIssue(id));

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const dispatcher = yield* Dispatcher;
				yield* Effect.forkChild(
					dispatcher.dispatchPlan(plan(issues), { concurrency: 2 }),
				);
				yield* Effect.sleep("5 millis");
				return yield* dispatcher.activeIssueIds();
			}).pipe(Effect.provide(TestEnv(recorder.layer))),
		);

		expect(result.size).toBe(2);
	});
});

// Suppress an unused-import warning under strict TS for `Context` —
// imported to keep the parity-with-services pattern visible to readers.
void Context;
