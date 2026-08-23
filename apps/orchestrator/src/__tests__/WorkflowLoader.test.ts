import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowLoader, WorkflowLoaderLayer } from "../services/WorkflowLoader.js";

// --- Helpers ------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(tmpdir(), "kangent-workflow-test-"));
});

afterEach(async () => {
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeWorkflow(content: string): Promise<string> {
	const p = path.join(tmpRoot, "WORKFLOW.md");
	await fs.writeFile(p, content, "utf8");
	return p;
}

const load = (workflowPath: string) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const loader = yield* WorkflowLoader;
			return yield* loader.load(workflowPath);
		}).pipe(Effect.provide(WorkflowLoaderLayer)),
	);

// --- Tests --------------------------------------------------------------

describe("WorkflowLoader", () => {
	it("parses front matter + body and returns ResolvedConfig", async () => {
		const p = await writeWorkflow(`---
tracker:
  kind: kangent
  kangent:
    endpoint: https://kangent.example
    board_id: abc123

polling:
  interval_ms: 15000
---

Hi {{ issue.identifier }}, do the thing.
`);
		const loaded = await load(p);
		expect(loaded.config.tracker.kind).toBe("kangent");
		expect(loaded.config.tracker.kangent.endpoint).toBe(
			"https://kangent.example",
		);
		expect(loaded.config.tracker.kangent.board_id).toBe("abc123");
		expect(loaded.config.polling.interval_ms).toBe(15_000);
		expect(loaded.promptTemplate).toBe("Hi {{ issue.identifier }}, do the thing.");
	});

	it("applies Kangent-flavoured defaults when sections are omitted", async () => {
		const p = await writeWorkflow(`---
tracker:
  kind: kangent
  kangent:
    endpoint: https://k
    board_id: b1
---

prompt
`);
		const loaded = await load(p);
		expect(loaded.config.tracker.active_states).toEqual(["Todo", "In Progress"]);
		expect(loaded.config.tracker.terminal_states).toEqual(["Done"]);
		expect(loaded.config.polling.interval_ms).toBe(30_000);
		expect(loaded.config.agent.max_concurrent_agents).toBe(10);
		expect(loaded.config.agent.max_turns).toBe(20);
		expect(loaded.config.codex.command).toBe("codex app-server");
		expect(loaded.config.codex.turn_timeout_ms).toBe(3_600_000);
	});

	it("lower-cases label_filter and label_exclude (so YAML case doesn't matter)", async () => {
		const p = await writeWorkflow(`---
tracker:
  kind: kangent
  kangent:
    endpoint: https://k
    board_id: b1
    label_filter: ["Agent-Ready", "BACKEND"]
    label_exclude: ["WIP"]
---
`);
		const loaded = await load(p);
		expect(loaded.config.tracker.kangent.label_filter).toEqual([
			"agent-ready",
			"backend",
		]);
		expect(loaded.config.tracker.kangent.label_exclude).toEqual(["wip"]);
	});

	it("resolves $ENV_VAR indirection on endpoint and agent_id", async () => {
		process.env.KANGENT_TEST_ENDPOINT = "https://envvar.example";
		process.env.KANGENT_TEST_AGENT_ID = "agent-from-env";
		try {
			const p = await writeWorkflow(`---
tracker:
  kind: kangent
  kangent:
    endpoint: $KANGENT_TEST_ENDPOINT
    board_id: b1
    agent_id: $KANGENT_TEST_AGENT_ID
---
`);
			const loaded = await load(p);
			expect(loaded.config.tracker.kangent.endpoint).toBe(
				"https://envvar.example",
			);
			expect(loaded.config.tracker.kangent.agent_id).toBe("agent-from-env");
		} finally {
			delete process.env.KANGENT_TEST_ENDPOINT;
			delete process.env.KANGENT_TEST_AGENT_ID;
		}
	});

	it("returns the literal value when $VAR is not set (lets doctor flag it)", async () => {
		delete process.env.KANGENT_DEFINITELY_UNSET;
		const p = await writeWorkflow(`---
tracker:
  kind: kangent
  kangent:
    endpoint: $KANGENT_DEFINITELY_UNSET
    board_id: b1
---
`);
		const loaded = await load(p);
		// Unset → loader returns the literal string so `doctor` can show
		// "your $VAR pointed at nothing" rather than silently empty.
		expect(loaded.config.tracker.kangent.endpoint).toBe(
			"$KANGENT_DEFINITELY_UNSET",
		);
	});

	it("rejects non-map front matter with WorkflowError(front_matter_not_a_map)", async () => {
		const p = await writeWorkflow(`---
- just a list
- of strings
---

body
`);
		await expect(load(p)).rejects.toMatchObject({
			_tag: "WorkflowError",
			kind: "front_matter_not_a_map",
		});
	});

	it("rejects malformed YAML with WorkflowError(parse_error)", async () => {
		const p = await writeWorkflow(`---
tracker:
  kind: kangent
  kangent:
   endpoint: "unclosed string
---

body
`);
		await expect(load(p)).rejects.toMatchObject({
			_tag: "WorkflowError",
			kind: "parse_error",
		});
	});

	it("rejects wrong-typed fields with WorkflowError(validation_error)", async () => {
		const p = await writeWorkflow(`---
polling:
  interval_ms: "thirty seconds"
---
`);
		await expect(load(p)).rejects.toMatchObject({
			_tag: "WorkflowError",
			kind: "validation_error",
		});
	});

	it("rejects a path that doesn't exist with WorkflowError(missing_file)", async () => {
		const ghost = path.join(tmpRoot, "DOES-NOT-EXIST.md");
		await expect(load(ghost)).rejects.toMatchObject({
			_tag: "WorkflowError",
			kind: "missing_file",
		});
	});

	it("ignores unknown front-matter keys (Symphony §5.3 forward-compat)", async () => {
		const p = await writeWorkflow(`---
tracker:
  kind: kangent
  kangent:
    endpoint: https://k
    board_id: b1

# Hypothetical future section that this version doesn't know about
some_section_we_dont_understand:
  foo: 42
---
`);
		const loaded = await load(p);
		expect(loaded.config.tracker.kangent.endpoint).toBe("https://k");
	});

	it("treats a file with no front matter as all-prompt-body", async () => {
		const p = await writeWorkflow("Just a prompt, no front matter at all.\n");
		const loaded = await load(p);
		expect(loaded.promptTemplate).toBe("Just a prompt, no front matter at all.");
		// Defaults still apply
		expect(loaded.config.tracker.kind).toBe("kangent");
	});

	it("drops non-positive entries from max_concurrent_agents_by_state", async () => {
		const p = await writeWorkflow(`---
agent:
  max_concurrent_agents_by_state:
    "In Progress": 2
    "Review": 0
    "Spike": -1
    "Done": 1.5
---
`);
		const loaded = await load(p);
		expect(loaded.config.agent.max_concurrent_agents_by_state).toEqual({
			"in progress": 2,
		});
	});
});
