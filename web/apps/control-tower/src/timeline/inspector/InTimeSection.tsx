/**
 * "In time" (M6.3 design section 3C): the selected entity's span, as of the playhead, in the
 * existing inspector of both workspaces. Began and ended with the events that bound them, the
 * duration in the words of design section 5 with how it is known, attempt and round, the outcome
 * once it is established, parent and children, the previous and next span in the same place (order
 * in time only), and evidence references. Only what the general event API already serves: no tool
 * input, no file contents, no model reasoning.
 */
import { useEffect, useMemo, useState } from "react";
import { findArtifact, type ArtifactState, type EntityRef } from "../../sim";
import { showInTimeline, showOnFloor, useScene, useSceneStore, useStore } from "../../scene";
import { ArtifactLink } from "../../shell/inspector/anatomies";
import { Elapsed, Facts, JumpButton, RefLink, RefList, Section, precisionWords, useEntityEvents, type Fact } from "../../shell/inspector/parts";
import { RULE_WORDS } from "../../shell/inspector/Provenance";
import { selectable } from "../../shell/vocab";
import type { TimelineData, TimelineSpan } from "../contract";
import { useTimelineData } from "../data";
import {
  attemptAndRound,
  beganFact,
  childrenOf,
  companionsOf,
  dependencyWords,
  durationSentence,
  endedFact,
  evidenceRefsOf,
  exactSpanIds,
  hasTimeSection,
  neighboursOf,
  ORDER_NOTE,
  outcomeAsOf,
  outcomeLabel,
  parentSpanOf,
  primarySpan,
  queryHintOf,
  queryOf,
  refKindOf,
  SPAN_KIND_WORDS,
  toolCallsWords,
  type EndFact,
} from "./model";

/** Re-asking the provider at most this often while new events arrive. */
const REQUERY_MS = 1000;

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly why: string }
  | { readonly status: "ready"; readonly spans: readonly TimelineSpan[]; readonly truncated: boolean };

/** Every span the section needs: the ref's own (by id where one is one-to-one) and its surroundings, over the whole history held. */
async function load(data: TimelineData, ref: string, hint: string, signal: AbortSignal): Promise<Loaded> {
  const window = data.extent();
  if (!window) return { status: "unavailable", why: "No history is held yet." };
  const [page, exact] = await Promise.all([data.spans(queryOf(hint, window), signal), Promise.all(exactSpanIds(ref).map((id) => data.span(id, signal)))]);
  const byId = new Map<string, TimelineSpan>();
  for (const s of page.spans) byId.set(s.id, s);
  for (const s of exact) if (s) byId.set(s.id, s);
  return { status: "ready", spans: [...byId.values()], truncated: page.truncated };
}

/** The spans about `ref`, re-read (throttled) whenever the provider says something may have changed. */
function useSpansFor(ref: string, hint: string): Loaded {
  const data = useTimelineData();
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded } | null>(null);
  const key = `${ref}\u0000${hint}`;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = data.subscribe(() => {
      if (timer === null) timer = setTimeout(() => ((timer = null), setVersion((v) => v + 1)), REQUERY_MS);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [data]);
  useEffect(() => {
    const abort = new AbortController();
    load(data, ref, hint, abort.signal).then(
      (value) => !abort.signal.aborted && setLoaded({ key, value }),
      () => !abort.signal.aborted && setLoaded({ key, value: { status: "unavailable", why: "The timing of this could not be read from the source just now." } }),
    );
    return () => abort.abort();
  }, [data, ref, hint, key, version]);
  // A previous answer for the same ref stands while a newer one is read (no flicker to "loading").
  return loaded && loaded.key === key ? loaded.value : { status: "loading" };
}

/** The section, for any entity with spans; nothing for the rest. */
export function InTimeSection({ entity }: { entity: EntityRef }) {
  if (!hasTimeSection(entity)) return null;
  return <InTime entity={entity} />;
}

