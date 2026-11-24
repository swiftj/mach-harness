/**
 * Lanes (M22): a ticket's build in lanes, as the Line and its side panel show it. Pure: no React, no
 * window (test/m22-lanes.test.mjs).
 *
 * Two sources, both recorded: the observer's reply (`GET /api/v1/cells/{ticket}` `lanes`, read from
 * the cell's build.json, each lane's lane.json and build-report.json), and the ticket's events in the
 * scene (a task built in a lane names its lane, event revision 9). The reply says what each lane is
 * given and how far it got when it was read; an event that arrived since then moves a lane on at
 * once, before the reply is read again. Nothing is invented: a lane whose record could not be read
 * says so, and a time no record gives is "not recorded".
 *
 * Words: "lane" is the product's word (docs/mach-next/M22_PARALLEL_BUILD.md section 3): a chain of
 * plan tasks one builder builds in its own worktree; "the join" brings the lanes together; a lane
 * "set aside" is not landed, and its tasks are built again in the cell, one at a time; a lane
 * "handed back" gives its remaining tasks to the cell, which builds them one at a time after the join.
 * A builder's own words (a hand-back's reason, a command and why it changed) are never in the reply.
 */
import type { CellState } from "../sim";
import { utcClock } from "../shell/time";
import { LINE_STATIONS, type LineRow } from "./model";

const BUILD = LINE_STATIONS.findIndex((s) => s.key === "build");

// ---------------------------------------------------------------- the reply, read tolerantly

export type FileReadState = "read" | "absent" | "unreadable";
export interface FileRead {
  readonly read: FileReadState;
  /** The observer's own words for why, never the file's. */
  readonly why: string | null;
}

export interface LaneRecord {
  readonly lane: string;
  readonly tasks: readonly string[];
  readonly status: "planned" | "open" | "done" | "joined" | "set-aside" | "sequential" | "handed-back" | null;
  /** "free-place": not handed out yet while other lanes are open; it waits for a builder's place. */
  readonly waiting: "free-place" | null;
  readonly record: FileRead;
  readonly handedAt: number | null;
  readonly startedAt: number | null;
  readonly lastStepAt: number | null;
  readonly finishedAt: number | null;
  /** Tasks done in the lane; null when its record could not be read. */
  readonly done: number | null;
  readonly total: number;
  readonly current: string | null;
  /** A lane handed back to the cell: its tasks finished and not then, and after the join those built in the cell. */
  readonly handedBack: { readonly at: number | null; readonly finished: readonly string[]; readonly unfinished: readonly string[]; readonly builtInCell: readonly string[] } | null;
  /** Each time the lane was made fresh (its folder, branch or record belonged to another build), with where its earlier work is kept. */
  readonly madeFresh: readonly { readonly at: number | null; readonly ref: string | null; readonly stateFileKept: boolean }[];
  /** Its tasks whose interrupted step the station recovered: their commit was found and recorded. */
  readonly recovered: readonly { readonly task: string; readonly at: number | null; readonly commit: string | null }[];
}

export interface LaneTask {
  readonly task: string;
  readonly kind: string | null;
  /** "commands": a task added when a changed test or lint command left the suite or the linter failing (C-T01). */
  readonly part: "before" | "lane" | "after" | "join" | "commands" | null;
  readonly lane: string | null;
  readonly status: string | null;
  readonly setAside: boolean;
  /** A task of a lane handed back unfinished: built in the cell after the join. */
  readonly handedBack: boolean;
  /** Its step was interrupted; the station found its commit and recorded it afterwards. */
  readonly recovered: { readonly at: number | null; readonly commit: string | null } | null;
  /** The task's commit on the ticket's branch (for a lane task: the landed copy). */
  readonly commit: string | null;
  /** The commit its lane made; it no longer exists once landed. */
  readonly laneCommit: string | null;
  readonly at: number | null;
  readonly testSeconds: number | null;
}

export interface CommitLink {
  readonly laneCommit: string;
  readonly task: string;
  readonly lane: string;
  readonly state: "landed" | "set-aside" | "not-joined";
  readonly landed: string | null;
}

export interface JoinRecord {
  readonly status: "JOINED" | "INTERACTION" | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly tip: string | null;
  readonly landed: number;
  readonly suitePassed: boolean | null;
  readonly suiteSeconds: number | null;
  readonly landingSeconds: number | null;
  readonly setAside: readonly SetAsideLane[];
  readonly interaction: { readonly failing: number; readonly lanesNamed: readonly string[]; readonly task: string | null } | null;
  /** The ticket's branch moved while the lanes were open: they landed on its new head, on top of these commits. */
  readonly movedBranch: { readonly from: string | null; readonly to: string | null; readonly commits: readonly string[]; readonly files: number } | null;
}

/** Why the join set a lane aside (build.py join_record, landing.py). */
export const ASIDE_WHYS = ["same-file", "frozen-test", "case-clash", "file-folder", "branch-moved", "did-not-apply", "unrecorded-commits", "lane-history"] as const;
export type AsideWhy = (typeof ASIDE_WHYS)[number];

export interface SetAsideLane {
  readonly lane: string;
  readonly tasks: readonly string[];
  readonly because: readonly { readonly other: string | null; readonly why: AsideWhy | null; readonly commits: number | null; readonly commit: string | null }[];
  /** The ref its commits are kept under, so nothing is lost; null when none was recorded. */
  readonly keptAs: string | null;
}

/** A recorded deviation about the lanes, a changed command or a recovered step: its type and what it names (never its words). */
export interface LaneDeviation {
  readonly type: string;
  readonly lane: string | null;
  readonly task: string | null;
  readonly at: number | null;
  readonly ref: string | null;
  readonly commit: string | null;
}

/** One change of the build's test or lint command: which and when. The commands and the reason are not served. */
export interface CommandChange {
  readonly at: number | null;
  readonly commands: readonly ("test" | "lint")[];
  readonly loop: number | null;
}

