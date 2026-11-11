/**
 * DEVELOPMENT ONLY. Loaded by `vite --mode fixtures` through ../api.ts; never part of a production build.
 *
 * Answers the slice operations the shell's fixture transport does not (slice.show, slice.reopen,
 * slice.pause, draft reads and writes) from web/fixtures, and passes everything else to it.
 * Choose the state with query parameters before the hash:
 *
 *   ?show=ready | open-questions | errors | approved     which slice.show the screen sees
 *   ?approve=refused                                      slice.approve answers with the engine's refusal
 *   ?interview=unavailable                                the session reports interview: false
 *
 * Composition (dev only, named so nobody mistakes it for engine output):
 *   - "errors" is slice.show.open-questions with its check replaced by slice.check.errors (the
 *     engine's real check of a spec missing its Invariants section) and the invariants removed.
 *   - slice.reopen has no fixture yet; its reply is built from slice.show.approved's work order.
 */
import type { EngineRun, SliceCheck, SliceShow, Transport, TransportResponse } from "@mach/ui/api";
import { fixtureTransport } from "../../../dev/fixtureTransport";
import showReady from "../../../../../../fixtures/slice.show.ready.json";
import showApproved from "../../../../../../fixtures/slice.show.approved.json";
import showOpen from "../../../../../../fixtures/slice.show.open-questions.json";
import checkErrors from "../../../../../../fixtures/slice.check.errors.json";
import checkReady from "../../../../../../fixtures/slice.check.ready.json";
import checkOpen from "../../../../../../fixtures/slice.check.open-questions.json";
import approve from "../../../../../../fixtures/slice.approve.json";
import approveRefused from "../../../../../../fixtures/slice.approve.refused-epic.json";
import pause from "../../../../../../fixtures/slice.pause.json";
import { devParam, devState } from "./devState";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ok = (data: unknown): TransportResponse => ({ status: 200, json: { ok: true, data } });
const fail = (kind: string, message: string, status = 200): TransportResponse => ({ status, json: { ok: false, error: { kind, message } } });
const run = <T,>(file: unknown) => file as EngineRun<T>;

function withoutStatus(check: SliceCheck): SliceCheck {
  const copy = clone(check);
  delete copy.status;
  return copy;
}

function composedErrors(): SliceShow {
  const show = clone(run<SliceShow>(showOpen).data!);
  show.check = withoutStatus(run<SliceCheck>(checkErrors).data!);
  show.check.spec = show.paths.spec;
  const model = show.spec?.model as { invariants?: unknown[] } | undefined;
  if (model) model.invariants = [];
  if (show.spec) {
    show.spec.markdown = show.spec.markdown.replace(/## Invariants\n\n(- \*\*INV-[^\n]*\n)+\n/, "");
    show.spec.findings = [];
  }
  return show;
}

function sliceShow(sliceId: string): SliceShow | null {
  const chosen = devParam("show");
  const scenario =
    chosen ??
    (sliceId === "SLICE-001" ? (devState.approved.has(sliceId) ? "approved" : "ready") : sliceId === "SLICE-002" ? (devState.writtenUp ? "open-questions" : "errors") : null);
  switch (scenario) {
    case "ready":
      return clone(run<SliceShow>(showReady).data!);
    case "approved":
      return clone(run<SliceShow>(showApproved).data!);
    case "open-questions":
      return clone(run<SliceShow>(showOpen).data!);
    case "errors":
      return composedErrors();
    default:
      return null;
  }
}

function checkFor(sliceId: string): SliceCheck {
  const show = sliceShow(sliceId);
  if (show) return show.check;
  return run<SliceCheck>(sliceId === "SLICE-001" ? checkReady : checkOpen).data!;
}

export const sliceFixtureTransport: Transport = async (request) => {
  const { path, method, body } = request;
  const args = body ? (JSON.parse(body) as Record<string, unknown>) : {};
  const sliceId = typeof args.slice_id === "string" ? args.slice_id : "";

  if (path === "/api/session") {
    const base = await fixtureTransport(request);
    const envelope = base.json as { ok: boolean; data: Record<string, unknown> };
    const unavailable = devParam("interview") === "unavailable";
    envelope.data.capabilities = {
      interview: !unavailable,
      interview_reason: unavailable
        ? "Claude Code 2.1.322 or later was not found on this computer, so the interview cannot run inside Product Studio. (Development fixture.)"
        : null,
      continue_command: "/mach:product-studio continue",
    };
    return base;
  }

  await new Promise((resolve) => setTimeout(resolve, 200));

  switch (path) {
    case "/api/ops/slice.show": {
      const show = sliceShow(sliceId);
      return show ? ok(show) : fail("invalid", `No development fixture answers slice.show for ${sliceId}. Use SLICE-001 or SLICE-002.`, 400);
    }
    case "/api/ops/slice.check":
      return ok(checkFor(sliceId));
    case "/api/ops/slice.approve": {
      if (devParam("approve") === "refused") return fail("refused", run(approveRefused).refused ?? "Refused.", 409);
      devState.approved.add(sliceId);
      return ok(run(approve).data);
    }
    case "/api/ops/slice.reopen": {
      devState.approved.delete(sliceId);
      const slice = clone(run<SliceShow>(showApproved).data!.slice);
      slice.status = "ready_for_approval";
      slice.spec_sha256 = null;
      return ok({ reopened: true, slice, waves_returned_to_draft: ["WAVE-001"] });
    }
    case "/api/ops/slice.pause":
      return ok({ ...run<object>(pause).data, slice_id: sliceId });
  }

  const draft = path.match(/^\/api\/drafts\/(spec|intent)\/([A-Z]+-\d{3,})$/);
  if (draft) {
    const kind = draft[1] as "spec" | "intent";
    const id = draft[2] ?? "";
    const show = sliceShow(id);
    if (!show) return fail("invalid", `No development fixture for ${id}.`, 400);
    if (method === "GET") {
      return ok({ slice_id: id, markdown: kind === "spec" ? (show.spec?.markdown ?? "") : ((show.why as { markdown?: string }).markdown ?? "") });
    }
    if (!show.editable) return fail("refused", show.edit_refusal ?? "This slice cannot be edited.", 409);
    return ok({ slice_id: id, kind, path: kind === "spec" ? show.paths.spec : show.paths.intent, check: show.check });
  }

  return fixtureTransport(request);
};
