import { Schema } from "effect";
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
} from "effect/unstable/httpapi";
import {
	BoardNotFound,
	CardNotFound,
	ColumnNotEmpty,
	ColumnNotFound,
	ValidationError,
} from "./errors.js";
import {
	AddCardPayload,
	AddColumnPayload,
	BoardStateResponse,
	CardResponse,
	ColumnResponse,
	CreateBoardPayload,
	CreateBoardResponse,
	DeleteCardResponse,
	DeleteColumnResponse,
	MoveCardPayload,
	ReorderColumnsPayload,
	ReorderColumnsResponse,
	UpdateCardPayload,
	UpdateColumnPayload,
	UpdatePresencePayload,
} from "./schemas/api.js";
import { ChangesResponse } from "./schemas/changes.js";

// --- Error variants with HTTP statuses attached ---
//
// In v4, status codes attach to the schema rather than to the `addError`
// call. We pipe each tagged error through `HttpApiSchema.status` once so
// every endpoint that references an error gets the status for free.

const NotFoundBoard = BoardNotFound.pipe(HttpApiSchema.status(404));
const NotFoundCard = CardNotFound.pipe(HttpApiSchema.status(404));
const NotFoundColumn = ColumnNotFound.pipe(HttpApiSchema.status(404));
const ConflictColumnNotEmpty = ColumnNotEmpty.pipe(HttpApiSchema.status(409));
const BadValidation = ValidationError.pipe(HttpApiSchema.status(400));

// --- Success variants where the server returns a non-200 success code ---

const Created = <S extends Schema.Top>(schema: S) =>
	schema.pipe(HttpApiSchema.status(201));

// --- Endpoints ---
//
// v4 collapses `setPath` / `setPayload` / `setHeaders` / `setUrlParams` /
// `addSuccess` / `addError` into a single options object passed to
// `HttpApiEndpoint.<method>(name, path, options)`.

const createBoard = HttpApiEndpoint.post("createBoard", "/api/boards", {
	payload: CreateBoardPayload,
	success: Created(CreateBoardResponse),
});

const getBoardState = HttpApiEndpoint.get("getBoardState", "/api/boards/:boardId/state", {
	params: { boardId: Schema.String },
	success: BoardStateResponse,
	error: NotFoundBoard,
});

const addCard = HttpApiEndpoint.post("addCard", "/api/boards/:boardId/cards", {
	params: { boardId: Schema.String },
	payload: AddCardPayload,
	success: Created(CardResponse),
	error: [NotFoundBoard, NotFoundColumn],
});

const updateCard = HttpApiEndpoint.patch("updateCard", "/api/boards/:boardId/cards/:cardId", {
	params: { boardId: Schema.String, cardId: Schema.String },
	payload: UpdateCardPayload,
	success: CardResponse,
	error: [NotFoundBoard, NotFoundCard],
});

const moveCard = HttpApiEndpoint.post("moveCard", "/api/boards/:boardId/cards/:cardId/move", {
	params: { boardId: Schema.String, cardId: Schema.String },
	payload: MoveCardPayload,
	success: CardResponse,
	error: [NotFoundBoard, NotFoundCard, NotFoundColumn],
});

const deleteCard = HttpApiEndpoint.delete("deleteCard", "/api/boards/:boardId/cards/:cardId", {
	params: { boardId: Schema.String, cardId: Schema.String },
	success: DeleteCardResponse,
	error: [NotFoundBoard, NotFoundCard],
});

const addColumn = HttpApiEndpoint.post("addColumn", "/api/boards/:boardId/columns", {
	params: { boardId: Schema.String },
	payload: AddColumnPayload,
	success: Created(ColumnResponse),
	error: NotFoundBoard,
});

// Reorder must be matched before the :columnId routes below or "reorder"
// would be parsed as a column id.
const reorderColumns = HttpApiEndpoint.post(
	"reorderColumns",
	"/api/boards/:boardId/columns/reorder",
	{
		params: { boardId: Schema.String },
		payload: ReorderColumnsPayload,
		success: ReorderColumnsResponse,
		error: [NotFoundBoard, NotFoundColumn, BadValidation],
	},
);

const updateColumn = HttpApiEndpoint.patch(
	"updateColumn",
	"/api/boards/:boardId/columns/:columnId",
	{
		params: { boardId: Schema.String, columnId: Schema.String },
		payload: UpdateColumnPayload,
		success: ColumnResponse,
		error: [NotFoundBoard, NotFoundColumn],
	},
);

const deleteColumn = HttpApiEndpoint.delete(
	"deleteColumn",
	"/api/boards/:boardId/columns/:columnId",
	{
		params: { boardId: Schema.String, columnId: Schema.String },
		headers: { moveCardsTo: Schema.optional(Schema.String) },
		success: DeleteColumnResponse,
		error: [NotFoundBoard, NotFoundColumn, ConflictColumnNotEmpty],
	},
);

// Incremental sync feed. Agents call this before any read/write to discover
// what has changed since their previous visit. The X-Agent-Id header is
// required; the server tracks a per-agent cursor and advances it on read.
const getChanges = HttpApiEndpoint.get("getChanges", "/api/boards/:boardId/changes", {
	params: { boardId: Schema.String },
	headers: { "x-agent-id": Schema.String },
	query: {
		since: Schema.optional(Schema.String),
		ack: Schema.optional(Schema.Literals(["true", "false"])),
	},
	success: ChangesResponse,
	error: NotFoundBoard,
});

const updatePresence = HttpApiEndpoint.post("updatePresence", "/api/boards/:boardId/presence", {
	params: { boardId: Schema.String },
	payload: UpdatePresencePayload,
	success: Schema.Void,
});

// --- Group ---

export class BoardsGroup extends HttpApiGroup.make("boards")
	.add(createBoard)
	.add(getBoardState)
	.add(getChanges)
	.add(addCard)
	.add(updateCard)
	.add(moveCard)
	.add(deleteCard)
	.add(addColumn)
	.add(reorderColumns)
	.add(updateColumn)
	.add(deleteColumn)
	.add(updatePresence) {}

// --- Top-level API ---

export class KangentApi extends HttpApi.make("KangentApi").add(BoardsGroup) {}
