/**
 * One plain sentence per event, for the inspector, the timeline and screen readers. Written from
 * the event alone (no scene), so it is the same wherever it is shown.
 */
import type { AnySimEvent } from "./events";

export function describe(event: AnySimEvent): string {
  const who = event.ticket_id ?? event.slice_id ?? event.wave_id ?? "the Factory";
  switch (event.type) {
    case "factory.activated":
      return `${event.data.by} enabled the Factory (${event.data.autonomy}, up to ${event.data.limits.max_parallel} cells at once).`;
    case "factory.disabled":
      return `${event.data.by} disabled the Factory.`;
    case "factory.paused":
      return `${event.data.by} paused the Factory.`;
    case "factory.resumed":
      return `${event.data.by} resumed the Factory.`;
    case "wave.discovered":
      return `Approved wave ${event.wave_id} arrived with ${event.data.slices.length} slices (approved by ${event.data.approval.actor}).`;
    case "intake.validated":
      return `Intake verified ${event.wave_id} against its source commit.`;
    case "intake.refused":
      return `Intake refused ${event.wave_id}: ${event.data.problems.join(" ")}`;
    case "slice.materialized":
      return `${event.slice_id} became ticket ${event.ticket_id}` + (event.data.dependencies.length ? `, waiting for ${event.data.dependencies.join(" and ")}.` : ".");
    case "slice.integrated":
      return `${event.slice_id} is integrated: ${event.data.commit.slice(0, 7)} is on main.`;
    case "dependency.resolved":
      return `${event.slice_id} is eligible: ` + (event.data.depends_on.length ? `${event.data.depends_on.join(" and ")} integrated.` : "it depends on nothing.");
    case "dependency.blocked":
      return `${event.slice_id} waits. ${event.data.reasons.join(" ")}`;
    case "work.scheduled":
      return `${event.slice_id} dispatched: cell ${event.ticket_id} opened at ${event.data.stage} (${event.data.risk} risk).`;
    case "revision.superseded":
      return `${event.slice_id} revision superseded: ${event.data.effect}.`;
    case "human.required":
      return `A person is needed for ${who}: ${event.data.reason}.`;
    case "revision.discovered":
      return `The supervisor read product commit ${event.data.commit.slice(0, 7)}.`;
    case "scheduling.decided": {
      const d = event.data;
      if (!d.dispatched.length && !d.started.length && !d.held.length) return "The supervisor has nothing new to start.";
      return `The supervisor dispatched ${d.dispatched.join(", ") || "nothing"} and started ${d.started.join(", ") || "nothing"}` + (d.held.length ? `; held ${d.held.length}.` : ".");
    }
    case "work.claimed":
      return `Execution ${event.execution_id} claimed for ${who} (next: ${event.data.next}).`;
    case "execution.started":
      return `Execution ${event.execution_id} started ${event.data.workflow} for ${who}.`;
    case "station.observed":
      return `The supervisor saw ${who} at ${event.data.stage}` + (event.data.from_stage ? ` (was ${event.data.from_stage}).` : ".");
    case "recovery.started":
      return `Recovering execution ${event.execution_id}: ${event.data.kind}.`;
    case "execution.completed":
      return `Execution ${event.execution_id} ended; ${who} ` + (event.data.waiting_for && event.data.waiting_for !== "nothing" ? `waits for ${event.data.waiting_for}` : "is finished") + ` ($${event.data.cost_usd.toFixed(2)}).`;
    case "execution.failed":
      return `Execution ${event.execution_id} ended without moving ${who} (attempt ${event.data.attempt}).`;
    case "workflow.started":
      return `${event.data.workflow} started for ${event.data.args.join(", ")}.`;
    case "workflow.phase":
      return `${who}: workflow phase ${event.data.phase}.`;
    case "workflow.finished":
      return `${event.data.workflow} returned for ${who}.`;
    case "station.entered":
      return `${who} entered ${event.data.station}` + (event.data.action !== event.data.station && event.data.action !== "stop" ? ` (${event.data.action})` : "") + `, round ${event.data.round}: ${event.data.reason}`;
    case "station.left":
      return `${who} left ${event.data.station}: ${event.data.outcome}.`;
    case "cell.stage_changed":
      return `${who} is now ${event.data.to} (${event.data.by}).`;
    case "agent.started":
      return `${event.data.label} started (${event.data.role}${event.data.seat ? `, ${event.data.seat} seat` : ""}, ${event.data.model}).`;
    case "agent.finished":
      return `${event.data.agent_id} finished: ${event.data.summary}`;
    case "tool.started":
      return `${event.data.agent_id} called ${event.data.tool}: ${event.data.target}`;
    case "tool.finished":
      return `${event.data.agent_id} ${event.data.ok ? "got" : "failed"} ${event.data.call_id}` + (event.data.summary ? `: ${event.data.summary}` : ".");
    case "artifact.written":
      return `${who}: ${event.data.label} written` + (event.data.writer.script ? ` by ${event.data.writer.script}` : "") + ".";
    case "gate.checked":
      return `${who}: ${event.data.gate} gate ${event.data.passed ? "passed" : "failed"}. ${event.data.detail}`;
    case "task.started":
      return `${who}: ${event.data.task_id} [${event.data.kind}] ${event.data.text}`;
    case "task.red":
      return `${who}: ${event.data.task_id} red as required; tests committed (${event.data.commit.slice(0, 7)}).`;
    case "task.green":
      return `${who}: ${event.data.task_id} green, ${event.data.passed} tests pass (${event.data.commit.slice(0, 7)}).`;
    case "task.done":
      return `${who}: ${event.data.task_id} committed (${event.data.commit.slice(0, 7)}).`;
    case "test.result":
      return `${who}: ${event.data.command} (${event.data.context}) ${event.data.passed} passed, ${event.data.failed} failed in ${event.data.seconds} s.`;
    case "build.revised":
      return `${who} returns to build after a failed ${event.data.because}: round ${event.data.round}, ${event.data.rounds_left} left.`;
    case "verification.started":
      return `${who}: verification round ${event.data.round} must prove ${event.data.targets.length} checks.`;
    case "evidence.captured":
      return `${who}: ${event.data.target_id} ${event.data.result === "pass" ? "proven" : "FAILED"}. ${event.data.note}`;
    case "verification.verdict":
      return `${who}: verification ${event.data.status} (${event.data.checks_passed} passed, ${event.data.checks_failed} failed).`;
    case "review.started":
      return `${who}: review round ${event.data.round} of ${event.data.max_rounds}, ${event.data.panel.length} seats, ${event.data.approvals_needed} approvals needed` + (event.data.delta ? ", delta review." : ".");
    case "review.finding":
      return `${who}: ${event.data.seat} ${event.data.severity}` + (event.data.rule ? ` (${event.data.rule})` : "") + `: ${event.data.title}`;
    case "review.vote":
      return `${who}: ${event.data.seat} seat votes ${event.data.vote}.`;
    case "review.decided":
      return `${who}: review round ${event.data.round} ${event.data.outcome} (${event.data.approvals} approved, ${event.data.approvals_needed} needed)` + (event.data.overruled_blockers_from.length ? `; blocker from ${event.data.overruled_blockers_from.join(", ")} outvoted.` : ".");
    case "human.approval_recorded":
      return `${event.data.by} approved ${who}.` + (event.data.note ? ` "${event.data.note}"` : "");
    case "merge.revalidated":
      return `${who}: ` + (event.data.needed ? `revalidated on main ${event.data.onto?.slice(0, 7)}; ${event.data.passed} tests pass.` : "no revalidation needed; main has not moved.");
    case "merge.completed":
      return `${who} merged into ${event.data.into} as ${event.data.merge_commit.slice(0, 7)}.`;
    case "cleanup.completed":
      return `${who} archived (${event.data.archive}) after ${event.data.rounds} round(s).`;
  }
}