export interface ReportTiming {
  readonly elapsedSeconds: number | null;
  readonly steps: readonly { readonly task: string; readonly lane: string | null; readonly seconds: number | null; readonly testSeconds: number | null }[];
  readonly wallSeconds: number | null;
  readonly summedSeconds: number | null;
  readonly ratio: number | null;
  readonly lanes: readonly { readonly lane: string; readonly elapsedSeconds: number | null }[];
}

export interface LanesGate {
  /** build.lanes-open, build.hand-back, build.join, or another build gate about one lane (a step recovered in it). */
  readonly gate: string;
  readonly verdict: string;
  readonly reasonCode: string | null;
  readonly lane: string | null;
  readonly at: number | null;
}

export interface LanesReply {
  readonly state: "planned" | "open" | "sequential" | "joined" | "unreadable";
  readonly source: "cell" | "archive" | null;
  readonly buildJson: FileRead;
  readonly buildReport: FileRead;
  readonly setting: number | null;
  readonly openedAt: number | null;
  /** When the build started (build.json `started_at`): the first task before the lanes is timed from it. */
  readonly buildStartedAt: number | null;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly lanes: readonly LaneRecord[];
  readonly join: JoinRecord | null;
  readonly refusals: readonly { readonly at: number | null; readonly reasonCode: string | null }[];
  /** When the latest join started, as the build station recorded it at that moment; null before any join started. */
  readonly joinStartedAt: number | null;
  /**
   * A join that started and has no result yet: "running" (its process is alive), "interrupted" (its process is gone: it never
   * finished and can be run again) or "unknown" (the observer cannot tell from here); null when no join is under way.
   */
  readonly joining: "running" | "interrupted" | "unknown" | null;
  readonly tasks: readonly LaneTask[];
  readonly commits: readonly CommitLink[];
  readonly report: ReportTiming | null;
  readonly gates: readonly LanesGate[];
  /** Built one task at a time after all because too few builders' places were free, or because the suite was not passing ("red" or "unknown") where the lanes would open. */
  readonly sequentialBecause: "free-places" | "suite" | null;
  readonly sequentialSuite: "red" | "unknown" | null;
  readonly deviations: readonly LaneDeviation[];
  readonly commandChanges: readonly CommandChange[];
}

const LANE_RE = /^L[1-9]\d{0,2}$/;
/** T01; R1-T01 (a revision round's); J-T01 (the join's); C-T01 (added when a changed command left the suite or the linter failing). */
const TASK_RE = /^(?:(?:R\d+|J|C)-)?T\d{1,5}$/;
const KEPT_REF_RE = /^refs\/mach\/(?:lanes-set-aside|lane-files)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/L[1-9]\d{0,2}\/[1-9]\d{0,5}$/;
const DEVIATION_TYPES = [
  "lanes-sequential", "lane-files-set-aside", "lane-handed-back", "lane-handed-back-joined", "lane-set-aside", "lanes-interaction",
  "test-command-set", "lint-command-set", "step-recovered", "lane-made-fresh", "lane-worktree-remade", "lanes-landed-on-moved-branch",
] as const;
const COMMIT_RE = /^[0-9a-f]{7,64}$/;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

type Obj = Readonly<Record<string, unknown>>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const laneId = (v: unknown): string | null => (typeof v === "string" && LANE_RE.test(v) ? v : null);
const taskId = (v: unknown): string | null => (typeof v === "string" && TASK_RE.test(v) ? v : null);
const commit = (v: unknown): string | null => (typeof v === "string" && COMMIT_RE.test(v) ? v : null);
const code = (v: unknown): string | null => (typeof v === "string" && CODE_RE.test(v) ? v : null);
const keptRef = (v: unknown): string | null => (typeof v === "string" && KEPT_REF_RE.test(v) ? v : null);
const secs = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const whole = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const time = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}
const ids = (v: unknown, read: (x: unknown) => string | null): string[] => arr(v).map(read).filter((x): x is string => x !== null);
function fileRead(v: unknown): FileRead {
  const o = obj(v);
  return { read: oneOf(o.read, ["read", "absent", "unreadable"] as const) ?? "unreadable", why: typeof o.why === "string" ? o.why.slice(0, 120) : null };
}

