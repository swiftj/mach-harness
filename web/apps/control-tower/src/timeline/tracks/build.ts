/**
 * The hierarchical track model: two projections of one span set (design section 4).
 *
 * Product: Wave → Slice → Cell → { rounds; one row per station; waits; review → seat per round;
 * verification }, executions as ribbons on the cell. The `executions` TrackKind is never emitted:
 * executions are ribbons here and roots in the execution grouping. Execution: Execution → { claim; workflow → agents
 * (one node each, or lanes) → tools }, station visits as ribbons on the execution. Rounds and attempts
 * are never nested in each other.
 *
 * Identity: a node's id is an entity ref or `<owner>/<kind>`; never positional. Given the previous tree,
 * every node whose subtree is unchanged is returned as the same object, and lanes are packed again only
 * for nodes whose spans changed. When spans changed in place or tool calls were appended, the previous
 * placement is updated instead of placing every span again. Span arrays are treated as immutable: pass a
 * new array, never one edited in place.
 */
import type { EntityRef } from "../../sim";
import {
  extentOf,
  attentionOf,
  type Grouping,
  type TimelineFilters,
  type TimelineSpan,
  type TrackKind,
  type TrackLane,
  type TrackNode,
  type TrackTree,
} from "../contract";
import { packLanes, startedBy } from "./lanes";
import { filterOf, idOf, individual, relationsOf, sliceOf, stationOf, ticketOf, execOf, type AgentGroup, type Relations } from "./relations";
import { containedWords } from "../../text/fields";

type Attention = TrackNode["attention"];
type Counts = NonNullable<TrackNode["counts"]>;
type MutableCounts = { -readonly [K in keyof Counts]-?: number };

/** The stations in belt order; others follow alphabetically. */
export const STATION_ORDER: readonly string[] = ["groom", "plan", "audit", "build", "verify", "review", "human-approval", "merge", "cleanup"];

/** What attentionOnly keeps (the contract: failed, interrupted, refused, or waiting on a person; and an outcome not known). */
const NEEDS_ATTENTION = new Set<Attention>(["person", "unknown", "interrupted", "failed"]);

const ZERO: MutableCounts = { failed: 0, rejected: 0, interrupted: 0, unknown: 0, waitingPerson: 0, open: 0 };

/** Spans that are work while open (the contract's open rule): everything else open is "open" or a wait. */
const AT_WORK = new Set<string>(["execution", "workflow", "agent", "tool", "task", "visit"]);

/** One span's contribution to the counts beneath a row. A rejected round is a rejection, not a failure. */
function countSpan(acc: MutableCounts, span: TimelineSpan, liveAt: number): void {
  const a = attentionOf(span, liveAt);
  // A verify or review visit and a seat that failed are the round's verdict, counted once on the round
  // (a failed verification, a rejection), not again for each part of it.
  if (a === "failed" && (span.kind === "seat" || (span.kind === "visit" && (span.ids.station === "verify" || span.ids.station === "review")))) return;
  switch (a) {
    case "failed":
      if (span.kind === "round" && /reject|changes/i.test(span.outcome ?? "")) acc.rejected++;
      else acc.failed++;
      break;
    case "interrupted":
      acc.interrupted++;
      break;
    case "unknown":
      acc.unknown++;
      break;
    case "person":
      acc.waitingPerson++;
      break;
    case "open":
      if (AT_WORK.has(span.kind) && !(span.kind === "visit" && span.ids.station === "human-approval")) acc.open++;
      break;
    default:
      break;
  }
}

/** The counts without zero keys (absent keys are zero), or undefined when nothing is counted. */
function frozenCounts(c: MutableCounts): Counts | undefined {
  const out: { -readonly [K in keyof Counts]?: number } = {};
  let any = false;
  for (const k of Object.keys(c) as (keyof Counts)[]) {
    if (c[k]) {
      out[k] = c[k];
      any = true;
    }
  }
  return any ? out : undefined;
}

function sameCounts(a: Counts | undefined, b: Counts | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const k of Object.keys(ZERO) as (keyof Counts)[]) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

function needsAttention(own: Attention, c: Counts | undefined): boolean {
  return NEEDS_ATTENTION.has(own) || Boolean(c && (c.failed || c.rejected || c.interrupted || c.unknown || c.waitingPerson));
}

const NO_TICKET = "Ticket not recorded";
const COUNT_ONLY_GROUP_NOTE = "Tool calls are counted, not observable one by one";

interface Draft {
  readonly id: string;
  readonly kind: TrackKind;
  readonly parentId: string | null;
  readonly ref: EntityRef | null;
  label: string;
  detail: string | null;
  /** An execution's label before its run and start are known ("LOCAL-001"). */
  base?: string;
  /** An execution's detail before numberRuns adds its start (so a rebuild does not add it twice). */
  baseDetail?: string | null;
  /** An execution's recorded supervisor attempt, if any. */
  attempt?: string | null;
  note: string | null;
  /** The label copies a free-text field (an agent's label). */
  freeText?: boolean;
  /** Children sort by order, then (when byTime) by their earliest instant, then by id. */
  readonly order: number;
  readonly byTime: boolean;
  /**
   * The node's own spans, in sections packed separately and stacked (a station's visits, then its
   * tasks). Copy-on-write once built: an incremental update replaces the arrays, never edits them, since
   * the previous tree's lane memo still holds them.
   */
  sections: TimelineSpan[][];
  ribbons: TimelineSpan[];
  readonly children: Draft[];
  /** The draft's Tools row, once made. */
  tools: Draft | null;
}

