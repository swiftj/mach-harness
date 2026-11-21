import { useId } from "react";
import { Link } from "react-router";
import { History } from "lucide-react";
import { ArtifactId, RelativeTime, StateGlyph, StatusPill } from "@mach/ui";
import type { IdeaRow } from "@mach/ui/api";
import { IssueLink } from "../../../shared/IssueLink";
import { nextPathOf, stepForNext, stepName } from "../shell/steps";
import { savedShown, showsReason, sourceShown, verdictLook } from "./model";
import { VerdictReason } from "./VerdictReason";

/**
 * One idea on the board: its title (the way in, opening the idea at the step that holds the engine's next step),
 * where it came from, its age, the verdict and its reason when decided, what it was shaped into, the engine's next
 * step in its own words, and where it is saved. Nothing here ranks or scores the idea.
 */
export function IdeaCard({ row }: { row: IdeaRow }) {
  const nextId = useId();
  const source = sourceShown(row.source);
  const saved = savedShown(row.github);
  const verdict = row.verdict ? verdictLook(row.verdict.decision) : null;
  const opensAt = stepName(stepForNext(row.next.kind, row.stage));
  const made = row.made ? [...row.made.epics, ...row.made.slices] : [];

  return (
    <article className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3.5">
      <div className="flex flex-col gap-1">
        <h4 className="text-body font-semibold leading-snug text-ink">
          <Link to={nextPathOf(row)} aria-describedby={nextId} className="rounded-xs underline-offset-2 hover:text-accent-ink hover:underline">
            {row.title}
          </Link>
        </h4>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-ink-muted">
          <ArtifactId plain>
            {row.idea_id}
          </ArtifactId>
          <span aria-hidden="true">·</span>
          <span>
            {source.words}
            {source.id ? (
              <>
                {" "}
                <ArtifactId plain className="text-caption">
                  {source.id}
                </ArtifactId>
              </>
            ) : null}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            added <RelativeTime iso={row.created} />
          </span>
        </p>
      </div>

      {verdict && row.verdict ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill size="sm" tone={verdict.tone} icon={<StateGlyph shape={verdict.glyph} />} title={verdict.description}>
              <span className="sr-only">Verdict: </span>
              {verdict.word}
            </StatusPill>
            {row.verdict.stale ? (
              <StatusPill size="sm" tone="warning" icon={<History aria-hidden="true" />} title="The brief changed after this verdict was recorded, so it no longer holds.">
                No longer holds
              </StatusPill>
            ) : null}
          </div>
          {showsReason(row) ? <VerdictReason ideaId={row.idea_id} /> : null}
          {row.verdict.decision === "no" && row.stage === "decided" ? <p className="text-caption text-ink-subtle">Kept with its reason. It stays on the board.</p> : null}
        </div>
      ) : null}

      {made.length ? (
        <p className="flex flex-wrap items-center gap-1.5 text-caption text-ink-muted">
          <span>Shaped into</span>
          {made.map((id) => (
            <ArtifactId key={id}>
              {id}
            </ArtifactId>
          ))}
        </p>
      ) : null}

      <div id={nextId} className="flex flex-col gap-0.5 border-t border-line pt-2.5">
        <p className="text-body-sm text-ink">{row.next.sentence}</p>
        <p className="text-caption text-ink-subtle">Opens at {opensAt}.</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {saved.attention ? (
          <StatusPill size="sm" tone={saved.tone} icon={<StateGlyph shape={saved.glyph} />} title={saved.description}>
            {saved.word}
          </StatusPill>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-caption text-ink-muted" title={saved.description}>
            <StateGlyph shape={saved.glyph} size={12} />
            {saved.word}
          </span>
        )}
        {saved.issue !== null ? (
          <span className="text-caption text-ink-muted">
            Issue <IssueLink number={saved.issue} url={saved.url} />
          </span>
        ) : null}
      </div>
    </article>
  );
}
