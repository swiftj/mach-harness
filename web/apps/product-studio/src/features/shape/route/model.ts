/**
 * Size and route, and Change what exists: the screens' logic, from the engine's answers alone. Pure, so it is
 * unit-tested (test/shape-route-model.test.mjs). It adds no product rule: the engine counts, names the route, says
 * whether it still holds, decides coverage and can refuse every act. This only says what to show and what each button
 * would send. It follows the PRD on-ramp's model (features/prd/model.ts) so the two read as one product.
 */
import type {
  EpicView,
  IdeaAct,
  IdeaSized,
  IdeaVerdict,
  RecordedRoute,
  RouteCounted,
  RouteView,
  ShapeApplied,
  ShapeCoverageRow,
  ShapeMapSlice,
  ShapeMapStatus,
  ShapeRoute,
  ShippedRule,
} from "@mach/ui/api";

/* ── Where the product manager is ──────────────────────────────────────── */

export const JOURNEY: Array<{ label: string }> = [{ label: "Size it" }, { label: "Map" }, { label: "Settle what no slice carries" }, { label: "Make the drafts" }];

/**
 * The step of sizing and the map the idea is at (0-based, as the Stepper counts): 0 size, 1 map, 2 settle, 3 make the
 * drafts, 4 when the drafts are made (every step done). A route that does not hold is sized again first.
 */
export function journeyStep(route: RouteState, status: Pick<ShapeMapStatus, "map" | "not_covered"> | null): number {
  if (status?.map?.applied) return 4;
  if (route.kind !== "holds") return 0;
  if (!status?.map) return 1;
  if ((status.not_covered ?? []).length > 0) return 2;
  return 3;
}

/* ── Whether it can be sized ───────────────────────────────────────────── */

export type Gate =
  | { kind: "go" }
  /** No verdict, or one that is not Go, or a Go the engine would still not size on: `why` is its sentence. */
  | { kind: "no-go"; decision: string | null; why: string | null }
  /** A Go (or another verdict) recorded on an earlier brief: the engine's sentence says why it no longer holds. */
  | { kind: "stale"; decision: string; note: string | null; why: string | null };

/**
 * Whether the idea may be sized now: the engine's own answer (`idea.show`'s `acts.size`), with the verdict as it reported
 * it to say what was recorded. Never worked out here: without the engine's answer, sizing is not offered.
 */
export function sizeGate(verdict: IdeaVerdict | null | undefined, act: IdeaAct | null | undefined): Gate {
  if (act?.allowed) return { kind: "go" };
  const why = act?.why ?? null;
  if (!verdict) return { kind: "no-go", decision: null, why };
  if (verdict.stale || !verdict.holds) return { kind: "stale", decision: verdict.decision, note: verdict.stale_note ?? null, why };
  return { kind: "no-go", decision: verdict.decision, why };
}

/** What is needed before sizing, in the engine's words: the sentence it would refuse sizing with, said before the click. */
export function gateWords(gate: Gate): string[] {
  if (gate.kind === "go") return [];
  return gate.why ? [gate.why] : [];
}

/* ── The route as it stands ───────────────────────────────────────────── */

export type RouteState =
  | { kind: "not-sized" }
  | { kind: "holds"; route: ShapeRoute; why: string; at: string; counted: RouteCounted | null }
  | { kind: "stale"; route: ShapeRoute; why: string; at: string; counted: RouteCounted | null; note: string | null };

/**
 * The route from the engine's three answers: a size just made on this page (it holds, the engine having just recorded
 * it), else the record in `idea.show` with `idea.map-status`'s view of whether it still holds.
 */
export function routeState(recorded: RecordedRoute | null | undefined, view: RouteView | null | undefined, sized?: IdeaSized | null): RouteState {
  if (sized) return { kind: "holds", route: sized.route, why: sized.why, at: "", counted: sized.counted };
  const base = recorded ?? view ?? null;
  if (!base) return { kind: "not-sized" };
  const counted = recorded?.counted ?? view?.counted ?? null;
  if (view && view.holds && (!recorded || view.brief_sha256 === recorded.brief_sha256)) return { kind: "holds", route: base.route, why: base.why, at: base.at, counted };
  return { kind: "stale", route: base.route, why: base.why, at: base.at, counted, note: view?.stale_note ?? null };
}

