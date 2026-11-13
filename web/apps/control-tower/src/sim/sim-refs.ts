/**
 * The entities a simulation event touches. Simulation only: a v3 event carries its own `entities`,
 * computed by the observer (contract D9), and the client derives none.
 */
import type { AnySimEvent } from "./events";
import type { EntityRef } from "./model";
import { gateId, ref } from "./model";

export function simRefsOf(event: AnySimEvent, sliceDeps: Map<string, readonly string[]>): EntityRef[] {
  const out = new Set<EntityRef>();
  const ticket = event.ticket_id;
  if (event.wave_id) out.add(ref.wave(event.wave_id));
  if (event.slice_id) out.add(ref.slice(event.slice_id));
  if (ticket) out.add(ref.cell(ticket));
  if (event.execution_id) out.add(ref.execution(event.execution_id));
  switch (event.type) {
    case "slice.materialized":
      for (const to of event.data.dependencies) out.add(ref.dependency(event.slice_id ?? "", to));
      break;
    case "dependency.resolved":
    case "dependency.blocked":
      for (const to of sliceDeps.get(event.slice_id ?? "") ?? []) out.add(ref.dependency(event.slice_id ?? "", to));
      break;
    case "slice.integrated":
      for (const [from, deps] of sliceDeps) if (deps.includes(event.slice_id ?? "")) out.add(ref.dependency(from, event.slice_id ?? ""));
      break;
    case "scheduling.decided":
      for (const id of event.data.dispatched) out.add(ref.slice(id));
      for (const id of event.data.started) out.add(ref.cell(id));
      break;
    case "human.required":
      if (ticket && /human-approval/.test(event.data.reason)) out.add(ref.gate(gateId(ticket, "human-approval")));
      break;
    case "station.entered":
    case "station.left":
      if (ticket) out.add(ref.station(event.data.station, ticket));
      if (event.data.station === "human-approval" && ticket) out.add(ref.gate(gateId(ticket, "human-approval")));
      break;
    case "agent.started":
      out.add(ref.agent(event.data.agent_id));
      if (event.data.parent_agent_id) out.add(ref.agent(event.data.parent_agent_id));
      if (event.data.station && ticket) out.add(ref.station(event.data.station, ticket));
      break;
    case "agent.finished":
      out.add(ref.agent(event.data.agent_id));
      break;
    case "tool.started":
    case "tool.finished":
      out.add(ref.agent(event.data.agent_id));
      out.add(ref.tool(event.data.call_id));
      break;
    case "artifact.written":
      out.add(ref.artifact(event.data.artifact_id));
      if (event.data.writer.agent_id) out.add(ref.agent(event.data.writer.agent_id));
      if (event.data.writer.call_id) out.add(ref.tool(event.data.writer.call_id));
      break;
    case "gate.checked":
      if (ticket) out.add(ref.gate(gateId(ticket, event.data.gate)));
      break;
    case "task.red":
    case "task.green":
      if (ticket) out.add(ref.gate(gateId(ticket, "red-before-green")));
      break;
    case "verification.started":
    case "verification.verdict":
    case "evidence.captured":
      if (ticket) out.add(ref.gate(gateId(ticket, "verification", event.data.round)));
      if (event.type === "evidence.captured") for (const id of event.data.evidence) out.add(ref.artifact(id));
      break;
    case "review.started":
    case "review.vote":
    case "review.decided":
      if (ticket) out.add(ref.gate(gateId(ticket, "review", event.data.round)));
      if (event.type === "review.decided" && event.data.outcome === "AWAITING_HUMAN" && ticket) out.add(ref.gate(gateId(ticket, "human-approval")));
      break;
    case "review.finding":
      if (ticket) out.add(ref.gate(gateId(ticket, "review", event.data.round)));
      out.add(ref.finding(event.data.finding_id));
      break;
    case "human.approval_recorded":
      if (ticket) out.add(ref.gate(gateId(ticket, "human-approval")));
      break;
    case "merge.revalidated":
      if (ticket) out.add(ref.gate(gateId(ticket, "merge-revalidation")));
      break;
    default:
      break;
  }
  return [...out];
}
