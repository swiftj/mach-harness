/**
 * The Factory's state on this machine, as `/api/v1/factory/status` reports it, for the honest empty
 * states: no Factory state in the project, the Factory not enabled on this machine, paused, and how
 * fresh the Factory Supervisor's heartbeat is.
 *
 * The observer client (src/live/observer.ts) reads only the lease from this route, and under a key the
 * observer does not use (`lease` at the top; the observer sends `report.lease` and `supervisor`), so
 * this reads the route itself. Read tolerantly: unknown fields are ignored, missing ones are null.
 * It reads; nothing in the Control Tower can enable, pause, schedule or approve anything.
 */
import type { FetchLike } from "../../live";
import { timeOf } from "../../live";

export interface FactoryReading {
  /** The project has a `.factory/` folder at all. Null: not reported. */
  readonly factoryPresent: boolean | null;
  /** The machine-local policy enables the Factory here. Null: not reported. */
  readonly enabled: boolean | null;
  readonly paused: boolean | null;
  /** The policy's effective mode, verbatim (`disabled`, `observe`, `supervised`). */
  readonly mode: string | null;
  readonly supervisor: {
    readonly leasePresent: boolean | null;
    readonly heartbeatFresh: boolean | null;
    readonly heartbeatAgeSeconds: number | null;
  };
  /** When the observer read the files (Unix ms). */
  readonly readAt: number | null;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Parse the route's `data`, whichever of the documented shapes it has. */
export function readFactoryStatus(data: unknown): FactoryReading {
  const d = obj(data);
  const summary = obj(d.summary);
  const report = obj(d.report);
  const supervisor = obj(d.supervisor);
  const lease = Object.keys(obj(d.lease)).length ? obj(d.lease) : obj(report.lease);
  const policy = Object.keys(obj(d.policy)).length ? obj(d.policy) : obj(report.policy);
  return {
    factoryPresent: bool(d.factory_present) ?? bool(report.factory_present),
    enabled: bool(summary.enabled) ?? bool(policy.enabled),
    paused: bool(summary.paused) ?? bool(policy.paused),
    mode: str(summary.mode) ?? str(policy.effective),
    supervisor: {
      leasePresent: bool(supervisor.lease_present) ?? bool(lease.present),
      heartbeatFresh: bool(supervisor.heartbeat_fresh) ?? bool(lease.live),
      heartbeatAgeSeconds: num(supervisor.heartbeat_age_seconds) ?? num(lease.heartbeat_age_seconds),
    },
    readAt: timeOf(d.read_at),
  };
}

/** Read the route once. Null when it cannot be read (the connection badge already says why). */
export async function fetchFactoryStatus(fetchLike: FetchLike, base = "/api/v1"): Promise<FactoryReading | null> {
  try {
    const response = await fetchLike(`${base}/factory/status`, { headers: { "X-MACH-Event-Schema": "3", Accept: "application/json" }, credentials: "same-origin" });
    const body = obj(await response.json());
    return body.ok === true ? readFactoryStatus(body.data) : null;
  } catch {
    return null;
  }
}
