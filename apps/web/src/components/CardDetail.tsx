import type { Card, CardPriority } from "@kangent/board-core";
import { useState } from "react";
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
} from "./ui";

interface CardDetailProps {
	card: Card;
	columns: { id: string; title: string }[];
	onClose: () => void;
	onSave: (updates: {
		title?: string;
		description?: unknown;
		priority?: CardPriority | null;
		dueDate?: string | null;
	}) => void;
	onMove: (toColumnId: string) => void;
	onDelete: () => void;
}

const PRIORITY_OPTIONS: Array<{ value: CardPriority; label: string }> = [
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "urgent", label: "Urgent" },
];

const SELECT_CLASS =
	"w-full h-[46px] px-[14px] text-lg leading-6 border border-border rounded-[10px] bg-[#fbfbfc] text-text-primary outline-none transition-colors duration-[180ms] focus:border-accent";

// dueDate is stored as an ISO date or date-time string. The native <input type="date">
// expects YYYY-MM-DD; truncate ISO inputs so editing in-place works.
function toDateInputValue(iso: string | undefined) {
	if (!iso) return "";
	if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

export function CardDetail({ card, columns, onClose, onSave, onMove, onDelete }: CardDetailProps) {
	const [title, setTitle] = useState(card.title);
	const [description, setDescription] = useState(
		typeof card.description === "string" ? card.description : "",
	);
	const [priority, setPriority] = useState<CardPriority | "">(card.priority ?? "");
	const [dueDate, setDueDate] = useState<string>(toDateInputValue(card.dueDate));
	const [isEditing, setIsEditing] = useState(false);
	const createdAt = new Date(card.createdAt).toLocaleDateString();

	const initialDescription = typeof card.description === "string" ? card.description : "";
	const initialPriority = card.priority ?? "";
	const initialDueDate = toDateInputValue(card.dueDate);

	const handleSave = () => {
		const updates: {
			title?: string;
			description?: unknown;
			priority?: CardPriority | null;
			dueDate?: string | null;
		} = {};
		if (title !== card.title) updates.title = title;
		if (description !== initialDescription) updates.description = description;
		if (priority !== initialPriority) {
			updates.priority = priority === "" ? null : priority;
		}
		if (dueDate !== initialDueDate) {
			updates.dueDate = dueDate === "" ? null : dueDate;
		}
		onSave(updates);
		setIsEditing(false);
	};

	return (
		<DetailModal onClose={onClose}>
			<DetailBody>
				<UtilityHeader alignStart>
					{isEditing ? (
						<Input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
					) : (
						<SectionTitle onClick={() => setIsEditing(true)}>{card.title}</SectionTitle>
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
								onMove(e.target.value);
							}
						}}
						className={SELECT_CLASS}
					>
						{columns.map((col) => (
							<option key={col.id} value={col.id}>
								{col.title}
							</option>
						))}
					</select>
				</FieldGroup>

				<div className="mt-6 grid grid-cols-2 gap-4 max-[640px]:grid-cols-1">
					<FieldGroup>
						<MetaLabel htmlFor="card-priority">Priority</MetaLabel>
						<select
							id="card-priority"
							value={priority}
							onChange={(e) => {
								setPriority(e.target.value as CardPriority | "");
								setIsEditing(true);
							}}
							className={SELECT_CLASS}
						>
							<option value="">No priority</option>
							{PRIORITY_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
					</FieldGroup>

					<FieldGroup>
						<MetaLabel htmlFor="card-due-date">Due date</MetaLabel>
						<Input
							id="card-due-date"
							type="date"
							value={dueDate}
							onChange={(e) => {
								setDueDate(e.target.value);
								setIsEditing(true);
							}}
						/>
					</FieldGroup>
				</div>

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
							{description || <MutedCopy as="span">Click to add a description...</MutedCopy>}
						</SurfacePanel>
					)}
				</FieldGroup>

				{isEditing && (
					<ActionsRow className="mt-5">
						<PrimaryButton label="Save" onClick={handleSave} />
						<TextAction
							onClick={() => {
								setTitle(card.title);
								setDescription(initialDescription);
								setPriority(initialPriority);
								setDueDate(initialDueDate);
								setIsEditing(false);
							}}
						>
							Cancel
						</TextAction>
					</ActionsRow>
				)}
			</DetailBody>

			<DetailFooter>
				<DangerAction onClick={onDelete}>Delete card</DangerAction>
			</DetailFooter>
		</DetailModal>
	);
}
