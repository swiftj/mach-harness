/**
 * The Line's model: the stations as columns, each ticket a row, and where each ticket stands now.
 * Pure: no React, no window, so every rule is tested in plain node (test/line-model.test.mjs).
 *
 * Everything here is read from the scene the store holds now (`log.sceneAt(now)`): cells, their
 * station visits, judging rounds, recorded waits and holds, executions and their recorded spend.
 * Nothing is estimated. A figure no record carries is null, and the view says "not recorded".
 *
 * A ticket is in one of five states, each drawn with its own shape as well as its own colour:
 * - `working`: a station visit is open (a worker is at it);
 * - `held`: nothing is at work on it and no person is needed (a recorded wait for a place, a
 *   dependency, a supervisor's hold, or simply its next step not started yet);
 * - `person`: a person must act (a person's approval, a question for the product owner, a recorded
 *   request for a person);
 * - `stopped`: the line stopped work on it (blocked: the round limit, or the supervisor parked it);
 * - `landed`: merged.
 */
import {
  MAX_ROUNDS,
  MODELS,
  capacityWaitOf,
  cellStopOf,
  mockWaitsOf,
  recheckCount,
  type CellStop,
  type MockWait,
  costCompletenessOf,
  isKnown,
  holdOf,
  parkedWords,
  type CellState,
  type ExecutionState,
  type Moment,
  type Risk,
  type Scene,
  type SliceState,
  type StationId,
  type StationVisit,
} from "../sim";

// ---------------------------------------------------------------- the stations

/** The model tier keys under `models` in `.factory/config.json` (run.py Project.model). */
export type TierKey = "planning" | "contracts" | "build" | "utility";

export interface LineStation {
  readonly key: "groom" | "plan" | "build" | "verify" | "review" | "merge" | "cleanup";
  readonly name: string;
  /** The recorded stations whose visits are counted in this column. */
  readonly visits: readonly StationId[];
  /** Who works here, in plain words. */
  readonly worker: string;
  /** What the station does, in one sentence. */
  readonly does: string;
  /** Where the model for this station is set: `.factory/config.json`, `models.<tier>`. */
  readonly tiers: string;
}

/** The columns, left to right. The readiness check (audit) is counted with Plan; a person's approval with Review. */
export const LINE_STATIONS: readonly LineStation[] = [
  { key: "groom", name: "Groom", visits: ["groom"], worker: "Interviewer", does: "Interviews the product owner, one question at a time, and writes the slice spec.", tiers: "models.planning" },
  { key: "plan", name: "Plan", visits: ["plan", "audit"], worker: "Contract engineer", does: "Writes the contracts and a test-first plan from the spec; the readiness check of the repository is counted here too.", tiers: "models.contracts (the readiness check: models.build)" },
  { key: "build", name: "Build", visits: ["build"], worker: "Builder", does: "Writes failing tests first, then the code, one planned task at a time.", tiers: "models.build" },
  { key: "verify", name: "Verify", visits: ["verify"], worker: "Verifier", does: "Runs the slice the way its user would and captures proof for every scenario and rule.", tiers: "models.build" },
  { key: "review", name: "Review", visits: ["review", "human-approval"], worker: "Review panel", does: "Reviewers with fresh eyes each submit findings; any blocker is a vote to reject. A person's approval, when one is needed, is counted here.", tiers: "models.contracts for High risk, models.build otherwise" },
  { key: "merge", name: "Merge", visits: ["merge"], worker: "Merge station", does: "Lands exactly the commit review approved, or refuses.", tiers: "models.utility" },
  { key: "cleanup", name: "Clean up", visits: ["cleanup"], worker: "Clean-up station", does: "Archives the ticket's record and removes its workspace.", tiers: "models.utility" },
];

const COLUMN_OF: Readonly<Partial<Record<StationId, number>>> = Object.fromEntries(LINE_STATIONS.flatMap((s, i) => s.visits.map((v) => [v, i])));
const GROOM = 0;
const PLAN = 1;
const BUILD = 2;
const VERIFY = 3;
const REVIEW = 4;
const MERGE = 5;
const CLEANUP = 6;

/** The column a recorded station is drawn in, or null for one the Line does not show (intake, observe). */
export function columnOf(station: StationId | null | undefined): number | null {
  return station ? (COLUMN_OF[station] ?? null) : null;
}

