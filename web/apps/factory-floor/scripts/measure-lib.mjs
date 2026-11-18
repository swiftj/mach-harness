// Small measuring helpers for the Analytics performance harness (analytics-measure.mjs): facts about
// this machine and checkout, a distribution of samples, and the JS heap after a forced collection.
import { spawnSync } from "node:child_process";
import os from "node:os";
import { app } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Facts about this machine and checkout, for the report. */
export function machineFacts() {
  const git = (...a) => spawnSync("git", a, { cwd: app, encoding: "utf8" }).stdout?.trim() || null;
  const cpu = os.cpus();
  return {
    cpu: cpu[0]?.model ?? null,
    cores: cpu.length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    commit: git("rev-parse", "--short", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
    power: os.platform() === "darwin" ? (spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" }).stdout?.split("\n")[0] ?? null) : null,
  };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

/** The median, 95th percentile and maximum of a list of samples. */
export function distribution(values) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: r1(pct(s, 50)), p95: r1(pct(s, 95)), max: r1(s.at(-1) ?? null) };
}

async function metrics(cdp) {
  const { metrics: m } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}

/** JS heap after a forced garbage collection, in MB. */
export async function heapAfterGc(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await sleep(200);
  await cdp.send("HeapProfiler.collectGarbage");
  const m = await metrics(cdp);
  return { heapMB: Math.round((m.JSHeapUsedSize / 2 ** 20) * 10) / 10, nodes: m.Nodes, listeners: m.JSEventListeners };
}
