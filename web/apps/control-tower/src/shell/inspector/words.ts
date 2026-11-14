/**
 * The inspector's and the header's wording for facts the M6.2 acceptance run found misread (D4, D7,
 * D8, D13, D14, D17), as plain functions over the scene's own state, so they are tested
 * (test/m62-acceptance.test.mjs) rather than left inside JSX. No React here.
 */
import { GAP_CLASS_WORDS, MODELS, type Completeness, type PlanFacts, type StationVisit, type StreamObservationState, type VisitStatus } from "../../sim";
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
export function elapsedWords(status: VisitStatus["state"] | "work" | "wait" | "interrupted" | "open", started: boolean, finished: boolean, duration: string): string {
  if (!started) return "not started";
  // An open wave, slice, cell or round (X2): open, never at work.
  if (status === "open") return finished ? `open ${duration}, then closed` : `open ${duration}`;
  if (status === "ended-unrecorded") return `ended without an exit record, within ${duration}`;
  // Entry to exit of a visit that stopped and was taken up again: a span, never time spent working.
  if (status === "interrupted") return finished ? `open for ${duration}, not continuous` : `open for ${duration}`;
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

/** Why a visit's span is not working time: where it stopped before it was taken up again. Null when it ran through. */
export function interruptionWords(visit: Pick<StationVisit, "interrupted">, clock: (t: number) => string): string | null {
  if (!visit.interrupted) return null;
  return visit.interrupted.reason === "execution-ended" ? `its execution ended by ${clock(visit.interrupted.at)} and the visit was taken up again later` : `the station was entered again at ${clock(visit.interrupted.at)} before this visit recorded its exit`;
}

/**
 * When a visit left, in words (R4): still open, waiting for a person, or ended without an exit
 * record at a bound. Plain text with the time formatted by `clock` (never an element, so it can
 * never print as "[object Object]"). An ended visit with an exit record is its own time.
 */
export function visitLeftWords(visit: Pick<StationVisit, "leftAt">, status: Pick<VisitStatus, "state">, clock: (t: number) => string): string {
  if (visit.leftAt === null) return status.state === "waiting-person" ? "not yet: waiting for a person" : "still open";
  if (status.state === "ended-unrecorded") return `no exit record; ended by ${clock(visit.leftAt)} at the latest`;
  return clock(visit.leftAt);
}

/** Cost by model from the last `execution.usage` among `entries` (the caller passes only what happened by the playhead). */
export function modelCostsOf(entries: readonly { readonly event: { readonly type: string } }[]): Array<[string, number | null]> {
  const usage = [...entries].reverse().find((e) => e.event.type === "execution.usage");
  if (!usage) return [];
  const models = ((usage.event as { data?: { models?: Record<string, { cost_usd?: number | null }> } }).data?.models ?? {}) as Record<string, { cost_usd?: number | null }>;
  return Object.entries(models).map(([name, m]): [string, number | null] => [name, typeof m.cost_usd === "number" ? m.cost_usd : null]);
}

/** A slice's own title, or null when it has none but its id (the reducer names an untitled slice by its id). */
export function sliceTitle(s: { readonly id: string; readonly title: string }): string | null {
  const t = s.title.trim();
  return t && t !== s.id ? t : null;
}

/** What a Timeline span picked through an ancestor is called, by its ref's grammar. */
export function pickedWords(detail: string): string {
  if (/^visit:.*\/task:/.test(detail)) return "a build task";
  if (detail.startsWith("visit:")) return "a station visit";
  if (/^gate:.*\/round#/.test(detail)) return "a review round";
  if (/^gate:.*\/required:/.test(detail)) return "a wait on a person";
  if (detail.startsWith("workflow:")) return "a workflow";
  if (detail.startsWith("seat:")) return "a review seat";
  if (detail.startsWith("gate:")) return "a wait at a gate";
  return "a span";
}

/**
 * The note above an entity selected through a span the store cannot select itself (a wait on a
 * person, a round, a seat). It never says nothing more is known: what the Timeline holds for the span
 * (its record's reasons, since when, until when or still open, how it is known) is the In time
 * section, shown first; the selected ancestor's own record follows.
 */
export function pickedThroughWords(detail: string, kindWord: string): string {
  return `You picked ${pickedWords(detail)} on the Timeline. It is not selectable on its own: what its span records is under In time, first; its ${kindWord.toLowerCase()}'s own record follows.`;
}

/** A seat's model by its name ("Claude Opus 5.5"); a model the vocabulary does not know, as recorded; null when none is. */
export function seatModelName(model: string | null | undefined): string | null {
  if (!model) return null;
  return (MODELS as Readonly<Record<string, { name: string }>>)[model]?.name ?? model;
}

/** The reviewer of a review seat, by the seat and model its record carries: never by its agent's opaque id. */
export function reviewerWords(seat: string, model: string | null): string {
  return `The ${seat} seat's reviewer${model ? `, on ${model}` : ""}`;
}

/**
 * A station on its own (`station:verify`, the Factory-level station, I-22): its visits across every
 * cell, never "Not visited" when a cell has been there. `cells` is the scene's cells at the playhead.
 */
export function stationAcrossWords(
  cells: Readonly<Record<string, { readonly station: string | null; readonly visits: readonly Pick<StationVisit, "station" | "enteredAt" | "leftAt">[] }>>,
  station: string,
): { word: string; visits: number; cells: number; working: number; last: Pick<StationVisit, "enteredAt" | "leftAt"> | undefined } {
  let visits = 0;
  let visited = 0;
  let working = 0;
  let last: Pick<StationVisit, "enteredAt" | "leftAt"> | undefined;
  for (const cell of Object.values(cells)) {
    const here = cell.visits.filter((v) => v.station === station);
    if (here.length) visited += 1;
    visits += here.length;
    for (const v of here) if (!last || v.enteredAt >= last.enteredAt) last = v;
    if (cell.station === station) working += 1;
  }
  const word = working ? `At work in ${plural(working, "cell")} now` : visits ? `Visited ${plural(visits, "time")} across ${plural(visited, "cell")}` : "Not visited";
  return { word, visits, cells: visited, working, last };
}
