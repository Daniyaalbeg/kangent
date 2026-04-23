import { Schema } from "effect"
import { ActorId } from "./board.js"

const BaseOp = Schema.Struct({
	opId: Schema.String,
	by: ActorId,
})

export class CardAddOp extends Schema.Class<CardAddOp>("CardAddOp")({
	...BaseOp.fields,
	type: Schema.Literal("card:add"),
	columnId: Schema.String,
	title: Schema.String,
	description: Schema.optional(Schema.Unknown),
}) {}

export class CardMoveOp extends Schema.Class<CardMoveOp>("CardMoveOp")({
	...BaseOp.fields,
	type: Schema.Literal("card:move"),
	cardId: Schema.String,
	toColumnId: Schema.String,
	position: Schema.Number,
}) {}

export class CardUpdateOp extends Schema.Class<CardUpdateOp>("CardUpdateOp")({
	...BaseOp.fields,
	type: Schema.Literal("card:update"),
	cardId: Schema.String,
	title: Schema.optional(Schema.String),
	description: Schema.optional(Schema.Unknown),
}) {}

export class CardDeleteOp extends Schema.Class<CardDeleteOp>("CardDeleteOp")({
	...BaseOp.fields,
	type: Schema.Literal("card:delete"),
	cardId: Schema.String,
}) {}

export class ColumnAddOp extends Schema.Class<ColumnAddOp>("ColumnAddOp")({
	...BaseOp.fields,
	type: Schema.Literal("column:add"),
	title: Schema.String,
}) {}

export class ColumnUpdateOp extends Schema.Class<ColumnUpdateOp>("ColumnUpdateOp")({
	...BaseOp.fields,
	type: Schema.Literal("column:update"),
	columnId: Schema.String,
	title: Schema.String,
}) {}

export class ColumnDeleteOp extends Schema.Class<ColumnDeleteOp>("ColumnDeleteOp")({
	...BaseOp.fields,
	type: Schema.Literal("column:delete"),
	columnId: Schema.String,
	moveCardsTo: Schema.optional(Schema.String),
}) {}

export class ColumnReorderOp extends Schema.Class<ColumnReorderOp>("ColumnReorderOp")({
	...BaseOp.fields,
	type: Schema.Literal("column:reorder"),
	columnIds: Schema.Array(Schema.String),
}) {}

export class PresenceUpdateOp extends Schema.Class<PresenceUpdateOp>("PresenceUpdateOp")({
	...BaseOp.fields,
	type: Schema.Literal("presence:update"),
	cursor: Schema.optional(Schema.Struct({ cardId: Schema.String })),
	status: Schema.Literal("viewing", "working", "idle"),
	message: Schema.optional(Schema.String),
}) {}

export const ClientOperation = Schema.Union(
	CardAddOp,
	CardMoveOp,
	CardUpdateOp,
	CardDeleteOp,
	ColumnAddOp,
	ColumnUpdateOp,
	ColumnDeleteOp,
	ColumnReorderOp,
	PresenceUpdateOp,
)
export type ClientOperation = typeof ClientOperation.Type

export class BoardStateMessage extends Schema.Class<BoardStateMessage>("BoardStateMessage")({
	type: Schema.Literal("board:state"),
	board: Schema.Unknown,
	version: Schema.Number,
}) {}

export class OpAppliedMessage extends Schema.Class<OpAppliedMessage>("OpAppliedMessage")({
	type: Schema.Literal("op:applied"),
	op: Schema.Unknown,
	version: Schema.Number,
}) {}

export class OpAckMessage extends Schema.Class<OpAckMessage>("OpAckMessage")({
	type: Schema.Literal("op:ack"),
	opId: Schema.String,
	version: Schema.Number,
}) {}

export class OpErrorMessage extends Schema.Class<OpErrorMessage>("OpErrorMessage")({
	type: Schema.Literal("op:error"),
	opId: Schema.String,
	code: Schema.String,
	message: Schema.String,
}) {}

export class PresenceStateMessage extends Schema.Class<PresenceStateMessage>(
	"PresenceStateMessage",
)({
	type: Schema.Literal("presence:state"),
	actors: Schema.Array(
		Schema.Struct({
			id: ActorId,
			cursor: Schema.optional(Schema.Struct({ cardId: Schema.String })),
			status: Schema.Literal("viewing", "working", "idle"),
			message: Schema.optional(Schema.String),
		}),
	),
}) {}

export const ServerMessage = Schema.Union(
	BoardStateMessage,
	OpAppliedMessage,
	OpAckMessage,
	OpErrorMessage,
	PresenceStateMessage,
)
export type ServerMessage = typeof ServerMessage.Type
