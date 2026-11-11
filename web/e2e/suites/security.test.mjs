// Security, against the real host and the real engine.
//
//   node --test web/e2e/suites/security.test.mjs
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { buildHost } from "../lib/build.mjs";
import { createWorld } from "../lib/world.mjs";
import { apiClient, raw, startHost } from "../lib/host.mjs";
import { openBrowser, settle, watchedPage } from "../lib/app.mjs";
import { specFor, whyFor } from "../lib/content.mjs";

let binary, world, host, api, before0, canary;
const bodies = []; // every API response body seen, to search for credentials afterwards

before(async () => {
  ({ binary } = buildHost());
  world = createWorld({ claude: "fake", turns: [{ kind: "question" }] });
  before0 = world.checkout();
  // A file outside the draft workspace that no draft write may reach.
  canary = join(world.root, "canary.md");
  writeFileSync(canary, "canary\n");
  host = await startHost(binary, world.pm, world.env);
});

after(async () => {
  await host?.stop();
  world?.cleanup();
});

const hostHeader = () => `127.0.0.1:${host.port}`;
const authed = async () => {
  if (!api) api = await apiClient(host);
  return api;
};
const record = (r) => {
  bodies.push(r.text);
  return r;
};

test("the one-time token", async (t) => {
  await t.test("a wrong Host with the token is refused and does not use the token up", async () => {
    const r = await raw({ port: host.port, path: `/?t=${host.token}`, headers: { Host: `evil.example:${host.port}` } });
    assert.equal(r.status, 403);
  });
  await t.test("a wrong token is refused", async () => {
    const r = await raw({ port: host.port, path: `/?t=${"0".repeat(host.token.length)}`, headers: { Host: hostHeader() } });
    assert.equal(r.status, 401);
    assert.ok(!r.headers["set-cookie"]);
  });
  await t.test("the token is exchanged once for an HttpOnly, SameSite=Strict cookie", async () => {
    const a = await authed();
    const cookie = a.setCookie.join("; ");
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//);
    assert.ok(!a.cookie.includes(host.token), "the cookie is not the start token");
  });
  await t.test("the token then stops working", async () => {
    const r = await raw({ port: host.port, path: `/?t=${host.token}`, headers: { Host: hostHeader() } });
    assert.equal(r.status, 401);
    assert.ok(!r.headers["set-cookie"]);
  });
});

test("every request is checked", async (t) => {
  const a = await authed();
  const good = { Host: hostHeader(), Cookie: a.cookie, Origin: `http://${hostHeader()}`, "X-MACH-CSRF": a.csrf, "Content-Type": "application/json" };
  const post = (headers, path = "/api/ops/status") => raw({ port: host.port, method: "POST", path, headers, body: "{}" }).then(record);

  await t.test("the control request is accepted", async () => {
    assert.equal((await post(good)).status, 200);
  });
  await t.test("without the cookie: 401 on every API route", async () => {
    for (const [method, path] of [["GET", "/api/session"], ["POST", "/api/ops/status"], ["GET", "/api/drafts/spec/SLICE-001"], ["POST", "/api/interview"], ["GET", "/api/interview?slice_id=SLICE-001"]]) {
      const rest = { ...good };
      delete rest.Cookie;
      const r = await raw({ port: host.port, method, path, headers: method === "GET" ? { Host: rest.Host } : rest, body: method === "GET" ? undefined : "{}" });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.equal(r.json?.error?.kind, "unauthorized", `${method} ${path}: ${r.text}`);
    }
    const forged = await post({ ...good, Cookie: "mach_studio_session=forged" });
    assert.equal(forged.status, 401);
  });
  await t.test("a wrong Host header is refused (DNS rebinding)", async () => {
    for (const h of [`evil.example:${host.port}`, `127.0.0.1:${host.port + 1}`, "127.0.0.1", `localhost.evil.example:${host.port}`, `127.0.0.1.nip.io:${host.port}`, `[::1]:${host.port}`, `0.0.0.0:${host.port}`]) {
      const g = await raw({ port: host.port, path: "/api/session", headers: { Host: h, Cookie: a.cookie } });
      assert.equal(g.status, 403, `GET with Host ${h}`);
      const p = await post({ ...good, Host: h, Origin: `http://${h}` });
      assert.equal(p.status, 403, `POST with Host ${h}`);
      const page = await raw({ port: host.port, path: "/", headers: { Host: h } });
      assert.equal(page.status, 403, `the page with Host ${h}`);
    }
    // localhost:<port> is allowed, with its own matching Origin.
    const l = await raw({ port: host.port, path: "/api/session", headers: { Host: `localhost:${host.port}`, Cookie: a.cookie } });
    assert.equal(l.status, 200);
  });
  await t.test("a foreign or missing Origin is refused", async () => {
    for (const origin of ["http://evil.example", "null", `http://localhost:${host.port}`, `https://${hostHeader()}`, `http://${hostHeader()}.evil.example`, undefined]) {
      const headers = { ...good, Origin: origin };
      if (origin === undefined) delete headers.Origin;
      const r = await post(headers);
      assert.equal(r.status, 403, `Origin ${origin}`);
      assert.equal(r.json?.ok, false);
    }
  });
  await t.test("a missing or wrong X-MACH-CSRF is refused", async () => {
    const without = { ...good };
    delete without["X-MACH-CSRF"];
    assert.equal((await post(without)).status, 403);
    assert.equal((await post({ ...good, "X-MACH-CSRF": "wrong" })).status, 403);
    assert.equal((await post({ ...good, "X-MACH-CSRF": a.csrf.slice(0, -1) })).status, 403);
    assert.equal((await post({ ...good, "X-MACH-CSRF": a.cookie.split("=")[1] })).status, 403, "the cookie value is not the CSRF token");
  });
  await t.test("a state-changing request must be JSON", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const r = await post({ ...good, "Content-Type": type });
      assert.ok([400, 415].includes(r.status), `${type}: HTTP ${r.status}`);
    }
  });
});

