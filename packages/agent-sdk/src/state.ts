/**
 * Local agent state for Kangent. Lives at `~/.kangent/state.yaml` and tracks
 * every board this user/agent has touched, so a fresh chat can answer
 * "which board are we working on?" without having to ask.
 *
 * Why YAML: the file is meant to be read directly by agents (and humans
 * inspecting it). YAML is more eye-readable than JSON and supports comments,
 * which lets agents leave notes alongside entries.
 *
 * - Boards are keyed by id and tagged with the `project` (cwd at record time)
 *   so an agent can resolve "the board for this repo" automatically.
 * - `origin` is sticky: a board you created stays `'created'` forever even
 *   after re-visiting it.
 * - Writes are atomic via tmp + rename. The file is created with mode 0600
 *   (only the owning user can read it), since URLs are the auth-equivalent
 *   for Kangent boards today.
 *
 * The whole module is Node-only. Browsers will tree-shake it out as long as
 * callers gate imports with a `typeof process` check or only use it server-side.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

const STATE_VERSION = 1 as const;

export type BoardOrigin = "created" | "visited";

export interface BoardEntry {
	/** Kangent board id (e.g. `"abc123xyz789"`). */
	id: string;
	/** Canonical board URL — agents can hand this back to humans verbatim. */
	url: string;
	/** Cached title for display. May be stale if the board was renamed elsewhere. */
	title?: string;
	/** First-write-wins: 'created' is never downgraded to 'visited'. */
	origin: BoardOrigin;
	/** Absolute path to the cwd at record time. Empty/undefined = global. */
	project?: string;
	/** ISO timestamp of the first time we saw this board. */
	firstAccessedAt: string;
	/** ISO timestamp of the most recent access. Sort key for "recent boards". */
	lastAccessedAt: string;
	/** Monotonic counter for how many times we've recorded this board. */
	visitCount: number;
}

export interface KangentState {
	version: typeof STATE_VERSION;
	/** Stable per-machine identifier; safe to use as a base for `X-Agent-Id`. */
	agentId: string;
	/** Optional explicit pin — overrides project-based lookup if set. */
	activeBoardId?: string;
	/** All known boards keyed by id. */
	boards: Record<string, BoardEntry>;
}

/* ---------- Paths & low-level I/O ---------- */

function stateDir(): string {
	return process.env.KANGENT_STATE_DIR ?? join(homedir(), ".kangent");
}

function stateFile(): string {
	return process.env.KANGENT_STATE_FILE ?? join(stateDir(), "state.yaml");
}

function freshState(): KangentState {
	return {
		version: STATE_VERSION,
		agentId: `agent-${randomUUID()}`,
		boards: {},
	};
}

async function readState(): Promise<KangentState> {
	try {
		const raw = await fs.readFile(stateFile(), "utf8");
		const parsed = YAML.parse(raw) as Partial<KangentState> | null;
		if (
			parsed &&
			parsed.version === STATE_VERSION &&
			parsed.boards &&
			typeof parsed.boards === "object"
		) {
			return {
				version: STATE_VERSION,
				agentId: parsed.agentId ?? `agent-${randomUUID()}`,
				activeBoardId: parsed.activeBoardId,
				boards: parsed.boards as Record<string, BoardEntry>,
			};
		}
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code !== "ENOENT") {
			// Corrupt file or unreadable — fall through to a fresh state and
			// let the next write reset it. Don't throw; agents shouldn't crash
			// because their cache is broken.
			console.warn("[kangent] state.yaml unreadable, starting fresh:", err);
		}
	}
	return freshState();
}

const FILE_HEADER = `# Kangent agent state — managed by @kangent/agent-sdk and any agent that
# follows the SKILL.md convention. Safe to read by hand; safe to edit if you
# know what you're doing. Boards you've created or visited live under \`boards\`.
`;

async function writeState(state: KangentState): Promise<void> {
	const dir = stateDir();
	const file = stateFile();
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	const yaml = YAML.stringify(state, {
		// Force quoting for strings that look like dates / numbers / etc., so
		// round-trips don't drift. lineWidth: 0 disables word wrapping (URLs and
		// titles stay on a single line — much easier to grep and diff).
		defaultStringType: "QUOTE_DOUBLE",
		defaultKeyType: "PLAIN",
		lineWidth: 0,
		indent: 2,
	});
	await fs.writeFile(tmp, FILE_HEADER + yaml, {
		encoding: "utf8",
		mode: 0o600,
	});
	// `rename` on the same filesystem is atomic — readers either see the old
	// file or the new one, never a half-written truncation.
	await fs.rename(tmp, file);
}

function sameProject(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	try {
		return resolve(a) === resolve(b);
	} catch {
		return a === b;
	}
}

/* ---------- Public API ---------- */

export interface RecordBoardAccessParams {
	boardId: string;
	url?: string;
	title?: string;
	origin: BoardOrigin;
	/**
	 * Override the project tag. Defaults to `process.cwd()`. Pass `null` to
	 * record without a project (e.g. for boards used outside any repo).
	 */
	project?: string | null;
}

