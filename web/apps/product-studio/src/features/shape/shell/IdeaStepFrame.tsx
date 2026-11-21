import type { ReactNode } from "react";
import { Link } from "react-router";
import { CircleAlert, Lightbulb } from "lucide-react";
import { ArtifactId, Button, EmptyState, ErrorState, Page, Skeleton, SkeletonText, describeError } from "@mach/ui";
import type { IdeaRow } from "@mach/ui/api";
import { ContextRow, OnePane, WorkScreen } from "../../../shared/layout/WorkScreen";
import { ShapeStepper } from "./ShapeStepper";
import { shapeHome, stepName, type ShapeStep } from "./steps";
import { useIdea } from "./useIdea";

/**
 * The frame of every page of one idea (shell-owned): a work screen (M16 layout) whose slim context row holds the
 * idea's ID and title, the step's name as the one h1, Shape's steps on one line and the lead sentence behind "About
 * this step"; then the page's own content. A page laid out in panes (`layout="panes"`) returns its own <WorkPanes>;
 * any other page's body is put in one scrolling pane, as it was laid out before. It reads the idea's row from the shared status and gives it
 * to the page, which reads anything more itself. While the status loads, a skeleton; an idea the board does not hold,
 * an empty state that leads back to the board. Screen engineers fill `children` and never change this file.
 */
export function IdeaStepFrame({
  ideaId,
  step,
  lead,
  layout = "page",
  children,
}: {
  ideaId: string;
  step: Exclude<ShapeStep, "ideas">;
  lead?: ReactNode;
  /** "panes": the page returns <WorkPanes> itself. "page": its body goes in one scrolling pane. */
  layout?: "panes" | "page";
  children: (row: IdeaRow) => ReactNode;
}) {
  const { row, board, loading, error, reload } = useIdea(ideaId);
  if (loading) {
    return (
      <Page width="wide">
        <div className="flex flex-col gap-6" aria-busy="true" role="status" aria-label="Reading the idea">
          <Skeleton className="h-8 w-80" />
          <Skeleton className="h-16 w-full" />
          <SkeletonText lines={4} />
        </div>
      </Page>
    );
  }
  if (!row) {
    if (error) {
      const { title, message } = describeError(error);
      return (
        <Page width="reading">
          <h1 className="sr-only">{stepName(step)}</h1>
          <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={reload}>Try again</Button>} />
        </Page>
      );
    }
    return (
      <Page>
        <EmptyState
          layout="page"
          headingLevel={1}
          icon={<Lightbulb />}
          title={`${ideaId} is not on the board`}
          description="No idea in your workspace has this number. It may have been given a new one."
          action={
            <Button asChild>
              <Link to={shapeHome}>Go to the ideas</Link>
            </Button>
          }
        />
      </Page>
    );
  }
  return (
    <WorkScreen
      header={
        <ContextRow
          identity={
            <>
              <ArtifactId plain>{row.idea_id}</ArtifactId>
              <span className="min-w-0 break-words">{row.title}</span>
            </>
          }
          title={stepName(step)}
          about={lead}
          aboutLabel="About this step"
          trail={<ShapeStepper row={row} here={step} ideasOnBoard={board?.ideas.length ?? 0} />}
        />
      }
    >
      {layout === "panes" ? children(row) : <OnePane label={stepName(step)} width="content">{children(row)}</OnePane>}
    </WorkScreen>
  );
}
