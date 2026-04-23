import { Effect, Schema } from "effect"
import {
	BoardStorage,
	Broadcaster,
	ClientOperation,
	type Card,
} from "@kangent/board-core"
import type { PresenceTracker } from "./presence.js"

export const processOperation = (raw: string, presence: PresenceTracker) =>
	Effect.gen(function* () {
		const parsed = yield* Schema.decodeUnknown(ClientOperation)(JSON.parse(raw))
		const storage = yield* BoardStorage
		const broadcaster = yield* Broadcaster

		switch (parsed.type) {
			case "card:add": {
				const card = yield* storage.addCard({
					columnId: parsed.columnId,
					title: parsed.title,
					description: parsed.description,
					by: parsed.by,
				})
				const version = yield* storage.incrementVersion()
				yield* broadcaster.broadcast(
					{ type: "op:applied", op: { ...parsed, cardId: card.id }, version },
				)
				return { type: "op:ack" as const, opId: parsed.opId, version, card }
			}

			case "card:update": {
				const card = yield* storage.updateCard(parsed.cardId, {
					title: parsed.title,
					description: parsed.description,
				})
				const version = yield* storage.incrementVersion()
				yield* broadcaster.broadcast({ type: "op:applied", op: parsed, version })
				return { type: "op:ack" as const, opId: parsed.opId, version, card }
			}

			case "card:move": {
				const card = yield* storage.moveCard(
					parsed.cardId,
					parsed.toColumnId,
					parsed.position,
				)
				const version = yield* storage.incrementVersion()
				yield* broadcaster.broadcast({ type: "op:applied", op: parsed, version })
				return { type: "op:ack" as const, opId: parsed.opId, version, card }
			}

			case "card:delete": {
				yield* storage.deleteCard(parsed.cardId)
				const version = yield* storage.incrementVersion()
				yield* broadcaster.broadcast({ type: "op:applied", op: parsed, version })
				return { type: "op:ack" as const, opId: parsed.opId, version }
			}

			case "column:add": {
				const column = yield* storage.addColumn(parsed.title)
				const version = yield* storage.incrementVersion()
				yield* broadcaster.broadcast(
					{ type: "op:applied", op: { ...parsed, columnId: column.id }, version },
				)
				return { type: "op:ack" as const, opId: parsed.opId, version, column }
			}

			case "column:update": {
				const column = yield* storage.updateColumn(parsed.columnId, parsed.title)
				const version = yield* storage.incrementVersion()
				yield* broadcaster.broadcast({ type: "op:applied", op: parsed, version })
				return { type: "op:ack" as const, opId: parsed.opId, version, column }
			}

			case "column:delete": {
				const result = yield* storage.deleteColumn(parsed.columnId, parsed.moveCardsTo)
				const version = yield* storage.incrementVersion()
				yield* broadcaster.broadcast({ type: "op:applied", op: parsed, version })
				return { type: "op:ack" as const, opId: parsed.opId, version, ...result }
			}

			case "column:reorder": {
				yield* storage.reorderColumns(parsed.columnIds)
				const version = yield* storage.incrementVersion()
				yield* broadcaster.broadcast({ type: "op:applied", op: parsed, version })
				return { type: "op:ack" as const, opId: parsed.opId, version }
			}

			case "presence:update": {
				presence.update(parsed.by, {
					cursor: parsed.cursor,
					status: parsed.status,
					message: parsed.message,
				})
				const actors = presence.getActive()
				yield* broadcaster.broadcast({ type: "presence:state", actors })
				return { type: "op:ack" as const, opId: parsed.opId, version: -1 }
			}
		}
	})
