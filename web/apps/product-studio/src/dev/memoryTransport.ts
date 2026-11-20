/**
 * DEVELOPMENT ONLY. The fixture answers for the M15 operations (M13 and M14 in the engine), used by
 * fixtureTransport under `vite --mode fixtures`. Every answer is a real engine run from
 * web/fixtures (see productMemoryFixtures.ts). Query parameters before the hash choose a scenario:
 *
 *   ?principles=empty | unpublished (default) | newer-elsewhere | never-published | published | unfinished
 *               | changed-on-github | folder                      principle.list
 *   ?publish=folder | refused-stopped | refused-offline           principle.publish (default: published on GitHub)
 *   reconcile.principles answers "take theirs" or "keep mine" by the choice sent
 *   ?policies=empty | problems | older                            policy.list
 *   ?accept=checked | refused-owner                               policy.accept (default: not checked against the owner)
 *   ?epic=nothing-shipped | after-retire | problems | unreadable  epic.current
 *   ?link=already-ready                                           epic.link (default: no slice marked ready)
 *   ?keys=reopen                                                  jira.keys (slices to reopen, epics with ready slices)
 *   ?export=cut                                                   jira.export (a description cut to fit)
 *   ?prd=empty                                                    prd.list (no PRD imported)
 *   ?prd-status=no-map | uncovered (default) | one-left | applied prd.status
 *   ?mocks=empty | problem                                        slice.mock.list
 *   ?resume=principles-policies | shipped-rules | from-prd | prd-drafted | idea-request   slice.resume
 *   ?refuse=<operation>                                           that operation answers with the engine's real refusal
 *
 * New status, show and refresh scenarios go through fixtureTransport's own parameters:
 *   ?fixture=status.principles | status.principles-published | status.principles-unfinished | status.policies-changed
 *            | status.shipped-moved | status.prds | status.jira-mocks
 *   ?show=open-concern | concern-accepted | concern-spec-changed | policy-followed | principle-exceptions | effects
 *         | effects-missing | effects-problems | prd-drafted | mocks-and-jira | four-mocks
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

/** The fixture a parameter names, from a fixed table; anything else is the default. */
function pick<D extends MemoryFixture | null>(given: string | null, table: Record<string, MemoryFixture>, otherwise: D): MemoryFixture | D {
  return given !== null && Object.hasOwn(table, given) ? (table[given] as MemoryFixture) : otherwise;
}

const principleLists: Record<string, MemoryFixture> = {
  empty: "principle.list.empty",
  "newer-elsewhere": "principle.list.newer-elsewhere",
  "never-published": "principle.list.never-published",
  published: "principle.list.published",
  unfinished: "principle.list.unfinished",
  "changed-on-github": "principle.list.changed-on-github",
  folder: "principle.list.folder",
};

const resumes: Record<string, MemoryFixture> = {
  "principles-policies": "slice.resume.principles-policies",
  "shipped-rules": "slice.resume.shipped-rules",
  "from-prd": "slice.resume.from-prd",
  "prd-drafted": "slice.resume.prd-drafted",
  "idea-request": "slice.resume.idea-request",
};

const shows: Record<string, MemoryFixture> = {
  "open-concern": "slice.show.open-concern",
  "concern-accepted": "slice.show.concern-accepted",
  "concern-spec-changed": "slice.show.concern-spec-changed",
  "policy-followed": "slice.show.policy-followed",
  "principle-exceptions": "slice.show.principle-exceptions",
  effects: "slice.show.effects",
  "effects-missing": "slice.show.effects-missing",
  "effects-problems": "slice.show.effects-problems",
  "prd-drafted": "slice.show.prd-drafted",
  "mocks-and-jira": "slice.show.mocks-and-jira",
  "four-mocks": "slice.show.four-mocks",
};

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
    case "principle.list":
      return answer(pick(devParam("principles"), principleLists, "principle.list.unpublished"));
    case "principle.add":
      return answer("principle.add");
    case "principle.set":
      return answer("principle.set");
    case "principle.retire":
      return answer("principle.retire");
    case "principle.publish":
      return answer(pick(devParam("publish"), { folder: "principle.publish.folder", "refused-stopped": "principle.publish.refused-stopped", "refused-offline": "principle.publish.refused-offline" }, "principle.publish"));
    case "reconcile.principles":
      return answer(args.take === "mine" ? "reconcile.principles.mine" : "reconcile.principles");
    case "policy.list":
      return answer(pick(devParam("policies"), { empty: "policy.list.empty", problems: "policy.list.problems", older: "policy.list.older" }, "policy.list"));
    case "policy.accept":
      return answer(pick(devParam("accept"), { checked: "policy.accept.checked", "refused-owner": "policy.accept.refused-owner" }, "policy.accept"));
    case "epic.current":
      return answer(
        pick(devParam("epic"), { "nothing-shipped": "epic.current.nothing-shipped", "after-retire": "epic.current.after-retire", problems: "epic.current.problems", unreadable: "epic.current.unreadable" }, "epic.current"),
      );
    case "epic.link":
      return answer(args.remove === true ? "epic.link.remove" : devParam("link") === "already-ready" ? "epic.link.already-ready" : "epic.link");
    case "slice.link":
      return answer(args.remove === true ? "slice.link.remove" : "slice.link");
    case "jira.export":
      return withDownloads(devParam("export") === "cut" ? "jira.export.cut" : args.state === "all" ? "jira.export.all" : "jira.export");
    case "jira.keys":
      return answer(args.dry_run === true ? "jira.keys.dry-run" : devParam("keys") === "reopen" ? "jira.keys.reopen" : "jira.keys");
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
      return answer(pick(devParam("mocks"), { empty: "slice.mock.list.empty", problem: "slice.mock.list.problem" }, "slice.mock.list"));
    case "slice.mock.add":
      return answer(typeof args.for === "string" ? "slice.mock.add" : "slice.mock.add.whole");
    case "slice.mock.remove":
      return answer("slice.mock.remove");
    case "slice.resume": {
      const chosen = pick(devParam("resume"), resumes, null);
      return chosen ? answer(chosen) : null;
    }
  }
  return null;
}

/** The M15 slice.show scenarios (?show=...), or null. */
export function memoryShow(scenario: string | null): unknown {
  const chosen = pick(scenario, shows, null);
  return chosen ? clone(memoryRuns[chosen].data) : null;
}
