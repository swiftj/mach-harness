import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ArrowRight, CircleAlert, FileText, MessagesSquare, RefreshCw } from "lucide-react";
import {
  ArtifactId,
  Badge,
  Banner,
  Button,
  DiagnosticList,
  Disclosure,
  EmptyState,
  ErrorState,
  Heading,
  Skeleton,
  SkeletonText,
  StateGlyph,
  StatusPill,
  Text,
  cn,
  describeError,
} from "@mach/ui";
import type { BriefCheck, BriefModel, BriefShow, IdeaRow } from "@mach/ui/api";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";
import { ideaPath } from "../shell/steps";
import { useOperation } from "../../../api/useOperation";
import { useEngineAct } from "../../../api/act";
import {
  assumptionState,
  briefCounts,
  briefSections,
  checkAgainWords,
  checkState,
  epicTodayPath,
  isNone,
  numberedLines,
  placeFindings,
  proseBlocks,
  revisionWords,
  rulesByEpic,
  verdictState,
  type BriefSection,
  type PlacedFinding,
  type PlacedFindings,
} from "./briefModel";

/**
 * The brief, as written, beside its check (M16, screen engineer 3). A document made for reading: the product manager's
 * words set as text, never as markup, each finding of the engine's check placed beside the part it concerns, and the
 * check in a panel beside it. Nothing is edited here: the conversation on the Explore step writes the brief. The engine
 * decides whether it passes, every finding's words, the revision and whether a verdict still holds.
 * Fixtures: ?brief=passes|finding|stale-verdict|change-starter|none, ?refuse=brief.show.
 */
export function BriefScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="brief" lead="One page, written by the conversation and owned by you. It never reaches the builders as instructions; the slice specs do.">
      {(row) => <BriefPage row={row} />}
    </IdeaStepFrame>
  );
}

function BriefPage({ row }: { row: IdeaRow }) {
  const ideaId = row.idea_id;
  const show = useOperation("brief.show", { idea_id: ideaId });
  const idea = useOperation("idea.show", { idea_id: ideaId });
  const act = useEngineAct();
  const [lastCheck, setLastCheck] = useState<BriefCheck | null>(null);

  // The conversation writes the brief elsewhere; when the board says it changed, read it again.
  const seen = useRef(`${row.revision} ${row.has_brief} ${row.brief_checked}`);
  const { reload } = show;
  useEffect(() => {
    const now = `${row.revision} ${row.has_brief} ${row.brief_checked}`;
    if (now === seen.current) return;
    seen.current = now;
    reload();
  }, [row.revision, row.has_brief, row.brief_checked, reload]);

  const checkAgain = async () => {
    setLastCheck(null);
    const result = await act.run("brief.check", { idea_id: ideaId });
    if (result) {
      setLastCheck(result);
      show.reload();
      idea.reload();
    }
  };

  if (!show.data && show.loading) return <BriefSkeleton />;
  if (!show.data) {
    const error = show.error;
    if (error?.kind === "refused" && !row.has_brief) return <NoBrief ideaId={ideaId} />;
    const described = error ? describeError(error) : { title: "Could not read the brief", message: "" };
    return (
      <ErrorState
        icon={<CircleAlert />}
        title={error?.kind === "refused" ? "The brief could not be shown" : described.title}
        message={error?.kind === "refused" ? error.message : described.message}
        hint={error?.hint}
        action={
          <div className="flex flex-wrap gap-2">
            <Button onClick={show.reload}>Try again</Button>
            <Button variant="ghost" asChild>
              <Link to={ideaPath(ideaId, "explore")}>Back to the conversation</Link>
            </Button>
          </div>
        }
      />
    );
  }

  const data = show.data;
  const placed = placeFindings(data);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_19rem] items-start gap-10">
      <div className="flex min-w-0 flex-col gap-5">
        <WrittenElsewhere ideaId={ideaId} primary={!data.passes} />
        <Notices show={data} lastCheck={lastCheck} actError={act.shown} ideaId={ideaId} />
        <BriefDocument show={data} placed={placed} lookups={idea.data?.lookups ?? null} />
        <Disclosure summary="The text as written, with its line numbers">
          <Text size="body-sm" tone="muted" className="mb-3">
            The check names lines by these numbers.
          </Text>
          <ol className="flex flex-col" aria-label="The brief's lines">
            {numberedLines(data.text).map((l) => (
              <li key={l.n} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3">
                <span className="text-right text-caption tabular text-ink-subtle">{l.n}</span>
                <span className="min-w-0 whitespace-pre-wrap break-words text-body-sm text-ink">{l.text || " "}</span>
              </li>
            ))}
          </ol>
        </Disclosure>
      </div>
      <CheckPanel show={data} placed={placed} ideaId={ideaId} onCheckAgain={checkAgain} checking={act.pending} />
    </div>
  );
}

