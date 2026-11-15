// The Timeline while the history changes under it, over a real mach-observer: late and
// out-of-order events reaching a window in the past (case 10), the live edge advancing (mach-synth
// --append), and the observer restarted on the same project (case 13: no duplicated rows).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiGet,
  apiOffenders,
  apiSession,
  appendSynth,
  consoleErrors,
  expandTable,
  hooks,
  launch,
  openApp,
  readTable,
  sleep,
  startObserver,
  synthProject,
  ensureStack,
} from "../scripts/timeline-e2e-lib.mjs";

const PORT = 4241;
const check = (ok, id, message) => assert.ok(ok, `${message} [${id}]`);

let browser;
let obs;
let dir;
let summary;
const pages = [];

async function open(hash, opts) {
  const { page, context } = await openApp(browser, obs, hash, opts);
  pages.push(page);
  return { page, context };
}

before(async () => {
  await ensureStack();
  ({ dir, summary } = synthProject("live", { cells: 12, events: 12000, seed: 7, hours: 6 }));
  obs = await startObserver(dir, PORT);
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await obs?.stop();
});

const iso = (ms) => new Date(ms).toISOString();

/** Lines in the cell lifecycle format (internal/testkit/synth/write.go), stamped in the past, written now. */
function lateVisit(ticket, station, fromMs, toMs) {
  const file = join(dir, ".factory", "worktrees", ticket, "lifecycle.jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const seq = Math.max(...lines.map((l) => l.seq)) + 1;
  const exec = lines.find((l) => l.at <= iso(fromMs) && l.execution_id)?.execution_id ?? null;
  const base = { execution_id: exec, round: null, station, ticket_id: ticket, v: 1, visit: `${station}#1` };
  const out = [
    { ...base, at: iso(fromMs), data: { stage: "planned" }, seq, type: "station.entered" },
    { ...base, at: iso(toMs), data: { outcome: "Gold", stage: "planned" }, seq: seq + 1, type: "station.exited" },
  ];
  appendFileSync(file, out.map((o) => JSON.stringify(o)).join("\n") + "\n");
}

const keysOf = (rows) => rows.map((r) => r.key);
const dupes = (keys) => keys.filter((k, i) => keys.indexOf(k) !== i);

describe("Timeline over a changing history (real observer)", () => {
  test("(10) a late, out-of-order visit reaches a window in the past without a reload", async () => {
    // SYN-008's plan visit ends at about 03:44:45; nothing is recorded for an audit visit.
    const t = "SYN-008";
    const plan = readFileSync(join(dir, ".factory", "worktrees", t, "lifecycle.jsonl"), "utf8").split("\n").filter((l) => l.includes('"plan#1"') && l.includes("station.exited"))[0];
    assert.ok(plan, `${t} has no plan visit in this history`);
    const planEnd = Date.parse(JSON.parse(plan).at);
    const from = planEnd - 15 * 60_000;
    const to = planEnd + 15 * 60_000;
    const { page, context } = await open(`#timeline?win=${from}-${to}&table=1`, { height: 1200 });
    await expandTable(page, { match: new RegExp(`${t}$|track:(slice|wave|cell):[^/]*$`) });
    const before_ = await readTable(page);
    assert.ok(before_.some((r) => r.key === `track:cell:${t}`), `${t} is not in the window ${from}-${to}`);
    assert.ok(!before_.some((r) => r.key === `track:station:${t}/audit`), `${t} already has an audit visit`);
    const at0 = (await hooks(page)).window;
    lateVisit(t, "audit", planEnd + 5_000, planEnd + 35_000);
    let found = null;
    for (let i = 0; i < 30 && !found; i++) {
      await sleep(1000);
      found = (await readTable(page)).find((r) => r.key === `track:station:${t}/audit`) ?? null;
    }
    if (!found) {
      // Tell a client that never re-read the window apart from an observer that never took the line in.
      const cookie = await apiSession(obs);
      const got = await apiGet(obs, cookie, `/api/v1/spans?from_ms=${from}&to_ms=${to}`);
      const held = JSON.stringify(got.body).includes(`${t}/audit#1`);
      assert.ok(held, `the observer itself does not serve the late audit visit for ${t} (status ${got.status})`);
    }
    check(found, "T5", `30 s after a late audit visit for ${t} was written (and the observer serves it), the past window still does not show it`);
    assert.equal((await hooks(page)).window, at0, "the window moved by itself");
    await context.close();
  });

  test("the live edge: events appended to the open execution reach the Timeline while following", async () => {
    const { page, context } = await open("#timeline?group=execution&table=1", { height: 1200 });
    const exec = summary.features.open_execution;
    await expandTable(page, { match: new RegExp(`track:execution:${exec}`), maxPasses: 3 });
    const count = async () => (await readTable(page)).filter((r) => r.key?.includes(exec)).length;
    const n0 = await count();
    assert.ok(n0 > 0, `the open execution ${exec} is not on the tracks`);
    const s0 = (await hooks(page)).spans;
    appendSynth(dir, { rate: 40, duration: "3s" });
    let n1 = n0;
    let s1 = s0;
    for (let i = 0; i < 20 && n1 === n0 && s1 === s0; i++) {
      await sleep(1000);
      n1 = await count();
      s1 = (await hooks(page)).spans;
    }
    assert.ok(n1 > n0 || s1 > s0, `nothing new on the tracks 20 s after appending to ${exec} (rows ${n0} → ${n1}, spans ${s0} → ${s1})`);
    await context.close();
  });

  test("(13) the observer restarted on the same project: after a reload, no duplicated rows", async () => {
    const hash = "#timeline?table=1&win=all";
    const a = await open(hash, { height: 1400 });
    await expandTable(a.page);
    const rowsA = await readTable(a.page);
    const spansA = (await hooks(a.page)).spans;
    assert.deepEqual(dupes(keysOf(rowsA)), [], "duplicated rows before the restart");
    await a.context.close();

    await obs.stop();
    obs = await startObserver(dir, PORT);
    const b = await open(hash, { height: 1400 });
    await expandTable(b.page);
    const rowsB = await readTable(b.page);
    const spansB = (await hooks(b.page)).spans;
    assert.deepEqual(dupes(keysOf(rowsB)), [], "duplicated rows after the restart");
    const onlyB = keysOf(rowsB).filter((k) => !keysOf(rowsA).includes(k));
    const onlyA = keysOf(rowsA).filter((k) => !keysOf(rowsB).includes(k));
    assert.deepEqual({ onlyA, onlyB }, { onlyA: [], onlyB: [] }, "the rows differ after the restart");
    assert.equal(spansB, spansA, `data-timeline-spans ${spansA} before, ${spansB} after`);
    await b.context.close();
  });

  test("every /api request is a GET to 127.0.0.1, and no console errors", () => {
    const bad = pages.flatMap(apiOffenders);
    assert.deepEqual(bad, [], `non-GET or non-loopback API requests: ${JSON.stringify(bad.slice(0, 5))}`);
    const errors = pages.flatMap(consoleErrors);
    assert.deepEqual(errors, [], `console errors: ${errors.slice(0, 5).join(" | ")}`);
  });
});
