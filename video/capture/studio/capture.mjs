// Records the four Product Studio clips for the demo film into video/public/footage/.
//
//   node video/capture/studio/capture.mjs            all four, in order (they share one scripted world)
//   node video/capture/studio/capture.mjs home       just one: home | interview | spec | ready
//                                                    (spec and ready need the interview's world, so
//                                                     they run it first, without keeping its footage)
//
// The world is the e2e one: the real Go host and engine, a stand-in `gh`, a scripted stand-in `claude`.
import { glide, clip, openBrowser, probe, startStudio, INTERVIEW_SLICE } from "./lib.mjs";

const wanted = process.argv.slice(2);
const want = (n) => wanted.length === 0 || wanted.includes(n);

const studio = await startStudio();
const results = [];
try {
  const { browser, state } = await openBrowser(studio);
  const base = { browser, state, studio };
  const main = (page) => page.getByRole("main");

  // 1. The project home -------------------------------------------------------------------------
  if (want("home")) {
    results.push(
      await clip({
        ...base,
        name: "studio-home",
        route: "/",
        ready: (page) => page.getByRole("heading", { name: "Team Space" }).first().waitFor(),
        body: async (rec, page, t) => {
          t.mark("home shown");
          await rec.hover(page.getByRole("heading", { name: "Accounts and sign-in" }), { timeout: 10000 });
          await rec.wait(500);
          t.mark("scroll down starts");
          await glide(page, 1, 3600);
          t.mark("bottom reached");
          await rec.wait(500);
          t.mark("scroll up starts");
          await glide(page, 0.3, 2600);
          t.mark("scrolled back up to the first epic's slices");
          await rec.hover(page.getByText("Ask for a second step at sign-in"));
          t.mark("cursor rests on a slice (being built)");
          await rec.wait(1100);
        },
      }),
    );
  }

  // 2. The guided interview ---------------------------------------------------------------------
  const needInterview = want("interview") || want("spec") || want("ready");
  if (needInterview) {
    results.push(
      await clip({
        ...base,
        name: want("interview") ? "studio-interview" : "studio-interview-unused",
        route: `/slices/${INTERVIEW_SLICE}/interview`,
        compress: [
          ["clicked Start the interview", "Q1 (Who it is for) with its recommendation appears", 1.0],
          ["clicked Yes, write it up", "spec written; engine check says ready", 1.2],
        ],
        ready: (page) => page.getByRole("button", { name: "Start the interview" }).waitFor(),
        body: async (rec, page, t) => {
          const card = (title) => main(page).getByRole("region", { name: title });
          t.mark("interview page, not started");
          await rec.wait(900);
          await rec.click(page.getByRole("button", { name: "Start the interview" }).first());
          t.mark("clicked Start the interview");
          await card("Who it is for").waitFor({ timeout: 60000 });
          await rec.wait(150);
          t.mark("Q1 (Who it is for) with its recommendation appears");
          await rec.hover(card("Who it is for").getByText("Recommended"));
          await rec.wait(2600);
          await rec.click(card("Who it is for").getByRole("button", { name: "Yes, accept" }));
          t.mark("clicked Yes, accept on Q1");
          await card("How long an invitation lasts").waitFor({ timeout: 60000 });
          await rec.wait(150);
          t.mark("Q2 (How long an invitation lasts) appears");
          await rec.hover(card("How long an invitation lasts").getByText("Recommended"));
          await rec.wait(2400);
          await rec.click(card("How long an invitation lasts").getByRole("button", { name: "Yes, accept" }));
          t.mark("clicked Yes, accept on Q2");
          await card("An address that is already a member").waitFor({ timeout: 60000 });
          await rec.wait(150);
          t.mark("Q3 (An address that is already a member) appears");
          await rec.hover(card("An address that is already a member").getByText("Recommended"));
          await rec.wait(2400);
          await rec.click(card("An address that is already a member").getByRole("button", { name: "Yes, accept" }));
          t.mark("clicked Yes, accept on Q3");
          const writeIt = main(page).getByRole("button", { name: "Yes, write it up" });
          await writeIt.waitFor({ timeout: 60000 });
          await rec.wait(150);
          t.mark("summary to confirm appears");
          await rec.hover(main(page).getByText("Summary to confirm"));
          await rec.wait(2800);
          await rec.click(writeIt);
          t.mark("clicked Yes, write it up");
          await main(page).getByText("ready for you to approve").waitFor({ timeout: 60000 });
          await rec.wait(150);
          t.mark("spec written; engine check says ready");
          await rec.wait(2200);
        },
      }),
    );
  }

  // 3. The written specification ----------------------------------------------------------------
  if (want("spec")) {
    results.push(
      await clip({
        ...base,
        name: "studio-spec",
        route: `/slices/${INTERVIEW_SLICE}`,
        ready: (page) => page.getByRole("heading", { level: 1, name: "Invite a teammate" }).waitFor(),
        body: async (rec, page, t) => {
          t.mark("specification top");
          await rec.hover(page.getByRole("heading", { level: 1, name: "Invite a teammate" }));
          await rec.wait(700);
          for (const [heading, ms, hold] of [
            ["Rules that always hold", 1100, 500],
            ["What the product does", 1100, 600],
            ["Decision table", 1200, 700],
            ["Examples to test", 1200, 800],
          ]) {
            t.mark(`scrolls to "${heading}"`);
            await glide(page, page.getByRole("heading", { name: heading }).first(), ms);
            await rec.wait(hold);
          }
          t.mark("end");
        },
      }),
    );
  }

  // 4. Mark ready to build ----------------------------------------------------------------------
  if (want("ready")) {
    results.push(
      await clip({
        ...base,
        name: "studio-ready",
        route: `/slices/${INTERVIEW_SLICE}`,
        compress: [
          ["clicked Mark ready to build in the dialog", "result dialog with the issue link appears", 1.1],
          ["clicked Done", "end: slice shows its issue number", 1.8],
        ],
        ready: (page) => page.getByRole("button", { name: "Mark ready to build" }).first().waitFor(),
        body: async (rec, page, t) => {
          t.mark("slice page");
          await rec.wait(600);
          await rec.click(main(page).getByRole("button", { name: "Mark ready to build" }));
          const confirm = page.getByRole("dialog", { name: `Mark ${INTERVIEW_SLICE} ready to build?` });
          await confirm.waitFor();
          t.mark("confirmation dialog (names the epic) opens");
          await rec.hover(confirm.getByText("Team membership", { exact: false }).first());
          await rec.wait(1700);
          await rec.click(confirm.getByRole("button", { name: "Mark ready to build" }));
          t.mark("clicked Mark ready to build in the dialog");
          const done = page.getByRole("dialog", { name: `${INTERVIEW_SLICE} is ready to build` });
          await done.waitFor({ timeout: 60000 });
          await rec.wait(150);
          t.mark("result dialog with the issue link appears");
          await rec.hover(done.getByRole("link", { name: /^#\d+/ }));
          await rec.wait(2100);
          await rec.click(done.getByRole("button", { name: "Done" }));
          t.mark("clicked Done");
          await main(page).getByRole("button", { name: `Reopen ${INTERVIEW_SLICE}` }).waitFor();
          await rec.wait(1200);
          t.mark("end: slice shows its issue number");
        },
      }),
    );
  }

  await browser.close();
} finally {
  await studio.stop();
}

for (const r of results) {
  const p = probe(r.mp4);
  console.log(`\n${r.mp4}\n  ${p.width}x${p.height} ${p.codec_name} ${p.pix_fmt} ${p.duration.toFixed(2)} s`);
  for (const m of r.marks) console.log(`  ${m.t.toFixed(1).padStart(5)} s  ${m.label}`);
}
import { rmSync } from "node:fs"; import { footageDir } from "./lib.mjs"; import { join } from "node:path"; rmSync(join(footageDir, "studio-interview-unused.mp4"), { force: true });