/** The four routes, in the order of their size. The engine's rule chooses one; none is ever chosen here. */
export const ROUTES: ReadonlyArray<{ route: ShapeRoute; name: string; when: string; next: string }> = [
  {
    route: "small-change",
    name: "A small change",
    when: "One outcome in one capability, at most one shipped rule, and nothing in a high-risk area.",
    next: "One draft slice of kind small: the short interview, started from the brief.",
  },
  {
    route: "one-slice",
    name: "One slice",
    when: "One outcome and at most three shipped rules.",
    next: "The slice interview, started from the brief.",
  },
  {
    route: "epic",
    name: "An epic",
    when: "Outcomes inside one capability.",
    next: "A map of thin slices in build order, in one epic.",
  },
  {
    route: "several-epics",
    name: "Several epics",
    when: "Outcomes in different capabilities.",
    next: "A map of epics, and thin slices in each.",
  },
];

export const routeName = (route: string): string => ROUTES.find((r) => r.route === route)?.name ?? route;

/* ── What MACH counted ────────────────────────────────────────────────── */

export interface CountedRow {
  label: string;
  /** The count in words: a number, or "Not determined" (never zero for a count the engine could not make). */
  value: string;
  /** A short sentence under it, when the engine reported one. */
  note: string | null;
}

const listWords = (ids: readonly string[]): string => (ids.length <= 1 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`);

/** High-risk areas in words: a number, or "Not determined", and which rules could not be read either way. */
export function highRiskWords(counted: Pick<RouteCounted, "high_risk_areas" | "high_risk_not_determined">): { value: string; note: string | null } {
  const missing = counted.high_risk_not_determined ?? [];
  if (counted.high_risk_areas === null) {
    return { value: "Not determined", note: missing.length ? `Not determined for ${listWords(missing)}: nothing on this computer says which files their slice changed.` : null };
  }
  const value = counted.high_risk_areas === 0 ? "None found" : String(counted.high_risk_areas);
  return { value, note: missing.length ? `Not determined for ${listWords(missing)}.` : null };
}

/** The counts the engine made, in the order the rule reads them, then what it counts beside the rule. */
export function countedRows(counted: RouteCounted): CountedRow[] {
  const risk = highRiskWords(counted);
  return [
    { label: "Outcomes", value: String(counted.outcomes), note: null },
    { label: "Capabilities", value: String(counted.capabilities), note: null },
    {
      label: "Shipped rules touched",
      value: String(counted.shipped_rules),
      note: counted.shipped_rules_looked_up ? `${counted.shipped_rules_looked_up} more looked up while exploring.` : null,
    },
    { label: "High-risk areas", value: risk.value, note: risk.note },
    { label: "Principle concerns", value: String(counted.principle_concerns), note: null },
    { label: "Policy concerns", value: String(counted.policy_concerns), note: null },
  ];
}

/* ── Coverage ─────────────────────────────────────────────────────────── */

export interface Coverage {
  /** Outcomes that needed the product manager's word: settled ones and the ones still open. */
  total: number;
  settled: number;
  /** The outcomes still open, in the brief's order. */
  left: ShapeCoverageRow[];
}

/** Settled of total, counting only outcomes no slice carries (an outcome a slice carries needs no word). */
export function coverageProgress(coverage: readonly ShapeCoverageRow[] | undefined): Coverage {
  const rows = coverage ?? [];
  const settled = rows.filter((r) => r.state === "settled").length;
  const left = rows.filter((r) => r.state === "not_covered");
  return { total: settled + left.length, settled, left };
}

/** One outcome's coverage, in words, for its row. */
export function coverageWords(row: ShapeCoverageRow, slices: readonly Pick<ShapeMapSlice, "key" | "title">[]): string {
  const name = (key: string) => {
    const found = slices.find((s) => s.key === key);
    return found ? `${key}, “${found.title}”` : key;
  };
  switch (row.state) {
    case "covered":
      return `Carried by ${row.carried_by.map(name).join(" and ")}`;
    case "not_covered":
      return "No slice carries it";
    case "settled": {
      const s = row.settled;
      if (!s) return "Settled";
      if (s.as === "slice") return `Settled: part of ${name(s.slice ?? "")}`;
      if (s.as === "later") return "Settled: later";
      return "Settled: out of scope";
    }
    default:
      return row.state;
  }
}

/* ── Settling one outcome ─────────────────────────────────────────────── */

export type SettleChoice = "slice" | "out-of-scope" | "later";

export interface SettleForm {
  choice: SettleChoice | "";
  slice: string;
  reason: string;
}

/** The reason's bound, as the host checks it: one line, at most 300 characters. */
export const REASON_MAX = 300;

export type SettleArgs =
  | { idea_id: string; outcome: string; as: "slice"; slice: string; reason?: string }
  | { idea_id: string; outcome: string; as: "out-of-scope" | "later"; reason: string };

/** The words the form says when out of scope or later has no reason: leaving an outcome out is the PM's decision, with why. */
export const REASON_NEEDED = "Say why it is left out, in your own words. Out of scope and later each need your reason.";

/**
 * What `idea.settle` is sent, or the one thing the form still needs, in words. The reason is kept to one line; out of
 * scope and later need it (the engine refuses them without one), part of a slice does not.
 */
export function settleArgs(ideaId: string, outcome: string, form: SettleForm): { args: SettleArgs } | { missing: string } {
  const reason = form.reason.trim().replace(/\s+/g, " ");
  const extra = reason ? { reason } : {};
  if (form.choice === "") return { missing: "Choose what this outcome is: part of a slice, out of scope, or later." };
  if (form.choice === "slice") {
    if (!form.slice) return { missing: "Choose the slice that carries this outcome." };
    return { args: { idea_id: ideaId, outcome, as: "slice", slice: form.slice, ...extra } };
  }
  if (!reason) return { missing: REASON_NEEDED };
  return { args: { idea_id: ideaId, outcome, as: form.choice, reason } };
}

/* ── Making the drafts ────────────────────────────────────────────────── */

export interface ApplyPlan {
  epics: Array<{ key: string; title: string }>;
  slices: Array<{ key: string; title: string; epic: string }>;
}

/** The two kinds of small change, as the product manager chooses one when the route is a small change (M18). */
export type SmallChangeKind = "fix" | "adjustment";
export const SMALL_CHANGE_KINDS: ReadonlyArray<{ kind: SmallChangeKind; name: string; words: string }> = [
  { kind: "fix", name: "A fix", words: "A shipped rule is not holding." },
  { kind: "adjustment", name: "An adjustment", words: "Wording, presentation, a default or a limit." },
];

/** Whether making the drafts needs the product manager to say which kind of small change it is: the route is a small change and its slice is not made yet. */
export function needsSmallKind(status: Pick<ShapeMapStatus, "route" | "map">): boolean {
  return status.route?.route === "small-change" && !status.map?.applied;
}

/** What `idea.apply` is sent: the kind only when the route is a small change, or the one thing still missing. */
export function applyArgs(
  ideaId: string,
  status: Pick<ShapeMapStatus, "route" | "map">,
  kind: SmallChangeKind | "",
): { args: { idea_id: string; change?: SmallChangeKind } } | { missing: string } {
  if (!needsSmallKind(status)) return { args: { idea_id: ideaId } };
  if (!kind) return { missing: "Choose which kind of small change this is: a fix or an adjustment." };
  return { args: { idea_id: ideaId, change: kind } };
}

/** What `idea.apply` would make, by name, in the map's order. `epicTitle` names an existing epic. */
export function applyPlan(map: NonNullable<ShapeMapStatus["map"]>, epicTitle: (epicId: string) => string | null): ApplyPlan {
  const newEpic = new Map(map.epics.map((e) => [e.key, e.title]));
  return {
    epics: map.epics.map((e) => ({ key: e.key, title: e.title })),
    slices: map.slices.map((s) => ({ key: s.key, title: s.title, epic: newEpic.get(s.epic) ?? epicTitle(s.epic) ?? s.epic })),
  };
}

/** "1 epic and 2 draft slices": what the button and dialog name. */
export function applyWhat(plan: ApplyPlan): string {
  const n = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;
  return [plan.epics.length ? n(plan.epics.length, "epic") : null, n(plan.slices.length, "draft slice")].filter(Boolean).join(" and ");
}

/** What an apply made and what already existed, from its answer: each epic and slice by ID, in the engine's order. */
export function applyOutcome(result: Pick<ShapeApplied, "made" | "kept" | "missing">): { made: string[]; kept: string[]; missing: string[]; nothingNew: boolean } {
  const made = [...result.made.epics, ...result.made.slices];
  const kept = [...result.kept.epics, ...result.kept.slices];
  return { made, kept, missing: result.missing, nothingNew: made.length === 0 };
}

/** Why the drafts cannot be made yet, from the engine's answer: outcomes not settled and its blockers, in its words. */
export function applyBlocked(status: Pick<ShapeMapStatus, "not_covered" | "blockers" | "can_apply" | "map">): string[] {
  if (status.map?.applied || status.can_apply) return [];
  const out: string[] = [];
  const left = status.not_covered ?? [];
  if (left.length) out.push(`Settle ${left.length === 1 ? left[0] : listWords(left)} first. Nothing is made while any outcome is unsettled.`);
  out.push(...(status.blockers ?? []));
  return out;
}

/* ── The parts of the page (M16 layout) ───────────────────────────────── */

/** The page's four parts, one per step of the journey, in its order. */
export type RoutePart = "size" | "map" | "settle" | "apply";
export const ROUTE_PARTS: readonly RoutePart[] = ["size", "map", "settle", "apply"];

/** The part that needs the product manager at a journey step: the current step's, and the drafts once they are made. */
export function partForStep(step: number): RoutePart {
  return ROUTE_PARTS[Math.min(Math.max(step, 0), ROUTE_PARTS.length - 1)] as RoutePart;
}

/** Where a part is on the journey: done before the current step, the current step, or not reached. */
export function partPlace(part: RoutePart, step: number): "done" | "current" | "later" {
  const index = ROUTE_PARTS.indexOf(part);
  return index < step ? "done" : index === step ? "current" : "later";
}

/** Each part's state in one line of plain words, from the engine's answers only; anything blocking the next act is in it. */
export function sizeSummary(route: RouteState, gate: Gate): string {
  if (route.kind === "holds") return `Route: ${routeName(route.route).toLowerCase()}`;
  if (route.kind === "stale") return `Route: ${routeName(route.route).toLowerCase()}, which no longer holds. Size it again.`;
  return gate.kind === "go" ? "Not sized yet" : "Not ready to size: it needs a Go on the brief as it is now";
}

export function mapSummary(status: Pick<ShapeMapStatus, "map"> | null): string {
  const map = status?.map;
  if (!map) return "No map yet: it is proposed in Claude Code";
  const n = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;
  const what = [map.epics.length ? n(map.epics.length, "new epic") : null, `${n(map.slices.length, "thin slice")} in build order`].filter(Boolean).join(" and ");
  return map.applied ? `${what}, kept as it was when the drafts were made` : what;
}

export function settleSummary(coverage: readonly ShapeCoverageRow[] | undefined): string {
  const progress = coverageProgress(coverage);
  const n = (count: number) => `${count} ${count === 1 ? "outcome" : "outcomes"}`;
  if (!(coverage ?? []).length) return "No outcomes to show";
  if (progress.total === 0) return "Every outcome is carried by a slice on the map";
  if (progress.left.length) return `${n(progress.left.length)} still to settle: ${progress.left.map((r) => r.outcome).join(", ")}`;
  return `Every outcome no slice carries is settled (${progress.settled} of ${progress.total})`;
}

export function applySummary(
  status: Pick<ShapeMapStatus, "not_covered" | "blockers" | "can_apply" | "map">,
  plan: ApplyPlan | null,
  made: { epics: readonly string[]; slices: readonly string[] } | null,
): string {
  if (status.map?.applied) {
    const ids = [...(made?.epics ?? []), ...(made?.slices ?? [])];
    return ids.length ? `Made: ${ids.join(", ")}` : "The drafts were made";
  }
  const blocked = applyBlocked(status);
  if (blocked.length) return blocked[0] as string;
  return plan ? `Ready to make ${applyWhat(plan)}` : "Ready to make the drafts";
}

/* ── The brief's own lines, as data ───────────────────────────────────── */

/** The brief's lines by number, from `brief.show`'s text. The text is kept exactly as the engine gave it. */
export function briefLines(text: string | null | undefined): Map<number, string> | null {
  if (typeof text !== "string") return null;
  const out = new Map<number, string>();
  text.split("\n").forEach((line, index) => out.set(index + 1, line));
  return out;
}


/** Line ranges and quotations are the PRD on-ramp's, shared (shared/lineRanges.ts). */
export { parseRanges, quote, rangeWords } from "../../../shared/lineRanges.ts";
export type { Quotation } from "../../../shared/lineRanges.ts";

/** The brief's words for an outcome, from its model; null when the brief as read has no such outcome. */
export function outcomeText(show: { model: { outcomes: Array<{ id: string; text: string }> } } | null | undefined, outcome: string): string | null {
  return show?.model.outcomes.find((o) => o.id === outcome)?.text ?? null;
}

/* ── Change what exists ───────────────────────────────────────────────── */

/** A shipped rule as the host accepts it: SLICE-NNN/FR-NN, SLICE-NNN/INV-NN or SLICE-NNN/RN. */
const RULE = /^(SLICE-\d{3,})\/((?:FR|INV)-\d{2,}|R\d+)$/;

/** The rule named in the address, or null when none or not the shape of one. */
export function parseRule(param: string | null | undefined): { rule: string; sliceId: string; id: string } | null {
  const text = (param ?? "").trim();
  const match = RULE.exec(text);
  return match ? { rule: text, sliceId: match[1] as string, id: match[2] as string } : null;
}

export type RuleStanding = "in-force" | "not-reconciled" | "no-longer";

export const standingWords: Record<RuleStanding, string> = {
  "in-force": "In force",
  "not-reconciled": "In force, not yet reconciled",
  "no-longer": "No longer in force",
};

/** The rule in the epic as the engine compiled it, with where the engine listed it; null when it did not list it. */
export function findRule(epic: EpicView | null | undefined, rule: string): { rule: ShippedRule; standing: RuleStanding } | null {
  if (!epic) return null;
  const inForce = epic.in_force.find((r) => r.rule === rule);
  if (inForce) return { rule: inForce, standing: "in-force" };
  const open = epic.not_yet_reconciled.find((r) => r.rule === rule);
  if (open) return { rule: open, standing: "not-reconciled" };
  const gone = epic.no_longer_in_force.find((r) => r.rule === rule);
  return gone ? { rule: gone, standing: "no-longer" } : null;
}

export interface Connection {
  /** What the engine recorded: a slice that confirmed the rule, or a rule it took the place of. */
  kind: "confirmed" | "took-the-place-of";
  /** A slice (confirmed) or a rule (took the place of). */
  id: string;
  words: string;
  note: string | null;
}

const effectWords: Record<string, string> = { kept: "kept", changed: "changed", replaced: "replaced", retired: "retired" };

/**
 * The connections the engine listed on the rule: each slice that declared it kept (its `confirmed_by`), and each
 * rule it took the place of. MACH carries these in when the idea starts; nothing is added here.
 */
export function connections(rule: ShippedRule): Connection[] {
  const out: Connection[] = [];
  for (const c of rule.confirmed_by ?? []) {
    out.push({ kind: "confirmed", id: c.slice_id, words: `${c.slice_id} declared it kept, in its example ${c.scenario}`, note: c.note });
  }
  for (const h of rule.takes_the_place_of ?? []) {
    out.push({ kind: "took-the-place-of", id: h.rule, words: `It ${effectWords[h.effect] ?? h.effect} ${h.rule}`, note: h.note });
  }
  return out;
}

/** The epic a rule's slice belongs to: the one the address names, else the one the status lists for its slice. */
export function epicOfRule(epicParam: string | null, sliceId: string, slices: ReadonlyArray<{ slice_id: string; epic_id: string }> | undefined): string | null {
  if (epicParam && /^EPIC-\d{3,}$/.test(epicParam)) return epicParam;
  return slices?.find((s) => s.slice_id === sliceId)?.epic_id ?? null;
}

/** The title an idea started from a rule may carry: one line, at most 120 characters; empty means the engine names it. */
export function changeArgs(rule: string, title: string): { rule: string; title?: string } {
  const clean = title.trim().replace(/\s+/g, " ");
  return clean ? { rule, title: clean.slice(0, 120) } : { rule };
}
