import { useAgent } from "agents/react"
import { useEffect, useMemo, useState } from "react"
import {
	DndContext,
	type DragEndEvent,
	type DragStartEvent,
	PointerSensor,
	closestCorners,
	useSensor,
	useSensors,
} from "@dnd-kit/core"
import type { Card as CardType } from "@kangent/board-core"
import type { BoardAgent, BoardAgentState } from "@kangent/board-worker"
import { nanoid } from "nanoid"
import { AgentAvatars } from "./AgentAvatars"
import { CardDetail } from "./CardDetail"
import { Column } from "./Column"
import { DragOverlay } from "./DragOverlay"
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
	boardId: string
}

export function Board({ boardId }: BoardProps) {
	const [actorId] = useState(() => `human:${nanoid(6)}`)
	const [connected, setConnected] = useState(false)
	const [activeCard, setActiveCard] = useState<CardType | null>(null)
	const [selectedCard, setSelectedCard] = useState<CardType | null>(null)
	const [isAddingColumn, setIsAddingColumn] = useState(false)
	const [newColumnTitle, setNewColumnTitle] = useState("")
	const [shareCopied, setShareCopied] = useState(false)

	const agent = useAgent<BoardAgent, BoardAgentState>({
		agent: "BoardAgent",
		basePath: `api/boards/${boardId}/live`,
		query: { actorId },
		onOpen: () => setConnected(true),
		onClose: () => setConnected(false),
		onError: () => setConnected(false),
	})

	const board = agent.state?.board ?? null
	const cardsList = agent.state?.cards ?? []
	const presence = agent.state?.presence ?? []
	const cards = useMemo(
		() => new Map(cardsList.map((card) => [card.id, card])),
		[cardsList],
	)

	useEffect(() => {
		if (!shareCopied) return
		const timeout = setTimeout(() => setShareCopied(false), 3000)
		return () => clearTimeout(timeout)
	}, [shareCopied])

	const columnsWithCards = useMemo(() => {
		if (!board) return []
		return board.columns.map((column) => ({
			...column,
			cards: column.cardIds
				.map((id) => cards.get(id))
				.filter((card): card is CardType => card !== undefined),
		}))
	}, [board, cards])

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
	)

	const handleShare = async () => {
		if (typeof window === "undefined") return
		const url = window.location.href
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(url)
			} else {
				const textarea = document.createElement("textarea")
				textarea.value = url
				textarea.style.position = "fixed"
				textarea.style.opacity = "0"
				document.body.appendChild(textarea)
				textarea.select()
				document.execCommand("copy")
				document.body.removeChild(textarea)
			}
			setShareCopied(true)
		} catch {
			setShareCopied(false)
		}
	}

	const handleDragStart = (event: DragStartEvent) => {
		const { active } = event
		if (active.data.current?.type === "card") {
			setActiveCard(active.data.current.card)
		}
	}

	const handleDragEnd = (event: DragEndEvent) => {
		setActiveCard(null)
		const { active, over } = event
		if (!board || !over || !active.data.current) return

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
			const column = columnsWithCards.find((entry) => entry.id === targetColumnId)
			const index = column?.cards.findIndex((entry) => entry.id === overCard.id) ?? 0
			position = index
		} else {
			targetColumnId = String(over.id).replace("column:", "")
			const column = columnsWithCards.find((entry) => entry.id === targetColumnId)
			position = column?.cards.length ?? 0
		}

		if (card.columnId === targetColumnId) {
			const column = columnsWithCards.find((entry) => entry.id === targetColumnId)
			const currentIndex = column?.cards.findIndex((entry) => entry.id === card.id) ?? 0
			if (currentIndex === position) return
		}

		void agent.call("moveCard", [
			card.id,
			{ toColumnId: targetColumnId, position, by: actorId },
		])
	}

	const handleAddCard = (columnId: string, title: string) => {
		void agent.call("addCard", [
			{
				columnId,
				title,
				by: actorId,
			},
		])
	}

	const handleUpdateCard = (cardId: string, updates: { title?: string; description?: unknown }) => {
		void agent.call("updateCard", [cardId, { ...updates, by: actorId }])
		setSelectedCard(null)
	}

	const handleDeleteCard = (cardId: string) => {
		void agent.call("deleteCard", [cardId, actorId])
		setSelectedCard(null)
	}

	const handleMoveCardFromModal = (cardId: string, toColumnId: string) => {
		if (!board) return
		const targetColumn = board.columns.find((entry) => entry.id === toColumnId)
		const position = targetColumn?.cardIds.length ?? 0
		void agent.call("moveCard", [
			cardId,
			{ toColumnId, position, by: actorId },
		])
	}

	const handleAddColumn = () => {
		const title = newColumnTitle.trim()
		if (!title) return
		void agent.call("addColumn", [title, actorId])
		setNewColumnTitle("")
		setIsAddingColumn(false)
	}

	const handleUpdateColumnTitle = (columnId: string, title: string) => {
		void agent.call("updateColumn", [columnId, title, actorId])
	}

	const handleDeleteColumn = (columnId: string) => {
		const column = board?.columns.find((entry) => entry.id === columnId)
		const label = column?.title ?? "this column"
		const confirmed = window.confirm(`Delete "${label}"?`)
		if (!confirmed) return
		void agent.call("deleteColumn", [columnId, undefined, actorId])
	}

	if (!board) {
		return (
			<PageShell variant="centered">
				<ContentColumn>
					<NoticeBar
						text={agent.identified ? "Loading board state..." : "Connecting to board..."}
						meta={connected ? "live" : "reconnecting"}
					/>
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
						<ChipButton onClick={() => void handleShare()}>
							{shareCopied ? "copied" : "share"}
						</ChipButton>
						<ChipButton as="a" variant="primary" href="/">
							new board
						</ChipButton>
					</UtilityNav>
				</UtilityHeader>

				<NoticeBar
					text={
						connected
							? "Live board: state is synced through the board agent in real time."
							: "Reconnecting to the board agent..."
					}
					meta={<AgentAvatars presence={presence} />}
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
										onChange={(event) => setNewColumnTitle(event.target.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter") handleAddColumn()
											if (event.key === "Escape") setIsAddingColumn(false)
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
					columns={board.columns.map((column) => ({
						id: column.id,
						title: column.title,
					}))}
					onClose={() => setSelectedCard(null)}
					onSave={(updates) => handleUpdateCard(selectedCard.id, updates)}
					onMove={(toColumnId) => handleMoveCardFromModal(selectedCard.id, toColumnId)}
					onDelete={() => handleDeleteCard(selectedCard.id)}
				/>
			)}
		</PageShell>
	)
}
