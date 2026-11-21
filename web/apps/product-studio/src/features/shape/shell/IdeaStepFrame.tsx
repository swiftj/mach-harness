import type { ReactNode } from "react";
import { Link } from "react-router";
import { CircleAlert, Lightbulb } from "lucide-react";
import { ArtifactId, Button, EmptyState, ErrorState, Heading, Page, Skeleton, SkeletonText, Text, describeError } from "@mach/ui";
import type { IdeaRow } from "@mach/ui/api";
import { ShapeStepper } from "./ShapeStepper";
import { shapeHome, stepName, type ShapeStep } from "./steps";
import { useIdea } from "./useIdea";

/**
 * The frame of every page of one idea (shell-owned): the idea's ID and title, the step's name as the one h1, the
 * lead sentence, the stepper, then the page's own content. It reads the idea's row from the shared status and gives it
 * to the page, which reads anything more itself. While the status loads, a skeleton; an idea the board does not hold,
 * an empty state that leads back to the board. Screen engineers fill `children` and never change this file.
 */
export function IdeaStepFrame({
  ideaId,
  step,
  lead,
  children,
}: {
  ideaId: string;
  step: Exclude<ShapeStep, "ideas">;
  lead?: ReactNode;
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
    <Page width="wide" className="flex flex-col gap-8">
      <header className="flex max-w-reading flex-col gap-2">
        <Text size="body-sm" tone="muted" className="flex flex-wrap items-baseline gap-x-2">
          <ArtifactId plain>{row.idea_id}</ArtifactId>
          <span>{row.title}</span>
        </Text>
        <Heading level={1}>{stepName(step)}</Heading>
        {lead ? <Text tone="muted">{lead}</Text> : null}
      </header>
      <ShapeStepper row={row} here={step} ideasOnBoard={board?.ideas.length ?? 0} />
      {children(row)}
    </Page>
  );
}
