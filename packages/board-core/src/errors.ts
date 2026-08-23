import { Schema } from "effect";

export class BoardNotFound extends Schema.TaggedErrorClass<BoardNotFound>()("BoardNotFound", {
	boardId: Schema.String,
}) {}

export class CardNotFound extends Schema.TaggedErrorClass<CardNotFound>()("CardNotFound", {
	cardId: Schema.String,
}) {}

export class ColumnNotFound extends Schema.TaggedErrorClass<ColumnNotFound>()("ColumnNotFound", {
	columnId: Schema.String,
}) {}

export class ColumnNotEmpty extends Schema.TaggedErrorClass<ColumnNotEmpty>()("ColumnNotEmpty", {
	columnId: Schema.String,
	cardCount: Schema.Number,
}) {}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
	message: Schema.String,
}) {}
