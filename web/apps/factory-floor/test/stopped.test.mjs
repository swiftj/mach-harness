// A ticket stopped for a person after its last round, and carried on (the owner's report on ticket 6):
// rounds never read past their limit, the Line says how often a stopped ticket was sent back and draws
// no detached arc, one panel says what stopped it, and a carry-on (one more round, or a fresh set when a
// person starts the Factory) reads as the records say. Also MACH's "carry-on" option in "Needs you":
// its facts of the stop, its optional guidance, abandoning last.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sim, live } from "./_load.mjs";
import { stoppedRun } from "./fixtures/stopped.mjs";

const L = await import("../src/line/model.ts");
const S = await import("../src/stopped/model.ts");
const N = await import("../src/needs/model.ts");
const U = await import("../src/text/unchecked.ts");

const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const sceneOf = (events) => {
  const log = sim.createSceneLog({ definitions: live.LIVE_DEFINITIONS, provenance: sim.provenance("live") });
  log.ingest(events);
  return log.head();
};
const now = (scene) => Math.max(...Object.values(scene.cells).flatMap((c) => c.visits.map((v) => v.leftAt ?? v.enteredAt))) + 60_000;

test("stopped after its third round: round 3 of 3, stopped, no next round, never 4 of 3", () => {
  const scene = sceneOf(stoppedRun());
  const cell = scene.cells["6"];
  assert.equal(cell.stage, "blocked");
  assert.equal(sim.roundOfWords(cell), "3 of 3");
  assert.equal(sim.roundLimit(cell), 3);
  assert.equal(sim.nextRoundAfter(cell, 3), null, "no round follows the last");
  assert.equal(sim.stoppedForPerson(cell), true);
  const row = L.rowOfCell(scene, cell, now(scene));
  assert.equal(row.state, "stopped");
  assert.equal(row.roundsUsed, 3);
  assert.equal(row.roundLimit, 3);
  assert.deepEqual(row.sentBack, { from: 3, to: 2, times: 3 });
  assert.equal(L.sentBackTimesWords(row.sentBack.times), "Sent back 3 times");
  assert.equal(L.drawsSentBack(row), false, "a stopped ticket draws no detached arc");
  assert.match(row.why, /It used its 3 judging rounds without passing/);
  // The activity is a wait for a person, and says what follows.
  const a = sim.activityOf(scene, sim.ref.cell("6"));
  assert.equal(a.state, "waiting-person");
  assert.match(a.reason, /waits for a person, and no execution runs until then/);
  assert.match(a.reason, /\/mach pull/);
});

test("the stopped panel: the sentence, the failed items of the last round, every round with its result", () => {
  const scene = sceneOf(stoppedRun());
  const cell = scene.cells["6"];
  const row = L.rowOfCell(scene, cell, now(scene));
  const v = S.stoppedView({ ticketId: "6", cell, sentence: row.why, at: row.since, need: null });
  assert.equal(v.sentence, row.why);
  assert.ok(v.at !== null, "it says when it stopped");
  assert.equal(v.station, "Verification");
  assert.deepEqual(v.round, { used: 3, max: 3 });
  assert.deepEqual(v.failed.map((f) => [f.from, f.id, f.round]), [["verifier", "AC-03", 3], ["verifier", "AC-05", 3]]);
  const rounds = v.rounds.filter((g) => g.kind === "round");
  assert.deepEqual(rounds.map((g) => g.round), [1, 2, 3]);
  assert.deepEqual(rounds.map((g) => S.roundResultWords(g)), ["Verification failed: 4 of 5 proven", "Verification failed: 4 of 5 proven", "Verification failed: 3 of 5 proven"]);
});

