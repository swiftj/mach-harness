/**
 * DEVELOPMENT ONLY. Imported by ../ops.ts only under `vite --mode fixtures`; never in a production build.
 *
 * The shared fixture transport can select only the `status` fixture (?fixture=). The delivery screens
 * need to drive refresh, feedback, send and the decisions that change the workspace, so this layer
 * answers those from the real fixtures in web/fixtures, chosen by URL:
 *
 *   ?fixture=status.conflicts        the status (also: status.collision, composed below)
 *   &refresh=refresh.second-pm-arrives
 *   &feedback=feedback.changes-requested   (also composed: feedback.needs-updating, feedback.declined,
 *                                             feedback.accepted-waiting, feedback.request-not-opened)
 *   &preview=send.dry-run            what send.preview answers
 *   &send=send                       (also: send.refused-offline, composed send.request-not-opened)
 *
 * The composed scenarios stand in for fixtures the host owner is adding ("Needs updating",
 * "Declined", "Accepted, waiting to merge", "Sent, pull request not opened"). They reuse the real
 * fixtures' shapes and the engine's own sentences (collab.in_words, cmd_feedback, cmd_send).
 *
 * Decisions (reconcile, renumber, wave.*, send) change an in-memory copy of the status so a flow can
 * be walked through end to end. Reloading the page starts again from the fixtures.
 */
import { MachApiError, type EngineRun, type OperationArgs, type OperationName, type Status } from "@mach/ui/api";

const files = import.meta.glob<EngineRun<unknown>>("../../../../../../../fixtures/*.json", { import: "default" });

async function fixture<T>(name: string): Promise<EngineRun<T> | null> {
  const loader = files[`../../../../../../../fixtures/${name}.json`];
  return loader ? ((await loader()) as EngineRun<T>) : null;
}

async function data<T>(name: string): Promise<T> {
  const run = await fixture<T>(name);
  if (!run?.data) throw new Error(`fixture ${name} has no data`);
  return structuredClone(run.data);
}

const clone = <T>(value: T): T => structuredClone(value);
const param = (name: string) => new URLSearchParams(window.location.search).get(name);

let status: Status | null = null;
const sentOverrides = new Map<string, Record<string, unknown>>();

async function composedStatus(name: string): Promise<Status> {
  if (name === "status.collision") {
    const base = await data<Status>("status.conflicts");
    const refresh = await data<{ needs_reconciling: Status["needs_reconciling"] }>("refresh.collision");
    base.needs_reconciling = refresh.needs_reconciling;
    for (const row of base.slices) if (row.slice_id === "SLICE-002") row.source = "collision";
    return base;
  }
  return data<Status>(name);
}

async function currentStatus(): Promise<Status> {
  if (!status) status = await composedStatus(param("fixture") ?? "status.wave-approved");
  return status;
}

const composedFeedback: Record<string, { status: string; meaning: string; pull_request?: string | null; branch?: string }> = {
  "feedback.needs-updating": {
    status: "Needs updating",
    meaning: "Other work reached the shared project first and this now conflicts with it. Refresh, reconcile, and send again.",
    pull_request: "https://example.test/pull/1",
  },
  "feedback.declined": { status: "Declined", meaning: "The request was closed without being accepted.", pull_request: "https://example.test/pull/1" },
  "feedback.accepted-waiting": {
    status: "Accepted, waiting to merge",
    meaning: "Reviewers approved it; it has not been merged yet.",
    pull_request: "https://example.test/pull/1",
  },
  "feedback.request-not-opened": {
    status: "Sent, pull request not opened",
    meaning: "The work reached the shared repository but the request for review could not be opened. Send it again, or give an engineer the branch name.",
    branch: "product/WAVE-001",
  },
};

async function feedback(args: { wave_id?: string }) {
  const name = param("feedback") ?? "feedback.waiting";
  let result: { refreshed: boolean; waves: Array<Record<string, unknown>> };
  const composed = composedFeedback[name];
  if (composed) {
    result = { refreshed: true, waves: [{ wave_id: "WAVE-001", slices: ["SLICE-001"], reviewer_remarks: [], ...composed }] };
  } else {
    result = await data(name);
  }
  for (const [waveId, row] of sentOverrides) {
    const existing = result.waves.find((w) => w.wave_id === waveId);
    if (existing) Object.assign(existing, row);
    else result.waves.push({ wave_id: waveId, ...row });
  }
  if (args.wave_id) result.waves = result.waves.filter((w) => w.wave_id === args.wave_id);
  return result;
}

function refused(message: string, operation: string) {
  return new MachApiError("refused", message, operation, 409);
}

function nextWaveId(s: Status): string {
  const numbers = s.waves.map((w) => Number(w.wave_id.split("-")[1]));
  return `WAVE-${String(Math.max(0, ...numbers) + 1).padStart(3, "0")}`;
}

