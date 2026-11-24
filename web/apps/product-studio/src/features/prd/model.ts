/**
 * The PRD on-ramp's screen logic, from the engine's answers alone. Pure, so it is unit-tested
 * (test/prd-model.test.mjs). It adds no product rule: the engine still decides every act and can
 * refuse any of them; this only says what to show and what each button would send.
 */
import type { PrdAnswer, PrdCoverageRow, PrdMapSlice, PrdStatus } from "@mach/ui/api";
import type { Quotation } from "../../shared/lineRanges.ts";

/* ── Where the product manager is ──────────────────────────────────────── */

export const JOURNEY: Array<{ label: string }> = [{ label: "Import" }, { label: "Map" }, { label: "Settle what is not covered" }, { label: "Make the drafts" }];

/**
 * The step a PRD is at: 1 map, 2 settle, 3 make the drafts, 4 when the drafts are made (every step
 * done). Import is always done once there is a PRD to look at.
 */
export function journeyStep(status: Pick<PrdStatus, "map" | "not_covered">): number {
  if (!status.map) return 1;
  if (status.map.applied) return 4;
  if ((status.not_covered ?? []).length > 0) return 2;
  return 3;
}

/* ── Coverage ─────────────────────────────────────────────────────────── */

export interface Coverage {
  /** Sections that needed the product manager's word: settled ones and the ones still open. */
  total: number;
  settled: number;
  /** The sections still open, in the document's order. */
  left: PrdCoverageRow[];
}

/** Settled of total, counting only sections no slice cites (covered and heading-only sections need no word). */
export function coverageProgress(coverage: PrdCoverageRow[] | undefined): Coverage {
  const rows = coverage ?? [];
  const settled = rows.filter((r) => r.state === "settled").length;
  const left = rows.filter((r) => r.state === "not_covered");
  return { total: settled + left.length, settled, left };
}

/** One section's state, in words, for its row and its accessible name. */
export function coverageWords(row: PrdCoverageRow, slices: readonly Pick<PrdMapSlice, "key" | "title">[]): string {
  const name = (key: string) => {
    const found = slices.find((s) => s.key === key);
    return found ? `${key}, “${found.title}”` : key;
  };
  switch (row.state) {
    case "covered":
      return `Covered by ${row.cited_by.map(name).join(" and ")}`;
    case "heading_only":
      return "A heading with nothing under it: nothing to cover";
    case "not_covered":
      return "Not covered";
    case "settled": {
      const s = row.settled;
      if (!s) return "Settled";
      if (s.as === "slice") return `Settled: part of ${name(s.slice ?? "")}`;
      if (s.as === "later") return "Settled: later";
      return "Settled: out of scope";
    }
  }
}

/* ── Settling one section ─────────────────────────────────────────────── */

export type SettleChoice = "slice" | "out-of-scope" | "later";

export interface SettleForm {
  choice: SettleChoice | "";
  slice: string;
  reason: string;
}

export type SettleArgs =
  | { prd_id: string; section: number; as: "slice"; slice: string; reason?: string }
  | { prd_id: string; section: number; as: "out-of-scope" | "later"; reason?: string };

/** What `prd.settle` is sent, or the one thing the form still needs, in words. */
export function settleArgs(prdId: string, section: number, form: SettleForm): { args: SettleArgs } | { missing: string } {
  const reason = form.reason.trim().replace(/\s+/g, " ");
  const extra = reason ? { reason } : {};
  if (form.choice === "") return { missing: "Choose what this section is: part of a slice, out of scope, or later." };
  if (form.choice === "slice") {
    if (!form.slice) return { missing: "Choose the slice this section belongs to." };
    return { args: { prd_id: prdId, section, as: "slice", slice: form.slice, ...extra } };
  }
  return { args: { prd_id: prdId, section, as: form.choice, ...extra } };
}

/* ── Making the drafts ────────────────────────────────────────────────── */

export interface ApplyPlan {
  epics: Array<{ key: string; title: string }>;
  slices: Array<{ key: string; title: string; epic: string }>;
}

/** What `prd.apply` would make, by name, in the map's order. `epicTitle` names an existing epic. */
export function applyPlan(map: NonNullable<PrdStatus["map"]>, epicTitle: (epicId: string) => string | null): ApplyPlan {
  const newEpic = new Map(map.epics.map((e) => [e.key, e.title]));
  return {
    epics: map.epics.map((e) => ({ key: e.key, title: e.title })),
    slices: map.slices.map((s) => ({ key: s.key, title: s.title, epic: newEpic.get(s.epic) ?? epicTitle(s.epic) ?? s.epic })),
  };
}

/* ── The PRD's own lines, as data ─────────────────────────────────────── */

/**
 * The numbered lines inside the engine's PRD fence (`<<<PRD-DATA ...>>>` ... `<<<END-PRD-DATA ...>>>`),
 * by line number. Anything that does not look like that fence gives null, so nothing unfenced is
 * ever shown. The text is kept exactly as the engine bounded and redacted it.
 */
