/**
 * DEVELOPMENT ONLY. Loaded by `vite --mode fixtures`; never part of a production build.
 *
 * Answers API calls from web/fixtures the way the host would: the engine's data in the envelope,
 * a refusal as { ok: false, error: { kind: "refused" } }. Query parameters before the hash choose
 * the scenario:
 *
 *   ?fixture=status.conflicts                             which status the app sees
 *   ?show=ready | open-questions | errors | approved      which slice.show the slice screens see
 *   ?approve=refused                                      slice.approve answers with the engine's refusal
 *   ?interview=unavailable                                the session reports interview: false
 *
 * Every answer is a real engine run from web/fixtures. The only adjustment: slice.reopen's fixture
 * is for SLICE-001, so its slice ID is set to the slice the screen asked about.
 */
import type { EngineRun, SliceCheck, SliceShow, Transport, TransportResponse } from "@mach/ui/api";
import { devParam, devState } from "./devState";

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
  status: "status.wave-approved",
  validate: "validate",
  refresh: "refresh.after-accept",
  "slice.resume": "slice.resume.ready",
  "wave.approve": "wave.approve",
  "send.preview": "send.dry-run",
  send: "send",
  feedback: "feedback.waiting",
};

/* ── Slices: slice.show, check, approve, reopen, pause, drafts ──────────── */

async function sliceShow(sliceId: string): Promise<SliceShow | null> {
  const scenario =
    devParam("show") ??
    (sliceId === "SLICE-001"
      ? devState.approved.has(sliceId)
        ? "approved"
        : "ready"
      : sliceId === "SLICE-002"
        ? devState.writtenUp
          ? "open-questions"
          : "errors"
        : null);
  switch (scenario) {
    case "ready":
      return data<SliceShow>("slice.show.ready");
    case "approved":
      return data<SliceShow>("slice.show.approved");
    case "open-questions":
      return data<SliceShow>("slice.show.open-questions");
    case "errors":
      return data<SliceShow>("slice.show.errors");
    default:
      return null;
  }
}

async function reopened(sliceId: string): Promise<unknown> {
  const reopen = await data<{ slice: { slice_id: string } }>("slice.reopen");
  reopen.slice.slice_id = sliceId;
  return reopen;
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
    case "/api/ops/slice.approve": {
      if (devParam("approve") === "refused") {
        const refused = await load("slice.approve.refused-epic");
        return fail("refused", refused?.refused ?? "Refused.", 422, refused?.hint ?? null);
      }
      devState.approved.add(sliceId);
      return ok(await data("slice.approve"));
    }
    case "/api/ops/slice.reopen":
      devState.approved.delete(sliceId);
      return ok(await reopened(sliceId));
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

  const op = path.startsWith("/api/ops/") ? path.slice("/api/ops/".length) : null;
  const chosen = op === "status" ? devParam("fixture") : null;
  const name = chosen ?? (op ? defaults[op] : undefined);
  const run = name ? await load<unknown>(name) : null;
  if (!run) return fail("invalid", `No fixture answers ${path}.`, 400);
  if (run.data !== null) return ok(run.data);
  return fail("refused", run.refused ?? "Refused.", 422, run.hint ?? null);
};
