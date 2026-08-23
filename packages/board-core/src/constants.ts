export const BOARD_ID_LENGTH = 12;
export const MAX_COLUMNS = 20;
export const MAX_CARDS_PER_COLUMN = 500;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 50_000;
// Default column titles for new boards. Aligned with Symphony's default
// `tracker.active_states` / `terminal_states` so a Kangent board works as a
// Symphony tracker out of the box without per-board state remapping.
// Lowercase comparison is used by Symphony, but the CLI side normalises —
// the server preserves the case shown here.
export const DEFAULT_COLUMNS = ["Todo", "In Progress", "Done"] as const;
