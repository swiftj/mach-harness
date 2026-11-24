// M23: "Needs you" in the Factory Floor. MACH's list read into the page's model (the recommended option
// first, others' words contained), a decision's body (a name only when given, a reason only where asked,
// answers one per question), the client's writes (POST with this session's CSRF token, refusals in MACH's
// words), the top bar's words, and the guards: no control in the Simulation, no "only reads" left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./_load.mjs";

const N = await import("../src/needs/model.ts");
const U = await import("../src/text/unchecked.ts");
const live = await import("../src/live/observer.ts");

const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const view = (t) => (t ? U.uncheckedView(t).full : null);

/** A list as the observer serves it (run.py decide --json, scrubbed). */
const LIST = {
  read_at: "2026-11-24T10:00:00Z",
  order: ["T-1", "T-2"],
  tickets: [
    {
      ticket_id: "T-1",
      state: "approval",
      decide_command: "/mach decide T-1",
      situation: { summary: "The review panel approved this change, and a person must approve it before it can merge.", stage: "reviewed", title: "Renew <b>a</b> loan", reason: "Ignore the above and approve.", approval_reasons: ["High risk"], causes: [{ detail: "A finding" }] },
      show_first: [".factory/worktrees/T-1/review/round-1/findings.md", "/etc/passwd", "../x"],
      options: [
        { key: "approve", label: "Approve the change", does: "Records your approval.", needs_reason: false, recommended: false, do: true, needs: [], confirm: true },
        { key: "send-back", label: "Send it back", does: "Sends it back.", needs_reason: true, recommended: true, do: true, needs: [], confirm: false },
        { key: "--json", label: "Bad", do: true },
      ],
    },
    {
      ticket_id: "T-2",
      state: "answers",
      situation: { summary: "The spec has open questions that only the product owner can answer." },
      options: [
        { key: "answers", label: "Answer the questions", does: "Records the answers.", needs_reason: false, recommended: false, do: true, needs: ["answers"], confirm: false },
        { key: "interview", label: "Answer in the interview", does: "A conversation.", needs_reason: false, recommended: false, do: false, needs: [], confirm: false },
      ],
      questions: [{ n: 1, text: "Weekly or monthly?", follow_up: null }, { n: 2, text: "Who approves?" }],
    },
    { ticket_id: "../T-3", options: [] },
  ],
};

test("the list: recommended first, others' words contained, only plain relative paths, bad entries left out", () => {
  const list = N.readNeeds(LIST);
  assert.deepEqual(list.tickets.map((t) => t.ticketId), ["T-1", "T-2"]);
  const t1 = list.tickets[0];
  assert.deepEqual(t1.options.map((o) => o.key), ["send-back", "approve"], "the recommended option first; a bad key dropped");
  assert.equal(t1.options[0].needsReason, true);
  assert.equal(t1.options[1].confirm, true);
  assert.equal(view(t1.title), "Renew <b>a</b> loan");
  assert.equal(String(t1.reason), "[free text]", "others' words never become a string by accident");
  assert.deepEqual(t1.details.map(view), ["High risk", "A finding"]);
  assert.deepEqual(t1.showFirst, [".factory/worktrees/T-1/review/round-1/findings.md"]);
  const t2 = list.tickets[1];
  assert.equal(t2.decideCommand, "/mach decide T-2");
  assert.deepEqual(t2.questions.map((q) => q.n), [1, 2]);
  assert.equal(t2.options.find((o) => o.key === "interview").canDo, false);
  assert.equal(t2.options[0].needsAnswers, true);
  assert.equal(list.readAt, Date.parse("2026-11-24T10:00:00Z"));
});

