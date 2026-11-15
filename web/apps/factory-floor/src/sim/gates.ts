/**
 * Gates as one source of truth for every view: the words for a gate's state, the gate states of one
 * ticket (indexed once per `scene.gates` object, never a scan of every gate per cell), and the gate a
 * ref names, whichever vocabulary the ref comes from.
 *
 * Two vocabularies name one gate. The scene's gate states have M6.0 ids (`LOCAL-001/plan-check`,
 * `LOCAL-001/verification#1`); the observer names each lifecycle evaluation by its own gate
 * (`gate:LOCAL-001/plan.check`, `gate:LOCAL-001/verify.verdict#1`, `…/frozen-tests#2`, contract 5.2).
 * `gateOfRef` resolves the second to the first through the evaluations the scene recorded (each
 * keeps its ref), never by parsing meaning out of the id. An evaluation no gate state stands for
 * (frozen-tests, build.start, verify.start...) resolves to itself: a `recorded` gate built from its
 * evaluations.
 */
import type { CellState, GateEvaluation, GateState, Scene } from "./model";
import { gateId } from "./model";
import type { GateKind } from "./vocabulary";

/** A gate state in one word. */
export const GATE_STATE_WORDS: Readonly<Record<GateState["state"], string>> = {
  open: "Checking",
  passed: "Passed",
  failed: "Refused",
  waiting: "Waiting for a person",
  skipped: "Not needed",
  overridden: "Overridden",
};

/** A gate's state in words, with the recorded reason code of an override or a refusal ("Overridden: test-passed-first-run"). */
export function gateStateWords(gate: Pick<GateState, "state" | "reasonCode">): string {
  const word = GATE_STATE_WORDS[gate.state];
  return (gate.state === "overridden" || gate.state === "failed") && gate.reasonCode ? `${word}: ${gate.reasonCode}` : word;
}

