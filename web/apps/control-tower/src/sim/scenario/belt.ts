/**
 * How one execution of the mach:belt Dynamic Workflow moves a cell, step by step, as the real
 * workflows/belt.js does: a Haiku clerk asks run.py what is next, the belt starts the worker it
 * names, and the station scripts (build.py, verify.py, review.py, merge.py, cleanup.py) decide.
 * Every function takes a start time and returns when it finished, so the story can lay cells side
 * by side.
 */
import type { Handle, ArtifactSpec, Lane } from "./recorder";
import { sha40 } from "./recorder";
import type { CellContent, FindingSpec, TaskSpec } from "./content";
import { PEOPLE } from "./content";
import type { AgentRole, BeltPhase, CellStage, Effort, ModelId, ReviewSeat, Risk, StationId, StepAction, ToolName } from "../vocabulary";
import { ACTION_STATION, AGENT_TYPES, MAX_ROUNDS, MODELS, PANELS } from "../vocabulary";
import type { StationOutcome } from "../events";

const S = 1000;
const M = 60 * S;
const RUN = "run.py";
const TEST_CMD = "pnpm test";

/** belt.js PHASE: the workflow phase each step's worker runs in. */
const PHASE: Record<StepAction, BeltPhase> = {
  audit: "Preflight",
  groom: "Groom",
  plan: "Groom",
  build: "Build",
  revise: "Build",
  verify: "Verify",
  review: "Review",
  merge: "Wrap up",
  cleanup: "Wrap up",
  stop: "Preflight",
};

export interface AgentSpec {
  role: AgentRole;
  label: string;
  model: ModelId;
  effort: Effort;
  phase: BeltPhase;
  station: StationId | null;
  seat?: ReviewSeat | null;
  parent?: AgentRun | null;
}

/** One agent's run: its own clock, its tool calls, and what it wrote. */
export class AgentRun {
  readonly lane: Lane;
  readonly id: string;
  readonly started: Handle;
  t: number;

  constructor(lane: Lane, spec: AgentSpec, t: number, cause: Handle | null = null) {
    this.lane = lane;
    this.id = lane.nextAgentId();
    this.t = t;
    this.started = lane.ev(
      t,
      "agent.started",
      {
        agent_id: this.id,
        role: spec.role,
        agent_type: AGENT_TYPES[spec.role] ?? null,
        seat: spec.seat ?? null,
        tier: MODELS[spec.model].tier,
        model: spec.model,
        effort: spec.effort,
        label: spec.label,
        parent_agent_id: spec.parent?.id ?? null,
        phase: spec.phase,
        station: spec.station,
      },
      cause,
    );
    this.t += 1200;
  }

  /**
   * A tool call of `ms` milliseconds. `inside` runs between start and finish, so facts the call
   * produced (a test run, a commit) can be recorded just before it returns.
   */
  tool(tool: ToolName, target: string, ms: number, opts: { summary?: string; ok?: boolean; gap?: number } = {}, inside?: (end: number, call: { id: string; started: Handle }) => void): { start: number; end: number; finished: Handle; callId: string } {
    const callId = this.lane.nextCallId();
    const start = this.t;
    const end = start + ms;
    const started = this.lane.ev(start, "tool.started", { call_id: callId, agent_id: this.id, tool, target }, this.started);
    inside?.(end, { id: callId, started });
    const finished = this.lane.ev(end, "tool.finished", { call_id: callId, agent_id: this.id, ok: opts.ok ?? true, summary: opts.summary ?? "" }, started);
    this.t = end + (opts.gap ?? 1500);
    return { start, end, finished, callId };
  }

  /** A file the agent writes or edits itself. */
  write(tool: "Write" | "Edit", spec: ArtifactSpec, ms: number): void {
    this.tool(tool, spec.path, ms, { summary: tool === "Write" ? "File created" : "File updated" }, (end, call) => {
      this.lane.writeArtifact(end - 100, spec, { agent_id: this.id, call_id: call.id, script: null }, call.started);
    });
  }

  /** An artifact a station script writes while this agent's Bash call runs it. */
  scriptArtifact(at: number, spec: ArtifactSpec, call: { id: string; started: Handle }, script: string): Handle {
    return this.lane.writeArtifact(at, spec, { agent_id: this.id, call_id: call.id, script }, call.started);
  }

  think(ms: number): void {
    this.t += ms;
  }

  /**
   * Work that takes `ms` in all: the agent reasons in short stretches between quick tool calls, as a
   * model does, rather than going silent for minutes.
   */
  work(ms: number, calls: ReadonlyArray<readonly [ToolName, string]>): void {
    const callMs = 2600;
    const thinking = Math.max(0, ms - calls.length * (callMs + 1500));
    const chunk = thinking / (calls.length + 1);
    calls.forEach(([tool, target], i) => {
      this.think(chunk);
      this.tool(tool, target, callMs + ((target.length + i) % 5) * 400, { summary: tool === "Grep" ? "matches found" : tool === "Bash" ? "ok" : "" });
    });
    this.think(chunk);
  }

  finish(summary: string, outcome: "done" | "error" = "done"): number {
    this.lane.ev(this.t, "agent.finished", { agent_id: this.id, outcome, summary }, this.started);
    return this.t;
  }
}

