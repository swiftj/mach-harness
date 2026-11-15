// M6.6 I-05: prose the observer has not checked for names (R1) is contained in the floor and Timeline
// inspectors exactly as in Analytics: one shared UncheckedText (src/text/), the session's display
// policy available outside analytics/, and a source guard that fails if an inspector prints a policy
// field any other way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import "./_load.mjs";

const F = await import("../src/text/fields.ts");
const U = await import("../src/text/unchecked.ts");
const D = await import("../src/analytics/data/index.ts");

const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("the known field list is the observer's own (redact.FreeTextFields), field for field", () => {
  const go = readFileSync(new URL("../../../../apps/observer/internal/redact/freetext.go", import.meta.url), "utf8");
  const block = go.slice(go.indexOf("var FreeTextFields"), go.indexOf("}\n", go.indexOf("var FreeTextFields")) + 1);
  const fromGo = [...block.matchAll(/\{"([^"]+)", "([^"]+)", (\d+)\}/g)].map(([, kind, path, max]) => ({ kind, path, max: Number(max) }));
  assert.ok(fromGo.length >= 15, "parsed the Go list");
  assert.deepEqual([...F.KNOWN_FREE_TEXT_FIELDS].map((f) => ({ ...f })), fromGo);
});

test("one UncheckedText: Analytics re-exports the shared module; no copy is left in analytics/", () => {
  assert.equal(existsSync(new URL("../src/analytics/data/UncheckedText.tsx", import.meta.url)), false);
  assert.equal(D.unchecked, U.unchecked);
  assert.equal(D.uncheckedView, U.uncheckedView);
  assert.equal(D.readDisplayPolicy, U.readDisplayPolicy);
  const component = src("text/UncheckedText.tsx");
  assert.match(component, /from "\.\/unchecked"/);
  // C1: never a title or an aria-label from the words.
  assert.doesNotMatch(component, /title=|aria-label=/);
});

test("the policy fails closed: undeclared contains every known field; a declared one may add fields and lower limits, never lift them", () => {
  assert.equal(F.freeTextFieldsOf(null), F.KNOWN_FREE_TEXT_FIELDS);
  assert.equal(F.freeTextFieldsOf(U.UNDECLARED_POLICY), F.KNOWN_FREE_TEXT_FIELDS);
  assert.equal(F.freeTextMax(null, "review.finding", "data.title"), 200);
  assert.equal(F.freeTextMax(null, ["agent.queued", "agent.started"], "data.label"), 120);
  assert.equal(F.freeTextMax(null, "made.up", "data.x"), U.DEFAULT_UNCHECKED_MAX);
  const policy = U.readDisplayPolicy({
    display_policy: { people: "role", free_text: { checked_for_names: false, note: "free text, not checked for names", event_fields: [
      { kind: "review.finding", path: "data.title", max: 80 },
      { kind: "human.required", path: "data.reason", max: 9999 },
      { kind: "new.kind", path: "data.words", max: 50 },
    ] } },
  });
  assert.equal(F.freeTextMax(policy, "review.finding", "data.title"), 80, "lowered");
  assert.equal(F.freeTextMax(policy, "human.required", "data.reason"), 280, "never lifted");
  assert.equal(F.freeTextMax(policy, "new.kind", "data.words"), 50, "added");
  assert.ok(F.kindHasFreeText(policy, "new.kind"));
  assert.ok(F.kindHasFreeText(null, "scheduling.decided"));
  assert.ok(!F.kindHasFreeText(null, "station.entered"));
});

test("valuesAt reads the policy's paths, arrays included; freeTextDataKeys names the data keys never printed raw", () => {
  const e = { type: "scheduling.decided", data: { held: [{ slice_id: "S-1", why: "waits for a person" }, { why: "" }], reasons: ["a", "b"], title: "T" } };
  assert.deepEqual(F.valuesAt(e, "data.held[].why"), ["waits for a person"]);
  assert.deepEqual(F.valuesAt(e, "data.reasons[]"), ["a", "b"]);
  assert.deepEqual(F.valuesAt(e, "data.title"), ["T"]);
  assert.deepEqual(F.valuesAt(e, "data.nothing[].x"), []);
  assert.deepEqual([...F.freeTextDataKeys(null, "review.finding")], ["title"]);
  assert.deepEqual([...F.freeTextDataKeys(null, "execution.completed")], ["waiting_for", "refused_tools"]);
  assert.deepEqual([...F.freeTextDataKeys(null, "station.entered")], []);
});

