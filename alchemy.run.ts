import alchemy from "alchemy"
import { DurableObjectNamespace, Vite } from "alchemy/cloudflare"

const app = await alchemy("kangent", {
	phase: process.argv.includes("--destroy") ? "destroy" : "up",
})

const boardDO = DurableObjectNamespace("board-do", {
	className: "BoardDO",
})

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
if (!accountId) {
	throw new Error(
		"CLOUDFLARE_ACCOUNT_ID is not set. Add it to .env at the repo root.",
	)
}

export const worker = await Vite("kangent-web", {
	accountId,
	cwd: "apps/web",
	entrypoint: "src/worker.ts",
	spa: true,
	bindings: {
		BOARD: boardDO,
	},
	// Worker must run before the static-asset handler so it can own
	// /kangent.SKILL.md, /agent-docs, /.well-known/kangent.json, and the
	// /api/boards/* routes. Otherwise Cloudflare's assets layer (with SPA
	// not_found_handling) intercepts them before the Worker sees the request.
	// The Worker itself falls through to env.ASSETS.fetch at the end.
	assets: {
		run_worker_first: true,
	},
	dev: {
		command: "npx vite",
	},
})

console.log(`Kangent -> ${worker.url}`)

await app.finalize()