// ---------------------------------------------------------------- the workflow around a ticket

export interface Answer {
  action: StepAction;
  reason: string;
  stage: CellStage | null;
  model?: ModelId | null;
  needs?: string;
}

/** A clerk relay: one run.py command, one JSON answer (belt.js clerk()). */
export function clerk(lane: Lane, t: number, label: string, command: string, phase: BeltPhase, summary: string, ms = 4200, inside?: (end: number, call: { id: string; started: Handle }, agent: AgentRun) => void): { end: number; finished: Handle } {
  const agent = new AgentRun(lane, { role: "clerk", label, model: "haiku", effort: "low", phase, station: null }, t);
  const call = agent.tool("Bash", `${RUN} ${command}`, ms, { summary, gap: 900 }, inside ? (end, c) => inside(end, c, agent) : undefined);
  const end = agent.finish(summary);
  return { end, finished: call.finished };
}

/** The workflow starts for one ticket: belt.js preflight (locate run.py, check the project, read the board). */
export function startWorkflow(lane: Lane, t: number, sessionId: string, cause: Handle): number {
  lane.ev(t, "workflow.started", { workflow: "mach:belt", args: [lane.ticket], until: null, phases: ["Preflight", "Groom", "Build", "Verify", "Review", "Wrap up", "Learn"], session_id: sessionId }, cause);
  lane.ev(t + 200, "workflow.phase", { workflow: "mach:belt", phase: "Preflight" });
  const locate = new AgentRun(lane, { role: "clerk", label: "locate the belt script", model: "haiku", effort: "low", phase: "Preflight", station: null }, t + 600);
  locate.tool("Bash", "pwd", 900, { summary: "project folder" });
  locate.tool("Skill", "mach:run where", 3800, { summary: "run_script, python" });
  let at = locate.finish("run.py located");
  at = clerk(lane, at + 400, "check the project", "where", "Preflight", "is_mach_project: true", 2600).end;
  at = clerk(lane, at + 400, "read the board", "board --headless", "Preflight", "audit_state: ok (Gold, 94); observe_due: false", 5200).end;
  return at + 600;
}

/** "What next?": a clerk runs run.py next; for work, the cell enters the station it names. */
export function next(lane: Lane, t: number, answer: Answer): number {
  const summary = answer.action === "stop" ? `stop: ${answer.needs ?? "nothing"}` : `${answer.action}: ${answer.reason}`;
  const asked = clerk(lane, t, `${lane.ticket}: what next?`, `next ${lane.ticket} --headless`, "Preflight", summary);
  let at = asked.end + 500;
  const station = answer.action === "stop" ? (answer.needs === "human-approval" ? "human-approval" : null) : ACTION_STATION[answer.action];
  if (station) {
    if (answer.action !== "stop") lane.ev(at, "workflow.phase", { workflow: "mach:belt", phase: PHASE[answer.action] });
    lane.station = station;
    lane.ev(
      at + 100,
      "station.entered",
      {
        station,
        action: answer.action,
        stage: answer.stage,
        round: lane.round,
        reason: answer.reason,
        agent_type: answer.action === "build" || answer.action === "revise" ? AGENT_TYPES.builder ?? null : answer.action === "verify" ? AGENT_TYPES.verifier ?? null : null,
        model: answer.model ?? null,
      },
      asked.finished,
    );
    at += 600;
  }
  return at;
}

export function leave(lane: Lane, t: number, action: StepAction, outcome: StationOutcome, note: string): number {
  const station = lane.station;
  if (station) lane.ev(t, "station.left", { station, action, outcome, stage: lane.stage, note });
  lane.station = null;
  return t + 400;
}

// ---------------------------------------------------------------- plan (intent stage 2)

