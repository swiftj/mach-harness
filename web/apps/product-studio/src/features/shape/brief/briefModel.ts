/**
 * How The brief screen arranges what `brief.show` and `brief.check` returned. It decides nothing about the brief: whether
 * it passes, every finding and its words, the revision and whether the verdict holds are the engine's. This only places
 * each finding beside the part of the brief its line falls in (the line numbers are the brief file's, as the engine
 * gives them), picks the words and shape for the state the engine reported, and splits the brief's text into
 * paragraphs and bullets for reading. Nothing is read from a finding's message.
 * Pure: imported by the screen and by test/shape-brief-model.test.mjs.
 */
import type { BriefCheck, BriefModel, BriefShow, IdeaLookups, IdeaVerdict, ShapeFinding } from "@mach/ui/api";

/** The brief's sections, in the grammar's order (M16_SHAPE_ENGINE_A.md). */
export type BriefSection = "problem" | "who" | "outcomes" | "not-doing" | "assumptions" | "open-questions" | "risks" | "touches";

export const briefSections: ReadonlyArray<{ id: BriefSection; heading: string; required: boolean }> = [
  { id: "problem", heading: "Problem", required: true },
  { id: "who", heading: "Who has it", required: true },
  { id: "outcomes", heading: "Outcomes", required: true },
  { id: "not-doing", heading: "Not doing", required: false },
  { id: "assumptions", heading: "Assumptions", required: true },
  { id: "open-questions", heading: "Open questions", required: false },
  { id: "risks", heading: "Risks", required: false },
  { id: "touches", heading: "What it touches", required: true },
];

/** Where one finding is shown: beside an outcome, an assumption, a section, or about the whole brief. */
export type FindingPlace =
  | { kind: "outcome"; id: string }
  | { kind: "assumption"; id: string }
  | { kind: "section"; id: BriefSection }
  | { kind: "whole" };

export interface PlacedFinding extends ShapeFinding {
  place: FindingPlace;
  /** The anchor of the part it is placed beside, for "Show it in the brief"; null when about the whole brief. */
  anchor: string | null;
  /** The part's name in words ("O-2", "Problem"), or null. */
  partName: string | null;
}

export interface PlacedFindings {
  all: PlacedFinding[];
  errors: PlacedFinding[];
  warnings: PlacedFinding[];
  outcome: Record<string, PlacedFinding[]>;
  assumption: Record<string, PlacedFinding[]>;
  section: Partial<Record<BriefSection, PlacedFinding[]>>;
  whole: PlacedFinding[];
}

export const anchorOf = (place: FindingPlace): string | null => {
  switch (place.kind) {
    case "outcome":
      return `brief-${place.id}`;
    case "assumption":
      return `brief-${place.id}`;
    case "section":
      return `brief-section-${place.id}`;
    default:
      return null;
  }
};

const headingOf = (id: BriefSection): string => briefSections.find((s) => s.id === id)?.heading ?? id;

/** Each section heading's line in the brief's text (1-based), in the order written. Unknown headings end a section too. */
export function sectionLines(text: string): Array<{ id: BriefSection | null; line: number }> {
  const out: Array<{ id: BriefSection | null; line: number }> = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const found = raw.match(/^##\s+(.+?)\s*$/);
    if (!found) return;
    const name = found[1] as string;
    out.push({ id: briefSections.find((s) => s.heading === name)?.id ?? null, line: index + 1 });
  });
  return out;
}

/** The part of the brief a line falls in. */
export function placeOfLine(line: number, text: string, model: Pick<BriefModel, "outcomes" | "assumptions">): FindingPlace {
  if (!line || line < 1) return { kind: "whole" };
  const sections = sectionLines(text);
  let current: { id: BriefSection | null; line: number } | null = null;
  for (const s of sections) if (s.line <= line) current = s;
  if (!current || !current.id) return { kind: "whole" };
  const items = current.id === "outcomes" ? model.outcomes : current.id === "assumptions" ? model.assumptions : null;
  if (items) {
    let item: { id: string; line: number } | null = null;
    for (const candidate of items) if (candidate.line <= line && candidate.line > (current?.line ?? 0) && (!item || candidate.line >= item.line)) item = candidate;
    if (item) return { kind: current.id === "outcomes" ? "outcome" : "assumption", id: item.id };
  }
  return { kind: "section", id: current.id };
}

