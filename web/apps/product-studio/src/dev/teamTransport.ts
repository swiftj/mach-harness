/**
 * DEVELOPMENT ONLY. Several product managers sharing one GitHub repository (M20 A3 and A4), used by fixtureTransport under
 * `vite --mode fixtures` when the address has `?team=`. Every answer is a real engine run from web/fixtures, written by
 * web/fixtures/team_memory.py on two product managers' clones of one repository (Ada and Ben; the app is Ben's unless
 * said). It remembers what the person did on the page, so each state can be walked to its end; reloading starts again.
 *
 *   ?team=same-moment#/slices/SLICE-001      Ben marks SLICE-001 ready at the same moment as Ada's, which GitHub made first and
 *                                            which keeps the number. Never blocked: his issue is closed, and in the same act
 *                                            his draft becomes SLICE-002 and is marked ready, the note saying so first.
 *   ?team=epic-same-moment#/slices/SLICE-002 The same for the epic: Ben's EPIC-001 ("Billing") loses to Ada's. Marking
 *                                            SLICE-002 ready gives his epic EPIC-002 and marks the slice ready, in one act.
 *   ?team=twice-kept#/                       A number held by two open issues, found by a refresh: Ada's view (hers kept).
 *   ?team=twice-closed#/                     Ben's view: his later issue was closed by MACH; his slice needs a new number.
 *   ?team=twice-builders#/                   Ben's later issue was already taken by the builders: reported, left alone.
 *   ?team=several#/                          Two project issues: refresh reports them; marking ready carries on, warning (SLICE-002).
 *   ?team=text-taken#/                       A refresh took Ada's new criteria for EPIC-001 into Ben's workspace.
 *   ?team=text-taken&show=ready#/slices/SLICE-001   Marking ready took the project's and epic's text instead of writing over it.
 *   ?team=project-changed#/                  Both changed the vision: "Carry on" leads to the choice on Vision. Keep mine or
 *                                            take theirs. With &show=ready#/slices/SLICE-001, marking ready says the project
 *                                            was not written and leads to the choice.
 *   ?team=project-unreadable#/vision         The other change is not in MACH's form: theirs cannot be shown or taken.
 *   ?team=epic-changed#/vision               Both changed EPIC-001's criteria: the choice under the epic (and on
 *                                            #/epics/EPIC-001/today).
 *   ?team=start-taken#/vision                No project yet; naming it takes the project already on GitHub (Ada's). Once
 *                                            the home's refresh has read GitHub (#/), the start screen and the form say so
 *                                            before anything is typed.
 *   ?team=start-not-checked#/vision          Naming it while GitHub cannot be read.
 *   ?team=start-several#/vision              Two project issues on GitHub: naming it takes the oldest, warning.
 *   ?team=prd-not-checked#/prds/PRD-01       Making a PRD's drafts while GitHub cannot be read.
 *   ?team=idea-not-checked&idea=settled&fixture=status.ideas-apply#/shape/ideas/IDEA-001/route
 *                                            Making an idea's drafts while GitHub cannot be read.
 *
 * Two answers are borrowed, as said where they are used: start-not-checked's status after naming is start-taken's (the
 * same words), and project-unreadable's "Keep mine" answer is project-changed's (the engine's note is the same).
 */
import type { EngineRun, TransportResponse } from "@mach/ui/api";
import { devParam } from "./devState";

const files = import.meta.glob<EngineRun<unknown>>("../../../../fixtures/*.team-*.json", { import: "default", eager: true });
const borrowed = import.meta.glob<EngineRun<unknown>>(["../../../../fixtures/refresh.start-empty.json", "../../../../fixtures/prd.show.json", "../../../../fixtures/prd.list.json"], {
  import: "default",
  eager: true,
});

