import { useParams } from "react-router";
import { CircleAlert } from "lucide-react";
import { Button, ErrorState, Skeleton, SkeletonText, describeError } from "@mach/ui";
import type { IdeaRow, MachApiError } from "@mach/ui/api";
import { useOperation } from "../../../api/useOperation";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";
import { CaseSection, NoCase } from "./CaseSection";
import { PublishSection } from "./PublishSection";
import { VerdictSection } from "./VerdictSection";

/**
 * The case as the customer would hear it, the hard questions with the product manager's answers, and the verdict.
 *
 * Owned by screen engineer 4 (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 6). Data: case.show (which carries
 * case.check's result), idea.show (verdict, verdict_note, the brief's revision, where it is saved), verdict.record,
 * idea.publish, idea.renumber. Fixtures: ?fixture=status.ideas with IDEA-003 (a case, one question left on purpose,
 * no verdict); ?case=none; ?idea=go|not-now|fault|stale-verdict|on-github; ?verdict=...; ?publish-idea=....
 */
export function CaseScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="case" lead="Before any epic exists: the case as the customer would hear it, the hardest questions, and your verdict.">
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
    return <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={ideaShow.reload}>Try again</Button>} />;
  }
  const show = ideaShow.data;
  const caseLoading = row.has_case && !caseShow.data && !caseShow.error;

  return (
    <div className="flex flex-col gap-8">
      {caseLoading ? (
        <div className="flex flex-col gap-4" aria-busy="true" role="status" aria-label="Reading the case">
          <Skeleton className="h-24 w-full" />
          <SkeletonText lines={5} />
        </div>
      ) : caseShow.data ? (
        <CaseSection ideaId={row.idea_id} shown={caseShow.data} />
      ) : caseShow.error && caseShow.error.kind !== "refused" ? (
        <CaseError error={caseShow.error} onRetry={caseShow.reload} />
      ) : (
        <NoCase ideaId={row.idea_id} message={caseShow.error?.message ?? null} />
      )}

      {show ? (
        <>
          <VerdictSection row={row} show={show} onRecorded={ideaShow.reload} />
          <PublishSection row={row} show={show} onChanged={ideaShow.reload} />
        </>
      ) : (
        <div className="flex flex-col gap-4" aria-busy="true" role="status" aria-label="Reading the verdict">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}
    </div>
  );
}

function CaseError({ error, onRetry }: { error: MachApiError; onRetry: () => void }) {
  const { title, message } = describeError(error);
  return <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={onRetry}>Try again</Button>} />;
}
