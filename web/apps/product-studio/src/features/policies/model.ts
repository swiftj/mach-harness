/**
 * What the two policy screens show, worked out from what the engine returned and nothing else:
 * `policy.list` for the packs, `slice.show` (its spec model and check) for one slice, `status` and
 * `principle.list` for names. No product rule lives here: whether a pack applies, whether a concern
 * is open and whether a name passes the owner check are the engine's answers, read as given.
 * Pure, so the unit tests run it against the fixtures (test/policies-model.test.mjs).
 */
import type {
  OwnerCheck,
  PolicyAnswer,
  PolicyConcern,
  PolicyList,
  PolicyPack,
  Principle,
  PrincipleAnswer,
  SliceCheck,
  SlicePrinciplesFlag,
  SpecModel,
  StatusSliceRow,
} from "@mach/ui/api";
import { specSectionOf } from "@mach/ui/sections";

/* ── The packs ─────────────────────────────────────────────────────────────── */

export interface PackRow {
  id: string;
  title: string | null;
  owner: string | null;
  status: string;
  /** What the pack applies to, one plain phrase per `applies-to` item. */
  appliesTo: string[];
  /** The 12-character version a spec quotes. */
  version: string;
  file: string;
  /** The engine's reasons this pack cannot be read; empty when it can. */
  problems: string[];
  /** Each statement with its text, as the engine lists it. */
  statements: Array<{ id: string; text: string }>;
}

/** One `applies-to` item in plain words. The engine decides what matches; this only reads the item out. */
export function appliesToWords(item: string): string {
  const [kind, ...rest] = item.split(":");
  const value = rest.join(":").trim();
  if (item.trim() === "all") return "Every slice";
  if (kind === "topic" && value) return `Slices about ${value.replace(/-/g, " ")}`;
  if (kind === "app" && value) return `Apps of the kind “${value}”`;
  if (kind === "path" && value) return `Code under ${value}`;
  return item;
}

export function packRow(pack: PolicyPack): PackRow {
  return {
    id: pack.id,
    title: pack.title,
    owner: pack.owner,
    status: pack.status,
    appliesTo: (pack.applies_to?.length ? pack.applies_to : ["all"]).map(appliesToWords),
    version: pack.short || (pack.digest ?? "").slice(0, 12),
    file: pack.file,
    problems: pack.problems ?? [],
    statements: pack.statements,
  };
}

/** How a pack's state reads: its word, its glyph shape and its tone. */
export function packState(row: PackRow): { word: string; shape: "blocked" | "superseded" | "approved"; tone: "danger" | "neutral" | "success" } {
  if (row.problems.length) return { word: "Cannot be read", shape: "blocked", tone: "danger" };
  if (row.status === "retired") return { word: "Retired", shape: "superseded", tone: "neutral" };
  return { word: "Active", shape: "approved", tone: "success" };
}

/**
 * A pack's row on the packs page, in one line (M16 layout): its owner, what it applies to and how many statements it
 * has, or, for a pack that cannot be read, that its reasons are shown under its name (they are never folded).
 */
export function packSummary(row: PackRow): string {
  if (row.problems.length) return `${row.problems.length === 1 ? "1 reason" : `${row.problems.length} reasons`} it cannot be read, shown under its name`;
  const statements = `${row.statements.length} ${row.statements.length === 1 ? "statement" : "statements"}`;
  return `Owner: ${row.owner ?? "not recorded"}. ${row.appliesTo.join("; ")}. ${statements}.`;
}

/**
 * Problems not already shown on a pack: a folder without a policy.md, or an unusable folder setting.
 * The engine repeats each pack's own problem here, prefixed with its file; those are shown on the pack.
 */
export function otherProblems(list: PolicyList): string[] {
  const files = list.packs.map((pack) => `${pack.file}:`);
  return list.problems.filter((text) => !files.some((prefix) => text.startsWith(prefix)));
}

export interface OlderSlice {
  sliceId: string;
  title: string | null;
  /** The engine's sentence. */
  note: string;
  /** The packs the engine named as changed, retired, gone or now applying. */
  packs: string[];
}

