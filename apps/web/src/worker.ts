import { getAgentByName, routeAgentRequest } from "agents"
import { BoardAgent } from "@kangent/board-worker"

export { BoardAgent }

export interface Env {
	BOARD: DurableObjectNamespace<BoardAgent>
	ASSETS: Fetcher
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		// Base URL derived from the request, so localhost-in-dev and the
		// production host both show up correctly in the SKILL.md, the
		// .well-known discovery record, and the agent-docs page.
		const baseUrl = url.origin

		// API routes → Durable Object
		if (url.pathname.startsWith("/api/boards")) {
			return handleApiRequest(request, env, url)
		}

		const agentResponse = await routeAgentRequest(request, env)
		if (agentResponse) {
			return agentResponse
		}

		// Canonical skill file. Vanity path so a user's repo-level SKILL.md
		// doesn't collide when agents cache this by basename.
		if (url.pathname === "/kangent.SKILL.md") {
			const { buildSkillMd } = await import("./skill-content")
			return new Response(buildSkillMd(baseUrl), {
				headers: {
					"Content-Type": "text/markdown; charset=utf-8",
					// Skill files are rebuilt with the app; revalidate often.
					"Cache-Control": "public, max-age=60, must-revalidate",
				},
			})
		}

		// Back-compat: old path redirects to the new vanity URL.
		if (url.pathname === "/SKILL.md") {
			return new Response(null, {
				status: 301,
				headers: { Location: "/kangent.SKILL.md" },
			})
		}

		// Discovery: other tools can auto-find our endpoints from here.
		if (url.pathname === "/.well-known/kangent.json") {
			const body = JSON.stringify(
				{
					name: "kangent",
					description:
						"Real-time Kanban boards for humans and agents. No account required.",
					skill: `${baseUrl}/kangent.SKILL.md`,
					api: `${baseUrl}/api`,
					docs: `${baseUrl}/agent-docs`,
				},
				null,
				2,
			)
			return new Response(body, {
				headers: { "Content-Type": "application/json; charset=utf-8" },
			})
		}

		// Human-readable agent docs — renders the SKILL.md as a simple HTML page
		// so users can eyeball what they're about to hand to their agent.
		if (url.pathname === "/agent-docs") {
			const { buildSkillMd } = await import("./skill-content")
			const html = renderAgentDocsHtml(buildSkillMd(baseUrl))
			return new Response(html, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			})
		}

		// Everything else → static assets (SPA)
		return env.ASSETS.fetch(request)
	},
} satisfies ExportedHandler<Env>

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

// Minimal markdown-ish renderer. Avoids pulling in a full library; the skill
// is our own file so we only need to handle the shapes we use: frontmatter,
// headings, fenced code blocks, inline code, and tables.
function renderAgentDocsHtml(md: string): string {
	const stripped = md.replace(/^---[\s\S]*?---\n/, "")
	const body = escapeHtml(stripped)
		// Fenced code blocks first so we don't re-process their contents.
		.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
			`<pre><code>${code}</code></pre>`,
		)
		.replace(/^### (.+)$/gm, "<h3>$1</h3>")
		.replace(/^## (.+)$/gm, "<h2>$1</h2>")
		.replace(/^# (.+)$/gm, "<h1>$1</h1>")
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\n\n/g, "</p><p>")
	// Embed the raw markdown so the Copy Page button can hand the full,
	// unrendered source to the user's clipboard. JSON.stringify + escaping `<`
	// keeps the payload safe inside a <script> tag.
	const mdJson = JSON.stringify(md).replace(/</g, "\\u003c")
	return `<!doctype html><html><head><meta charset="utf-8">
<title>Kangent — Agent Docs</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 780px; margin: 2.5rem auto; padding: 0 1rem; color: #111; position: relative; }
  h1, h2, h3 { line-height: 1.25; }
  h1 { font-size: 2rem; margin-top: 0; }
  h2 { margin-top: 2.25rem; border-top: 1px solid #eee; padding-top: 1.25rem; }
  pre { background: #0b0b0b; color: #f0f0f0; padding: 0.9rem 1rem; border-radius: 6px; overflow-x: auto; font-size: 13px; }
  code { background: #f3f3f3; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.92em; }
  pre code { background: transparent; padding: 0; }
  a { color: #0366d6; }
  /* Anchored to the same column as the h1 (body is position: relative and
     max-width: 780px), so the button lives inside the layout instead of
     floating over the viewport edge. */
  #copy-page { position: absolute; top: 0; right: 1rem; font: inherit; font-size: 13px; padding: 0.45rem 0.75rem; border: 1px solid #d0d0d0; border-radius: 6px; background: #fff; color: #111; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  #copy-page:hover { background: #f7f7f7; }
  #copy-page:active { background: #eee; }
  #copy-page[data-state="copied"] { border-color: #137333; color: #137333; }
</style></head><body><button id="copy-page" type="button" aria-label="Copy page as markdown">Copy Page</button><p>${body}</p>
<script>(() => {
  const md = ${mdJson};
  const btn = document.getElementById("copy-page");
  if (!btn) return;
  const label = btn.textContent;
  let timer;
  btn.addEventListener("click", async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
      } else {
        const ta = document.createElement("textarea");
        ta.value = md;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      btn.textContent = "Copied";
      btn.dataset.state = "copied";
    } catch (err) {
      btn.textContent = "Copy failed";
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.textContent = label;
      delete btn.dataset.state;
    }, 1500);
  });
})();</script></body></html>`
}

async function handleApiRequest(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	// POST /api/boards → create a new board (needs its own DO)
	if (url.pathname === "/api/boards" && request.method === "POST") {
		return handleCreateBoard(request, env)
	}

	// Extract boardId from path: /api/boards/:boardId/...
	const match = url.pathname.match(/^\/api\/boards\/([^/]+)/)
	if (!match?.[1]) {
		return new Response(JSON.stringify({ error: "Board ID required" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		})
	}

	const boardId = match[1]
	const stub = await getAgentByName(env.BOARD, boardId)

	// Forward the full request to the board agent instance.
	return stub.fetch(request)
}

async function handleCreateBoard(request: Request, env: Env): Promise<Response> {
	let body: { title?: string; description?: string; columns?: string[]; by?: string }
	try {
		body = await request.json()
	} catch {
		return new Response(JSON.stringify({ error: "Invalid JSON" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		})
	}

	if (!body.title) {
		return new Response(
			JSON.stringify({ error: "Title is required" }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		)
	}

	// Generate a unique board ID and initialize its board agent instance.
	const boardId = crypto.randomUUID().replace(/-/g, "").slice(0, 12)
	const stub = await getAgentByName(env.BOARD, boardId)
	const board = await stub.initializeBoard({
		title: body.title,
		description: body.description,
		columns: body.columns,
		by: body.by ?? "human:anonymous",
	})

	return new Response(
		JSON.stringify({
			id: boardId,
			url: `/b/${boardId}`,
			token: `tok_${boardId}`,
			board,
		}),
		{
			status: 201,
			headers: { "Content-Type": "application/json" },
		},
	)
}
