/**
 * The PRD on-ramp's screen logic, from the engine's answers alone. Pure, so it is unit-tested
 * (test/prd-model.test.mjs). It adds no product rule: the engine still decides every act and can
 * refuse any of them; this only says what to show and what each button would send.
 */
import type { PrdAnswer, PrdCoverageRow, PrdMapSlice, PrdStatus } from "@mach/ui/api";

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
