/**
 * Screen-reader descriptions of the Timeline, shared by the canvas's live region, the structured
 * alternative (the table) and the workspace's visually hidden summary of the window. Pure: no DOM, no
 * React, so the words are tested in plain node (test/timeline-a11y.test.mjs).
 *
 * Words come from the existing vocabularies (src/shell/vocab.ts KIND_WORDS, stateWord, schedulerLook,
 * and the grammar's conditions). The honesty rules hold here too: a span counts in a window only once
 * it has started by the live edge; a span whose end lies beyond the live edge is still open there; an
 * outcome or a failure is counted only once the end that established it is held.
 */
import { factoryConditions } from "@mach/ui";
import { getTimeBase, KIND_WORDS, schedulerLook, stateWord, timecode } from "../../shell/vocab";
import { attentionOf, extentOf, overlaps, type SpanKind, type TimelineSpan, type TimeWindow, type TrackKind, type TrackNode, type TrackTree } from "../contract";

export type Attention = TrackNode["attention"];

const RANK: Readonly<Record<Attention, number>> = { none: 0, open: 1, person: 2, interrupted: 3, failed: 4 };

/** The worse of two conditions (failed > interrupted > person > open > none), as the track model ranks them. */
export function worse(a: Attention, b: Attention): Attention {
  return RANK[b] > RANK[a] ? b : a;
}

/** A condition in words, from the state vocabulary. Empty for none. */
export function attentionWords(a: Attention): string {
  switch (a) {
    case "failed":
      return stateWord("failed");
    case "interrupted":
      return factoryConditions.interrupted.label;
    case "person":
      return stateWord("human");
    case "open":
      return "Still open";
    default:
      return "";
  }
}

/** Whether a span belongs to `window` at `liveAt`: it overlaps the window and had started by the live edge. */
export function inWindow(span: TimelineSpan, window: TimeWindow, liveAt: number): boolean {
  const x = extentOf(span);
  return x !== null && x.from <= liveAt && overlaps(span, window);
}

/** Where a span's end is held, or null while it is open at `liveAt` (no end, or an end beyond the live edge). */
export function heldEnd(span: TimelineSpan, liveAt: number): number | null {
  const e = span.end;
  if (!e) return null;
  const t = e.at ?? e.notAfter ?? e.notBefore;
  return t !== null && t <= liveAt ? t : null;
}

/** What a set of spans holds in a window: counts by condition, the first start and the last end. */
export interface TrackSummary {
  readonly count: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly person: number;
  readonly open: number;
  readonly firstStart: number | null;
  /** The last held end; meaningful only when nothing is still open. */
  readonly lastEnd: number | null;
  readonly stillOpen: boolean;
  readonly worst: Attention;
}

export const EMPTY_SUMMARY: TrackSummary = { count: 0, failed: 0, interrupted: 0, person: 0, open: 0, firstStart: null, lastEnd: null, stillOpen: false, worst: "none" };

interface Acc {
  count: number;
  failed: number;
  interrupted: number;
  person: number;
  open: number;
  firstStart: number | null;
  lastEnd: number | null;
  worst: Attention;
}

function add(acc: Acc, span: TimelineSpan, liveAt: number): void {
  const x = extentOf(span);
  if (!x) return;
  acc.count++;
  const a = attentionOf(span, liveAt);
  if (a === "failed") acc.failed++;
  else if (a === "interrupted") acc.interrupted++;
  else if (a === "person") acc.person++;
  else if (a === "open") acc.open++;
  acc.worst = worse(acc.worst, a);
  if (acc.firstStart === null || x.from < acc.firstStart) acc.firstStart = x.from;
  const end = heldEnd(span, liveAt);
  if (end !== null && (acc.lastEnd === null || end > acc.lastEnd)) acc.lastEnd = end;
}

function freeze(acc: Acc): TrackSummary {
  return { ...acc, stillOpen: acc.open + acc.person > 0 };
}

function merge(into: Acc, s: TrackSummary): void {
  into.count += s.count;
  into.failed += s.failed;
  into.interrupted += s.interrupted;
  into.person += s.person;
  into.open += s.open;
  if (s.firstStart !== null && (into.firstStart === null || s.firstStart < into.firstStart)) into.firstStart = s.firstStart;
  if (s.lastEnd !== null && (into.lastEnd === null || s.lastEnd > into.lastEnd)) into.lastEnd = s.lastEnd;
  into.worst = worse(into.worst, s.worst);
}

const blank = (): Acc => ({ count: 0, failed: 0, interrupted: 0, person: 0, open: 0, firstStart: null, lastEnd: null, worst: "none" });