/**
 * Upsert a board entry. Bumps `visitCount`, updates `lastAccessedAt`, and
 * sets `activeBoardId` to this id so it becomes the default for follow-up
 * lookups. Origin is sticky.
 */
export async function recordBoardAccess(params: RecordBoardAccessParams): Promise<BoardEntry> {
	const state = await readState();
	const now = new Date().toISOString();
	const project =
		params.project === null ? undefined : (params.project ?? process.cwd());

	const existing = state.boards[params.boardId];
	const entry: BoardEntry = existing
		? {
				...existing,
				url: params.url ?? existing.url,
				title: params.title ?? existing.title,
				origin: existing.origin === "created" ? "created" : params.origin,
				// Don't drop a previously-known project just because the caller didn't pass one.
				project: project ?? existing.project,
				lastAccessedAt: now,
				visitCount: existing.visitCount + 1,
			}
		: {
				id: params.boardId,
				url: params.url ?? "",
				title: params.title,
				origin: params.origin,
				project,
				firstAccessedAt: now,
				lastAccessedAt: now,
				visitCount: 1,
			};

	state.boards[params.boardId] = entry;
	state.activeBoardId = params.boardId;
	await writeState(state);
	return entry;
}

export interface ListBoardsOptions {
	/** Filter to boards recorded against this project path. Use `null` for global-only. */
	project?: string | null;
	/** Cap results. */
	limit?: number;
}

export async function listBoards(options: ListBoardsOptions = {}): Promise<BoardEntry[]> {
	const state = await readState();
	let entries = Object.values(state.boards);

	if (options.project === null) {
		entries = entries.filter((entry) => !entry.project);
	} else if (options.project !== undefined) {
		entries = entries.filter((entry) => sameProject(entry.project, options.project!));
	}

	entries.sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt));
	if (options.limit && options.limit > 0) entries = entries.slice(0, options.limit);
	return entries;
}

/**
 * Single most-recent board for the current (or given) project. Returns `null`
 * if the user has never recorded a board against this directory.
 */
export async function getBoardForProject(
	project: string = process.cwd(),
): Promise<BoardEntry | null> {
	const list = await listBoards({ project, limit: 1 });
	return list[0] ?? null;
}

/** Most-recent board across all projects. Useful when there's no cwd context. */
export async function getMostRecentBoard(): Promise<BoardEntry | null> {
	const list = await listBoards({ limit: 1 });
	return list[0] ?? null;
}

export async function getActiveBoard(): Promise<BoardEntry | null> {
	const state = await readState();
	if (!state.activeBoardId) return null;
	return state.boards[state.activeBoardId] ?? null;
}

export async function setActiveBoard(boardId: string | null): Promise<void> {
	const state = await readState();
	if (boardId === null) {
		state.activeBoardId = undefined;
	} else {
		if (!state.boards[boardId]) {
			throw new Error(
				`[kangent] cannot pin unknown board "${boardId}" — call recordBoardAccess() first.`,
			);
		}
		state.activeBoardId = boardId;
	}
	await writeState(state);
}

export async function removeBoard(boardId: string): Promise<void> {
	const state = await readState();
	delete state.boards[boardId];
	if (state.activeBoardId === boardId) state.activeBoardId = undefined;
	await writeState(state);
}

export async function clearBoards(): Promise<void> {
	const state = await readState();
	state.boards = {};
	state.activeBoardId = undefined;
	await writeState(state);
}

/**
 * Stable per-machine agent identifier. Persisted in state.yaml so successive
 * chats use the same value — pair with a tool prefix to derive `X-Agent-Id`,
 * e.g. `${tool}-${agentId}` so Codex and Claude Code keep separate cursors
 * on the same machine.
 */
export async function getAgentId(): Promise<string> {
	const state = await readState();
	if (!state.agentId) {
		state.agentId = `agent-${randomUUID()}`;
		await writeState(state);
	}
	return state.agentId;
}

/* ---------- URL parsing helpers ---------- */

export interface BoardReference {
	boardId: string;
	url?: string;
}

const URL_RE = /https?:\/\/[^\s)]+/i;
const BOARD_RE = /\/b\/([A-Za-z0-9_-]+)/;
const API_RE = /\/api\/boards\/([A-Za-z0-9_-]+)/;

/**
 * Pull a Kangent board reference out of free-form text. Useful when the user
 * pastes a URL like "work on https://kangent.dev/b/abc123xyz789".
 *
 *  - Matches `/b/<id>` and `/api/boards/<id>` paths.
 *  - Returns `null` if no recognizable id is present.
 */
export function parseBoardReference(text: string): BoardReference | null {
	if (!text) return null;
	const urlMatch = text.match(URL_RE);
	const url = urlMatch?.[0];
	const haystack = url ?? text;
	const board = haystack.match(BOARD_RE);
	if (board?.[1]) return { boardId: board[1], url };
	const api = haystack.match(API_RE);
	if (api?.[1]) return { boardId: api[1], url };
	return null;
}

/* ---------- Path inspection ---------- */

/** Directory holding `state.yaml`. Useful for telling users where to look. */
export function getStateDirectory(): string {
	return stateDir();
}

/** Full path to the state file. */
export function getStateFilePath(): string {
	return stateFile();
}
