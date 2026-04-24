import {
	Agent,
	type Connection,
	type ConnectionContext,
	type WSMessage,
	callable,
} from "agents"
import {
	type AddCardParams,
	type AppendChangeParams,
	BoardNotFound,
	type Board,
	type BoardSnapshot,
	type Card,
	CardNotFound,
	type CardUpdates,
	type Change,
	type ChangeFeedRead,
	type Column,
	ColumnNotEmpty,
	ColumnNotFound,
	type CreateBoardParams,
	DEFAULT_COLUMNS,
} from "@kangent/board-core"
import { nanoid } from "nanoid"

const CHANGELOG_RETENTION = 500
const PRESENCE_TTL_MS = 3 * 60 * 1000

const changeKey = (version: number) =>
	`changelog:${String(version).padStart(12, "0")}`
const cursorKey = (agentId: string) => `cursor:${agentId}`

export interface PresenceActor {
	id: string
	status: "viewing" | "working" | "idle"
	cursor?: { cardId: string }
	message?: string
	lastSeenAt: number
}

export interface BoardAgentState {
	board: Board | null
	cards: Card[]
	presence: PresenceActor[]
}

type BoardConnectionState = {
	actorId: string
}

export class BoardAgent extends Agent<Cloudflare.Env, BoardAgentState> {
	initialState: BoardAgentState = {
		board: null,
		cards: [],
		presence: [],
	}

	private get boardId() {
		return this.name
	}

	async initializeBoard(params: CreateBoardParams) {
		if (this.state.board) {
			return this.state.board
		}

		const now = new Date().toISOString()
		const columnTitles = params.columns ?? [...DEFAULT_COLUMNS]
		const columns = columnTitles.map(
			(title, index) =>
				({
					id: nanoid(8),
					title,
					position: index,
					cardIds: [],
				}) as Column,
		)
		const board = {
			id: this.boardId,
			title: params.title,
			description: params.description,
			columns,
			createdAt: now,
			updatedAt: now,
			createdBy: params.by as Board["createdBy"],
			version: 0,
		} as Board

		this.setState({
			board,
			cards: [],
			presence: [],
		})

		return board
	}

	onConnect(connection: Connection<BoardConnectionState>, ctx: ConnectionContext) {
		const url = new URL(ctx.request.url)
		const actorId = url.searchParams.get("actorId")?.trim() || `human:${connection.id}`
		connection.setState({ actorId })
		this.upsertPresence(actorId, { status: "viewing" })
	}

	onMessage(_connection: Connection<BoardConnectionState>, _message: WSMessage) {
		// The Agents SDK handles RPC and state-sync protocol messages for us.
	}

	onClose(connection: Connection<BoardConnectionState>) {
		const actorId = connection.state?.actorId
		if (!actorId) return
		this.removePresence(actorId)
	}

	async onRequest(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url)
			const tail = this.getBoardPath(url.pathname)

			if (tail === "/live") {
				return this.json({ ok: true })
			}

			if (tail === "/state" && request.method === "GET") {
				const snapshot = this.requireSnapshot()
				return this.json({
					board: { ...snapshot.board, cards: snapshot.cards },
					presence: this.prunePresence(this.state.presence),
				})
			}

			if (tail === "/changes" && request.method === "GET") {
				return this.handleChangesRequest(request, url)
			}

			if (tail === "/cards" && request.method === "POST") {
				const body = (await request.json()) as AddCardParams
				const { card, version } = await this.addCardInternal({
					columnId: body.columnId,
					title: body.title,
					description: body.description,
					by: body.by ?? "ai:unknown",
				})
				return this.json({ card, version }, 201)
			}

			const cardPatch = tail.match(/^\/cards\/([^/]+)$/)
			if (cardPatch && request.method === "PATCH") {
				const cardId = decodeURIComponent(cardPatch[1]!)
				const body = (await request.json()) as {
					title?: string
					description?: unknown
					by?: string
				}
				const { card, version } = await this.updateCardInternal(cardId, {
					title: body.title,
					description: body.description,
					by: body.by ?? "ai:unknown",
				})
				return this.json({ card, version })
			}

			const cardMove = tail.match(/^\/cards\/([^/]+)\/move$/)
			if (cardMove && request.method === "POST") {
				const cardId = decodeURIComponent(cardMove[1]!)
				const body = (await request.json()) as {
					toColumnId: string
					position: number
					by?: string
				}
				const { card, version } = await this.moveCardInternal(cardId, {
					toColumnId: body.toColumnId,
					position: body.position,
					by: body.by ?? "ai:unknown",
				})
				return this.json({ card, version })
			}

