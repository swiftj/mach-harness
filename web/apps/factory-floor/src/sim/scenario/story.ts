/**
 * The storyboard, as a script. One approved delivery wave (WAVE-007, five invoicing slices) arrives
 * at a Factory a person has just enabled. The supervisor takes it in, dispatches the three slices
 * that depend on nothing, and runs one execution of the mach:belt workflow per ticket, in parallel:
 *
 *   LOCAL-033 (SLICE-023, Medium)  plan, build, verify PASS, review APPROVED 2 of 3 with one outvoted
 *                                  product blocker, merge (no revalidation: first to land), cleanup.
 *   LOCAL-031 (SLICE-021, Medium)  plan, build, verify FAILS on matrix rule R4, revise (round 2),
 *                                  verify PASS, review round 2 APPROVED 3 of 3, merge with
 *                                  revalidation, cleanup. Its merge frees SLICE-024.
 *   LOCAL-032 (SLICE-022, High)    changes an existing contract; review round 1 REJECTED by a security
 *                                  blocker, revise, verify, delta review round 2 AWAITING_HUMAN; the
 *                                  execution stops at the human gate; Daniel Okafor approves; a new
 *                                  execution merges it with revalidation and cleans up.
 *   LOCAL-034 (SLICE-024, Medium)  waits for SLICE-021; eligible and dispatched when it is integrated;
 *                                  still building when the scenario ends.
 *   LOCAL-035 (SLICE-025, High)    waits for SLICE-022 and SLICE-024 throughout.
 *
 * The supervisor ticks every 60 s (poll_seconds 60): it observes stage changes, records the plan,
 * notices finished executions and starts new ones only on ticks, as supervisor.py does.
 */
import type { AnySimEvent, EventDataMap } from "../events";
import type { Chapter, Fixture } from "../model";
import type { CellStage, Risk } from "../vocabulary";
import { CONTENT, DEFINITIONS, PEOPLE, PROJECT, SLICE_IDS, TICKETS, WAVE } from "./content";
import { approveByPerson, build, cleanup, endWorkflow, leave, merge, next, plan, review, revise, startWorkflow, verify, type MainLine, type Suite } from "./belt";
import { Lane, Recorder, SCENARIO_START, hex, sha40, uuidFrom, type Envelope, type Handle } from "./recorder";

const S = 1000;
const TICK0 = 30 * S;
const PERIOD = 60 * S;
const BASELINE_TESTS = 412;
const TAIL = 20 * S;

/** The first supervisor tick strictly after `t`. */
export function tickAfter(t: number): number {
  return t < TICK0 ? TICK0 : TICK0 + (Math.floor((t - TICK0) / PERIOD) + 1) * PERIOD;
}

const RUNNER = uuidFrom("runner:priya-macbook");
const PRODUCT_COMMIT = sha40("product:WAVE-007:r1");
const MAIN_AT_DISPATCH = sha40("main:before-wave-007");
const LIMITS: EventDataMap["factory.activated"]["limits"] = {
  max_parallel: 3,
  max_execution_minutes: 120,
  max_runs_per_day: 20,
  max_budget_usd_per_run: 25,
  max_budget_usd_per_day: 100,
  max_attempts: 2,
  poll_seconds: 60,
};

const risk = (slice: string): Risk => DEFINITIONS.slices[slice]?.risk ?? "Medium";
const title = (slice: string): string => DEFINITIONS.slices[slice]?.title ?? slice;