function InTime({ entity }: { entity: EntityRef }) {
  const hint = useScene((s) => queryHintOf(s, entity));
  const loaded = useSpansFor(entity, hint);
  // As of the playhead: the time of the last event applied there, so this re-renders per event, not per frame.
  const asOf = useScene((s) => s.at);
  const workspace = useSceneStore((s) => s.workspace);
  const store = useStore();
  const target = selectable(entity);
  const aside = target ? (
    <button
      type="button"
      onClick={() => (workspace === "floor" ? showInTimeline(store, target) : showOnFloor(store))}
      className="text-caption font-semibold text-accent-ink underline decoration-1 underline-offset-[3px] hover:decoration-2"
    >
      {workspace === "floor" ? "Show in Timeline" : "Show on the floor"}
    </button>
  ) : undefined;
  return (
    <Section title="In time" id={`time-${entity}`} aside={aside}>
      {loaded.status === "loading" ? (
        <p className="text-body-sm text-ink-muted">Reading its timing…</p>
      ) : loaded.status === "unavailable" ? (
        <p className="text-body-sm text-ink-muted">Timing is not available: {loaded.why}</p>
      ) : (
        <Spans entity={entity} spans={loaded.spans} truncated={loaded.truncated} asOf={asOf} />
      )}
    </Section>
  );
}

function linkable(ref: string): EntityRef | null {
  return /^[a-z]+:./.test(ref) ? selectable(ref as EntityRef) : null;
}

function EndFactValue({ fact }: { fact: EndFact }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className={fact.state === "at" || fact.state === "bounded" ? "font-mono text-[12px] tabular text-ink" : fact.state === "open" ? "text-ink" : "italic text-ink-subtle"}>{fact.text}</span>
      {fact.inferred ? <span className="text-caption text-ink-subtle">{fact.inferred}</span> : null}
      {fact.eventId && fact.state !== "open" && fact.state !== "not-started" ? (
        <span>
          <JumpButton eventId={fact.eventId} label="Go to event" />
        </span>
      ) : null}
    </span>
  );
}

function Spans({ entity, spans, truncated, asOf }: { entity: EntityRef; spans: readonly TimelineSpan[]; truncated: boolean; asOf: number }) {
  const primary = useMemo(() => primarySpan(entity, spans, asOf), [entity, spans, asOf]);
  const dependency = refKindOf(entity) === "dependency" ? dependencyWords(entity, primary) : null;
  if (!primary) {
    return (
      <>
        {dependency ? <p className="mb-2 text-body-sm text-ink">{dependency}</p> : null}
        <p className="text-body-sm italic text-ink-subtle">Not recorded: no span of its time is held{truncated ? " (the source returned only part of this history)" : ""}.</p>
      </>
    );
  }
  return <PrimarySpan entity={entity} primary={primary} spans={spans} truncated={truncated} asOf={asOf} dependency={dependency} />;
}

