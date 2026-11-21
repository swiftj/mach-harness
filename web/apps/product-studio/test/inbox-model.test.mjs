// Unit tests for what the Decisions screen's groups say while closed, and which group opens
// (src/features/inbox/model.ts), and the project home's folded criteria (src/features/home/model.ts).
// Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { namesInLine, openGroup, questionsSummary, requestsSummary, sliceGroupSummary } from "../src/features/inbox/model.ts";
import { doneWhenLabel } from "../src/features/home/model.ts";

test("names in a line: one, two, and more than two", () => {
  assert.equal(namesInLine([]), "");
  assert.equal(namesInLine(["Remove a teammate"]), "Remove a teammate");
  assert.equal(namesInLine(["Invite", "Rename"]), "Invite and Rename");
  assert.equal(namesInLine(["Invite", "Rename", "Resend", "Remove"]), "Invite, Rename and 2 more");
});

test("a group of slices says how many and which", () => {
  assert.equal(sliceGroupSummary(["Remove a teammate"]), "1 slice: Remove a teammate");
  assert.equal(sliceGroupSummary(["Invite", "Rename", "Resend"]), "3 slices: Invite, Rename and 1 more");
  assert.equal(sliceGroupSummary([]), "Nothing waiting");
});

test("open questions count the questions, not the slices", () => {
  assert.equal(questionsSummary([{ title: "Invite a teammate by email", open_questions: 2 }]), "2 open questions on Invite a teammate by email");
  assert.equal(
    questionsSummary([
      { title: "A", open_questions: 1 },
      { title: "B", open_questions: 0 },
    ]),
    "1 open question on A and B",
  );
  assert.equal(questionsSummary([]), "Nothing waiting");
});

test("requests: how many, and how many can be picked up; not read yet is said, never zero", () => {
  assert.equal(requestsSummary(7, 3), "7 requests, 3 you can pick up");
  assert.equal(requestsSummary(1, 0), "1 request, none to pick up");
  assert.equal(requestsSummary(0, 0), "No open requests");
  assert.equal(requestsSummary(null, 0), "Not read yet");
});

test("the most urgent group opens on arrival; the person's choice holds while its group exists", () => {
  const ids = ["builders", "approvals", "requests"];
  assert.equal(openGroup(ids, undefined), "builders");
  assert.equal(openGroup(ids, "requests"), "requests");
  assert.equal(openGroup(ids, null), null, "closed by the person stays closed");
  assert.equal(openGroup(["approvals", "requests"], "builders"), "approvals", "a group that emptied gives way to the most urgent");
  assert.equal(openGroup([], undefined), null);
});

test("an epic's criteria fold behind their count", () => {
  assert.equal(doneWhenLabel(1), "Done when: 1 criterion");
  assert.equal(doneWhenLabel(2), "Done when: 2 criteria");
});
