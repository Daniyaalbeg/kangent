import { Effect, Layer } from "effect"
import {
	BoardStorage,
	Broadcaster,
	type AppendChangeParams,
	type Card,
	type Column,
} from "@kangent/board-core"
import { makeStorageLayer } from "./storage.js"
import { makeBroadcasterLayer, type ConnectionState } from "./broadcaster.js"
import { processOperation } from "./websocket.js"
import { PresenceTracker } from "./presence.js"

// Max number of changes returned in a single /changes response. Agents can
// keep calling until fromVersion == toVersion + 1 if they fell far behind.
const CHANGES_PAGE_LIMIT = 200

export class BoardDO implements DurableObject {
	private connections = new Map<WebSocket, ConnectionState>()
	private presence = new PresenceTracker()

	constructor(
		private state: DurableObjectState,
		private env: unknown,
	) {}

	private broadcastBoardState() {
		return this.run(
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const board = yield* storage.getBoard()
				const cards = yield* storage.getCards()
				const broadcaster = yield* Broadcaster
				yield* broadcaster.broadcast({
					type: "board:state",
					board: { ...board, cards },
					version: board.version,
				})
			}),
		)
	}

	private get layers() {
		return Layer.merge(
			makeStorageLayer(this.state.storage),
			makeBroadcasterLayer(this.connections),
		)
	}

	private run<A, E>(
		effect: Effect.Effect<A, E, BoardStorage | Broadcaster>,
	): Promise<A> {
		return Effect.runPromise(
			effect.pipe(Effect.provide(this.layers)) as Effect.Effect<A, E>,
		)
	}

	// Record a mutation to the changelog. `version` must be the one returned
	// by incrementVersion(). `by` falls back to ai:unknown when the caller
	// didn't supply one.
	private appendChange(params: AppendChangeParams) {
		return this.run(
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				yield* storage.appendChange(params)
			}),
		)
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		// WebSocket upgrade
		if (request.headers.get("Upgrade") === "websocket") {
			return this.handleWebSocketUpgrade()
		}

		// Route API requests
		try {
			return await this.routeApi(request, url)
		} catch (error: any) {
			const tag = error?._tag
			if (tag === "BoardNotFound") return this.json({ _tag: tag, boardId: error.boardId }, 404)
			if (tag === "CardNotFound") return this.json({ _tag: tag, cardId: error.cardId }, 404)
			if (tag === "ColumnNotFound") return this.json({ _tag: tag, columnId: error.columnId }, 404)
			if (tag === "ColumnNotEmpty")
				return this.json({ _tag: tag, columnId: error.columnId, cardCount: error.cardCount }, 409)
			return this.json({ error: error?.message ?? "Internal error" }, 500)
		}
	}

	private async routeApi(request: Request, url: URL): Promise<Response> {
		const path = url.pathname
		const method = request.method

		// POST /api/boards — create board (forwarded from outer worker with boardId in body)
		if (path === "/api/boards" && method === "POST") {
			const body = (await request.json()) as any
			const board = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.createBoard({
						title: body.title,
						description: body.description,
						columns: body.columns,
						by: body.by ?? "human:anonymous",
					})
				}),
			)
			return this.json(board, 201)
		}

		// GET /api/boards/:id/changes — incremental sync feed.
		// Server-tracks a per-agent cursor keyed off the X-Agent-Id header.
		// Agents SHOULD call this before any read/write to avoid duplicating work.
		if (path.match(/\/api\/boards\/[^/]+\/changes$/) && method === "GET") {
			return this.handleChangesRequest(request, url)
		}

		// GET /api/boards/:id/state
		if (path.match(/\/api\/boards\/[^/]+\/state$/) && method === "GET") {
			const board = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.getBoard()
				}),
			)
			const cards = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.getCards()
				}),
			)
			return this.json({
				board: { ...board, cards },
				presence: this.presence.getActive(),
			})
		}

		// POST /api/boards/:id/cards
		if (path.match(/\/api\/boards\/[^/]+\/cards$/) && method === "POST") {
			const body = (await request.json()) as any
			const by = body.by ?? "ai:unknown"
			const card = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.addCard({
						columnId: body.columnId,
						title: body.title,
						description: body.description,
						by,
					})
				}),
			)
			const version = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.incrementVersion()
				}),
			)
			await this.appendChange({
				version,
				op: "card:add",
				cardId: card.id,
				columnId: body.columnId,
				snapshot: card,
				by,
			})
			await this.broadcastBoardState()
			return this.json({ card, version }, 201)
		}

		// PATCH /api/boards/:id/cards/:cardId
		const cardPatch = path.match(/\/api\/boards\/[^/]+\/cards\/([^/]+)$/)
		if (cardPatch && method === "PATCH") {
			const cardId = cardPatch[1]!
			const body = (await request.json()) as any
			const card = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.updateCard(cardId, {
						title: body.title,
						description: body.description,
					})
				}),
			)
			const version = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.incrementVersion()
				}),
			)
			await this.appendChange({
				version,
				op: "card:update",
				cardId,
				snapshot: card,
				by: body.by ?? "ai:unknown",
			})
			await this.broadcastBoardState()
			return this.json({ card, version })
		}

		// POST /api/boards/:id/cards/:cardId/move
		const cardMove = path.match(/\/api\/boards\/[^/]+\/cards\/([^/]+)\/move$/)
		if (cardMove && method === "POST") {
			const cardId = cardMove[1]!
			const body = (await request.json()) as any
			// Capture the origin column BEFORE the move so we can report it in the changelog.
			const originalColumnId = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					const existing = yield* storage.getCard(cardId)
					return existing.columnId
				}),
			).catch(() => undefined)
			const card = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.moveCard(cardId, body.toColumnId, body.position)
				}),
			)
			const version = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.incrementVersion()
				}),
			)
			await this.appendChange({
				version,
				op: "card:move",
				cardId,
				columnId: body.toColumnId,
				fromColumnId: originalColumnId,
				snapshot: card,
				by: body.by ?? "ai:unknown",
			})
			await this.broadcastBoardState()
			return this.json({ card, version })
		}

		// DELETE /api/boards/:id/cards/:cardId
		const cardDelete = path.match(/\/api\/boards\/[^/]+\/cards\/([^/]+)$/)
		if (cardDelete && method === "DELETE") {
			const cardId = cardDelete[1]!
			const by = url.searchParams.get("by") ?? "ai:unknown"
			await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					yield* storage.deleteCard(cardId)
				}),
			)
			const version = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.incrementVersion()
				}),
			)
			await this.appendChange({
				version,
				op: "card:delete",
				cardId,
				snapshot: null,
				by,
			})
			await this.broadcastBoardState()
			return this.json({ deleted: cardId, version })
		}

		// POST /api/boards/:id/columns
		if (path.match(/\/api\/boards\/[^/]+\/columns$/) && method === "POST") {
			const body = (await request.json()) as any
			const column = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.addColumn(body.title)
				}),
			)
			const version = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.incrementVersion()
				}),
			)
			await this.appendChange({
				version,
				op: "column:add",
				columnId: column.id,
				snapshot: column,
				by: body.by ?? "ai:unknown",
			})
			await this.broadcastBoardState()
			return this.json({ column, version }, 201)
		}

		// PATCH /api/boards/:id/columns/:columnId
		const colPatch = path.match(/\/api\/boards\/[^/]+\/columns\/([^/]+)$/)
		if (colPatch && method === "PATCH") {
			const columnId = colPatch[1]!
			const body = (await request.json()) as any
			const column = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.updateColumn(columnId, body.title)
				}),
			)
			const version = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.incrementVersion()
				}),
			)
			await this.appendChange({
				version,
				op: "column:update",
				columnId,
				snapshot: column,
				by: body.by ?? "ai:unknown",
			})
			await this.broadcastBoardState()
			return this.json({ column, version })
		}

		// DELETE /api/boards/:id/columns/:columnId
		const colDelete = path.match(/\/api\/boards\/[^/]+\/columns\/([^/]+)$/)
		if (colDelete && method === "DELETE") {
			const columnId = colDelete[1]!
			const moveCardsTo = url.searchParams.get("moveCardsTo") ?? undefined
			const by = url.searchParams.get("by") ?? "ai:unknown"
			const result = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.deleteColumn(columnId, moveCardsTo)
				}),
			)
			const version = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					return yield* storage.incrementVersion()
				}),
			)
			await this.appendChange({
				version,
				op: "column:delete",
				columnId,
				snapshot: null,
				by,
			})
			await this.broadcastBoardState()
			return this.json({ deleted: columnId, cardsMoved: result.cardsMoved, version })
		}

		// POST /api/boards/:id/presence
		if (path.match(/\/api\/boards\/[^/]+\/presence$/) && method === "POST") {
			const body = (await request.json()) as any
			this.presence.update(body.by, {
				status: body.status,
				message: body.message,
			})
			return this.json({ ok: true })
		}

		return this.json({ error: "Not found" }, 404)
	}

	private async handleChangesRequest(request: Request, url: URL): Promise<Response> {
		const agentId = request.headers.get("X-Agent-Id")?.trim()
		if (!agentId) {
			return this.json(
				{
					error:
						"X-Agent-Id header is required. Send a stable id per agent instance so the server can track what you've already seen.",
				},
				400,
			)
		}

		// `since` query param lets the agent override the server-tracked cursor
		// (useful when the agent persists its own cursor and wants exact control,
		// or when testing). Otherwise we use the server cursor for this agent.
		const sinceParam = url.searchParams.get("since")
		const overrideSince =
			sinceParam !== null && !Number.isNaN(Number(sinceParam))
				? Math.max(0, Number(sinceParam))
				: undefined

		// `ack=false` lets an agent peek without advancing the cursor. Default true.
		const ack = url.searchParams.get("ack") !== "false"

		const { feed, storedCursor } = await this.run(
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const stored = yield* storage.getAgentCursor(agentId)
				const afterVersion = overrideSince ?? stored ?? 0
				const feed = yield* storage.readChanges(afterVersion, CHANGES_PAGE_LIMIT)
				return { feed, storedCursor: stored }
			}),
		)

		// On first sync, include the full current board + cards so the agent can
		// seed its cache in one round-trip.
		let snapshot: { board: unknown; cards: unknown } | null = null
		if (feed.isFirstSync) {
			snapshot = await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					const board = yield* storage.getBoard()
					const cards = yield* storage.getCards()
					return { board, cards }
				}),
			).catch(() => null)
		}

		// Advance cursor. Even on isFirstSync we set it to toVersion so the next
		// call returns only subsequent mutations.
		if (ack && (feed.toVersion !== storedCursor || feed.isFirstSync)) {
			await this.run(
				Effect.gen(function* () {
					const storage = yield* BoardStorage
					yield* storage.setAgentCursor(agentId, feed.toVersion)
				}),
			)
		}

		return this.json({
			toVersion: feed.toVersion,
			fromVersion: feed.fromVersion,
			isFirstSync: feed.isFirstSync,
			snapshot,
			changes: feed.changes,
		})
	}

	private handleWebSocketUpgrade(): Response {
		const pair = new WebSocketPair()
		const [client, server] = [pair[0], pair[1]]

		this.state.acceptWebSocket(server)
		this.connections.set(server, { ws: server })

		// Send current board state on connect
		this.run(
			Effect.gen(function* () {
				const storage = yield* BoardStorage
				const board = yield* storage.getBoard()
				const cards = yield* storage.getCards()
				return { board, cards }
			}),
		)
			.then(({ board, cards }) => {
				server.send(
					JSON.stringify({
						type: "board:state",
						board: { ...board, cards },
						version: board.version,
					}),
				)
			})
			.catch(() => {
				// Board may not exist yet
			})

		return new Response(null, { status: 101, webSocket: client })
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (typeof message !== "string") return

		try {
			const result = await Effect.runPromise(
				processOperation(message, this.presence).pipe(Effect.provide(this.layers)),
			)
			ws.send(JSON.stringify(result))
			await this.broadcastBoardState()
		} catch (error) {
			let opId = "unknown"
			try {
				opId = JSON.parse(message).opId ?? "unknown"
			} catch {}
			ws.send(
				JSON.stringify({
					type: "op:error",
					opId,
					code: "OPERATION_FAILED",
					message: error instanceof Error ? error.message : "Unknown error",
				}),
			)
		}
	}

	async webSocketClose(ws: WebSocket) {
		const connState = this.connections.get(ws)
		if (connState?.actorId) {
			this.presence.remove(connState.actorId)
		}
		this.connections.delete(ws)
	}

	async webSocketError(ws: WebSocket) {
		this.connections.delete(ws)
	}

	private json(data: unknown, status = 200) {
		return new Response(JSON.stringify(data), {
			status,
			headers: { "Content-Type": "application/json" },
		})
	}
}