/** The observer's `lanes`, or null when the reply has none (a build not in lanes). */
export function readLanesReply(raw: unknown): LanesReply | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = obj(raw);
  const state = oneOf(d.state, ["planned", "open", "sequential", "joined", "unreadable"] as const) ?? "unreadable";
  const lanes: LaneRecord[] = [];
  for (const x of arr(d.lanes)) {
    const l = obj(x);
    const lane = laneId(l.lane);
    if (!lane) continue;
    const tasks = ids(l.tasks, taskId);
    lanes.push({
      lane,
      tasks,
      status: oneOf(l.status, ["planned", "open", "done", "joined", "set-aside", "sequential", "handed-back"] as const),
      waiting: oneOf(l.waiting, ["free-place"] as const),
      record: fileRead(l.record),
      handedAt: time(l.handed_at),
      startedAt: time(l.started_at),
      lastStepAt: time(l.last_step_at),
      finishedAt: time(l.finished_at),
      done: whole(l.done),
      total: whole(l.total) ?? tasks.length,
      current: taskId(l.current),
      handedBack:
        l.handed_back && typeof l.handed_back === "object"
          ? { at: time(obj(l.handed_back).at), finished: ids(obj(l.handed_back).finished_then, taskId), unfinished: ids(obj(l.handed_back).unfinished_then, taskId), builtInCell: ids(obj(l.handed_back).built_in_cell, taskId) }
          : null,
      madeFresh: arr(l.made_fresh).map((x) => ({ at: time(obj(x).at), ref: keptRef(obj(x).ref), stateFileKept: obj(x).state_file_kept === true })),
      recovered: arr(l.recovered).flatMap((x) => {
        const task = taskId(obj(x).task);
        return task ? [{ task, at: time(obj(x).at), commit: commit(obj(x).commit) }] : [];
      }),
    });
  }
  const j = d.join && typeof d.join === "object" ? obj(d.join) : null;
  const interaction = j?.interaction && typeof j.interaction === "object" ? obj(j.interaction) : null;
  const join: JoinRecord | null = j
    ? {
        status: oneOf(j.status, ["JOINED", "INTERACTION"] as const),
        startedAt: time(j.started_at),
        finishedAt: time(j.finished_at),
        tip: commit(j.tip),
        landed: whole(j.landed) ?? 0,
        suitePassed: typeof j.suite_passed === "boolean" ? j.suite_passed : null,
        suiteSeconds: secs(j.suite_seconds),
        landingSeconds: secs(j.landing_seconds),
        setAside: arr(j.set_aside).flatMap((x) => {
          const s = obj(x);
          const lane = laneId(s.lane);
          return lane
            ? [{
                lane,
                tasks: ids(s.tasks, taskId),
                because: arr(s.because).map((b) => ({ other: laneId(obj(b).other), why: oneOf(obj(b).why, ASIDE_WHYS), commits: whole(obj(b).commits), commit: commit(obj(b).commit) })),
                keptAs: keptRef(s.kept_as),
              }]
            : [];
        }),
        interaction: interaction ? { failing: whole(interaction.failing) ?? 0, lanesNamed: ids(interaction.lanes_named, laneId), task: taskId(interaction.task) } : null,
        movedBranch:
          j.moved_branch && typeof j.moved_branch === "object"
            ? { from: commit(obj(j.moved_branch).from), to: commit(obj(j.moved_branch).to), commits: ids(obj(j.moved_branch).commits, commit), files: whole(obj(j.moved_branch).files) ?? 0 }
            : null,
      }
    : null;
  const r = d.report_timing && typeof d.report_timing === "object" ? obj(d.report_timing) : null;
  return {
    state,
    source: oneOf(d.source, ["cell", "archive"] as const),
    buildJson: fileRead(d.build_json),
    buildReport: fileRead(d.build_report),
    setting: whole(d.setting),
    openedAt: time(d.opened_at),
    buildStartedAt: time(d.build_started_at),
    before: ids(d.before, taskId),
    after: ids(d.after, taskId),
    lanes,
    join,
    refusals: arr(d.join_refusals).map((x) => ({ at: time(obj(x).at), reasonCode: code(obj(x).reason_code) })),
    joinStartedAt: time(d.join_started_at),
    joining: oneOf(d.joining, ["running", "interrupted", "unknown"] as const),
    tasks: arr(d.tasks).flatMap((x) => {
      const t = obj(x);
      const task = taskId(t.task);
      return task
        ? [{
            task,
            kind: oneOf(t.kind, ["test", "impl", "contract", "refactor", "docs"] as const),
            part: oneOf(t.part, ["before", "lane", "after", "join", "commands"] as const),
            lane: laneId(t.lane),
            status: typeof t.status === "string" && /^[a-z][a-z-]{0,23}$/.test(t.status) ? t.status : null,
            setAside: t.set_aside === true,
            handedBack: t.handed_back === true,
            recovered: t.recovered && typeof t.recovered === "object" ? { at: time(obj(t.recovered).at), commit: commit(obj(t.recovered).commit) } : null,
            commit: commit(t.commit),
            laneCommit: commit(t.lane_commit),
            at: time(t.at),
            testSeconds: secs(t.test_seconds),
          }]
        : [];
    }),
    commits: arr(d.commits).flatMap((x) => {
      const c = obj(x);
      const laneCommit = commit(c.lane_commit);
      const task = taskId(c.task);
      const lane = laneId(c.lane);
      const state = oneOf(c.state, ["landed", "set-aside", "not-joined"] as const);
      return laneCommit && task && lane && state ? [{ laneCommit, task, lane, state, landed: commit(c.landed_commit) }] : [];
    }),
    report: r
      ? {
          elapsedSeconds: secs(r.elapsed_seconds),
          steps: arr(r.steps).flatMap((x) => {
            const s = obj(x);
            const task = taskId(s.task);
            return task ? [{ task, lane: laneId(s.lane), seconds: secs(s.seconds), testSeconds: secs(s.test_seconds) }] : [];
          }),
          wallSeconds: secs(r.lanes_wall_seconds),
          summedSeconds: secs(r.lanes_summed_seconds),
          ratio: secs(r.lanes_ratio),
          lanes: arr(r.lanes).flatMap((x) => {
            const l = laneId(obj(x).lane);
            return l ? [{ lane: l, elapsedSeconds: secs(obj(x).elapsed_seconds) }] : [];
          }),
        }
      : null,
    gates: arr(d.gates).flatMap((x) => {
      const g = obj(x);
      const gate = typeof g.gate === "string" && /^build\.[a-z][a-z-]{0,40}$/.test(g.gate) ? g.gate : null;
      const at = obj(g.at);
      return gate ? [{ gate, verdict: typeof g.verdict === "string" ? g.verdict : "unknown", reasonCode: code(g.reason_code), lane: laneId(g.lane), at: time(at.at) }] : [];
    }),
    sequentialBecause: oneOf(d.sequential_because, ["free-places", "suite"] as const),
    sequentialSuite: oneOf(d.sequential_suite, ["red", "unknown"] as const),
    deviations: arr(d.deviations).flatMap((x) => {
      const v = obj(x);
      const type = oneOf(v.type, DEVIATION_TYPES);
      return type ? [{ type, lane: laneId(v.lane), task: taskId(v.task), at: time(v.at), ref: keptRef(v.ref), commit: commit(v.commit) }] : [];
    }),
    commandChanges: readCommandChanges(d.command_changes),
  };
}

/** The observer's `command_changes` (which command changed, and when); empty when there are none. */
export function readCommandChanges(raw: unknown): readonly CommandChange[] {
  return arr(raw).flatMap((x) => {
    const c = obj(x);
    const commands = arr(c.commands)
      .map((k) => oneOf(k, ["test", "lint"] as const))
      .filter((k): k is "test" | "lint" => k !== null);
    return commands.length ? [{ at: time(c.at), commands, loop: whole(c.loop) }] : [];
  });
}