// ---------------------------------------------------------------- one ticket

export type LineState = "working" | "held" | "person" | "stopped" | "landed";

/** What the state is called, in plain words. */
export const STATE_WORDS: Readonly<Record<LineState, string>> = {
  working: "Working",
  held: "Held",
  person: "Waiting for you",
  stopped: "Stopped",
  landed: "Landed",
};

/** A reason a ticket is held. `freeText`: the supervisor's own words, shown contained (never in a label). */
export type HeldReason =
  | { readonly kind: "capacity"; readonly words: string }
  | { readonly kind: "dependency"; readonly words: string }
  | { readonly kind: "supervisor"; readonly words: string; readonly freeText: string }
  | { readonly kind: "next"; readonly words: string }
  /** M15: sent back by the merge-time recheck; it moves on by itself, to Verify. */
  | { readonly kind: "recheck"; readonly words: string };

export interface StationTime {
  readonly column: number;
  /** Milliseconds, or null when no record gives the length. */
  readonly ms: number | null;
  /** How the length is known: measured (entry and exit recorded), so far (still open), or at most (it never recorded an exit). */
  readonly basis: "measured" | "so-far" | "at-most";
  /** A second or later visit to this column: work sent back. */
  readonly rework: boolean;
  readonly round: number;
}

export interface LineRow {
  readonly ticketId: string;
  readonly sliceId: string | null;
  /** The slice's title as recorded (free text: shown contained, never in a label). Null when none is recorded. */
  readonly title: string | null;
  /** The slice's epic (M11), when recorded: its id, and its name as recorded (free text, like the title). */
  readonly epicId: string | null;
  readonly epicTitle: string | null;
  /** The slice's GitHub issue number, when recorded; shown as text, never as a link. */
  readonly issue: number | null;
  readonly risk: Risk | null;
  readonly state: LineState;
  /** The column the ticket stands at. */
  readonly column: number;
  /** A person's approval sits between Review and Merge: the marker is drawn on that boundary. */
  readonly beforeMerge: boolean;
  /** Columns finished (a visit there ended), left of the marker. */
  readonly passed: readonly number[];
  /** Short words on the marker beside the state: "task 4 of 9", "9 of 14 checks". Our words only. */
  readonly detail: string | null;
  /** Since when it has been in this state (source time), or null when no record says. */
  readonly since: number | null;
  /** Work sent back to an earlier station: from the column that sent it, to the column it went back to, how many times. */
  readonly sentBack: { readonly from: number; readonly to: number; readonly times: number } | null;
  readonly held: HeldReason | null;
  /** Why it is here, in our words. */
  readonly why: string;
  /** A person's recorded words that say why it needs a person (free text, contained), when there are any. */
  readonly personWords: string | null;
  /** What it needs from a person. */
  readonly needs: string;
  /** The `/mach` command to copy. */
  readonly command: string;
  /** A second command, shown below the first (M15: explain, beside a policy concern's accept command). */
  readonly alsoCommand?: string | null;
  /** M15: the wait M13 or M14 added that put it here, when one did (one code for every view). */
  readonly stop?: CellStop["kind"] | "waiting-mocks" | null;
  /** M15: the slice's Jira key, when recorded (an identifier, shown as text, never a link). */
  readonly jira?: string | null;
  /** M15: the change record's repository-relative path, when recorded (shown as text, never a link). */
  readonly changeRecord?: string | null;
  /** M15: the merge-time recheck sent it back this many times (each a repeat review round, no judging round used). */
  readonly rechecks?: number;
  readonly times: readonly StationTime[];
  /** Judging rounds started (verification or review), of MAX_ROUNDS. */
  readonly roundsUsed: number;
  /** Recorded spend across its executions; null when none is recorded. `partial`: a record says it may be under-reported, or only some executions recorded one. */
  readonly cost: { readonly usd: number; readonly partial: boolean } | null;
  /** When its first record was made (for a stable order). */
  readonly openedAt: number;
}

const ROUND_WORDS = ["", "once", "twice"];
export const timesWords = (n: number): string => ROUND_WORDS[n] ?? `${n} times`;

function visitMs(v: StationVisit, now: number): StationTime["ms"] {
  if (v.leftAt === null) return Math.max(0, now - v.enteredAt);
  if (v.durationMs !== null) return v.durationMs;
  return Math.max(0, v.leftAt - v.enteredAt);
}

