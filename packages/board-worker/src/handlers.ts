import { HttpApiBuilder } from "@effect/platform"
import { Effect, Option } from "effect"
import {
	KangentApi,
	BoardStorage,
	Broadcaster,
	CreateBoardResponse,
	BoardStateResponse,
	CardResponse,
	ColumnResponse,
	DeleteCardResponse,
	DeleteColumnResponse,
	ChangesResponse,
	BoardSnapshot,
	Board,
} from "@kangent/board-core"

export const BoardsGroupLive = HttpApiBuilder.group(KangentApi, "boards", (handlers) =>
	handlers
		.handle("createBoard", ({ payload }) =>
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const board = yield* storage.createBoard({
					title: payload.title,
					description: payload.description,
					by: payload.by,
				})
				return new CreateBoardResponse({
					id: board.id,
					url: `/b/${board.id}`,
					token: `tok_${board.id}`,
					board,
				})
			}),
		)
		.handle("getBoardState", ({ path }) =>
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const board = yield* storage.getBoard()
				return new BoardStateResponse({
					board,
					presence: [],
				})
			}),
		)
		.handle("getChanges", ({ headers, urlParams }) =>
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const agentId = headers["x-agent-id"]
				const overrideSince =
					urlParams.since !== undefined && !Number.isNaN(Number(urlParams.since))
						? Math.max(0, Number(urlParams.since))
						: undefined
				const ack = urlParams.ack !== "false"
				const stored = yield* storage.getAgentCursor(agentId)
				const afterVersion = overrideSince ?? stored ?? 0
				const feed = yield* storage.readChanges(afterVersion, 200)

				let snapshot: BoardSnapshot | null = null
				if (feed.isFirstSync) {
					const board = yield* storage.getBoard()
					const cards = yield* storage.getCards()
					snapshot = new BoardSnapshot({ board, cards })
				}

				if (ack) {
					yield* storage.setAgentCursor(agentId, feed.toVersion)
				}

				return new ChangesResponse({
					toVersion: feed.toVersion,
					fromVersion: feed.fromVersion,
					isFirstSync: feed.isFirstSync,
					snapshot,
					changes: feed.changes,
				})
			}),
		)
		.handle("addCard", ({ path, payload }) =>
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const card = yield* storage.addCard({
					columnId: payload.columnId,
					title: payload.title,
					description: payload.description,
					by: payload.by,
				})
				const version = yield* storage.incrementVersion()
				const broadcaster = yield* Broadcaster
				yield* broadcaster.broadcast({
					type: "op:applied",
					op: { type: "card:add", cardId: card.id },
					version,
				})
				return new CardResponse({ card, version })
			}),
		)
		.handle("updateCard", ({ path, payload }) =>
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const card = yield* storage.updateCard(path.cardId, {
					title: payload.title,
					description: payload.description,
				})
				const version = yield* storage.incrementVersion()
				const broadcaster = yield* Broadcaster
				yield* broadcaster.broadcast({
					type: "op:applied",
					op: { type: "card:update", cardId: path.cardId },
					version,
				})
				return new CardResponse({ card, version })
			}),
		)
		.handle("moveCard", ({ path, payload }) =>
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const card = yield* storage.moveCard(
					path.cardId,
					payload.toColumnId,
					payload.position,
				)
				const version = yield* storage.incrementVersion()
				const broadcaster = yield* Broadcaster
				yield* broadcaster.broadcast({
					type: "op:applied",
					op: { type: "card:move", cardId: path.cardId },
					version,
				})
				return new CardResponse({ card, version })
			}),
		)
		.handle("deleteCard", ({ path }) =>
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				yield* storage.deleteCard(path.cardId)
				const version = yield* storage.incrementVersion()
				const broadcaster = yield* Broadcaster
				yield* broadcaster.broadcast({
					type: "op:applied",
					op: { type: "card:delete", cardId: path.cardId },
					version,
				})
				return new DeleteCardResponse({ deleted: path.cardId, version })
			}),
		)
		.handle("addColumn", ({ path, payload }) =>
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const column = yield* storage.addColumn(payload.title)
				const version = yield* storage.incrementVersion()
				const broadcaster = yield* Broadcaster
				yield* broadcaster.broadcast({
					type: "op:applied",
					op: { type: "column:add", columnId: column.id },
					version,
				})
				return new ColumnResponse({ column, version })
			}),
		)
		.handle("updateColumn", ({ path, payload }) =>
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const column = yield* storage.updateColumn(path.columnId, payload.title)
				const version = yield* storage.incrementVersion()
				const broadcaster = yield* Broadcaster
				yield* broadcaster.broadcast({
					type: "op:applied",
					op: { type: "column:update", columnId: path.columnId },
					version,
				})
				return new ColumnResponse({ column, version })
			}),
		)
		.handle("deleteColumn", ({ path, headers }) =>
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const result = yield* storage.deleteColumn(path.columnId, headers.moveCardsTo)
				const version = yield* storage.incrementVersion()
				const broadcaster = yield* Broadcaster
				yield* broadcaster.broadcast({
					type: "op:applied",
					op: { type: "column:delete", columnId: path.columnId },
					version,
				})
				return new DeleteColumnResponse({
					deleted: path.columnId,
					cardsMoved: result.cardsMoved,
					version,
				})
			}),
		)
		.handle("updatePresence", ({ path, payload }) =>
			Effect.gen(function* () {
				const broadcaster = yield* Broadcaster
				yield* broadcaster.broadcast({
					type: "presence:state",
					actors: [
						{
							id: payload.by,
							status: payload.status,
							message: payload.message,
						},
					],
				})
			}),
		),
)
