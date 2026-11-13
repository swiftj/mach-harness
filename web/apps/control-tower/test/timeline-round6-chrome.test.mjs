// Round 6, the chrome's defects (docs/mach-next/M6_3_COMPLETION.md, section 5): 11 the table's Track
// column and bounded times; 12 the "Factory is not enabled" notice over the stage; 15 raw words in the
// inspector (a station's outcome code, a reviewer as a hex id, a picked span's raw id, "between 0 ms
// and"); 16 the 32 Tab stops before the tracks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./_load.mjs";

const notices = await import("../src/shell/notices.ts");
const M = await import("../src/timeline/inspector/model.ts");
const words = await import("../src/shell/inspector/words.ts");
const skip = await import("../src/timeline/a11y/skip.ts");
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

// ---------------------------------------------------------------- 11. the table

test("11: a track's label is never shrunk for its note or detail; only a label longer than the column is cut, in its details", () => {
  const t = src("timeline/a11y/TimelineTable.tsx");
  assert.match(t, /"min-w-0 flex-1 basis-0 truncate text-caption text-ink-subtle"/, "the note or detail takes only the room the label leaves");
  assert.doesNotMatch(t, /shrink-\[4\] truncate text-caption/, "no longer competing with the label for room");
});

test("11: an end known between two times is drawn as a range on two short lines, said in full; never 'between … and' wrapped", () => {
  const t = src("timeline/a11y/TimelineTable.tsx");
  assert.match(t, /return <BoundedMoment lo=\{end\.notBefore\} hi=\{end\.notAfter\} \/>;/);
  assert.match(t, /whitespace-nowrap font-mono text-\[11px\] leading-\[13px\]/);
  assert.match(t, /between \{spokenTime\(lo\)\} and \{spokenTime\(hi\)\}/, "a screen reader hears both bounds");
  assert.doesNotMatch(t, /between <Moment/, "the old wrapping sentence is gone");
});

// ---------------------------------------------------------------- 12. the Factory's state in the chrome

const live = { source: "live", connection: { state: "live" }, empty: false, settled: true, notice: null, observer: "answered" };