export function fencedLines(fenced: string | null | undefined): Map<number, string> | null {
  if (typeof fenced !== "string") return null;
  const lines = fenced.split("\n");
  const [first, last] = [lines[0] ?? "", lines[lines.length - 1] ?? ""];
  if (lines.length < 2 || !first.startsWith("<<<PRD-DATA ") || !last.startsWith("<<<END-PRD-DATA ")) return null;
  const out = new Map<number, string>();
  for (const line of lines.slice(1, -1)) {
    const match = /^\s*(\d+)\| ?(.*)$/.exec(line);
    if (match) out.set(Number(match[1]), match[2] ?? "");
  }
  return out;
}


/** Line ranges and quotations are shared with Shape's map (shared/lineRanges.ts). */
export { parseRanges, quote, rangeWords } from "../../shared/lineRanges.ts";
export type { Quotation } from "../../shared/lineRanges.ts";

/* ── Drafted answers ──────────────────────────────────────────────────── */

export interface AnswerGroups {
  /** Drafted answers waiting for the product manager's word: these can be accepted as a group. */
  waiting: PrdAnswer[];
  accepted: PrdAnswer[];
  /** Drafted answers the product manager set aside to discuss. */
  discuss: PrdAnswer[];
  /** Points the PRD does not settle and contradictions: always asked in the interview, never accepted here. */
  alwaysAsked: PrdAnswer[];
}

export function answerGroups(answers: readonly PrdAnswer[]): AnswerGroups {
  const drafted = answers.filter((a) => a.kind === "drafted");
  return {
    waiting: drafted.filter((a) => a.state === "pending"),
    accepted: drafted.filter((a) => a.state === "accepted"),
    discuss: drafted.filter((a) => a.state === "discuss"),
    alwaysAsked: answers.filter((a) => a.kind !== "drafted"),
  };
}

/** Whether the product manager can accept this answer here. Only a drafted answer waiting for their word. */
export const canAccept = (answer: PrdAnswer): boolean => answer.kind === "drafted" && answer.state === "pending";

/**
 * What `prd.confirm` is sent for the answers waiting: every one accepted except those named to
 * discuss. Numbers are listed, never "all", so the act is exactly what the dialog named. Null when
 * nothing is waiting.
 */
export function confirmArgs(sliceId: string, waiting: readonly PrdAnswer[], toDiscuss: ReadonlySet<number>): { slice_id: string; accept?: number[]; discuss?: number[] } | null {
  const numbers = waiting.filter(canAccept).map((a) => a.n);
  if (!numbers.length) return null;
  const accept = numbers.filter((n) => !toDiscuss.has(n));
  const discuss = numbers.filter((n) => toDiscuss.has(n));
  return { slice_id: sliceId, ...(accept.length ? { accept } : {}), ...(discuss.length ? { discuss } : {}) };
}

/** The confirming button's words for the choice made. */
export function confirmLabel(accept: number, discuss: number): string {
  if (accept && discuss) return `Accept ${accept} and discuss ${discuss}`;
  if (accept) return accept === 1 ? "Accept the drafted answer" : `Accept ${accept} drafted answers`;
  return discuss === 1 ? "Discuss it in the interview" : `Discuss all ${discuss} in the interview`;
}

/* ── Import ───────────────────────────────────────────────────────────── */

/** The import limits in words, said before the product manager picks a file. */
export function limitWords(limit: { maxBytes: number; extensions: readonly string[] }): string {
  const size = limit.maxBytes % (1024 * 1024) === 0 ? `${limit.maxBytes / (1024 * 1024)} MB` : `${Math.round(limit.maxBytes / 1024)} KB`;
  return `One Markdown or plain-text file (${limit.extensions.join(", ")}), at most ${size}.`;
}

/** Lines in a section, for the imported list. */
export const sectionLines = (s: { start: number; end: number }): number => s.end - s.start + 1;

/* ── The parts of a PRD's page (M16 layout) ───────────────────────────── */

/** The page's four parts, one per step of the path, in its order: the parts are the stepper. */
export type PrdPart = "import" | "map" | "settle" | "apply";
export const PRD_PARTS: readonly PrdPart[] = ["import", "map", "settle", "apply"];

/** The part that needs the product manager at a step (`journeyStep`): the current step's, and the drafts once they are made. */
export function partForStep(step: number): PrdPart {
  return PRD_PARTS[Math.min(Math.max(step, 0), PRD_PARTS.length - 1)] as PrdPart;
}