export function plan(lane: Lane, t: number, c: CellContent): number {
  const worker = new AgentRun(lane, { role: "intent", label: `${lane.ticket}: plan`, model: "opus", effort: "high", phase: "Groom", station: "plan" }, t);
  worker.tool("Skill", `mach:intent ${lane.ticket} --headless`, 2600, { summary: "intent skill loaded" });
  worker.tool("Bash", `cell.py status ${lane.ticket}`, 2100, { summary: "stage spec-ready, 0 open questions" });
  const spawnAt = worker.t;
  const engineer = new AgentRun(lane, { role: "contract-engineer", label: `${lane.ticket}: contract engineer`, model: "opus", effort: "high", phase: "Groom", station: "plan", parent: worker }, spawnAt + 1500);
  engineer.tool("Read", "references/contracts-and-plan.md", 2400);
  engineer.tool("Read", "spec.json", 3100, { summary: "requirements, invariants, scenarios, matrix" });
  engineer.tool("Glob", c.contracts[0]?.path.startsWith("api/") ? "api/openapi/*.yaml" : "proto/**/*.proto", 1300, { summary: "existing contracts" });
  for (const contract of c.contracts) {
    if (contract.existing) engineer.tool("Read", contract.path, 2600);
    engineer.work(38 * S, [["Grep", "message .*Request"], ["Read", "spec.json"]]);
    engineer.write(contract.existing ? "Edit" : "Write", { kind: "contract", path: contract.path, label: contract.path.split("/").pop() ?? contract.path, summary: contract.summary }, 3400);
  }
  engineer.work(52 * S, [["Read", "references/contracts-and-plan.md"], ["Grep", "FR-0|INV-0|AC-0"], ["Read", c.contracts[0]?.path ?? "spec.json"]]);
  engineer.write("Write", { kind: "plan", path: "plan.md", label: "plan.md", summary: `${c.tasks.length} tasks, test-first; touch map for ${new Set(c.tasks.flatMap((x) => x.files)).size} files` }, 4100);
  engineer.tool("Bash", `cell.py check-plan ${lane.ticket}`, 3200, { summary: "PLANNED (self-check)" });
  const engineerDone = engineer.finish(`Contracts and a ${c.tasks.length}-task test-first plan written.`);
  // The intent skill does not take the engineer's word: it runs the gate itself.
  worker.tool("Agent", "mach:contract-engineer", engineerDone + 600 - spawnAt, { summary: "contract engineer reported" });
  const changesExisting = c.contracts.some((x) => x.existing);
  worker.tool("Bash", `cell.py check-plan ${lane.ticket}`, 3600, { summary: "PLANNED" }, (end, call) => {
    lane.ev(end - 400, "gate.checked", {
      gate: "plan-check",
      passed: true,
      detail: `Every requirement and scenario is assigned to a task, tests come before implementation, and ${c.contracts.length} contract(s) exist.` + (changesExisting ? " An existing contract changes, so the ticket is High risk." : ""),
      tier: null,
      score: null,
    }, call.started);
    worker.scriptArtifact(end - 300, { kind: "commit", path: `feature/${lane.ticket}`, id: `${lane.ticket}:commit:${sha40(`${lane.ticket}-contracts`).slice(0, 7)}`, label: `contract(${lane.slice}): boundary contracts [${lane.ticket}]`, summary: c.contracts.map((x) => x.path).join(", "), sha: sha40(`${lane.ticket}-contracts`) }, call, "cell.py check-plan");
    lane.setStage(end - 200, "planned", "cell.py check-plan", call.started);
  });
  return worker.finish("Stage 2 done: contracts committed, plan checked.");
}

// ---------------------------------------------------------------- build (TDD)

export interface Suite {
  /** Tests passing on the cell's branch. */
  passing: number;
  /** New tests written but not yet passing. */
  pending: number;
}

function commitSpec(lane: Lane, task: TaskSpec, prefix: string): ArtifactSpec {
  const sha = sha40(`${lane.ticket}-${task.id}-${lane.round}`);
  return {
    kind: "commit",
    path: `feature/${lane.ticket}`,
    id: `${lane.ticket}:commit:${sha.slice(0, 7)}`,
    label: `${prefix}(${lane.slice}): ${task.id} ${task.text.replace(/\s*\((?:[A-Z]+-\d+|R\d+)(?:,\s*(?:[A-Z]+-\d+|R\d+))*\)\s*$/, "").slice(0, 64)} [${lane.ticket}]`,
    summary: task.files.join(", "),
    sha,
  };
}

function runTask(lane: Lane, builder: AgentRun, task: TaskSpec, suite: Suite, loop: number): void {
  builder.tool("Bash", `build.py next ${lane.ticket}`, 1800, { summary: `${task.id} [${task.kind}]` }, (end, call) => {
    lane.ev(end - 200, "task.started", { task_id: task.id, kind: task.kind, text: task.text, files: task.files, ids: task.ids, loop }, call.started);
  });
  for (const file of task.reads ?? []) builder.tool("Read", file, 1600 + (file.length % 7) * 300);
  const main = task.files[0] ?? "";
  const neighbour = main.replace(/\.test\.(tsx?)$/, ".$1");
  builder.work(task.minutes * 0.55 * M, [
    ["Grep", task.ids[0] ?? task.id],
    ["Read", task.kind === "test" ? neighbour : main.replace(/\.(tsx?)$/, ".test.$1")],
    ["Glob", main.slice(0, main.lastIndexOf("/") + 1) + "*"],
    ["Read", "spec.json"],
  ]);
  task.files.forEach((file, i) => {
    const existing = task.kind === "impl" && (file.endsWith("routes.ts") || file.endsWith("schedule.ts") || i > 0 || loop > 0);
    // Source files are not artifacts of the line; the commit that build.py makes from them is.
    builder.tool(existing || (task.kind === "test" && loop > 0) ? "Edit" : "Write", file, 2400 + i * 900, { summary: "File written" });
  });
  builder.work(task.minutes * 0.25 * M, [
    ["Edit", main],
    ["Bash", "git diff --stat"],
  ]);
  const seconds = 38 + ((suite.passing + task.id.length) % 9);
  const prefix = task.kind === "test" ? "test" : task.kind === "impl" ? "feat" : task.kind === "contract" ? "chore" : task.kind;
  const step = task.kind === "test" ? "red" : task.kind === "impl" ? "green" : "done";
  builder.tool("Bash", `build.py ${step} ${lane.ticket} ${task.id}`, seconds * S + 2600, { summary: step === "red" ? "RED: suite fails with the new tests; committed" : step === "green" ? "GREEN: suite passes; committed" : "DONE: suite still green; committed" }, (end, call) => {
    const spec = commitSpec(lane, task, prefix);
    if (task.kind === "test") {
      const added = task.tests ?? 3;
      suite.pending += added;
      lane.ev(end - 500, "test.result", { context: "red", command: TEST_CMD, passed: suite.passing, failed: suite.pending, skipped: 0, seconds, exit_code: 1, task_id: task.id }, call.started);
      builder.scriptArtifact(end - 300, spec, call, "build.py red");
      lane.ev(end - 200, "task.red", { task_id: task.id, commit: spec.sha ?? "", test_file: task.files[0] ?? "", failing: suite.pending, note: `${added} new test(s) fail as expected.` }, call.started);
    } else if (task.kind === "impl") {
      suite.passing += suite.pending;
      suite.pending = 0;
      lane.ev(end - 500, "test.result", { context: "green", command: TEST_CMD, passed: suite.passing, failed: 0, skipped: 0, seconds, exit_code: 0, task_id: task.id }, call.started);
      builder.scriptArtifact(end - 300, spec, call, "build.py green");
      lane.ev(end - 200, "task.green", { task_id: task.id, commit: spec.sha ?? "", passed: suite.passing, note: "Suite green." }, call.started);
    } else {
      lane.ev(end - 500, "test.result", { context: "done", command: TEST_CMD, passed: suite.passing, failed: 0, skipped: 0, seconds, exit_code: 0, task_id: task.id }, call.started);
      builder.scriptArtifact(end - 300, spec, call, "build.py done");
      lane.ev(end - 200, "task.done", { task_id: task.id, commit: spec.sha ?? "", note: "Suite still green." }, call.started);
    }
  });
}