/** What a node's lanes were built from, kept so an unchanged node is not packed again. */
interface LaneMemo {
  readonly sections: readonly (readonly TimelineSpan[])[];
  readonly lanes: readonly TrackLane[];
  /** How many of the sections' spans had started by liveAt when the lanes were packed. */
  readonly started: number;
  readonly liveAt: number;
  readonly own: Attention;
  /** The counts of the node's own spans. */
  readonly counts: MutableCounts;
  readonly from: number;
}

interface Internal {
  readonly memo: Map<string, LaneMemo>;
  /** What the incremental path needs: the input, the relations, the drafts and their version. */
  readonly input: readonly TimelineSpan[];
  readonly rel: Relations;
  readonly filters: TimelineFilters;
  readonly keep: ((s: TimelineSpan) => boolean) | null;
  readonly placer: Placer;
  readonly version: number;
}

const internals = new WeakMap<TrackTree, Internal>();

// ---------------------------------------------------------------- span equality

function sameEnd(a: TimelineSpan["start"], b: TimelineSpan["start"]): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.at === b.at && a.notBefore === b.notBefore && a.notAfter === b.notAfter && a.reason === b.reason && a.basis === b.basis && a.precision === b.precision && a.eventId === b.eventId && a.rule === b.rule;
}

function sameRecord(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i])) continue;
    return false;
  }
  return true;
}

/** Same object, or the same span with nothing a drawing or a label could show changed. */
export function sameSpan(a: TimelineSpan, b: TimelineSpan): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.outcome === b.outcome &&
    a.authority === b.authority &&
    a.parent === b.parent &&
    a.duration.basis === b.duration.basis &&
    a.duration.ms === b.duration.ms &&
    a.duration.minMs === b.duration.minMs &&
    a.duration.maxMs === b.duration.maxMs &&
    sameEnd(a.start, b.start) &&
    sameEnd(a.end, b.end) &&
    sameRecord(a.attrs as Readonly<Record<string, unknown>>, b.attrs as Readonly<Record<string, unknown>>) &&
    sameRecord(a.ids, b.ids)
  );
}

function sameList(a: readonly TimelineSpan[], b: readonly TimelineSpan[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameSpan(a[i] as TimelineSpan, b[i] as TimelineSpan)) return false;
  return true;
}

function sameSections(a: readonly (readonly TimelineSpan[])[], b: readonly (readonly TimelineSpan[])[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameList(a[i] as TimelineSpan[], b[i] as TimelineSpan[])) return false;
  return true;
}

// ---------------------------------------------------------------- words

