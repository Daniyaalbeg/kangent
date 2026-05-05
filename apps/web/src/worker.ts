import { BoardAgentSqlite } from "@kangent/board-worker";
import { getAgentByName, routeAgentRequest } from "agents";
import { PostHog } from "posthog-node";

export { BoardAgentSqlite };

export interface Env {
	BOARD_SQLITE: DurableObjectNamespace<BoardAgentSqlite>;
	ASSETS: Fetcher;
	POSTHOG_API_KEY?: string;
	POSTHOG_HOST?: string;
}

// The skill file is the source of truth on GitHub — `npx skills add` and
// `.well-known` consumers fetch from there. We don't serve the markdown from
// the worker because that would mean keeping a second copy in sync.
const SKILL_REPO = "daniyaalbeg/kangent";
const SKILL_RAW_URL = `https://raw.githubusercontent.com/${SKILL_REPO}/main/skills/kangent/SKILL.md`;
const SKILL_VIEW_URL = `https://github.com/${SKILL_REPO}/blob/main/skills/kangent/SKILL.md`;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		// Base URL derived from the request, so the .well-known discovery
		// record returns the host the agent actually hit (localhost in dev,
		// prod in prod) for the API endpoint.
		const baseUrl = url.origin;

		// API routes → Durable Object
		if (url.pathname.startsWith("/api/boards")) {
			return handleApiRequest(request, env, url);
		}

		const agentResponse = await routeAgentRequest(request, env);
		if (agentResponse) {
			return agentResponse;
		}

		// Discovery: other tools can auto-find our endpoints from here.
		if (url.pathname === "/.well-known/kangent.json") {
			const body = JSON.stringify(
				{
					name: "kangent",
					description: "Real-time Kanban boards for humans and agents. No account required.",
					skill: SKILL_RAW_URL,
					docs: SKILL_VIEW_URL,
					api: `${baseUrl}/api`,
				},
				null,
				2,
			);
			return new Response(body, {
				headers: { "Content-Type": "application/json; charset=utf-8" },
			});
		}

		// Everything else → static assets (SPA)
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

async function handleApiRequest(request: Request, env: Env, url: URL): Promise<Response> {
	// POST /api/boards → create a new board (needs its own DO)
	if (url.pathname === "/api/boards" && request.method === "POST") {
		return handleCreateBoard(request, env);
	}

	// Extract boardId from path: /api/boards/:boardId/...
	const match = url.pathname.match(/^\/api\/boards\/([^/]+)/);
	if (!match?.[1]) {
		return new Response(JSON.stringify({ error: "Board ID required" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	const boardId = match[1];
	const stub = await getAgentByName(env.BOARD_SQLITE, boardId);

	// Forward the full request to the board agent instance.
	return stub.fetch(request);
}

async function handleCreateBoard(request: Request, env: Env): Promise<Response> {
	let body: { title?: string; description?: string; columns?: string[]; by?: string };
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: "Invalid JSON" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	if (!body.title) {
		return new Response(JSON.stringify({ error: "Title is required" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	// Generate a unique board ID and initialize its board agent instance.
	const boardId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
	const stub = await getAgentByName(env.BOARD_SQLITE, boardId);
	const board = await stub.initializeBoard({
		title: body.title,
		description: body.description,
		columns: body.columns,
		by: body.by ?? "human:anonymous",
	});

	if (env.POSTHOG_API_KEY) {
		const posthog = new PostHog(env.POSTHOG_API_KEY, {
			host: env.POSTHOG_HOST,
			flushAt: 1,
			flushInterval: 0,
			enableExceptionAutocapture: true,
		});
		const distinctId = body.by ?? "human:anonymous";
		await posthog.captureImmediate({
			distinctId,
			event: "board created",
			properties: {
				board_id: boardId,
				board_title: body.title,
				columns_count: body.columns?.length,
				actor_type: distinctId.split(":")[0],
			},
		});
		await posthog.shutdown();
	}

	return new Response(
		JSON.stringify({
			id: boardId,
			url: `/b/${boardId}`,
			board,
		}),
		{
			status: 201,
			headers: { "Content-Type": "application/json" },
		},
	);
}
