import { Schema } from "effect";

export const ActorId = Schema.String.pipe(Schema.brand("ActorId"));
export type ActorId = typeof ActorId.Type;

export const CardPriority = Schema.Literal("low", "medium", "high", "urgent");
export type CardPriority = typeof CardPriority.Type;

export class Column extends Schema.Class<Column>("Column")({
	id: Schema.String,
	title: Schema.String,
	position: Schema.Number,
	cardIds: Schema.Array(Schema.String),
}) {}

export class Card extends Schema.Class<Card>("Card")({
	id: Schema.String,
	columnId: Schema.String,
	title: Schema.String,
	description: Schema.Unknown,
	position: Schema.Number,
	// Optional flagging fields. Either may be set/cleared independently by the
	// UI or by an agent. dueDate is an ISO-8601 date or date-time string.
	priority: Schema.optional(CardPriority),
	dueDate: Schema.optional(Schema.String),
	createdBy: ActorId,
	createdAt: Schema.String,
	updatedAt: Schema.String,
}) {}

export class Board extends Schema.Class<Board>("Board")({
	id: Schema.String,
	title: Schema.String,
	description: Schema.optional(Schema.String),
	columns: Schema.Array(Column),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	createdBy: ActorId,
	version: Schema.Number,
}) {}
