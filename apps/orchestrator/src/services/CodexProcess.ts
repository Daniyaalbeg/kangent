/**
 * Spawn and supervise a `codex app-server` subprocess.
 *
 * Three layers live in this file:
 *
 *   - `CodexProcessLayer` (default) — the real spawn loop. Talks JSON-RPC
 *     over stdio (line-delimited; one JSON object per line, `\n` terminated)
 *     using the protocol that `codex app-server generate-ts` describes.
 *     Lifecycle per dispatch:
 *
 *         spawn  →  initialize  →  initialized
 *                →  thread/start (cwd = workspace)
 *                →  turn/start (input = rendered prompt)
 *                →  wait for "turn/completed" notification for our turnId
 *                →  inspect Turn.status; success / failure
 *                →  close stdin; wait for clean exit
 *
 *   - `CodexProcessFakeLayer(simulateMs)` — synthetic successful turn,
 *     used by `kangent run --fake-codex` and AgentRunner tests.
 *
 *   - `CodexProcessFailingLayer(reason)` — always-fail, for testing
 *     AgentRunner's rollback path.
 *
 * Failure handling:
 *
 *   - Spawn errors (ENOENT etc.)               → OrchestratorError
 *   - JSON-RPC response error on a required    → OrchestratorError
 *     request (initialize / thread/start /
 *     turn/start)
 *   - Turn ends with `status: failed`          → OrchestratorError with
 *                                                 turn.error.message
 *   - Turn ends with `status: interrupted`     → OrchestratorError
 *   - Timeout (params.timeoutMs)               → kill + OrchestratorError
 *   - Fiber interrupt (SIGINT / SIGTERM to     → kill chain (SIGTERM
 *     parent)                                    then SIGKILL after 5s)
 *
 * codex's stderr is piped to our stderr so users see deprecation warnings
 * and configuration notices. stdout is consumed by the RPC layer.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Context, Effect, Layer } from "effect";
import { OrchestratorError } from "../domain/errors.js";

// --------------------------------------------------------- protocol types ---

/**
 * Minimal protocol types — narrowed to the fields we actually use. The
 * generated `ClientRequest` / `ServerNotification` definitions are
 * exhaustive but huge; pulling the whole thing in would bloat the bundle
 * and force a redeploy whenever codex adds a method. We type only what
 * we send and the notifications we react to.
 */

interface RpcResponseOk<R> {
	readonly id: number | string;
	readonly result: R;
}
interface RpcResponseErr {
	readonly id: number | string;
	readonly error: { readonly code?: number; readonly message: string };
}
interface RpcNotification {
	readonly method: string;
	readonly params: unknown;
}
type RpcIncoming = RpcResponseOk<unknown> | RpcResponseErr | RpcNotification;

interface InitializeParams {
	readonly clientInfo: { name: string; title: string | null; version: string };
	readonly capabilities: null;
}

interface ThreadStartParams {
	readonly cwd: string;
	readonly approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
	readonly experimentalRawEvents: boolean;
	readonly persistExtendedHistory: boolean;
}

interface ThreadStartResponse {
	readonly thread: { readonly id: string };
}

interface TurnStartParams {
	readonly threadId: string;
	readonly input: ReadonlyArray<{
		readonly type: "text";
		readonly text: string;
		readonly text_elements: ReadonlyArray<unknown>;
	}>;
}

interface TurnStartResponse {
	readonly turn: { readonly id: string };
}

interface TurnCompletedNotification {
	readonly threadId: string;
	readonly turn: {
		readonly id: string;
		readonly status: "completed" | "interrupted" | "failed" | "inProgress";
		readonly error: { readonly message: string } | null;
		readonly durationMs: number | null;
	};
}

interface AgentMessageDeltaNotification {
	readonly threadId: string;
	readonly turnId: string;
	readonly itemId: string;
	readonly delta: string;
}

// ----------------------------------------------------------- service tag ---

export interface CodexProcessImpl {
	readonly start: (params: {
		readonly workspacePath: string;
		readonly command: string;
		/** Pre-rendered prompt — `{{ issue.foo }}` already substituted. */
		readonly prompt: string;
		/** Overall cap from `codex.turn_timeout_ms`. */
		readonly timeoutMs?: number;
		/** From `codex.approval_policy`; defaults to `"never"` for autonomous runs. */
		readonly approvalPolicy?: TurnStartApproval;
	}) => Effect.Effect<void, OrchestratorError>;
}

type TurnStartApproval = "untrusted" | "on-failure" | "on-request" | "never";

export class CodexProcess extends Context.Service<CodexProcess, CodexProcessImpl>()(
	"orchestrator/CodexProcess",
) {}

// --------------------------------------------------------------- helpers ---

/**
 * Split `codex.command` into `[bin, ...args]`. We use whitespace splitting
 * — sufficient for the `"codex app-server"` default and for users who pass
 * a custom path. Shell-style quoting / spaces in paths would need a real
 * parser; if that becomes a need we'll swap in `shell-quote` then.
 *
 * Appends `--listen=stdio://` to args if the user didn't include `--listen`
 * themselves. Without this we'd fall back to codex's default listen URL
 * (also stdio:// today, but we want to be explicit so changes in defaults
 * don't break us).
 */