/** Where the time went, one entry per visit, in the order they happened. Interrupted visits are left out (their span is not time spent). */
export function stationTimes(cell: CellState, now: number): StationTime[] {
  const seen = new Set<number>();
  const out: StationTime[] = [];
  for (const v of cell.visits) {
    const column = columnOf(v.station);
    if (column === null || v.interrupted) continue;
    const rework = seen.has(column);
    seen.add(column);
    const basis: StationTime["basis"] = v.leftAt === null ? "so-far" : v.unclosed ? "at-most" : "measured";
    out.push({ column, ms: visitMs(v, now), basis, rework, round: v.round });
  }
  return out;
}

/** The judging rounds started: the highest round any verification or review began. */
export function roundsUsed(cell: CellState): number {
  let n = 0;
  for (const v of cell.verifications) n = Math.max(n, v.round);
  for (const r of cell.reviews) n = Math.max(n, r.round);
  return n;
}

/** The recorded spend of an execution, or null (never 0 for "not recorded"). */
function executionCost(x: ExecutionState): { usd: number; partial: boolean } | null {
  if (x.usage && x.usage.costUsd !== null) return { usd: x.usage.costUsd, partial: costCompletenessOf(x).complete === false };
  if (x.outcome && isKnown(x.meta, "costUsd")) return { usd: x.outcome.costUsd, partial: false };
  return null;
}

/** The ticket's recorded spend across its executions. */
export function ticketCost(scene: Scene, ticketId: string): LineRow["cost"] {
  let usd = 0;
  let recorded = 0;
  let total = 0;
  let partial = false;
  for (const x of Object.values(scene.executions)) {
    if (x.ticketId !== ticketId) continue;
    total += 1;
    const c = executionCost(x);
    if (!c) continue;
    recorded += 1;
    usd += c.usd;
    partial ||= c.partial;
  }
  if (!recorded) return null;
  return { usd, partial: partial || recorded < total };
}

/** The visits sent back to Build (a revision), and the judging station that sent the last one. */
function sentBackOf(cell: CellState): LineRow["sentBack"] {
  let builds = 0;
  let from: number | null = null;
  let last: number | null = null;
  for (const v of cell.visits) {
    const c = columnOf(v.station);
    if (c === null) continue;
    if (c === BUILD) {
      builds += 1;
      if (builds > 1 && last !== null && last > BUILD) from = last;
    }
    last = c;
  }
  return builds > 1 && from !== null ? { from, to: BUILD, times: builds - 1 } : null;
}

/** The last judging outcome before the open build visit (a revision), in words. */
function revisionWhy(cell: CellState): string | null {
  const reviews = cell.reviews.filter((r) => r.outcome !== null);
  const verifications = cell.verifications.filter((v) => v.status !== "running");
  const lastReview = reviews.at(-1) ?? null;
  const lastVerify = verifications.at(-1) ?? null;
  const reviewAt = lastReview?.decidedAt ?? -1;
  const verifyAt = lastVerify?.decidedAt ?? -1;
  if (lastReview?.humanSentBack && reviewAt >= verifyAt) return `A person sent it back in round ${lastReview.round}. The builder is working on their reason.`;
  if (lastReview && lastReview.outcome === "REJECTED" && reviewAt >= verifyAt) {
    const blockers = lastReview.findings.filter((f) => f.severity === "blocker" && !f.outvoted).length;
    return `Review rejected round ${lastReview.round}${blockers ? ` with ${blockers} blocking finding${blockers === 1 ? "" : "s"}` : ""}. The builder is fixing what it found.`;
  }
  if (lastVerify && lastVerify.status !== "PASS") return `Verification failed in round ${lastVerify.round}. The builder is fixing what it found.`;
  return null;
}

function openVisit(cell: CellState): StationVisit | null {
  for (let i = cell.visits.length - 1; i >= 0; i--) {
    const v = cell.visits[i] as StationVisit;
    if (v.leftAt === null && !v.unclosed) return v;
  }
  return null;
}

function passedColumns(cell: CellState, before: number): number[] {
  const done = new Set<number>();
  for (const v of cell.visits) {
    const c = columnOf(v.station);
    if (c !== null && c < before && v.leftAt !== null) done.add(c);
  }
  return [...done].sort((a, b) => a - b);
}

