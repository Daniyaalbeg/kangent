import {
	type AddCardParams,
	type AppendChangeParams,
	type Board,
	BoardNotFound,
	type BoardSnapshot,
	type BoardUpdates,
	type Card,
	CardNotFound,
	type CardPriority,
	type CardUpdates,
	type Change,
	type ChangeFeedRead,
	type Column,
	ColumnNotEmpty,
	ColumnNotFound,
	type CreateBoardParams,
	DEFAULT_COLUMNS,
	ValidationError,
} from "@kangent/board-core";
import { Agent, type Connection, type ConnectionContext, type WSMessage, callable } from "agents";
import { nanoid } from "nanoid";
import { PostHog } from "posthog-node";

const CHANGELOG_RETENTION = 500;
const PRESENCE_TTL_MS = 3 * 60 * 1000;

const changeKey = (version: number) => `changelog:${String(version).padStart(12, "0")}`;
const cursorKey = (agentId: string) => `cursor:${agentId}`;

export interface PresenceActor {
	id: string;
	status: "viewing" | "working" | "idle";
	cursor?: { cardId: string };
	message?: string;
	lastSeenAt: number;
}

export interface BoardAgentState {
	board: Board | null;
	cards: Card[];
	presence: PresenceActor[];
}

type BoardConnectionState = {
	actorId: string;
};

export class BoardAgentSqlite extends Agent<Cloudflare.Env, BoardAgentState> {
	initialState: BoardAgentState = {
		board: null,
		cards: [],
		presence: [],
	};

	private get boardId() {
		return this.name;
	}

	private makePostHog(): PostHog | null {
		const env = this.env as unknown as { POSTHOG_API_KEY?: string; POSTHOG_HOST?: string };
		if (!env.POSTHOG_API_KEY) return null;
		return new PostHog(env.POSTHOG_API_KEY, {
			host: env.POSTHOG_HOST,
			flushAt: 1,
			flushInterval: 0,
			enableExceptionAutocapture: true,
		});
	}

	// Fire-and-forget event capture. PostHog should never sit on the request's
	// critical path — flushing it added a full HTTP round-trip to every board
	// write. The DO stays alive while the dangling promise is pending so the
	// capture still completes; errors are swallowed so PostHog being down
	// can't fail a board mutation.
	private capture(distinctId: string, event: string, properties: Record<string, unknown>): void {
		const posthog = this.makePostHog();
		if (!posthog) return;
		void posthog
			.captureImmediate({ distinctId, event, properties })
			.then(() => posthog.shutdown())
			.catch(() => {});
	}

	private captureException(error: Error): void {
		const posthog = this.makePostHog();
		if (!posthog) return;
		void posthog
			.captureExceptionImmediate(error, "server")
			.then(() => posthog.shutdown())
			.catch(() => {});
	}

	async initializeBoard(params: CreateBoardParams) {
		if (this.state.board) {
			return this.state.board;
		}

		const now = new Date().toISOString();
		const columnTitles = params.columns ?? [...DEFAULT_COLUMNS];
		const columns = columnTitles.map(
			(title, index) =>
				({
					id: nanoid(8),
					title,
					position: index,
					cardIds: [],
				}) as Column,
		);
		const board = {
			id: this.boardId,
			title: params.title,
			description: params.description,
			columns,
			// Per-board monotonic sequence used to mint card identifiers.
			// Starts at 1 so the first card on this board becomes
			// `<boardId>-1`.
			nextCardSeq: 1,
			createdAt: now,
			updatedAt: now,
			createdBy: params.by as Board["createdBy"],
			version: 0,
		} as Board;

		this.setState({
			board,
			cards: [],
			presence: [],
		});

		return board;
	}

	onConnect(connection: Connection<BoardConnectionState>, ctx: ConnectionContext) {
		const url = new URL(ctx.request.url);
		const actorId = url.searchParams.get("actorId")?.trim() || `human:${connection.id}`;
		connection.setState({ actorId });
		this.upsertPresence(actorId, { status: "viewing" });
	}

	onMessage(_connection: Connection<BoardConnectionState>, _message: WSMessage) {
		// The Agents SDK handles RPC and state-sync protocol messages for us.
	}

	onClose(connection: Connection<BoardConnectionState>) {
		const actorId = connection.state?.actorId;
		if (!actorId) return;
		this.removePresence(actorId);
	}

	async onRequest(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url);
			const tail = this.getBoardPath(url.pathname);

			if (tail === "/live") {
				return this.json({ ok: true });
			}

