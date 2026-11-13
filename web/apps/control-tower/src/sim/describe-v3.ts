/**
 * One plain sentence per log entry, and how prominent it is, for both dialects. Simulation events
 * keep their M6.0 sentences (describe.ts); version 3 events get sentences written from the event
 * alone, in the contract's words. People are "a person" (contract D15). An unknown kind says so.
 */
import type { Significance } from "./catalog";
import type { AnySimEvent } from "./events";
import { describe } from "./describe";
import type { LogEntry } from "./log";
import type { AnyV3Event, UnknownV3Event } from "./v3";
import { isKnownV3Kind } from "./v3";
import { gapClassWord } from "./provenance";
import { gapClassOf } from "./reduce-v3";

const SIGNIFICANCE: Readonly<Record<string, Significance>> = {
  "wave.discovered": "chapter",
  "factory.activated": "chapter",
  "slice.integrated": "major",
  "work.scheduled": "major",
  "dependency.resolved": "major",
  "dependency.blocked": "minor",
  "human.required": "major",
  "execution.started": "major",
  "execution.completed": "major",
  "execution.failed": "major",
  "recovery.started": "major",
  "station.entered": "major",
  "station.exited": "minor",
  "gate.evaluated": "minor",
  "review.round_started": "major",
  "review.decided": "major",
  "review.verdict_submitted": "minor",
  "human.approval_recorded": "major",
  "merge.completed": "major",
  "cleanup.completed": "minor",
  "workflow.started": "minor",
  "workflow.finished": "minor",
  "agent.started": "minor",
  "agent.finished": "minor",
  "agent.queued": "ambient",
  "agent.progressed": "ambient",
  "tool.called": "ambient",
  "tool.returned": "ambient",
  "tool.refused": "minor",
  "verify.check_recorded": "minor",
  "history.gap": "major",
  "history.began": "minor",
  "client.history_missing": "major",
  "client.snapshot_applied": "major",
};

export function significanceOf(type: string): Significance {
  return SIGNIFICANCE[type] ?? "ambient";
}

export function describeEntry(entry: LogEntry): string {
  const event = entry.event;
  if (event.schema_version !== 3) return describe(event as AnySimEvent);
  return describeV3(event);
}

/** Who acted, by role only: the observer never serves a name. */
function roleWords(role: string | null | undefined): string {
  return role === "engineer" ? "An engineer" : role === "supervisor" ? "The supervisor" : "A person";
}