test("containField: an opaque value at the field's limit, a placeholder wherever it is turned into a string", () => {
  const long = "x".repeat(500);
  const t = F.containField(null, "review.finding", "data.title", long);
  assert.equal(t.max, 200);
  assert.equal(`${t}`, "[free text]");
  assert.equal(JSON.stringify({ t }), '{"t":"[free text]"}');
  const v = U.uncheckedView(t);
  assert.equal(Array.from(v.shown).length, 200);
  assert.ok(v.truncated);
  assert.equal(v.note, "free text, not checked for names");
  assert.equal(F.containField(null, "review.finding", "data.title", "  "), null);
});

// ---------------------------------------------------------------- the source guard

// The inspector files (floor and Timeline): every anatomy, the header, the evidence list, the run at the playhead, "In time".
const INSPECTOR_FILES = ["shell/inspector/anatomies.tsx", "shell/inspector/Inspector.tsx", "shell/inspector/parts.tsx", "shell/inspector/RunNow.tsx", "shell/inspector/Provenance.tsx", "timeline/inspector/InTimeSection.tsx"];

// How the scene names each policy field (text/fields.ts KNOWN_FREE_TEXT_FIELDS, through the reducers).
const POLICY_READS = [
  [/\bfinding\.title\b/, "review.finding data.title"],
  [/\b(?:agent|writer|parent|queued)\.label\b/, "agent.* data.label"],
  [/\b(?:agent|execution|queued)\.phase\b/, "agent.* data.phase"],
  [/\b(?:execution|workflow)\.phases\b/, "workflow.phases_declared data.phases[].title"],
  [/\.reasons\b/, "dependency.blocked data.reasons[]"],
  [/\b(?:attention|a)\.reason\b/, "human.required data.reason / intake.refused data.problems[]"],
  [/\bh\.why\b/, "scheduling.decided data.held[].why"],
  [/\bwaitingFor\b/, "execution.completed data.waiting_for"],
  [/\bwaitedOn\b/, "a wait's reasons (dependency.blocked / human.required)"],
  [/\bidentity\.name\b/, "an agent's name is its label"],
  [/\bmoment\.text\b|\bchapter\.title\b/, "an event's sentence quoting prose"],
];

// A read that does not print: a test, a count, an assignment, a key, a prop handed to FreeText.
const NOT_PRINTED = [/text=\{[^}]*$/, /^\s*(?:const|let)\s/, /^\s*\/\//, /^\s*\*/, /^\s*\/\*/];
const IS_TEST_OR_PROP = (line, index, length) => {
  const after = line.slice(index + length);
  const before = line.slice(0, index);
  return (
    // a test or a count
    /^(?:\s*\?|\s*&&|\s*!==|\s*===|\.length|\[0\]\s*\?|\s*\|\|)/.test(after) ||
    // handed to a contained component (FreeText's text, DeclaredPhases' phases, WaitedOn's reasons), or a FreeText field's own name
    /(?:text|phases|reasons)=\{[^}]*$/.test(before) ||
    /field="$/.test(before)
  );
};

// A list whose items are each printed through FreeText on the next lines: `{slice.reasons.map((r) => (` then `<FreeText … text={r}`.
const MAPPED_INTO_FREE_TEXT = (lines, i, index, length) => /^\.map\(/.test(lines[i].slice(index + length)) && lines.slice(i + 1, i + 5).some((l) => /<FreeText\b/.test(l));

// Reviewed exceptions: a read that is not the prose itself.
const ALLOWED = [
  // The header names any entity; only an agent's name is its label, and that branch goes through FreeText on the same line.
  ["shell/inspector/Inspector.tsx", /proseName\(kindOf\(entity\)\) && !identity\.name\.endsWith\(refId\(entity\)\) \? <FreeText field=\{proseName\(kindOf\(entity\)\)!\} text=\{identity\.name\} \/> : identity\.name/],
];

/** Every place a file prints a policy field outside FreeText / KindWords / EventWords: [file:line, field, text]. */
export function unguardedPrints(file, text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (NOT_PRINTED.some((r) => r.test(line))) return;
    if (ALLOWED.some(([f, r]) => f === file && r.test(line))) return;
    for (const [pattern, field] of POLICY_READS) {
      const g = new RegExp(pattern.source, "g");
      for (const m of line.matchAll(g)) {
        // a test whose "?" or "&&" begins the next line
        const testOnNextLine = line.slice(m.index + m[0].length).trim() === "" && /^\s*(?:\?|&&)/.test(lines[i + 1] ?? "");
        if (testOnNextLine || IS_TEST_OR_PROP(line, m.index, m[0].length) || MAPPED_INTO_FREE_TEXT(lines, i, m.index, m[0].length)) continue;
        out.push([`${file}:${i + 1}`, field, line.trim()]);
      }
    }
  });
  return out;
}

