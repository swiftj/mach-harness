/**
 * Decisions in force (key 4, `#decisions`): the project's architecture decisions (ADRs) for an
 * engineer. The list, the required baseline, what waits on a person, and one decision's page
 * (`#decisions?adr=ADR-0007`). Nothing here accepts, changes or excepts a decision; the page says where
 * that is done (a ticket's proposal or conflict can be decided in "Needs you" on the Line, M23).
 *
 * Live: read from the observer (`/api/v1/decisions`, `/api/v1/decisions/{adr}`) when the workspace
 * opens and on "Read again"; it does not follow the stream. Simulation: the sample in fixture.ts,
 * under the Simulation's stamp and a banner saying so; never a project's.
 *
 * People's words (titles, the ADR's text, problems that quote a header, recorded reasons) are printed
 * only through UncheckedText: plain text, bounded, labelled once per section. An ADR's text is shown
 * as plain monospaced text: never Markdown, never markup, and nothing in it is a link.
 */
import { ArrowLeft, FileText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge, CommandLine, EmptyState, ErrorState, LoadingState, Moment, StatusPill, cn } from "@mach/ui";
import { useSceneStore, useStore } from "../scene";
import { ObserverError } from "../live/observer";
import { SourceStamp } from "../shell/SourceBadge";
import { useSource } from "../shell/source/context";
import { UncheckedNote, UncheckedText } from "../text/UncheckedText";
import type { UncheckedText as Unchecked } from "../text/unchecked";
import { SAMPLE_DECISIONS, sampleDecision } from "./fixture";
import {
  BASELINE_HELD,
  COMMANDS,
  STATUS_WORDS,
  STOP_WORDS,
  WHERE_CHANGED,
  ordered,
  readDecision,
  readDecisions,
  sameTextWords,
  stateWords,
  stopCommand,
  summary,
  type AdrRow,
  type DecisionPage,
  type DecisionsView,
} from "./model";

type Load<T> = { readonly state: "loading" } | { readonly state: "ready"; readonly data: T } | { readonly state: "absent" } | { readonly state: "failed"; readonly message: string };

/** One read, again on `nonce`. A 404 from an observer that has no such route is "absent", not a failure. */
function useRead<T>(read: ((signal: AbortSignal) => Promise<T>) | null, nonce: number, key: string): Load<T> {
  const [load, setLoad] = useState<{ key: string; value: Load<T> }>({ key: "", value: { state: "loading" } });
  useEffect(() => {
    if (!read) return;
    const ctl = new AbortController();
    // Until this read answers, the key differs from the one held, so the hook says "loading".
    const k = `${key}#${nonce}`;
    read(ctl.signal).then(
      (data) => setLoad({ key: k, value: { state: "ready", data } }),
      (error: unknown) => {
        if (ctl.signal.aborted) return;
        if (error instanceof ObserverError && error.kind === "not_found") setLoad({ key: k, value: { state: "absent" } });
        else setLoad({ key: k, value: { state: "failed", message: error instanceof Error ? error.message : "The observer could not be read." } });
      },
    );
    return () => ctl.abort();
  }, [read, nonce, key]);
  return load.key === `${key}#${nonce}` ? load.value : { state: "loading" };
}