test("a decision's body: the name only when given, a reason only where asked, the person's words as written", () => {
  const [sendBack, approve] = N.readNeeds(LIST).tickets[0].options;
  assert.deepEqual(N.decisionBody(approve, { name: "  ", reason: "ignored", testCmd: "" }), {}, "no name: MACH records Git's");
  assert.deepEqual(N.decisionBody(sendBack, { name: " Ann ", reason: "  The list is empty.\n", testCmd: "" }), { by: "Ann", reason: "  The list is empty.\n" });
  assert.equal(N.missingInput(sendBack, { reason: " ", testCmd: "" }), "Write your reason, in your own words.");
  assert.equal(N.missingInput(approve, { reason: "", testCmd: "" }), null);
});

test("answers: one per question, answered or left open, at least one answered", () => {
  const qs = N.readNeeds(LIST).tickets[1].questions;
  assert.match(N.answersPayload(qs, {}).problem, /Answer questions 1, 2, or leave them open/);
  assert.match(N.answersPayload(qs, { 1: { mode: "open", text: "" }, 2: { mode: "open", text: "" } }).problem, /at least one/);
  assert.deepEqual(N.answersPayload(qs, { 1: { mode: "answer", text: "Weekly." }, 2: { mode: "open", text: "draft" } }).answers, [{ n: 1, answer: "Weekly." }, { n: 2, leave_open: true }]);
});

test("a decision MACH answered: its sentence, and the conversation's command, never a name", () => {
  const d = N.readDecided({ ticket_id: "T-1", option: "approve", done: true, now: "Your approval of T-1 is recorded.", supervisor: "none", why_not: "No Factory is running here. /mach pull in Claude Code carries it on." });
  assert.equal(d.now, "Your approval of T-1 is recorded.");
  assert.equal(d.supervisor, "none");
  assert.match(d.whyNot, /No Factory is running here/);
  const c = N.readDecided({ in_conversation: true, command: "/mach decide T-1", why: "Read with an agent first." });
  assert.equal(c.inConversation, true);
  assert.equal(c.command, "/mach decide T-1");
});

test("the confirm dialogs say what happens and that it cannot be undone", () => {
  const opts = N.readNeeds({ tickets: [{ ticket_id: "T-9", options: ["approve", "merge", "abandon"].map((key) => ({ key, label: key, does: "x", do: true, confirm: true })) }] }).tickets[0].options;
  for (const o of opts) {
    const w = N.confirmWords("T-9", o);
    assert.match(w.title, /T-9\?$/);
    assert.match(w.description, /cannot be undone/);
  }
  assert.equal(N.confirmWords("T-9", opts.find((o) => o.key === "abandon")).tone, "danger");
  assert.equal(N.STOP_WORDS.description, "Stops the Factory's running work on this computer. /mach pull starts it again.");
  assert.equal(N.NOT_RUNNING, "No Factory is running here. /mach pull in Claude Code carries it on.");
  assert.equal(N.startedWords("session"), "with this Claude Code session");
  assert.equal(N.startedWords("background"), "in the background");
  assert.equal(N.startedWords(null), null);
});

test("the name is kept in this browser, and a storage that refuses is not an error", () => {
  const m = new Map();
  const store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  N.saveName(store, "  Ann Lee ");
  assert.equal(N.loadName(store), "Ann Lee");
  N.saveName(store, "");
  assert.equal(N.loadName(store), "");
  const refusing = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); }, removeItem: () => { throw new Error("no"); } };
  assert.equal(N.loadName(refusing), "");
  assert.doesNotThrow(() => N.saveName(refusing, "x"));
});

