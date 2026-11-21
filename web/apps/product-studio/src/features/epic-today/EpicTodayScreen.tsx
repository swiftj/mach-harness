import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { CircleAlert, GitCommitHorizontal, PackageOpen } from "lucide-react";
import { ArtifactId, Badge, Banner, Button, DiagnosticList, EmptyState, ErrorState, Heading, Skeleton, SkeletonText, StateGlyph, Text, cn, describeError, plain, plural } from "@mach/ui";
import type { EpicCurrent, EpicView, ShippedRule } from "@mach/ui/api";
import { useOperation } from "../../api/useOperation";
import { useStatus } from "../../api/store";
import { Fold } from "../../shared/layout/Fold";
import { SectionNav } from "../../shared/layout/SectionNav";
import { ContextRow, OnePane, WorkPane, WorkPanes, WorkScreen } from "../../shared/layout/WorkScreen";
import { connectionWords, earlierText, effectWord, epicPage, sliceEffectsWords, sliceTitle, type GroupId, type NotApplied, type RuleGroup } from "./model";

/**
 * How an epic works today: `epic.current` ({epic_id}), which changes nothing. The page arranges the
 * engine's lists for reading and adds no rule of its own; its `note` (which commit, that it may be
 * behind GitHub, that the slices are the authority) is shown once, as written. Fixtures:
 * epic.current, ?epic=nothing-shipped|after-retire|problems, ?refuse=epic.current.
 *
 * A document (docs/mach-next/M16_LAYOUT.md): the rules by group in the wide pane, each rule's connections folded with
 * their count and its "Change this" link always in view; the list of groups with their counts, the shipped slices and
 * the source note in the narrow pane beside it.
 */
export function EpicTodayScreen() {
  const epicId = useParams().epicId ?? "";
  return <EpicToday key={epicId} epicId={epicId} />;
}

function EpicToday({ epicId }: { epicId: string }) {
  const current = useOperation("epic.current", { epic_id: epicId });
  const statusTitle = useStatus().data?.epics.find((e) => e.epic_id === epicId)?.title;
  const title = current.data?.epic?.title ?? statusTitle ?? epicId;
  const epic = current.data?.epic ?? null;
  const label = `How ${title} works today`;
  const header = (
    <ContextRow
      identity={
        <>
          <ArtifactId>{epicId}</ArtifactId>
          {epic ? (
            <span>
              {plural(epic.in_force.length, "rule")} in force, from {plural(epic.slices.length, "shipped slice")}
            </span>
          ) : null}
        </>
      }
      title={label}
      about="Every rule in force for this epic, from its slices that have shipped."
    />
  );
  return (
    <WorkScreen header={header}>
      {current.data ? (
        <EpicBody current={current.data} epicId={epicId} label={label} />
      ) : current.loading ? (
        <OnePane label={label}>
          <TodaySkeleton />
        </OnePane>
      ) : (
        <OnePane label={label}>
          <ReadError error={current.error} onRetry={current.reload} />
        </OnePane>
      )}
    </WorkScreen>
  );
}

function ReadError({ error, onRetry }: { error: ReturnType<typeof useOperation<"epic.current">>["error"]; onRetry: () => void }) {
  const described = error ? describeError(error) : { title: "Could not read how this epic works", message: "" };
  return (
    <ErrorState
      className="max-w-reading"
      icon={<CircleAlert />}
      title={error?.kind === "refused" ? "How this epic works could not be read" : described.title}
      message={error?.kind === "refused" ? error.message : described.message}
      hint={error?.hint}
      action={<Button onClick={onRetry}>Try again</Button>}
    />
  );
}

function TodaySkeleton() {
  return (
    <div role="status" aria-label="Reading the shipped slices" aria-busy="true" className="flex max-w-reading flex-col gap-6">
      <Skeleton className="h-7 w-56" />
      <SkeletonText lines={4} />
      <Skeleton className="h-7 w-48" />
      <SkeletonText lines={3} />
    </div>
  );
}

