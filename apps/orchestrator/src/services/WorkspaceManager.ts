/**
 * Per-issue workspace lifecycle. Symphony §6.5 (hooks) + §10.7 (run loop).
 *
 * Each issue gets its own directory under `config.workspace.root`, named
 * by the issue identifier (e.g. `~/.kangent/workspaces/b1-7/`). Codex runs
 * with that directory as its cwd. The user's `hooks.*` scripts run at
 * lifecycle boundaries with `KANGENT_*` env vars so they can react to
 * the current issue.
 *
 * Lifecycle:
 *
 *   acquire(issue)        ← AgentRunner calls before codex
 *     ├── ensureDir       ← mkdir -p; rm -rf any half-built dir
 *     ├── after_create    ← only if newly created (sentinel-gated)
 *     └── before_run      ← every dispatch, even on existing workspaces
 *
 *   release(issue, path)  ← AgentRunner calls after codex (success OR failure)
 *     └── after_run
 *
 *   (not yet wired) teardown(issue) → before_remove + rm -rf
 *
 * Idempotency: `<workspace>/.kangent-ready` is a sentinel file written
 * at the very end of `after_create`. On prepare:
 *   - sentinel present  → workspace was set up cleanly; skip `after_create`
 *   - sentinel missing  → either fresh (dir doesn't exist) or stale from
 *     a crashed prior run; rm -rf and re-create from scratch.
 *
 * Hook execution: `sh -c <script>` via `child_process.spawn`. Output is
 * inherited from the parent so users see the hook's logs in their
 * terminal (Symphony §13.4 says hook logs are "developer-facing", not
 * structured). On `hooks.timeout_ms` expiry we SIGTERM the child; if it
 * doesn't exit within 5s of SIGTERM we SIGKILL it. Interrupts (SIGINT
 * to the parent) propagate to the hook via the `AbortSignal` that
 * `Effect.callback` hands us — the hook gets the same kill chain.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import { WorkspaceError } from "../domain/errors.js";
import type { Issue } from "../domain/Issue.js";
import { WorkflowConfig } from "./WorkflowLoader.js";

const SENTINEL = ".kangent-ready";

type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

export interface WorkspaceManagerImpl {
	/**
	 * Ensure the workspace exists for `issue` and run any pre-codex hooks.
	 * Returns the absolute workspace path. Idempotent: re-calling on an
	 * already-prepared workspace skips `after_create` but always re-runs
	 * `before_run`.
	 */
	readonly acquire: (
		issue: Issue,
	) => Effect.Effect<string, WorkspaceError, WorkflowConfig>;

	/** Run the post-codex `after_run` hook against `path`. */
	readonly release: (
		issue: Issue,
		workspacePath: string,
	) => Effect.Effect<void, WorkspaceError, WorkflowConfig>;
}

export class WorkspaceManager extends Context.Service<
	WorkspaceManager,
	WorkspaceManagerImpl
>()("orchestrator/WorkspaceManager") {}

// ---------------------------------------------------------------- helpers ---

function workspacePath(rootDir: string, issue: Issue): string {
	// The identifier is `<boardId>-<seq>` — filesystem-safe by construction
	// (alnum + dash). We still defensively replace unsafe chars in case a
	// future identifier scheme widens.
	//
	// Note: `.` is intentionally NOT in the allowlist. Identifiers don't
	// contain dots, and an identifier of literal `..` would otherwise
	// `path.resolve` to the parent of `rootDir` — a workspace-escape bug.
	const safe = issue.identifier.replace(/[^A-Za-z0-9_-]/g, "_");
	const resolved = path.resolve(rootDir, safe);
	// Defense in depth: even with the regex above, refuse to return any
	// path that doesn't sit cleanly inside `rootDir`. Catches symlink
	// shenanigans and any future regex regression.
	const rootResolved = path.resolve(rootDir);
	if (
		resolved !== rootResolved &&
		!resolved.startsWith(rootResolved + path.sep)
	) {
		throw new Error(
			`workspace path escaped root: identifier=${issue.identifier} resolved=${resolved} root=${rootResolved}`,
		);
	}
	return resolved;
}

