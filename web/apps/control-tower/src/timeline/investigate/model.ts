/**
 * The investigation lenses' derivations (M6.3, investigate/): pure functions of the spans of the
 * fetched window, the marks of that window and the live edge. No DOM, no React, so they are tested
 * in plain node (test/timeline-investigate.test.mjs).
 *
 * Rules held here, for every lens:
 * - nothing is said that no record supports: a verdict comes from a mark or a recorded outcome, a
 *   difference between two attempts only from fields both records carry, a dependency link only to an
 *   instant that is in the data, "resumed" only when a later record shows the work taken up again;
 * - nothing after `liveAt` is known: spans and marks beyond it are not used;
 * - review rounds and execution attempts are different things and are never nested in each other;
 * - the approval of the code by a person and the authorization to merge are different records.
 */
import { extentOf, outcomeKnownAt, type ConcurrencySeries, type SpanKind, type TimelineMark, type TimelineSpan, type TimeWindow } from "../contract";

// ---------------------------------------------------------------- shared readers

/** The ticket a ref is about: `cell:T`, `visit:T/…`, `station:T/…`, `seat:T/…`, `gate:T/…`, `slice-wait…` excluded. */
export function ticketOfRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const m = /^(cell|visit|station|seat|gate):([^/#@]+)/.exec(ref);
  return m ? m[2]! : null;
}

export function ticketOf(span: TimelineSpan): string | null {
  const t = span.ids.ticket_id;
  if (t) return t;
  if (span.parent?.startsWith("cell:")) return span.parent.slice(5);
  return ticketOfRef(span.entity);
}

export function sliceOf(span: TimelineSpan): string | null {
  if (span.ids.slice_id) return span.ids.slice_id;
  if (span.entity.startsWith("slice:")) return span.entity.slice(6);
  return null;
}

/** When a span starts as recorded (the earliest bound when only bounded), or null. */
export function startAt(span: TimelineSpan): number | null {
  const s = span.start;
  if (!s) return null;
  return s.at ?? s.notBefore ?? null;
}

/**
 * An execution's run number among its cell's executions, the same naming as the tracks ("run 2 of 3"):
 * order by recorded start, executions not started by `liveAt` not counted. The supervisor's own
 * `attempt` number is a different fact (it can repeat across executions) and is not this.
 */
export function runOf(exec: TimelineSpan, spans: readonly TimelineSpan[], liveAt: number): { readonly index: number; readonly of: number } | null {
  const ticket = ticketOf(exec);
  const at = startAt(exec);
  if (!ticket || at === null || at > liveAt) return null;
  const seen = new Set<string>();
  const list = spans
    .filter((s) => s.kind === "execution" && ticketOf(s) === ticket && (startAt(s) ?? Infinity) <= liveAt && !seen.has(s.entity) && seen.add(s.entity))
    .sort((a, b) => startAt(a)! - startAt(b)! || (a.entity < b.entity ? -1 : 1));
  const i = list.findIndex((s) => s.entity === exec.entity);
  return i < 0 ? null : { index: i + 1, of: list.length };
}

/** "run 2 of 3", or "the only run". */
export const runWords = (r: { index: number; of: number }): string => (r.of > 1 ? `run ${r.index} of ${r.of}` : "the only run");

/** The supervisor's recorded attempt number, or null. */
export const attemptOf = (s: TimelineSpan): number | null => s.attrs.attempt ?? (s.ids.attempt ? Number(s.ids.attempt) : null);

/** When a span ends as recorded, or null while open or not known. */
export function endAt(span: TimelineSpan): number | null {
  const e = span.end;
  if (!e) return null;
  return e.at ?? e.notAfter ?? e.notBefore ?? null;
}

/** The end as of `liveAt`: null when the span is open there (no end yet, or an end after what is held). */
export function endBy(span: TimelineSpan, liveAt: number): number | null {
  const e = endAt(span);
  return e !== null && e <= liveAt ? e : null;
}

/** The station a visit is at: its id, its action, or its entity `visit:T/<station>#n`. */
export function stationOf(span: TimelineSpan): string | null {
  if (span.ids.station) return span.ids.station;
  const m = /^visit:[^/]+\/([^#/]+)/.exec(span.entity);
  if (m) return m[1]!;
  return span.attrs.action ?? null;
}

function roundOf(span: TimelineSpan): number | null {
  const r = span.attrs.round ?? (span.ids.round !== undefined ? Number(span.ids.round) : null);
  return r !== null && Number.isFinite(r) && r > 0 ? r : null;
}

/** The execution a visit was made in, as an entity ref: its parent when that is an execution, else its recorded execution id. */
export function executionOfVisit(span: TimelineSpan): string | null {
  if (span.parent?.startsWith("execution:")) return span.parent;
  return span.ids.execution_id ? `execution:${span.ids.execution_id}` : null;
}

const byStart = (a: TimelineSpan, b: TimelineSpan) => (startAt(a) ?? endAt(a) ?? 0) - (startAt(b) ?? endAt(b) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function held(spans: readonly TimelineSpan[], liveAt: number): TimelineSpan[] {
  return spans.filter((s) => {
    const t = startAt(s) ?? endAt(s);
    return t !== null && t <= liveAt;
  });
}

/** A record a figure comes from, named for the hover: what it is and which event or span. */
export interface Source {
  readonly what: string;
  readonly ref: string;
  readonly eventId: string | null;
}

export const spanSource = (s: TimelineSpan, what: string): Source => ({ what, ref: s.entity, eventId: s.end?.eventId ?? s.start?.eventId ?? null });
export const markSource = (m: TimelineMark, what: string): Source => ({ what, ref: m.id, eventId: m.eventId });

/** Padding around what a lens frames, as a share of its length (and at least a minute each side). */
const FRAME_PAD = 0.05;

/**
 * The padded extent of `spans` (X15): from the earliest start to the latest recorded instant (an open
 * span counts by its start), padded 5% each side. Null when none has a time.
 */
/**
 * The entity refs a Frame concerns, for bringing their rows into view: each span's own ref, then its
 * parent's (a wait on a person has no row of its own in the Execution grouping; its cell names the
 * executions that do). In order, without repeats.
 */
export function frameAbout(spans: readonly (TimelineSpan | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const s of spans) if (s) out.add(s.entity);
  for (const s of spans) if (s?.parent) out.add(s.parent);
  return [...out];
}

export function frameOf(spans: readonly TimelineSpan[]): TimeWindow | null {
  let from = Infinity;
  let to = -Infinity;
  for (const s of spans) {
    const x = extentOf(s);
    if (!x) continue;
    from = Math.min(from, x.from);
    to = Math.max(to, Number.isFinite(x.to) ? x.to : x.from);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const pad = Math.max(60_000, (to - from) * FRAME_PAD);
  return { from: from - pad, to: to + pad };
}

// ---------------------------------------------------------------- 1. retries: the build → verify ladder

export type VerdictKind = "failed" | "refused" | "overridden" | "passed" | "none";

export interface RungVerdict {
  readonly kind: VerdictKind;
  readonly at: number | null;
  /** The mark it was read from, or null when read from the visit's recorded outcome (or none recorded). */
  readonly mark: TimelineMark | null;
  /** Checks named by the record ("3 of 5 checks"), else null. */
  readonly checks: string | null;
  readonly sources: readonly Source[];
}

export type FollowedKind = "revise" | "review" | "other" | "nothing-yet";

export interface Rung {
  /** 1-based, in time order: the n-th pass through build → verify. */
  readonly index: number;
  readonly ticket: string;
  /** The build or revise visit (null when a verification had no build visit before it in the window). */
  readonly build: TimelineSpan | null;
  readonly verify: TimelineSpan | null;
  readonly verdict: RungVerdict;
  readonly followed: { readonly kind: FollowedKind; readonly station: string | null; readonly span: TimelineSpan | null };
  /** The rung's first recorded instant: the comparison's zero. */
  readonly first: number;
}

/** A labelled run over the ladder's slots (two per rung: build, verify). Rounds and attempts each get their own. */
export interface SlotRun {
  readonly label: string;
  /** The entity to reveal. */
  readonly ref: string;
  readonly fromSlot: number;
  readonly toSlot: number;
  readonly from: number | null;
  readonly to: number | null;
  readonly span: TimelineSpan | null;
  readonly endReason: string | null;
  /** For an execution: the supervisor's recorded attempt number (hover card only; it can repeat). */
  readonly attempt?: number | null;
}

export interface Ladder {
  readonly ticket: string;
  readonly rungs: readonly Rung[];
  /** Review rounds, as recorded on the visits (`round`). Bracketed above the ladder. */
  readonly rounds: readonly SlotRun[];
  /** Execution attempts the visits were made in. A rail below the ladder. */
  readonly attempts: readonly SlotRun[];
  /** Visits whose round is not recorded / whose execution is not recorded. */
  readonly unroundedSlots: number;
  readonly unattemptedSlots: number;
}

const isVerifyMark = (m: TimelineMark, ticket: string, verify: TimelineSpan): boolean => {
  if (m.entity === verify.entity) return true;
  if (m.entity && new RegExp(`^gate:${escapeRe(ticket)}/verif`).test(m.entity)) return true;
  return m.entity === `cell:${ticket}` && /verif/i.test(m.label);
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "3 of 5 checks", "4 checks": only when a record's own words carry the number. */
export function checksIn(label: string): string | null {
  const m = /(\d+)\s+(?:of\s+(\d+)\s+)?checks?\b/i.exec(label);
  if (!m) return null;
  return m[2] ? `${m[1]} of ${m[2]} checks` : `${m[1]} check${m[1] === "1" ? "" : "s"}`;
}

/**
 * Whether a gate mark records the verification's own decision: `verify.verdict` or `verify.finish`
 * (the lifecycle log's gate names), or the simulation's `verification` gate. `verify.start` passing
 * only means the verification began: a running or crashed verification never reads "passed" (T7).
 */
export function decidesVerification(m: TimelineMark): boolean {
  return /\bGate (verify\.verdict|verify\.finish|verification)\b/.test(m.label);
}

/** The verification's verdict: from the marks recorded for it within the visit, else its recorded outcome, else none. */
export function verdictOf(verify: TimelineSpan, ticket: string, marks: readonly TimelineMark[], liveAt: number): RungVerdict {
  const s = startAt(verify);
  const e = endBy(verify, liveAt);
  const until = Math.min(liveAt, (e ?? liveAt) + 1000);
  const mine = marks.filter((m) => (m.kind === "failure" || m.kind === "gate") && m.at <= liveAt && (s === null || m.at >= s) && m.at <= until && isVerifyMark(m, ticket, verify));
  const pick = (pred: (m: TimelineMark) => boolean) => mine.find(pred) ?? null;
  const failure = pick((m) => m.kind === "failure");
  const refused = pick((m) => m.kind === "gate" && m.verdict === "refused");
  const overridden = pick((m) => m.kind === "gate" && m.verdict === "overridden");
  const passed = pick((m) => m.kind === "gate" && m.verdict === "passed" && decidesVerification(m));
  const checks = mine.map((m) => checksIn(m.label)).find((c) => c !== null) ?? null;
  const from = (kind: VerdictKind, m: TimelineMark, what: string): RungVerdict => ({ kind, at: m.at, mark: m, checks, sources: [markSource(m, what)] });
  if (failure) return from("failed", failure, "failure mark");
  if (refused) return from("refused", refused, "gate decision (refused)");
  if (overridden) return from("overridden", overridden, "gate decision (overridden)");
  if (passed) return from("passed", passed, "gate decision (passed)");
  if (outcomeKnownAt(verify, liveAt) && verify.outcome) {
    const o = verify.outcome.toLowerCase();
    const kind: VerdictKind = /pass/.test(o) ? "passed" : /fail|reject|incomplete/.test(o) ? "failed" : /refus/.test(o) ? "refused" : "none";
    if (kind !== "none") return { kind, at: e, mark: null, checks, sources: [spanSource(verify, `verification visit's recorded outcome (${verify.outcome})`)] };
  }
  return { kind: "none", at: null, mark: null, checks, sources: [] };
}

const isBuild = (st: string | null) => st === "build" || st === "revise";

/**
 * The build → verify ladder of one cell: one rung per pass, in time order. A build or revise visit
 * opens a rung; the next verification closes it. Rounds and execution attempts are read from the
 * visits as recorded and laid over the rungs' slots independently.
 */
export function ladderOf(ticket: string, spans: readonly TimelineSpan[], marks: readonly TimelineMark[], liveAt: number): Ladder {
  const visits = held(spans, liveAt)
    .filter((s) => s.kind === "visit" && ticketOf(s) === ticket)
    .sort(byStart);
  interface Draft {
    build: TimelineSpan | null;
    verify: TimelineSpan | null;
  }
  const drafts: Draft[] = [];
  for (const v of visits) {
    const st = stationOf(v);
    if (isBuild(st)) drafts.push({ build: v, verify: null });
    else if (st === "verify") {
      const last = drafts[drafts.length - 1];
      if (last && last.verify === null) last.verify = v;
      else drafts.push({ build: null, verify: v });
    }
  }
  const rungs: Rung[] = drafts.map((d, i) => {
    const anchor = d.verify ?? d.build!;
    const verdict = d.verify ? verdictOf(d.verify, ticket, marks, liveAt) : { kind: "none" as const, at: null, mark: null, checks: null, sources: [] };
    const after = startAt(anchor) ?? 0;
    const next = visits.find((v) => v !== d.build && v !== d.verify && (startAt(v) ?? 0) > after && (startAt(v) ?? Infinity) <= liveAt) ?? null;
    const nst = next ? stationOf(next) : null;
    const followed = !d.verify || !next ? { kind: "nothing-yet" as const, station: null, span: null } : { kind: (isBuild(nst) ? "revise" : nst === "review" ? "review" : "other") as FollowedKind, station: nst, span: next };
    const firsts = [d.build, d.verify].map((s) => (s ? startAt(s) : null)).filter((t): t is number => t !== null);
    return { index: i + 1, ticket, build: d.build, verify: d.verify, verdict, followed, first: firsts.length ? Math.min(...firsts) : 0 };
  });

  // Slots: rung i holds slot 2i (build) and 2i + 1 (verify).
  const slots: Array<TimelineSpan | null> = [];
  for (const r of rungs) slots.push(r.build, r.verify);

  const runs = (key: (v: TimelineSpan) => string | null, make: (k: string, first: TimelineSpan) => Omit<SlotRun, "fromSlot" | "toSlot">): { runs: SlotRun[]; missing: number } => {
    const out: SlotRun[] = [];
    let missing = 0;
    let open: { k: string; from: number; to: number; first: TimelineSpan } | null = null;
    const flush = () => {
      if (open) out.push({ ...make(open.k, open.first), fromSlot: open.from, toSlot: open.to });
      open = null;
    };
    slots.forEach((v, i) => {
      if (!v) return;
      const k = key(v);
      if (k === null) {
        missing += 1;
        flush();
        return;
      }
      if (open && open.k === k) open.to = i;
      else {
        flush();
        open = { k, from: i, to: i, first: v };
      }
    });
    flush();
    return { runs: out, missing };
  };

  const roundSpans = spans.filter((s) => s.kind === "round" && ticketOf(s) === ticket);
  const rounds = runs(
    (v) => {
      const r = roundOf(v);
      return r === null ? null : String(r);
    },
    (k) => {
      const span = roundSpans.find((s) => String(roundOf(s)) === k) ?? null;
      return { label: `Round ${k}`, ref: span?.entity ?? `gate:${ticket}/round#${k}`, from: span ? startAt(span) : null, to: span ? endBy(span, liveAt) : null, span, endReason: span && endBy(span, liveAt) !== null ? (span.end?.reason ?? null) : null };
    },
  );
  const execSpans = spans.filter((s) => s.kind === "execution");
  const attempts = runs(executionOfVisit, (k) => {
    const span = execSpans.find((s) => s.entity === k) ?? null;
    const run = span ? runOf(span, execSpans, liveAt) : null;
    const words = run ? runWords(run) : "execution not held";
    return { label: `${words[0]!.toUpperCase()}${words.slice(1)}`, attempt: span ? attemptOf(span) : null, ref: k, from: span ? startAt(span) : null, to: span ? endBy(span, liveAt) : null, span, endReason: span && endBy(span, liveAt) !== null ? (span.end?.reason ?? null) : null };
  });
  return { ticket, rungs, rounds: rounds.runs, attempts: attempts.runs, unroundedSlots: rounds.missing, unattemptedSlots: attempts.missing };
}

/** Whether a ladder is worth showing unselected: more than one build or verify visit, or a failed verification. */
export function hasRetries(l: Ladder): boolean {
  return l.rungs.length > 1 || l.rungs.some((r) => r.verdict.kind === "failed" || r.verdict.kind === "refused");
}

/** The cells the retries lens shows: the selected one, else every cell in the window with retries (at most `limit`). */
export function retryLadders(spans: readonly TimelineSpan[], marks: readonly TimelineMark[], liveAt: number, selectedTicket: string | null, limit = 6): { ladders: Ladder[]; more: number } {
  if (selectedTicket) {
    const l = ladderOf(selectedTicket, spans, marks, liveAt);
    return { ladders: l.rungs.length ? [l] : [], more: 0 };
  }
  const tickets: string[] = [];
  for (const s of [...spans].sort(byStart)) {
    if (s.kind !== "visit") continue;
    const t = ticketOf(s);
    if (t && !tickets.includes(t)) tickets.push(t);
  }
  const all = tickets.map((t) => ladderOf(t, spans, marks, liveAt)).filter(hasRetries);
  return { ladders: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

/** One rung's parts on a time axis relative to its first instant. */
export interface RungTiming {
  readonly part: "build" | "verify";
  readonly span: TimelineSpan;
  readonly from: number;
  /** Null while open at the live edge. */
  readonly to: number | null;
}

export function rungTimings(r: Rung, liveAt: number): RungTiming[] {
  const out: RungTiming[] = [];
  for (const [part, s] of [
    ["build", r.build],
    ["verify", r.verify],
  ] as const) {
    if (!s) continue;
    const a = startAt(s);
    if (a === null) continue;
    const b = endBy(s, liveAt);
    out.push({ part, span: s, from: a - r.first, to: b === null ? null : b - r.first });
  }
  return out;
}

const VERDICT_WORDS: Readonly<Record<VerdictKind, string>> = { failed: "failed", refused: "gate refused", overridden: "gate overridden", passed: "passed", none: "no verdict recorded" };
export const verdictWords = (k: VerdictKind): string => VERDICT_WORDS[k];

const followedWords = (r: Rung): string => (r.followed.kind === "revise" ? "a revise visit" : r.followed.kind === "review" ? "review" : r.followed.station ? `a ${r.followed.station} visit` : "nothing yet");

/**
 * What differs between two rungs, in words, only where both records carry the fact: the verdict, the
 * number of checks, the visit that followed, the round and the execution attempt. Durations are shown
 * side by side by the caller with their basis; they are not turned into a claim here.
 */
export function compareRungs(a: Rung, b: Rung, ladder: Ladder): string[] {
  const out: string[] = [];
  const A = `pass ${a.index}`;
  const B = `pass ${b.index}`;
  if (a.verdict.kind !== "none" && b.verdict.kind !== "none" && a.verdict.kind !== b.verdict.kind) out.push(`Verdict: ${A} ${verdictWords(a.verdict.kind)}, ${B} ${verdictWords(b.verdict.kind)}.`);
  if (a.verdict.checks && b.verdict.checks && a.verdict.checks !== b.verdict.checks) out.push(`Checks recorded: ${A} ${a.verdict.checks}, ${B} ${b.verdict.checks}.`);
  if (a.followed.kind !== "nothing-yet" && b.followed.kind !== "nothing-yet" && followedWords(a) !== followedWords(b)) out.push(`What followed: ${A} went to ${followedWords(a)}, ${B} to ${followedWords(b)}.`);
  const roundAt = (r: Rung) => {
    const v = r.verify ?? r.build;
    return v ? roundOf(v) : null;
  };
  const ra = roundAt(a);
  const rb = roundAt(b);
  if (ra !== null && rb !== null && ra !== rb) out.push(`Review round: ${A} in round ${ra}, ${B} in round ${rb}.`);
  const attemptAt = (r: Rung) => {
    const v = r.verify ?? r.build;
    const ref = v ? executionOfVisit(v) : null;
    return ref ? (ladder.attempts.find((x) => x.ref === ref)?.label ?? null) : null;
  };
  const xa = attemptAt(a);
  const xb = attemptAt(b);
  if (xa && xb && xa !== xb && !/not held/.test(xa + xb)) out.push(`Execution: ${A} ran in ${xa.toLowerCase()}, ${B} in ${xb.toLowerCase()}.`);
  return out;
}

// ---------------------------------------------------------------- 2. parallel execution

export type ConcurrencyLineKind = "execution" | "visit" | "agent";

export interface Step {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

export interface ConcurrencyLine {
  readonly kind: ConcurrencyLineKind;
  readonly label: string;
  readonly steps: readonly Step[];
  /**
   * Of each step's count, how many are spans whose end is inferred or bounded (a visit that ended
   * without an exit record; the data layer's per-bucket `inferredMax`): drawn as a lighter band above
   * the recorded part. Same breaks as `steps`; empty when the source does not say.
   */
  readonly inferred: readonly Step[];
  /** The most such spans in one bucket of the window (0 when none or not said). */
  readonly inferredPeak: number;
  readonly peak: number;
  readonly peakAt: number | null;
}

export interface LimitLine {
  readonly value: number;
  readonly from: number;
  readonly to: number;
  /** What the limit counts, as recorded (`appliesTo`); "executions" when the record does not say. */
  readonly appliesTo: string;
}

export type LaneSegmentKind = "station" | "capacity" | "eligible" | "claim";

export interface LaneSegment {
  readonly kind: LaneSegmentKind;
  readonly span: TimelineSpan;
  readonly from: number;
  /** Null while open at the live edge. */
  readonly to: number | null;
}

export interface CellLane {
  readonly key: string;
  readonly label: string;
  readonly ref: string;
  readonly segments: readonly LaneSegment[];
}

export interface ConcurrencyView {
  readonly lines: readonly ConcurrencyLine[];
  readonly limits: readonly LimitLine[];
  readonly lanes: readonly CellLane[];
  readonly yMax: number;
}

const LINE_LABEL: Readonly<Record<ConcurrencyLineKind, string>> = { execution: "executions running", visit: "cells in a station", agent: "agents working" };

/** The stepped lines, the recorded `max_parallel` limits, and per cell when it was in a station, waiting, eligible or claimed. */
export function concurrencyView(series: ConcurrencySeries | null, spans: readonly TimelineSpan[], window: TimeWindow, liveAt: number): ConcurrencyView {
  const lines: ConcurrencyLine[] = [];
  if (series && series.buckets.length) {
    for (const kind of ["execution", "visit", "agent"] as const) {
      const steps: Step[] = [];
      const inferred: Step[] = [];
      let said = false;
      let inferredPeak = 0;
      let peak = 0;
      let peakAt: number | null = null;
      series.buckets.forEach((b, i) => {
        const from = b.from;
        const to = series.buckets[i + 1]?.from ?? Math.min(series.to, from + series.bucketMs);
        if (from > liveAt) return;
        const a = b.active[kind] as { max: number; inferredMax?: number } | undefined;
        const count = a?.max ?? 0;
        const inf = Math.min(count, Math.max(0, a?.inferredMax ?? 0));
        if (a?.inferredMax !== undefined) said = true;
        if (inf > inferredPeak) inferredPeak = inf;
        const last = steps[steps.length - 1];
        const lastInf = inferred[inferred.length - 1];
        if (last && lastInf && last.count === count && lastInf.count === inf && last.to === from) {
          steps[steps.length - 1] = { ...last, to: Math.min(to, liveAt) };
          inferred[inferred.length - 1] = { ...lastInf, to: Math.min(to, liveAt) };
        } else {
          steps.push({ from, to: Math.min(to, liveAt), count });
          inferred.push({ from, to: Math.min(to, liveAt), count: inf });
        }
        if (count > peak) {
          peak = count;
          peakAt = from;
        }
      });
      if (steps.some((s) => s.count > 0)) lines.push({ kind, label: LINE_LABEL[kind], steps, inferred: said ? inferred : [], inferredPeak, peak, peakAt });
    }
  }
  const limits: LimitLine[] = (series?.limits ?? [])
    .filter((l) => l.name === "max_parallel" && Number.isFinite(l.value))
    .map((l) => ({ value: l.value, from: Math.max(l.from, window.from), to: Math.min(l.to ?? liveAt, window.to, liveAt), appliesTo: String((l as { appliesTo?: unknown }).appliesTo ?? "executions") }))
    .filter((l) => l.to > l.from);
  // Headroom above the highest line or limit, so a peak is never drawn on the frame's edge (X14).
  const top = Math.max(1, ...lines.map((l) => l.peak), ...limits.map((l) => l.value));
  const yMax = top + Math.max(1, Math.ceil(top * 0.2));

  const lanes = new Map<string, { label: string; ref: string; segments: LaneSegment[]; first: number }>();
  const KIND: Partial<Record<SpanKind, LaneSegmentKind>> = { visit: "station", "capacity-wait": "capacity", "slice-eligible": "eligible", claim: "claim" };
  // A slice's own wait (a ready slice held for a free place names only its slice) goes on its cell's
  // lane, beside its eligibility, when a span records which cell the slice became.
  const sliceCell = new Map<string, string>();
  for (const s of spans) if (s.ids.slice_id && s.ids.ticket_id && !sliceCell.has(s.ids.slice_id)) sliceCell.set(s.ids.slice_id, s.ids.ticket_id);
  for (const s of held(spans, liveAt)) {
    const kind = KIND[s.kind];
    if (!kind) continue;
    const from = startAt(s);
    if (from === null) continue;
    const t = ticketOf(s) ?? (s.ids.slice_id ? (sliceCell.get(s.ids.slice_id) ?? null) : null);
    const sl = sliceOf(s);
    const key = t ? `cell:${t}` : sl ? `slice:${sl}` : null;
    if (!key) continue;
    const lane = lanes.get(key) ?? { label: t ?? sl!, ref: key, segments: [], first: from };
    lane.segments.push({ kind, span: s, from, to: endBy(s, liveAt) });
    lane.first = Math.min(lane.first, from);
    lanes.set(key, lane);
  }
  return {
    lines,
    limits,
    yMax,
    lanes: [...lanes.entries()].sort((a, b) => a[1].first - b[1].first || (a[0] < b[0] ? -1 : 1)).map(([key, l]) => ({ key, label: l.label, ref: l.ref, segments: l.segments.sort((a, b) => a.from - b.from) })),
  };
}

const LINE_KINDS: Readonly<Record<ConcurrencyLineKind, SpanKind>> = { execution: "execution", visit: "visit", agent: "agent" };

/** The spans of a line's kind active at `t`: what a count at that moment is made of, for the hover and the reveal. */
export function activeAt(spans: readonly TimelineSpan[], kind: ConcurrencyLineKind, t: number, liveAt: number): TimelineSpan[] {
  return spans.filter((s) => {
    if (s.kind !== LINE_KINDS[kind]) return false;
    const a = startAt(s);
    const b = endBy(s, liveAt) ?? liveAt;
    return a !== null && a <= t && t < Math.max(b, a + 1);
  });
}

// ---------------------------------------------------------------- 3. dependency waits

export interface DependencyLink {
  readonly slice: string;
  /** The dependency's own completion or integration instant, when it is in the data; else null. */
  readonly instant: { readonly at: number; readonly ref: string; readonly what: string; readonly source: Source } | null;
}

export interface WaitItem {
  readonly span: TimelineSpan;
  readonly slice: string;
  readonly ticket: string | null;
  readonly from: number;
  /** Null while still waiting at the live edge. */
  readonly to: number | null;
  /** The record that ended the wait (its end event), when recorded. */
  readonly ended: { readonly at: number; readonly eventId: string | null } | null;
  readonly dependencies: readonly DependencyLink[];
  readonly reasons: readonly string[];
  /** Always true today: no record links a wait's end to a specific dependency's event. */
  readonly releaseNotRecorded: boolean;
}

export const RELEASE_NOT_RECORDED = "The records name the dependency; they do not say which event released it.";

/** Each dependency wait in the window, its dependencies, and their own completion instants where the data holds them. */
export function waitItems(spans: readonly TimelineSpan[], marks: readonly TimelineMark[], liveAt: number): WaitItem[] {
  const sliceOfTicket = new Map<string, string>();
  for (const s of spans) {
    const t = ticketOf(s);
    const sl = s.ids.slice_id;
    if (t && sl && !sliceOfTicket.has(t)) sliceOfTicket.set(t, sl);
  }
  const instantOf = (slice: string): DependencyLink["instant"] => {
    // A cell of that slice ended merged (its own span), or a merge mark for one of its cells.
    for (const s of spans) {
      if (s.kind !== "cell" || sliceOf(s) !== slice) continue;
      const e = endBy(s, liveAt);
      if (e !== null && outcomeKnownAt(s, liveAt) && /merged|integrated|completed/i.test(s.outcome ?? "")) return { at: e, ref: s.entity, what: `${slice} ${s.outcome!.toLowerCase()}`, source: spanSource(s, `cell ${ticketOf(s) ?? ""} ended ${s.outcome!.toLowerCase()}`.replace("  ", " ")) };
    }
    for (const m of marks) {
      if (m.kind !== "merge" || m.at > liveAt) continue;
      const t = ticketOfRef(m.entity);
      if (t && sliceOfTicket.get(t) === slice) return { at: m.at, ref: m.entity ?? `slice:${slice}`, what: `${slice} merged`, source: markSource(m, "merge mark") };
    }
    return null;
  };
  return held(spans, liveAt)
    .filter((s) => s.kind === "slice-wait")
    .sort(byStart)
    .flatMap((s) => {
      const from = startAt(s);
      const slice = sliceOf(s);
      if (from === null || !slice) return [];
      const to = endBy(s, liveAt);
      return [
        {
          span: s,
          slice,
          ticket: s.ids.ticket_id ?? null,
          from,
          to,
          ended: to !== null ? { at: to, eventId: s.end?.eventId ?? null } : null,
          dependencies: (s.attrs.dependsOn ?? []).map((d) => ({ slice: d, instant: instantOf(d) })),
          reasons: s.attrs.reasons ?? [],
          releaseNotRecorded: true,
        },
      ];
    });
}

// ---------------------------------------------------------------- 4. review and human intervention

export interface SeatRow {
  readonly seat: string;
  readonly ref: string;
  readonly span: TimelineSpan | null;
  readonly from: number | null;
  readonly vote: string | null;
  readonly voteAt: number | null;
  readonly sources: readonly Source[];
}

export interface ReviewRound {
  readonly ticket: string;
  readonly round: number;
  readonly ref: string;
  readonly seats: readonly SeatRow[];
  readonly decision: { readonly verdict: string; readonly at: number; readonly mark: TimelineMark } | null;
  /** Only when the decision (or a gate decision of the round) records a security veto. */
  readonly securityVeto: TimelineMark | null;
  /** A person's approval asked for after this round, and given. */
  readonly human: { readonly from: number; readonly to: number | null; readonly ref: string; readonly sources: readonly Source[]; readonly approved: { readonly at: number; readonly ref: string; readonly source: Source } | null } | null;
}

export type MergeAuthority = "policy" | "person" | "not-recorded";

export interface CellReview {
  readonly ticket: string;
  readonly rounds: readonly ReviewRound[];
  /** A person's approval of the code (review's human approval), when recorded. */
  readonly codeApproval: { readonly at: number; readonly ref: string; readonly source: Source } | null;
  /** The authorization to merge, when recorded: by policy, by a person, or a merge whose authority is not recorded. */
  readonly merge: { readonly at: number; readonly authority: MergeAuthority; readonly ref: string; readonly source: Source } | null;
  /** Said when only one of the two is in the records. */
  readonly notes: readonly string[];
}

const seatOfRef = (ref: string): { ticket: string; round: number; seat: string } | null => {
  const m = /^seat:([^/]+)\/review#(\d+)\/(.+)$/.exec(ref);
  return m ? { ticket: m[1]!, round: Number(m[2]), seat: m[3]! } : null;
};

const voteWord = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const u = v.toUpperCase();
  if (u.startsWith("APPROVE")) return "approved";
  if (u.startsWith("REJECT")) return "rejected";
  if (u.startsWith("ESCALAT")) return "escalated";
  return v.toLowerCase().replace(/_/g, " ");
};

/** How a merge was authorized, from the record's own words; "not-recorded" when it says only that it merged. */
export function mergeAuthorityOf(m: TimelineMark): MergeAuthority {
  const words = `${m.verdict ?? ""} ${m.label}`.toLowerCase();
  if (/by a person|by-person|person merged|manual/.test(words)) return "person";
  if (/policy|auto/.test(words)) return "policy";
  return "not-recorded";
}

/** Review rounds per cell in the window: seats, verdicts, the decision, a person's gate after it, and the merge. */
export function reviewCells(spans: readonly TimelineSpan[], marks: readonly TimelineMark[], liveAt: number): CellReview[] {
  const hs = held(spans, liveAt);
  const hm = marks.filter((m) => m.at <= liveAt);
  const rounds = new Map<string, { ticket: string; round: number; seats: Map<string, SeatRow> }>();
  const roundKey = (t: string, r: number) => `${t}#${r}`;
  const ensure = (t: string, r: number) => {
    const k = roundKey(t, r);
    let x = rounds.get(k);
    if (!x) rounds.set(k, (x = { ticket: t, round: r, seats: new Map() }));
    return x;
  };
  for (const s of hs) {
    if (s.kind !== "seat") continue;
    const p = seatOfRef(s.entity);
    const t = p?.ticket ?? ticketOf(s);
    const r = p?.round ?? roundOf(s);
    if (!t || r === null) continue;
    const seat = p?.seat ?? s.ids.seat ?? "seat";
    const voteAt = endBy(s, liveAt);
    const vote = voteAt !== null ? voteWord(s.attrs.vote ?? s.outcome) : null;
    ensure(t, r).seats.set(seat, { seat, ref: s.entity, span: s, from: startAt(s), vote, voteAt: vote ? voteAt : null, sources: [spanSource(s, `review seat ${seat}`)] });
  }
  for (const m of hm) {
    if (m.kind !== "review" || !m.entity) continue;
    const p = seatOfRef(m.entity);
    if (!p) continue;
    const x = ensure(p.ticket, p.round);
    const prev = x.seats.get(p.seat);
    if (prev && prev.vote) continue;
    x.seats.set(p.seat, { seat: p.seat, ref: m.entity, span: prev?.span ?? null, from: prev?.from ?? null, vote: m.verdict ?? voteWord(m.label), voteAt: m.at, sources: [...(prev?.sources ?? []), markSource(m, `vote of the ${p.seat} seat`)] });
  }
  const decisions = new Map<string, TimelineMark>();
  for (const m of hm) {
    if (m.kind !== "review" || !m.entity) continue;
    const g = /^gate:([^/]+)\/review#(\d+)$/.exec(m.entity);
    if (!g) continue;
    ensure(g[1]!, Number(g[2]));
    if (!decisions.has(roundKey(g[1]!, Number(g[2])))) decisions.set(roundKey(g[1]!, Number(g[2])), m);
  }

  const tickets = [...new Set([...rounds.values()].map((r) => r.ticket))];
  const out: CellReview[] = [];
  for (const t of tickets) {
    const mine = [...rounds.values()].filter((r) => r.ticket === t).sort((a, b) => a.round - b.round);
    const humanWaits = hs.filter((s) => (s.kind === "gate-wait" || s.kind === "person-wait") && ticketOf(s) === t).sort(byStart);
    const humanMarks = hm.filter((m) => m.kind === "human" && ticketOfRef(m.entity) === t).sort((a, b) => a.at - b.at);
    const cellRounds: ReviewRound[] = mine.map((r, i) => {
      const dm = decisions.get(roundKey(t, r.round)) ?? null;
      const decision = dm ? { verdict: dm.verdict ?? voteWord(dm.label) ?? "decided", at: dm.at, mark: dm } : null;
      const nextStart = mine[i + 1] ? Math.min(...[...mine[i + 1]!.seats.values()].map((s) => s.from ?? s.voteAt ?? Infinity)) : Infinity;
      const after = decision?.at ?? Math.max(-Infinity, ...[...r.seats.values()].map((s) => s.voteAt ?? -Infinity));
      const vetoMark =
        (dm && /veto/i.test(`${dm.verdict ?? ""} ${dm.label}`) ? dm : null) ??
        hm.find((m) => (m.kind === "gate" || m.kind === "review") && ticketOfRef(m.entity) === t && /security.?veto/i.test(`${m.verdict ?? ""} ${m.label}`) && (decision ? Math.abs(m.at - decision.at) <= 60_000 : false)) ??
        null;
      // A person's gate after the decision and before the next round.
      let human: ReviewRound["human"] = null;
      const wait = humanWaits.find((s) => {
        const a = startAt(s) ?? 0;
        return (s.attrs.round === r.round || (a >= after && a < nextStart)) && s.kind === "gate-wait";
      });
      // Only an approval gate the review opened counts; the supervisor stopping for a person is the
      // recovery lens's "the line stopped for a person" (T14).
      const required = humanMarks.find((m) => m.verdict === "required" && m.at >= after && m.at < nextStart && reviewAskedForPerson(m, hs));
      if (wait || required) {
        const from = wait ? startAt(wait)! : required!.at;
        const until = wait ? endBy(wait, liveAt) : required!.until !== null && required!.until <= liveAt ? required!.until : null;
        const approvedMark = humanMarks.find((m) => m.verdict === "approved" && m.at >= from && m.at < nextStart) ?? null;
        const waitApproved = wait && until !== null && outcomeKnownAt(wait, liveAt) && /pass|approv|completed/i.test(wait.outcome ?? "") ? wait : null;
        const approved = approvedMark ? { at: approvedMark.at, ref: approvedMark.entity ?? `cell:${t}`, source: markSource(approvedMark, "a person's approval") } : waitApproved ? { at: until!, ref: waitApproved.entity, source: spanSource(waitApproved, `approval gate ended ${waitApproved.outcome}`) } : null;
        human = { from, to: until, ref: wait?.entity ?? required?.entity ?? `cell:${t}`, sources: [...(wait ? [spanSource(wait, "wait for a person's approval")] : []), ...(required ? [markSource(required, "a person's approval was required")] : [])], approved };
      }
      return {
        ticket: t,
        round: r.round,
        ref: `gate:${t}/review#${r.round}`,
        seats: [...r.seats.values()].sort((a, b) => SEAT_ORDER(a.seat) - SEAT_ORDER(b.seat) || (a.seat < b.seat ? -1 : 1)),
        decision,
        securityVeto: vetoMark,
        human,
      };
    });
    const approval = cellRounds.map((r) => r.human?.approved).find((a) => a) ?? (() => {
      const m = humanMarks.find((x) => x.verdict === "approved");
      return m ? { at: m.at, ref: m.entity ?? `cell:${t}`, source: markSource(m, "a person's approval") } : null;
    })();
    const mergeMark = hm.find((m) => m.kind === "merge" && ticketOfRef(m.entity) === t) ?? null;
    const policyGate = hm.find((m) => m.kind === "gate" && ticketOfRef(m.entity) === t && /merge/i.test(m.label) && /policy|auto/i.test(m.label) && m.verdict === "passed") ?? null;
    let merge: CellReview["merge"] = null;
    if (mergeMark) {
      const authority = mergeAuthorityOf(mergeMark);
      merge = { at: mergeMark.at, authority: authority === "not-recorded" && policyGate ? "policy" : authority, ref: mergeMark.entity ?? `cell:${t}`, source: markSource(mergeMark, "merge record") };
    } else if (policyGate) merge = { at: policyGate.at, authority: "policy", ref: policyGate.entity ?? `cell:${t}`, source: markSource(policyGate, "merge policy gate") };
    const notes: string[] = [];
    if (approval && !merge) notes.push("The authorization to merge is not recorded for this cell.");
    if (merge && !approval) notes.push("No approval of the code by a person is recorded for this cell.");
    if (merge && merge.authority === "not-recorded") notes.push("The merge is recorded; who or what authorized it is not.");
    out.push({ ticket: t, rounds: cellRounds, codeApproval: approval, merge, notes });
  }
  return out;
}

/** A "person required" mark the review opened (its approval gate), not the supervisor stopping for a person. */
export function reviewAskedForPerson(m: TimelineMark, spans: readonly TimelineSpan[]): boolean {
  if (/supervisor stopped|person was needed/i.test(m.label)) return false;
  if (spans.some((s) => s.entity === m.entity && s.kind === "person-wait")) return false;
  return spans.some((s) => s.entity === m.entity && s.kind === "gate-wait") || /review asked|approval was required/i.test(m.label);
}

function SEAT_ORDER(seat: string): number {
  const i = ["architecture", "security", "product", "general"].indexOf(seat);
  return i < 0 ? 9 : i;
}

// ---------------------------------------------------------------- 5. recovery and interruption

/**
 * "late-exit": a visit whose exit was recorded after its execution ended (`interruptedAt`): never by
 * itself a sign that work resumed (T4). "person": the line stopped for a person (a supervisor wait).
 */
export type RecoveryKind = "interrupted" | "unknown" | "no-exit" | "late-exit" | "person";

export interface RecoveryItem {
  readonly kind: RecoveryKind;
  readonly span: TimelineSpan;
  readonly ticket: string | null;
  readonly label: string;
  readonly from: number | null;
  /** Where the work stopped (or was last known): the recorded end, or the visit's `interruptedAt`. */
  readonly stoppedAt: number | null;
  readonly recoveries: readonly TimelineMark[];
  /** Only when a later record shows the work taken up again. */
  readonly resumed: { readonly at: number; readonly ref: string; readonly words: string; readonly source: Source } | null;
  readonly sources: readonly Source[];
}

const EXEC_KINDS: ReadonlySet<SpanKind> = new Set<SpanKind>(["execution", "claim"]);

/**
 * Interrupted executions, executions whose outcome is unknown, visits ended without an exit record,
 * visits stopped and taken up again, and the recoveries recorded for them. "Resumed" only when a
 * later record (the next attempt claiming the same cell, or the visit itself going on) shows it.
 */
export function recoveryItems(spans: readonly TimelineSpan[], marks: readonly TimelineMark[], liveAt: number): { items: RecoveryItem[]; looseRecoveries: TimelineMark[] } {
  const hs = held(spans, liveAt);
  const hm = marks.filter((m) => m.at <= liveAt);
  const recoveries = hm.filter((m) => m.kind === "recovery");
  const used = new Set<string>();
  const execs = hs.filter((s) => s.kind === "execution");
  const runOfExec = (x: TimelineSpan) => (x.kind === "execution" ? runOf(x, hs, liveAt) : null);

  const nextAttempt = (ticket: string | null, after: number, not: string): RecoveryItem["resumed"] => {
    if (!ticket) return null;
    const later = hs
      .filter((s) => EXEC_KINDS.has(s.kind) && s.entity !== not && ticketOf(s) === ticket && (startAt(s) ?? -Infinity) >= after)
      .sort(byStart)[0];
    if (!later) return null;
    const x = later.kind === "execution" ? later : (execs.find((e) => e.entity === later.entity) ?? later);
    const r = runOfExec(x);
    return { at: startAt(later)!, ref: later.entity, words: `taken up again by ${r ? runWords(r) : "a later execution"}`, source: spanSource(later, later.kind === "claim" ? "the next claim of the same cell" : "the next execution of the same cell") };
  };
  const recsFor = (ref: string) => {
    const r = recoveries.filter((m) => m.entity === ref);
    r.forEach((m) => used.add(m.id));
    return r;
  };

  const items: RecoveryItem[] = [];
  for (const s of hs.sort(byStart)) {
    const ticket = ticketOf(s);
    const e = endBy(s, liveAt);
    const reason = e !== null ? (s.end?.reason ?? null) : null;
    const outcome = e !== null && outcomeKnownAt(s, liveAt) ? (s.outcome ?? "").toLowerCase() : "";
    if (s.kind === "execution") {
      const unknown = reason === "unknown" || outcome === "unknown" || hm.some((m) => m.kind === "interruption" && m.entity === s.entity && m.verdict === "unknown");
      const interrupted = !unknown && (reason === "interrupted" || reason === "superseded" || /interrupt|timed.?out/.test(outcome));
      if (!unknown && !interrupted) continue;
      const r = runOfExec(s);
      const recs = recsFor(s.entity);
      const stop = e ?? recs[0]?.at ?? null;
      items.push({
        kind: unknown ? "unknown" : "interrupted",
        span: s,
        ticket,
        label: `${ticket ?? "Execution"}${r ? ` · ${runWords(r)}` : ""}`,
        from: startAt(s),
        stoppedAt: stop,
        recoveries: recs,
        resumed: stop !== null ? nextAttempt(ticket, stop, s.entity) : null,
        sources: [spanSource(s, unknown ? "execution whose outcome is not known" : "interrupted execution"), ...recs.map((m) => markSource(m, "recovery mark"))],
      });
    } else if (s.kind === "person-wait") {
      // The line stopped for a person (the supervisor's wait), not a review's approval gate.
      items.push({ kind: "person", span: s, ticket, label: `Stopped for a person${ticket ? ` · ${ticket}` : ""}`, from: startAt(s), stoppedAt: startAt(s), recoveries: recsFor(s.entity), resumed: null, sources: [spanSource(s, "the line stopped for a person")] });
    } else if (s.kind === "visit") {
      const st = stationOf(s) ?? "station";
      const name = `${st[0]!.toUpperCase()}${st.slice(1)} visit${ticket ? ` · ${ticket}` : ""}`;
      if (s.attrs.interruptedAt !== undefined && s.attrs.interruptedAt <= liveAt) {
        // Its exit was stamped after its execution ended: that is all `interruptedAt` says. Resumed only
        // when a later record shows it (a later execution of the same cell).
        const x = executionOfVisit(s);
        items.push({ kind: "late-exit", span: s, ticket, label: name, from: startAt(s), stoppedAt: s.attrs.interruptedAt, recoveries: recsFor(s.entity), resumed: nextAttempt(ticket, s.attrs.interruptedAt, x ?? ""), sources: [spanSource(s, "visit whose exit was recorded after its execution ended")] });
      } else if (e !== null && s.end?.basis === "inferred" && (reason === "interrupted" || reason === "superseded" || reason === "unknown")) {
        const x = executionOfVisit(s);
        items.push({ kind: "no-exit", span: s, ticket, label: name, from: startAt(s), stoppedAt: e, recoveries: recsFor(s.entity), resumed: nextAttempt(ticket, e, x ?? ""), sources: [spanSource(s, "visit ended without an exit record")] });
      }
    }
  }
  return { items, looseRecoveries: recoveries.filter((m) => !used.has(m.id)) };
}

/** A figure's name: its visible words first when the description does not already hold them. */
export function figureName(name: string, visible: string): string {
  if (!visible || name.toLowerCase().includes(visible.toLowerCase())) return name;
  return `${visible}: ${name}`;
}