/** A first build: start (audit gate and baseline), every task in plan order, finish. */
export function build(lane: Lane, t: number, c: CellContent, suite: Suite, stopAfterTasks?: number): number {
  const builder = new AgentRun(lane, { role: "builder", label: `${lane.ticket}: build`, model: "sonnet", effort: "high", phase: "Build", station: "build" }, t);
  builder.tool("Skill", `mach:build ${lane.ticket}`, 2400, { summary: "build skill loaded" });
  builder.tool("Bash", `build.py start ${lane.ticket}`, 49 * S, { summary: `baseline green: ${suite.passing} passed` }, (end, call) => {
    lane.ev(end - 900, "gate.checked", { gate: "audit", passed: true, detail: "Readiness report is current for this commit: Gold (94/100). Building may start.", tier: "Gold", score: 94 }, call.started);
    lane.ev(end - 600, "test.result", { context: "baseline", command: TEST_CMD, passed: suite.passing, failed: 0, skipped: 0, seconds: 44, exit_code: 0, task_id: null }, call.started);
    builder.scriptArtifact(end - 400, { kind: "build-state", path: "build.json", label: "build.json", summary: `${c.tasks.length} tasks; suite green at baseline` }, call, "build.py start");
    lane.setStage(end - 200, "building", "build.py start", call.started);
  });
  builder.tool("Read", "plan.md", 1900);
  builder.tool("Read", "spec.json", 2300);
  const tasks = stopAfterTasks === undefined ? c.tasks : c.tasks.slice(0, stopAfterTasks);
  for (const task of tasks) runTask(lane, builder, task, suite, 0);
  if (stopAfterTasks !== undefined) return builder.t; // still building when the scenario ends
  return finishBuild(lane, builder, c, suite, `Built ${c.tasks.length} tasks; ${suite.passing} tests pass.`);
}

function finishBuild(lane: Lane, builder: AgentRun, c: CellContent, suite: Suite, summary: string): number {
  builder.tool("Bash", `build.py finish ${lane.ticket}`, 58 * S, { summary: "BUILT: suite and lint green; build-report.json written" }, (end, call) => {
    lane.ev(end - 600, "test.result", { context: "finish", command: TEST_CMD, passed: suite.passing, failed: 0, skipped: 0, seconds: 46, exit_code: 0, task_id: null }, call.started);
    builder.scriptArtifact(end - 400, { kind: "build-report", path: "build-report.json", label: "build-report.json", summary: `${c.tasks.length} tasks, every FR, INV and AC named by a test; lint clean` }, call, "build.py finish");
    lane.setStage(end - 200, "built", "build.py finish", call.started);
  });
  return builder.finish(summary);
}