function issueEnv(issue: Issue, ws: string): Record<string, string> {
	return {
		...process.env,
		KANGENT_ISSUE_ID: issue.id,
		KANGENT_ISSUE_IDENTIFIER: issue.identifier,
		KANGENT_ISSUE_TITLE: issue.title,
		KANGENT_ISSUE_STATE: issue.state,
		KANGENT_ISSUE_URL: issue.url ?? "",
		KANGENT_ISSUE_BRANCH: issue.branch_name ?? "",
		KANGENT_WORKSPACE: ws,
	} as Record<string, string>;
}

/** Promisified `fs.access` returning a boolean. */
async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Run a single hook script. Returns void on success; fails with
 * `WorkspaceError` on non-zero exit, timeout, or spawn error.
 *
 * Implementation notes:
 *   - `Effect.callback` is v4's async primitive. The `AbortSignal` it
 *     hands us fires on fiber interrupt (e.g. SIGINT during daemon
 *     shutdown) and we wire it to kill the child.
 *   - Two-phase kill: SIGTERM first, then SIGKILL after 5s. Lets `git
 *     clone` etc. clean up gracefully when the hook itself is well-behaved.
 *   - `stdio: "inherit"` because users wrote these scripts and want to
 *     see their `echo`/`git` output. Structured logging is for the
 *     orchestrator's own diagnostics, not for opaque shell scripts.
 */
function runHook(opts: {
	readonly name: HookName;
	readonly script: string;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly timeoutMs: number;
}): Effect.Effect<void, WorkspaceError> {
	return Effect.callback<void, WorkspaceError>((resume, signal) => {
		const child = spawn("sh", ["-c", opts.script], {
			cwd: opts.cwd,
			env: opts.env,
			stdio: "inherit",
		});

		let settled = false;
		const settle = (effect: Effect.Effect<void, WorkspaceError>) => {
			if (settled) return;
			settled = true;
			cleanupTimers();
			resume(effect);
		};

		// Three reasons we'd kill the child: timeout, interrupt, or our
		// own escalation when SIGTERM is ignored. Track which fired so the
		// error message is accurate.
		let killReason: "timeout" | "interrupt" | null = null;
		let escalated = false;

		const killChild = (sig: NodeJS.Signals) => {
			try {
				child.kill(sig);
			} catch {
				/* already gone */
			}
		};

		const timeoutTimer = setTimeout(() => {
			killReason = "timeout";
			killChild("SIGTERM");
			// SIGKILL escalation if SIGTERM is ignored for 5s.
			escalateTimer = setTimeout(() => {
				escalated = true;
				killChild("SIGKILL");
			}, 5_000);
		}, opts.timeoutMs);

		let escalateTimer: NodeJS.Timeout | null = null;
		const cleanupTimers = () => {
			clearTimeout(timeoutTimer);
			if (escalateTimer) clearTimeout(escalateTimer);
		};

		// Fiber interrupt → tear the child down with the same escalation
		// chain. AbortSignal fires once; the listener runs on the
		// microtask after `resume` is invoked, so settle's `settled`
		// guard prevents a double-resume from the exit handler.
		signal.addEventListener("abort", () => {
			if (settled) return;
			killReason = "interrupt";
			killChild("SIGTERM");
			escalateTimer = setTimeout(() => {
				escalated = true;
				killChild("SIGKILL");
			}, 5_000);
		});

		child.once("error", (err) => {
			settle(
				Effect.fail(
					new WorkspaceError({
						kind: "hook_failed",
						hook: opts.name,
						message: `Hook ${opts.name} failed to spawn: ${err.message}`,
					}),
				),
			);
		});

		child.once("exit", (code, sig) => {
			if (sig === "SIGTERM" || sig === "SIGKILL") {
				const kind =
					killReason === "interrupt"
						? "hook_signal"
						: escalated
							? "hook_signal"
							: "hook_timeout";
				settle(
					Effect.fail(
						new WorkspaceError({
							kind,
							hook: opts.name,
							message: `Hook ${opts.name} killed by ${sig}${
								killReason === "timeout" && !escalated
									? ` after ${opts.timeoutMs}ms timeout`
									: ""
							}`,
						}),
					),
				);
				return;
			}
			if (code === 0) {
				settle(Effect.void);
				return;
			}
			settle(
				Effect.fail(
					new WorkspaceError({
						kind: "hook_failed",
						hook: opts.name,
						message: `Hook ${opts.name} exited with code ${code ?? "?"}`,
						exitCode: code ?? undefined,
					}),
				),
			);
		});
	});
}

