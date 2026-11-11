// Opt-in, and it spends money (up to the $6 guard): a real AI-assisted interview carried all the
// way to an approved, sent wave, through the browser only.
//
//   E2E_REAL_CLAUDE_FULL=1 node --test --test-reporter=spec web/e2e/suites/interview-real-full.test.mjs
//
// The host launches the person's real `claude` exactly as it always does; only its documented
// --model sonnet and --budget-per-turn 0.50 flags are set. No permission-skipping flag anywhere.
// Every parsed question is answered "Yes, accept" ("You decide" when it has no recommendation); a
// confirmation of the write-up gets a short typed yes. Mid-interview the page is reloaded once and
// the host is restarted once. The spec is never written by the test: if the interviewer cannot
// reach an approvable spec this way, that is the finding, recorded in result.json.
//
// Guards: stop and report at $6 total, 45 questions, or 40 minutes.
// E2E_FULL_NO_RESTART=1 leaves out the host restart (for when a restart is known to strand the
// interview on screen, so the rest of the path can still be proven).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { screenshots } from "../lib/env.mjs";
import { buildHost } from "../lib/build.mjs";
import { createWorld } from "../lib/world.mjs";
import { startHost } from "../lib/host.mjs";
import { openBrowser, settle, watchedPage } from "../lib/app.mjs";

const enabled = process.env.E2E_REAL_CLAUDE_FULL === "1";
const FOLDER = join(screenshots, "interview-real-full");
const GUARD = { usd: 6, questions: 45, ms: 40 * 60 * 1000 };
const HOST_FLAGS = ["--model", "sonnet", "--budget-per-turn", "0.50"];
const IDEA = "Invite one teammate by email; the workspace has a seat limit.";
const SLICE = "SLICE-001";

let binary, world, host, browser, session, page;
const started = Date.now();
const result = {
  idea: IDEA,
  host_flags: HOST_FLAGS,
  restart_included: process.env.E2E_FULL_NO_RESTART !== "1",
  turns: [], // {n, kind, title, answer, turn_cost_usd, session_cost_usd, seconds}
  reload: null,
  restart: null,
  stopped_because: null,
  final_check: null,
  final_state: null,
  total_cost_usd: 0,
  duration_s: null,
  defects: [],
  findings: [],
};

const save = () => {
  result.duration_s = Math.round((Date.now() - started) / 1000);
  mkdirSync(FOLDER, { recursive: true });
  writeFileSync(join(FOLDER, "result.json"), JSON.stringify(result, null, 2));
};
const shot = async (name) => {
  mkdirSync(FOLDER, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: join(FOLDER, `${name}.png`) }).catch(() => {});
};

before(async () => {
  if (!enabled) return;
  ({ binary } = buildHost());
  // E2E_FULL_REHEARSAL=1 plays the same path against the scripted stand-in (free), to check the test itself.
  world = process.env.E2E_FULL_REHEARSAL === "1"
    ? createWorld({ claude: "fake", turns: [...Array.from({ length: 7 }, (_, k) => ({ kind: "question", number: k + 1, title: `Rehearsal question ${k + 1}` })), { kind: "write_spec" }] })
    : createWorld({ claude: "real" });
  host = await startHost(binary, world.pm, world.env, HOST_FLAGS);
  browser = await openBrowser();
  session = await watchedPage(browser, host.origin);
  page = session.page;
});

after(async () => {
  if (!enabled) return;
  save();
  await browser?.close();
  await host?.stop();
  world?.cleanup();
});

const main = () => page.getByRole("main");
const dialog = () => page.getByRole("dialog");
const current = async () => (await page.evaluate(async (id) => (await fetch(`/api/interview?slice_id=${id}`)).json(), SLICE)).data.interview;
// Read-only each turn (slice show, no bookkeeping); the recording `slice check --ready` runs only when that says ready.
const engineCheck = () => {
  const shown = world.studio(world.pm, "slice", "show", SLICE).json?.check;
  if (!shown?.ready) return shown;
  return world.studio(world.pm, "slice", "check", SLICE, "--ready").json;
};
const guardTripped = () => {
  if (result.total_cost_usd > GUARD.usd) return `total cost $${result.total_cost_usd} passed $${GUARD.usd}`;
  if (result.turns.filter((t) => t.kind === "question").length > GUARD.questions) return `more than ${GUARD.questions} questions`;
  if (Date.now() - started > GUARD.ms) return "40 minutes passed";
  return null;
};

