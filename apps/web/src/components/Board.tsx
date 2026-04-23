import { useState, useCallback, useEffect, useMemo } from "react"
import {
	DndContext,
	type DragStartEvent,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
	closestCorners,
} from "@dnd-kit/core"
import type { Card as CardType } from "@kangent/board-core"
import { useBoardStore } from "~/lib/store"
import { Column } from "./Column"
import { CardDetail } from "./CardDetail"
import { DragOverlay } from "./DragOverlay"
import { AgentAvatars } from "./AgentAvatars"
import { nanoid } from "nanoid"
import {
	ActionsRow,
	Brand,
	ChipButton,
	ContentColumn,
	GhostButton,
	Input,
	NoticeBar,
	PageShell,
	PageTitle,
	PrimaryButton,
	SurfacePanel,
	TextAction,
	UtilityHeader,
	UtilityLinkSpan,
	UtilityNav,
	scrollbarThinClass,
} from "./ui"

interface BoardProps {
	sendOp: (op: Record<string, unknown>) => void
}

export function Board({ sendOp }: BoardProps) {
	const board = useBoardStore((s) => s.board)
	const cards = useBoardStore((s) => s.cards)
	const addCard = useBoardStore((s) => s.addCard)
	const updateCard = useBoardStore((s) => s.updateCard)
	const moveCard = useBoardStore((s) => s.moveCard)
	const deleteCard = useBoardStore((s) => s.deleteCard)
	const addColumn = useBoardStore((s) => s.addColumn)
	const updateColumn = useBoardStore((s) => s.updateColumn)
	const deleteColumn = useBoardStore((s) => s.deleteColumn)

	const [activeCard, setActiveCard] = useState<CardType | null>(null)
	const [selectedCard, setSelectedCard] = useState<CardType | null>(null)
	const [isAddingColumn, setIsAddingColumn] = useState(false)
	const [newColumnTitle, setNewColumnTitle] = useState("")
	const [shareCopied, setShareCopied] = useState(false)

	const handleShare = useCallback(async () => {
		if (typeof window === "undefined") return
		const url = window.location.href
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(url)
			} else {
				const ta = document.createElement("textarea")
				ta.value = url
				ta.style.position = "fixed"
				ta.style.opacity = "0"
				document.body.appendChild(ta)
				ta.select()
				document.execCommand("copy")
				document.body.removeChild(ta)
			}
			setShareCopied(true)
		} catch {
			setShareCopied(false)
		}
	}, [])

	useEffect(() => {
		if (!shareCopied) return
		const t = setTimeout(() => setShareCopied(false), 3000)
		return () => clearTimeout(t)
	}, [shareCopied])

	const columnsWithCards = useMemo(() => {
		if (!board) return []
		return board.columns.map((col) => ({
			...col,
			cards: col.cardIds
				.map((id) => cards.get(id))
				.filter((c): c is CardType => c !== undefined),
		}))
	}, [board, cards])

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
	)

	const handleDragStart = useCallback((event: DragStartEvent) => {
		const { active } = event
		if (active.data.current?.type === "card") {
			setActiveCard(active.data.current.card)
		}
	}, [])

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			setActiveCard(null)
			const { active, over } = event
			if (!over || !active.data.current) return

			const activeData = active.data.current
			if (activeData.type !== "card") return

			const card = activeData.card as CardType
			let targetColumnId: string
			let position: number

			if (over.data.current?.type === "column") {
				targetColumnId = over.data.current.column.id
				position = over.data.current.column.cardIds?.length ?? 0
			} else if (over.data.current?.type === "card") {
				const overCard = over.data.current.card as CardType
				targetColumnId = overCard.columnId
				const col = columnsWithCards.find((c) => c.id === targetColumnId)
				const idx = col?.cards.findIndex((c) => c.id === overCard.id) ?? 0
				position = idx
			} else {
				// Dropped on a column droppable
				const colId = String(over.id).replace("column:", "")
				targetColumnId = colId
				const col = columnsWithCards.find((c) => c.id === colId)
				position = col?.cards.length ?? 0
			}

			if (card.columnId === targetColumnId) {
				const col = columnsWithCards.find((c) => c.id === targetColumnId)
				const currentIdx = col?.cards.findIndex((c) => c.id === card.id) ?? 0
				if (currentIdx === position) return
			}

			moveCard(card.id, targetColumnId, position)
			sendOp({
				type: "card:move",
				opId: nanoid(8),
				cardId: card.id,
				toColumnId: targetColumnId,
				position,
			})
		},
		[columnsWithCards, moveCard, sendOp],
	)

	const handleAddCard = useCallback(
		(columnId: string, title: string) => {
			addCard(columnId, title)
			sendOp({
				type: "card:add",
				opId: nanoid(8),
				columnId,
				title,
			})
		},
		[addCard, sendOp],
	)

	const handleUpdateCard = useCallback(
		(cardId: string, updates: { title?: string; description?: unknown }) => {
			updateCard(cardId, updates)
			sendOp({
				type: "card:update",
				opId: nanoid(8),
				cardId,
				...updates,
			})
			setSelectedCard(null)
		},
		[updateCard, sendOp],
	)

	const handleDeleteCard = useCallback(
		(cardId: string) => {
			deleteCard(cardId)
			sendOp({
				type: "card:delete",
				opId: nanoid(8),
				cardId,
			})
			setSelectedCard(null)
		},
		[deleteCard, sendOp],
	)

	const handleMoveCardFromModal = useCallback(
		(cardId: string, toColumnId: string) => {
			const targetCol = board?.columns.find((c) => c.id === toColumnId)
			const position = targetCol?.cardIds.length ?? 0
			moveCard(cardId, toColumnId, position)
			sendOp({
				type: "card:move",
				opId: nanoid(8),
				cardId,
				toColumnId,
				position,
			})
			setSelectedCard((prev) =>
				prev && prev.id === cardId
					? ({ ...prev, columnId: toColumnId, position } as CardType)
					: prev,
			)
		},
		[board, moveCard, sendOp],
	)

	const handleAddColumn = useCallback(() => {
		if (!newColumnTitle.trim()) return
		addColumn(newColumnTitle.trim())
		sendOp({
			type: "column:add",
			opId: nanoid(8),
			title: newColumnTitle.trim(),
		})
		setNewColumnTitle("")
		setIsAddingColumn(false)
	}, [newColumnTitle, addColumn, sendOp])

	const handleUpdateColumnTitle = useCallback(
		(columnId: string, title: string) => {
			updateColumn(columnId, title)
			sendOp({
				type: "column:update",
				opId: nanoid(8),
				columnId,
				title,
			})
		},
		[updateColumn, sendOp],
	)

	const handleDeleteColumn = useCallback(
		(columnId: string) => {
			const col = board?.columns.find((c) => c.id === columnId)
			const label = col?.title ?? "this column"
			const confirmed = window.confirm(
				`Delete "${label}"? This will also remove the cards it contains.`,
			)
			if (!confirmed) return
			deleteColumn(columnId)
			sendOp({
				type: "column:delete",
				opId: nanoid(8),
				columnId,
			})
		},
		[board, deleteColumn, sendOp],
	)

	if (!board) {
		return (
			<PageShell variant="centered">
				<ContentColumn>
					<NoticeBar text="Loading board state..." meta="sync" />
				</ContentColumn>
			</PageShell>
		)
	}

	return (
		<PageShell variant="board">
			<div className="flex flex-col gap-[18px]">
				<UtilityHeader>
					<UtilityNav align="start">
						<Brand />
						<UtilityLinkSpan>public board</UtilityLinkSpan>
					</UtilityNav>
					<UtilityNav>
						<ChipButton onClick={handleShare}>
						{shareCopied ? "copied" : "share"}
					</ChipButton>
						<ChipButton as="a" variant="primary" href="/">
							new board
						</ChipButton>
					</UtilityNav>
				</UtilityHeader>

				<NoticeBar
					text="Live board: human edits and agent actions stay visible to everyone in real time."
					meta={<AgentAvatars />}
				/>

				<section className="flex items-end justify-between gap-6 max-[900px]:flex-col max-[900px]:items-stretch">
					<div className="flex flex-col gap-2">
						<PageTitle>{board.title}</PageTitle>
					</div>
				</section>

				<DndContext
					sensors={sensors}
					collisionDetection={closestCorners}
					onDragStart={handleDragStart}
					onDragEnd={handleDragEnd}
				>
					<div
						className={`flex gap-[18px] items-start overflow-x-auto pb-3 max-[900px]:pb-5 ${scrollbarThinClass}`}
					>
						{columnsWithCards.map((column) => (
							<Column
								key={column.id}
								column={column}
								onAddCard={(title) => handleAddCard(column.id, title)}
								onCardClick={setSelectedCard}
								onUpdateTitle={(title) => handleUpdateColumnTitle(column.id, title)}
								onDelete={() => handleDeleteColumn(column.id)}
							/>
						))}

						{isAddingColumn ? (
							<div className="shrink-0 basis-[270px] flex flex-col gap-3">
								<div className="relative flex flex-col gap-[10px] pt-[14px] pb-3 before:content-[''] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-border">
									<div className="flex items-center justify-between gap-3">
										<span className="text-xs leading-4 tracking-[0.12em] uppercase text-text-muted">
											Column
										</span>
										<span className="text-xs leading-4 text-text-subtle">+</span>
									</div>
								</div>
								<SurfacePanel>
									<Input
										autoFocus
										onChange={(e) => setNewColumnTitle(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") handleAddColumn()
											if (e.key === "Escape") setIsAddingColumn(false)
										}}
										placeholder="Column title..."
										type="text"
										value={newColumnTitle}
									/>
									<ActionsRow>
										<PrimaryButton label="Add column" onClick={handleAddColumn} />
										<TextAction onClick={() => setIsAddingColumn(false)}>
											Cancel
										</TextAction>
									</ActionsRow>
								</SurfacePanel>
							</div>
						) : (
							<button
								onClick={() => setIsAddingColumn(true)}
								className="shrink-0 basis-[270px] flex flex-col gap-3 bg-transparent p-0 border-0 text-left"
								type="button"
							>
								<div className="relative flex flex-col gap-[10px] pt-[14px] pb-3 before:content-[''] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-border">
									<div className="flex items-center justify-between gap-3">
										<span className="text-xs leading-4 tracking-[0.12em] uppercase text-text-muted">
											Column
										</span>
										<span className="text-xs leading-4 text-text-subtle">+</span>
									</div>
								</div>
								<GhostButton muted>+ Add column</GhostButton>
							</button>
						)}
					</div>

					<DragOverlay activeCard={activeCard} />
				</DndContext>
			</div>

			{selectedCard && (
				<CardDetail
					card={cards.get(selectedCard.id) ?? selectedCard}
					columns={board.columns.map((c) => ({ id: c.id, title: c.title }))}
					onClose={() => setSelectedCard(null)}
					onSave={(updates) => handleUpdateCard(selectedCard.id, updates)}
					onMove={(toColumnId) =>
						handleMoveCardFromModal(selectedCard.id, toColumnId)
					}
					onDelete={() => handleDeleteCard(selectedCard.id)}
				/>
			)}
		</PageShell>
	)
}
