/**
 * "Needs you" (design M23 3 and 4.2): MACH's own list of what waits for a person (`GET /api/v1/needs`,
 * which is run.py's `decide --json`), read into the page's model, and the words for deciding in the
 * Factory Floor. Pure: no React, no fetch, so tests read it directly.
 *
 * Text written by others (a spec's title, a reviewer's or the verifier's words, a stop's reason, an open
 * question) is wrapped as free text (`unchecked`), shown plain and labelled, never as a label, a button or
 * an instruction. Everything a button or a dialog says is MACH's own (`label`, `does`, `summary`) or this
 * file's.
 */
import type { DecisionBody } from "../live/observer";
import { unchecked, type UncheckedText } from "../text/unchecked";

export interface NeedOption {
  readonly key: string;
  /** MACH's own words for the button: one to five words. */
  readonly label: string;
  /** MACH's own sentence: what choosing it does. */
  readonly does: string;
  readonly needsReason: boolean;
  readonly recommended: boolean;
  /** The Factory Floor can record it (`decide do` carries it out by itself); otherwise it needs a conversation. */
  readonly canDo: boolean;
  readonly needsTestCommand: boolean;
  readonly needsAnswers: boolean;
  /** A decision confirmed in a dialog first: it cannot be undone, or it stops another worker. */
  readonly confirm: boolean;
  /** MACH takes the ticket's step from the other worker as it records this (the take-over, or a release to the Factory). */
  readonly takesOver: boolean;
  /** Optional free-text inputs the option takes, by name (MACH's `takes`, such as "guidance"): one text box each, never required. */
  readonly takes: readonly TakesName[];
}

/** The optional inputs the page knows how to ask for and send (each is a body field of the same name). */
export const TAKES = ["guidance"] as const;
export type TakesName = (typeof TAKES)[number];

/** What a text box for an optional input says, and how long its words may be (the observer's own limit). */
export const TAKES_WORDS: Readonly<Record<TakesName, { readonly label: string; readonly hint: string; readonly max: number }>> = {
  guidance: { label: "What should the builder do differently?", hint: "Recorded with your decision and given to the builder with the findings. Left empty, the builder works from the findings alone.", max: 4000 },
};

/** One item the stop names as failed: its ID (`AC-03`, `R2`), its text and the verifier's or reviewer's note, as recorded. */
export interface StoppedItem {
  readonly id: string;
  readonly text: UncheckedText | null;
  readonly note: UncheckedText | null;
}

/** MACH's facts of a stop (`situation.stopped`): where, the rounds, what failed, and the findings file. */
export interface StoppedFacts {
  readonly station: string | null;
  readonly round: { readonly used: number | null; readonly max: number | null };
  readonly failed: readonly StoppedItem[];
  /** Project-relative; never a link. */
  readonly findingsFile: string | null;
}

export interface NeedQuestion {
  readonly n: number;
  readonly text: UncheckedText | null;
  readonly followUp: UncheckedText | null;
}

export interface NeedTicket {
  readonly ticketId: string;
  readonly state: string;
  /** MACH's own sentence for what happened. */
  readonly summary: string;
  readonly stage: string | null;
  readonly title: UncheckedText | null;
  readonly reason: UncheckedText | null;
  /** Further words behind it: the review's reasons for a person, the verifier's and reviewers' findings, the supervisor's hold. */
  readonly details: readonly UncheckedText[];
  /** Files to read first, relative to the project. */
  readonly showFirst: readonly string[];
  /** Recommended first, then in MACH's order. */
  readonly options: readonly NeedOption[];
  /** The command that walks this ticket in Claude Code. */
  readonly decideCommand: string;
  readonly questions: readonly NeedQuestion[];
  /**
   * MACH's own sentences to read before deciding, such as another worker that may still be on the ticket. Shown above
   * the options in the warning tone; they never disable an option or take its place.
   */
  readonly warnings: readonly string[];
  /** A ticket stopped for a person: what MACH says stopped it (`situation.stopped`); null when it says nothing of it. */
  readonly stopped: StoppedFacts | null;
}

export interface NeedsList {
  readonly tickets: readonly NeedTicket[];
  readonly readAt: number | null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const TICKET = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
const OPTION = /^[a-z][a-z-]{0,31}$/;

/** Field names for the free-text label (the observer declares them in `display_policy.free_text.catalog_fields`). */
export const FIELD = {
  title: "/api/v1/needs tickets[].situation.title",
  reason: "/api/v1/needs tickets[].situation.reason",
  detail: "/api/v1/needs tickets[].situation",
  question: "/api/v1/needs tickets[].questions[].text",
  stoppedText: "/api/v1/needs tickets[].situation.stopped.failed[].text",
  stoppedNote: "/api/v1/needs tickets[].situation.stopped.failed[].note",
} as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._#/-]{0,59}$/;
const roundNum = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 99 ? v : null);
const relPath = (v: unknown): string | null => {
  const p = str(v);
  return p && !p.startsWith("/") && !p.includes("..") && p.length <= 300 ? p : null;
};

