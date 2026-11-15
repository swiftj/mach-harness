/**
 * Where a scene comes from and how much of it can be trusted. Every scene carries its provenance
 * (`scene.provenance`), its completeness (`scene.completeness`), and every entity in it carries an
 * `EntityMeta`: the authority of the event that last set it, the fields that apply but are not known,
 * the fields the observer filled by inference, and whether its start and end times were measured.
 *
 * A view may not draw a value without being able to say which of these it is. See
 * docs/mach-next/M6_1_EVENT_CONTRACT.md sections 7 and 8.
 */

/**
 * The three sources of a scene, persistent in the store and stamped on every scene:
 * - `live`: the Live Factory, events received from the observer's stream as they happen;
 * - `replay`: Historical Replay of real events, loaded from the observer's history (no stream);
 * - `simulation`: the deterministic M6.0 scenario, a development, demonstration and regression
 *   fixture. Never real execution.
 */
export const SCENE_SOURCES = ["live", "replay", "simulation"] as const;
export type SceneSource = (typeof SCENE_SOURCES)[number];

/**
 * Who stands behind a value. The first three are the contract's (section 7); `simulated` is the
 * client's own word for anything the simulation made up, so a simulated value can never be read as
 * authoritative, observed or reconstructed.
 */
export type Authority = "authoritative" | "observed" | "reconstructed" | "simulated";

/**
 * Whether a time was measured (a record carried it, to the millisecond or second), inferred (placed
 * by arrival, bounded between other records, or taken from the event's position because no record
 * says), simulated, or not known at all.
 */
export type TimeQuality = "measured" | "inferred" | "simulated" | "unknown";

export interface EntityMeta {
  /** Authority of the event that last set this entity. */
  readonly authority: Authority;
  /** That event's id (`sim:<seq>` for the simulation). */
  readonly eventId: string;
  /** Fields whose authority differs from `authority` (for example a cell's stage sampled by the supervisor). */
  readonly fields: Readonly<Record<string, Authority>>;
  /** Fields that apply but are not known. The scene holds a placeholder value for them; draw "not recorded". */
  readonly unknown: readonly string[];
  /** Fields filled by inference, with the rule (`label`, `time-window`, `execution`, ...). */
  readonly inferred: Readonly<Record<string, string>>;
  /** How the entity's start time is known (`startedAt`, `enteredAt`, `openedAt`, ...). */
  readonly start: TimeQuality;
  /** How the entity's end time is known (`finishedAt`, `leftAt`, ...); `unknown` while open. */
  readonly end: TimeQuality;
  /**
   * The observer committed the event that last set it after events that sort after it (the event's
   * own `late`, contract 6.5): a view treats the change as a state change (drawn at its end state),
   * never as motion replayed. Lateness to this browser alone (a batch inserted before what it already
   * held) is a delivery fact and stays on the log entry: `isLateEntry(log, meta.eventId)`. Always
   * false for the simulation.
   */
  readonly late: boolean;
}

/** The meta of every simulated entity: one frozen object, shared. */
export const SIM_META: EntityMeta = Object.freeze({
  authority: "simulated",
  eventId: "",
  fields: Object.freeze({}),
  unknown: Object.freeze([]) as readonly string[],
  inferred: Object.freeze({}),
  start: "simulated",
  end: "simulated",
  late: false,
});

export interface SceneProvenance {
  readonly source: SceneSource;
  /** What a view prints next to the scene: "Live Factory", "Historical replay", "Simulation". */
  readonly label: string;
  /** Simulation only: the fixture's id. Live and replay: the observer's project folder name, if known. */
  readonly origin: string | null;
}

export const PROVENANCE: Readonly<Record<SceneSource, SceneProvenance>> = {
  live: { source: "live", label: "Live Factory", origin: null },
  replay: { source: "replay", label: "Historical replay", origin: null },
  simulation: { source: "simulation", label: "Simulation", origin: null },
};

export function provenance(source: SceneSource, origin: string | null = null): SceneProvenance {
  return origin === null ? PROVENANCE[source] : { ...PROVENANCE[source], origin };
}

