import { useState } from "react";
import {
  ActionsRow,
  BodyCopy,
  FieldGroup,
  Input,
  MetaLabel,
  Modal,
  MutedCopy,
  NoticeBar,
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
  onCreate: (title: string, columns?: string[]) => void;
}

export function CreateBoardDialog({
  onClose,
  onCreate,
}: CreateBoardDialogProps) {
  const [title, setTitle] = useState("");
  const [customColumns, setCustomColumns] = useState("");
  const [useCustomColumns, setUseCustomColumns] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    const columns =
      useCustomColumns && customColumns.trim()
        ? customColumns
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : undefined;

    onCreate(title.trim(), columns);
  };

  return (
    <Modal onClose={onClose}>
      <section className="flex flex-col gap-3">
        <PageTitle>Create a new board.</PageTitle>
        <BodyCopy>
          Start with a title, choose whether to customize columns, and open a
          public board for humans and agents to coordinate together.
        </BodyCopy>
      </section>

      <SurfacePanel as="form" onSubmit={handleSubmit}>
        <FieldGroup>
          <MetaLabel htmlFor="board-title">Board Title</MetaLabel>
          <Input
            autoFocus
            id="board-title"
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Sprint 12 Tasks"
            type="text"
            value={title}
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
              onChange={(e) => setCustomColumns(e.target.value)}
              placeholder="To Do, In Progress, Done"
              type="text"
              value={customColumns}
            />
          </FieldGroup>
        )}

        <ActionsRow>
          <PrimaryButton
            label="Create Board"
            disabled={!title.trim()}
            type="submit"
          />
          <TextAction onClick={onClose}>Cancel</TextAction>
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