/** A revision round after a failed verification or a rejected review. */
export function revise(lane: Lane, t: number, c: CellContent, suite: Suite, because: "verification" | "review", findingsPath: string): number {
  const builder = new AgentRun(lane, { role: "builder", label: `${lane.ticket}: revise`, model: "sonnet", effort: "high", phase: "Build", station: "build" }, t);
  builder.tool("Skill", `mach:build ${lane.ticket}`, 2200, { summary: "build skill loaded" });
  const loop = lane.round; // the failed round number becomes the loop
  builder.tool("Bash", `build.py revise ${lane.ticket} --findings ${findingsPath}`, 3100, { summary: `REVISING: round ${loop + 1} of ${MAX_ROUNDS}` }, (end, call) => {
    lane.round = loop + 1;
    lane.ev(end - 500, "build.revised", { loop, round: loop + 1, rounds_left: MAX_ROUNDS - loop - 1, findings: `review-findings-${loop}.md`, because }, call.started);
    builder.scriptArtifact(end - 400, { kind: "findings-copy", path: `review-findings-${loop}.md`, label: `review-findings-${loop}.md`, summary: `Copied from ${findingsPath}` }, call, "build.py revise");
    lane.setStage(end - 200, "building", "build.py revise", call.started);
  });
  builder.tool("Read", `review-findings-${loop}.md`, 2100);
  for (const task of c.revise?.tasks ?? []) {
    builder.tool("Bash", `build.py add-task ${lane.ticket} --kind ${task.kind} --file ${task.files[0]}`, 1700, { summary: `ADDED ${task.id}` });
  }
  for (const task of c.revise?.tasks ?? []) runTask(lane, builder, task, suite, loop);
  return finishBuild(lane, builder, c, suite, `Revision ${loop}: ${(c.revise?.tasks ?? []).length} tasks; findings addressed.`);
}

// ---------------------------------------------------------------- verify

export function verify(lane: Lane, t: number, c: CellContent, suite: Suite): { end: number; passed: boolean } {
  const round = lane.round;
  const verifier = new AgentRun(lane, { role: "verifier", label: `${lane.ticket}: verify`, model: "sonnet", effort: "medium", phase: "Verify", station: "verify" }, t);
  const head = sha40(`${lane.ticket}-head-${round}`);
  verifier.tool("Skill", `mach:verify ${lane.ticket}`, 2300, { summary: "verify skill loaded" });
  verifier.tool("Bash", `verify.py start ${lane.ticket}`, 54 * S, { summary: `${c.targets.length} targets; suite green; contracts match` }, (end, call) => {
    lane.ev(end - 800, "test.result", { context: "verify", command: TEST_CMD, passed: suite.passing, failed: 0, skipped: 0, seconds: 45, exit_code: 0, task_id: null }, call.started);
    verifier.scriptArtifact(end - 700, { kind: "evidence", path: "evidence/test-suite.log", label: "test-suite.log", summary: `${suite.passing} passed` }, call, "verify.py start");
    verifier.scriptArtifact(end - 600, { kind: "evidence", path: "evidence/contract-check.log", label: "contract-check.log", summary: `${c.contracts.length} contract(s) unchanged since build` }, call, "verify.py start");
    verifier.scriptArtifact(end - 500, { kind: "verification-results", path: "evidence/results.json", label: "results.json", summary: "started; no records yet" }, call, "verify.py start");
    lane.ev(end - 300, "verification.started", {
      round,
      app_type: "web",
      head,
      targets: c.targets.map((x) => ({ id: x.id, kind: x.kind, title: x.title })),
      required_evidence: ["screenshot (*.png, *.jpg, *.jpeg)", "recording of the flow (*.webm, *.mp4, *.mov, *.gif, *trace*.zip)"],
    }, call.started);
  });
  verifier.tool("Read", "spec.json", 2200);
  verifier.tool("Bash", "pnpm dev --port 4310", 8600, { summary: "app ready on 127.0.0.1:4310" });
  verifier.write("Write", { kind: "evidence", path: "evidence/driver.spec.ts", label: "driver.spec.ts", summary: `Playwright driver for ${c.targets.length} checks, data chosen by the verifier` }, 3900);
  verifier.work(25 * S, [["Bash", "pnpm exec playwright test evidence/driver.spec.ts --list"]]);
  let failures = 0;
  c.targets.forEach((target, i) => {
    const fails = target.fail?.round === round;
    const files = [`evidence/${target.evidence}`];
    verifier.tool("Bash", `pnpm exec playwright test evidence/driver.spec.ts -g "${target.id}"`, (target.kind === "scenario" ? 24 : 15) * S + i * 700, { summary: fails ? "1 failed" : "1 passed", ok: true }, (end, call) => {
      verifier.scriptArtifact(end - 300, { kind: "evidence", path: files[0] ?? "", label: target.evidence, summary: fails ? target.fail?.note ?? "" : target.note, sha: sha40(`${lane.ticket}-${target.evidence}-${round}`) }, call, "playwright");
      if (i === 0) {
        files.push(`evidence/${c.recording}`);
        verifier.scriptArtifact(end - 200, { kind: "evidence", path: `evidence/${c.recording}`, label: c.recording, summary: "Recording of the flow", sha: sha40(`${lane.ticket}-${c.recording}-${round}`) }, call, "playwright");
      }
    });
    verifier.tool("Bash", `verify.py record ${lane.ticket} ${target.id} --result ${fails ? "fail" : "pass"}`, 2100, { summary: "RECORDED" }, (end, call) => {
      lane.ev(end - 200, "evidence.captured", {
        round,
        target_id: target.id,
        target_kind: target.kind,
        result: fails ? "fail" : "pass",
        evidence: files.map((f) => `${lane.ticket}:${f}`),
        note: fails ? target.fail?.note ?? "" : target.note,
      }, call.started);
    });
    if (fails) {
      failures++;
      verifier.think(20 * S);
    }
  });
  const passed = failures === 0;
  verifier.tool("Bash", `verify.py finish ${lane.ticket}`, 4200, { summary: passed ? "PASS" : "FAIL_WITH_EVIDENCE" }, (end, call) => {
    if (!passed) verifier.scriptArtifact(end - 600, { kind: "verification-findings", path: "evidence/findings.md", label: "findings.md", summary: c.targets.filter((x) => x.fail?.round === round).map((x) => `${x.id}: ${x.fail?.note}`).join(" ") }, call, "verify.py finish");
    verifier.scriptArtifact(end - 500, { kind: "verification-summary", path: "evidence/summary.json", label: "summary.json", summary: passed ? `PASS: ${c.targets.length} of ${c.targets.length} checks` : `FAIL_WITH_EVIDENCE: ${c.targets.length - failures} of ${c.targets.length} checks passed` }, call, "verify.py finish");
    lane.ev(end - 300, "verification.verdict", { round, status: passed ? "PASS" : "FAIL_WITH_EVIDENCE", checks_passed: c.targets.length - failures, checks_failed: failures, head, findings: passed ? null : "evidence/findings.md" }, call.started);
    if (passed) lane.setStage(end - 200, "verified", "verify.py finish", call.started);
  });
  const end = verifier.finish(passed ? `PASS: ${c.targets.length} of ${c.targets.length} checks proven.` : `FAIL_WITH_EVIDENCE: ${failures} check(s) failed.`);
  return { end, passed };
}