/** `situation.stopped`, read tolerantly: an item without a plain ID is left out; at most 50 items. */
export function readStopped(value: unknown): StoppedFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = obj(value);
  const round = obj(s.round);
  const failed: StoppedItem[] = [];
  for (const item of arr(s.failed).slice(0, 50)) {
    const f = obj(item);
    const id = str(f.id);
    if (!id || !SAFE_ID.test(id)) continue;
    failed.push({ id, text: unchecked(f.text, FIELD.stoppedText, 300), note: unchecked(f.note, FIELD.stoppedNote, 600) });
  }
  return { station: str(s.station) && /^[a-z-]{1,30}$/.test(s.station as string) ? (s.station as string) : null, round: { used: roundNum(round.used), max: roundNum(round.max) }, failed, findingsFile: relPath(s.findings_file) };
}

/** Options in the order a person reads them: the recommended one first, then MACH's order. */
export function orderedOptions<T extends { readonly recommended: boolean; readonly key?: string }>(options: readonly T[]): T[] {
  // Abandoning is always reachable and always last: it deletes the work.
  const last = (o: T) => o.key === "abandon";
  return [...options.filter((o) => o.recommended && !last(o)), ...options.filter((o) => !o.recommended && !last(o)), ...options.filter(last)];
}

/** The option a stopped ticket is carried on with (MACH's key; another agent's run.py offers it). */
export const CARRY_ON = "carry-on";

/**
 * What happens after a carry-on is recorded, said truthfully: a Factory running here takes the ticket
 * up at the build step; with none running, /mach pull does. Unknown (the status is not read): both.
 */
export function carryOnNext(running: boolean | null | undefined): string {
  if (running === true) return "The Factory running here picks it up at the build step, with your words and the findings.";
  if (running === false) return "No Factory is running here. /mach pull in Claude Code carries it on from the build step.";
  return "A running Factory picks it up at the build step; if none is running, /mach pull in Claude Code carries it on from there.";
}

function readOption(value: unknown): NeedOption | null {
  const o = obj(value);
  const key = str(o.key);
  const label = str(o.label);
  if (!key || !OPTION.test(key) || !label) return null;
  const needs = arr(o.needs).filter((x): x is string => typeof x === "string");
  return {
    key,
    label,
    does: str(o.does) ?? "",
    needsReason: o.needs_reason === true,
    recommended: o.recommended === true,
    canDo: o.do === true,
    needsTestCommand: needs.includes("test_cmd"),
    needsAnswers: needs.includes("answers"),
    confirm: o.confirm === true || o.takes_over === true,
    takesOver: o.takes_over === true,
    takes: arr(o.takes).filter((x): x is TakesName => typeof x === "string" && (TAKES as readonly string[]).includes(x)),
  };
}

/** MACH's sentences, at most `max`, each plain text. */
function sentences(value: unknown, max = 5): string[] {
  return arr(value)
    .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    .slice(0, max)
    .map((s) => s.slice(0, 1000));
}

function details(situation: Record<string, unknown>): UncheckedText[] {
  const out: (UncheckedText | null)[] = [];
  for (const r of arr(situation.approval_reasons)) out.push(unchecked(r, FIELD.detail, 200));
  for (const c of arr(situation.causes).slice(0, 5)) {
    const cause = obj(c);
    out.push(unchecked(cause.detail ?? cause.rule, FIELD.detail, 300));
  }
  out.push(unchecked(obj(situation.parked).reason, FIELD.detail, 300));
  return out.filter((x): x is UncheckedText => x !== null);
}