/** Slices answered under an older version of a pack, in slice order, with their titles where status has them. */
export function slicesAnsweredUnderOlder(list: PolicyList, slices: StatusSliceRow[] = []): OlderSlice[] {
  return Object.entries(list.slices_answered_under_older ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sliceId, flag]) => ({
      sliceId,
      title: slices.find((s) => s.slice_id === sliceId)?.title ?? null,
      note: flag.note,
      packs: (flag.changes ?? []).flatMap((change) => (change && typeof change === "object" && typeof (change as { id?: unknown }).id === "string" ? [(change as { id: string }).id] : [])),
    }));
}

/* ── One slice ─────────────────────────────────────────────────────────────── */

export interface PrincipleRow {
  id: string;
  title: string | null;
  revision: number;
  statement: string;
  answer: PrincipleAnswer["answer"];
  upheldBy: string[];
  reason: string | null;
  /** The engine flagged it as answered under an older revision. */
  older: boolean;
  /** The principle is retired now. */
  retired: boolean;
}

export function principleRows(answers: PrincipleAnswer[] | undefined, principles: Principle[] = [], flag?: SlicePrinciplesFlag | null): PrincipleRow[] {
  return (answers ?? []).map((a) => {
    const known = principles.find((p) => p.id === a.id);
    return {
      id: a.id,
      title: known?.title ?? null,
      revision: a.revision,
      statement: a.statement,
      answer: a.answer,
      upheldBy: a.upheld_by ?? [],
      reason: a.reason,
      older: Boolean(flag?.older?.includes(a.id)),
      retired: Boolean(flag?.retired?.includes(a.id)) || known?.status === "retired",
    };
  });
}

export function principleAnswerWords(answer: PrincipleAnswer["answer"]): { word: string; shape: "approved" | "superseded" | "accepted"; tone: "success" | "neutral" | "warning" } {
  if (answer === "applies") return { word: "Applies", shape: "approved", tone: "success" };
  if (answer === "does_not_apply") return { word: "Does not apply", shape: "superseded", tone: "neutral" };
  return { word: "An exception", shape: "accepted", tone: "warning" };
}

/** A recorded acceptance, with the name and how it was checked told apart. */
export interface Acceptance {
  name: string;
  on: string | null;
  words: string;
  /** One of the engine's three phrases, or null when the line was written by hand. */
  check: OwnerCheck | null;
}

const CHECK_TAIL = /\s\((checked against the pack's owner|checked against the project's list|not checked against the owner)\)$/;

/** The name given, without the bracketed check the resolution line carries after it, and the check. */
export function acceptance(concern: PolicyConcern): Acceptance | null {
  if (concern.resolution !== "accepted") return null;
  const by = (concern.by ?? "").trim();
  const tail = CHECK_TAIL.exec(by);
  return {
    name: tail ? by.slice(0, tail.index).trim() : by,
    on: concern.on ?? null,
    words: concern.words ?? "",
    check: concern.owner_check ?? (tail ? (tail[1] ?? null) : null),
  };
}

