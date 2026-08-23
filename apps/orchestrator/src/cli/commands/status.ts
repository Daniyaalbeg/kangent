/**
 * `kangent status` — peek at a running daemon's runtime state. Stub for
 * the MVP: there's no daemon yet, so the command just reports that.
 *
 * Real impl will hit the optional HTTP server (Symphony §13.7
 * `/api/v1/state`) on a known local port, falling back to a "no daemon
 * running" message when nothing answers.
 */

import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";

export const status = Command.make("status", {}, () =>
	Effect.gen(function* () {
		yield* Console.log(
			"No local daemon HTTP server yet — `kangent run` is single-shot in this build.",
		);
		yield* Console.log(
			"The next phase wires the optional dashboard (Symphony §13.7) and this command starts talking to it.",
		);
	}),
);
