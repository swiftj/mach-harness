/**
 * Helpers the investigation lenses read (additive to the contract's tracks API): what sits on one
 * track, a track's ancestors, a ticket's judging rounds with their visits and seats, and a ticket's
 * execution attempts with the visits made during each. Pure, over spans and the tree only.
 *
 * Rounds and attempts are different counts and are never nested in each other: an attempt is one
 * execution of the ticket, a round one judging pass. An attempt may span a round boundary, so the
 * same round's visits can fall in two attempts. Which attempt a visit belongs to is read from the
 * visit's own record (`execution_id`, or a parent that is an execution) where it is recorded, and
 * otherwise from time overlap only, which is said as such (`by: "overlap"`): order in time, not a link.
 */
import { extentOf, type DurationBasis, type TimelineSpan, type TrackNode, type TrackTree } from "../contract";

const startOf = (s: TimelineSpan): number => extentOf(s)?.from ?? Number.POSITIVE_INFINITY;
const byStart = (a: TimelineSpan, b: TimelineSpan): number => startOf(a) - startOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const intOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

/** The spans on a track's own lanes (not its children's, not its ribbons), in time order. Empty for an unknown track. */
export function spansOnTrack(tree: TrackTree, trackId: string): TimelineSpan[] {
  const node = tree.byId.get(trackId);
  if (!node) return [];
  const out: TimelineSpan[] = [];
  for (const lane of node.lanes) for (const s of lane.spans) out.push(s);
  return out.sort(byStart);
}

/** A track's ancestors, the root first (the track itself excluded). Empty for a root or an unknown track. */
export function ancestorsOf(tree: TrackTree, trackId: string): TrackNode[] {
  const out: TrackNode[] = [];
  let node = tree.byId.get(trackId);
  while (node?.parentId) {
    const parent = tree.byId.get(node.parentId);
    if (!parent) break;
    out.unshift(parent);
    node = parent;
  }
  return out;
}

/** The bounds of a span as recorded: `to` null while open; with how its length is known. */
export interface Bounds {
  readonly from: number | null;
  readonly to: number | null;
  readonly basis: DurationBasis;
}

function boundsOf(span: TimelineSpan | null, members: readonly TimelineSpan[]): Bounds {
  if (span) {
    const x = extentOf(span);
    return { from: x ? x.from : null, to: span.end ? (x && Number.isFinite(x.to) ? x.to : null) : null, basis: span.duration.basis };
  }
  // No span for it: the bounds of what was recorded in it, never more.
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  let open = false;
  for (const s of members) {
    const x = extentOf(s);
    if (!x) continue;
    from = Math.min(from, x.from);
    if (!Number.isFinite(x.to)) open = true;
    else to = Math.max(to, x.to);
  }
  if (!Number.isFinite(from)) return { from: null, to: null, basis: "unknown" };
  return { from, to: open || !Number.isFinite(to) ? null : to, basis: open ? "open" : "unknown" };
}

export interface RoundOf {
  readonly round: number;
  /** The round's own span (`round`), when recorded. */
  readonly span: TimelineSpan | null;
  readonly bounds: Bounds;
  /** Station visits of the round, in time order. */
  readonly visits: readonly TimelineSpan[];
  /** Review seats of the round, in time order. */
  readonly seats: readonly TimelineSpan[];
}

const ticketIs = (s: TimelineSpan, ticket: string): boolean => s.ids.ticket_id === ticket;
const roundOfSpan = (s: TimelineSpan): number | null => intOf(s.ids.round) ?? intOf(s.attrs.round);

