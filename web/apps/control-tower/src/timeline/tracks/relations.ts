/**
 * How spans relate, read from `span.ids`, `span.parent` and `span.entity` only (the ids each kind carries
 * are those of apps/observer/internal/project/spans.go). Agent and tool ids are opaque: they are compared
 * whole, never parsed. One pass over every span, before filters, so a track's id never depends on what a
 * filter hides.
 */
import type { TimelineFilters, TimelineSpan } from "../contract";

/** Grouping of agents: one node each up to this many in a group, lanes beyond it. */
export const MAX_AGENT_NODES = 24;

export interface AgentGroup {
  /** `<workflow ref>/agents`, or `execution:<id>/agents` for agents outside a workflow. */
  readonly id: string;
  /** The node the group hangs under: the workflow ref or the execution ref. */
  readonly owner: string;
  readonly execution: string;
  readonly members: Set<string>;
}

export interface Relations {
  /** execution id → ticket. */
  readonly execTicket: Map<string, string>;
  /** execution id → attempt number, as recorded. */
  readonly execAttempt: Map<string, string>;
  /** execution id → every ticket whose visits ran in it (normally one). */
  readonly execCells: Map<string, Set<string>>;
  readonly ticketSlice: Map<string, string>;
  readonly sliceWave: Map<string, string>;
  /** visit entity (`visit:<id>`) → station. */
  readonly visitStation: Map<string, string>;
  /** Tickets that have a cell in the product grouping. */
  readonly cellTickets: Set<string>;
  /** agent entity → its group. */
  readonly agentGroup: Map<string, AgentGroup>;
  /** group id → group. */
  readonly groups: Map<string, AgentGroup>;
  /** agent entity → its span (the agent's, else its queue's), for labels and the count-only note. */
  readonly agentSpan: Map<string, TimelineSpan>;
}

/** An id, or null when absent or empty (the observer writes empty strings for some). */
export function idOf(span: TimelineSpan, key: string): string | null {
  const value = span.ids[key];
  return value ? value : null;
}

/** Whether an agent group is drawn as one node per agent (else as lanes on the group). */
export function individual(group: AgentGroup): boolean {
  return group.members.size <= MAX_AGENT_NODES;
}

/**
 * One pass, switching on kind first so the bulk (tools, agents) reads only what it needs. Tools and
 * workflows contribute nothing: adding a tool never changes where another span goes.
 */
export function relationsOf(spans: readonly TimelineSpan[]): Relations {
  const rel: Relations = {
    execTicket: new Map(),
    execAttempt: new Map(),
    execCells: new Map(),
    ticketSlice: new Map(),
    sliceWave: new Map(),
    visitStation: new Map(),
    cellTickets: new Set(),
    agentGroup: new Map(),
    groups: new Map(),
    agentSpan: new Map(),
  };
  const sliceAndWave = (span: TimelineSpan, ticket: string | null, authoritative: boolean): void => {
    const slice = span.ids.slice_id;
    if (!slice) return;
    const wave = span.ids.wave_id;
    if (wave && !rel.sliceWave.has(slice)) rel.sliceWave.set(slice, wave);
    if (ticket && (authoritative || !rel.ticketSlice.has(ticket))) rel.ticketSlice.set(ticket, slice);
  };
  for (const span of spans) {
    switch (span.kind) {
      case "tool":
      case "workflow":
      case "wave":
        break;
      case "agent":
      case "agent-queue": {
        let group = rel.agentGroup.get(span.entity);
        if (!group) {
          const exec = span.ids.execution_id || "?";
          const execRef = `execution:${exec}`;
          const owner = span.parent && span.parent !== execRef ? span.parent : execRef;
          const id = `${owner}/agents`;
          group = rel.groups.get(id);
          if (!group) rel.groups.set(id, (group = { id, owner, execution: exec, members: new Set() }));
          group.members.add(span.entity);
          rel.agentGroup.set(span.entity, group);
        }
        if (span.kind === "agent" || !rel.agentSpan.has(span.entity)) rel.agentSpan.set(span.entity, span);
        break;
      }
      case "execution":
      case "claim": {
        const exec = span.ids.execution_id;
        const ticket = span.ids.ticket_id || null;
        if (exec && ticket) rel.execTicket.set(exec, ticket);
        const attempt = span.ids.attempt || (span.attrs.attempt !== undefined ? String(span.attrs.attempt) : null);
        if (exec && attempt) rel.execAttempt.set(exec, attempt);
        sliceAndWave(span, ticket, false);
        break;
      }
      case "visit": {
        const ticket = span.ids.ticket_id || null;
        const station = span.ids.station;
        if (station) rel.visitStation.set(span.entity, station);
        const exec = span.ids.execution_id;
        if (exec && ticket) {
          let cells = rel.execCells.get(exec);
          if (!cells) rel.execCells.set(exec, (cells = new Set()));
          cells.add(ticket);
        }
        if (ticket) rel.cellTickets.add(ticket);
        sliceAndWave(span, ticket, false);
        break;
      }
      case "slice-wait":
      case "slice-eligible":
      case "capacity-wait":
        sliceAndWave(span, span.ids.ticket_id || null, false);
        break;
      default: {
        // cell, round, task, seat, gate-wait, person-wait: they belong to a cell.
        const ticket = span.ids.ticket_id || null;
        if (ticket) rel.cellTickets.add(ticket);
        sliceAndWave(span, ticket, span.kind === "cell");
        break;
      }
    }
  }
  return rel;
}

export function execOf(span: TimelineSpan): string | null {
  return idOf(span, "execution_id");
}

export function ticketOf(span: TimelineSpan, rel: Relations): string | null {
  const ticket = idOf(span, "ticket_id");
  if (ticket) return ticket;
  const exec = execOf(span);
  return exec ? (rel.execTicket.get(exec) ?? null) : null;
}

export function sliceOf(span: TimelineSpan, rel: Relations): string | null {
  const slice = idOf(span, "slice_id");
  if (slice) return slice;
  const ticket = ticketOf(span, rel);
  return ticket ? (rel.ticketSlice.get(ticket) ?? null) : null;
}

/** The station a span belongs to, where it has one. */
export function stationOf(span: TimelineSpan, rel: Relations): string | null {
  const station = idOf(span, "station");
  if (station) return station;
  switch (span.kind) {
    case "task":
      return span.parent ? (rel.visitStation.get(span.parent) ?? null) : null;
    case "seat":
      return "review";
    case "gate-wait":
      return "human-approval";
    default:
      return null;
  }
}

/** A span predicate for the filters other than attentionOnly; null when nothing is restricted. */
export function filterOf(filters: TimelineFilters, rel: Relations): ((span: TimelineSpan) => boolean) | null {
  const kinds = new Set(filters.kinds);
  const tickets = new Set(filters.tickets);
  const executions = new Set(filters.executions);
  const slices = new Set(filters.slices);
  const stations = new Set(filters.stations);
  if (kinds.size + tickets.size + executions.size + slices.size + stations.size === 0) return null;
  return (span) => {
    if (kinds.size > 0 && !kinds.has(span.kind)) return false;
    if (tickets.size > 0) {
      const t = ticketOf(span, rel);
      if (t === null || !tickets.has(t)) return false;
    }
    if (executions.size > 0) {
      const x = execOf(span);
      if (x === null || !executions.has(x)) return false;
    }
    if (slices.size > 0) {
      const s = sliceOf(span, rel);
      if (s === null || !slices.has(s)) return false;
    }
    if (stations.size > 0) {
      const s = stationOf(span, rel);
      if (s === null || !stations.has(s)) return false;
    }
    return true;
  };
}