// ---------------------------------------------------------------- review

export interface ReviewResult {
  end: number;
  outcome: "APPROVED" | "AWAITING_HUMAN" | "REJECTED" | "ESCALATE";
}

export function review(lane: Lane, t: number, c: CellContent, risk: Risk, previousHead: string | null): ReviewResult {
  const round = lane.round;
  const rules = PANELS[risk];
  const model: ModelId = risk === "High" ? "opus" : "sonnet";
  const seats: ReviewSeat[] = rules.reviewers === 3 ? ["architecture", "security", "product"] : ["general"];
  const findings = c.findings[round] ?? [];
  const head = sha40(`${lane.ticket}-head-${round}`);
  const reasons = rules.human_approval ? [`the change is ${risk} risk`] : [];
  const blockerFilesBefore = previousHead ? (c.findings[round - 1] ?? []).filter((f) => f.severity === "blocker" && f.file).map((f) => f.file as string) : [];
  const delta = previousHead
    ? { since_commit: previousHead, files_changed: (c.revise?.tasks ?? []).flatMap((x) => x.files).filter((f, i, all) => all.indexOf(f) === i), earlier_blocker_files: blockerFilesBefore }
    : null;

  const seated = clerk(lane, t, `${lane.ticket}: seat the panel`, `review-start ${lane.ticket}`, "Review", `round ${round} of ${MAX_ROUNDS}; ${seats.length} seats on ${model}`, 5600, (end, call, agent) => {
    lane.ev(end - 500, "review.started", {
      round,
      max_rounds: MAX_ROUNDS,
      risk,
      approvals_needed: rules.approvals,
      human_approval_required: rules.human_approval,
      human_approval_reasons: reasons,
      panel: seats.map((role) => ({ role, model })),
      head,
      diff_stat: c.diffStat,
      delta,
    }, call.started);
    agent.scriptArtifact(end - 400, { kind: "review-packet", path: `review/round-${round}/packet.json`, label: `round-${round}/packet.json`, summary: `${risk} risk, ${rules.approvals} approval(s) needed` + (delta ? `; delta since ${delta.since_commit.slice(0, 7)}` : "") }, call, "review.py start");
    agent.scriptArtifact(end - 300, { kind: "review-diff", path: delta ? `review/round-${round}/delta.patch` : `review/round-${round}/diff.patch`, label: delta ? "delta.patch" : "diff.patch", summary: delta ? `${delta.files_changed.length} files changed since round ${round - 1}` : c.diffStat }, call, "review.py start");
  });

  // Every seat at once, each a fresh agent (belt.js review(): parallel(...)).
  let latest = seated.end;
  const votes: Partial<Record<ReviewSeat, "APPROVE" | "REJECT">> = {};
  let blockers = 0;
  seats.forEach((seat, i) => {
    const mine: FindingSpec[] = findings.filter((f) => f.seat === seat);
    const reviewer = new AgentRun(lane, { role: "reviewer", label: `${lane.ticket}: ${seat} reviewer`, model, effort: "high", phase: "Review", station: "review", seat }, seated.end + 300 + i * 450, seated.finished);
    reviewer.tool("Read", "references/reviewer-brief.md", 2200);
    reviewer.tool("Read", `references/${seat}.md`, 1900);
    reviewer.tool("Read", `review/round-${round}/packet.json`, 1600);
    reviewer.tool("Read", delta ? `review/round-${round}/delta.patch` : `review/round-${round}/diff.patch`, 4800 + i * 900);
    for (const file of c.reviewReads[seat] ?? []) reviewer.tool("Read", file, 2600 + file.length * 40);
    reviewer.tool("Grep", seat === "security" ? "retry|idempotency|query|params" : seat === "architecture" ? "import .* from" : "FR-0", 1400);
    reviewer.work((risk === "High" ? 95 : 70) * S + i * 11 * S, [
      ["Grep", seat === "product" ? "AC-0" : "INV-0"],
      ["Read", "spec.json"],
      ["Read", c.reviewReads[seat]?.[0] ?? "spec.json"],
    ]);
    reviewer.tool("Write", `review/round-${round}/${seat}-findings.json`, 2600, { summary: `${mine.length} finding(s)` });
    const vote: "APPROVE" | "REJECT" = mine.some((f) => f.severity === "blocker") ? "REJECT" : "APPROVE";
    votes[seat] = vote;
    blockers += mine.filter((f) => f.severity === "blocker").length;
    reviewer.tool("Bash", `review.py submit ${lane.ticket} --reviewer ${seat}`, 2400, { summary: `RECORDED: ${vote}` }, (end, call) => {
      mine.forEach((f, k) => {
        lane.ev(end - 600 + k * 50, "review.finding", { round, seat, finding_id: `${lane.ticket}/r${round}/${seat}/${k + 1}`, severity: f.severity, title: f.title, rule: f.rule, file: f.file }, call.started);
      });
      lane.ev(end - 300, "review.vote", { round, seat, vote, blockers: mine.filter((f) => f.severity === "blocker").length, notes: mine.filter((f) => f.severity === "note").length, model, head }, call.started);
      reviewer.scriptArtifact(end - 200, { kind: "vote", path: `review/round-${round}/votes/${seat}.json`, label: `votes/${seat}.json`, summary: vote }, call, "review.py submit");
    });
    latest = Math.max(latest, reviewer.finish(`${vote}: ${mine.filter((f) => f.severity === "blocker").length} blocker(s), ${mine.filter((f) => f.severity === "note").length} note(s).`));
  });

  const approvals = Object.values(votes).filter((v) => v === "APPROVE").length;
  const securityVeto = findings.some((f) => f.seat === "security" && f.severity === "blocker");
  const passed = approvals >= rules.approvals && !securityVeto;
  const outcome: ReviewResult["outcome"] = passed ? (rules.human_approval ? "AWAITING_HUMAN" : "APPROVED") : round >= MAX_ROUNDS ? "ESCALATE" : "REJECTED";
  const overruled = passed ? seats.filter((seat) => votes[seat] === "REJECT") : [];
  const tally = clerk(lane, latest + 800, `${lane.ticket}: tally`, `review-tally ${lane.ticket}`, "Review", `${outcome}: ${approvals} of ${seats.length} approve`, 3900, (end, call, agent) => {
    agent.scriptArtifact(end - 600, { kind: "review-findings", path: `review/round-${round}/findings.md`, label: `round-${round}/findings.md`, summary: `${outcome}. ${blockers} blocker(s)` + (overruled.length ? `, outvoted from ${overruled.join(", ")}` : "") }, call, "review.py tally");
    agent.scriptArtifact(end - 500, { kind: "decision", path: `review/round-${round}/decision.json`, label: `round-${round}/decision.json`, summary: outcome }, call, "review.py tally");
    lane.ev(end - 400, "review.decided", {
      round,
      outcome,
      approvals,
      approvals_needed: rules.approvals,
      votes,
      blockers,
      overruled_blockers_from: overruled,
      security_veto: securityVeto && approvals >= rules.approvals,
      head,
      findings: `review/round-${round}/findings.md`,
    }, call.started);
    const to: CellStage = outcome === "APPROVED" ? "approved" : outcome === "AWAITING_HUMAN" ? "awaiting-human" : outcome === "REJECTED" ? "built" : "blocked";
    lane.setStage(end - 200, to, "review.py tally", call.started);
  });
  return { end: tally.end, outcome };
}

