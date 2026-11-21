import { Link, useParams } from "react-router";
import { CircleAlert, History, MessagesSquare } from "lucide-react";
import { ArtifactId, Banner, Button, DiagnosticList, EmptyState, ErrorState, FactList, Heading, Skeleton, SkeletonText, StateGlyph, StatusPill, Text, describeError, plain, plural, type Diagnostic, type GlyphShape, type Tone } from "@mach/ui";
import type { EffectRow, ShippedChecked, ShippedMoved, SliceShow } from "@mach/ui/api";
import { useSliceShow } from "../../api/useSliceShow";
import { useOperation } from "../../api/useOperation";
import { useStatus } from "../../api/store";
import { Fold } from "../../shared/layout/Fold";
import { OnePane, WorkPane, WorkPanes, WorkScreen } from "../../shared/layout/WorkScreen";
import { SliceContextRow } from "../../shared/SliceContextRow";
import { effectSummary, effectWords, effectsHeading, effectsView, shortCommit, type EffectLine, type EffectProblem, type EffectsView } from "./model";

/**
 * What one slice does to behaviour that has shipped: `slice.show` (`spec.model.effects`, the check's
 * findings about the section, `check.shipped`) and `status.slices[].shipped_moved`. Read-only: the rows
 * are written in the interview. The shipped rule's wording, where the slice's own epic lists it, comes
 * from `epic.current`. Fixtures: ?show=effects, ?fixture=status.shipped-moved.
 *
 * M16 layout: the slice's context row with its pages as tabs; each effect is a row that says its state, with the rule's
 * wording, what the effect means and the note folded under it; a finding about a row and the moved-since note are never
 * folded. What the check read sits in the narrow pane beside the rows.
 */
export function SliceEffectsScreen() {
  const sliceId = useParams().sliceId ?? "";
  return <EffectsPage key={sliceId} sliceId={sliceId} />;
}

const ABOUT = "Which rules that have already shipped this slice keeps, changes, replaces or retires.";

function EffectsPage({ sliceId }: { sliceId: string }) {
  const show = useSliceShow(sliceId);
  const moved = useStatus().data?.slices.find((s) => s.slice_id === sliceId)?.shipped_moved ?? null;
  const view = show.data ? effectsView(show.data, moved) : null;
  // The act for the state: with rows (or "None") the way to change them is the interview. With nothing written, the
  // interview is offered as the empty state's own primary act instead, so it is never offered twice.
  const offer = show.data && view && (view.state === "rows" || view.state === "none") ? <InterviewLink show={show.data} primary={false} /> : null;
  return (
    <WorkScreen header={<SliceContextRow sliceId={sliceId} show={show.data} title="Effects on shipped behaviour" about={ABOUT} actions={offer} refreshing={show.loading && Boolean(show.data)} />}>
      {show.data && view ? (
        <EffectsBody show={show.data} view={view} />
      ) : show.loading ? (
        <OnePane label="Effects on shipped behaviour">
          <EffectsSkeleton />
        </OnePane>
      ) : (
        <OnePane label="Effects on shipped behaviour">
          <LoadError error={show.error} sliceId={sliceId} onRetry={show.reload} />
        </OnePane>
      )}
    </WorkScreen>
  );
}

function LoadError({ error, sliceId, onRetry }: { error: ReturnType<typeof useSliceShow>["error"]; sliceId: string; onRetry: () => void }) {
  const described = error ? describeError(error) : { title: "Could not read the slice", message: "" };
  return (
    <ErrorState
      icon={<CircleAlert />}
      title={error?.kind === "refused" ? `${sliceId} could not be shown` : described.title}
      message={error?.kind === "refused" ? error.message : described.message}
      hint={error?.hint}
      action={<Button onClick={onRetry}>Try again</Button>}
    />
  );
}

function EffectsSkeleton() {
  return (
    <div role="status" aria-label="Reading the slice" aria-busy="true" className="flex max-w-reading flex-col gap-4">
      <SkeletonText lines={2} />
      <Skeleton className="h-40" />
    </div>
  );
}

