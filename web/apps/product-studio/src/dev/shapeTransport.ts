/**
 * DEVELOPMENT ONLY. The fixture answers for Shape's operations (M16), used by fixtureTransport under
 * `vite --mode fixtures`. Every answer is a real engine run from web/fixtures (see shapeFixtures.ts and the shape_*
 * scenarios in web/fixtures/product_memory.py). Query parameters before the hash choose a scenario:
 *
 *   ?fixture=status.ideas            the board on the project home and in Shape (any status.ideas-* name works:
 *                                     -stale-verdict, -routes, -settle, -apply, -shaped, -look-back, -changed,
 *                                     -unfinished, -folder, -number-taken, -long-reason, -unreadable). Without it,
 *                                     status has no ideas: Shape's quiet way in.
 *   ?refresh=refresh.ideas | refresh.ideas-changed | refresh.ideas-none-saved
 *   ?ideas=empty | changed | long-reason | unreadable   idea.list (default: the board, every stage and source)
 *   ?faults=empty                     idea.faults (default: two open faults, one already started as IDEA-004)
 *   ?idea=<name>                      idea.show, by fixture suffix: request | exploring | brief-written | fault |
 *                                     not-now | go | change | shaped-one-slice | stale-verdict | stale-route | sized |
 *                                     uncovered | settled | applied | mapped | shaped | blockers | look-back |
 *                                     looked-back | on-github | changed | unfinished | folder | number-taken |
 *                                     long-reason | refused-unreadable. Default: the board's own idea for IDEA-001 to
 *                                     IDEA-008, else exploring. idea.map-status answers for the same idea, so the
 *                                     two always agree.
 *   ?brief=passes | finding | warnings | stale-verdict | change-starter | none   brief.show and brief.check (default by idea)
 *   ?case=none | all-answered | unanswered   case.show and case.check (default: IDEA-003's case, one question not
 *                                     answered on purpose; none: refused, no case yet)
 *   ?verdict=refused-go-without-brief | refused-offline | no-login | long-reason   verdict.record (default: by the decision sent)
 *   ?publish-idea=again | folder | finished | shaped | refused-stopped | refused-no-login | refused-number-taken
 *   ?size=one-slice | epic | several-epics | refused-no-go             idea.size (default: several-epics; epic has
 *                                     high-risk areas not determined)
 *   ?map=refused-stale                idea.map (default: an outcome no slice carries)
 *   ?map-status=<name>                idea.map-status, by fixture suffix (uncovered | settled | applied | sized |
 *                                     blockers | stale-route | mapped | ...); idea.show then answers for the same idea.
 *                                     Default: the same scenario as idea.show.
 *   ?settle=refused-carried           idea.settle (default: by the `as` sent)
 *   ?apply=again | refused-unsettled  idea.apply
 *   ?chain=looked-back                idea.chain (default: missing values)
 *   ?change=refused-replaced          idea.change
 *   ?add=refused-twice | refused-not-template                          idea.add (default: by the source sent)
 *   ?lookback=again | folder | refused-not-shipped | refused-secret     lookback.record (default: by the item sent)
 *   ?show=from-idea, ?resume=from-idea   a slice made from an idea (slice.show, slice.resume)
 *   ?refuse=<operation>               that Shape operation answers with the engine's real refusal
 *
 * The Shape conversation in fixture mode is the scripted one in features/shape/explore/dev/ (its own parameters are
 * in its header); these routes answer only a client that reaches the host's routes directly.
 */
import type { EngineRun, TransportResponse } from "@mach/ui/api";
import { devParam } from "./devState";
import { shapeRuns, type ShapeFixture } from "./shapeFixtures";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function answer(name: ShapeFixture): TransportResponse {
  const found = shapeRuns[name] as EngineRun<unknown>;
  if (found.data !== null) return { status: 200, json: { ok: true, data: clone(found.data) } };
  const error = found.hint ? { kind: "refused", message: found.refused ?? "Refused.", hint: found.hint } : { kind: "refused", message: found.refused ?? "Refused." };
  return { status: 422, json: { ok: false, error } };
}

/** `<prefix>.<suffix>` when that fixture exists, else the fallback. */
function named(prefix: string, suffix: string | null | undefined, fallback: ShapeFixture): ShapeFixture {
  const name = suffix ? `${prefix}.${suffix}` : null;
  return name && Object.hasOwn(shapeRuns, name) ? (name as ShapeFixture) : fallback;
}

/** The board scenario's own idea.show for each of its ideas. */
const boardIdeas: Record<string, string> = {
  "IDEA-001": "request",
  "IDEA-002": "exploring",
  "IDEA-003": "brief-written",
  "IDEA-004": "fault",
  "IDEA-005": "not-now",
  "IDEA-006": "go",
  "IDEA-007": "change",
  "IDEA-008": "shaped-one-slice",
};
const boardBriefs: Record<string, string> = { "IDEA-002": "finding", "IDEA-003": "passes", "IDEA-007": "change-starter" };

