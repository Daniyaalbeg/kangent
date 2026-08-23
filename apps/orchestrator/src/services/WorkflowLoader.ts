/**
 * Reads `WORKFLOW.md`, parses YAML front matter + Markdown body, validates
 * the front matter against the Schema in `domain/Workflow.ts`, applies
 * defaults, and resolves `$VAR_NAME` env-var indirection on string fields
 * that explicitly start with `$`.
 *
 * This service is the single source of truth for the "config layer" in
 * Symphony's component model (§3.1). Other services consume `LoadedWorkflow`
 * and don't reach back to the file system.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import matter from "gray-matter";
import { WorkflowError } from "../domain/errors.js";
import {
	type LoadedWorkflow,
	type ResolvedConfig,
	type WorkflowFrontMatter,
	WorkflowFrontMatter as WorkflowFrontMatterSchema,
} from "../domain/Workflow.js";

// --- $VAR / ~ expansion -------------------------------------------------

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value;
}

function resolveEnv(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!value.startsWith("$")) return value;
	const name = value.slice(1);
	const resolved = process.env[name];
	if (!resolved || resolved.length === 0) return undefined;
	return resolved;
}

function resolvePath(value: string, workflowDir: string): string {
	const expanded = expandHome(value);
	const envResolved = resolveEnv(expanded) ?? expanded;
	if (path.isAbsolute(envResolved)) return envResolved;
	return path.resolve(workflowDir, envResolved);
}

// --- Defaults (Symphony spec §6.4) -------------------------------------

const DEFAULT_ACTIVE_STATES_KANGENT = ["Todo", "In Progress"] as const;
const DEFAULT_TERMINAL_STATES_KANGENT = ["Done"] as const;

function applyDefaults(
	raw: WorkflowFrontMatter,
	workflowPath: string,
): ResolvedConfig {
	const workflowDir = path.dirname(workflowPath);
	const trackerKind = raw.tracker?.kind ?? "kangent";

	const trackerSection = raw.tracker;
	const kangent = trackerSection?.kangent;

	const workspaceRoot = raw.workspace?.root
		? resolvePath(raw.workspace.root, workflowDir)
		: path.join(tmpdir(), "kangent_workspaces");

	const activeStates =
		trackerSection?.active_states && trackerSection.active_states.length > 0
			? [...trackerSection.active_states]
			: trackerKind === "kangent"
				? [...DEFAULT_ACTIVE_STATES_KANGENT]
				: ["Todo", "In Progress"];

	const terminalStates =
		trackerSection?.terminal_states && trackerSection.terminal_states.length > 0
			? [...trackerSection.terminal_states]
			: trackerKind === "kangent"
				? [...DEFAULT_TERMINAL_STATES_KANGENT]
				: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

	const concurrencyByState: Record<string, number> = {};
	const rawConcurrencyMap = raw.agent?.max_concurrent_agents_by_state ?? {};
	for (const [stateName, n] of Object.entries(rawConcurrencyMap)) {
		// Symphony §5.3.5: ignore non-positive entries; normalise state names
		// to lowercase for lookup so workflow authors don't have to match the
		// exact column casing.
		if (typeof n === "number" && n > 0 && Number.isInteger(n)) {
			concurrencyByState[stateName.toLowerCase()] = n;
		}
	}

	return {
		tracker: {
			kind: trackerKind,
			active_states: activeStates,
			terminal_states: terminalStates,
			kangent: {
				endpoint: resolveEnv(kangent?.endpoint) ?? kangent?.endpoint,
				board_id: kangent?.board_id,
				board_url: kangent?.board_url,
				label_filter: (kangent?.label_filter ?? []).map((l) => l.toLowerCase()),
				label_exclude: (kangent?.label_exclude ?? []).map((l) =>
					l.toLowerCase(),
				),
				agent_id: resolveEnv(kangent?.agent_id) ?? kangent?.agent_id,
			},
		},
		polling: {
			interval_ms: raw.polling?.interval_ms ?? 30_000,
		},
		workspace: {
			root: workspaceRoot,
		},
		hooks: {
			after_create: raw.hooks?.after_create,
			before_run: raw.hooks?.before_run,
			after_run: raw.hooks?.after_run,
			before_remove: raw.hooks?.before_remove,
			timeout_ms: raw.hooks?.timeout_ms ?? 60_000,
		},
		agent: {
			max_concurrent_agents: raw.agent?.max_concurrent_agents ?? 10,
			max_turns: raw.agent?.max_turns ?? 20,
			max_retry_backoff_ms: raw.agent?.max_retry_backoff_ms ?? 300_000,
			max_concurrent_agents_by_state: concurrencyByState,
		},
		codex: {
			command: raw.codex?.command ?? "codex app-server",
			approval_policy: raw.codex?.approval_policy,
			thread_sandbox: raw.codex?.thread_sandbox,
			turn_sandbox_policy: raw.codex?.turn_sandbox_policy,
			turn_timeout_ms: raw.codex?.turn_timeout_ms ?? 3_600_000,
			read_timeout_ms: raw.codex?.read_timeout_ms ?? 5_000,
			stall_timeout_ms: raw.codex?.stall_timeout_ms ?? 300_000,
		},
		server: {
			port: raw.server?.port,
		},
	};
}

// --- Service ------------------------------------------------------------

export class WorkflowLoader extends Context.Service<
	WorkflowLoader,
	{
		/** Load and validate a `WORKFLOW.md` file. Returns the resolved config. */
		readonly load: (workflowPath: string) => Effect.Effect<LoadedWorkflow, WorkflowError>;
	}