			const cardDelete = tail.match(/^\/cards\/([^/]+)$/)
			if (cardDelete && request.method === "DELETE") {
				const cardId = decodeURIComponent(cardDelete[1]!)
				const by = url.searchParams.get("by") ?? "ai:unknown"
				const { version } = await this.deleteCardInternal(cardId, by)
				return this.json({ deleted: cardId, version })
			}

			if (tail === "/columns" && request.method === "POST") {
				const body = (await request.json()) as { title: string; by?: string }
				const { column, version } = await this.addColumnInternal(
					body.title,
					body.by ?? "ai:unknown",
				)
				return this.json({ column, version }, 201)
			}

			const columnPatch = tail.match(/^\/columns\/([^/]+)$/)
			if (columnPatch && request.method === "PATCH") {
				const columnId = decodeURIComponent(columnPatch[1]!)
				const body = (await request.json()) as { title: string; by?: string }
				const { column, version } = await this.updateColumnInternal(
					columnId,
					body.title,
					body.by ?? "ai:unknown",
				)
				return this.json({ column, version })
			}

			const columnDelete = tail.match(/^\/columns\/([^/]+)$/)
			if (columnDelete && request.method === "DELETE") {
				const columnId = decodeURIComponent(columnDelete[1]!)
				const moveCardsTo = url.searchParams.get("moveCardsTo") ?? undefined
				const by = url.searchParams.get("by") ?? "ai:unknown"
				const { cardsMoved, version } = await this.deleteColumnInternal(
					columnId,
					moveCardsTo,
					by,
				)
				return this.json({ deleted: columnId, cardsMoved, version })
			}

			if (tail === "/presence" && request.method === "POST") {
				const body = (await request.json()) as {
					by: string
					status: "viewing" | "working" | "idle"
					message?: string
					cursor?: { cardId: string }
				}
				this.upsertPresence(body.by, {
					status: body.status,
					message: body.message,
					cursor: body.cursor,
				})
				return this.json({ ok: true })
			}

