import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArtifactId, Banner, Button, Heading, Text, type Refresh, type Status, IdText, Panel, plural } from "@mach/ui";
import { artifactFromPath, fieldLabel, titleFor } from "../../api/describe";

/** The engine reports spec updates with added/removed/changed IDs; the shared type lists only some. */
type Update = Refresh["updated"][number] & { added?: string[]; removed?: string[] };

function Item({ path, status, children }: { path: string; status: Status | null; children?: ReactNode }) {
  const a = artifactFromPath(path);
  const title = titleFor(status, a.id);
  return (
    <li className="flex flex-col gap-1 py-2.5">
      <p className="flex flex-wrap items-center gap-2 text-body text-ink">
        <span className="font-semibold">{a.noun}</span>
        {a.id ? <ArtifactId>{a.id}</ArtifactId> : null}
        {title && a.id ? <span className="text-ink-muted">{title}</span> : null}
      </p>
      {children ? <div className="text-body-sm text-ink-muted">{children}</div> : null}
    </li>
  );
}

function Block({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <Heading level={3} id={id} size="title-3">
        {title}
      </Heading>
      {hint ? (
        <Text size="body-sm" tone="muted">
          {hint}
        </Text>
      ) : null}
      <ul className="flex flex-col divide-y divide-line">{children}</ul>
    </section>
  );
}

function updateWords(update: Update): string | null {
  const parts: string[] = [];
  if (update.fields?.length) parts.push(`Changed: ${update.fields.map((f) => fieldLabel(f).toLowerCase()).join(", ")}`);
  if (update.added?.length) parts.push(`Added: ${update.added.join(", ")}`);
  if (update.removed?.length) parts.push(`Removed: ${update.removed.join(", ")}`);
  if (update.changed?.length) parts.push(`Changed: ${update.changed.join(", ")}`);
  return parts.length ? parts.join(". ") + "." : null;
}

/** What a successful refresh brought in, in product terms, with the way to whatever still needs the PM. */
export function RefreshSummary({ result, status, heading }: { result: Refresh; status: Status | null; heading: string }) {
  const unsettled = result.needs_reconciling.conflicts.length + result.needs_reconciling.collisions.length;
  const nothing = !result.arrived.length && !result.updated.length && !result.merged.length && !result.approvals_withdrawn.length;
  return (
    <Panel aria-labelledby="summary-title" className="flex flex-col gap-5 px-5 py-4">
      <div className="flex flex-col gap-1">
        <Heading level={2} id="summary-title" size="title-2">
          {heading}
        </Heading>
        <p className="flex items-start gap-2 text-body text-ink">
          {unsettled ? (
            <TriangleAlert aria-hidden="true" className="mt-1 size-4 shrink-0 text-warning-ink" />
          ) : (
            <CircleCheck aria-hidden="true" className="mt-1 size-4 shrink-0 text-success-ink" />
          )}
          <span>
            {/* Never "up to date" while something still needs the PM's decision. */}
            {nothing && !unsettled ? "You are up to date: nothing new arrived from the shared project. " : ""}
            {nothing && unsettled ? "Nothing else arrived, but something you changed was also changed in the shared project. " : ""}
            Your unpublished drafts are preserved; a refresh never overwrites your own changes.
          </span>
        </p>
      </div>

      {result.arrived.length ? (
        <Block id="arrived" title={`New from other product managers (${result.arrived.length})`} hint="Shared work that was not in your workspace yet.">
          {result.arrived.map((path) => (
            <Item key={path} path={path} status={status} />
          ))}
        </Block>
      ) : null}

      {result.updated.length ? (
        <Block id="updated" title={`Updated (${result.updated.length})`} hint="You had not changed these, so the shared version replaced yours.">
          {(result.updated as Update[]).map((update) => {
            const words = updateWords(update);
            return (
              <Item key={update.path} path={update.path} status={status}>
                {words ? <IdText text={words} /> : null}
              </Item>
            );
          })}
        </Block>
      ) : null}

      {result.merged.length ? (
        <Block id="merged" title={`Combined with your draft (${result.merged.length})`} hint="You and the shared project changed different things. Both sets of changes were kept.">
          {result.merged.map((merge) => (
            <Item key={merge.path} path={merge.path} status={status}>
              {(merge.taken_from_shared ?? []).length
                ? `Taken from the shared project: ${(merge.taken_from_shared ?? []).map((f) => fieldLabel(f).toLowerCase()).join(", ")}. Your other changes stay.`
                : "Your changes stay."}
            </Item>
          ))}
        </Block>
      ) : null}

      {result.approvals_withdrawn.length ? (
        <Banner tone="warning" title={`${plural(result.approvals_withdrawn.length, "approval")} withdrawn`}>
          <p>
            A change from the shared project replaced what you had approved, so the approval no longer holds:{" "}
            <IdText text={result.approvals_withdrawn.join(", ")} />. Look again and approve when you are ready.
          </p>
        </Banner>
      ) : null}

      {unsettled ? (
        <Banner
          tone="warning"
          title={`${plural(unsettled, "item")} ${unsettled === 1 ? "needs" : "need"} your decision`}
          actions={
            <Button size="sm" variant="primary" asChild>
              <Link to="/inbox">Settle in Decisions</Link>
            </Button>
          }
        >
          These changed both in your draft and in the shared project, or someone else took their number. Nothing is chosen for you.
        </Banner>
      ) : null}
    </Panel>
  );
}