export function DecisionsWorkspace() {
  const store = useStore();
  const source = useSceneStore((s) => s.source);
  const decision = useSceneStore((s) => s.decision);
  const { client = null } = useSource();
  const [nonce, setNonce] = useState(0);
  const simulation = source === "simulation";

  const readList = useCallback(
    async (signal: AbortSignal): Promise<DecisionsView> => {
      if (simulation) return readDecisions(SAMPLE_DECISIONS);
      if (!client?.decisions) throw new ObserverError("not_found", "This observer has no decisions route.", 404);
      return readDecisions(await client.decisions(signal));
    },
    [client, simulation],
  );
  const readOne = useCallback(
    async (signal: AbortSignal): Promise<DecisionPage> => {
      if (!decision) throw new ObserverError("not_found", "No decision is open.", 404);
      if (simulation) {
        const sample = sampleDecision(decision);
        if (!sample) throw new ObserverError("not_found", "The sample has no such decision.", 404);
        return readDecision(sample, decision);
      }
      if (!client?.decision) throw new ObserverError("not_found", "This observer has no decisions route.", 404);
      return readDecision(await client.decision(decision, signal), decision);
    },
    [client, simulation, decision],
  );
  const list = useRead(simulation || client ? readList : null, nonce, `list|${source}`);
  const page = useRead(decision && (simulation || client) ? readOne : null, nonce, `one|${source}|${decision ?? ""}`);

  const home = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstShown = useRef(true);
  // Opening a decision, or going back, moves focus to the heading of what is now shown.
  useEffect(() => {
    if (firstShown.current) {
      firstShown.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: false });
    home.current?.scrollTo?.({ top: 0 });
  }, [decision]);

  const open = (id: string | null) => store.setDecision(id);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && decision && !e.defaultPrevented) {
      e.preventDefault();
      open(null);
    }
  };

  return (
    // The workspace's keyboard home (focus returns here); Escape on a decision's page goes back to the list,
    // a shortcut for the "Back to every decision" button, which is the control.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div ref={home} tabIndex={-1} data-decisions-home="" onKeyDown={onKeyDown} className="h-full overflow-y-auto outline-none">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-6 px-4 py-6 min-[900px]:px-8">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 ref={decision ? undefined : heading} tabIndex={-1} className="font-display text-title-1 font-[650] text-ink outline-none">
              Decisions in force
            </h2>
            {simulation ? <SourceStamp source="simulation" /> : null}
            <button
              type="button"
              onClick={() => setNonce((n) => n + 1)}
              className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-sm border border-line-control bg-surface px-2.5 text-body-sm text-ink hover:bg-surface-sunken [&_svg]:size-4"
            >
              <RefreshCw aria-hidden="true" />
              Read again
            </button>
          </div>
          <p className="max-w-reading text-body text-ink-muted">The project's architecture decisions (ADRs), the decisions every ticket must have before it is planned, and what waits on an engineer.</p>
          <p className="max-w-reading rounded-sm border border-line bg-surface-sunken px-3 py-2 text-body-sm text-ink" data-decisions-where="">
            {WHERE_CHANGED}
          </p>
          {simulation ? (
            <p className="max-w-reading text-body-sm text-warning-ink" data-decisions-sample="">
              Simulation: these are sample decisions to show the page. No project was read.
            </p>
          ) : null}
        </header>

        {!simulation && !client ? (
          <EmptyState title="Nothing real to show here" description="Architecture decisions are read from a project by the observer. Open the Factory Floor from the observer's link to see them." />
        ) : decision ? (
          <DecisionView id={decision} load={page} headingRef={heading} onBack={() => open(null)} onOpen={open} onRetry={() => setNonce((n) => n + 1)} />
        ) : (
          <ListView load={list} onOpen={open} onRetry={() => setNonce((n) => n + 1)} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function Section({ title, id, note, children }: { title: string; id: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div>
        <h3 id={id} className="text-title-3 font-semibold text-ink">
          {title}
        </h3>
        {note ? <p className="mt-0.5 text-caption text-ink-subtle">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Basis({ text }: { text: string }) {
  return text ? <p className="max-w-reading text-caption text-ink-subtle" data-decisions-basis="">{text}</p> : null;
}

/** An ADR ID that opens its page: a real button, so Tab, Enter and Space work. */
function AdrLink({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(id)} className="font-mono text-[13px] text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2">
      {id}
    </button>
  );
}

function AdrLinks({ ids, onOpen }: { ids: readonly string[]; onOpen: (id: string) => void }) {
  return (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-1">
      {ids.map((id) => (
        <AdrLink key={id} id={id} onOpen={onOpen} />
      ))}
    </span>
  );
}

function Contained({ text, max }: { text: Unchecked | null; max?: number }) {
  return <UncheckedText text={text} labelled {...(max !== undefined ? { max } : {})} />;
}

function StatusMark({ a }: { a: Pick<AdrRow, "status" | "supersededBy" | "binding" | "problems" | "unread"> }) {
  const tone = a.unread || !a.status ? "danger" : a.status === "accepted" && !a.binding ? "warning" : STATUS_WORDS[a.status].tone;
  return (
    <StatusPill tone={tone} size="sm" className={cn(a.status === "proposed" && "border-dashed", (a.unread || !a.status) && "rounded-none")}>
      {stateWords(a)}
    </StatusPill>
  );
}

function Loading({ load, onRetry, what, children }: { load: Load<unknown>; onRetry: () => void; what: string; children: () => ReactNode }) {
  if (load.state === "loading") return <LoadingState label={`Reading ${what}`} />;
  if (load.state === "absent")
    return <EmptyState title="This observer does not serve decisions" description="It was built before Decisions in force. Start the observer that came with this version of MACH to see them." />;
  if (load.state === "failed")
    return (
      <ErrorState
        title={`The observer could not read ${what}`}
        message={load.message}
        action={
          <button type="button" onClick={onRetry} className="rounded-sm border border-line-control bg-surface px-3 py-1.5 text-body-sm font-semibold text-ink hover:bg-surface-sunken">
            Try again
          </button>
        }
      />
    );
  return <>{children()}</>;
}

const TABLE = "w-full border-collapse text-body-sm";
const TH = "border-b border-line-strong px-2 py-1.5 text-left align-bottom text-label text-ink-muted";
const TD = "border-b border-line px-2 py-2 align-top";

// ---------------------------------------------------------------- the list

function ListView({ load, onOpen, onRetry }: { load: Load<DecisionsView>; onOpen: (id: string) => void; onRetry: () => void }) {
  return (
    <Loading load={load} onRetry={onRetry} what="the decisions">
      {() => {
        if (load.state !== "ready") return null;
        const v = load.data;
        const s = summary(v);
        return (
          <>
            <Basis text={v.basis} />
            <Baseline v={v} onOpen={onOpen} />
            <Waiting v={v} onOpen={onOpen} />
            <Section
              title="Every decision"
              id="decisions-all"
              note={
                <>
                  {v.adrs.length === 0 ? "None yet. " : `${v.adrs.length} in ${v.dir ?? "the ADR folder"}: ${s.binding} in force, ${s.proposed} proposed, ${s.withProblems} with problems. `}
                  Titles and problems: <UncheckedNote />.
                </>
              }
            >
              {v.adrs.length === 0 ? (
                <EmptyState
                  title="No architecture decisions yet"
                  description={
                    v.dirFound
                      ? `${v.dir ?? "The ADR folder"} holds no ADR file. An engineer writes one with ${COMMANDS.new.command}, or drafts the baseline with ${COMMANDS.baseline.command}.`
                      : `There is no ${v.dir ?? "ADR"} folder. An engineer drafts the baseline with ${COMMANDS.baseline.command}.`
                  }
                />
              ) : (
                <AdrTable adrs={v.adrs} onOpen={onOpen} />
              )}
              {v.problems.length ? (
                <div className="flex flex-col gap-1" data-decisions-problems="">
                  <p className="text-label text-danger-ink">Problems MACH found in the ADR folder</p>
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink">
                    {v.problems.map((p, i) => (
                      <li key={i}>
                        <Contained text={p} />
                      </li>
                    ))}
                  </ul>
                  <p className="text-caption text-ink-muted">A file with a problem binds nothing. It is fixed by a pull request for the file.</p>
                </div>
              ) : null}
              <CommandLine command={COMMANDS.list.command} purpose={COMMANDS.list.purpose} />
            </Section>
            {v.cellsUnreadable.length ? (
              <p className="text-body-sm text-warning-ink">
                The records of {v.cellsUnreadable.join(", ")} could not be read, so what they wait on is not shown.
              </p>
            ) : null}
          </>
        );
      }}
    </Loading>
  );
}

function AdrTable({ adrs, onOpen }: { adrs: readonly AdrRow[]; onOpen: (id: string) => void }) {
  return (
    // A table that can scroll sideways is a focusable region with a name (style guide 7.19).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div role="region" aria-label="Every decision, scrolls sideways when narrow" tabIndex={0} className="overflow-x-auto rounded-md border border-line">
      <table className={TABLE} data-decisions-table="">
        <thead className="bg-surface-sunken">
          <tr>
            <th scope="col" className={TH}>
              ADR
            </th>
            <th scope="col" className={TH}>
              Decision
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
            <th scope="col" className={TH}>
              Topics
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered(adrs).map((a, i) => (
            <tr key={`${a.file ?? i}`} data-adr={a.id ?? ""}>
              <td className={cn(TD, "whitespace-nowrap")}>{a.id ? <AdrLink id={a.id} onOpen={onOpen} /> : <span className="text-caption text-ink-subtle">no number</span>}</td>
              <td className={TD}>
                <span className="text-ink">{a.title ? <Contained text={a.title} /> : <span className="italic text-ink-subtle">{a.unread ? "cannot be read" : "no title"}</span>}</span>
                <span className="mt-0.5 block break-all font-mono text-caption text-ink-subtle">{a.file ?? (a.fileText ? <Contained text={a.fileText} /> : null)}</span>
                {a.problems.length ? <span className="mt-0.5 block text-caption text-danger-ink">{a.problems.length === 1 ? "1 problem" : `${a.problems.length} problems`}</span> : null}
              </td>
              <td className={cn(TD, "whitespace-nowrap")}>
                <StatusMark a={a} />
                {a.supersedes.length ? <span className="mt-1 block text-caption text-ink-muted">supersedes {a.supersedes.join(", ")}</span> : null}
              </td>
              <td className={TD}>{a.topics.length ? <span className="text-caption text-ink">{a.topics.join(", ")}</span> : <span className="text-caption text-ink-subtle">none</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Baseline({ v, onOpen }: { v: DecisionsView; onOpen: (id: string) => void }) {
  const b = v.baseline;
  return (
    <Section title="The required baseline" id="decisions-baseline" note="Set by adr.required_topics in .factory/config.json. Each topic is covered by an accepted decision that names topic:<topic>.">
      {b.covered ? (
        <p className="text-body-sm text-success-ink" data-baseline-covered="">Every required topic is covered.</p>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-warning-line bg-warning-soft px-4 py-3" data-baseline-missing="">
          <p className="text-label text-warning-ink">
            {b.missing.length
              ? `Missing: ${b.missing.join(", ")}.`
              : b.unusableEntries
                ? "A required topic in the setting is not a topic word, so no decision can cover it."
                : "The baseline is not covered."}
          </p>
          <p className="text-body-sm text-ink">{BASELINE_HELD}</p>
          <CommandLine command={COMMANDS.baseline.command} purpose={COMMANDS.baseline.purpose} />
        </div>
      )}
      {b.settingProblems.length ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink">
          {b.settingProblems.map((p, i) => (
            <li key={i}>
              <Contained text={p} />
            </li>
          ))}
        </ul>
      ) : null}
      {b.topics.length === 0 ? (
        <p className="text-body-sm text-ink-muted">This project requires no topics: adr.required_topics is an empty list.</p>
      ) : (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div role="region" aria-label="Required topics, scrolls sideways when narrow" tabIndex={0} className="overflow-x-auto rounded-md border border-line">
          <table className={TABLE} data-baseline-table="">
            <thead className="bg-surface-sunken">
              <tr>
                <th scope="col" className={TH}>
                  Topic
                </th>
                <th scope="col" className={TH}>
                  What it decides
                </th>
                <th scope="col" className={TH}>
                  Covered by
                </th>
              </tr>
            </thead>
            <tbody>
              {b.topics.map((t) => (
                <tr key={t.topic} data-topic={t.topic} data-covered={t.coveredBy.length ? "yes" : "no"}>
                  <td className={cn(TD, "whitespace-nowrap font-mono text-[13px] text-ink")}>{t.topic}</td>
                  <td className={cn(TD, "text-ink-muted")}>{t.description}</td>
                  <td className={cn(TD, "whitespace-nowrap")}>
                    {t.coveredBy.length ? (
                      <AdrLinks ids={t.coveredBy} onOpen={onOpen} />
                    ) : (
                      <StatusPill tone="warning" size="sm" className="rounded-none border-dashed">
                        Missing
                      </StatusPill>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Waiting({ v, onOpen }: { v: DecisionsView; onOpen: (id: string) => void }) {
  const nothing = v.stopped.length === 0 && v.proposals.length === 0 && v.proposedOnMain.length === 0;
  const held = new Set(v.stopped.filter((s) => s.needs === "adr-acceptance").map((s) => s.ticket));
  const proposals = v.proposals.filter((p) => !held.has(p.ticket));
  return (
    <Section title="Waiting on a person" id="decisions-waiting" note={<>Tickets stopped on a decision, and proposals that need accepting. Recorded words: <UncheckedNote />.</>}>
      {nothing ? (
        <p className="text-body-sm text-ink-muted">Nothing waits on a person about a decision. A ticket that stops on one appears here.</p>
      ) : (
        <ul className="flex flex-col gap-3" data-decisions-waiting="">
          {v.stopped.map((s) => (
            <li key={`${s.ticket}-${s.needs}`} className="flex flex-col gap-1.5 rounded-md border-2 border-warning-line bg-surface px-4 py-3" data-stop={s.needs} data-ticket={s.ticket}>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] text-ink-muted">{s.ticket}</span>
                <span className="text-label text-ink">{STOP_WORDS[s.needs].title}</span>
                {s.adrs.length ? <AdrLinks ids={s.adrs} onOpen={onOpen} /> : null}
              </p>
              <p className="text-body-sm text-ink">{STOP_WORDS[s.needs].sentence}</p>
              {s.title ? (
                <p className="text-body-sm text-ink-muted">
                  The decision: <Contained text={s.title} />
                </p>
              ) : null}
              {s.reason ? (
                <p className="text-body-sm text-ink">
                  Why the plan cannot follow it: <Contained text={s.reason} max={240} />
                </p>
              ) : null}
              {s.alsoMainConflict ? <p className="text-caption text-ink-muted">This ticket also records a conflict with the main branch, which MACH may ask about first.</p> : null}
              {s.needs === "adr-fix" && v.problems.length ? <p className="text-caption text-ink-muted">The problems are listed under Every decision.</p> : null}
              <CommandLine command={stopCommand(s).command} purpose={stopCommand(s).purpose} />
              {s.needs === "adr-decision" && s.adr ? <CommandLine command={COMMANDS.except(s.ticket, s.adr).command} purpose={COMMANDS.except(s.ticket, s.adr).purpose} /> : null}
            </li>
          ))}
          {proposals.map((p) => (
            <li key={`${p.ticket}-${p.adr}`} className="flex flex-col gap-1.5 rounded-md border border-dashed border-info-line bg-surface px-4 py-3" data-proposal={p.adr} data-ticket={p.ticket}>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] text-ink-muted">{p.ticket}</span>
                <span className="text-label text-ink">proposes</span>
                <AdrLink id={p.adr} onOpen={onOpen} />
                {p.title ? <Contained text={p.title} /> : null}
              </p>
              <p className="text-body-sm text-ink">
                {p.holdsBuild ? "Its build waits until an engineer accepts it." : "The ticket goes on; the proposal is reviewed with the change and lands as proposed, for an engineer to accept on the main branch."}
              </p>
              {p.holdsBuild ? <CommandLine command={COMMANDS.acceptOnTicket(p.ticket, [p.adr]).command} purpose={COMMANDS.acceptOnTicket(p.ticket, [p.adr]).purpose} /> : null}
            </li>
          ))}
          {v.proposedOnMain.length ? (
            <li className="flex flex-col gap-1.5 rounded-md border border-dashed border-info-line bg-surface px-4 py-3" data-proposed-on-main="">
              <p className="flex flex-wrap items-center gap-2">
                <span className="text-label text-ink">Proposed in the ADR folder, not yet accepted:</span>
                <AdrLinks ids={v.proposedOnMain} onOpen={onOpen} />
              </p>
              <p className="text-body-sm text-ink">A proposed decision binds nothing. An engineer reads it, accepts it, and commits it to the main branch by pull request.</p>
              <CommandLine command={COMMANDS.accept(v.proposedOnMain.join(" ")).command} purpose="to accept the proposed decisions" />
            </li>
          ) : null}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- one decision

function DecisionView({
  id,
  load,
  headingRef,
  onBack,
  onOpen,
  onRetry,
}: {
  id: string;
  load: Load<DecisionPage>;
  headingRef: { current: HTMLHeadingElement | null };
  onBack: () => void;
  onOpen: (id: string) => void;
  onRetry: () => void;
}) {
  return (
    <article className="flex flex-col gap-5" data-decision={id} aria-labelledby="decision-heading">
      <p>
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-body-sm font-semibold text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2 [&_svg]:size-4">
          <ArrowLeft aria-hidden="true" />
          Back to every decision
        </button>
        <span className="ml-2 text-caption text-ink-subtle">(Escape)</span>
      </p>
      <div>
        <p className="font-mono text-[13px] text-ink-muted">{id}</p>
        <h3 id="decision-heading" ref={headingRef} tabIndex={-1} className="font-display text-title-2 font-[650] text-ink outline-none">
          {load.state === "ready" && load.data.adr?.title ? <Contained text={load.data.adr.title} /> : load.state === "ready" && !load.data.adr ? "Proposed by a ticket" : id}
        </h3>
      </div>
      <Loading load={load} onRetry={onRetry} what={id}>
        {() => (load.state === "ready" ? <DecisionBody p={load.data} onOpen={onOpen} /> : null)}
      </Loading>
    </article>
  );
}

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-ink-subtle">{term}</dt>
          <dd className="min-w-0 text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DecisionBody({ p, onOpen }: { p: DecisionPage; onOpen: (id: string) => void }) {
  const a = p.adr;
  return (
    <>
      <Basis text={p.basis} />
      {a ? (
        <>
          <p className="flex flex-wrap items-center gap-2">
            <StatusMark a={a} />
            <span className="text-caption text-ink-muted">Titles, text and reasons on this page: <UncheckedNote /></span>
          </p>
          <Facts
            rows={[
              ["File", a.file ? <span key="f" className="break-all font-mono text-[13px]">{a.file}</span> : a.fileText ? <Contained key="f" text={a.fileText} /> : "not a plain path"],
              ["Status", stateWords(a)],
              ...(a.supersededBy ? ([["Superseded by", <AdrLink key="s" id={a.supersededBy} onOpen={onOpen} />]] as const) : []),
              ...(a.supersedes.length ? ([["Supersedes", <AdrLinks key="u" ids={a.supersedes} onOpen={onOpen} />]] as const) : []),
              ["Topics", a.topics.length ? a.topics.join(", ") : "none"],
              ["Applies to", a.appliesTo.length ? <span key="a" className="font-mono text-[13px]">{a.appliesTo.join(", ")}</span> : "nothing that can be shown"],
              ...(a.appliesToHidden ? ([["Not shown", `${a.appliesToHidden} applies-to item${a.appliesToHidden === 1 ? "" : "s"} that are not a plain code, topic or path`]] as const) : []),
              ["Binds the Factory", a.binding ? "yes, once committed on the main branch" : "no"],
              ...(a.sameNumber.length ? ([["Same number", <span key="n" className="font-mono text-[13px]">{a.sameNumber.join(", ")}</span>]] as const) : []),
            ]}
          />
          {a.problems.length ? (
            <div className="flex flex-col gap-1 rounded-md border border-danger-line bg-danger-soft px-4 py-3">
              <p className="text-label text-danger-ink">Why it binds nothing</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink">
                {a.problems.map((x, i) => (
                  <li key={i}>
                    <Contained text={x} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="max-w-reading text-body-sm text-ink">The ADR folder has no file with this ID. A ticket proposes it on its own branch; it reaches the main branch with that ticket's change.</p>
      )}

      <Section title="Where it is changed" id="decision-changed">
        <p className="max-w-reading text-body-sm text-ink">{WHERE_CHANGED}</p>
        {a?.status === "proposed" ? <CommandLine command={COMMANDS.accept(p.id).command} purpose={COMMANDS.accept(p.id).purpose} /> : null}
        {a?.status === "accepted" ? (
          <p className="max-w-reading text-body-sm text-ink-muted">To replace it, an engineer writes a new decision whose status supersedes this one, and changes this file's status to superseded, in one pull request.</p>
        ) : null}
        {a?.status === "accepted" ? <CommandLine command={COMMANDS.new.command} purpose={COMMANDS.new.purpose} /> : null}
      </Section>

      {p.text ? (
        <Section title="The decision as written" id="decision-text" note={`Plain text, as the file holds it${p.textCut ? `, cut at ${p.textLimit} characters: read the rest in its file` : ""}.`}>
          {/* A region that scrolls: focusable, named by the ID only (never by its words). */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <pre role="region" className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-sunken p-4 font-mono text-[13px] leading-relaxed text-ink" data-decision-text="" tabIndex={0} aria-label={`The text of ${p.id}`}>
            <UncheckedText text={p.text} labelled expandable={false} />
          </pre>
        </Section>
      ) : a?.unread ? (
        <p className="text-body-sm text-danger-ink">The file cannot be read, so its text is not shown.</p>
      ) : null}

      <Section title="Tickets planned under it" id="decision-tickets" note="Live tickets only: tickets already cleaned up and archived are not read here.">
        {p.plannedUnder.length === 0 ? (
          <p className="text-body-sm text-ink-muted">No live ticket was planned under it.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-body-sm" data-planned-under="">
            {p.plannedUnder.map((t) => (
              <li key={t.ticket} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-[13px] text-ink">{t.ticket}</span>
                <span className="text-ink-muted">{t.stage ? `at ${t.stage}` : "stage not recorded"}</span>
                <span className="text-ink-muted">planned {t.plannedAt ? <Moment at={t.plannedAt} inline /> : "at a time not recorded"}</span>
                <Badge tone={t.sameText === false ? "warning" : "neutral"} outline>
                  {sameTextWords(t.sameText)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Exceptions recorded against it" id="decision-exceptions" note="A person's exception lets one ticket depart from this decision. People are shown by their role.">
        {p.exceptions.length === 0 ? (
          <p className="text-body-sm text-ink-muted">No live ticket has an exception to it.</p>
        ) : (
          <ul className="flex flex-col gap-2" data-exceptions="">
            {p.exceptions.map((e) => (
              <li key={e.ticket} className="flex flex-col gap-1 rounded-md border border-line px-4 py-3 text-body-sm">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-[13px] text-ink">{e.ticket}</span>
                  <span className="text-ink-muted">
                    decided by {e.by}
                    {e.at ? (
                      <>
                        {" "}
                        <Moment at={e.at} inline />
                      </>
                    ) : null}
                    ; recorded by {e.recordedBy}
                  </span>
                </p>
                <p className="text-ink">
                  Why: {e.reason ? <Contained text={e.reason} max={400} /> : <span className="italic text-ink-subtle">no reason recorded</span>}
                </p>
                {e.sameText === false ? <p className="text-caption text-warning-ink">Recorded against an earlier text of this decision.</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {p.conflicts.length ? (
        <Section title="Plans that cannot follow it" id="decision-conflicts">
          <ul className="flex flex-col gap-2">
            {p.conflicts.map((c) => (
              <li key={c.ticket} className="flex flex-col gap-1 rounded-md border-2 border-warning-line px-4 py-3 text-body-sm">
                <p>
                  <span className="font-mono text-[13px] text-ink">{c.ticket}</span>
                  <span className="ml-2 text-ink-muted">stopped for an engineer</span>
                </p>
                {c.reason ? (
                  <p className="text-ink">
                    Why: <Contained text={c.reason} max={400} />
                  </p>
                ) : null}
                <CommandLine command={COMMANDS.decide(c.ticket).command} purpose={COMMANDS.decide(c.ticket).purpose} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {p.proposedBy.length ? (
        <Section title="Proposed by a ticket" id="decision-proposed">
          <ul className="flex flex-col gap-2">
            {p.proposedBy.map((x) => (
              <li key={x.ticket} className="flex flex-col gap-1 rounded-md border border-dashed border-info-line px-4 py-3 text-body-sm">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-[13px] text-ink">{x.ticket}</span>
                  {x.title ? <Contained text={x.title} /> : null}
                </p>
                {x.file ? <p className="break-all font-mono text-caption text-ink-subtle">{x.file}, on the ticket's branch</p> : null}
                <p className="text-ink">{x.accepted ? "Accepted on the ticket's branch." : x.holdsBuild ? "Not accepted yet: the ticket's build waits for it." : "Not accepted yet: it is reviewed with the change."}</p>
                {!x.accepted && x.holdsBuild ? <CommandLine command={COMMANDS.acceptOnTicket(x.ticket, [p.id]).command} purpose={COMMANDS.acceptOnTicket(x.ticket, [p.id]).purpose} /> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {p.acceptances.length ? (
        <p className="text-body-sm text-ink-muted">
          Accepted by a person on {p.acceptances.map((x) => x.ticket).join(", ")}'s branch.
        </p>
      ) : null}
      <p className="flex items-center gap-1.5 text-caption text-ink-subtle [&_svg]:size-3.5">
        <FileText aria-hidden="true" />
        The page reads the files again when you press Read again.
      </p>
    </>
  );
}
