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
  SliceStatusPill,
  SourceBadge,
  StateGlyph,
  Text,
  toneClasses,
  type SliceShow,
  type Status,
} from "@mach/ui";
import { graphStates, type MachNode } from "@mach/ui/graph";
import { client } from "../../api/client";
import { ApproveEpicDialog } from "../vision/ApproveEpicDialog";

export interface NodeSheetProps {
  node: MachNode | null;
  status: Status;
  nodes: MachNode[];
  onClose: () => void;
  onSelect: (node: MachNode) => void;
  onNewSlice: (epicId: string) => void;
}

/** What it means for the PM, by graph state. Never presents approval or acceptance as built work. */
const meaning: Record<string, string> = {
  proposed: "Nothing is settled yet.",
  interviewing: "Being worked out in the interview.",
  ready: "The specification is complete and passes every check. It is waiting for your approval.",
  approved: "You approved this definition. It reaches engineering when a delivery wave containing it is sent.",
  submitted: "Sent to engineering for review. Nobody has built anything yet.",
  accepted: "Engineering accepted the definition into the shared project. It is not built yet.",
  blocked: "An automatic check on its review request is failing.",
  superseded: "Replaced by later work. Kept for history.",
};

export function NodeSheet({ node, status, nodes, onClose, onSelect, onNewSlice }: NodeSheetProps) {
  const [approve, setApprove] = useState(false);
  const kind = node?.data.kind;
  const title = node ? (kind === "product" ? node.data.title : `${node.data.artifactId}: ${node.data.title}`) : "";
  const d = node ? graphStates[node.data.state] : null;

  return (
    <>
      <Sheet open={node !== null && !approve} onOpenChange={(open) => !open && onClose()}>
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
                  {meaning[node.data.state]}
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
                <EpicDetail
                  id={node.data.artifactId}
                  status={status}
                  nodes={nodes}
                  onSelect={onSelect}
                  onNewSlice={onNewSlice}
                  onApprove={() => setApprove(true)}
                />
              ) : null}
              {kind === "product" ? <ProjectDetail status={status} /> : null}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
      <ApproveEpicDialog
        epic={approve && node?.data.kind === "epic" ? { epic_id: node.data.artifactId, title: node.data.title } : null}
        sliceTitles={node ? status.slices.filter((s) => s.epic_id === node.data.artifactId).map((s) => `${s.slice_id} ${s.title}`) : []}
        onOpenChange={(open) => !open && setApprove(false)}
      />
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
  const wave = status.waves.find((w) => w.slices.includes(id) && w.status !== "superseded");
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
        <Fact term="Where it is">
          <SourceBadge source={row.source} showDraft />
        </Fact>
        {wave ? (
          <Fact term="Delivery wave">
            <ArtifactId>{wave.wave_id}</ArtifactId> {wave.sent ? "sent for review" : wave.status === "approved_for_engineering" ? "approved, not sent" : "draft"}
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
        ) : (
          <Button asChild>
            <Link to="/waves">Delivery waves</Link>
          </Button>
        )}
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
  onApprove,
}: {
  id: string;
  status: Status;
  nodes: MachNode[];
  onSelect: (node: MachNode) => void;
  onNewSlice: (epicId: string) => void;
  onApprove: () => void;
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
        <Fact term="Where it is">
          <SourceBadge source={epic.source} showDraft />
        </Fact>
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
      {epic.status === "proposed" ? (
        <Text size="body-sm" tone="muted">
          Its slices can be worked on now, but none can be approved until you approve the epic.
        </Text>
      ) : null}
      <Actions>
        <Button variant="primary" onClick={() => onNewSlice(id)} disabled={epic.status === "superseded" || epic.status === "completed"}>
          Start a slice in this epic
        </Button>
        {epic.status === "proposed" ? <Button onClick={onApprove}>Approve {id}</Button> : null}
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
