/**
 * DEVELOPMENT ONLY. Starting a project from nothing (M19), used by fixtureTransport under `vite --mode fixtures` when the
 * address has `?start=`. It answers every operation the start screen and its ways use, from the real engine runs in
 * web/fixtures (written by web/fixtures/start_memory.py in an empty project), and remembers what the person did in this
 * page so each way can be walked end to end: import a PRD, let the scripted conversation record its map, settle the
 * sections, name the product, make the drafts; or add an idea; or start from a request.
 *
 *   ?start=empty (or any value)   nothing yet: the start screen
 *   ?start=requests               nothing yet, and two requests waiting on GitHub
 *   ?start=prd-imported | prd-mapped | prd-settled    a PRD already started, no project
 *   ?start=idea                   an idea already added, no project
 *   ?start=prd-and-idea           both
 *
 * Status is the real run for the state reached. One state has no run of its own and is made from two real runs, as said
 * where it is done: an idea added beside a PRD that is not settled yet. Reloading the page starts again from the
 * parameter.
 */
import type { EngineRun, TransportResponse } from "@mach/ui/api";
import { devParam } from "./devState";

const files = import.meta.glob<EngineRun<unknown>>("../../../../fixtures/*.start*.json", { import: "default", eager: true });
const more = import.meta.glob<EngineRun<unknown>>("../../../../fixtures/prd.apply.refused-no-project.json", { import: "default", eager: true });

function run(name: string): EngineRun<unknown> {
  const found = files[`../../../../fixtures/${name}.json`] ?? more[`../../../../fixtures/${name}.json`];
  if (!found) throw new Error(`fixture ${name} is missing`);
  return found;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function answer(name: string, adjust?: (data: Record<string, unknown>) => void): TransportResponse {
  const found = run(name);
  if (found.data === null) {
    const error = found.hint ? { kind: "refused", message: found.refused ?? "Refused.", hint: found.hint } : { kind: "refused", message: found.refused ?? "Refused." };
    return { status: 422, json: { ok: false, error } };
  }
  const data = clone(found.data) as Record<string, unknown>;
  adjust?.(data);
  return { status: 200, json: { ok: true, data } };
}

type PrdStage = "none" | "imported" | "mapped" | "one-left" | "settled" | "applied";

/** What the person has done on this page, starting from the parameter. */
export const startState = {
  active: false,
  prd: "none" as PrdStage,
  idea: false,
  requests: false,
  project: false,
  epic: false,
  picked: false,
};

function begin(): void {
  if (startState.active) return;
  const given = devParam("start");
  startState.active = true;
  startState.requests = given === "requests";
  startState.prd = given === "prd-imported" ? "imported" : given === "prd-mapped" ? "mapped" : given === "prd-settled" || given === "prd-and-idea" ? "settled" : "none";
  startState.idea = given === "idea" || given === "prd-and-idea";
}

/** True when the address asks for the start scenarios. */
export const startScenario = (): boolean => devParam("start") !== null;

/** The scripted PRD conversation recorded the map. */
export function startMapRecorded(): void {
  if (startState.prd === "none" || startState.prd === "imported") startState.prd = "mapped";
}

function status(): TransportResponse {
  const s = startState;
  if (s.project) {
    if (s.prd === "applied") return answer("status.start-made");
    if (s.prd !== "none") {
      // No run of its own: the project as named (status.start-prd-named) with the PRD as it stands in this page.
      return answer("status.start-prd-named");
    }
    if (s.picked) return answer("status.start-request-picked");
    if (s.epic) return answer("status.start-request-epic");
    return answer("status.start-request-named");
  }
  const withIdea = s.idea;
  // An idea added beside a PRD that is not settled yet has no run of its own: the idea's board is taken from
  // status.start-idea, the rest from the PRD's run.
  const addIdea = (d: Record<string, unknown>) => {
    if (withIdea) d.ideas = clone((run("status.start-idea").data as Record<string, unknown>).ideas);
  };
  switch (s.prd) {
    case "imported":
      return answer("status.start-prd-imported", addIdea);
    case "mapped":
    case "one-left":
      return answer("status.start-prd-mapped", addIdea);
    case "settled":
      return answer(withIdea ? "status.start-prd-and-idea" : "status.start-prd-settled");
    default:
      return answer(withIdea ? "status.start-idea" : s.requests ? "status.start-requests" : "status.start-empty");
  }
}

/** Answers one operation of the start scenarios, or null when the address does not ask for them or it is not one of them. */
export function startRoute(path: string, args: Record<string, unknown>): TransportResponse | null {
  if (!startScenario()) return null;
  begin();
  const op = path.startsWith("/api/ops/") ? path.slice("/api/ops/".length) : null;
  const s = startState;
  switch (op) {
    case "status":
      return status();
    case "refresh":
      return answer(s.requests ? "refresh.start-requests" : "refresh.start-empty");
    case "request.list":
      return answer(s.requests && !s.picked ? "request.list.start" : "request.list.start-empty");
    case "prd.list":
      return answer(s.prd === "none" ? "prd.list.start-empty" : "prd.list.start");
    case "prd.import":
      if (s.prd === "none") s.prd = "imported";
      return answer("prd.import.start");
    case "prd.show":
      return answer("prd.show.start");
    case "prd.status":
      return answer(
        { none: "prd.status.start-no-map", imported: "prd.status.start-no-map", mapped: "prd.status.start-mapped", "one-left": "prd.status.start-one-left", settled: "prd.status.start-settled", applied: "prd.status.start-applied" }[s.prd],
      );
    case "prd.settle":
      if (s.prd === "mapped") {
        s.prd = "one-left";
        return answer("prd.settle.start");
      }
      s.prd = "settled";
      return answer("prd.settle.start-last");
    case "prd.apply":
      if (!s.project) return answer("prd.apply.refused-no-project");
      s.prd = "applied";
      return answer("prd.apply.start");
    case "project.init":
      s.project = true;
      return answer("project.init.start");
    case "idea.add":
      s.idea = true;
      return answer("idea.add.start");
    case "idea.list":
      return answer(s.idea ? "idea.list.start" : "idea.list.start-empty");
    case "epic.add":
      s.epic = true;
      return answer("epic.add.start");
    case "request.pick":
      s.picked = true;
      return answer("request.pick.start");
  }
  void args;
  return null;
}
