/**
 * What every Analytics area takes: its data as contract.ts shapes inside a load state, where the
 * figures come from, what moment they describe, and the callbacks that leave the area. An area never
 * fetches, never reads a fixture and never navigates: the caller (the Shell's workspace, or the
 * development proof page) owns the source, the address and the scene store.
 */
import type { EntityRef } from "../../sim/model";
import type { AnalyticsSnapshot, Station } from "../contract";
import type { InsightsReply } from "../data/types";
import type { AreaId } from "../model/findings";
import type { CohortBy, RunConfigs } from "../model/cohorts";

/** simulation: the seeded fixture, always labelled Simulated. live: the observer's head. replay: the observer at a point in time. */
export type AreaSource = "simulation" | "live" | "replay";

/**
 * The data's load state. `error` carries the observer's answer ("the observer answered 400: <reason>"
 * is how it is shown); `unavailable` says why this source cannot answer at all; `stale` marks figures
 * that are shown but older than the source now is.
 */
export type AreaData<T> =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly status: number | null; readonly reason: string }
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "ready"; readonly value: T; readonly stale?: { readonly reason: string } | null };

export type OpenWhere = "timeline" | "floor";
export interface Interval {
  readonly from: number;
  readonly to: number;
}
/** Open an entity in another workspace. The Shell wires it to the scene store (showInTimeline, showOnFloor). */
export type OnOpen = (ref: EntityRef, where: OpenWhere, interval?: Interval) => void;

/** Which figure's contributors the Rows drawer lists. */
export interface RowsRequest {
  /** `${metric}` or `${metric}|${dimension}=${value}` (contract.ts `contributorKey`). */
  readonly key: string;
  readonly title: string;
  readonly unit: "ms" | "usd" | "count" | "rate" | "tokens";
  readonly about?: string;
  /** The population the rows are listed over when it is not the view's window (an Improvement Opportunity's last N runs or its own window). */
  readonly population?: { readonly lastRuns: number | null; readonly fromMs: number | null; readonly toMs: number | null };
}

/** The window the workspace describes: a preset ending at the newest record, or a chosen interval. */
export type WindowChoice = "7d" | "14d" | "28d" | "all" | Interval;

/** A selection inside one area that narrows its related charts (shown as a removable chip). */
export interface Pick {
  readonly dim: "station" | "model" | "outcome" | "target_kind" | "rule";
  readonly value: string;
}

export interface CompareChoice {
  readonly by: CohortBy;
  readonly a: string | null;
  readonly b: string | null;
}

/** Every area's props. */
export interface AreaProps {
  readonly data: AreaData<AnalyticsSnapshot>;
  readonly source: AreaSource;
  /** "As of 13 Nov, 18:00 UTC", "As of the playhead, 12 Nov 09:14": what moment the figures describe. */
  readonly asOf: string;
  readonly onOpen: OnOpen;
  /** Opens the Rows drawer; without it the areas offer no "Rows" buttons. */
  readonly onRows?: (r: RowsRequest) => void;
  /** Moves to another area (and a section in it). */
  readonly onArea?: (area: AreaId, focus?: string) => void;
  /** Brushing a trend sets the workspace window; without it the trends are not brushable. */
  readonly onWindow?: (w: Interval) => void;
}

export interface PulseProps extends AreaProps {
  /** The observer's Improvement Opportunities for the same query; "What stands out" lists the first few. Absent: not served. */
  readonly insights?: AreaData<InsightsReply>;
}
export interface FlowProps extends AreaProps {
  readonly station: Station | null;
  readonly onStation: (s: Station | null) => void;
}
export interface QualityProps extends AreaProps {
  /** A failure kind (Q4 `target_kind`) or blocker rule (R2 `rule`) narrowing the ticket-level charts. */
  readonly pick: Pick | null;
  readonly onPick: (p: Pick | null) => void;
}
export interface EconomicsProps extends AreaProps {
  /** The model narrowing figures recorded per model. Only this area offers it. The data must be loaded with it. */
  readonly model: string | null;
  readonly onModel: (m: string | null) => void;
}
export interface ReliabilityProps extends AreaProps {
  /** An ending (completed, failed, interrupted, unknown, parked, killed) whose executions are listed. */
  readonly pick: Pick | null;
  readonly onPick: (p: Pick | null) => void;
}
export interface CompareProps extends AreaProps {
  /** Per finished ticket, the `config_id` each execution recorded (null: none). Absent: every run is "configuration not recorded". */
  readonly configs?: RunConfigs;
  readonly compare: CompareChoice | null;
  readonly onCompare: (c: CompareChoice) => void;
}
export interface OpportunitiesProps extends AreaProps {
  readonly insights?: AreaData<InsightsReply>;
}