/** Where the brief is written, and the way back to it. */
function WrittenElsewhere({ ideaId, primary }: { ideaId: string; primary: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-md border border-line bg-surface-sunken px-4 py-3">
      <Text size="body-sm" tone="muted" className="max-w-reading">
        The conversation on the Explore step writes this brief with you. It is read here, not edited: to change a word, say it in the conversation.
      </Text>
      <Button variant={primary ? "primary" : "secondary"} size="sm" asChild>
        <Link to={ideaPath(ideaId, "explore")}>
          <MessagesSquare aria-hidden="true" />
          Back to the conversation
        </Link>
      </Button>
    </div>
  );
}

function Notices({
  show,
  lastCheck,
  actError,
  ideaId,
}: {
  show: BriefShow;
  lastCheck: BriefCheck | null;
  actError: ReturnType<typeof useEngineAct>["shown"];
  ideaId: string;
}) {
  const verdict = verdictState(show.verdict);
  const revision = revisionWords(show);
  const said = lastCheck ? checkAgainWords(lastCheck) : null;
  return (
    <>
      {actError ? (
        <Banner tone="danger" live="assertive" title={actError.title === "Not done" ? "The brief was not checked" : actError.title}>
          {actError.message}
        </Banner>
      ) : null}
      {said ? (
        <Banner tone={lastCheck?.passes ? "success" : "info"} live="polite" title={said.title}>
          {said.body}
        </Banner>
      ) : null}
      {verdict.kind === "stale" ? (
        <Banner
          tone="warning"
          title={`Your verdict (${verdict.decision}) no longer holds`}
          actions={
            <Button variant="secondary" size="sm" asChild>
              <Link to={ideaPath(ideaId, "case")}>Go to the case</Link>
            </Button>
          }
        >
          {verdict.note}
        </Banner>
      ) : null}
      {revision.changed && !said ? (
        <Banner tone="info" title={show.revision === 0 ? "Not checked yet" : "Changed since its last check"}>
          {revision.changed}
        </Banner>
      ) : null}
    </>
  );
}

/* ---------------------------------------------------------------- the document */

function BriefDocument({ show, placed, lookups }: { show: BriefShow; placed: PlacedFindings; lookups: Parameters<typeof rulesByEpic>[1] }) {
  const model = show.model;
  const written = new Set(model?.sections ?? []);
  const revision = revisionWords(show);
  return (
    <article aria-labelledby="brief-title" className="flex flex-col gap-10 rounded-md border border-line bg-surface px-10 py-9">
      <header className="flex flex-col gap-2 border-b border-line pb-6">
        <Text size="caption" tone="subtle" className="tabular">
          {revision.line}
        </Text>
        <Heading level={2} size="title-1" id="brief-title" className="max-w-reading">
          {model?.title ?? <span className="italic text-ink-subtle">No title written</span>}
        </Heading>
      </header>
      {placed.whole.length ? (
        <section aria-label="About the whole brief" className="flex flex-col gap-2">
          <Text size="body-sm" weight="semibold">
            About the whole brief
          </Text>
          <DiagnosticList items={placed.whole} />
        </section>
      ) : null}
      {briefSections.map(({ id, heading, required }) => (
        <DocSection key={id} id={id} heading={heading} findings={placed.section[id] ?? []}>
          {!written.has(heading) ? (
            <Missing>{required ? "Not written yet." : "Left out of this brief."}</Missing>
          ) : (
            <SectionBody id={id} model={model} placed={placed} lookups={lookups} />
          )}
        </DocSection>
      ))}
    </article>
  );
}

