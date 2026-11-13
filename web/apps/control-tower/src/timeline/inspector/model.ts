/**
 * The "In time" section's facts, as pure functions over spans and the scene (design sections 3C and
 * 5), so every sentence is tested in plain node (test/timeline-inspector.test.mjs) rather than left
 * inside JSX. No React, no design system.
 *
 * Everything here is read "as of" a moment (`asOf`): the inspector shows the playhead's truth, so a
 * span that ends after it is still open, a span that starts after it has not begun, and an outcome
 * established after it is not shown (`outcomeKnownAt`). Order in time is never said as causation.
 */
import { findAgent, findToolCall, type ArtifactState, type EntityRef, type Scene } from "../../sim";
import { duration, timecode } from "../../shell/time";
import { elapsedWords } from "../../shell/inspector/words";
import { outcomeKnownAt, type SpanKind, type SpanQuery, type TimeWindow, type TimelineSpan } from "../contract";
import { stoppedState, stoppedWords, type StoppedState } from "../render/words";

/** A stopped execution's state in the headline's words. */
const STOPPED_HEADLINE: Readonly<Record<StoppedState, string>> = { interrupted: "interrupted", "timed-out": "timed out", "could-not-start": "could not start", unknown: "outcome not known" };

// ---------------------------------------------------------------- which spans a ref has

/** The entity kinds the section is shown for, and for each the span kinds that stand for it, most telling first. */
const PRIMARY_KINDS: Readonly<Record<string, readonly SpanKind[]>> = {
  wave: ["wave"],
  slice: ["slice-eligible", "slice-wait"],
  cell: ["cell"],
  execution: ["execution", "claim"],
  workflow: ["workflow"],
  agent: ["agent", "agent-queue"],
  tool: ["tool"],
  visit: ["visit"],
  station: ["visit"],
  seat: ["seat"],
  gate: ["person-wait", "gate-wait", "round"],
  dependency: ["slice-wait"],
};

/** The ref's kind (the text before the first colon). */
export const refKindOf = (ref: string): string => ref.slice(0, ref.indexOf(":"));
const refIdOf = (ref: string): string => ref.slice(ref.indexOf(":") + 1);

/** Whether the section applies to this ref at all. */
export function hasTimeSection(ref: string): boolean {
  return refKindOf(ref) in PRIMARY_KINDS;
}

/** A station on its own (`station:build`), not one cell's: its section lists its visits across cells. */
export const isStationAcrossCells = (ref: string): boolean => refKindOf(ref) === "station" && !refIdOf(ref).includes("/");

/**
 * A station's visits across every cell, begun by `asOf`, in time order: the latest `limit` and how
 * many earlier ones are not listed.
 */
export function stationVisitsAcross(ref: string, spans: readonly TimelineSpan[], asOf: number, limit = 12): { shown: TimelineSpan[]; rest: number } {
  const station = refIdOf(ref);
  const all = spans.filter((s) => s.kind === "visit" && s.ids["station"] === station && begunBy(s, asOf)).sort(byStart);
  return { shown: all.slice(Math.max(0, all.length - limit)), rest: Math.max(0, all.length - limit) };
}

/** Span ids that stand for exactly this ref (`<kind>:<entity>`), for `data.span(id)`. Empty when none is one-to-one. */
export function exactSpanIds(ref: string): string[] {
  switch (refKindOf(ref)) {
    case "wave":
    case "cell":
    case "execution":
    case "workflow":
    case "agent":
    case "tool":
    case "visit":
    case "seat":
      return [`${refKindOf(ref)}:${ref}`];
    default:
      return [];
  }
}

/**
 * How to narrow the spans query for a ref, as a string (so a React selector stays stable):
 * `ticket:<id>`, `execution:<id>`, `wave:<id>`, or "" (the whole window). Agent and tool ids are
 * opaque: their execution and ticket are read from the scene, never from the id.
 */
export function queryHintOf(scene: Scene | null, ref: string): string {
  const id = refIdOf(ref);
  const before = (s: string) => s.split("/")[0] ?? "";
  switch (refKindOf(ref)) {
    case "cell":
      return `ticket:${id}`;
    case "station":
      // On its own: every cell's visits to it.
      return id.includes("/") ? `ticket:${before(id)}` : "kinds:visit";
    case "visit":
    case "seat":
    case "gate":
      return id.includes("/") ? `ticket:${before(id)}` : "";
    case "wave":
      return `wave:${id}`;
    case "execution":
      return `execution:${id}`;
    case "workflow":
      return id.includes("/") ? `execution:${before(id)}` : "";
    case "agent": {
      const a = scene ? findAgent(scene, id) : null;
      return a ? (a.executionId ? `execution:${a.executionId}` : a.ticketId ? `ticket:${a.ticketId}` : "") : "";
    }
    case "tool": {
      const c = scene ? findToolCall(scene, id) : null;
      return c?.ticketId ? `ticket:${c.ticketId}` : "";
    }
    case "slice": {
      const t = scene?.slices[id]?.ticketId;
      return t ? `ticket:${t}` : "";
    }
    case "dependency": {
      const t = scene?.slices[id.split("->")[0] ?? ""]?.ticketId;
      return t ? `ticket:${t}` : "";
    }
    default:
      return "";
  }
}