function run(name: string): EngineRun<unknown> {
  const found = files[`../../../../fixtures/${name}.json`] ?? borrowed[`../../../../fixtures/${name}.json`];
  if (!found) throw new Error(`fixture ${name} is missing`);
  return found;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function answer(name: string): TransportResponse {
  const found = run(name);
  if (found.data === null) {
    const error = found.hint ? { kind: "refused", message: found.refused ?? "Refused.", hint: found.hint } : { kind: "refused", message: found.refused ?? "Refused." };
    return { status: 422, json: { ok: false, error } };
  }
  return { status: 200, json: { ok: true, data: clone(found.data) } };
}

/** What the person did on this page. */
const done = { ready: false, took: null as "mine" | "theirs" | null, named: false, applied: false, refreshed: false };

export const teamScenario = (): string | null => devParam("team");

function statusFor(team: string): string | null {
  switch (team) {
    case "same-moment":
      return done.ready ? "status.team-same-moment" : "status.team-before-same-moment";
    case "epic-same-moment":
      return done.ready ? "status.team-epic-same-moment" : "status.team-before-epic-same-moment";
    case "twice-kept":
    case "twice-closed":
    case "twice-builders":
    case "several":
      return `status.team-${team}`;
    case "text-taken":
      return devParam("show") ? "status.team-text-taken" : "status.team-text-taken-refresh";
    case "project-changed":
      return done.took ? `status.team-project-${done.took}` : "status.team-project-changed";
    case "project-unreadable":
      return done.took ? "status.team-project-mine" : "status.team-project-unreadable";
    case "epic-changed":
      return done.took ? `status.team-epic-${done.took}` : "status.team-epic-changed";
    case "start-taken":
      return done.named ? "status.team-taken" : done.refreshed ? "status.team-start-known" : "status.team-start";
    case "start-not-checked":
      // After naming it, start-not-checked borrows start-taken's status: the same words were given in both runs.
      return done.named ? "status.team-taken" : "status.team-start";
    case "start-several":
      return "status.team-several-start";
    default:
      // prd-not-checked and idea-not-checked: the PRD's and Shape's own fixtures answer status.
      return null;
  }
}

function refreshFor(team: string): string | null {
  switch (team) {
    case "start-taken":
      done.refreshed = true;
      return "refresh.team-start-taken";
    case "start-not-checked":
      return "refresh.start-empty";
    case "start-several":
      return "refresh.team-several-start";
    case "prd-not-checked":
    case "idea-not-checked":
      return null;
    default:
      // Once a choice is made, or for a slice's own page in text-taken, a refresh that reports nothing new: the
      // same-moment run's (its notices are on the slice, not in the refresh).
      if (done.took || (team === "text-taken" && devParam("show"))) return "refresh.team-same-moment";
      return `refresh.team-${team}`;
  }
}

/** Answers one operation of the team states, or null when the address does not ask for them or it is not one of them. */
export function teamRoute(path: string, args: Record<string, unknown>): TransportResponse | null {
  const team = teamScenario();
  if (!team) return null;
  const op = path.startsWith("/api/ops/") ? path.slice("/api/ops/".length) : null;
  const sliceId = typeof args.slice_id === "string" ? args.slice_id : "";
  switch (op) {
    case "status": {
      const name = statusFor(team);
      return name ? answer(name) : null;
    }
    case "refresh": {
      const name = refreshFor(team);
      return name ? answer(name) : null;
    }
    case "slice.show":
      if (team === "same-moment") return answer(done.ready || sliceId === "SLICE-002" ? "slice.show.team-same-moment" : "slice.show.team-before-same-moment");
      if (team === "epic-same-moment") return answer(done.ready ? "slice.show.team-epic-same-moment" : "slice.show.team-before-epic-same-moment");
      if (team === "twice-closed") return answer("slice.show.team-twice-closed");
      return null;
    case "slice.ready":
      if (team === "same-moment" || team === "epic-same-moment") {
        done.ready = true;
        return answer(`slice.ready.team-${team}`);
      }
      if (team === "several") return answer("slice.ready.team-several");
      if (team === "text-taken") return answer("slice.ready.team-text-taken");
      if (team === "project-changed") return answer("slice.ready.team-text-changed");
      return null;
    case "reconcile": {
      const take = args.take === "theirs" ? "theirs" : "mine";
      if (team === "project-unreadable") {
        if (take === "theirs") return answer("reconcile.team-project-theirs-refused");
        done.took = "mine";
        // Borrowed from project-changed: the engine's note for keeping the project is the same.
        return answer("reconcile.team-project-mine");
      }
      done.took = take;
      return answer(args.target === "project" ? `reconcile.team-project-${take}` : `reconcile.team-epic-${take}`);
    }
    case "project.init":
      if (team === "start-several") return answer("project.init.team-several");
      done.named = true;
      return answer(team === "start-not-checked" ? "project.init.team-not-checked" : "project.init.team-taken");
    case "prd.list":
      return team === "prd-not-checked" ? answer("prd.list") : null;
    case "prd.show":
      return team === "prd-not-checked" ? answer("prd.show") : null;
    case "prd.status":
      return team === "prd-not-checked" ? answer(done.applied ? "prd.status.team-not-checked" : "prd.status.team-settled") : null;
    case "prd.apply":
      if (team !== "prd-not-checked") return null;
      done.applied = true;
      return answer("prd.apply.team-not-checked");
    case "idea.apply":
      return team === "idea-not-checked" ? answer("idea.apply.team-not-checked") : null;
  }
  return null;
}
