/**
 * `kangent workflow validate [path]` — load a WORKFLOW.md, validate it,
 * and print the resolved config so authors can sanity-check their
 * defaults and `$VAR` resolutions.
 */

import { Console, Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { WorkflowLoader } from "../../services/WorkflowLoader.js";

const workflowPath = Argument.path("workflow", {
	pathType: "file",
	mustExist: true,
}).pipe(
	Argument.withDefault("./WORKFLOW.md"),
	Argument.withDescription("Path to the WORKFLOW.md to validate"),
);

const validate = Command.make(
	"validate",
	{ workflowPath },
	({ workflowPath }) =>
		Effect.gen(function* () {
			const loader = yield* WorkflowLoader;
			const loaded = yield* loader.load(workflowPath);
			yield* Console.log(`✓ ${loaded.path}`);
			yield* Console.log("");
			yield* Console.log("=== Resolved config ===");
			yield* Console.log(JSON.stringify(loaded.config, null, 2));
			yield* Console.log("");
			yield* Console.log("=== Prompt template (first 200 chars) ===");
			yield* Console.log(
				loaded.promptTemplate.length > 200
					? `${loaded.promptTemplate.slice(0, 200)}…`
					: loaded.promptTemplate,
			);
		}),
);

export const workflow = Command.make("workflow").pipe(
	Command.withSubcommands([validate]),
);