/** The spans query for a hint over a window. */
export function queryOf(hint: string, window: TimeWindow): SpanQuery {
  const at = hint.indexOf(":");
  if (at < 0) return { window };
  const [key, value] = [hint.slice(0, at), hint.slice(at + 1)];
  if (key === "kinds") return { window, kinds: value.split(",").filter((k): k is SpanKind => k in SPAN_KIND_WORDS) };
  return key === "ticket" ? { window, ticket: value } : key === "execution" ? { window, execution: value } : key === "wave" ? { window, wave: value } : { window };
}

/** The dependency ref's two ends: `dependency:A->B` (A waits for B). */
export function dependencyEnds(ref: string): { from: string; to: string } | null {
  if (refKindOf(ref) !== "dependency") return null;
  const [from, to] = refIdOf(ref).split("->");
  return from && to ? { from, to } : null;
}

/** Every span about the ref: its own (entity), and for a station visit or a dependency, the spans that stand for them. */
export function spansAbout(ref: string, spans: readonly TimelineSpan[]): TimelineSpan[] {
  const kind = refKindOf(ref);
  if (kind === "station" && isStationAcrossCells(ref)) return spans.filter((s) => s.kind === "visit" && s.ids["station"] === refIdOf(ref));
  if (kind === "station") {
    const [ticket, station] = refIdOf(ref).split("/");
    return spans.filter((s) => s.kind === "visit" && s.ids["station"] === station && (s.ids["ticket_id"] === ticket || s.entity.startsWith(`visit:${ticket}/`)));
  }
  if (kind === "dependency") {
    const ends = dependencyEnds(ref);
    if (!ends) return [];
    const waits = spans.filter((s) => s.kind === "slice-wait" && s.entity === `slice:${ends.from}`);
    // A wait recorded as on another dependency is not this one's; a wait with no recorded cause may be.
    return waits.filter((s) => !s.attrs.dependsOn || s.attrs.dependsOn.some((d) => sameSlice(d, ends.to)));
  }
  return spans.filter((s) => s.entity === ref);
}

const sameSlice = (a: string, b: string) => a === b || a === `slice:${b}` || `slice:${a}` === b;

// ---------------------------------------------------------------- time as of a moment

/** The earliest moment a span is known to have begun (its start, its bound, or its end when only that is recorded). */
export function beganAt(span: TimelineSpan): number | null {
  const s = span.start;
  if (s) return s.at ?? s.notBefore ?? s.notAfter;
  const e = span.end;
  return e ? (e.at ?? e.notBefore ?? e.notAfter) : null;
}

/** Whether a span has begun by `asOf`. */
export function begunBy(span: TimelineSpan, asOf: number): boolean {
  const t = beganAt(span);
  return t !== null && t <= asOf;
}

/** The moment a span's end is placed at, or null when its end has no time. */
function endTime(span: TimelineSpan): number | null {
  const e = span.end;
  return e ? (e.at ?? e.notAfter ?? e.notBefore) : null;
}

/** Whether a span has ended by `asOf`. An end with no time at all is ended (it is recorded) but not placed. */
export function endedBy(span: TimelineSpan, asOf: number): boolean {
  if (!span.end) return false;
  const t = endTime(span);
  return t === null || t <= asOf;
}

const WAIT_KINDS: ReadonlySet<SpanKind> = new Set(["slice-wait", "slice-eligible", "capacity-wait", "gate-wait", "person-wait", "agent-queue"]);
export const isWait = (span: TimelineSpan): boolean => WAIT_KINDS.has(span.kind);

const isInterrupted = (span: TimelineSpan) => span.attrs.interruptedAt !== undefined || span.end?.reason === "interrupted" || span.end?.reason === "superseded";

