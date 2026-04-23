import { Schema } from "effect"
import { ActorId, Board, Card, Column } from "./board.js"

// Full board snapshot (board + cards), returned only on first-sync responses
// so agents can seed their cache without a second /state call.
export class BoardSnapshot extends Schema.Class<BoardSnapshot>("BoardSnapshot")({
	board: Board,
	cards: Schema.Array(Card),
}) {}

// Kinds of mutation that produce a change entry. The string literals double
// as the "what happened" signal for agents consuming the feed.
export const ChangeOp = Schema.Literal(
	"card:add",
	"card:update",
	"card:move",
	"card:delete",
	"column:add",
	"column:update",
	"column:delete",
)
export type ChangeOp = typeof ChangeOp.Type

// Post-op snapshot of the affected entity. Null for deletes.
export const ChangeSnapshot = Schema.NullOr(Schema.Union(Card, Column))

export class Change extends Schema.Class<Change>("Change")({
	version: Schema.Number,
	op: ChangeOp,
	cardId: Schema.optional(Schema.String),
	columnId: Schema.optional(Schema.String),
	// For card:move, the pre-move column so agents can move the card in their local cache
	// without re-reading the whole board.
	fromColumnId: Schema.optional(Schema.String),
	snapshot: ChangeSnapshot,
	by: ActorId,
	at: Schema.String,
}) {}

// Response returned by GET /api/boards/:boardId/changes
export class ChangesResponse extends Schema.Class<ChangesResponse>("ChangesResponse")({
	// Server version the agent is now synced through.
	toVersion: Schema.Number,
	// Lowest change version in `changes` (or toVersion+1 if empty).
	fromVersion: Schema.Number,
	// True on the agent's first visit OR when changelog retention dropped below
	// the agent's last-seen cursor. Agent must rebuild its cache from `board`.
	isFirstSync: Schema.Boolean,
	// Populated only when isFirstSync is true. Otherwise null.
	// Includes both board metadata (title, columns) and the full card list so
	// agents can seed their local cache in a single round-trip.
	snapshot: Schema.NullOr(BoardSnapshot),
	// Ordered oldest-first. Safe to apply in sequence.
	changes: Schema.Array(Change),
}) {}