/** Every finding the engine reported, placed beside the part its line falls in, errors before warnings, in line order. */
export function placeFindings(show: Pick<BriefShow, "findings" | "text" | "model">): PlacedFindings {
  const model = { outcomes: show.model?.outcomes ?? [], assumptions: show.model?.assumptions ?? [] };
  const all: PlacedFinding[] = show.findings.map((finding) => {
    const place = placeOfLine(finding.line, show.text, model);
    const partName = place.kind === "outcome" || place.kind === "assumption" ? place.id : place.kind === "section" ? headingOf(place.id) : null;
    return { ...finding, place, anchor: anchorOf(place), partName };
  });
  const placed: PlacedFindings = { all, errors: [], warnings: [], outcome: {}, assumption: {}, section: {}, whole: [] };
  const byLine = (a: PlacedFinding, b: PlacedFinding) => a.line - b.line;
  placed.errors = all.filter((f) => f.severity === "error").sort(byLine);
  placed.warnings = all.filter((f) => f.severity !== "error").sort(byLine);
  for (const f of [...placed.errors, ...placed.warnings]) {
    if (f.place.kind === "outcome") (placed.outcome[f.place.id] ??= []).push(f);
    else if (f.place.kind === "assumption") (placed.assumption[f.place.id] ??= []).push(f);
    else if (f.place.kind === "section") (placed.section[f.place.id] ??= []).push(f);
    else placed.whole.push(f);
  }
  return placed;
}

export type GlyphShape = "open" | "half" | "ready" | "approved" | "blocked" | "superseded";
export type StateTone = "neutral" | "success" | "warning" | "danger" | "accent" | "info";

export interface CheckState {
  kind: "problems" | "warnings" | "passes";
  word: string;
  tone: StateTone;
  glyph: GlyphShape;
  /** One sentence under the pill. */
  detail: string;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The check's state, as the engine reported it: problems (errors) stop it passing; warnings never do. */
export function checkState(show: Pick<BriefShow, "passes" | "findings">): CheckState {
  const errors = show.findings.filter((f) => f.severity === "error").length;
  const warnings = show.findings.length - errors;
  if (!show.passes) {
    return {
      kind: "problems",
      word: errors ? `${count(errors, "problem")} to fix` : "Does not pass yet",
      tone: "danger",
      glyph: "blocked",
      detail: "Fix each problem in the conversation, then check the brief again.",
    };
  }
  if (warnings) {
    return {
      kind: "warnings",
      word: `Passes, ${count(warnings, "warning")}`,
      tone: "warning",
      glyph: "half",
      detail: "Warnings never stop a brief passing. Each is worth a look before you make the case.",
    };
  }
  return { kind: "passes", word: "Passes its check", tone: "success", glyph: "ready", detail: "Nothing to fix. The next step is the case." };
}

/** What the brief holds, counted from its model: shown only when something was counted (never four zeros). */
export function briefCounts(model: BriefModel | null | undefined): Array<[string, number]> | null {
  if (!model) return null;
  const items: Array<[string, number]> = [
    ["Outcomes", model.outcomes?.length ?? 0],
    ["Assumptions", model.assumptions?.length ?? 0],
    ["Open questions", model.open_questions?.length ?? 0],
    ["Rules touched", model.touches?.shipped_rules?.length ?? 0],
  ];
  return items.some(([, n]) => n > 0) ? items : null;
}

/** Where the revision stands, in words: the engine's revision and whether the text changed since its last check. */
export function revisionWords(show: Pick<BriefShow, "revision" | "changed_since_check">): { line: string; changed: string | null } {
  if (show.revision === 0) {
    return { line: "Not checked yet", changed: "This brief has not been checked yet. Check it to record it as its first revision." };
  }
  return {
    line: `Revision ${show.revision}`,
    changed: show.changed_since_check
      ? `The conversation changed the brief after revision ${show.revision} was checked. Check it again to record the change as the next revision.`
      : null,
  };
}

/** The verdict as it stands against the brief now: a stale verdict in the engine's own words. */
export function verdictState(verdict: IdeaVerdict | null | undefined): { kind: "none" } | { kind: "holds"; decision: string } | { kind: "stale"; decision: string; note: string } {
  if (!verdict) return { kind: "none" };
  const decision = decisionWord(verdict.decision);
  if (verdict.stale || !verdict.holds) {
    return { kind: "stale", decision, note: verdict.stale_note ?? `The brief changed after this verdict was recorded (revision ${verdict.revision}), so it no longer holds.` };
  }
  return { kind: "holds", decision };
}

const decisionWords: Record<string, string> = { go: "Go", "not-now": "Not now", no: "No" };
export const decisionWord = (decision: string): string => decisionWords[decision] ?? decision;

/**
 * What "Check again" did, from the engine's answer: its own sentence on the revision (the note's first sentence) as the
 * title, then where the check stands and the rest of the engine's note.
 */
export function checkAgainWords(result: Pick<BriefCheck, "passes" | "errors" | "warnings" | "note">): { title: string; body: string } {
  const note = result.note.trim();
  const end = note.indexOf(". ");
  const title = end < 0 ? note : note.slice(0, end + 1);
  const rest = end < 0 ? "" : note.slice(end + 2).trim();
  const state = !result.passes
    ? `It does not pass yet: ${count(result.errors.length, "problem")} to fix.`
    : result.warnings.length
      ? `It passes its check, with ${count(result.warnings.length, "warning")}.`
      : "It passes its check.";
  return { title, body: rest ? `${state} ${rest}` : state };
}

/** An assumption's state as a word and a shape. A state the grammar does not know is shown as missing. */
export function assumptionState(a: BriefModel["assumptions"][number]): { word: string; tone: StateTone; glyph: GlyphShape } {
  if (a.state === "confirmed") {
    const by = a.confirmed_by ? ` by ${a.confirmed_by}` : "";
    const on = a.confirmed_on ? ` on ${formatDay(a.confirmed_on)}` : "";
    return { word: `Confirmed${by}${on}`, tone: "success", glyph: "approved" };
  }
  if (a.state === "assumed") return { word: "Assumed, not confirmed", tone: "warning", glyph: "half" };
  return { word: "No state given", tone: "danger", glyph: "blocked" };
}

/** "2026-11-18" as "18 Nov 2026" in the person's locale; the text itself when it is not a date. */
export function formatDay(day: string): string {
  const found = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!found) return day;
  const date = new Date(Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3])));
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** A block of the brief's prose for reading: paragraphs, or a bullet list when every line of a block starts "- ". */
export type ProseBlock = { kind: "paragraph"; text: string } | { kind: "list"; items: string[] };

