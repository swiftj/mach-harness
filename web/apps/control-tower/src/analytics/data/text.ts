/**
 * Containment of prose (M6_5_SECURITY.md section 6 B, rules C1 to C6).
 *
 * The observer serves some fields as prose it has not checked for names (R1: label, do not
 * withhold). The data layer hands every such value to the UI only as `UncheckedText`: an opaque
 * object, not a string. It cannot be passed where a string is expected (a query parameter, a hash, a
 * `title`), it prints as a placeholder if interpolated or serialised by mistake, and its words are
 * read only through `uncheckedView`, which truncates and labels them. The one component that renders
 * it is `UncheckedText.tsx` in this folder.
 *
 * Analytics replies hold such prose in one place today: group keys of `group_by=phase` (phase
 * titles, `agent.*.data.phase`, at most 60 characters). The rest of what they carry is identifiers,
 * codes, numbers and the observer's own catalog strings (group A), which are plain strings.
 */

/** The words shown beside contained prose, once per panel (C3), when the observer does not give its own. */
export const UNCHECKED_NOTE = "free text, not checked for names";
/** Characters kept when no field limit is known (C2). */
export const DEFAULT_UNCHECKED_MAX = 120;

const TEXT = Symbol("unchecked-text");
const PLACEHOLDER = "[free text]";

/** Prose the observer has not checked for names. Read it only with `uncheckedView`. */
export interface UncheckedText {
  readonly [TEXT]: string;
  /** The field's limit (characters), from the session's display policy or the field's own. */
  readonly max: number;
  /** Where it came from, as the policy names it ("agent.started data.phase"), for the label. */
  readonly field: string;
  toString(): string;
  toJSON(): string;
}

/** Wraps prose from a reply. Empty or non-string values are null (nothing to show), never "". */
export function unchecked(value: unknown, field: string, max: number = DEFAULT_UNCHECKED_MAX): UncheckedText | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_UNCHECKED_MAX;
  return Object.freeze({
    [TEXT]: value,
    max: limit,
    field,
    // C4: an accidental `${t}`, String(t), URLSearchParams or JSON.stringify never carries the words.
    toString: () => PLACEHOLDER,
    toJSON: () => PLACEHOLDER,
  });
}

export function isUnchecked(value: unknown): value is UncheckedText {
  return !!value && typeof value === "object" && TEXT in value;
}

/** What the rendering component needs: the shown (truncated) words, the full words for an explicit expansion, the label. */
export interface UncheckedView {
  readonly shown: string;
  readonly full: string;
  readonly truncated: boolean;
  readonly note: string;
}

/** C2: truncated to the field's limit (or `max`, whichever is smaller), on a character boundary, with an ellipsis. */
export function uncheckedView(t: UncheckedText, options: { readonly max?: number; readonly note?: string | null } = {}): UncheckedView {
  const full = t[TEXT];
  const max = Math.max(1, Math.min(t.max, options.max ?? t.max));
  const chars = Array.from(full);
  const truncated = chars.length > max;
  return { shown: truncated ? `${chars.slice(0, max - 1).join("")}…` : full, full, truncated, note: options.note || UNCHECKED_NOTE };
}

/** One declared prose field (`display_policy.free_text.event_fields[]`). */
export interface FreeTextField {
  readonly kind: string;
  readonly path: string;
  readonly max: number;
}

/** `/session` `display_policy`, as the analytics layer reads it. */
export interface DisplayPolicy {
  readonly people: "role" | "unknown";
  /** False unless the observer says it checked free text for names (it never does today). */
  readonly checkedForNames: boolean;
  readonly note: string;
  readonly fields: readonly FreeTextField[];
  /** False when the observer declared no policy (an older observer): contain everything that may be prose. */
  readonly declared: boolean;
}

/** The policy assumed when none is declared: nothing is checked, every prose field contained. */
export const UNDECLARED_POLICY: DisplayPolicy = { people: "unknown", checkedForNames: false, note: UNCHECKED_NOTE, fields: [], declared: false };

/** Reads `display_policy` (or the whole `/session` data). Anything unreadable fails closed (UNDECLARED_POLICY). */
export function readDisplayPolicy(value: unknown): DisplayPolicy {
  if (!value || typeof value !== "object") return UNDECLARED_POLICY;
  const v = value as Record<string, unknown>;
  const dp = (v.display_policy && typeof v.display_policy === "object" ? v.display_policy : v) as Record<string, unknown>;
  const ft = dp.free_text && typeof dp.free_text === "object" ? (dp.free_text as Record<string, unknown>) : null;
  if (!ft) return { ...UNDECLARED_POLICY, people: dp.people === "role" ? "role" : "unknown" };
  const fields: FreeTextField[] = [];
  for (const f of Array.isArray(ft.event_fields) ? ft.event_fields : []) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    if (typeof r.kind !== "string" || typeof r.path !== "string") continue;
    fields.push({ kind: r.kind, path: r.path, max: typeof r.max === "number" && r.max > 0 ? Math.floor(r.max) : DEFAULT_UNCHECKED_MAX });
  }
  return {
    people: dp.people === "role" ? "role" : "unknown",
    checkedForNames: ft.checked_for_names === true,
    note: typeof ft.note === "string" && ft.note.trim() ? ft.note : UNCHECKED_NOTE,
    fields,
    declared: true,
  };
}

/**
 * Group dimensions whose values are prose (M6_5_SECURITY.md 6 B: `group_by=phase`). A value of these
 * is wrapped; every other dimension's value is an identifier or a code.
 */
export const PROSE_DIMENSIONS: Readonly<Record<string, { readonly field: string; readonly path: string }>> = {
  phase: { field: "agent.started data.phase", path: "data.phase" },
};

/** The limit for a prose dimension: the policy's (the smallest declared for that path), else the default. */
export function proseLimit(policy: DisplayPolicy, dimension: string): number {
  const p = PROSE_DIMENSIONS[dimension];
  if (!p) return DEFAULT_UNCHECKED_MAX;
  const maxes = policy.fields.filter((f) => f.path === p.path).map((f) => f.max);
  return maxes.length ? Math.min(...maxes) : 60;
}