export function buildScenario(): Fixture {
  const rec = new Recorder(PROJECT.id, RUNNER, PRODUCT_COMMIT);
  const sliceEnv = (slice: string, extra: Partial<Envelope> = {}): Envelope => ({
    source: "supervisor",
    wave_id: WAVE.id,
    slice_id: slice,
    revision: WAVE.revision,
    ticket_id: TICKETS[slice] ?? null,
    ...extra,
  });
  const lanes: Record<string, Lane> = {};
  const laneOf = (slice: string): Lane => {
    const ticket = TICKETS[slice] ?? slice;
    lanes[ticket] ??= new Lane(rec, ticket, slice, WAVE.id, WAVE.revision);
    return lanes[ticket];
  };
  const archivedAt: Record<string, number> = {};
  const decisions: Array<{ t: number; data: EventDataMap["scheduling.decided"] }> = [];
  const executionEnds: Array<{ lane: Lane; execution: string; session: string; workflowEnd: number; stage: CellStage | null; waitingFor: string; cost: number }> = [];

  // ------------------------------------------------------------ 00:00 a person enables the Factory
  rec.emit(0, "factory.activated", {
    autonomy: "supervised",
    by: PEOPLE.engineer,
    limits: LIMITS,
    allow_merge: true,
    persistent: true,
    backlog: "exclude",
    excluded_slices: [],
  }, { source: "engineer", source_commit: null });

  // ------------------------------------------------------------ 00:30 first tick: intake takes the wave in
  const t1 = TICK0;
  rec.emit(t1 + 100, "wave.discovered", { slices: [...SLICE_IDS], approval: { actor: PEOPLE.productManager, approved_at: WAVE.approvedAt } },
    { source: "supervisor", wave_id: WAVE.id, revision: WAVE.revision });
  rec.emit(t1 + 200, "intake.validated", { digest: `sha256:${hex("wave-007-digest", 64)}` }, { source: "supervisor", wave_id: WAVE.id, revision: WAVE.revision });
  SLICE_IDS.forEach((slice, i) => {
    rec.emit(t1 + 320 + i * 70, "slice.materialized", { digest: `sha256:${hex(`${slice}-digest`, 64)}`, adopted: false, dependencies: [...(DEFINITIONS.slices[slice]?.dependencies ?? [])] }, sliceEnv(slice));
  });
  for (const slice of ["SLICE-021", "SLICE-022", "SLICE-023"]) rec.emit(t1 + 720, "dependency.resolved", { depends_on: [] }, sliceEnv(slice));
  rec.emit(t1 + 740, "dependency.blocked", { reasons: ["It waits for SLICE-021 to be integrated (now queued)."] }, sliceEnv("SLICE-024"));
  rec.emit(t1 + 760, "dependency.blocked", { reasons: ["It waits for SLICE-022 to be integrated (now queued).", "It waits for SLICE-024 to be integrated (now queued)."] }, sliceEnv("SLICE-025"));
  rec.emit(t1 + 1000, "revision.discovered", { from_commit: null, commit: PRODUCT_COMMIT }, { source: "supervisor", refs: { integration_branch: PROJECT.integrationBranch } });

  /** intake.py open_cell: open, write intent.md, finalize to spec-ready, record work.scheduled. */
  const dispatch = (slice: string, t: number): number => {
    const lane = laneOf(slice);
    const def = DEFINITIONS.slices[slice];
    const script = { agent_id: null, call_id: null, script: "intake.py open_cell" };
    lane.writeArtifact(t, { kind: "intent", path: "intent.md", label: "intent.md", summary: `Why, from product/intents/${slice}.md; approved by ${PEOPLE.productManager}` }, script, null);
    lane.writeArtifact(t + 150, { kind: "spec", path: def?.specPath ?? "spec.md", label: "spec.md", summary: "The approved slice spec, checked against its SHA-256" }, { ...script, script: "cell.py finalize" }, null);
    lane.writeArtifact(t + 250, { kind: "spec", path: "spec.json", label: "spec.json", summary: "The spec as data, every matrix rule expanded" }, { ...script, script: "cell.py finalize" }, null);
    const specCommit = sha40(`${lane.ticket}-spec`);
    lane.writeArtifact(t + 300, { kind: "commit", path: `feature/${lane.ticket}`, id: `${lane.ticket}:commit:${specCommit.slice(0, 7)}`, label: `spec(${slice}): ${title(slice)} [${lane.ticket}]`, summary: def?.specPath ?? "", sha: specCommit }, { ...script, script: "cell.py finalize" }, null);
    lane.setStage(t + 400, "spec-ready", "intake.py open_cell (cell.py open, then finalize)");
    rec.emit(t + 500, "work.scheduled", { stage: "spec-ready", risk: risk(slice), branch: `feature/${lane.ticket}`, by: "supervisor", authorization: `runner ${RUNNER}; supervised` },
      sliceEnv(slice, { refs: { cell: `.factory/worktrees/${lane.ticket}/cell.json` } }));
    return t + 700;
  };

  /** supervisor.start: claim, then launch; the workflow starts a few seconds later. */
  const launch = (lane: Lane, t: number, stage: CellStage, nextAction: EventDataMap["work.claimed"]["next"], attempt = 1): { started: Handle; workflowAt: number; execution: string; session: string } => {
    const execution = `x${hex(`execution:${lane.ticket}:${t}`, 12)}`;
    const session = uuidFrom(`session:${execution}`);
    lane.execution = execution;
    // Real kinds keep cause null, as MACH writes them today.
    rec.emit(t, "work.claimed", { stage, next: nextAction, attempt }, sliceEnv(lane.slice, { execution_id: execution }));
    const started = rec.emit(t + 800, "execution.started", { session_id: session, until: null, workflow: "mach:belt", limits: { minutes: LIMITS.max_execution_minutes, budget_usd: LIMITS.max_budget_usd_per_run } },
      sliceEnv(lane.slice, { execution_id: execution, refs: { execution: `.factory/local/executions/${execution}/`, cell: `.factory/worktrees/${lane.ticket}/cell.json` } }));
    return { started, workflowAt: t + 7400, execution, session };
  };

  let at = t1 + 1300;
  for (const slice of ["SLICE-021", "SLICE-022", "SLICE-023"]) at = dispatch(slice, at);
  rec.emit(at + 300, "dependency.blocked", { reasons: ["It waits for SLICE-021 to be integrated (now active)."] }, sliceEnv("SLICE-024"));
  rec.emit(at + 320, "dependency.blocked", { reasons: ["It waits for SLICE-022 to be integrated (now active).", "It waits for SLICE-024 to be integrated (now queued)."] }, sliceEnv("SLICE-025"));
  at += 600;
  const runs: Record<string, ReturnType<typeof launch>> = {};
  for (const slice of ["SLICE-021", "SLICE-022", "SLICE-023"]) {
    const lane = laneOf(slice);
    runs[lane.ticket] = launch(lane, at, "spec-ready", "plan");
    at += 1100;
  }
  decisions.push({ t: at + 400, data: { state: "supervised", dispatched: ["SLICE-021", "SLICE-022", "SLICE-023"], started: ["LOCAL-031", "LOCAL-032", "LOCAL-033"], held: [] } });

  const suites: Record<string, Suite> = {};
  const main: MainLine = { head: MAIN_AT_DISPATCH, tests: BASELINE_TESTS, merges: [] };

  /** One ticket from its first "what next?" to approval (or the human gate). */
  const toApproval = (lane: Lane, startAt: number): { end: number; outcome: string } => {
    const c = CONTENT[lane.ticket];
    if (!c) throw new Error(`No content for ${lane.ticket}`);
    const suite = (suites[lane.ticket] = { passing: BASELINE_TESTS, pending: 0 });
    const r = risk(lane.slice);
    let t = next(lane, startAt, { action: "plan", stage: "spec-ready", reason: "The spec is ready; contracts and the plan are not written yet.", model: "opus" });
    t = leave(lane, plan(lane, t, c), "plan", "done", "Contracts committed; plan checked.");
    t = next(lane, t + 800, { action: "build", stage: "planned", reason: "Groomed and cleared to build." });
    t = leave(lane, build(lane, t, c, suite), "build", "done", `${c.tasks.length} tasks built test-first.`);
    let previousHead: string | null = null;
    for (;;) {
      t = next(lane, t + 800, { action: "verify", stage: "built", reason: "Built; not yet verified." });
      const verified = verify(lane, t, c, suite);
      t = leave(lane, verified.end, "verify", verified.passed ? "passed" : "failed", verified.passed ? "PASS" : "FAIL_WITH_EVIDENCE");
      if (!verified.passed) {
        t = next(lane, t + 800, { action: "revise", stage: "built", reason: "Verification failed this build." });
        t = leave(lane, revise(lane, t, c, suite, "verification", "evidence/findings.md"), "revise", "done", `Round ${lane.round}: findings addressed.`);
        continue;
      }
      t = next(lane, t + 800, { action: "review", stage: "verified", reason: "Verified; ready for the review panel." });
      const reviewed = review(lane, t, c, r, previousHead);
      const outcome = reviewed.outcome;
      t = leave(lane, reviewed.end, "review", outcome === "APPROVED" ? "approved" : outcome === "AWAITING_HUMAN" ? "awaiting-human" : "rejected", outcome);
      if (outcome === "REJECTED") {
        previousHead = sha40(`${lane.ticket}-head-${lane.round}`);
        t = next(lane, t + 800, { action: "revise", stage: "built", reason: "Review rejected this build." });
        t = leave(lane, revise(lane, t, c, suite, "review", `review/round-${lane.round}/findings.md`), "revise", "done", `Round ${lane.round}: blocker addressed.`);
        continue;
      }
      return { end: t, outcome };
    }
  };

  /** From approval: merge, cleanup, the final stop, and the workflow's return. */
  const toFinish = (lane: Lane, startAt: number): number => {
    const suite = suites[lane.ticket] ?? { passing: BASELINE_TESTS, pending: 0 };
    let t = next(lane, startAt, { action: "merge", stage: "approved", reason: "Approved; the project's settings let the line merge it.", model: "haiku" });
    t = leave(lane, merge(lane, t, title(lane.slice), suite, main, MAIN_AT_DISPATCH), "merge", "merged", "Landed on main.");
    t = next(lane, t + 600, { action: "cleanup", stage: "merged", reason: "Merged.", model: "haiku" });
    const cleaned = cleanup(lane, t, lane.round);
    archivedAt[lane.ticket] = cleaned;
    t = leave(lane, cleaned, "cleanup", "archived", "Archived; run record appended.");
    t = next(lane, t + 600, { action: "stop", stage: null, reason: `This ticket is finished: it was merged and cleaned up (.factory/archive/${lane.ticket}.tar.gz).`, needs: "nothing" });
    return endWorkflow(lane, t, { stage: "", waiting_for: "nothing" });
  };

  // ------------------------------------------------------------ the three executions, side by side
  const ticketsInOrder = ["LOCAL-033", "LOCAL-031", "LOCAL-032"];
  const approvedAt: Record<string, number> = {};
  for (const ticket of ticketsInOrder) {
    const lane = lanes[ticket];
    const run = runs[ticket];
    if (!lane || !run) throw new Error(`No lane for ${ticket}`);
    const t = startWorkflow(lane, run.workflowAt, run.session, run.started);
    const result = toApproval(lane, t);
    approvedAt[ticket] = result.end;
  }

  // LOCAL-032 stops at the human gate: its first execution ends there.
  const high = lanes["LOCAL-032"] as Lane;
  const highRun = runs["LOCAL-032"] as ReturnType<typeof launch>;
  let highAt = next(high, (approvedAt["LOCAL-032"] ?? 0) + 800, { action: "stop", stage: "awaiting-human", reason: "The review panel approved, and a person must approve before merge because the change is High risk.", needs: "human-approval" });
  const firstWorkflowEnd = endWorkflow(high, highAt, { stage: "awaiting-human", waiting_for: "human-approval" });
  executionEnds.push({ lane: high, execution: highRun.execution, session: highRun.session, workflowEnd: firstWorkflowEnd, stage: "awaiting-human", waitingFor: "human-approval", cost: 14.62 });
  const gateTick = tickAfter(firstWorkflowEnd + 4 * S);
  rec.emit(gateTick + 600, "human.required", { reason: "waiting for human-approval" }, sliceEnv("SLICE-022"));

  // The two Medium tickets merge as they are approved: LOCAL-033 first, then LOCAL-031.
  const order = ["LOCAL-033", "LOCAL-031"].sort((a, b) => (approvedAt[a] ?? 0) - (approvedAt[b] ?? 0));
  if (order[0] !== "LOCAL-033") throw new Error("The story expects LOCAL-033 to be approved before LOCAL-031");
  const finishedAt: Record<string, number> = {};
  for (const ticket of order) {
    const lane = lanes[ticket] as Lane;
    finishedAt[ticket] = toFinish(lane, (approvedAt[ticket] ?? 0) + 800);
    const run = runs[ticket] as ReturnType<typeof launch>;
    executionEnds.push({ lane, execution: run.execution, session: run.session, workflowEnd: finishedAt[ticket] ?? 0, stage: null, waitingFor: "nothing", cost: ticket === "LOCAL-033" ? 7.18 : 10.94 });
  }

  // Integration: the tick after each merge, the plan sees the merge commit on main.
  const mergedAt = (ticket: string): number => {
    const e = rec.stageChanges.find((x) => x.ticket === ticket && x.to === "merged");
    if (!e) throw new Error(`${ticket} never merged`);
    return e.t;
  };
  const integrate = (slice: string): number => {
    const ticket = TICKETS[slice] ?? slice;
    const tick = tickAfter(mergedAt(ticket));
    rec.emit(tick + 600, "slice.integrated", { commit: sha40(`${ticket}-merge`) }, sliceEnv(slice));
    return tick;
  };
  integrate("SLICE-023");
  const unblockTick = integrate("SLICE-021");

  // SLICE-024 becomes eligible and is dispatched on the same tick.
  rec.emit(unblockTick + 700, "dependency.resolved", { depends_on: ["SLICE-021"] }, sliceEnv("SLICE-024"));
  dispatch("SLICE-024", unblockTick + 1000);
  rec.emit(unblockTick + 1900, "dependency.blocked", { reasons: ["It waits for SLICE-022 to be integrated (now active).", "It waits for SLICE-024 to be integrated (now active)."] }, sliceEnv("SLICE-025"));
  const reminders = laneOf("SLICE-024");
  const remindersRun = launch(reminders, unblockTick + 2200, "spec-ready", "plan");
  decisions.push({ t: unblockTick + 3400, data: { state: "supervised", dispatched: ["SLICE-024"], started: ["LOCAL-034"], held: [] } });
  {
    let t = startWorkflow(reminders, remindersRun.workflowAt, remindersRun.session, remindersRun.started);
    const c = CONTENT["LOCAL-034"];
    if (!c) throw new Error("No content for LOCAL-034");
    const suite: Suite = { passing: BASELINE_TESTS + main.merges.reduce((sum, m) => sum + m.tests, 0), pending: 0 };
    t = next(reminders, t, { action: "plan", stage: "spec-ready", reason: "The spec is ready; contracts and the plan are not written yet.", model: "opus" });
    t = leave(reminders, plan(reminders, t, c), "plan", "done", "Contracts committed; plan checked.");
    t = next(reminders, t + 800, { action: "build", stage: "planned", reason: "Groomed and cleared to build." });
    build(reminders, t, c, suite, 3); // the scenario ends while this builder is at work
  }

  // ------------------------------------------------------------ the person at the gate, then the last merge
  const approvalAt = gateTick + 4 * 60 * S + 27 * S;
  approveByPerson(high, approvalAt, "Checked the idempotency key handling against the processor's retry rules. OK to ship.");
  const mergeTick = tickAfter(approvalAt + 600);
  const second = launch(high, mergeTick + 1800, "approved", "merge");
  decisions.push({ t: mergeTick + 3000, data: { state: "supervised", dispatched: [], started: ["LOCAL-032"], held: [] } });
  highAt = startWorkflow(high, second.workflowAt, second.session, second.started);
  const highEnd = toFinish(high, highAt);
  executionEnds.push({ lane: high, execution: second.execution, session: second.session, workflowEnd: highEnd, stage: null, waitingFor: "nothing", cost: 1.37 });
  const lastTick = integrate("SLICE-022");
  rec.emit(lastTick + 1500, "dependency.blocked", { reasons: ["It waits for SLICE-024 to be integrated (now active)."] }, sliceEnv("SLICE-025"));

  // ------------------------------------------------------------ the supervisor's tick-bound records
  for (const end of executionEnds) {
    const tick = tickAfter(end.workflowEnd + 4 * S);
    end.lane.rec.emit(tick + 200, "execution.completed", {
      stage: end.stage,
      next: "stop",
      waiting_for: end.waitingFor,
      how: "exited",
      seen_to_end: true,
      cost_usd: end.cost,
      session_id: end.session,
      refused_tools: [],
    }, sliceEnv(end.lane.slice, { execution_id: end.execution, refs: { cell: `.factory/worktrees/${end.lane.ticket}/cell.json`, execution: `.factory/local/executions/${end.execution}/` } }));
  }
  decisions.sort((a, b) => a.t - b.t);
  decisions.forEach((d, i) => {
    rec.emit(d.t, "scheduling.decided", d.data, { source: "supervisor" });
    // A decision that differs from the last is recorded once; the next quiet tick records the change back to nothing.
    const quiet = tickAfter(d.t) + 3000;
    const following = decisions[i + 1];
    if (!following || following.t > quiet) rec.emit(quiet, "scheduling.decided", { state: "supervised", dispatched: [], started: [], held: [] }, { source: "supervisor" });
  });

  const provisional = rec.build();
  const lastT = provisional[provisional.length - 1]?.t ?? 0;
  observeStages(rec, archivedAt, lastT);

  const events = rec.build();
  const end = events[events.length - 1]?.t ?? 0;
  return {
    id: "m6-living-factory-wave-007",
    title: "WAVE-007 through the Factory (simulation)",
    startAt: SCENARIO_START,
    duration: end + TAIL,
    events,
    definitions: DEFINITIONS,
    chapters: chaptersOf(events),
  };
}