/** How the check reads in a sentence, or the honest "not recorded" for a line written by hand. */
export function checkWords(check: OwnerCheck | null | undefined): string {
  if (!check) return "How the name was checked is not recorded.";
  const text = String(check);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export interface ConcernRow {
  statementId: string;
  statement: string;
  why: string;
  owner: string;
  resolution: "open" | "accepted" | "spec_changed";
  accepted: Acceptance | null;
}

export interface PolicyRow {
  pack: string;
  title: string | null;
  owner: string | null;
  version: string;
  answer: PolicyAnswer["answer"];
  concerns: ConcernRow[];
}

export function policyRows(answers: PolicyAnswer[] | undefined, packs: PolicyPack[] = []): PolicyRow[] {
  return (answers ?? []).map((a) => {
    const known = packs.find((p) => p.id === a.pack);
    return {
      pack: a.pack,
      title: known?.title ?? null,
      owner: known?.owner ?? null,
      version: a.sha256,
      answer: a.answer,
      concerns: (a.concerns ?? []).map((c) => ({
        statementId: c.statement_id,
        statement: c.statement,
        why: c.why,
        owner: c.owner,
        resolution: c.resolution === "accepted" || c.resolution === "spec_changed" ? c.resolution : "open",
        accepted: acceptance(c),
      })),
    };
  });
}

export function concernState(resolution: ConcernRow["resolution"]): { word: string; shape: "half" | "accepted" | "ready"; tone: "warning" | "neutral" | "success" } {
  if (resolution === "open") return { word: "Waiting for its owner", shape: "half", tone: "warning" };
  if (resolution === "accepted") return { word: "Accepted by its owner", shape: "accepted", tone: "neutral" };
  return { word: "Met by changing the spec", shape: "ready", tone: "success" };
}

export function openConcerns(rows: PolicyRow[]): Array<ConcernRow & { pack: string }> {
  return rows.flatMap((row) => row.concerns.filter((c) => c.resolution === "open").map((c) => ({ ...c, pack: row.pack })));
}

/**
 * A pack's row on the slice's page, in one line (M16 layout: the row says the state, the detail folds):
 * "Followed, answered under version b7b600b3e580", or the concerns by how each stands, saying that an open one is
 * shown above the rows (an open concern is never folded).
 */
export function packAnswerSummary(row: PolicyRow): string {
  const version = `Answered under version ${row.version}.`;
  if (row.answer === "followed" || !row.concerns.length) return `Followed. ${version}`;
  const open = row.concerns.filter((c) => c.resolution === "open").length;
  const accepted = row.concerns.filter((c) => c.resolution === "accepted").length;
  const changed = row.concerns.filter((c) => c.resolution === "spec_changed").length;
  const parts = [
    ...(open ? [open === 1 ? "1 waits for its owner (shown above)" : `${open} wait for their owners (shown above)`] : []),
    ...(accepted ? [`${accepted} accepted by ${accepted === 1 ? "its owner" : "their owners"}`] : []),
    ...(changed ? [`${changed} met by changing the spec`] : []),
  ];
  const concerns = row.concerns.length === 1 ? "1 concern" : `${row.concerns.length} concerns`;
  return `${concerns}: ${parts.join(", ")}. ${version}`;
}

/** Whether a pack's row has anything to open: the concerns that are no longer open (an open one is shown above). */
export function settledConcerns(row: PolicyRow): ConcernRow[] {
  return row.concerns.filter((c) => c.resolution !== "open");
}

/** A principle's row in one line: what upholds it, or that a reason or an exception is recorded. */
export function principleSummary(row: PrincipleRow): string {
  if (row.answer === "applies") return row.upheldBy.length ? `Upheld by ${row.upheldBy.join(", ")}` : "What upholds it is not recorded";
  if (row.answer === "does_not_apply") return row.reason ? "Why it does not apply is recorded" : "Why it does not apply is not recorded";
  return row.reason ? "Your exception, in your own words" : "The reason for the exception is not recorded";
}

/** The check's findings about the principles and policies sections, in the engine's words. */
export function answerFindings(check: SliceCheck | null | undefined): Array<{ severity: "error" | "warning"; message: string; line: number | null; rule: string | null }> {
  return (check?.diagnostics ?? [])
    .filter((d) => specSectionOf(d) === "policies" || specSectionOf(d) === "principles")
    .map((d) => ({ severity: d.severity === "warning" ? ("warning" as const) : ("error" as const), message: d.message, line: d.line, rule: d.rule }));
}

/** Which of the tab's states to draw. */
export type SliceTabState = "no-spec" | "nothing-to-answer" | "answers";

export function sliceTabState(model: Partial<SpecModel> | null | undefined): SliceTabState {
  if (!model) return "no-spec";
  const principles = model.principles ?? [];
  const policies = model.policies ?? [];
  return principles.length || policies.length ? "answers" : "nothing-to-answer";
}

/** The form's own hygiene before the engine is asked: both fields filled. Lengths and characters are the engine's to judge. */
export function acceptFormErrors(by: string, reason: string): { by?: string; reason?: string } {
  const out: { by?: string; reason?: string } = {};
  if (!by.trim()) out.by = "Write the owner's GitHub login, or their name or role.";
  if (!reason.trim()) out.reason = "Write the owner's reason as they gave it.";
  return out;
}

/** The arguments for policy.accept, as the engine takes them. */
export function acceptArgs(sliceId: string, statementId: string, by: string, reason: string) {
  return { slice_id: sliceId, policy_id: statementId, by: by.trim(), reason: reason.trim() };
}
