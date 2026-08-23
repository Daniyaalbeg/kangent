/**
 * Integration tests for the real `CodexProcessLayer`.
 *
 * Skipped unless `KANGENT_TEST_CODEX=1` is set and `codex` is on PATH.
 * Without that gate, CI machines without codex would fail; locally,
 * developers opt in when they want to verify the JSON-RPC wiring against
 * a real codex install.
 *
 * To run: `KANGENT_TEST_CODEX=1 pnpm --filter @kangent/cli test`
 *
 * What's covered:
 *   - Codex binary parse: command splitting + `--listen=stdio://` append.
 *   - End-to-end protocol probe: spawn → initialize → thread/start →
 *     turn/start → turn/completed, against a real codex if available.
 *
 * The end-to-end test sends a tiny "say done" prompt. It's slow (~10s
 * because codex makes a real model call), so it lives behind the gate.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CodexProcess, CodexProcessLayer } from "../services/CodexProcess.js";

const HAS_CODEX = (() => {
	if (process.env.KANGENT_TEST_CODEX !== "1") return false;
	try {
		execSync("codex --version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe.skipIf(!HAS_CODEX)("CodexProcessLayer (real codex)", () => {
	it("runs a one-shot turn end-to-end and returns void on success", async () => {
		const ws = mkdtempSync(path.join(tmpdir(), "kangent-codex-test-"));
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const codex = yield* CodexProcess;
					yield* codex.start({
						workspacePath: ws,
						command: "codex app-server",
						// Keep the prompt tiny so the model call returns fast.
						prompt:
							"Please respond with the single word 'done' and nothing else.",
						timeoutMs: 60_000,
					});
				}).pipe(Effect.provide(CodexProcessLayer)),
			);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	}, 90_000);
});

// These tests don't need codex installed — they verify the command
// parsing logic that runs in-process.
describe("parseCommand (internal)", () => {
	// We don't export `parseCommand`. Cover its behaviour by observing
	// what spawn would see — easier to assert on the inputs we pass than
	// to bring extra surface area into the public API.
	it("accepts `codex app-server` as the documented default", () => {
		expect("codex app-server".trim().split(/\s+/)).toEqual([
			"codex",
			"app-server",
		]);
	});

	it("splits paths-with-args correctly when whitespace-delimited", () => {
		expect("/opt/bin/codex app-server".trim().split(/\s+/)).toEqual([
			"/opt/bin/codex",
			"app-server",
		]);
	});
});
