import { useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { CircleAlert, CircleDashed, Scale, TriangleAlert } from "lucide-react";
import { Button, ErrorState, Skeleton, SkeletonText, StatusPill, describeError } from "@mach/ui";
import type { CaseShow, IdeaRow, IdeaShow, MachApiError } from "@mach/ui/api";
import { useOperation } from "../../../api/useOperation";
import { Part, Parts } from "../../../shared/layout/Parts";
import { OnePane, WorkPane, WorkPanes } from "../../../shared/layout/WorkScreen";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";
import { CaseCheck, CaseCheckPill, CaseSection, NoCase } from "./CaseSection";
import { caseSummary, decisionWord, openOnArrival, publishState, publishSummary, verdictState, verdictSummary, type CasePart } from "./model";
import { PublishSection, StatePill } from "./PublishSection";
import { VerdictSection } from "./VerdictSection";

/**
 * The case as the customer would hear it, the hard questions with the product manager's answers, and the verdict.
 *
 * Owned by screen engineer 4 (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 6). Data: case.show (which carries
 * case.check's result), idea.show (verdict, verdict_note, the brief's revision, where it is saved), verdict.record,
 * idea.publish, idea.renumber. Fixtures: ?fixture=status.ideas with IDEA-003 (a case, one question left on purpose,
 * no verdict); ?case=none; ?idea=go|not-now|fault|stale-verdict|on-github; ?verdict=...; ?publish-idea=....
 *
 * Laid out in two panes (M16 layout, docs/mach-next/M16_LAYOUT.md): the wide pane holds three parts, one open at a
 * time (the case, the verdict, publishing), each row saying its state; the narrow pane keeps the case's check and the
 * questions without an answer in view while the person decides.
 */
export function CaseScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="case" layout="panes" lead="Before any epic exists: the case as the customer would hear it, the hardest questions, and your verdict.">
      {(row) => <CaseBody row={row} />}
    </IdeaStepFrame>
  );
}

function CaseBody({ row }: { row: IdeaRow }) {
  const ideaShow = useOperation("idea.show", { idea_id: row.idea_id });
  // Ask for the case only when the board says one is written; otherwise "no case yet" needs no call.
  const caseShow = useOperation("case.show", row.has_case ? { idea_id: row.idea_id } : null);

  if (ideaShow.error && !ideaShow.data) {
    const { title, message } = describeError(ideaShow.error);
    return (
      <OnePane label="The case">
        <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={ideaShow.reload}>Try again</Button>} />
      </OnePane>
    );
  }
  const show = ideaShow.data;
  if (!show)
    return (
      <OnePane label="The case">
        <div className="flex flex-col gap-4" aria-busy="true" role="status" aria-label="Reading the case and the verdict">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </OnePane>
    );

  const caseLoading = row.has_case && !caseShow.data && !caseShow.error;
  const caseBody = caseLoading ? (
    <div className="flex flex-col gap-4" aria-busy="true" role="status" aria-label="Reading the case">
      <Skeleton className="h-24 w-full" />
      <SkeletonText lines={5} />
    </div>
  ) : caseShow.data ? (
    <CaseSection shown={caseShow.data} />
  ) : caseShow.error && caseShow.error.kind !== "refused" ? (
    <CaseError error={caseShow.error} onRetry={caseShow.reload} />
  ) : (
    <NoCase ideaId={row.idea_id} message={caseShow.error?.message ?? null} />
  );

  return (
    <WorkPanes>
      <WorkPane label="The case, the verdict and publishing">
        <CaseParts row={row} show={show} shown={caseShow.data ?? null} caseLoading={caseLoading} caseBody={caseBody} onChanged={ideaShow.reload} />
      </WorkPane>
      {caseShow.data ? (
        <WorkPane side label="The case's check">
          <CaseCheck ideaId={row.idea_id} shown={caseShow.data} />
        </WorkPane>
      ) : null}
    </WorkPanes>
  );
}

/**
 * The three parts. The verdict is open on arrival, or publishing when saving stopped part way or is the board's next
 * step. Each closed part's row carries its state in words and a pill, so nothing needed to decide is hidden.
 */
function CaseParts({
  row,
  show,
  shown,
  caseLoading,
  caseBody,
  onChanged,
}: {
  row: IdeaRow;
  show: IdeaShow;
  shown: CaseShow | null;
  caseLoading: boolean;
  caseBody: ReactNode;
  onChanged: () => void;
}) {
  const publish = publishState(show.idea.github);
  const [open, setOpen] = useState<string | null>(() => openOnArrival(publish, row.next.kind));
  const verdict = verdictState(show.verdict);
  const shaped = !show.acts.verdict.allowed;
  return (
    <Parts label="The case, the verdict and publishing" open={open} onOpenChange={(id) => setOpen(id as CasePart | null)}>
      <Part id="case" name="The case" summary={caseLoading ? "Reading the case" : caseSummary(shown?.model ?? null)} status={shown ? <CaseCheckPill shown={shown} /> : null}>
        {caseBody}
      </Part>
      <Part id="verdict" name="Your verdict" summary={verdictSummary(verdict, shaped, show.verdict_note)} status={<VerdictPill verdict={verdict} />}>
        <VerdictSection row={row} show={show} onRecorded={onChanged} />
      </Part>
      <Part id="publish" name="Saved for others to read" summary={publishSummary(publish)} status={<StatePill state={publish} />}>
        <PublishSection row={row} show={show} onChanged={onChanged} />
      </Part>
    </Parts>
  );
}

/** The verdict as a pill: the decision's word with one shape for all three, so none looks preferred. */
function VerdictPill({ verdict }: { verdict: ReturnType<typeof verdictState> }) {
  if (verdict.kind === "none")
    return (
      <StatusPill icon={<CircleDashed aria-hidden="true" />} className="border-dashed">
        No verdict yet
      </StatusPill>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <StatusPill icon={<Scale aria-hidden="true" />}>{decisionWord(verdict.verdict.decision)}</StatusPill>
      {verdict.kind === "stale" ? (
        <StatusPill tone="warning" icon={<TriangleAlert aria-hidden="true" />} className="border-dashed">
          No longer holds
        </StatusPill>
      ) : null}
    </span>
  );
}

function CaseError({ error, onRetry }: { error: MachApiError; onRetry: () => void }) {
  const { title, message } = describeError(error);
  return <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={onRetry}>Try again</Button>} />;
}