/** MACH's note, once: which commit, and that it is this computer's copy of the main branch. */
function SourceNote({ current }: { current: EpicCurrent }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-canvas px-4 py-3">
      <GitCommitHorizontal aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ink-subtle" />
      <div className="flex min-w-0 flex-col gap-1">
        <Text size="body-sm" weight="semibold">
          Read from this computer, and only read
        </Text>
        <Text size="body-sm" tone="muted" className="break-words">
          {current.note}
        </Text>
      </div>
    </div>
  );
}

/** The unit of each group's count in the section list, so a count reads in words. */
const jumpUnit: Record<GroupId, [string, string]> = {
  invariants: ["rule", "rules"],
  requirements: ["rule", "rules"],
  decisions: ["rule", "rules"],
  other: ["rule", "rules"],
  "not-reconciled": ["rule", "rules"],
  "no-longer": ["rule", "rules"],
  "not-applied": ["slice", "slices"],
  conflicts: ["conflict", "conflicts"],
};
/** Groups that need a look carry their tone on the count too, always with the group's own words beside it. */
const jumpTone: Partial<Record<GroupId, string>> = { "not-applied": "font-semibold text-danger-ink", conflicts: "font-semibold text-warning-ink" };

function EpicBody({ current, epicId, label }: { current: EpicCurrent; epicId: string; label: string }) {
  const epic = current.epic;
  if (!epic) {
    return (
      <OnePane label={label} width="reading">
        <div className="flex flex-col gap-6">
          <EmptyState
            className="max-w-reading"
            icon={<PackageOpen />}
            title="Nothing in this epic has shipped yet"
            description={[
              `No slice of ${epicId} has been merged on the main branch, so it has no rules in force yet: a new epic starts here. Once one of its slices is merged, its rules are listed on this page.`,
              ...current.notes,
            ].join(" ")}
          />
          <div className="max-w-reading">
            <SourceNote current={current} />
          </div>
        </div>
      </OnePane>
    );
  }
  const page = epicPage(epic);
  return (
    <WorkPanes>
      <WorkPane label={label}>
        <div className="flex flex-col gap-10">
          {current.notes.length ? (
            <Banner tone="info" title="What MACH noted">
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {current.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {page.groups.map((group) => (
            <Group key={group.id} id={group.id} title={group.title} hint={group.hint} count={group.rules.length} tone={group.id === "not-reconciled" ? "warning" : "neutral"}>
              <ul className="rounded-md border border-line bg-surface">
                {group.rules.map((rule) => (
                  <RuleItem key={rule.rule} rule={rule} epic={epic} epicId={epicId} group={group} />
                ))}
              </ul>
            </Group>
          ))}
          {page.notApplied.length ? (
            <Group
              id="not-applied"
              title="Effects not applied"
              hint="These slices say what they change, but MACH found problems in what they say, so none of it was applied. Their own rules still count as shipped."
              count={page.notApplied.length}
              tone="danger"
            >
              <NotAppliedList items={page.notApplied} epic={epic} />
            </Group>
          ) : null}
          {page.conflicts.length ? (
            <Group id="conflicts" title="Conflicts" hint="Where two slices act on the same rule in ways that do not fit together, as MACH found them." count={page.conflicts.length} tone="warning">
              <ul className="flex flex-col gap-2">
                {page.conflicts.map((text, index) => (
                  <li key={index} className="flex items-start gap-2.5 rounded-md border border-warning-line bg-surface px-4 py-3 text-body text-ink">
                    <span className="mt-1 shrink-0 text-warning-ink">
                      <StateGlyph shape="blocked" />
                    </span>
                    <span className="min-w-0 break-words">{text}</span>
                  </li>
                ))}
              </ul>
            </Group>
          ) : null}
          {page.groups.length === 0 && !page.notApplied.length ? <Text tone="muted">The shipped slices of this epic hold no rule MACH could list.</Text> : null}
        </div>
      </WorkPane>
      <WorkPane side label="Groups and sources">
        <div className="flex flex-col gap-8">
          {page.jumps.length ? (
            <SectionNav
              label="Groups on this page"
              items={page.jumps.map((jump) => {
                const [one, many] = jumpUnit[jump.id];
                return {
                  id: `group-${jump.id}`,
                  label: jump.title,
                  note: <span className={cn("shrink-0 text-caption tabular", jumpTone[jump.id] ?? "text-ink-subtle")}>{plural(jump.count, one, many)}</span>,
                };
              })}
            />
          ) : null}
          <ShippedSlices epic={epic} />
          <SourceNote current={current} />
        </div>
      </WorkPane>
    </WorkPanes>
  );
}

function Group({ id, title, hint, count, tone, children }: { id: GroupId; title: string; hint: string; count: number; tone: "neutral" | "warning" | "danger"; children: ReactNode }) {
  return (
    <section id={`group-${id}`} aria-labelledby={`group-${id}-title`} className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Heading level={2} size="title-3" id={`group-${id}-title`} className="outline-offset-4">
          {title}
        </Heading>
        <Badge tone={tone}>{count}</Badge>
      </div>
      <Text size="body-sm" tone="muted" className="-mt-1 max-w-reading">
        {hint}
      </Text>
      {children}
    </section>
  );
}

/** The shipped slices the page is compiled from, each with what its effects section was (narrow pane). */
function ShippedSlices({ epic }: { epic: EpicView }) {
  return (
    <section aria-labelledby="shipped-slices-title" className="flex flex-col gap-2">
      <Heading level={2} size="title-3" id="shipped-slices-title">
        From {plural(epic.slices.length, "shipped slice")}
      </Heading>
      <Text size="body-sm" tone="muted">
        Each rule names the slice it came from.
      </Text>
      <ul className="flex flex-col divide-y divide-line border-y border-line">
        {epic.slices.map((slice) => (
          <li key={slice.slice_id} className="flex min-w-0 flex-col gap-0.5 py-2.5">
            <span className="flex flex-wrap items-center gap-2">
              <ArtifactId>{slice.slice_id}</ArtifactId>
              {slice.issue ? <span className="text-caption text-ink-subtle">issue #{slice.issue}</span> : null}
            </span>
            <span className="break-words text-body-sm font-semibold text-ink">{slice.title ?? "Title not recorded"}</span>
            <span className={cn("text-caption", slice.effects === "problems" ? "font-semibold text-danger-ink" : "text-ink-subtle")}>{sliceEffectsWords[slice.effects] ?? slice.effects}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Where a rule came from: its slice's ID and title. */
function Source({ epic, sliceId, label = "From" }: { epic: EpicView; sliceId: string; label?: string }) {
  const title = sliceTitle(epic, sliceId);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span>{label}</span>
      <ArtifactId plain className="text-ink-muted">
        {sliceId}
      </ArtifactId>
      {title ? <span>{title}</span> : null}
    </span>
  );
}

function OtherEpic({ epicId, own }: { epicId: string | null; own: string }) {
  if (!epicId || epicId === own) return null;
  return (
    <span>
      {" "}
      in <ArtifactId plain>{epicId}</ArtifactId>
    </span>
  );
}

function RuleItem({ rule, epic, epicId, group }: { rule: ShippedRule; epic: EpicView; epicId: string; group: RuleGroup }) {
  const gone = group.id === "no-longer";
  const history = rule.takes_the_place_of ?? [];
  const confirmed = rule.confirmed_by ?? [];
  const superseded = rule.superseded_by ?? [];
  const now = rule.now ?? [];
  const connections = connectionWords(rule);
  return (
    <li className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 border-t border-line px-4 py-4 first:border-t-0">
      <span className="flex items-start gap-1.5 pt-0.5">
        {gone ? (
          <span className="mt-0.5 text-ink-subtle">
            <StateGlyph shape="superseded" size={12} title="No longer in force" />
          </span>
        ) : null}
        <ArtifactId>{rule.id}</ArtifactId>
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className={cn("max-w-reading break-words text-body", gone ? "text-ink-muted" : "text-ink")}>{plain(rule.text)}</p>
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-caption text-ink-subtle">
          <span>
            <Source epic={epic} sliceId={rule.slice_id} />
            {group.id === "not-reconciled" ? <span> · not yet reconciled</span> : null}
          </span>
          {gone ? null : (
            <Link
              to={`/shape/change?rule=${encodeURIComponent(rule.rule)}&epic=${encodeURIComponent(epicId)}`}
              aria-label={`Change this: ${rule.rule}`}
              className="font-semibold text-accent-ink underline-offset-2 hover:underline"
            >
              Change this
            </Link>
          )}
        </p>
        {connections ? (
          <Fold small label={connections}>
            <ul className="flex flex-col gap-1.5 border-l-2 border-line-strong pl-3">
              {history.map((h, index) => {
                const earlier = earlierText(epic, h.rule);
                return (
                  <li key={`h${index}`} className="text-body-sm text-ink-muted">
                    <span className="font-semibold text-ink">{effectWord[h.effect] ?? h.effect}</span> <ArtifactId plain>{h.rule}</ArtifactId>
                    <OtherEpic epicId={h.epic_id} own={epicId} />
                    {earlier ? <span>, which said “{plain(earlier)}”</span> : null}
                    {h.note ? <span className="block text-ink-subtle">{h.note}</span> : null}
                  </li>
                );
              })}
              {confirmed.map((c, index) => (
                <li key={`c${index}`} className="text-body-sm text-ink-muted">
                  <span className="font-semibold text-ink">Confirmed</span> by <ArtifactId plain>{c.slice_id}</ArtifactId> in its example <ArtifactId plain>{c.scenario}</ArtifactId>
                  {c.note ? <span className="block text-ink-subtle">{c.note}</span> : null}
                </li>
              ))}
              {superseded.map((s, index) => (
                <li key={`s${index}`} className="text-body-sm text-ink-muted">
                  <span className="font-semibold text-ink">{effectWord[s.effect] ?? s.effect}</span> by <ArtifactId plain>{s.by ?? s.slice_id}</ArtifactId>
                  <OtherEpic epicId={s.epic_id} own={epicId} />
                  {s.note ? <span className="block text-ink-subtle">{s.note}</span> : null}
                </li>
              ))}
            </ul>
          </Fold>
        ) : null}
        {gone ? (
          now.length ? (
            <div className="mt-1 flex flex-col gap-1 rounded-sm bg-surface-sunken px-3 py-2">
              <span className="text-caption font-semibold text-ink-muted">What holds now</span>
              {now.map((n) => (
                <p key={n.rule} className="text-body-sm text-ink">
                  <ArtifactId plain className="mr-1.5">
                    {n.rule}
                  </ArtifactId>
                  {plain(n.text)}
                  <OtherEpic epicId={n.epic_id} own={epicId} />
                </p>
              ))}
            </div>
          ) : (
            <p className="text-body-sm italic text-ink-subtle">Nothing took its place.</p>
          )
        ) : null}
      </div>
    </li>
  );
}

function NotAppliedList({ items, epic }: { items: NotApplied[]; epic: EpicView }) {
  return (
    <ul className="flex flex-col gap-4">
      {items.map((item) => (
        <li key={item.slice_id} className="flex flex-col gap-2">
          <Text size="body-sm" tone="muted">
            <Source epic={epic} sliceId={item.slice_id} label="In" />
          </Text>
          {item.problems.length ? (
            <DiagnosticList items={item.problems.map((p) => ({ severity: "error", message: p.message, line: p.line, rule: p.code, section: null }))} />
          ) : (
            <Text size="body-sm" tone="subtle">
              MACH listed no detail.
            </Text>
          )}
        </li>
      ))}
    </ul>
  );
}
