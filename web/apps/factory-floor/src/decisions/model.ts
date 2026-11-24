/**
 * Decisions in force: the observer's `/api/v1/decisions` and `/api/v1/decisions/{adr}` replies read
 * into what the Decisions workspace shows, and the words it uses. Pure: no React, no window.
 *
 * Every value written by people (an ADR's title and text, a problem that quotes a header, a reason
 * recorded against a decision) is handed on only as `UncheckedText` (src/text/unchecked.ts), so it
 * is printed plain, bounded and labelled, and can never reach a title, an accessible name, the
 * address or storage. Everything else is a code, an ID, a time or a count, checked here; a value
 * that does not fit is dropped, never guessed.
 *
 * Nothing here acts. The page says where a decision is changed: in the terminal (`/mach adr ...`)
 * and by a pull request for the ADR file.
 */
import { unchecked, type UncheckedText } from "../text/unchecked";

export const ADR_ID = /^ADR-[0-9]{4}$/;
const TICKET = /^[A-Za-z0-9][A-Za-z0-9._:#~-]{0,127}$/;
const TOPIC = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const APPLIES = /^(all|app:[a-z]+|topic:[a-z0-9]+(?:-[a-z0-9]+)*|path:[A-Za-z0-9._*?/-]{1,200})$/;
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,15}(Z|[+-][0-9]{2}:[0-9]{2})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TOKEN = /^[a-z][a-z0-9_.-]{0,63}$/;

export const STATUSES = ["proposed", "accepted", "deprecated", "rejected", "superseded"] as const;
export type AdrStatus = (typeof STATUSES)[number];
export const STOP_CODES = ["adr-decision", "adr-acceptance", "adr-fix"] as const;
export type StopCode = (typeof STOP_CODES)[number];

/** Where a field came from, for its label (the observer declares them in `display_policy.free_text.catalog_fields`). */
const FIELD = {
  title: "an ADR's title",
  fileText: "an ADR's file name",
  problem: "a problem with an ADR file",
  reason: "a reason recorded against a decision",
  text: "an ADR's text",
} as const;

export interface AdrRow {
  readonly id: string | null;
  readonly number: number | null;
  /** A plain repository path; null when the name is not one (then `fileText` holds it, contained). */
  readonly file: string | null;
  readonly fileText: UncheckedText | null;
  readonly title: UncheckedText | null;
  /** Null when the status cannot be read (a problem says why). */
  readonly status: AdrStatus | null;
  readonly supersededBy: string | null;
  readonly supersedes: readonly string[];
  readonly topics: readonly string[];
  readonly appliesTo: readonly string[];
  readonly appliesToHidden: number;
  /** Accepted and readable: it binds the Factory (once committed on the main branch). */
  readonly binding: boolean;
  /** The file itself could not be read. */
  readonly unread: boolean;
  readonly problems: readonly UncheckedText[];
  readonly digest: string | null;
}

export interface BaselineTopic {
  readonly topic: string;
  readonly description: string;
  readonly addedByProject: boolean;
  readonly coveredBy: readonly string[];
}

export interface Baseline {
  readonly topics: readonly BaselineTopic[];
  readonly missing: readonly string[];
  readonly covered: boolean;
  /** Entries of adr.required_topics that are not topic words: they stay required and no ADR can cover them. */
  readonly unusableEntries: number;
  readonly settingProblems: readonly UncheckedText[];
}

export interface Proposal {
  readonly ticket: string;
  readonly adr: string;
  readonly title: UncheckedText | null;
  readonly file: string | null;
  readonly stage: string | null;
  readonly risk: string | null;
  /** A High-risk ticket's build waits for it. */
  readonly holdsBuild: boolean;
}

export interface Stop {
  readonly ticket: string;
  readonly needs: StopCode;
  readonly stage: string | null;
  readonly adr: string | null;
  readonly adrs: readonly string[];
  readonly title: UncheckedText | null;
  readonly reason: UncheckedText | null;
  readonly at: string | null;
  /** The cell also records a conflict with main, which the routing sheet may stop on first. */
  readonly alsoMainConflict: boolean;
}

export interface DecisionsView {
  readonly basis: string;
  readonly dir: string | null;
  readonly dirFound: boolean;
  readonly config: "read" | "missing" | "unreadable" | null;
  readonly adrs: readonly AdrRow[];
  readonly problems: readonly UncheckedText[];
  readonly baseline: Baseline;
  readonly proposals: readonly Proposal[];
  readonly stopped: readonly Stop[];
  readonly proposedOnMain: readonly string[];
  readonly cellsRead: number;
  readonly cellsUnreadable: readonly string[];
}