/** What the marker says beside the state while work is open, from what the station recorded. */
function workingDetail(cell: CellState, column: number): string | null {
  if (column === BUILD) {
    // The task being worked on: the first one not done, numbered in plan order. Its total only when the plan recorded one.
    const at = cell.tasks.findIndex((t) => t.doneAt === null);
    if (at < 0) return null;
    const total = cell.plan?.tasks ?? null;
    return total ? `task ${at + 1} of ${total}` : `task ${at + 1}`;
  }
  if (column === VERIFY) {
    const v = cell.verifications.at(-1);
    if (!v || !v.checks.length) return null;
    return `${v.checks.filter((c) => c.result !== "pending").length} of ${v.checks.length} checks`;
  }
  if (column === REVIEW) {
    const r = cell.reviews.at(-1);
    if (!r || !r.seats.length) return null;
    return `${r.seats.filter((s) => s.vote !== null).length} of ${r.seats.length} votes`;
  }
  return null;
}

/** The column a ticket waits at when nothing is open, from its recorded stage (run.py's next step). */
function waitingColumn(cell: CellState): number {
  switch (cell.stage) {
    case "interview":
    case "spec-open":
      return GROOM;
    case "spec-ready":
      return PLAN;
    case "planned":
    case "building":
      return BUILD;
    case "built": {
      const lastJudge = [...cell.visits].reverse().find((v) => v.station === "verify" || v.station === "review" || v.station === "merge");
      const lastBuild = [...cell.visits].reverse().find((v) => v.station === "build");
      // Judged after the last build and not passed: back to Build; otherwise on to Verify.
      return lastJudge && lastBuild && lastJudge.enteredAt > lastBuild.enteredAt && lastJudge.outcome !== "passed" ? BUILD : VERIFY;
    }
    case "verified":
    case "awaiting-human":
      return REVIEW;
    case "approved":
    case "pr-open":
      return MERGE;
    case "merged":
      return CLEANUP;
    case "blocked": {
      const last = [...cell.visits].reverse().find((v) => columnOf(v.station) !== null);
      return columnOf(last?.station) ?? BUILD;
    }
  }
}

const command = (verb: "decide" | "explain", ticketId: string) => `/mach ${verb} ${ticketId}`;

/** A row's epic and issue, from its slice: what is recorded, else null. */
function epicOf(slice: SliceState | undefined): Pick<LineRow, "epicId" | "epicTitle" | "issue"> {
  return { epicId: slice?.epicId ?? null, epicTitle: slice?.epicTitle?.trim() ? slice.epicTitle : null, issue: slice?.issue ?? null };
}

/**
 * The review round a review visit sat: the k-th review visit of a judging round sat the k-th entry for
 * it, so a repeat (round-N.k, M13) is its own visit with its own findings and decision.
 */
export function reviewOfVisit(cell: Pick<CellState, "visits" | "reviews">, v: StationVisit): CellState["reviews"][number] | null {
  const nth = cell.visits.filter((x) => x.station === "review" && x.round === v.round && x.enteredAt < v.enteredAt).length;
  return cell.reviews.filter((r) => r.round === v.round)[nth] ?? cell.reviews.find((r) => r.round === v.round) ?? null;
}

/** "round 1", or "round 1, repeat 1 (no judging round used)" for a repeat review round. */
export function visitRoundWords(cell: Pick<CellState, "visits" | "reviews"> | null, v: StationVisit): string {
  const repeat = cell && v.station === "review" ? (reviewOfVisit(cell, v)?.repeat ?? 0) : 0;
  return repeat > 0 ? `round ${v.round}, repeat ${repeat} (no judging round used)` : `round ${v.round}`;
}

/** The verb a "Needs you" item starts with: what the person must do (style guide 8.8). */
export function needVerb(row: Pick<LineRow, "state" | "beforeMerge" | "stop">): string {
  if (row.state === "stopped") return "Unblock";
  if (row.beforeMerge) return "Approve or send back";
  switch (row.stop) {
    case "main-conflict":
      return "Resolve the conflict with main on";
    case "policy-owner":
      return "Ask the policy's owner about";
    case "waiting-mocks":
      return "Commit the design mocks for";
    default:
      return "Decide on";
  }
}

