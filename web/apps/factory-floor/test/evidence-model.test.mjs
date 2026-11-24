// M6.4: the evidence player (docs/mach-next/M6_4_EVIDENCE_PLAYER.md sections 3, 4 and 6). The client's
// new calls (a cell's evidence, served text with its headers, refusals as reason codes, one retry on
// 503), the player's model (grouping by run, the failed filter, stepping across files and checks, every
// withheld state and its words, the integrity banner, what is requested and when, media off, the
// simulation's own content), the scene-id to catalog-id mapping, and the address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { live, sim } from "./_load.mjs";

const M = await import("../src/evidence/model.ts");
const H = await import("../src/shell/source/hash.ts");
const { createSceneStore } = await import("../src/scene/store.ts");
const { manualClock } = await import("../src/scene/clock.ts");

const T = "LOCAL-101";
const id = (n) => `a${String(n).padStart(24, "0")}`;
const at = (ms) => ({ at: new Date(ms).toISOString(), precision: "exact", event_id: `e${ms}`, pos: ms, authority: "authoritative" });
const T0 = Date.UTC(2026, 10, 16, 9, 0, 0);

/** A `/cells/{t}/evidence` reply: two verification runs, every kind of file state. */
function reply({ media = true } = {}) {
  const art = (n, path, more = {}) => ({
    id: id(n), ref: `artifact:${T}:${path}`, logical: `artifact:${T}:${path}`, ticket_id: T, origin: "cell", path_rel: path, kind: "evidence", nature: "evidence",
    media_type: "text/plain; charset=utf-8", bytes: 2048, sha256: `s${n}`, recorded_sha256: `s${n}`, integrity: "match", targets: [], round: 1, commit: "0123456789abcdef0123", content_access: "text", free_text: false, free_text_note: null, ...more,
  });
  return {
    ticket_id: T,
    artifacts: [
      art(1, "evidence/ac-01.png", { media_type: "image/png", content_access: media ? "media" : "media-disabled", targets: [{ id: "AC-01", kind: "scenario", result: "fail" }] }),
      art(2, "evidence/flow.webm", { media_type: "video/webm", content_access: media ? "media" : "media-disabled" }),
      art(3, "evidence/r1.json", { media_type: "application/json", free_text: true, free_text_note: "free text, not checked for names", targets: [{ id: "R1" }, { id: "R2" }] }),
      art(4, "evidence/api-token.txt", { content_access: "none", access_reason: "its name says it holds credentials; its content is never served" }),
      art(5, "evidence/huge.log", { content_access: "none", access_reason: "the file is larger than the observer reads (64 MB at most); it is listed, not hashed or served" }),
      art(6, "evidence/trace.zip", { media_type: "application/octet-stream", content_access: "none", access_reason: "its contents are not a type the observer serves (application/octet-stream)" }),
      art(7, "evidence/ac-01.png", { round: 2, media_type: "image/png", content_access: media ? "media" : "media-disabled", origin: "cell" }),
      art(8, "evidence/r2.txt", { round: 2 }),
    ],
    checks: [
      { target_id: "AC-01", target_kind: "scenario", result: "fail", round: 1, visit_id: `${T}/verify#1`, at: at(T0 + 1000), evidence: [
        { file: "evidence/ac-01.png", sha256: "s1", artifact_id: id(1), integrity: "match", content_access: media ? "media" : "media-disabled" },
        { file: "evidence/flow.webm", sha256: "s2", artifact_id: id(2), integrity: "match", content_access: media ? "media" : "media-disabled" },
      ] },
      { target_id: "R1", target_kind: "matrix rule", result: "pass", round: 1, visit_id: `${T}/verify#1`, at: at(T0 + 2000), evidence: [
        { file: "evidence/r1.json", sha256: "s3", artifact_id: id(3), integrity: "match", content_access: "text" },
        { file: "evidence/api-token.txt", sha256: "s4", artifact_id: id(4), integrity: "match", content_access: "none" },
        { file: "evidence/huge.log", sha256: "s5", artifact_id: id(5), integrity: "unchecked", content_access: "none" },
        { file: "evidence/trace.zip", sha256: "s6", artifact_id: id(6), integrity: "match", content_access: "none" },
        { file: "evidence/gone.txt", sha256: "s9", artifact_id: null, integrity: "missing" },
      ] },
      { target_id: "H-1", target_kind: "holdout", result: "pass", round: 1, visit_id: `${T}/verify#1`, at: at(T0 + 3000), evidence: [] },
      { target_id: "AC-01", target_kind: "scenario", result: "pass", round: 2, visit_id: `${T}/verify#2`, at: at(T0 + 60_000), evidence: [
        { file: "evidence/ac-01.png", sha256: "s7", artifact_id: id(7), integrity: "match", content_access: media ? "media" : "media-disabled" },
      ] },
      { target_id: "R2", target_kind: "matrix rule", result: "pass", round: 2, visit_id: `${T}/verify#2`, at: at(T0 + 61_000), evidence: [
        { file: "evidence/r2.txt", sha256: "older", artifact_id: id(8), integrity: "mismatch", content_access: "text" },
      ] },
    ],
    settings: { evidence_media: media, source: ".factory/config.json" },
    cursor: "g.42",
    note: "verified evidence is a file results.json names with a matching hash; prose is written by an agent and is never proof",
  };
}