/** A summary of the given spans that lie in the window. */
export function summariseSpans(spans: Iterable<TimelineSpan>, window: TimeWindow, liveAt: number): TrackSummary {
  const acc = blank();
  for (const s of spans) if (inWindow(s, window, liveAt)) add(acc, s, liveAt);
  return freeze(acc);
}

/** A track's own spans (every lane), not its children's. */
export function* ownSpans(node: TrackNode): Generator<TimelineSpan> {
  for (const lane of node.lanes) yield* lane.spans;
}

/**
 * A track and everything below it, in the window. `memo` (keyed by track id) makes a walk over many
 * rows cost each span once: the table passes one per window.
 */
export function summariseTrack(node: TrackNode, window: TimeWindow, liveAt: number, memo?: Map<string, TrackSummary>): TrackSummary {
  const hit = memo?.get(node.id);
  if (hit) return hit;
  const acc = blank();
  for (const s of ownSpans(node)) if (inWindow(s, window, liveAt)) add(acc, s, liveAt);
  for (const child of node.children) merge(acc, summariseTrack(child, window, liveAt, memo));
  const out = freeze(acc);
  memo?.set(node.id, out);
  return out;
}

// ---------------------------------------------------------------- words

const SMALL = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** A count in words: "one" to "nine", then numerals with separators. */
export function countWord(n: number): string {
  return n >= 0 && n < SMALL.length ? (SMALL[n] as string) : n.toLocaleString("en-GB");
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

/** A moment as the app prints it (wall-clock UTC for real history, scenario time for the simulation). */
export function momentWords(t: number): string {
  return timecode(t, false);
}

function utc(): string {
  return getTimeBase() === "wall" ? " UTC" : "";
}

/** The kind of a track in words, when its label does not already say it (a cell's label is its ticket). */
const TRACK_KIND_WORDS: Readonly<Partial<Record<TrackKind, string>>> = {
  wave: KIND_WORDS.wave.toLowerCase(),
  slice: KIND_WORDS.slice.toLowerCase(),
  cell: KIND_WORDS.cell.toLowerCase(),
  station: `${KIND_WORDS.station.toLowerCase()}s`,
  seat: KIND_WORDS.seat.toLowerCase(),
  execution: KIND_WORDS.execution.toLowerCase(),
  workflow: KIND_WORDS.workflow.toLowerCase(),
  agent: KIND_WORDS.agent.toLowerCase(),
};

/** "from 23:18:00 to still open", "from 23:18:00 to 23:40:12 UTC", or "" when nothing is in the window. */
export function rangeWords(s: TrackSummary): string {
  if (s.count === 0 || s.firstStart === null) return "";
  const end = s.stillOpen ? "still open" : s.lastEnd !== null ? `${momentWords(s.lastEnd)}${utc()}` : "an end not known";
  return `from ${momentWords(s.firstStart)}${s.stillOpen ? utc() : ""} to ${end}`;
}

/** The conditions worth saying, worst first: "one failed, two interrupted, one waiting for a person". */
function conditionWords(s: TrackSummary): string[] {
  const out: string[] = [];
  if (s.failed) out.push(`${countWord(s.failed)} ${stateWord("failed").toLowerCase()}`);
  if (s.interrupted) out.push(`${countWord(s.interrupted)} ${factoryConditions.interrupted.label.toLowerCase()}`);
  if (s.person) out.push(`${countWord(s.person)} ${stateWord("human").toLowerCase()}`);
  return out;
}

/** The counts of a summary: "129 spans in this window, one failed, one waiting for a person". */
export function countWords(s: TrackSummary): string {
  if (s.count === 0) return "Nothing in this window";
  return [`${plural(s.count, "span", "spans")} in this window`, ...conditionWords(s)].join(", ");
}

/** The words for a track's summary: "LOCAL-031, cell, 129 spans in this window, one failed; from 23:18:00 to still open". */
export function summaryWords(node: TrackNode, s: TrackSummary): string {
  const head = [node.label];
  const kind = TRACK_KIND_WORDS[node.kind];
  if (kind && !node.label.toLowerCase().includes(kind)) head.push(kind);
  if (s.count === 0) return `${head.join(", ")}, nothing in this window`;
  head.push(`${plural(s.count, "span", "spans")} in this window`);
  head.push(...conditionWords(s));
  const range = rangeWords(s);
  return range ? `${head.join(", ")}; ${range}` : head.join(", ");
}

/** One track's summary in the window, in words (for the canvas's live region and the table). */
export function rowSummary(node: TrackNode, window: TimeWindow, liveAt: number): string {
  return summaryWords(node, summariseTrack(node, window, liveAt));
}

/** Nouns for counting spans by kind, from the vocabularies where they have one. */
const SPAN_NOUNS: Readonly<Record<SpanKind, readonly [string, string]>> = (() => {
  const n = (word: string): readonly [string, string] => [word.toLowerCase(), `${word.toLowerCase()}s`];
  const dependency = schedulerLook("waiting-on-dependency").label.toLowerCase().replace(/^waiting /, "wait ");
  return {
    wave: n(KIND_WORDS.wave),
    cell: n(KIND_WORDS.cell),
    visit: n(KIND_WORDS.station),
    seat: n(KIND_WORDS.seat),
    execution: n(KIND_WORDS.execution),
    workflow: n(KIND_WORDS.workflow),
    agent: n(KIND_WORDS.agent),
    tool: n(KIND_WORDS.tool),
    // No noun in the vocabularies for these: the plainest words for what the records are.
    round: ["round", "rounds"],
    task: ["build task", "build tasks"],
    claim: ["claim", "claims"],
    "agent-queue": ["queue before an agent", "queues before an agent"],
    "slice-wait": [dependency, dependency.replace(/^wait /, "waits ")],
    "slice-eligible": ["eligible wait", "eligible waits"],
    "capacity-wait": ["wait for capacity", "waits for capacity"],
    "gate-wait": ["wait on a person", "waits on a person"],
    "person-wait": ["wait on a person", "waits on a person"],
  };
})();

const ORDER: readonly SpanKind[] = ["wave", "cell", "round", "visit", "task", "seat", "execution", "claim", "workflow", "agent", "agent-queue", "tool", "slice-wait", "slice-eligible", "capacity-wait", "gate-wait", "person-wait"];

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Counts by noun (two kinds can share one: a gate wait and a person wait are both "waits on a person"). */
function byNoun(counts: ReadonlyMap<SpanKind, number>): string[] {
  const merged = new Map<string, { n: number; nouns: readonly [string, string] }>();
  for (const kind of ORDER) {
    const c = counts.get(kind);
    if (!c) continue;
    const nouns = SPAN_NOUNS[kind];
    const m = merged.get(nouns[0]);
    if (m) m.n += c;
    else merged.set(nouns[0], { n: c, nouns });
  }
  return [...merged.values()].map(({ n, nouns }) => plural(n, nouns[0], nouns[1]));
}

/**
 * The whole window in words: its bounds, how many spans by kind, failures and interruptions, the waits
 * on a person (and how many still wait), and what is still open. Each span counts once (ribbons, which
 * repeat another hierarchy's spans, are not counted).
 */
export function windowSummary(tree: TrackTree, window: TimeWindow, liveAt: number): string {
  const counts = new Map<SpanKind, number>();
  const open = new Map<SpanKind, number>();
  const acc = blank();
  let personWaits = 0;
  for (const node of tree.byId.values()) {
    for (const s of ownSpans(node)) {
      if (!inWindow(s, window, liveAt)) continue;
      add(acc, s, liveAt);
      counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
      if (s.kind === "person-wait" || s.kind === "gate-wait") personWaits++;
      if (heldEnd(s, liveAt) === null) open.set(s.kind, (open.get(s.kind) ?? 0) + 1);
    }
  }
  const to = Math.min(window.to, liveAt);
  const bounds = `From ${momentWords(window.from)} to ${momentWords(Math.max(window.from, to))}${utc()}`;
  if (acc.count === 0) return `${bounds}: nothing recorded in this window.`;
  const sentences = [`${bounds}, ${plural(acc.count, "span", "spans")}: ${list(byNoun(counts))}.`];
  const bad: string[] = [];
  if (acc.failed) bad.push(`${countWord(acc.failed)} ${stateWord("failed").toLowerCase()}`);
  if (acc.interrupted) bad.push(`${countWord(acc.interrupted)} ${factoryConditions.interrupted.label.toLowerCase()}`);
  if (bad.length) sentences.push(`${capitalise(list(bad))}.`);
  if (personWaits) sentences.push(`${capitalise(plural(personWaits, "wait on a person", "waits on a person"))}${acc.person ? `, ${countWord(acc.person)} still waiting` : ""}.`);
  const stillOpen = byNoun(open);
  sentences.push(stillOpen.length ? `Still open: ${list(stillOpen)}.` : "Nothing is still open.");
  return sentences.join(" ");
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