/** Answers an operation, or returns undefined to let the shared fixture transport answer it. */
export async function scenarioOp<K extends OperationName>(name: K, rawArgs: OperationArgs<K>): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const args = rawArgs as Record<string, unknown>;
  switch (name) {
    case "status":
      return clone(await currentStatus());

    case "refresh": {
      const result = await data<Record<string, unknown>>(param("refresh") ?? "refresh.after-accept");
      return result;
    }

    case "feedback":
      return feedback(args as { wave_id?: string });

    case "slice.show": {
      const s = await currentStatus();
      const row = s.slices.find((r) => r.slice_id === args.slice_id);
      const source = row?.open_questions ? "slice.show.open-questions" : row?.status === "approved_for_engineering" ? "slice.show.approved" : "slice.show.ready";
      const show = await data<{ slice: Record<string, unknown> }>(source);
      show.slice.slice_id = args.slice_id;
      if (row) show.slice.title = row.title;
      return show;
    }

    case "reconcile": {
      const s = await currentStatus();
      const artifact = String(args.artifact);
      const field = (args.field as string | undefined) ?? null;
      if (!s.needs_reconciling.conflicts.includes(artifact)) {
        const run = await fixture("reconcile.refused-unknown");
        return refused(run?.refused ?? "Nothing by that name needs reconciling.", name);
      }
      const details = s.needs_reconciling.details[artifact] as { fields?: Record<string, unknown> } | undefined;
      if (field && details?.fields) {
        delete details.fields[field];
        if (Object.keys(details.fields).length === 0) delete s.needs_reconciling.details[artifact];
      } else {
        delete s.needs_reconciling.details[artifact];
      }
      if (!s.needs_reconciling.details[artifact]) s.needs_reconciling.conflicts = s.needs_reconciling.conflicts.filter((p) => p !== artifact);
      const id = artifact.match(/[A-Z]+-\d{3,}/)?.[0];
      const stillConflicting = s.needs_reconciling.conflicts.some((p) => id && p.includes(id));
      if (id && !stillConflicting) {
        for (const row of [...s.epics, ...s.slices, ...s.waves]) {
          const rowId = "slice_id" in row ? row.slice_id : "epic_id" in row ? row.epic_id : row.wave_id;
          if (rowId === id && row.source === "conflict") row.source = "draft";
        }
      }
      return { reconciled: artifact, took: args.take, field, approvals_withdrawn: [], needs_reconciling: clone(s.needs_reconciling) };
    }

    case "slice.renumber":
    case "epic.renumber":
    case "wave.renumber": {
      const result = await data<Record<string, unknown>>("slice.renumber");
      status = await data<Status>("status.after-renumber");
      return result;
    }

    case "wave.new": {
      const s = await currentStatus();
      const run = await data<{ wave: Record<string, unknown> }>("wave.new");
      const waveId = nextWaveId(s);
      const slices = args.slice as string[];
      Object.assign(run.wave, { wave_id: waveId, slices });
      s.waves.push({ wave_id: waveId, status: "draft", revision: 1, slices, approval: null, source: "draft", sent: false, pull_request: null });
      return run;
    }

    case "wave.add":
    case "wave.remove": {
      const s = await currentStatus();
      const row = s.waves.find((w) => w.wave_id === args.wave_id);
      if (!row) return refused(`There is no ${String(args.wave_id)}.`, name);
      if (row.status !== "draft") return refused(`${row.wave_id} is approved_for_engineering. An approved wave cannot be changed; start a new one.`, name);
      const ids = args.slice_ids as string[];
      row.slices = name === "wave.add" ? [...new Set([...row.slices, ...ids])] : row.slices.filter((id) => !ids.includes(id));
      row.revision += 1;
      return { wave: { schema_version: 1, wave_id: row.wave_id, project_id: "team-space", revision: row.revision, base_project_revision: 1, status: row.status, slices: row.slices, approval: null } };
    }

    case "wave.approve": {
      const s = await currentStatus();
      const row = s.waves.find((w) => w.wave_id === args.wave_id);
      const run = await data<{ wave: Record<string, unknown> }>("wave.approve");
      if (row) {
        const unapproved = row.slices.filter((id) => s.slices.find((r) => r.slice_id === id)?.status !== "approved_for_engineering");
        if (unapproved.length) return refused(`${row.wave_id} cannot be approved yet:\n  ${unapproved.map((id) => `${id} is not approved`).join("\n  ")}`, name);
        row.status = "approved_for_engineering";
        row.approval = run.wave.approval as Status["waves"][number]["approval"];
        Object.assign(run.wave, { wave_id: row.wave_id, slices: row.slices });
      }
      return run;
    }

    case "send.preview": {
      const chosen = param("preview") ?? "send.dry-run";
      const run = await fixture<Record<string, unknown>>(chosen);
      if (!run) return undefined;
      if (!run.data) return refused(run.refused ?? "Refused.", name);
      return { ...clone(run.data), wave_id: args.wave_id };
    }

    case "send": {
      const chosen = param("send") ?? "send";
      if (chosen === "send.request-not-opened") {
        const result = await data<Record<string, unknown>>("send");
        Object.assign(result, { wave_id: args.wave_id, status: "Sent, pull request not opened", pull_request: null, problem: "The GitHub tool (gh) is not installed on this machine." });
        markSent(String(args.wave_id), { status: "Sent, pull request not opened", meaning: composedFeedback["feedback.request-not-opened"]?.meaning, branch: result.branch });
        return result;
      }
      const run = await fixture<Record<string, unknown>>(chosen);
      if (!run) return undefined;
      if (!run.data) return refused(run.refused ?? "Refused.", name);
      const result: Record<string, unknown> = { ...clone(run.data), wave_id: args.wave_id };
      markSent(String(args.wave_id), { status: result.status, meaning: "Nobody has decided yet.", pull_request: result.pull_request, reviewer_remarks: [] });
      return result;
    }

    default:
      return undefined;
  }
}

function markSent(waveId: string, row: Record<string, unknown>) {
  const s = status;
  const wave = s?.waves.find((w) => w.wave_id === waveId);
  if (wave) {
    wave.sent = true;
    wave.source = "published";
    wave.pull_request = (row.pull_request as string | null | undefined) ?? null;
    row.slices = wave.slices;
  }
  sentOverrides.set(waveId, row);
}
