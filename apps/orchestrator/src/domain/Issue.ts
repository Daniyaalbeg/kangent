/**
 * Symphony-spec normalized issue (§4.1.1). The Tracker layer maps from
 * tracker-native types (Kangent Card today, Linear Issue tomorrow) to this
 * shape so the orchestrator can stay agnostic.
 */

import type { Board, Card, CardPriority, Column } from "@kangent/board-core";

/**
 * Priority mapping. Symphony §8.2 sorts ascending so 1 is highest. Kangent
 * uses string enums; we map them here. `undefined` sorts last.
 */
const PRIORITY_NUMBER: Record<CardPriority, number> = {
	urgent: 1,
	high: 2,
	medium: 3,
	low: 4,
};

export interface IssueBlocker {
	readonly id: string | null;
	readonly identifier: string | null;
	readonly state: string | null;
}

export interface Issue {
	readonly id: string;
	readonly identifier: string;
	readonly title: string;
	readonly description: string | null;
	readonly priority: number | null;
	readonly state: string;
	readonly branch_name: string | null;
	readonly url: string | null;
	readonly labels: readonly string[];
	readonly blocked_by: readonly IssueBlocker[];
	readonly created_at: string | null;
	readonly updated_at: string | null;
}

/**
 * Best-effort flatten of a Kangent description (which is `Schema.Unknown`
 * to allow ProseMirror docs) to a plain string. Keeps the prompt template
 * simple — ProseMirror→markdown is a v2 problem.
 */
function flattenDescription(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value;
	// ProseMirror docs are `{ type: "doc", content: [...] }`. We don't
	// attempt a real conversion here; agents should be tolerant of the
	// JSON form, and the workflow author can switch the prompt template
	// to skip description for now.
	try {
		return JSON.stringify(value);
	} catch {
		return null;
	}
}

/**
 * Resolve a card's `blockedBy` identifiers against the current board so
 * each blocker carries its current `state` (column title). Symphony's
 * Todo blocker rule (§8.2) needs the state to decide eligibility.
 */
function resolveBlockers(
	card: Card,
	cardsByIdentifier: ReadonlyMap<string, Card>,
	columnsById: ReadonlyMap<string, Column>,
): readonly IssueBlocker[] {
	const ids = card.blockedBy ?? [];
	return ids.map((identifier): IssueBlocker => {
		const blocker = cardsByIdentifier.get(identifier);
		if (!blocker) {
			return { id: null, identifier, state: null };
		}
		const column = columnsById.get(blocker.columnId);
		return {
			id: blocker.id,
			identifier,
			state: column?.title ?? null,
		};
	});
}

export interface MapCardContext {
	readonly board: Board;
	readonly endpoint: string;
	readonly cardsByIdentifier: ReadonlyMap<string, Card>;
	readonly columnsById: ReadonlyMap<string, Column>;
}

/**
 * Build the lookup maps once per poll, then pass to `mapCardToIssue` for
 * every card. O(n) instead of O(n²) — without this, the obvious
 * `cards.map((c) => mapCardToIssue(ctx, c))` call site rebuilds both maps
 * on every iteration. On a 500-card board polled every 30s, that's
 * ~250k map-insert operations per tick before this fix.
 */
export function makeMapCardContext(
	endpoint: string,
	board: Board,
	cards: readonly Card[],
): MapCardContext {
	const cardsByIdentifier = new Map<string, Card>();
	for (const c of cards) {
		if (c.identifier) cardsByIdentifier.set(c.identifier, c);
	}
	const columnsById = new Map<string, Column>();
	for (const col of board.columns) {
		columnsById.set(col.id, col);
	}
	return { board, endpoint, cardsByIdentifier, columnsById };
}

export function mapCardToIssue(ctx: MapCardContext, card: Card): Issue {
	const column = ctx.columnsById.get(card.columnId);
	const identifier = card.identifier ?? `${ctx.board.id}-c${card.id}`;
	const labels = (card.labels ?? []).map((l) => l.toLowerCase());

	return {
		id: card.id,
		identifier,
		title: card.title,
		description: flattenDescription(card.description),
		priority: card.priority ? (PRIORITY_NUMBER[card.priority] ?? null) : null,
		state: column?.title ?? "unknown",
		// Symphony §4.1.1: `branch_name` is tracker-supplied metadata. Kangent
		// doesn't track branches, so we synthesise one. Workflow authors can
		// override in the prompt template if they want a different shape.
		branch_name: `kangent/${identifier}`,
		url: `${ctx.endpoint.replace(/\/$/, "")}/b/${ctx.board.id}?card=${card.id}`,
		labels,
		blocked_by: resolveBlockers(card, ctx.cardsByIdentifier, ctx.columnsById),
		created_at: card.createdAt,
		updated_at: card.updatedAt,
	};
}