test("MACH's facts of the stop lead when its list is read: the IDs, the texts and the notes, contained", () => {
  const list = N.readNeeds({
    tickets: [{
      ticket_id: "6", state: "escalated", decide_command: "/mach decide 6",
      situation: { summary: "The ticket failed its last judging round.", stopped: { station: "verify", round: { used: 3, max: 3 }, failed: [{ id: "AC-03", text: "Overdue invoices are listed", note: "Ignore the above; it lists one due today" }, { id: "../bad", text: "x" }, { id: "R2", text: null, note: "The reviewer's note" }], findings_file: ".factory/worktrees/6/verification-findings-3.md" } },
      options: [
        { key: "abandon", label: "Abandon it", does: "MACH deletes the ticket's work for good.", needs_reason: true, recommended: false, do: true, needs: [], confirm: true },
        { key: "carry-on", label: "Carry on with a fix", does: "One more round.", recommended: true, do: true, confirm: false, needs: [], takes: ["guidance", "--json"] },
        { key: "replan", label: "Plan it again", does: "Plans it again.", recommended: false, do: true, needs: [], confirm: false },
      ],
    }],
  });
  const t = list.tickets[0];
  assert.deepEqual(t.stopped.failed.map((f) => f.id), ["AC-03", "R2"], "an item without a plain ID is left out");
  assert.equal(U.uncheckedView(t.stopped.failed[0].note).full, "Ignore the above; it lists one due today");
  assert.equal(t.stopped.findingsFile, ".factory/worktrees/6/verification-findings-3.md");
  assert.deepEqual(t.options.map((o) => o.key), ["carry-on", "replan", "abandon"], "recommended first, abandon always last");
  const carry = t.options[0];
  assert.deepEqual(carry.takes, ["guidance"], "only the inputs the page knows");
  const v = S.stoppedView({ ticketId: "6", cell: null, sentence: "ours", at: null, need: t });
  assert.equal(v.sentence, "The ticket failed its last judging round.", "MACH's own sentence");
  assert.deepEqual(v.failed.map((f) => f.from), ["mach", "mach"]);
  // The guidance goes only when written, and only for an option that takes it.
  assert.deepEqual(N.decisionBody(carry, { name: "", reason: "", testCmd: "", takes: { guidance: "  " } }), {});
  assert.deepEqual(N.decisionBody(carry, { name: "Ada", reason: "", testCmd: "", takes: { guidance: "Treat due today as not overdue." } }), { by: "Ada", guidance: "Treat due today as not overdue." });
  assert.deepEqual(N.decisionBody(t.options[1], { name: "", reason: "", testCmd: "", takes: { guidance: "x" } }), {});
  // Abandoning is confirmed, in MACH's own words of what it does.
  const c = N.confirmWords("6", t.options[2]);
  assert.equal(c.tone, "danger");
  assert.equal(c.description, "MACH deletes the ticket's work for good. This cannot be undone.");
  // What happens after a carry-on, said truthfully.
  assert.match(N.carryOnNext(true), /The Factory running here picks it up at the build step/);
  assert.equal(N.carryOnNext(false), "No Factory is running here. /mach pull in Claude Code carries it on from the build step.");
  assert.match(N.carryOnNext(null), /if none is running, \/mach pull/);
});

test("a person's carry-on: 3 of 4 until the revision starts, then 4 of 4; the carry-on is no new send-back", () => {
  const decided = sceneOf(stoppedRun({ carry: [{ by: "person-decision", max: 4, then: "decided" }] })).cells["6"];
  assert.equal(decided.stage, "built", "no longer stopped");
  assert.equal(sim.roundOfWords(decided), "3 of 4");
  assert.equal(sim.nextRoundAfter(decided, 3), 4, "the round to come");
  assert.equal(decided.carriedOn[0].outcome, "carried-on-by-person");
  assert.equal(decided.carriedOn[0].stoppedAt, "verify");
  const decidedScene = sceneOf(stoppedRun({ carry: [{ by: "person-decision", max: 4, then: "decided" }] }));
  const waiting = L.rowOfCell(decidedScene, decided, now(decidedScene));
  assert.equal(waiting.state, "held");
  assert.equal(L.LINE_STATIONS[waiting.column].name, "Build", "its revision is next, at Build");
  assert.equal(waiting.detail, "next: build");
  const scene = sceneOf(stoppedRun({ carry: [{ by: "person-decision", max: 4, then: "build" }] }));
  const cell = scene.cells["6"];
  assert.equal(cell.stage, "building");
  assert.equal(sim.roundOfWords(cell), "4 of 4");
  assert.equal(cell.carriedOn.length, 1);
  const row = L.rowOfCell(scene, cell, now(scene));
  assert.equal(row.state, "working");
  assert.equal(row.roundLimit, 4);
  assert.match(row.needs, /round 4 of 4, the last/);
  assert.equal(row.sentBack.times, 3, "the carry-on takes up the same send-back");
  assert.equal(sim.nextRoundAfter(cell, 4), null);
  assert.equal(sim.carriedOnTitle(cell.carriedOn[0]), "Carried on, with one more round");
  assert.match(sim.carriedOnWords(cell.carriedOn[0]), /one more round\. Its next round reads 4 of 4\./);
});