export interface TicketUnder {
  readonly ticket: string;
  readonly stage: string | null;
  readonly plannedAt: string | null;
  /** Planned under the text the folder holds now (true), an earlier text (false), or not known (null). */
  readonly sameText: boolean | null;
}

export interface ExceptionRow {
  readonly ticket: string;
  readonly stage: string | null;
  readonly at: string | null;
  /** Always a role: people's names never leave the observer. */
  readonly by: string;
  readonly recordedBy: string;
  readonly reason: UncheckedText | null;
  readonly sameText: boolean | null;
}

export interface ConflictRow {
  readonly ticket: string;
  readonly stage: string | null;
  readonly at: string | null;
  readonly reason: UncheckedText | null;
}

export interface ProposedBy {
  readonly ticket: string;
  readonly title: UncheckedText | null;
  readonly file: string | null;
  readonly accepted: boolean;
  readonly holdsBuild: boolean;
}

export interface DecisionPage {
  readonly id: string;
  readonly basis: string;
  /** Null when the ADR folder has no file with this ID (a ticket's own proposal, on its branch). */
  readonly adr: (AdrRow & { readonly sameNumber: readonly string[] }) | null;
  readonly text: UncheckedText | null;
  readonly textCut: boolean;
  readonly textLimit: number;
  readonly plannedUnder: readonly TicketUnder[];
  readonly exceptions: readonly ExceptionRow[];
  readonly conflicts: readonly ConflictRow[];
  readonly proposedBy: readonly ProposedBy[];
  readonly acceptances: readonly { readonly ticket: string; readonly at: string | null }[];
}

// ---------------------------------------------------------------- reading

type Obj = Readonly<Record<string, unknown>>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const match = (re: RegExp, v: unknown): string | null => (typeof v === "string" && re.test(v) ? v : null);
const ids = (v: unknown): string[] => arr(v).flatMap((x) => (typeof x === "string" && ADR_ID.test(x) ? [x] : []));
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const texts = (v: unknown, field: string, max: number): UncheckedText[] => arr(v).flatMap((x) => {
  const t = unchecked(x, field, max);
  return t ? [t] : [];
});
const yesNo = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

function readAdr(v: unknown): AdrRow {
  const a = obj(v);
  const status = typeof a.status === "string" && (STATUSES as readonly string[]).includes(a.status) ? (a.status as AdrStatus) : null;
  const problems = texts(a.problems, FIELD.problem, 400);
  return {
    id: match(ADR_ID, a.id),
    number: typeof a.number === "number" && Number.isInteger(a.number) && a.number >= 0 ? a.number : null,
    file: match(PATH, a.file),
    fileText: unchecked(a.file_text, FIELD.fileText, 200),
    title: unchecked(a.title, FIELD.title, 200),
    status,
    supersededBy: match(ADR_ID, a.superseded_by),
    supersedes: ids(a.supersedes),
    topics: arr(a.topics).flatMap((x) => (typeof x === "string" && TOPIC.test(x) ? [x] : [])),
    appliesTo: arr(a.applies_to).flatMap((x) => (typeof x === "string" && APPLIES.test(x) ? [x] : [])),
    appliesToHidden: count(a.applies_to_hidden),
    // Fails closed: binds only when the observer says so of a readable, accepted file.
    binding: a.binding === true && status === "accepted" && problems.length === 0 && a.unread !== true,
    unread: a.unread === true,
    problems,
    digest: match(DIGEST, a.digest),
  };
}

const CONFIGS = ["read", "missing", "unreadable"] as const;

