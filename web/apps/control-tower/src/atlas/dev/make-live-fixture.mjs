// Development only: writes the event histories the Atlas live dev page (live.html) replays, built
// with the store's own test fixture generator (test/fixtures/v3.mjs), so no production code path
// knows about fixtures. Output: node_modules/.cache/atlas-live/fixture.json (git-ignored).
//
//   node src/atlas/dev/make-live-fixture.mjs
//
// Scenarios:
// - twelve: twelve cells through the belt at once (the scale test's factory, one round, no approval).
// - three: three cells showing the states the simulation never has: one interrupted (its process
//   killed mid-build; the observer closes its running agents as unknown), one with its history
//   beginning part-way (history.began) and one waiting for an execution place (capacity.wait_changed).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beltRun, ev, finalize } from "../../../test/fixtures/v3.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "..", "node_modules", ".cache", "atlas-live", "fixture.json");
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const hex = (n, w) => n.toString(16).padStart(w, "0");

function lane(n, { t0, approve = false }) {
  return beltRun({
    ticket: `LOCAL-${hex(n, 4)}`,
    slice: `SLICE-${hex(n, 4)}`,
    wave: "WAVE-001",
    execution: `x${hex(n, 12)}`,
    intakeGen: hex(n, 8),
    cellGen: hex(n * 7919, 8).slice(-8),
    t0,
    approve,
    progressEvery: 3,
  });
}

function twelve() {
  const events = [];
  for (let i = 0; i < 12; i++) events.push(...lane(i + 1, { t0: T0 + i * 4_000 }).events);
  return finalize(events);
}

function three() {
  const events = [];
  // 1: an ordinary run whose history begins part-way (the observer started with it in flight).
  const a = lane(1, { t0: T0 });
  events.push(...a.events);
  events.push(ev("history.began", { stream: "observer", key: "c:LOCAL-0001:begin", seq: 1, t: T0 + 500, ids: { ticket_id: "LOCAL-0001", slice_id: "SLICE-0001" }, entities: ["cell:LOCAL-0001"], data: { reason: "The observer started with this cell in flight.", snapshot: { stage: "planned", round: 1, station: null } } }));
  // 2: interrupted mid-build: the process is killed; the observer closes the agents left open.
  const b = lane(2, { t0: T0 + 4_000 });
  const cut = T0 + 4_000 + 40_000;
  const kept = b.events.filter((e) => e.time.order_ms <= cut);
  const started = new Map();
  for (const e of kept) {
    if (e.type === "agent.started") started.set(e.ids.agent_id, e);
    if (e.type === "agent.finished") started.delete(e.ids.agent_id);
  }
  events.push(...kept);
  const exec = "x" + hex(2, 12);
  events.push(ev("execution.process_ended", { stream: "execution-record", key: `x:${exec}`, seq: 2, t: cut + 1_000, precision: "s", ids: { ticket_id: "LOCAL-0002", execution_id: exec }, entities: [`execution:${exec}`, "cell:LOCAL-0002"], data: { ended: "interrupted", exit_code: null, seconds: 41 } }));
  let k = 0;
  for (const [agentId, s] of started) {
    if (agentId.endsWith("/main")) continue;
    events.push(ev("agent.finished", { stream: "observer", key: `close:${agentId}`, seq: ++k, t: cut + 1_000, precision: "bounded", ids: { ...s.ids }, entities: s.entities, parent: s.parent, data: { status: "unknown", duration_ms: null, tokens: null, tool_calls: null } }));
  }
  // 3: taken in and scheduled, then held: every execution place is in use (recorded).
  const c = lane(3, { t0: T0 + 8_000 });
  const scheduled = c.events.filter((e) => ["wave.discovered", "slice.materialized", "dependency.resolved", "work.scheduled"].includes(e.type));
  events.push(...scheduled);
  const at = scheduled.at(-1).time.order_ms + 1_500;
  events.push(ev("capacity.wait_changed", { stream: "intake-log", key: "i:capacity", seq: 1, t: at, precision: "s", writer: "supervisor", ids: { ticket_id: "LOCAL-0003", slice_id: "SLICE-0003" }, entities: ["cell:LOCAL-0003"], data: { state: "waiting", limit: 2, running: 2 } }));
  return finalize(events);
}

mkdirSync(dirname(out), { recursive: true });
const data = { twelve: twelve(), three: three() };
writeFileSync(out, JSON.stringify(data));
console.log(`wrote ${out}: twelve ${data.twelve.length} events, three ${data.three.length} events`);
