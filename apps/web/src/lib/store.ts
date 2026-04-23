import { create } from "zustand"
import { nanoid } from "nanoid"
import type { Board, Card, Column, ActorId } from "@kangent/board-core"

interface PresenceActor {
	id: string
	status: "viewing" | "working" | "idle"
	cursor?: { cardId: string }
	message?: string
	lastSeenAt?: number
}

interface PendingOp {
	opId: string
	type: string
	rollback: () => void
}

export interface BoardStore {
	board: Board | null
	cards: Map<string, Card>
	version: number
	connected: boolean
	presence: PresenceActor[]
	pendingOps: Map<string, PendingOp>
	actorId: string

	setBoard: (board: Board, cards: Card[]) => void
	setConnected: (connected: boolean) => void
	setVersion: (version: number) => void
	setPresence: (actors: PresenceActor[]) => void

	addCard: (columnId: string, title: string, description?: unknown) => string
	updateCard: (cardId: string, updates: { title?: string; description?: unknown }) => void
	moveCard: (cardId: string, toColumnId: string, position: number) => void
	deleteCard: (cardId: string) => void
	addColumn: (title: string) => string
	updateColumn: (columnId: string, title: string) => void
	deleteColumn: (columnId: string, moveCardsTo?: string) => void
	reorderColumns: (columnIds: string[]) => void

	applyRemoteOp: (op: any, version: number) => void
	ackOp: (opId: string, version: number) => void
	rollbackOp: (opId: string) => void
}

