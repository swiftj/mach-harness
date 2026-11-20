import { Link, useParams } from "react-router";
import { CircleAlert, History, MessagesSquare } from "lucide-react";
import { ArtifactId, Banner, Button, DiagnosticList, Disclosure, EmptyState, ErrorState, FactList, Heading, Skeleton, SkeletonText, StateGlyph, StatusPill, Text, describeError, plain, plural, type Diagnostic, type GlyphShape, type Tone } from "@mach/ui";
import type { EffectRow, ShippedChecked, ShippedMoved, SliceShow } from "@mach/ui/api";
import { useSliceShow } from "../../api/useSliceShow";
import { useOperation } from "../../api/useOperation";
import { useStatus } from "../../api/store";
import { SliceScreenFrame } from "../../shared/ScreenFrame";
import { effectWords, effectsView, shortCommit, type EffectLine, type EffectProblem } from "./model";

/**
 * What one slice does to behaviour that has shipped: `slice.show` (`spec.model.effects`, the check's
 * findings about the section, `check.shipped`) and `status.slices[].shipped_moved`. Read-only: the rows
 * are written in the interview. The shipped rule's wording, where the slice's own epic lists it, comes
 * from `epic.current`. Fixtures: ?show=effects, ?fixture=status.shipped-moved.
 */
export function SliceEffectsScreen() {
  const sliceId = useParams().sliceId ?? "";
  return <EffectsPage key={sliceId} sliceId={sliceId} />;
}

