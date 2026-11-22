/**
 * M18: a small change (docs/mach-next/M18_DESIGN.md part C, docs/mach-next/M18_APP.md). The shapes are the engine's own
 * (skills/product-studio/scripts/small_change.py), from the real fixtures in web/fixtures (small_memory.py). A slice
 * started any other way carries none of these fields, so every one is optional where it appears.
 */
import type { WorkOrder } from "./types";

/** The engine's two kinds of small change, in its order (small.CHANGES). */
export const smallChanges = ["fix", "adjustment"] as const;
export type SmallChangeKind = (typeof smallChanges)[number];

/** What starts a small change: `slice.new` and `request.pick` take it as `small`. A fix names the shipped rule that is
 *  not holding (SLICE-NNN/FR-NN, in force on the product manager's copy of main); an adjustment names none. */
export type SmallStart = { change: "fix"; rule: string } | { change: "adjustment" };

/** The work order's record of how the change started (`small`). */
export interface SmallOnWorkOrder {
  change: SmallChangeKind;
  /** A fix's shipped rule; null for an adjustment. */
  shipped_rule: string | null;
}

/** When and why a small change became a full slice. `rule` is the rule a check (or the interview) found broken; null
 *  when the product manager asked, and `reason` is then their own words. */
export interface SmallWidened {
  at: string;
  /** The rule's fixed sentence, or the product manager's words. */
  reason: string;
  rule: string | null;
}

/** A check's verdict on a slice still being drafted as a small change. */
export interface SmallVerdict {
  verdict: "small" | "not small";
  small: boolean;
  rule: string | null;
  sentence: string;
  failed: string[];
}

/** `status.slices[].small`. */
export interface StatusSmall extends SmallOnWorkOrder {
  /** Still a small change (never widened). */
  light_path: boolean;
  widened: SmallWidened | null;
}

/** `small_change` on `slice check`, `slice show`'s check, `slice ready` and `slice widen`. */
export interface SliceSmallChange extends SmallOnWorkOrder {
  kind: "small";
  light_path: boolean;
  widened: SmallWidened | null;
  /** Only while it is still a small change and the spec could be judged. */
  verdict?: SmallVerdict | null;
  /** True on the one check that widened it. */
  widened_now?: boolean;
  /** The engine's sentence once widened (written for the interviewer; the app writes its own line). */
  note?: string;
}

/** `slice resume`'s `small_change`: what the interviewer follows. The app reads only the kind and the widening. */
export interface SmallChangeResume extends SliceSmallChange {
  limits: { requirements: number; scenarios: number; questions: number; changed_shipped_rules: number };
  settings_notes?: string[];
  method: string;
  questions_sentence?: string;
  rules?: Record<string, string>;
}

/** `slice widen`: the slice, now a full slice, with the product manager's reason kept. */
export interface SliceWiden {
  widened: true;
  slice: WorkOrder;
  small_change: SmallChangeResume;
  factory_authorized: false;
  note: string;
}
