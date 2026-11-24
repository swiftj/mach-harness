// The inspector's panel for a gate (and every panel's header), after the owner used it: the ticket in
// the header's id links back, no "Related" list, a gate's reason in plain words (never "Refused:
// refused"), no note on how finely a shown time was measured, and a Record section that no longer
// says "Measured" beside its start and end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sim } from "./_load.mjs";

const O = await import("../src/shell/inspector/outcomes.ts");
const owner = await import("../src/shell/inspector/owner.ts");
const words = await import("../src/shell/inspector/words.ts");

const SRC = new URL("../src/", import.meta.url);
const src = (p) => readFileSync(new URL(p, SRC), "utf8");
const evaluation = (over = {}) => ({ gate: "plan.replan", verdict: "refused", reasonCode: null, subject: null, round: null, at: 1000, eventId: "e1", late: false, gateId: null, ref: "gate:LOCAL-001/plan.replan", ...over });

// ---------------------------------------------------------------- 1. the header's link back

test("the header's id names its ticket: that part is the link, the rest stays text", () => {
  assert.deepEqual(owner.ownerOfId("gate:LOCAL-001/groom.finalize"), { ticketId: "LOCAL-001", rest: "/groom.finalize" });
  assert.deepEqual(owner.ownerOfId("gate:LOCAL-001/verification#2"), { ticketId: "LOCAL-001", rest: "/verification#2" });
  assert.deepEqual(owner.ownerOfId("station:LOCAL-001/build"), { ticketId: "LOCAL-001", rest: "/build" });
  assert.deepEqual(owner.ownerOfId("visit:LOCAL-001/verify#1"), { ticketId: "LOCAL-001", rest: "/verify#1" });
  assert.deepEqual(owner.ownerOfId("seat:LOCAL-001/review#2/security"), { ticketId: "LOCAL-001", rest: "/review#2/security" });
  assert.deepEqual(owner.ownerOfId("finding:LOCAL-001/r2/security/1"), { ticketId: "LOCAL-001", rest: "/r2/security/1" });
  assert.deepEqual(owner.ownerOfId("artifact:LOCAL-001:evidence/run.log"), { ticketId: "LOCAL-001", rest: ":evidence/run.log" });
  // An id that does not start with its ticket has no link: an opaque execution, agent or tool id; the ticket itself; a station on its own.
  for (const ref of ["execution:x1a2b3c4d5e6f", "agent:a-77", "tool:t-1", "workflow:x1a2b3c4d5e6f/task0001", "cell:LOCAL-001", "slice:SLICE-001", "station:verify", "dependency:SLICE-2->SLICE-1"]) {
    assert.equal(owner.ownerOfId(ref), null, ref);
  }
});

test("the link selects the ticket's cell, its slice before it has a cell, and nothing that is not held", () => {
  const scene = { cells: { "LOCAL-001": {} }, slices: { "SLICE-002": { id: "SLICE-002", ticketId: "LOCAL-002" } } };
  assert.equal(owner.ownerRefOf(scene, "gate:LOCAL-001/groom.finalize"), "cell:LOCAL-001");
  assert.equal(owner.ownerRefOf(scene, "gate:LOCAL-002/groom.finalize"), "slice:SLICE-002");
  assert.equal(owner.ownerRefOf(scene, "gate:LOCAL-009/groom.finalize"), null, "no link to a ticket the history does not hold");
  // The simulation: every gate's header links its cell.
  const end = sim.finalScene(sim.SCENARIO);
  for (const g of Object.values(end.gates)) assert.equal(owner.ownerRefOf(end, `gate:${g.id}`), `cell:${g.ticketId}`, g.id);
});