function DocSection({ id, heading, findings, children }: { id: BriefSection; heading: string; findings: PlacedFinding[]; children: ReactNode }) {
  return (
    <section id={`brief-section-${id}`} aria-labelledby={`brief-section-${id}-title`} className="flex scroll-mt-6 flex-col gap-3">
      <Heading level={3} size="title-3" id={`brief-section-${id}-title`}>
        {heading}
      </Heading>
      {findings.length ? <DiagnosticList items={findings} /> : null}
      {children}
    </section>
  );
}

function SectionBody({ id, model, placed, lookups }: { id: BriefSection; model: BriefModel; placed: PlacedFindings; lookups: Parameters<typeof rulesByEpic>[1] }) {
  switch (id) {
    case "problem":
      return <Prose text={model.problem} lead />;
    case "who":
      return <Prose text={model.who_has_it} />;
    case "not-doing":
      return <Prose text={model.not_doing} />;
    case "risks":
      return <Prose text={model.risks} />;
    case "outcomes":
      return <Outcomes model={model} placed={placed} />;
    case "assumptions":
      return <Assumptions model={model} placed={placed} />;
    case "open-questions":
      return <OpenQuestions questions={model.open_questions ?? []} />;
    case "touches":
      return <Touches model={model} lookups={lookups} />;
  }
}

