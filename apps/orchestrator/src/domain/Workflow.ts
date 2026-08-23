/**
 * WORKFLOW.md schema. Models the Symphony-spec front matter sections
 * (tracker, polling, workspace, hooks, agent, codex) plus the Kangent
 * extension under `tracker.kangent` and the optional dashboard server.
 *
 * Schemas here are intentionally permissive — fields are `optional` and
 * the loader applies defaults after a successful decode. That keeps the
 * decode error surface narrow (only "wrong type" failures, not "missing
 * field" failures) and lets us evolve defaults without breaking files
 * that already validate.
 */

import { Schema } from "effect";

// --- Helpers ------------------------------------------------------------

/**
 * Strings that may either be literal values or `$VAR` env-var references.
 * Resolved by the loader, not the schema. Symphony §6.1 says env-var
 * indirection only applies where a value explicitly starts with `$`.
 */
const StringOrEnv = Schema.String;

// --- Tracker section ----------------------------------------------------

/**
 * The Kangent extension block under `tracker.kangent`. Symphony §5.3 says
 * unknown keys SHOULD be ignored, so the implementation owns this shape.
 */
export const TrackerKangent = Schema.Struct({
	endpoint: Schema.optional(Schema.String),
	board_id: Schema.optional(Schema.String),
	board_url: Schema.optional(Schema.String),
	label_filter: Schema.optional(Schema.Array(Schema.String)),
	label_exclude: Schema.optional(Schema.Array(Schema.String)),
	agent_id: Schema.optional(StringOrEnv),
});

export const TrackerSection = Schema.Struct({
	kind: Schema.optional(Schema.String),
	active_states: Schema.optional(Schema.Array(Schema.String)),
	terminal_states: Schema.optional(Schema.Array(Schema.String)),
	kangent: Schema.optional(TrackerKangent),
});

// --- Polling section ----------------------------------------------------

export const PollingSection = Schema.Struct({
	interval_ms: Schema.optional(Schema.Number),
});

// --- Workspace section --------------------------------------------------

export const WorkspaceSection = Schema.Struct({
	root: Schema.optional(StringOrEnv),
});

// --- Hooks section ------------------------------------------------------

export const HooksSection = Schema.Struct({
	after_create: Schema.optional(Schema.String),
	before_run: Schema.optional(Schema.String),
	after_run: Schema.optional(Schema.String),
	before_remove: Schema.optional(Schema.String),
	timeout_ms: Schema.optional(Schema.Number),
});

// --- Agent section ------------------------------------------------------

export const AgentSection = Schema.Struct({
	max_concurrent_agents: Schema.optional(Schema.Number),
	max_turns: Schema.optional(Schema.Number),
	max_retry_backoff_ms: Schema.optional(Schema.Number),
	max_concurrent_agents_by_state: Schema.optional(
		Schema.Record(Schema.String, Schema.Number),
	),
});

// --- Codex section ------------------------------------------------------

export const CodexSection = Schema.Struct({
	command: Schema.optional(Schema.String),
	approval_policy: Schema.optional(Schema.String),
	thread_sandbox: Schema.optional(Schema.String),
	turn_sandbox_policy: Schema.optional(Schema.String),
	turn_timeout_ms: Schema.optional(Schema.Number),
	read_timeout_ms: Schema.optional(Schema.Number),
	stall_timeout_ms: Schema.optional(Schema.Number),
});

// --- Server (optional dashboard) ---------------------------------------

export const ServerSection = Schema.Struct({
	port: Schema.optional(Schema.Number),
});

// --- Top-level front matter --------------------------------------------

export const WorkflowFrontMatter = Schema.Struct({
	tracker: Schema.optional(TrackerSection),
	polling: Schema.optional(PollingSection),
	workspace: Schema.optional(WorkspaceSection),
	hooks: Schema.optional(HooksSection),
	agent: Schema.optional(AgentSection),
	codex: Schema.optional(CodexSection),
	server: Schema.optional(ServerSection),
});

export type WorkflowFrontMatter = typeof WorkflowFrontMatter.Type;

// --- Resolved (post-defaults, post-env-resolution) config --------------

/**
 * Effective config after defaults are applied and `$VAR` indirection is
 * resolved. This is the shape services consume — schemas above are the
 * input contract, this is the runtime contract.
 */
export interface ResolvedConfig {
	readonly tracker: {
		readonly kind: string;
		readonly active_states: readonly string[];
		readonly terminal_states: readonly string[];
		readonly kangent: {
			readonly endpoint: string | undefined;
			readonly board_id: string | undefined;
			readonly board_url: string | undefined;
			readonly label_filter: readonly string[];
			readonly label_exclude: readonly string[];
			readonly agent_id: string | undefined;
		};
	};
	readonly polling: {
		readonly interval_ms: number;
	};
	readonly workspace: {
		readonly root: string;
	};
	readonly hooks: {
		readonly after_create: string | undefined;
		readonly before_run: string | undefined;
		readonly after_run: string | undefined;
		readonly before_remove: string | undefined;
		readonly timeout_ms: number;
	};
	readonly agent: {
		readonly max_concurrent_agents: number;
		readonly max_turns: number;
		readonly max_retry_backoff_ms: number;
		readonly max_concurrent_agents_by_state: Readonly<Record<string, number>>;
	};
	readonly codex: {
		readonly command: string;
		readonly approval_policy: string | undefined;
		readonly thread_sandbox: string | undefined;
		readonly turn_sandbox_policy: string | undefined;
		readonly turn_timeout_ms: number;
		readonly read_timeout_ms: number;
		readonly stall_timeout_ms: number;
	};
	readonly server: {
		readonly port: number | undefined;
	};
}

/** The loaded WORKFLOW.md after parse + Schema decode + defaults. */
export interface LoadedWorkflow {
	/** Absolute path the workflow was loaded from. */
	readonly path: string;
	/** Markdown body after stripping front matter; trimmed. */
	readonly promptTemplate: string;
	/** Effective runtime config after defaults + env resolution. */
	readonly config: ResolvedConfig;
	/** Raw decoded front matter (pre-defaults), kept for `workflow show`. */
	readonly raw: WorkflowFrontMatter;
}
