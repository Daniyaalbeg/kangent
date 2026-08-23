import { Schema } from "effect";

export const ActorId = Schema.String.pipe(Schema.brand("ActorId"));
export type ActorId = typeof ActorId.Type;

export const CardPriority = Schema.Literals(["low", "medium", "high", "urgent"]);
export type CardPriority = typeof CardPriority.Type;

export class Column extends Schema.Class<Column>("Column")({
	id: Schema.String,
	title: Schema.String,
	position: Schema.Number,
	cardIds: Schema.Array(Schema.String),
}) {}

export class Card extends Schema.Class<Card>("Card")({
	id: Schema.String,
	// Human-readable, collision-resistant ticket key in the form
	// `<boardId>-<seq>` (e.g. `f3a2b1c4d5e6-1`). Stamped server-side on
	// `card:add` and never recycled. Optional in the schema for backward
	// compatibility with cards created before identifiers existed; the
	// server lazily backfills missing identifiers on first access.
	identifier: Schema.optional(Schema.String),
	columnId: Schema.String,
	title: Schema.String,
	description: Schema.Unknown,
	position: Schema.Number,
	// Optional flagging fields. Either may be set/cleared independently by the
	// UI or by an agent. dueDate is an ISO-8601 date or date-time string.
	priority: Schema.optional(CardPriority),
	dueDate: Schema.optional(Schema.String),
	// Free-form, case-preserving labels. Consumers (e.g. the orchestrator CLI
	// for filtering) MAY normalize to lowercase locally. Treated as a set:
	// duplicates are rejected at the API boundary.
	labels: Schema.optional(Schema.Array(Schema.String)),
	// Card identifiers that block this card. The Symphony Todo blocker rule
	// (§8.2) skips cards in `Todo` whose blockers are still non-terminal.
	// We store identifiers (not internal ids) so blockers stay readable when
	// rendered in logs and UI.
	blockedBy: Schema.optional(Schema.Array(Schema.String)),
	createdBy: ActorId,
	createdAt: Schema.String,
	updatedAt: Schema.String,
}) {}

export class Board extends Schema.Class<Board>("Board")({
	id: Schema.String,
	title: Schema.String,
	description: Schema.optional(Schema.String),
	columns: Schema.Array(Column),
	// Per-board monotonic counter used to mint card identifiers. Optional in
	// the schema so legacy boards (created before identifiers existed)
	// continue to decode; the worker treats `undefined` as "needs migration".
	nextCardSeq: Schema.optional(Schema.Number),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	createdBy: ActorId,
	version: Schema.Number,
}) {}
