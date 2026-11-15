// Source scans: the simulation has no randomness and no wall clock, and the catalog matches MACH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sim } from "./_load.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const repo = join(app, "..", "..", "..");

const sources = (folder) =>
  readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("src/sim uses no randomness and no wall clock", () => {
  const forbidden = [/Math\.random/, /Date\.now/, /new Date\(\s*\)/, /performance\.now/, /crypto\.getRandomValues/, /crypto\.randomUUID/, /setTimeout|setInterval|requestAnimationFrame/];
  const files = sources(join(app, "src", "sim"));
  assert.ok(files.length >= 10);
  for (const file of files) {
    const code = strip(readFileSync(file, "utf8"));
    for (const pattern of forbidden) assert.ok(!pattern.test(code), `${relative(app, file)} uses ${pattern}`);
  }
});

test("src/scene reads wall time only through the injectable clock", () => {
  for (const file of sources(join(app, "src", "scene"))) {
    const code = strip(readFileSync(file, "utf8"));
    assert.ok(!/Math\.random|Date\.now/.test(code), relative(app, file));
    if (!file.endsWith("clock.ts")) assert.ok(!/performance\.now|requestAnimationFrame\(/.test(code), `${relative(app, file)} reads the clock directly`);
  }
});

test("src/sim and src/scene use only erasable TypeScript (node strips the types)", () => {
  for (const file of [...sources(join(app, "src", "sim")), ...sources(join(app, "src", "scene"))]) {
    const code = strip(readFileSync(file, "utf8"));
    assert.ok(!/^\s*(export\s+)?(declare\s+)?(const\s+)?enum\s+\w+\s*\{/m.test(code), `${relative(app, file)} declares an enum`);
    assert.ok(!/^\s*(export\s+)?(declare\s+)?namespace\s+\w+\s*\{/m.test(code), `${relative(app, file)} declares a namespace`);
    assert.ok(!/constructor\s*\(\s*(public|private|protected|readonly)\s/.test(code), `${relative(app, file)} uses parameter properties`);
  }
});

test("the real kinds are exactly intake.py EVENT_TYPES", () => {
  const intake = readFileSync(join(repo, "skills", "run", "scripts", "intake.py"), "utf8");
  const block = intake.slice(intake.indexOf("EVENT_TYPES = ("), intake.indexOf(")\nAPPROVED"));
  const kinds = [...block.matchAll(/"([a-z]+\.[a-z_]+)"/g)].map((m) => m[1]);
  assert.equal(kinds.length, 22);
  assert.deepEqual([...sim.REAL_KINDS].sort(), kinds.sort());
});

test("the envelope's fields are the schema's required fields", () => {
  const schema = JSON.parse(readFileSync(join(repo, "docs", "mach-next", "schemas", "factory-event.schema.json"), "utf8"));
  const event = sim.SCENARIO.events[0];
  assert.deepEqual(Object.keys(event).filter((k) => k !== "t").sort(), [...schema.required].sort());
  assert.deepEqual([...schema.properties.type.enum].sort(), [...sim.REAL_KINDS].sort());
  assert.deepEqual([...schema.properties.source.enum].sort(), ["engineer", "intake", "supervisor"]);
});

test("the catalog covers every kind; only real kinds 'exist'; every entry says where", () => {
  const { EVENT_CATALOG, REAL_KINDS, SIM_KINDS } = sim;
  assert.equal(Object.keys(EVENT_CATALOG).length, REAL_KINDS.length + SIM_KINDS.length);
  for (const kind of [...REAL_KINDS, ...SIM_KINDS]) {
    const entry = EVENT_CATALOG[kind];
    assert.ok(entry, kind);
    assert.equal(entry.real, REAL_KINDS.includes(kind));
    assert.equal(entry.telemetry === "exists", entry.real, `${kind}: only intake.EVENT_TYPES kinds exist today`);
    assert.ok(entry.meaning.length > 10 && entry.payload.length > 3 && entry.source.length > 10, kind);
    if (entry.real) assert.match(entry.source, /\.py/);
  }
});

test("agent models and stations match MACH's own files", () => {
  const agents = join(repo, "agents");
  for (const [role, file] of [["builder", "builder.md"], ["verifier", "verifier.md"], ["reviewer", "reviewer.md"], ["contract-engineer", "contract-engineer.md"]]) {
    const model = /^model:\s*(\w+)/m.exec(readFileSync(join(agents, file), "utf8"))[1];
    const used = sim.SCENARIO.events.filter((e) => e.type === "agent.started" && e.data.role === role && e.data.seat === null).map((e) => e.data.model);
    for (const m of used) assert.equal(m, model, `${role} runs on ${m}, agents/${file} says ${model}`);
  }
  const belt = readFileSync(join(repo, "workflows", "belt.js"), "utf8");
  for (const phase of sim.BELT_PHASES) assert.ok(belt.includes(`title: '${phase}'`), phase);
});