function parseCommand(command: string): { bin: string; args: string[] } {
	const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) {
		return { bin: "codex", args: ["app-server", "--listen=stdio://"] };
	}
	const [bin, ...rest] = tokens;
	const hasListen = rest.some((a) => a.startsWith("--listen"));
	return {
		bin: bin as string,
		args: hasListen ? rest : [...rest, "--listen=stdio://"],
	};
}

function fail(message: string): OrchestratorError {
	return new OrchestratorError({ message });
}

// ---------------------------------------------------- the JSON-RPC client ---

/**
 * Tiny stateful JSON-RPC client over a pair of streams. Tracks pending
 * requests by id; forwards notifications to a callback. NDJSON framing.
 *
 * Lives only for the duration of one `start()` call — no need for a
 * separate Layer.
 */
class CodexRpc {
	private nextId = 1;
	private readonly pending = new Map<
		number | string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private stdoutBuf = "";
	private closed = false;
	private closedReason: Error | null = null;

	constructor(
		private readonly stdin: Writable,
		stdout: Readable,
		private readonly onNotification: (n: RpcNotification) => void,
	) {
		stdout.setEncoding("utf8");
		stdout.on("data", (chunk: string) => this.onStdoutChunk(chunk));
		stdout.on("end", () => this.shutdown(new Error("codex stdout closed")));
		stdout.on("error", (err) => this.shutdown(err));
	}

	private onStdoutChunk(chunk: string) {
		this.stdoutBuf += chunk;
		// NDJSON: split on \n; everything before the last \n is complete.
		let nl = this.stdoutBuf.indexOf("\n");
		while (nl >= 0) {
			const line = this.stdoutBuf.slice(0, nl).trim();
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (line.length > 0) this.handleLine(line);
			nl = this.stdoutBuf.indexOf("\n");
		}
	}

