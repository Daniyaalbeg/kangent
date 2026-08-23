import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { Issue } from "../domain/Issue.js";
import {
	Orchestrator,
	OrchestratorLayer,
	dispatchOrder,
	isBlocked,
} from "../services/Orchestrator.js";
import { Tracker, type TrackerImpl } from "../services/Tracker.js";
import { WorkflowConfigOf } from "../services/WorkflowLoader.js";
import type { LoadedWorkflow } from "../domain/Workflow.js";

// --- Fixtures -----------------------------------------------------------

function issue(overrides: Partial<Issue> = {}): Issue {
	return {
		id: overrides.id ?? "c1",
		identifier: overrides.identifier ?? "b1-1",
		title: "card",
		description: null,
		priority: null,
		state: "Todo",
		branch_name: null,
		url: null,
		labels: [],
		blocked_by: [],
		created_at: "2026-05-01T00:00:00.000Z",
		updated_at: "2026-05-01T00:00:00.000Z",
		...overrides,
	};
}

function loadedWorkflow(): LoadedWorkflow {
	return {
		path: "/tmp/WORKFLOW.md",
		promptTemplate: "do stuff",
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

const TrackerStubLayer = (candidates: readonly Issue[]) =>
	Layer.succeed(Tracker, {
		fetchCandidateIssues: () => Effect.succeed(candidates),
		fetchIssuesByStates: () => Effect.succeed([]),
		fetchIssueStatesByIds: () => Effect.succeed([]),
		moveIssueToState: () => Effect.succeed(undefined),
	} satisfies TrackerImpl);

// --- Pure helpers -------------------------------------------------------

describe("dispatchOrder", () => {
	it("sorts lower numeric priority first", () => {
		const a = issue({ identifier: "a", priority: 1 });
		const b = issue({ identifier: "b", priority: 3 });
		expect(dispatchOrder(a, b)).toBe(-1);
		expect(dispatchOrder(b, a)).toBe(1);
	});

	it("treats null/undefined priority as last", () => {
		const lowest = issue({ identifier: "z", priority: 4 });
		const none = issue({ identifier: "a", priority: null });
		expect(dispatchOrder(lowest, none)).toBe(-1);
	});

	it("breaks priority ties on createdAt oldest-first", () => {
		const older = issue({
			identifier: "z",
			priority: 2,
			created_at: "2026-04-01T00:00:00.000Z",
		});
		const newer = issue({
			identifier: "a",
			priority: 2,
			created_at: "2026-05-01T00:00:00.000Z",
		});
		// older sorts first even though identifier would sort it second.
		expect(dispatchOrder(older, newer)).toBe(-1);
	});

	it("breaks createdAt ties on identifier lexicographic", () => {
		const a = issue({ identifier: "b1-1", priority: 2 });
		const b = issue({ identifier: "b1-2", priority: 2 });
		expect(dispatchOrder(a, b)).toBe(-1);
	});
});

describe("isBlocked (Symphony §8.2)", () => {
	const entry = "Todo";
	const terminal = ["Done"];

	it("entry state + non-terminal blocker → blocked", () => {
		const blocked = issue({
			state: "Todo",
			blocked_by: [{ id: "x", identifier: "b1-9", state: "In Progress" }],
		});
		expect(isBlocked(blocked, entry, terminal)).toBe(true);
	});

	it("entry state + terminal blocker → not blocked", () => {
		const ready = issue({
			state: "Todo",
			blocked_by: [{ id: "x", identifier: "b1-9", state: "Done" }],
		});
		expect(isBlocked(ready, entry, terminal)).toBe(false);
	});

	it("entry state + unresolved blocker (state=null) → blocked", () => {
		const ambiguous = issue({
			state: "Todo",
			blocked_by: [{ id: null, identifier: "b1-9", state: null }],
		});
		expect(isBlocked(ambiguous, entry, terminal)).toBe(true);
	});

	it("non-entry state + non-terminal blocker → not blocked (agent already working)", () => {
		const inFlight = issue({
			state: "In Progress",
			blocked_by: [{ id: "x", identifier: "b1-9", state: "In Progress" }],
		});
		expect(isBlocked(inFlight, entry, terminal)).toBe(false);
	});

	it("case-insensitive on state, entry, and terminal_states", () => {
		const card = issue({
			state: "TODO",
			blocked_by: [{ id: "x", identifier: "b1-9", state: "done" }],
		});
		expect(isBlocked(card, "todo", ["DONE"])).toBe(false);
	});

	it("respects a non-'Todo' entry state — `Backlog` board (regression for hardcoded 'todo' bug)", () => {
		// active_states: ["Backlog", "Doing"], terminal: ["Done"].
		// A card in "Backlog" with a non-terminal blocker MUST be blocked.
		// Before the fix this returned false because `state !== "todo"`.
		const blocked = issue({
			state: "Backlog",
			blocked_by: [{ id: "x", identifier: "b1-9", state: "Doing" }],
		});
		expect(isBlocked(blocked, "Backlog", ["Done"])).toBe(true);

		// And a card NOT in the entry state shouldn't be blocked even
		// with a non-terminal blocker.
		const working = issue({
			state: "Doing",
			blocked_by: [{ id: "x", identifier: "b1-9", state: "Doing" }],
		});
		expect(isBlocked(working, "Backlog", ["Done"])).toBe(false);
	});
});

// --- pollOnce integration -----------------------------------------------

describe("Orchestrator.pollOnce", () => {
	const run = (candidates: readonly Issue[]) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const orch = yield* Orchestrator;
				return yield* orch.pollOnce();
			}).pipe(
				Effect.provide(OrchestratorLayer),
				Effect.provide(TrackerStubLayer(candidates)),
				Effect.provide(WorkflowConfigOf(loadedWorkflow())),
			),
		);

	it("returns ready cards sorted, blocked cards separated", async () => {
		const blocker = issue({
			id: "b",
			identifier: "b1-blocker",
			state: "Todo",
		});
		const blocked = issue({
			id: "bd",
			identifier: "b1-blocked",
			state: "Todo",
			blocked_by: [
				{ id: "b", identifier: "b1-blocker", state: "Todo" },
			],
		});
		const urgent = issue({
			id: "u",
			identifier: "b1-urgent",
			state: "Todo",
			priority: 1,
		});
		const plan = await run([blocker, blocked, urgent]);
		expect(plan.totalCandidates).toBe(3);
		expect(plan.ready.map((i) => i.identifier)).toEqual([
			"b1-urgent", // priority 1 first
			"b1-blocker", // no priority, but no blockers
		]);
		expect(plan.blocked.map((i) => i.identifier)).toEqual(["b1-blocked"]);
	});

	it("returns empty plan when tracker yields nothing", async () => {
		const plan = await run([]);
		expect(plan).toEqual({ ready: [], blocked: [], totalCandidates: 0 });
	});
});
