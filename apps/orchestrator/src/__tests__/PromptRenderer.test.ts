import { describe, expect, it } from "vitest";
import type { Issue } from "../domain/Issue.js";
import { renderPrompt } from "../services/PromptRenderer.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
	return {
		id: "c1",
		identifier: "b1-7",
		title: "Implement search",
		description: "Use Postgres full-text",
		priority: 2,
		state: "Todo",
		branch_name: "kangent/b1-7",
		url: "https://k/b/b1?card=c1",
		labels: ["backend", "search"],
		blocked_by: [],
		created_at: "2026-05-01T00:00:00.000Z",
		updated_at: "2026-05-01T00:00:00.000Z",
		...overrides,
	};
}

describe("renderPrompt", () => {
	it("substitutes top-level fields with the issue's value", () => {
		const out = renderPrompt(
			"Work on {{ issue.identifier }} — {{ issue.title }}.",
			{ issue: makeIssue() },
		);
		expect(out).toBe("Work on b1-7 — Implement search.");
	});

	it("renders empty string for unresolved paths (Mustache parity)", () => {
		const out = renderPrompt(
			"Hello {{ issue.nonexistent }}, world.",
			{ issue: makeIssue() },
		);
		expect(out).toBe("Hello , world.");
	});

	it("renders empty string when value is null/undefined", () => {
		const out = renderPrompt("URL: {{ issue.description }}", {
			issue: makeIssue({ description: null }),
		});
		expect(out).toBe("URL: ");
	});

	it("coerces numbers and booleans via String()", () => {
		const out = renderPrompt(
			"Priority: {{ issue.priority }}",
			{ issue: makeIssue({ priority: 1 }) },
		);
		expect(out).toBe("Priority: 1");
	});

	it("JSON-encodes nested structures so accidental object interpolation is debuggable", () => {
		const out = renderPrompt("Labels: {{ issue.labels }}", {
			issue: makeIssue({ labels: ["a", "b"] }),
		});
		expect(out).toBe('Labels: ["a","b"]');
	});

	it("tolerates whitespace inside the braces", () => {
		const out = renderPrompt(
			"[{{   issue.identifier   }}]",
			{ issue: makeIssue() },
		);
		expect(out).toBe("[b1-7]");
	});

	it("leaves non-matching curly braces alone", () => {
		const out = renderPrompt(
			"const x = { y: 1 }; do {{ issue.identifier }}",
			{ issue: makeIssue() },
		);
		expect(out).toBe("const x = { y: 1 }; do b1-7");
	});

	it("renders the same placeholder repeatedly", () => {
		const out = renderPrompt(
			"{{ issue.identifier }} — {{ issue.identifier }} again",
			{ issue: makeIssue() },
		);
		expect(out).toBe("b1-7 — b1-7 again");
	});
});
