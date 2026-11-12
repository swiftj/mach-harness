/**
 * What the sheet may say about a thing, read from the scene as recorded (M6_1_EVENT_CONTRACT.md 7 to
 * 8.1): an execution's own start and end, a visit's measured duration, an agent's tool activity as a
 * count when only a count is observable, and the nine activity states with the authority behind them.
 * Pure functions of scene values; no id is parsed, nothing is estimated.
 */
import type { FactoryState } from "@mach/ui";
import type { ActivityState, AgentState, Authority, EntityMeta, ExecutionState, StationVisit, TimeQuality } from "../sim";
import { isKnown, toolActivity } from "../sim";

/** An execution's span: its process's own start and end records where they exist, else the supervisor's. */
export function execSpan(x: ExecutionState): { start: number; end: number | null; startQuality: TimeQuality; endQuality: TimeQuality } {
  const start = x.processStartedAt ?? x.startedAt ?? x.claimedAt;
  const end = x.processEndedAt ?? x.endedAt;
  return { start, end, startQuality: x.meta.start, endQuality: end === null ? "unknown" : x.meta.end };
}

/** A visit's end: its entry plus the duration the station measured, else when it was seen to leave. */
export function visitEnd(v: Pick<StationVisit, "enteredAt" | "leftAt" | "durationMs">): number | null {
  if (v.leftAt === null) return null;
  return v.durationMs !== null ? v.enteredAt + v.durationMs : v.leftAt;
}

/** A time that was placed rather than measured: an inference, or a value the record does not hold. */
export function placed(q: TimeQuality): boolean {
  return q === "inferred" || q === "unknown";
}

/**
 * How many tool calls an agent has made, as known: each call (per-call agents), or the count a
 * workflow snapshot reported (count-only agents; null until the first snapshot).
 */
export function callCount(a: AgentState): number | null {
  const act = toolActivity(a);
  return act.kind === "calls" ? act.calls.length : act.count;
}

/** Whether an agent's calls can be drawn one by one. Workflow agents report only a count (contract D13). */
export function perCall(a: AgentState): boolean {
  return toolActivity(a).kind === "calls";
}

/** "Sonnet", or the recorded model name when it is none of the four tiers, or "model not recorded". */
export function modelWords(a: AgentState, tierWord: string): string {
  if (isKnown(a.meta, "model")) return tierWord;
  return a.modelName ?? "model not recorded";
}

/** An agent's honest status in a few words. */
export function agentStatusWords(a: AgentState, stale: boolean): string {
  switch (a.lifecycle) {
    case "queued":
      return "queued";
    case "running":
      return stale ? "as last seen, working" : "working";
    case "done":
      return "done";
    case "error":
      return "failed";
    case "unknown":
      return "ended, how not recorded";
  }
}

/** "12.4k tokens" */
export function tokenWords(n: number | null): string | null {
  if (n === null) return null;
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`;
}

/** The grammar state that draws an activity (the nine states onto the grammar's seven marks, by shape). */
export function activityMark(a: ActivityState): FactoryState | "unknown" | "stale" {
  switch (a) {
    case "executing":
      return "active";
    case "waiting-dependency":
    case "waiting-resources":
      return "waiting";
    case "waiting-person":
      return "human";
    case "completed":
      return "succeeded";
    case "failed":
    case "interrupted":
      return "failed";
    case "stale":
      return "stale";
    case "unknown":
      return "unknown";
  }
}

const ACTIVITY_WORDS: Record<ActivityState, string> = {
  executing: "running",
  "waiting-dependency": "waiting on a dependency",
  "waiting-resources": "waiting for an execution place",
  "waiting-person": "waiting for a person",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
  stale: "as last seen",
  unknown: "state not recorded",
};

export function activityWords(a: ActivityState): string {
  return ACTIVITY_WORDS[a];
}

/** How a mark is drawn by who stands behind it: solid (authoritative, simulated), the live treatment (observed), dashed and open (reconstructed). */
export function strokeOf(authority: Authority): { dash: string | undefined; open: boolean } {
  return authority === "reconstructed" ? { dash: "3 2", open: true } : { dash: undefined, open: false };
}

/** Whether a field of an entity is a placeholder (not recorded). */
export function unknownField(meta: EntityMeta, field: string): boolean {
  return !isKnown(meta, field);
}
