import { DragOverlay as DndDragOverlay } from "@dnd-kit/core";
import type { Card as CardType, Column as ColumnType } from "@kangent/board-core";
import { BOARD_CARD_CLASS } from "./Card";

type DragActive = { type: "card"; card: CardType } | { type: "column"; column: ColumnType } | null;

interface DragOverlayProps {
	activeDrag: DragActive;
}

export function DragOverlay({ activeDrag }: DragOverlayProps) {
	if (!activeDrag) return null;

	if (activeDrag.type === "card") {
		const card = activeDrag.card;
		const description =
			typeof card.description === "string"
				? card.description
				: card.description
					? "Rich text content"
					: null;
		return (
			<DndDragOverlay>
				<div className={BOARD_CARD_CLASS} style={{ opacity: 0.92, rotate: "2deg", width: 270 }}>
					<h4 className="m-0 font-serif font-medium text-[29px] leading-[1.05] text-balance">
						{card.title}
					</h4>
					{description && (
						<p className="m-0 text-[13px] leading-[1.45] text-text-secondary line-clamp-2">
							{description}
						</p>
					)}
				</div>
			</DndDragOverlay>
		);
	}

	const column = activeDrag.column;
	return (
		<DndDragOverlay>
			<div
				className="shrink-0 basis-[270px] flex flex-col gap-3"
				style={{ opacity: 0.92, rotate: "1deg", width: 270 }}
			>
				<div className="relative flex flex-row items-center justify-between gap-3 pt-[14px] pb-3 before:content-[''] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-border">
					<span className="text-xs leading-4 tracking-[0.12em] uppercase text-text-muted">
						{column.title}
					</span>
					<span className="text-xs leading-4 text-text-subtle">{column.cardIds.length}</span>
				</div>
				<div className="flex flex-col gap-[10px] min-h-[44px] p-2 rounded-xl bg-surface-muted ring-1 ring-inset ring-border-soft" />
			</div>
		</DndDragOverlay>
	);
}