const model = (opts = {}) => M.buildLiveModel(live.readCellEvidence(reply(opts), T), { ...opts });

// ---------------------------------------------------------------- the client

test("client: /cells/{t}/evidence is read with every field the player needs; the catalog entry keeps targets, access_reason and origin", async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return { status: 200, json: async () => ({ ok: true, data: reply() }) };
  };
  const client = live.createObserverClient({ fetch });
  const ev = await client.cellEvidence(T);
  assert.deepEqual(urls, [`/api/v1/cells/${T}/evidence`]);
  assert.equal(ev.ticketId, T);
  assert.equal(ev.evidenceMedia, true);
  assert.equal(ev.checks.length, 5);
  assert.deepEqual(ev.checks[0].evidence[0], { file: "evidence/ac-01.png", sha256: "s1", artifactId: id(1), integrity: "match", contentAccess: "media" });
  assert.equal(ev.checks[0].at.atMs, T0 + 1000);
  assert.equal(ev.checks[1].evidence[4].artifactId, null);
  const a = ev.artifacts[0];
  assert.equal(a.origin, "cell");
  assert.deepEqual(a.targets, [{ id: "AC-01", kind: "scenario", result: "fail" }]);
  assert.equal(ev.artifacts[3].accessReason, "its name says it holds credentials; its content is never served");
  assert.equal(ev.artifacts[0].recordedSha256, "s1");
  assert.equal(live.readArtifactEntry({ id: "x", origin: "somewhere" }).origin, null, "an unknown origin is not passed on");
});

test("client: the session says whether media is served (capabilities.evidence_media)", async () => {
  for (const [value, want] of [[true, true], [false, false], [undefined, null]]) {
    const fetch = async () => ({ status: 200, json: async () => ({ ok: true, data: { generation: "g", capabilities: value === undefined ? {} : { evidence_media: value } } }) });
    assert.equal((await live.createObserverClient({ fetch }).session()).evidenceMedia, want);
  }
});

test("client: content URLs are made from catalog ids only; a path or prose never reaches a request", async () => {
  const client = live.createObserverClient({ fetch: async () => assert.fail("no request") });
  assert.equal(client.artifactContentUrl(id(1)), `/api/v1/artifacts/${id(1)}/content`);
  for (const bad of ["evidence/ac-01.png", "../../etc/passwd", "a123", `${id(1)}?download=1`, "A0000000000000000000000001", ""]) {
    assert.equal(client.artifactContentUrl(bad), null, bad);
    assert.deepEqual(await client.artifactText(bad), { ok: false, reason: "invalid", status: 0, retried: false });
  }
});

const textReply = (status, { body = "", headers = {}, json = null } = {}) => ({
  status,
  headers: { get: (h) => Object.entries(headers).find(([k]) => k.toLowerCase() === h.toLowerCase())?.[1] ?? null },
  text: async () => body,
  json: async () => json ?? { ok: false, error: { kind: "refused", message: "no" } },
});

