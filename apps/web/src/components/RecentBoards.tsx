import { Link } from "@tanstack/react-router";
import { useBoardHistory } from "~/hooks/useBoardHistory";
import type { BoardHistoryEntry, BoardOrigin } from "~/lib/boardHistory";
import { TextAction } from "./ui";

const RELATIVE_DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
	{ amount: 60, unit: "second" },
	{ amount: 60, unit: "minute" },
	{ amount: 24, unit: "hour" },
	{ amount: 7, unit: "day" },
	{ amount: 4.34524, unit: "week" },
	{ amount: 12, unit: "month" },
	{ amount: Number.POSITIVE_INFINITY, unit: "year" },
];

const relativeFormatter =
	typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl
		? new Intl.RelativeTimeFormat("en", { numeric: "auto" })
		: null;

function formatRelative(ms: number): string {
	const diffSeconds = (ms - Date.now()) / 1000;
	if (!relativeFormatter) {
		// Fallback if Intl.RelativeTimeFormat isn't around.
		const abs = Math.abs(diffSeconds);
		if (abs < 60) return "just now";
		if (abs < 3600) return `${Math.round(abs / 60)}m ago`;
		if (abs < 86400) return `${Math.round(abs / 3600)}h ago`;
		return `${Math.round(abs / 86400)}d ago`;
	}
	let duration = diffSeconds;
	for (const division of RELATIVE_DIVISIONS) {
		if (Math.abs(duration) < division.amount) {
			return relativeFormatter.format(Math.round(duration), division.unit);
		}
		duration /= division.amount;
	}
	return relativeFormatter.format(Math.round(duration), "year");
}

function originLabel(origin: BoardOrigin): string {
	return origin === "created" ? "yours" : "visited";
}

function originBadgeClass(origin: BoardOrigin): string {
	return origin === "created"
		? "bg-[color-mix(in_srgb,var(--color-accent)_12%,white)] text-accent"
		: "bg-surface-muted text-text-secondary";
}

interface RecentBoardRowProps {
	board: BoardHistoryEntry;
	onRemove: (boardId: string) => void;
}

function RecentBoardRow({ board, onRemove }: RecentBoardRowProps) {
	return (
		<li className="group relative flex items-center gap-3 rounded-[10px] bg-surface px-[14px] py-[10px] ring-1 ring-inset ring-border-soft transition-transform duration-[180ms] hover:-translate-y-px">
			<Link
				to="/b/$boardId"
				params={{ boardId: board.id }}
				className="flex flex-1 items-center gap-3 min-w-0 no-underline text-text-primary"
			>
				<span className="flex-1 min-w-0 truncate text-[15px] leading-[22px]">{board.title}</span>
				<span
					className={`inline-flex items-center justify-center h-5 px-2 rounded-full text-[11px] leading-[14px] font-medium ${originBadgeClass(board.origin)}`}
				>
					{originLabel(board.origin)}
				</span>
				<span className="text-xs leading-4 text-text-muted whitespace-nowrap">
					{formatRelative(board.lastAccessedAt)}
				</span>
			</Link>
			<button
				type="button"
				aria-label={`Remove ${board.title} from history`}
				onClick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					onRemove(board.id);
				}}
				className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity duration-[140ms] text-text-muted hover:text-text-primary text-base leading-none px-1"
			>
				×
			</button>
		</li>
	);
}

export function RecentBoards({ limit = 12 }: { limit?: number }) {
	const { boards, loaded, remove, clear } = useBoardHistory(limit);

	// Don't render anything until we've checked storage — avoids a flash on
	// first paint, and keeps the home page clean for genuinely new users.
	if (!loaded || boards.length === 0) return null;

	const createdCount = boards.filter((b) => b.origin === "created").length;
	const visitedCount = boards.length - createdCount;

	return (
		<section className="mt-10 flex flex-col gap-3" aria-label="Your boards">
			<header className="flex items-baseline justify-between gap-3">
				<span className="text-xs leading-4 tracking-[0.12em] uppercase text-text-muted">
					Your boards
				</span>
				<span className="text-xs leading-4 text-text-muted">
					{createdCount > 0 && (
						<>
							{createdCount} created
							{visitedCount > 0 && " · "}
						</>
					)}
					{visitedCount > 0 && <>{visitedCount} visited</>}
				</span>
			</header>

			<ul className="list-none p-0 m-0 flex flex-col gap-2">
				{boards.map((board) => (
					<RecentBoardRow key={board.id} board={board} onRemove={(id) => void remove(id)} />
				))}
			</ul>

			<div className="flex justify-end">
				<TextAction
					onClick={() => {
						if (window.confirm("Clear all locally stored boards?")) {
							void clear();
						}
					}}
				>
					Clear history
				</TextAction>
			</div>
		</section>
	);
}
