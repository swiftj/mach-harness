import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import {
  ArtifactId,
  Button,
  EpicStatusPill,
  Sheet,
  SheetContent,
  SkeletonText,
  SliceGithubPills,
  SliceStatusPill,
  StateGlyph,
  Text,
  epicStates,
  githubMarksOf,
  toneClasses,
  type SliceShow,
  type Status,
} from "@mach/ui";
import { graphStates, type GraphState, type MachNode } from "@mach/ui/graph";
import { client } from "../../api/client";
import { IssueLink, IssueNumber } from "../../shared/IssueLink";

export interface NodeSheetProps {
  node: MachNode | null;
  status: Status;
  nodes: MachNode[];
  onClose: () => void;
  onSelect: (node: MachNode) => void;
  onNewSlice: (epicId: string) => void;
}

/** What it means for the PM, by graph state (an epic says its own). Never presents approval as built work. */
const meaning: Record<GraphState, string> = {
  proposed: "Nothing is settled yet.",
  interviewing: "Being worked out in the interview.",
  ready: "The specification is complete and passes every check. It is waiting for you to mark it ready to build.",
  approved: "You approved this text and marked it ready.",
  ready_to_build: "Saved for the builders, who have not taken it yet. Nothing is built yet.",
  building: "The builders have taken it and are building it.",
  question: "The builders asked a question about it on GitHub and are waiting for your answer.",
  shipped: "Built and merged.",
  superseded: "Replaced by later work. Kept for history.",
};

