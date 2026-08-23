#!/usr/bin/env node
/**
 * Top-level `kangent` CLI entry. Wires `effect/unstable/cli`'s
 * `Command.run` to our subcommands and provides the platform layers.
 *
 * In v4, `Command.run(root, { version })` returns an `Effect<void, ...>`
 * directly — argv is read from the runtime's `Stdio` service (provided
 * by `NodeServices.layer`). No explicit `cli(process.argv)` call.
 *
 * Layer composition order:
 *   - AppLayer        — orchestrator services + structured logger
 *   - NodeHttpClient  — HTTP transport for the typed Kangent client
 *   - NodeServices    — FileSystem, Path, Stdio, Terminal, Spawner
 *   - NodeRuntime.runMain — installs SIGINT/SIGTERM + clean exit codes
 */

import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import {
	NodeHttpClient,
	NodeRuntime,
	NodeServices,
} from "@effect/platform-node";
import { AppLayer } from "../layers/AppLayer.js";
import { doctor } from "./commands/doctor.js";
import { run } from "./commands/run.js";
import { status } from "./commands/status.js";
import { workflow } from "./commands/workflow.js";

const root = Command.make("kangent").pipe(
	Command.withSubcommands([run, doctor, workflow, status]),
);

Command.run(root, { version: "0.1.0" }).pipe(
	Effect.provide(AppLayer),
	Effect.provide(NodeHttpClient.layerUndici),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