/** A ticket's judging rounds in order, each with its visits and review seats in time order. */
export function roundsOf(spans: readonly TimelineSpan[], ticket: string): RoundOf[] {
  const rounds = new Map<number, { span: TimelineSpan | null; visits: TimelineSpan[]; seats: TimelineSpan[] }>();
  const of = (n: number) => {
    let r = rounds.get(n);
    if (!r) rounds.set(n, (r = { span: null, visits: [], seats: [] }));
    return r;
  };
  for (const s of spans) {
    if (!ticketIs(s, ticket)) continue;
    if (s.kind !== "round" && s.kind !== "visit" && s.kind !== "seat") continue;
    const n = roundOfSpan(s);
    if (n === null) continue;
    const r = of(n);
    if (s.kind === "round") r.span = s;
    else if (s.kind === "visit") r.visits.push(s);
    else r.seats.push(s);
  }
  return [...rounds.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, r]) => ({ round, span: r.span, bounds: boundsOf(r.span, [...r.visits, ...r.seats]), visits: r.visits.sort(byStart), seats: r.seats.sort(byStart) }));
}

export interface AttemptVisit {
  readonly span: TimelineSpan;
  /** "recorded": the visit's record names this execution; "overlap": placed by time only. */
  readonly by: "recorded" | "overlap";
}

export interface AttemptOf {
  readonly execution: string;
  /** As recorded; null when no attempt number is recorded. */
  readonly attempt: number | null;
  readonly span: TimelineSpan | null;
  readonly claim: TimelineSpan | null;
  readonly bounds: Bounds;
  /** Visits made during the attempt, in time order. */
  readonly visits: readonly AttemptVisit[];
}

const execIdOf = (s: TimelineSpan): string | null => s.ids.execution_id || (s.parent?.startsWith("execution:") ? s.parent.slice("execution:".length) : null);

/**
 * A ticket's execution attempts in order (by attempt number where recorded, then by start), each with
 * its bounds, how its length is known, and the visits made during it.
 */
export function attemptsOf(spans: readonly TimelineSpan[], ticket: string): AttemptOf[] {
  const byExec = new Map<string, { span: TimelineSpan | null; claim: TimelineSpan | null; attempt: number | null }>();
  for (const s of spans) {
    if ((s.kind !== "execution" && s.kind !== "claim") || !ticketIs(s, ticket)) continue;
    const x = execIdOf(s);
    if (!x) continue;
    const e = byExec.get(x) ?? { span: null, claim: null, attempt: null };
    if (s.kind === "execution") e.span = s;
    else e.claim = s;
    e.attempt ??= intOf(s.ids.attempt) ?? intOf(s.attrs.attempt);
    byExec.set(x, e);
  }
  const attempts = [...byExec.entries()].map(([execution, e]) => ({ execution, ...e, bounds: boundsOf(e.span, e.claim ? [e.claim] : []), visits: [] as AttemptVisit[] }));
  const known = new Map(attempts.map((a) => [a.execution, a] as const));
  for (const v of spans) {
    if (v.kind !== "visit" || !ticketIs(v, ticket)) continue;
    const x = execIdOf(v);
    if (x) {
      known.get(x)?.visits.push({ span: v, by: "recorded" });
      continue;
    }
    // No execution on its record: placed in the attempt whose bounds hold its start, if exactly one does.
    const at = extentOf(v)?.from;
    if (at === undefined) continue;
    const holders = attempts.filter((a) => a.bounds.from !== null && a.bounds.from <= at && (a.bounds.to === null || at <= a.bounds.to));
    if (holders.length === 1) (holders[0] as (typeof attempts)[number]).visits.push({ span: v, by: "overlap" });
  }
  return attempts
    .sort((a, b) => (a.attempt ?? Number.POSITIVE_INFINITY) - (b.attempt ?? Number.POSITIVE_INFINITY) || (a.bounds.from ?? Number.POSITIVE_INFINITY) - (b.bounds.from ?? Number.POSITIVE_INFINITY) || (a.execution < b.execution ? -1 : 1))
    .map((a) => ({ execution: a.execution, attempt: a.attempt, span: a.span, claim: a.claim, bounds: a.bounds, visits: a.visits.sort((p, q) => byStart(p.span, q.span)) }));
}