test("client: served text comes with its headers (truncated, free text, redactions, evidence match), as plain text", async () => {
  const fetch = async () => textReply(200, { body: "<b>not markup</b>\n[link](http://x)\n", headers: { "X-MACH-Truncated": "true", "X-MACH-Free-Text": "unchecked-for-names", "X-MACH-Redacted": "3", "X-MACH-Evidence-Match": "match" } });
  const r = await live.createObserverClient({ fetch }).artifactText(id(3));
  assert.equal(r.ok, true);
  assert.equal(r.text, "<b>not markup</b>\n[link](http://x)\n", "the words as served, untouched");
  assert.deepEqual(r.labels, { freeText: true, redacted: 3, truncated: true, evidenceMatch: "match" });
  const plain = await live.createObserverClient({ fetch: async () => textReply(200, { body: "x" }) }).artifactText(id(3));
  assert.deepEqual(plain.labels, { freeText: false, redacted: null, truncated: false, evidenceMatch: null });
});

test("client: every refusal of the content route becomes its reason code", async () => {
  const refuse = (status, reason) => textReply(status, { json: { ok: false, error: { kind: "refused", message: "m", ...(reason ? { reason } : {}) } } });
  const cases = [
    [refuse(403, "credential-name"), "credential-name"],
    [refuse(403, "media-disabled"), "media-disabled"],
    [refuse(403, "link"), "link"],
    [refuse(413, "too-large"), "too-large"],
    [refuse(409, "changed"), "changed"],
    [refuse(409, "duplicate"), "duplicate"],
    [refuse(415, "type"), "type"],
    [refuse(404), "not-found"],
    [refuse(401), "unauthorized"],
    [refuse(415), "type"],
    [refuse(403, "something-new"), "refused"],
  ];
  for (const [response, want] of cases) {
    const r = await live.createObserverClient({ fetch: async () => response }).artifactText(id(1));
    assert.equal(r.ok, false);
    assert.equal(r.reason, want, `${response.status} → ${want}`);
    assert.equal(r.retried, false);
  }
  const down = await live.createObserverClient({ fetch: async () => Promise.reject(new Error("offline")) }).artifactText(id(1));
  assert.deepEqual(down, { ok: false, reason: "network", status: 0, retried: false });
  for (const code of ["credential-name", "media-disabled", "link", "too-large", "changed", "duplicate", "type", "unavailable", "not-found", "unauthorized", "network", "invalid", "refused", "missing", "not-catalogued"]) {
    assert.ok(M.reasonWords(code).length > 20, code);
  }
});

