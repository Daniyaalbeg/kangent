import { Schema } from "effect";

/**
 * Workflow loader / parser failure. Covers missing file, malformed YAML
 * front matter, and front matter that decodes but fails Schema validation.
 *
 * Symphony spec §5.5 distinguishes `missing_workflow_file`,
 * `workflow_parse_error`, and `workflow_front_matter_not_a_map`. We collapse
 * them into one error class with a `kind` discriminator so callers can
 * pattern-match without three separate `_tag`s.
 */
export class WorkflowError extends Schema.TaggedErrorClass<WorkflowError>()(
	"WorkflowError",
	{
		kind: Schema.Literals([
			"missing_file",
			"parse_error",
			"front_matter_not_a_map",
			"validation_error",
		]),
		path: Schema.String,
		message: Schema.String,
	},
) {}

/**
 * Tracker adapter failure. Mirrors Symphony §11.4 error categories.
 * Implementations populate `code` with the most specific category that
 * applies; the orchestrator uses it to decide whether to retry, skip the
 * tick, or fail the run attempt.
 */
export class TrackerError extends Schema.TaggedErrorClass<TrackerError>()(
	"TrackerError",
	{
		code: Schema.Literals([
			"unsupported_tracker_kind",
			"missing_tracker_endpoint",
			"missing_tracker_board_id",
			"transport",
			"non_200_status",
			"malformed_payload",
			"unknown",
		]),
		message: Schema.String,
	},
) {}

/**
 * Workspace / hook failures. Symphony §6.5 defines hooks as opt-in user
 * code run before/after the orchestrator interacts with codex; failures
 * are typed separately from `OrchestratorError` so AgentRunner can tell
 * "your hook script blew up" apart from "we couldn't talk to codex".
 *
 * `kind` discriminator:
 *   - `io_error`     — filesystem / mkdir / rm failed.
 *   - `hook_failed`  — hook process exited non-zero or errored out.
 *   - `hook_timeout` — hook ran longer than `hooks.timeout_ms`.
 *   - `hook_signal`  — hook killed by a signal (e.g. SIGINT during shutdown).
 */
export class WorkspaceError extends Schema.TaggedErrorClass<WorkspaceError>()(
	"WorkspaceError",
	{
		kind: Schema.Literals([
			"io_error",
			"hook_failed",
			"hook_timeout",
			"hook_signal",
		]),
		message: Schema.String,
		/** Which lifecycle hook failed, if applicable. */
		hook: Schema.optional(
			Schema.Literals([
				"after_create",
				"before_run",
				"after_run",
				"before_remove",
			]),
		),
		/** Exit code if the hook process exited non-zero. */
		exitCode: Schema.optional(Schema.Number),
	},
) {}

/**
 * Wraps any other lower-level failure that bubbles up from a service. Use
 * sparingly — prefer adding a new tagged error to this file when a
 * recurring failure mode emerges.
 */
export class OrchestratorError extends Schema.TaggedErrorClass<OrchestratorError>()(
	"OrchestratorError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}