/** The accept command for a policy concern, as the run skill routes it (M14 part A). The POL id and the owner's words are the person's to fill in. */
export const policyAcceptCommand = (ticketId: string): string => `/mach policy accept ${ticketId} <POL-id> "<the owner's words>"`;

/** What M13 and M14 put on a row besides its state: the Jira key, the change record, the rechecks. */
function m15Facts(cell: CellState, slice: SliceState | undefined): Pick<LineRow, "jira" | "changeRecord" | "rechecks"> {
  return { jira: cell.jira ?? slice?.jira ?? null, changeRecord: cell.changeRecord?.path ?? null, rechecks: recheckCount(cell) };
}

/** One cell as a row of the Line. */
export function rowOfCell(scene: Scene, cell: CellState, now: number): LineRow {
  const slice = scene.slices[cell.sliceId];
  const title = cell.title.trim() && cell.title !== cell.ticketId ? cell.title : null;
  const attention = scene.supervisor.attention[cell.ticketId] ?? (cell.sliceId ? scene.supervisor.attention[cell.sliceId] : undefined) ?? null;
  const parked = [...Object.values(scene.executions)].filter((x) => x.ticketId === cell.ticketId && x.notProgressing).at(-1) ?? null;
  const base = {
    ticketId: cell.ticketId,
    sliceId: cell.sliceId || null,
    title,
    ...epicOf(slice),
    risk: cell.meta.unknown.includes("risk") ? null : cell.risk,
    times: stationTimes(cell, now),
    roundsUsed: roundsUsed(cell),
    cost: ticketCost(scene, cell.ticketId),
    openedAt: cell.openedAt,
    sentBack: sentBackOf(cell),
    personWords: null as string | null,
    ...m15Facts(cell, slice),
  };
  const landed = cell.merged !== null || cell.stage === "merged" || cell.runRecord?.outcome === "merged";

  if (landed) {
    const cleaned = cell.archived !== null || cell.visits.some((v) => v.station === "cleanup" && v.leftAt !== null);
    const column = cleaned ? CLEANUP : MERGE;
    return {
      ...base,
      state: "landed",
      column,
      beforeMerge: false,
      passed: passedColumns(cell, column),
      detail: null,
      since: cell.merged?.at ?? cell.runRecord?.at ?? null,
      held: null,
      why: cleaned ? "Merged and cleaned up. Its record is in the archive." : "Merged. Clean-up has not finished yet.",
      needs: "Nothing.",
      command: command("explain", cell.ticketId),
    };
  }

  if (cell.stage === "blocked" || parked) {
    const column = waitingColumn({ ...cell, stage: "blocked" });
    const lastReview = cell.reviews.at(-1);
    const why = parked
      ? `${parkedWords(parked.notProgressing)}.`
      : lastReview?.outcome === "ESCALATE"
        ? `Review rejected it in round ${lastReview.round}, the last of ${MAX_ROUNDS}. The line has stopped work on it.`
        : `It used its ${MAX_ROUNDS} judging rounds without passing. The line has stopped work on it.`;
    return {
      ...base,
      state: "stopped",
      column,
      beforeMerge: false,
      passed: passedColumns(cell, column),
      detail: null,
      since: attention?.at ?? [...cell.stageHistory].reverse().find((h) => h.stage === "blocked")?.at ?? null,
      held: null,
      why,
      needs: "Read why, then re-plan it, fix it by hand, or abandon it.",
      command: command("decide", cell.ticketId),
    };
  }

  const open = openVisit(cell);
  // M15: the waits M13 and M14 added, each with its own reason (never the generic "a person is needed").
  const stop = open ? null : cellStopOf(scene, cell);
  if (stop?.kind === "main-conflict") {
    return {
      ...base,
      stop: stop.kind,
      personWords: stop.basis === "supervisor" ? (attention?.reason ?? null) : null,
      state: "person",
      column: BUILD,
      beforeMerge: false,
      passed: passedColumns(cell, BUILD),
      detail: "conflict with main",
      since: stop.since,
      held: null,
      why: "Bringing its branch up to date with the main branch conflicts. The build station changed nothing and waits for a person to resolve it.",
      needs: "Merge the main branch into the ticket's branch in its cell and resolve the conflict; the build then carries on. Or plan it again, or abandon it.",
      command: command("decide", cell.ticketId),
      alsoCommand: command("explain", cell.ticketId),
    };
  }
  if (stop?.kind === "policy-owner") {
    return {
      ...base,
      stop: stop.kind,
      personWords: stop.basis === "supervisor" ? (attention?.reason ?? null) : null,
      state: "person",
      column: GROOM,
      beforeMerge: false,
      passed: [],
      detail: "policy owner",
      since: stop.since,
      held: null,
      why: "The spec is held only by a policy concern: a statement of a policy pack it cannot meet. Only the policy's owner settles it.",
      needs: "The policy's owner accepts the concern in their own words, or the spec changes so the policy is met.",
      command: policyAcceptCommand(cell.ticketId),
      alsoCommand: command("explain", cell.ticketId),
    };
  }
  if (stop?.kind === "merge-recheck") {
    const held: HeldReason = { kind: "recheck", words: "Work that landed on the main branch after approval touches the same ground, so the approval did not carry over. It is verified and reviewed again on the merged result; this uses no judging round." };
    return {
      ...base,
      stop: stop.kind,
      sentBack: { from: MERGE, to: VERIFY, times: stop.times },
      state: "held",
      column: VERIFY,
      beforeMerge: false,
      passed: passedColumns(cell, VERIFY),
      detail: "verify again",
      since: stop.since,
      held,
      why: held.words,
      needs: "Nothing. It moves on by itself.",
      command: command("explain", cell.ticketId),
    };
  }
  const waitingApproval = cell.stage === "awaiting-human" || open?.station === "human-approval";
  if (waitingApproval || cell.stage === "spec-open" || attention) {
    if (waitingApproval) {
      const r = cell.reviews.at(-1);
      const votes = r && r.approvals !== null ? `${r.approvals} of ${r.seats.length} reviewers approved` : "Review approved it";
      return {
        ...base,
        state: "person",
        column: REVIEW,
        beforeMerge: true,
        passed: passedColumns(cell, REVIEW + 1),
        detail: "your approval",
        since: open?.station === "human-approval" ? open.enteredAt : (r?.decidedAt ?? attention?.at ?? null),
        held: null,
        why: `${votes}${r ? ` in round ${r.round}` : ""}. Its risk needs a person's approval before it merges.`,
        needs: "Approve it, or send it back with your reason.",
        command: command("decide", cell.ticketId),
      };
    }
    if (cell.stage === "spec-open") {
      return {
        ...base,
        state: "person",
        column: GROOM,
        beforeMerge: false,
        passed: [],
        detail: "open questions",
        since: [...cell.stageHistory].reverse().find((h) => h.stage === "spec-open")?.at ?? null,
        held: null,
        why: "The spec still has open questions only the product owner can answer.",
        needs: "Answer the open questions; the interview goes on with you.",
        command: `/mach ${cell.ticketId}`,
      };
    }
    const column = open ? (columnOf(open.station) ?? waitingColumn(cell)) : waitingColumn(cell);
    return {
      ...base,
      personWords: attention?.reason ?? null,
      state: "person",
      column,
      beforeMerge: false,
      passed: passedColumns(cell, column),
      detail: null,
      since: attention?.at ?? null,
      held: null,
      why: "The line recorded that a person is needed before it can go on.",
      needs: "Decide what happens next.",
      command: command("decide", cell.ticketId),
    };
  }

  if (open) {
    const column = columnOf(open.station) ?? waitingColumn(cell);
    const revision = column === BUILD && cell.visits.filter((v) => v.station === "build").length > 1 ? revisionWhy(cell) : null;
    return {
      ...base,
      state: "working",
      column,
      beforeMerge: false,
      passed: passedColumns(cell, column),
      detail: workingDetail(cell, column),
      since: open.enteredAt,
      held: null,
      why: revision ?? `${(LINE_STATIONS[column] as LineStation).worker} at work. ${(LINE_STATIONS[column] as LineStation).does}`,
      needs: revision && cell.round >= MAX_ROUNDS ? `Nothing yet. This is round ${cell.round}, the last: another rejection stops the ticket for you.` : "Nothing. It moves on by itself.",
      command: command("explain", cell.ticketId),
    };
  }

  const column = waitingColumn(cell);
  const wait = capacityWaitOf(scene, cell.ticketId) ?? (cell.capacityWait ? { since: cell.capacityWait.since, limit: cell.capacityWait.limit } : null);
  const blocking = slice ? slice.dependsOn.filter((d) => scene.dependencies[`${slice.id}->${d}`]?.state === "blocking") : [];
  const held: HeldReason = wait
    ? { kind: "capacity", words: `Waiting for a free place to work${wait.limit !== null ? ` (at most ${wait.limit} at once)` : ""}.` }
    : blocking.length
      ? { kind: "dependency", words: `Waits for ${blocking.join(", ")} to be merged first.` }
      : { kind: "next", words: `Next: ${(LINE_STATIONS[column] as LineStation).name}. Its last step finished; the next has not started yet.` };
  return {
    ...base,
    state: "held",
    column,
    beforeMerge: false,
    passed: passedColumns(cell, column),
    detail: held.kind === "next" ? `next: ${(LINE_STATIONS[column] as LineStation).name.toLowerCase()}` : held.kind === "capacity" ? "no free place" : "waits on another",
    since: wait?.since ?? cell.visits.at(-1)?.leftAt ?? cell.stationSince ?? null,
    held,
    why: held.words,
    needs: "Nothing. It moves on when the line takes it up.",
    command: command("explain", cell.ticketId),
  };
}

