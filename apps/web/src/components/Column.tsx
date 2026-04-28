import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Card as CardType, Column as ColumnType } from "@kangent/board-core";
import { useState } from "react";
import { Card } from "./Card";
import {
	ActionsRow,
	ColumnInlineButton,
	ColumnTitleInput,
	PrimaryButton,
	SurfacePanel,
	TextAction,
	Textarea,
	scrollbarThinClass,
} from "./ui";

interface ColumnProps {
	column: ColumnType & { cards: CardType[] };
	onAddCard: (title: string) => void;
	onCardClick: (card: CardType) => void;
	onUpdateTitle: (title: string) => void;
	onDelete: () => void;
}

// Identifier used by @dnd-kit for the column-as-sortable. Cards still use the
// card's raw id, so we namespace columns to keep the two id spaces disjoint.
export const columnSortId = (id: string) => `column-sort:${id}`;

export function Column({ column, onAddCard, onCardClick, onUpdateTitle, onDelete }: ColumnProps) {
	const [isAddingCard, setIsAddingCard] = useState(false);
	const [newCardTitle, setNewCardTitle] = useState("");
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [editTitle, setEditTitle] = useState(column.title);

	// useSortable for the column itself: positions the column on the board
	// and surfaces drag listeners that we attach to the header only.
	const {
		attributes,
		listeners,
		setNodeRef: setSortableRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: columnSortId(column.id),
		data: { type: "column", columnId: column.id },
	});

	// Droppable for cards landing in this column — separate from the column's
	// sortable handle so dropping a card on empty space inside the column works.
	const { setNodeRef: setDropRef } = useDroppable({
		id: `column:${column.id}`,
		data: { type: "column", column },
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.55 : 1,
	};

	const handleAddCard = () => {
		if (newCardTitle.trim()) {
			onAddCard(newCardTitle.trim());
			setNewCardTitle("");
			setIsAddingCard(false);
		}
	};

	const handleSaveTitle = () => {
		if (editTitle.trim() && editTitle !== column.title) {
			onUpdateTitle(editTitle.trim());
		}
		setIsEditingTitle(false);
	};

	return (
		<div ref={setSortableRef} style={style} className="shrink-0 basis-[270px] flex flex-col gap-3">
			<div
				// The column header acts as the drag handle. Listeners only attach
				// here so clicks on cards/inputs below don't initiate a column drag.
				{...(!isEditingTitle ? attributes : {})}
				{...(!isEditingTitle ? listeners : {})}
				className={`relative flex flex-row items-center justify-between gap-3 pt-[14px] pb-3 before:content-[''] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-border ${
					isEditingTitle ? "" : "cursor-grab active:cursor-grabbing"
				}`}
			>
				{isEditingTitle ? (
					<ColumnTitleInput
						type="text"
						value={editTitle}
						onChange={(e) => setEditTitle(e.target.value)}
						onBlur={handleSaveTitle}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleSaveTitle();
							if (e.key === "Escape") setIsEditingTitle(false);
						}}
						autoFocus
					/>
				) : (
					<>
						<button
							className="p-0 border-0 bg-transparent text-left text-xs leading-4 tracking-[0.12em] uppercase text-text-muted"
							onClick={(e) => {
								// Don't bubble to the drag handle.
								e.stopPropagation();
								setEditTitle(column.title);
								setIsEditingTitle(true);
							}}
							onPointerDown={(e) => e.stopPropagation()}
							type="button"
						>
							{column.title}
						</button>
						<button
							onClick={(e) => {
								e.stopPropagation();
								onDelete();
							}}
							onPointerDown={(e) => e.stopPropagation()}
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
				ref={setDropRef}
				className={`flex flex-col gap-[10px] min-h-[44px] ${scrollbarThinClass}`}
			>
				<SortableContext
					items={column.cards.map((c) => c.id)}
					strategy={verticalListSortingStrategy}
				>
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
									e.preventDefault();
									handleAddCard();
								}
								if (e.key === "Escape") setIsAddingCard(false);
							}}
						/>
						<ActionsRow>
							<PrimaryButton label="Add card" onClick={handleAddCard} />
							<TextAction onClick={() => setIsAddingCard(false)}>Cancel</TextAction>
						</ActionsRow>
					</SurfacePanel>
				) : (
					<ColumnInlineButton onClick={() => setIsAddingCard(true)}>
						+ Add a card
					</ColumnInlineButton>
				)}
			</div>
		</div>
	);
}
