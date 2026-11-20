/**
 * DEVELOPMENT ONLY. The fixture answers for the M15 operations (M13 and M14 in the engine), used by
 * fixtureTransport under `vite --mode fixtures`. Every answer is a real engine run from
 * web/fixtures (see productMemoryFixtures.ts). Query parameters before the hash choose a scenario:
 *
 *   ?principles=empty | unpublished (default) | newer-elsewhere   principle.list
 *   ?epic=nothing-shipped | after-retire                          epic.current
 *   ?prd=empty                                                    prd.list (no PRD imported)
 *   ?prd-status=no-map | uncovered (default) | one-left | applied prd.status
 *   ?mocks=empty                                                  slice.mock.list
 *   ?resume=principles-policies | shipped-rules | from-prd | idea-request   slice.resume
 *   ?refuse=<operation>                                           that operation answers with the engine's real refusal
 *
 * New status, show and refresh scenarios go through fixtureTransport's own parameters:
 *   ?fixture=status.principles | status.shipped-moved | status.prds | status.jira-mocks
 *   ?show=open-concern | concern-accepted | effects | mocks-and-jira
 *   ?refresh=refresh.shipped-moved | refresh.principles-newer-elsewhere | refresh.idea-request
 *   ?ready=with-mocks | refused-open-concern
 *
 * The host adds `downloads` to jira.export's answer; here each offered file is a short text that
 * says it is a development fixture, since the real files exist only on the engine's side.
 */
import type { EngineRun, TransportResponse } from "@mach/ui/api";
import { devParam } from "./devState";
import { memoryRuns, type MemoryFixture } from "./productMemoryFixtures";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function answer(name: MemoryFixture): TransportResponse {
  const found = memoryRuns[name] as EngineRun<unknown>;
  if (found.data !== null) return { status: 200, json: { ok: true, data: clone(found.data) } };
  const error = found.hint ? { kind: "refused", message: found.refused ?? "Refused.", hint: found.hint } : { kind: "refused", message: found.refused ?? "Refused." };
  return { status: 422, json: { ok: false, error } };
}

/** The real refusal for an operation, used by ?refuse=<operation>. */
const refusals: Partial<Record<string, MemoryFixture>> = {
  "principle.add": "principle.add.refused-wording",
  "principle.set": "principle.add.refused-wording",
  "principle.publish": "principle.publish.refused-newer-elsewhere",
  "policy.accept": "policy.accept.refused",
  "epic.current": "epic.current.refused-name",
  "slice.link": "slice.link.refused-form",
  "epic.link": "slice.link.refused-form",
  "jira.export": "jira.export.refused-epic",
  "jira.keys": "jira.keys.refused-not-csv",
  "prd.import": "prd.import.refused-format",
  "prd.apply": "prd.apply.refused-unsettled",
  "prd.confirm": "prd.confirm.refused-contradiction",
  "slice.mock.add": "slice.mock.add.refused-not-a-picture",
  "slice.ready": "slice.ready.refused-open-concern",
};

function withDownloads(name: MemoryFixture): TransportResponse {
  const response = answer(name);
  const envelope = response.json as { ok: boolean; data?: Record<string, unknown> };
  if (envelope.ok && envelope.data) {
    const text = (file: string) => `data:text/plain;charset=utf-8,${encodeURIComponent(`Development fixture: the host serves the real ${file} here.`)}`;
    envelope.data.downloads = [
      { name: "mach-jira.csv", url: text("mach-jira.csv"), bytes: 0 },
      { name: "README.txt", url: text("README.txt"), bytes: 0 },
    ];
  }
  return response;
}

/** Answers one M15 operation, or null when the path is not one of them. */
export function memoryRoute(path: string, args: Record<string, unknown>): TransportResponse | null {
  const op = path.startsWith("/api/ops/") ? path.slice("/api/ops/".length) : null;
  if (!op) return null;
  const refused = devParam("refuse") === op ? refusals[op] : undefined;
  if (refused) return answer(refused);
  switch (op) {
    case "principle.list": {
      const scenario = devParam("principles");
      return answer(scenario === "empty" ? "principle.list.empty" : scenario === "newer-elsewhere" ? "principle.list.newer-elsewhere" : "principle.list.unpublished");
    }
    case "principle.add":
      return answer("principle.add");
    case "principle.set":
      return answer("principle.set");
    case "principle.retire":
      return answer("principle.retire");
    case "principle.publish":
      return answer("principle.publish");
    case "reconcile.principles":
      return answer("reconcile.principles");
    case "policy.list":
      return answer("policy.list");
    case "policy.accept":
      return answer("policy.accept");
    case "epic.current": {
      const scenario = devParam("epic");
      return answer(scenario === "nothing-shipped" ? "epic.current.nothing-shipped" : scenario === "after-retire" ? "epic.current.after-retire" : "epic.current");
    }
    case "epic.link":
      return answer(args.remove === true ? "epic.link.already-ready" : "epic.link");
    case "slice.link":
      return answer(args.remove === true ? "slice.link.remove" : "slice.link");
    case "jira.export":
      return withDownloads(args.state === "all" ? "jira.export.all" : "jira.export");
    case "jira.keys":
      return answer(args.dry_run === true ? "jira.keys.dry-run" : "jira.keys");
    case "prd.import":
      return answer("prd.import");
    case "prd.list":
      return answer(devParam("prd") === "empty" ? "prd.list.empty" : "prd.list");
    case "prd.show":
      return answer(typeof args.lines === "string" ? "prd.show.lines" : "prd.show");
    case "prd.map":
      return answer("prd.map");
    case "prd.settle":
      return answer(args.as === "out-of-scope" ? "prd.settle.out-of-scope" : "prd.settle");
    case "prd.status": {
      const scenario = devParam("prd-status");
      return answer(
        scenario === "no-map" ? "prd.status.no-map" : scenario === "one-left" ? "prd.status.one-left" : scenario === "applied" ? "prd.status.applied" : "prd.status.uncovered",
      );
    }
    case "prd.apply":
      return answer("prd.apply");
    case "prd.draft":
      return answer("prd.draft");
    case "prd.confirm":
      return answer("prd.confirm");
    case "slice.mock.list":
      return answer(devParam("mocks") === "empty" ? "slice.mock.list.empty" : "slice.mock.list");
    case "slice.mock.add":
      return answer(typeof args.for === "string" ? "slice.mock.add" : "slice.mock.add.whole");
    case "slice.mock.remove":
      return answer("slice.mock.remove");
    case "slice.resume": {
      const scenario = devParam("resume");
      const chosen: MemoryFixture | null =
        scenario === "principles-policies"
          ? "slice.resume.principles-policies"
          : scenario === "shipped-rules"
            ? "slice.resume.shipped-rules"
            : scenario === "from-prd"
              ? "slice.resume.from-prd"
              : scenario === "idea-request"
                ? "slice.resume.idea-request"
                : null;
      return chosen ? answer(chosen) : null;
    }
  }
  return null;
}

/** The M15 slice.show scenarios (?show=...), or null. */
export function memoryShow(scenario: string | null): unknown {
  const chosen: MemoryFixture | null =
    scenario === "open-concern"
      ? "slice.show.open-concern"
      : scenario === "concern-accepted"
        ? "slice.show.concern-accepted"
        : scenario === "effects"
          ? "slice.show.effects"
          : scenario === "mocks-and-jira"
            ? "slice.show.mocks-and-jira"
            : null;
  return chosen ? clone(memoryRuns[chosen].data) : null;
}
