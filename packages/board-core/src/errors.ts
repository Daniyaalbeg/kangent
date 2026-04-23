import { Schema } from "effect"

export class BoardNotFound extends Schema.TaggedError<BoardNotFound>()("BoardNotFound", {
	boardId: Schema.String,
}) {}

export class CardNotFound extends Schema.TaggedError<CardNotFound>()("CardNotFound", {
	cardId: Schema.String,
}) {}

export class ColumnNotFound extends Schema.TaggedError<ColumnNotFound>()("ColumnNotFound", {
	columnId: Schema.String,
}) {}

export class ColumnNotEmpty extends Schema.TaggedError<ColumnNotEmpty>()("ColumnNotEmpty", {
	columnId: Schema.String,
	cardCount: Schema.Number,
}) {}

export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
	message: Schema.String,
}) {}
