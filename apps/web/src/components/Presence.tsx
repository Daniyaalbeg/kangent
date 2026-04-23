import { useBoardStore } from "~/lib/store"
import { PresenceBubble, PresenceDot, PresenceStrip } from "./ui"

export function Presence() {
	const presence = useBoardStore((s) => s.presence)
	const connected = useBoardStore((s) => s.connected)

	return (
		<PresenceStrip>
			<div className="flex ml-[2px]">
				{presence.map((actor) => {
					const isAgent = actor.id.startsWith("ai:")
					const initial = isAgent
						? "A"
						: actor.id.charAt(actor.id.indexOf(":") + 1)?.toUpperCase() || "?"

					return (
						<PresenceBubble
							key={actor.id}
							human={!isAgent}
							title={`${actor.id} (${actor.status})${actor.message ? `: ${actor.message}` : ""}`}
						>
							{initial}
						</PresenceBubble>
					)
				})}
			</div>
			<PresenceDot
				connected={connected}
				title={connected ? "Connected" : "Disconnected"}
			/>
		</PresenceStrip>
	)
}
