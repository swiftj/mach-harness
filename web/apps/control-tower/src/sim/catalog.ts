/**
 * The event catalog: every kind the fixture can contain, what it means, its payload, and whether a
 * real MACH Factory could supply it today.
 *
 * telemetry:
 * - "exists": MACH emits this event today, in .factory/intake/events.jsonl (intake.py Factory.emit).
 *   Only the 22 kinds of intake.EVENT_TYPES qualify.
 * - "derivable": no event, but the fact is on disk today and an observer could turn it into one
 *   without changing MACH: a station's own record (cell.json, build.json, evidence/*.json,
 *   review/round-N/*), Git, or an execution's stream.jsonl (kept whole, parsed only for its result).
 * - "missing": not recorded anywhere MACH or Claude Code is known to keep it.
 *
 * `missingFields` lists payload fields the simulation shows that the derivable source does not hold.
 * Reconciled with docs/mach-next/M6_0_TELEMETRY_GAPS.md (sections 2 to 4 and 8).
 */
import type { EventKind } from "./events";

export type Telemetry = "exists" | "derivable" | "missing";
/** How prominent the moment is: chapter openers, major beats, minor steps, ambient activity. */
export type Significance = "chapter" | "major" | "minor" | "ambient";

export interface CatalogEntry {
  readonly kind: EventKind;
  /** A kind MACH emits today (intake.EVENT_TYPES). */
  readonly real: boolean;
  readonly meaning: string;
  /** The `data` fields, briefly. */
  readonly payload: string;
  readonly telemetry: Telemetry;
  /** Where it is emitted (exists) or could be derived from (derivable), or why it is missing. File and function. */
  readonly source: string;
  readonly missingFields?: readonly string[];
  /** The telemetry analyst's proposed name for it, where section 6 of the gaps document proposes one. */
  readonly proposedAs?: string;
  readonly significance: Significance;
}

const real = (
  kind: EventKind,
  meaning: string,
  payload: string,
  source: string,
  significance: Significance,
  missingFields?: readonly string[],
): CatalogEntry => ({ kind, real: true, meaning, payload, telemetry: "exists", source, significance, ...(missingFields ? { missingFields } : {}) });

const sim = (
  kind: EventKind,
  telemetry: Exclude<Telemetry, "exists">,
  meaning: string,
  payload: string,
  source: string,
  significance: Significance,
  extra: { missingFields?: readonly string[]; proposedAs?: string } = {},
): CatalogEntry => ({ kind, real: false, meaning, payload, telemetry, source, significance, ...extra });