function EffectsPage({ sliceId }: { sliceId: string }) {
  const show = useSliceShow(sliceId);
  const moved = useStatus().data?.slices.find((s) => s.slice_id === sliceId)?.shipped_moved ?? null;
  return (
    <SliceScreenFrame sliceId={sliceId} slice={show.data?.slice} title="Effects on shipped behaviour" lead="Which rules that have already shipped this slice keeps, changes, replaces or retires.">
      {show.data ? (
        <EffectsBody show={show.data} moved={moved} />
      ) : show.loading ? (
        <EffectsSkeleton />
      ) : (
        <LoadError error={show.error} sliceId={sliceId} onRetry={show.reload} />
      )}
    </SliceScreenFrame>
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

function EffectsBody({ show, moved }: { show: SliceShow; moved: ShippedMoved | null }) {
  const view = effectsView(show, moved);
  const epic = useOperation("epic.current", view.state === "rows" ? { epic_id: show.slice.epic_id } : null);
  const unanswered = view.sectionProblems.length === 0 || view.sectionProblems.some((p) => p.rule === "effects-missing");
  const wording = new Map<string, string>();
  const known = epic.data?.epic;
  if (known) [...known.in_force, ...known.not_yet_reconciled, ...known.no_longer_in_force].forEach((r) => wording.set(r.rule, r.text));

  return (
    <div className="flex flex-col gap-8">
      {view.moved ? <MovedBanner moved={view.moved} /> : null}
      <ReadOnlyNote show={show} offer={view.state === "rows" || view.state === "none"} />
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
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <Heading level={2} size="title-2" id="effects-title">
              {view.state === "none" ? "No effect on shipped behaviour" : plural(view.rows.length, "shipped rule") + " touched"}
            </Heading>
            <ShippedSummary shipped={view.shipped} />
          </div>
          {view.sectionProblems.length ? <ProblemList problems={view.sectionProblems} label="About the whole section" /> : null}
          {view.state === "none" ? <NoneAnswer /> : <EffectsTable rows={view.rows} wording={wording} />}
        </section>
      )}
      <ShippedDetail shipped={view.shipped} />
    </div>
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

function EffectsTable({ rows, wording }: { rows: EffectLine[]; wording: Map<string, string> }) {
  return (
    // A scrollable region must be reachable by keyboard (WCAG 2.1.1; axe scrollable-region-focusable).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="overflow-x-auto rounded-md border border-line" role="region" aria-label="Each shipped rule this slice touches, scrolls sideways when narrow" tabIndex={0}>
      <table className="w-full min-w-[44rem] border-collapse text-body-sm">
        <caption className="sr-only">Each shipped rule this slice touches, what it does to it, and what in this slice takes its place or proves it still holds</caption>
        <thead className="bg-surface-sunken">
          <tr>
            {["Shipped rule", "Effect", "In this slice", "Note"].map((h) => (
              <th key={h} scope="col" className="border-b border-line-strong px-3 py-2 text-left text-label text-ink-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="bg-surface">
          {rows.map((line, index) => (
            <EffectTableRow key={`${line.row.shipped_rule}-${index}`} line={line} text={wording.get(line.row.shipped_rule) ?? null} last={index === rows.length - 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EffectTableRow({ line, text, last }: { line: EffectLine; text: string | null; last: boolean }) {
  const { row, problems } = line;
  const words = effectWords[row.effect];
  const rule = last && !problems.length ? "" : "border-b border-line";
  return (
    <>
      <tr className="align-top">
        <th scope="row" className={`px-3 py-3 text-left font-normal ${problems.length ? "" : rule}`}>
          <div className="flex min-w-0 flex-col gap-1">
            <ArtifactId className="self-start">{row.shipped_rule}</ArtifactId>
            {text ? <span className="max-w-[28rem] text-body-sm text-ink-muted">{plain(text)}</span> : null}
          </div>
        </th>
        <td className={`px-3 py-3 ${problems.length ? "" : rule}`}>
          <div className="flex flex-col gap-1">
            <span className="self-start">
              <EffectPill effect={row.effect} />
            </span>
            {words ? <span className="max-w-[14rem] text-caption text-ink-subtle">{words.means}</span> : null}
          </div>
        </td>
        <td className={`px-3 py-3 ${problems.length ? "" : rule}`}>
          {row.in_slice ? (
            <span className="flex flex-col gap-1">
              {words?.inSlice ? <span className="text-caption text-ink-subtle">{words.inSlice}</span> : null}
              <ArtifactId className="self-start">{row.in_slice}</ArtifactId>
            </span>
          ) : (
            <span className="text-ink-subtle italic">Nothing takes its place</span>
          )}
        </td>
        <td className={`px-3 py-3 text-ink ${problems.length ? "" : rule}`}>{row.note ? <span className="whitespace-pre-line break-words">{row.note}</span> : <span className="text-ink-subtle italic">No note</span>}</td>
      </tr>
      {problems.length ? (
        <tr>
          <td colSpan={4} className={`px-3 pb-3 ${last ? "" : "border-b border-line"}`}>
            <ProblemList problems={problems} label={`About ${row.shipped_rule}`} />
          </td>
        </tr>
      ) : null}
    </>
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

function ReadOnlyNote({ show, offer }: { show: SliceShow; offer: boolean }) {
  return (
    <div className="flex max-w-reading flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-md border border-line bg-surface px-5 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Text weight="semibold">This page only reads</Text>
        <Text size="body-sm" tone="muted">
          {show.editable ? "Each row is written in the interview, one shipped rule at a time. To change a row, continue the interview." : (show.edit_refusal ?? "This slice cannot be changed now.")}
        </Text>
      </div>
      {offer ? <InterviewLink show={show} primary={false} /> : null}
    </div>
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

function ShippedSummary({ shipped }: { shipped: ShippedChecked | null }) {
  if (!shipped) return null;
  return (
    <Text size="body-sm" tone="muted" className="inline-flex items-center gap-1.5">
      <History aria-hidden="true" className="size-4" />
      {shipped.rules === 0 ? "No rule had shipped when this was checked" : `Checked against ${plural(shipped.rules, "rule")} that had shipped`}
    </Text>
  );
}

/** Where the check read the shipped rules, and anything the engine said it could not read. */
function ShippedDetail({ shipped }: { shipped: ShippedChecked | null }) {
  if (!shipped) return null;
  const commit = shortCommit(shipped.commit);
  return (
    <div className="flex max-w-reading flex-col gap-3">
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
        <Disclosure summary="Where the shipped rules were read">
          <div className="flex flex-col gap-2">
            <Text size="body-sm" tone="muted">
              From this computer’s copy of the main branch, which may be behind GitHub.
            </Text>
            <FactList
              facts={[
                ["Branch", shipped.branch ? <ArtifactId plain>{shipped.branch}</ArtifactId> : "not recorded"],
                ["Commit", commit ? <ArtifactId plain>{commit}</ArtifactId> : "not recorded"],
                ["Rules read", String(shipped.rules)],
              ]}
            />
          </div>
        </Disclosure>
      ) : null}
    </div>
  );
}