/** What the observer says of one ticket's build: its lanes (null for a build not in lanes) and its changed commands. */
export interface CellBuild {
  readonly lanes: LanesReply | null;
  readonly commands: readonly CommandChange[];
}

/** The client's reply for a ticket (`{ lanes, command_changes }` of `/cells/{ticket}`). */
export function readCellBuild(raw: unknown): CellBuild {
  const d = obj(raw);
  return { lanes: readLanesReply(d.lanes), commands: readCommandChanges(d.command_changes) };
}

// ---------------------------------------------------------------- with the events since

/** The tasks the scene's events say are done in each lane (event revision 9). */
function doneByEvents(cell: Pick<CellState, "tasks"> | null): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of cell?.tasks ?? []) {
    if (!t.lane || t.doneAt === null) continue;
    const set = out.get(t.lane) ?? new Set<string>();
    set.add(t.id);
    out.set(t.lane, set);
  }
  return out;
}

/** Each lane as the reply has it, moved on by any task an event since says is done in it. */
export function lanesNow(reply: LanesReply, cell: Pick<CellState, "tasks"> | null): readonly LaneRecord[] {
  if (reply.state !== "open") return reply.lanes;
  const events = doneByEvents(cell);
  const doneInReply = new Set(reply.tasks.filter((t) => t.status === "done").map((t) => t.task));
  return reply.lanes.map((l) => {
    const seen = events.get(l.lane);
    if (!seen || l.done === null) return l;
    const done = l.tasks.filter((t) => doneInReply.has(t) || seen.has(t));
    if (done.length <= l.done) return l;
    const current = l.tasks.find((t) => !done.includes(t)) ?? null;
    return { ...l, done: done.length, current, status: current === null && l.status === "open" ? "done" : l.status, waiting: null };
  });
}

// ---------------------------------------------------------------- on the Line

export interface LaneChip {
  readonly lane: string;
  /** "L2: T07, 2 of 6 done". */
  readonly words: string;
  readonly tone: "working" | "held" | "done" | "fail" | "unknown";
}