/** The product manager's words as text: paragraphs, or bullets where they wrote bullets. */
function Prose({ text, lead = false }: { text: string | null | undefined; lead?: boolean }) {
  if (isNone(text)) return <Missing>None.</Missing>;
  const blocks = proseBlocks(text);
  if (!blocks.length) return <Missing>Nothing written.</Missing>;
  return (
    <div className={cn("flex max-w-reading flex-col gap-3 text-ink", lead ? "text-body-lg" : "text-body")}>
      {blocks.map((block, index) =>
        block.kind === "paragraph" ? (
          <p key={index}>{block.text}</p>
        ) : (
          <ul key={index} className="flex list-disc flex-col gap-1 pl-5">
            {block.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

function Missing({ children }: { children: ReactNode }) {
  return (
    <Text size="body-sm" tone="subtle" className="italic">
      {children}
    </Text>
  );
}

/** One numbered line of the brief (an outcome or an assumption): its ID in the gutter, the words beside it. */
function IdLine({ id, children, findings }: { id: string; children: ReactNode; findings: PlacedFinding[] }) {
  return (
    <li id={`brief-${id}`} aria-labelledby={`brief-${id}-id`} className="grid scroll-mt-6 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-4 border-t border-line py-4 first:border-t-0 first:pt-1">
      <span id={`brief-${id}-id`} className="pt-1">
        <ArtifactId>{id}</ArtifactId>
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        {children}
        {findings.length ? <DiagnosticList items={findings} compact /> : null}
      </div>
    </li>
  );
}

function Outcomes({ model, placed }: { model: BriefModel; placed: PlacedFindings }) {
  if (!model.outcomes?.length) return <Missing>No outcome could be read.</Missing>;
  return (
    <ul className="flex max-w-reading flex-col">
      {model.outcomes.map((o) => (
        <IdLine key={o.id} id={o.id} findings={placed.outcome[o.id] ?? []}>
          <p className="text-body-lg text-ink">{o.text}</p>
          <p className="text-body-sm text-ink-muted">
            <span className="font-semibold text-ink">How we would know: </span>
            {o.how_we_would_know ? o.how_we_would_know : <span className="italic text-ink-subtle">not written yet</span>}
          </p>
        </IdLine>
      ))}
    </ul>
  );
}

function Assumptions({ model, placed }: { model: BriefModel; placed: PlacedFindings }) {
  if (!model.assumptions?.length) return <Missing>None.</Missing>;
  return (
    <ul className="flex max-w-reading flex-col">
      {model.assumptions.map((a) => {
        const state = assumptionState(a);
        return (
          <IdLine key={a.id} id={a.id} findings={placed.assumption[a.id] ?? []}>
            <p className="text-body text-ink">{a.text}</p>
            <span className="self-start">
              <StatusPill tone={state.tone} size="sm" icon={<StateGlyph shape={state.glyph} />} className="whitespace-normal">
                {state.word}
              </StatusPill>
            </span>
          </IdLine>
        );
      })}
    </ul>
  );
}

function OpenQuestions({ questions }: { questions: string[] }) {
  if (!questions.length) return <Missing>None.</Missing>;
  return (
    <ul className="flex max-w-reading flex-col gap-2">
      {questions.map((q, i) => (
        <li key={i} className="flex items-start gap-2.5 rounded-md border border-warning-line bg-surface px-4 py-3">
          <span className="mt-1 shrink-0 text-warning-ink">
            <StateGlyph shape="half" />
          </span>
          <p className="min-w-0 text-body text-ink">{q}</p>
        </li>
      ))}
    </ul>
  );
}

function Touches({ model, lookups }: { model: BriefModel; lookups: Parameters<typeof rulesByEpic>[1] }) {
  const capabilities = model.touches?.capabilities ?? [];
  const groups = rulesByEpic(model, lookups);
  return (
    <div className="flex max-w-reading flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Text size="body-sm" tone="muted">
          Capabilities
        </Text>
        {capabilities.length ? (
          <ul className="flex flex-wrap gap-2">
            {capabilities.map((c, i) => (
              <li key={i}>
                <Badge tone="neutral" className="h-auto min-h-6 whitespace-normal py-0.5 text-body-sm font-normal text-ink">
                  {c.name}
                  {c.epic_id ? <ArtifactId plain>{c.epic_id}</ArtifactId> : null}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Missing>None named.</Missing>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Text size="body-sm" tone="muted">
          Shipped rules
        </Text>
        {groups.length ? (
          <ul className="flex flex-col gap-3">
            {groups.map((g) => (
              <li key={g.epicId ?? "none"} className="flex flex-col gap-1.5">
                <span className="flex flex-wrap gap-1.5">
                  {g.rules.map((rule) => (
                    <ArtifactId key={rule}>{rule}</ArtifactId>
                  ))}
                </span>
                {g.epicId ? (
                  <Link to={epicTodayPath(g.epicId)} className="self-start rounded-xs text-body-sm text-accent-ink underline underline-offset-2 hover:text-ink">
                    How {g.name ?? <ArtifactId plain>{g.epicId}</ArtifactId>} works today
                  </Link>
                ) : groups.length > 1 || capabilities.some((c) => c.epic_id) ? (
                  <Text size="caption" tone="subtle">
                    Their epic was not recorded when they were looked up.
                  </Text>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Missing>None.</Missing>
        )}
        {capabilities.some((c) => c.epic_id) ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {capabilities
              .filter((c) => c.epic_id && !groups.some((g) => g.epicId === c.epic_id))
              .map((c) => (
                <li key={c.epic_id}>
                  <Link to={epicTodayPath(c.epic_id as string)} className="rounded-xs text-body-sm text-accent-ink underline underline-offset-2 hover:text-ink">
                    How {c.name} works today
                  </Link>
                </li>
              ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- findings */


/** Moves to the part of the brief a finding is placed beside, and gives it focus. */
function goTo(anchor: string) {
  const target = document.getElementById(anchor);
  if (!target) return;
  target.scrollIntoView({ block: "start" });
  target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

function AsideFindings({ title, items }: { title: string; items: PlacedFinding[] }) {
  if (!items.length) return null;
  const error = items[0]?.severity === "error";
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <Text size="body-sm" weight="semibold">
        {title}
      </Text>
      <ul className="flex flex-col gap-2">
        {items.map((f, i) => (
          <li key={i} className={cn("flex flex-col gap-1.5 rounded-md border px-3 py-2.5", error ? "border-danger-line bg-danger-soft" : "border-warning-line bg-warning-soft")}>
            <span className="flex items-start gap-2 text-body-sm text-ink">
              <span className={cn("mt-0.5 shrink-0", error ? "text-danger-ink" : "text-warning-ink")}>
                <StateGlyph shape={error ? "blocked" : "half"} />
              </span>
              <span className="min-w-0">{f.message}</span>
            </span>
            {f.anchor ? (
              <button
                type="button"
                onClick={() => goTo(f.anchor as string)}
                className="ml-6 min-h-6 self-start rounded-xs text-left text-caption font-semibold text-ink-muted underline underline-offset-2 hover:text-ink"
              >
                Show {f.partName} in the brief
              </button>
            ) : (
              <span className="ml-6 text-caption text-ink-subtle">About the whole brief{f.line ? `, line ${f.line}` : ""}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------------------------------------------------------- the check panel */

function CheckPanel({
  show,
  placed,
  ideaId,
  onCheckAgain,
  checking,
}: {
  show: BriefShow;
  placed: PlacedFindings;
  ideaId: string;
  onCheckAgain: () => void;
  checking: boolean;
}) {
  const state = checkState(show);
  const counts = briefCounts(show.model);
  const revision = revisionWords(show);
  const verdict = verdictState(show.verdict);
  return (
    <aside aria-labelledby="check-title" className="sticky top-6 flex flex-col gap-5">
      <section className="flex flex-col gap-4 rounded-md border border-line bg-surface px-4 py-4">
        <div className="flex items-baseline justify-between gap-2">
          <Heading level={2} size="title-3" id="check-title">
            Check
          </Heading>
          <Text as="span" size="caption" tone="subtle" className="tabular">
            {revision.line}
            {show.changed_since_check && show.revision > 0 ? ", changed since" : ""}
          </Text>
        </div>
        <span className="self-start">
          <StatusPill tone={state.tone} icon={<StateGlyph shape={state.glyph} />}>
            {state.word}
          </StatusPill>
        </span>
        <Text size="body-sm" tone="muted">
          {state.detail}
        </Text>
        {counts ? (
          <dl className="grid grid-cols-2 gap-2">
            {counts.map(([label, value]) => (
              <div key={label} className="flex min-w-0 flex-col rounded-sm bg-surface-sunken px-2.5 py-2">
                <dt className="truncate text-caption text-ink-muted">{label}</dt>
                <dd className="text-title-3 font-semibold tabular text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {verdict.kind !== "none" ? (
          <Text size="body-sm" tone="muted" className="flex items-start gap-2">
            <span className={cn("mt-0.5 shrink-0", verdict.kind === "stale" ? "text-warning-ink" : "text-ink-muted")}>
              <StateGlyph shape={verdict.kind === "stale" ? "superseded" : "approved"} />
            </span>
            <span>
              {verdict.kind === "stale" ? `Verdict ${verdict.decision}: no longer holds.` : `Verdict ${verdict.decision}: holds for this brief.`}
            </span>
          </Text>
        ) : null}
        <div className="flex flex-col gap-2">
          {show.passes ? (
            <Button variant="primary" asChild>
              <Link to={ideaPath(ideaId, "case")}>
                Make the case
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onCheckAgain} disabled={checking} aria-busy={checking || undefined}>
            <RefreshCw aria-hidden="true" />
            {checking ? "Checking…" : "Check again"}
          </Button>
        </div>
        <Text size="caption" tone="subtle">
          MACH checks the brief's structure. It never scores the idea.
        </Text>
      </section>
      <AsideFindings title={`Problems to fix (${placed.errors.length})`} items={placed.errors} />
      <AsideFindings title={`Warnings (${placed.warnings.length})`} items={placed.warnings} />
    </aside>
  );
}

/* ---------------------------------------------------------------- empty and loading */

function NoBrief({ ideaId }: { ideaId: string }) {
  return (
    <EmptyState
      icon={<FileText />}
      title="No brief yet"
      description="A brief is one page: the problem, who has it, and the outcomes you want, each with how you would know. The conversation on the Explore step writes it with you."
      action={
        <Button variant="primary" asChild>
          <Link to={ideaPath(ideaId, "explore")}>
            <MessagesSquare aria-hidden="true" />
            Go to the conversation
          </Link>
        </Button>
      }
    />
  );
}

function BriefSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Reading the brief" className="grid grid-cols-[minmax(0,1fr)_19rem] items-start gap-10">
      <div className="flex flex-col gap-6 rounded-md border border-line bg-surface px-10 py-9">
        <Skeleton className="h-9 w-2/3" />
        <SkeletonText lines={3} />
        <Skeleton className="h-6 w-40" />
        <SkeletonText lines={4} />
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

