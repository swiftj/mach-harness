/**
 * Compare's cohorts: finished tickets grouped by risk tier, app type, time period, or the execution
 * configuration (`config_id`, the SHA-256 the supervisor records when it starts an execution;
 * M6_5_DESIGN.md section 5) their executions ran under.
 *
 * A run's configuration is read only from what was recorded, never inferred:
 * - every execution recorded the same `config_id` → that configuration;
 * - no execution recorded one (older executions, hand-driven work, a failed capture) → the explicit
 *   "configuration not recorded" cohort;
 * - executions recorded different ones, or some recorded one and some did not → "more than one
 *   configuration".
 * None of these is ever merged into another. Equal `config_id` means the same MACH files, tiers,
 * thresholds and policy; the id is compared, never interpreted.
 *
 * Pure; tested in test/analytics-ui-model.test.mjs.
 */
import type { RunRecord } from "../contract";
import { dayText } from "./format";

export type CohortBy = "risk" | "app_type" | "period" | "config";

/** Per finished ticket: the `config_id` each of its executions recorded (null: none recorded). */
export type RunConfigs = Readonly<Record<string, readonly (string | null)[]>>;

export const NOT_RECORDED = "not-recorded";
export const MIXED = "mixed";

export function configOf(ticket: string, configs: RunConfigs | undefined): string {
  const list = configs?.[ticket];
  if (!list || list.length === 0 || list.every((c) => c === null)) return NOT_RECORDED;
  const ids = new Set(list);
  if (ids.size > 1) return MIXED;
  return list[0]!;
}

export interface CohortOption {
  readonly key: string;
  readonly label: string;
  /** Finished tickets in it. */
  readonly runs: number;
  /** Whether the key is an identifier (shown in the mono face) rather than words. */
  readonly code: boolean;
}

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

export function cohortLabel(by: CohortBy, key: string, mid?: number): string {
  if (by === "risk") return key === "unknown" ? "Risk not recorded" : `${cap(key)} risk`;
  if (by === "app_type") return key === "unknown" ? "App type not recorded" : `${cap(key)} apps`;
  if (by === "period") return key === "earlier" ? `Before ${mid !== undefined ? dayText(mid) : "the middle"}` : `From ${mid !== undefined ? dayText(mid) : "the middle"}`;
  if (key === NOT_RECORDED) return "Configuration not recorded";
  if (key === MIXED) return "More than one configuration";
  return `Configuration ${key.slice(0, 8)}`;
}

/** The cohort a finished ticket belongs to under `by`. */
export function cohortKey(by: CohortBy, r: RunRecord, configs: RunConfigs | undefined, mid: number): string {
  if (by === "risk") return r.risk ?? "unknown";
  if (by === "app_type") return r.app_type ?? "unknown";
  if (by === "period") return r.closed_at && r.closed_at.ms < mid ? "earlier" : "later";
  return configOf(r.ticket_id, configs);
}

/** Every cohort present among the runs, largest first; the not-recorded and mixed cohorts are always last and never folded into another. */
export function cohortOptions(by: CohortBy, runs: readonly RunRecord[], configs: RunConfigs | undefined, mid: number): CohortOption[] {
  const n = new Map<string, number>();
  for (const r of runs) {
    if (by === "period" && !r.closed_at) continue;
    const k = cohortKey(by, r, configs, mid);
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  const special = (k: string) => k === NOT_RECORDED || k === MIXED || k === "unknown";
  const order = by === "period" ? ["earlier", "later"] : by === "risk" ? ["low", "medium", "high"] : [];
  return [...n.entries()]
    .sort((a, b) => Number(special(a[0])) - Number(special(b[0])) || (order.length ? order.indexOf(a[0]) - order.indexOf(b[0]) : b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .map(([key, runs]) => ({ key, label: cohortLabel(by, key, mid), runs, code: by === "config" && !special(key) }));
}

export function cohortRuns(by: CohortBy, key: string, runs: readonly RunRecord[], configs: RunConfigs | undefined, mid: number): RunRecord[] {
  return runs.filter((r) => (by !== "period" || r.closed_at) && cohortKey(by, r, configs, mid) === key);
}

/** The two cohorts to show by default: the two largest that are not "not recorded" or "mixed", else whatever exists. */
export function defaultPair(options: readonly CohortOption[]): [string | null, string | null] {
  const plain = options.filter((o) => o.key !== NOT_RECORDED && o.key !== MIXED && o.key !== "unknown");
  const pool = plain.length >= 2 ? [...plain].sort((a, b) => b.runs - a.runs) : options;
  return [pool[0]?.key ?? null, pool.find((o) => o.key !== pool[0]?.key)?.key ?? null];
}