	private handleLine(line: string) {
		let parsed: RpcIncoming;
		try {
			parsed = JSON.parse(line) as RpcIncoming;
		} catch {
			// Codex shouldn't emit garbage on stdout, but if it does, log
			// and keep going rather than tearing the whole turn down.
			console.error(`[codex] non-JSON stdout line: ${line.slice(0, 200)}`);
			return;
		}
		if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
			const pending = this.pending.get(parsed.id);
			if (!pending) return;
			this.pending.delete(parsed.id);
			if ("error" in parsed) {
				pending.reject(
					new Error(
						`codex JSON-RPC error: ${parsed.error.message}${
							parsed.error.code != null ? ` (code ${parsed.error.code})` : ""
						}`,
					),
				);
			} else {
				pending.resolve(parsed.result);
			}
			return;
		}
		if ("method" in parsed) {
			this.onNotification(parsed);
			return;
		}
		// Unknown shape — ignore.
	}

	request<R>(method: string, params: unknown): Promise<R> {
		if (this.closed) {
			return Promise.reject(
				this.closedReason ?? new Error("codex RPC channel closed"),
			);
		}
		const id = this.nextId++;
		const payload = `${JSON.stringify({ jsonrpc: "2.0", method, id, params })}\n`;
		return new Promise<R>((resolve, reject) => {
			this.pending.set(id, {
				resolve: resolve as (v: unknown) => void,
				reject,
			});
			this.stdin.write(payload, (err) => {
				if (err) {
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	notify(method: string, params?: unknown): void {
		if (this.closed) return;
		const payload = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
		this.stdin.write(payload, () => {});
	}

	shutdown(reason: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.closedReason = reason;
		for (const pending of this.pending.values()) pending.reject(reason);
		this.pending.clear();
	}
}

// ---------------------------------------------------------- real spawn ---

function startReal(params: {
	readonly workspacePath: string;
	readonly command: string;
	readonly prompt: string;
	readonly timeoutMs?: number;
	readonly approvalPolicy?: TurnStartApproval;
}): Effect.Effect<void, OrchestratorError> {
	return Effect.callback<void, OrchestratorError>((resume, signal) => {
		const { bin, args } = parseCommand(params.command);

		let child: ChildProcessByStdio<Writable, Readable, null>;
		try {
			child = spawn(bin, args, {
				cwd: params.workspacePath,
				stdio: ["pipe", "pipe", "inherit"],
			}) as ChildProcessByStdio<Writable, Readable, null>;
		} catch (err) {
			resume(
				Effect.fail(
					fail(
						`Failed to spawn ${bin}: ${err instanceof Error ? err.message : String(err)}`,
					),
				),
			);
			return;
		}

		let settled = false;
		let ourTurnId: string | null = null;

		const settle = (effect: Effect.Effect<void, OrchestratorError>) => {
			if (settled) return;
			settled = true;
			cleanup();
			resume(effect);
		};

		// Kill chain: SIGTERM → 5s → SIGKILL.
		let killEscalate: NodeJS.Timeout | null = null;
		const killChild = (sig: NodeJS.Signals) => {
			try {
				child.kill(sig);
			} catch {
				/* already gone */
			}
		};
		const beginKill = () => {
			killChild("SIGTERM");
			killEscalate = setTimeout(() => killChild("SIGKILL"), 5_000);
		};

		// Overall turn-level timeout. The kill chain runs on timeout
		// regardless of where in the protocol we are.
		const timeoutTimer = params.timeoutMs
			? setTimeout(() => {
					settle(
						Effect.fail(
							fail(`codex turn timed out after ${params.timeoutMs}ms`),
						),
					);
				}, params.timeoutMs)
			: null;

		const cleanup = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killEscalate) clearTimeout(killEscalate);
			beginKill();
		};

		// Fiber interrupt (SIGINT during daemon shutdown) — propagate to
		// the child. Same kill chain.
		signal.addEventListener("abort", () => {
			settle(Effect.fail(fail("codex turn interrupted")));
		});

		child.on("error", (err) => {
			settle(Effect.fail(fail(`codex process error: ${err.message}`)));
		});
		child.on("exit", (code, sig) => {
			if (settled) return;
			settle(
				Effect.fail(
					fail(
						`codex exited unexpectedly before turn completed (code=${code ?? "?"}, signal=${sig ?? "?"})`,
					),
				),
			);
		});

		// All async protocol work happens through this Promise chain. The
		// resolution of `chain` is what flips us to "turn complete" or
		// "turn failed".
		const rpc = new CodexRpc(child.stdin, child.stdout, (n) =>
			handleNotification(n),
		);

		function handleNotification(n: RpcNotification) {
			switch (n.method) {
				case "item/agentMessage/delta": {
					// Stream codex's assistant message to the parent stderr so
					// users see progress as the turn runs. Inherit-style logging.
					const p = n.params as AgentMessageDeltaNotification;
					if (ourTurnId && p.turnId === ourTurnId && p.delta) {
						process.stderr.write(p.delta);
					}
					return;
				}
				case "turn/completed": {
					const p = n.params as TurnCompletedNotification;
					if (!ourTurnId || p.turn.id !== ourTurnId) return;
					if (p.turn.status === "completed") {
						// Newline after the streamed deltas so the next CLI line
						// starts cleanly.
						process.stderr.write("\n");
						settle(Effect.void);
					} else if (p.turn.status === "failed") {
						const msg = p.turn.error?.message ?? "unknown reason";
						settle(Effect.fail(fail(`codex turn failed: ${msg}`)));
					} else if (p.turn.status === "interrupted") {
						settle(Effect.fail(fail("codex turn was interrupted")));
					}
					return;
				}
				case "error": {
					// Per-turn error notification. codex may still emit
					// `turn/completed` after this; let that drive the outcome
					// unless it never comes (we'll time out). Log and continue.
					const p = n.params as {
						error?: { message?: string };
					};
					console.error(
						`[codex error notification] ${p.error?.message ?? "(no message)"}`,
					);
					return;
				}
				default:
					// Other notifications (item/started, turn/started, etc.) —
					// not load-bearing for our use case.
					return;
			}
		}

		void (async () => {
			try {
				await rpc.request<unknown>("initialize", {
					clientInfo: {
						name: "kangent-orchestrator",
						title: null,
						version: "0.1.0",
					},
					capabilities: null,
				} satisfies InitializeParams);
				rpc.notify("initialized");

				const threadRes = await rpc.request<ThreadStartResponse>(
					"thread/start",
					{
						cwd: params.workspacePath,
						approvalPolicy: params.approvalPolicy ?? "never",
						experimentalRawEvents: false,
						persistExtendedHistory: false,
					} satisfies ThreadStartParams,
				);

				const turnRes = await rpc.request<TurnStartResponse>("turn/start", {
					threadId: threadRes.thread.id,
					input: [
						{ type: "text", text: params.prompt, text_elements: [] },
					],
				} satisfies TurnStartParams);

				ourTurnId = turnRes.turn.id;
				// From here, completion arrives via the `turn/completed`
				// notification handler.
			} catch (err) {
				settle(
					Effect.fail(
						fail(
							err instanceof Error
								? err.message
								: `codex protocol error: ${String(err)}`,
						),
					),
				);
			}
		})();
	});
}

// ------------------------------------------------------ exported layers ---

export const CodexProcessLayer = Layer.succeed(CodexProcess, {
	start: startReal,
});

/**
 * Synthetic successful turn — sleeps `simulateMs` then resolves.
 * Used by `kangent run --fake-codex` and by AgentRunner tests that
 * don't want to spawn a real codex.
 */
export const CodexProcessFakeLayer = (simulateMs = 0) =>
	Layer.succeed(CodexProcess, {
		start: () =>
			simulateMs > 0
				? Effect.sleep(`${simulateMs} millis`).pipe(Effect.asVoid)
				: Effect.void,
	});

/**
 * Always-fail synthetic codex. Used to exercise AgentRunner's
 * "move card back to Todo on failure" path without spawning anything.
 */
export const CodexProcessFailingLayer = (reason = "synthetic codex failure") =>
	Layer.succeed(CodexProcess, {
		start: () => Effect.fail(new OrchestratorError({ message: reason })),
	});
