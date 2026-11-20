/**
 * M15: the waits M13 and M14 added, read from what the scene holds. Pure. One reading for every
 * view, so the Line, the Floor and the inspector agree (test/m15-states.test.mjs).
 *
 * - `main-conflict` (M13, build on today's main): the build station refused to start or revise
 *   because merging the main branch in conflicts (a recorded `build.start`/`build.revise` refusal with
 *   reason code `main-conflict`, and no build entered since), or the supervisor recorded the stop
 *   (`needs: main-conflict`, revision 7). A person resolves it.
 * - `policy-owner` (M14, policy packs): the spec is held at `spec-open` only by a policy concern: the
 *   finalize gate refused with `open-questions` while its count of open questions was 0, or the
 *   supervisor recorded the stop. The policy's owner acts.
 * - `merge-recheck` (M13, the check at the merge): the merge station's last visit ended
 *   `landed-overlap` and nothing has been verified since. Nobody needs to act: it goes back to be
 *   verified and reviewed again, and no judging round is used.
 *
 * Every reading comes from a recorded code; prose is never read. A code these rules do not know is
 * left to the generic account the views already give.
 */
import type { AttentionEntry, CellState, GateEvaluation, Scene, StationVisit } from "./model";

export type CellStopKind = "main-conflict" | "policy-owner" | "merge-recheck";

export interface CellStop {
  readonly kind: CellStopKind;
  /** When the record that says so was made (source time), or null when none says. */
  readonly since: number | null;
  /** Which record says so: the station's own gate or exit, or the supervisor's recorded stop. */
  readonly basis: "station" | "supervisor";
  /** merge-recheck: how many times the merge-time recheck sent it back. */
  readonly times: number;
}

function lastVisit(cell: CellState, station: StationVisit["station"]): StationVisit | null {
  for (let i = cell.visits.length - 1; i >= 0; i--) if ((cell.visits[i] as StationVisit).station === station) return cell.visits[i] as StationVisit;
  return null;
}

function lastGate(cell: CellState, pick: (g: GateEvaluation) => boolean): GateEvaluation | null {
  for (let i = cell.gateLog.length - 1; i >= 0; i--) if (pick(cell.gateLog[i] as GateEvaluation)) return cell.gateLog[i] as GateEvaluation;
  return null;
}

/** The supervisor's recorded stop for a ticket (human.required `needs`, or the last execution's). */
function recordedNeeds(scene: Scene, cell: CellState): { readonly needs: string; readonly at: number | null } | null {
  const attention: AttentionEntry | undefined = scene.supervisor.attention[cell.ticketId];
  if (attention?.needs) return { needs: attention.needs, at: attention.at };
  const x = cell.executionId ? scene.executions[cell.executionId] : undefined;
  if (x?.outcome?.needs) return { needs: x.outcome.needs, at: x.endedAt };
  return null;
}

export function cellStopOf(scene: Scene, cell: CellState): CellStop | null {
  if (cell.merged || cell.stage === "merged" || cell.stage === "blocked") return null;
  const recorded = recordedNeeds(scene, cell);
  if (cell.stage === "spec-open") {
    const finalize = lastGate(cell, (g) => g.gate === "groom.finalize");
    const onlyConcerns = finalize?.verdict === "refused" && finalize.reasonCode === "open-questions" && finalize.counts?.open_questions === 0;
    if (onlyConcerns) return { kind: "policy-owner", since: finalize.at, basis: "station", times: 0 };
    if (recorded?.needs === "policy-owner") return { kind: "policy-owner", since: recorded.at, basis: "supervisor", times: 0 };
    return null;
  }
  if (cell.stage === "planned" || cell.stage === "built" || cell.stage === "building") {
    const build = lastVisit(cell, "build");
    const conflict = lastGate(cell, (g) => g.gate === "build.start" || g.gate === "build.revise");
    if (conflict && conflict.verdict === "refused" && conflict.reasonCode === "main-conflict" && (!build || build.enteredAt <= conflict.at)) {
      return { kind: "main-conflict", since: conflict.at, basis: "station", times: 0 };
    }
    if (recorded?.needs === "main-conflict" && (!build || recorded.at === null || build.enteredAt <= recorded.at)) {
      return { kind: "main-conflict", since: recorded.at, basis: "supervisor", times: 0 };
    }
  }
  if (cell.stage === "built") {
    const merge = lastVisit(cell, "merge");
    const verify = lastVisit(cell, "verify");
    if (merge && merge.outcomeWord === "landed-overlap" && merge.leftAt !== null && (!verify || verify.enteredAt < merge.leftAt)) {
      const times = cell.visits.filter((v) => v.station === "merge" && v.outcomeWord === "landed-overlap").length;
      return { kind: "merge-recheck", since: merge.leftAt, basis: "station", times };
    }
  }
  return null;
}

/** How many times the merge-time recheck sent a ticket back (merge exits `landed-overlap`), whatever stage it is at now. */
export function recheckCount(cell: CellState): number {
  return cell.visits.filter((v) => v.station === "merge" && v.outcomeWord === "landed-overlap").length;
}

export interface MockWait {
  readonly sliceId: string;
  readonly issue: number | null;
  readonly revision: number | null;
  readonly since: number;
  /** Intake's own sentence (MACH-written, but it names files: shown contained, like a recorded reason). */
  readonly reason: string;
}

/** Slice issues intake holds until their design mocks are committed (intake.refused `waiting: mocks`) and not yet taken in. */
export function mockWaitsOf(scene: Scene): MockWait[] {
  const out: MockWait[] = [];
  for (const [id, a] of Object.entries(scene.supervisor.attention)) {
    if (a.needs !== "waiting-mocks") continue;
    if (scene.slices[id]) continue; // taken in after all
    out.push({ sliceId: id, issue: a.issue ?? null, revision: a.revision ?? null, since: a.at, reason: a.reason });
  }
  return out.sort((a, b) => a.since - b.since || (a.sliceId < b.sliceId ? -1 : 1));
}
