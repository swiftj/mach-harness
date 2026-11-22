/**
 * DEVELOPMENT ONLY. The fixture answers for a small change (M18), used by fixtureTransport under `vite --mode fixtures`.
 * Every answer is a real engine run from web/fixtures (see smallFixtures.ts and web/fixtures/small_memory.py). Query
 * parameters before the hash choose a scenario:
 *
 *   ?fixture=status.small-drafting | status.small-changes | status.small-ready     which status the app sees
 *   ?show=small-drafting | small | small-fix | small-widened | small-widened-asked | small-ready
 *                                     slice.show (and slice.check) for the slice the screen asks about
 *   ?resume=small | small-fix | small-widened                                       slice.resume
 *   ?epic=small                       epic.current: the epic with the shipped rules a fix chooses from
 *   ?small-start=refused-not-in-force slice.new with a fix answers with the engine's refusal
 *   ?widen=refused-already | refused-full                                           slice.widen (default: widened)
 *   ?ready=small | small-widened      slice.ready of a small change: marked ready, or made a full slice instead
 *   ?show=small-widened-at-ready      the slice that marking ready made a full slice
 *
 * slice.new with `small` answers the engine's small change (a fix or an adjustment, by the kind sent); without it, the
 * engine's full slice. request.pick with `small` is answered by requestFixtures.ts from request.pick.small. The answers'
 * slice ID is set to the one the screen asked about, as fixtureTransport does for slice.ready.
 */
import type { EngineRun, TransportResponse } from "@mach/ui/api";
import { devParam } from "./devState";
import { smallRuns, type SmallFixture } from "./smallFixtures";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function answer(name: SmallFixture, sliceId?: string): TransportResponse {
  const found = smallRuns[name] as EngineRun<unknown>;
  if (found.data === null) return { status: 422, json: { ok: false, error: { kind: "refused", message: found.refused ?? "Refused." } } };
  const data = clone(found.data) as { slice?: { slice_id: string } };
  if (sliceId && data.slice) data.slice.slice_id = sliceId;
  return { status: 200, json: { ok: true, data } };
}

function named(prefix: string, suffix: string | null, fallback: SmallFixture | null): SmallFixture | null {
  const name = suffix ? `${prefix}.${suffix}` : null;
  return name && Object.hasOwn(smallRuns, name) ? (name as SmallFixture) : fallback;
}

/** The M18 slice.show scenarios (?show=small...), or null. */
export function smallShow(scenario: string | null): unknown {
  const chosen = named("slice.show", scenario, null);
  return chosen ? clone(smallRuns[chosen].data) : null;
}

/** Answers one small change operation, or null when the request is not one this module answers. */
export function smallRoute(path: string, args: Record<string, unknown>): TransportResponse | null {
  const op = path.startsWith("/api/ops/") ? path.slice("/api/ops/".length) : null;
  const sliceId = typeof args.slice_id === "string" ? args.slice_id : undefined;
  switch (op) {
    case "slice.new": {
      const small = args.small as { change?: string } | undefined;
      if (!small) return null;
      if (small.change === "fix") {
        return answer(devParam("small-start") === "refused-not-in-force" ? "slice.new.refused-small-not-in-force" : "slice.new.small-fix");
      }
      return answer("slice.new.small");
    }
    case "slice.widen":
      return answer(named("slice.widen", devParam("widen"), "slice.widen") ?? "slice.widen", sliceId);
    case "slice.resume": {
      const chosen = named("slice.resume", devParam("resume"), null);
      return chosen ? answer(chosen, sliceId) : null;
    }
    case "slice.ready": {
      const chosen = devParam("ready") === "small" ? "slice.ready.small" : devParam("ready") === "small-widened" ? "slice.ready.small-widened" : null;
      return chosen ? answer(chosen, sliceId) : null;
    }
    case "epic.current":
      return devParam("epic") === "small" ? answer("epic.current.small") : null;
  }
  return null;
}