test("the link is a real link with an accessible name, and following it moves focus to the new heading", () => {
  const inspector = src("shell/inspector/Inspector.tsx");
  assert.match(inspector, /<IdLine entity=\{entity\} id=\{identity\.id\} \/>/);
  assert.match(inspector, /<EntityLink to=\{owner\} label=\{`Back to \$\{parts\.ticketId\}`\}>\s*\{parts\.ticketId\}\s*<\/EntityLink>\s*\{parts\.rest\}/);
  assert.doesNotMatch(inspector.slice(inspector.indexOf("function IdLine")), /^\s*<p[^>]*truncate/m, "the id line wraps, so the link's focus ring is never clipped");
  const parts = src("shell/inspector/parts.tsx");
  const link = parts.slice(parts.indexOf("export function EntityLink"), parts.indexOf("export function RefLink"));
  assert.match(link, /<a\s+href=\{href\}\s+aria-label=\{label\}/, "an anchor with an address");
  assert.match(link, /formatHash\(\{ route: s\.workspace, sel: to/, "its address selects the entity");
  assert.match(link, /e\.preventDefault\(\);\s*follow\(store\.select, to\)/);
  assert.match(link, /e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey/, "a modified click opens it elsewhere");
  assert.match(parts, /function follow\([^)]*\)[^{]*\{\s*select\(target\);\s*requestAnimationFrame\(\(\) => document\.querySelector<HTMLElement>\("\[data-inspector-heading\]"\)\?\.focus/);
});

// ---------------------------------------------------------------- 2. no "Related" section

test("no panel has a Related section; what it held is linked where it is named", () => {
  const anat = src("shell/inspector/anatomies.tsx");
  assert.doesNotMatch(anat, /title="Related"/);
  assert.doesNotMatch(anat, /function CellLink/, "the owner link is the header's");
  const part = (from, to) => anat.slice(anat.indexOf(from), anat.indexOf(to));
  // Links no other place gives, moved beside what names them.
  assert.match(part("export function SliceAnatomy", "export function CellAnatomy"), /ref\.dependency\(d\.from, d\.to\)/, "a slice's dependencies");
  assert.match(part("export function SliceAnatomy", "export function CellAnatomy"), /\["Ticket", slice\.ticketId \? cell \? <IdLink/, "a slice's cell");
  assert.match(part("export function GateAnatomy", "function ReasonWords"), /\["Merged", <EntityLink key="m" to=\{ref\.station\("merge", gate\.ticketId\)\}>/, "a merged gate's merge");
  assert.match(part("export function FindingAnatomy", "export function DependencyAnatomy"), /ref\.gate\(`\$\{ticketId\}\/review#\$\{finding\.round\}`\)[\s\S]*ref\.agent\(seat\.agentId\)/, "a finding's round and reviewer");
  assert.match(part("export function DependencyAnatomy", "// ---------------------------------------------------------------- execution"),/ref\.slice\(from\.id\)[\s\S]*ref\.slice\(to\.id\)/, "a dependency's slices");
  assert.match(part("export function ExecutionAnatomy", "function allAgentsOf"), /\["Ticket", ticketCell \? <IdLink/, "an execution's ticket (its id does not name it)");
  assert.match(part("export function VisitAnatomy", "function ReviewerWords"), /ref\.station\(visit\.station, visit\.ticketId\)/, "a visit's station");
  assert.match(part("export function SeatAnatomy", "export function WorkflowAnatomy"), /ref\.gate\(`\$\{seat\.ticketId\}\/review#\$\{seat\.round\}`\)/, "a seat's review");
  assert.match(part("function ReviewerWords", "export function SeatAnatomy"), /ref\.agent\(seat\.agentId\)/, "a seat's reviewer");
  assert.match(part("export function WorkflowAnatomy", "export function ProjectAnatomy"), /ref\.execution\(workflow\.executionId\)/, "a workflow's execution");
  assert.match(part("function PerCallAgent", "// ---------------------------------------------------------------- tool call"), /\["Started by"[\s\S]*title="Agents it started"[\s\S]*title="What it wrote"/, "an agent's parent, children and files");
  assert.match(part("export function ToolAnatomy", "// ---------------------------------------------------------------- artifact"), /\["Made by"[\s\S]*title="What it wrote"/, "a tool call's agent and files");
});

// ---------------------------------------------------------------- 3. a gate's reason in words

test("a recorded reason code reads in plain words", () => {
  assert.deepEqual(O.gateReasonOf("plan-invalid"), { words: "the plan did not pass its check", code: "plan-invalid", known: true });
  assert.equal(O.gateReasonOf("FAIL_WITH_EVIDENCE").words, "failed, with evidence", "a station's own outcome word");
  assert.equal(O.gateReasonOf("sent-back").words, "with the latest main merged in the tests fail, so the ticket went back to the build station", "merge's code, not the person's word");
  assert.equal(O.gatePositionWords({ state: "failed", reasonCode: "plan-invalid" }), "Refused: the plan did not pass its check");
  assert.equal(O.gatePositionWords({ state: "overridden", reasonCode: "test-passed-first-run" }), "Overridden: a new test passed before any code was written");
  assert.equal(O.gatePositionWords({ state: "failed", reasonCode: "FAIL_WITH_EVIDENCE" }), "Refused: failed, with evidence");
  assert.equal(O.gatePositionWords({ state: "failed", reasonCode: "sent-back", gate: "human-approval" }), "Sent back by a person");
});

test("a code the table does not know is shown as recorded, never dropped or guessed at", () => {
  assert.deepEqual(O.gateReasonOf("lane-merge-commit"), { words: "lane-merge-commit", code: "lane-merge-commit", known: false });
  assert.equal(O.gatePositionWords({ state: "failed", reasonCode: "lane-merge-commit" }), "Refused: lane-merge-commit");
  const decision = O.gateDecisionOf(sim.recordedGate("LOCAL-001", "LOCAL-001/build.join", [evaluation({ gate: "build.join", reasonCode: "lane-merge-commit" })]), null);
  assert.deepEqual(decision.reason, { words: "lane-merge-commit", code: "lane-merge-commit", known: false });
});

test("no reason recorded: the verdict once, and 'No reason was recorded', never 'Refused: refused'", () => {
  // The intent station records `refused` when a command stops without a code of its own (cell.py main).
  for (const code of [null, "", "refused", "REFUSED", "overridden"]) assert.equal(O.gateReasonOf(code), null, String(code));
  assert.equal(O.gatePositionWords({ state: "failed", reasonCode: "refused" }), "Refused");
  assert.equal(O.gatePositionWords({ state: "failed", reasonCode: null }), "Refused");
  const gate = sim.recordedGate("LOCAL-001", "LOCAL-001/plan.replan", [evaluation({ reasonCode: "refused" })]);
  assert.equal(gate.detail, "Refused: refused.", "the gate's own sentence repeats the verdict");
  const decision = O.gateDecisionOf(gate, null);
  assert.equal(decision.reason, "none");
  assert.equal(O.NO_REASON_WORDS, "No reason was recorded");
  assert.equal(decision.detail, null, "the sentence that repeats the verdict is not shown");
  assert.equal(O.evaluationWords(evaluation({ reasonCode: "refused" })), "Refused: no reason was recorded");
});

test("the event's own sentence (Why it looks like this, Evidence) never repeats the verdict as its reason", () => {
  const said = (verdict, reason_code) => sim.describeV3({ type: "gate.evaluated", ids: { ticket_id: "LOCAL-001" }, data: { gate: "plan.replan", verdict, reason_code, subject: null, status: null, audit_tier: null, counts: {} } });
  assert.equal(said("refused", "refused"), "LOCAL-001: gate plan.replan refused.");
  assert.equal(said("passed", "PASS"), "LOCAL-001: gate plan.replan passed.");
  assert.equal(said("refused", "plan-invalid"), "LOCAL-001: gate plan.replan refused (plan-invalid).");
  assert.equal(said("refused", null), "LOCAL-001: gate plan.replan refused.");
});

test("a gate's Decision: the reason of the evaluation that set it, its subject, and the gate's sentence only where it adds something", () => {
  // A gate state set by a lifecycle evaluation: the evaluation's own code (a gate state keeps an older one).
  const planCheck = { gate: "plan-check", state: "failed", reasonCode: "spec-invalid", detail: "Refused: plan-invalid." };
  const set = O.gateDecisionOf(planCheck, evaluation({ gate: "plan.check", reasonCode: "plan-invalid" }));
  assert.equal(set.reason.words, "the plan did not pass its check");
  assert.equal(set.detail, null);
  const green = O.gateDecisionOf({ gate: "red-before-green", state: "failed", reasonCode: "suite-red", detail: "Refused green step for T2: suite-red." }, evaluation({ gate: "build.green", reasonCode: "suite-red", subject: "T2" }));
  assert.deepEqual([green.reason.words, green.subject, green.detail], ["the suite does not pass", "T2", null]);
  // Passed with a recorded reason: said; passed with none: the sentence stands.
  const replan = O.gateDecisionOf(sim.recordedGate("LOCAL-001", "LOCAL-001/plan.replan", [evaluation({ verdict: "passed", reasonCode: "spec-changed" })]), null);
  assert.equal(replan.reason.words, "the slice's spec changed");
  const covered = O.gateDecisionOf({ gate: "plan-check", state: "passed", reasonCode: null, detail: "The plan covers every requirement." }, evaluation({ gate: "plan.check", verdict: "passed" }));
  assert.deepEqual([covered.reason, covered.detail], [null, "The plan covers every requirement."]);
  // Set without a lifecycle evaluation (a review's tally, a person, the simulation): its sentence is its account; no reason is claimed missing.
  const review = O.gateDecisionOf({ gate: "review", state: "failed", reasonCode: null, detail: "REJECTED: 1 approved, 2 needed" }, null);
  assert.deepEqual([review.reason, review.detail], [null, "REJECTED: 1 approved, 2 needed"]);
  // Evaluated more than once: every evaluation, oldest first.
  const twice = O.gateDecisionOf(sim.recordedGate("LOCAL-001", "LOCAL-001/frozen-tests", [evaluation({ gate: "frozen-tests", reasonCode: "frozen-tests", subject: "T3" }), evaluation({ gate: "frozen-tests", verdict: "overridden", reasonCode: "test-amended", subject: "T3", at: 2000 })]), null);
  assert.equal(twice.evaluations.length, 2);
  assert.deepEqual(twice.evaluations.map(O.evaluationWords), ["Refused for T3: the task changes tests that are already committed", "Overridden for T3: a committed test was changed"]);
});

test("every reason code a station writes into its gate record has words", () => {
  const skills = new URL("../../../../skills/", import.meta.url);
  const codes = new Set();
  for (const station of readdirSync(skills)) {
    const dir = join(skills.pathname, station, "scripts");
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".py") && statSync(join(dir, f)).isFile());
    } catch {
      continue;
    }
    for (const f of files) for (const m of readFileSync(join(dir, f), "utf8").matchAll(/"reason_code": "([A-Za-z0-9_.-]+)"/g)) codes.add(m[1]);
  }
  assert.ok(codes.size >= 15, `found ${codes.size}`);
  for (const code of codes) {
    if (code === "refused") assert.equal(O.gateReasonOf(code), null, "only the verdict");
    else assert.ok(O.gateReasonOf(code)?.known, `${code} has words`);
  }
  // Codes written from a value: the audit tier, the verification status, the re-plan's and the join's.
  for (const code of ["gold", "silver", "bronze", "INCOMPLETE_EVIDENCE", "FAIL_WITH_EVIDENCE", "replanned", "lanes-interaction", "landing-failed", "branch-moved"]) assert.ok(O.gateReasonOf(code)?.known, code);
  assert.equal(O.gateReasonOf("PASS"), null, "a pass that only says it passed");
});

// ---------------------------------------------------------------- 4. no note on a shown time's precision

test("no 'Measured to the millisecond' (or any note on how finely a shown time was measured) anywhere in the app", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|mdx?)$/.test(name) && !/README/.test(name)) files.push(p);
    }
  };
  walk(SRC.pathname);
  for (const p of files) {
    // What a person reads: code comments are left out.
    const text = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join("\n");
    assert.doesNotMatch(text, /Measured to the (milli)?second|measured to the (milli)?second/, p);
    assert.doesNotMatch(text, /, measured`|\(measured\)`/, p);
    assert.doesNotMatch(text, /precisionWords/, p);
  }
});

// ---------------------------------------------------------------- 5. the Record section

test("the Record section no longer says 'Measured' beside a start and an end: a time not recorded, or placed, is said once", () => {
  const provenance = src("shell/inspector/Provenance.tsx");
  assert.doesNotMatch(provenance, /\["Start time"|\["End time"|\["Latest record's time"|\["Time", "Simulated"\]/);
  assert.match(provenance, /times \? \["Times", times\] : null/);
  assert.equal(words.recordTimesWords({ start: "measured", end: "measured" }), null, "recorded times need no note");
  assert.equal(words.recordTimesWords({ start: "simulated", end: "simulated" }), null);
  assert.equal(words.recordTimesWords({ start: "unknown", end: "measured" }), "Start not recorded");
  assert.equal(words.recordTimesWords({ start: "measured", end: "unknown" }), "End not recorded, or still open");
  assert.equal(words.recordTimesWords({ start: "inferred", end: "unknown" }), "Start placed by the observer, not measured; end not recorded, or still open");
});

test("the gate's Decision repeats nothing the header shows (name, position, decided time)", () => {
  const anat = src("shell/inspector/anatomies.tsx");
  const gate = anat.slice(anat.indexOf("export function GateAnatomy"), anat.indexOf("function ReasonWords"));
  assert.doesNotMatch(gate, /\["Gate", gateName\(gate\)\]|\["Position"|\["Decided"/);
  assert.match(gate, /reachedEarlier \? \["Reached", at\(gate\.openedAt\)\] : null/);
  assert.match(gate, /\["Reason", decision\.reason === "none" \? NO_REASON_WORDS : <ReasonWords/);
  assert.match(src("shell/inspector/Inspector.tsx"), /word: gatePositionWords\(\{ \.\.\.g, reasonCode: null \}\)/, "the header shows the verdict; the reason is said once, below");
});
