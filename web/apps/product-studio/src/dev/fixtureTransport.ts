/**
 * DEVELOPMENT ONLY. Loaded by `vite --mode fixtures`; never part of a production build.
 *
 * Answers API calls from web/fixtures the way the host would: the engine's data in the envelope,
 * a refusal as { ok: false, error: { kind: "refused" } }. Query parameters before the hash choose
 * the scenario:
 *
 *   ?fixture=status.states                                which status the app sees
 *   ?show=ready | open-questions | errors | on-github | question   which slice.show the slice screens see
 *   ?ready=refused | folder                               slice.ready answers with the engine's refusal, or saves to the folder
 *   ?refresh=refresh.offline                              which refresh the app sees
 *   ?take=refused                                         slice.take answers with the engine's refusal (a different epic here)
 *   ?interview=unavailable                                the session reports interview: false
 *
 * M15 (principles, policies, effects, the epic today, the PRD on-ramp, Jira, mocks): see
 * memoryTransport.ts for its parameters; ?show=, ?ready=, ?fixture= and ?refresh= take its names too.
 * M16 (Shape): see shapeTransport.ts; ?fixture=status.ideas shows the ideas board.
 *
 * Every answer is a real engine run from web/fixtures. The only adjustment: the slice.ready and
 * slice.reopen fixtures are for SLICE-001, so their slice ID is set to the slice the screen asked about.
 */
import type { EngineRun, SliceCheck, SliceShow, Transport, TransportResponse } from "@mach/ui/api";
import { devParam, devState } from "./devState";
import { memoryRoute, memoryShow } from "./memoryTransport";
import { shapeRoute, shapeShow } from "./shapeTransport";

const files = import.meta.glob<EngineRun<unknown>>("../../../../fixtures/*.json", { import: "default" });

async function load<T>(name: string): Promise<EngineRun<T> | null> {
  const loader = files[`../../../../fixtures/${name}.json`];
  return loader ? ((await loader()) as EngineRun<T>) : null;
}

