/**
 * Structured logger that writes JSON to stderr, leaving stdout clean for
 * any machine-readable output (`--json` modes, future API responses).
 *
 * Built on v4's `Logger.formatJson` (which is itself a `Logger<unknown,
 * string>`) piped through `Logger.withConsoleError` so output goes to
 * `console.error` (stderr) instead of `console.log`. `Logger.layer` then
 * returns a `Layer` that registers it on top of the runtime's
 * `CurrentLoggers` reference.
 *
 * Symphony §13.1's `issue_id` / `issue_identifier` / `session_id` context
 * is provided by callers via `Effect.annotateLogs({...})` — `formatJson`
 * picks them up automatically from the fiber context.
 */

import { Logger } from "effect";

const stderrJsonLogger = Logger.formatJson.pipe(Logger.withConsoleError);

export const LoggerLayer = Logger.layer([stderrJsonLogger]);
