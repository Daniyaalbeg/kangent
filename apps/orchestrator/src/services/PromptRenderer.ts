/**
 * Minimal `{{ path.to.value }}` substitution for WORKFLOW.md prompt bodies.
 *
 * Symphony §6.4 leaves the templating language open; this is the Mustache-
 * compatible subset that covers every example in the spec:
 *
 *     {{ issue.identifier }}
 *     {{ issue.title }}
 *     {{ issue.state }}
 *     {{ issue.url }}
 *     {{ issue.branch_name }}
 *
 * Unknown paths render as the empty string (Mustache parity) — the
 * orchestrator never errors on a typo'd template; the worst case is a
 * blank in the prompt, which the agent can ask for.
 *
 * Not supported here (revisit when needed):
 *   - `{{#section}}…{{/section}}` blocks
 *   - `{{> partial}}`
 *   - escaping (`{{{ raw }}}`) — codex receives the prompt verbatim, no
 *     HTML escaping concerns.
 */

import type { Issue } from "../domain/Issue.js";

type Scope = { readonly issue: Issue };

export function renderPrompt(template: string, scope: Scope): string {
	return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
		const parts = key.split(".");
		let value: unknown = scope;
		for (const part of parts) {
			if (
				value !== null &&
				typeof value === "object" &&
				part in (value as Record<string, unknown>)
			) {
				value = (value as Record<string, unknown>)[part];
			} else {
				return "";
			}
		}
		if (value == null) return "";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}
		// Fall back to JSON for arrays / nested objects. Mustache itself
		// would render `[object Object]`; JSON gives users something
		// debuggable when they accidentally interpolate a non-leaf.
		try {
			return JSON.stringify(value);
		} catch {
			return "";
		}
	});
}
