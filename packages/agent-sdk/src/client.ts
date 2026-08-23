import { Effect } from "effect"
import { HttpApiClient } from "effect/unstable/httpapi"
import { KangentApi } from "@kangent/board-core"

export const makeClient = (baseUrl: string) =>
	HttpApiClient.make(KangentApi, { baseUrl })

export const makeClientEffect = (baseUrl: string) =>
	Effect.gen(function* () {
		return yield* makeClient(baseUrl)
	})
