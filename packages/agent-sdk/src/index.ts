export { makeClient, makeClientEffect } from "./client.js";
export { KangentHttpClient, type KangentHttpClientOptions } from "./http.js";
export {
	type BoardEntry,
	type BoardOrigin,
	type BoardReference,
	type KangentState,
	type ListBoardsOptions,
	type RecordBoardAccessParams,
	clearBoards,
	getActiveBoard,
	getAgentId,
	getBoardForProject,
	getMostRecentBoard,
	getStateDirectory,
	getStateFilePath,
	listBoards,
	parseBoardReference,
	recordBoardAccess,
	removeBoard,
	setActiveBoard,
} from "./state.js";
