import type { PresenceEntry } from "./broadcaster.js"

const PRESENCE_TTL_MS = 60_000

export class PresenceTracker {
	private entries = new Map<string, PresenceEntry>()

	update(
		actorId: string,
		data: {
			cursor?: { cardId: string }
			status: "viewing" | "working" | "idle"
			message?: string
		},
	) {
		this.entries.set(actorId, {
			id: actorId,
			...data,
			lastSeen: Date.now(),
		})
	}

	remove(actorId: string) {
		this.entries.delete(actorId)
	}

	getActive(): PresenceEntry[] {
		const now = Date.now()
		const result: PresenceEntry[] = []
		for (const [id, entry] of this.entries) {
			if (now - entry.lastSeen > PRESENCE_TTL_MS) {
				this.entries.delete(id)
			} else {
				result.push(entry)
			}
		}
		return result
	}
}
