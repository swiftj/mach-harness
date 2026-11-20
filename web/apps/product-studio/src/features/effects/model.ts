/**
 * What the Effects tab shows, worked out only from what the engine reported: the spec's own rows
 * (`spec.model.effects`), the check's findings about the section, the rules the check read
 * (`check.shipped`) and the status's `shipped_moved`. Nothing here decides whether a rule is in
 * force; a finding is placed beside a row only by the line the engine gave it.
 * Pure: imported by the screen and by test/effects-model.test.mjs.
 */
import type { EffectRow, ShippedChecked, ShippedMoved, SliceShow } from "@mach/ui/api";

/** The spec's heading for the section, as the engine names it in `diagnostics[].section`. */
export const EFFECTS_HEADING = "Effects on shipped behaviour";

export interface EffectProblem {
  /** The engine's words, as written. */
  message: string;
  line: number | null;
  rule: string | null;
  /** "check": the spec check found it now; "moved": the shipped rules moved since the slice was checked. */
  source: "check" | "moved";
  severity: "error" | "warning";
}

export interface EffectLine {
  row: EffectRow;
  /** The row's line in the spec, when it could be found by its shipped rule. */
  line: number | null;
  problems: EffectProblem[];
}

export type EffectsState =
  /** No specification has been written yet. */
  | "no-spec"
  /** A specification exists but has no effects section (or the engine could not read it). */
  | "no-section"
  /** The section says "None.": this slice changes no shipped behaviour. */
  | "none"
  | "rows";

export interface EffectsView {
  state: EffectsState;
  rows: EffectLine[];
  /** Findings about the section that belong to no row (a missing section, a problem with the table). */
  sectionProblems: EffectProblem[];
  shipped: ShippedChecked | null;
  moved: ShippedMoved | null;
}

/** True for a check finding about the effects section, by the engine's section or its rule code. */
function aboutEffects(section: string | null | undefined, rule: string | null | undefined): boolean {
  return section === EFFECTS_HEADING || (typeof rule === "string" && rule.startsWith("effects-"));
}

/** The engine's check findings about the effects section, in its words. */
export function effectProblems(check: SliceShow["check"] | null | undefined): EffectProblem[] {
  if (!check) return [];
  if (check.diagnostics) {
    return check.diagnostics
      .filter((d) => aboutEffects(d.section, d.rule))
      .map((d) => ({ message: d.message, line: d.line, rule: d.rule, source: "check" as const, severity: d.severity === "warning" ? ("warning" as const) : ("error" as const) }));
  }
  // An engine without diagnostics: its error lines end with the rule code in brackets.
  return [
    ...check.errors.filter((e) => /\[effects-[a-z-]+\]\s*$/.test(e)).map((message) => ({ message, line: null, rule: null, source: "check" as const, severity: "error" as const })),
    ...check.warnings.filter((e) => /\[effects-[a-z-]+\]\s*$/.test(e)).map((message) => ({ message, line: null, rule: null, source: "check" as const, severity: "warning" as const })),
  ];
}

/**
 * The line of each table row in the spec's effects section, by the shipped rule its first cell
 * names. Lines count from 1, as the engine counts them. A rule named twice keeps its first line.
 */
export function effectRowLines(markdown: string | null | undefined): Map<string, number> {
  const lines = new Map<string, number>();
  if (!markdown) return lines;
  const text = markdown.split("\n");
  let inside = false;
  for (let index = 0; index < text.length; index += 1) {
    const line = text[index] ?? "";
    if (/^#{1,6}\s/.test(line)) {
      inside = /^##\s+Effects on shipped behaviour\s*$/.test(line);
      continue;
    }
    if (!inside || !line.trim().startsWith("|")) continue;
    const first = line.trim().replace(/^\|/, "").split("|")[0]?.trim() ?? "";
    if (/^SLICE-\d{3,}\/[A-Z]+-?\d+$/.test(first) && !lines.has(first)) lines.set(first, index + 1);
  }
  return lines;
}

/** Everything the Effects tab shows for one slice. `moved` is this slice's `status.slices[].shipped_moved`. */
export function effectsView(show: SliceShow, moved: ShippedMoved | null | undefined): EffectsView {
  const spec = show.spec;
  const model = spec?.model && typeof spec.model === "object" ? spec.model : null;
  const shipped = show.check?.shipped ?? null;
  const problems: EffectProblem[] = [
    ...effectProblems(show.check),
    ...(moved?.problems ?? []).map((p) => ({ message: p.message, line: p.line, rule: p.code, source: "moved" as const, severity: "error" as const })),
  ];
  const effects = model?.effects;
  const state: EffectsState = !spec ? "no-spec" : effects === undefined || effects === null ? "no-section" : effects.length === 0 ? "none" : "rows";
  const lines = effectRowLines(spec?.markdown);
  const placed = new Set<EffectProblem>();
  const rows: EffectLine[] = (effects ?? []).map((row) => {
    const line = lines.get(row.shipped_rule) ?? null;
    const mine = line === null ? [] : problems.filter((p) => p.line === line);
    mine.forEach((p) => placed.add(p));
    return { row, line, problems: mine };
  });
  return { state, rows, sectionProblems: problems.filter((p) => !placed.has(p)), shipped, moved: moved ?? null };
}

/** The effect in a word, a sentence that says what it means, and what the "In this slice" cell holds. */
export const effectWords: Record<EffectRow["effect"], { word: string; means: string; inSlice: string }> = {
  kept: { word: "Kept", means: "Still holds. This slice proves it with one of its own examples.", inSlice: "Proved by" },
  changed: { word: "Changed", means: "Still in force, in a new form this slice writes.", inSlice: "Now written as" },
  replaced: { word: "Replaced", means: "No longer in force. A rule of this slice takes its place.", inSlice: "Replaced by" },
  retired: { word: "Retired", means: "No longer in force, and nothing takes its place.", inSlice: "" },
};

/** The commit as the family shows one: its first 10 characters. */
export function shortCommit(commit: string | null | undefined): string | null {
  return commit ? commit.slice(0, 10) : null;
}
