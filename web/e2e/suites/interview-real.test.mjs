// Opt-in, and it spends money: the interview UI against the person's real Claude Code.
// Start, receive one real parsed question, answer it, receive the next, stop.
//
//   E2E_REAL_CLAUDE=1 node --test web/e2e/suites/interview-real.test.mjs
//
// The host launches Claude exactly as it always does; this suite only uses the host's documented
// --budget-per-turn and --model flags to bound the spend (default $0.30 a turn on sonnet; override
// with E2E_REAL_BUDGET and E2E_REAL_MODEL). No permission-skipping flag is used anywhere.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { screenshots } from "../lib/env.mjs";
import { buildHost } from "../lib/build.mjs";
import { createWorld } from "../lib/world.mjs";
import { startHost } from "../lib/host.mjs";
import { openBrowser, settle, shoot, watchedPage } from "../lib/app.mjs";

const enabled = process.env.E2E_REAL_CLAUDE === "1";
const FOLDER = "interview-real";
let binary, world, host, browser, session, page;
const result = { turns: [], cost_usd: null, questions: [], notes: [] };

before(async () => {
  if (!enabled) return;
  ({ binary } = buildHost());
  world = createWorld({ claude: "real" });
  for (const argv of [
    ["project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together without friction.", "--outcome", "Teams can work together"],
    ["epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join"],
    ["epic", "approve", "EPIC-001"],
  ]) {
    const r = world.studio(world.pm, ...argv);
    if (r.code !== 0) throw new Error(r.stderr);
  }
  host = await startHost(binary, world.pm, world.env, ["--budget-per-turn", process.env.E2E_REAL_BUDGET || "0.30", "--model", process.env.E2E_REAL_MODEL || "sonnet"]);
  browser = await openBrowser();
  session = await watchedPage(browser, host.origin);
  page = session.page;
});

after(async () => {
  if (!enabled) return;
  mkdirSync(join(screenshots, FOLDER), { recursive: true });
  writeFileSync(join(screenshots, FOLDER, "result.json"), JSON.stringify(result, null, 2));
  await browser?.close();
  await host?.stop();
  world?.cleanup();
});

test("real claude: start, one parsed question, answer, the next, stop", { skip: !enabled && "set E2E_REAL_CLAUDE=1 to run (spends money)" }, async (t) => {
  const main = () => page.getByRole("main");
  await page.goto(host.url, { waitUntil: "networkidle" });
  const capability = await page.evaluate(async () => (await (await fetch("/api/session")).json()).data.capabilities);
  result.capability = capability;
  if (!capability.interview) return t.skip(`the host says the interview is unavailable: ${capability.interview_reason}`);

  await t.test("start a slice and open the interview", async () => {
    await page.goto(`${host.origin}/#/roadmap`);
    await settle(page);
    await main().getByRole("button", { name: "Start a slice" }).first().click();
    await page.getByRole("dialog").getByRole("textbox", { name: "Title" }).fill("Invite a teammate");
    await page.getByRole("dialog").getByRole("textbox", { name: /The idea/ }).fill("A workspace admin invites one teammate by email; a seat is held for them.");
    await page.getByRole("dialog").getByRole("button", { name: "Start and open the interview" }).click();
    await page.waitForURL(/interview$/);
    await main().getByRole("button", { name: "Start the interview" }).click();
  });

  const current = async () => (await page.evaluate(async () => (await fetch(`/api/interview?slice_id=SLICE-001`)).json())).data.interview;
  /** Polls the host until the turn in progress has finished and `turns` reached n. */
  const turnsDone = async (n, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const i = await current();
      if (i && !i.turn_running && i.turns >= n && i.state === "waiting_for_reply") return i;
      await page.waitForTimeout(2000);
    }
    throw new Error(`turn ${n} did not finish within ${ms / 1000}s: ${JSON.stringify(await current()).slice(0, 300)}`);
  };
  const questionCard = () => main().getByRole("region").filter({ has: page.getByRole("button", { name: "Yes, accept" }) }).last();
  await t.test("receive one real, parsed question", async () => {
    await page.getByRole("button", { name: "Yes, accept" }).waitFor({ timeout: 240000 });
    const state = await turnsDone(1, 60000);
    const card = questionCard();
    const text = (await card.innerText()).replace(/\s+/g, " ").slice(0, 600);
    result.questions.push({ shown: text, engine_text: state.last_message?.text?.slice(-400) });
    await shoot(page, FOLDER, "01-first-question");
    result.turns.push({ after: "first", state: state.state, session_cost: state.session_cost_usd, kind: state.last_message?.kind, live_question_field: state.last_message?.question ?? null });
    assert.equal(state.last_message?.kind, "question", JSON.stringify(state.last_message).slice(0, 400));
    await card.getByText("Recommended", { exact: true }).waitFor();
    assert.ok((await card.getByRole("heading").count()) > 0, "the question card has the parsed title as a heading");
  });

  await t.test("answer it and receive the next", async () => {
    await page.getByRole("button", { name: "Yes, accept" }).click();
    const state = await turnsDone(2, 300000);
    await settle(page);
    result.turns.push({ after: "second", state: state.state, session_cost: state.session_cost_usd, kind: state.last_message?.kind });
    result.questions.push({ engine_text: (state.last_message?.text || "").slice(-600) });
    await shoot(page, FOLDER, "02-next-message");
    assert.ok(["question", "confirmation", "other"].includes(state.last_message?.kind));
    if (state.last_message?.kind === "question") await page.getByRole("button", { name: "Yes, accept" }).waitFor();
  });

  await t.test("stop", async () => {
    await main().getByRole("button", { name: "Stop" }).click();
    const confirm = page.getByRole("dialog");
    if (await confirm.count()) await confirm.getByRole("button", { name: /Stop/ }).last().click();
    let state = await current();
    for (let i = 0; i < 30 && state?.live; i++) {
      await page.waitForTimeout(1000);
      state = await current();
    }
    assert.ok(!state?.live, "the interview ended");
    result.cost_usd = state?.session_cost_usd ?? null;
    result.final = { state: state?.state, turns: state?.turns };
    await shoot(page, FOLDER, "03-stopped");
    t.diagnostic(`session cost $${result.cost_usd}`);
    // Nothing the person must do was done by the interviewer.
    const status = world.status();
    assert.notEqual(status.slices[0].status, "approved_for_engineering");
    assert.equal(status.waves.length, 0);
  });

  await t.test("no console error, CSP violation or outside request", async () => {
    const p = await session.problems();
    assert.deepEqual({ external: p.external, csp: p.csp, console: p.consoleErrors.filter((m) => !/status of 422/.test(m)) }, { external: [], csp: [], console: [] });
  });
});