// ---------------------------------------------------------------- human approval, merge, cleanup

export function approveByPerson(lane: Lane, t: number, note: string): number {
  const head = sha40(`${lane.ticket}-head-${lane.round}`);
  lane.rec.emit(t, "human.approval_recorded", { round: lane.round, by: PEOPLE.approver, note, head }, lane.env({ source: "engineer", execution_id: null }));
  lane.writeArtifact(t + 300, { kind: "decision", path: `review/round-${lane.round}/decision.json`, label: `round-${lane.round}/decision.json`, summary: `APPROVED by ${PEOPLE.approver}` }, { agent_id: null, call_id: null, script: "review.py approve-human" }, null);
  lane.setStage(t + 500, "approved", "review.py approve-human");
  if (lane.station === "human-approval") return leave(lane, t + 700, "stop", "approved", `Approved by ${PEOPLE.approver}.`);
  return t + 700;
}

export interface MainLine {
  head: string;
  tests: number;
  merges: Array<{ t: number; ticket: string; commit: string; tests: number }>;
}

export function merge(lane: Lane, t: number, title: string, suite: Suite, main: MainLine, branchedFrom: string): number {
  const worker = new AgentRun(lane, { role: "merge", label: `${lane.ticket}: merge`, model: "haiku", effort: "low", phase: "Wrap up", station: "merge" }, t);
  worker.tool("Skill", `mach:merge ${lane.ticket}`, 2100, { summary: "merge skill loaded" });
  worker.tool("Bash", `merge.py plan ${lane.ticket}`, 2400, { summary: "approval valid for the branch head; local merge into main" });
  const approved = sha40(`${lane.ticket}-head-${lane.round}`);
  const needed = main.head !== branchedFrom;
  const added = main.merges.reduce((sum, m) => sum + m.tests, 0);
  const total = suite.passing + added;
  const mergeCommit = sha40(`${lane.ticket}-merge`);
  worker.tool("Bash", `merge.py run ${lane.ticket}`, needed ? 63 * S : 5200, { summary: "MERGED" }, (end, call) => {
    if (needed) {
      const landed = sha40(`${lane.ticket}-revalidated`);
      worker.scriptArtifact(end - 1500, { kind: "commit", path: `feature/${lane.ticket}`, id: `${lane.ticket}:commit:${landed.slice(0, 7)}`, label: `Merge main into feature/${lane.ticket} before landing [${lane.ticket}]`, summary: `main at ${main.head.slice(0, 7)} brought in (${main.merges.map((m) => m.ticket).join(", ")})`, sha: landed }, call, "merge.py revalidate");
      lane.ev(end - 1300, "test.result", { context: "revalidate", command: TEST_CMD, passed: total, failed: 0, skipped: 0, seconds: 47, exit_code: 0, task_id: null }, call.started);
      lane.ev(end - 1100, "merge.revalidated", { needed: true, onto: main.head, head: landed, approved_commit: approved, tests: TEST_CMD, passed: total, seconds: 47, note: `main moved since approval (${main.merges.map((m) => m.ticket).join(", ")} landed); merged in and the suite passes, so the approval holds for the revalidated head.` }, call.started);
    } else {
      lane.ev(end - 1100, "merge.revalidated", { needed: false, onto: null, head: approved, approved_commit: approved, tests: TEST_CMD, passed: suite.passing, seconds: 0, note: "main has not moved since approval; the approved commit lands as it is." }, call.started);
    }
    worker.scriptArtifact(end - 600, { kind: "merge-commit", path: "main", id: `${lane.ticket}:merge:${mergeCommit.slice(0, 7)}`, label: `Merge ${lane.ticket}: ${lane.slice}: ${title}`, summary: `--no-ff into main`, sha: mergeCommit }, call, "merge.py run");
    lane.setStage(end - 400, "merged", "merge.py run", call.started);
    lane.ev(end - 300, "merge.completed", { method: "local", into: "main", merge_commit: mergeCommit, approved_commit: approved, landed_commit: needed ? sha40(`${lane.ticket}-revalidated`) : approved, revalidated: needed }, call.started);
  });
  main.head = mergeCommit;
  main.merges.push({ t: worker.t, ticket: lane.ticket, commit: mergeCommit, tests: suite.passing - main.tests });
  return worker.finish(`Merged into main as ${mergeCommit.slice(0, 7)}.`);
}

