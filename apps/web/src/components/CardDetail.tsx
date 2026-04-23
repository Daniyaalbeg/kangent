import { useState } from "react"
import type { Card } from "@kangent/board-core"
import {
	ActionsRow,
	DangerAction,
	DetailBody,
	DetailFooter,
	DetailModal,
	FieldGroup,
	Input,
	MetaLabel,
	MutedCopy,
	PrimaryButton,
	SectionTitle,
	SurfacePanel,
	TextAction,
	Textarea,
	UtilityHeader,
} from "./ui"

interface CardDetailProps {
	card: Card
	columns: { id: string; title: string }[]
	onClose: () => void
	onSave: (updates: { title?: string; description?: unknown }) => void
	onMove: (toColumnId: string) => void
	onDelete: () => void
}

export function CardDetail({
	card,
	columns,
	onClose,
	onSave,
	onMove,
	onDelete,
}: CardDetailProps) {
	const [title, setTitle] = useState(card.title)
	const [description, setDescription] = useState(
		typeof card.description === "string" ? card.description : "",
	)
	const [isEditing, setIsEditing] = useState(false)
	const createdAt = new Date(card.createdAt).toLocaleDateString()

	const handleSave = () => {
		onSave({
			...(title !== card.title ? { title } : {}),
			...(description !== (typeof card.description === "string" ? card.description : "")
				? { description }
				: {}),
		})
		setIsEditing(false)
	}

	return (
		<DetailModal onClose={onClose}>
			<DetailBody>
				<UtilityHeader alignStart>
					{isEditing ? (
						<Input
							type="text"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							autoFocus
						/>
					) : (
						<SectionTitle onClick={() => setIsEditing(true)}>
							{card.title}
						</SectionTitle>
					)}
					<TextAction onClick={onClose}>Close</TextAction>
				</UtilityHeader>

				<div className="mt-3 flex gap-2 text-sm text-text-muted">
					<span>by {card.createdBy}</span>
					<span>&middot;</span>
					<span>{createdAt}</span>
				</div>

				<FieldGroup className="mt-6">
					<MetaLabel htmlFor="card-status">Status</MetaLabel>
					<select
						id="card-status"
						value={card.columnId}
						onChange={(e) => {
							if (e.target.value !== card.columnId) {
								onMove(e.target.value)
							}
						}}
						className="w-full h-[46px] px-[14px] text-lg leading-6 border border-border rounded-[10px] bg-[#fbfbfc] text-text-primary outline-none transition-colors duration-[180ms] focus:border-accent"
					>
						{columns.map((col) => (
							<option key={col.id} value={col.id}>
								{col.title}
							</option>
						))}
					</select>
				</FieldGroup>

				<FieldGroup className="mt-6">
					<MetaLabel htmlFor="card-description">Description</MetaLabel>
					{isEditing ? (
						<Textarea
							id="card-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={6}
							placeholder="Add a description..."
						/>
					) : (
						<SurfacePanel onClick={() => setIsEditing(true)}>
							{description || (
								<MutedCopy as="span">Click to add a description...</MutedCopy>
							)}
						</SurfacePanel>
					)}
				</FieldGroup>

				{isEditing && (
					<ActionsRow className="mt-5">
						<PrimaryButton label="Save" onClick={handleSave} />
						<TextAction onClick={() => setIsEditing(false)}>Cancel</TextAction>
					</ActionsRow>
				)}
			</DetailBody>

			<DetailFooter>
				<DangerAction onClick={onDelete}>Delete card</DangerAction>
			</DetailFooter>
		</DetailModal>
	)
}