/** `/api/v1/needs` `data`, read tolerantly: a ticket without an ID or a usable option list is left out. */
export function readNeeds(data: unknown): NeedsList {
  const d = obj(data);
  const tickets: NeedTicket[] = [];
  for (const t of arr(d.tickets)) {
    const item = obj(t);
    const ticketId = str(item.ticket_id);
    if (!ticketId || !TICKET.test(ticketId)) continue;
    const situation = obj(item.situation);
    tickets.push({
      ticketId,
      state: str(item.state) ?? "",
      summary: str(situation.summary) ?? "This ticket waits for a person.",
      stage: str(situation.stage),
      title: unchecked(situation.title, FIELD.title, 120),
      reason: unchecked(situation.reason, FIELD.reason, 300),
      details: details(situation),
      showFirst: arr(item.show_first).filter((p): p is string => typeof p === "string" && !p.startsWith("/") && !p.includes("..")),
      options: orderedOptions(arr(item.options).map(readOption).filter((o): o is NeedOption => o !== null)),
      decideCommand: str(item.decide_command) ?? `/mach decide ${ticketId}`,
      questions: arr(item.questions)
        .map((q) => obj(q))
        .filter((q) => typeof q.n === "number" && Number.isInteger(q.n) && q.n > 0)
        .map((q) => ({ n: q.n as number, text: unchecked(q.text, FIELD.question, 300), followUp: unchecked(q.follow_up, FIELD.question, 300) })),
      warnings: sentences(item.warnings),
      stopped: readStopped(situation.stopped),
    });
  }
  const at = str(d.read_at);
  return { tickets, readAt: at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : null };
}

/** What the observer answered for one decision (`decide do`, without the person's name). */
export interface Decided {
  readonly ticketId: string | null;
  readonly option: string | null;
  readonly done: boolean;
  readonly inConversation: boolean;
  /** MACH's sentence: what is true now. */
  readonly now: string | null;
  /** For an option that needs a conversation: why, and the command. */
  readonly why: string | null;
  readonly command: string | null;
  readonly note: string | null;
  /** Why no Factory carries it on now ("No Factory is running here. ..."), when that is so. */
  readonly whyNot: string | null;
  readonly supervisor: "started" | "woken" | "none" | null;
  /** MACH's sentences recorded with the decision, such as another worker that may still be on the ticket. */
  readonly warnings: readonly string[];
  /**
   * Another person's decision on this ticket came first and made this one moot. Nothing was recorded, and it is not a
   * refusal: `now` says what was decided, when, and what the ticket waits for now (information, not an error).
   */
  readonly alreadyDecided: boolean;
  /** The step was taken from the other worker. */
  readonly tookOver: boolean;
}

export function readDecided(data: unknown): Decided {
  const d = obj(data);
  const sup = d.supervisor === "started" || d.supervisor === "woken" || d.supervisor === "none" ? d.supervisor : null;
  return {
    warnings: sentences(d.warnings),
    alreadyDecided: d.already_decided === true && d.done !== true,
    tookOver: d.took_over === true,
    ticketId: str(d.ticket_id),
    option: str(d.option),
    done: d.done === true,
    inConversation: d.in_conversation === true,
    now: str(d.now),
    why: str(d.why),
    command: str(d.command),
    note: str(d.note),
    whyNot: str(d.why_not),
    supervisor: sup,
  };
}

/** One answer being written: in the person's words, or left open. Nothing is chosen for them. */
export interface AnswerDraft {
  readonly mode: "answer" | "open" | null;
  readonly text: string;
}

/**
 * The answers to send, or what is still missing, in words. Every question is answered or left open, and at
 * least one answered (MACH's own rule, act.py). The person's words are sent as written.
 */
export function answersPayload(questions: readonly NeedQuestion[], drafts: Readonly<Record<number, AnswerDraft>>): { readonly answers: NonNullable<DecisionBody["answers"]> | null; readonly problem: string | null } {
  const out: ({ readonly n: number; readonly answer: string } | { readonly n: number; readonly leave_open: true })[] = [];
  const missing: number[] = [];
  for (const q of questions) {
    const d = drafts[q.n];
    if (d?.mode === "open") out.push({ n: q.n, leave_open: true });
    else if (d?.mode === "answer" && d.text.trim() !== "") out.push({ n: q.n, answer: d.text });
    else missing.push(q.n);
  }
  if (missing.length > 0) {
    return { answers: null, problem: `Answer question${missing.length > 1 ? "s" : ""} ${missing.join(", ")}, or leave ${missing.length > 1 ? "them" : "it"} open.` };
  }
  if (out.every((a) => "leave_open" in a)) return { answers: null, problem: "Answer at least one question: with every one left open, nothing would change." };
  return { answers: out, problem: null };
}

/** The body for one decision. A name only when the person gave one (else MACH records Git's user name); a reason only where asked for. */
export function decisionBody(
  option: NeedOption,
  input: { readonly name: string; readonly reason: string; readonly testCmd: string; readonly answers?: DecisionBody["answers"] | null; readonly takes?: Readonly<Partial<Record<TakesName, string>>> },
): DecisionBody {
  const name = input.name.trim();
  // An optional input is sent only when the option takes it and the person wrote something, as written.
  const taken: Partial<Record<TakesName, string>> = {};
  for (const key of option.takes) {
    const v = input.takes?.[key] ?? "";
    if (v.trim()) taken[key] = v.slice(0, TAKES_WORDS[key].max);
  }
  return {
    ...(name ? { by: name } : {}),
    ...(option.needsReason ? { reason: input.reason } : {}),
    ...(option.needsTestCommand ? { test_cmd: input.testCmd.trim() } : {}),
    ...(option.needsAnswers && input.answers ? { answers: input.answers } : {}),
    ...taken,
  };
}

