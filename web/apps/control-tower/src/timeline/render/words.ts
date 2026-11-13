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
import type { MarkState } from "@mach/ui";
import { duration as durationOf, timecode } from "../../shell/time";
import { elapsedWords } from "../../shell/inspector/words";
import { noEndRecorded, outcomeKnownAt, type FlatRow, type SpanAuthority, type SpanKind, type SpanPrecision, type TimelineSpan, type TrackNode } from "../contract";

/** Kinds whose open state is a wait, not work: "waiting for", never "at work for". */
/**
 * A capacity wait in words: "waiting for a free place (1 of 1 in use)" when the record names the
 * limit (the supervisor holds a ready slice only while every place is taken), else "waiting for capacity".
 */
export function capacityWords(span: Pick<TimelineSpan, "attrs">): string {
  const n = span.attrs.limit;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? `waiting for a free place (${n} of ${n} in use)` : "waiting for capacity";
}

export const WAIT_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>(["slice-wait", "slice-eligible", "capacity-wait", "gate-wait", "person-wait", "agent-queue"]);

/** Kinds that are work while open (the contract's open rule); a human-approval visit is a wait. */
const WORK_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>(["execution", "workflow", "agent", "tool", "task", "visit"]);

/** How an open span is said: "at work" (work), "waiting" (a wait, a visit to human approval) or "open" (a wave, slice, cell, round, claim, seat). The inspector's words. */
export function openWord(span: TimelineSpan): "at work" | "waiting" | "open" {
  if (WAIT_KINDS.has(span.kind)) return "waiting";
  if (span.kind === "visit" && span.ids.station === "human-approval") return "waiting";
  return WORK_KINDS.has(span.kind) ? "at work" : "open";
}

/**
 * What the tree knows around an open container (a wave, slice, cell or round): when anything beneath it
 * last ended, and since when a person has been waited on. Both null when not known.
 */
export interface OpenContext {
  readonly lastActivity: number | null;
  readonly personSince: number | null;
}

/** A moment in words: UTC HH:MM:SS for wall time, the scenario's elapsed time otherwise. */
export function clockWords(t: number): string {
  if (t > 86_400_000) return new Date(t).toISOString().slice(11, 19);
  return timecode(t, false);
}

/** "; last activity 06:42:56; waiting for a person since 06:40:12", or "" when nothing is known. */
export function contextWords(ctx: OpenContext | null | undefined): string {
  if (!ctx) return "";
  const parts: string[] = [];
  if (ctx.lastActivity !== null) parts.push(`last activity ${clockWords(ctx.lastActivity)}`);
  if (ctx.personSince !== null) parts.push(`waiting for a person since ${clockWords(ctx.personSince)}`);
  return parts.length ? `; ${parts.join("; ")}` : "";
}

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
  return r === "interrupted" || r === "superseded" || endedWithoutExit(span) || stoppedState(span) !== null;
}

/** How an execution stopped when it did not run to its end: from the observer's `attrs.state`, else its end's reason. */
export type StoppedState = "interrupted" | "timed-out" | "could-not-start" | "unknown";
const STOPPED: ReadonlySet<string> = new Set(["interrupted", "timed-out", "could-not-start", "unknown"]);

/**
 * An execution's stopped state (design 5): "interrupted", "timed-out", "could-not-start" (all with end
 * reason "interrupted"), or "unknown" (the outcome is not known). Null for an execution that ran to its
 * end, is running, or any other kind. Never "took", "failed" or "running".
 */
export function stoppedState(span: TimelineSpan): StoppedState | null {
  if (span.kind !== "execution") return null;
  const st = span.attrs.state;
  if (st && STOPPED.has(st)) return st as StoppedState;
  const r = span.end?.reason;
  if (r === "interrupted" || r === "unknown") return r;
  return null;
}

const STOPPED_WORDS: Readonly<Record<Exclude<StoppedState, "unknown">, string>> = {
  interrupted: "interrupted",
  "timed-out": "timed out",
  "could-not-start": "could not start; stopped",
};

/**
 * A stopped execution's length in words: "interrupted after at most 6 min 48 s", "outcome not known;
 * last record at 03:12:40". Its end is a bound at best (the process was stopped from outside), so the
 * length is the most it can have been, never a measured "took".
 */