test("guard: no inspector anatomy prints a free-text policy field outside the contained component", () => {
  const found = INSPECTOR_FILES.flatMap((f) => unguardedPrints(f, src(f)));
  assert.deepEqual(found, [], `printed raw:\n${found.map((x) => x.join("  ")).join("\n")}`);
  // describeEntry quotes prose; only FreeText.tsx (EventWords) may call it in an inspector.
  for (const f of INSPECTOR_FILES) assert.doesNotMatch(src(f), /describeEntry\(/, f);
});

test("guard: the guard bites (the M6.5 inspectors, before I-05, are caught)", () => {
  // The anatomy as M6.5 left it: the finding title and the execution's waiting_for printed raw.
  const before = [
    '      <span className="text-ink-muted">{finding.seat}:</span> {finding.title}',
    '          <blockquote className="text-body text-ink">{finding.title}</blockquote>',
    '            execution.outcome ? ["Outcome", `${execution.outcome.stage ?? "?"}, next ${execution.outcome.next}${execution.outcome.waitingFor ? `, waiting for ${execution.outcome.waitingFor}` : ""}`] : null,',
    '                <span className="font-mono text-[12px]">{id}</span> {a.reason}',
    '      {word} <span className="text-ink-subtle">{agent.label}</span>',
  ].join("\n");
  const found = unguardedPrints("before.tsx", before).map(([, field]) => field);
  assert.ok(found.includes("review.finding data.title"));
  assert.ok(found.includes("execution.completed data.waiting_for"));
  assert.ok(found.some((f) => f.startsWith("human.required")));
  assert.ok(found.includes("agent.* data.label"));
});

test("the contained component is used for every policy field kind the inspectors show", () => {
  const free = src("shell/inspector/FreeText.tsx");
  const table = src("text/fields.ts");
  for (const field of ["findingTitle", "agentLabel", "agentPhase", "declaredPhase", "waitReason", "personNeeded", "heldWhy", "waitingFor"]) assert.match(table, new RegExp(`\\b${field}:`), field);
  assert.match(free, /from "\.\.\/\.\.\/text\/UncheckedText"/);
  assert.match(free, /useDisplayPolicy/);
  const all = INSPECTOR_FILES.map(src).join("\n");
  for (const field of ["findingTitle", "agentLabel", "waitReason", "personNeeded", "heldWhy", "waitingFor"]) assert.match(all, new RegExp(`field="${field}"`), field);
});

test("the session's policy is read outside analytics/: one shared hook over the client's /session", () => {
  const hook = src("shell/displayPolicy.ts");
  assert.match(hook, /client\.displayPolicy\(\)/);
  assert.match(hook, /readDisplayPolicy/);
  assert.match(hook, /UNDECLARED_POLICY/);
});

// ---------------------------------------------------------------- the whole floor, the Timeline and the shell

import { readdirSync, statSync } from "node:fs";

const ROOTS = ["blueprint", "atlas", "shell", "timeline"];
const walk = (dir) =>
  readdirSync(new URL(`../src/${dir}`, import.meta.url)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    const st = statSync(new URL(`../src/${rel}`, import.meta.url));
    if (st.isDirectory()) return walk(rel);
    return /\.tsx?$/.test(name) ? [rel] : [];
  });
const ALL_FILES = ROOTS.flatMap(walk);

