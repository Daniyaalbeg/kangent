/**
 * Local board history backed by IndexedDB.
 *
 * Why IndexedDB over localStorage:
 *  - Survives Safari's 7-day localStorage eviction (we ask for persistent storage).
 *  - Async, non-blocking, transactional — safe under concurrent tab writes.
 *  - Indexed queries: `lastAccessedAt` index lets us read recents in sort order.
 *  - Headroom to cache board snapshots later without rework.
 *
 * The store is keyed by board id. `origin` is sticky:
 *  - First write wins between `'created'` and `'visited'`.
 *  - A user who created a board never gets downgraded to a visitor on re-visit.
 *  - A user who visited someone else's board does not get promoted if they
 *    happen to re-call recordBoardAccess with `'created'` later.
 */

const DB_NAME = "kangent"
const DB_VERSION = 1
const STORE = "boardHistory"
const INDEX_LAST_ACCESSED = "lastAccessedAt"
const BROADCAST_CHANNEL = "kangent:board-history"
const HISTORY_CHANGED_EVENT = "kangent:board-history-changed"

export type BoardOrigin = "created" | "visited"

export interface BoardHistoryEntry {
	id: string
	title: string
	origin: BoardOrigin
	firstAccessedAt: number
	lastAccessedAt: number
	visitCount: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null
let persistRequested: Promise<boolean> | null = null

function isIDBAvailable(): boolean {
	try {
		return typeof indexedDB !== "undefined"
	} catch {
		return false
	}
}

function openDB(): Promise<IDBDatabase | null> {
	if (dbPromise) return dbPromise
	if (!isIDBAvailable()) {
		dbPromise = Promise.resolve(null)
		return dbPromise
	}
	dbPromise = new Promise<IDBDatabase | null>((resolve) => {
		let req: IDBOpenDBRequest
		try {
			req = indexedDB.open(DB_NAME, DB_VERSION)
		} catch (err) {
			console.warn("[kangent] indexedDB.open threw", err)
			resolve(null)
			return
		}
		req.onupgradeneeded = () => {
			const db = req.result
			if (!db.objectStoreNames.contains(STORE)) {
				const store = db.createObjectStore(STORE, { keyPath: "id" })
				store.createIndex(INDEX_LAST_ACCESSED, "lastAccessedAt", { unique: false })
			}
		}
		req.onsuccess = () => {
			const db = req.result
			// If another tab triggers a version change, close this connection
			// so the upgrade can proceed and we'll re-open lazily.
			db.onversionchange = () => {
				db.close()
				dbPromise = null
			}
			resolve(db)
		}
		req.onerror = () => {
			console.warn("[kangent] failed to open board history DB", req.error)
			resolve(null)
		}
		req.onblocked = () => {
			console.warn("[kangent] board history DB upgrade blocked")
			resolve(null)
		}
	})
	return dbPromise
}

type StoreOp<T> = (store: IDBObjectStore) => T | Promise<T>

function withStore<T>(mode: IDBTransactionMode, op: StoreOp<T>): Promise<T | null> {
	return openDB().then((db) => {
		if (!db) return null
		return new Promise<T | null>((resolve) => {
			let result: T | null = null
			let tx: IDBTransaction
			try {
				tx = db.transaction(STORE, mode)
			} catch (err) {
				console.warn("[kangent] failed to open transaction", err)
				resolve(null)
				return
			}
			const store = tx.objectStore(STORE)
			Promise.resolve(op(store))
				.then((value) => {
					result = value as T
				})
				.catch((err) => {
					console.warn("[kangent] board history op failed", err)
				})
			tx.oncomplete = () => resolve(result)
			tx.onerror = () => resolve(null)
			tx.onabort = () => resolve(null)
		})
	})
}

/**
 * Best-effort request for durable storage. Browsers grant this freely once
 * the user has interacted with the site; failures are harmless.
 */
function requestPersistentStorage(): Promise<boolean> {
	if (persistRequested) return persistRequested
	if (typeof navigator === "undefined" || !navigator.storage?.persist) {
		persistRequested = Promise.resolve(false)
		return persistRequested
	}
	persistRequested = navigator.storage.persist().catch(() => false)
	return persistRequested
}

function notifyChanged(): void {
	if (typeof window === "undefined") return
	window.dispatchEvent(new Event(HISTORY_CHANGED_EVENT))
	try {
		const bc = new BroadcastChannel(BROADCAST_CHANNEL)
		bc.postMessage("changed")
		bc.close()
	} catch {
		// BroadcastChannel unavailable in this environment — same-tab event still fires.
	}
}

/**
 * Record that the current user touched a board. Called both when creating
 * (`'created'`) and when navigating into one (`'visited'`).
 *
 * Origin precedence: existing 'created' is never overwritten by a later 'visited'.
 */
export async function recordBoardAccess(
	boardId: string,
	title: string | null | undefined,
	origin: BoardOrigin,
): Promise<void> {
	if (!boardId) return
	const safeTitle = (title ?? "").trim() || "Untitled board"

	await withStore("readwrite", (store) => {
		return new Promise<void>((resolve) => {
			const getReq = store.get(boardId)
			getReq.onsuccess = () => {
				const now = Date.now()
				const existing = getReq.result as BoardHistoryEntry | undefined
				const next: BoardHistoryEntry = existing
					? {
							...existing,
							// Refresh title only if we have a real one — avoids overwriting a known
							// title with a placeholder if the caller didn't have it yet.
							title: title ? safeTitle : existing.title,
							origin: existing.origin === "created" ? "created" : origin,
							lastAccessedAt: now,
							visitCount: existing.visitCount + 1,
						}
					: {
							id: boardId,
							title: safeTitle,
							origin,
							firstAccessedAt: now,
							lastAccessedAt: now,
							visitCount: 1,
						}
				store.put(next)
				resolve()
			}
			getReq.onerror = () => resolve()
		})
	})

	notifyChanged()
	void requestPersistentStorage()
}

/**
 * Read recent boards in descending lastAccessedAt order.
 * Returns [] on any failure (no IDB, blocked, etc.).
 */
export async function getRecentBoards(limit = 25): Promise<BoardHistoryEntry[]> {
	const result = await withStore("readonly", (store) => {
		return new Promise<BoardHistoryEntry[]>((resolve) => {
			const items: BoardHistoryEntry[] = []
			let cursorReq: IDBRequest<IDBCursorWithValue | null>
			try {
				cursorReq = store.index(INDEX_LAST_ACCESSED).openCursor(null, "prev")
			} catch (err) {
				console.warn("[kangent] failed to open history cursor", err)
				resolve(items)
				return
			}
			cursorReq.onsuccess = () => {
				const cursor = cursorReq.result
				if (!cursor || items.length >= limit) {
					resolve(items)
					return
				}
				items.push(cursor.value as BoardHistoryEntry)
				cursor.continue()
			}
			cursorReq.onerror = () => resolve(items)
		})
	})
	return result ?? []
}

export async function removeBoardFromHistory(boardId: string): Promise<void> {
	if (!boardId) return
	await withStore("readwrite", (store) => {
		store.delete(boardId)
	})
	notifyChanged()
}

export async function clearBoardHistory(): Promise<void> {
	await withStore("readwrite", (store) => {
		store.clear()
	})
	notifyChanged()
}

export const boardHistoryEvents = {
	CHANGED: HISTORY_CHANGED_EVENT,
	BROADCAST_CHANNEL,
}
