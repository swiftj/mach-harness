/* global document */
// The Timeline over a real mach-observer serving a small synthetic history (mach-synth: 12 cells,
// 12,000 events, seed 7, six hours). The generator's summary names each feature (which ticket has
// a failed verification, which execution was interrupted, ...), so the tests look for those, not
// for positions. Assertions read what a person can perceive: the table (the canvas's structured
// twin), the inspector, the lenses, the hooks and the address. Cases 1-9, 11, 12 and 15 of the brief.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiOffenders,
  clockMs,
  cols,
  consoleErrors,
  expandTable,
  hooks,
  inspectorText,
  isOpenRow,
  launch,
  openApp,
  readTable,
  scratch,
  selectTableRow,
  sleep,
  spanRows,
  startObserver,
  subtree,
  synthProject,
  timelineReady,
  WS,
  ensureStack,
} from "../scripts/timeline-e2e-lib.mjs";

const PORT = 4240;
/** A condition the design promises; the message names the finding a failure waits on. */
const check = (ok, id, message) => assert.ok(ok, `${message} [${id}]`);

let browser;
let obs;
let summary;
const pages = [];
let product = null; // rows of the product grouping, every track open
let execution = null; // rows of the execution grouping, the featured executions open

async function open(hash, opts) {
  const { page, context } = await openApp(browser, obs, hash, opts);
  pages.push(page);
  return { page, context };
}

before(async () => {
  await ensureStack();
  const made = synthProject("synthetic", { cells: 12, events: 12000, seed: 7, hours: 6 });
  summary = made.summary;
  obs = await startObserver(made.dir, PORT);
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await obs?.stop();
});

async function productRows() {
  if (product) return product;
  const { page, context } = await open("#timeline?table=1", { height: 1400 });
  await expandTable(page);
  product = await readTable(page);
  dump("product", product);
  await context.close();
  return product;
}

async function executionRows() {
  if (execution) return execution;
  const f = summary.features;
  const ids = [f.interrupted_execution, f.outcome_unknown_execution, f.arrival_only_stream, f.open_execution].filter(Boolean);
  const { page, context } = await open("#timeline?group=execution&table=1", { height: 1400 });
  // Every execution track, then everything under the featured ones.
  await expandTable(page, { match: new RegExp(`^track:execution:[^/]+$|${ids.join("|")}`), maxPasses: 6 });
  execution = await readTable(page);
  dump("execution", execution);
  await context.close();
  return execution;
}

/** The rows read, kept beside the run for a person looking into a failure. */
const dump = (name, rows) => writeFileSync(join(scratch, `rows-${name}.txt`), rows.map((r) => `${r.level} ${r.key} :: ${r.text}`).join("\n"));

const ticketOf = (r) => /SYN-\d{3}/.exec(r.text)?.[0] ?? null;

