/**
 * A small change in the app (M18 part C, docs/mach-next/M18_APP.md): the words, the start's arguments, the label and
 * the line on a slice that became a full slice. Pure: the unit tests import this file directly. Whether a change is
 * small is the engine's to decide; nothing here judges it. The app's words are "small change" and "full slice".
 */
import type { EpicCurrent, ShippedRule, SmallStart, SmallWidened, StatusSliceRow, WorkOrder } from "@mach/ui/api";

/** What a small change is, said once wherever one is started. */
export const SMALL_CHANGE_MEANS =
  "A small change asks fewer questions and writes a shorter spec. Nothing is checked less: it goes through every check in the Factory, as any slice does.";

/** What happens when it turns out bigger. */
export const SMALL_CHANGE_GROWS = "If it turns out to be more than a small change, MACH makes it a full slice and keeps every answer.";

export type StartAs = "slice" | "small";
export type ChangeKind = "fix" | "adjustment";

export const startOptions: ReadonlyArray<{ value: StartAs; label: string; description: string }> = [
  { value: "slice", label: "A new slice", description: "One complete outcome for one type of user. The interview works through it with you." },
  { value: "small", label: "A small change", description: "A fix or an adjustment to something that has shipped. Fewer questions, a shorter spec." },
];

export const changeOptions: ReadonlyArray<{ value: ChangeKind; label: string; description: string }> = [
  { value: "fix", label: "A fix", description: "Something that has shipped is not working as it should." },
  { value: "adjustment", label: "An adjustment", description: "Different wording or presentation, a default or a limit." },
];

/** SLICE-NNN/ and an INV-NN, FR-NN or RN: the rules a fix may name (the engine's own pattern, small.SHIPPED_RULE_RE). */
export const FIXABLE_RULE = /^SLICE-\d{3,}\/(?:(?:INV|FR)-\d{2,}|R\d+)$/;

/** The shipped rules a fix may name, from how the epic works today: those in force, then those shipped before effects
 *  were recorded. Scenarios are not rules a fix names. */
export function rulesToFix(current: EpicCurrent | null | undefined): ShippedRule[] {
  const epic = current?.epic;
  if (!epic) return [];
  const seen = new Set<string>();
  return [...epic.in_force, ...epic.not_yet_reconciled].filter((r) => FIXABLE_RULE.test(r.rule) && !seen.has(r.rule) && Boolean(seen.add(r.rule)));
}

export interface StartChoice {
  as: StartAs;
  change: ChangeKind | null;
  rule: string | null;
}

export const fullSlice: StartChoice = { as: "slice", change: null, rule: null };

/** The `small` argument for slice.new and request.pick, or what is still missing in the person's terms. */
export function smallArgs(choice: StartChoice): { small?: SmallStart; missing?: "change" | "rule" } {
  if (choice.as === "slice") return {};
  if (choice.change === null) return { missing: "change" };
  if (choice.change === "adjustment") return { small: { change: "adjustment" } };
  if (!choice.rule || !FIXABLE_RULE.test(choice.rule)) return { missing: "rule" };
  return { small: { change: "fix", rule: choice.rule } };
}

export const MISSING_WORDS = {
  change: "Say whether this is a fix or an adjustment.",
  rule: "Choose the shipped rule that is not working as it should.",
} as const;

type Kinded = Pick<WorkOrder, "kind" | "widened"> | Pick<StatusSliceRow, "kind" | "small">;

/** Where a slice stands as a small change: "small" while it is one, "full" once it became a full slice, null for a
 *  slice started any other way. */
export function smallState(slice: Kinded | null | undefined): "small" | "full" | null {
  if (!slice || slice.kind !== "small") return null;
  const widened = "widened" in slice ? slice.widened : "small" in slice ? slice.small?.widened : null;
  return widened ? "full" : "small";
}

/** The label's word and its one-sentence description; null when the slice is not a small change (now). */
export function smallLabel(slice: Kinded | null | undefined): { word: string; description: string } | null {
  return smallState(slice) === "small" ? { word: "Small change", description: SMALL_CHANGE_MEANS } : null;
}

/** The line on a slice that began as a small change and is now a full slice. */
export function widenedLine(widened: SmallWidened): { lead: string; reason: string; byRule: boolean; at: string } {
  const byRule = widened.rule !== null;
  return {
    lead: "This began as a small change and is now a full slice.",
    reason: widened.reason,
    byRule,
    at: widened.at,
  };
}

/** Whether the product manager may make this slice a full slice now: a small change, not yet widened, still a draft
 *  they can edit. The engine decides again when asked. */
export function canWiden(slice: Pick<WorkOrder, "kind" | "widened">, editable: boolean): boolean {
  return smallState(slice) === "small" && editable;
}

/** The widen dialog's bound on the reason: the host's (engine.MaxWidenReason). */
export const MAX_WIDEN_REASON = 300;

export function widenProblem(why: string): string | null {
  const said = why.trim();
  if (!said) return "Say why, in your own words: what makes it more than a small change.";
  if ([...said].length > MAX_WIDEN_REASON) return `Keep the reason to ${MAX_WIDEN_REASON} characters or fewer.`;
  return null;
}

/** Words a person must never read in this feature (M18 wording). */
export const NEVER_SAID = [/light path/i, /\bengine\b/i, /\bkind\b/i, /\bscript\b/i];
