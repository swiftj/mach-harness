// Unit tests for the Design mocks tab (src/features/mocks/model.ts and delivery.ts), against the
// engine's real answers in web/fixtures. Run: pnpm --filter @mach/product-studio test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  WHOLE_SLICE,
  addArguments,
  addAvailability,
  byteWords,
  deliveryState,
  dimensionWords,
  fingerprint,
  kindWords,
  mockAlt,
  mockPurpose,
  purposeOptions,
} from "../src/features/mocks/model.ts";
import { forgetReadyAnswer, readyAnswer, rememberReadyAnswer } from "../src/shared/mocksDelivery.ts";
import { mockPictureUrl } from "../src/api/mockPicture.ts";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}.json`, import.meta.url), "utf8"));
const list = fixture("slice.mock.list").data;
const ready = fixture("slice.ready.with-mocks").data;
const scenarios = [
  { id: "AC-01", title: "Admin invites a colleague" },
  { id: "AC-02", title: "Invite to an outside address is refused" },
];

test("each picture is described from the engine's facts alone", () => {
  const [binding, whole] = list.mocks;
  assert.equal(mockPurpose(binding, scenarios), "AC-01: Admin invites a colleague");
  assert.equal(mockPurpose(whole, scenarios), "The whole slice");
  assert.equal(mockPurpose({ for: "AC-09" }, scenarios), "AC-09", "a scenario no longer in the spec shows its ID only");
  assert.equal(fingerprint(binding.sha256), "d3a67710b6bc");
  assert.equal(kindWords(binding.format), "PNG picture");
  assert.equal(kindWords(whole.format), "JPEG picture");
  assert.equal(dimensionWords(binding), "4 × 3 pixels");
  assert.equal(byteWords(binding.bytes), "69 bytes");
  assert.equal(byteWords(1), "1 byte");
  assert.equal(byteWords(12 * 1024), "12 KB");
  assert.equal(byteWords(Math.round(1.4 * 1024 * 1024)), "1.4 MB");
  assert.equal(byteWords(5 * 1024 * 1024), "5 MB");
});

test("the scenario choice offers the whole slice first, then the slice's own scenarios", () => {
  assert.deepEqual(
    purposeOptions(scenarios).map((o) => o.value),
    [WHOLE_SLICE, "AC-01", "AC-02"],
  );
  assert.deepEqual(purposeOptions([]), [{ value: WHOLE_SLICE, label: "The whole slice" }]);
});

test("binding is sent only with a scenario; an empty note is left out", () => {
  assert.deepEqual(addArguments({ purpose: WHOLE_SLICE, binding: true, note: "  " }), {});
  assert.deepEqual(addArguments({ purpose: "AC-01", binding: false, note: "" }), { for: "AC-01" });
  assert.deepEqual(addArguments({ purpose: "AC-01", binding: true, note: " The invite form " }), { for: "AC-01", binding: true, note: "The invite form" });
});

test("adding: available below the engine's limit, full at it, locked when the slice cannot change", () => {
  assert.equal(addAvailability(fixture("slice.mock.list.empty").data.mocks.length, list.limit, true), "available");
  assert.equal(addAvailability(list.mocks.length, list.limit, true), "available");
  const four = fixture("slice.show.four-mocks").data;
  assert.equal(addAvailability(four.slice.mocks.length, list.limit, four.editable), "full", "a work order with four pictures, the engine's limit");
  assert.equal(addAvailability(1, list.limit, false), "locked");
});

const github = (progress, saved = "github") => ({ saved, progress });

test("each picture's alternative text says what it is for, from the slice's own record", () => {
  const four = fixture("slice.show.four-mocks").data.slice.mocks;
  assert.deepEqual(
    four.map((m) => mockAlt(m, scenarios)),
    [
      "Design mock for the whole slice. After sending",
      "Binding design mock for scenario AC-01: Admin invites a colleague. The invite form",
      "Design mock for the whole slice. When the address is wrong",
      "Design mock for the whole slice",
    ],
  );
});

test("a picture changed in the workspace carries the engine's problem, and only the host's own address is asked for", () => {
  const changed = fixture("slice.mock.list.problem").data;
  assert.deepEqual(changed.mocks.map((m) => m.problem), ["its SHA-256 is not the approved one", null, null, null]);
  const sha = changed.mocks[1].sha256;
  assert.equal(mockPictureUrl("SLICE-001", sha), `/api/slices/SLICE-001/mocks/${sha}`);
  assert.equal(mockPictureUrl("SLICE-001", sha.slice(0, 12)), null);
  assert.equal(mockPictureUrl("SLICE-001", sha.toUpperCase()), null);
  assert.equal(mockPictureUrl("../SLICE-001", sha), null);
});

test("a draft never waits for its pictures", () => {
  assert.deepEqual(deliveryState({ status: "draft", github: github("draft", null), mockCount: 2, toCommit: ready.mocks }), { kind: "none" });
});

test("marked ready on GitHub with the engine's answer: waiting, with the engine's own folder and note", () => {
  const state = deliveryState({ status: ready.slice.status, github: github("ready_to_build"), mockCount: ready.slice.mocks.length, toCommit: ready.mocks });
  assert.equal(state.kind, "waiting");
  assert.equal(state.toCommit.commit_as, "product/ready/SLICE-001/mocks/");
  assert.match(state.toCommit.note, /The builders hold SLICE-001/);
});

test("marked ready on GitHub, answer not in this window: still waiting, without a folder", () => {
  assert.deepEqual(deliveryState({ status: "approved_for_engineering", github: github("ready_to_build"), mockCount: 1, toCommit: null }), { kind: "waiting", toCommit: null });
});

test("no waiting once the builders have the slice, without pictures, or when saved to the folder", () => {
  for (const progress of ["being_built", "question", "shipped"]) {
    assert.deepEqual(deliveryState({ status: "approved_for_engineering", github: github(progress), mockCount: 1, toCommit: ready.mocks }), { kind: "none" }, progress);
  }
  assert.deepEqual(deliveryState({ status: "approved_for_engineering", github: github("ready_to_build"), mockCount: 0, toCommit: null }), { kind: "none" });
  assert.deepEqual(deliveryState({ status: "approved_for_engineering", github: github("ready_to_build", "folder"), mockCount: 2, toCommit: null }), { kind: "none" });
});

test("the ready answer is kept in memory for the slice it names, and forgotten on request", () => {
  rememberReadyAnswer(ready);
  assert.equal(readyAnswer("SLICE-001")?.folder, ready.mocks.folder);
  assert.equal(readyAnswer("SLICE-002"), null);
  rememberReadyAnswer({ ...ready, mocks: null });
  assert.equal(readyAnswer("SLICE-001"), null, "marked ready again without pictures clears it");
  rememberReadyAnswer(ready);
  forgetReadyAnswer("SLICE-001");
  assert.equal(readyAnswer("SLICE-001"), null);
});

test("the engine's refusals are kept as written for the dialog", () => {
  assert.match(fixture("slice.mock.add.refused-not-a-picture").refused, /^notes\.png cannot be a design mock/);
  assert.match(fixture("slice.mock.add.refused-ready").refused, /reopen it first/);
});
