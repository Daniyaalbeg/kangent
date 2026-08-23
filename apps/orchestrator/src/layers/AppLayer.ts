/**
 * Layer composition for the CLI runtime.
 *
 * The split here is load-bearing: services that need a loaded
 * `WorkflowConfig` to construct (currently just `TrackerKangentLayer`)
 * must be provided AFTER `WorkflowConfigOf(loaded)`. Otherwise their
 * `WorkflowConfig` requirement leaks all the way out to `main.ts`,
 * where there's no workflow loaded yet.
 *
 * Two layers:
 *   - `AppLayer`              — provided once at `main.ts`. Stateless;
 *                               no WorkflowConfig dependency.
 *   - `WorkflowDependentLayer` — provided per-command after a successful
 *                               `WorkflowLoader.load(...)`.
 *
 * Platform layers (`NodeServices.layer`, `NodeHttpClient.layerUndici`)
 * also live at `main.ts`.
 */

import { Layer } from "effect";
import { LoggerLayer } from "../runtime/Logger.js";
import { AgentRunnerLayer } from "../services/AgentRunner.js";
import { CodexProcessLayer } from "../services/CodexProcess.js";
import { DispatcherLayer } from "../services/Dispatcher.js";
import { OrchestratorLayer } from "../services/Orchestrator.js";
import { TrackerKangentLayer } from "../services/TrackerKangent.js";
import { WorkflowLoaderLayer } from "../services/WorkflowLoader.js";
import { WorkspaceManagerLayer } from "../services/WorkspaceManager.js";

export const AppLayer = Layer.mergeAll(
	LoggerLayer,
	WorkflowLoaderLayer,
	AgentRunnerLayer,
	CodexProcessLayer,
	DispatcherLayer,
	OrchestratorLayer,
	WorkspaceManagerLayer,
);

export const WorkflowDependentLayer = TrackerKangentLayer;