test("client: a busy observer (503) is asked again once after its Retry-After, then the player says so", async () => {
  const slept = [];
  const sleep = async (ms) => void slept.push(ms);
  let calls = 0;
  const busyOnce = async () => (++calls === 1 ? textReply(503, { headers: { "Retry-After": "1" }, json: { ok: false, error: { kind: "unavailable", message: "busy" } } }) : textReply(200, { body: "ok" }));
  const r1 = await live.createObserverClient({ fetch: busyOnce, sleep }).artifactText(id(1));
  assert.equal(r1.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(slept, [1000]);
  calls = 0;
  const alwaysBusy = async () => (++calls, textReply(503, { headers: { "Retry-After": "1" }, json: { ok: false, error: { kind: "unavailable", message: "busy" } } }));
  const r2 = await live.createObserverClient({ fetch: alwaysBusy, sleep }).artifactText(id(1));
  assert.deepEqual(r2, { ok: false, reason: "unavailable", status: 503, retried: true });
  assert.equal(calls, 2, "one retry, never more");
  assert.match(M.reasonWords("unavailable"), /even when asked again/);
});

test("src/live keeps no timer: the retry waits on the sleep the shell injects (the browser's)", () => {
  const src = readFileSync(new URL("../src/live/observer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /[^.\w]setTimeout\(/);
  assert.match(readFileSync(new URL("../src/shell/source/boot.ts", import.meta.url), "utf8"), /createObserverClient\(\{ fetch: browserFetch, sleep: browserSleep \}\)/);
  // The browser's fetch hands the content route's headers and text on, and asks for no caching.
  const boot = readFileSync(new URL("../src/shell/source/boot.ts", import.meta.url), "utf8");
  assert.match(boot, /headers: response\.headers, text: \(\) => response\.text\(\)/);
  assert.match(boot, /cache: "no-store"/);
});

// ---------------------------------------------------------------- grouping, the filter, stepping

test("checks are grouped by verification run (round and visit), newest first, each check with its files", () => {
  const m = model();
  assert.deepEqual(m.runs.map((r) => [r.round, r.visitId]), [[2, `${T}/verify#2`], [1, `${T}/verify#1`]]);
  assert.deepEqual(m.runs[1].checks.map((c) => c.id), ["AC-01", "R1", "H-1"]);
  assert.deepEqual(m.runs[0].checks.map((c) => c.id), ["AC-01", "R2"]);
  assert.equal(M.runWords(m.runs[0]), "Round 2, visit verify#2");
  assert.equal(M.runWords({ round: null, visitId: null }), "Round not recorded");
  assert.deepEqual(M.listedChecks(m).map((c) => c.key), [`2|${T}/verify#2/AC-01`, `2|${T}/verify#2/R2`, `1|${T}/verify#1/AC-01`, `1|${T}/verify#1/R1`, `1|${T}/verify#1/H-1`]);
  assert.deepEqual([M.kindWords("scenario"), M.kindWords("matrix rule"), M.kindWords("holdout"), M.kindWords(null)], ["Scenario", "Matrix rule", "Holdout", "Kind not recorded"]);
  assert.deepEqual(M.resultLook("fail"), { word: "Failed", state: "failed" });
  assert.deepEqual(M.resultLook("pass"), { word: "Passed", state: "succeeded" });
  assert.equal(m.readFrom, "cell");
  assert.equal(m.mediaEnabled, true);
});

test("the failed filter lists only failed checks; the selection follows it", () => {
  const m = model();
  assert.deepEqual(M.listedChecks(m, true).map((c) => c.id), ["AC-01"]);
  const sel = M.initialSelection(m, {}, true);
  assert.equal(sel.check, `1|${T}/verify#1/AC-01`);
  const kept = M.keepSelection(m, { check: `2|${T}/verify#2/R2`, file: id(8) }, true);
  assert.equal(kept.check, `1|${T}/verify#1/AC-01`, "a check the filter hides gives way to the first listed");
});

test("stepping: next file walks a check's files, then on to the next check with files (empty checks passed over), and stops at the ends", () => {
  const m = model();
  let sel = M.initialSelection(m);
  assert.deepEqual(sel, { check: `2|${T}/verify#2/AC-01`, file: id(7) });
  const seen = [];
  for (let i = 0; i < 20; i++) {
    seen.push(`${sel.check.split("/").at(-1)}:${sel.file}`);
    const next = M.stepFile(m, sel, 1);
    if (next === sel) break;
    sel = next;
  }
  assert.deepEqual(seen, [`AC-01:${id(7)}`, `R2:${id(8)}`, `AC-01:${id(1)}`, `AC-01:${id(2)}`, `R1:${id(3)}`, `R1:${id(4)}`, `R1:${id(5)}`, `R1:${id(6)}`, "R1:n4"], "H-1 has no file and is passed over; the last file stays");
  assert.equal(M.stepFile(m, sel, 1), sel, "at the end it stays");
  const back = M.stepFile(m, { check: `1|${T}/verify#1/AC-01`, file: id(1) }, -1);
  assert.deepEqual(back, { check: `2|${T}/verify#2/R2`, file: id(8) }, "before a check's first file: the previous check's last");
  // Checks: next and previous, at the first file; H-1 is a check of its own (no file).
  assert.deepEqual(M.stepCheck(m, { check: `1|${T}/verify#1/R1`, file: id(5) }, 1), { check: `1|${T}/verify#1/H-1`, file: null });
  assert.deepEqual(M.stepCheck(m, { check: `1|${T}/verify#1/R1`, file: id(5) }, -1), { check: `1|${T}/verify#1/AC-01`, file: id(1) });
  const first = M.initialSelection(m);
  assert.equal(M.stepCheck(m, first, -1), first, "before the first check it stays");
  // With the filter: only failed checks are stepped through.
  const f = M.initialSelection(m, {}, true);
  assert.equal(M.stepCheck(m, f, 1, true), f);
  assert.deepEqual(M.stepFile(m, f, 1, true), { check: f.check, file: id(2) });
});

test("where the player starts: a check id from the address (newest run), a file by catalog id, by scene id or by path", () => {
  const m = model();
  assert.deepEqual(M.initialSelection(m, { check: "R1" }), { check: `1|${T}/verify#1/R1`, file: id(3) });
  assert.deepEqual(M.initialSelection(m, { check: "AC-01" }), { check: `2|${T}/verify#2/AC-01`, file: id(7) }, "the newest run's check of that id");
  assert.deepEqual(M.initialSelection(m, { artifactId: id(2) }), { check: `1|${T}/verify#1/AC-01`, file: id(2) });
  assert.deepEqual(M.initialSelection(m, { path: "evidence/huge.log" }), { check: `1|${T}/verify#1/R1`, file: id(5) });
  assert.deepEqual(M.initialSelection(m, { check: "NOPE" }), M.initialSelection(m), "an unknown check: the first");
  assert.deepEqual(M.initialSelection(M.buildLiveModel(live.readCellEvidence({ ticket_id: T, checks: [] }, T))), M.NO_SELECTION);
});

// ---------------------------------------------------------------- states, words, integrity

test("each file's state and why: ready, withheld (credential name, too large, type, media off), missing, changed since recorded", () => {
  const m = model();
  const r1 = M.listedChecks(m).find((c) => c.id === "R1");
  const by = Object.fromEntries(r1.files.map((f) => [f.name, f]));
  assert.equal(by["r1.json"].state, "ready");
  assert.equal(by["r1.json"].cls, "text");
  assert.equal(by["r1.json"].freeText, true);
  assert.deepEqual(by["r1.json"].proves, ["R1", "R2"], "what it proves: the catalog's targets");
  assert.deepEqual([by["api-token.txt"].state, by["api-token.txt"].reason], ["withheld", "credential-name"]);
  assert.deepEqual([by["huge.log"].state, by["huge.log"].reason], ["withheld", "too-large"]);
  assert.deepEqual([by["trace.zip"].state, by["trace.zip"].reason], ["withheld", "type"]);
  assert.equal(by["trace.zip"].accessWords, "its contents are not a type the observer serves (application/octet-stream)", "the observer's own words kept when no code says it");
  assert.deepEqual([by["gone.txt"].state, by["gone.txt"].reason, by["gone.txt"].artifactId], ["missing", "not-catalogued", null], "no catalog id: the route cannot say more");
  const r2 = M.listedChecks(m).find((c) => c.id === "R2").files[0];
  assert.deepEqual([r2.state, r2.integrity], ["changed", "mismatch"]);
  assert.equal(M.STATE_WORDS.changed, "Changed since it was recorded");
  // The words the player says.
  assert.match(M.reasonWords("credential-name"), /name looks like it holds credentials/);
  assert.match(M.reasonWords("too-large"), /larger than the observer serves/);
  assert.match(M.reasonWords("type"), /does not serve this type/);
  assert.match(M.reasonWords("changed"), /changed after the observer catalogued it/);
  assert.match(M.reasonWords("link"), /link, or not a plain file/);
  assert.match(M.reasonWords("media-disabled", "image"), /^Screenshots are off in this project's settings \(floor\.evidence_media in \.factory\/config\.json\), so this file is not requested\.$/);
  assert.match(M.reasonWords("media-disabled", "video"), /^Recordings are off/);
  // The catalog's own phrases (catalog.go `access`) map to codes.
  assert.equal(M.accessReasonCode("the archive holds more than one file of this name; which one is meant is unknown, so neither is served"), "duplicate");
  assert.equal(M.accessReasonCode("the file is not there to read"), "missing");
  assert.equal(M.accessReasonCode(null), "type");
});

test("integrity is always said; a file that does not match its recorded hash says so above the viewer and is never called proof", () => {
  assert.equal(M.INTEGRITY_WORDS.match.banner, null);
  assert.match(M.INTEGRITY_WORDS.match.fact, /Matches the hash the verifier recorded/);
  assert.match(M.INTEGRITY_WORDS.mismatch.banner, /does not match the hash the verifier recorded.*It is not proof/);
  assert.match(M.INTEGRITY_WORDS.unchecked.banner, /not shown as proof/);
  assert.ok(M.INTEGRITY_WORDS.missing.banner);
  for (const k of ["match", "mismatch", "missing", "unchecked", "simulated"]) assert.ok(M.INTEGRITY_WORDS[k].fact, k);
  const player = readFileSync(new URL("../src/evidence/EvidencePlayer.tsx", import.meta.url), "utf8");
  // The banner is the integrity's, except for a file not kept after cleanup (cleanup.archive), which says that instead of "not there".
  assert.match(player, /const banner = fileBanner\(file\);/);
  for (const k of ["match", "mismatch", "missing", "unchecked", "simulated"]) assert.equal(M.fileBanner({ integrity: k, reason: null }), M.INTEGRITY_WORDS[k].banner, k);
  assert.equal(M.fileBanner({ integrity: "mismatch", reason: "missing" }), M.INTEGRITY_WORDS.mismatch.banner);
  assert.match(player, /\["Integrity", INTEGRITY_WORDS\[file\.integrity\]\.fact\]/);
});

// ---------------------------------------------------------------- what is requested, and when

test("content is requested only for the file selected: one request at most, by catalog id, never for a withheld or missing file", () => {
  const m = model();
  // Building the model and stepping make no request: they are pure. Walk every file and collect what each selection may load.
  const asked = [];
  for (const c of M.listedChecks(m)) {
    for (const f of c.files) {
      const r = M.contentRequest(m, { check: c.key, file: f.key });
      asked.push([f.name, r.kind, r.artifactId ?? r.reason ?? null]);
      if (r.artifactId) assert.equal(r.artifactId, f.artifactId, "only the selected file's id");
    }
  }
  assert.deepEqual(asked, [
    ["ac-01.png", "image", id(7)],
    ["r2.txt", "text", id(8)],
    ["ac-01.png", "image", id(1)],
    ["flow.webm", "video", id(2)],
    ["r1.json", "text", id(3)],
    ["api-token.txt", "none", "credential-name"],
    ["huge.log", "none", "too-large"],
    ["trace.zip", "none", "type"],
    ["gone.txt", "none", "not-catalogued"],
  ]);
  assert.deepEqual(M.contentRequest(m, M.NO_SELECTION), { kind: "none", reason: null }, "no selection, no request");
});

test("the player's viewer asks for content only through contentRequest, inside the keyed viewer of the one selected file, and drops it on moving on", () => {
  const player = readFileSync(new URL("../src/evidence/EvidencePlayer.tsx", import.meta.url), "utf8");
  // One place reads content: the selected file's viewer, keyed by file so moving on unmounts it.
  assert.equal((player.match(/client\.artifactText\(/g) ?? []).length, 1);
  assert.equal((player.match(/artifactContentUrl\?\.\(/g) ?? []).length, 1);
  assert.match(player, /<Viewer key=\{`\$\{check\.key\}\/\$\{file\.key\}`\}/);
  assert.match(player, /const request = contentRequest\(model, \{ check: check\.key, file: file\.key \}\);/);
  // Aborted on moving on; nothing kept beyond what is on screen.
  assert.match(player, /ctl\.abort\(\);\s*setResult\(null\);/);
  const code = player.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /new Map\(|WeakMap|caches\.|localStorage|sessionStorage|indexedDB/, "no content cache, nothing stored");
  // Video never autoplays.
  assert.doesNotMatch(code, /autoPlay|autoplay/);
  assert.match(player, /<video [^>]*controls preload="metadata"/);
});

test("media off: images and video are listed with their facts and never requested; text still opens", () => {
  const m = model({ media: false });
  assert.equal(m.mediaEnabled, false);
  const all = M.listedChecks(m).flatMap((c) => c.files.map((f) => [c, f]));
  for (const [c, f] of all) {
    const r = M.contentRequest(m, { check: c.key, file: f.key });
    if (f.cls === "image" || f.cls === "video") {
      assert.deepEqual([f.state, f.reason, r.kind, r.reason], ["withheld", "media-disabled", "none", "media-disabled"], f.name);
      assert.ok(f.bytes !== null && f.mediaType, "its facts stay");
    }
  }
  const text = all.find(([, f]) => f.name === "r1.json");
  assert.equal(M.contentRequest(m, { check: text[0].key, file: text[1].key }).kind, "text");
  // The setting from the session when the reply does not say; off when neither says (fail closed).
  const quiet = { ...reply(), settings: undefined };
  assert.equal(M.buildLiveModel(live.readCellEvidence(quiet, T), { sessionMedia: true }).mediaEnabled, true);
  assert.equal(M.buildLiveModel(live.readCellEvidence(quiet, T)).mediaEnabled, false);
  // Even if a reply said "media" for one file while the setting is off, nothing is requested.
  const odd = reply({ media: false });
  odd.checks[0].evidence[0].content_access = "media";
  const om = M.buildLiveModel(live.readCellEvidence(odd, T));
  assert.equal(M.contentRequest(om, M.initialSelection(om, { artifactId: id(1) })).kind, "none");
});

// ---------------------------------------------------------------- the archive

test("archived cells work as live ones and say they are read from the archive", () => {
  const r = reply();
  for (const a of r.artifacts) a.origin = "archive";
  const m = M.buildLiveModel(live.readCellEvidence(r, T));
  assert.equal(m.readFrom, "archive");
  assert.equal(M.listedChecks(m)[0].files[0].origin, "archive");
  assert.equal(M.contentRequest(m, M.initialSelection(m)).kind, "image");
  assert.match(M.ARCHIVE_WORDS, /archive/);
  r.artifacts[0].origin = "cell";
  assert.equal(M.buildLiveModel(live.readCellEvidence(r, T)).readFrom, "both");
});

// ---------------------------------------------------------------- the simulation

test("simulation: the scenario's checks with content the app makes itself, labelled; a recording says there is none", () => {
  const log = sim.fixtureLog(sim.SCENARIO);
  const end = log.sceneAt(sim.SCENARIO.duration);
  const cell = end.cells["131"];
  const m = M.buildSimModel(cell);
  assert.equal(m.source, "simulation");
  assert.equal(m.readFrom, "simulation");
  assert.deepEqual(m.runs.map((r) => r.round), [2, 1], "131 failed verification once");
  assert.ok(M.listedChecks(m, true).length >= 1, "round 1's failed check");
  const files = M.listedChecks(m).flatMap((c) => c.files.map((f) => [c, f]));
  assert.ok(files.length > 0);
  for (const [c, f] of files) {
    assert.equal(f.artifactId, null, "the simulation has no catalog id: nothing is ever fetched");
    assert.equal(f.integrity, "simulated");
    const r = M.contentRequest(m, { check: c.key, file: f.key });
    assert.equal(r.kind, "simulated", f.name);
    if (f.cls === "video") assert.equal(r.content.kind, "video");
    // M15: a design mock's sample pictures also say which side they are (the approved mock or the capture).
    if (f.cls === "image") assert.deepEqual(r.content, { kind: "image", checkId: c.id, result: c.result, round: c.round, ...(f.role ? { role: f.role } : {}) });
  }
  assert.match(M.SIM_RECORDING_WORDS, /^There is no recording in a simulation\./);
  assert.match(M.SIM_CONTENT_NOTE, /not a capture/);
  // Its text says what it is.
  const json = M.simulatedText({ ticket: "132", checkId: "R1", kind: "matrix rule", result: "pass", round: 1, note: "one charge", path: "evidence/r1-charged-once.json" });
  assert.equal(JSON.parse(json).simulation, "sample written by the Factory Floor; not a capture");
  assert.match(M.simulatedText({ ticket: "T", checkId: "X", kind: null, result: null, round: null, note: null, path: "evidence/test.log" }), /^# Simulation: sample written by the Factory Floor; not a capture/);
  // At an earlier moment: the scene there holds fewer checks, and nothing later.
  const early = M.buildSimModel(log.sceneAt(sim.SCENARIO.duration / 3).cells["131"] ?? cell);
  for (const c of M.listedChecks(early)) assert.ok(c.atMs <= sim.SCENARIO.duration / 3);
});

// ---------------------------------------------------------------- scene ids and catalog ids

test("the check that cites a file, newest round first (the artifact inspector opens the player there)", () => {
  const cell = { ticketId: T, verifications: [
    { round: 1, checks: [{ targetId: "AC-01", evidence: [`${T}:evidence/ac-01.png`] }] },
    { round: 2, checks: [{ targetId: "AC-01", evidence: ["evidence/ac-01.png"] }, { targetId: "R1", evidence: ["evidence/r1.json"] }] },
  ] };
  assert.deepEqual(M.checkCitingPath(cell, "evidence/ac-01.png"), { checkId: "AC-01", round: 2 });
  assert.deepEqual(M.checkCitingPath(cell, "evidence/r1.json"), { checkId: "R1", round: 2 });
  assert.equal(M.checkCitingPath(cell, "evidence/findings.md"), null);
  assert.equal(M.sameFile("evidence/a.png", "a.png"), true);
  assert.equal(M.sameFile("evidence/a.png", "b/a.png"), false);
});

// ---------------------------------------------------------------- the address and the store

test("the address carries only the ticket and the check; a path, a file name or prose is never accepted or written", () => {
  const w = { route: "floor", sel: null };
  assert.equal(H.formatHash({ ...w, evidence: { ticket: T, check: "AC-01" } }), `#floor?evidence=${T}&check=AC-01`);
  assert.equal(H.formatHash({ ...w, evidence: { ticket: T, check: null } }), `#floor?evidence=${T}`);
  assert.equal(H.formatHash(w), "#floor", "closed: nothing written");
  assert.equal(H.formatHash({ ...w, evidence: { ticket: "evidence/ac-01.png", check: "AC-01" } }), "#floor", "a path is not a ticket");
  assert.equal(H.formatHash({ ...w, evidence: { ticket: T, check: "a file.png" } }), `#floor?evidence=${T}`);
  assert.deepEqual(H.parseHash(`#line?evidence=${T}&check=R1`).evidence, { ticket: T, check: "R1" });
  assert.equal(H.parseHash("#floor?evidence=..%2F..%2Fetc").evidence, null);
  assert.deepEqual(H.parseHash(`#floor?evidence=${T}&check=%3Cb%3E`).evidence, { ticket: T, check: null });
  for (const route of ["line", "floor", "analytics"]) {
    const text = H.formatHash({ ...w, route, evidence: { ticket: T, check: "AC-02" } });
    assert.deepEqual(H.parseHash(text).evidence, { ticket: T, check: "AC-02" }, route);
  }
});

test("the store opens the player for identifiers only; the file to start at stays in memory, never in the address", async () => {
  const { createHashSync } = await import("../src/shell/source/hashSync.ts");
  const store = createSceneStore({ fixture: sim.SCENARIO, clock: manualClock(0), workspace: "floor" });
  store.openEvidence("not a ticket/../x");
  assert.equal(store.getState().evidence, null);
  let hash = "#floor";
  const host = {
    getHash: () => hash,
    replaceHash: (h) => (hash = h),
    onHashChange: () => () => {},
  };
  const sync = createHashSync(store, host);
  store.openEvidence("131", { check: "AC-01", start: { sceneArtifactId: "131:evidence/ac-01-overdue-filter.png", path: "evidence/ac-01-overdue-filter.png" } });
  assert.equal(hash, "#floor?evidence=131&check=AC-01");
  assert.doesNotMatch(hash, /png|evidence%2F|overdue/);
  store.setEvidenceCheck("R4");
  assert.equal(hash, "#floor?evidence=131&check=R4");
  store.setEvidenceCheck("evidence/x.png");
  assert.equal(store.getState().evidence.check, null);
  store.closeEvidence();
  assert.equal(hash, "#floor");
  sync.dispose();
  // Opened from the address (Back to it), and closed by an address without it.
  const { applyHash } = await import("../src/shell/source/hashSync.ts");
  applyHash(store, H.parseHash("#floor?evidence=132&check=R2"));
  assert.deepEqual(store.getState().evidence, { ticket: "132", check: "R2", start: null });
  applyHash(store, H.parseHash("#floor"));
  assert.equal(store.getState().evidence, null);
  store.dispose?.();
});

test("accessible names use IDs, positions and types, never a file's name", () => {
  const f = { cls: "image", state: "withheld" };
  assert.equal(M.fileAccessibleName(f, 0, 3, "AC-01"), "Screenshot 1 of 3, check AC-01, withheld");
  assert.equal(M.lineCount("a\nb\n"), 2);
  assert.equal(M.lineCount("a\nb"), 2);
  assert.equal(M.lineCount(""), 0);
  assert.equal(M.sizeWords(2048), "2.0 KB");
  assert.equal(M.sizeWords(null), null);
});
