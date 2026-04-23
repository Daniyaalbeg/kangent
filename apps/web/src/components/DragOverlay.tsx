import { DragOverlay as DndDragOverlay } from "@dnd-kit/core"
import type { Card as CardType } from "@kangent/board-core"
import { BOARD_CARD_CLASS } from "./Card"

interface DragOverlayProps {
	activeCard: CardType | null
}

export function DragOverlay({ activeCard }: DragOverlayProps) {
	if (!activeCard) return null
	const description =
		typeof activeCard.description === "string"
			? activeCard.description
			: activeCard.description
				? "Rich text content"
				: null

	return (
		<DndDragOverlay>
			<div
				className={BOARD_CARD_CLASS}
				style={{ opacity: 0.92, rotate: "2deg", width: 270 }}
			>
				<h4 className="m-0 font-serif font-medium text-[29px] leading-[1.05] text-balance">
					{activeCard.title}
				</h4>
				{description && (
					<p className="m-0 text-[13px] leading-[1.45] text-text-secondary line-clamp-2">
						{description}
					</p>
				)}
			</div>
		</DndDragOverlay>
	)
}