export interface LaneLine {
  /** The words on the marker at Build ("3 lanes"), or null to keep the marker as it is. */
  readonly marker: string | null;
  readonly chips: readonly LaneChip[];
  /** The moment the lanes are at, when it is one of its own: every lane done and the join next; joined; a lane set aside; a failure only when joined. */
  readonly moment: { readonly words: string; readonly tone: "working" | "done" | "fail" | "held" } | null;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const isAre = (n: number): string => (n === 1 ? "is" : "are");
const wasWere = (n: number): string => (n === 1 ? "was" : "were");

/** The tasks done, by the reply or by an event since. */
function doneTasks(reply: LanesReply, cell: Pick<CellState, "tasks"> | null): ReadonlySet<string> {
  return new Set([...reply.tasks.filter((t) => t.status === "done").map((t) => t.task), ...(cell?.tasks ?? []).filter((t) => t.doneAt !== null).map((t) => t.id)]);
}

/** A handed-back lane's remaining tasks (those built in the cell after the join, or those unfinished when it was handed back), and whether every one is done. */
function handedBackRemaining(l: LaneRecord, done: ReadonlySet<string>): { readonly tasks: readonly string[]; readonly built: boolean } {
  const hb = l.handedBack;
  const tasks = hb ? (hb.builtInCell.length ? hb.builtInCell : hb.unfinished) : [];
  return { tasks, built: tasks.length > 0 && tasks.every((t) => done.has(t)) };
}

function chipOf(l: LaneRecord, aside: ReadonlySet<string>, doneIds: ReadonlySet<string>): LaneChip {
  if (aside.has(l.lane) || l.status === "set-aside") return { lane: l.lane, words: `${l.lane}: set aside`, tone: "fail" };
  if (l.status === "handed-back") {
    // A way on, not a failure: its remaining tasks wait for the cell, then are built there one at a time.
    const { tasks, built } = handedBackRemaining(l, doneIds);
    if (!tasks.length) return { lane: l.lane, words: `${l.lane}: handed back`, tone: "held" };
    return built
      ? { lane: l.lane, words: `${l.lane}: handed back, its ${plural(tasks.length, "remaining task")} ${wasWere(tasks.length)} built one at a time`, tone: "done" }
      : { lane: l.lane, words: `${l.lane}: handed back, its ${plural(tasks.length, "remaining task")} ${isAre(tasks.length)} built one at a time`, tone: "held" };
  }
  if (l.status === "joined") return { lane: l.lane, words: `${l.lane}: landed, ${l.total} of ${l.total} done`, tone: "done" };
  if (l.record.read === "unreadable" || (l.record.read === "absent" && l.done === null)) return { lane: l.lane, words: `${l.lane}: its record could not be read`, tone: "unknown" };
  if (l.waiting === "free-place") return { lane: l.lane, words: `${l.lane}: waiting for a free place`, tone: "held" };
  const done = l.done ?? 0;
  if (l.status === "done" || (l.total > 0 && done >= l.total)) return { lane: l.lane, words: `${l.lane}: done, ${l.total} of ${l.total}`, tone: "done" };
  if (l.status === "planned") return { lane: l.lane, words: `${l.lane}: not started, ${plural(l.total, "task")}`, tone: "held" };
  return { lane: l.lane, words: `${l.lane}: ${l.current ?? "next task not recorded"}, ${done} of ${l.total} done`, tone: "working" };
}

/** A join under way, from its recorded start: being joined, or one that never finished; null when none is under way. */
function joinUnderWay(reply: LanesReply): { readonly words: string; readonly summary: string; readonly tone: "working" | "held" } | null {
  if (reply.state !== "open" || reply.joining === null) return null;
  const since = reply.joinStartedAt === null ? null : `${utcClock(reply.joinStartedAt)} UTC`;
  if (reply.joining === "interrupted") {
    const words = `The join ${since ? `started at ${since} and ` : ""}did not finish; every lane's work is kept, and it can be run again.`;
    return { words, summary: words, tone: "held" };
  }
  const words = `The lanes are being joined${since ? `, since ${since}` : ""}.`;
  return {
    words,
    summary: `${words.slice(0, -1)}: their commits are landed on the ticket's branch, one per task in plan order, and the whole suite is run on the result.`,
    tone: "working",
  };
}

/** The last join that stopped and landed nothing, when no join has finished since: landing's own code. */
function stoppedJoin(reply: LanesReply): string | null {
  if (reply.state !== "open") return null;
  const last = reply.refusals.at(-1);
  return last ? (last.reasonCode ?? "no reason code recorded") : null;
}

/**
 * What the Line shows of a ticket's lanes: null for a build that is not in lanes (its row is exactly
 * as before), or one planned but not opened yet, or decided to be built one task at a time.
 */
export function laneLine(reply: LanesReply | null, cell: Pick<CellState, "tasks"> | null): LaneLine | null {
  if (!reply || reply.state === "planned" || reply.state === "sequential") return null;
  if (reply.state === "unreadable") return { marker: null, chips: [], moment: { words: "Built in lanes, but its build record could not be read.", tone: "held" } };
  const lanes = lanesNow(reply, cell);
  const aside = new Set((reply.join?.setAside ?? []).map((s) => s.lane));
  const done = doneTasks(reply, cell);
  const chips = lanes.map((l) => chipOf(l, aside, done));
  if (reply.state === "open") {
    const stopped = stoppedJoin(reply);
    const underWay = joinUnderWay(reply);
    // A lane handed back is ready for the join as a done one is: its finished tasks land, the rest are built in the cell after it.
    const allDone = lanes.length > 0 && lanes.every((l) => l.status === "done" || l.status === "handed-back" || (l.done !== null && l.done >= l.total));
    const moment = underWay
      ? { words: underWay.words, tone: underWay.tone }
      : stopped
      ? { words: `The join stopped and landed nothing (${stopped}); every lane's work is kept.`, tone: "fail" as const }
      : allDone
        ? { words: "Every lane is done: next, the lanes are joined.", tone: "working" as const }
        : null;
    return { marker: allDone ? "lanes done" : plural(lanes.length, "lane"), chips, moment };
  }
  // Joined.
  const join = reply.join;
  const setAside = join?.setAside ?? [];
  const parts: string[] = [];
  let tone: "done" | "fail" = "done";
  if (join?.interaction) {
    const fix = join.interaction.task ?? "a task";
    const fixDone = reply.tasks.find((t) => t.task === join.interaction?.task)?.status === "done" || (cell?.tasks ?? []).some((t) => t.id === join.interaction?.task && t.doneAt !== null);
    parts.push(`Failed only when joined: ${plural(join.interaction.failing, "test")} ${join.interaction.failing === 1 ? "fails" : "fail"} together; ${fix} ${fixDone ? "made them pass together" : "makes them pass together"}.`);
    tone = fixDone ? "done" : "fail";
  } else {
    parts.push(`Lanes joined: ${plural(join?.landed ?? 0, "task")} landed, the whole suite passed.`);
  }
  const moved = movedBranchWords(join);
  if (moved) parts.push(moved);
  for (const s of setAside) {
    parts.push(`${s.lane} set aside: its ${plural(s.tasks.length, "task")} ${s.tasks.length === 1 ? "is" : "are"} built again one at a time.`);
    tone = "fail";
  }
  for (const l of lanes) {
    if (l.status !== "handed-back") continue;
    const { tasks, built } = handedBackRemaining(l, done);
    if (tasks.length) parts.push(`${l.lane} handed back: its ${plural(tasks.length, "remaining task")} ${built ? wasWere(tasks.length) : isAre(tasks.length)} built one at a time.`);
  }
  return { marker: null, chips, moment: { words: parts.join(" "), tone } };
}

/** The lanes landed on a ticket's branch that moved while they were open; null when it did not. */
function movedBranchWords(join: JoinRecord | null | undefined): string | null {
  const m = join?.movedBranch;
  if (!m) return null;
  const n = m.commits.length;
  return n
    ? `The ticket's branch moved while the lanes were open: they landed on top of the ${plural(n, "commit")} made there.`
    : "The ticket's branch moved while the lanes were open: they landed on its new head.";
}

/** Why a lane was set aside, in words, from the lane's side ("it changed a file also changed by L1"); null for a code not known. */
export function asideWhyWords(b: SetAsideLane["because"][number]): string | null {
  const other = b.other;
  switch (b.why) {
    case "same-file":
      return other ? `it changed a file also changed by ${other}` : "it changed a file another lane also changed";
    case "frozen-test":
      return other ? `it changed a test file of ${other}` : "it changed another lane's test file";
    case "case-clash":
      return other ? `one of its file names and one of ${other}'s differ only by letter case` : "one of its file names and another lane's differ only by letter case";
    case "file-folder":
      return other ? `one of its files and a folder of ${other} have the same path, or the other way round` : "one of its files and another lane's folder have the same path, or the other way round";
    case "branch-moved":
      return b.commits !== null && b.commits > 1
        ? `${b.commits} commits made on the ticket's branch while the lanes were open changed its files`
        : "a commit made on the ticket's branch while the lanes were open changed its file";
    case "did-not-apply":
      return b.commit ? `its commit ${b.commit.slice(0, 10)} did not apply on the landed work` : "one of its commits did not apply on the landed work";
    case "unrecorded-commits":
      return "its branch held commits no task recorded";
    case "lane-history":
      return "its commits were not one chain from the fork point";
    default:
      return null;
  }
}

/** The row with the lanes' words on its marker, while it works at Build in lanes. */
export function withLaneMarker<R extends Pick<LineRow, "detail" | "state" | "column">>(row: R, line: LaneLine | null): R {
  if (!line?.marker || row.state !== "working" || row.column !== BUILD) return row;
  return { ...row, detail: line.marker };
}

// ---------------------------------------------------------------- in the side panel

export interface PanelTask {
  readonly task: string;
  readonly kind: string | null;
  readonly status: string;
  /** The time it took, in seconds, or null: "not recorded". */
  readonly seconds: number | null;
  /** Where the time comes from: the build report, or the clock between two recorded moments. */
  readonly basis: "report" | "recorded" | null;
  readonly laneCommit: string | null;
  readonly commit: string | null;
  /** What happened to its lane commit: landed as `commit`, set aside, or on its lane's branch still. */
  readonly commitWords: string | null;
}

export interface PanelGroup {
  readonly key: string;
  readonly title: string;
  readonly note: string | null;
  readonly tasks: readonly PanelTask[];
}

export interface PanelTiming {
  /** The lanes part: from opening the lanes to the last lane done. */
  readonly wallSeconds: number | null;
  /** Each lane's own time, first to last station call, added up. */
  readonly summedSeconds: number | null;
  readonly basis: "report" | "recorded" | null;
  /** The whole build, start to finish, and its tasks' times added up (the report's, once written). */
  readonly buildSeconds: number | null;
  readonly tasksSeconds: number | null;
  readonly tasksNotRecorded: number;
  readonly note: string;
}

export interface LanesPanel {
  readonly summary: string;
  readonly problems: readonly string[];
  /** What happened on the way and how nothing was lost: a step recovered, a lane made fresh, files kept aside. */
  readonly notes: readonly string[];
  readonly groups: readonly PanelGroup[];
  readonly timing: PanelTiming | null;
}

const between = (a: number | null, b: number | null): number | null => (a !== null && b !== null && b >= a ? Math.round((b - a) / 100) / 10 : null);

function commitWords(t: LaneTask, link: CommitLink | undefined): string | null {
  if (!t.laneCommit) return null;
  const lane = t.laneCommit.slice(0, 10);
  if (link?.state === "landed" && link.landed) return `lane commit ${lane}, landed as ${link.landed.slice(0, 10)}`;
  if (link?.state === "set-aside" || t.setAside) return `lane commit ${lane}, not landed: its lane was set aside`;
  return `lane commit ${lane}, on its lane's branch until the join`;
}

const STATUS_WORDS: Readonly<Record<string, string>> = { done: "done", pending: "not done yet" };

/** Each task's time: the report's when it has one, else the clock between recorded moments of its own chain. */
function taskTimes(reply: LanesReply): ReadonlyMap<string, { seconds: number | null; basis: PanelTask["basis"] }> {
  const out = new Map<string, { seconds: number | null; basis: PanelTask["basis"] }>();
  const steps = new Map((reply.report?.steps ?? []).map((s) => [s.task, s]));
  const at = new Map(reply.tasks.map((t) => [t.task, t.at]));
  // A lane's chain starts when the lane was handed to its builder; each task then from the one before it.
  for (const l of reply.lanes) {
    let previous = l.handedAt;
    for (const id of l.tasks) {
      const done = at.get(id) ?? null;
      out.set(id, { seconds: between(previous, done), basis: between(previous, done) === null ? null : "recorded" });
      previous = done ?? previous;
    }
  }
  // The cell's own chain: tasks before the lanes from the build's start, then one to the next; after
  // the join, from the join's end.
  let previous: number | null = reply.buildStartedAt;
  for (const id of reply.before) {
    const done = at.get(id) ?? null;
    out.set(id, { seconds: between(previous, done), basis: between(previous, done) === null ? null : "recorded" });
    previous = done ?? previous;
  }
  previous = reply.join?.finishedAt ?? null;
  const afterJoin = reply.tasks.filter((t) => t.part === "join" || t.part === "after" || t.setAside).map((t) => t.task);
  for (const id of afterJoin) {
    const done = at.get(id) ?? null;
    out.set(id, { seconds: between(previous, done), basis: between(previous, done) === null ? null : "recorded" });
    previous = done ?? previous;
  }
  for (const [id, s] of steps) if (s.seconds !== null) out.set(id, { seconds: s.seconds, basis: "report" });
  return out;
}

/** The tasks grouped by lane, each with its time; the lanes' wall time against their summed time. */
export function lanesPanel(reply: LanesReply | null, cell: Pick<CellState, "tasks"> | null): LanesPanel | null {
  if (!reply) return null;
  const problems: string[] = [];
  if (reply.buildJson.read !== "read") problems.push(`The build record (build.json) ${reply.buildJson.read === "absent" ? "is not there" : "could not be read"}${reply.buildJson.why ? `: ${reply.buildJson.why}` : ""}.`);
  const lanes = lanesNow(reply, cell);
  for (const l of lanes) {
    if (l.record.read === "unreadable" || (l.record.read === "absent" && l.done === null)) problems.push(`Lane ${l.lane}'s own record could not be read${l.record.why ? `: ${l.record.why}` : ""}. Its progress is not shown.`);
  }
  const byId = new Map(reply.tasks.map((t) => [t.task, t]));
  const eventsDone = new Set((cell?.tasks ?? []).filter((t) => t.doneAt !== null).map((t) => t.id));
  const links = new Map(reply.commits.map((c) => [c.task, c]));
  const times = taskTimes(reply);
  const aside = new Set((reply.join?.setAside ?? []).map((s) => s.lane));
  const handedBackIds = new Set(lanes.flatMap((l) => (l.status === "handed-back" ? handedBackRemaining(l, new Set()).tasks : [])));
  const row = (id: string): PanelTask => {
    const t = byId.get(id);
    const time = times.get(id);
    const done = t?.status === "done" || (eventsDone.has(id) && (reply.state === "open" || handedBackIds.has(id) || t?.part === "commands"));
    const notDone = t?.status ? (STATUS_WORDS[t.status] ?? t.status) : "not recorded";
    return {
      task: id,
      kind: t?.kind ?? null,
      status: done
        ? t?.recovered
          ? "done, recovered after an interrupted step"
          : "done"
        : (t?.handedBack || handedBackIds.has(id)) && t?.status !== "done"
          ? `${notDone}, built in the cell after the join`
          : notDone,
      seconds: done ? (time?.seconds ?? null) : null,
      basis: done ? (time?.basis ?? null) : null,
      laneCommit: t?.laneCommit ?? null,
      commit: t?.commit ?? null,
      commitWords: t ? commitWords(t, links.get(id)) : null,
    };
  };
  const groups: PanelGroup[] = [];
  if (reply.before.length) groups.push({ key: "before", title: "Before the lanes", note: "Built in the cell, one at a time.", tasks: reply.before.map(row) });
  for (const l of lanes) {
    const status = aside.has(l.lane) || l.status === "set-aside"
      ? "set aside: not landed; its tasks are built again in the cell, one at a time"
      : l.status === "handed-back"
        ? handedBackNote(l, reply.state === "joined")
      : l.waiting === "free-place"
        ? "waiting for a free place"
        : l.status === "joined"
          ? "joined"
          : l.done !== null && l.done >= l.total && l.total > 0
            ? "done"
            : l.status === "planned"
              ? "not started"
              : l.done === null
                ? "progress not recorded"
                : `${l.done} of ${l.total} done`;
    groups.push({ key: l.lane, title: `Lane ${l.lane}`, note: status, tasks: l.tasks.map(row) });
  }
  const joinTasks = reply.tasks.filter((t) => t.part === "join").map((t) => t.task);
  if (joinTasks.length) groups.push({ key: "join", title: "After the join", note: "Added when the lanes failed together; built in the cell.", tasks: joinTasks.map(row) });
  if (reply.after.length) groups.push({ key: "after", title: "After the lanes", note: "Built in the cell, one at a time, once the lanes are joined.", tasks: reply.after.map(row) });
  const commandTasks = reply.tasks.filter((t) => t.part === "commands").map((t) => t.task);
  if (commandTasks.length) groups.push({ key: "commands", title: "After a command changed", note: "Added when a new test or lint command left the suite or the linter failing; built in the cell.", tasks: commandTasks.map(row) });

  const summary = summaryOf(reply, lanes);
  return { summary, problems, notes: notesOf(reply, lanes), groups, timing: timingOf(reply, lanes, times) };
}

const taskList = (ids: readonly string[]): string => (ids.length <= 1 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`);

/** A handed-back lane's state in its group's heading. */
function handedBackNote(l: LaneRecord, joined: boolean): string {
  const hb = l.handedBack;
  const remaining = hb ? (hb.builtInCell.length ? hb.builtInCell : hb.unfinished) : [];
  const finished = hb?.finished.length ? (joined ? "its finished tasks landed at the join; " : "its finished tasks land at the join; ") : "";
  if (!remaining.length) return "handed back";
  return `handed back: ${finished}${taskList(remaining)} ${isAre(remaining.length)} built in the cell, one at a time, ${joined ? "now that the lanes are joined" : "after the join"}`;
}

const clock = (t: number | null): string | null => (t === null ? null : `${utcClock(t)} UTC`);

/** A handed-back lane in the panel's summary: what it handed back, and where its tasks go. */
function handedBackSentence(l: LaneRecord, joined: boolean): string {
  const hb = l.handedBack;
  const when = clock(hb?.at ?? null);
  const remaining = hb ? (hb.builtInCell.length ? hb.builtInCell : hb.unfinished) : [];
  const finished = hb?.finished.length ?? 0;
  const rest = remaining.length
    ? ` its ${plural(remaining.length, "remaining task")} (${taskList(remaining)}) ${isAre(remaining.length)} built in the cell, one at a time, ${joined ? "after the join" : "once the lanes are joined"}`
    : "";
  const land = finished ? `; its ${plural(finished, "finished task")} ${joined ? "landed" : finished === 1 ? "lands" : "land"} at the join` : "";
  return `Lane ${l.lane} was handed back to the cell${when ? ` at ${when}` : ""}:${rest || " nothing was left unfinished"}${land}.`;
}

/**
 * What happened on the way, from the recorded deviations and the lanes' own records, each with how
 * nothing was lost: a step recovered after an interruption, a lane made fresh, a lane's worktree made
 * again, uncommitted files kept aside at the join.
 */
function notesOf(reply: LanesReply, lanes: readonly LaneRecord[]): string[] {
  const notes: string[] = [];
  const recovered = new Map<string, { lane: string | null; task: string; commit: string | null }>();
  for (const l of lanes) for (const r of l.recovered) recovered.set(`${l.lane}|${r.task}`, { lane: l.lane, task: r.task, commit: r.commit });
  for (const d of reply.deviations) {
    if (d.type === "step-recovered" && d.task && !recovered.has(`${d.lane}|${d.task}`)) recovered.set(`${d.lane}|${d.task}`, { lane: d.lane, task: d.task, commit: d.commit });
  }
  for (const r of recovered.values()) {
    const where = r.lane ? `In lane ${r.lane}, the` : "The";
    notes.push(`${where} step of ${r.task} was interrupted; the station found its commit${r.commit ? ` (${r.commit.slice(0, 10)})` : ""} and recorded it, so nothing was lost.`);
  }
  for (const l of lanes) {
    for (const f of l.madeFresh) {
      const when = clock(f.at);
      const kept = f.ref
        ? `Nothing was lost: what was there before is kept under ${f.ref}${f.stateFileKept ? ", and its earlier record beside it in the cell" : ""}.`
        : f.stateFileKept
          ? "Nothing was lost: its earlier record is kept beside it in the cell."
          : "Nothing of its own was there to keep.";
      notes.push(`Lane ${l.lane} was made fresh${when ? ` at ${when}` : ""}, because its folder, branch or record belonged to another build. ${kept}`);
    }
  }
  for (const d of reply.deviations) {
    if (d.type === "lane-worktree-remade" && d.lane) notes.push(`Lane ${d.lane}'s worktree was made again on a new branch, because its branch was checked out somewhere else.`);
    if (d.type === "lane-files-set-aside" && d.lane) notes.push(`Lane ${d.lane} had uncommitted files no task held; ${d.ref ? `the station kept them under ${d.ref}` : "the station kept them"}, and the join went on without them.`);
  }
  return notes;
}