export function describeV3(event: AnyV3Event | UnknownV3Event): string {
  if (!isKnownV3Kind(event.type)) return `An event this version does not understand (${event.type}).`;
  const e = event as AnyV3Event;
  const who = e.ids.ticket_id ?? e.ids.slice_id ?? e.ids.wave_id ?? "the Factory";
  const station = e.ids.station ?? "a station";
  switch (e.type) {
    case "wave.discovered":
      return `Approved wave ${e.ids.wave_id} arrived with ${e.data.slices.length} slices.`;
    case "slice.materialized":
      return `${e.ids.slice_id} became ticket ${e.ids.ticket_id}.`;
    case "slice.integrated":
      return `${e.ids.slice_id} is integrated.`;
    case "dependency.resolved":
      return `${e.ids.slice_id} is eligible.`;
    case "dependency.blocked":
      return `${e.ids.slice_id} waits. ${e.data.reasons.join(" ")}`;
    case "work.scheduled":
      return `${e.ids.slice_id ?? who} dispatched: cell ${e.ids.ticket_id} opened.`;
    case "human.required":
      return `A person is needed for ${who}: ${e.data.reason}`;
    case "factory.activated":
      return `${roleWords(e.data.by_role)} enabled the Factory on this machine (${e.data.autonomy}).`;
    case "factory.disabled":
      return `${roleWords(e.data.by_role)} disabled the Factory on this machine${e.data.stopped ? ", stopping what was running" : ""}.`;
    case "factory.paused":
      return `${roleWords(e.data.by_role)} paused the Factory${e.data.reason ? `: ${e.data.reason.replace(/[.\s]+$/, "")}` : ""}.`;
    case "factory.resumed":
      return `${roleWords(e.data.by_role)} resumed the Factory.`;
    case "work.claimed":
      return `The supervisor claimed ${who} (attempt ${e.data.attempt}).`;
    case "execution.started":
      return `An execution started for ${who}.`;
    case "execution.completed":
      return `The execution for ${who} ended${e.data.stage ? ` at ${e.data.stage}` : ""}.`;
    case "execution.failed":
      return `The execution for ${who} failed.`;
    case "execution.process_ended":
      return `The execution's process ${e.data.ended === "exited" ? "exited" : e.data.ended}.`;
    case "station.observed":
      return `The supervisor saw ${who} at ${e.data.stage} (sampled).`;
    case "station.entered":
      return `${who} entered ${e.data.station}${e.data.action === "revise" ? " to revise" : ""}.`;
    case "station.exited":
      return `${who} left ${e.data.station}: ${e.data.outcome}.`;
    case "gate.evaluated":
      return `${who}: gate ${e.data.gate} ${e.data.verdict}${e.data.reason_code ? ` (${e.data.reason_code})` : ""}.`;
    case "build.task_completed":
      return `${who}: task ${e.data.task_id} ${e.data.step}.`;
    case "verify.check_recorded":
      return `${who}: ${e.data.target_id} ${e.data.result === "pass" ? "proven" : "failed"}.`;
    case "review.round_started":
      return `${who}: review round ${e.ids.round ?? ""} seated ${e.data.panel.length} reviewer(s).`;
    case "review.verdict_submitted":
      return `${who}: the ${e.data.seat} seat voted ${e.data.vote}.`;
    case "review.decided":
      return `${who}: review ${e.data.outcome} (${e.data.approvals} approve, ${e.data.approvals_needed} needed).`;
    case "human.approval_recorded":
      return `${who}: a person approved.`;
    case "merge.completed":
      return `${who} merged.`;
    case "cleanup.completed":
      return `${who} cleaned up (${e.data.outcome}).`;
    case "workflow.started":
      return `A Dynamic Workflow (${e.data.workflow}) started for ${who}.`;
    case "workflow.finished":
      return `The workflow for ${who} ended: ${e.data.status}.`;
    case "agent.queued":
      return `Queued: ${e.data.label}.`;
    case "agent.started":
      return `Started: ${e.data.label}.`;
    case "agent.progressed":
      return `Progress: ${e.data.tool_calls ?? "?"} tool call(s) so far.`;
    case "agent.finished":
      return `Finished (${e.data.status}).`;
    case "tool.refused":
      return `${e.data.tool} was refused in ${station}.`;
    case "history.gap": {
      // Said by the gap's class (observer M6.2): only a history-losing class is "lost".
      const cls = typeof e.data.class === "string" && e.data.class ? e.data.class : gapClassOf(e.data.reason);
      const lost = typeof e.data.history_lost === "boolean" ? e.data.history_lost : cls !== "unknown-type" && cls !== "conflict";
      const n = e.data.count ?? "Some";
      if (cls === "unknown-type") return `${n} record(s) received, not interpreted (${e.data.reason}).`;
      if (cls === "conflict") return `A record was read again with different content; the first copy was kept (${e.data.reason}).`;
      return lost ? `${n} record(s) of history lost: ${gapClassWord(cls)} (${e.data.reason}).` : `${n} record(s): ${gapClassWord(cls)} (${e.data.reason}).`;
    }
    case "history.began":
      return `History for ${who} begins here (${e.data.reason}).`;
    case "client.history_missing":
      return e.data.reason === "window" ? "History before here is not loaded." : e.data.reason === "reset" ? "The observer rebuilt its index; the scene was reloaded." : "History missed while disconnected; the scene was reloaded.";
    case "client.snapshot_applied":
      return "Seeded from the observer's projected state (reconstructed), for what no later event here describes.";
    default:
      return `${e.type.replace(/[._]/g, " ")} for ${who}.`;
  }
}
