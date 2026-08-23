import type { Board, Card } from "@kangent/board-core";
import { describe, expect, it } from "vitest";
import { makeMapCardContext, mapCardToIssue } from "../domain/Issue.js";

const BOARD_ID = "b1";

function makeBoard(overrides: Partial<Board> = {}): Board {
	return {
		id: BOARD_ID,
		title: "Test board",
		columns: [
			{ id: "col-todo", title: "Todo", position: 0, cardIds: [] },
			{ id: "col-wip", title: "In Progress", position: 1, cardIds: [] },
			{ id: "col-done", title: "Done", position: 2, cardIds: [] },
		],
		nextCardSeq: 10,
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
		createdBy: "human:vivy" as Board["createdBy"],
		version: 1,
		...overrides,
	} as Board;
}

function makeCard(overrides: Partial<Card> = {}): Card {
	return {
		id: "c1",
		identifier: `${BOARD_ID}-1`,
		columnId: "col-todo",
		title: "A card",
		description: null,
		position: 0,
		createdBy: "human:vivy" as Card["createdBy"],
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
		...overrides,
	} as Card;
}

describe("mapCardToIssue", () => {
	it("maps a basic card to a Symphony Issue", () => {
		const board = makeBoard();
		const card = makeCard();
		const ctx = makeMapCardContext("https://kangent.example", board, [card]);
		const issue = mapCardToIssue(ctx, card);
		expect(issue).toMatchObject({
			id: "c1",
			identifier: "b1-1",
			title: "A card",
			state: "Todo",
			labels: [],
			blocked_by: [],
			priority: null,
		});
		expect(issue.url).toBe("https://kangent.example/b/b1?card=c1");
		expect(issue.branch_name).toBe("kangent/b1-1");
	});

	it("lower-cases labels (so label_filter matching is case-insensitive)", () => {
		const board = makeBoard();
		const card = makeCard({ labels: ["AGENT-READY", "Backend", "search"] });
		const ctx = makeMapCardContext("https://k", board, [card]);
		expect(mapCardToIssue(ctx, card).labels).toEqual([
			"agent-ready",
			"backend",
			"search",
		]);
	});

	it("maps Kangent priority strings to Symphony numeric priorities", () => {
		const board = makeBoard();
		const ctx = (cards: readonly Card[]) =>
			makeMapCardContext("https://k", board, cards);
		const urgent = makeCard({ id: "u", priority: "urgent" });
		const high = makeCard({ id: "h", priority: "high" });
		const medium = makeCard({ id: "m", priority: "medium" });
		const low = makeCard({ id: "l", priority: "low" });
		const none = makeCard({ id: "n" });
		expect(mapCardToIssue(ctx([urgent]), urgent).priority).toBe(1);
		expect(mapCardToIssue(ctx([high]), high).priority).toBe(2);
		expect(mapCardToIssue(ctx([medium]), medium).priority).toBe(3);
		expect(mapCardToIssue(ctx([low]), low).priority).toBe(4);
		expect(mapCardToIssue(ctx([none]), none).priority).toBeNull();
	});

	it("resolves blockedBy identifiers to {id, identifier, state}", () => {
		const board = makeBoard();
		const blocker = makeCard({
			id: "blocker-1",
			identifier: "b1-7",
			columnId: "col-done",
		});
		const card = makeCard({ id: "c2", identifier: "b1-2", blockedBy: ["b1-7"] });
		const ctx = makeMapCardContext("https://k", board, [card, blocker]);
		const issue = mapCardToIssue(ctx, card);
		expect(issue.blocked_by).toEqual([
			{ id: "blocker-1", identifier: "b1-7", state: "Done" },
		]);
	});

	it("emits {id: null, state: null} for blockers whose identifier doesn't resolve", () => {
		const board = makeBoard();
		const card = makeCard({ blockedBy: ["b1-999-typo"] });
		const ctx = makeMapCardContext("https://k", board, [card]);
		expect(mapCardToIssue(ctx, card).blocked_by).toEqual([
			{ id: null, identifier: "b1-999-typo", state: null },
		]);
	});

	it("synthesises an identifier for cards that haven't been migrated yet", () => {
		const board = makeBoard();
		// Pre-migration card: no `identifier` field.
		const card = makeCard({ id: "legacy-abc", identifier: undefined });
		const ctx = makeMapCardContext("https://k", board, [card]);
		expect(mapCardToIssue(ctx, card).identifier).toBe("b1-clegacy-abc");
	});

	it("returns state=\"unknown\" when columnId points at a deleted column", () => {
		const board = makeBoard();
		const orphan = makeCard({ columnId: "ghost-column" });
		const ctx = makeMapCardContext("https://k", board, [orphan]);
		expect(mapCardToIssue(ctx, orphan).state).toBe("unknown");
	});

	it("strips trailing slashes from the endpoint when building the URL", () => {
		const board = makeBoard();
		const card = makeCard();
		const ctx = makeMapCardContext("https://kangent.example/", board, [card]);
		expect(mapCardToIssue(ctx, card).url).toBe(
			"https://kangent.example/b/b1?card=c1",
		);
	});

	it("flattens string descriptions, JSON-encodes ProseMirror docs", () => {
		const board = makeBoard();
		const stringCard = makeCard({ description: "hello world" });
		const proseMirrorCard = makeCard({
			id: "pm",
			description: { type: "doc", content: [] },
		});
		const ctx = makeMapCardContext("https://k", board, [stringCard, proseMirrorCard]);
		expect(mapCardToIssue(ctx, stringCard).description).toBe("hello world");
		expect(mapCardToIssue(ctx, proseMirrorCard).description).toBe(
			'{"type":"doc","content":[]}',
		);
	});
});