function summaryOf(reply: LanesReply, lanes: readonly LaneRecord[]): string {
  const n = plural(lanes.length, "lane");
  switch (reply.state) {
    case "planned":
      return `Planned in ${n}: the tasks before the lanes are built first, then the lanes are opened.`;
    case "sequential":
      if (reply.sequentialBecause === "suite")
        return `Planned in ${n}, but the cell's suite was ${reply.sequentialSuite === "red" ? "failing" : "not known to pass"} where they would open, so the plan is built one task at a time, as without lanes, and the builder makes the suite pass on the way.`;
      return `Planned in ${n}, but too few builders' places were free when they were to open, so the plan is built one task at a time, as without lanes.`;
    case "unreadable":
      return "Built in lanes, but the build record could not be read, so its lanes are not shown.";
    case "open": {
      const underWay = joinUnderWay(reply);
      if (underWay) return `Built in ${n}. ${underWay.summary}`;
      const stopped = stoppedJoin(reply);
      if (stopped) return `Built in ${n}. The join stopped and landed nothing (${stopped}); the ticket's branch is where it was and every lane's work is kept.`;
      const waiting = lanes.filter((l) => l.waiting === "free-place").length;
      const words = [`Built in ${n} at the same time, each by its own builder in its own worktree${waiting ? `; ${plural(waiting, "lane")} ${waiting === 1 ? "waits" : "wait"} for a free place` : ""}.`];
      for (const l of lanes) if (l.status === "handed-back") words.push(handedBackSentence(l, false));
      return words.join(" ");
    }
    case "joined": {
      const j = reply.join;
      const aside = j?.setAside ?? [];
      const words = [`Built in ${n}, then joined: ${plural(j?.landed ?? 0, "task")} landed on the ticket's branch, one per task in plan order.`];
      const moved = movedBranchWords(j);
      if (moved) words.push(moved);
      if (j?.interaction) words.push(`The whole suite failed only on the joined result (${plural(j.interaction.failing, "failing test")}${j.interaction.lanesNamed.length ? `, in files of ${j.interaction.lanesNamed.join(", ")}` : ""}); ${j.interaction.task ?? "a task"} makes the lanes pass together.`);
      else if (j?.suitePassed) words.push("The whole suite passed on the joined result.");
      for (const s of aside) {
        const why = s.because.map(asideWhyWords).filter((w): w is string => w !== null);
        words.push(`${s.lane} was set aside${why.length ? ` (${why.join("; ")})` : ""}: its tasks are built again in the cell, one at a time.${s.keptAs ? ` Its lane commits are kept under ${s.keptAs}, so nothing is lost.` : ""}`);
      }
      for (const l of lanes) if (l.status === "handed-back") words.push(handedBackSentence(l, true));
      return words.join(" ");
    }
  }
}