function ioError(
	message: string,
	cause?: unknown,
): WorkspaceError {
	return new WorkspaceError({
		kind: "io_error",
		message: cause instanceof Error ? `${message}: ${cause.message}` : message,
	});
}

// ----------------------------------------------------------------- layer ---

export const WorkspaceManagerLayer = Layer.succeed(WorkspaceManager, {
	acquire: (issue) =>
		Effect.gen(function* () {
			const cfg = yield* WorkflowConfig;
			const ws = workspacePath(cfg.config.workspace.root, issue);
			const sentinel = path.join(ws, SENTINEL);

			const wsExists = yield* Effect.tryPromise({
				try: () => exists(ws),
				catch: (cause) => ioError(`stat ${ws}`, cause),
			});
			const sentinelExists = wsExists
				? yield* Effect.tryPromise({
						try: () => exists(sentinel),
						catch: (cause) => ioError(`stat ${sentinel}`, cause),
					})
				: false;

			// Half-built workspace (dir exists, sentinel missing) → wipe and
			// rebuild. This happens after a crash mid-`after_create`.
			if (wsExists && !sentinelExists) {
				yield* Effect.tryPromise({
					try: () => fs.rm(ws, { recursive: true, force: true }),
					catch: (cause) => ioError(`rm -rf ${ws}`, cause),
				});
			}

			const isFresh = !sentinelExists;
			if (isFresh) {
				yield* Effect.tryPromise({
					try: () => fs.mkdir(ws, { recursive: true }),
					catch: (cause) => ioError(`mkdir -p ${ws}`, cause),
				});

				if (cfg.config.hooks.after_create) {
					yield* runHook({
						name: "after_create",
						script: cfg.config.hooks.after_create,
						cwd: ws,
						env: issueEnv(issue, ws),
						timeoutMs: cfg.config.hooks.timeout_ms,
					}).pipe(
						// On after_create failure: rm -rf so the next dispatch
						// starts clean rather than skipping after_create on a
						// half-built tree. Sentinel was never written, so this
						// is what the next call would do anyway — we just do
						// it eagerly to avoid leaving litter.
						Effect.tapError(() =>
							Effect.tryPromise({
								try: () => fs.rm(ws, { recursive: true, force: true }),
								catch: () => ioError("rm during rollback"),
							}).pipe(
								Effect.matchEffect({
									onFailure: () => Effect.void,
									onSuccess: () => Effect.void,
								}),
							),
						),
					);

					yield* Effect.tryPromise({
						try: () => fs.writeFile(sentinel, ""),
						catch: (cause) => ioError(`touch ${sentinel}`, cause),
					});
				} else {
					// No `after_create` configured — write the sentinel
					// immediately so future calls take the fast path.
					yield* Effect.tryPromise({
						try: () => fs.writeFile(sentinel, ""),
						catch: (cause) => ioError(`touch ${sentinel}`, cause),
					});
				}
			}

			if (cfg.config.hooks.before_run) {
				yield* runHook({
					name: "before_run",
					script: cfg.config.hooks.before_run,
					cwd: ws,
					env: issueEnv(issue, ws),
					timeoutMs: cfg.config.hooks.timeout_ms,
				});
			}

			return ws;
		}),

	release: (issue, workspacePath) =>
		Effect.gen(function* () {
			const cfg = yield* WorkflowConfig;
			if (!cfg.config.hooks.after_run) return;
			yield* runHook({
				name: "after_run",
				script: cfg.config.hooks.after_run,
				cwd: workspacePath,
				env: issueEnv(issue, workspacePath),
				timeoutMs: cfg.config.hooks.timeout_ms,
			});
		}),
});
