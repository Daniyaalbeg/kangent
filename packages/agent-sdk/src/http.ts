export interface KangentHttpClientOptions {
	baseUrl: string
	token?: string
}

export class KangentHttpClient {
	private baseUrl: string
	private token?: string

	constructor(options: KangentHttpClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/$/, "")
		this.token = options.token
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		}
		if (this.token) {
			headers["Authorization"] = `Bearer ${this.token}`
		}
		const res = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		})
		if (!res.ok) {
			const error = await res.json().catch(() => ({ message: res.statusText }))
			throw new Error(`Kangent API error (${res.status}): ${JSON.stringify(error)}`)
		}
		return (res.status === 204 ? undefined : res.json()) as T
	}

	async createBoard(params: { title: string; description?: string; columns?: string[]; by: string }) {
		return this.request<{ id: string; url: string; token: string; board: unknown }>(
			"POST",
			"/api/boards",
			params,
		)
	}

	async getBoardState(boardId: string) {
		return this.request<{ board: unknown; presence: unknown[] }>(
			"GET",
			`/api/boards/${boardId}/state`,
		)
	}

	async addCard(boardId: string, params: { columnId: string; title: string; description?: string; by: string }) {
		return this.request<{ card: unknown; version: number }>(
			"POST",
			`/api/boards/${boardId}/cards`,
			params,
		)
	}

	async updateCard(boardId: string, cardId: string, params: { title?: string; description?: string; by: string }) {
		return this.request<{ card: unknown; version: number }>(
			"PATCH",
			`/api/boards/${boardId}/cards/${cardId}`,
			params,
		)
	}

	async moveCard(boardId: string, cardId: string, params: { toColumnId: string; position: number; by: string }) {
		return this.request<{ card: unknown; version: number }>(
			"POST",
			`/api/boards/${boardId}/cards/${cardId}/move`,
			params,
		)
	}

	async deleteCard(boardId: string, cardId: string) {
		return this.request<{ deleted: string; version: number }>(
			"DELETE",
			`/api/boards/${boardId}/cards/${cardId}`,
		)
	}

	async addColumn(boardId: string, params: { title: string; by: string }) {
		return this.request<{ column: unknown; version: number }>(
			"POST",
			`/api/boards/${boardId}/columns`,
			params,
		)
	}

	async updateColumn(boardId: string, columnId: string, params: { title: string; by: string }) {
		return this.request<{ column: unknown; version: number }>(
			"PATCH",
			`/api/boards/${boardId}/columns/${columnId}`,
			params,
		)
	}

	async deleteColumn(boardId: string, columnId: string, moveCardsTo?: string) {
		const query = moveCardsTo ? `?moveCardsTo=${moveCardsTo}` : ""
		return this.request<{ deleted: string; cardsMoved: number; version: number }>(
			"DELETE",
			`/api/boards/${boardId}/columns/${columnId}${query}`,
		)
	}

	async updatePresence(boardId: string, params: { by: string; status: string; message?: string }) {
		return this.request<void>("POST", `/api/boards/${boardId}/presence`, params)
	}
}