function timingOf(reply: LanesReply, lanes: readonly LaneRecord[], times: ReadonlyMap<string, { seconds: number | null }>): PanelTiming | null {
  if (reply.state === "planned" || reply.state === "sequential" || reply.state === "unreadable") return null;
  const r = reply.report;
  let wall = r?.wallSeconds ?? null;
  let summed = r?.summedSeconds ?? null;
  let basis: PanelTiming["basis"] = wall !== null && summed !== null ? "report" : null;
  if (basis === null) {
    const ends = lanes.map((l) => l.finishedAt);
    const elapsed = lanes.map((l) => between(l.startedAt ?? l.handedAt, l.finishedAt));
    if (lanes.length && ends.every((e) => e !== null) && elapsed.every((e) => e !== null)) {
      wall = between(reply.openedAt, Math.max(...(ends as number[])));
      summed = Math.round((elapsed as number[]).reduce((a, b) => a + b, 0) * 10) / 10;
      basis = wall !== null ? "recorded" : null;
      if (basis === null) summed = null;
    } else {
      wall = null;
      summed = null;
    }
  }
  const all = reply.tasks.map((t) => times.get(t.task)?.seconds ?? null);
  const recorded = all.filter((s): s is number => s !== null);
  return {
    wallSeconds: wall,
    summedSeconds: summed,
    basis,
    buildSeconds: r?.elapsedSeconds ?? null,
    tasksSeconds: recorded.length ? Math.round(recorded.reduce((a, b) => a + b, 0) * 10) / 10 : null,
    tasksNotRecorded: all.length - recorded.length,
    note:
      basis === "report"
        ? "From the build report. Wall time runs from opening the lanes to the last lane done; the lanes' own times are added up. The added-up time is not what a build one task at a time would have taken, which was not run."
        : basis === "recorded"
          ? "From the moments the lanes recorded; the build report adds the rest when the build finishes. The added-up time is not what a build one task at a time would have taken, which was not run."
          : "Not every lane has recorded when it finished yet, so the lanes' times are not added up.",
  };
}

