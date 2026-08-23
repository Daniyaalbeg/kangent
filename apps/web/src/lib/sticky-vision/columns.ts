// Map a detected sticky-note color to one of the board's existing columns.
//
// Strategy (cheap → smart):
//   1) Title keyword match on the column titles. "Done" is almost always
//      green; "Blocked" is almost always red/pink; etc.
//   2) Fallback by position: warm colors (yellow/pink/orange) → leftmost
//      column (assumed "todo"-ish); cool colors (blue/purple) → middle;
//      green → rightmost (assumed "done"). This matches how teams typically
//      arrange both columns and sticky notes.
//
// The user can always override per-card in the review UI; this only seeds
// the dropdown's default value.

import type { ColorBucket } from "./detect";

const BUCKET_KEYWORDS: Record<ColorBucket, string[]> = {
	yellow: ["todo", "to do", "to-do", "backlog", "ideas", "inbox", "new"],
	green: ["done", "complete", "shipped", "approved", "ready"],
	blue: ["progress", "doing", "working", "active", "wip", "started"],
	pink: ["blocked", "blocker", "issue", "bug", "stuck"],
	orange: ["next", "review", "qa", "testing", "test"],
	purple: ["spike", "research", "design", "exploration"],
	other: [],
};

interface ColumnRef {
	id: string;
	title: string;
}

/** Returns a column id, or null if there are no columns at all. */
export function suggestColumnForColor(
	bucket: ColorBucket,
	columns: readonly ColumnRef[],
): string | null {
	if (columns.length === 0) return null;

	// 1) Keyword match.
	const keywords = BUCKET_KEYWORDS[bucket];
	if (keywords.length > 0) {
		const titleMatch = columns.find((column) => {
			const title = column.title.toLowerCase();
			return keywords.some((kw) => title.includes(kw));
		});
		if (titleMatch) return titleMatch.id;
	}

	// 2) Position fallback. With < 3 columns we can't do "middle"; just send
	//    everything to the first column and let the user re-bucket.
	const first = columns[0];
	if (!first) return null;
	if (columns.length < 3) return first.id;
	const last = columns[columns.length - 1] ?? first;
	const middle = columns[Math.floor(columns.length / 2)] ?? first;

	switch (bucket) {
		case "green":
			return last.id;
		case "blue":
		case "purple":
			return middle.id;
		case "yellow":
		case "pink":
		case "orange":
		case "other":
			return first.id;
	}
}

/** Friendly label for the color chip in the review UI. */
export function bucketLabel(bucket: ColorBucket): string {
	switch (bucket) {
		case "yellow":
			return "Yellow";
		case "pink":
			return "Pink";
		case "blue":
			return "Blue";
		case "green":
			return "Green";
		case "orange":
			return "Orange";
		case "purple":
			return "Purple";
		case "other":
			return "Unknown";
	}
}