const ENTRIES: readonly CatalogEntry[] = [
  // ---------------------------------------------------------------- real: intake and scheduling
  real("wave.discovered", "An approved delivery wave was seen on the integration branch for the first time.", "slices, approval{actor, approved_at}; envelope wave_id, revision",
    "skills/run/scripts/intake.py Factory._intake", "chapter"),
  real("intake.validated", "The wave's source commit and every artifact passed verification.", "digest", "intake.py Factory._intake", "minor"),
  real("intake.refused", "Verification of approved product work failed; nothing was taken in.", "problems[]", "intake.py Factory._intake", "major"),
  real("slice.materialized", "An execution ticket now exists for a slice revision: the wave becoming tickets.", "digest, adopted, dependencies[]; envelope ticket_id",
    "intake.py Factory.materialize / reissue", "major"),
  real("slice.integrated", "The plan saw the slice's merge commit on the integration branch.", "commit",
    "intake.py Factory.record (stamped when the plan noticed, not when it merged)", "major"),
  real("dependency.resolved", "A slice became ready: everything it waits for is integrated. The slice is eligible.", "depends_on[] (IDs only)",
    "intake.py Factory.record (cause is never set, so it does not say which integration freed it)", "major", ["cause"]),
  real("dependency.blocked", "A slice is blocked, or its reasons changed.", "reasons[] (prose)",
    "intake.py Factory.record (capacity waits are filtered out)", "minor"),
  real("work.scheduled", "A slice was dispatched: its cell was opened and finalized to spec-ready.", "stage, risk, branch, by, authorization",
    "intake.py Factory.open_cell", "major"),
  real("revision.superseded", "A slice revision was replaced or withdrawn by product.", "from_revision, effect", "intake.py Factory._intake", "major"),
  real("human.required", "A person must decide something before the slice or ticket can move (here: the human approval gate is waiting).", "reason (prose)",
    "intake.py Factory.record / materialize; supervisor.py Supervisor.park, schedule (at the next recorded plan)", "major"),
  // ---------------------------------------------------------------- real: activation
  real("factory.activated", "The Factory was enabled on this machine by an engineer.", "autonomy, by, limits{...}, allow_merge, persistent, backlog, excluded_slices[]",
    "skills/run/scripts/activation.py enable (confirm)", "chapter"),
  real("factory.disabled", "Automatic execution was revoked on this machine.", "by, stopped", "activation.py change", "major"),
  real("factory.paused", "Dispatch and new starts are paused.", "by, reason", "activation.py change", "major"),
  real("factory.resumed", "The Factory resumed after a pause.", "by, retrying[]", "activation.py change", "major"),
  // ---------------------------------------------------------------- real: supervisor
  real("revision.discovered", "The ledger's product source commit changed during a supervisor tick.", "from_commit, commit; refs.integration_branch",
    "skills/run/scripts/supervisor.py Supervisor.once", "minor"),
  real("scheduling.decided", "What the supervisor dispatched, started or held this tick, once per distinct decision.", "state, dispatched[], started[], held[{slice_id|ticket_id, why}]",
    "supervisor.py Supervisor.decided (ready slices waiting for a place are not listed)", "major"),
  real("work.claimed", "An execution was reserved for a ticket, durably, before any process started.", "stage, next, attempt; envelope execution_id",
    "supervisor.py Supervisor.start", "minor"),
  real("execution.started", "The claude -p process for a claim is running; it launches the mach:belt workflow for the ticket.", "session_id, until, workflow, limits{minutes, budget_usd}",
    "supervisor.py Supervisor.start (stamped after the wrapper spawned; started.json has the real start)", "major"),
  real("station.observed", "A tick saw a different cell.json stage than last time.", "from_stage, stage; refs.cell",
    "supervisor.py Supervisor.observe (sampled once per tick: stages passed between ticks are lost, and a failed verification is no stage change)", "ambient"),
  real("recovery.started", "A claim or execution left by an earlier supervisor is being reconciled.", "kind", "supervisor.py Supervisor.recover / serve", "major"),
  real("execution.completed", "An execution ended and the line's records say where the ticket now stands.", "stage, next, waiting_for, how, seen_to_end, cost_usd, session_id, refused_tools[]",
    "supervisor.py Supervisor.finish (at the next tick after the process ended; result.json has the real end)", "major"),
  real("execution.failed", "An execution ended without moving the ticket, or its outcome is unknown.", "stage, next, how, claude_error, exit_code, attempt, session_id",
    "supervisor.py Supervisor.finish", "major"),

  // ---------------------------------------------------------------- simulation: the Dynamic Workflow
  sim("workflow.started", "derivable", "The execution's claude -p session started the mach:belt Dynamic Workflow for its ticket.", "workflow, args[], until, phases[], session_id",
    "An assistant tool_use named Workflow in .factory/local/executions/<x>/stream.jsonl (kept, not parsed by executor.outcome). execution.started is the nearest real event.",
    "minor"),
  sim("workflow.phase", "missing", "The belt entered a phase (workflows/belt.js phase()).", "workflow, phase",
    "belt.js phase() is not persisted. Whether it appears in stream.jsonl is unverified (gaps document section 7, item 1).", "ambient"),
  sim("workflow.finished", "derivable", "The belt returned its per-ticket summary.", "workflow, tickets[{ticket, outcome, stage, waiting_for}], learning",
    "The final result message in stream.jsonl; executor.outcome keeps four fields per ticket and drops stations[] and learning.", "minor", { missingFields: ["learning (dropped)"] }),

  // ---------------------------------------------------------------- simulation: stations and stages
  sim("station.entered", "missing", "A cell arrived at a station: run.py next answered this action and the belt started its worker.", "station, action, stage, round, reason, agent_type, model",
    "No stage history and no visit record exist. run.py next only reads and is never logged. Approximations: build.json started_at, results.json started_at, packet.json started_at; planning has only file mtimes.",
    "minor", { proposedAs: "station.entered (cell-local log, gaps G2)" }),
  sim("station.left", "missing", "A cell's work at a station ended, with how it ended.", "station, action, outcome, stage, note",
    "Approximations only: build-report.json finished_at, summary.json timestamp, decision.json decided_at, cell.json merged.at, runs.jsonl closed_at.",
    "minor", { proposedAs: "station.exited (gaps G2)" }),
  sim("cell.stage_changed", "derivable", "A station script wrote a new stage to the cell's cell.json.", "from, to, by (the script)",
    "Watch .factory/worktrees/<t>/cell.json (stage, updated_at). station.observed is the real, sampled form.", "minor",
    { missingFields: ["exact time when two writes are close together", "history (cell.json is overwritten)"] }),

  // ---------------------------------------------------------------- simulation: agents and tools
  sim("agent.started", "derivable", "An agent started inside the execution: a clerk, a station worker, a sub-agent, or a reviewer seat.", "agent_id, role, agent_type, seat, tier, model, effort, label, parent_agent_id, phase, station",
    "stream.jsonl: system/task_* notifications and messages with parent_tool_use_id, if the Workflow tool's agents appear there (unverified, gaps section 7 item 1). Seat models: review/round-N/packet.json panel[]. MACH holds no agent ID.",
    "minor", { missingFields: ["agent_id (only Claude's own IDs)", "label and phase (unverified)"] }),
  sim("agent.finished", "derivable", "An agent finished.", "agent_id, outcome, summary", "stream.jsonl, as agent.started.", "ambient",
    { missingFields: ["per-agent cost and duration"] }),
  sim("tool.started", "derivable", "An agent called a tool.", "call_id, agent_id, tool, target (short)",
    "stream.jsonl assistant tool_use {id, name, input}. Lines carry no timestamp, so timing needs a live tailer. Inputs stay local: show the tool name and a short target only.",
    "ambient", { proposedAs: "tool.called (observer)" }),
  sim("tool.finished", "derivable", "A tool call returned.", "call_id, agent_id, ok, summary", "stream.jsonl user tool_result {tool_use_id, is_error}.", "ambient"),
  sim("artifact.written", "derivable", "A file or commit was produced for a cell.", "artifact_id, kind, path, label, writer{agent_id, call_id, script}, station, round, version, sha, summary",
    "File mtimes in the cell folder; commits on feature/<ticket> (one per build task); evidence hashes in results.json.", "minor",
    { missingFields: ["writer agent and tool call (stream only)", "version (files are overwritten)"] }),

  // ---------------------------------------------------------------- simulation: gates and the build
  sim("gate.checked", "derivable", "A gate with no event of its own was checked: the readiness audit at build start, or cell.py check-plan.", "gate, passed, detail, tier, score",
    "build.json audit{tier, human_review_required} and .factory/audit-report.json; check-plan's result is cell.json stage 'planned' with risk and contracts.", "minor",
    { missingFields: ["time of the plan check", "refused checks (printed only)"] }),
  sim("task.started", "missing", "The builder took the next task of plan.md.", "task_id, kind, text, files[], ids[], loop",
    "build.py next prints the task and records nothing; build.json tasks[].at is the completion time.", "ambient"),
  sim("task.red", "derivable", "A [test] task was accepted because the suite failed with it, and its tests were committed.", "task_id, commit, test_file, failing, note",
    "build.json tasks[] (status, first_run, commit, at, test_run); the test(...) commit.", "minor", { missingFields: ["failing test count"], proposedAs: "build.task.completed" }),
  sim("task.green", "derivable", "An [impl] task was accepted because the whole suite passed, and its code was committed.", "task_id, commit, passed, note",
    "build.json tasks[]; the feat(...) commit.", "minor", { missingFields: ["passing test count"], proposedAs: "build.task.completed" }),
  sim("task.done", "derivable", "A [contract], [refactor] or [docs] task was committed.", "task_id, commit, note", "build.json tasks[].", "minor"),
  sim("test.result", "derivable", "A test suite run finished: baseline, red, green, verification rerun or merge revalidation.", "context, command, passed, failed, skipped, seconds, exit_code, task_id",
    "build.json tasks[].test_run{exit_code, seconds} and baseline_run; evidence/test-suite.log.", "ambient",
    { missingFields: ["passed/failed/skipped counts (only in raw output)"] }),
  sim("build.revised", "derivable", "A revision round started after a failed verification or a rejected review.", "loop, round, rounds_left, findings, because",
    "build.json loop and stage 'building'; review-findings-<loop>.md.", "major"),

  // ---------------------------------------------------------------- simulation: verification
  sim("verification.started", "derivable", "The verifier started: what must be proven and which kinds of evidence are required.", "round, app_type, head, targets[{id, kind, title}], required_evidence[]",
    "evidence/results.json started_at, head; targets recomputed from spec.json as verify.py Cell.targets does.", "minor"),
  sim("evidence.captured", "derivable", "One scenario, matrix rule or holdout was proven or disproven, with its evidence files.", "round, target_id, target_kind, result, evidence[], note",
    "evidence/results.json records[ID] {kind, result, note, evidence[{file, sha256}], at} (verify.py record; a re-record overwrites).", "minor",
    { proposedAs: "verify.check.recorded" }),
  sim("verification.verdict", "derivable", "verify.py finish gave its verdict.", "round, status, checks_passed, checks_failed, head, findings",
    "evidence/summary.json (status, checks, head, timestamp); findings.md on failure. INCOMPLETE_EVIDENCE is not written.", "major",
    { proposedAs: "gate.decided" }),

  // ---------------------------------------------------------------- simulation: review
  sim("review.started", "derivable", "A review round was seated: the panel, the threshold, and the delta for a later round.", "round, max_rounds, risk, approvals_needed, human_approval_required, human_approval_reasons[], panel[], head, diff_stat, delta",
    "review/round-N/packet.json (started_at).", "major", { proposedAs: "review.round.started" }),
  sim("review.finding", "derivable", "One finding by one seat: a blocker (must name a rule and a file) or a note.", "round, seat, finding_id, severity, title, rule, file",
    "review/round-N/votes/<role>.json findings[], written once per seat with all its findings.", "minor",
    { missingFields: ["time per finding (all a seat's findings share its vote time)"] }),
  sim("review.vote", "derivable", "A seat's vote, which follows from its findings: any blocker is a REJECT.", "round, seat, vote, blockers, notes, model, head",
    "review/round-N/votes/<role>.json (vote, at).", "minor", { proposedAs: "review.vote.submitted" }),
  sim("review.decided", "derivable", "review.py tally decided the round.", "round, outcome, approvals, approvals_needed, votes, blockers, overruled_blockers_from[], security_veto, head, findings",
    "review/round-N/decision.json (decided_at).", "major"),
  sim("human.approval_recorded", "derivable", "A named person approved the change after the panel (review.py approve-human).", "round, by, note, head",
    "decision.json human_approval{by, note, recorded_at}. 'by' is a typed name, not an authenticated identity.", "chapter",
    { proposedAs: "approval.recorded" }),

  // ---------------------------------------------------------------- simulation: merge and cleanup
  sim("merge.revalidated", "derivable", "The merge queue step: main had moved, so it was merged into the branch and the suite rerun (or no revalidation was needed).", "needed, onto, head, approved_commit, tests, passed, seconds, note",
    "cell.json revalidated{head, onto, at, tests} on success. When main has not moved nothing is written, and a conflict is only printed.", "minor",
    { missingFields: ["a 'not needed' record", "test counts and seconds"] }),
  sim("merge.completed", "derivable", "The approved commit landed on the default branch.", "method, into, merge_commit, approved_commit, landed_commit, revalidated",
    "cell.json merged{commit, at, method, landed_commit} and stage 'merged'.", "major", { proposedAs: "merge.landed" }),
  sim("cleanup.completed", "derivable", "The cell was archived and removed, and its run record appended.", "archive, outcome, rounds, first_pass, run_record",
    ".factory/archive/<t>.tar.gz and the runs.jsonl line (closed_at).", "minor", { proposedAs: "cell.cleaned" }),
];

export const EVENT_CATALOG: Readonly<Record<EventKind, CatalogEntry>> = Object.fromEntries(ENTRIES.map((entry) => [entry.kind, entry])) as Record<EventKind, CatalogEntry>;
export const CATALOG_ENTRIES = ENTRIES;