export function cleanup(lane: Lane, t: number, rounds: number): number {
  const worker = new AgentRun(lane, { role: "cleanup", label: `${lane.ticket}: cleanup`, model: "haiku", effort: "low", phase: "Wrap up", station: "cleanup" }, t);
  worker.tool("Skill", `mach:cleanup ${lane.ticket}`, 1900, { summary: "cleanup skill loaded" });
  worker.tool("Bash", `cleanup.py plan ${lane.ticket}`, 2600, { summary: "archive, then remove worktree and cell; delete local branch" });
  worker.tool("Bash", `cleanup.py run ${lane.ticket}`, 9800, { summary: "CLEANED" }, (end, call) => {
    worker.scriptArtifact(end - 600, { kind: "archive", path: `.factory/archive/${lane.ticket}.tar.gz`, id: `${lane.ticket}:archive`, label: `${lane.ticket}.tar.gz`, summary: "cell folder without repo/, checked before deletion" }, call, "cleanup.py run");
    worker.scriptArtifact(end - 500, { kind: "run-record", path: ".factory/archive/runs.jsonl", id: `${lane.ticket}:run-record`, label: "runs.jsonl line", summary: `merged in ${rounds} round(s)` }, call, "cleanup.py run");
    lane.ev(end - 300, "cleanup.completed", { archive: `.factory/archive/${lane.ticket}.tar.gz`, outcome: "merged", rounds, first_pass: rounds === 1, run_record: ".factory/archive/runs.jsonl" }, call.started);
  });
  return worker.finish("Archived and removed; run record appended.");
}

/** The belt's last steps: the final "what next?" said stop, then Learn, then the workflow returns. */
export function endWorkflow(lane: Lane, t: number, outcome: { stage: CellStage | ""; waiting_for: string }): number {
  lane.ev(t, "workflow.phase", { workflow: "mach:belt", phase: "Learn" });
  const asked = clerk(lane, t + 400, "is an observe pass due?", "board --headless", "Learn", "observe_due: false", 4800);
  lane.ev(asked.end + 300, "workflow.finished", { workflow: "mach:belt", tickets: [{ ticket: lane.ticket, outcome: "stopped", stage: outcome.stage, waiting_for: outcome.waiting_for }], learning: "no observe pass was due" }, asked.finished);
  return asked.end + 300;
}