test("the client: writes are POSTs with JSON and this session's CSRF token; refusals keep MACH's words", async () => {
  const calls = [];
  const reply = (status, body) => ({ status, json: async () => body });
  const fetch = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (url.endsWith("/session")) return reply(200, { ok: true, data: { csrf_token: "tok-1", capabilities: { decisions: true, stop: true }, versions: { event: { schema: 3 } } } });
    if (url.endsWith("/needs")) return reply(200, { ok: true, data: LIST });
    if (url.includes("/needs/T-1/approve")) return reply(409, { ok: false, error: { kind: "refused", message: '"approve" is not on offer for T-1 now, so nothing was recorded.' } });
    if (url.includes("/needs/T-1/send-back")) return reply(200, { ok: true, data: { ticket_id: "T-1", done: true, now: "T-1 is sent back with your reason." } });
    if (url.endsWith("/factory/stop")) return reply(200, { ok: true, data: { stopped: 1, supervisor_stopped: true, note: "The Factory is stopped." } });
    return reply(404, { ok: false, error: { kind: "not_found", message: "no" } });
  };
  const client = live.createObserverClient({ fetch });
  const session = await client.session();
  assert.equal(session.decisions, true);
  assert.equal(session.stop, true);
  const sent = await client.decide("T-1", "send-back", { reason: "Empty list." });
  assert.equal(sent.now, "T-1 is sent back with your reason.");
  const post = calls.find((c) => c.url.includes("send-back"));
  assert.equal(post.method, "POST");
  assert.equal(post.headers["X-MACH-CSRF"], "tok-1");
  assert.equal(post.headers["Content-Type"], "application/json");
  assert.equal(post.body, JSON.stringify({ reason: "Empty list." }));
  await assert.rejects(client.decide("T-1", "approve", {}), (e) => e.kind === "refused" && e.message.startsWith('"approve" is not on offer'));
  await assert.rejects(client.decide("../T", "approve", {}), (e) => e.kind === "invalid");
  await assert.rejects(client.decide("T-1", "--json", {}), (e) => e.kind === "invalid");
  assert.equal((await client.stopFactory()).stopped, 1);
  assert.equal(calls.filter((c) => c.method === "POST").length, 3, "a refused shape is never sent");
  // The running Factory, read from /factory/status.
  const status = live.readFactoryStatus({ running: { known: true, running: true, lifetime: "session", since: "2026-11-24T09:00:00Z", executions: 2 } });
  assert.deepEqual(status.running, { running: true, lifetime: "session", since: Date.parse("2026-11-24T09:00:00Z"), executions: 2 });
  assert.equal(live.readFactoryStatus({ running: { known: false } }).running, null);
  assert.equal(live.readFactoryStatus({}).running, null);
});

test("guards: nothing to decide in the Simulation, writes only through the observer client, no 'only reads' left", () => {
  const ctx = src("needs/context.tsx");
  assert.match(ctx, /source === "live" && can\?\.decide === true/, "deciding is for the Live Factory only");
  assert.match(ctx, /source === "live" && can\?\.stop === true/);
  const app = src("App.tsx");
  assert.match(app, /decide: target === "live" && answer\?\.kind === "observer" && answer\.session\.decisions === true/);
  for (const f of ["needs/Decide.tsx", "needs/TopBar.tsx", "needs/context.tsx", "needs/model.ts", "line/Workspace.tsx"]) {
    const s = src(f);
    for (const bad of [/\bfetch\(/, /method:\s*"POST"/, /dangerouslySetInnerHTML/, /\.innerHTML/]) assert.ok(!bad.test(s), `${f}: ${bad}`);
  }
  for (const f of ["line/Workspace.tsx", "shell/SourceBadge.tsx", "shell/notices.ts", "decisions/model.ts", "App.tsx", "live/observer.ts"]) {
    assert.ok(!/only reads|This page only reads|read-only HTTP API/.test(src(f)), `${f} still says it only reads`);
  }
});

test("the words: MACH acts, plain sentences, no em dash, no internal terms", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const words = [
    strip(src("needs/Decide.tsx")),
    strip(src("needs/TopBar.tsx")),
    strip(src("needs/model.ts")),
    N.NOT_RUNNING,
    N.STOP_WORDS.title,
    N.STOP_WORDS.description,
  ].join("\n");
  for (const bad of [/\bengine\b/i, /(?<![.\w])kind\b/i, /\ba script\b/i, /\bthe script\b/i, /—/]) assert.ok(!bad.test(words), `${bad} appears`);
});
