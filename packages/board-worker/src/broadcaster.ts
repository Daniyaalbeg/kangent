import { Effect, Layer } from "effect"
import { Broadcaster } from "@kangent/board-core"

export interface PresenceEntry {
	id: string
	cursor?: { cardId: string }
	status: "viewing" | "working" | "idle"
	message?: string
	lastSeen: number
}

export interface ConnectionState {
	ws: WebSocket
	actorId?: string
}

export const makeBroadcasterLayer = (connections: Map<WebSocket, ConnectionState>) =>
	Layer.succeed(Broadcaster, {
		broadcast: (message, exclude?) =>
			Effect.sync(() => {
				const data = JSON.stringify(message)
				for (const [ws] of connections) {
					if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
						ws.send(data)
					}
				}
			}),

		broadcastPresence: () =>
			Effect.sync(() => {
				// Presence is broadcast as part of regular operations for now
			}),

		getConnectionCount: () => Effect.sync(() => connections.size),
	})