export const useBoardStore = create<BoardStore>((set, get) => ({
	board: null,
	cards: new Map(),
	version: 0,
	connected: false,
	presence: [],
	pendingOps: new Map(),
	actorId: `human:${nanoid(6)}`,

	setBoard: (board, cards) =>
		set({
			board,
			cards: new Map(cards.map((c) => [c.id, c])),
			version: board.version,
		}),

	setConnected: (connected) => set({ connected }),
	setVersion: (version) => set({ version }),
	setPresence: (actors) =>
		set((s) => {
			const now = Date.now()
			const incomingIds = new Set(actors.map((a) => a.id))
			const stamped = actors.map((a) => ({ ...a, lastSeenAt: now }))
			// Preserve departed actors with their last-seen timestamp so UI can fade them out after 3 min
			for (const old of s.presence) {
				if (!incomingIds.has(old.id) && old.lastSeenAt) {
					stamped.push({ ...old, lastSeenAt: old.lastSeenAt })
				}
			}
			return { presence: stamped }
		}),

	addCard: (columnId, title, description) => {
		const cardId = `temp_${nanoid(8)}`
		const now = new Date().toISOString()
		const state = get()
		const board = state.board
		if (!board) return cardId

		const col = board.columns.find((c) => c.id === columnId)
		if (!col) return cardId

		const card: Card = {
			id: cardId,
			columnId,
			title,
			description: description ?? null,
			position: col.cardIds.length,
			createdBy: state.actorId as any,
			createdAt: now,
			updatedAt: now,
		} as Card

		const oldCards = new Map(state.cards)
		const oldBoard = state.board

		set((s) => {
			const newCards = new Map(s.cards)
			newCards.set(cardId, card)
			return {
				cards: newCards,
				board: s.board
					? {
							...s.board,
							columns: s.board.columns.map((c) =>
								c.id === columnId
									? ({ ...c, cardIds: [...c.cardIds, cardId] } as Column)
									: c,
							),
						} as Board
					: null,
			}
		})

		return cardId
	},

	updateCard: (cardId, updates) => {
		set((s) => {
			const existing = s.cards.get(cardId)
			if (!existing) return s
			const updated = {
				...existing,
				...updates,
				updatedAt: new Date().toISOString(),
			} as Card
			const newCards = new Map(s.cards)
			newCards.set(cardId, updated)
			return { cards: newCards }
		})
	},

	moveCard: (cardId, toColumnId, position) => {
		set((s) => {
			const card = s.cards.get(cardId)
			if (!card || !s.board) return s

			const newCards = new Map(s.cards)
			newCards.set(cardId, { ...card, columnId: toColumnId, position } as Card)

			const newColumns = s.board.columns.map((c) => {
				let cardIds = c.cardIds.filter((id) => id !== cardId)
				if (c.id === toColumnId) {
					const insertIdx = Math.min(Math.max(0, Math.round(position)), cardIds.length)
					cardIds = [...cardIds.slice(0, insertIdx), cardId, ...cardIds.slice(insertIdx)]
				}
				return { ...c, cardIds } as Column
			})

			return {
				cards: newCards,
				board: { ...s.board, columns: newColumns } as Board,
			}
		})
	},

	deleteCard: (cardId) => {
		set((s) => {
			const newCards = new Map(s.cards)
			newCards.delete(cardId)
			return {
				cards: newCards,
				board: s.board
					? ({
							...s.board,
							columns: s.board.columns.map(
								(c) =>
									({
										...c,
										cardIds: c.cardIds.filter((id) => id !== cardId),
									}) as Column,
							),
						} as Board)
					: null,
			}
		})
	},

	addColumn: (title) => {
		const columnId = `temp_${nanoid(8)}`
		set((s) => {
			if (!s.board) return s
			const column: Column = {
				id: columnId,
				title,
				position: s.board.columns.length,
				cardIds: [],
			} as Column
			return {
				board: {
					...s.board,
					columns: [...s.board.columns, column],
				} as Board,
			}
		})
		return columnId
	},

	updateColumn: (columnId, title) => {
		set((s) => {
			if (!s.board) return s
			return {
				board: {
					...s.board,
					columns: s.board.columns.map((c) =>
						c.id === columnId ? ({ ...c, title } as Column) : c,
					),
				} as Board,
			}
		})
	},

	deleteColumn: (columnId, moveCardsTo) => {
		set((s) => {
			if (!s.board) return s
			const col = s.board.columns.find((c) => c.id === columnId)
			if (!col) return s

			const newCards = new Map(s.cards)
			if (moveCardsTo) {
				for (const cardId of col.cardIds) {
					const card = newCards.get(cardId)
					if (card) {
						newCards.set(cardId, { ...card, columnId: moveCardsTo } as Card)
					}
				}
			} else {
				for (const cardId of col.cardIds) {
					newCards.delete(cardId)
				}
			}

			return {
				cards: newCards,
				board: {
					...s.board,
					columns: s.board.columns
						.filter((c) => c.id !== columnId)
						.map((c) =>
							moveCardsTo && c.id === moveCardsTo
								? ({ ...c, cardIds: [...c.cardIds, ...col.cardIds] } as Column)
								: c,
						),
				} as Board,
			}
		})
	},

	reorderColumns: (columnIds) => {
		set((s) => {
			if (!s.board) return s
			const byId = new Map(s.board.columns.map((c) => [c.id, c]))
			const reordered = columnIds
				.map((id, i) => {
					const col = byId.get(id)
					return col ? ({ ...col, position: i } as Column) : undefined
				})
				.filter((c): c is Column => c !== undefined)
			return { board: { ...s.board, columns: reordered } as Board }
		})
	},

	applyRemoteOp: (op, version) => {
		const state = get()
		if (state.pendingOps.has(op.opId)) return

		switch (op.type) {
			case "card:add":
			case "card:update":
			case "card:move":
			case "card:delete":
			case "column:add":
			case "column:update":
			case "column:delete":
			case "column:reorder":
				// For remote ops, we'd need full state reconciliation.
				// For now, just update the version.
				set({ version })
				break
		}
	},

	ackOp: (opId, version) => {
		set((s) => {
			const newPending = new Map(s.pendingOps)
			newPending.delete(opId)
			return { pendingOps: newPending, version }
		})
	},

	rollbackOp: (opId) => {
		const state = get()
		const op = state.pendingOps.get(opId)
		if (op) {
			op.rollback()
			set((s) => {
				const newPending = new Map(s.pendingOps)
				newPending.delete(opId)
				return { pendingOps: newPending }
			})
		}
	},

}))
