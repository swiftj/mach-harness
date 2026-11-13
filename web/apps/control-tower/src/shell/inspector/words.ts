/**
 * The inspector's and the header's wording for facts the M6.2 acceptance run found misread (D4, D7,
 * D8, D13, D14, D17), as plain functions over the scene's own state, so they are tested
 * (test/m62-acceptance.test.mjs) rather than left inside JSX. No React here.
 */
import type { Completeness, StreamObservationState, VisitStatus } from "../../sim";
import type { ConnectionStatus } from "../../scene/connection";

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/**
 * Agents and tools of an execution or a cell (D7): a count only when its stream was read; otherwise
 * "Not observed" with the reason, never "0".
 */
export function agentsWords(observation: StreamObservationState | null, started: number, working?: number): string {
  if (observation && observation.state === "not-observed") return `Not observed: ${observation.reason ?? "no stream was read for it."}`;
  const count = working === undefined ? String(started) : `${working} working, ${started} so far`;
  return observation?.state === "unproven" ? `${count} (unproven runtime version)` : count;
}

/** The note under an execution's runtime version: quiet when the version is compatible but unproven. */
export function runtimeWords(observation: StreamObservationState): string | null {
  if (observation.state === "unproven") return `Claude Code ${observation.version ?? "(version not recorded)"}: unproven runtime version; its records matched the known shapes.`;
  if (observation.state === "not-observed" && observation.version) return `Claude Code ${observation.version}: agents and tools not observed.`;
  return null;
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
  if (c.state === "reconstructed") return { state: "reconstructed", why: ["Part of what is shown was seeded from an observer snapshot, not from events.", ...parts].join(" ") };
  if (c.state === "partial") return { state: "partial", why: parts.join(" ") || "Some history is missing." };
  if (notInterpreted) return { state: "not-interpreted", why: parts.join(" ") };
  return null;
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
