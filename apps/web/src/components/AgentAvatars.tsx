import { useEffect, useState } from "react"
import { useBoardStore } from "~/lib/store"

const ACTIVE_WINDOW_MS = 3 * 60 * 1000

// Deterministic color palette cycled by agent id so the same agent keeps the same color.
const AGENT_COLORS = [
	"#f97316", // orange
	"#14b8a6", // teal
	"#a855f7", // purple
	"#ec4899", // pink
	"#22c55e", // green
	"#eab308", // amber
	"#06b6d4", // cyan
	"#ef4444", // red
]

function colorFor(id: string) {
	let hash = 0
	for (let i = 0; i < id.length; i++) {
		hash = (hash * 31 + id.charCodeAt(i)) >>> 0
	}
	return AGENT_COLORS[hash % AGENT_COLORS.length]
}

export function AgentAvatars() {
	const presence = useBoardStore((s) => s.presence)
	// Re-render every 30s so avatars drop off after the 3-minute window passes.
	const [, setTick] = useState(0)
	useEffect(() => {
		const t = setInterval(() => setTick((n) => n + 1), 30_000)
		return () => clearInterval(t)
	}, [])

	const now = Date.now()
	const activeAgents = presence.filter(
		(a) =>
			a.id.startsWith("ai:") &&
			a.lastSeenAt !== undefined &&
			now - a.lastSeenAt < ACTIVE_WINDOW_MS,
	)

	if (activeAgents.length === 0) return null

	return (
		<div className="flex items-center">
			{activeAgents.map((agent) => (
				<div
					key={agent.id}
					title={`${agent.id} (${agent.status})${agent.message ? `: ${agent.message}` : ""}`}
					className="w-6 h-6 -ml-[6px] first:ml-0 rounded-full border-2 border-page-bg flex items-center justify-center text-[12px] leading-none"
					style={{ backgroundColor: colorFor(agent.id) }}
				>
					<span aria-hidden="true">🤖</span>
				</div>
			))}
		</div>
	)
}