// ---------------------------------------------------------------- a changed command (any build, in lanes or not)

export interface CommandsPanel {
  /** One sentence per change: "The test command changed at 10:40:00 UTC." */
  readonly lines: readonly string[];
  readonly note: string;
}

/**
 * The side panel's part for a build whose test or lint command was changed while it was building:
 * which command and when. The commands themselves and the reason are a builder's own words, which
 * the observer does not serve: the note says where they are. Null when none changed.
 */
export function commandsPanel(changes: readonly CommandChange[] | null | undefined): CommandsPanel | null {
  if (!changes?.length) return null;
  const lines = changes.map((c) => {
    const both = c.commands.includes("test") && c.commands.includes("lint");
    const what = both ? "The test and lint commands" : `The ${c.commands[0]} command`;
    const when = clock(c.at);
    return `${what} changed${when ? ` at ${when}` : ", at a time not recorded"}${c.loop ? `, in revision round ${c.loop}` : ""}.`;
  });
  return {
    lines,
    note: "Nothing done was undone: the build carried on from where it was. The old and the new command, and why it changed, are in the build's record for the reviewers.",
  };
}

/** A lane commit followed to the commit that landed in its place, when the reply records it. */
export function landedCommitOf(reply: LanesReply | null, laneCommit: string): CommitLink | null {
  if (!reply) return null;
  return reply.commits.find((c) => c.laneCommit === laneCommit || (laneCommit.length >= 7 && c.laneCommit.startsWith(laneCommit))) ?? null;
}