/** `/api/v1/decisions`'s data. */
export function readDecisions(data: unknown): DecisionsView {
  const d = obj(data);
  const source = obj(d.source);
  const b = obj(d.baseline);
  const waiting = obj(d.waiting);
  const cells = obj(d.cells);
  const topics: BaselineTopic[] = arr(b.topics).flatMap((v) => {
    const t = obj(v);
    const topic = match(TOPIC, t.topic);
    if (!topic) return [];
    // The topic's one line is MACH's own (adr.REQUIRED_TOPICS), never a person's.
    return [{ topic, description: typeof t.description === "string" ? t.description : "", addedByProject: t.added_by_project === true, coveredBy: ids(t.covered_by) }];
  });
  const stopped: Stop[] = arr(waiting.stopped).flatMap((v) => {
    const s = obj(v);
    const ticket = match(TICKET, s.ticket);
    const needs = typeof s.needs === "string" && (STOP_CODES as readonly string[]).includes(s.needs) ? (s.needs as StopCode) : null;
    if (!ticket || !needs) return [];
    return [{
      ticket,
      needs,
      stage: match(TOKEN, s.stage),
      adr: match(ADR_ID, s.adr),
      adrs: ids(s.adrs),
      title: unchecked(s.title, FIELD.title, 200),
      reason: unchecked(s.reason, FIELD.reason, 1000),
      at: match(TIME, s.at),
      alsoMainConflict: s.also_recorded === "main-conflict",
    }];
  });
  const proposals: Proposal[] = arr(waiting.proposals).flatMap((v) => {
    const p = obj(v);
    const ticket = match(TICKET, p.ticket);
    const adr = match(ADR_ID, p.adr);
    if (!ticket || !adr) return [];
    return [{ ticket, adr, title: unchecked(p.title, FIELD.title, 200), file: match(PATH, p.file), stage: match(TOKEN, p.stage), risk: typeof p.risk === "string" ? p.risk : null, holdsBuild: p.holds_build === true }];
  });
  return {
    basis: typeof d.basis === "string" ? d.basis : "",
    dir: match(PATH, source.dir),
    dirFound: source.dir_found === true,
    config: typeof source.config === "string" && (CONFIGS as readonly string[]).includes(source.config) ? (source.config as DecisionsView["config"]) : null,
    adrs: arr(d.adrs).map(readAdr),
    problems: texts(d.problems, FIELD.problem, 400),
    baseline: {
      topics,
      missing: arr(b.missing).flatMap((x) => (typeof x === "string" && TOPIC.test(x) ? [x] : [])),
      // Fails closed: covered only when the observer says so and no required topic is missing.
      covered: b.covered === true && topics.every((t) => t.coveredBy.length > 0),
      unusableEntries: count(b.unusable_entries),
      settingProblems: texts(b.setting_problems, FIELD.problem, 400),
    },
    proposals,
    stopped,
    proposedOnMain: ids(waiting.proposed_on_main),
    cellsRead: count(cells.read),
    cellsUnreadable: arr(cells.unreadable).flatMap((x) => (typeof x === "string" && TICKET.test(x) ? [x] : [])),
  };
}

/** `/api/v1/decisions/{adr}`'s data. */
export function readDecision(data: unknown, id: string): DecisionPage {
  const d = obj(data);
  const raw = d.adr && typeof d.adr === "object" ? obj(d.adr) : null;
  const tickets = <T>(v: unknown, f: (o: Obj, ticket: string) => T): T[] =>
    arr(v).flatMap((x) => {
      const o = obj(x);
      const ticket = match(TICKET, o.ticket);
      return ticket ? [f(o, ticket)] : [];
    });
  const limit = count(d.text_limit) || 6000;
  return {
    id,
    basis: typeof d.basis === "string" ? d.basis : "",
    adr: raw ? { ...readAdr(raw), sameNumber: arr(raw.same_number).flatMap((x) => (typeof x === "string" && PATH.test(x) ? [x] : [])) } : null,
    text: unchecked(d.text, FIELD.text, limit),
    textCut: d.text_cut === true,
    textLimit: limit,
    plannedUnder: tickets(d.planned_under, (o, ticket) => ({ ticket, stage: match(TOKEN, o.stage), plannedAt: match(TIME, o.planned_at), sameText: yesNo(o.same_text) })),
    exceptions: tickets(d.exceptions, (o, ticket) => ({
      ticket,
      stage: match(TOKEN, o.stage),
      at: match(TIME, o.at),
      by: "a person",
      recordedBy: o.recorded_by === "an agent, on the person's instruction in conversation" ? "an agent, on the person's instruction in conversation" : "a person",
      reason: unchecked(o.reason, FIELD.reason, 1000),
      sameText: yesNo(o.same_text),
    })),
    conflicts: tickets(d.conflicts, (o, ticket) => ({ ticket, stage: match(TOKEN, o.stage), at: match(TIME, o.at), reason: unchecked(o.reason, FIELD.reason, 1000) })),
    proposedBy: tickets(d.proposed_by, (o, ticket) => ({ ticket, title: unchecked(o.title, FIELD.title, 200), file: match(PATH, o.file), accepted: o.accepted === true, holdsBuild: o.holds_build === true })),
    acceptances: tickets(d.acceptances, (o, ticket) => ({ ticket, at: match(TIME, o.at) })),
  };
}

// ---------------------------------------------------------------- words

