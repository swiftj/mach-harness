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
 * "set aside" is not landed, and its tasks are built again in the cell, one at a time.
 */
import type { CellState } from "../sim";
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
  readonly status: "planned" | "open" | "done" | "joined" | "set-aside" | "sequential" | null;
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
}

export interface LaneTask {
  readonly task: string;
  readonly kind: string | null;
  readonly part: "before" | "lane" | "after" | "join" | null;
  readonly lane: string | null;
  readonly status: string | null;
  readonly setAside: boolean;
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
  readonly setAside: readonly { readonly lane: string; readonly tasks: readonly string[]; readonly because: readonly { readonly other: string | null; readonly why: "same-file" | "frozen-test" | null }[] }[];
  readonly interaction: { readonly failing: number; readonly lanesNamed: readonly string[]; readonly task: string | null } | null;
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
  readonly gate: "build.lanes-open" | "build.join";
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
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly lanes: readonly LaneRecord[];
  readonly join: JoinRecord | null;
  readonly refusals: readonly { readonly at: number | null; readonly reasonCode: string | null }[];
  readonly tasks: readonly LaneTask[];
  readonly commits: readonly CommitLink[];
  readonly report: ReportTiming | null;
  readonly gates: readonly LanesGate[];
}

const LANE_RE = /^L[1-9]\d{0,2}$/;
const TASK_RE = /^(?:(?:R\d+|J)-)?T\d{1,5}$/;
const COMMIT_RE = /^[0-9a-f]{7,64}$/;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