/** A slice with a ticket and no cell yet (approved, not dispatched): held before Plan, with its recorded reason. */
export function rowOfSlice(scene: Scene, slice: SliceState): LineRow {
  const hold = holdOf(scene.supervisor.holds, slice);
  const blocking = slice.dependsOn.filter((d) => scene.dependencies[`${slice.id}->${d}`]?.state === "blocking");
  const held: HeldReason = blocking.length
    ? { kind: "dependency", words: `Waits for ${blocking.join(", ")} to be merged first.` }
    : hold
      ? { kind: "supervisor", words: "The supervisor holds it. Its recorded words:", freeText: hold.why }
      : { kind: "next", words: "Approved and taken in; its cell is not open yet." };
  return {
    ticketId: slice.ticketId,
    sliceId: slice.id,
    title: slice.title.trim() && slice.title !== slice.id ? slice.title : null,
    ...epicOf(slice),
    risk: slice.meta.unknown.includes("risk") ? null : slice.risk,
    state: "held",
    column: PLAN,
    beforeMerge: false,
    passed: [],
    detail: held.kind === "dependency" ? "waits on another" : held.kind === "supervisor" ? "held" : "not started",
    since: hold?.since ?? slice.since,
    sentBack: null,
    held,
    why: held.words,
    personWords: null,
    needs: "Nothing. It starts when the supervisor or an engineer dispatches it.",
    command: command("explain", slice.ticketId),
    times: [],
    roundsUsed: 0,
    cost: null,
    openedAt: slice.since,
  };
}

