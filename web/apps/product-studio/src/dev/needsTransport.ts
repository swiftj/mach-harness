/**
 * DEVELOPMENT ONLY. The fixture answers for Technical needs and a design you already have (M17), used by
 * fixtureTransport under `vite --mode fixtures`. Every answer is a real engine run from web/fixtures (see
 * needsFixtures.ts and web/fixtures/needs_memory.py). Query parameters before the hash choose a scenario:
 *
 *   ?fixture=status.needs-none | status.needs-unpublished | status.needs-adr-behind | status.needs-newer-elsewhere |
 *            status.designs-unsettled | status.designs-published        which status the app sees (any status.* works)
 *   ?refresh=refresh.needs-newer-elsewhere                                another product manager's newer needs
 *   ?needs=empty | answered-some | published | several | adr-behind | newer-elsewhere
 *                                     need.list (default: several: needs in several kinds, a given, one kind with
 *                                     nothing to say, a retired need, unpublished changes)
 *   ?need-add=data | given | refused-technology | refused-given-without-who   need.add (default: by the kind sent)
 *   ?need-set=why | refused-retired   need.set (default: a new revision of the statement)
 *   ?need-none=refused-has-need       need.none
 *   ?publish-needs=again | refused-none | refused-newer-elsewhere   need.publish (default: to GitHub and the folder)
 *   ?reconcile-needs=refused-nothing-newer                            reconcile.needs (default: theirs taken)
 *   ?designs=empty | imported | mapped | published   design.list (default: mapped, one conflict waiting)
 *   ?design=unmapped | mapped | settled | published | lines   design.show (default: follows ?designs)
 *   ?import-design=again              design.import (default: brought in as DES-01)
 *   ?settle-design=refused-no-conflict                                design.settle
 *   ?publish-design=again | refused-unsettled | refused-no-map        design.publish
 *   ?refuse=<operation>               that operation answers with the engine's real refusal
 *
 * The needs conversation in fixture mode is the scripted one in features/needs/shell/dev/ (its parameters are in its
 * header); these routes answer only a client that reaches the host's routes directly.
 */
import type { EngineRun, TransportResponse } from "@mach/ui/api";
import { devParam } from "./devState";
import { needsRuns, type NeedsFixture } from "./needsFixtures";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function answer(name: NeedsFixture): TransportResponse {
  const found = needsRuns[name] as EngineRun<unknown>;
  if (found.data !== null) return { status: 200, json: { ok: true, data: clone(found.data) } };
  const error = found.hint ? { kind: "refused", message: found.refused ?? "Refused.", hint: found.hint } : { kind: "refused", message: found.refused ?? "Refused." };
  return { status: 422, json: { ok: false, error } };
}

/** `<prefix>.<suffix>` when that fixture exists, else the fallback. */
function named(prefix: string, suffix: string | null | undefined, fallback: NeedsFixture): NeedsFixture {
  const name = suffix ? `${prefix}.${suffix}` : null;
  return name && Object.hasOwn(needsRuns, name) ? (name as NeedsFixture) : fallback;
}

/** The real refusal for an operation, used by ?refuse=<operation>. */
const refusals: Partial<Record<string, NeedsFixture>> = {
  "need.add": "need.add.refused-technology",
  "need.set": "need.set.refused-retired",
  "need.none": "need.none.refused-has-need",
  "need.publish": "need.publish.refused-newer-elsewhere",
  "reconcile.needs": "reconcile.needs.refused-nothing-newer",
  "design.settle": "design.settle.refused-no-conflict",
  "design.publish": "design.publish.refused-unsettled",
};

/** design.show for the scenario design.list is in. */
const shownFor: Record<string, string> = { imported: "unmapped", mapped: "mapped", published: "published" };

const conversationUnavailable: TransportResponse = {
  status: 503,
  json: { ok: false, error: { kind: "unavailable", message: "The needs conversation does not run with development fixtures. Start Product Studio from Claude Code to talk it through." } },
};

/** Answers one needs or design operation (and the needs conversation's routes), or null when the path is not one of them. */
export function needsRoute(path: string, method: string, args: Record<string, unknown>): TransportResponse | null {
  if (path.startsWith("/api/interview")) {
    const query = path.includes("?") ? new URLSearchParams(path.slice(path.indexOf("?") + 1)) : null;
    if (query?.get("needs") === "true") {
      if (path.startsWith("/api/interview/history")) return { status: 200, json: { ok: true, data: { needs: true, events: [], truncated: false } } };
      return { status: 200, json: { ok: true, data: { interview: null } } };
    }
    if (path === "/api/interview" && method === "POST" && args.needs === true) return conversationUnavailable;
    return null;
  }
  const op = path.startsWith("/api/ops/") ? path.slice("/api/ops/".length) : null;
  if (!op) return null;
  const refused = devParam("refuse") === op ? refusals[op] : undefined;
  if (refused) return answer(refused);
  switch (op) {
    case "need.list":
      return answer(named("need.list", devParam("needs"), "need.list.several"));
    case "need.add":
      return answer(named("need.add", devParam("need-add") ?? (args.kind === "given" ? "given" : args.kind === "data" ? "data" : null), "need.add"));
    case "need.set":
      return answer(named("need.set", devParam("need-set"), "need.set"));
    case "need.retire":
      return answer("need.retire");
    case "need.none":
      return answer(named("need.none", devParam("need-none"), "need.none"));
    case "need.publish":
      return answer(named("need.publish", devParam("publish-needs"), "need.publish"));
    case "reconcile.needs":
      return answer(named("reconcile.needs", devParam("reconcile-needs"), "reconcile.needs"));
    case "design.list":
      return answer(named("design.list", devParam("designs"), "design.list.mapped"));
    case "design.import":
      return answer(named("design.import", devParam("import-design"), "design.import"));
    case "design.show": {
      if (typeof args.lines === "string" && devParam("design") === null) return answer("design.show.lines");
      const scenario = devParam("design") ?? shownFor[devParam("designs") ?? "mapped"];
      return answer(named("design.show", scenario, "design.show.mapped"));
    }
    case "design.settle":
      return answer(named("design.settle", devParam("settle-design"), "design.settle"));
    case "design.publish":
      return answer(named("design.publish", devParam("publish-design"), "design.publish"));
  }
  return null;
}
