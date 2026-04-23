import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Schema } from "effect"
import {
	BoardNotFound,
	CardNotFound,
	ColumnNotEmpty,
	ColumnNotFound,
} from "./errors.js"
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
	UpdateCardPayload,
	UpdateColumnPayload,
	UpdatePresencePayload,
} from "./schemas/api.js"
import { ChangesResponse } from "./schemas/changes.js"

// --- Endpoints ---

const createBoard = HttpApiEndpoint.post("createBoard", "/api/boards")
	.setPayload(CreateBoardPayload)
	.addSuccess(CreateBoardResponse, { status: 201 })

const getBoardState = HttpApiEndpoint.get("getBoardState", "/api/boards/:boardId/state")
	.setPath(Schema.Struct({ boardId: Schema.String }))
	.addSuccess(BoardStateResponse)
	.addError(BoardNotFound, { status: 404 })

const addCard = HttpApiEndpoint.post("addCard", "/api/boards/:boardId/cards")
	.setPath(Schema.Struct({ boardId: Schema.String }))
	.setPayload(AddCardPayload)
	.addSuccess(CardResponse, { status: 201 })
	.addError(BoardNotFound, { status: 404 })
	.addError(ColumnNotFound, { status: 404 })

const updateCard = HttpApiEndpoint.patch("updateCard", "/api/boards/:boardId/cards/:cardId")
	.setPath(Schema.Struct({ boardId: Schema.String, cardId: Schema.String }))
	.setPayload(UpdateCardPayload)
	.addSuccess(CardResponse)
	.addError(BoardNotFound, { status: 404 })
	.addError(CardNotFound, { status: 404 })

const moveCard = HttpApiEndpoint.post("moveCard", "/api/boards/:boardId/cards/:cardId/move")
	.setPath(Schema.Struct({ boardId: Schema.String, cardId: Schema.String }))
	.setPayload(MoveCardPayload)
	.addSuccess(CardResponse)
	.addError(BoardNotFound, { status: 404 })
	.addError(CardNotFound, { status: 404 })
	.addError(ColumnNotFound, { status: 404 })

const deleteCard = HttpApiEndpoint.del("deleteCard", "/api/boards/:boardId/cards/:cardId")
	.setPath(Schema.Struct({ boardId: Schema.String, cardId: Schema.String }))
	.addSuccess(DeleteCardResponse)
	.addError(BoardNotFound, { status: 404 })
	.addError(CardNotFound, { status: 404 })

const addColumn = HttpApiEndpoint.post("addColumn", "/api/boards/:boardId/columns")
	.setPath(Schema.Struct({ boardId: Schema.String }))
	.setPayload(AddColumnPayload)
	.addSuccess(ColumnResponse, { status: 201 })
	.addError(BoardNotFound, { status: 404 })

const updateColumn = HttpApiEndpoint.patch(
	"updateColumn",
	"/api/boards/:boardId/columns/:columnId",
)
	.setPath(Schema.Struct({ boardId: Schema.String, columnId: Schema.String }))
	.setPayload(UpdateColumnPayload)
	.addSuccess(ColumnResponse)
	.addError(BoardNotFound, { status: 404 })
	.addError(ColumnNotFound, { status: 404 })

const deleteColumn = HttpApiEndpoint.del(
	"deleteColumn",
	"/api/boards/:boardId/columns/:columnId",
)
	.setPath(Schema.Struct({ boardId: Schema.String, columnId: Schema.String }))
	.setHeaders(Schema.Struct({ moveCardsTo: Schema.optional(Schema.String) }))
	.addSuccess(DeleteColumnResponse)
	.addError(BoardNotFound, { status: 404 })
	.addError(ColumnNotFound, { status: 404 })
	.addError(ColumnNotEmpty, { status: 409 })

// Incremental sync feed. Agents call this before any read/write to discover
// what has changed since their previous visit. The X-Agent-Id header is
// required; the server tracks a per-agent cursor and advances it on read.
const getChanges = HttpApiEndpoint.get("getChanges", "/api/boards/:boardId/changes")
	.setPath(Schema.Struct({ boardId: Schema.String }))
	.setHeaders(
		Schema.Struct({
			"x-agent-id": Schema.String,
		}),
	)
	.setUrlParams(
		Schema.Struct({
			since: Schema.optional(Schema.String),
			ack: Schema.optional(Schema.Literal("true", "false")),
		}),
	)
	.addSuccess(ChangesResponse)
	.addError(BoardNotFound, { status: 404 })

const updatePresence = HttpApiEndpoint.post("updatePresence", "/api/boards/:boardId/presence")
	.setPath(Schema.Struct({ boardId: Schema.String }))
	.setPayload(UpdatePresencePayload)
	.addSuccess(Schema.Void)

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
	.add(updateColumn)
	.add(deleteColumn)
	.add(updatePresence) {}

// --- Top-level API ---

export class KangentApi extends HttpApi.make("KangentApi").add(BoardsGroup) {}