/**
 * M15: a slice issue intake holds until its approved design mocks are committed (M14 part C). It has no
 * cell and no ticket yet; its row is named by its slice, before Plan, and waits for a person.
 */
export function rowOfMockWait(wait: MockWait): LineRow {
  return {
    ticketId: wait.sliceId,
    sliceId: wait.sliceId,
    title: null,
    epicId: null,
    epicTitle: null,
    issue: wait.issue,
    risk: null,
    state: "person",
    column: PLAN,
    beforeMerge: false,
    passed: [],
    detail: "waits for mocks",
    since: wait.since,
    sentBack: null,
    held: null,
    why: "Intake holds this slice: its approved design mocks are not on the main branch yet, so it is not taken in. Intake's words:",
    personWords: wait.reason,
    needs: `Commit the approved pictures Product Studio wrote to product/ready/${wait.sliceId}/mocks/ on the main branch; the next intake takes the slice in.`,
    command: "/mach product status",
    alsoCommand: "/mach pull --dry-run",
    stop: "waiting-mocks",
    times: [],
    roundsUsed: 0,
    cost: null,
    openedAt: wait.since,
  };
}

export interface LineModel {
  /** Rows in the order they entered the line; landed ones after the rest, the newest few only. */
  readonly rows: readonly LineRow[];
  /** Landed tickets not shown as rows (only the newest LANDED_SHOWN are). */
  readonly landedHidden: number;
  /** Tickets waiting for a person or stopped, longest waiting first. */
  readonly needs: readonly LineRow[];
}

/** How many landed tickets keep a row. */
export const LANDED_SHOWN = 5;