function stationWords(station: string): string {
  const words = station.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function agentLabel(span: TimelineSpan | undefined): string {
  return span?.attrs.label ?? span?.attrs.agentType ?? "Agent";
}

/** Words without a leading ticket ("LOCAL-001: build", "LOCAL-001 · build" → "build"); unchanged when nothing would remain. */
export function withoutTicket(words: string, ticket: string | undefined): string {
  if (!ticket || !words.startsWith(ticket)) return words;
  const rest = words.slice(ticket.length).replace(/^[\s:·\-–—/]+/, "");
  return rest && rest !== words.slice(ticket.length) ? rest : words;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
/** A start time for a label: HH:MM UTC for wall time, mm:ss elapsed for the simulation. */
export function startWords(t: number): string {
  if (t > 86_400_000) {
    const d = new Date(t);
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }
  const s = Math.max(0, Math.floor(t / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

function countOnlyNote(span: TimelineSpan): string {
  const n = span.attrs.toolCalls;
  if (n === undefined) return COUNT_ONLY_GROUP_NOTE;
  return `${n} tool ${n === 1 ? "call" : "calls"}, counted, not observable one by one`;
}

// ---------------------------------------------------------------- drafting

class Drafts {
  readonly byId = new Map<string, Draft>();
  readonly roots: Draft[] = [];
  /** Bumped by every incremental update: a tree whose version is not the drafts' cannot update them. */
  version = 0;

  get(id: string): Draft | undefined {
    return this.byId.get(id);
  }

  make(id: string, kind: TrackKind, parent: Draft | null, init: { ref?: EntityRef | null; label: string; detail?: string | null; order: number; byTime?: boolean }): Draft {
    const draft: Draft = {
      id,
      kind,
      parentId: parent ? parent.id : null,
      ref: init.ref ?? null,
      label: init.label,
      detail: init.detail ?? null,
      note: null,
      order: init.order,
      byTime: init.byTime ?? false,
      sections: [],
      ribbons: [],
      children: [],
      tools: null,
    };
    this.byId.set(id, draft);
    (parent ? parent.children : this.roots).push(draft);
    return draft;
  }
}

function asRef(value: string): EntityRef {
  return value as EntityRef;
}

/** Where one span goes in a grouping. Placement depends only on the span and the relations. */
interface Placer {
  readonly drafts: Drafts;
  place(span: TimelineSpan): { readonly draft: Draft; readonly section: number } | null;
  /** The drafts that carry the span as a ribbon. */
  ribbonsOf(span: TimelineSpan): readonly Draft[];
  /** Refreshes words taken from a span's attrs (an agent's label, a workflow's name, a seat's model). */
  relabel(span: TimelineSpan): void;
}

function productPlacer(rel: Relations): Placer {
  const d = new Drafts();
  // A cell's wave: the cell span's own wave_id where recorded; otherwise its slice's, read from any span
  // that names both (a slice wait, an execution, a visit; relations.ts `sliceWave`). A capacity wait
  // names only its ticket (apps/observer spans.go): it goes to its cell's Waits row through the cell.
  // A slice or cell whose wave is recorded nowhere goes under this group, never dropped; it says only
  // that no wave is recorded, not that the work is outside every wave.
  const unplanned = (): Draft => d.get("factory/unplanned") ?? d.make("factory/unplanned", "factory", null, { label: "No wave recorded", order: 1000 });
  const wave = (w: string): Draft => d.get(`wave:${w}`) ?? d.make(`wave:${w}`, "wave", null, { ref: asRef(`wave:${w}`), label: w, order: 0, byTime: true });
  const slice = (s: string): Draft => {
    const id = `slice:${s}`;
    const existing = d.get(id);
    if (existing) return existing;
    const w = rel.sliceWave.get(s);
    return d.make(id, "slice", w ? wave(w) : unplanned(), { ref: asRef(id), label: s, order: 1, byTime: true });
  };
  const cell = (t: string): Draft => {
    const id = `cell:${t}`;
    const existing = d.get(id);
    if (existing) return existing;
    const s = rel.ticketSlice.get(t) ?? null;
    // No detail: the slice is the row's parent, and repeating its id only cuts the ticket off.
    return d.make(id, "cell", s ? slice(s) : unplanned(), { ref: asRef(id), label: t, order: 2, byTime: true });
  };
  const cellRow = (t: string, kind: TrackKind, label: string, order: number): Draft => {
    const id = `cell:${t}/${kind}`;
    return d.get(id) ?? d.make(id, kind, cell(t), { label, order });
  };
  const station = (t: string, st: string): Draft => {
    const id = `station:${t}/${st}`;
    const existing = d.get(id);
    if (existing) return existing;
    const index = STATION_ORDER.indexOf(st);
    return d.make(id, "station", cell(t), { ref: asRef(id), label: stationWords(st), order: 10 + (index < 0 ? STATION_ORDER.length : index) });
  };
  const factoryRow = (kind: TrackKind, suffix: string, label: string, order: number): Draft => d.get(`factory/${suffix}`) ?? d.make(`factory/${suffix}`, kind, null, { label, order });
  const seatNode = (span: TimelineSpan, t: string): Draft => {
    const existing = d.get(span.entity);
    if (existing) return existing;
    const round = Number(idOf(span, "round") ?? span.attrs.round ?? 0);
    const seat = idOf(span, "seat") ?? "seat";
    return d.make(span.entity, "seat", cellRow(t, "review", "Review", 300), { ref: asRef(span.entity), label: `R${round} ${seat}`, detail: span.attrs.model ?? null, order: round });
  };

  return {
    drafts: d,
    place(span) {
      switch (span.kind) {
        case "wave":
          return { draft: wave(idOf(span, "wave_id") ?? span.entity.slice(span.entity.indexOf(":") + 1)), section: 0 };
        case "slice-wait":
        case "slice-eligible":
        case "capacity-wait": {
          const ticket = ticketOf(span, rel);
          if (ticket && rel.cellTickets.has(ticket)) return { draft: cellRow(ticket, "waits", "Waits", 200), section: 0 };
          const s = sliceOf(span, rel);
          if (!s) return { draft: factoryRow("waits", "waits", "Factory waits", 1001), section: 0 };
          const id = `slice:${s}/waits`;
          return { draft: d.get(id) ?? d.make(id, "waits", slice(s), { label: "Waits", order: 0 }), section: 0 };
        }
        case "cell":
        case "round":
        case "visit":
        case "task":
        case "seat":
        case "gate-wait":
        case "person-wait": {
          const t = idOf(span, "ticket_id");
          if (!t) return { draft: factoryRow("factory", "unattached", "Not attached to a cell", 1002), section: 0 };
          switch (span.kind) {
            case "cell":
              return { draft: cell(t), section: 0 };
            case "round":
              return { draft: cellRow(t, "rounds", "Rounds", 0), section: 0 };
            case "visit":
              return { draft: station(t, idOf(span, "station") ?? "unknown"), section: 0 };
            case "task": {
              // There is no "verification" span kind: the Verification row is the verify visits' tasks
              // (the checks recorded), and it is not emitted when a cell has none (an empty row is noise).
              const st = stationOf(span, rel) ?? "unknown";
              return st === "verify" ? { draft: cellRow(t, "verification", "Verification", 400), section: 0 } : { draft: station(t, st), section: 1 };
            }
            case "seat":
              return { draft: seatNode(span, t), section: 0 };
            default:
              return { draft: cellRow(t, "waits", "Waits", 200), section: 0 };
          }
        }
        default:
          return null;
      }
    },
    ribbonsOf(span) {
      // Every execution that touched a cell, on that cell's row.
      if (span.kind !== "execution") return [];
      const x = execOf(span);
      const cells = new Set<string>(x ? (rel.execCells.get(x) ?? []) : []);
      const t = ticketOf(span, rel);
      if (t) cells.add(t);
      const out: Draft[] = [];
      for (const ticket of cells) {
        const draft = d.get(`cell:${ticket}`);
        if (draft) out.push(draft);
      }
      return out;
    },
    relabel(span) {
      if (span.kind !== "seat") return;
      const draft = d.get(span.entity);
      if (draft) draft.detail = span.attrs.model ?? null;
    },
  };
}

function executionPlacer(rel: Relations): Placer {
  const d = new Drafts();
  const execution = (x: string): Draft => {
    const id = `execution:${x}`;
    const existing = d.get(id);
    if (existing) return existing;
    // What tells executions apart comes first: the ticket, its run among the cell's executions and its
    // start (numbered by numberRuns before finishing); the supervisor's recorded attempt is the detail.
    const attempt = rel.execAttempt.get(x);
    const ticket = rel.execTicket.get(x);
    const base = ticket ?? NO_TICKET;
    const draft = d.make(id, "execution", null, { ref: asRef(id), label: base, detail: attempt ? `supervisor attempt ${attempt}` : "attempt not recorded", order: 0, byTime: true });
    draft.base = base;
    draft.baseDetail = draft.detail;
    draft.attempt = attempt ?? null;
    return draft;
  };
  const claim = (x: string): Draft => d.get(`execution:${x}/claim`) ?? d.make(`execution:${x}/claim`, "claim", execution(x), { label: "Claim", order: 0 });
  /** An agent's or workflow's words without the ticket its execution already shows ("LOCAL-001: build" → "build"). */
  const local = (words: string, x: string): string => withoutTicket(words, rel.execTicket.get(x));
  const toolsOf = (owner: Draft): Draft => (owner.tools ??= d.make(`${owner.id}/tools`, "tools", owner, { label: "Tools", order: 100 }));
  const workflow = (ref: string, x: string): Draft => d.get(ref) ?? d.make(ref, "workflow", execution(x), { ref: asRef(ref), label: "Workflow", order: 10, byTime: true });
  const groupNode = (group: AgentGroup): Draft => {
    const existing = d.get(group.id);
    if (existing) return existing;
    const parent = group.owner === `execution:${group.execution}` ? execution(group.execution) : workflow(group.owner, group.execution);
    const n = group.members.size;
    const node = d.make(group.id, "agents", parent, { label: "Agents", detail: `${n} ${n === 1 ? "agent" : "agents"}`, order: 20 });
    if (!individual(group)) for (const member of group.members) if (rel.agentSpan.get(member)?.attrs.toolsCountOnly) node.note = COUNT_ONLY_GROUP_NOTE;
    return node;
  };
  const labelAgent = (node: Draft, span: TimelineSpan | undefined, x: string): void => {
    // An agent's label is free text (agent.started data.label): bounded here, and the row is marked so no name or title quotes it.
    node.label = span?.attrs.label ? containedWords("agentLabel", local(span.attrs.label, x)) || "Agent" : local(agentLabel(span), x);
    node.freeText = Boolean(span?.attrs.label);
    node.detail = span?.attrs.model ?? null;
    node.note = span?.attrs.toolsCountOnly ? countOnlyNote(span) : null;
  };
  const agent = (entity: string, group: AgentGroup): Draft => {
    const existing = d.get(entity);
    if (existing) return existing;
    const node = d.make(entity, "agent", groupNode(group), { ref: asRef(entity), label: "Agent", order: 0, byTime: true });
    labelAgent(node, rel.agentSpan.get(entity), group.execution);
    return node;
  };

  return {
    drafts: d,
    place(span) {
      const x = execOf(span);
      if (!x) return null;
      switch (span.kind) {
        case "execution":
          return { draft: execution(x), section: 0 };
        case "claim":
          return { draft: claim(x), section: 0 };
        case "workflow": {
          const node = workflow(span.entity, x);
          if (span.attrs.label) node.label = containedWords("agentLabel", local(span.attrs.label, x)) || node.label;
          return { draft: node, section: 0 };
        }
        case "agent":
        case "agent-queue": {
          const group = rel.agentGroup.get(span.entity) as AgentGroup;
          return { draft: individual(group) ? agent(span.entity, group) : groupNode(group), section: 0 };
        }
        case "tool": {
          const parent = span.parent;
          const group = parent ? rel.agentGroup.get(parent) : undefined;
          if (!parent || !group) return { draft: toolsOf(execution(x)), section: 0 };
          if (rel.agentSpan.get(parent)?.attrs.toolsCountOnly) return null; // counted only: no tool rows, ever
          return { draft: toolsOf(individual(group) ? agent(parent, group) : groupNode(group)), section: 0 };
        }
        default:
          return null;
      }
    },
    ribbonsOf(span) {
      // The station visits made during each execution.
      if (span.kind !== "visit") return [];
      const x = execOf(span) ?? (span.parent?.startsWith("execution:") ? span.parent.slice("execution:".length) : null);
      const draft = x ? d.get(`execution:${x}`) : undefined;
      return draft ? [draft] : [];
    },
    relabel(span) {
      if (span.kind === "workflow" && span.attrs.label) {
        const draft = d.get(span.entity);
        const x = execOf(span);
        if (draft) draft.label = containedWords("agentLabel", x ? local(span.attrs.label, x) : span.attrs.label) || draft.label;
      } else if (span.kind === "agent" || span.kind === "agent-queue") {
        if (span.kind === "agent" || rel.agentSpan.get(span.entity)?.kind !== "agent") rel.agentSpan.set(span.entity, span);
        const draft = d.get(span.entity);
        const group = rel.agentGroup.get(span.entity);
        if (draft && group) labelAgent(draft, rel.agentSpan.get(span.entity), group.execution);
      }
    },
  };
}

function put(draft: Draft, span: TimelineSpan, section: number): void {
  while (draft.sections.length <= section) draft.sections.push([]);
  (draft.sections[section] as TimelineSpan[]).push(span);
}

/** Places every span (the full path). */
function placeAll(spans: readonly TimelineSpan[], placer: Placer, keep: ((s: TimelineSpan) => boolean) | null): void {
  for (const span of spans) {
    if (keep && !keep(span)) continue;
    const at = placer.place(span);
    if (at) put(at.draft, span, at.section);
  }
  for (const span of spans) {
    if (span.kind !== "execution" && span.kind !== "visit") continue;
    if (keep && !keep(span)) continue;
    for (const draft of placer.ribbonsOf(span)) draft.ribbons.push(span);
  }
}

/** Replaces `old` by `next` in an array, copy-on-write. False when `old` is not there. */
function replaced(list: TimelineSpan[], old: TimelineSpan, next: TimelineSpan): TimelineSpan[] | null {
  const i = list.indexOf(old);
  if (i < 0) return null;
  const copy = list.slice();
  copy[i] = next;
  return copy;
}

/** The most changed spans the incremental path takes before a full pass is cheaper. */
const MAX_INCREMENTAL = 512;

/**
 * Updates the previous drafts in place for spans changed without moving (same id, kind, entity, parent
 * and ids, and nothing that decides where other spans go), and for appended tool calls. False when the
 * change is anything else: the caller then takes the full path.
 */
function applyIncremental(prev: Internal, spans: readonly TimelineSpan[]): boolean {
  const input = prev.input;
  if (spans.length < input.length) return false;
  const changed: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (spans[i] !== input[i]) {
      changed.push(i);
      if (changed.length > MAX_INCREMENTAL) return false;
    }
  }
  if (changed.length + spans.length - input.length > MAX_INCREMENTAL) return false;
  const keep = prev.keep;
  for (const i of changed) {
    const a = input[i] as TimelineSpan;
    const b = spans[i] as TimelineSpan;
    if (a.id !== b.id || a.kind !== b.kind || a.entity !== b.entity || a.parent !== b.parent || !sameRecord(a.ids, b.ids)) return false;
    if (keep && keep(a) !== keep(b)) return false;
    if ((a.kind === "execution" || a.kind === "claim") && a.attrs.attempt !== b.attrs.attempt) return false;
    if ((a.kind === "agent" || a.kind === "agent-queue") && Boolean(a.attrs.toolsCountOnly) !== Boolean(b.attrs.toolsCountOnly)) return false;
  }
  for (let i = input.length; i < spans.length; i++) if ((spans[i] as TimelineSpan).kind !== "tool") return false;

  const placer = prev.placer;
  for (const i of changed) {
    const a = input[i] as TimelineSpan;
    const b = spans[i] as TimelineSpan;
    placer.relabel(b);
    if (keep && !keep(b)) continue;
    const at = placer.place(b);
    if (at) {
      const sections = at.draft.sections.slice();
      const next = replaced(sections[at.section] ?? [], a, b);
      if (!next) return false;
      sections[at.section] = next;
      at.draft.sections = sections;
    }
    for (const draft of placer.ribbonsOf(b)) {
      const next = replaced(draft.ribbons, a, b);
      if (!next) return false;
      draft.ribbons = next;
    }
  }
  for (let i = input.length; i < spans.length; i++) {
    const span = spans[i] as TimelineSpan;
    if (keep && !keep(span)) continue;
    const at = placer.place(span);
    if (!at) continue;
    const sections = at.draft.sections.slice();
    while (sections.length <= at.section) sections.push([]);
    sections[at.section] = [...(sections[at.section] as TimelineSpan[]), span];
    at.draft.sections = sections;
  }
  return true;
}

// ---------------------------------------------------------------- finishing

function byExtent(a: TimelineSpan, b: TimelineSpan): number {
  const fa = extentOf(a)?.from ?? Number.POSITIVE_INFINITY;
  const fb = extentOf(b)?.from ?? Number.POSITIVE_INFINITY;
  return fa - fb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

interface Finished {
  readonly node: TrackNode;
  readonly from: number;
}

class Finisher {
  readonly memo = new Map<string, LaneMemo>();
  readonly byId = new Map<string, TrackNode>();
  private readonly liveAt: number;
  private readonly attentionOnly: boolean;
  private readonly prevById: ReadonlyMap<string, TrackNode> | null;
  private readonly prev: Internal | null;

  constructor(liveAt: number, attentionOnly: boolean, previous: TrackTree | null) {
    this.liveAt = liveAt;
    this.attentionOnly = attentionOnly;
    this.prevById = previous ? previous.byId : null;
    this.prev = previous ? (internals.get(previous) ?? null) : null;
  }

  private lanesOf(draft: Draft): LaneMemo {
    const old = this.prev?.memo.get(draft.id);
    const same = old !== undefined && sameSections(old.sections, draft.sections);
    if (old && same && old.liveAt === this.liveAt) return old;
    // The lanes depend on what has started by liveAt (lanes.ts): reused while that count holds.
    let started = 0;
    for (const section of draft.sections) started += startedBy(section, this.liveAt);
    if (old && same && old.started === started) {
      return { ...old, liveAt: this.liveAt, own: this.ownAttention(old.sections), counts: this.countsOf(old.lanes) };
    }
    const lanes: TrackLane[] = [];
    let from = Number.POSITIVE_INFINITY;
    for (const section of draft.sections) {
      for (const lane of packLanes(section, this.liveAt)) lanes.push(lane);
      for (const span of section) {
        const x = extentOf(span);
        if (x && x.from < from) from = x.from;
      }
    }
    return { sections: draft.sections, lanes, started, liveAt: this.liveAt, own: this.ownAttention(draft.sections), counts: this.countsOf(lanes), from };
  }

  /**
   * The row's OWN condition: that of its latest span (by start) in its first section (a station's
   * visits, not their tasks), as held at liveAt. A Verify row whose round-1 visit failed and whose
   * round-2 visit passed is not failed; the failure is in its counts. A span not started by liveAt
   * does not count.
   */
  private ownAttention(sections: readonly (readonly TimelineSpan[])[]): Attention {
    const list = sections.find((s) => s.length > 0) ?? [];
    let latest: TimelineSpan | null = null;
    let at = Number.NEGATIVE_INFINITY;
    for (const span of list) {
      const x = extentOf(span);
      if (!x || x.from > this.liveAt) continue;
      if (x.from > at || (x.from === at && latest !== null && span.id > latest.id)) {
        latest = span;
        at = x.from;
      }
    }
    return latest ? attentionOf(latest, this.liveAt) : "none";
  }

  private countsOf(lanes: readonly TrackLane[]): MutableCounts {
    const c = { ...ZERO };
    for (const lane of lanes) for (const span of lane.spans) countSpan(c, span, this.liveAt);
    return c;
  }

  finish(draft: Draft, depth: number): Finished | null {
    const kids: Finished[] = [];
    for (const child of draft.children) {
      const done = this.finish(child, depth + 1);
      if (done) kids.push(done);
    }
    const order = new Map(draft.children.map((c) => [c.id, c] as const));
    kids.sort((a, b) => {
      const da = order.get(a.node.id) as Draft;
      const db = order.get(b.node.id) as Draft;
      if (da.order !== db.order) return da.order - db.order;
      if (da.byTime && db.byTime && a.from !== b.from) return a.from - b.from;
      return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
    });
    const memo = this.lanesOf(draft);
    if (draft.kind === "verification") {
      let n = 0;
      for (const lane of memo.lanes) n += lane.spans.length;
      draft.detail = `${n} ${n === 1 ? "check" : "checks"} recorded`;
    }
    // The node's own condition, never a child's; what happened beneath it is counted.
    const attention = memo.own;
    const sum = { ...memo.counts };
    let spanCount = 0;
    let from = memo.from;
    for (const lane of memo.lanes) spanCount += lane.spans.length;
    for (const k of kids) {
      spanCount += k.node.spanCount;
      if (k.from < from) from = k.from;
      const c = k.node.counts;
      if (c) for (const key of Object.keys(c) as (keyof Counts)[]) sum[key] += c[key] ?? 0;
    }
    const counts = frozenCounts(sum);
    if (this.attentionOnly && !needsAttention(attention, counts)) return null;
    if (spanCount === 0 && draft.ribbons.length === 0) return null;
    this.memo.set(draft.id, memo);

    const ribbons = draft.ribbons.length > 1 ? [...draft.ribbons].sort(byExtent) : draft.ribbons;
    const children = kids.map((k) => k.node);
    const prev = this.prevById?.get(draft.id);
    if (
      prev &&
      prev.kind === draft.kind &&
      prev.depth === depth &&
      prev.parentId === draft.parentId &&
      prev.ref === draft.ref &&
      prev.label === draft.label &&
      prev.detail === draft.detail &&
      prev.note === draft.note &&
      prev.attention === attention &&
      sameCounts(prev.counts, counts) &&
      prev.spanCount === spanCount &&
      prev.lanes === memo.lanes &&
      sameList(prev.ribbons, ribbons) &&
      prev.children.length === children.length &&
      prev.children.every((c, i) => c === children[i])
    ) {
      this.index(prev);
      return { node: prev, from };
    }
    const node: TrackNode = {
      id: draft.id,
      kind: draft.kind,
      ref: draft.ref,
      label: draft.label,
      detail: draft.detail,
      ...(draft.freeText ? { freeText: true as const } : {}),
      depth,
      parentId: draft.parentId,
      children,
      lanes: memo.lanes,
      ribbons: prev && sameList(prev.ribbons, ribbons) ? prev.ribbons : ribbons,
      spanCount,
      attention,
      ...(counts ? { counts } : {}),
      note: draft.note,
    };
    this.index(node);
    return { node, from };
  }

  private index(node: TrackNode): void {
    this.byId.set(node.id, node);
  }
}

/** An execution's start: its execution span's recorded start, else the earliest instant of its own spans. */
function executionStart(draft: Draft): number | null {
  let start: number | null = null;
  let any: number | null = null;
  for (const section of draft.sections) {
    for (const span of section) {
      if (span.kind === "execution" && span.start?.at != null && (start === null || span.start.at < start)) start = span.start.at;
      const x = extentOf(span);
      if (x && (any === null || x.from < any)) any = x.from;
    }
  }
  return start ?? any;
}

/**
 * Labels the execution roots by what tells them apart: "LOCAL-001 · run 2/3" (detail "from 05:37",
 * or "from 05:37 · attempt 2" for a later supervisor attempt), the run being
 * the execution's order among its cell's executions by start (from the structural spans, so it does not
 * depend on the window). An execution not started by liveAt is not counted yet.
 */
function numberRuns(roots: readonly Draft[], liveAt: number): void {
  const byTicket = new Map<string, { draft: Draft; start: number }[]>();
  for (const draft of roots) {
    if (draft.kind !== "execution" || draft.base === undefined) continue;
    const start = executionStart(draft);
    if (start === null || start > liveAt) {
      draft.label = draft.base;
      if (draft.baseDetail !== undefined) draft.detail = draft.baseDetail;
      continue;
    }
    // The start goes in the detail: the label keeps what survives fitting at the default column
    // (recheck R2). A first supervisor attempt is the usual case and says nothing a run number does
    // not; a later one ("attempt 2") is kept, short, so it is not cut to "s…" (round 6, defect 19).
    // The label column's title says the supervisor's attempt in full.
    draft.detail = `from ${startWords(start)}${draft.attempt && draft.attempt !== "1" ? ` · attempt ${draft.attempt}` : ""}`;
    if (draft.base === NO_TICKET) {
      draft.label = NO_TICKET;
      continue;
    }
    const list = byTicket.get(draft.base);
    if (list) list.push({ draft, start });
    else byTicket.set(draft.base, [{ draft, start }]);
  }
  for (const list of byTicket.values()) {
    list.sort((a, b) => a.start - b.start || (a.draft.id < b.draft.id ? -1 : 1));
    list.forEach(({ draft }, i) => {
      draft.label = list.length > 1 ? `${draft.base} · run ${i + 1}/${list.length}` : draft.base!;
    });
  }
}

// ---------------------------------------------------------------- the tree

/**
 * The refs a node's spans are about, with how directly: -1 the node is the ref, 0 a span is about it,
 * 2 a span's parent is it, 3 a span's ids name it, 4 a ribbon is about it. Kept per node object, so a
 * rebuild that reuses a node reuses its refs and tracksOf costs one lookup per node.
 */
const nodeRefs = new WeakMap<TrackNode, Map<string, number>>();

function refsOfNode(node: TrackNode, rel: Relations): Map<string, number> {
  const known = nodeRefs.get(node);
  if (known) return known;
  const refs = new Map<string, number>();
  const add = (ref: string | null, rank: number): void => {
    if (!ref) return;
    const had = refs.get(ref);
    if (had === undefined || rank < had) refs.set(ref, rank);
  };
  add(node.id, -1);
  let lastTicket: string | null = null;
  let lastSlice: string | null = null;
  let lastExec: string | null = null;
  for (const lane of node.lanes) {
    for (const span of lane.spans) {
      add(span.entity, 0);
      add(span.parent, 2);
      // Derived refs, deduplicated (a node's spans usually share them).
      const ticket = ticketOf(span, rel);
      if (ticket && ticket !== lastTicket) {
        add(`cell:${ticket}`, 3);
        lastTicket = ticket;
      }
      const slice = sliceOf(span, rel);
      if (slice && slice !== lastSlice) {
        add(`slice:${slice}`, 3);
        const wave = idOf(span, "wave_id") ?? rel.sliceWave.get(slice);
        if (wave) add(`wave:${wave}`, 3);
        lastSlice = slice;
      }
      const exec = execOf(span);
      if (exec && exec !== lastExec) {
        add(`execution:${exec}`, 3);
        lastExec = exec;
      }
      const station = idOf(span, "station");
      if (ticket && station) add(`station:${ticket}/${station}`, 3);
      const visit = idOf(span, "visit_id");
      if (visit) add(`visit:${visit}`, 3);
    }
  }
  for (const ribbon of node.ribbons) add(ribbon.entity, 4);
  nodeRefs.set(node, refs);
  return refs;
}

function makeTree(grouping: Grouping, roots: readonly TrackNode[], byId: ReadonlyMap<string, TrackNode>, rel: Relations): TrackTree {
  let ofSpan: Map<string, { trackId: string; lane: number }> | null = null;
  const locate = (): Map<string, { trackId: string; lane: number }> => {
    if (ofSpan) return ofSpan;
    ofSpan = new Map();
    for (const node of byId.values()) {
      node.lanes.forEach((lane, i) => {
        for (const span of lane.spans) (ofSpan as Map<string, { trackId: string; lane: number }>).set(span.id, { trackId: node.id, lane: i });
      });
    }
    return ofSpan;
  };
  return {
    grouping,
    roots,
    byId,
    get ofSpan() {
      return locate();
    },
    tracksOf(ref: string): readonly string[] {
      const tracks: [string, number][] = [];
      for (const node of byId.values()) {
        const rank = refsOfNode(node, rel).get(ref);
        if (rank !== undefined) tracks.push([node.id, rank]);
      }
      return tracks
        .sort((a, b) => a[1] - b[1] || (byId.get(b[0])?.depth ?? 0) - (byId.get(a[0])?.depth ?? 0) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([id]) => id);
    },
  };
}

/**
 * The track a mark about `ref` is drawn on: the most specific track that is about it (the track is the
 * ref, one of its spans is, or a ribbon on it is), or null. Never a track that only names it in a
 * span's ids (L6 of the live run: a wave's intake mark, about no row of the execution grouping, was
 * drawn on an agent row two minutes before that agent's execution began, because every agent's spans
 * name their slice's wave).
 */
export function markTrackOf(tree: TrackTree, ref: string): string | null {
  const index = markIndexOf(tree);
  if (!index) return tree.tracksOf(ref)[0] ?? null;
  return index.get(ref) ?? null;
}

/** Ref -> the track a mark about it is drawn on, built in one pass over the tree's nodes, once per tree. */
const markIndex = new WeakMap<TrackTree, Map<string, string>>();
/** Work counters for tests (assignment work counted, never timed): index builds and nodes scanned to build them. */
export const markAssignment = { indexBuilds: 0, nodesScanned: 0 };

function markIndexOf(tree: TrackTree): Map<string, string> | null {
  const known = markIndex.get(tree);
  if (known) return known;
  const rel = internals.get(tree)?.rel;
  if (!rel) return null;
  markAssignment.indexBuilds += 1;
  const best = new Map<string, { id: string; rank: number; depth: number }>();
  for (const node of tree.byId.values()) {
    markAssignment.nodesScanned += 1;
    for (const [ref, rank] of refsOfNode(node, rel)) {
      // About it: the track is it (-1), a span is it (0), or a ribbon is it (4). A span's parent (2) or
      // ids (3) only name it: a station row is not where its execution's recovery happened.
      if (rank !== -1 && rank !== 0 && rank !== 4) continue;
      const b = best.get(ref);
      if (!b || rank < b.rank || (rank === b.rank && (node.depth > b.depth || (node.depth === b.depth && node.id < b.id)))) best.set(ref, { id: node.id, rank, depth: node.depth });
    }
  }
  const index = new Map<string, string>();
  for (const [ref, b] of best) index.set(ref, b.id);
  markIndex.set(tree, index);
  return index;
}

function sameFilters(a: TimelineFilters, b: TimelineFilters): boolean {
  if (a === b) return true;
  const same = (x: readonly string[], y: readonly string[]): boolean => x.length === y.length && x.every((v, i) => v === y[i]);
  return a.attentionOnly === b.attentionOnly && same(a.tickets, b.tickets) && same(a.executions, b.executions) && same(a.slices, b.slices) && same(a.stations, b.stations) && same(a.kinds, b.kinds);
}

/**
 * The track tree for `spans` in one grouping. With `previous` (the last tree built for the same
 * grouping), unchanged subtrees are the same objects; and when spans changed in place, or tool calls were
 * appended, only the nodes holding them are touched instead of placing every span again.
 */
export function buildTrackTree(spans: readonly TimelineSpan[], grouping: Grouping, filters: TimelineFilters, liveAt: number, previous?: TrackTree): TrackTree {
  const before = previous && previous.grouping === grouping ? previous : null;
  const prev = before ? (internals.get(before) ?? null) : null;
  let rel: Relations;
  let keep: ((s: TimelineSpan) => boolean) | null;
  let placer: Placer;
  if (prev && prev.version === prev.placer.drafts.version && sameFilters(prev.filters, filters) && applyIncremental(prev, spans)) {
    ({ rel, keep, placer } = prev);
  } else {
    if (prev) prev.placer.drafts.version++; // a failed incremental attempt may have touched the drafts
    rel = relationsOf(spans);
    keep = filterOf(filters, rel);
    placer = grouping === "product" ? productPlacer(rel) : executionPlacer(rel);
    placeAll(spans, placer, keep);
  }
  const drafts = placer.drafts;
  const version = ++drafts.version;
  if (grouping === "execution") numberRuns(drafts.roots, liveAt);
  const finisher = new Finisher(liveAt, filters.attentionOnly, before);
  const finished: Finished[] = [];
  const orderOf = new Map(drafts.roots.map((r) => [r.id, r] as const));
  for (const root of drafts.roots) {
    const done = finisher.finish(root, 0);
    if (done) finished.push(done);
  }
  finished.sort((a, b) => {
    const da = orderOf.get(a.node.id) as Draft;
    const db = orderOf.get(b.node.id) as Draft;
    if (da.order !== db.order) return da.order - db.order;
    if (da.byTime && db.byTime && a.from !== b.from) return a.from - b.from;
    return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
  });
  const tree = makeTree(grouping, finished.map((f) => f.node), finisher.byId, rel);
  internals.set(tree, { memo: finisher.memo, input: spans, rel, filters, keep, placer, version });
  return tree;
}
