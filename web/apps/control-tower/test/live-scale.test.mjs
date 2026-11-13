// M6.2: scale. Twelve cells at once, and a 200,000-event history: reducer throughput, re-derivation
// cost, random-access scene cost and heap, measured; memory bounded by `retain`. And src/live reads
// wall time only through the injected clock and timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";
import { sim, live } from "./_load.mjs";
import { beltRun, finalize } from "./fixtures/v3.mjs";

const { createSceneLog, provenance, activityOf } = sim;
v8.setFlagsFromString("--expose_gc");
const gc = vm.runInNewContext("gc");
const heapMb = () => {
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1048576;
};

const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const hex = (n, w) => n.toString(16).padStart(w, "0");

/** `lanes` cells in parallel, `rounds` belts each, one after the other per lane. */
function factory({ lanes, rounds, progressEvery = 1, approve = true }) {
  const events = [];
  let n = 0;
  for (let r = 0; r < rounds; r++) {
    for (let lane = 0; lane < lanes; lane++) {
      n++;
      const ticket = `LOCAL-${hex(n, 4)}`;
      const run = beltRun({
        ticket,
        slice: `SLICE-${hex(n, 4)}`,
        wave: `WAVE-${hex(r, 3)}`,
        execution: `x${hex(n, 12)}`,
        intakeGen: hex(n, 8),
        cellGen: hex(n * 7919, 8).slice(-8),
        t0: T0 + r * 900_000 + lane * 4_000,
        approve,
        progressEvery,
      });
      events.push(...run.events);
    }
  }
  return finalize(events);
}

test("twelve cells at once: every one reaches its human gate, the scene holds all twelve", (t) => {
  const events = factory({ lanes: 12, rounds: 1, approve: false });
  const t0 = performance.now();
  const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live") });
  log.ingest(events);
  const ms = performance.now() - t0;
  const head = log.head();
  assert.equal(Object.keys(head.cells).length, 12);
  for (const cell of Object.values(head.cells)) {
    assert.equal(cell.stage, "awaiting-human");
    assert.equal(activityOf(head, `cell:${cell.ticketId}`).state, "waiting-person");
  }
  // Mid-run, all twelve are at work at once.
  const busy = log.sceneAt(T0 + 200_000);
  const executing = Object.keys(busy.cells).filter((id) => activityOf(busy, `cell:${id}`).state === "executing").length;
  assert.equal(executing, 12, `executing at once: ${executing}`);
  t.diagnostic(`12 cells: ${events.length} events reduced in ${ms.toFixed(1)} ms`);
});

test("a 200,000-event history: throughput, late-event cost, random access, heap (measured)", (t) => {
  const events = factory({ lanes: 12, rounds: 54, progressEvery: 1 });
  const history = events.slice(0, 200_000);
  assert.equal(history.length, 200_000);
  const before = heapMb();
  const t0 = performance.now();
  const log = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live"), checkpointEvery: 128, cacheSize: 256 });
  for (let i = 0; i < history.length; i += 256) log.ingest(history.slice(i, i + 256)); // as the stream delivers: batches of up to 256
  const ingestMs = performance.now() - t0;
  const after = heapMb();
  const throughput = history.length / (ingestMs / 1000);

  // A late event 300 events behind the head.
  const late = history[history.length - 300];
  const log2 = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live"), checkpointEvery: 128 });
  log2.ingest(history.filter((e) => e !== late));
  const t1 = performance.now();
  const r = log2.ingest([late]);
  const lateMs = performance.now() - t1;
  assert.deepStrictEqual(log2.head(), log.head());

  // Random access over the whole history (scrubbing).
  const span = log.headTime() - log.floorTime();
  const t2 = performance.now();
  let checksum = 0;
  for (let i = 0; i < 2000; i++) checksum += log.sceneAt(log.floorTime() + ((i * 7919) % 2000) * (span / 2000)).cursor;
  const accessUs = ((performance.now() - t2) / 2000) * 1000;

  const cells = Object.keys(log.head().cells).length;
  t.diagnostic(`200,000 events, ${cells} cells: ingest ${ingestMs.toFixed(0)} ms (${Math.round(throughput).toLocaleString("en")} events/s); heap +${(after - before).toFixed(0)} MB (${log.stats().checkpoints} checkpoints); late event 300 back: ${r.rederived} reductions in ${lateMs.toFixed(1)} ms; random sceneAt ${accessUs.toFixed(0)} µs (checksum ${checksum})`);
  assert.ok(throughput > 20_000, `throughput ${throughput}`);
  assert.ok(r.rederived <= 300 + 128, `re-derived ${r.rederived}`);
  assert.ok(accessUs < 5_000, `random access ${accessUs} µs`);

  // Bounded: keep the newest 50,000.
  const before2 = heapMb();
  const bounded = createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: provenance("live"), checkpointEvery: 128, retain: 50_000 });
  for (let i = 0; i < history.length; i += 256) bounded.ingest(history.slice(i, i + 256));
  const after2 = heapMb();
  assert.ok(bounded.stats().events <= 55_000 + 128);
  assert.deepStrictEqual(bounded.head(), log.head(), "compaction never changes what is shown at the edge");
  t.diagnostic(`retain 50,000: ${bounded.stats().events} events kept, ${bounded.stats().compactions} compactions, heap +${(after2 - before2).toFixed(0)} MB`);
});

const here = dirname(fileURLToPath(import.meta.url));
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("src/live reads wall time only through the injected clock and timers, and has no randomness", () => {
  const folder = join(here, "..", "src", "live");
  const files = readdirSync(folder).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const code = strip(readFileSync(join(folder, file), "utf8"));
    for (const pattern of [/Math\.random/, /Date\.now/, /new Date\(\s*\)/, /performance\.now/, /[^.\w](setTimeout|setInterval)\((?!callback)|requestAnimationFrame\(/, /new EventSource|\bfetch\(/]) {
      assert.ok(!pattern.test(code.replace(/timers\.set(Timeout|Interval)\(/g, "").replace(/options\.fetch\(/g, "")), `${file} uses ${pattern}`);
    }
  }
});

test("no code in sim, scene or live parses an agent or tool id", () => {
  for (const sub of ["sim", "scene", "live"]) {
    const folder = join(here, "..", "src", sub);
    for (const file of readdirSync(folder).filter((f) => f.endsWith(".ts"))) {
      const code = strip(readFileSync(join(folder, file), "utf8"));
      assert.ok(!/agent[A-Za-z]*\.(slice|split|substring|match)\(/i.test(code), `${sub}/${file} parses an agent id`);
      assert.ok(!/(call|tool)Id\.(slice|split|substring|match)\(/.test(code), `${sub}/${file} parses a tool id`);
    }
  }
});
