import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { Card as CardType } from "@kangent/board-core"
import { AgentBadge } from "./ui"

interface CardProps {
	card: CardType
	onClick: () => void
}

const BOARD_CARD_CLASS =
	"flex flex-col gap-2 p-[14px] rounded-xl bg-surface cursor-grab active:cursor-grabbing " +
	"ring-1 ring-inset ring-border-soft " +
	"transition-[transform,box-shadow] duration-[180ms] " +
	"hover:-translate-y-px hover:shadow-[inset_0_0_0_1px_var(--color-border),0_10px_24px_-18px_rgb(39_39_42/0.38)]"

export { BOARD_CARD_CLASS }

export function Card({ card, onClick }: CardProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: card.id,
		data: { type: "card", card },
	})

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	}

	const isAgent = card.createdBy?.startsWith("ai:")
	const description =
		typeof card.description === "string"
			? card.description
			: card.description
				? "Rich text content"
				: null

	return (
		<div
			ref={setNodeRef}
			style={style}
			{...attributes}
			{...listeners}
			onClick={onClick}
			className={BOARD_CARD_CLASS}
		>
			<div className="flex items-start justify-between gap-[10px]">
				<h4 className="m-0 font-serif font-medium text-[29px] leading-[1.05] text-balance">
					{card.title}
				</h4>
				{isAgent && <AgentBadge />}
			</div>
			{description && (
				<p className="m-0 text-[13px] leading-[1.45] text-text-secondary line-clamp-2">
					{description}
				</p>
			)}
			<div className="text-[13px] leading-[18px] text-text-muted">
				<span>{card.createdBy}</span>
			</div>
		</div>
	)
}