>()("orchestrator/WorkflowLoader") {}

/**
 * Live implementation. Stateless — no hidden caching, so callers can
 * re-load freely (e.g. when a file watcher fires). Symphony §6.2 calls
 * for dynamic reload; we'll wire the watcher around this service later.
 */
export const WorkflowLoaderLayer = Layer.succeed(WorkflowLoader, {
	load: (workflowPath: string) =>
		Effect.gen(function* () {
			const absolute = path.resolve(workflowPath);
			const raw = yield* readFile(absolute);
			const parsed = yield* parseFrontMatter(absolute, raw);
			const decoded = yield* decodeFrontMatter(absolute, parsed.data);
			const config = applyDefaults(decoded, absolute);
			return {
				path: absolute,
				promptTemplate: parsed.content.trim(),
				config,
				raw: decoded,
			};
		}),
});

// --- Internal steps -----------------------------------------------------

function readFile(absolute: string) {
	return Effect.tryPromise({
		try: () => fs.readFile(absolute, "utf8"),
		catch: (cause) =>
			new WorkflowError({
				kind: "missing_file",
				path: absolute,
				message:
					cause instanceof Error
						? cause.message
						: `Failed to read ${absolute}`,
			}),
	});
}

function parseFrontMatter(absolute: string, raw: string) {
	return Effect.try({
		try: () => matter(raw),
		catch: (cause) =>
			new WorkflowError({
				kind: "parse_error",
				path: absolute,
				message:
					cause instanceof Error ? cause.message : String(cause),
			}),
	}).pipe(
		Effect.flatMap((result) => {
			// `matter` returns `{}` for missing front matter — that's allowed
			// by Symphony §5.2 ("treat the entire file as prompt body").
			// But if the front matter parses to a non-map (string, array,
			// number), reject it.
			if (
				result.data === null ||
				typeof result.data !== "object" ||
				Array.isArray(result.data)
			) {
				return Effect.fail(
					new WorkflowError({
						kind: "front_matter_not_a_map",
						path: absolute,
						message:
							"YAML front matter must decode to a map/object at the top level",
					}),
				);
			}
			return Effect.succeed(result);
		}),
	);
}

function decodeFrontMatter(absolute: string, data: unknown) {
	return Schema.decodeUnknownEffect(WorkflowFrontMatterSchema)(data).pipe(
		Effect.mapError(
			(parseError) =>
				new WorkflowError({
					kind: "validation_error",
					path: absolute,
					message:
						parseError instanceof Error
							? parseError.message
							: String(parseError),
				}),
		),
	);
}

// --- WorkflowConfig (loaded snapshot, provided into the runtime) ------

/**
 * The loaded `WORKFLOW.md` exposed as a service so any other service can
 * read it via `yield* WorkflowConfig`. The CLI loads once at startup and
 * provides this service for the rest of the lifetime — re-loading on
 * file change replaces the layer (Symphony §6.2 dynamic reload).
 */
export class WorkflowConfig extends Context.Service<
	WorkflowConfig,
	LoadedWorkflow
>()("orchestrator/WorkflowConfig") {}

/**
 * Build a `WorkflowConfig` layer from a single already-loaded workflow.
 * Use from the CLI after a successful `WorkflowLoader.load()`:
 *
 *   const loaded = yield* loader.load(workflowPath)
 *   yield* program.pipe(Effect.provide(WorkflowConfigOf(loaded)))
 */
export const WorkflowConfigOf = (loaded: LoadedWorkflow) =>
	Layer.succeed(WorkflowConfig, loaded);
