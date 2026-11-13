/**
 * The client's own markers (`client.history_missing`, `client.snapshot_applied`, ids `k:`): what the
 * client itself knows about its history. They never come from or go to the observer.
 */
import type { AnyV3Event, EngineEvent } from "../sim/v3";

const pad = (n: number, width: number): string => String(Math.max(0, Math.floor(n))).padStart(width, "0");

/** A client marker event (`k:` id, rank 7, key `k`): placed at `t`, never sent anywhere. */
export function clientEvent<K extends "client.history_missing" | "client.snapshot_applied">(type: K, n: number, t: number, data: AnyV3Event["data"]): EngineEvent {
  const iso = new Date(t).toISOString();
  return {
    schema_version: 3,
    schema_revision: 0,
    id: `k:${type.slice(7)}:${n}`,
    type,
    pos: 0,
    origin: { stream: "observer", key: "k", seq: n, part: 0, writer: "observer", script: null, source_version: "control-tower" },
    authority: "reconstructed",
    time: { occurred_at: iso, precision: "bounded", not_before: null, not_after: iso, observed_at: iso, order_ms: t },
    order: `${pad(t, 15)}~7~k~${pad(n, 12)}~0000`,
    ids: { project_id: null, wave_id: null, slice_id: null, revision: null, ticket_id: null, cell_instance: null, execution_id: null, runner_id: null, visit_id: null, station: null, round: null, attempt: null, seat: null, agent_id: null, parent_agent_id: null, tool_call_id: null },
    entities: [],
    parent: null,
    cause: null,
    artifacts: [],
    unknown: [],
    inferred: {},
    provenance: { basis: [], rule: `client-${type.slice(7)}`, files: [] },
    late: false,
    withheld: 0,
    data,
  } as unknown as EngineEvent;
}

