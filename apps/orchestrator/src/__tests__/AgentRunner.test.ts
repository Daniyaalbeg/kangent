import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { Issue } from "../domain/Issue.js";
import { AgentRunner, AgentRunnerLayer } from "../services/AgentRunner.js";
import {
	CodexProcessFailingLayer,
	CodexProcessFakeLayer,
} from "../services/CodexProcess.js";
import { Tracker, type TrackerImpl } from "../services/Tracker.js";
import { WorkflowConfigOf } from "../services/WorkflowLoader.js";
import { WorkspaceManager } from "../services/WorkspaceManager.js";
import type { LoadedWorkflow } from "../domain/Workflow.js";

// Tests don't exercise workspace lifecycle directly — they care about
// AgentRunner's tracker + codex orchestration. A no-op WorkspaceManager
// keeps the AgentRunner type signature happy without touching disk.
const NoopWorkspaceLayer = Layer.succeed(WorkspaceManager, {
	acquire: (_issue) => Effect.succeed("/fake/workspace"),
	release: () => Effect.void,
});

/** A WorkspaceManager whose `acquire` always fails. Lets us verify that
 * AgentRunner rolls the card back to the entry state when workspace prep
 * blows up — exercising the "after_create flake → retry next tick" flow. */
const FailingWorkspaceLayer = Layer.succeed(WorkspaceManager, {
	acquire: () =>
		Effect.fail({
			_tag: "WorkspaceError" as const,
			kind: "hook_failed" as const,
			hook: "after_create" as const,
			message: "git clone failed",
		} as never),
	release: () => Effect.void,
});

// --- Fixtures -----------------------------------------------------------

function makeIssue(): Issue {
	return {
		id: "c1",
		identifier: "b1-1",
		title: "do thing",
		description: null,
		priority: 2,
		state: "Todo",
		branch_name: "kangent/b1-1",
		url: null,
		labels: [],
		blocked_by: [],
		created_at: "2026-05-01T00:00:00.000Z",
		updated_at: "2026-05-01T00:00:00.000Z",
	};
}