			if (tail === "/state" && request.method === "GET") {
				const snapshot = this.ensureMigrated();
				const actorId = new URL(request.url).searchParams.get("actorId") ?? "human:anonymous";
				this.capture(actorId, "board viewed", {
					board_id: this.boardId,
					board_title: snapshot.board.title,
					actor_type: actorId.split(":")[0],
				});
				return this.json({
					board: snapshot.board,
					cards: snapshot.cards,
					presence: this.prunePresence(this.state.presence),
				});
			}

			if (tail === "/changes" && request.method === "GET") {
				return this.handleChangesRequest(request, url);
			}

			if (tail === "" && request.method === "PATCH") {
				const body = (await request.json()) as {
					title?: string;
					description?: string | null;
					by?: string;
				};
				const { board, version } = await this.updateBoardInternal({
					title: body.title,
					description: body.description,
					by: body.by ?? "ai:unknown",
				});
				return this.json({ board, version });
			}

			if (tail === "/cards" && request.method === "POST") {
				const body = (await request.json()) as AddCardParams;
				const { card, version } = await this.addCardInternal({
					columnId: body.columnId,
					title: body.title,
					description: body.description,
					priority: body.priority,
					dueDate: body.dueDate,
					labels: body.labels,
					blockedBy: body.blockedBy,
					by: body.by ?? "ai:unknown",
				});
				return this.json({ card, version }, 201);
			}

			const cardPatch = tail.match(/^\/cards\/([^/]+)$/);
			if (cardPatch && request.method === "PATCH") {
				const cardId = decodeURIComponent(cardPatch[1]!);
				const body = (await request.json()) as {
					title?: string;
					description?: unknown;
					priority?: CardPriority | null;
					dueDate?: string | null;
					labels?: string[];
					blockedBy?: string[];
					by?: string;
				};
				const { card, version } = await this.updateCardInternal(cardId, {
					title: body.title,
					description: body.description,
					priority: body.priority,
					dueDate: body.dueDate,
					labels: body.labels,
					blockedBy: body.blockedBy,
					by: body.by ?? "ai:unknown",
				});
				return this.json({ card, version });
			}

			const cardMove = tail.match(/^\/cards\/([^/]+)\/move$/);
			if (cardMove && request.method === "POST") {
				const cardId = decodeURIComponent(cardMove[1]!);
				const body = (await request.json()) as {
					toColumnId: string;
					position: number;
					by?: string;
				};
				const { card, version } = await this.moveCardInternal(cardId, {
					toColumnId: body.toColumnId,
					position: body.position,
					by: body.by ?? "ai:unknown",
				});
				return this.json({ card, version });
			}

			const cardDelete = tail.match(/^\/cards\/([^/]+)$/);
			if (cardDelete && request.method === "DELETE") {
				const cardId = decodeURIComponent(cardDelete[1]!);
				const by = url.searchParams.get("by") ?? "ai:unknown";
				const { version } = await this.deleteCardInternal(cardId, by);
				return this.json({ deleted: cardId, version });
			}

			if (tail === "/columns" && request.method === "POST") {
				const body = (await request.json()) as { title: string; by?: string };
				const { column, version } = await this.addColumnInternal(
					body.title,
					body.by ?? "ai:unknown",
				);
				return this.json({ column, version }, 201);
			}

			if (tail === "/columns/reorder" && request.method === "POST") {
				const body = (await request.json()) as {
					columnIds: string[];
					by?: string;
				};
				const { columns, version } = await this.reorderColumnsInternal(
					body.columnIds ?? [],
					body.by ?? "ai:unknown",
				);
				return this.json({ columns, version });
			}

			const columnPatch = tail.match(/^\/columns\/([^/]+)$/);
			if (columnPatch && request.method === "PATCH") {
				const columnId = decodeURIComponent(columnPatch[1]!);
				const body = (await request.json()) as { title: string; by?: string };
				const { column, version } = await this.updateColumnInternal(
					columnId,
					body.title,
					body.by ?? "ai:unknown",
				);
				return this.json({ column, version });
			}

			const columnDelete = tail.match(/^\/columns\/([^/]+)$/);
			if (columnDelete && request.method === "DELETE") {
				const columnId = decodeURIComponent(columnDelete[1]!);
				const moveCardsTo = url.searchParams.get("moveCardsTo") ?? undefined;
				const by = url.searchParams.get("by") ?? "ai:unknown";
				const { cardsMoved, version } = await this.deleteColumnInternal(columnId, moveCardsTo, by);
				return this.json({ deleted: columnId, cardsMoved, version });
			}

