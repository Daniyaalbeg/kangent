import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LoadedWorkflow } from "../domain/Workflow.js";
import type { Issue } from "../domain/Issue.js";
import {
	WorkspaceManager,
	WorkspaceManagerLayer,
} from "../services/WorkspaceManager.js";
import { WorkflowConfigOf } from "../services/WorkflowLoader.js";

// --- Fixtures -----------------------------------------------------------

let wsRoot: string;

beforeEach(async () => {
	wsRoot = await fs.mkdtemp(path.join(tmpdir(), "kangent-ws-test-"));
});

afterEach(async () => {
	await fs.rm(wsRoot, { recursive: true, force: true });
});

function makeIssue(overrides: Partial<Issue> = {}): Issue {
	return {
		id: "card-id-1",
		identifier: "b1-1",
		title: "test card",
		description: null,
		priority: null,
		state: "Todo",
		branch_name: "kangent/b1-1",
		url: "https://k/b/b1?card=card-id-1",
		labels: [],
		blocked_by: [],
		created_at: "2026-05-01T00:00:00.000Z",
		updated_at: "2026-05-01T00:00:00.000Z",
		...overrides,
	};
}

function makeWorkflow(
	hooks: Partial<LoadedWorkflow["config"]["hooks"]> = {},
): LoadedWorkflow {
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
			workspace: { root: wsRoot },
			hooks: {
				after_create: undefined,
				before_run: undefined,
				after_run: undefined,
				before_remove: undefined,
				timeout_ms: 5_000,
				...hooks,
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

const acquire = (issue: Issue, workflow: LoadedWorkflow) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const ws = yield* WorkspaceManager;
			return yield* ws.acquire(issue);
		}).pipe(
			Effect.provide(WorkspaceManagerLayer),
			Effect.provide(WorkflowConfigOf(workflow)),
		),
	);

const release = (issue: Issue, p: string, workflow: LoadedWorkflow) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const ws = yield* WorkspaceManager;
			yield* ws.release(issue, p);
		}).pipe(
			Effect.provide(WorkspaceManagerLayer),
			Effect.provide(WorkflowConfigOf(workflow)),
		),
	);

async function dirExists(p: string): Promise<boolean> {
	try {
		const s = await fs.stat(p);
		return s.isDirectory();
	} catch {
		return false;
	}
}

async function fileContents(p: string): Promise<string | null> {
	try {
		return await fs.readFile(p, "utf8");
	} catch {
		return null;
	}
}

// --- Tests --------------------------------------------------------------