function PrimarySpan({ entity, primary, spans, truncated, asOf, dependency }: { entity: EntityRef; primary: TimelineSpan; spans: readonly TimelineSpan[]; truncated: boolean; asOf: number; dependency: string | null }) {
  const began = beganFact(primary, asOf, RULE_WORDS);
  const ended = endedFact(primary, asOf, RULE_WORDS);
  const length = durationSentence(primary, asOf, RULE_WORDS);
  const { attempt, round, note } = attemptAndRound(primary);
  const outcome = outcomeAsOf(primary, asOf);
  const calls = toolCallsWords(primary);
  const parent = parentSpanOf(primary, spans, asOf);
  const children = childrenOf(primary, spans, asOf);
  const { before, after } = neighboursOf(primary, spans, asOf);
  const companions = companionsOf(entity, primary, spans, asOf);
  const facts: Fact[] = [
    ["What", SPAN_KIND_WORDS[primary.kind]],
    ["Began", <EndFactValue key="b" fact={began} />],
    primary.start && began.state !== "not-started" && primary.start.precision ? ["Start time", precisionWords(primary.start.precision)] : null,
    ["Ended", <EndFactValue key="e" fact={ended} />],
    primary.end && ended.state !== "open" && ended.state !== "not-started" ? ["End time", precisionWords(primary.end.precision)] : null,
    [
      "Duration",
      length.live ? (
        <span key="d">
          <Elapsed startedAt={length.live.startedAt} finishedAt={null} mode={length.live.mode} />
          <span className="text-ink-subtle">, still open</span>
        </span>
      ) : (
        length.text
      ),
    ],
    attempt !== null ? ["Attempt", attempt] : null,
    round !== null ? ["Round", round] : null,
    outcome !== null ? [outcomeLabel(primary), outcome] : null,
    calls ? ["Tool calls", calls] : null,
  ];
  return (
    <>
      {dependency ? <p className="mb-2 text-body-sm text-ink">{dependency}</p> : null}
      <Facts facts={facts} />
      {note ? <p className="mt-2 text-caption text-ink-subtle">{note}</p> : null}
      {companions.length ? (
        <div className="mt-3">
          <p className="text-caption font-semibold text-ink">Also on its record</p>
          <ul className="mt-0.5 flex flex-col gap-0.5 text-body-sm text-ink-muted">
            {companions.slice(-4).map((c) => (
              <li key={c.id}>
                {SPAN_KIND_WORDS[c.kind]}: {durationSentence(c, asOf, RULE_WORDS).text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {primary.parent || children.shown.length ? (
        <div className="mt-3">
          <p className="text-caption font-semibold text-ink">Parent and children</p>
          <RefList>
            {primary.parent ? <SpanLink to={primary.parent} span={parent} asOf={asOf} prefix="Within" /> : null}
            {children.shown.map((c) => (
              <SpanLink key={c.id} to={c.entity} span={c} asOf={asOf} />
            ))}
          </RefList>
          {children.rest ? <p className="mt-1 text-caption text-ink-subtle">{children.rest} earlier not listed.</p> : null}
        </div>
      ) : null}
      {before || after ? (
        <div className="mt-3">
          <p className="text-caption font-semibold text-ink">Before and after</p>
          <RefList>
            {before ? <SpanLink to={before.span.entity} span={before.span} asOf={asOf} prefix="Previous" detail={before.words} /> : null}
            {after ? <SpanLink to={after.span.entity} span={after.span} asOf={asOf} prefix="Next" detail={after.words} /> : null}
          </RefList>
          <p className="mt-1 text-caption text-ink-subtle">{ORDER_NOTE}</p>
        </div>
      ) : null}
      <EvidenceRefs entity={entity} />
      {truncated ? <p className="mt-3 text-caption text-ink-subtle">The source returned only part of this history: neighbours and children may be missing.</p> : null}
    </>
  );
}

/** A related span: a link to its entity, with its kind and its duration in words (or a gap for a neighbour). */
function SpanLink({ to, span, asOf, prefix, detail }: { to: string; span: TimelineSpan | null; asOf: number; prefix?: string; detail?: string }) {
  const target = linkable(to);
  const what = span ? SPAN_KIND_WORDS[span.kind] : "Not held here";
  const words = detail ?? (span ? durationSentence(span, asOf, RULE_WORDS).text : "its timing is not held here");
  const body = (
    <>
      {prefix ? <span className="text-ink-subtle">{prefix}: </span> : null}
      {what} <span className="font-mono text-[12px] text-ink-muted">{to}</span>
    </>
  );
  return (
    <div className="flex flex-col">
      {target ? <RefLink to={target}>{body}</RefLink> : <span className="px-1.5 py-1 text-body-sm">{body}</span>}
      <span className="px-1.5 pb-1 text-caption text-ink-subtle">{words}</span>
    </div>
  );
}

/** Evidence references the anatomy already knows (`evidenceRefsOf`), with the events that produced or verified each. */
function EvidenceRefs({ entity }: { entity: EntityRef }) {
  const scene = useScene();
  const cellRef = useMemo<EntityRef | null>(() => {
    const id = entity.slice(entity.indexOf(":") + 1);
    const kind = refKindOf(entity);
    if (kind === "cell") return entity;
    if (kind === "station" || kind === "visit") return `cell:${id.split("/")[0]}`;
    return null;
  }, [entity]);
  const { all, happened } = useEntityEvents(cellRef ?? entity);
  const refs = useMemo(() => evidenceRefsOf(scene, entity, all.slice(0, happened)).slice(0, 6), [scene, entity, all, happened]);
  const artifacts = useMemo(() => {
    const byId = new Map<string, ArtifactState>();
    for (const r of refs) {
      const a = findArtifact(scene, r.artifactId);
      if (a) byId.set(r.artifactId, a);
    }
    return byId;
  }, [scene, refs]);
  if (!refs.length) return null;
  return (
    <div className="mt-3">
      <p className="text-caption font-semibold text-ink">Evidence references</p>
      <RefList>
        {refs.map((r) => {
          const a = artifacts.get(r.artifactId);
          return (
            <div key={r.artifactId} className="flex flex-col">
              {a ? <ArtifactLink artifact={a} /> : null}
              <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1.5 pb-1 text-caption text-ink-subtle">
                {r.producedBy ? <JumpButton eventId={r.producedBy} label="Go to the record of the write" /> : <span>The record of the write is not named</span>}
                {r.verifiedBy.length ? r.verifiedBy.slice(0, 2).map((id, i) => <JumpButton key={id} eventId={id} label={i === 0 ? "Go to the check that cites it" : "Go to the next check"} />) : null}
              </span>
            </div>
          );
        })}
      </RefList>
    </div>
  );
}
