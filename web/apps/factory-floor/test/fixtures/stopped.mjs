// A ticket's lifecycle records as the observer serves them (version 3), for the stopped panel and the
// rounds: three failed verification rounds, the build station's refusal of a fourth (round-limit, stage
// blocked), and, when asked, a person's carry-on in the shape the stations write it (data.carried_on:
// the new round, the new limit, who gave them). The same scenario as the observer's synthetic one
// (apps/observer/internal/testkit/synth/stopped.go), smaller.
import { ev, finalize } from "./v3.mjs";

export const T0 = Date.UTC(2026, 10, 24, 20, 0, 0);

/**
 * `carry`: [] (stopped), or a list of carry-ons, each { by, max, then } where `then` is "decided" (recorded, the
 * revision not started), "build"
 * (the build round started) or "fail-build" (that round's verification failed and it went back to build).
 */
export function stoppedRun({ ticket = "6", carry = [], extraBuild = false, reset = false } = {}) {
  const out = [];
  const key = `c:${ticket}:5e6f7a8b`;
  let seq = 0;
  let t = T0;
  const visits = {};
  const life = (type, station, visit, round, data) =>
    out.push(ev(type, { stream: "cell-lifecycle", key, seq: ++seq, t: (t += 60_000), ids: { ticket_id: ticket, slice_id: "SLICE-006", cell_instance: "5e6f7a8b", visit_id: visit, station, round }, entities: [`cell:${ticket}`, `station:${ticket}/${station}`, `visit:${visit}`], data }));
  const enter = (station, round, data) => {
    visits[station] = (visits[station] ?? 0) + 1;
    const visit = `${ticket}/${station}#${visits[station]}`;
    life("station.entered", station, visit, round, { station, stage: data.stage ?? null, action: data.action ?? station, resumed: false, unclosed_visit: null, head: null, counts: {}, ...(data.carried_on ? { carried_on: data.carried_on } : {}) });
    return visit;
  };
  const exit = (station, visit, round, outcome, stage) => life("station.exited", station, visit, round, { station, outcome, stage, duration_ms: 60_000, closed_by: null, head: null, counts: {} });
  const failedVerify = (round, failing) => {
    const v = enter("verify", round, { stage: "built" });
    for (const id of ["AC-01", "AC-02", "AC-03", "AC-04", "AC-05"]) {
      life("verify.check_recorded", "verify", v, round, { target_id: id, target_kind: "scenario", result: failing.includes(id) ? "fail" : "pass", evidence: [] });
    }
    life("gate.evaluated", "verify", v, round, { gate: "verify.verdict", verdict: "refused", reason_code: "FAIL_WITH_EVIDENCE", subject: null, status: "FAIL_WITH_EVIDENCE", audit_tier: null, counts: {} });
    exit("verify", v, round, "FAIL_WITH_EVIDENCE", "built");
  };
  for (let round = 1; round <= 3; round++) {
    const b = enter("build", round, { stage: "building", action: round === 1 ? "build" : "revise" });
    exit("build", b, round, "built", "built");
    failedVerify(round, round === 3 ? ["AC-03", "AC-05"] : ["AC-03"]);
  }
  // The build station refuses a fourth round: the ticket is stopped for a person.
  life("gate.evaluated", "build", `${ticket}/build#${visits.build}`, 3, { gate: "round-limit", verdict: "refused", reason_code: "round-limit", subject: null, status: null, audit_tier: null, counts: { rounds: 3 } });
  const stop = enter("build", 3, { stage: "blocked", action: "revise" });
  exit("build", stop, 3, "escalated", "blocked");
  if (extraBuild) {
    // A fourth build round recorded with no carry-on record (the record was lost): the limit reads as the round that started.
    enter("build", 4, { stage: "building", action: "revise" });
  }
  let judged = 3;
  for (const c of carry) {
    t += 3_600_000;
    // The build station's record (rounds.py): station.exited, the round being judged as the envelope's round.
    const number = judged + 1;
    const base = c.by === "person-start" ? judged : 0;
    life("station.exited", "build", `${ticket}/build#${visits.build}`, judged, {
      station: "build", outcome: "carried-on-by-person", stage: "built", duration_ms: null, closed_by: null, head: null, counts: { round_number: number, rounds_base: base },
      carried_on: { outcome: "carried-on-by-person", round: number - base, max: c.max, number, base, by: c.by, stopped_at: "verify" },
    });
    if (c.then === "decided") continue; // the revision has not started yet
    const b = enter("build", number, { stage: "building", action: "revise" });
    judged = number;
    if (c.then === "fail-build") {
      exit("build", b, number, "built", "built");
      failedVerify(number, ["AC-05"]);
      enter("build", number + 1, { stage: "building", action: "revise" });
      judged = number + 1;
    }
  }
  if (reset) {
    // A person started the Factory on a ticket that is not stopped: its count starts again.
    t += 3_600_000;
    life("station.exited", "build", `${ticket}/build#${visits.build}`, judged, {
      station: "build", outcome: "rounds-reset", stage: "building", duration_ms: null, closed_by: null, head: null, counts: {},
      carried_on: { outcome: "rounds-reset", round: 1, max: 3, number: judged, base: judged - 1, by: "person-start", stopped_at: null },
    });
  }
  return finalize(out);
}
