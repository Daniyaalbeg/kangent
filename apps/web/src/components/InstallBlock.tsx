import { useEffect, useState } from "react"

// GitHub slug the skills.sh CLI resolves. Must match a public repo containing
// SKILL.md at the root (or under skills/<name>/ for monorepo layout). Update
// this once we publish — see README's TODO.
const SKILL_REPO = "daniyaalbeg/kangent"

const INSTALL_CMD = `npx skills add ${SKILL_REPO}`

function buildAgentPrompt(baseUrl: string): string {
	return `Kangent is a real-time Kanban board for humans and agents. Boards live at URLs; you collaborate with a human (or other agents) over a shared board with cards, columns, and presence.

Install the skill with: npx skills add ${SKILL_REPO}
(or follow the skill inline from ${baseUrl}/kangent.SKILL.md if you can't run shell)

When you join a board, call GET ${baseUrl}/api/boards/<boardId>/changes with an X-Agent-Id header (a stable id for this agent instance) BEFORE doing anything else. That endpoint returns only what changed since your last visit — do not re-read the whole board. If the response says isFirstSync:true, use the snapshot field to seed your cache.

Always include "by": "ai:<your-name>" on writes so humans can see who did what.

Board URL: <paste the board URL here>`
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
	const [copied, setCopied] = useState(false)
	return (
		<button
			type="button"
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(value)
					setCopied(true)
					setTimeout(() => setCopied(false), 1500)
				} catch {
					// Clipboard API blocked; user can still select manually.
				}
			}}
			className="rounded border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 transition"
		>
			{copied ? "Copied" : label}
		</button>
	)
}

export function InstallBlock() {
	// Use whatever origin the user is actually viewing — localhost in dev,
	// the production host in prod — so the prompt they copy matches.
	// Starts empty to avoid an SSR/hydration mismatch; populated on mount.
	const [baseUrl, setBaseUrl] = useState("")
	useEffect(() => {
		setBaseUrl(window.location.origin)
	}, [])

	const agentPrompt = buildAgentPrompt(baseUrl)

	return (
		<section className="mt-14 flex flex-col gap-10">
			{/* Block A — install the skill via the skills.sh CLI (cross-agent) */}
			<div>
				<h2 className="text-sm font-semibold tracking-wider text-zinc-500 uppercase">
					Install the skill
				</h2>
				<p className="mt-2 text-sm text-zinc-600">
					One command via{" "}
					<a
						href="https://skills.sh"
						className="underline underline-offset-2"
						target="_blank"
						rel="noreferrer"
					>
						skills.sh
					</a>
					. Works for Claude Code, Codex, and any agent the CLI supports.
				</p>

				<div className="relative mt-3">
					<pre className="overflow-x-auto rounded-lg bg-zinc-950 p-4 pr-16 text-xs leading-relaxed text-zinc-100">
						<code>{INSTALL_CMD}</code>
					</pre>
					<div className="absolute right-2 top-2">
						<CopyButton value={INSTALL_CMD} />
					</div>
				</div>

				<p className="mt-3 text-xs text-zinc-500">
					Want the version served by this exact deployment instead? Fetch{" "}
					<code className="text-xs">{baseUrl || "<this host>"}/kangent.SKILL.md</code>.
				</p>
			</div>

			{/* Block B — natural-language prompt to paste into any agent chat */}
			<div>
				<h2 className="text-sm font-semibold tracking-wider text-zinc-500 uppercase">
					Hand this to your agent
				</h2>
				<p className="mt-2 text-sm text-zinc-600">
					No install required. Works with any agent that can read text and
					make HTTP calls.
				</p>

				<div className="relative mt-3">
					<pre className="max-h-72 overflow-auto rounded-lg bg-zinc-950 p-4 pr-16 text-xs leading-relaxed text-zinc-100 whitespace-pre-wrap">
						<code>{agentPrompt}</code>
					</pre>
					<div className="absolute right-2 top-2">
						<CopyButton value={agentPrompt} />
					</div>
				</div>
			</div>
		</section>
	)
}