test("bound to loopback only", async (t) => {
  await t.test("the listening socket is 127.0.0.1", () => {
    const out = execFileSync("lsof", ["-nP", "-a", "-p", String(host.child.pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
    const lines = out.split("\n").filter((l) => l.includes("LISTEN"));
    assert.ok(lines.length >= 1, out);
    for (const l of lines) assert.match(l, /127\.0\.0\.1:\d+ \(LISTEN\)/, l);
  });
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && (i.family === "IPv4" || i.family === "IPv6") && !i.address.startsWith("fe80"));
  await t.test(`not reachable on the machine's other addresses (${lan.map((i) => i.address).join(", ") || "none found"})`, async (st) => {
    if (!lan.length) return st.skip("this machine has no non-loopback address");
    for (const i of lan) {
      const reached = await new Promise((done) => {
        const s = connect({ host: i.address, port: host.port, timeout: 2000 });
        s.on("connect", () => (s.destroy(), done(true)));
        s.on("error", () => done(false));
        s.on("timeout", () => (s.destroy(), done(false)));
      });
      assert.equal(reached, false, `reachable on ${i.address}`);
    }
  });
  await t.test("not reachable on ::1 unless asked", async () => {
    const reached = await new Promise((done) => {
      const s = connect({ host: "::1", port: host.port, timeout: 2000 });
      s.on("connect", () => (s.destroy(), done(true)));
      s.on("error", () => done(false));
    });
    assert.equal(reached, false);
  });
});

test("draft routes stay inside the draft workspace", async (t) => {
  const a = await authed();
  for (const [op, args] of [
    ["project.init", { id: "team-space", name: "Team Space", vision: "Teams work together.", outcome: ["Teams can work together"] }],
    ["epic.add", { title: "Team membership", criterion: ["Only invited people can join"] }],
    ["epic.approve", { epic_id: "EPIC-001" }],
    ["slice.new", { epic: "EPIC-001", title: "Invite a teammate", depends_on: [] }],
    ["slice.new", { epic: "EPIC-001", title: "Remove a teammate", depends_on: [] }],
  ]) {
    const r = await a.op(op, args);
    assert.equal(r.ok, true, `${op}: ${JSON.stringify(r)}`);
  }
  const before = new Set(readdirSync(world.root, { recursive: true }).map(String));

  await t.test("traversal and malformed IDs in the path are refused", async () => {
    const paths = [
      "/api/drafts/spec/..%2F..%2F..%2Fetc%2Fpasswd", "/api/drafts/spec/../../ops/status", "/api/drafts/spec/SLICE-001%2F..%2F..%2Fx",
      "/api/drafts/spec/SLICE-001.md", "/api/drafts/spec/SLICE-1", "/api/drafts/spec/slice-001", "/api/drafts/spec/SLICE-001%00",
      "/api/drafts/spec/%2e%2e", "/api/drafts/work_order/SLICE-001", "/api/drafts/project/SLICE-001", "/api/drafts/..%2Fproduct/SLICE-001",
      "/api/drafts/intent/SLICE-001/extra", "/api/drafts/spec/EPIC-001", "/api/drafts/spec/SLICE-001-invite-teammate",
    ];
    for (const path of paths) {
      const r = record(await a.send("PUT", path, { markdown: "# pwned\n" }));
      assert.ok(r.status >= 300, `PUT ${path}: HTTP ${r.status} ${r.text.slice(0, 160)}`);
      assert.notEqual(r.json?.ok, true, `PUT ${path} succeeded`);
      const g = record(await a.get(path));
      assert.notEqual(g.json?.ok, true, `GET ${path} succeeded`);
    }
  });
  await t.test("a spec name cannot leave specs/slices/", async () => {
    for (const name of ["../../x", "../../../../canary", "a/b", "..", ".", "/etc/passwd", "x\u0000y", "x.md", "X Y", "a".repeat(200), "invite-teammate/../../../x"]) {
      const r = record(await a.send("PUT", "/api/drafts/spec/SLICE-001", { markdown: specFor("SLICE-001"), name }));
      assert.notEqual(r.json?.ok, true, `name ${JSON.stringify(name)} accepted: ${r.text.slice(0, 200)}`);
    }
  });
  await t.test("unknown body fields are refused", async () => {
    const r = record(await a.send("PUT", "/api/drafts/intent/SLICE-001", { markdown: whyFor("SLICE-001"), path: "../../../canary.md" }));
    assert.notEqual(r.json?.ok, true, r.text);
  });
  await t.test("a symbolic link anywhere on the path is refused", async () => {
    // SLICE-002's spec location replaced by a link pointing at the canary outside the draft.
    const specs = join(world.pm, ".factory/studio/draft/specs/slices");
    mkdirSync(specs, { recursive: true });
    symlinkSync(canary, join(specs, "SLICE-002-remove-teammate.md"));
    const r1 = record(await a.send("PUT", "/api/drafts/spec/SLICE-002", { markdown: "# overwritten\n", name: "remove-teammate" }));
    assert.notEqual(r1.json?.ok, true, `wrote through a file link: ${r1.text.slice(0, 200)}`);
    // The intents folder replaced by a link to a folder outside the draft.
    const outside = join(world.root, "outside");
    mkdirSync(outside);
    const intents = join(world.pm, ".factory/studio/draft/product/intents");
    rmSync(intents, { recursive: true, force: true });
    symlinkSync(outside, intents);
    const r2 = record(await a.send("PUT", "/api/drafts/intent/SLICE-002", { markdown: "# overwritten\n" }));
    assert.notEqual(r2.json?.ok, true, `wrote through a folder link: ${r2.text.slice(0, 200)}`);
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(readFileSync(canary, "utf8"), "canary\n");
    rmSync(intents);
    rmSync(join(specs, "SLICE-002-remove-teammate.md"));
    mkdirSync(intents);
  });
  await t.test("legitimate writes land only under specs/slices/ and product/intents/", async () => {
    const s = record(await a.send("PUT", "/api/drafts/spec/SLICE-001", { markdown: specFor("SLICE-001"), name: "invite-teammate" }));
    assert.equal(s.json?.ok, true, s.text);
    assert.equal(s.json.data.path, "specs/slices/SLICE-001-invite-teammate.md");
    const w = record(await a.send("PUT", "/api/drafts/intent/SLICE-001", { markdown: whyFor("SLICE-001") }));
    assert.equal(w.json?.ok, true, w.text);
    assert.equal(w.json.data.path, "product/intents/SLICE-001.md");
    const added = readdirSync(world.root, { recursive: true }).map(String).filter((p) => !before.has(p));
    const unexpected = added.filter((p) => !/^pm\/\.factory\/studio\//.test(p) && !/^outside$/.test(p) && !/^bin\/calls/.test(p) && p !== "gh.json");
    assert.deepEqual(unexpected, [], "files appeared outside the Product Studio workspace");
    assert.equal(readFileSync(canary, "utf8"), "canary\n");
  });
  await t.test("an approved slice's drafts are read-only", async () => {
    assert.equal((await a.op("slice.approve", { slice_id: "SLICE-001" })).ok, true);
    const r = record(await a.send("PUT", "/api/drafts/spec/SLICE-001", { markdown: "# changed\n" }));
    assert.equal(r.json?.ok, false);
    assert.equal(r.json.error.kind, "refused");
  });
});

test("the page: CSP, no other origin, nothing secret readable", async (t) => {
  // A second host for a fresh one-time token (this one's is spent).
  const second = await startHost(binary, world.pm, world.env);
  const browser = await openBrowser();
  try {
    const { page, problems, context } = await watchedPage(browser, second.origin);
    const responses = [];
    page.on("response", async (r) => {
      try {
        responses.push({ url: r.url(), headers: await r.allHeaders(), body: r.url().includes("/api/") ? await r.text() : "" });
      } catch {
        /* the body of a redirect */
      }
    });
    await page.goto(second.url, { waitUntil: "networkidle" });
    for (const route of ["/", "/vision", "/roadmap", "/slices/SLICE-001", "/slices/SLICE-002/interview", "/inbox", "/waves", "/shared"]) {
      await page.goto(`${second.origin}/#${route}`);
      await settle(page, 500);
    }
    const seen = await problems();
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === "mach_studio_session");

    await t.test("no request to any other origin, no CSP violation", () => {
      assert.deepEqual(seen.external, []);
      assert.deepEqual(seen.csp, []);
    });
    await t.test("the CSP header is on every response and allows no inline or eval", () => {
      const html = responses.find((r) => new URL(r.url).pathname === "/");
      assert.ok(html, "the page response was seen");
      for (const r of responses) {
        const csp = r.headers["content-security-policy"];
        assert.ok(csp, `no CSP on ${r.url}`);
        assert.ok(!/unsafe-inline|unsafe-eval|unsafe-hashes|\*/.test(csp), `${r.url}: ${csp}`);
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /script-src 'self'(;|$)/);
      }
    });
    await t.test("the session cookie is HttpOnly and SameSite=Strict as the browser sees it", () => {
      assert.ok(session, JSON.stringify(cookies));
      assert.equal(session.httpOnly, true);
      assert.equal(session.sameSite, "Strict");
    });
    await t.test("no credential in page HTML, JS-readable cookies, storage or API responses", async () => {
      const readable = await page.evaluate(() => ({
        cookie: document.cookie,
        local: JSON.stringify({ ...localStorage }),
        sessionStore: JSON.stringify({ ...sessionStorage }),
        html: document.documentElement.outerHTML,
      }));
      assert.equal(readable.cookie, "", "document.cookie is readable");
      const secrets = [session.value, second.token, host.token];
      for (const secret of secrets) {
        for (const [where, text] of [["html", readable.html], ["localStorage", readable.local], ["sessionStorage", readable.sessionStore], ...responses.map((r) => [r.url, r.body]), ...bodies.map((b, i) => [`api body ${i}`, b])]) {
          assert.ok(!text.includes(secret), `a credential appears in ${where}`);
        }
      }
      for (const name of ["ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "sk-ant-"]) {
        assert.ok(!responses.some((r) => r.body.includes(name)), `${name} appears in an API response`);
      }
    });
    await t.test("the host's own output never contains the session cookie or the CSRF token", () => {
      const logs = host.logs() + second.logs();
      assert.ok(!logs.includes(session.value), "session cookie in logs");
      assert.ok(api && !logs.includes(api.csrf), "CSRF token in logs");
      assert.ok(!logs.includes(api.cookie.split("=")[1]), "first session cookie in logs");
    });
  } finally {
    await browser.close();
    await second.stop();
  }
});

test("nothing can reach the Factory", async (t) => {
  const a = await authed();
  const runner = join(world.pm, ".factory/local/runner.json");
  const local = join(world.pm, ".factory/local");
  const factoryBefore = existsSync(local) ? readdirSync(local, { recursive: true }).map(String).sort() : null;

  await t.test("no route starts a station or enables execution", async () => {
    const attempts = [
      ["POST", "/api/factory/enable"], ["POST", "/api/factory"], ["POST", "/api/run"], ["POST", "/api/station/build"], ["POST", "/api/belt"],
      ["POST", "/api/ops/factory.enable"], ["POST", "/api/ops/run"], ["POST", "/api/ops/product.dispatch"], ["PUT", "/api/drafts/runner/SLICE-001"],
      ["PUT", "/api/drafts/spec/..%2F..%2F..%2Flocal%2Frunner.json"], ["POST", "/api/interview/../ops/factory.enable"], ["GET", "/api/local/runner.json"],
    ];
    for (const [method, path] of attempts) {
      const r = record(method === "GET" ? await a.get(path) : await a.send(method, path, { enabled: true }));
      assert.notEqual(r.json?.ok, true, `${method} ${path} succeeded`);
    }
    for (const bad of [{ status: "factory" }, { status: "enabled" }]) {
      const r = await a.op("project.set", bad);
      assert.notEqual(r.ok === true && existsSync(runner), true);
    }
  });

  await t.test("the interviewer can neither approve, send, reconcile nor touch the Factory", async () => {
    const started = record(await a.send("POST", "/api/interview", { slice_id: "SLICE-002" }));
    assert.equal(started.json?.ok, true, started.text);
    // Wait for the stand-in's single turn to have been launched.
    for (let i = 0; i < 50 && !world.claudeCalls().length; i++) await new Promise((r) => setTimeout(r, 200));
    const [call] = world.claudeCalls();
    assert.ok(call, "the interview turn ran");
    const listAfter = (flag) => {
      const at = call.argv.indexOf(flag);
      if (at < 0) return [];
      const out = [];
      for (const x of call.argv.slice(at + 1)) {
        if (x.startsWith("--")) break;
        out.push(x);
      }
      return out;
    };
    const allowed = listAfter("--allowedTools");
    const denied = listAfter("--disallowedTools");
    assert.ok(allowed.length > 0 && denied.length > 0, "allow and deny lists present");
    // What follows the script path in each allowed Bash rule: only the read-only and own-slice operations.
    const ops = allowed.filter((r) => r.startsWith("Bash(")).map((r) => r.replace(/^Bash\(.*?studio\.py"? /, "").replace(/\)$/, ""));
    const permitted = /^(where|status|validate|refresh|slice (resume|check|pause|set) SLICE-002( \*)?)$/;
    assert.deepEqual(ops.filter((o) => !permitted.test(o)), [], "an allowed Bash rule beyond the documented operations");
    const edits = allowed.filter((r) => r.startsWith("Edit("));
    assert.equal(edits.length, 2, edits.join("\n"));
    for (const e of edits) assert.match(e, /SLICE-002(-\*)?\.md\)$/);
    assert.deepEqual(allowed.filter((r) => !/^(Read|Glob|Grep|Bash\(|Edit\()/.test(r)), []);
    for (const word of ["slice approve", "epic approve", "wave", "send", "reconcile"]) assert.ok(denied.some((r) => r.includes(` ${word}`)), `denied rules do not name ${word}`);
    assert.ok(!call.argv.some((x) => /dangerously|bypassPermissions|acceptEdits/.test(x)));
    const stop = record(await a.send("POST", `/api/interview/${started.json.data.interview_id}/stop`, {}));
    assert.equal(stop.json?.ok, true, stop.text);
  });

  await t.test("a whole delivery through the host never writes .factory/local/ and every report says factory_authorized: false", async () => {
    const reports = [];
    const op = async (name, args) => {
      const r = await a.op(name, args);
      assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`);
      reports.push([name, r.data]);
      return r.data;
    };
    await op("wave.new", { slice: ["SLICE-001"] });
    await op("wave.approve", { wave_id: "WAVE-001" });
    await op("send.preview", { wave_id: "WAVE-001" });
    await op("send", { wave_id: "WAVE-001" });
    await op("feedback", { wave_id: "WAVE-001" });
    world.land("product/WAVE-001");
    await op("refresh", {});
    await op("status", {});
    await op("where", {});
    await op("validate", {});
    const flagged = reports.filter(([, d]) => d && typeof d === "object" && "factory_authorized" in d);
    assert.ok(flagged.some(([n]) => n === "status"), "status reports factory_authorized");
    for (const [name, d] of flagged) assert.equal(d.factory_authorized, false, name);
    const missing = reports.filter(([, d]) => !(d && typeof d === "object" && "factory_authorized" in d)).map(([n]) => n);
    t.diagnostic(`reports without factory_authorized (the engine does not provide it there): ${missing.join(", ")}`);
    assert.ok(!existsSync(runner), ".factory/local/runner.json was written");
    const factoryAfter = existsSync(local) ? readdirSync(local, { recursive: true }).map(String).sort() : null;
    assert.deepEqual(factoryAfter, factoryBefore, ".factory/local/ changed");
    for (const dir of ["worktrees", "tickets", "intake"]) {
      const p = join(world.pm, ".factory", dir);
      assert.ok(!existsSync(p) || readdirSync(p).filter((n) => n !== ".gitkeep").length === 0, `.factory/${dir} has entries`);
    }
  });
});

test("the PM's checkout is byte-identical after everything", () => {
  assert.deepEqual(world.checkout(), before0);
});