/** What is still missing before a decision can be sent, in words; null when nothing is. */
export function missingInput(option: NeedOption, input: { readonly reason: string; readonly testCmd: string }): string | null {
  if (option.needsReason && input.reason.trim() === "") return "Write your reason, in your own words.";
  if (option.needsTestCommand && input.testCmd.trim() === "") return "Write the command that runs the tests.";
  return null;
}

/** The confirm dialog for a decision that cannot be undone: what will happen, and that it cannot be undone. */
export function confirmWords(ticket: string, option: NeedOption): { readonly title: string; readonly description: string; readonly verb: string; readonly tone: "primary" | "danger" } {
  switch (option.key) {
    case "approve":
      return { title: `Approve ${ticket}?`, description: `Your approval of ${ticket} is recorded, and the Factory carries it on: it merges or waits, as the project's merge settings say. An approval cannot be undone.`, verb: "Approve", tone: "primary" };
    case "merge":
      return { title: `Merge ${ticket}?`, description: `MACH merges ${ticket} into the main branch, and cleanup follows. A merge cannot be undone from here.`, verb: "Merge", tone: "primary" };
    case "abandon":
      // MACH's own sentence of what abandoning does (it says the work is deleted for good).
      return { title: `Abandon ${ticket}?`, description: option.does ? `${option.does} This cannot be undone.` : `MACH takes ${ticket} off the line and removes its cell, with your reason. This cannot be undone.`, verb: "Abandon", tone: "danger" };
    case "take-over":
      // MACH's own sentence says what happens to the other worker, in the words of the take-over it carries out:
      // "the other worker stops at its next step", and "the Factory's run on it is ended" when it was a Factory run.
      return { title: `Take over ${ticket}?`, description: option.does, verb: "Take it over", tone: "primary" };
    default:
      if (option.takesOver) {
        return {
          title: `${option.label}: ${ticket}?`,
          description: `${option.does} Another worker holds this ticket's step, so MACH takes the step over as it records this: the other worker stops at its next step.`,
          verb: option.label,
          tone: "primary",
        };
      }
      return { title: `${option.label}: ${ticket}?`, description: `${option.does} This cannot be undone from here.`, verb: option.label, tone: "primary" };
  }
}

/** While another decision on the project is being recorded, a decision made here waits for it, and the page asks again by itself. */
export const WAITING_WORDS = "Recording after another decision finishes";

/** How often the page asks again while another decision is being recorded. */
export const RETRY_MS = 2000;

/** "for 12 s", "for 3 min": how long a decision made here has waited for another one. */
export function waitedWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `for ${s} s` : `for ${Math.floor(s / 60)} min`;
}

/** The sentence when something waits and no Factory runs here. */
export const NOT_RUNNING = "No Factory is running here. /mach pull in Claude Code carries it on.";

/**
 * The same, when a ticket stopped for a person is among them: true for it too, said in full. Starting the
 * Factory gives a ticket stopped for its rounds a fresh set of rounds; a decision made here first is
 * taken into account.
 */
export const NOT_RUNNING_STOPPED =
  "No Factory is running here. /mach pull in Claude Code starts it: it takes up each decision made here, and gives a ticket stopped for its rounds a fresh set of rounds, from the build step.";

/** The stop's confirmation. */
export const STOP_WORDS = { title: "Stop the Factory?", description: "Stops the Factory's running work on this computer. /mach pull starts it again.", verb: "Stop the Factory" } as const;

/** How a running Factory was started, in words. */
export function startedWords(lifetime: "session" | "background" | null | undefined): string | null {
  return lifetime === "session" ? "with this Claude Code session" : lifetime === "background" ? "in the background" : null;
}

/** Where the person's name is kept in this browser. */
export const NAME_KEY = "mach.floor.name";

export function loadName(storage: Pick<Storage, "getItem"> | null | undefined): string {
  try {
    const v = storage?.getItem(NAME_KEY);
    return typeof v === "string" ? v.slice(0, 120) : "";
  } catch {
    return "";
  }
}

export function saveName(storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined, name: string): void {
  try {
    const v = name.trim();
    if (v) storage?.setItem(NAME_KEY, v.slice(0, 120));
    else storage?.removeItem(NAME_KEY);
  } catch {
    // Storage refused: the name lasts for this visit.
  }
}