/** Waits (polling the host, never sleeping blindly) until a turn after `turnsBefore` has finished. */
async function turnFinished(turnsBefore, ms = 12 * 60 * 1000) {
  const until = Date.now() + ms;
  for (;;) {
    const i = await current();
    if (i && !i.turn_running && i.turns > turnsBefore && i.state !== "thinking" && i.state !== "working" && i.state !== "starting") return i;
    if (i && ["ended", "failed"].includes(i.state)) return i;
    if (Date.now() > until) throw new Error(`no finished turn within ${ms / 1000}s: ${JSON.stringify(i).slice(0, 300)}`);
    await page.waitForTimeout(2000);
  }
}

function recordTurn(i, extra) {
  const previous = result.turns.at(-1)?.session_cost_usd ?? result.restart?.cost_before ?? 0;
  const entry = {
    n: result.turns.length + 1,
    kind: i.last_message?.kind ?? null,
    title: i.last_message?.question?.title ?? null,
    session_cost_usd: i.session_cost_usd ?? null,
    turn_cost_usd: i.session_cost_usd != null ? Math.round((i.session_cost_usd - previous) * 1e6) / 1e6 : null,
    at_s: Math.round((Date.now() - started) / 1000),
    ...extra,
  };
  result.turns.push(entry);
  result.total_cost_usd = Math.max(result.total_cost_usd, i.session_cost_usd ?? 0);
  save();
  return entry;
}

const conversationText = () => main().getByRole("list", { name: "Conversation with the interviewer" }).innerText().catch(() => "");
const decisionsCount = async () => {
  const name = await page.getByRole("tab", { name: /^Decisions/ }).first().innerText().catch(() => "");
  return Number((name.match(/\d+/) || ["0"])[0]);
};