export function stoppedWords(span: TimelineSpan, state: StoppedState): string {
  const e = span.end;
  const t0 = startAt(span);
  if (state === "unknown") {
    if (e === null) return t0 === null ? "outcome not known; no end recorded" : `outcome not known; no end recorded, last known start ${clockWords(t0)}`;
    const last = e.basis === "recorded" ? (e.at ?? e.notBefore) : (e.notBefore ?? null);
    const by = e.notAfter ?? e.at;
    if (last !== null) return by !== null && by > last + 999 ? `outcome not known; last record at ${clockWords(last)}, ended by ${clockWords(by)}` : `outcome not known; last record at ${clockWords(last)}`;
    return by !== null ? `outcome not known; ended by ${clockWords(by)} at the latest` : "outcome not known; when it ended is not known";
  }
  const word = STOPPED_WORDS[state];
  const endAt = e ? (e.notAfter ?? e.at) : null;
  const most = span.duration.maxMs ?? span.duration.ms ?? (endAt !== null && t0 !== null ? endAt - t0 : null);
  if (e === null) return `${word}; when is not recorded`;
  if (most === null) return `${word}, after a time not known`;
  return `${word} after at most ${durationText(Math.max(0, most))}`;
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

/** Whether the outcome is not known: closed by a bound with no outcome (the recovery's unknown state, a visit closed by cleanup). */
export function outcomeUnknown(span: TimelineSpan, liveAt: number): boolean {
  return span.end !== null && span.end.reason === "unknown" && endedBy(span, liveAt);
}

/**
 * The duration in the words of design section 5. `context` (from the tree, for an open wave, slice,
 * cell or round) adds when anything beneath it last ended.
 */
/** The words for an open span when its history, no longer live, ended at `at` (the inspector's too). */
export function noEndWords(at: number): string {
  return `no end recorded; the history ends at ${clockWords(at)}`;
}

export function durationWords(span: TimelineSpan, liveAt: number, context?: OpenContext | null): string {
  const wait = WAIT_KINDS.has(span.kind);
  const s = span.start;
  const e = span.end;
  const t0 = startAt(span);

  // Unknown: one end applies but nothing records it. Never extended into a length.
  const startUnknown = s === null || (s.at === null && s.notBefore === null && s.notAfter === null);
  const endUnknown = e !== null && e.at === null && e.notBefore === null && e.notAfter === null;
  if (startUnknown) return endUnknown ? "start and end not known" : "start not known";
  if (t0 !== null && t0 > liveAt) return "not started yet";

  // Open at the end of a history that is no longer live (a replay, a disabled Factory): never "at work".
  if (noEndRecorded(span, liveAt)) return noEndWords(span.attrs.historyEndsAt!);

  // An execution stopped from outside, or of unknown outcome: never "took", "failed" or "running".
  const stopped = stoppedState(span);
  if (stopped !== null && (e === null || endedBy(span, liveAt))) return stoppedWords(span, stopped);

  // Open, or ended only after what is held: still running at the live edge.
  if (e === null || !endedBy(span, liveAt)) {
    if (endUnknown) return "end not known";
    if (t0 === null) return "start not known";
    const word = openWord(span);
    const d = durationText(liveAt - t0);
    // Only work is "at work"; an open container is open, and says what the tree knows of its activity.
    return word === "open" ? `open ${d}${contextWords(context)}` : `${word} for ${d}`;
  }
  if (endUnknown) return "end not known";

  const basis = span.duration.basis;
  const ms = span.duration.ms ?? (e.at !== null && t0 !== null ? e.at - t0 : null);
  const min = span.duration.minMs ?? (e.notBefore !== null && t0 !== null ? e.notBefore - t0 : ms);
  const max = span.duration.maxMs ?? (e.notAfter !== null && t0 !== null ? e.notAfter - (s?.notBefore ?? t0) : ms);
  const inferredRule = e.basis === "inferred" ? e.rule : s?.basis === "inferred" ? s.rule : null;

  if (e.reason === "unknown" && span.kind !== "visit") {
    // Closed at a bound with no outcome (the supervisor's recovery found its state unknown): never "took".
    const endAt = e.notAfter ?? e.at;
    const bound = span.duration.maxMs ?? span.duration.ms ?? (endAt !== null && t0 !== null ? endAt - t0 : null);
    return bound === null ? "outcome not known; when it ended is not known" : `outcome not known; ended within ${durationText(bound)}`;
  }
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
    // `interruptedAt` says only that the exit was stamped after the execution ended (or after the station
    // was entered again): never that the work was taken up. Entry to exit is a span, not time worked.
    // The inspector's words (src/timeline/inspector/model.ts) and the bar's (render/draw.ts shortDuration).
    return `${elapsedWords("interrupted", true, true, `${basis === "measured" ? "" : "about "}${durationText(ms)}`)}; its exit was recorded after its execution ended (at ${clockWords(span.attrs.interruptedAt)})`;
  }

  switch (basis) {
    case "measured":
      if (ms === null) return "length not known";
      return `${wait ? "waited" : "took"} ${durationText(ms)}`;
    case "bounded": {
      if (min === null || max === null) return ms === null ? "length not known" : `about ${durationText(ms)}`;
      const a = durationText(Math.min(min, max));
      const b = durationText(Math.max(min, max));
      // A lower bound of nothing says nothing: "up to 4 min 7 s", never "between 0 ms and …" (round 6).
      if (Math.min(min, max) <= 0) return `up to ${b}`;
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
      return a.attempt ? `Execution, supervisor attempt ${a.attempt}` : "Execution";
    case "tool":
      return a.label ? `Tool call ${a.label}` : "Tool call";
    case "task":
      return a.label ? `Build task ${a.label}` : "Build task";
    case "capacity-wait": {
      const w = capacityWords(span);
      return w.charAt(0).toUpperCase() + w.slice(1);
    }
    default:
      return a.label && span.kind !== "slice-wait" ? `${KIND_WORDS[span.kind]}: ${a.label}` : KIND_WORDS[span.kind];
  }
}

/** What an attempt is, said once in the hover card of an execution. */
export const ATTEMPT_WORDS = "An attempt is the supervisor's own count of its tries to run this ticket; the run is this execution's order among the cell's executions.";

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

/** The one sentence for tooltips and screen readers. `context`: as for durationWords. */
export function describeSpan(span: TimelineSpan, liveAt: number, context?: OpenContext | null): string {
  const subject = spanSubject(span);
  const ticket = ticketOf(span);
  const whose = ticket && !subject.includes(ticket) ? ` for ${ticket}` : "";
  const parts = [durationWords(span, liveAt, context)];
  if (span.kind === "agent" && span.attrs.toolsCountOnly && span.attrs.toolCalls !== undefined) {
    parts.push(`${span.attrs.toolCalls} tool call${span.attrs.toolCalls === 1 ? "" : "s"}, not observable one by one`);
  }
  if (outcomeKnownAt(span, liveAt) && span.outcome && !isInterrupted(span)) parts.push(outcomePhrase(span, liveAt));
  else if (OUTCOME_KINDS.has(span.kind) && endedBy(span, liveAt) && !isInterrupted(span) && span.outcome === null && !outcomeUnknown(span, liveAt)) parts.push("no outcome recorded yet");
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
  // The simulation's times are all simulated: said once, not once per end.
  if (s?.precision === "simulated" && (!e || e.precision === "simulated") && s.basis !== "inferred" && e?.basis !== "inferred") return "Simulated times.";
  return `${cap(startWords)}; ${endWords}.`;
}

// ---------------------------------------------------------------- a row's own state and its counts

/** Track kinds that hold one long-lived container (open is "open", never "running"). */
const CONTAINER_TRACKS: ReadonlySet<TrackNode["kind"]> = new Set<TrackNode["kind"]>(["wave", "slice", "cell", "rounds", "review", "factory"]);

/**
 * A row's OWN state, for its mark and its words: never a child's verdict (a cell whose round was
 * rejected is not failed; it says "2 rejections" beside its own state). Merged is the cell's outcome;
 * an open container is "open", "open, work running" or "open, waiting for a person" from its counts.
 */
export function nodeState(node: TrackNode, liveAt: number): { readonly state: MarkState | null; readonly words: string } {
  const c = node.counts ?? {};
  switch (node.attention) {
    case "failed":
      return { state: "failed", words: "failed" };
    case "unknown":
      // Its own span open at the end of a history that is no longer live: no end recorded.
      if (node.lanes[0]?.spans.some((s) => noEndRecorded(s, liveAt))) return { state: "unknown", words: "no end recorded" };
      return { state: "unknown", words: "outcome not known" };
    case "interrupted":
      return { state: "interrupted", words: "interrupted" };
    case "person":
      return { state: "human", words: "waiting for a person" };
    case "open": {
      if (node.kind === "station" && node.id.endsWith("/human-approval")) return { state: "human", words: "waiting for a person" };
      if (node.kind === "waits") return { state: "waiting", words: "waiting" };
      if (CONTAINER_TRACKS.has(node.kind)) {
        if (c.waitingPerson) return { state: "human", words: "open, waiting for a person" };
        if (c.open) return { state: "active", words: "open, work running" };
        return { state: "idle", words: "open" };
      }
      return { state: "active", words: "running" };
    }
    default: {
      const own = node.lanes[0]?.spans;
      if (node.kind === "cell" && own?.some((s) => outcomeKnownAt(s, liveAt) && /merged/i.test(s.outcome ?? ""))) return { state: "succeeded", words: "merged" };
      return { state: null, words: "" };
    }
  }
}

/** What happened beneath a row, worst first: "2 rejections", "1 failed", "1 interrupted", "1 outcome not known". */
export function countsWords(counts: TrackNode["counts"]): string[] {
  if (!counts) return [];
  const out: string[] = [];
  const n = (k: number, one: string, many: string) => `${k.toLocaleString("en-GB")} ${k === 1 ? one : many}`;
  if (counts.rejected) out.push(n(counts.rejected, "rejection", "rejections"));
  if (counts.failed) out.push(n(counts.failed, "failed", "failed"));
  if (counts.interrupted) out.push(n(counts.interrupted, "interrupted", "interrupted"));
  if (counts.unknown) out.push(n(counts.unknown, "outcome not known", "outcomes not known"));
  return out;
}

/** The ink the counts are set in: the worst counted condition's. */
export function countsTone(counts: TrackNode["counts"]): "fail" | "halt" | "muted" | null {
  if (!counts) return null;
  if (counts.rejected || counts.failed) return "fail";
  if (counts.interrupted) return "halt";
  if (counts.unknown) return "muted";
  return null;
}

/**
 * The counts a row says beside its own mark: what happened beneath it, less the row's own condition (an
 * execution that itself failed wears the fail mark; it does not also say "1 failed").
 */
export function shownCounts(node: TrackNode): TrackNode["counts"] {
  const c = node.counts;
  if (!c) return undefined;
  const key = node.attention === "failed" ? (c.failed ? "failed" : "rejected") : node.attention === "interrupted" ? "interrupted" : node.attention === "unknown" ? "unknown" : null;
  if (!key || !c[key]) return c;
  return { ...c, [key]: (c[key] ?? 0) - 1 };
}

/** Whether a row shows its counts: a group, or a row of several spans (a single span's mark says it). */
export function showsCounts(node: TrackNode): boolean {
  return countsWords(shownCounts(node)).length > 0 && (node.children.length > 0 || node.spanCount > 1);
}

/**
 * The most of a label that fits `room`, dropping its trailing " · " parts first (they are details:
 * "LOCAL-001 · run 2/3 · 05:37" becomes "LOCAL-001 · run 2/3", then "LOCAL-001"), so an id is
 * never cut in the middle while a detail can go instead. Only the first part is ever truncated.
 * `dropped` holds what was taken off, for the title. Pure given `width`.
 */
export function fitLabel(label: string, room: number, width: (text: string) => number): { readonly text: string; readonly dropped: string; readonly truncated: boolean } {
  const parts = label.split(" · ");
  for (let n = parts.length; n >= 1; n--) {
    const text = parts.slice(0, n).join(" · ");
    if (width(text) <= room) return { text, dropped: parts.slice(n).join(" · "), truncated: false };
  }
  return { text: parts[0] as string, dropped: parts.slice(1).join(" · "), truncated: true };
}

/** A row in words, for the cursor's card and the live region: its label, then its own state, counts and spans. */
export function rowWords(row: FlatRow, liveAt = Number.POSITIVE_INFINITY): { title: string; detail: string } {
  const n = row.node;
  const title = n.detail ? `${n.label}, ${n.detail}` : n.label;
  const parts: string[] = [];
  const own = nodeState(n, liveAt).words;
  if (own) parts.push(own);
  parts.push(...countsWords(shownCounts(n)));
  parts.push(`${n.spanCount.toLocaleString("en-GB")} span${n.spanCount === 1 ? "" : "s"} in this track and below`);
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

/**
 * The words the label column shows for a row's note: the count-only notes, long enough to be cut to
 * "Tool calls are c…" or "2 tool calls, cou…", keep their informative part ("calls counted",
 * "2 calls, counted"); the full note stays in the row's title and in the table (round 6, defect 19).
 */
export function shortNote(note: string): string {
  if (note === "Tool calls are counted, not observable one by one") return "calls counted";
  const m = /^(\d+) tool (calls?), counted, not observable one by one$/.exec(note);
  return m ? `${m[1]} ${m[2]}, counted` : note;
}

/**
 * An execution row's full words: its detail is kept short ("from 16:55"), the title says the
 * supervisor's attempt in full (round 6, defect 19).
 */
export function executionTitle(node: Pick<TrackNode, "label" | "detail" | "lanes" | "children">): string {
  // As tracks/relations.ts reads it: from the execution's or its claim's ids or attrs.
  let attempt: string | undefined;
  for (const n of [node, ...node.children.filter((c) => c.kind === "claim")]) {
    for (const lane of n.lanes) {
      for (const span of lane.spans) {
        if (span.kind !== "execution" && span.kind !== "claim") continue;
        const a = span.ids.attempt || (span.attrs.attempt !== undefined ? String(span.attrs.attempt) : "");
        if (a) attempt = a;
      }
    }
  }
  const head = [node.label, node.detail].filter(Boolean).join(" — ");
  return `${head}; ${attempt ? `supervisor attempt ${attempt}` : "no supervisor attempt recorded"}`;
}
