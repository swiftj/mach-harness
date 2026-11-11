/**
 * DEVELOPMENT ONLY. Loaded by `vite --mode fixtures`; never part of a production build.
 *
 * Answers API calls from web/fixtures the way the host would: the engine's data in the envelope,
 * a refusal as { ok: false, error: { kind: "refused" } }. Choose which status fixture the app sees
 * with ?fixture=<name>, e.g. ?fixture=status.conflicts.
 */
import type { EngineRun, Transport } from "@mach/ui/api";

const files = import.meta.glob<EngineRun<unknown>>("../../../../fixtures/*.json", { import: "default" });

function load(name: string): Promise<EngineRun<unknown>> | null {
  const key = `../../../../fixtures/${name}.json`;
  const loader = files[key];
  return loader ? loader() : null;
}

/** Which fixture answers each operation by default. */
const defaults: Record<string, string> = {
  where: "where",
  status: "status.wave-approved",
  validate: "validate",
  refresh: "refresh.after-accept",
  "slice.check": "slice.check.ready",
  "slice.resume": "slice.resume.ready",
  "slice.approve": "slice.approve",
  "wave.approve": "wave.approve",
  "send.preview": "send.dry-run",
  send: "send",
  feedback: "feedback.waiting",
};

export const fixtureTransport: Transport = async ({ path }) => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (path === "/api/session") {
    return {
      status: 200,
      json: {
        ok: true,
        data: {
          project: { name: "Team Space", folder: "team-space", path: "/project", project_id: "team-space" },
          csrf_token: "fixtures",
          capabilities: { interview: false, interview_reason: "Fixture mode has no interviewer." },
          versions: { host: "fixtures", api: 1, engine_install: null },
          engine_problem: null,
        },
      },
    };
  }
  const op = path.startsWith("/api/ops/") ? path.slice("/api/ops/".length) : null;
  const params = new URLSearchParams(window.location.search);
  const chosen = op === "status" ? params.get("fixture") : null;
  const name = chosen ?? (op ? defaults[op] : undefined);
  const run = name ? load(name) : null;
  if (!run) {
    return { status: 400, json: { ok: false, error: { kind: "invalid", message: `No fixture answers ${path}.` } } };
  }
  const result = await run;
  if (result.data !== null) return { status: 200, json: { ok: true, data: result.data } };
  return { status: 200, json: { ok: false, error: { kind: "refused", message: result.refused ?? "Refused." } } };
};