/** A lifecycle gate's own name in words: `frozen-tests` "Frozen tests", `verify.start` "Verify start". */
export function recordedGateWords(name: string): string {
  const words = name.replace(/[-._]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Gate";
}

/**
 * The gate state a lifecycle gate maps to, whatever its verdict, or null when no gate kind stands
 * for it. (The reducer sets a state only for some verdicts: a passed red-before-green task is a
 * build fact, not a gate decision; the kind is the same.)
 */
export function gateKindOfEvaluation(name: string): GateKind | null {
  switch (name) {
    case "audit.readiness":
      return "audit";
    case "plan.check":
      return "plan-check";
    case "verify.verdict":
      return "verification";
    case "build.red":
    case "build.green":
    case "red-before-green":
      return "red-before-green";
    case "merge.land":
      return "merge-revalidation";
    default:
      return null;
  }
}

// ---------------------------------------------------------------- one ticket's gate states, indexed

type GateRecord = Scene["gates"];
const byTicketCache = new WeakMap<GateRecord, ReadonlyMap<string, readonly GateState[]>>();
const EMPTY: readonly GateState[] = Object.freeze([]);

function byTicket(gates: GateRecord): ReadonlyMap<string, readonly GateState[]> {
  let index = byTicketCache.get(gates);
  if (!index) {
    const out = new Map<string, GateState[]>();
    for (const g of Object.values(gates)) {
      const list = out.get(g.ticketId);
      if (list) list.push(g);
      else out.set(g.ticketId, [g]);
    }
    for (const list of out.values()) list.sort((a, b) => a.openedAt - b.openedAt || a.seq - b.seq);
    index = out;
    byTicketCache.set(gates, index);
  }
  return index;
}

/** One ticket's gate states, oldest first. The same array while `scene.gates` is the same object. */
export function gatesOfTicket(scene: Pick<Scene, "gates">, ticketId: string): readonly GateState[] {
  return byTicket(scene.gates).get(ticketId) ?? EMPTY;
}

const latestCache = new WeakMap<GateRecord, Map<string, GateState | null>>();
/**
 * The latest gate of one kind (of one ticket, or of any), by when it opened. Computed once per
 * `scene.gates` object and question: a cell bay asks it on every store change.
 */
export function latestGateOf(scene: Pick<Scene, "gates">, kind: GateState["gate"], ticketId?: string): GateState | null {
  let cache = latestCache.get(scene.gates);
  if (!cache) latestCache.set(scene.gates, (cache = new Map()));
  const key = `${kind}\u0000${ticketId ?? ""}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pool = ticketId === undefined ? Object.values(scene.gates) : gatesOfTicket(scene, ticketId);
  let found: GateState | null = null;
  for (const g of pool) {
    if (g.gate !== kind) continue;
    if (!found || g.openedAt > found.openedAt || (g.openedAt === found.openedAt && g.seq > found.seq)) found = g;
  }
  cache.set(key, found);
  return found;
}

// ---------------------------------------------------------------- resolving a ref of either vocabulary

const recordedCache = new WeakMap<CellState, Map<string, GateState>>();

function cellsForRef(scene: Scene, id: string): readonly CellState[] {
  // The cell part of the contract's gate grammar (`<cell>/<gate>`) only narrows the search; every
  // cell is tried when it is not a ticket held (a later incarnation `~k`).
  const slash = id.indexOf("/");
  const hinted = slash > 0 ? scene.cells[id.slice(0, slash)] : undefined;
  return hinted ? [hinted, ...Object.values(scene.cells).filter((c) => c !== hinted)] : Object.values(scene.cells);
}

/**
 * The gate a ref id names at this scene (`id` without `gate:`): the scene's own gate state; else the
 * gate state the evaluations recorded under that observer ref set (or whose kind it is, for a
 * ticket and round that has one); else a `recorded` gate built from those evaluations. Null when the
 * history at this moment holds neither.
 */
export function gateOfRef(scene: Scene, id: string): GateState | null {
  const own = scene.gates[id];
  if (own) return own;
  const full = `gate:${id}`;
  for (const cell of cellsForRef(scene, id)) {
    const evaluations = cell.gateLog.filter((g) => g.ref === full);
    if (!evaluations.length) continue;
    return stateFor(scene, cell, full, evaluations);
  }
  return null;
}

function stateFor(scene: Scene, cell: CellState, full: string, evaluations: readonly GateEvaluation[]): GateState {
  for (let i = evaluations.length - 1; i >= 0; i--) {
    const set = evaluations[i]!.gateId;
    if (set && scene.gates[set]) return scene.gates[set]!;
  }
  const last = evaluations[evaluations.length - 1]!;
  const kind = gateKindOfEvaluation(last.gate);
  if (kind) {
    const same = scene.gates[gateId(cell.ticketId, kind, last.round ?? cell.round)];
    if (same) return same;
  }
  let perCell = recordedCache.get(cell);
  if (!perCell) recordedCache.set(cell, (perCell = new Map()));
  const cached = perCell.get(full);
  if (cached && cached.recorded?.evaluations.length === evaluations.length) return cached;
  const made = recordedGate(cell.ticketId, full.slice("gate:".length), evaluations);
  perCell.set(full, made);
  return made;
}

const verdictState = (v: GateEvaluation["verdict"]): GateState["state"] => (v === "passed" ? "passed" : v === "overridden" ? "overridden" : "failed");

function verdictWords(g: GateEvaluation): string {
  if (g.verdict === "overridden") return `Overridden${g.subject ? ` for ${g.subject}` : ""}: ${g.reasonCode ?? "no reason code"}`;
  if (g.verdict === "refused") return `Refused${g.subject ? ` for ${g.subject}` : ""}: ${g.reasonCode ?? "no reason code"}`;
  return `Passed${g.subject ? ` for ${g.subject}` : ""}`;
}

/** A gate no gate state stands for, from its recorded evaluations (oldest first). */
export function recordedGate(ticketId: string, id: string, evaluations: readonly GateEvaluation[]): GateState {
  const first = evaluations[0]!;
  const last = evaluations[evaluations.length - 1]!;
  const detail = evaluations.length === 1 ? `${verdictWords(last)}.` : `Evaluated ${evaluations.length} times: ${evaluations.map(verdictWords).join("; ")}.`;
  return {
    id,
    ticketId,
    gate: "recorded",
    round: last.round,
    state: verdictState(last.verdict),
    detail,
    openedAt: first.at,
    decidedAt: last.at,
    seq: 0,
    reasonCode: last.reasonCode,
    meta: { authority: "authoritative", eventId: last.eventId, fields: {}, unknown: [], inferred: {}, start: "measured", end: "measured", late: last.late },
    recorded: { name: last.gate, evaluations },
  };
}

/** A gate's name in words, for any gate state (a `recorded` gate by its lifecycle name). */
export function gateNameWords(gate: Pick<GateState, "gate" | "recorded">, words: Readonly<Record<GateKind, string>>): string {
  return gate.gate === "recorded" ? recordedGateWords(gate.recorded?.name ?? "gate") : words[gate.gate];
}

// ---------------------------------------------------------------- a cell's Gates list

export interface CellGateEntry {
  /** The ref to select: the gate state's own, or the evaluation's (observer) ref. */
  readonly ref: `gate:${string}`;
  readonly gate: GateState;
}

/**
 * Every gate the history evaluated for one cell (D6): each gate state, and each gate the lifecycle
 * log evaluated that no gate state stands for (every override and refusal, and every pass: build.start,
 * verify.start, frozen-tests...), one entry per gate and round, oldest first. An evaluation that set
 * (or is of the kind of) a gate state is that state's entry, never a second one.
 */
export function cellGateList(scene: Scene, ticketId: string): readonly CellGateEntry[] {
  const cell = scene.cells[ticketId];
  const out: CellGateEntry[] = [];
  const seen = new Set<string>();
  for (const g of gatesOfTicket(scene, ticketId)) {
    seen.add(g.id);
    out.push({ ref: `gate:${g.id}`, gate: g });
  }
  if (cell) {
    const refs = new Map<string, GateEvaluation[]>();
    for (const e of cell.gateLog) {
      const list = refs.get(e.ref);
      if (list) list.push(e);
      else refs.set(e.ref, [e]);
    }
    for (const [full, evaluations] of refs) {
      const gate = stateFor(scene, cell, full, evaluations);
      if (seen.has(gate.id)) continue;
      seen.add(gate.id);
      out.push({ ref: full as `gate:${string}`, gate });
    }
  }
  return out.sort((a, b) => a.gate.openedAt - b.gate.openedAt);
}
