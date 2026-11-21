import { useEffect, useRef } from "react";
import { Link, useParams } from "react-router";
import { ArrowRight, CircleAlert, FileText } from "lucide-react";
import { Button, ErrorState, Skeleton, SkeletonText, Text, describeError } from "@mach/ui";
import type { IdeaRow } from "@mach/ui/api";
import { useOperation } from "../../../api/useOperation";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";
import { ideaPath } from "../shell/steps";
import { useIdeaBoard } from "../shell/useIdea";
import { Conversation } from "./Conversation";
import { IdeaSource } from "./IdeaSource";
import { LookedUp } from "./LookedUp";
import { briefWayOn } from "./model";
import { useIdeaConversation } from "./useIdeaConversation";

/**
 * Explore one idea (screen engineer 2, M16): the Shape conversation, one open question at a time, beside what MACH
 * looked up and where the idea came from. Side by side on a wide window, stacked when narrower. The page shows what
 * the engine returns: `idea.show` (source, lookups, brief), the shared board row (stage), and the conversation's events.
 */
export function ExploreScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="explore" lead="Open questions, one at a time, answered in your own words. Facts are looked up, never asked.">
      {(row) => <Explore row={row} />}
    </IdeaStepFrame>
  );
}

function Explore({ row }: { row: IdeaRow }) {
  const ideaId = row.idea_id;
  const show = useOperation("idea.show", { idea_id: ideaId });
  const conv = useIdeaConversation(ideaId);
  const { board } = useIdeaBoard();

  // The conversation wrote the brief, the case or the lookups: read the idea again. Several writes arrive close together.
  const reload = show.reload;
  const changes = conv.model.draftChanges;
  useEffect(() => {
    if (!changes) return;
    const timer = setTimeout(reload, 400);
    return () => clearTimeout(timer);
  }, [changes, reload]);
  // The stage moved (Start exploring, or a brief check): the idea's own record changed too.
  const stage = useRef(row.stage);
  useEffect(() => {
    if (stage.current === row.stage) return;
    stage.current = row.stage;
    reload();
  }, [row.stage, reload]);

  const way = briefWayOn(show.data);

  return (
    <div className="flex flex-col gap-8">
      {way ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3">
          <span className="flex items-center gap-2 text-body text-ink">
            <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
            Your brief is written. {way.state}
          </span>
          <Button variant="secondary" asChild>
            <Link to={ideaPath(ideaId, "brief")}>
              Read the brief
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,1fr)]">
        <Conversation conv={conv} row={row} />
        <aside aria-label="What MACH looked up, and where the idea came from" className="flex min-w-0 flex-col gap-8 border-t border-line pt-8 xl:border-l xl:border-t-0 xl:pl-8 xl:pt-0">
          {show.data ? (
            <>
              <IdeaSource source={show.data.source} />
              <LookedUp lookups={show.data.lookups} board={board?.ideas ?? []} />
            </>
          ) : show.error ? (
            <ErrorState
              icon={<CircleAlert />}
              title={show.error.kind === "refused" ? "The idea could not be read" : describeError(show.error).title}
              message={show.error.kind === "refused" ? show.error.message : describeError(show.error).message}
              hint={show.error.hint}
              action={<Button onClick={show.reload}>Try again</Button>}
            />
          ) : (
            <div className="flex flex-col gap-4" role="status" aria-label="Reading what MACH looked up">
              <Skeleton className="h-6 w-56" />
              <SkeletonText lines={5} />
            </div>
          )}
          {show.data && show.loading ? (
            <Text size="caption" tone="subtle" role="status">
              Reading the idea again
            </Text>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