function EffectsBody({ show, view }: { show: SliceShow; view: EffectsView }) {
  const epic = useOperation("epic.current", view.state === "rows" ? { epic_id: show.slice.epic_id } : null);
  const unanswered = view.sectionProblems.length === 0 || view.sectionProblems.some((p) => p.rule === "effects-missing");
  const wording = new Map<string, string>();
  const known = epic.data?.epic;
  if (known) [...known.in_force, ...known.not_yet_reconciled, ...known.no_longer_in_force].forEach((r) => wording.set(r.rule, r.text));

  return (
    <WorkPanes>
      <WorkPane label="Each shipped rule this slice touches">
        <div className="flex flex-col gap-6">
          {view.moved ? <MovedBanner moved={view.moved} /> : null}
          {view.state === "no-spec" ? (
            <EmptyState
              icon={<MessagesSquare />}
              title="Nothing is written yet"
              description="Once the interview has written the specification, the shipped rules this slice touches are listed here, or “None” when it touches none."
              action={<InterviewLink show={show} primary />}
            />
          ) : view.state === "no-section" ? (
            <section aria-labelledby="effects-missing-title" className="flex max-w-reading flex-col gap-3 rounded-md border border-dashed border-line-strong px-6 py-6">
              <Heading level={2} size="title-2" id="effects-missing-title">
                {unanswered ? "Not answered yet" : "The section has problems to fix"}
              </Heading>
              <Text tone="muted">
                {unanswered
                  ? "The specification does not yet say what this slice does to behaviour that has shipped. The interview settles it, one shipped rule at a time."
                  : "The specification has a section on shipped behaviour, but the check could not read its rows. The interview puts it right."}
              </Text>
              <ProblemList problems={view.sectionProblems} label="What the check reported" />
              <div className="pt-1">
                <InterviewLink show={show} primary />
              </div>
            </section>
          ) : (
            <section aria-labelledby="effects-title" className="flex flex-col gap-4">
              <Heading level={2} size="title-3" id="effects-title">
                {effectsHeading(view)}
              </Heading>
              {view.sectionProblems.length ? <ProblemList problems={view.sectionProblems} label="About the whole section" /> : null}
              {view.state === "none" ? <NoneAnswer /> : <EffectRows rows={view.rows} wording={wording} />}
            </section>
          )}
          {/* What the check read is short reference: it sits under the rows in the same pane, never a second pane. */}
          <CheckedAside show={show} shipped={view.shipped} />
        </div>
      </WorkPane>
    </WorkPanes>
  );
}

/** The slice's answer is "None.": a real answer, shown as one. */
function NoneAnswer() {
  return (
    <div className="flex max-w-reading items-start gap-3 rounded-md border border-line bg-surface px-5 py-4">
      <span className="mt-1 text-success-ink">
        <StateGlyph shape="accepted" />
      </span>
      <div className="flex flex-col gap-1">
        <Text size="body-lg" weight="semibold">
          None
        </Text>
        <Text tone="muted">The specification says this slice keeps, changes, replaces and retires no rule that has shipped.</Text>
      </div>
    </div>
  );
}

const effectLook: Record<EffectRow["effect"], { tone: Tone; shape: GlyphShape }> = {
  kept: { tone: "success", shape: "accepted" },
  changed: { tone: "info", shape: "half" },
  replaced: { tone: "neutral", shape: "submitted" },
  retired: { tone: "neutral", shape: "superseded" },
};

function EffectPill({ effect }: { effect: EffectRow["effect"] }) {
  const look = effectLook[effect] ?? { tone: "neutral" as Tone, shape: "open" as GlyphShape };
  const words = effectWords[effect] ?? { word: effect, means: "" };
  return (
    <StatusPill tone={look.tone} size="sm" icon={<StateGlyph shape={look.shape} size={12} />} title={words.means || undefined}>
      {words.word}
    </StatusPill>
  );
}

/** Each effect a row: the rule, the effect and what in this slice answers for it; its findings under it, never folded. */
function EffectRows({ rows, wording }: { rows: EffectLine[]; wording: Map<string, string> }) {
  return (
    <ul aria-label="Each shipped rule this slice touches" className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
      {rows.map((line, index) => (
        <EffectRowItem key={`${line.row.shipped_rule}-${index}`} line={line} text={wording.get(line.row.shipped_rule) ?? null} />
      ))}
    </ul>
  );
}