/** A range of history the client knows it does not have. */
export interface HistoryGapState {
  /** Event id of the record that reported it (`history.gap`, or the client's own `k:` marker). */
  readonly eventId: string;
  /** Where in history it sits (the reporting event's `t`). */
  readonly at: number;
  readonly reason: string;
  /** Observer gaps: the source partition and sequence range. Client gaps: the cursors. */
  readonly source: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly count: number | null;
  /**
   * The gap's class (observer M6.2 `class`, else read from the reason): `not-received`,
   * `unparsable-line`, `unknown-type`, `state-mismatch`, `evicted`, `source-unreadable`, `conflict`,
   * or the client's own (`cursor-expired`, `observer-index-reset`, `before-window`).
   */
  readonly class: string;
  /**
   * Whether history was lost there. False for `unknown-type` (the records were received, not
   * interpreted) and `conflict` (the first record was kept): those never make a scene partial.
   */
  readonly lost: boolean;
}

/** What each gap class means, for people. */
export const GAP_CLASS_WORDS: Readonly<Record<string, string>> = {
  "not-received": "not received",
  "unparsable-line": "unreadable lines",
  "unknown-type": "received, not interpreted",
  "state-mismatch": "records probably missing",
  evicted: "no longer held by the observer",
  "source-unreadable": "a source could not be read",
  conflict: "a conflicting copy, the first kept",
  "cursor-expired": "missed while away",
  "observer-index-reset": "the observer rebuilt its index",
  "before-window": "before the loaded window",
};

/** A gap's class in words, for people: GAP_CLASS_WORDS, else the class itself. */
export const gapClassWord = (cls: string): string => GAP_CLASS_WORDS[cls] ?? cls.replace(/-/g, " ");

/**
 * How complete the scene's history is, up to this scene's moment:
 * - `complete`: nothing is known to be missing;
 * - `partial`: some history is missing (`gaps`), or some entities' history began part-way (`began`);
 * - `reconstructed`: the scene was seeded from an observer snapshot (`since`), not from events.
 */
export interface Completeness {
  readonly state: "complete" | "partial" | "reconstructed";
  /** `t` from which events are complete: the snapshot's moment, or after the latest gap. Null: from the start. */
  readonly since: number | null;
  readonly gaps: readonly HistoryGapState[];
  /** Entities whose history begins part-way (`history.began`), with the reason and when. */
  readonly began: Readonly<Record<string, { readonly reason: string; readonly at: number; readonly eventId: string }>>;
  /**
   * Records received but not interpreted (gaps of class unknown-type), by source key (`s:<execution>`
   * or `stream/<execution>`): they lose no history, so they never make the scene partial.
   */
  readonly notInterpreted: Readonly<Record<string, number>>;
  /**
   * The observer's own account of its history (observer M6.2 `history`: from `/snapshot`'s
   * `state.history`, `/project`'s `history` or `/health`'s `projection.history`), when the scene was
   * seeded from it: what it lost before what this scene holds. Null: not received.
   */
  readonly observer: ObserverHistory | null;
}

/**
 * How complete the observer's projected history is, by gap class (observer M6.2,
 * `{completeness, lost, not_interpreted, classes, gaps, partial, not_v3}`). `partial` only when
 * history was lost (`lost` is not empty); `unknown-type` records are `notInterpreted` and never
 * make it partial; a `conflict` keeps the first copy and is in `classes` only.
 */
export interface ObserverHistory {
  readonly completeness: "complete" | "partial";
  /** History-losing gap classes and their counts (`not-received`, `unparsable-line`, `state-mismatch`, `evicted`, `source-unreadable`). */
  readonly lost: Readonly<Record<string, number>>;
  /** Records received and not interpreted, by class (`unknown-type`). */
  readonly notInterpreted: Readonly<Record<string, number>>;
  /** Every class seen, with counts. */
  readonly classes: Readonly<Record<string, number>>;
  /** The projection's own reason when history before a position is no longer held (else null). */
  readonly partial: string | null;
}

export const COMPLETE: Completeness = Object.freeze({ state: "complete", since: null, gaps: Object.freeze([]) as readonly HistoryGapState[], began: Object.freeze({}), notInterpreted: Object.freeze({}), observer: null });

/**
 * The degraded and ordinary states a view may draw for a cell, slice, execution or agent
 * (contract 8.1 and the product owner's list). Computed by `activityOf` (selectors.ts), never
 * stored: `stale` depends on the connection.
 */
export const ACTIVITY_STATES = [
  "executing",
  "waiting-dependency",
  "waiting-resources",
  "waiting-person",
  "completed",
  "failed",
  "interrupted",
  "stale",
  "unknown",
] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];