// Scene and span copies of the policy's fields, as the drawing code reads them.
const PROSE_READS = [
  [/\b(?:finding|f|b|blocker)\.title\b/, "review.finding data.title"],
  [/\b(?:slice|sl|cell|lane\.slice|track)\.title\b/, "slice.materialized data.title (a slice's or cell's title)"],
  [/\brefused\.(?:join|map)\b/, "execution.completed data.refused_tools[]"],
  [/\b(?:agent|a\.agent|writer)\.label\b/, "agent.* data.label"],
  [/\battrs\.label\b/, "agent.* data.label (a span's copy)"],
  [/\b(?:agent|a\.agent)\.phase\b/, "agent.* data.phase"],
  [/\b(?:execution|workflow|x)\.phases\b/, "workflow.phases_declared data.phases[].title"],
  [/\bwaitingFor\b/, "execution.completed data.waiting_for"],
  [/(?<!\))\.reasons\b(?!\.length)/, "dependency.blocked data.reasons[]"],
  [/\b(?:attention|a)\.reason\b/, "human.required data.reason"],
  [/\b(?:h|hold|held)\.why\b/, "scheduling.decided data.held[].why"],
  [/\.authorization\b/, "work.scheduled data.authorization"],
  [/\.effect\b/, "revision.superseded data.effect"],
];