function makeWorkflow(
	overrides: Partial<LoadedWorkflow["config"]["tracker"]> = {},
): LoadedWorkflow {
	const baseTracker = {
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
	} as LoadedWorkflow["config"]["tracker"];
	return {
		path: "/tmp/WORKFLOW.md",
		promptTemplate: "do stuff",
		raw: {} as LoadedWorkflow["raw"],
		config: {
			tracker: { ...baseTracker, ...overrides },
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

interface TrackerCall {
	readonly issueId: string;
	readonly toState: string;
	readonly by: string;
}

function makeTrackerRecorder(opts: { failOn?: string } = {}): {
	readonly layer: Layer.Layer<Tracker>;
	readonly calls: TrackerCall[];
} {
	const calls: TrackerCall[] = [];
	const layer = Layer.succeed(Tracker, {
		fetchCandidateIssues: () => Effect.succeed([]),
		fetchIssuesByStates: () => Effect.succeed([]),
		fetchIssueStatesByIds: () => Effect.succeed([]),
		moveIssueToState: ({ issue, toState, by }) => {
			calls.push({ issueId: issue.id, toState, by });
			if (opts.failOn && opts.failOn.toLowerCase() === toState.toLowerCase()) {
				return Effect.fail(
					// Untyped TrackerError to keep test deps minimal — only the
					// shape matters here.
					{ _tag: "TrackerError", code: "transport", message: "boom" } as never,
				);
			}
			return Effect.succeed(undefined);
		},
	} satisfies TrackerImpl);
	return { layer, calls };
}

// --- Tests --------------------------------------------------------------

describe("AgentRunner.run", () => {
	it("happy path: claims card → succeeds → does NOT move card to a terminal state", async () => {
		const tracker = makeTrackerRecorder();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const runner = yield* AgentRunner;
				return yield* runner.run(makeIssue());
			}).pipe(
				Effect.provide(AgentRunnerLayer),
				Effect.provide(tracker.layer),
				Effect.provide(CodexProcessFakeLayer()),
				Effect.provide(WorkflowConfigOf(makeWorkflow())),
				Effect.provide(NoopWorkspaceLayer),
			),
		);

		expect(result.outcome).toBe("completed");
		expect(tracker.calls).toEqual([
			// One single move: Todo → In Progress. Terminal-state move is
			// agent's responsibility via codex tool call.
			{ issueId: "c1", toState: "In Progress", by: "ai:kangent-orchestrator" },
		]);
	});

	it("failure path: codex fails → card moved back to Todo, outcome=failed", async () => {
		const tracker = makeTrackerRecorder();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const runner = yield* AgentRunner;
				return yield* runner.run(makeIssue());
			}).pipe(
				Effect.provide(AgentRunnerLayer),
				Effect.provide(tracker.layer),
				Effect.provide(CodexProcessFailingLayer("codex blew up")),
				Effect.provide(WorkflowConfigOf(makeWorkflow())),
				Effect.provide(NoopWorkspaceLayer),
			),
		);

		expect(result.outcome).toBe("failed");
		expect(result.reason).toBe("codex blew up");
		expect(tracker.calls.map((c) => c.toState)).toEqual([
			"In Progress", // claim
			"Todo", // reconcile after codex failure
		]);
	});

	it("if the initial claim move fails, dispatch errors out before invoking codex", async () => {
		const tracker = makeTrackerRecorder({ failOn: "In Progress" });
		let codexStarted = false;
		const inspectingCodex = Layer.succeed(
			(await import("../services/CodexProcess.js")).CodexProcess,
			{
				start: () =>
					Effect.sync(() => {
						codexStarted = true;
					}),
			},
		);
		const program = Effect.gen(function* () {
			const runner = yield* AgentRunner;
			return yield* runner.run(makeIssue());
		}).pipe(
			Effect.provide(AgentRunnerLayer),
			Effect.provide(tracker.layer),
			Effect.provide(inspectingCodex),
			Effect.provide(WorkflowConfigOf(makeWorkflow())),
			Effect.provide(NoopWorkspaceLayer),
		);
		await expect(Effect.runPromise(program)).rejects.toMatchObject({
			_tag: "OrchestratorError",
		});
		expect(codexStarted).toBe(false);
		// We only see the failed claim attempt — no rollback when there
		// was nothing to roll back.
		expect(tracker.calls.map((c) => c.toState)).toEqual(["In Progress"]);
	});

	it("workspace acquire fails → claim is rolled back, dispatch outcome=failed", async () => {
		const tracker = makeTrackerRecorder();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const runner = yield* AgentRunner;
				return yield* runner.run(makeIssue());
			}).pipe(
				Effect.provide(AgentRunnerLayer),
				Effect.provide(tracker.layer),
				Effect.provide(CodexProcessFakeLayer()),
				Effect.provide(WorkflowConfigOf(makeWorkflow())),
				Effect.provide(FailingWorkspaceLayer),
			),
		);

		expect(result.outcome).toBe("failed");
		expect(result.reason).toMatch(/workspace after_create: git clone failed/);
		// Both the claim and the rollback fired — confirming workspace
		// failure routes through the same rollback path as codex failure.
		expect(tracker.calls.map((c) => c.toState)).toEqual([
			"In Progress",
			"Todo",
		]);
	});

	it("non-'Todo' entry state: claim and rollback target the configured entry, not the literal 'Todo'", async () => {
		// active_states: ["Backlog", "Doing"], terminal: ["Done"].
		// Before the fix, AgentRunner hardcoded "Todo" as the entry state
		// — so rollback would move the card to a column that doesn't exist
		// on this board and the card would get stuck.
		const tracker = makeTrackerRecorder();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const runner = yield* AgentRunner;
				return yield* runner.run({
					...makeIssue(),
					state: "Backlog",
				});
			}).pipe(
				Effect.provide(AgentRunnerLayer),
				Effect.provide(tracker.layer),
				Effect.provide(CodexProcessFailingLayer("codex blew up")),
				Effect.provide(
					WorkflowConfigOf(
						makeWorkflow({
							active_states: ["Backlog", "Doing"],
							terminal_states: ["Done"],
						}),
					),
				),
				Effect.provide(NoopWorkspaceLayer),
			),
		);

		expect(result.outcome).toBe("failed");
		expect(tracker.calls.map((c) => c.toState)).toEqual([
			"Doing", // claim → working state
			"Backlog", // rollback → entry state
		]);
	});

	it("workflow with no non-terminal active state besides Todo → dispatch fails fast", async () => {
		const tracker = makeTrackerRecorder();
		const program = Effect.gen(function* () {
			const runner = yield* AgentRunner;
			return yield* runner.run(makeIssue());
		}).pipe(
			Effect.provide(AgentRunnerLayer),
			Effect.provide(tracker.layer),
			Effect.provide(CodexProcessFakeLayer()),
			Effect.provide(
				WorkflowConfigOf(
					makeWorkflow({
						// Only Todo is active. There's no working state to move to.
						active_states: ["Todo"],
						terminal_states: ["Done"],
					}),
				),
			),
			Effect.provide(NoopWorkspaceLayer),
		);
		await expect(Effect.runPromise(program)).rejects.toMatchObject({
			_tag: "OrchestratorError",
		});
		// No moves attempted: we failed before claiming.
		expect(tracker.calls).toHaveLength(0);
	});
});