/** supervisor.observe: on every tick, each live cell whose stage differs from what was last seen. */
function observeStages(rec: Recorder, archivedAt: Record<string, number>, until: number): void {
  const seen: Record<string, CellStage> = {};
  const changes = [...rec.stageChanges].sort((a, b) => a.t - b.t);
  for (let tick = TICK0; tick <= until; tick += PERIOD) {
    const at = tick + 800;
    const current: Record<string, (typeof changes)[number]> = {};
    for (const change of changes) if (change.t <= at) current[change.ticket] = change;
    for (const [ticket, change] of Object.entries(current)) {
      if ((archivedAt[ticket] ?? Infinity) <= at) continue;
      if (seen[ticket] === change.to) continue;
      rec.emit(at, "station.observed", { from_stage: seen[ticket] ?? null, stage: change.to }, {
        source: "supervisor",
        wave_id: change.wave,
        slice_id: change.slice,
        revision: WAVE.revision,
        ticket_id: ticket,
        refs: { cell: `.factory/worktrees/${ticket}/cell.json` },
      });
      seen[ticket] = change.to;
    }
  }
}

function chaptersOf(events: readonly AnySimEvent[]): Chapter[] {
  const find = (pred: (e: AnySimEvent) => boolean): AnySimEvent | undefined => events.find(pred);
  const specs: Array<{ id: string; title: string; summary: string; pred: (e: AnySimEvent) => boolean; focus: (e: AnySimEvent) => Chapter["focus"] }> = [
    { id: "enabled", title: "The Factory is enabled", summary: `${PEOPLE.engineer} enables supervised autonomy: three cells at once, merging allowed.`, pred: (e) => e.type === "factory.activated", focus: () => null },
    { id: "wave", title: "An approved wave arrives", summary: `${WAVE.id}, five invoicing slices approved by ${PEOPLE.productManager}, becomes five tickets.`, pred: (e) => e.type === "wave.discovered", focus: () => `wave:${WAVE.id}` },
    { id: "dispatch", title: "Three cells start", summary: "The scheduler dispatches the three slices that depend on nothing; SLICE-024 and SLICE-025 wait.", pred: (e) => e.type === "work.scheduled", focus: () => `wave:${WAVE.id}` },
    { id: "plan", title: "Contracts and plans", summary: "A contract engineer in each cell writes the boundary contracts and a test-first plan.", pred: (e) => e.type === "agent.started" && e.data.role === "contract-engineer", focus: (e) => (e.ticket_id ? `cell:${e.ticket_id}` : null) },
    { id: "build", title: "Test-first construction", summary: "Builders work task by task: a failing test committed, then the code that makes the suite pass.", pred: (e) => e.type === "task.red", focus: (e) => (e.ticket_id ? `cell:${e.ticket_id}` : null) },
    { id: "verify", title: "Verification", summary: "Fresh verifiers prove every scenario and matrix rule with their own data and capture evidence.", pred: (e) => e.type === "verification.started", focus: (e) => (e.ticket_id ? `cell:${e.ticket_id}` : null) },
    { id: "verify-fail", title: "R4 fails: back to build", summary: "LOCAL-031 lists an invoice due today as overdue. The verdict sends it back for round 2.", pred: (e) => e.type === "verification.verdict" && e.data.status === "FAIL_WITH_EVIDENCE", focus: (e) => (e.ticket_id ? `gate:${e.ticket_id}/verification#${e.type === "verification.verdict" ? e.data.round : 1}` : null) },
    { id: "review", title: "Review panels", summary: "Three fresh reviewers per cell, one per seat, vote through their findings.", pred: (e) => e.type === "review.started", focus: (e) => (e.ticket_id ? `cell:${e.ticket_id}` : null) },
    { id: "blocker", title: "A security blocker", summary: "The security seat rejects LOCAL-032: a timed-out charge could charge a card twice.", pred: (e) => e.type === "review.decided" && e.data.outcome === "REJECTED", focus: (e) => (e.ticket_id ? `gate:${e.ticket_id}/review#1` : null) },
    { id: "integrate", title: "First work lands", summary: "LOCAL-033 merges into main; nothing to revalidate.", pred: (e) => e.type === "merge.completed", focus: (e) => (e.ticket_id ? `cell:${e.ticket_id}` : null) },
    { id: "human-gate", title: "A person must approve", summary: "LOCAL-032 passes its delta review; as High risk it stops for a person.", pred: (e) => e.type === "review.decided" && e.data.outcome === "AWAITING_HUMAN", focus: (e) => (e.ticket_id ? `gate:${e.ticket_id}/human-approval` : null) },
    { id: "unblocked", title: "SLICE-024 is free to start", summary: "SLICE-021 is integrated, so SLICE-024 becomes eligible and is dispatched.", pred: (e) => e.type === "dependency.resolved" && e.slice_id === "SLICE-024", focus: () => "dependency:SLICE-024->SLICE-021" },
    { id: "approved", title: `${PEOPLE.approver} approves`, summary: "The person signs off; the supervisor starts a new execution to merge.", pred: (e) => e.type === "human.approval_recorded", focus: (e) => (e.ticket_id ? `gate:${e.ticket_id}/human-approval` : null) },
    { id: "last-merge", title: "Revalidated and merged", summary: "Main moved twice since approval: LOCAL-032 is revalidated on top of it and lands.", pred: (e) => e.type === "merge.completed" && e.ticket_id === "LOCAL-032", focus: () => "cell:LOCAL-032" },
  ];
  const chapters: Chapter[] = [];
  for (const spec of specs) {
    const event = find(spec.pred);
    if (!event) throw new Error(`Chapter ${spec.id} has no event`);
    chapters.push({ id: spec.id, title: spec.title, summary: spec.summary, t: event.t, seq: event.seq, focus: spec.focus(event) });
  }
  return chapters.sort((a, b) => a.t - b.t);
}