			return this.json({ error: "Not found" }, 404)
		} catch (error) {
			return this.handleError(error)
		}
	}

	@callable()
	async addCard(params: AddCardParams) {
		return this.addCardInternal(params)
	}

	@callable()
	async updateCard(
		cardId: string,
		updates: CardUpdates & { by?: string },
	) {
		return this.updateCardInternal(cardId, {
			title: updates.title,
			description: updates.description,
			by: updates.by ?? "human:anonymous",
		})
	}

	@callable()
	async moveCard(
		cardId: string,
		params: { toColumnId: string; position: number; by?: string },
	) {
		return this.moveCardInternal(cardId, {
			toColumnId: params.toColumnId,
			position: params.position,
			by: params.by ?? "human:anonymous",
		})
	}

	@callable()
	async deleteCard(cardId: string, by?: string) {
		return this.deleteCardInternal(cardId, by ?? "human:anonymous")
	}

	@callable()
	async addColumn(title: string, by?: string) {
		return this.addColumnInternal(title, by ?? "human:anonymous")
	}

	@callable()
	async updateColumn(columnId: string, title: string, by?: string) {
		return this.updateColumnInternal(columnId, title, by ?? "human:anonymous")
	}

	@callable()
	async deleteColumn(columnId: string, moveCardsTo?: string, by?: string) {
		return this.deleteColumnInternal(columnId, moveCardsTo, by ?? "human:anonymous")
	}

	@callable()
	async updatePresence(params: {
		by: string
		status: "viewing" | "working" | "idle"
		message?: string
		cursor?: { cardId: string }
	}) {
		this.upsertPresence(params.by, {
			status: params.status,
			message: params.message,
			cursor: params.cursor,
		})
		return { ok: true }
	}

	private getBoardPath(pathname: string) {
		const match = pathname.match(/^\/api\/boards\/[^/]+(\/.*)?$/)
		return match?.[1] ?? ""
	}

	private requireSnapshot(): BoardSnapshot {
		const board = this.state.board
		if (!board) {
			throw new BoardNotFound({ boardId: this.boardId })
		}

		return {
			board,
			cards: this.state.cards,
		} as BoardSnapshot
	}

	private prunePresence(presence: PresenceActor[]) {
		const now = Date.now()
		return presence.filter((entry) => now - entry.lastSeenAt < PRESENCE_TTL_MS)
	}

	private upsertPresence(
		actorId: string,
		update: Omit<PresenceActor, "id" | "lastSeenAt">,
	) {
		const nextPresence = this.prunePresence(this.state.presence).filter(
			(entry) => entry.id !== actorId,
		)
		nextPresence.push({
			id: actorId,
			lastSeenAt: Date.now(),
			...update,
		})
		this.setState({
			...this.state,
			presence: nextPresence,
		})
	}

	private removePresence(actorId: string) {
		const nextPresence = this.prunePresence(this.state.presence).filter(
			(entry) => entry.id !== actorId,
		)
		if (nextPresence.length === this.state.presence.length) return
		this.setState({
			...this.state,
			presence: nextPresence,
		})
	}

	private async handleChangesRequest(request: Request, url: URL) {
		this.requireSnapshot()
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

		const sinceParam = url.searchParams.get("since")
		const overrideSince =
			sinceParam !== null && !Number.isNaN(Number(sinceParam))
				? Math.max(0, Number(sinceParam))
				: undefined
		const ack = url.searchParams.get("ack") !== "false"
		const storedCursor = await this.getAgentCursor(agentId)
		const afterVersion = overrideSince ?? storedCursor ?? 0
		const feed = await this.readChanges(afterVersion, 200)

		const snapshot =
			feed.isFirstSync && this.state.board
				? { board: this.state.board, cards: this.state.cards }
				: null

		if (ack && (feed.toVersion !== storedCursor || feed.isFirstSync)) {
			await this.setAgentCursor(agentId, feed.toVersion)
		}

		return this.json({
			toVersion: feed.toVersion,
			fromVersion: feed.fromVersion,
			isFirstSync: feed.isFirstSync,
			snapshot,
			changes: feed.changes,
		})
	}

	private async addCardInternal(params: AddCardParams) {
		const snapshot = this.requireSnapshot()
		const column = snapshot.board.columns.find((entry) => entry.id === params.columnId)
		if (!column) {
			throw new ColumnNotFound({ columnId: params.columnId })
		}

		const now = new Date().toISOString()
		const card = {
			id: nanoid(8),
			columnId: params.columnId,
			title: params.title,
			description: params.description ?? null,
			position: column.cardIds.length,
			createdBy: params.by,
			createdAt: now,
			updatedAt: now,
		} as Card
		const nextColumns = snapshot.board.columns.map((entry) =>
			entry.id === params.columnId
				? ({ ...entry, cardIds: [...entry.cardIds, card.id] }) as Column
				: entry,
		)
		const version = snapshot.board.version + 1
		const board = this.withBoardMeta(snapshot.board, { columns: nextColumns, version })

		this.setState({
			...this.state,
			board,
			cards: [...snapshot.cards, card],
			presence: this.prunePresence(this.state.presence),
		})

		await this.appendChange({
			version,
			op: "card:add",
			cardId: card.id,
			columnId: params.columnId,
			snapshot: card,
			by: params.by,
		})

		return { card, version }
	}

	private async updateCardInternal(
		cardId: string,
		updates: CardUpdates & { by: string },
	) {
		const snapshot = this.requireSnapshot()
		const existing = snapshot.cards.find((entry) => entry.id === cardId)
		if (!existing) {
			throw new CardNotFound({ cardId })
		}

		const card = {
			...existing,
			...(updates.title !== undefined ? { title: updates.title } : {}),
			...(updates.description !== undefined
				? { description: updates.description }
				: {}),
			updatedAt: new Date().toISOString(),
		} as Card
		const version = snapshot.board.version + 1
		const board = this.withBoardMeta(snapshot.board, { version })

		this.setState({
			...this.state,
			board,
			cards: snapshot.cards.map((entry) => (entry.id === cardId ? card : entry)),
			presence: this.prunePresence(this.state.presence),
		})

		await this.appendChange({
			version,
			op: "card:update",
			cardId,
			snapshot: card,
			by: updates.by,
		})

		return { card, version }
	}

	private async moveCardInternal(
		cardId: string,
		params: { toColumnId: string; position: number; by: string },
	) {
		const snapshot = this.requireSnapshot()
		const existing = snapshot.cards.find((entry) => entry.id === cardId)
		if (!existing) {
			throw new CardNotFound({ cardId })
		}

		const targetColumn = snapshot.board.columns.find(
			(entry) => entry.id === params.toColumnId,
		)
		if (!targetColumn) {
			throw new ColumnNotFound({ columnId: params.toColumnId })
		}

		const nextColumns = snapshot.board.columns.map((entry) => {
			let cardIds = entry.cardIds.filter((id) => id !== cardId)
			if (entry.id === params.toColumnId) {
				const insertIndex = Math.min(
					Math.max(0, Math.round(params.position)),
					cardIds.length,
				)
				cardIds = [
					...cardIds.slice(0, insertIndex),
					cardId,
					...cardIds.slice(insertIndex),
				]
			}
			return { ...entry, cardIds } as Column
		})
		const card = {
			...existing,
			columnId: params.toColumnId,
			position: params.position,
			updatedAt: new Date().toISOString(),
		} as Card
		const version = snapshot.board.version + 1
		const board = this.withBoardMeta(snapshot.board, { columns: nextColumns, version })

		this.setState({
			...this.state,
			board,
			cards: snapshot.cards.map((entry) => (entry.id === cardId ? card : entry)),
			presence: this.prunePresence(this.state.presence),
		})

		await this.appendChange({
			version,
			op: "card:move",
			cardId,
			columnId: params.toColumnId,
			fromColumnId: existing.columnId,
			snapshot: card,
			by: params.by,
		})

		return { card, version }
	}

	private async deleteCardInternal(cardId: string, by: string) {
		const snapshot = this.requireSnapshot()
		const existing = snapshot.cards.find((entry) => entry.id === cardId)
		if (!existing) {
			throw new CardNotFound({ cardId })
		}

		const nextColumns = snapshot.board.columns.map(
			(entry) =>
				({
					...entry,
					cardIds: entry.cardIds.filter((id) => id !== cardId),
				}) as Column,
		)
		const version = snapshot.board.version + 1
		const board = this.withBoardMeta(snapshot.board, { columns: nextColumns, version })

		this.setState({
			...this.state,
			board,
			cards: snapshot.cards.filter((entry) => entry.id !== cardId),
			presence: this.prunePresence(this.state.presence),
		})

		await this.appendChange({
			version,
			op: "card:delete",
			cardId,
			snapshot: null,
			by,
		})

		return { deleted: cardId, version }
	}

	private async addColumnInternal(title: string, by: string) {
		const snapshot = this.requireSnapshot()
		const column = {
			id: nanoid(8),
			title,
			position: snapshot.board.columns.length,
			cardIds: [],
		} as Column
		const version = snapshot.board.version + 1
		const board = this.withBoardMeta(snapshot.board, {
			columns: [...snapshot.board.columns, column],
			version,
		})

		this.setState({
			...this.state,
			board,
			cards: [...snapshot.cards],
			presence: this.prunePresence(this.state.presence),
		})

		await this.appendChange({
			version,
			op: "column:add",
			columnId: column.id,
			snapshot: column,
			by,
		})

		return { column, version }
	}

	private async updateColumnInternal(columnId: string, title: string, by: string) {
		const snapshot = this.requireSnapshot()
		const existing = snapshot.board.columns.find((entry) => entry.id === columnId)
		if (!existing) {
			throw new ColumnNotFound({ columnId })
		}

		const column = {
			...existing,
			title,
		} as Column
		const version = snapshot.board.version + 1
		const board = this.withBoardMeta(snapshot.board, {
			columns: snapshot.board.columns.map((entry) =>
				entry.id === columnId ? column : entry,
			),
			version,
		})

		this.setState({
			...this.state,
			board,
			cards: [...snapshot.cards],
			presence: this.prunePresence(this.state.presence),
		})

		await this.appendChange({
			version,
			op: "column:update",
			columnId,
			snapshot: column,
			by,
		})

		return { column, version }
	}

	private async deleteColumnInternal(
		columnId: string,
		moveCardsTo: string | undefined,
		by: string,
	) {
		const snapshot = this.requireSnapshot()
		const column = snapshot.board.columns.find((entry) => entry.id === columnId)
		if (!column) {
			throw new ColumnNotFound({ columnId })
		}

		if (column.cardIds.length > 0 && !moveCardsTo) {
			throw new ColumnNotEmpty({ columnId, cardCount: column.cardIds.length })
		}

		let cards = [...snapshot.cards]
		let cardsMoved = 0
		let nextColumns = snapshot.board.columns.filter((entry) => entry.id !== columnId)

		if (moveCardsTo && column.cardIds.length > 0) {
			const targetColumn = nextColumns.find((entry) => entry.id === moveCardsTo)
			if (!targetColumn) {
				throw new ColumnNotFound({ columnId: moveCardsTo })
			}

			cardsMoved = column.cardIds.length
			cards = snapshot.cards.map((entry) =>
				column.cardIds.includes(entry.id)
					? ({ ...entry, columnId: moveCardsTo, updatedAt: new Date().toISOString() }) as Card
					: entry,
			)
			nextColumns = nextColumns.map((entry) =>
				entry.id === moveCardsTo
					? ({
							...entry,
							cardIds: [...entry.cardIds, ...column.cardIds],
						}) as Column
					: entry,
			)
		}

		nextColumns = nextColumns.map(
			(entry, index) =>
				({
					...entry,
					position: index,
				}) as Column,
		)

		const version = snapshot.board.version + 1
		const board = this.withBoardMeta(snapshot.board, {
			columns: nextColumns,
			version,
		})

		this.setState({
			...this.state,
			board,
			cards,
			presence: this.prunePresence(this.state.presence),
		})

		await this.appendChange({
			version,
			op: "column:delete",
			columnId,
			snapshot: null,
			by,
		})

		return { deleted: columnId, cardsMoved, version }
	}

	private withBoardMeta(
		board: Board,
		updates: Partial<Board> & { version: number },
	) {
		return {
			...board,
			...updates,
			updatedAt: new Date().toISOString(),
		} as Board
	}

	private async appendChange(params: AppendChangeParams) {
		const entry = {
			version: params.version,
			op: params.op,
			cardId: params.cardId,
			columnId: params.columnId,
			fromColumnId: params.fromColumnId,
			snapshot: params.snapshot,
			by: params.by as Change["by"],
			at: new Date().toISOString(),
		} as Change
		await this.ctx.storage.put(changeKey(params.version), entry)

		const all = await this.ctx.storage.list({ prefix: "changelog:" })
		if (all.size <= CHANGELOG_RETENTION) return

		const toPrune = all.size - CHANGELOG_RETENTION
		const iterator = all.keys()
		for (let index = 0; index < toPrune; index++) {
			const next = iterator.next()
			if (next.done) break
			await this.ctx.storage.delete(next.value)
		}
	}

	private async readChanges(afterVersion: number, limit: number): Promise<ChangeFeedRead> {
		const all = await this.ctx.storage.list<Change>({ prefix: "changelog:" })
		const entries = Array.from(all.values()) as Change[]
		const toVersion = this.state.board?.version ?? 0

		if (entries.length === 0) {
			return {
				fromVersion: toVersion + 1,
				toVersion,
				isFirstSync: afterVersion === 0 && toVersion > 0,
				changes: [],
			}
		}

		const oldestVersion = entries[0]!.version
		const newest = entries[entries.length - 1]!

		if (afterVersion > 0 && afterVersion < oldestVersion - 1) {
			return {
				fromVersion: oldestVersion,
				toVersion: newest.version,
				isFirstSync: true,
				changes: [],
			}
		}

		if (afterVersion === 0) {
			return {
				fromVersion: oldestVersion,
				toVersion: newest.version,
				isFirstSync: true,
				changes: [],
			}
		}

		const changes = entries.filter((entry) => entry.version > afterVersion).slice(0, limit)
		return {
			fromVersion: changes.length > 0 ? changes[0]!.version : afterVersion + 1,
			toVersion: newest.version,
			isFirstSync: false,
			changes,
		}
	}

	private async getAgentCursor(agentId: string) {
		const value = await this.ctx.storage.get<number>(cursorKey(agentId))
		return typeof value === "number" ? value : undefined
	}

	private async setAgentCursor(agentId: string, version: number) {
		await this.ctx.storage.put(cursorKey(agentId), version)
	}

	private handleError(error: unknown) {
		const tag = (error as { _tag?: string } | null)?._tag
		if (tag === "BoardNotFound") {
			const typed = error as BoardNotFound
			return this.json({ _tag: tag, boardId: typed.boardId }, 404)
		}
		if (tag === "CardNotFound") {
			const typed = error as CardNotFound
			return this.json({ _tag: tag, cardId: typed.cardId }, 404)
		}
		if (tag === "ColumnNotFound") {
			const typed = error as ColumnNotFound
			return this.json({ _tag: tag, columnId: typed.columnId }, 404)
		}
		if (tag === "ColumnNotEmpty") {
			const typed = error as ColumnNotEmpty
			return this.json(
				{ _tag: tag, columnId: typed.columnId, cardCount: typed.cardCount },
				409,
			)
		}

		const message =
			error instanceof Error ? error.message : "Internal error"
		return this.json({ error: message }, 500)
	}

	private json(data: unknown, status = 200) {
		return new Response(JSON.stringify(data), {
			status,
			headers: { "Content-Type": "application/json" },
		})
	}
}
