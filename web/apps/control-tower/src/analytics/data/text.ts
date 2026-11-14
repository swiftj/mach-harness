/**
 * Containment of prose in Analytics replies (M6_5_SECURITY.md section 6 B). The containment itself
 * (`UncheckedText`, the session's display policy) is shared with the floor and Timeline inspectors
 * and lives in `src/text/`; this file adds what only Analytics replies need: which group dimensions
 * carry prose. Group keys of `group_by=phase` (phase titles, `agent.*.data.phase`, at most 60
 * characters) are the one place they do today; the rest is identifiers, codes, numbers and the
 * observer's own catalog strings (group A), which are plain strings.
 */
import { DEFAULT_UNCHECKED_MAX, type DisplayPolicy } from "../../text/unchecked";

export * from "../../text/unchecked";

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
