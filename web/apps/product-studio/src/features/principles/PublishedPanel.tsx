import type { ReactNode } from "react";
import { CircleCheck, CircleDashed, GitBranch, PenLine, RefreshCw, TriangleAlert, Upload } from "lucide-react";
import { Button, Heading, RelativeTime, StatusPill, Text } from "@mach/ui";
import type { PrincipleList } from "@mach/ui/api";
import { IssueLink } from "../../shared/IssueLink";
import { countWords, publishOffered, stateLook, type PublishState } from "./model";

const glyphs: Record<(typeof stateLook)[PublishState]["glyph"], ReactNode> = {
  dashed: <CircleDashed aria-hidden="true" />,
  check: <CircleCheck aria-hidden="true" />,
  pen: <PenLine aria-hidden="true" />,
  alert: <TriangleAlert aria-hidden="true" />,
  branch: <GitBranch aria-hidden="true" />,
};

/** What each state means for the product manager, in one or two sentences. */
function explanation(state: PublishState, list: PrincipleList): string {
  const theirs = list.published.revision;
  switch (state) {
    case "never-published":
      return "The builders do not have your principles yet. Publish them so every slice marked ready after that answers them.";
    case "unpublished":
      return theirs !== null
        ? `You have changes the builders do not have. They have version ${theirs}; publish to give them the changes.`
        : "You have changes the builders do not have. Publish to give them the changes.";
    case "published":
      return "The builders have exactly the principles listed here.";
    case "unfinished":
      return "Publishing to GitHub stopped part way. Publish again to finish; nothing is made twice.";
    case "changed-on-github":
      return "The principles on the project's issue were edited after they were approved, so the builders cannot rely on them. Publish them again to save a version you approved.";
    case "newer-elsewhere":
      return "Choose a version first. Publishing now would be refused, because someone else published a newer one.";
    case "none":
      return "There is nothing to publish yet.";
  }
}

/**
 * Where the principles stand with the builders: the engine's flags as a word, a shape and a tone,
 * the facts of the last publish, and the one act that moves it on.
 */
export function PublishedPanel({
  state,
  list,
  active,
  retired,
  onPublish,
  checking,
  onCheckGithub,
}: {
  state: PublishState;
  list: PrincipleList;
  active: number;
  retired: number;
  onPublish: () => void;
  checking: boolean;
  onCheckGithub: () => void;
}) {
  const look = stateLook[state];
  const p = list.published;
  const readAt = p.github?.read_at ?? null;
  return (
    <section aria-labelledby="principles-builders" className="flex flex-col gap-4 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="flex max-w-reading min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Heading level={2} size="title-3" id="principles-builders">
              With the builders
            </Heading>
            <StatusPill tone={look.tone} icon={glyphs[look.glyph]} className={state === "never-published" ? "border-dashed" : undefined}>
              {look.word}
            </StatusPill>
          </div>
          <Text tone="muted">{explanation(state, list)}</Text>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {publishOffered(state) ? (
            <Button variant={state === "newer-elsewhere" ? "secondary" : "primary"} onClick={onPublish}>
              <Upload aria-hidden="true" />
              {state === "unfinished" ? "Finish publishing" : state === "unpublished" ? "Publish the changes" : "Publish the principles"}
            </Button>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-6 gap-y-1.5 border-t border-line pt-4 text-body-sm">
        <dt className="text-ink-muted">Here</dt>
        <dd className="text-ink">{countWords(active, retired)}</dd>
        <dt className="text-ink-muted">Published version</dt>
        <dd className="text-ink tabular">{p.revision !== null ? `Version ${p.revision}` : "Not published yet"}</dd>
        {p.saved ? (
          <>
            <dt className="text-ink-muted">Where</dt>
            <dd className="text-ink">
              {p.saved === "github" ? (
                p.issue !== null ? (
                  <>
                    The project&apos;s issue <IssueLink number={p.issue} url={p.url} />
                  </>
                ) : (
                  "The project's issue on GitHub"
                )
              ) : (
                "A folder in your workspace, for you to commit"
              )}
            </dd>
          </>
        ) : null}
        {p.saved === "github" ? (
          <>
            <dt className="text-ink-muted">Approved by</dt>
            <dd className="text-ink">
              {p.approved_by ? (
                <span translate="no" className="font-mono">
                  {p.approved_by}
                </span>
              ) : (
                "not recorded"
              )}
            </dd>
          </>
        ) : null}
        {p.published_at ? (
          <>
            <dt className="text-ink-muted">Published</dt>
            <dd className="text-ink">
              <RelativeTime iso={p.published_at} />
            </dd>
          </>
        ) : null}
        {p.saved === "github" || p.github ? (
          <>
            <dt className="text-ink-muted">GitHub last read</dt>
            <dd className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink">
              {readAt ? <RelativeTime iso={readAt} /> : <span>not recorded</span>}
              <Button size="sm" variant="ghost" loading={checking} onClick={onCheckGithub}>
                <RefreshCw aria-hidden="true" />
                Check GitHub again
              </Button>
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
