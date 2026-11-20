// Unit tests for showing a request filed in the idea template (src/features/inbox/requests/model.ts),
// against the engine's real answers in web/fixtures. Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ideaSections, questionsToAskFirst, unfence } from "../src/features/inbox/requests/model.ts";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8"));

test("a request in the idea template shows the engine's five parts, in order, each unfenced", () => {
  const { request } = fixture("request.show.idea").data;
  const sections = ideaSections(request.idea);
  assert.deepEqual(
    sections.map((s) => s.heading),
    ["Problem", "Proposed outcome", "Affected users and systems", "Constraints", "Open questions"],
  );
  assert.equal(sections[0].text, "Admins email support to bring a colleague in, and wait a day.");
  assert.equal(sections[3].text, "Only people in the company may be added.\nNot part of this idea: removing people.");
  assert.ok(sections.every((s) => !s.text.includes("REQUEST-DATA")), "no fence marker is shown");
});

test("a request not in the template shows as before: no parts", () => {
  const { request } = fixture("request.show.plain").data;
  assert.equal(ideaSections(request.idea), null);
  assert.equal(ideaSections(undefined), null);
  assert.equal(ideaSections({ parts: [], open_questions: 0, note: "" }), null);
});

test("a part whose fence is broken is not shown as text", () => {
  const sections = ideaSections({ parts: [{ part: "problem", heading: "Problem", fenced: "plain text, not fenced" }] });
  assert.deepEqual(sections, [{ part: "problem", heading: "Problem", text: null }]);
});

test("the list marks a request filed in the template", () => {
  const items = fixture("request.list.idea").data.requests.items;
  assert.deepEqual(
    items.map((i) => [i.number, i.idea_template === true]),
    [
      [42, false],
      [43, true],
    ],
  );
});

test("starting a slice from an idea carries its questions to ask first, unfenced", () => {
  const { request } = fixture("request.pick.idea").data;
  const q = questionsToAskFirst(request.questions_to_ask_first);
  assert.equal(q.count, 2);
  assert.equal(q.text, "- Should the colleague have to accept?\n- Is there a limit on team size?");
  assert.equal(questionsToAskFirst(fixture("slice.resume.idea-request").data.request?.questions_to_ask_first)?.count, 2);
});

test("no questions to ask first without any, or with a broken fence", () => {
  assert.equal(questionsToAskFirst(undefined), null);
  assert.equal(questionsToAskFirst({ count: 0, fenced: "" }), null);
  assert.equal(questionsToAskFirst({ count: 1, fenced: "- unfenced" }), null);
  assert.equal(unfence("- unfenced"), null);
});
