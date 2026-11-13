/**
 * The inspector's and the header's wording for facts the M6.2 acceptance run found misread (D4, D7,
 * D8, D13, D14, D17), as plain functions over the scene's own state, so they are tested
 * (test/m62-acceptance.test.mjs) rather than left inside JSX. No React here.
 */
import { GAP_CLASS_WORDS, type Completeness, type PlanFacts, type StreamObservationState, type VisitStatus } from "../../sim";
import type { ConnectionStatus, RuntimeSummary } from "../../scene/connection";

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/**
 * Agents and tools of an execution or a cell (D7): a count only when its stream was read; otherwise
 * "Not observed" with the reason, never "0". A count from a runtime the observer has not proved (or
 * whose records were partly refused) says so after the count, never silently.
 */
export function agentsWords(observation: StreamObservationState | null, started: number, working?: number): string {
  if (observation && observation.state === "not-observed") return `Not observed: ${observation.reason ?? "no stream was read for it."}`;
  const count = working === undefined ? String(started) : `${working} working, ${started} so far`;
  const note = observation ? activityNote(observation) : null;
  return note ? `${count}: ${note}` : count;
}

/**
 * How agent activity read from a stream stands, in a phrase (observer M6.2 runtime states), or null
 * when nothing needs saying (a proven runtime, or an observer that does not judge it).
 */
export function activityNote(observation: StreamObservationState): string | null {
  const v = observation.version ? ` (${observation.version})` : "";
  switch (observation.state) {
    case "unproven":
      return observation.runtime === "unknown" ? "agent activity from a Claude Code version its stream has not stated yet" : `agent activity from an unproven Claude Code version${v}`;
    case "partial":
      return `agent activity from Claude Code${v}; some of its records were refused, so some may be missing`;
    default:
      return null;
  }
}

/** The runtime's state in words, for the Record block and the connection facts (observer M6.2). */
export function runtimeStateWords(observation: StreamObservationState): string {
  const named = observation.version ? `Claude Code ${observation.version}` : "Claude Code, version not recorded";
  switch (observation.runtime) {
    case "proven":
      return `${named}: proven (the observer's fixtures come from this version)`;
    case "compatible-unproven":
      return `${named}: compatible, unproven (every record matched the known shapes)`;
    case "incompatible":
      return `${named}: some records refused for their shape${observation.recordsRefused ? ` (${observation.recordsRefused.toLocaleString("en-GB")})` : ""}; nothing of them is shown`;
    case "unknown":
      return `${named}: not stated by its stream yet`;
    default:
      return observation.state === "not-observed" ? `${named}: agents and tools not observed` : `${named}: not judged by this observer`;
  }
}

/**
 * Every execution stream's runtime, summed by the observer (`ingest.runtime`): the worst state and
 * the versions seen, e.g. "2.1.323 compatible, unproven (3 executions)". Null before any stream.
 */
export function runtimeSummaryWords(summary: RuntimeSummary): string | null {
  const known = summary.versions.filter((v) => v.version);
  if (!known.length) return summary.state === "unknown" ? null : RUNTIME_WORDS[summary.state];
  return known
    .map((v) => `${v.version} ${v.state ? RUNTIME_WORDS[v.state] : "not judged"}${v.executions ? ` (${plural(v.executions, "execution")})` : ""}${v.recordsRefused ? `, ${plural(v.recordsRefused, "record")} refused` : ""}`)
    .join("; ");
}

const RUNTIME_WORDS: Readonly<Record<RuntimeSummary["state"], string>> = {
  proven: "proven",
  "compatible-unproven": "compatible, unproven",
  incompatible: "some records refused",
  unknown: "not stated yet",
};

/** The note under an execution's runtime version: said whenever the runtime is not proven. */
export function runtimeWords(observation: StreamObservationState): string | null {
  if (observation.state === "unproven" || observation.state === "partial") return `${runtimeStateWords(observation)}. ${observation.reason ?? ""}`.trim();
  if (observation.state === "not-observed" && observation.version) return `Claude Code ${observation.version}: agents and tools not observed.`;
  return null;
}

/**
 * The plan's facts on a cell (D11, observer M6.2): app type, risk, contract and task counts, each
 * "not recorded" when the plan's exit did not say it, and where they came from.
 */
