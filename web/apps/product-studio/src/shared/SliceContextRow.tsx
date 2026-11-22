import type { ReactNode } from "react";
import { ArtifactId, SliceGithubPills, SliceLifecycle, SliceStatusPill } from "@mach/ui";
import type { SliceShow, WorkOrder } from "@mach/ui/api";
import { IssueLink } from "./IssueLink";
import { SliceSections } from "./SliceSections";
import { ContextRow } from "./layout/WorkScreen";
import { SmallChangeLabel } from "../features/small-change/SmallChangeLabel";

/**
 * The slim context row of a slice's own pages (M16 layout): line one says which slice (its ID, name, epic, state, its
 * place on GitHub and its issue) with the page's acts at the right; line two is the page's name as the h1 and the
 * slice's lifecycle path; then the slice's pages as tabs. Until the slice is read, its ID stands in for it.
 *
 * Every slice page uses it: the specification (whose h1 is the slice's own title, so line one leaves the name out),
 * Effects on shipped behaviour, Principles and policies, Design mocks and From the PRD. A page that reads the slice's
 * work order rather than its full record passes `slice` alone; the GitHub pills and the path then wait for the record.
 */
export function SliceContextRow({
  sliceId,
  show,
  slice: order,
  title,
  about,
  actions,
  refreshing = false,
}: {
  sliceId: string;
  show?: SliceShow | null;
  slice?: Pick<WorkOrder, "slice_id" | "title" | "epic_id" | "status" | "source" | "kind" | "widened"> | null;
  /** The page's h1. Leave it out on the specification page, whose h1 is the slice's title. */
  title?: string;
  about?: ReactNode;
  actions?: ReactNode;
  refreshing?: boolean;
}) {
  const slice = show?.slice ?? order ?? null;
  const named = Boolean(title);
  return (
    <ContextRow
      identity={
        slice ? (
          <>
            <ArtifactId>{slice.slice_id}</ArtifactId>
            {named ? <span className="font-semibold text-ink">{slice.title}</span> : null}
            {slice.epic_id ? (
              <span>
                in <ArtifactId plain>{slice.epic_id}</ArtifactId>
              </span>
            ) : null}
            <SliceStatusPill status={slice.status} size="sm" />
            <SmallChangeLabel slice={slice} />
            {show ? <SliceGithubPills github={show.github} size="sm" /> : null}
            {show?.github.issue ? (
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
      title={title ?? slice?.title ?? sliceId}
      about={about}
      trail={slice && show ? <SliceLifecycle status={slice.status} openQuestions={show.check.open_questions.length} className="max-w-full" /> : undefined}
      actions={actions}
      below={<SliceSections sliceId={sliceId} fromPrd={slice?.source?.kind === "prd"} />}
    />
  );
}
