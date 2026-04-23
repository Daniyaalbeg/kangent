import { useState } from "react"
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { useDroppable } from "@dnd-kit/core"
import type { Card as CardType, Column as ColumnType } from "@kangent/board-core"
import { Card } from "./Card"
import {
	ActionsRow,
	ColumnInlineButton,
	ColumnTitleInput,
	PrimaryButton,
	SurfacePanel,
	TextAction,
	Textarea,
	scrollbarThinClass,
} from "./ui"

interface ColumnProps {
	column: ColumnType & { cards: CardType[] }
	onAddCard: (title: string) => void
	onCardClick: (card: CardType) => void
	onUpdateTitle: (title: string) => void
	onDelete: () => void
}

export function Column({
	column,
	onAddCard,
	onCardClick,
	onUpdateTitle,
	onDelete,
}: ColumnProps) {
	const [isAddingCard, setIsAddingCard] = useState(false)
	const [newCardTitle, setNewCardTitle] = useState("")
	const [isEditingTitle, setIsEditingTitle] = useState(false)
	const [editTitle, setEditTitle] = useState(column.title)

	const { setNodeRef } = useDroppable({
		id: `column:${column.id}`,
		data: { type: "column", column },
	})

	const handleAddCard = () => {
		if (newCardTitle.trim()) {
			onAddCard(newCardTitle.trim())
			setNewCardTitle("")
			setIsAddingCard(false)
		}
	}

	const handleSaveTitle = () => {
		if (editTitle.trim() && editTitle !== column.title) {
			onUpdateTitle(editTitle.trim())
		}
		setIsEditingTitle(false)
	}

	return (
		<div className="shrink-0 basis-[270px] flex flex-col gap-3">
			<div className="relative flex flex-row items-center justify-between gap-3 pt-[14px] pb-3 before:content-[''] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-border">
				{isEditingTitle ? (
					<ColumnTitleInput
						type="text"
						value={editTitle}
						onChange={(e) => setEditTitle(e.target.value)}
						onBlur={handleSaveTitle}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleSaveTitle()
							if (e.key === "Escape") setIsEditingTitle(false)
						}}
						autoFocus
					/>
				) : (
					<>
						<button
							className="p-0 border-0 bg-transparent text-left text-xs leading-4 tracking-[0.12em] uppercase text-text-muted"
							onClick={() => {
								setEditTitle(column.title)
								setIsEditingTitle(true)
							}}
							type="button"
						>
							{column.title}
						</button>
						<button
							onClick={onDelete}
							className="p-0 border-0 bg-transparent cursor-pointer text-xs leading-4 text-text-subtle"
							title="Delete column"
							type="button"
						>
							&times;
						</button>
					</>
				)}
			</div>

			<div
				ref={setNodeRef}
				className={`flex flex-col gap-[10px] min-h-[44px] ${scrollbarThinClass}`}
			>
				<SortableContext items={column.cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
					{column.cards.map((card) => (
						<Card key={card.id} card={card} onClick={() => onCardClick(card)} />
					))}
				</SortableContext>
				{isAddingCard ? (
					<SurfacePanel>
						<Textarea
							value={newCardTitle}
							onChange={(e) => setNewCardTitle(e.target.value)}
							placeholder="Enter card title..."
							rows={2}
							autoFocus
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault()
									handleAddCard()
								}
								if (e.key === "Escape") setIsAddingCard(false)
							}}
						/>
						<ActionsRow>
							<PrimaryButton label="Add card" onClick={handleAddCard} />
							<TextAction onClick={() => setIsAddingCard(false)}>
								Cancel
							</TextAction>
						</ActionsRow>
					</SurfacePanel>
				) : (
					<ColumnInlineButton onClick={() => setIsAddingCard(true)}>
						+ Add a card
					</ColumnInlineButton>
				)}
			</div>
		</div>
	)
}