describe("WorkspaceManager.acquire", () => {
	it("creates the workspace directory and writes the sentinel when no hooks are configured", async () => {
		const issue = makeIssue();
		const result = await acquire(issue, makeWorkflow());
		expect(result).toBe(path.resolve(wsRoot, "b1-1"));
		expect(await dirExists(result)).toBe(true);
		expect(await fileContents(path.join(result, ".kangent-ready"))).toBe("");
	});

	it("runs after_create exactly once across two acquires (idempotent via sentinel)", async () => {
		const marker = path.join(wsRoot, "after_create_log");
		// Hook appends the issue identifier to a marker file. Two acquires
		// should leave the marker with exactly one line.
		const workflow = makeWorkflow({
			after_create: `echo "$KANGENT_ISSUE_IDENTIFIER" >> "${marker}"`,
		});
		const issue = makeIssue();
		await acquire(issue, workflow);
		await acquire(issue, workflow);
		const log = await fs.readFile(marker, "utf8");
		expect(log.trim().split("\n")).toEqual(["b1-1"]);
	});

	it("exposes KANGENT_* env vars to hook scripts", async () => {
		const dump = path.join(wsRoot, "env-dump");
		const workflow = makeWorkflow({
			after_create: `printenv | grep '^KANGENT_' | sort > "${dump}"`,
		});
		const issue = makeIssue();
		await acquire(issue, workflow);
		const text = await fs.readFile(dump, "utf8");
		const lines = text.trim().split("\n");
		// Check the load-bearing ones — id, identifier, title, workspace.
		// Order is `sort`-stable.
		expect(lines).toContain("KANGENT_ISSUE_ID=card-id-1");
		expect(lines).toContain("KANGENT_ISSUE_IDENTIFIER=b1-1");
		expect(lines).toContain("KANGENT_ISSUE_TITLE=test card");
		expect(lines.find((l) => l.startsWith("KANGENT_WORKSPACE="))).toBe(
			`KANGENT_WORKSPACE=${path.resolve(wsRoot, "b1-1")}`,
		);
	});

	it("runs after_create with the workspace as cwd", async () => {
		// Capture pwd at the time the hook runs.
		const marker = path.join(wsRoot, "cwd-capture");
		const workflow = makeWorkflow({
			after_create: `pwd > "${marker}"`,
		});
		const issue = makeIssue();
		const wsPath = await acquire(issue, workflow);
		const captured = (await fs.readFile(marker, "utf8")).trim();
		// macOS prepends /private to /tmp paths via symlink-resolved cwd.
		expect(captured.endsWith(path.basename(wsPath))).toBe(true);
	});

	it("runs before_run on every acquire (not gated by sentinel)", async () => {
		const marker = path.join(wsRoot, "before_run_log");
		const workflow = makeWorkflow({
			before_run: `echo "$KANGENT_ISSUE_IDENTIFIER" >> "${marker}"`,
		});
		const issue = makeIssue();
		await acquire(issue, workflow);
		await acquire(issue, workflow);
		await acquire(issue, workflow);
		const log = await fs.readFile(marker, "utf8");
		expect(log.trim().split("\n")).toEqual(["b1-1", "b1-1", "b1-1"]);
	});

	it("rolls back the workspace dir when after_create fails (so next acquire starts clean)", async () => {
		// Hook creates a file then exits non-zero. Without rollback, the
		// next acquire would see the directory exists, skip after_create
		// because the sentinel… wait, sentinel won't exist. So the next
		// acquire should rm-rf the partial state and re-run. But this
		// test specifically checks that rm-rf happens IMMEDIATELY on
		// after_create failure, so the on-disk state is clean even before
		// a retry.
		const workflow = makeWorkflow({
			after_create: `touch should-not-survive && exit 1`,
		});
		const issue = makeIssue();
		const wsPath = path.resolve(wsRoot, "b1-1");
		await expect(acquire(issue, workflow)).rejects.toMatchObject({
			_tag: "WorkspaceError",
			kind: "hook_failed",
			hook: "after_create",
		});
		expect(await dirExists(wsPath)).toBe(false);
	});

	it("re-runs after_create on a half-built workspace (dir exists, sentinel missing)", async () => {
		// Simulate a crashed prior run: workspace dir exists with leftover
		// junk, but no sentinel. The next acquire should wipe and rerun.
		const wsPath = path.resolve(wsRoot, "b1-1");
		await fs.mkdir(wsPath, { recursive: true });
		await fs.writeFile(path.join(wsPath, "stale-junk"), "x");
		// No sentinel.
		const marker = path.join(wsRoot, "rerun-marker");
		const workflow = makeWorkflow({
			after_create: `echo ran > "${marker}"`,
		});
		await acquire(makeIssue(), workflow);
		expect(await fileContents(marker)).toBe("ran\n");
		// Stale junk was wiped.
		expect(await fileContents(path.join(wsPath, "stale-junk"))).toBeNull();
		// Fresh sentinel is in place.
		expect(await fileContents(path.join(wsPath, ".kangent-ready"))).toBe("");
	});

	it("fails with hook_timeout when a hook overruns hooks.timeout_ms", async () => {
		const workflow = makeWorkflow({
			after_create: `sleep 10`,
			timeout_ms: 200, // 200ms timeout; sleep 10s should be killed.
		});
		await expect(acquire(makeIssue(), workflow)).rejects.toMatchObject({
			_tag: "WorkspaceError",
			kind: "hook_timeout",
			hook: "after_create",
		});
	});

	it("sanitises filesystem-unsafe characters in the identifier", async () => {
		// Theoretical identifier containing slashes + dots — board-core
		// makes this impossible today, but the sanitiser keeps us safe
		// if the scheme ever widens. Note: `.` is stripped along with
		// `/` because `..` as a path component would otherwise escape.
		const issue = makeIssue({ identifier: "b1/dangerous-../../etc" });
		const result = await acquire(issue, makeWorkflow());
		expect(result).toBe(
			path.resolve(wsRoot, "b1_dangerous-______etc"),
		);
		expect(result.startsWith(wsRoot)).toBe(true);
	});

	it("refuses to escape the workspace root via a literal '..' identifier (regression)", async () => {
		// Before the fix, `path.resolve(rootDir, "..")` returned the
		// PARENT of rootDir — a workspace-escape bug. The sanitiser now
		// rewrites `..` to `__` so the resolved path stays inside root.
		const issue = makeIssue({ identifier: ".." });
		const result = await acquire(issue, makeWorkflow());
		expect(result).toBe(path.resolve(wsRoot, "__"));
		expect(result.startsWith(wsRoot)).toBe(true);
	});
});

describe("WorkspaceManager.release", () => {
	it("runs after_run with the workspace as cwd and the right env", async () => {
		const marker = path.join(wsRoot, "after_run_log");
		const workflow = makeWorkflow({
			after_run: `echo "$KANGENT_ISSUE_IDENTIFIER@$KANGENT_WORKSPACE" >> "${marker}"`,
		});
		const issue = makeIssue();
		const wsPath = await acquire(issue, workflow);
		await release(issue, wsPath, workflow);
		const log = (await fs.readFile(marker, "utf8")).trim();
		expect(log).toBe(`b1-1@${wsPath}`);
	});

	it("is a no-op when after_run is not configured", async () => {
		const workflow = makeWorkflow(); // no hooks
		const issue = makeIssue();
		const wsPath = await acquire(issue, workflow);
		await expect(release(issue, wsPath, workflow)).resolves.toBeUndefined();
	});
});
