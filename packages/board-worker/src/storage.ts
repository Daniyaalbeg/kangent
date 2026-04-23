import { Effect, Layer } from "effect"
import {
	type AddCardParams,
	type AppendChangeParams,
	type Board,
	BoardNotFound,
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
	BoardStorage as BoardStorageTag,
} from "@kangent/board-core"
import { nanoid } from "nanoid"

// Keep the last N changelog entries per board. Entries older than this are
// pruned on append. Agents whose cursor falls below the retained floor get
// an isFirstSync response and rebuild from the full board snapshot.
const CHANGELOG_RETENTION = 500

// Lexically-sortable key for a change. DO storage.list returns keys in string
// order, so we zero-pad so numeric order matches string order up to 10^12 - 1.
const changeKey = (version: number) =>
	`changelog:${String(version).padStart(12, "0")}`
const cursorKey = (agentId: string) => `cursor:${agentId}`

const doGet = (storage: DurableObjectStorage, key: string) =>
	Effect.tryPromise(() => storage.get(key)).pipe(Effect.orDie)

const doPut = (storage: DurableObjectStorage, keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
	Effect.tryPromise(() =>
		typeof keyOrEntries === "string"
			? storage.put(keyOrEntries, value)
			: storage.put(keyOrEntries),
	).pipe(Effect.orDie)

const doDelete = (storage: DurableObjectStorage, key: string) =>
	Effect.tryPromise(() => storage.delete(key)).pipe(Effect.orDie)

const doList = (storage: DurableObjectStorage, options: DurableObjectListOptions) =>
	Effect.tryPromise(() => storage.list(options)).pipe(Effect.orDie)

export const makeStorageLayer = (storage: DurableObjectStorage) =>
	Layer.succeed(BoardStorageTag, {
		getBoard: () =>
			Effect.gen(function* () {
				const meta = yield* doGet(storage, "board:meta")
				if (!meta) return yield* Effect.fail(new BoardNotFound({ boardId: "unknown" }))
				const columnsRaw = yield* doGet(storage, "board:columns")
				const columns = (columnsRaw ?? []) as Column[]
				return { ...(meta as any), columns } as Board
			}),

		createBoard: (params: CreateBoardParams) =>
			Effect.gen(function* () {
				const id = nanoid(12)
				const now = new Date().toISOString()
				const columnTitles = params.columns ?? [...DEFAULT_COLUMNS]
				const columns = columnTitles.map(
					(title, i) =>
						({ id: nanoid(8), title, position: i, cardIds: [] }) as Column,
				)
				const meta = {
					id,
					title: params.title,
					description: params.description,
					createdAt: now,
					updatedAt: now,
					createdBy: params.by,
					version: 0,
				}
				yield* doPut(storage, { "board:meta": meta, "board:columns": columns })
				return { ...meta, columns } as unknown as Board
			}),

		updateBoardMeta: (meta) =>
			Effect.gen(function* () {
				const existing = yield* doGet(storage, "board:meta")
				if (!existing) return yield* Effect.fail(new BoardNotFound({ boardId: "unknown" }))
				const updated = { ...(existing as any), ...meta, updatedAt: new Date().toISOString() }
				yield* doPut(storage, "board:meta", updated)
				const columns = ((yield* doGet(storage, "board:columns")) ?? []) as Column[]
				return { ...updated, columns } as Board
			}),

		getCard: (cardId) =>
			Effect.gen(function* () {
				const card = yield* doGet(storage, `card:${cardId}`)
				if (!card) return yield* Effect.fail(new CardNotFound({ cardId }))
				return card as Card
			}),

		getCards: () =>
			Effect.gen(function* () {
				const entries = yield* doList(storage, { prefix: "card:" })
				return Array.from(entries.values()) as Card[]
			}),

		addCard: (params: AddCardParams) =>
			Effect.gen(function* () {
				const columns = ((yield* doGet(storage, "board:columns")) ?? []) as Column[]
				const col = columns.find((c) => c.id === params.columnId)
				if (!col) return yield* Effect.fail(new ColumnNotFound({ columnId: params.columnId }))

				const cardId = nanoid(8)
				const now = new Date().toISOString()
				const card: Card = {
					id: cardId,
					columnId: params.columnId,
					title: params.title,
					description: params.description ?? null,
					position: col.cardIds.length,
					createdBy: params.by,
					createdAt: now,
					updatedAt: now,
				} as Card

				const updatedCol = { ...col, cardIds: [...col.cardIds, cardId] }
				const updatedColumns = columns.map((c) => (c.id === col.id ? updatedCol : c))
				yield* doPut(storage, { [`card:${cardId}`]: card, "board:columns": updatedColumns })
				return card
			}),

		updateCard: (cardId, updates: CardUpdates) =>
			Effect.gen(function* () {
				const existing = yield* doGet(storage, `card:${cardId}`)
				if (!existing) return yield* Effect.fail(new CardNotFound({ cardId }))
				const card = existing as Card
				const updated = {
					...card,
					...(updates.title !== undefined ? { title: updates.title } : {}),
					...(updates.description !== undefined ? { description: updates.description } : {}),
					updatedAt: new Date().toISOString(),
				} as Card
				yield* doPut(storage, `card:${cardId}`, updated)
				return updated
			}),

		moveCard: (cardId, toColumnId, position) =>
			Effect.gen(function* () {
				const existing = yield* doGet(storage, `card:${cardId}`)
				if (!existing) return yield* Effect.fail(new CardNotFound({ cardId }))
				const card = existing as Card

				const columns = ((yield* doGet(storage, "board:columns")) ?? []) as Column[]
				const targetCol = columns.find((c) => c.id === toColumnId)
				if (!targetCol) return yield* Effect.fail(new ColumnNotFound({ columnId: toColumnId }))

				const updatedColumns = columns.map((c) => {
					let cardIds = c.cardIds.filter((id) => id !== cardId)
					if (c.id === toColumnId) {
						const insertIdx = Math.min(Math.max(0, Math.round(position)), cardIds.length)
						cardIds = [...cardIds.slice(0, insertIdx), cardId, ...cardIds.slice(insertIdx)]
					}
					return { ...c, cardIds }
				})

				const updated = {
					...card,
					columnId: toColumnId,
					position,
					updatedAt: new Date().toISOString(),
				} as Card
				yield* doPut(storage, { [`card:${cardId}`]: updated, "board:columns": updatedColumns })
				return updated
			}),

		deleteCard: (cardId) =>
			Effect.gen(function* () {
				const existing = yield* doGet(storage, `card:${cardId}`)
				if (!existing) return yield* Effect.fail(new CardNotFound({ cardId }))

				const columns = ((yield* doGet(storage, "board:columns")) ?? []) as Column[]
				const updatedColumns = columns.map(
					(c) => ({ ...c, cardIds: c.cardIds.filter((id) => id !== cardId) }),
				)
				yield* doDelete(storage, `card:${cardId}`)
				yield* doPut(storage, "board:columns", updatedColumns)
			}),

		addColumn: (title) =>
			Effect.gen(function* () {
				const columns = ((yield* doGet(storage, "board:columns")) ?? []) as Column[]
				const column: Column = {
					id: nanoid(8),
					title,
					position: columns.length,
					cardIds: [],
				} as Column
				yield* doPut(storage, "board:columns", [...columns, column])
				return column
			}),

		updateColumn: (columnId, title) =>
			Effect.gen(function* () {
				const columns = ((yield* doGet(storage, "board:columns")) ?? []) as Column[]
				const col = columns.find((c) => c.id === columnId)
				if (!col) return yield* Effect.fail(new ColumnNotFound({ columnId }))
				const updated = { ...col, title }
				yield* doPut(storage, "board:columns", columns.map((c) => (c.id === columnId ? updated : c)))
				return updated as Column
			}),

		deleteColumn: (columnId, moveCardsTo?) =>
			Effect.gen(function* () {
				const columns = ((yield* doGet(storage, "board:columns")) ?? []) as Column[]
				const col = columns.find((c) => c.id === columnId)
				if (!col) return yield* Effect.fail(new ColumnNotFound({ columnId }))

				if (col.cardIds.length > 0 && !moveCardsTo) {
					return yield* Effect.fail(
						new ColumnNotEmpty({ columnId, cardCount: col.cardIds.length }),
					)
				}

				let cardsMoved = 0
				if (moveCardsTo && col.cardIds.length > 0) {
					const targetCol = columns.find((c) => c.id === moveCardsTo)
					if (!targetCol)
						return yield* Effect.fail(new ColumnNotFound({ columnId: moveCardsTo }))

					cardsMoved = col.cardIds.length
					const cardUpdates: Record<string, unknown> = {}
					for (const cardId of col.cardIds) {
						const card = (yield* doGet(storage, `card:${cardId}`)) as Card
						if (card) {
							cardUpdates[`card:${cardId}`] = { ...card, columnId: moveCardsTo }
						}
					}
					if (Object.keys(cardUpdates).length > 0) {
						yield* doPut(storage, cardUpdates)
					}

					const remaining = columns
						.filter((c) => c.id !== columnId)
						.map((c) =>
							c.id === moveCardsTo
								? { ...c, cardIds: [...c.cardIds, ...col.cardIds] }
								: c,
						)
						.map((c, i) => ({ ...c, position: i }))
					yield* doPut(storage, "board:columns", remaining)
				} else {
					const remaining = columns
						.filter((c) => c.id !== columnId)
						.map((c, i) => ({ ...c, position: i }))
					yield* doPut(storage, "board:columns", remaining)
				}

				return { cardsMoved }
			}),

		reorderColumns: (columnIds) =>
			Effect.gen(function* () {
				const columns = ((yield* doGet(storage, "board:columns")) ?? []) as Column[]
				const byId = new Map(columns.map((c) => [c.id, c]))
				const reordered = columnIds
					.map((id, i) => {
						const col = byId.get(id)
						return col ? { ...col, position: i } : undefined
					})
					.filter((c): c is Column => c !== undefined)
				yield* doPut(storage, "board:columns", reordered)
			}),

		incrementVersion: () =>
			Effect.gen(function* () {
				const meta = (yield* doGet(storage, "board:meta")) as any
				if (!meta) return 0
				const newVersion = (meta.version ?? 0) + 1
				yield* doPut(storage, "board:meta", { ...meta, version: newVersion })
				return newVersion
			}),

		appendChange: (params: AppendChangeParams) =>
			Effect.gen(function* () {
				const entry: Change = {
					version: params.version,
					op: params.op,
					cardId: params.cardId,
					columnId: params.columnId,
					fromColumnId: params.fromColumnId,
					snapshot: params.snapshot,
					by: params.by as Change["by"],
					at: new Date().toISOString(),
				} as Change
				yield* doPut(storage, changeKey(params.version), entry)

				// Prune: if we've exceeded retention, drop the oldest excess entries.
				const all = yield* doList(storage, { prefix: "changelog:" })
				if (all.size > CHANGELOG_RETENTION) {
					const toPrune = all.size - CHANGELOG_RETENTION
					const iter = all.keys()
					for (let i = 0; i < toPrune; i++) {
						const next = iter.next()
						if (next.done) break
						yield* doDelete(storage, next.value)
					}
				}
			}),

		readChanges: (afterVersion: number, limit: number) =>
			Effect.gen(function* () {
				const all = yield* doList(storage, { prefix: "changelog:" })
				const entries = Array.from(all.values()) as Change[]

				// Empty changelog: either no mutations yet or retention dropped everything.
				if (entries.length === 0) {
					const meta = (yield* doGet(storage, "board:meta")) as any
					const toVersion = (meta?.version ?? 0) as number
					return {
						fromVersion: toVersion + 1,
						toVersion,
						// afterVersion=0 is the sentinel meaning "never seen anything before";
						// that's the first-sync case. If afterVersion > 0 but we have no
						// entries at all, the agent is still ahead of us — treat as no-op.
						isFirstSync: afterVersion === 0 && toVersion > 0,
						changes: [],
					}
				}

				const oldestVersion = entries[0]!.version
				const newest = entries[entries.length - 1]!
				const toVersion = newest.version

				// Agent's cursor fell below retention: we can't fill the gap; force resync.
				if (afterVersion > 0 && afterVersion < oldestVersion - 1) {
					return {
						fromVersion: oldestVersion,
						toVersion,
						isFirstSync: true,
						changes: [],
					}
				}

				// First visit: return everything we have, agent will also receive the
				// full board snapshot from the handler layer.
				if (afterVersion === 0) {
					return {
						fromVersion: oldestVersion,
						toVersion,
						isFirstSync: true,
						changes: [],
					}
				}

				const slice = entries
					.filter((c) => c.version > afterVersion)
					.slice(0, limit)
				const result: ChangeFeedRead = {
					fromVersion: slice.length > 0 ? slice[0]!.version : afterVersion + 1,
					toVersion,
					isFirstSync: false,
					changes: slice,
				}
				return result
			}),

		getAgentCursor: (agentId: string) =>
			Effect.gen(function* () {
				const v = yield* doGet(storage, cursorKey(agentId))
				return typeof v === "number" ? v : undefined
			}),

		setAgentCursor: (agentId: string, version: number) =>
			Effect.gen(function* () {
				yield* doPut(storage, cursorKey(agentId), version)
			}),
	})
