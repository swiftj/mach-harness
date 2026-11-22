// Records the third film's Product Studio "Shape" clips into video/public/footage/.
//
//   (once)  cd web/apps/product-studio && pnpm exec vite --mode fixtures --port 5290 --strictPort
//   node video/capture/shape/capture.mjs                 all of them, in order
//   node video/capture/shape/capture.mjs board explore   just these: board | explore | brief | case | route | spec-rules | lookback
//
// World: Product Studio's fixture mode (sample data, no host, no engine, no claude). See lib.mjs for how the sample
// data is made to tell one idea's story. Light theme, 1920x1080, 30 fps, as the first two films' Studio clips.
import { clip, openBrowser, paneGlide, report, setQuery, cleanup, sleep, glide, IDEA, TITLE } from "./lib.mjs";

const wanted = process.argv.slice(2);
const want = (n) => wanted.length === 0 || wanted.includes(n);
const results = [];
const { browser } = await openBrowser();
const base = { browser };
const main = (page) => page.locator("main");
const here = `/shape/ideas/${IDEA}`;

try {
  // 1. The ideas board: columns, the pointer travels across and settles on the idea, opens it ----------------
  if (want("board")) {
    results.push(
      await clip({
        ...base,
        name: "shape-board",
        url: "?fixture=status.ideas#/shape",
        ready: (page) => page.getByText(TITLE).first().waitFor(),
        body: async (rec, page, t) => {
          t.mark("the board, five columns");
          await rec.wait(400);
          for (const col of ["New", "Exploring", "Brief written", "Decided", "Shaped into work"]) {
            await rec.hover(page.getByRole("heading", { level: 3, name: new RegExp("^" + col) }));
            t.mark(`pointer on ${col}`);
            await rec.wait(260);
          }
          await rec.hover(page.getByText(TITLE).first());
          t.mark("pointer settles on the idea");
          await rec.wait(1500);
          await rec.click(page.getByText(TITLE).first());
          t.mark("clicked the idea");
          await page.getByRole("button", { name: "Start the conversation" }).first().waitFor({ timeout: 15000 });
          await rec.wait(1200);
          t.mark("Explore opened");
        },
      }),
    );
  }

  // 2. Explore: one open question, an answer, then what MACH looked up -------------------------------------
  if (want("explore")) {
    results.push(
      await clip({
        ...base,
        name: "shape-explore",
        url: `?fixture=status.ideas#${here}/explore`,
        ready: (page) => page.getByRole("button", { name: "Start the conversation" }).first().waitFor(),
        compress: [["clicked Start the conversation", "the open question appears", 1.2]],
        body: async (rec, page, t) => {
          t.mark("Explore, conversation not started");
          await rec.wait(350);
          await rec.click(page.getByRole("button", { name: "Start the conversation" }).first());
          t.mark("clicked Start the conversation");
          const send = page.getByRole("button", { name: /Send (answer|reply)/ });
          const question = page.getByText(/What happens today that you would like to be different/).first();
          await question.waitFor({ timeout: 60000 });
          await rec.wait(150);
          t.mark("the open question appears");
          await rec.hover(question);
          t.mark("pointer on the question");
          await rec.wait(800);
          t.mark("start typing");
          await rec.type(page.locator("textarea").first(), "We get about 40 renewal calls a week at Central.", { delay: 26 });
          t.mark("answer typed");
          await rec.wait(300);
          await rec.click(send);
          t.mark("answer sent");
          await rec.wait(800);
          for (const group of [/What exists today/, /What is already wanted/, /What stands in the way/]) {
            const head = page.getByRole("button", { name: group });
            await rec.click(head);
            t.mark(`opened ${group.source}`);
            await paneGlide(head, 450, 14);
            await rec.wait(650);
          }
          await rec.wait(300);
        },
      }),
    );
  }

  // 3. The brief beside its check -----------------------------------------------------------------------
  const briefStage = "fixture=status.ideas-long-reason&idea=brief-written&brief=passes";
  if (want("brief")) {
    results.push(
      await clip({
        ...base,
        name: "shape-brief",
        url: `?${briefStage}#${here}/brief`,
        ready: (page) => page.getByText("Passes its check").first().waitFor(),
        body: async (rec, page, t) => {
          // The pill in the check pane (the stepper above says the same words, further up and to the right).
          const pills = page.getByText("Passes its check", { exact: true });
          const boxes = await Promise.all([...Array(await pills.count()).keys()].map((i) => pills.nth(i).boundingBox()));
          const check = pills.nth(boxes.findIndex((b) => b && b.y > 260 && b.x > 900));
          t.mark("the brief beside its check");
          await rec.wait(500);
          await rec.hover(check);
          t.mark("pointer on the check, passing");
          await rec.wait(700);
          await paneGlide(page.getByRole("heading", { name: "Outcomes" }).first(), 900, 20);
          t.mark("outcomes");
          await rec.hover(page.getByText(/renewal calls at Central fall/).first());
          await rec.wait(800);
          await rec.hover(page.getByText(/complaints about unexpected fines/).first());
          t.mark("how we would know, on each outcome");
          await rec.wait(800);
          await paneGlide(page.getByRole("heading", { name: "Assumptions" }).first(), 900, 20);
          t.mark("assumptions");
          await rec.hover(page.getByText("Assumed, not confirmed").first());
          t.mark("one marked assumed");
          await rec.wait(1100);
          await rec.hover(check);
          t.mark("back to the check");
          await rec.wait(1100);
        },
      }),
    );
  }

  // 4. The case: its hard questions, then the three equal verdicts; Go, a reason, recorded ----------------
  if (want("case")) {
    results.push(
      await clip({
        ...base,
        name: "shape-case",
        url: `?${briefStage}&case=all-answered#${here}/case`,
        ready: (page) => page.getByRole("button", { name: /^Your verdict/ }).waitFor(),
        body: async (rec, page, t) => {
          t.mark("the case page");
          await rec.wait(400);
          await rec.click(page.getByRole("button", { name: /^The case/ }).first());
          t.mark("the case opened");
          await paneGlide(page.getByRole("heading", { name: "The hard questions" }), 800, 16);
          await rec.hover(page.getByText("Who would not want this?"));
          await rec.wait(450);
          await rec.hover(page.getByText("What would make us stop?"));
          t.mark("the hard questions, answered");
          await rec.wait(350);
          await rec.click(page.getByRole("button", { name: /^Your verdict/ }));
          t.mark("verdict opened");
          for (const choice of ["Go", "No"]) {
            await rec.hover(page.getByRole("radio", { name: new RegExp("^" + choice + "\\b") }));
            await rec.wait(200);
          }
          t.mark("three equal choices");
          await rec.click(page.getByRole("radio", { name: /^Go\b/ }));
          t.mark("chose Go");
          await rec.type(page.locator("textarea").first(), "Members ask for it at every desk.", { delay: 22 });
          t.mark("reason typed");
          await rec.wait(250);
          await setQuery(page, "fixture=status.ideas-folder&idea=settled&brief=passes&case=all-answered");
          await rec.click(page.getByRole("button", { name: "Record the verdict" }));
          t.mark("clicked Record the verdict");
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          {
            t.mark("confirmation dialog");
            await rec.wait(600);
            await rec.click(dialog.getByRole("button", { name: /Record|Confirm|Go/ }).last());
            t.mark("confirmed");
          }
          await rec.wait(1500);
          t.mark("recorded");
        },
      }),
    );
  }

  // 5. Size and route: an epic, the map, apply, what was made --------------------------------------------
  if (want("route")) {
    results.push(
      await clip({
        ...base,
        name: "shape-route",
        url: `?fixture=status.ideas-folder&idea=folder&brief=passes#${here}/route`,
        ready: (page) => page.getByRole("button", { name: `Size ${IDEA}` }).waitFor(),
        body: async (rec, page, t) => {
          t.mark("not sized yet");
          await rec.wait(400);
          await setQuery(page, "fixture=status.ideas-settle&idea=settled&size=epic&brief=passes");
          await rec.click(page.getByRole("button", { name: `Size ${IDEA}` }));
          t.mark("clicked Size");
          await page.getByText("Route: an epic").first().waitFor({ timeout: 15000 });
          await rec.wait(500);
          t.mark("the route: an epic");
          await rec.hover(page.getByText("An epic", { exact: true }).first());
          await rec.wait(600);
          await rec.click(page.getByRole("button", { name: /^Map/ }));
          t.mark("the map opened");
          await paneGlide(page.getByRole("heading", { name: /Thin slices/ }), 700, 16);
          await rec.hover(page.getByText("Renew a loan from my loans").first());
          await rec.wait(400);
          await rec.hover(page.getByText("Renew from the catalogue").first());
          t.mark("the slices in order, each with the outcomes it carries");
          await rec.wait(900);
          const make = page.getByRole("button", { name: /^Make \d+ epics? and/ });
          await rec.click(page.getByRole("button", { name: /^Make the drafts/ }));
          await make.waitFor();
          await rec.wait(300);
          await setQuery(page, "fixture=status.ideas-shaped&idea=applied&brief=passes");
          await rec.click(make);
          t.mark("clicked Make the drafts");
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          await rec.wait(900);
          t.mark("confirmation dialog");
          await rec.click(dialog.getByRole("button", { name: /^Make/ }).last());
          t.mark("applied");
          await page.getByText(/EPIC-002/).first().waitFor({ timeout: 15000 });
          await rec.wait(2200);
          t.mark("the epic and slices made");
        },
      }),
    );
  }

  // 6. One slice's specification pages: principles, policy packs, design mocks, effects ------------------
  if (want("spec-rules")) {
    results.push(
      await clip({
        ...base,
        name: "studio-spec-rules",
        url: "?fixture=status.ideas-shaped&show=policy-followed&brief=passes#/slices/SLICE-005/policies",
        ready: (page) => page.getByText("Versions stay as published").waitFor(),
        body: async (rec, page, t) => {
          t.mark("principles and policies");
          await rec.wait(400);
          await rec.hover(page.getByText("Versions stay as published"));
          await rec.wait(300);
          await rec.click(page.getByText("Versions stay as published"));
          t.mark("a principle, answered and upheld");
          await rec.wait(1100);
          await rec.hover(page.getByText("Followed. Answered under version"));
          t.mark("a policy pack, followed");
          await rec.wait(900);
          await setQuery(page, "fixture=status.ideas-shaped&show=four-mocks&brief=passes");
          await rec.click(page.getByRole("link", { name: "Design mocks" }));
          await page.getByText("Picture 1").first().waitFor({ timeout: 15000 });
          t.mark("design mocks");
          await rec.hover(page.getByText("For AC-01: Member renews a loan").first());
          await rec.wait(1900);
          await setQuery(page, "fixture=status.ideas-shaped&show=effects&brief=passes");
          await rec.click(page.getByRole("link", { name: "Effects on shipped behaviour" }));
          await page.getByText("1 shipped rule touched").waitFor({ timeout: 15000 });
          t.mark("effects on shipped behaviour");
          await rec.hover(page.getByText("The system shall send the invitation by email."));
          await rec.wait(2300);
        },
      }),
    );
  }

  // 7. Look back: the chain, one outcome recorded as met ---------------------------------------------------
  if (want("lookback")) {
    results.push(
      await clip({
        ...base,
        name: "shape-lookback",
        url: `?fixture=status.ideas-look-back&idea=look-back&brief=passes#${here}/look-back`,
        ready: async (page) => {
          await page.getByText("Your look back on O-1").waitFor();
          await page.evaluate(() => document.querySelectorAll("*").forEach((e) => e.scrollTop && (e.scrollTop = 0)));
        },
        body: async (rec, page, t) => {
          t.mark("Look back, O-1 not recorded yet");
          await rec.wait(500);
          await rec.click(page.getByRole("radio", { name: /Met/ }));
          t.mark("chose Met");
          await rec.type(page.locator("textarea").first(), "Calls at Central were down to 11 a week by the start of March.", { delay: 10 });
          t.mark("note typed");
          await rec.wait(250);
          await setQuery(page, "fixture=status.ideas-look-back&idea=looked-back&chain=looked-back&brief=passes");
          await rec.click(page.getByRole("button", { name: /Record the look back on O-1/ }));
          t.mark("clicked Record the look back");
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          await rec.wait(450);
          await rec.click(dialog.getByRole("button", { name: "Record the look back" }));
          t.mark("confirmed");
          await dialog.waitFor({ state: "detached" });
          await rec.wait(450);
          t.mark("recorded");
          const row = page.getByRole("button", { name: /^O-1 Members renew/ });
          await paneGlide(row, 600, 20);
          await rec.wait(150);
          await rec.click(row);
          const chain = page.getByRole("heading", { name: /From O-1 to what shipped/ });
          await chain.waitFor();
          await paneGlide(chain, 900, 16);
          t.mark("the chain, from the outcome to the look back");
          await rec.hover(page.getByText("Shipped", { exact: true }).first());
          await rec.wait(1500);
        },
      }),
    );
  }

  await browser.close();
} finally {
  cleanup();
}
report(results);
process.exit(0);