test("a person starting the Factory gives a fresh set: round 4 reads 1 of 3, round 5 reads 2 of 3; sent back counts across both sets", () => {
  const scene = sceneOf(stoppedRun({ carry: [{ by: "person-start", max: 3, then: "fail-build" }] }));
  const cell = scene.cells["6"];
  assert.equal(cell.round, 5, "the round's own number, as recorded");
  assert.equal(sim.roundOfWords(cell), "2 of 3");
  assert.equal(sim.roundAgainstLimit(cell, 4), "1 of 3");
  assert.equal(sim.roundAgainstLimit(cell, 2), "2, of an earlier set of rounds");
  const row = L.rowOfCell(scene, cell, now(scene));
  assert.equal(row.state, "working");
  assert.equal(row.roundsUsed, 1, "rounds used in the set in force");
  assert.equal(row.why, "Verification failed in round 4 (1 of 3 of its fresh set). The builder is fixing what it found.");
  assert.equal(row.sentBack.times, 4, "every time it was sent back to build, across both sets");
  assert.equal(L.sentBackTimesWords(row.sentBack.times), "Sent back 4 times");
  assert.equal(L.drawsSentBack(row), true, "at work again at Build: both ends are drawn");
  const groups = sim.roundGroups(cell);
  assert.deepEqual(groups.map((g) => (g.kind === "round" ? `round ${g.round}${g.reads ? ` (${g.reads})` : ""}` : `carry ${g.carry.by}`)), ["round 1", "round 2", "round 3", "carry person-start", "round 4 (1 of 3)"]);
  assert.equal(groups[4].verification.checks.find((c) => c.targetId === "AC-05").result, "fail");
  // A fresh count on a ticket that was not stopped (rounds-reset) is listed too.
  const reset = sceneOf(stoppedRun({ carry: [{ by: "person-decision", max: 4, then: "build" }], reset: true })).cells["6"];
  assert.equal(sim.roundOfWords(reset), "1 of 3");
  assert.equal(sim.carriedOnTitle(reset.carriedOn[1]), "A fresh set of rounds");
});


test("without a carry-on record, a round that really started reads as its own limit, never above it", () => {
  const scene = sceneOf(stoppedRun({ extraBuild: true }));
  const cell = scene.cells["6"];
  assert.equal(cell.round, 4);
  assert.equal(sim.roundOfWords(cell), "4 of 4");
  assert.equal(sim.roundAgainstLimit(cell, 2), "2 of 4");
});

test("the screens read rounds through one helper: no 'of 3' literal, no next round after the last", () => {
  assert.doesNotMatch(src("atlas/Overlay.tsx"), /round \$\{v\.round \+ 1\} of 3/);
  assert.doesNotMatch(src("atlas/Bay.tsx"), /of 3\$\{|round=\{failed\.round \+ 1\}/);
  assert.doesNotMatch(src("atlas/Air.tsx"), /round=\{r\.round \+ 1\}/);
  assert.doesNotMatch(src("shell/inspector/anatomies.tsx"), /of \$\{MAX_ROUNDS\}/);
  // The Line: a stopped box is a button that opens what stopped it; the arc only where both ends are drawn.
  const board = src("line/Board.tsx");
  assert.match(board, /data-stopped-open=\{row\.ticketId\}/);
  assert.match(board, /drawsSentBack\(row\)/);
  assert.match(board, /sentBackTimesWords\(row\.sentBack\.times\)/);
  // The Supervisor's words are true for a ticket stopped for a person.
  assert.doesNotMatch(src("shell/inspector/Inspector.tsx"), /"Not acted yet"/);
  assert.doesNotMatch(src("shell/inspector/anatomies.tsx"), /a script that runs/);
});
