import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		// Effect's stack traces are deep — bumping helps locate failures.
		chaiConfig: {
			truncateThreshold: 200,
		},
	},
});