test("real claude, full: an AI-assisted interview to an approved, sent wave", { skip: !enabled && "set E2E_REAL_CLAUDE_FULL=1 to run (spends up to $6)" }, async (t) => {
  let broken = null;
  const step = (name, fn) =>
    t.test(name, async (st) => {
      if (broken) return st.skip(`after "${broken}"`);
      try {
        await fn(st);
      } catch (e) {
        broken = name;
        await shot(`FAILED-${name.replace(/[^a-z0-9]+/gi, "-")}`);
        result.stopped_because ??= `${name}: ${String(e.message).slice(0, 400)}`;
        save();
        throw e;
      }
    });

  await step("vision, epic and approval through the UI", async () => {
    await page.goto(host.url, { waitUntil: "networkidle" });
    const capability = await page.evaluate(async () => (await (await fetch("/api/session")).json()).data.capabilities);
    result.capability = capability;
    assert.ok(capability.interview, `interview unavailable: ${capability.interview_reason}`);
    await page.goto(`${host.origin}/#/vision`);
    await main().getByRole("textbox", { name: "Name" }).fill("Team Space");
    await main().getByRole("textbox", { name: "Vision" }).fill("Small teams work together in one shared workspace.");
    await main().getByRole("textbox", { name: "Outcome 1" }).fill("Teams can bring the people they work with into their workspace");
    await main().getByRole("button", { name: "Create the project" }).click();
    await main().getByRole("heading", { level: 1, name: "Vision" }).waitFor();
    await main().getByRole("button", { name: "Add an epic" }).click();
    await dialog().getByRole("textbox", { name: "Title" }).fill("Team membership");
    await dialog().getByRole("textbox", { name: "Criterion 1" }).fill("Only invited people can join a workspace");
    await dialog().getByRole("button", { name: "Add epic" }).click();
    await dialog().waitFor({ state: "detached" });
    await main().getByRole("button", { name: "Approve EPIC-001" }).click();
    await dialog().getByRole("button", { name: "Approve epic" }).click();
    await dialog().waitFor({ state: "detached" });
    assert.equal(world.status().epics[0].status, "approved");
  });

  await step("start the slice with an idea and open the interview", async () => {
    await page.goto(`${host.origin}/#/roadmap`);
    await settle(page);
    await main().getByRole("button", { name: "Start a slice" }).first().click();
    await dialog().getByRole("textbox", { name: "Title" }).fill("Invite a teammate");
    await dialog().getByRole("textbox", { name: /The idea/ }).fill(IDEA);
    await dialog().getByRole("button", { name: "Start and open the interview" }).click();
    await page.waitForURL(/interview$/);
    await shot("01-interview-start");
    await main().getByRole("button", { name: "Start the interview" }).click();
  });

  let done = false;
  let reloaded = false;
  let restarted = false;
  await step("answer every question until the spec is approvable", async () => {
    let turnsBefore = 0;
    for (;;) {
      const i = await turnFinished(turnsBefore);
      turnsBefore = i.turns;
      if (["ended", "failed"].includes(i.state)) {
        recordTurn(i, { answer: null });
        throw new Error(`the interview ${i.state}: ${JSON.stringify(i.last_message).slice(0, 300)}`);
      }
      await settle(page);
      const check = engineCheck();
      const ready = check?.ready === true && (check.open_questions ?? []).length === 0;
      const card = main().getByRole("region").filter({ has: page.getByRole("button", { name: "Yes, accept" }) }).last();
      const isQuestion = (await page.getByRole("button", { name: "Yes, accept" }).count()) > 0;
      if (ready) {
        recordTurn(i, { answer: null, spec_ready: true });
        result.final_check = check;
        await shot("05-spec-ready");
        done = true;
        return;
      }
      const tripped = guardTripped();
      if (tripped) {
        recordTurn(i, { answer: null });
        result.stopped_because = `guard: ${tripped}`;
        throw new Error(result.stopped_because);
      }
      let answer;
      if (!isQuestion && i.last_message?.kind === "question") {
        // The host says a question is waiting but the screen offers no Yes/No card (seen after a
        // reload): answer it the only way the screen allows, with a typed yes, and record that.
        answer = "Yes (typed: no Yes/No card on screen)";
        if (!(await main().getByRole("textbox", { name: "Your reply" }).count())) {
          // Neither card nor reply box: the screen is stuck. A reload is what a person would try.
          result.findings.push(`question "${i.last_message?.question?.title}" waiting on the host, but the screen offered no card and no reply box; reloaded the page to go on`);
          await shot(`10-stuck-before-reload-${result.turns.length + 1}`);
          await page.reload();
          await settle(page, 1000);
          if (await page.getByRole("button", { name: "Yes, accept" }).count()) answer = "Yes, accept";
        }
        recordTurn(i, { title: i.last_message?.question?.title ?? null, answer });
        if (answer === "Yes, accept") {
          await main().getByRole("region").filter({ has: page.getByRole("button", { name: "Yes, accept" }) }).last().getByRole("button", { name: "Yes, accept" }).click();
          continue;
        }
        await main().getByRole("textbox", { name: "Your reply" }).fill("Yes");
        await main().getByRole("button", { name: "Send reply" }).click();
      } else if (isQuestion) {
        const title = (await card.getByRole("heading").first().innerText().catch(() => "")).trim();
        const hasRecommendation = (await card.getByText("Recommended", { exact: true }).count()) > 0;
        answer = hasRecommendation ? "Yes, accept" : "You decide";
        recordTurn(i, { title: i.last_message?.question?.title ?? title, answer });
        const q = result.turns.filter((x) => x.kind === "question").length;
        if (q === 1) await shot("02-first-question");
        if (q % 5 === 0) await shot(`03-question-${String(q).padStart(2, "0")}`);
        await card.getByRole("button", { name: answer }).click();
      } else {
        const confirmation = i.last_message?.kind === "confirmation";
        answer = confirmation ? "Yes, that captures it. Please write it up." : "Please continue.";
        recordTurn(i, { answer, text: (i.last_message?.text || "").slice(-500) });
        if (!confirmation) result.defects.push({ note: "a final message that was neither a parsed question nor a confirmation", text: (i.last_message?.text || "").slice(-500) });
        await shot(`04-${confirmation ? "confirmation" : "other"}-${result.turns.length}`);
        const box = main().getByRole("textbox", { name: confirmation ? "Does this capture the intent?" : "Your reply" });
        await box.fill(answer);
        await main().getByRole("button", { name: "Send reply" }).click();
      }

      const questions = result.turns.filter((x) => x.kind === "question").length;
      // Once, after the third question: reload the page mid-interview.
      if (!reloaded && questions >= 3) {
        reloaded = true;
        const n = await turnFinished(turnsBefore);
        turnsBefore = n.turns;
        await settle(page);
        const before = { conversation: await conversationText(), decisions: await decisionsCount() };
        await page.reload();
        await main().getByRole("list", { name: "Conversation with the interviewer" }).waitFor({ timeout: 30000 });
        await settle(page, 800);
        const afterText = await conversationText();
        const titles = result.turns.filter((x) => x.title).map((x) => x.title);
        result.reload = {
          after_question: questions,
          titles_missing_after_reload: titles.filter((x) => !afterText.includes(x)),
          decisions_before: before.decisions,
          decisions_after: await decisionsCount(),
          question_card_back: (await page.getByRole("button", { name: "Yes, accept" }).count()) > 0 || n.last_message?.kind !== "question",
        };
        await shot("06-after-reload");
        save();
        // Findings, not stops: the interview goes on so the rest of the path is still proven.
        if (result.reload.titles_missing_after_reload.length) result.findings.push(`after a reload the conversation lacks: ${result.reload.titles_missing_after_reload.join(", ")}`);
        if (result.reload.decisions_after !== result.reload.decisions_before) result.findings.push(`after a reload Decisions shows ${result.reload.decisions_after}, before it showed ${result.reload.decisions_before}`);
        if (!result.reload.question_card_back) result.findings.push(`after a reload the open question "${n.last_message?.question?.title}" has no Yes/No card; the transcript shows it as already answered`);
        turnsBefore = n.turns - 1; // the finished turn is handled by the loop's next iteration
        continue;
      }
      // Once, after the sixth question: restart the host mid-interview.
      if (!restarted && questions >= 6 && process.env.E2E_FULL_NO_RESTART !== "1") {
        restarted = true;
        const n = await turnFinished(turnsBefore);
        const costBefore = n.session_cost_usd;
        const lastTitle = n.last_message?.question?.title ?? null;
        await host.stop();
        host = await startHost(binary, world.pm, world.env, HOST_FLAGS);
        await page.goto(host.url, { waitUntil: "networkidle" });
        await page.goto(`${host.origin}/#/slices/${SLICE}/interview`);
        await main().getByRole("button", { name: "Continue the interview" }).waitFor({ timeout: 30000 });
        await shot("07-after-host-restart");
        const resumed = page.waitForResponse((r) => r.url().endsWith("/api/interview") && r.request().method() === "POST");
        await main().getByRole("button", { name: "Continue the interview" }).click();
        const body = await (await resumed).json();
        await main().getByRole("list", { name: "Conversation with the interviewer" }).waitFor({ timeout: 30000 });
        await settle(page, 800);
        const afterText = await conversationText();
        const titles = result.turns.filter((x) => x.title).map((x) => x.title);
        const cur = await current();
        result.restart = {
          after_question: questions,
          start_response: body.data ?? body,
          cost_before: costBefore,
          last_question_before: lastTitle,
          last_question_after: cur?.last_message?.question?.title ?? null,
          turns_after: cur?.turns,
          titles_missing_after_restart: titles.filter((x) => !afterText.includes(x)),
        };
        save();
        result.restart.question_card_back = (await page.getByRole("button", { name: "Yes, accept" }).count()) > 0 || n.last_message?.kind !== "question";
        result.restart.stopped_banner_after_resume = (await main().getByText("Product Studio's host was stopped").count()) > 0;
        if (result.restart.stopped_banner_after_resume) {
          result.findings.push(`after a host restart and "Continue the interview" (host: resumed), the screen still says "Product Studio's host was stopped" and offers Continue again, with no question card and no reply box`);
          await shot("07b-after-continue-still-stopped");
          // The only way forward the screen offers: its own Continue button.
          const again = page.waitForResponse((r) => r.url().endsWith("/api/interview") && r.request().method() === "POST");
          await main().getByRole("button", { name: "Continue the interview" }).click();
          result.restart.second_continue = (await (await again).json()).data ?? null;
          await settle(page, 800);
          result.restart.card_after_second_continue = (await page.getByRole("button", { name: "Yes, accept" }).count()) > 0;
          result.restart.composer_after_second_continue = (await main().getByRole("textbox", { name: "Your reply" }).count()) > 0;
          result.restart.banner_after_second_continue = (await main().getByText("Product Studio's host was stopped").count()) > 0;
          await shot("07c-after-second-continue");
        }
        if (body.data?.resumed !== true) result.findings.push(`after a host restart the interview did not resume: ${JSON.stringify(body).slice(0, 300)}`);
        if (cur?.turns !== n.turns) result.findings.push(`resuming after a host restart ran a turn (turns ${n.turns} -> ${cur?.turns}) instead of replaying the last message`);
        if (result.restart.last_question_after !== lastTitle) result.findings.push(`after a host restart the last question is "${result.restart.last_question_after}", before it was "${lastTitle}"`);
        if (result.restart.titles_missing_after_restart.length) result.findings.push(`after a host restart the conversation lacks: ${result.restart.titles_missing_after_restart.join(", ")}`);
        if (!result.restart.question_card_back) result.findings.push(`after a host restart the open question "${lastTitle}" has no Yes/No card`);
        save();
        turnsBefore = n.turns - 1;
        continue;
      }
    }
  });

  await step("approve the slice in the app", async () => {
    assert.ok(done);
    await page.goto(`${host.origin}/#/slices/${SLICE}`);
    await main().getByRole("heading", { level: 1 }).waitFor();
    await settle(page);
    await page.getByRole("complementary", { name: "Engine check" }).getByText(/Ready for your approval/).waitFor({ timeout: 30000 });
    await main().getByRole("button", { name: `Approve ${SLICE}` }).click();
    await dialog().getByRole("button", { name: `Approve ${SLICE}` }).click();
    await dialog().waitFor({ state: "detached" });
    assert.equal(world.status().slices[0].status, "approved_for_engineering");
    await shot("08-slice-approved");
  });

  await step("create, approve and send a wave", async () => {
    await page.goto(`${host.origin}/#/waves`);
    await settle(page);
    await main().getByRole("button", { name: "Start a wave", exact: true }).click();
    await dialog().getByRole("checkbox", { name: new RegExp(SLICE) }).check();
    await dialog().getByRole("button", { name: "Create a wave with 1 slice" }).click();
    await dialog().waitFor({ state: "detached" });
    const card = main().getByRole("article", { name: "Delivery wave WAVE-001" });
    await card.getByRole("button", { name: "Approve WAVE-001" }).click();
    await dialog().getByRole("button", { name: "Approve WAVE-001" }).click();
    await dialog().waitFor({ state: "detached" });
    await main().getByRole("link", { name: "Review and send WAVE-001" }).click();
    await main().getByRole("heading", { level: 1, name: "Send WAVE-001 to engineering" }).waitFor();
    await settle(page);
    await main().getByRole("button", { name: "Send WAVE-001 to engineering…" }).click();
    await dialog().getByRole("button", { name: "Send WAVE-001" }).click();
    await main().getByText("WAVE-001 was sent to engineering").waitFor({ timeout: 120000 });
    await shot("09-sent");
  });

  await t.test("reload and host restart restored the interview faithfully", () => {
    assert.deepEqual(result.findings, []);
  });

  await step("the engine's state on disk", async () => {
    const status = world.status();
    const files = world.branchFiles("product/WAVE-001");
    const creates = world.gh().calls.filter((c) => c.argv[0] === "pr" && c.argv[1] === "create");
    result.final_state = {
      slice: status.slices[0],
      wave: status.waves[0],
      pull_requests: creates.length,
      branch_files: files,
      factory_authorized: status.factory_authorized,
    };
    save();
    assert.equal(status.slices[0].status, "approved_for_engineering");
    assert.equal(status.slices[0].open_questions, 0);
    assert.equal(status.waves[0].status, "approved_for_engineering");
    assert.equal(status.waves[0].sent, true);
    assert.equal(creates.length, 1);
    assert.deepEqual(files.filter((f) => !/^(product\/|specs\/slices\/)/.test(f)), []);
    assert.equal(status.factory_authorized, false);
    const p = await session.problems();
    // The host's port changed at the restart; both origins are the host's own.
    result.page_problems = { external: p.external.filter((u) => !u.startsWith("http://127.0.0.1:")), csp: p.csp, console: p.consoleErrors.map((m) => m.split("\n")[0]).filter((m) => !/status of 422/.test(m)) };
    save();
  });
});
