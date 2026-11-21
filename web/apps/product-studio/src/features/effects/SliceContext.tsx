import type { ReactNode } from "react";
import { ArtifactId, SliceGithubPills, SliceLifecycle, SliceStatusPill } from "@mach/ui";
import type { SliceShow } from "@mach/ui/api";
import { IssueLink } from "../../shared/IssueLink";
import { SliceSections } from "../../shared/SliceSections";
import { ContextRow } from "../../shared/layout/WorkScreen";

/**
 * The slim context row of a slice's own pages (M16 layout), as the specification page draws it: the slice's ID, name,
 * epic and state on line one with the page's acts at the right; the page's name as the h1 and the slice's lifecycle
 * path on line two; the slice's pages as tabs under them. Until the slice is read, its ID stands in for it.
 *
 * Used by Effects on shipped behaviour, Principles and policies and Design mocks. It belongs in `shared/` beside
 * `SliceSections`; it lives here because this rollout's area may not change `shared/`.
 */
export function SliceContext({
  sliceId,
  show,
  title,
  about,
  actions,
  refreshing = false,
}: {
  sliceId: string;
  show: SliceShow | null | undefined;
  title: string;
  about?: ReactNode;
  actions?: ReactNode;
  refreshing?: boolean;
}) {
  const slice = show?.slice;
  return (
    <ContextRow
      identity={
        slice && show ? (
          <>
            <ArtifactId>{slice.slice_id}</ArtifactId>
            <span className="font-semibold text-ink">{slice.title}</span>
            <span>
              in <ArtifactId plain>{slice.epic_id}</ArtifactId>
            </span>
            <SliceStatusPill status={slice.status} size="sm" />
            <SliceGithubPills github={show.github} size="sm" />
            {show.github.issue ? (
              <span>
                Issue <IssueLink number={show.github.issue} url={show.github.url} />
              </span>
            ) : null}
            {refreshing ? <span className="text-caption text-ink-subtle">Updating…</span> : null}
          </>
        ) : (
          <ArtifactId>{sliceId}</ArtifactId>
        )
      }
      title={title}
      about={about}
      aboutLabel="About this page"
      trail={slice && show ? <SliceLifecycle status={slice.status} openQuestions={show.check.open_questions.length} className="w-[34rem] max-w-full" /> : undefined}
      actions={actions}
      below={<SliceSections sliceId={sliceId} fromPrd={slice?.source?.kind === "prd"} />}
    />
  );
}