// Where a read is contained or not printed at all.
const CONTAINED = /containedWords\(|<FreeText\b|<KindWords\b|<EventWords\b|codesOnlyWords\(|containField\(|text=\{/;
const NOT_A_PRINT = (after) => /^(?:\s*=(?!=)|\s*\?|\s*&&|\s*!==|\s*===|\s*\|\||\.length|\[0\]\s*\?|\.includes|\.indexOf|\s*\)\s*\?)/.test(after);
// A string that names something to assistive technology or in a hover: codes and counts only, even contained.
const NAMING = /aria-label=|\btitle=|\btitle:\s*`?[^,]*$|\blabel=\{|\bname:\s*`|\bname=\{|\bname:\s*[a-z]/;

// Reviewed exceptions: a read that is a copy into data, not a print or a name.
const CONTAINMENT_ALLOWED = [
  // A stand-in slice record for a cell with no slice: a data field, printed later through containedWords.
  ["blueprint/tree.ts", /s = \{ id: cell\.sliceId \|\| cell\.ticketId, title: cell\.title,/],
  // A selector's value, printed by the row through FreeText.
  ["shell/inspector/RunNow.tsx", /return isKnown\(cell\.meta, "title"\) \? cell\.title : \(s\.slices\[cell\.sliceId\]\?\.title \?\? ""\);/],
  // The identity's name: shown only in the inspector's heading, through FreeText (Inspector.tsx).
  ["shell/inspector/entity.ts", /name: (?:sl && sl\.title && isKnown\(sl\.meta, "title"\) \? sl\.title|c && isKnown\(c\.meta, "title"\) \? c\.title)/],
];

/** [file:line, field, kind, line]: a policy field printed outside the contained path, or in a name. */
export function containmentOffenders(file, text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (/^(?:\/\/|\*|\/\*|import )/.test(trimmed)) return;
    if (CONTAINMENT_ALLOWED.some(([f, r]) => f === file && r.test(line))) return;
    for (const [pattern, field] of PROSE_READS) {
      for (const m of line.matchAll(new RegExp(pattern.source, "g"))) {
        const after = line.slice(m.index + m[0].length);
        const before = line.slice(0, m.index);
        if (NOT_A_PRINT(after)) continue;
        if (/field="$|kind: \[|\breadonly\b|^\s*(?:readonly\s+)?\w+\??:/.test(before) || /^\s*[:?]?\s*(?:readonly\s)?[\w\s|<>[\],.]*;\s*$/.test(after)) continue; // a type or a key
        if (/^\s*$/.test(after) && /^\s*(?:\?|&&)/.test(lines[i + 1] ?? "")) continue;
        // Handed to a contained component (FreeText's text, DeclaredPhases' phases, WaitedOn's reasons), tested, or mapped into FreeText.
        if (/(?:text|phases|reasons|tools)=\{[^}]*$|Boolean\([\w?.]*$|\bif \([\w?.!\s&|="]*$/.test(before)) continue;
        if (/^\.map\(/.test(after) && lines.slice(i + 1, i + 5).some((l) => /<FreeText\b/.test(l))) continue;
        // An assignment is checked where its value is printed, unless it builds a sentence around the prose itself.
        const inTemplate = before.lastIndexOf("${") > before.lastIndexOf("}");
        if (/^\s*(?:const|let)\s+\w+\s*=/.test(line) && !NAMING.test(line) && !(inTemplate && !CONTAINED.test(before.slice(before.lastIndexOf("${"))))) continue;
        if (NAMING.test(before) && !/>\s*$/.test(before)) {
          out.push([`${file}:${i + 1}`, field, "named (aria-label, title, label or name)", trimmed.slice(0, 160)]);
          continue;
        }
        if (CONTAINED.test(before.slice(-120))) continue;
        out.push([`${file}:${i + 1}`, field, "printed raw", trimmed.slice(0, 160)]);
      }
    }
  });
  return out;
}

test("guard: blueprint, atlas, shell and timeline print the policy's free text only through the shared containment, and never name with it", () => {
  assert.ok(ALL_FILES.length > 60, `scanned ${ALL_FILES.length} files`);
  const found = ALL_FILES.flatMap((f) => containmentOffenders(f, src(f)));
  assert.deepEqual(found, [], `\n${found.map((x) => x.join("  ")).join("\n")}`);
});

test("guard: the containment guard bites (the M6.5 Blueprint, Atlas and Timeline lines are caught)", () => {
  const before = [
    '    <g style={{ opacity: p }} role="note" aria-label={`Outvoted ${seat} blocker ${rule ?? ""}: ${f.title}`}>',
    '  const waiting = x.outcome?.waitingFor && x.outcome.waitingFor !== "nothing" ? `, waiting for ${x.outcome.waitingFor}` : "";',
    '          <Hit key={f.id} entity={ref.finding(f.id)} label={`Note, from the ${f.seat} seat: ${f.title}`}>',
    "        {clip(slice.reasons[0], 90)}",
    '      return { ref: a.ref, trackId: track.id, title: a.agent.label, detail: "" };',
  ].join("\n");
  const kinds = containmentOffenders("before.tsx", before).map(([, field, kind]) => `${field} ${kind}`);
  assert.ok(kinds.some((k) => k.startsWith("review.finding") && k.includes("named")));
  assert.ok(kinds.some((k) => k.startsWith("execution.completed") && k.includes("raw")));
  assert.ok(kinds.some((k) => k.startsWith("dependency.blocked")));
  assert.ok(kinds.some((k) => k.startsWith("agent.*")));
});

test("drawing code reads the session's policy (not only the known list): the shell sets it once /session answers", () => {
  const F2 = F;
  const policy = U.readDisplayPolicy({ display_policy: { free_text: { checked_for_names: false, event_fields: [{ kind: "review.finding", path: "data.title", max: 10 }] } } });
  F2.setSessionPolicy(policy);
  try {
    assert.equal(F2.containedWords("findingTitle", "a".repeat(50)).length, 10);
    assert.equal(F2.codesOnlyWords("station.entered"), null);
    assert.match(F2.codesOnlyWords("human.required", "SYN-001"), /^A person is needed \(SYN-001\)\. Its words are free text/);
  } finally {
    F2.setSessionPolicy(null);
  }
  assert.equal(F2.containedWords("findingTitle", "a".repeat(500)).length, 200, "fails closed to the known limit");
  assert.match(src("shell/displayPolicy.ts"), /setSessionPolicy\(p\)/);
  assert.match(src("shell/Shell.tsx"), /data-free-text-panel-note/);
});

test("a sentence is treated as quoting prose only when it carries one of its event's prose values", () => {
  const held = { type: "scheduling.decided", data: { held: [{ slice_id: "S-1", why: "waits for a free place: 1 of 1 in use" }] } };
  assert.equal(F.eventQuotesFreeText(held, null), true, "the event holds prose");
  assert.equal(F.eventQuotesFreeText(held, null, "scheduling decided for the Factory."), false, "a sentence that counts, not quotes");
  assert.equal(F.eventQuotesFreeText(held, null, "S-1 held: waits for a free place: 1 of 1 in use"), true);
  assert.equal(F.eventQuotesFreeText({ type: "execution.completed", data: { waiting_for: null } }, null), false);
  assert.match(src("shell/history.ts"), /eventQuotesFreeText\(entry\.event, undefined, title\)/);
  assert.match(src("shell/inspector/FreeText.tsx"), /quotesFreeText\(policy, entry, words\)/);
});
