// The M16 layout keeps what must stay equal, equal, and folds nothing a person must act on
// (docs/mach-next/M16_LAYOUT.md, 2.5 and 6). Reads the screens' sources; the same is checked in the running app by the
// capture pass and the e2e suites. The verdict's and the look back's own equal-weight tests are in
// shape-case-model.test.mjs and shape-lookback.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
/** The source between the first `from` and the next `to` after it. */
const between = (text, from, to) => {
  const a = text.indexOf(from);
  assert.ok(a >= 0, `missing: ${from}`);
  const b = text.indexOf(to, a + from.length);
  return text.slice(a, b < 0 ? undefined : b);
};

test("accepting a policy concern has the same weight as changing the specification, and nothing is chosen for the person", () => {
  const page = src("features/policies/SlicePoliciesScreen.tsx");
  const acts = between(page, "<Link to={`/slices/${sliceId}/interview`}>Change the specification</Link>", "</div>");
  assert.match(acts, /<AcceptConcernDialog/);
  const change = between(page, '<Button asChild variant="secondary">\n                <Link to={`/slices/${sliceId}/interview`}>Change the specification', "</Button>");
  assert.match(change, /variant="secondary"/);
  const dialog = src("features/policies/AcceptConcernDialog.tsx");
  assert.match(dialog, /<Button variant="secondary">Record the owner&apos;s acceptance<\/Button>/, "the opener is secondary, like its neighbour");
  assert.doesNotMatch(dialog, /defaultChecked|defaultValue=\{?["'`][^"'`]/, "no answer is filled in for the person");
});

test("the verdict choices and the look-back results each come from one list with one look", () => {
  const verdict = src("features/shape/case/VerdictSection.tsx");
  assert.equal((verdict.match(/verdictChoices\.map/g) ?? []).length, 1);
  assert.doesNotMatch(verdict, /defaultChecked|autoFocus/);
  const record = src("features/shape/lookback/RecordItem.tsx");
  assert.doesNotMatch(record, /defaultChecked|defaultValue=\{?["'`]/);
  assert.match(record, /resultChoices\[/, "the three results come from the model's list");
});

test("an open policy concern is never inside a part or a fold", () => {
  const page = src("features/policies/SlicePoliciesScreen.tsx");
  const concerns = between(page, '<section aria-labelledby="open-concerns-title"', "</section>");
  assert.doesNotMatch(concerns, /<Fold|<Part\b/);
  assert.ok(page.indexOf('aria-labelledby="open-concerns-title"') < page.indexOf("<Parts"), "above the rows");
});

test("a malformed pack's reasons stay in view under its row, open or closed", () => {
  const page = src("features/policies/PoliciesScreen.tsx");
  assert.match(page, /attention=\{row\.problems\.length \? <PackProblems row=\{row\} \/> : undefined\}/);
  const parts = src("shared/layout/Parts.tsx");
  // The attention slot is drawn outside the part's body, which is the only thing a closed part hides.
  const item = between(parts, "<li ", "</li>");
  assert.ok(item.indexOf("{attention ?") < item.indexOf("hidden={!open}"), "drawn before, and outside, the hidden body");
  assert.doesNotMatch(between(page, "function PackProblems", "\n}\n"), /<Fold/);
});

test("a refused Jira row is listed in the open, never folded", () => {
  const keys = src("features/jira/KeysBack.tsx");
  const refused = between(keys, "summary.refused.length > 0 ?", "</Group>");
  assert.doesNotMatch(refused, /<Fold/);
  assert.doesNotMatch(between(keys, "function Group(", "\n}\n"), /<Fold|hidden=/);
});

test("the notice that a slice waits for its pictures to be committed is never folded; only the file names are", () => {
  const panel = src("shared/MocksToCommit.tsx");
  const folds = panel.match(/<Fold\s[^>]*>/g) ?? [];
  assert.equal(folds.length, 1);
  assert.match(folds[0], /File names/);
  assert.ok(panel.indexOf("Waiting for its pictures to be committed") < panel.indexOf("<Fold label"));
  const mocks = src("features/mocks/SliceMocksScreen.tsx");
  assert.doesNotMatch(between(mocks, 'delivery.kind === "waiting" ? <MocksToCommitPanel', "\n"), /<Fold/);
});

test("a stale verdict's warning is in the open; only the old verdict's reason folds", () => {
  const verdict = src("features/shape/case/VerdictSection.tsx");
  const stale = between(verdict, "if (stale)", "  return (\n    <div");
  assert.ok(stale.indexOf('<Banner tone="warning" title="This verdict no longer holds">') < stale.indexOf("<Fold"), "the banner comes first, outside the fold");
  assert.match(src("features/shape/case/model.ts"), /no longer holds/, "and the closed part's summary says so too");
});

test("a map's blockers are a banner above the parts, never folded", () => {
  const route = src("features/shape/route/RouteScreen.tsx");
  assert.ok(route.indexOf("<MapBlockers") < route.indexOf("<Parts"), "above the parts");
  assert.doesNotMatch(between(src("features/shape/route/TheMap.tsx"), "export function MapBlockers", "\n}\n"), /<Fold|<Part\b/);
});