export function lineModel(scene: Scene, now: number): LineModel {
  const rows: LineRow[] = [];
  const withCell = new Set<string>();
  for (const cell of Object.values(scene.cells)) {
    withCell.add(cell.ticketId);
    rows.push(rowOfCell(scene, cell, now));
  }
  for (const slice of Object.values(scene.slices)) {
    if (!slice.ticketId || withCell.has(slice.ticketId) || slice.scheduler === "integrated" || slice.scheduler === "dispatched") continue;
    rows.push(rowOfSlice(scene, slice));
  }
  for (const wait of mockWaitsOf(scene)) rows.push(rowOfMockWait(wait));
  const byOpen = (a: LineRow, b: LineRow) => a.openedAt - b.openedAt || (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0);
  const active = rows.filter((r) => r.state !== "landed").sort(byOpen);
  const landed = rows.filter((r) => r.state === "landed").sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
  const needs = active.filter((r) => r.state === "person" || r.state === "stopped").sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
  return { rows: [...active, ...landed.slice(0, LANDED_SHOWN).sort(byOpen)], landedHidden: Math.max(0, landed.length - LANDED_SHOWN), needs };
}

// ---------------------------------------------------------------- one station

export interface StationStat {
  readonly column: number;
  /** Tickets at work here now. */
  readonly atWork: number;
  /** The median length of the finished, measured visits held, and how many there were. */
  readonly typicalMs: number | null;
  readonly sample: number;
  /** Judging stations: visits whose outcome sent the work back, of those decided. Null for the others. */
  readonly sentBack: { readonly back: number; readonly of: number } | null;
  /** The models recorded for agents that worked here (their recorded names), most seen first. */
  readonly models: readonly string[];
}

const JUDGING = new Set([VERIFY, REVIEW, MERGE]);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function stationStats(scene: Scene, rows: readonly LineRow[]): StationStat[] {
  return LINE_STATIONS.map((_, column) => {
    const lengths: number[] = [];
    let back = 0;
    let of = 0;
    const models = new Map<string, number>();
    for (const cell of Object.values(scene.cells)) {
      for (const v of cell.visits) {
        if (columnOf(v.station) !== column || v.station === "human-approval") continue;
        if (v.leftAt !== null && !v.unclosed && !v.interrupted) lengths.push(v.durationMs ?? v.leftAt - v.enteredAt);
        if (JUDGING.has(column) && v.leftAt !== null && v.outcome !== null && !v.unclosed) {
          of += 1;
          // M15: the merge-time recheck sends work back too (to Verify), though it is no rejection.
          if (v.outcome === "failed" || v.outcome === "rejected" || v.outcomeWord === "landed-overlap") back += 1;
        }
      }
      for (const a of Object.values(cell.agents)) {
        if (columnOf(a.station) !== column) continue;
        // The model as recorded; the simulation's agents carry its own (simulated) model.
        const name = a.modelName ?? (a.meta.authority === "simulated" ? MODELS[a.model].name : null);
        if (name) models.set(name, (models.get(name) ?? 0) + 1);
      }
    }
    return {
      column,
      atWork: rows.filter((r) => r.column === column && r.state === "working").length,
      typicalMs: median(lengths),
      sample: lengths.length,
      sentBack: JUDGING.has(column) ? { back, of } : null,
      models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m),
    };
  });
}

// ---------------------------------------------------------------- what just happened

/**
 * The newest significant moments at or before `now`, newest first. The simulation's index holds every
 * moment of its whole scenario, so a moment later than the clock is filtered out here (live, the log
 * holds only what has arrived and the clock never trails it, but the same rule holds). Nothing is
 * invented or moved: recorded moments are only filtered and ordered by their own time.
 */
export function feedOf(moments: readonly Moment[], now: number, limit = 12): readonly Moment[] {
  const past = moments.filter((m) => m.t <= now);
  // Ascending by t by contract; ordering by t (stable) keeps the feed right if a list ever is not.
  return past
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.t - b.m.t || a.i - b.i)
    .slice(-limit)
    .reverse()
    .map(({ m }) => m);
}

/** "1 in 6 sent back", "none sent back", or null when nothing was decided here. */
export function sentBackWords(s: StationStat["sentBack"]): string | null {
  if (!s || s.of === 0) return null;
  if (s.back === 0) return `none of ${s.of} sent back`;
  return `${s.back} of ${s.of} sent back`;
}
