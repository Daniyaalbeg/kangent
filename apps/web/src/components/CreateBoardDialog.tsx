import { useState } from "react";
import {
	ActionsRow,
	BodyCopy,
	FieldGroup,
	Input,
	MetaLabel,
	Modal,
	MutedCopy,
	PageTitle,
	PrimaryButton,
	SectionTitle,
	SurfacePanel,
	TextAction,
	Toggle,
	ToggleRow,
} from "./ui";

interface CreateBoardDialogProps {
	onClose: () => void;
	// Resolves on success. Reject (throw) to surface the error inline in the
	// dialog without dismissing it — the user can fix the input and retry.
	onCreate: (title: string, columns?: string[]) => Promise<void>;
}

export function CreateBoardDialog({ onClose, onCreate }: CreateBoardDialogProps) {
	const [title, setTitle] = useState("");
	const [customColumns, setCustomColumns] = useState("");
	const [useCustomColumns, setUseCustomColumns] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (isSubmitting || !title.trim()) return;

		const columns =
			useCustomColumns && customColumns.trim()
				? customColumns
						.split(",")
						.map((c) => c.trim())
						.filter(Boolean)
				: undefined;

		setIsSubmitting(true);
		setErrorMessage(null);
		try {
			await onCreate(title.trim(), columns);
			// Parent navigates on success and unmounts us — no need to reset state.
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : "Couldn't create the board.");
			setIsSubmitting(false);
		}
	};

	return (
		<Modal onClose={onClose}>
			<section className="flex flex-col gap-3">
				<PageTitle>Create a new board.</PageTitle>
				<BodyCopy>
					Start with a title, choose whether to customize columns, and open a public board for
					humans and agents to coordinate together.
				</BodyCopy>
			</section>

			<SurfacePanel as="form" onSubmit={handleSubmit}>
				<FieldGroup>
					<MetaLabel htmlFor="board-title">Board Title</MetaLabel>
					<Input
						autoFocus
						id="board-title"
						onChange={(e) => {
							setTitle(e.target.value);
							if (errorMessage) setErrorMessage(null);
						}}
						placeholder="e.g. Sprint 12 Tasks"
						type="text"
						value={title}
						disabled={isSubmitting}
					/>
				</FieldGroup>

				<ToggleRow>
					<div className="flex flex-col gap-1">
						<SectionTitle as="h3">Custom columns</SectionTitle>
						<MutedCopy>
							{useCustomColumns
								? "Provide comma-separated columns for your initial board."
								: "Default columns: To Do, In Progress, Done"}
						</MutedCopy>
					</div>
					<Toggle
						checked={useCustomColumns}
						onChange={() => setUseCustomColumns((value) => !value)}
					/>
				</ToggleRow>

				{useCustomColumns && (
					<FieldGroup>
						<MetaLabel htmlFor="custom-columns">Columns</MetaLabel>
						<Input
							id="custom-columns"
							onChange={(e) => {
								setCustomColumns(e.target.value);
								if (errorMessage) setErrorMessage(null);
							}}
							placeholder="To Do, In Progress, Done"
							type="text"
							value={customColumns}
							disabled={isSubmitting}
						/>
					</FieldGroup>
				)}

				{errorMessage && (
					<div
						role="alert"
						className="rounded-[10px] px-[14px] py-[10px] text-[13px] leading-[18px] bg-[color-mix(in_srgb,var(--color-danger)_10%,white)] text-danger ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-danger)_28%,transparent)]"
					>
						{errorMessage}
					</div>
				)}

				<ActionsRow>
					<PrimaryButton
						label={isSubmitting ? "Creating…" : "Create Board"}
						disabled={!title.trim() || isSubmitting}
						type="submit"
					/>
					<TextAction onClick={onClose} disabled={isSubmitting}>
						Cancel
					</TextAction>
				</ActionsRow>
			</SurfacePanel>

			{/*<NoticeBar
        text={
          <>
            Agents can use your board immediately once they receive the board
            URL and associated <code>SKILL.md</code> instructions.
          </>
        }
        meta="instant setup"
      />*/}
		</Modal>
	);
}
