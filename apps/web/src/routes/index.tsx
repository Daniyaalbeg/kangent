import { createRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CreateBoardDialog } from "~/components/CreateBoardDialog";
import { InstallBlock } from "~/components/InstallBlock";
import { RecentBoards } from "~/components/RecentBoards";
import {
  BodyCopy,
  Brand,
  ContentColumn,
  DisplayTitle,
  FeatureCard,
  FeatureGrid,
  MutedCopy,
  NoticeBar,
  PageShell,
  PrimaryButton,
  UtilityHeader,
  UtilityLink,
  UtilityNav,
} from "~/components/ui";
import { recordBoardAccess } from "~/lib/boardHistory";
import { Route as rootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const [showDialog, setShowDialog] = useState(false);
  const features = [
    {
      id: "01",
      title: "Real-time",
      copy: "WebSocket-powered live sync. See changes as they happen.",
    },
    {
      id: "02",
      title: "Agent-ready",
      copy: "HTTP API + SKILL.md. Any agent can manage boards instantly.",
    },
    {
      id: "03",
      title: "No auth",
      copy: "Board at a URL. Share and collaborate immediately.",
    },
  ];

  const handleCreate = async (title: string, columns?: string[]) => {
    let res: Response;
    try {
      res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          columns,
          by: "human:anonymous",
        }),
      });
    } catch {
      // Network failure — couldn't reach the worker at all.
      throw new Error("Couldn't reach the server. Check your connection and try again.");
    }

    if (!res.ok) {
      // Try to surface the server's structured error if it's there. Effect
      // errors come back as { _tag: "ValidationError", message: "..." }.
      const fallback = `Server returned ${res.status}.`;
      const body = (await res.json().catch(() => null)) as
        | { _tag?: string; message?: string }
        | null;
      const message = body?.message ?? fallback;
      throw new Error(message);
    }

    const data = (await res.json()) as { id: string };
    // Record before navigating so the entry is in IDB by the time we land
    // on the board page (which will upsert with `'visited'` — origin stays 'created').
    await recordBoardAccess(data.id, title, "created");
    navigate({ to: "/b/$boardId", params: { boardId: data.id } });
  };

  return (
    <PageShell variant="centered">
      <ContentColumn>
        <UtilityHeader aria-label="Primary">
          <Brand />
          <UtilityNav aria-label="Primary">
            <UtilityLink
              href="https://github.com/daniyaalbeg/kangent/blob/main/skills/kangent/SKILL.md"
              target="_blank"
              rel="noreferrer"
            >
              board API
            </UtilityLink>
          </UtilityNav>
        </UtilityHeader>

        <section className="mt-12 flex flex-col">
          <DisplayTitle className="text-balance">
            Kanban for agents
            <br />
            and sometimes humans
          </DisplayTitle>
          <div className="mt-8 flex flex-col gap-3">
            <BodyCopy>
              Give an agent a skill file, it gets full access. Create a board
              instantly and collaborate in real time without logging in.
            </BodyCopy>
            <BodyCopy>
              Kangent keeps planning visible, editable, and shareable from one
              URL.
            </BodyCopy>
          </div>
        </section>

        <div className="mt-8 text-center">
          <PrimaryButton
            fullWidth
            label="Create a Board"
            icon="◎"
            onClick={() => setShowDialog(true)}
          />
          <MutedCopy className="mt-[12px]">
            Share a board URL with collaborators or connect an agent using{" "}
            <code>SKILL.md</code>.
          </MutedCopy>
        </div>

        <RecentBoards />

        <FeatureGrid className="mt-10">
          {features.map((feature) => (
            <FeatureCard
              key={feature.id}
              id={feature.id}
              title={feature.title}
              copy={feature.copy}
            />
          ))}
        </FeatureGrid>

        <InstallBlock />
      </ContentColumn>

      {showDialog && (
        <CreateBoardDialog
          onClose={() => setShowDialog(false)}
          onCreate={handleCreate}
        />
      )}
    </PageShell>
  );
}
