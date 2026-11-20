/**
 * How the "How <epic> works today" page arranges what `epic.current` returned. It only sorts the
 * engine's lists into groups for reading and looks things up by the IDs the engine gave; which
 * rule is in force, replaced or retired is the engine's answer and is never worked out here.
 * Pure: imported by the screen and by test/epic-today-model.test.mjs.
 */
import type { EpicView, ShippedRule } from "@mach/ui/api";

export type GroupId = "invariants" | "requirements" | "decisions" | "other" | "not-reconciled" | "no-longer" | "not-applied" | "conflicts";

export interface RuleGroup {
  id: GroupId;
  title: string;
  /** One sentence under the heading that says what the group holds. */
  hint: string;
  rules: ShippedRule[];
}

export interface NotApplied {
  slice_id: string;
  problems: Array<{ line: number | null; code: string | null; message: string }>;
}

export interface EpicPage {
  /** The rules in force, by kind, then the rules shipped before effects were declared, then those no longer in force. Empty groups are left out. */
  groups: RuleGroup[];
  notApplied: NotApplied[];
  conflicts: string[];
  /** Every group on the page, in order, with its count, for the list that jumps between them. */
  jumps: Array<{ id: GroupId; title: string; count: number }>;
  inForce: number;
}

const KIND_GROUPS: Array<{ id: GroupId; kind: string; title: string; hint: string }> = [
  { id: "invariants", kind: "invariant", title: "Rules that always hold", hint: "Limits the product must never break, whatever happens." },
  { id: "requirements", kind: "requirement", title: "What the product does", hint: "Behaviour in force, including refusals and the exact words people see." },
  { id: "decisions", kind: "decision rule", title: "Decisions", hint: "Each combination of conditions and the outcome it leads to." },
];

/** `not_applied` as the engine lists it ({slice_id, problems}); anything else is left out. */
export function notApplied(items: unknown[] | null | undefined): NotApplied[] {
  const out: NotApplied[] = [];
  for (const item of items ?? []) {
    if (!item || typeof item !== "object") continue;
    const record = item as { slice_id?: unknown; problems?: unknown };
    if (typeof record.slice_id !== "string") continue;
    const problems = Array.isArray(record.problems) ? record.problems : [];
    out.push({
      slice_id: record.slice_id,
      problems: problems
        .filter((p): p is { line?: unknown; code?: unknown; message: string } => !!p && typeof p === "object" && typeof (p as { message?: unknown }).message === "string")
        .map((p) => ({ line: typeof p.line === "number" ? p.line : null, code: typeof p.code === "string" ? p.code : null, message: p.message })),
    });
  }
  return out;
}

/** `conflicts` as the engine lists them: sentences. */
export function conflicts(items: unknown[] | null | undefined): string[] {
  return (items ?? []).filter((c): c is string => typeof c === "string" && c.trim() !== "");
}

/** The page's groups, in reading order. */
export function epicPage(epic: EpicView): EpicPage {
  const groups: RuleGroup[] = [];
  const known = new Set(KIND_GROUPS.map((g) => g.kind));
  for (const g of KIND_GROUPS) {
    const rules = epic.in_force.filter((r) => r.kind === g.kind);
    if (rules.length) groups.push({ id: g.id, title: g.title, hint: g.hint, rules });
  }
  const other = epic.in_force.filter((r) => !known.has(r.kind));
  if (other.length) groups.push({ id: "other", title: "Other rules in force", hint: "Rules of a kind this page does not group.", rules: other });
  if (epic.not_yet_reconciled.length) {
    groups.push({
      id: "not-reconciled",
      title: "Not yet reconciled",
      hint: "These shipped before slices said what they do to earlier behaviour. They are shown as written; no later slice has confirmed, changed or retired them.",
      rules: epic.not_yet_reconciled,
    });
  }
  if (epic.no_longer_in_force.length) {
    groups.push({ id: "no-longer", title: "No longer in force", hint: "Kept for history: what each one was, and what a later slice did to it.", rules: epic.no_longer_in_force });
  }
  const skipped = notApplied(epic.not_applied);
  const clashes = conflicts(epic.conflicts);
  const jumps: EpicPage["jumps"] = groups.map((g) => ({ id: g.id, title: g.title, count: g.rules.length }));
  if (skipped.length) jumps.push({ id: "not-applied", title: "Effects not applied", count: skipped.length });
  if (clashes.length) jumps.push({ id: "conflicts", title: "Conflicts", count: clashes.length });
  return { groups, notApplied: skipped, conflicts: clashes, jumps, inForce: epic.in_force.length };
}

/** A shipped slice's title by its ID, from the epic's own list; null when the engine gave none. */
export function sliceTitle(epic: EpicView, sliceId: string): string | null {
  return epic.slices.find((s) => s.slice_id === sliceId)?.title ?? null;
}

/** The earlier wording of a rule this one took the place of, when the epic still lists it. */
export function earlierText(epic: EpicView, rule: string): string | null {
  return epic.no_longer_in_force.find((r) => r.rule === rule)?.text ?? null;
}

/** What a shipped slice's effects section was, in words. */
export const sliceEffectsWords: Record<string, string> = {
  declared: "Says what it does to earlier rules",
  none: "Changes no earlier rule",
  missing: "Shipped before slices said what they change",
  problems: "Its effects could not be applied",
};

/** The effect in a word, for a rule's history. */
export const effectWord: Record<string, string> = { kept: "Kept", changed: "Changed", replaced: "Replaced", retired: "Retired" };