export function proseBlocks(text: string | null | undefined): ProseBlock[] {
  if (!text) return [];
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
    .filter((lines) => lines.length)
    .map((lines) =>
      lines.every((l) => /^[-*]\s+/.test(l)) ? { kind: "list" as const, items: lines.map((l) => l.replace(/^[-*]\s+/, "")) } : { kind: "paragraph" as const, text: lines.join(" ") },
    );
}

/** "None." is the grammar's answer for an empty optional part. */
export const isNone = (text: string | null | undefined): boolean => (text ?? "").trim() === "None.";

export interface RuleGroup {
  epicId: string | null;
  /** The capability's name the brief gives that epic, when it gives one. */
  name: string | null;
  rules: string[];
}

/**
 * The shipped rules the brief names, grouped by the epic the recorded lookups give each one (identifiers only), so
 * each group can link to "How this epic works today". A rule whose epic was not recorded is in a group without one.
 */
export function rulesByEpic(model: BriefModel | null | undefined, lookups: IdeaLookups | null | undefined): RuleGroup[] {
  const rules = model?.touches?.shipped_rules ?? [];
  const epicOf = new Map((lookups?.items?.shipped_rules ?? []).map((r) => [r.rule, r.epic_id] as const));
  const names = new Map((model?.touches?.capabilities ?? []).filter((c) => c.epic_id).map((c) => [c.epic_id as string, c.name] as const));
  const groups: RuleGroup[] = [];
  for (const rule of rules) {
    const epicId = epicOf.get(rule) ?? null;
    let group = groups.find((g) => g.epicId === epicId);
    if (!group) {
      group = { epicId, name: epicId ? (names.get(epicId) ?? null) : null, rules: [] };
      groups.push(group);
    }
    group.rules.push(rule);
  }
  return groups.sort((a, b) => (a.epicId === null ? 1 : 0) - (b.epicId === null ? 1 : 0));
}

/** Where "How this epic works today" is in the app. */
export const epicTodayPath = (epicId: string): string => `/epics/${encodeURIComponent(epicId)}/today`;

/** The brief's lines, numbered as the engine numbers them, for the text as written. */
export const numberedLines = (text: string): Array<{ n: number; text: string }> => text.replace(/\n$/, "").split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t }));