/** Each status as the page says it. */
export const STATUS_WORDS: Readonly<Record<AdrStatus, { readonly label: string; readonly tone: "success" | "info" | "neutral" | "warning" }>> = {
  accepted: { label: "Accepted", tone: "success" },
  proposed: { label: "Proposed", tone: "info" },
  deprecated: { label: "Deprecated", tone: "neutral" },
  rejected: { label: "Rejected", tone: "neutral" },
  superseded: { label: "Superseded", tone: "neutral" },
};

/** One row's state in words: its status, what supersedes it, whether it binds. */
export function stateWords(a: Pick<AdrRow, "status" | "supersededBy" | "binding" | "problems" | "unread">): string {
  if (a.unread) return "Cannot be read";
  if (!a.status) return "Status cannot be read";
  const base = STATUS_WORDS[a.status].label;
  if (a.status === "superseded") return a.supersededBy ? `Superseded by ${a.supersededBy}` : base;
  if (a.status === "accepted" && !a.binding) return "Accepted, but binds nothing until its problems are fixed";
  return base;
}

/** What a stop means, and what a person does about it, in plain words. */
export const STOP_WORDS: Readonly<Record<StopCode, { readonly title: string; readonly sentence: string }>> = {
  "adr-decision": {
    title: "The plan cannot follow a decision",
    sentence: "The contract engineer found this slice cannot be planned under an accepted decision. An engineer decides: an exception for this ticket, or a new decision that supersedes it, and the ticket planned again.",
  },
  "adr-acceptance": {
    title: "A proposal waits to be accepted",
    sentence: "This High-risk ticket's plan proposes a new decision, and its build waits until an engineer accepts it.",
  },
  "adr-fix": {
    title: "A decision file cannot be read",
    sentence: "An ADR file on the main branch cannot be read, so no ticket is planned until an engineer fixes it by pull request.",
  },
};

/** The baseline's one sentence when a required topic is missing. */
export const BASELINE_HELD =
  "No ticket is planned or built until every required topic is covered by an accepted decision on the main branch. Tickets already planned carry on.";

/**
 * Where a decision is changed. The page never changes one: these are the run skill's real commands
 * (skills/run/SKILL.md), for a person to run in Claude Code, and a pull request for the ADR file.
 */
export const COMMANDS = {
  list: { command: "/mach adr list", purpose: "to list the decisions in the terminal" },
  baseline: { command: "/mach adr baseline", purpose: "to draft the missing baseline decisions" },
  new: { command: '/mach adr new "<decision>"', purpose: "to write a new decision as proposed" },
  accept: (id: string) => ({ command: `/mach adr accept ${id}`, purpose: `to accept ${id}` }),
  acceptOnTicket: (ticket: string, adrs: readonly string[]) => ({ command: `/mach adr accept ${ticket} ${adrs.join(" ")}`, purpose: `to accept the decision ${ticket} proposes` }),
  except: (ticket: string, id: string) => ({ command: `/mach adr except ${ticket} ${id} "<why>"`, purpose: `to record an exception to ${id} for ${ticket}` }),
  decide: (ticket: string) => ({ command: `/mach decide ${ticket}`, purpose: `to decide about ${ticket}` }),
} as const;

/** The one sentence on every page about where changes happen. */
export const WHERE_CHANGED =
  "This page only reads. A decision is accepted, changed or superseded by a pull request for its ADR file, and a ticket's exception or a proposal's acceptance is recorded with /mach adr in Claude Code.";

/** The command for a stop: what a person runs next. */
export function stopCommand(s: Pick<Stop, "ticket" | "needs" | "adr" | "adrs">): { readonly command: string; readonly purpose: string } {
  if (s.needs === "adr-acceptance" && s.adrs.length) return COMMANDS.acceptOnTicket(s.ticket, s.adrs);
  return COMMANDS.decide(s.ticket);
}

/** Whether the ticket planned under a decision was planned under its current text. */
export function sameTextWords(v: boolean | null): string {
  return v === true ? "under this text" : v === false ? "under an earlier text" : "text not compared";
}

/** Summary counts for the list's header. */
export function summary(v: DecisionsView): { readonly accepted: number; readonly binding: number; readonly proposed: number; readonly withProblems: number } {
  return {
    accepted: v.adrs.filter((a) => a.status === "accepted").length,
    binding: v.adrs.filter((a) => a.binding).length,
    proposed: v.adrs.filter((a) => a.status === "proposed").length,
    withProblems: v.adrs.filter((a) => a.problems.length > 0).length,
  };
}

/** The ADRs in the order the list shows them: by number, a file without one last, in file order. */
export function ordered(adrs: readonly AdrRow[]): AdrRow[] {
  return [...adrs].sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER));
}