type Obj = Readonly<Record<string, unknown>>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const laneId = (v: unknown): string | null => (typeof v === "string" && LANE_RE.test(v) ? v : null);
const taskId = (v: unknown): string | null => (typeof v === "string" && TASK_RE.test(v) ? v : null);
const commit = (v: unknown): string | null => (typeof v === "string" && COMMIT_RE.test(v) ? v : null);
const code = (v: unknown): string | null => (typeof v === "string" && CODE_RE.test(v) ? v : null);
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
      status: oneOf(l.status, ["planned", "open", "done", "joined", "set-aside", "sequential"] as const),
      waiting: oneOf(l.waiting, ["free-place"] as const),
      record: fileRead(l.record),
      handedAt: time(l.handed_at),
      startedAt: time(l.started_at),
      lastStepAt: time(l.last_step_at),
      finishedAt: time(l.finished_at),
      done: whole(l.done),
      total: whole(l.total) ?? tasks.length,
      current: taskId(l.current),
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
          return lane ? [{ lane, tasks: ids(s.tasks, taskId), because: arr(s.because).map((b) => ({ other: laneId(obj(b).other), why: oneOf(obj(b).why, ["same-file", "frozen-test"] as const) })) }] : [];
        }),
        interaction: interaction ? { failing: whole(interaction.failing) ?? 0, lanesNamed: ids(interaction.lanes_named, laneId), task: taskId(interaction.task) } : null,
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
    before: ids(d.before, taskId),
    after: ids(d.after, taskId),
    lanes,
    join,
    refusals: arr(d.join_refusals).map((x) => ({ at: time(obj(x).at), reasonCode: code(obj(x).reason_code) })),
    tasks: arr(d.tasks).flatMap((x) => {
      const t = obj(x);
      const task = taskId(t.task);
      return task
        ? [{
            task,
            kind: oneOf(t.kind, ["test", "impl", "contract", "refactor", "docs"] as const),
            part: oneOf(t.part, ["before", "lane", "after", "join"] as const),
            lane: laneId(t.lane),
            status: typeof t.status === "string" && /^[a-z][a-z-]{0,23}$/.test(t.status) ? t.status : null,
            setAside: t.set_aside === true,
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
      const gate = oneOf(g.gate, ["build.lanes-open", "build.join"] as const);
      const at = obj(g.at);
      return gate ? [{ gate, verdict: typeof g.verdict === "string" ? g.verdict : "unknown", reasonCode: code(g.reason_code), lane: laneId(g.lane), at: time(at.at) }] : [];
    }),
  };
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

function chipOf(l: LaneRecord, aside: ReadonlySet<string>): LaneChip {
  if (aside.has(l.lane) || l.status === "set-aside") return { lane: l.lane, words: `${l.lane}: set aside`, tone: "fail" };
  if (l.status === "joined") return { lane: l.lane, words: `${l.lane}: landed, ${l.total} of ${l.total} done`, tone: "done" };
  if (l.record.read === "unreadable" || (l.record.read === "absent" && l.done === null)) return { lane: l.lane, words: `${l.lane}: its record could not be read`, tone: "unknown" };
  if (l.waiting === "free-place") return { lane: l.lane, words: `${l.lane}: waiting for a free place`, tone: "held" };
  const done = l.done ?? 0;
  if (l.status === "done" || (l.total > 0 && done >= l.total)) return { lane: l.lane, words: `${l.lane}: done, ${l.total} of ${l.total}`, tone: "done" };
  if (l.status === "planned") return { lane: l.lane, words: `${l.lane}: not started, ${plural(l.total, "task")}`, tone: "held" };
  return { lane: l.lane, words: `${l.lane}: ${l.current ?? "next task not recorded"}, ${done} of ${l.total} done`, tone: "working" };
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
  const chips = lanes.map((l) => chipOf(l, aside));
  if (reply.state === "open") {
    const stopped = stoppedJoin(reply);
    const allDone = lanes.length > 0 && lanes.every((l) => l.status === "done" || (l.done !== null && l.done >= l.total));
    const moment = stopped
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
  for (const s of setAside) {
    parts.push(`${s.lane} set aside: its ${plural(s.tasks.length, "task")} ${s.tasks.length === 1 ? "is" : "are"} built again one at a time.`);
    tone = "fail";
  }
  return { marker: null, chips, moment: { words: parts.join(" "), tone } };
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
  // The cell's own chain: tasks before the lanes from one to the next (the first has no recorded start
  // here); after the join, from the join's end.
  let previous: number | null = null;
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
  const row = (id: string): PanelTask => {
    const t = byId.get(id);
    const time = times.get(id);
    const done = t?.status === "done" || (eventsDone.has(id) && reply.state === "open");
    return {
      task: id,
      kind: t?.kind ?? null,
      status: done ? "done" : t?.status ? (STATUS_WORDS[t.status] ?? t.status) : "not recorded",
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

  const summary = summaryOf(reply, lanes);
  return { summary, problems, groups, timing: timingOf(reply, lanes, times) };
}

function summaryOf(reply: LanesReply, lanes: readonly LaneRecord[]): string {
  const n = plural(lanes.length, "lane");
  switch (reply.state) {
    case "planned":
      return `Planned in ${n}: the tasks before the lanes are built first, then the lanes are opened.`;
    case "sequential":
      return `Planned in ${n}, but too few builders' places were free when they were to open, so the plan is built one task at a time, as without lanes.`;
    case "unreadable":
      return "Built in lanes, but the build record could not be read, so its lanes are not shown.";
    case "open": {
      const stopped = stoppedJoin(reply);
      if (stopped) return `Built in ${n}. The join stopped and landed nothing (${stopped}); the ticket's branch is where it was and every lane's work is kept.`;
      const waiting = lanes.filter((l) => l.waiting === "free-place").length;
      return `Built in ${n} at the same time, each by its own builder in its own worktree${waiting ? `; ${plural(waiting, "lane")} ${waiting === 1 ? "waits" : "wait"} for a free place` : ""}.`;
    }
    case "joined": {
      const j = reply.join;
      const aside = j?.setAside ?? [];
      const words = [`Built in ${n}, then joined: ${plural(j?.landed ?? 0, "task")} landed on the ticket's branch, one per task in plan order.`];
      if (j?.interaction) words.push(`The whole suite failed only on the joined result (${plural(j.interaction.failing, "failing test")}${j.interaction.lanesNamed.length ? `, in files of ${j.interaction.lanesNamed.join(", ")}` : ""}); ${j.interaction.task ?? "a task"} makes the lanes pass together.`);
      else if (j?.suitePassed) words.push("The whole suite passed on the joined result.");
      for (const s of aside) {
        const with_ = s.because.map((b) => (b.other ? `${b.why === "frozen-test" ? "changed a test file of" : "changed a file also changed by"} ${b.other}` : null)).filter(Boolean);
        words.push(`${s.lane} was set aside${with_.length ? ` (it ${with_.join("; ")})` : ""}: its tasks are built again in the cell, one at a time.`);
      }
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

/** A lane commit followed to the commit that landed in its place, when the reply records it. */
export function landedCommitOf(reply: LanesReply | null, laneCommit: string): CommitLink | null {
  if (!reply) return null;
  return reply.commits.find((c) => c.laneCommit === laneCommit || (laneCommit.length >= 7 && c.laneCommit.startsWith(laneCommit))) ?? null;
}
