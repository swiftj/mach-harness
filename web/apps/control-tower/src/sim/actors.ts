/**
 * Which part of MACH wrote an event, where it is one of the two non-agent actors. Attribution is
 * by kind, from the real emitters (intake.py, supervisor.py); see ACTOR_KINDS. Intake's own kinds
 * (wave.discovered, intake.validated, slice.materialized, ...) belong to intake, and the engineer's
 * commands to the engineer: neither is attributed here.
 */
import type { AnySimEvent, EventKind } from "./events";
import type { ActorId, ActorState } from "./model";

/** Kinds the supervisor writes (supervisor.py Supervisor.once, decided, start, observe, recover, finish). */
const SUPERVISOR_KINDS: readonly EventKind[] = [
  "revision.discovered",
  "scheduling.decided",
  "work.claimed",
  "execution.started",
  "station.observed",
  "recovery.started",
  "execution.completed",
  "execution.failed",
];
/** Kinds the scheduler writes (intake.py Factory.record and open_cell). */
const SCHEDULER_KINDS: readonly EventKind[] = ["dependency.resolved", "dependency.blocked", "slice.integrated", "work.scheduled"];

export const ACTOR_KINDS: Readonly<Record<ActorId, readonly EventKind[]>> = {
  supervisor: SUPERVISOR_KINDS,
  scheduler: SCHEDULER_KINDS,
};

export const ACTOR_INFO: Readonly<Record<ActorId, { title: string; code: string }>> = {
  supervisor: { title: "Line supervisor", code: "skills/run/scripts/supervisor.py (Supervisor.once, observe, decided, start, recover, finish, park)" },
  scheduler: { title: "Scheduler", code: "skills/run/scripts/intake.py (Factory.plan, record, dispatch, open_cell)" },
};

/**
 * The actor behind an event, or null. human.required has two writers: the scheduler's recorded plan
 * (its reasons read "waiting for ...", or are the plan's own reasons) and the supervisor parking a
 * ticket (Supervisor.park, schedule). The fixture's only one comes from the plan.
 */
export function actorOf(event: AnySimEvent): ActorId | null {
  if (SUPERVISOR_KINDS.includes(event.type)) return "supervisor";
  if (SCHEDULER_KINDS.includes(event.type)) return "scheduler";
  if (event.type === "human.required" && event.source === "supervisor") return /^waiting for /.test(event.data.reason) ? "scheduler" : "supervisor";
  return null;
}

export function emptyActors(): Readonly<Record<ActorId, ActorState>> {
  const make = (id: ActorId): ActorState => ({ id, ...ACTOR_INFO[id], acts: 0, lastActedAt: null, lastSeq: null, lastKind: null });
  return { supervisor: make("supervisor"), scheduler: make("scheduler") };
}