/** Where a part is on the path: done before the current step, the current step, or not reached. */
export function partPlace(part: PrdPart, step: number): "done" | "current" | "later" {
  const index = PRD_PARTS.indexOf(part);
  return index < step ? "done" : index === step ? "current" : "later";
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Markdown, 5 sections, 22 lines": what was imported. */
export function importSummary(prd: Pick<PrdStatus["prd"], "format" | "sections" | "line_count">): string {
  return `${prd.format === "markdown" ? "Markdown" : "Plain text"}, ${count(prd.sections, "section")}, ${count(prd.line_count, "line")}`;
}

/** The map in one line, from the engine's answer only. */
export function mapSummary(status: Pick<PrdStatus, "map">): string {
  const map = status.map;
  if (!map) return "No map yet: MACH proposes it here";
  const what = [map.epics.length ? count(map.epics.length, "new epic") : null, `${count(map.slices.length, "thin slice")} in build order`].filter(Boolean).join(" and ");
  return map.applied ? `${what}, kept as it was when the drafts were made` : what;
}

/** Settling in one line: what is still open, by section number, or that nothing is. */
export function settleSummary(coverage: PrdCoverageRow[] | undefined): string {
  const progress = coverageProgress(coverage);
  if (!(coverage ?? []).length) return "No sections to show";
  if (progress.total === 0) return "Every section is cited by a slice on the map";
  if (progress.left.length) return `${count(progress.left.length, "section")} still to settle: ${progress.left.map((r) => r.n).join(", ")}`;
  return `Every section no slice cites is settled (${progress.settled} of ${progress.total})`;
}

/** What stops the drafts being made, in words, or null. Shown in the part's summary and beside its button. */
export function applyBlocked(status: Pick<PrdStatus, "map" | "not_covered">): string | null {
  const left = status.not_covered ?? [];
  if (!left.length || status.map?.applied) return null;
  return `Settle ${left.length === 1 ? `section ${left[0]}` : `sections ${left.join(", ")}`} first. Nothing can be made while any section is unsettled.`;
}

/** "1 epic and 2 draft slices": what making the drafts adds. */
export function applyWhat(plan: ApplyPlan): string {
  return [plan.epics.length ? count(plan.epics.length, "epic") : null, count(plan.slices.length, "draft slice")].filter(Boolean).join(" and ");
}

/**
 * Making the drafts in one line: made (and what), blocked (and by what), or ready (and what it makes). With
 * `needsProduct` (no project yet, M19) the product is named first, on the same part.
 */
export function applySummary(status: Pick<PrdStatus, "map" | "not_covered" | "prd">, plan: ApplyPlan | null, needsProduct = false): string {
  if (!status.map) return "After the map";
  if (status.map.applied) {
    const made = status.prd.applied ?? [];
    return made.length ? `Made: ${made.join(", ")}` : "The drafts were made";
  }
  const blocked = applyBlocked(status);
  if (blocked) return blocked;
  const what = plan ? applyWhat(plan) : "the drafts";
  return needsProduct ? `Name the product, then make ${what}` : `Ready to make ${what}`;
}

/**
 * The command that has MACH propose a PRD's map in Claude Code, for the same install as the host's continue command
 * ("/mach:studio continue" gives "/mach:studio start from PRD-01"). Null when the host reports none.
 */
export function prdCommand(continueCommand: string | null | undefined, prdId: string): string | null {
  if (typeof continueCommand !== "string") return null;
  const skill = continueCommand.trim().replace(/ continue$/, "");
  if (!skill || skill === continueCommand.trim() || /\s/.test(skill)) return null;
  return `${skill} start from ${prdId}`;
}

/** The document's sections by state, for the narrow pane. Before a map there is no coverage, so only the sections are counted. */
export function coverageCounts(status: Pick<PrdStatus, "coverage" | "sections" | "prd">): Array<{ label: string; value: number }> {
  const rows = status.coverage ?? [];
  if (!rows.length) return [{ label: "Sections", value: status.sections?.length ?? status.prd.sections }];
  const n = (state: PrdCoverageRow["state"]) => rows.filter((r) => r.state === state).length;
  return [
    { label: "Covered by a slice", value: n("covered") },
    { label: "Settled by you", value: n("settled") },
    { label: "Not covered", value: n("not_covered") },
    { label: "Heading only", value: n("heading_only") },
  ];
}

/** How many of the document's lines a set of quotations holds ("Rests on 3 lines of the PRD"). */
export function quotedCount(quotations: readonly Quotation[]): number {
  return quotations.reduce((sum, q) => sum + q.lines.length, 0);
}

/* ── A slice's drafted answers, as sections of its page (M16 layout) ───── */

export type AnswerSection = "waiting" | "always" | "word";

/** The groups of answers, for the page's section list, each with how many it holds. Empty groups are left out. */
export function answerSections(groups: AnswerGroups): Array<{ id: AnswerSection; label: string; count: number }> {
  const out: Array<{ id: AnswerSection; label: string; count: number }> = [];
  if (groups.waiting.length) out.push({ id: "waiting", label: "Waiting for your word", count: groups.waiting.length });
  if (groups.alwaysAsked.length) out.push({ id: "always", label: "Always asked in the interview", count: groups.alwaysAsked.length });
  const word = groups.accepted.length + groups.discuss.length;
  if (word) out.push({ id: "word", label: "Your word so far", count: word });
  return out;
}
