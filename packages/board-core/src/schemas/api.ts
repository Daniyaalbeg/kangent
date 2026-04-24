import { Schema } from "effect"
import { ActorId, Board, Card, Column } from "./board.js"

// --- Request Payloads ---

export class CreateBoardPayload extends Schema.Class<CreateBoardPayload>("CreateBoardPayload")({
	title: Schema.String,
	description: Schema.optional(Schema.String),
	columns: Schema.optional(Schema.Array(Schema.String)),
	by: ActorId,
}) {}

export class AddCardPayload extends Schema.Class<AddCardPayload>("AddCardPayload")({
	columnId: Schema.String,
	title: Schema.String,
	description: Schema.optional(Schema.Unknown),
	by: ActorId,
}) {}

export class UpdateCardPayload extends Schema.Class<UpdateCardPayload>("UpdateCardPayload")({
	title: Schema.optional(Schema.String),
	description: Schema.optional(Schema.Unknown),
	by: ActorId,
}) {}

export class MoveCardPayload extends Schema.Class<MoveCardPayload>("MoveCardPayload")({
	toColumnId: Schema.String,
	position: Schema.Number,
	by: ActorId,
}) {}

export class AddColumnPayload extends Schema.Class<AddColumnPayload>("AddColumnPayload")({
	title: Schema.String,
	by: ActorId,
}) {}

export class UpdateColumnPayload extends Schema.Class<UpdateColumnPayload>("UpdateColumnPayload")({
	title: Schema.String,
	by: ActorId,
}) {}

export class UpdatePresencePayload extends Schema.Class<UpdatePresencePayload>(
	"UpdatePresencePayload",
)({
	by: ActorId,
	status: Schema.Literal("viewing", "working", "idle"),
	message: Schema.optional(Schema.String),
}) {}

// --- Response Schemas ---

export class CreateBoardResponse extends Schema.Class<CreateBoardResponse>("CreateBoardResponse")({
	id: Schema.String,
	url: Schema.String,
	board: Board,
}) {}

export class BoardStateResponse extends Schema.Class<BoardStateResponse>("BoardStateResponse")({
	board: Board,
	presence: Schema.Array(
		Schema.Struct({
			id: ActorId,
			status: Schema.Literal("viewing", "working", "idle"),
			message: Schema.optional(Schema.String),
		}),
	),
}) {}

export class CardResponse extends Schema.Class<CardResponse>("CardResponse")({
	card: Card,
	version: Schema.Number,
}) {}

export class ColumnResponse extends Schema.Class<ColumnResponse>("ColumnResponse")({
	column: Column,
	version: Schema.Number,
}) {}

export class DeleteCardResponse extends Schema.Class<DeleteCardResponse>("DeleteCardResponse")({
	deleted: Schema.String,
	version: Schema.Number,
}) {}

export class DeleteColumnResponse extends Schema.Class<DeleteColumnResponse>(
	"DeleteColumnResponse",
)({
	deleted: Schema.String,
	cardsMoved: Schema.Number,
	version: Schema.Number,
}) {}
