/**
 * DEVELOPMENT ONLY. Moving the whole project (M21 F), used by fixtureTransport under `vite --mode fixtures` when the
 * address has `?move=`. Every answer is a real engine run from web/fixtures (written by web/fixtures/move_memory.py),
 * plus what the host adds: `downloads` after an export (here a short text, since the fixture has no file to serve) and
 * `kept` after a plan (the archive's own SHA-256, as the host keeps the file under it). It remembers what the person did
 * in this page, so the whole way can be walked: look at the file, bring it in, look an ID up.
 *
 *   ?move=empty        nothing here yet: bring a project in, which becomes the project       #/move
 *   ?move=join         this repository has its own project: the one brought in joins it, renumbered
 *   ?move=unfinished   bringing a project in stopped part way: finish it or set it aside
 *   ?move=refused      the export is refused (bringing in another project stopped part way)
 *
 * Reloading the page starts again from the parameter.
 */
import type { EngineRun, TransportResponse } from "@mach/ui/api";
import { devParam } from "./devState";

const files = import.meta.glob<EngineRun<unknown>>(
  ["../../../../fixtures/project.export*.json", "../../../../fixtures/project.import*.json", "../../../../fixtures/status.import-*.json"],
  { import: "default", eager: true },
);
const others = import.meta.glob<EngineRun<unknown>>("../../../../fixtures/status.rich.json", { import: "default", eager: true });

function run(name: string): EngineRun<unknown> {
  const found = files[`../../../../fixtures/${name}.json`] ?? others[`../../../../fixtures/${name}.json`];
  if (!found) throw new Error(`fixture ${name} is missing`);
  return found;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function answer(name: string, adjust?: (data: Record<string, unknown>) => void): TransportResponse {
  const found = run(name);
  if (found.data === null) return { status: 422, json: { ok: false, error: { kind: "refused", message: found.refused ?? "Refused." } } };
  const data = clone(found.data) as Record<string, unknown>;
  adjust?.(data);
  return { status: 200, json: { ok: true, data } };
}

/** What the host adds after a plan: the file named by the hash it is kept under. */
function kept(data: Record<string, unknown>) {
  const archive = data.archive as { file: string; sha256: string };
  data.kept = { sha256: archive.sha256, name: archive.file, bytes: (run("project.export").data as { bytes: number }).bytes };
}

const state = { active: false, mode: "empty", imported: false, setAside: false, readyAsked: 0 };

function begin() {
  if (state.active) return;
  state.active = true;
  state.mode = devParam("move") ?? "empty";
}

/** Answers the operations the "Move this project" screen uses, or null when the page is not in this mode. */
export function moveRoute(path: string, args: Record<string, unknown>): TransportResponse | null {
  if (devParam("move") === null) return null;
  begin();
  const op = path.startsWith("/api/ops/") ? path.slice("/api/ops/".length) : null;
  const join = state.mode === "join";
  switch (op) {
    case "status":
      if (state.mode === "unfinished" && !state.imported && !state.setAside) return answer("status.import-unfinished");
      if (state.setAside) return answer("status.import-set-aside");
      if (join) return answer("status.rich");
      return answer(state.imported ? "status.import-done" : "status.import-empty");
    case "project.export":
      if (state.mode === "refused" || (state.mode === "unfinished" && !state.imported && !state.setAside)) return answer("project.export.refused-unfinished");
      if (state.mode === "empty" && !state.imported) return answer("project.export.refused-no-project");
      return answer("project.export", (data) => {
        const name = String(data.file).split("/").pop() ?? "mach-project.zip";
        data.downloads = [{ name, url: `data:text/plain;charset=utf-8,${encodeURIComponent("Development fixture: the host serves the real project file here.")}`, bytes: data.bytes }];
      });
    case "project.import":
      if (args.plan === true) {
        if (state.imported) return answer("project.import.already", kept);
        return answer(state.mode === "unfinished" ? "project.import.plan-resuming" : join ? "project.import.plan-join" : "project.import.plan", kept);
      }
      state.imported = true;
      return answer(join ? "project.import.join" : "project.import");
    case "project.import.abandon":
      if (state.mode !== "unfinished" || state.setAside || state.imported) return answer("project.import.abandon.refused-none");
      state.setAside = true;
      return answer("project.import.abandon");
    case "project.imports.ready":
      // Stopped at the principles not yet published, then (asked again) stopped at a slice that does not answer them.
      return answer(state.readyAsked++ === 0 ? "project.imports.ready.stopped" : "project.imports.ready");
    case "project.imports":
      // A lookup answers with a real run whatever ID was typed: SLICE-002 (or SLICE-001 when joining), or SLICE-099.
      if (typeof args.identifier === "string") {
        if (!state.imported && !state.setAside) return answer("project.imports.lookup-none");
        return answer(join ? "project.imports.lookup-join" : "project.imports.lookup");
      }
      if (state.setAside) return answer("project.imports.set-aside");
      if (state.mode === "unfinished" && !state.imported) return answer("project.imports.unfinished");
      return answer(state.imported ? "project.imports" : "project.imports.none");
  }
  return null;
}
