import { useCallback, useEffect, useState } from "react"
import {
	type BoardHistoryEntry,
	boardHistoryEvents,
	clearBoardHistory,
	getRecentBoards,
	removeBoardFromHistory,
} from "~/lib/boardHistory"

interface UseBoardHistoryResult {
	boards: BoardHistoryEntry[]
	loaded: boolean
	refresh: () => Promise<void>
	remove: (boardId: string) => Promise<void>
	clear: () => Promise<void>
}

/**
 * Reactive view of locally stored board history.
 *
 * Subscribes to same-tab dispatches and cross-tab BroadcastChannel messages,
 * so any record/remove/clear from anywhere in the app updates this hook.
 */
export function useBoardHistory(limit = 25): UseBoardHistoryResult {
	const [boards, setBoards] = useState<BoardHistoryEntry[]>([])
	const [loaded, setLoaded] = useState(false)

	const refresh = useCallback(async () => {
		const list = await getRecentBoards(limit)
		setBoards(list)
		setLoaded(true)
	}, [limit])

	useEffect(() => {
		void refresh()
	}, [refresh])

	useEffect(() => {
		const onChange = () => {
			void refresh()
		}
		window.addEventListener(boardHistoryEvents.CHANGED, onChange)

		let bc: BroadcastChannel | null = null
		try {
			bc = new BroadcastChannel(boardHistoryEvents.BROADCAST_CHANNEL)
			bc.onmessage = onChange
		} catch {
			// BroadcastChannel unsupported — same-tab event listener is enough.
		}

		return () => {
			window.removeEventListener(boardHistoryEvents.CHANGED, onChange)
			bc?.close()
		}
	}, [refresh])

	const remove = useCallback(async (boardId: string) => {
		await removeBoardFromHistory(boardId)
	}, [])

	const clear = useCallback(async () => {
		await clearBoardHistory()
	}, [])

	return { boards, loaded, refresh, remove, clear }
}