/** The real refusal for an operation, used by ?refuse=<operation>. */
const refusals: Partial<Record<string, ShapeFixture>> = {
  "idea.add": "idea.add.refused-twice",
  "idea.publish": "idea.publish.refused-stopped",
  "idea.size": "idea.size.refused-no-go",
  "idea.map": "idea.map.refused-stale",
  "idea.settle": "idea.settle.refused-carried",
  "idea.apply": "idea.apply.refused-unsettled",
  "idea.change": "idea.change.refused-replaced",
  "brief.show": "brief.show.refused-none",
  "case.show": "case.show.refused-none",
  "case.check": "case.show.refused-none",
  "verdict.record": "verdict.record.refused-offline",
  "lookback.record": "lookback.record.refused-not-shipped",
};

const conversationUnavailable: TransportResponse = {
  status: 503,
  json: { ok: false, error: { kind: "unavailable", message: "The Shape conversation does not run with development fixtures. Start Product Studio from Claude Code to talk it through." } },
};

/** Answers one Shape operation (and the Shape conversation's routes), or null when the path is not one of them. */
export function shapeRoute(path: string, method: string, args: Record<string, unknown>): TransportResponse | null {
  if (path.startsWith("/api/interview")) {
    const query = path.includes("?") ? new URLSearchParams(path.slice(path.indexOf("?") + 1)) : null;
    if (query?.has("idea_id")) {
      if (path.startsWith("/api/interview/history")) return { status: 200, json: { ok: true, data: { idea_id: query.get("idea_id"), events: [], truncated: false } } };
      return { status: 200, json: { ok: true, data: { interview: null } } };
    }
    if (path === "/api/interview" && method === "POST" && typeof args.idea_id === "string") return conversationUnavailable;
    return null;
  }
  const op = path.startsWith("/api/ops/") ? path.slice("/api/ops/".length) : null;
  if (!op) return null;
  const refused = devParam("refuse") === op ? refusals[op] : undefined;
  if (refused) return answer(refused);
  const idea = typeof args.idea_id === "string" ? args.idea_id : "";
  switch (op) {
    case "idea.list":
      return answer(named("idea.list", devParam("ideas"), "idea.list.board"));
    case "idea.faults":
      return answer(named("idea.faults", devParam("faults"), "idea.faults"));
    case "idea.show":
      // idea.show and idea.map-status answer for the same idea, captured in the same run, so they always agree.
      return answer(named("idea.show", devParam("idea") ?? devParam("map-status") ?? boardIdeas[idea], "idea.show.exploring"));
    case "idea.add": {
      const given = devParam("add") ?? (args.from_request !== undefined ? "from-request" : args.from_issue !== undefined ? "from-issue" : args.from_fault !== undefined ? "from-fault" : null);
      return answer(named("idea.add", given, "idea.add"));
    }
    case "idea.stage":
      return answer("idea.stage");
    case "idea.lookups":
      return answer("idea.lookups");
    case "idea.renumber":
      return answer("idea.renumber");
    case "idea.publish":
      return answer(named("idea.publish", devParam("publish-idea"), "idea.publish"));
    case "idea.size":
      return answer(named("idea.size", devParam("size") ?? (idea === "IDEA-006" ? "one-slice" : null), "idea.size.several-epics"));
    case "idea.map":
      return answer(named("idea.map", devParam("map"), "idea.map.uncovered"));
    case "idea.map-status":
      return answer(named("idea.map-status", devParam("map-status") ?? devParam("idea") ?? boardIdeas[idea], "idea.map-status.exploring"));
    case "idea.settle":
      return answer(named("idea.settle", devParam("settle") ?? (args.as === "out-of-scope" ? "out-of-scope" : null), "idea.settle"));
    case "idea.apply":
      return answer(named("idea.apply", devParam("apply"), "idea.apply"));
    case "idea.change":
      return answer(named("idea.change", devParam("change"), "idea.change"));
    case "idea.chain":
      return answer(named("idea.chain", devParam("chain"), "idea.chain"));
    case "brief.show":
    case "brief.check": {
      const scenario = devParam("brief") ?? boardBriefs[idea] ?? (idea === "IDEA-001" ? "none" : "passes");
      if (scenario === "none") return answer("brief.show.refused-none");
      return answer(named(op, scenario, op === "brief.show" ? "brief.show.passes" : "brief.check.passes"));
    }
    case "case.show":
    case "case.check": {
      const scenario = devParam("case");
      if (scenario === "none" || (idea !== "" && idea !== "IDEA-003" && scenario === null)) return answer("case.show.refused-none");
      return answer(named(op, scenario, op === "case.show" ? "case.show" : "case.check"));
    }
    case "verdict.record": {
      const decision = args.decision === "no" ? "no" : args.decision === "not-now" ? "not-now" : "go";
      return answer(named("verdict.record", devParam("verdict") ?? decision, "verdict.record.go"));
    }
    case "lookback.record": {
      const given = devParam("lookback") ?? (args.assumption !== undefined ? "assumption" : args.result === "too-early" ? "too-early" : null);
      return answer(named("lookback.record", given, "lookback.record"));
    }
    case "slice.resume":
      return devParam("resume") === "from-idea" ? answer("slice.resume.from-idea") : null;
  }
  return null;
}

/** slice.show for a slice made from an idea (?show=from-idea), or null. */
export function shapeShow(scenario: string | null): unknown {
  return scenario === "from-idea" ? clone(shapeRuns["slice.show.from-idea"].data) : null;
}
