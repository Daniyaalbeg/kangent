import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import alchemy from "alchemy/cloudflare/vite"
import { resolve } from "node:path"

export default defineConfig(({ mode }) => {
	// In production we require an explicit public URL so deploy artifacts
	// (OpenGraph tags, sitemaps, canonical links — anything that can't be
	// derived from the request) point at the canonical host. In dev we derive
	// everything from the request origin, so the env var is optional.
	if (mode === "production") {
		const env = loadEnv(mode, __dirname, "")
		const publicUrl = env.VITE_KANGENT_PUBLIC_URL?.trim()
		if (!publicUrl || publicUrl.includes("REPLACE-ME")) {
			throw new Error(
				"[kangent] VITE_KANGENT_PUBLIC_URL is not set for the production build. " +
					"Set it in apps/web/.env to the public URL where Kangent is reachable " +
					"(e.g. https://kangent-web.<account>.workers.dev or https://kangent.app). " +
					"See apps/web/.env.example.",
			)
		}
	}

	return {
		plugins: [react(), tailwindcss(), alchemy()],
		resolve: {
			alias: {
				"~": resolve(__dirname, "./src"),
			},
		},
	}
})