describe("Timeline over a synthetic history (real observer)", () => {
  test("the workspace becomes ready with the hooks the suite relies on", async () => {
    const { page, context } = await open("#timeline");
    const h = await hooks(page);
    assert.ok(h.ready, "data-timeline-ready never set");
    assert.ok(h.spans > 0, `data-timeline-spans is ${h.spans}`);
    check(/^\d+-\d+$/.test(h.window ?? ""), "r4-workspace", `data-timeline-window is ${JSON.stringify(h.window)}, not "<from>-<to>"`);
    check(h.groupingAttr === "product", "r4-workspace", `data-timeline-grouping on the workspace is ${JSON.stringify(h.groupingAttr)}`);
    check(h.sceneReady, "r4-workspace", "no [data-scene-ready] on the shell");
    await context.close();
  });

  test("(1) several cells are at work at once, and the concurrency lens says how many", async () => {
    const rows = await productRows();
    const cells = spanRows(rows, "cell").map((r) => ({ t: ticketOf(r), from: clockMs(cols(r).started), to: isOpenRow(r) ? Infinity : clockMs(cols(r).ended) }));
    assert.ok(cells.length >= 10, `only ${cells.length} cell spans in the table`);
    let most = 0;
    for (const c of cells) most = Math.max(most, cells.filter((d) => d.from <= c.from && d.to > c.from).length);
    assert.ok(most >= 2, `no two cell spans overlap (most at once: ${most})`);
    const { page, context } = await open("#timeline?lens=concurrency");
    const band = page.locator("[data-timeline-band=concurrency]");
    await band.waitFor({ timeout: 15000 });
    await sleep(800);
    const text = await band.innerText();
    const m = /executions running\s+(\d+)\s+at most/i.exec(text);
    assert.ok(m, `the concurrency lens does not say how many executions ran at once:\n${text.slice(0, 400)}`);
    assert.ok(Number(m[1]) >= 2 && Number(m[1]) <= summary.max_parallel, `executions at once: ${m[1]} (limit ${summary.max_parallel})`);
    await context.close();
  });

  test("(2) the Execution grouping nests workflow, agents lane and agent spans under the execution", async () => {
    const rows = await executionRows();
    const execs = rows.filter((r) => /^track:execution:[^/]+$/.test(r.key ?? ""));
    assert.ok(execs.length >= summary.executions - 2, `${execs.length} execution tracks for ${summary.executions} executions`);
    const x = summary.features.interrupted_execution;
    const under = subtree(rows, `track:execution:${x}`);
    const wf = under.find((r) => r.key?.startsWith(`track:workflow:${x}/`) && !r.key.endsWith("/agents"));
    assert.ok(wf, `no workflow track under execution ${x}`);
    const lane = under.find((r) => r.key === `${wf.key}/agents`);
    assert.ok(lane && lane.level === wf.level + 1, `no agents lane under ${wf.key}`);
    const agents = subtree(rows, lane.key).filter((r) => r.key.startsWith("span:agent:"));
    assert.ok(agents.length >= 5 && agents.every((a) => a.level === lane.level + 1), `${agents.length} agent spans under the lane`);
    // Each execution row says what distinguishes it: the ticket, its run among the cell's runs, its start.
    check(execs.every((r) => /SYN-\d{3} · run \d+\/\d+/.test(r.text)), "X7", `execution labels do not all say "<ticket> · run n/m": ${execs.slice(0, 3).map((r) => cols(r).track).join(" / ")}`);
  });

  test("(3) a count-only agent shows its count, says the calls are not observable one by one, and has no tool rows", async () => {
    const rows = await executionRows();
    const lanes = rows.filter((r) => r.key?.endsWith("/agents") && r.key.startsWith("track:workflow:"));
    assert.ok(lanes.length, "no agents lane in the execution grouping");
    const counted = rows.filter((r) => r.key?.startsWith("span:agent:") && /\d+ tool calls?, not observable one by one/.test(r.text));
    assert.ok(counted.length > 0, "no agent says its tool calls are not observable one by one");
    for (const lane of lanes) {
      const tools = subtree(rows, lane.key).filter((r) => r.key.startsWith("span:tool:") || r.key.startsWith("track:tool"));
      assert.equal(tools.length, 0, `tool rows invented under the count-only agents of ${lane.key}: ${tools.map((t) => t.key).join(", ")}`);
    }
    check(lanes.some((l) => /not observable one by one/.test(l.text)), "design 4", "no agents lane label says the calls are counted, not observable one by one");
  });

  test("(4) a failed verification, then the remediation: rows in order and the retries lens ladder", async () => {
    const rows = await productRows();
    const t = summary.tickets.find((x) => spanRows(rows, "visit").some((r) => r.key.includes(`${x}/verify#1`) && /fail/i.test(cols(r).outcome)));
    assert.ok(t, "no cell whose first verification failed");
    const visits = spanRows(rows, "visit").filter((r) => r.key.includes(`visit:${t}/`));
    const v1 = visits.find((r) => r.key.endsWith("/verify#1"));
    const v2 = visits.find((r) => r.key.endsWith("/verify#2"));
    const revise = visits.find((r) => /revise/i.test(cols(r).what) && clockMs(cols(r).started) >= clockMs(cols(v1).ended));
    assert.ok(v2 && /pass/i.test(cols(v2).outcome), `${t}: no passing second verification`);
    assert.ok(revise, `${t}: no revise visit after the failed verification`);
    assert.ok(clockMs(cols(revise).ended) <= clockMs(cols(v2).started), `${t}: the revise visit does not come before the second verification`);
    const { page, context } = await open(`#timeline?lens=retries&sel=cell:${t}`);
    const band = page.locator("[data-timeline-band=retries]");
    await band.waitFor({ timeout: 15000 });
    await sleep(800);
    const text = await band.innerText();
    const block = text.slice(text.indexOf(t));
    assert.ok(text.includes(t), `the retries lens does not show ${t}`);
    assert.match(block, /Pass 1[\s\S]*Verify[\s\S]*failed[\s\S]*revise[\s\S]*Pass 2[\s\S]*Verify[\s\S]*passed/i, `the ladder for ${t} does not read pass 1 failed, revise, pass 2 passed:\n${block.slice(0, 400)}`);
    await context.close();
  });

  test("(4b) selecting the failed verification makes it the inspector's subject", async () => {
    const t = (await productRows()) && summary.tickets.find((x) => product.some((r) => r.key === `span:visit:visit:${x}/verify#1` && /fail/i.test(cols(r).outcome)));
    const { page, context } = await open(`#timeline?table=1`, { height: 1400 });
    await expandTable(page, { match: new RegExp(t) });
    const row = await selectTableRow(page, (r) => r.key === `span:visit:visit:${t}/verify#1`);
    assert.ok(row, `no row for ${t}'s first verification`);
    const text = await inspectorText(page);
    check(/fail/i.test(text.slice(0, 600)), "X3", `the inspector does not say the selected verification failed:\n${text.slice(0, 600)}`);
    check(!/\bpass(ed)?\b/i.test(text.slice(0, 300)), "X3", `the inspector headlines a pass for the failed verification:\n${text.slice(0, 300)}`);
    await context.close();
  });

  test("(5) several review rounds, each with its seats and verdicts", async () => {
    const rows = await productRows();
    const rounds = spanRows(rows, "round");
    const t = summary.tickets.find((x) => rounds.filter((r) => r.key.includes(`${x}/round#`)).length >= 2 && rounds.some((r) => r.key.includes(`${x}/round#1`) && /reject/i.test(cols(r).outcome)));
    assert.ok(t, "no cell with a rejected round followed by another");
    const mine = rounds.filter((r) => r.key.includes(`${t}/round#`));
    assert.ok(mine.some((r) => /approved/i.test(cols(r).outcome)), `${t}: no approved round`);
    for (const n of [1, 2]) {
      const seats = spanRows(rows, "seat").filter((r) => r.key.includes(`${t}/review#${n}/`));
      assert.ok(seats.length >= 3, `${t} round ${n}: ${seats.length} seats`);
      assert.ok(seats.every((s) => /approve|reject|block/i.test(cols(s).outcome)), `${t} round ${n}: a seat without a verdict`);
    }
    const { page, context } = await open(`#timeline?lens=review&sel=cell:${t}`);
    const band = page.locator("[data-timeline-band=review]");
    await band.waitFor({ timeout: 15000 });
    await sleep(800);
    const text = await band.innerText();
    assert.match(text, new RegExp(`${t} · Round 1[\\s\\S]*Rejected[\\s\\S]*${t} · Round 2[\\s\\S]*Approved`), `the review lens does not show ${t}'s two rounds and decisions`);
    await context.close();
  });

  test("(6) a wait on a person: one resolved, one still open (waiting, never 'took')", async () => {
    const rows = await productRows();
    const { human_wait_closed: closed, human_wait_open: open_ } = summary.features;
    const waits = spanRows(rows, "person-wait");
    const c = waits.find((r) => r.text.includes(closed));
    const o = waits.find((r) => r.text.includes(open_));
    assert.ok(c, `no person-wait row for ${closed}`);
    assert.ok(o, `no person-wait row for ${open_}`);
    assert.ok(!isOpenRow(c) && /waited/.test(cols(c).duration), `${closed}: the resolved wait reads "${cols(c).duration}"`);
    assert.ok(isOpenRow(o), `${open_}: the open wait has an end: ${cols(o).ended}`);
    assert.match(cols(o).duration, /waiting/i, `${open_}: the open wait reads "${cols(o).duration}"`);
    assert.doesNotMatch(o.text, /\btook\b/, `${open_}: an open wait "took" a duration`);
  });

  test("(7) dependency-blocked work, and what released it (or that the cause is not recorded)", async () => {
    const rows = await productRows();
    const { blocked_several_times_slice: several, blocked_at_end_slice: atEnd } = summary.features;
    const waits = spanRows(rows, "slice-wait");
    const s = waits.filter((r) => r.key.includes(`slice:${several}`));
    assert.ok(s.length >= 2 && s.every((r) => !isOpenRow(r)), `${several}: ${s.length} closed dependency waits`);
    const e = waits.find((r) => r.key.includes(`slice:${atEnd}`));
    check(e && isOpenRow(e) && /waiting/i.test(cols(e).duration), "new: a slice with no cell", `${atEnd}: no open dependency wait on the tracks (${e?.text ?? "the slice is not in the product tree at all"})`);
    const { page, context } = await open(`#timeline?lens=waits`);
    const band = page.locator("[data-timeline-band=waits]");
    await band.waitFor({ timeout: 15000 });
    await sleep(800);
    const text = await band.innerText();
    const blk = text.slice(text.indexOf(several), text.indexOf(several) + 300);
    assert.match(blk, /blocked [2-9]×/, `${several}: the waits lens does not count its waits:\n${blk}`);
    assert.match(blk, /SLICE-\d{3} merged/, `${several}: the waits lens does not name what was integrated before it went on`);
    assert.match(text, /do not say which event released it|not recorded|not named/i, "the waits lens does not say that the release cause is not recorded");
    const end = text.slice(text.indexOf(atEnd), text.indexOf(atEnd) + 200);
    assert.match(end, /still waiting/i, `${atEnd}: the waits lens does not say it is still waiting`);
    await context.close();
  });

  test("(8) interrupted and recovered; an unknown outcome is never running or completed", async () => {
    const rows = await executionRows();
    // Every condition is checked; the failures are reported together.
    const failed = [];
    const check = (ok, id, message) => ok || failed.push(`${message} [${id}]`);
    const { interrupted_execution: xi, outcome_unknown_execution: xu } = summary.features;
    const ei = rows.find((r) => r.key === `span:execution:execution:${xi}`);
    assert.ok(ei, `no span row for the interrupted execution ${xi}`);
    check(/interrupt/i.test(ei.text), "design 5: an interrupted span says so", `the interrupted execution does not say it was interrupted: ${cols(ei).what}`);
    check(!/\btook\b/.test(ei.text), "design 5: an interrupted span never 'took'", `the interrupted execution "took" a duration: ${cols(ei).what}`);
    const ticket = ticketOf(ei);
    const later = rows.filter((r) => /^track:execution:[^/]+$/.test(r.key) && r.text.includes(`${ticket} · run`) && clockMs(cols(r).started) > clockMs(cols(ei).ended));
    assert.ok(later.length >= 1, `${ticket}: no later execution took the work up`);
    const iOpen = subtree(rows, `track:execution:${xi}`).filter((r) => r.key.startsWith("span:") && isOpenRow(r));
    check(iOpen.length === 0, "T1", `under the interrupted execution ${xi}, ${iOpen.length} spans still read as running: ${iOpen.slice(0, 2).map((r) => cols(r).what).join(" / ")}`);

    const eu = rows.find((r) => r.key === `span:execution:execution:${xu}`);
    assert.ok(eu, `no span row for the execution of unknown outcome ${xu}`);
    // Its process record says interrupted and the supervisor recorded outcome-unknown: since M6.3 polish
    // it reads "interrupted" (the process record outranks the recovery, as on the Factory Floor; shared
    // contracts 2.3). Either way it is never running or completed.
    assert.match(eu.text, /outcome not known|interrupted/i);
    assert.doesNotMatch(cols(eu).outcome, /finished|completed|done|passed/i, `unknown outcome shown as ${cols(eu).outcome}`);
    assert.ok(!isOpenRow(eu) && !/running/i.test(eu.text), `the unknown-outcome execution reads as running: ${cols(eu).what}`);
    const uRunning = subtree(rows, `track:execution:${xu}`).filter((r) => /running/i.test(r.text) || (r.key.startsWith("span:") && isOpenRow(r)));
    check(uRunning.length === 0, "T1", `under the execution of unknown outcome ${xu}, ${uRunning.length} rows read as running: ${uRunning.slice(0, 2).map((r) => cols(r).what || cols(r).track).join(" / ")}`);
    check(!/running|outcome not known · .*running/i.test(rows.find((r) => r.key === `track:execution:${xu}`)?.text ?? ""), "T1", "the unknown execution's track reads as running");
    assert.deepEqual(failed, [], failed.join("\n"));
  });

  test("(9) the deliberate gap in the history is shown as a gap", async () => {
    const { page, context } = await open("#timeline");
    // The jump menu offers gaps; jumping to the next one from the start of the history puts it in words.
    await page.keyboard.press("Home");
    await sleep(400);
    const jump = page.locator(`${WS} [role=toolbar] button[title^="Jump to"]`).first();
    assert.ok(await jump.count(), "no jump menu in the toolbar");
    await jump.click();
    const next = page.getByRole("button", { name: /^Next gap/i }).first();
    check((await next.count()) > 0, "design 3D", "the jump menu offers no gaps");
    await next.click();
    await sleep(1500);
    const said = await page.evaluate(() => [...document.querySelectorAll("[aria-live], [role=status], [role=alert], [data-inspector], [data-announcer]")].map((e) => e.textContent).join(" \n "));
    check(/gap|missing|not (held|recorded)/i.test(said), "design 3A", `jumping to the next gap says nothing about a gap:\n${said.slice(0, 600)}`);
    check(/No later gap/i.test(said) === false, "design 3A", "the jump menu finds no gap in a history that has one");
    // The overview names it for a screen reader too (the hatched column is its drawing).
    const overview = await page.evaluate((ws) => document.querySelector(`${ws} section[aria-label="Whole history"]`)?.innerText + " " + [...document.querySelectorAll(`${ws} section[aria-label="Whole history"] [aria-label], ${ws} section[aria-label="Whole history"] [title]`)].map((e) => e.getAttribute("aria-label") + " " + (e.getAttribute("title") ?? "")).join(" "), WS);
    check(/gap|missing/i.test(overview), "design 3A", "the overview says nothing of the gap in history");
    await context.close();
  });

  test("(11) open spans say open or waiting, never a duration that 'took'; open containers are never 'running'", async () => {
    const rows = await productRows();
    const open_ = rows.filter((r) => r.key?.startsWith("span:") && isOpenRow(r));
    assert.ok(open_.length > 0, "no open span in the history (the synthetic history has several)");
    const took = open_.filter((r) => /\btook\b/.test(cols(r).duration) || /\btook\b/.test(cols(r).what));
    assert.equal(took.length, 0, `open spans that "took": ${took.map((r) => r.key).join(", ")}`);
    const containers = open_.filter((r) => /^span:(wave|slice|cell|round):/.test(r.key));
    const running = containers.filter((r) => /running|at work/i.test(r.text));
    check(running.length === 0, "X2", `open containers called running: ${running.map((r) => `${r.key}: ${cols(r).duration}`).join("; ")}`);
    assert.ok(containers.every((r) => /open/i.test(cols(r).duration)), `an open container whose duration does not say open: ${containers.find((r) => !/open/i.test(cols(r).duration))?.text}`);
  });

  test("(12) bounded and inferred times are worded as such", async () => {
    const rows = [...(await productRows()), ...(await executionRows())];
    const bounded = rows.filter((r) => r.key?.startsWith("span:") && /between/i.test(cols(r).started + cols(r).ended));
    const inferred = rows.filter((r) => r.key?.startsWith("span:") && /≈|about/.test(cols(r).started + cols(r).ended));
    assert.ok(bounded.length > 0, "no span with a bounded end in the table");
    assert.ok(inferred.length > 0, "no span with an inferred end in the table");
    const badB = bounded.filter((r) => /^took\b/.test(cols(r).duration));
    assert.equal(badB.length, 0, `bounded spans measured as "took": ${badB.slice(0, 3).map((r) => `${r.key}: ${cols(r).duration}`).join("; ")}`);
    const badI = inferred.filter((r) => !/about|≈|placed by rule|within|between|open|running|waiting/i.test(cols(r).duration));
    assert.equal(badI.length, 0, `inferred spans worded as measured: ${badI.slice(0, 3).map((r) => `${r.key}: ${cols(r).duration}`).join("; ")}`);
  });

  test("(15) scrubbed back: no future outcome in the inspector, and the tracks say they are as of the live edge", async () => {
    const rows = await productRows();
    const cell = spanRows(rows, "cell").find((r) => /merged/i.test(cols(r).outcome));
    const t = ticketOf(cell);
    const startMs = summary.start_ms + clockMs(cols(cell).started);
    const endMs = summary.start_ms + clockMs(cols(cell).ended);
    const at = Math.round((startMs + endMs) / 2);
    const { page, context } = await open(`#timeline?sel=cell:${t}&at=${at}&table=1`);
    await sleep(1500);
    const text = await inspectorText(page);
    assert.ok(text.includes(t), `the inspector does not show ${t}`);
    assert.doesNotMatch(text, /\bmerged\b/i, `scrubbed to before ${t} merged, the inspector already says merged`);
    const caption = await page.evaluate((ws) => document.querySelector(`${ws} [data-timeline-table]`)?.innerText.slice(0, 400) ?? "", WS);
    check(/as of the live edge/i.test(caption), "T6", `the table does not say it is as of the live edge while the playhead is back:\n${caption.slice(0, 200)}`);
    const tracks = await page.evaluate((ws) => document.querySelector(ws)?.innerText ?? "", WS);
    check(/after the playhead/i.test(tracks), "T6", "nothing labels the region after the playhead");
    await context.close();
  });

  test("every /api request is a GET to 127.0.0.1, and no console errors", () => {
    const bad = pages.flatMap(apiOffenders);
    assert.deepEqual(bad, [], `non-GET or non-loopback API requests: ${JSON.stringify(bad.slice(0, 5))}`);
    assert.ok(pages.some((p) => p.requests.some((r) => r.url.includes("/api/v1/spans"))), "the pages never asked the observer for spans");
    const errors = pages.flatMap(consoleErrors);
    assert.deepEqual(errors, [], `console errors: ${errors.slice(0, 5).join(" | ")}`);
  });
});

void timelineReady;
