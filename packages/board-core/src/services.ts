import { Context, type Effect } from "effect";
import type { BoardNotFound, CardNotFound, ColumnNotEmpty, ColumnNotFound } from "./errors.js";
import type { Board, Card, CardPriority, Column } from "./schemas/board.js";
import type { Change, ChangeOp } from "./schemas/changes.js";

export interface CreateBoardParams {
	readonly title: string;
	readonly description?: string;
	readonly columns?: readonly string[];
	readonly by: string;
}

export interface BoardUpdates {
	readonly title?: string;
	// `null` clears the description; omit to leave unchanged.
	readonly description?: string | null;
}

export interface AddCardParams {
	readonly columnId: string;
	readonly title: string;
	readonly description?: unknown;
	readonly priority?: CardPriority;
	readonly dueDate?: string;
	readonly by: string;
}

export interface CardUpdates {
	readonly title?: string;
	readonly description?: unknown;
	// `null` clears the field; omitting leaves it unchanged.
	readonly priority?: CardPriority | null;
	readonly dueDate?: string | null;
}

export interface AppendChangeParams {
	readonly version: number;
	readonly op: ChangeOp;
	readonly cardId?: string;
	readonly columnId?: string;
	readonly fromColumnId?: string;
	readonly columnIds?: readonly string[];
	// Board for `board:update`, Card for card ops, Column for column add/update,
	// `null` for deletes and reorders (which encode their delta in `cardId` /
	// `columnId` / `columnIds` instead).
	readonly snapshot: Board | Card | Column | null;
	readonly by: string;
}

export interface ChangeFeedRead {
	readonly fromVersion: number;
	readonly toVersion: number;
	readonly isFirstSync: boolean;
	readonly changes: readonly Change[];
}

export class BoardStorage extends Context.Tag("BoardStorage")<
	BoardStorage,
	{
		readonly getBoard: () => Effect.Effect<Board, BoardNotFound>;
		readonly createBoard: (params: CreateBoardParams) => Effect.Effect<Board>;
		readonly updateBoardMeta: (meta: {
			title?: string;
			description?: string;
		}) => Effect.Effect<Board, BoardNotFound>;
		readonly getCard: (cardId: string) => Effect.Effect<Card, CardNotFound>;
		readonly getCards: () => Effect.Effect<readonly Card[]>;
		readonly addCard: (params: AddCardParams) => Effect.Effect<Card, ColumnNotFound>;
		readonly updateCard: (
			cardId: string,
			updates: CardUpdates,
		) => Effect.Effect<Card, CardNotFound>;
		readonly moveCard: (
			cardId: string,
			toColumnId: string,
			position: number,
		) => Effect.Effect<Card, CardNotFound | ColumnNotFound>;
		readonly deleteCard: (cardId: string) => Effect.Effect<void, CardNotFound>;
		readonly addColumn: (title: string) => Effect.Effect<Column>;
		readonly updateColumn: (
			columnId: string,
			title: string,
		) => Effect.Effect<Column, ColumnNotFound>;
		readonly deleteColumn: (
			columnId: string,
			moveCardsTo?: string,
		) => Effect.Effect<{ cardsMoved: number }, ColumnNotFound | ColumnNotEmpty>;
		readonly reorderColumns: (columnIds: readonly string[]) => Effect.Effect<void>;
		readonly incrementVersion: () => Effect.Effect<number>;
		// --- Change feed ---
		// Append a changelog entry. Called after each mutation.
		readonly appendChange: (params: AppendChangeParams) => Effect.Effect<void>;
		// Read changes strictly greater than `afterVersion`, up to `limit`.
		// Also reports whether the agent's `afterVersion` fell below retention
		// (isFirstSync => caller should return full board instead).
		readonly readChanges: (afterVersion: number, limit: number) => Effect.Effect<ChangeFeedRead>;
		// Server-tracked per-agent cursor. Undefined on first visit.
		readonly getAgentCursor: (agentId: string) => Effect.Effect<number | undefined>;
		readonly setAgentCursor: (agentId: string, version: number) => Effect.Effect<void>;
	}
>() {}

export class Broadcaster extends Context.Tag("Broadcaster")<
	Broadcaster,
	{
		readonly broadcast: (message: unknown, exclude?: WebSocket) => Effect.Effect<void>;
		readonly broadcastPresence: () => Effect.Effect<void>;
		readonly getConnectionCount: () => Effect.Effect<number>;
	}
>() {}