			if (tail === "/presence" && request.method === "POST") {
				const body = (await request.json()) as {
					by: string;
					status: "viewing" | "working" | "idle";
					message?: string;
					cursor?: { cardId: string };
				};
				this.upsertPresence(body.by, {
					status: body.status,
					message: body.message,
					cursor: body.cursor,
				});
				return this.json({ ok: true });
			}

			return this.json({ error: "Not found" }, 404);
		} catch (error) {
			return this.handleError(error);
		}
	}

	@callable()
	async addCard(params: AddCardParams) {
		return this.addCardInternal(params);
	}

	@callable()
	async updateBoard(updates: BoardUpdates & { by?: string }) {
		return this.updateBoardInternal({
			title: updates.title,
			description: updates.description,
			by: updates.by ?? "human:anonymous",
		});
	}

	@callable()
	async updateCard(cardId: string, updates: CardUpdates & { by?: string }) {
		return this.updateCardInternal(cardId, {
			title: updates.title,
			description: updates.description,
			priority: updates.priority,
			dueDate: updates.dueDate,
			labels: updates.labels,
			blockedBy: updates.blockedBy,
			by: updates.by ?? "human:anonymous",
		});
	}

	@callable()
	async moveCard(cardId: string, params: { toColumnId: string; position: number; by?: string }) {
		return this.moveCardInternal(cardId, {
			toColumnId: params.toColumnId,
			position: params.position,
			by: params.by ?? "human:anonymous",
		});
	}

	@callable()
	async deleteCard(cardId: string, by?: string) {
		return this.deleteCardInternal(cardId, by ?? "human:anonymous");
	}

	@callable()
	async addColumn(title: string, by?: string) {
		return this.addColumnInternal(title, by ?? "human:anonymous");
	}

	@callable()
	async updateColumn(columnId: string, title: string, by?: string) {
		return this.updateColumnInternal(columnId, title, by ?? "human:anonymous");
	}

	@callable()
	async deleteColumn(columnId: string, moveCardsTo?: string, by?: string) {
		return this.deleteColumnInternal(columnId, moveCardsTo, by ?? "human:anonymous");
	}

	@callable()
	async reorderColumns(columnIds: string[], by?: string) {
		return this.reorderColumnsInternal(columnIds, by ?? "human:anonymous");
	}

	@callable()
	async updatePresence(params: {
		by: string;
		status: "viewing" | "working" | "idle";
		message?: string;
		cursor?: { cardId: string };
	}) {
		this.upsertPresence(params.by, {
			status: params.status,
			message: params.message,
			cursor: params.cursor,
		});
		return { ok: true };
	}

	private getBoardPath(pathname: string) {
		const match = pathname.match(/^\/api\/boards\/[^/]+(\/.*)?$/);
		return match?.[1] ?? "";
	}

	private requireSnapshot(): BoardSnapshot {
		const board = this.state.board;
		if (!board) {
			throw new BoardNotFound({ boardId: this.boardId });
		}

		return {
			board,
			cards: this.state.cards,
		} as BoardSnapshot;
	}

	private prunePresence(presence: PresenceActor[]) {
		const now = Date.now();
		return presence.filter((entry) => now - entry.lastSeenAt < PRESENCE_TTL_MS);
	}

	private upsertPresence(actorId: string, update: Omit<PresenceActor, "id" | "lastSeenAt">) {
		const nextPresence = this.prunePresence(this.state.presence).filter(
			(entry) => entry.id !== actorId,
		);
		nextPresence.push({
			id: actorId,
			lastSeenAt: Date.now(),
			...update,
		});
		this.setState({
			...this.state,
			presence: nextPresence,
		});
	}

	private removePresence(actorId: string) {
		const nextPresence = this.prunePresence(this.state.presence).filter(
			(entry) => entry.id !== actorId,
		);
		if (nextPresence.length === this.state.presence.length) return;
		this.setState({
			...this.state,
			presence: nextPresence,
		});
	}

	private async handleChangesRequest(request: Request, url: URL) {
		// Migration is part of the read contract for `/changes` so agents
		// always receive cards stamped with `identifier` in the snapshot.
		this.ensureMigrated();
		const agentId = request.headers.get("X-Agent-Id")?.trim();
		if (!agentId) {
			return this.json(
				{
					error:
						"X-Agent-Id header is required. Send a stable id per agent instance so the server can track what you've already seen.",
				},
				400,
			);
		}

		const sinceParam = url.searchParams.get("since");
		const overrideSince =
			sinceParam !== null && !Number.isNaN(Number(sinceParam))
				? Math.max(0, Number(sinceParam))
				: undefined;
		const ack = url.searchParams.get("ack") !== "false";
		const storedCursor = await this.getAgentCursor(agentId);
		const afterVersion = overrideSince ?? storedCursor ?? 0;
		const feed = await this.readChanges(afterVersion, 200);

		const snapshot =
			feed.isFirstSync && this.state.board
				? { board: this.state.board, cards: this.state.cards }
				: null;

		if (ack && (feed.toVersion !== storedCursor || feed.isFirstSync)) {
			await this.setAgentCursor(agentId, feed.toVersion);
		}

		return this.json({
			toVersion: feed.toVersion,
			fromVersion: feed.fromVersion,
			isFirstSync: feed.isFirstSync,
			snapshot,
			changes: feed.changes,
		});
	}

	private async updateBoardInternal(params: BoardUpdates & { by: string }) {
		const snapshot = this.ensureMigrated();

		// No-op: nothing to apply. Return current state without bumping version
		// or appending a change — the caller would otherwise see an empty diff.
		if (params.title === undefined && params.description === undefined) {
			return { board: snapshot.board, version: snapshot.board.version };
		}

		// Validate title separately so we can give a precise error.
		let nextTitle: string | undefined;
		if (params.title !== undefined) {
			const trimmed = params.title.trim();
			if (!trimmed) {
				throw new ValidationError({ message: "Board title cannot be empty" });
			}
			nextTitle = trimmed;
		}

		const version = snapshot.board.version + 1;
		const now = new Date().toISOString();

		// Description handling: `null` means clear (delete the optional field),
		// any string means set, undefined means leave alone. We rebuild the
		// board explicitly so we can drop the field cleanly when clearing.
		const { description: prevDescription, ...rest } = snapshot.board;
		let board: Board;
		if (params.description === null) {
			board = {
				...rest,
				...(nextTitle !== undefined ? { title: nextTitle } : {}),
				version,
				updatedAt: now,
			} as Board;
		} else {
			board = {
				...snapshot.board,
				...(nextTitle !== undefined ? { title: nextTitle } : {}),
				...(params.description !== undefined ? { description: params.description } : {}),
				version,
				updatedAt: now,
			} as Board;
		}

		this.setState({
			...this.state,
			board,
			presence: this.prunePresence(this.state.presence),
		});

		await this.appendChange({
			version,
			op: "board:update",
			snapshot: board,
			by: params.by,
		});

		this.capture(params.by, "board updated", {
			board_id: this.boardId,
			board_title: board.title,
			actor_type: params.by.split(":")[0],
		});

		return { board, version };
	}

	private async addCardInternal(params: AddCardParams) {
		const snapshot = this.ensureMigrated();
		const column = snapshot.board.columns.find((entry) => entry.id === params.columnId);
		if (!column) {
			throw new ColumnNotFound({ columnId: params.columnId });
		}

		const labels = this.normalizeStringList(params.labels, "labels");
		const blockedBy = this.normalizeStringList(params.blockedBy, "blockedBy");
		const { identifier, nextCardSeq } = this.mintCardIdentifier(snapshot.board);

		const now = new Date().toISOString();
		const card = {
			id: nanoid(8),
			identifier,
			columnId: params.columnId,
			title: params.title,
			description: params.description ?? null,
			position: column.cardIds.length,
			...(params.priority !== undefined ? { priority: params.priority } : {}),
			...(params.dueDate !== undefined ? { dueDate: params.dueDate } : {}),
			...(labels !== undefined ? { labels } : {}),
			...(blockedBy !== undefined ? { blockedBy } : {}),
			createdBy: params.by,
			createdAt: now,
			updatedAt: now,
		} as Card;
		const nextColumns = snapshot.board.columns.map((entry) =>
			entry.id === params.columnId
				? ({ ...entry, cardIds: [...entry.cardIds, card.id] } as Column)
				: entry,
		);
		const version = snapshot.board.version + 1;
		const board = this.withBoardMeta(snapshot.board, {
			columns: nextColumns,
			version,
			nextCardSeq,
		});

		this.setState({
			...this.state,
			board,
			cards: [...snapshot.cards, card],
			presence: this.prunePresence(this.state.presence),
		});

		await this.appendChange({
			version,
			op: "card:add",
			cardId: card.id,
			columnId: params.columnId,
			snapshot: card,
			by: params.by,
		});

		this.capture(params.by, "card added", {
			board_id: this.boardId,
			card_id: card.id,
			column_id: params.columnId,
			card_title: card.title,
			has_priority: params.priority != null,
			has_due_date: params.dueDate != null,
			actor_type: params.by.split(":")[0],
		});

		return { card, version };
	}

	private async updateCardInternal(cardId: string, updates: CardUpdates & { by: string }) {
		const snapshot = this.ensureMigrated();
		const existing = snapshot.cards.find((entry) => entry.id === cardId);
		if (!existing) {
			throw new CardNotFound({ cardId });
		}

		const labels = this.normalizeStringList(updates.labels, "labels");
		const blockedBy = this.normalizeStringList(updates.blockedBy, "blockedBy");

		const next: Card = {
			...existing,
			...(updates.title !== undefined ? { title: updates.title } : {}),
			...(updates.description !== undefined ? { description: updates.description } : {}),
			updatedAt: new Date().toISOString(),
		} as Card;
		if (updates.priority !== undefined) {
			if (updates.priority === null) {
				delete (next as { priority?: CardPriority }).priority;
			} else {
				(next as { priority?: CardPriority }).priority = updates.priority;
			}
		}
		if (updates.dueDate !== undefined) {
			if (updates.dueDate === null) {
				delete (next as { dueDate?: string }).dueDate;
			} else {
				(next as { dueDate?: string }).dueDate = updates.dueDate;
			}
		}
		// Full-replace semantics for labels/blockedBy: `undefined` leaves the
		// existing list alone, `[]` clears it, anything else overwrites.
		if (labels !== undefined) {
			if (labels.length === 0) {
				delete (next as { labels?: readonly string[] }).labels;
			} else {
				(next as { labels?: readonly string[] }).labels = labels;
			}
		}
		if (blockedBy !== undefined) {
			if (blockedBy.length === 0) {
				delete (next as { blockedBy?: readonly string[] }).blockedBy;
			} else {
				(next as { blockedBy?: readonly string[] }).blockedBy = blockedBy;
			}
		}
		const card = next;
		const version = snapshot.board.version + 1;
		const board = this.withBoardMeta(snapshot.board, { version });

		this.setState({
			...this.state,
			board,
			cards: snapshot.cards.map((entry) => (entry.id === cardId ? card : entry)),
			presence: this.prunePresence(this.state.presence),
		});

		await this.appendChange({
			version,
			op: "card:update",
			cardId,
			snapshot: card,
			by: updates.by,
		});

		this.capture(updates.by, "card updated", {
			board_id: this.boardId,
			card_id: cardId,
			column_id: card.columnId,
			actor_type: updates.by.split(":")[0],
		});

		return { card, version };
	}

	private async moveCardInternal(
		cardId: string,
		params: { toColumnId: string; position: number; by: string },
	) {
		const snapshot = this.ensureMigrated();
		const existing = snapshot.cards.find((entry) => entry.id === cardId);
		if (!existing) {
			throw new CardNotFound({ cardId });
		}

		const targetColumn = snapshot.board.columns.find((entry) => entry.id === params.toColumnId);
		if (!targetColumn) {
			throw new ColumnNotFound({ columnId: params.toColumnId });
		}

		const nextColumns = snapshot.board.columns.map((entry) => {
			let cardIds = entry.cardIds.filter((id) => id !== cardId);
			if (entry.id === params.toColumnId) {
				const insertIndex = Math.min(Math.max(0, Math.round(params.position)), cardIds.length);
				cardIds = [...cardIds.slice(0, insertIndex), cardId, ...cardIds.slice(insertIndex)];
			}
			return { ...entry, cardIds } as Column;
		});
		const card = {
			...existing,
			columnId: params.toColumnId,
			position: params.position,
			updatedAt: new Date().toISOString(),
		} as Card;
		const version = snapshot.board.version + 1;
		const board = this.withBoardMeta(snapshot.board, { columns: nextColumns, version });

		this.setState({
			...this.state,
			board,
			cards: snapshot.cards.map((entry) => (entry.id === cardId ? card : entry)),
			presence: this.prunePresence(this.state.presence),
		});

		await this.appendChange({
			version,
			op: "card:move",
			cardId,
			columnId: params.toColumnId,
			fromColumnId: existing.columnId,
			snapshot: card,
			by: params.by,
		});

		this.capture(params.by, "card moved", {
			board_id: this.boardId,
			card_id: cardId,
			from_column_id: existing.columnId,
			to_column_id: params.toColumnId,
			column_changed: existing.columnId !== params.toColumnId,
			actor_type: params.by.split(":")[0],
		});

		return { card, version };
	}

	private async deleteCardInternal(cardId: string, by: string) {
		const snapshot = this.ensureMigrated();
		const existing = snapshot.cards.find((entry) => entry.id === cardId);
		if (!existing) {
			throw new CardNotFound({ cardId });
		}

		const nextColumns = snapshot.board.columns.map(
			(entry) =>
				({
					...entry,
					cardIds: entry.cardIds.filter((id) => id !== cardId),
				}) as Column,
		);
		const version = snapshot.board.version + 1;
		const board = this.withBoardMeta(snapshot.board, { columns: nextColumns, version });

		this.setState({
			...this.state,
			board,
			cards: snapshot.cards.filter((entry) => entry.id !== cardId),
			presence: this.prunePresence(this.state.presence),
		});

		await this.appendChange({
			version,
			op: "card:delete",
			cardId,
			snapshot: null,
			by,
		});

		this.capture(by, "card deleted", {
			board_id: this.boardId,
			card_id: cardId,
			column_id: existing.columnId,
			actor_type: by.split(":")[0],
		});

		return { deleted: cardId, version };
	}

	private async addColumnInternal(title: string, by: string) {
		const snapshot = this.ensureMigrated();
		const column = {
			id: nanoid(8),
			title,
			position: snapshot.board.columns.length,
			cardIds: [],
		} as Column;
		const version = snapshot.board.version + 1;
		const board = this.withBoardMeta(snapshot.board, {
			columns: [...snapshot.board.columns, column],
			version,
		});

		this.setState({
			...this.state,
			board,
			cards: [...snapshot.cards],
			presence: this.prunePresence(this.state.presence),
		});

		await this.appendChange({
			version,
			op: "column:add",
			columnId: column.id,
			snapshot: column,
			by,
		});

		this.capture(by, "column added", {
			board_id: this.boardId,
			column_id: column.id,
			column_title: title,
			actor_type: by.split(":")[0],
		});

		return { column, version };
	}

	private async updateColumnInternal(columnId: string, title: string, by: string) {
		const snapshot = this.ensureMigrated();
		const existing = snapshot.board.columns.find((entry) => entry.id === columnId);
		if (!existing) {
			throw new ColumnNotFound({ columnId });
		}

		const column = {
			...existing,
			title,
		} as Column;
		const version = snapshot.board.version + 1;
		const board = this.withBoardMeta(snapshot.board, {
			columns: snapshot.board.columns.map((entry) => (entry.id === columnId ? column : entry)),
			version,
		});

		this.setState({
			...this.state,
			board,
			cards: [...snapshot.cards],
			presence: this.prunePresence(this.state.presence),
		});

		await this.appendChange({
			version,
			op: "column:update",
			columnId,
			snapshot: column,
			by,
		});

		return { column, version };
	}

	private async deleteColumnInternal(
		columnId: string,
		moveCardsTo: string | undefined,
		by: string,
	) {
		const snapshot = this.ensureMigrated();
		const column = snapshot.board.columns.find((entry) => entry.id === columnId);
		if (!column) {
			throw new ColumnNotFound({ columnId });
		}

		if (column.cardIds.length > 0 && !moveCardsTo) {
			throw new ColumnNotEmpty({ columnId, cardCount: column.cardIds.length });
		}

		let cards = [...snapshot.cards];
		let cardsMoved = 0;
		let nextColumns = snapshot.board.columns.filter((entry) => entry.id !== columnId);

		if (moveCardsTo && column.cardIds.length > 0) {
			const targetColumn = nextColumns.find((entry) => entry.id === moveCardsTo);
			if (!targetColumn) {
				throw new ColumnNotFound({ columnId: moveCardsTo });
			}

			cardsMoved = column.cardIds.length;
			cards = snapshot.cards.map((entry) =>
				column.cardIds.includes(entry.id)
					? ({ ...entry, columnId: moveCardsTo, updatedAt: new Date().toISOString() } as Card)
					: entry,
			);
			nextColumns = nextColumns.map((entry) =>
				entry.id === moveCardsTo
					? ({
							...entry,
							cardIds: [...entry.cardIds, ...column.cardIds],
						} as Column)
					: entry,
			);
		}

		nextColumns = nextColumns.map(
			(entry, index) =>
				({
					...entry,
					position: index,
				}) as Column,
		);

		const version = snapshot.board.version + 1;
		const board = this.withBoardMeta(snapshot.board, {
			columns: nextColumns,
			version,
		});

		this.setState({
			...this.state,
			board,
			cards,
			presence: this.prunePresence(this.state.presence),
		});

		await this.appendChange({
			version,
			op: "column:delete",
			columnId,
			snapshot: null,
			by,
		});

		this.capture(by, "column deleted", {
			board_id: this.boardId,
			column_id: columnId,
			cards_moved: cardsMoved,
			actor_type: by.split(":")[0],
		});

		return { deleted: columnId, cardsMoved, version };
	}

	private async reorderColumnsInternal(columnIds: readonly string[], by: string) {
		const snapshot = this.ensureMigrated();
		const currentIds = snapshot.board.columns.map((entry) => entry.id);

		// Validate: input must be a permutation of the current column ids.
		// Anything else (missing, extra, or duplicate id) is rejected so the
		// server never has to invent ordering.
		if (columnIds.length !== currentIds.length) {
			throw new ValidationError({
				message: `reorderColumns expected ${currentIds.length} ids, got ${columnIds.length}`,
			});
		}
		const seen = new Set<string>();
		for (const id of columnIds) {
			if (seen.has(id)) {
				throw new ValidationError({
					message: `reorderColumns contains duplicate id: ${id}`,
				});
			}
			seen.add(id);
			if (!currentIds.includes(id)) {
				throw new ColumnNotFound({ columnId: id });
			}
		}

		// No-op if the ordering matches what we already have.
		const sameOrder = currentIds.every((id, index) => id === columnIds[index]);
		if (sameOrder) {
			return { columns: snapshot.board.columns, version: snapshot.board.version };
		}

		const byId = new Map(snapshot.board.columns.map((entry) => [entry.id, entry]));
		const nextColumns = columnIds.map(
			(id, index) =>
				({
					...(byId.get(id) as Column),
					position: index,
				}) as Column,
		);

		const version = snapshot.board.version + 1;
		const board = this.withBoardMeta(snapshot.board, {
			columns: nextColumns,
			version,
		});

		this.setState({
			...this.state,
			board,
			cards: [...snapshot.cards],
			presence: this.prunePresence(this.state.presence),
		});

		await this.appendChange({
			version,
			op: "column:reorder",
			columnIds,
			snapshot: null,
			by,
		});

		return { columns: nextColumns, version };
	}

	private withBoardMeta(board: Board, updates: Partial<Board> & { version: number }) {
		return {
			...board,
			...updates,
			updatedAt: new Date().toISOString(),
		} as Board;
	}

	// Ensure the board and its cards have the Symphony-compatible fields the
	// API contract now exposes (`nextCardSeq` on the board, `identifier` on
	// every card). Idempotent: cheap boolean check on already-migrated state.
	//
	// We migrate on demand instead of via a one-shot startup hook because the
	// Agents SDK loads state lazily and we want any read or write to return a
	// consistent view to the agent on the other end of the wire.
	private ensureMigrated(): BoardSnapshot {
		// Inline the board-null check (rather than delegating to
		// `requireSnapshot`) so the rest of this file can call
		// `ensureMigrated` everywhere without risking recursion.
		const currentBoard = this.state.board;
		if (!currentBoard) {
			throw new BoardNotFound({ boardId: this.boardId });
		}
		const snapshot: BoardSnapshot = {
			board: currentBoard,
			cards: this.state.cards,
		} as BoardSnapshot;
		const boardNeedsSeq = snapshot.board.nextCardSeq === undefined;
		const cardsNeedingId = snapshot.cards.filter((entry) => !entry.identifier);

		if (!boardNeedsSeq && cardsNeedingId.length === 0) {
			return snapshot;
		}

		// Defensive: tolerate a partial prior migration (some cards already
		// stamped). Take the max sequence already in use as the starting point
		// so we never reuse an identifier.
		const idPrefix = `${this.boardId}-`;
		let maxSeq = 0;
		for (const card of snapshot.cards) {
			if (!card.identifier?.startsWith(idPrefix)) continue;
			const tail = card.identifier.slice(idPrefix.length);
			const parsed = Number(tail);
			if (Number.isInteger(parsed) && parsed > maxSeq) maxSeq = parsed;
		}

		// Assign identifiers in createdAt order so the numbering tracks
		// creation order. Stable for replay/debug.
		const ordered = [...cardsNeedingId].sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt),
		);
		const assigned = new Map<string, string>();
		for (const card of ordered) {
			maxSeq += 1;
			assigned.set(card.id, `${idPrefix}${maxSeq}`);
		}

		const cards = snapshot.cards.map((card) =>
			card.identifier
				? card
				: ({ ...card, identifier: assigned.get(card.id) } as Card),
		);
		const nextCardSeq = Math.max(snapshot.board.nextCardSeq ?? 1, maxSeq + 1);
		const board = { ...snapshot.board, nextCardSeq } as Board;

		this.setState({
			...this.state,
			board,
			cards,
			presence: this.prunePresence(this.state.presence),
		});

		return { board, cards } as BoardSnapshot;
	}

	// Mint the next identifier for a new card and return both the identifier
	// and the bumped board sequence, so callers can apply both in the same
	// `setState` to keep them consistent.
	private mintCardIdentifier(board: Board): { identifier: string; nextCardSeq: number } {
		const seq = board.nextCardSeq ?? 1;
		return {
			identifier: `${board.id}-${seq}`,
			nextCardSeq: seq + 1,
		};
	}

	// Trim, reject empty entries, reject duplicates. Server preserves case so
	// that consumers that care about case (e.g. UI badge styling) stay accurate;
	// the CLI side normalises to lowercase when filtering.
	private normalizeStringList(
		values: readonly string[] | undefined,
		field: string,
	): readonly string[] | undefined {
		if (values === undefined) return undefined;
		const seen = new Set<string>();
		const out: string[] = [];
		for (const raw of values) {
			const trimmed = raw.trim();
			if (!trimmed) {
				throw new ValidationError({ message: `${field}: empty value not allowed` });
			}
			if (seen.has(trimmed)) {
				throw new ValidationError({ message: `${field}: duplicate value "${trimmed}"` });
			}
			seen.add(trimmed);
			out.push(trimmed);
		}
		return out;
	}

	private async appendChange(params: AppendChangeParams) {
		const entry = {
			version: params.version,
			op: params.op,
			cardId: params.cardId,
			columnId: params.columnId,
			fromColumnId: params.fromColumnId,
			columnIds: params.columnIds,
			snapshot: params.snapshot,
			by: params.by as Change["by"],
			at: new Date().toISOString(),
		} as Change;
		await this.ctx.storage.put(changeKey(params.version), entry);

		const all = await this.ctx.storage.list({ prefix: "changelog:" });
		if (all.size <= CHANGELOG_RETENTION) return;

		const toPrune = all.size - CHANGELOG_RETENTION;
		const iterator = all.keys();
		for (let index = 0; index < toPrune; index++) {
			const next = iterator.next();
			if (next.done) break;
			await this.ctx.storage.delete(next.value);
		}
	}

	private async readChanges(afterVersion: number, limit: number): Promise<ChangeFeedRead> {
		const all = await this.ctx.storage.list<Change>({ prefix: "changelog:" });
		const entries = Array.from(all.values()) as Change[];
		const toVersion = this.state.board?.version ?? 0;

		if (entries.length === 0) {
			return {
				fromVersion: toVersion + 1,
				toVersion,
				isFirstSync: afterVersion === 0 && toVersion > 0,
				changes: [],
			};
		}

		const oldestVersion = entries[0]!.version;
		const newest = entries[entries.length - 1]!;

		if (afterVersion > 0 && afterVersion < oldestVersion - 1) {
			return {
				fromVersion: oldestVersion,
				toVersion: newest.version,
				isFirstSync: true,
				changes: [],
			};
		}

		if (afterVersion === 0) {
			return {
				fromVersion: oldestVersion,
				toVersion: newest.version,
				isFirstSync: true,
				changes: [],
			};
		}

		const changes = entries.filter((entry) => entry.version > afterVersion).slice(0, limit);
		return {
			fromVersion: changes.length > 0 ? changes[0]!.version : afterVersion + 1,
			toVersion: newest.version,
			isFirstSync: false,
			changes,
		};
	}

	private async getAgentCursor(agentId: string) {
		const value = await this.ctx.storage.get<number>(cursorKey(agentId));
		return typeof value === "number" ? value : undefined;
	}

	private async setAgentCursor(agentId: string, version: number) {
		await this.ctx.storage.put(cursorKey(agentId), version);
	}

	private handleError(error: unknown): Response {
		const tag = (error as { _tag?: string } | null)?._tag;
		if (tag === "BoardNotFound") {
			const typed = error as BoardNotFound;
			return this.json({ _tag: tag, boardId: typed.boardId }, 404);
		}
		if (tag === "CardNotFound") {
			const typed = error as CardNotFound;
			return this.json({ _tag: tag, cardId: typed.cardId }, 404);
		}
		if (tag === "ColumnNotFound") {
			const typed = error as ColumnNotFound;
			return this.json({ _tag: tag, columnId: typed.columnId }, 404);
		}
		if (tag === "ColumnNotEmpty") {
			const typed = error as ColumnNotEmpty;
			return this.json({ _tag: tag, columnId: typed.columnId, cardCount: typed.cardCount }, 409);
		}
		if (tag === "ValidationError") {
			const typed = error as ValidationError;
			return this.json({ _tag: tag, message: typed.message }, 400);
		}

		this.captureException(error instanceof Error ? error : new Error(String(error)));
		const message = error instanceof Error ? error.message : "Internal error";
		return this.json({ error: message }, 500);
	}

	private json(data: unknown, status = 200) {
		return new Response(JSON.stringify(data), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}
}