function sortKey(span: TimelineSpan): number {
  return beganAt(span) ?? Number.POSITIVE_INFINITY;
}
const byStart = (a: TimelineSpan, b: TimelineSpan) => sortKey(a) - sortKey(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The span the section is about: of the ref's spans, the most telling kind (an agent's run before
 * its queue), the latest begun by `asOf`; if none has begun, the first to begin (shown as "not
 * started at the playhead").
 */
export function primarySpan(ref: string, spans: readonly TimelineSpan[], asOf: number): TimelineSpan | null {
  const order = PRIMARY_KINDS[refKindOf(ref)] ?? [];
  const about = spansAbout(ref, spans).filter((s) => order.includes(s.kind));
  if (!about.length) return null;
  const rank = (s: TimelineSpan) => order.indexOf(s.kind);
  const begun = about.filter((s) => begunBy(s, asOf));
  if (begun.length) return [...begun].sort((a, b) => rank(a) - rank(b) || byStart(b, a))[0] ?? null;
  return [...about].sort((a, b) => byStart(a, b) || rank(a) - rank(b))[0] ?? null;
}

/**
 * The span "In time" is about (X3): when the Timeline picked a span through an ancestor
 * (`selectionDetail`), that span, if it is held; else the ref's own primary span.
 */
export function subjectSpan(ref: string, detail: string | null, spans: readonly TimelineSpan[], asOf: number): { span: TimelineSpan | null; picked: boolean } {
  if (detail && detail !== ref) {
    const own = spans.filter((s) => s.entity === detail).sort(byStart);
    const pick = own.find((s) => s.kind !== "agent-queue") ?? own[0];
    if (pick) return { span: pick, picked: true };
  }
  return { span: primarySpan(ref, spans, asOf), picked: false };
}

const cap = (w: string) => (w ? `${w[0]!.toUpperCase()}${w.slice(1)}` : w);

/** A span's name in a few words: "Verify, round 1", "Security seat, round 2", "Execution". */
export function spanName(span: TimelineSpan): string {
  const round = span.ids["round"] ?? (span.attrs.round !== undefined ? String(span.attrs.round) : null);
  const r = round ? `, round ${round}` : "";
  if (span.kind === "visit") return `${cap((span.ids["station"] ?? "station visit").replace(/-/g, " "))}${r}`;
  if (span.kind === "seat") {
    const seat = span.ids["seat"] ?? /\/([^/]+)$/.exec(span.entity)?.[1] ?? "review";
    return `${cap(seat)} seat${r}`;
  }
  return `${SPAN_KIND_WORDS[span.kind]}${r}`;
}

/**
 * One line naming a span, its state and its time as of `asOf` (X3): "Verify, round 1 — failed,
 * 21:42–27:20". Never an outcome before its event; an open span says "open" (or "at work" when it is
 * a kind that works), a visit closed by rule says so.
 */
export function spanHeadline(span: TimelineSpan, asOf: number, clock: (t: number) => string = (t) => timecode(t, false)): string {
  const from = beganAt(span);
  if (!begunBy(span, asOf)) return `${spanName(span)} — not started at the playhead`;
  const stopped = stoppedState(span);
  if (stopped !== null && (span.end === null || endedBy(span, asOf))) {
    const to = span.end ? endTime(span) : null;
    const times = from !== null && to !== null ? `${clock(from)}–${span.end?.at === null ? "at most " : ""}${clock(to)}` : from !== null ? `from ${clock(from)}` : "";
    return `${spanName(span)} — ${STOPPED_HEADLINE[stopped]}${times ? `, ${times}` : ""}`;
  }
  if (!endedBy(span, asOf)) {
    const state = isWait(span) ? "waiting" : atWorkWhileOpen(span) ? "at work" : "open";
    return `${spanName(span)} — ${state}${from !== null ? `, from ${clock(from)}` : ""}`;
  }
  const to = endTime(span);
  const outcome = outcomeAsOf(span, asOf);
  const state = endedWithoutExit(span)
    ? "ended without an exit record"
    : outcome
      ? outcome.toLowerCase()
      : span.end?.reason === "failed" || span.end?.reason === "refused"
        ? span.end.reason
        : span.end?.reason === "interrupted" || span.end?.reason === "superseded"
          ? span.end.reason
          : "ended";
  const times = from !== null && to !== null ? `${clock(from)}–${endedWithoutExit(span) ? "at most " : ""}${clock(to)}` : from !== null ? `from ${clock(from)}` : to !== null ? `until ${clock(to)}` : "";
  return `${spanName(span)} — ${state}${times ? `, ${times}` : ""}`;
}

/** Other spans about the same entity, begun by `asOf` (a cell's capacity waits, an agent's queue), in time order. */
export function companionsOf(ref: string, primary: TimelineSpan, spans: readonly TimelineSpan[], asOf: number): TimelineSpan[] {
  if (refKindOf(ref) === "station" || refKindOf(ref) === "dependency") return [];
  return spansAbout(ref, spans)
    .filter((s) => s.id !== primary.id && begunBy(s, asOf))
    .sort(byStart);
}

// ---------------------------------------------------------------- the words for one span

export const SPAN_KIND_WORDS: Readonly<Record<SpanKind, string>> = {
  wave: "Wave",
  "slice-wait": "Waiting on a dependency",
  "slice-eligible": "Eligible, waiting to be scheduled",
  "capacity-wait": "Waiting for execution capacity",
  cell: "Cell",
  round: "Judging round",
  visit: "Station visit",
  task: "Build task",
  seat: "Review seat",
  "gate-wait": "Gate",
  "person-wait": "Waiting for a person",
  claim: "Claim",
  execution: "Execution",
  workflow: "Workflow",
  "agent-queue": "Queued in its workflow",
  agent: "Agent",
  tool: "Tool call",
};

/**
 * Rules spans are placed by, in words, for those the inspector's shared `RULE_WORDS`
 * (src/shell/inspector/Provenance.tsx) does not hold yet. Merged at the call site, the shared words
 * first: `{ ...TIMELINE_RULE_WORDS, ...RULE_WORDS }`, so one rule is said one way everywhere. The two
 * visit rules repeat the shared wording; the lead may move `previous-completion` into RULE_WORDS.
 */
export const TIMELINE_RULE_WORDS: Readonly<Record<string, string>> = {
  "previous-completion": "it began when the previous task completed",
  "execution-ended": "bounded by its execution's end: it never recorded an exit",
  "unclosed-visit": "bounded by the next entry: it never recorded an exit",
};

/** A rule in words: the given words (the call site's merge), then the span rules, then the rule's name made readable. */
export function ruleWords(rule: string | null, rules: Readonly<Record<string, string>> = {}): string {
  if (!rule) return "a rule the record does not name";
  return rules[rule] ?? TIMELINE_RULE_WORDS[rule] ?? rule.replace(/[-_]+/g, " ");
}

/** The rules by which a visit with no exit record is closed (the observer's and the scene's D4). */
const NO_EXIT_RULES: ReadonlySet<string> = new Set(["execution-ended", "unclosed-visit"]);

/** A visit that never recorded an exit and was closed by rule: it ended without an exit record; it has no outcome. */
export function endedWithoutExit(span: TimelineSpan): boolean {
  return span.kind === "visit" && span.end !== null && span.end.basis === "inferred" && span.end.rule !== null && NO_EXIT_RULES.has(span.end.rule);
}

const span1 = (ms: number) => (ms < 1000 ? "under a second" : duration(ms));

/** What the live duration line needs: when it began and which words the Elapsed component uses. */
export interface LiveDuration {
  readonly startedAt: number;
  /** "open": a container (wave, slice, cell, round, claim) still open: never "at work". */
  readonly mode: "work" | "wait" | "interrupted" | "open";
}

/** The kinds that are ever "at work" while open: an execution, workflow, agent, tool, task, or a station visit other than human approval. */
const WORK_KINDS: ReadonlySet<SpanKind> = new Set(["execution", "workflow", "agent", "tool", "task"]);
export function atWorkWhileOpen(span: TimelineSpan): boolean {
  if (span.kind === "visit") return (span.ids["station"] ?? "") !== "human-approval";
  return WORK_KINDS.has(span.kind);
}

/** Whether `s` lies beneath the container `c` (a wave, slice, cell or round): by its recorded ids, else by its parent chain. */
function beneath(c: TimelineSpan, s: TimelineSpan, byEntity: ReadonlyMap<string, TimelineSpan>): boolean {
  if (s.id === c.id) return false;
  const id = refIdOf(c.entity);
  switch (c.kind) {
    case "wave":
      if (s.ids["wave_id"] === id) return true;
      break;
    case "slice-wait":
    case "slice-eligible":
      if (s.ids["slice_id"] === id && s.kind !== "slice-wait" && s.kind !== "slice-eligible") return true;
      break;
    case "cell":
      if (s.ids["ticket_id"] === id || s.entity.startsWith(`visit:${id}/`) || s.entity.startsWith(`seat:${id}/`) || s.entity.startsWith(`gate:${id}/`)) return true;
      break;
    case "round": {
      const t = c.ids["ticket_id"];
      const r = c.ids["round"] ?? (c.attrs.round !== undefined ? String(c.attrs.round) : undefined);
      if (t && r !== undefined && s.ids["ticket_id"] === t && String(s.ids["round"] ?? s.attrs.round ?? "") === r) return true;
      break;
    }
    default:
      break;
  }
  let p = s.parent;
  for (let guard = 0; p && guard < 8; guard++) {
    if (p === c.entity) return true;
    p = byEntity.get(p)?.parent ?? null;
  }
  return false;
}

/** What an open container says beside how long it has been open (X2): the last thing that happened beneath it, and a wait on a person still open there. */
export interface OpenContext {
  /** The latest instant recorded beneath it by `asOf` (an end, or the start of something still open), or null. */
  readonly lastActivity: number | null;
  /** The start of the earliest wait on a person still open beneath it (or the container itself) at `asOf`, or null. */
  readonly waitingSince: number | null;
}

export function openContextOf(c: TimelineSpan, spans: readonly TimelineSpan[], asOf: number): OpenContext {
  const byEntity = new Map<string, TimelineSpan>();
  for (const s of spans) if (!byEntity.has(s.entity)) byEntity.set(s.entity, s);
  let last: number | null = null;
  let waiting: number | null = null;
  for (const s of spans) {
    if (!beneath(c, s, byEntity) || !begunBy(s, asOf)) continue;
    const t = endedBy(s, asOf) ? endTime(s) : beganAt(s);
    if (t !== null && t <= asOf && (last === null || t > last)) last = t;
    if ((s.kind === "person-wait" || s.kind === "gate-wait") && !endedBy(s, asOf)) {
      const b = beganAt(s);
      if (b !== null && (waiting === null || b < waiting)) waiting = b;
    }
  }
  return { lastActivity: last, waitingSince: waiting };
}

/**
 * The words after "open for <d>" for an open container: "; last activity 06:42; waiting for a person
 * since 06:40". Empty when neither is known. Shared wording (the table and the tooltips say the same).
 */
export function openContextWords(ctx: OpenContext, clock: (t: number) => string): string {
  const parts: string[] = [];
  if (ctx.lastActivity !== null) parts.push(`last activity ${clock(ctx.lastActivity)}`);
  if (ctx.waitingSince !== null) parts.push(`waiting for a person since ${clock(ctx.waitingSince)}`);
  return parts.length ? `; ${parts.join("; ")}` : "";
}

export interface DurationSentence {
  /** The sentence as of `asOf` (for an open span, its length at `asOf`; the view keeps it live). */
  readonly text: string;
  /** Set when the span is open at `asOf` and its start is known: the view shows Elapsed instead of `text`. */
  readonly live: LiveDuration | null;
}

/**
 * A span's duration in the words of design section 5, as of `asOf`, with how it is known. An
 * interrupted or open span never "took".
 */
export function durationSentence(span: TimelineSpan, asOf: number, rules: Readonly<Record<string, string>> = {}, clock: (t: number) => string = (t) => timecode(t, false)): DurationSentence {
  if (!begunBy(span, asOf)) return { text: "Not started at the playhead", live: null };
  // An execution stopped from outside, or of unknown outcome: never "took", "failed" or "at work".
  const stopped = stoppedState(span);
  if (stopped !== null && (span.end === null || endedBy(span, asOf))) {
    const words = stoppedWords(span, stopped);
    return { text: words.charAt(0).toUpperCase() + words.slice(1), live: null };
  }
  if (!endedBy(span, asOf)) {
    const start = span.start?.at ?? null;
    if (start === null) return { text: span.start ? "Still open; its start is known only within bounds, so how long is not known" : "Still open; start not known", live: null };
    const interrupted = span.attrs.interruptedAt !== undefined && span.attrs.interruptedAt <= asOf;
    const mode: LiveDuration["mode"] = interrupted ? "interrupted" : isWait(span) ? "wait" : atWorkWhileOpen(span) ? "work" : "open";
    // An open wave, slice, cell, round or claim is "open", never "at work" (X2).
    if (mode === "open") return { text: elapsedWords("open", true, false, span1(Math.max(0, asOf - start))), live: { startedAt: start, mode } };
    const d = span1(Math.max(0, asOf - start));
    // The app's one vocabulary (the Elapsed component's words): "at work for", "waiting for", "open for".
    return { text: elapsedWords(mode, true, false, d), live: { startedAt: start, mode } };
  }
  const { ms, minMs, maxMs, basis } = span.duration;
  const known = ms ?? maxMs ?? minMs;
  if (endedWithoutExit(span)) {
    // Closed by rule at a bound (its execution's end, or the next entry): at most that long, never "took".
    const start = span.start?.at ?? null;
    const bound = maxMs ?? (start !== null && span.end?.at !== null && span.end?.at !== undefined ? span.end.at - start : null);
    if (bound === null) return { text: "ended without an exit record; how long is not known", live: null };
    return { text: elapsedWords("ended-unrecorded", true, true, span1(Math.max(0, bound))), live: null };
  }
  if (isInterrupted(span)) {
    if (known === null) return { text: span.end?.reason === "superseded" ? "Open, then superseded; how long is not known" : "Open, then interrupted; how long is not known", live: null };
    const d = span1(known);
    // `interruptedAt` only says the exit was stamped after its execution ended: never that work resumed.
    if (span.attrs.interruptedAt !== undefined) return { text: `open for ${d}; its exit was recorded after its execution ended (at ${clock(span.attrs.interruptedAt)})`, live: null };
    return { text: span.end?.reason === "superseded" ? `open for ${d}, then superseded` : `open for ${d}, then interrupted`, live: null };
  }
  switch (basis) {
    case "measured":
      return { text: ms !== null ? `took ${span1(ms)} (measured)` : "Measured, but the length was not given", live: null };
    case "bounded":
      if (minMs !== null && maxMs !== null) return { text: minMs === maxMs ? `took ${span1(minMs)} (bounded to that)` : `between ${span1(minMs)} and ${span1(maxMs)}`, live: null };
      if (minMs !== null) return { text: `at least ${span1(minMs)}; the upper bound is not known`, live: null };
      if (maxMs !== null) return { text: `at most ${span1(maxMs)}; the lower bound is not known`, live: null };
      return { text: "Bounded, but neither bound is recorded", live: null };
    case "inferred": {
      const rule = span.start?.basis === "inferred" ? span.start.rule : span.end?.basis === "inferred" ? span.end.rule : (span.start?.rule ?? span.end?.rule ?? null);
      return { text: `${known !== null ? `about ${span1(known)}` : "length not known"}, placed by rule: ${ruleWords(rule, rules)}`, live: null };
    }
    case "unknown":
      if (!span.start || (span.start.at === null && span.start.notBefore === null)) return { text: "start not known", live: null };
      return { text: "end not known", live: null };
    case "open":
      // Open in the record, ended by `asOf`: cannot happen; say what is true.
      return { text: "Still open", live: null };
  }
}

/** One end of a span in words, as of `asOf`. */
export interface EndFact {
  readonly state: "at" | "bounded" | "open" | "not-known" | "not-recorded" | "not-started";
  readonly text: string;
  readonly at: number | null;
  readonly eventId: string | null;
  readonly inferred: string | null;
}

export function beganFact(span: TimelineSpan, asOf: number, rules: Readonly<Record<string, string>> = {}, clock: (t: number) => string = (t) => timecode(t, false)): EndFact {
  const s = span.start;
  if (!s) return { state: "not-known", text: "Not known: only its end is recorded", at: null, eventId: null, inferred: null };
  const inferred = s.basis === "inferred" ? `placed by rule: ${ruleWords(s.rule, rules)}` : null;
  if (!begunBy(span, asOf)) return { state: "not-started", text: "Not started at the playhead", at: s.at, eventId: s.eventId, inferred };
  if (s.at !== null) return { state: "at", text: clock(s.at), at: s.at, eventId: s.eventId, inferred };
  if (s.notBefore !== null || s.notAfter !== null) return { state: "bounded", text: boundsText(s.notBefore, s.notAfter, clock), at: null, eventId: s.eventId, inferred };
  return { state: s.eventId ? "not-known" : "not-recorded", text: s.eventId ? "Not known" : "Not recorded", at: null, eventId: s.eventId, inferred };
}

export function endedFact(span: TimelineSpan, asOf: number, rules: Readonly<Record<string, string>> = {}, clock: (t: number) => string = (t) => timecode(t, false)): EndFact {
  if (!begunBy(span, asOf)) return { state: "not-started", text: "Not started at the playhead", at: null, eventId: null, inferred: null };
  const e = span.end;
  if (!e || !endedBy(span, asOf)) {
    const text = span.kind === "person-wait" ? "Still open: waiting for a person" : isWait(span) ? "Still open: still waiting" : "Still open";
    return { state: "open", text, at: null, eventId: null, inferred: null };
  }
  const inferred = e.basis === "inferred" ? `placed by rule: ${ruleWords(e.rule, rules)}` : null;
  const how = endedWithoutExit(span) ? "; ended without an exit record" : e.reason === "unknown" ? "; how it ended is not recorded" : "";
  if (e.at !== null) return { state: "at", text: `${clock(e.at)}${how}`, at: e.at, eventId: e.eventId, inferred };
  if (e.notBefore !== null || e.notAfter !== null) return { state: "bounded", text: `${boundsText(e.notBefore, e.notAfter, clock)}${how}`, at: null, eventId: e.eventId, inferred };
  return { state: e.eventId ? "not-known" : "not-recorded", text: e.eventId ? `Not known${how}` : "Not recorded", at: null, eventId: e.eventId, inferred };
}

function boundsText(lo: number | null, hi: number | null, clock: (t: number) => string): string {
  if (lo !== null && hi !== null) return `between ${clock(lo)} and ${clock(hi)}`;
  if (lo !== null) return `not before ${clock(lo)}`;
  return `not after ${clock(hi as number)}`;
}

/**
 * The outcome as of the playhead `asOf`, or null: never before the event that established it, and
 * never for a visit that ended without an exit record (no record says how it went). `asOf` is the
 * playhead itself (order time), compared with the span's `end.at`: not the time of the last event
 * applied, which lags the playhead by an event when two fall in the same millisecond.
 */
export function outcomeAsOf(span: TimelineSpan, asOf: number): string | null {
  if (endedWithoutExit(span)) return null;
  return begunBy(span, asOf) && outcomeKnownAt(span, asOf) ? span.outcome : null;
}

/** What the outcome is called: a seat's is its verdict. */
export const outcomeLabel = (span: TimelineSpan): string => (span.kind === "seat" ? "Verdict" : "Outcome");

/** Attempt and round, where the span has them, and the note when both are present. */
export function attemptAndRound(span: TimelineSpan): { attempt: number | null; round: number | null; note: string | null } {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
  const attempt = num(span.attrs.attempt) ?? num(span.ids["attempt"]);
  const round = num(span.attrs.round) ?? num(span.ids["round"]);
  const note = attempt !== null && round !== null ? "Attempts and rounds are different counts: an attempt is one execution of the ticket; a round is one judging pass of verification and review." : null;
  return { attempt, round, note };
}

/** A count-only agent's tool calls in words (design section 5: no calls are invented), or null for an agent seen call by call. */
export function toolCallsWords(span: TimelineSpan): string | null {
  if (!span.attrs.toolsCountOnly) return null;
  const n = span.attrs.toolCalls;
  if (n === undefined || n === null) return "Tool calls reported as a count, none reported yet; individual calls are not observable";
  return `${n.toLocaleString("en-GB")} tool call${n === 1 ? "" : "s"} reported as a count; individual calls are not observable`;
}

/** A dependency's wait in words: what is recorded about why it waited. */
export function dependencyWords(ref: string, span: TimelineSpan | null): string | null {
  const ends = dependencyEnds(ref);
  if (!ends) return null;
  if (!span) return `${ends.from} depends on ${ends.to}: the relationship is recorded; no wait on it is recorded.`;
  if (span.attrs.dependsOn?.some((d) => sameSlice(d, ends.to))) return `${ends.from} waited on ${ends.to}, as recorded with the wait.`;
  return `${ends.from} depends on ${ends.to}: the relationship is recorded; what this wait was waiting on is not recorded.`;
}

// ---------------------------------------------------------------- parent, children, before and after

/** The span of the parent entity, if it is among `spans` (the most telling kind for that entity). */
export function parentSpanOf(primary: TimelineSpan, spans: readonly TimelineSpan[], asOf: number): TimelineSpan | null {
  if (!primary.parent) return null;
  return primarySpan(primary.parent, spans, asOf) ?? spans.find((s) => s.entity === primary.parent) ?? null;
}

/** Children begun by `asOf`, in time order: the latest `limit`, and how many earlier ones are not listed. */
export function childrenOf(primary: TimelineSpan, spans: readonly TimelineSpan[], asOf: number, limit = 8): { shown: TimelineSpan[]; rest: number } {
  const all = spans.filter((s) => s.parent === primary.entity && s.entity !== primary.entity && begunBy(s, asOf)).sort(byStart);
  return { shown: all.slice(Math.max(0, all.length - limit)), rest: Math.max(0, all.length - limit) };
}

function samePlace(a: TimelineSpan, b: TimelineSpan): boolean {
  if (a.kind === "visit") return a.ids["station"] === b.ids["station"] && (a.ids["ticket_id"] ?? null) === (b.ids["ticket_id"] ?? null);
  return (a.parent ?? null) === (b.parent ?? null);
}

export interface Neighbour {
  readonly span: TimelineSpan;
  /** The gap in words: order in time only. */
  readonly words: string;
}

/**
 * The previous and next span of the same kind in the same place (same parent; a visit's same
 * station in the same cell), begun by `asOf`, with the gap between them in words.
 */
export function neighboursOf(primary: TimelineSpan, spans: readonly TimelineSpan[], asOf: number): { before: Neighbour | null; after: Neighbour | null } {
  if (!begunBy(primary, asOf)) return { before: null, after: null };
  const peers = spans.filter((s) => s.kind === primary.kind && s.id !== primary.id && samePlace(s, primary) && begunBy(s, asOf));
  const sorted = [...peers, primary].sort(byStart);
  const i = sorted.indexOf(primary);
  const prev = i > 0 ? (sorted[i - 1] ?? null) : null;
  const next = sorted[i + 1] ?? null;
  return {
    before: prev ? { span: prev, words: gapWords(prev, primary, asOf, "before") } : null,
    after: next ? { span: next, words: gapWords(primary, next, asOf, "after") } : null,
  };
}

/**
 * The gap from `earlier`'s end to `later`'s start, in words, as of `asOf`. "before": said of the
 * selected span relative to the previous one; "after": said of the next one relative to the selected.
 */
export function gapWords(earlier: TimelineSpan, later: TimelineSpan, asOf: number, side: "before" | "after"): string {
  const subject = side === "before" ? "It" : "The next";
  const other = side === "before" ? "the previous" : "this";
  const start = later.start?.at ?? null;
  if (!endedBy(earlier, asOf)) return `${subject} started while ${other} was still open`;
  const end = earlier.end?.at ?? null;
  if (start === null || end === null) return `${subject} started after ${other} began; the gap between them is not known`;
  const gap = start - end;
  if (Math.abs(gap) < 1000) return `${subject} started as ${other} ended`;
  return gap > 0 ? `${subject} started ${duration(gap)} after ${other} ended` : `${subject} started ${duration(-gap)} before ${other} ended`;
}

/** Said once beside "Before and after". */
export const ORDER_NOTE = "Order in time only: one following another does not mean one caused the other.";

/** A one-line duration for a linked span (a parent, a child, a neighbour), as of `asOf`. */
export function shortDuration(span: TimelineSpan, asOf: number, rules: Readonly<Record<string, string>> = {}): string {
  return durationSentence(span, asOf, rules).text;
}

// ---------------------------------------------------------------- evidence (the hook Evidence Theater, M6.4, uses)

/**
 * One evidence reference, stable for M6.4: an artifact's catalog id (`artifact:<artifactId>` is its
 * ref; the observer's artifact catalog uses the same id), the event that produced it, and the events
 * that verified it, newest first. References only: nothing here reads a file.
 */
export interface EvidenceRef {
  /** The artifact catalog id. */
  readonly artifactId: string;
  /** The event that recorded the write, or null when no record names it. */
  readonly producedBy: string | null;
  /** Verification records that cite the artifact's file, in log order. */
  readonly verifiedBy: readonly string[];
}

/** A log entry's id, type and data, as much as evidence matching reads. */
export interface EvidenceEvent {
  readonly id: string;
  readonly event: { readonly type: string; readonly data?: unknown };
}

const VERIFY_EVENTS: ReadonlySet<string> = new Set(["verify.check_recorded", "evidence.captured"]);

/**
 * The artifacts the inspector already knows for an entity (the same lists its anatomies link: a
 * cell's artifacts, a station visit's, what an agent wrote, what a tool call wrote; a visit's are
 * its station's written while it was open), newest first, as references only:
 *
 * - `artifactId`: the scene artifact's id, which is its catalog ref without the `artifact:` prefix;
 * - `producedBy`: the event that recorded the write (`sim:<seq>` for the simulation), or null when
 *   the scene does not name it;
 * - `verifiedBy`: the ids of verification records (`verify.check_recorded`, the simulation's
 *   `evidence.captured`) among `events` whose evidence names the artifact's file. The scene keeps no
 *   event id on a verification check, so without `events` this is always empty.
 *
 * Pure: Evidence Theater (M6.4) calls it with the scene at the playhead and the entity's cell's log
 * entries. Nothing here reads file contents.
 */
export function evidenceRefsOf(scene: Scene, ref: EntityRef | string, events: readonly EvidenceEvent[] = []): EvidenceRef[] {
  const artifacts = artifactsOf(scene, ref);
  return [...artifacts]
    .sort((a, b) => b.writtenAt - a.writtenAt || b.seq - a.seq)
    .map((a) => ({
      artifactId: a.id,
      producedBy: a.meta.authority === "simulated" ? `sim:${a.seq}` : a.meta.eventId || null,
      verifiedBy: events.filter((e) => VERIFY_EVENTS.has(e.event.type) && namesFile(e.event.data, a.path)).map((e) => e.id),
    }));
}

function namesFile(data: unknown, path: string): boolean {
  const list = (data as { evidence?: unknown } | undefined)?.evidence;
  if (!Array.isArray(list) || !path) return false;
  return list.some((x) => {
    const file = typeof x === "string" ? x : x && typeof x === "object" && typeof (x as { file?: unknown }).file === "string" ? (x as { file: string }).file : null;
    return file !== null && file.length > 0 && (file === path || path.endsWith(`/${file}`) || file.endsWith(`/${path}`));
  });
}

function artifactsOf(scene: Scene, ref: string): readonly ArtifactState[] {
  const id = refIdOf(ref);
  switch (refKindOf(ref)) {
    case "cell":
      return scene.cells[id]?.artifacts ?? [];
    case "station": {
      const [ticket, station] = id.split("/");
      return ticket && station ? (scene.cells[ticket]?.artifacts ?? []).filter((a) => a.station === station) : [];
    }
    case "visit": {
      for (const cell of Object.values(scene.cells)) {
        const v = cell.visits.find((x) => x.visitId === id);
        if (v) return cell.artifacts.filter((a) => a.station === v.station && a.writtenAt >= v.enteredAt && (v.leftAt === null || a.writtenAt <= v.leftAt));
      }
      return [];
    }
    case "agent": {
      const agent = findAgent(scene, id);
      return agent ? (scene.cells[agent.ticketId]?.artifacts ?? []).filter((a) => a.writer.agentId === agent.id) : [];
    }
    case "tool": {
      const call = findToolCall(scene, id);
      return call ? (scene.cells[call.ticketId]?.artifacts ?? []).filter((a) => call.artifactIds.includes(a.id)) : [];
    }
    default:
      return [];
  }
}