export function planWords(plan: PlanFacts): string {
  const parts = [
    plan.appType ? `app type ${plan.appType}` : "app type not recorded",
    plan.risk ? `${plan.risk} risk` : "risk not recorded",
    plan.contracts !== null ? plural(plan.contracts, "contract") : "contracts not recorded",
    plan.tasks !== null ? plural(plan.tasks, "task") : "tasks not recorded",
  ];
  const from = plan.authority === "reconstructed" ? "from the observer's summary of the plan's exit" : "recorded at the plan's exit";
  return `${parts.join(", ")} (${from})`;
}

/**
 * The header's completeness badge (D8). Partial only where history was lost; records received and
 * not interpreted (unknown-type) are said as such, never as "could not be received".
 */
export function completenessWords(c: Completeness): { state: "partial" | "reconstructed" | "not-interpreted"; why: string } | null {
  const lost = c.gaps.filter((g) => g.lost);
  let notInterpreted = 0;
  for (const n of Object.values(c.notInterpreted)) notInterpreted += n;
  const began = Object.keys(c.began).length;
  const parts: string[] = [];
  if (lost.length) parts.push(`${plural(lost.length, "range")} of history ${lost.length === 1 ? "was" : "were"} lost (${[...new Set(lost.map((g) => GAP_CLASS_WORDS[g.class] ?? g.class))].join(", ")}).`);
  if (began) parts.push(`${began} entit${began === 1 ? "y's" : "ies'"} history begins part-way.`);
  if (notInterpreted) parts.push(`Received, not interpreted (${plural(notInterpreted, "record")}).`);
  // The observer's own account (observer M6.2 `history`), received with what seeded the scene: what
  // it lost before then, by class. Records it did not interpret are not lost and are not said here.
  const observerLost = c.observer ? Object.entries(c.observer.lost).filter(([, n]) => n > 0) : [];
  if (observerLost.length) parts.push(`The observer's own history is partial (${observerLost.map(([cls, n]) => `${GAP_CLASS_WORDS[cls] ?? cls}: ${n.toLocaleString("en-GB")}`).join(", ")}).`);
  if (c.state === "reconstructed") return { state: "reconstructed", why: ["Part of what is shown was seeded from the observer's projected state, not from events.", ...parts].join(" ") };
  if (c.state === "partial") return { state: "partial", why: parts.join(" ") || "Some history is missing." };
  if (notInterpreted) return { state: "not-interpreted", why: parts.join(" ") };
  return null;
}

/** What each gap class means, for people (kept with the gap's type, in sim/provenance.ts). */
export { GAP_CLASS_WORDS } from "../../sim";

/** A visit's or a gate's elapsed-time words (D4, D14): at work, waiting for a person, or bounded. */
export function elapsedWords(status: VisitStatus["state"] | "work" | "wait", started: boolean, finished: boolean, duration: string): string {
  if (!started) return "not started";
  if (status === "ended-unrecorded") return `ended without an exit record, within ${duration}`;
  if (finished) return `took ${duration}`;
  return status === "waiting-person" || status === "wait" ? `waiting for ${duration}` : `at work for ${duration}`;
}

/**
 * What the connection holds (D17): what arrived, what is held, and the observer's own total when only
 * part is held ("of N"). `late` is the observer's own flag; arrivals placed before what was already
 * held are reordered, not late.
 */
export function receivedWords(c: Pick<ConnectionStatus, "received" | "duplicates" | "late" | "held" | "total" | "reordered">): string {
  const parts = [`${plural(c.received, "event")} received`];
  if (c.total !== null && c.held !== null && c.held < c.total) parts.push(`${c.held.toLocaleString("en-GB")} held of ${c.total.toLocaleString("en-GB")}`);
  else if (c.total !== null) parts.push(`all ${c.total.toLocaleString("en-GB")} held`);
  if (c.duplicates) parts.push(`${c.duplicates.toLocaleString("en-GB")} repeated`);
  if (c.late) parts.push(`${c.late.toLocaleString("en-GB")} marked late by the observer`);
  if (c.reordered) parts.push(`${c.reordered.toLocaleString("en-GB")} placed before events already shown`);
  return parts.join(", ");
}

/** The observer's delivery lag (read to commit to sent), in words. */
export function deliveryLagWords(ms: number | null): string {
  if (ms === null) return "Not reported";
  if (ms < 1000) return "under a second";
  return `${(ms / 1000).toFixed(1)} s`;
}