function EffectRowItem({ line, text }: { line: EffectLine; text: string | null }) {
  const { row, problems } = line;
  const words = effectWords[row.effect];
  return (
    <li className="flex flex-col gap-2 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ArtifactId>{row.shipped_rule}</ArtifactId>
        <EffectPill effect={row.effect} />
        <Text as="span" size="body-sm" tone={row.in_slice ? "default" : "subtle"} className={row.in_slice ? undefined : "italic"}>
          {row.in_slice && effectSummary(row).endsWith(row.in_slice) ? (
            <>
              {effectSummary(row).slice(0, -row.in_slice.length)}
              <ArtifactId plain>{row.in_slice}</ArtifactId>
            </>
          ) : (
            effectSummary(row)
          )}
        </Text>
        {problems.length ? (
          <span className="text-caption font-semibold text-danger-ink">{plural(problems.length, "problem")}</span>
        ) : null}
      </div>
      {text ? <p className="max-w-reading break-words text-body-sm text-ink-muted">{plain(text)}</p> : null}
      {problems.length ? <ProblemList problems={problems} label={`About ${row.shipped_rule}`} /> : null}
      <Fold label={row.note ? `What “${words?.word ?? row.effect}” means, and the note` : `What “${words?.word ?? row.effect}” means`}>
        <dl className="grid max-w-reading grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-body-sm">
          <dt className="text-ink-muted">{words?.word ?? row.effect} means</dt>
          <dd className="min-w-0 text-ink">{words?.means || "not recorded"}</dd>
          <dt className="text-ink-muted">Note</dt>
          <dd className="min-w-0 break-words text-ink">{row.note ? <span className="whitespace-pre-line">{row.note}</span> : <span className="italic text-ink-subtle">No note</span>}</dd>
        </dl>
      </Fold>
    </li>
  );
}

function toDiagnostic(p: EffectProblem): Diagnostic {
  return { severity: p.severity, message: p.message, line: p.line, rule: p.rule, section: null };
}

function ProblemList({ problems, label }: { problems: EffectProblem[]; label: string }) {
  if (!problems.length) return null;
  return (
    <div role="group" aria-label={label}>
      <DiagnosticList items={problems.map(toDiagnostic)} />
    </div>
  );
}

function MovedBanner({ moved }: { moved: ShippedMoved }) {
  return (
    <Banner tone="warning" title="The shipped rules have moved since this slice was checked">
      <span className="flex flex-col gap-1">
        <span>{moved.note}</span>
        <span className="text-ink-muted">What the check finds now is shown below, beside the row it concerns.</span>
      </span>
    </Banner>
  );
}

function InterviewLink({ show, primary }: { show: SliceShow; primary: boolean }) {
  if (!show.editable) return null;
  return (
    <Button variant={primary ? "primary" : "secondary"} asChild>
      <Link to={`/slices/${show.slice.slice_id}/interview`}>
        <MessagesSquare aria-hidden="true" />
        {show.slice.status === "draft" ? "Start the interview" : "Continue the interview"}
      </Link>
    </Button>
  );
}

/** The narrow pane: that this page only reads, how many shipped rules the check read, and where it read them. */
function CheckedAside({ show, shipped }: { show: SliceShow; shipped: ShippedChecked | null }) {
  const commit = shipped ? shortCommit(shipped.commit) : null;
  return (
    <div className="grid grid-cols-2 gap-x-10 gap-y-8 border-t border-line pt-6">
      <section aria-labelledby="effects-reads-title" className="flex flex-col gap-1.5">
        <Heading level={2} size="title-3" id="effects-reads-title">
          This page only reads
        </Heading>
        <Text size="body-sm" tone="muted">
          {show.editable ? "Each row is written in the interview, one shipped rule at a time. To change a row, continue the interview." : (show.edit_refusal ?? "This slice cannot be changed now.")}
        </Text>
      </section>
      {shipped ? (
        <section aria-labelledby="effects-checked-title" className="flex flex-col gap-3">
          <Heading level={2} size="title-3" id="effects-checked-title">
            What the check read
          </Heading>
          <Text size="body-sm" tone="muted" className="inline-flex items-start gap-1.5">
            <History aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {shipped.rules === 0 ? "No rule had shipped when this was checked" : `Checked against ${plural(shipped.rules, "rule")} that had shipped`}
          </Text>
          {shipped.notes.length ? (
            <Banner tone="info" title="The shipped rules could not all be read">
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {shipped.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {commit || shipped.branch ? (
            <div className="flex flex-col gap-2">
              <Text size="body-sm" tone="muted">
                From this computer’s copy of the main branch, which may be behind GitHub.
              </Text>
              <div className="text-body-sm">
                <FactList
                  facts={[
                    ["Branch", shipped.branch ? <ArtifactId plain>{shipped.branch}</ArtifactId> : "not recorded"],
                    ["Commit", commit ? <ArtifactId plain>{commit}</ArtifactId> : "not recorded"],
                    ["Rules read", String(shipped.rules)],
                  ]}
                />
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
