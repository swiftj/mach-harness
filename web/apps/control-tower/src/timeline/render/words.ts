/**
 * The words of the timing grammar (docs/mach-next/M6_3_DESIGN.md section 5, "Words"): one sentence
 * per span for tooltips and screen readers, and its duration said the way it is known. Pure: no DOM,
 * no React, so the words are tested in plain node (test/timeline-render.test.mjs).
 *
 * Rules held here:
 * - nothing after `liveAt` is known: a span whose end lies beyond it reads as still running;
 * - an outcome is said only once `outcomeKnownAt` allows it;
 * - an interrupted or superseded span never "took" anything;
 * - "not recorded" is never a span: it is the label column's word, not this module's.
 */
import { duration as durationOf } from "../../shell/time";
import { elapsedWords } from "../../shell/inspector/words";
import { outcomeKnownAt, type FlatRow, type SpanAuthority, type SpanKind, type SpanPrecision, type TimelineSpan, type TrackNode } from "../contract";

/** Kinds whose open state is a wait, not work: "waiting for", never "running for". */
export const WAIT_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>(["slice-wait", "slice-eligible", "capacity-wait", "gate-wait", "person-wait", "agent-queue"]);

/** A duration in words, down to milliseconds: "340 ms", "48 s", "4 min 12 s", "1 h 3 min". */
export function durationText(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)} ms`;
  return durationOf(v);
}

/** A rule identifier in words: "visit-end-at-next-visit" reads "visit end at next visit". */
export function ruleWords(rule: string | null): string {
  if (!rule) return "a rule not named";
  return rule.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Where a span starts and ends as recorded (bounds where only bounded). Null ends are not known. */
function startAt(span: TimelineSpan): number | null {
  const s = span.start;
  if (!s) return null;
  return s.at ?? s.notBefore ?? null;
}

function isInterrupted(span: TimelineSpan): boolean {
  const r = span.end?.reason;
  return r === "interrupted" || r === "superseded" || endedWithoutExit(span);
}

/**
 * A span closed at a bound because nothing recorded its exit (its execution ended, or a later visit
 * superseded it): the end is inferred and the reason says it stopped from outside. Drawn and said as
 * "ended without an exit record", never as running and never as "took".
 */
export function endedWithoutExit(span: TimelineSpan): boolean {
  const e = span.end;
  return e !== null && e.basis === "inferred" && (e.reason === "interrupted" || e.reason === "superseded" || e.reason === "unknown");
}

/** The ticket a span is about, under either spelling of its id. */
export function ticketOf(span: TimelineSpan): string | null {
  return span.ids.ticket ?? span.ids.ticket_id ?? span.ids.cell ?? null;
}

/** Whether the end is recorded at or before what is held. A span ending after `liveAt` is still open there. */
export function endedBy(span: TimelineSpan, liveAt: number): boolean {
  const e = span.end;
  if (!e) return false;
  const at = e.at ?? e.notAfter ?? e.notBefore;
  return at !== null && at <= liveAt;
}

/** The duration in the words of design section 5. */
export function durationWords(span: TimelineSpan, liveAt: number): string {
  const wait = WAIT_KINDS.has(span.kind);
  const s = span.start;
  const e = span.end;
  const t0 = startAt(span);

  // Unknown: one end applies but nothing records it. Never extended into a length.
  const startUnknown = s === null || (s.at === null && s.notBefore === null && s.notAfter === null);
  const endUnknown = e !== null && e.at === null && e.notBefore === null && e.notAfter === null;
  if (startUnknown) return endUnknown ? "start and end not known" : "start not known";
  if (t0 !== null && t0 > liveAt) return "not started yet";

  // Open, or ended only after what is held: still running at the live edge.
  if (e === null || !endedBy(span, liveAt)) {
    if (endUnknown) return "end not known";
    if (t0 === null) return "start not known";
    return `${wait ? "waiting" : "running"} for ${durationText(liveAt - t0)}`;
  }
  if (endUnknown) return "end not known";

  const basis = span.duration.basis;
  const ms = span.duration.ms ?? (e.at !== null && t0 !== null ? e.at - t0 : null);
  const min = span.duration.minMs ?? (e.notBefore !== null && t0 !== null ? e.notBefore - t0 : ms);
  const max = span.duration.maxMs ?? (e.notAfter !== null && t0 !== null ? e.notAfter - (s?.notBefore ?? t0) : ms);
  const inferredRule = e.basis === "inferred" ? e.rule : s?.basis === "inferred" ? s.rule : null;

  if (endedWithoutExit(span)) {
    // The words of the inspector (src/shell/inspector/words.ts elapsedWords, "ended-unrecorded").
    const endAt = e.notAfter ?? e.at;
    const bound = span.duration.maxMs ?? span.duration.ms ?? (endAt !== null && t0 !== null ? endAt - t0 : null);
    return bound === null ? "ended without an exit record, when is not known" : elapsedWords("ended-unrecorded", true, true, durationText(bound));
  }
  if (isInterrupted(span)) {
    const word = e.reason === "superseded" ? "superseded" : "interrupted";
    if (ms === null) return `${word}, after a time not known`;
    return `${word} after ${basis === "measured" ? "" : "about "}${durationText(ms)}`;
  }
  if (span.attrs.interruptedAt !== undefined && ms !== null) {
    return `ran ${basis === "measured" ? "" : "about "}${durationText(ms)}, interrupted once and taken up again`;
  }

  switch (basis) {
    case "measured":
      if (ms === null) return "length not known";
      return `${wait ? "waited" : "took"} ${durationText(ms)}`;
    case "bounded": {
      if (min === null || max === null) return ms === null ? "length not known" : `about ${durationText(ms)}`;
      const a = durationText(Math.min(min, max));
      const b = durationText(Math.max(min, max));
      return a === b ? `about ${a}, within bounds` : `between ${a} and ${b}`;
    }
    case "inferred":
      return `about ${ms === null ? "a length not known" : durationText(ms)}, placed by rule: ${ruleWords(inferredRule)}`;
    case "open":
      // The observer said open but the end is now held: say what is known.
      return ms === null ? "length not known" : `${wait ? "waited" : "took"} ${durationText(ms)}`;
    case "unknown":
      return "length not known";
  }
}

const KIND_WORDS: Readonly<Record<SpanKind, string>> = {
  wave: "Wave",
  "slice-wait": "Waiting on a dependency",
  "slice-eligible": "Eligible, not yet dispatched",
  "capacity-wait": "Waiting for capacity",
  cell: "Cell",
  round: "Round",
  visit: "Station visit",
  task: "Build task",
  seat: "Review seat",
  "gate-wait": "Waiting at a gate",
  "person-wait": "Waiting for a person",
  claim: "Claim",
  execution: "Execution",
  workflow: "Workflow",
  "agent-queue": "Queued before its agent",
  agent: "Agent",
  tool: "Tool call",
};

const OUTCOME_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>(["cell", "round", "visit", "task", "seat", "execution", "workflow", "agent", "tool", "claim"]);

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** What the span is about, in a few words: "Build visit, round 2", "Agent builder (Sonnet)". */
export function spanSubject(span: TimelineSpan): string {
  const a = span.attrs;
  switch (span.kind) {
    case "visit": {
      const station = span.ids.station === "merge" || span.ids.station === "human-approval" ? span.ids.station : (a.action ?? span.ids.station ?? null);
      const base = station ? `${cap(station.replace(/-/g, " "))} visit` : "Station visit";
      return a.round && a.round > 1 ? `${base}, round ${a.round}` : base;
    }
    case "round":
      return a.round ? `Round ${a.round}` : "Round";
    case "agent":
    case "seat": {
      const seat = a.label ?? span.ids.seat;
      const who = span.kind === "seat" ? (seat ? `Review seat ${seat}` : "Review seat") : a.label ? `Agent ${a.label}` : "Agent";
      return a.model ? `${who} (${cap(a.model)})` : who;
    }
    case "execution":
      return a.attempt ? `Execution, attempt ${a.attempt}` : "Execution";
    case "tool":
      return a.label ? `Tool call ${a.label}` : "Tool call";
    case "task":
      return a.label ? `Build task ${a.label}` : "Build task";
    default:
      return a.label && span.kind !== "slice-wait" && span.kind !== "capacity-wait" ? `${KIND_WORDS[span.kind]}: ${a.label}` : KIND_WORDS[span.kind];
  }
}

/** An outcome string in words: "changes-requested" reads "changes requested". */
export function outcomeWords(outcome: string): string {
  if (/^human\.approval/i.test(outcome)) return "approved by a person";
  return outcome.replace(/[-_.]+/g, " ").toLowerCase();
}

const FAILED_OUTCOME = /fail|reject|refus|declin|denied/i;

/** Whether a wait on a person ended in an approval, as recorded by `liveAt`. */
export function personApproved(span: TimelineSpan, liveAt: number): boolean {
  if (span.kind !== "person-wait" && span.kind !== "gate-wait") return false;
  if (!outcomeKnownAt(span, liveAt) || !span.outcome) return false;
  if (span.end?.reason === "refused" || span.end?.reason === "failed" || FAILED_OUTCOME.test(span.outcome)) return false;
  return /approv|pass|completed/i.test(span.outcome);
}

/** A merge visit: the station that lands the approved commit. */
export function isMergeVisit(span: TimelineSpan): boolean {
  return span.kind === "visit" && (span.ids.station === "merge" || span.attrs.action === "merge");
}

/**
 * The outcome in the words the events already use (src/sim/describe-v3.ts): a seat "voted reject",
 * a person "approved the review" (the code: review's human approval), a merge visit "merged" (the
 * authorization to land it; who merged is not in the records, so it is not said).
 */
function outcomePhrase(span: TimelineSpan, liveAt: number): string {
  const o = span.outcome ?? "";
  if (span.kind === "seat") return `voted ${outcomeWords(o)}`;
  if (span.kind === "person-wait" || span.kind === "gate-wait") {
    if (personApproved(span, liveAt)) return /approval|review|human-approval/i.test(`${o} ${span.entity}`) ? "a person approved the review" : "a person approved";
    if (FAILED_OUTCOME.test(o)) return "a person declined";
    return outcomeWords(o);
  }
  if (isMergeVisit(span) && /merged|completed/i.test(o)) return "merged into the main branch";
  return outcomeWords(o);
}

/** The one sentence for tooltips and screen readers. */
export function describeSpan(span: TimelineSpan, liveAt: number): string {
  const subject = spanSubject(span);
  const ticket = ticketOf(span);
  const whose = ticket && !subject.includes(ticket) ? ` for ${ticket}` : "";
  const parts = [durationWords(span, liveAt)];
  if (span.kind === "agent" && span.attrs.toolsCountOnly && span.attrs.toolCalls !== undefined) {
    parts.push(`${span.attrs.toolCalls} tool call${span.attrs.toolCalls === 1 ? "" : "s"}, not observable one by one`);
  }
  if (outcomeKnownAt(span, liveAt) && span.outcome && !isInterrupted(span)) parts.push(outcomePhrase(span, liveAt));
  else if (OUTCOME_KINDS.has(span.kind) && endedBy(span, liveAt) && !isInterrupted(span) && span.outcome === null) parts.push("no outcome recorded yet");
  return `${subject}${whose}: ${parts.join(", ")}.`;
}

export const AUTHORITY_WORDS: Readonly<Record<SpanAuthority, string>> = {
  authoritative: "Authoritative: a station's own record",
  observed: "Observed: seen by the observer as it happened",
  reconstructed: "Reconstructed from other records",
  simulated: "Simulated: the fixture, not a real run",
};

export const PRECISION_WORDS: Readonly<Record<SpanPrecision, string>> = {
  ms: "to the millisecond",
  s: "to the second",
  arrival: "when its event arrived",
  bounded: "within bounds",
  unknown: "not known",
  simulated: "simulated time",
};

/** How the two ends are known, in one line: "Start to the second; end placed by rule: …". */
export function precisionLine(span: TimelineSpan, liveAt: number): string {
  const s = span.start;
  const e = span.end;
  const startWords = !s || (s.at === null && s.notBefore === null) ? "start not known" : s.basis === "inferred" ? `start placed by rule: ${ruleWords(s.rule)}` : `start ${PRECISION_WORDS[s.precision]}`;
  let endWords: string;
  if (e && endedWithoutExit(span) && endedBy(span, liveAt)) endWords = `no exit recorded; closed at a bound by rule: ${ruleWords(e.rule)}`;
  else if (!e || !endedBy(span, liveAt)) endWords = e && e.at === null && e.notBefore === null ? "end not known" : "not ended by the live edge";
  else if (e.basis === "inferred") endWords = `end placed by rule: ${ruleWords(e.rule)}`;
  else endWords = `end ${PRECISION_WORDS[e.precision]}`;
  return `${cap(startWords)}; ${endWords}.`;
}

const ATTENTION_WORDS: Readonly<Record<TrackNode["attention"], string | null>> = {
  none: null,
  open: "work in progress",
  person: "waiting for a person",
  interrupted: "something was interrupted",
  failed: "something failed",
};

/** A row in words, for the cursor's card and the live region: its label, then count, attention and state. */
export function rowWords(row: FlatRow): { title: string; detail: string } {
  const n = row.node;
  const title = n.detail ? `${n.label}, ${n.detail}` : n.label;
  const parts = [`${n.spanCount.toLocaleString("en-GB")} span${n.spanCount === 1 ? "" : "s"} in this track and below`];
  const attention = ATTENTION_WORDS[n.attention];
  if (attention) parts.push(attention);
  if (row.hasChildren) parts.push(row.expanded ? "expanded" : "collapsed");
  if (row.lane > 0) parts.push(`lane ${row.lane + 1}`);
  const detail = parts.join(", ");
  return { title, detail: detail[0]!.toUpperCase() + detail.slice(1) };
}

/** Below this many characters a label column detail says nothing: it is dropped (the full text is in the title). */
export const DETAIL_MIN_CHARS = 6;

/**
 * Whether a row's quieter detail is shown beside its label: only when at least DETAIL_MIN_CHARS of it
 * (or all of a shorter one) fit after the label, which has priority. Pure given the widths.
 */
export function showDetail(available: number, labelWidth: number, detailWidth: number, minWidth: number): boolean {
  return available - labelWidth - 6 >= Math.min(detailWidth, minWidth);
}
