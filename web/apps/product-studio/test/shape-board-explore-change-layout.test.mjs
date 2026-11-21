// The M16 layout on Shape's ideas board, Explore and Change what exists (docs/mach-next/M16_LAYOUT.md): each is a work
// screen whose page does not scroll, its long parts scroll inside their own regions, and the conversation keeps its
// newest turn in view by scrolling its own pane, never the page. Reads the screens' sources: the behaviour itself is
// checked by capture in the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../src/features/shape/${path}`, import.meta.url), "utf8");
const layout = readFileSync(new URL("../src/shared/layout/WorkScreen.tsx", import.meta.url), "utf8");

test("the ideas board: a work screen, the add act in the context row, the columns in one region that scrolls inside itself", () => {
  const board = read("ideas/IdeasBoardScreen.tsx");
  assert.match(board, /<WorkScreen header=\{header\(addButton\(false\)/, "the add act is in the context row");
  assert.doesNotMatch(board, /ScreenFrame/);
  assert.match(board, /<WorkBoard label="Ideas board"/, "one labelled region, the shared board area");
  // The shared board area: a labelled region that scrolls on its own and is a tab stop while it has more to show.
  assert.match(layout, /export function WorkBoard[\s\S]*?<ScrollRegion as="section" label=\{label\}/);
  assert.match(layout, /export function ScrollRegion[\s\S]*?tabIndex=\{edges\.more \? 0 : undefined\}[\s\S]*?overflow-auto/);
  assert.match(board, /sticky top-0/, "each column's heading and count stay in view");
  assert.doesNotMatch(board, /<Disclosure/, "disclosures are the layout's Fold");
});

test("Explore: two panes, the source and each group of lookups folded with its count, the newest turn kept in view", () => {
  const screen = read("explore/ExploreScreen.tsx");
  assert.match(screen, /layout="panes"/);
  assert.match(screen, /<WorkPane label="The conversation" header=\{<ConversationHeader/, "the heading and the conversation's acts stay at the top of its pane");
  assert.match(screen, /<WorkPane side label="Where this idea came from and what MACH looked up">/);
  const looked = read("explore/LookedUp.tsx");
  assert.match(looked, /<Fold boxed heading=\{3\}/, "each folded group keeps its heading");
  assert.match(looked, /group\.entries\.length/, "the count is the engine's entries, not a figure of the app's own");
  assert.match(read("explore/IdeaSource.tsx"), /<Fold label=/, "someone else's words are folded, never dropped");
  const conversation = read("explore/Conversation.tsx");
  assert.match(conversation, /closest<HTMLElement>\("\[data-pane\]"\)/, "it scrolls its own pane");
  assert.doesNotMatch(conversation, /scrollIntoView|window\.scroll/, "never the page");
  assert.ok(conversation.indexOf("<ExploreTranscript") < conversation.indexOf("<Current "), "oldest first, what is asked now last");
  assert.doesNotMatch(read("explore/ExploreTranscript.tsx"), /<details/, "disclosures are the layout's Fold");
});

test("Change what exists: one pane, the form first and the rule and its connections under it", () => {
  const change = read("route/ChangeScreen.tsx");
  assert.doesNotMatch(change, /ScreenFrame/);
  assert.match(change, /<WorkPane label="Start an idea from this rule">\s*<div[^>]*>\s*<StartSection/);
  assert.doesNotMatch(change, /<WorkPane side/, "no second pane just to fill space");
  assert.ok(change.indexOf("<StartSection") < change.indexOf('id="rule-heading"'), "the act first, the rule under it");
  assert.match(change, /"idea\.change"/, "the act is unchanged");
  assert.match(change, /<ConfirmDialog/, "and still confirmed");
});