test("12: the Factory not enabled is the top bar's chip, never a notice over the stage; its words are unchanged", () => {
  const n = notices.noticesFor({ ...live, factory: { factoryPresent: true, enabled: false, paused: false } });
  assert.equal(n.stage, null, "nothing covers the Atlas or the Blueprint");
  assert.equal(n.chip.key, "disabled");
  assert.equal(n.chip.chip, "Factory not enabled");
  assert.equal(n.chip.title, "The Factory is not enabled on this machine");
  assert.match(n.chip.body, /Enabling it is an engineer's decision taken outside the Control Tower, which has no control to start, pause, schedule or approve anything\./);
});

test("12: paused is a chip too; a chip never hides an empty or failing stage's notice", () => {
  assert.equal(notices.noticesFor({ ...live, factory: { factoryPresent: true, enabled: true, paused: true } }).chip.key, "paused");
  const empty = notices.noticesFor({ ...live, empty: true, factory: { factoryPresent: true, enabled: false } });
  assert.equal(empty.stage.key, "empty", "an empty stage still says so");
  assert.equal(empty.chip.key, "disabled");
  const stale = notices.noticesFor({ ...live, connection: { state: "stale", staleSince: null, attempts: 0 }, factory: { factoryPresent: true, enabled: false } });
  assert.equal(stale.stage.key, "stale-stale");
  assert.equal(stale.chip.key, "disabled");
  const noFactory = notices.noticesFor({ ...live, factory: { factoryPresent: false, enabled: false } });
  assert.equal(noFactory.stage.key, "no-factory");
  assert.equal(noFactory.chip, null, "no .factory folder: nothing to be enabled");
});

test("12: in the top bar the run's name gives way last, after the history's start", () => {
  const c = src("shell/chrome.tsx");
  assert.match(c, /<h1 className="max-w-\[45%\] shrink-0 truncate font-sans/);
  assert.match(c, /hidden min-w-0 truncate text-caption text-ink-subtle min-\[1360px\]:inline/);
});

test("12: replay and the simulation show no Factory chip", () => {
  assert.equal(notices.noticesFor({ ...live, source: "replay", factory: { factoryPresent: true, enabled: false } }).chip, null);
  assert.equal(notices.noticesFor({ ...live, source: "simulation", factory: { factoryPresent: true, enabled: false } }).chip, null);
});

test("12: the chip sits in the top bar, opens the whole notice, and the stage notice skips it", () => {
  const shell = src("shell/Shell.tsx");
  assert.match(shell, /<CompletenessBadge \/>\s*<FactoryStateChip \/>/);
  const badge = src("shell/SourceBadge.tsx");
  assert.match(badge, /const n = useNotices\(\)\.chip;/);
  assert.match(badge, /aria-label=\{`\$\{n\.title\}\. Details`\}/);
  assert.match(badge, /aria-describedby=\{bodyId\}/, "a screen reader hears the whole notice from the chip");
  assert.match(badge, /return useNotices\(\)\.stage;/);
});

// ---------------------------------------------------------------- 15. plain words

test("15: a station's outcome code is said in plain words where it is a state; other words are left as they are", () => {
  assert.equal(M.outcomeStateWords("FAIL_WITH_EVIDENCE"), "Failed, with evidence");
  assert.equal(M.outcomeStateWords("AWAITING_HUMAN"), "Review approved; waiting for a person's approval");
  assert.equal(M.outcomeStateWords("REJECT"), "Reject");
  assert.equal(M.outcomeStateWords("spec-ready"), "Spec-ready");
  const visit = { station: "verify", leftAt: 10, outcome: "failed", outcomeWord: "FAIL_WITH_EVIDENCE", unclosed: null };
  assert.equal(M.visitStateWords(visit), "Failed, with evidence");
  assert.equal(M.visitStateWords({ ...visit, leftAt: null }), "Working");
  assert.equal(M.visitStateWords({ ...visit, outcomeWord: null, outcome: "passed" }), "Passed");
});

test("15: the inspector's header, a visit's State and a station's visit list use the plain words; the record is still quoted", () => {
  const ins = src("shell/inspector/Inspector.tsx");
  assert.match(ins, /word: last \? visitStateWords\(last\) : "Not visited"/);
  assert.match(ins, /word: visitStateWords\(v\), phase/);
  const an = src("shell/inspector/anatomies.tsx");
  assert.match(an, /\["State", visitStateWords\(visit\)\]/);
  assert.match(an, /\["The station said", visit\.outcomeWord \? <Mono key="o">\{visit\.outcomeWord\}<\/Mono>/, "the raw word stays where the record is quoted");
  assert.doesNotMatch(an, /round\.outcome\?\.toLowerCase\(\)\.replace\("_", " "\)/, "'awaiting human' is no longer made by hand");
});

test("15: a reviewer is named by its seat and model, its agent id a quiet second line", () => {
  assert.equal(words.seatModelName("opus"), "Claude Opus 5.5");
  assert.equal(words.seatModelName("claude-next"), "claude-next", "a model the vocabulary does not know, as recorded");
  assert.equal(words.seatModelName(null), null);
  assert.equal(words.reviewerWords("security", "Claude Opus 5.5"), "The security seat's reviewer, on Claude Opus 5.5");
  assert.equal(words.reviewerWords("product", null), "The product seat's reviewer");
  const an = src("shell/inspector/anatomies.tsx");
  assert.match(an, /\["Reviewer", seat\.agentId \? <ReviewerWords key="r" seat=\{seat\} \/> : "not seen"\]/);
  assert.match(an, /\["Vote", seat\.vote \? outcomeStateWords\(seat\.vote\) : "not yet"\]/);
});

test("15: a span picked through an ancestor names its raw id on its own quiet line, never in the sentence", () => {
  const sentence = words.pickedThroughWords("gate:LOCAL-001/required:human-approval#1", "Cell");
  assert.doesNotMatch(sentence, /gate:/);
  assert.match(sentence, /^You picked a wait on a person on the Timeline\./);
  const ins = src("shell/inspector/Inspector.tsx");
  assert.match(ins, /<span className="mt-1 block font-mono text-\[11px\] text-ink-subtle \[overflow-wrap:anywhere\]" title="The span's record id">/);
});

test("15: a duration bounded from nothing reads 'up to', never 'between 0 ms and'", () => {
  const s = { id: "w", kind: "workflow", entity: "workflow:x/1", parent: null, ids: {}, start: { eventId: "a", at: 0, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: null }, end: { eventId: "b", at: 11_220_000, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: "completed" }, duration: { ms: null, minMs: 0, maxMs: 11_220_000, basis: "bounded" }, outcome: null, authority: "observed", attrs: {} };
  assert.equal(M.durationSentence(s, 20_000_000).text, "up to 3 h 7 min");
  assert.equal(M.durationSentence({ ...s, duration: { ...s.duration, minMs: 60_000 } }, 20_000_000).text, "between 1 min and 3 h 7 min");
});

// ---------------------------------------------------------------- 16. a route to the tracks

const stub = (present) => ({ querySelector: (sel) => (present.includes(sel) ? { sel, focus() { this.focused = true; } } : null) });

test("16: 'Skip to the tracks' goes to the canvas, else the table's focusable row, else the table", () => {
  const [canvas, row, grid] = skip.TRACKS_TARGETS;
  assert.equal(skip.tracksFocusTarget(stub([canvas, row, grid])).sel, canvas);
  assert.equal(skip.tracksFocusTarget(stub([row, grid])).sel, row);
  assert.equal(skip.tracksFocusTarget(stub([grid])).sel, grid);
  assert.equal(skip.tracksFocusTarget(stub([])), null);
});

test("16: with nothing drawn yet it falls back to the stage", () => {
  const stage = { focused: false, focus() { this.focused = true; } };
  assert.equal(skip.focusTracks(stub([]), stage), false);
  assert.equal(stage.focused, true);
  assert.equal(skip.focusTracks(stub([skip.TRACKS_TARGETS[0]]), stage), true);
});

test("16: the skip link is the page's second Tab stop while the Timeline is up, and only then", () => {
  const shell = src("shell/Shell.tsx");
  const first = shell.indexOf('{onFloor ? "Skip to the factory view" : "Skip to the timeline"}');
  const second = shell.indexOf("Skip to the tracks");
  const header = shell.indexOf("<header");
  assert.ok(first > 0 && second > first && header > second, "both skip links come before the header");
  assert.match(shell, /\{onFloor \? null : \(\s*<a\s+href="#stage"\s+data-skip-tracks=""/);
  assert.match(shell, /focusTracks\(document, document\.getElementById\("stage"\)\)/);
});

test("15: a gate refused with a station's outcome code says it in plain words; other reason codes stay as recorded", () => {
  assert.equal(M.gatePositionWords({ state: "failed", reasonCode: "FAIL_WITH_EVIDENCE" }), "Refused: failed, with evidence");
  assert.equal(M.gatePositionWords({ state: "failed", reasonCode: "findings-invalid" }), "Refused: findings-invalid");
  assert.equal(M.gatePositionWords({ state: "passed", reasonCode: null }), "Passed");
  for (const f of ["shell/inspector/Inspector.tsx", "shell/inspector/anatomies.tsx"]) assert.doesNotMatch(src(f), /gateStateWords\(/, `${f} uses gatePositionWords`);
});

test("15: a span's headline says a station's outcome in words; a wait closed by a record says so", () => {
  const s = { id: "v", kind: "visit", entity: "visit:T/verify#1", parent: null, ids: {}, start: { eventId: "a", at: 0, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: null }, end: { eventId: "b", at: 60_000, precision: "ms", notBefore: null, notAfter: null, basis: "recorded", rule: null, reason: "failed" }, duration: { ms: 60_000, minMs: 60_000, maxMs: 60_000, basis: "measured" }, outcome: "FAIL_WITH_EVIDENCE", authority: "authoritative", attrs: {} };
  const h = M.spanHeadline(s, 120_000, (t) => `t${t}`);
  assert.match(h, / — failed, with evidence, t0–t60000$/);
  assert.doesNotMatch(h, /fail_with_evidence/i);
  assert.deepEqual(M.outcomeWordsOf("work.claimed"), { words: "closed by a work.claimed record", own: null });
  assert.deepEqual(M.outcomeWordsOf("spec-ready"), { words: "spec-ready", own: null });
});
