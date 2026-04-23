import { useEffect, useRef, useCallback } from "react"
import { useBoardStore } from "~/lib/store"

export function useWebSocket(boardId: string | undefined) {
	const wsRef = useRef<WebSocket | null>(null)

	useEffect(() => {
		if (!boardId) return

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
		const ws = new WebSocket(`${protocol}//${window.location.host}/api/boards/${boardId}/ws`)
		wsRef.current = ws

		ws.addEventListener("open", () => {
			useBoardStore.getState().setConnected(true)
		})

		ws.addEventListener("message", (event) => {
			try {
				const msg = JSON.parse(event.data)
				const store = useBoardStore.getState()
				switch (msg.type) {
					case "board:state":
						store.setBoard(msg.board, msg.board.cards ?? [])
						store.setVersion(msg.version)
						break
					case "op:applied":
						store.applyRemoteOp(msg.op, msg.version)
						break
					case "op:ack":
						store.ackOp(msg.opId, msg.version)
						break
					case "op:error":
						store.rollbackOp(msg.opId)
						break
					case "presence:state":
						store.setPresence(msg.actors)
						break
				}
			} catch {
				// ignore parse errors
			}
		})

		ws.addEventListener("close", () => {
			useBoardStore.getState().setConnected(false)
		})

		ws.addEventListener("error", () => {
			useBoardStore.getState().setConnected(false)
		})

		return () => {
			ws.close()
			wsRef.current = null
		}
	}, [boardId])

	const sendOp = useCallback(
		(op: Record<string, unknown>) => {
			const ws = wsRef.current
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(
					JSON.stringify({
						...op,
						by: useBoardStore.getState().actorId,
					}),
				)
			}
		},
		[],
	)

	const connected = useBoardStore((s) => s.connected)

	return { sendOp, connected }
}