export function NodeSheet({ node, status, nodes, onClose, onSelect, onNewSlice }: NodeSheetProps) {
  const kind = node?.data.kind;
  const title = node ? (kind === "product" ? node.data.title : `${node.data.artifactId}: ${node.data.title}`) : "";
  const d = node ? graphStates[node.data.state] : null;
  const epic = kind === "epic" ? status.epics.find((e) => e.epic_id === node?.data.artifactId) : undefined;

  return (
    <>
      <Sheet open={node !== null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent
          width={480}
          title={title}
          description={kind === "product" ? "The project" : kind === "epic" ? "Epic" : "Slice"}
        >
          {node && d ? (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <span className={`inline-flex items-center gap-2 text-label ${toneClasses[d.tone].ink}`}>
                  <StateGlyph shape={d.glyph} />
                  {node.data.stateLabel ?? d.label}
                </span>
                <Text size="body-sm" tone="muted">
                  {epic ? epicStates[epic.status].description : meaning[node.data.state]}
                </Text>
                {node.data.attention ? (
                  <Text size="body-sm" tone="warning" weight="semibold">
                    {node.data.attention}: settle it on the{" "}
                    <Link to="/inbox" className="underline">
                      Decisions
                    </Link>{" "}
                    screen.
                  </Text>
                ) : null}
              </div>
              {kind === "slice" ? <SliceDetail id={node.data.artifactId} status={status} /> : null}
              {kind === "epic" ? (
                <EpicDetail id={node.data.artifactId} status={status} nodes={nodes} onSelect={onSelect} onNewSlice={onNewSlice} />
              ) : null}
              {kind === "product" ? <ProjectDetail status={status} /> : null}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-body-sm">{children}</dl>;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-muted">{term}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2 border-t border-line pt-5">{children}</div>;
}

function SliceDetail({ id, status }: { id: string; status: Status }) {
  const row = status.slices.find((s) => s.slice_id === id);
  const epic = status.epics.find((e) => e.epic_id === row?.epic_id);
  const [show, setShow] = useState<SliceShow | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    client.op("slice.show", { slice_id: id }).then(
      (result) => live && setShow(result),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [id]);

  if (!row) return null;
  const approved = row.status === "approved_for_engineering" || row.status === "superseded";
  const summary = show?.spec?.model?.summary;
  const openQuestions = show?.spec?.model?.open_questions ?? [];
  return (
    <>
      <Facts>
        <Fact term="Status">
          <SliceStatusPill status={row.status} size="sm" />
        </Fact>
        <Fact term="Epic">{epic ? `${epic.epic_id} ${epic.title}` : row.epic_id}</Fact>
        {row.github.state_label || githubMarksOf(row.github).length ? (
          <Fact term="With the builders">
            <span className="flex flex-wrap gap-1.5">
              <SliceGithubPills github={row.github} size="sm" />
            </span>
          </Fact>
        ) : null}
        {row.github.issue ? (
          <Fact term="Issue">
            <IssueLink number={row.github.issue} url={row.github.url} />
          </Fact>
        ) : null}
        {show ? (
          <Fact term="Needs first">{show.slice.dependencies.length ? show.slice.dependencies.join(", ") : "Nothing"}</Fact>
        ) : null}
      </Facts>
      {!show && !failed ? <SkeletonText lines={3} /> : null}
      {summary ? (
        <div className="flex flex-col gap-1.5">
          <Text size="body-sm" weight="semibold">
            Outcome
          </Text>
          <Text editorial>
            {summary.actor}: {summary.outcome}
          </Text>
        </div>
      ) : null}
      {openQuestions.length ? (
        <div className="flex flex-col gap-1.5">
          <Text size="body-sm" weight="semibold">
            Open questions
          </Text>
          <ul className="flex flex-col gap-1">
            {openQuestions.map((q) => (
              <li key={q.question} className="text-body-sm text-ink">
                {q.question}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {row.resume_note ? (
        <div className="flex flex-col gap-1.5">
          <Text size="body-sm" weight="semibold">
            Where the interview stopped
          </Text>
          <Text editorial tone="muted">
            {row.resume_note}
          </Text>
        </div>
      ) : null}
      {failed ? (
        <Text size="body-sm" tone="muted">
          The specification’s details could not be read just now.
        </Text>
      ) : null}
      <Actions>
        <Button variant={approved ? "primary" : "secondary"} asChild>
          <Link to={`/slices/${id}`}>
            Open the specification
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
        {!approved ? (
          <Button variant="primary" asChild>
            <Link to={`/slices/${id}/interview`}>{row.status === "draft" ? "Start the interview" : "Continue the interview"}</Link>
          </Button>
        ) : null}
      </Actions>
    </>
  );
}

function EpicDetail({
  id,
  status,
  nodes,
  onSelect,
  onNewSlice,
}: {
  id: string;
  status: Status;
  nodes: MachNode[];
  onSelect: (node: MachNode) => void;
  onNewSlice: (epicId: string) => void;
}) {
  const epic = status.epics.find((e) => e.epic_id === id);
  if (!epic) return null;
  const slices = status.slices.filter((s) => s.epic_id === id);
  return (
    <>
      <Facts>
        <Fact term="Status">
          <EpicStatusPill status={epic.status} size="sm" />
        </Fact>
        {epic.issue ? (
          <Fact term="Issue">
            <IssueNumber number={epic.issue} url={epic.url} />
          </Fact>
        ) : null}
      </Facts>
      <div className="flex flex-col gap-2">
        <Text size="body-sm" weight="semibold">
          Slices
        </Text>
        {slices.length ? (
          <ul className="flex flex-col gap-1">
            {slices.map((s) => {
              const node = nodes.find((n) => n.id === `slice:${s.slice_id}`);
              return (
                <li key={s.slice_id}>
                  <button
                    type="button"
                    onClick={() => node && onSelect(node)}
                    className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-body-sm hover:bg-surface-sunken"
                  >
                    <ArtifactId plain>{s.slice_id}</ArtifactId>
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    <SliceStatusPill status={s.status} size="sm" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <Text size="body-sm" tone="muted">
            No slices yet.
          </Text>
        )}
      </div>
      <Actions>
        <Button variant="primary" onClick={() => onNewSlice(id)}>
          Start a slice in this epic
        </Button>
        <Button variant="ghost" asChild>
          <Link to="/vision" state={{ focus: "epics" }}>
            Edit in Vision
          </Link>
        </Button>
      </Actions>
    </>
  );
}

function ProjectDetail({ status }: { status: Status }) {
  const project = status.project!;
  return (
    <>
      <Text editorial size="body-lg">
        {project.vision}
      </Text>
      <div className="flex flex-col gap-1.5">
        <Text size="body-sm" weight="semibold">
          Intended outcomes
        </Text>
        <ul className="flex flex-col gap-1">
          {project.outcomes.map((o) => (
            <li key={o} className="text-body-sm text-ink">
              {o}
            </li>
          ))}
        </ul>
      </div>
      <Actions>
        <Button asChild>
          <Link to="/vision">Edit the vision</Link>
        </Button>
      </Actions>
    </>
  );
}