async function data<T>(name: string): Promise<T> {
  const run = await load<T>(name);
  if (!run?.data) throw new Error(`fixture ${name} is missing or has no data`);
  return clone(run.data);
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ok = (value: unknown): TransportResponse => ({ status: 200, json: { ok: true, data: value } });
const fail = (kind: string, message: string, status = 200, hint: EngineRun<unknown>["hint"] = null): TransportResponse => ({
  status,
  json: { ok: false, error: hint ? { kind, message, hint } : { kind, message } },
});

/** Which fixture answers each operation by default. */
const defaults: Record<string, string> = {
  where: "where",
  status: "status.rich",
  validate: "validate",
  refresh: "refresh.rich",
  "slice.resume": "slice.resume.ready",
  "slice.renumber": "slice.renumber",
  "slice.move": "slice.move",
  reconcile: "reconcile.theirs",
};

/* ── Slices: slice.show, check, ready, reopen, pause, drafts ────────────── */

async function sliceShow(sliceId: string): Promise<SliceShow | null> {
  const scenario =
    devParam("show") ??
    (sliceId === "SLICE-001"
      ? devState.reopened.has(sliceId)
        ? "ready"
        : "on-github"
      : sliceId === "SLICE-002"
        ? devState.writtenUp
          ? "open-questions"
          : "errors"
        : null);
  switch (scenario) {
    case "ready":
      return data<SliceShow>("slice.show.ready");
    case "on-github":
      return data<SliceShow>("slice.show.on-github");
    case "question":
      return data<SliceShow>("slice.show.question");
    case "open-questions":
      return data<SliceShow>("slice.show.open-questions");
    case "errors":
      return data<SliceShow>("slice.show.errors");
    default:
      // M15: open-concern, concern-accepted, effects, mocks-and-jira (memoryTransport.ts).
      return ((memoryShow(scenario) ?? shapeShow(scenario)) as SliceShow | null) ?? null;
  }
}

async function forSlice(name: string, sliceId: string): Promise<unknown> {
  const result = await data<{ slice: { slice_id: string } }>(name);
  result.slice.slice_id = sliceId;
  return result;
}

async function sliceRoute(path: string, method: string, args: Record<string, unknown>): Promise<TransportResponse | null> {
  const sliceId = typeof args.slice_id === "string" ? args.slice_id : "";
  switch (path) {
    case "/api/ops/slice.show": {
      const show = await sliceShow(sliceId);
      return show ? ok(show) : fail("invalid", `No development fixture answers slice.show for ${sliceId}. Use SLICE-001 or SLICE-002.`, 400);
    }
    case "/api/ops/slice.check": {
      const show = await sliceShow(sliceId);
      return ok(show ? show.check : await data<SliceCheck>(sliceId === "SLICE-001" ? "slice.check.ready" : "slice.check.open-questions"));
    }
    case "/api/ops/slice.ready": {
      // ?ready=refused: open questions (no hint). ?ready=refused-once: refused with a hint the first
      // time, then, slowly enough to see the button working, marked ready.
      const mode = devParam("ready");
      const first = devState.readyAsked++ === 0;
      if (mode === "refused-open-concern") {
        const refused = await load("slice.ready.refused-open-concern");
        return fail("refused", refused?.refused ?? "Refused.", 422, refused?.hint ?? null);
      }
      if (mode === "with-mocks") {
        devState.reopened.delete(sliceId);
        return ok(await forSlice("slice.ready.with-mocks", sliceId));
      }
      if (mode === "refused" || (mode === "refused-once" && first)) {
        const refused = await load(mode === "refused" ? "slice.ready.refused-open-questions" : "slice.ready.refused-number-taken");
        return fail("refused", refused?.refused ?? "Refused.", 422, refused?.hint ?? null);
      }
      if (mode === "refused-once") await new Promise((resolve) => setTimeout(resolve, 1500));
      devState.reopened.delete(sliceId);
      return ok(await forSlice(devParam("ready") === "folder" ? "slice.ready.folder" : "slice.ready", sliceId));
    }
    case "/api/ops/slice.reopen":
      devState.reopened.add(sliceId);
      return ok(await forSlice("slice.reopen", sliceId));
    case "/api/ops/slice.pause":
      return ok({ ...(await data<object>("slice.pause")), slice_id: sliceId });
  }
  const draft = path.match(/^\/api\/drafts\/(spec|intent)\/([A-Z]+-\d{3,})$/);
  if (!draft) return null;
  const kind = draft[1] as "spec" | "intent";
  const id = draft[2] ?? "";
  const show = await sliceShow(id);
  if (!show) return fail("invalid", `No development fixture for ${id}.`, 400);
  if (method === "GET") {
    const markdown = kind === "spec" ? (show.spec?.markdown ?? null) : show.why.markdown;
    return ok({
      slice_id: id,
      kind,
      editable: show.editable,
      edit_refusal: show.edit_refusal,
      path: kind === "spec" ? show.paths.spec : show.paths.intent,
      exists: markdown !== null,
      markdown,
      ...(kind === "spec" ? { spec_name_pattern: show.paths.spec_name_pattern } : {}),
    });
  }
  if (!show.editable) return fail("refused", show.edit_refusal ?? "This slice cannot be edited.", 409);
  return ok({ slice_id: id, kind, path: kind === "spec" ? show.paths.spec : show.paths.intent, check: show.check });
}

/* ── The transport ──────────────────────────────────────────────────────── */

export const fixtureTransport: Transport = async ({ path, method, body }) => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (path === "/api/session") {
    const unavailable = devParam("interview") === "unavailable";
    return ok({
      project: { name: "Team Space", folder: "team-space", path: "/project", project_id: "team-space" },
      csrf_token: "fixtures",
      capabilities: {
        interview: !unavailable,
        interview_reason: unavailable
          ? "Claude Code 2.1.322 or later was not found on this computer, so the interview cannot run inside Product Studio. (Development fixture.)"
          : null,
        continue_command: "/mach:product-studio continue",
      },
      versions: { host: "fixtures", api: 1, engine_install: null },
      engine_problem: null,
    });
  }
  const args = body ? (JSON.parse(body) as Record<string, unknown>) : {};
  const slice = await sliceRoute(path, method, args);
  if (slice) return slice;
  const memory = memoryRoute(path, args);
  if (memory) return memory;
  const shape = shapeRoute(path, method, args);
  if (shape) return shape;

  const op = path.startsWith("/api/ops/") ? path.slice("/api/ops/".length) : null;
  if (op === "slice.take") {
    const run = await load<unknown>(devParam("take") === "refused" ? "slice.take.refused-epic" : "slice.take");
    if (run?.data) return ok(run.data);
    return fail("refused", run?.refused ?? "Refused.", 422, run?.hint ?? null);
  }
  const chosen = op === "status" ? devParam("fixture") : op === "refresh" ? devParam("refresh") : null;
  const name = chosen ?? (op ? defaults[op] : undefined);
  const run = name ? await load<unknown>(name) : null;
  if (!run) return fail("invalid", `No fixture answers ${path}.`, 400);
  if (run.data !== null) return ok(run.data);
  return fail("refused", run.refused ?? "Refused.", 422, run.hint ?? null);
};
