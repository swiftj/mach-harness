// Conformance: the terminal engine (studio.py run directly, as /mach:product-studio does) and the
// host API must leave equivalent workspaces, reports and GitHub issues for the same operations,
// and the host must expose exactly its allowlist: none of the engine's leftover commands.
//
//   node --test web/e2e/suites/conformance.test.mjs
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHost } from "../lib/build.mjs";
import { createWorld } from "../lib/world.mjs";
import { apiClient, startHost } from "../lib/host.mjs";
import { specFor, whyFor } from "../lib/content.mjs";

// The host's allowlist as documented (contract sections 3, 8.1 and 8.4, apps/studio/README.md).
const ALLOWLIST = [
  "where", "status", "validate", "refresh", "project.init", "project.set", "epic.add", "epic.set", "epic.renumber",
  "slice.new", "slice.set", "slice.resume", "slice.pause", "slice.check", "slice.show", "slice.ready", "slice.reopen", "slice.renumber", "slice.move", "slice.take",
  "reconcile", "request.list", "request.show", "request.pick", "request.link", "request.met",
  // M15 (docs/mach-next/M15_STUDIO_FOUNDATION.md): what M13 and M14 added to the engine.
  "principle.list", "principle.add", "principle.set", "principle.retire", "principle.publish", "reconcile.principles",
  "policy.list", "policy.accept", "epic.current", "epic.link", "slice.link", "jira.export", "jira.keys",
  "prd.import", "prd.list", "prd.show", "prd.map", "prd.settle", "prd.status", "prd.apply", "prd.draft", "prd.confirm",
  "slice.mock.add", "slice.mock.remove", "slice.mock.list",
  // M16 (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md): Shape.
  "idea.add", "idea.list", "idea.faults", "idea.show", "idea.stage", "idea.lookups", "idea.renumber", "idea.publish", "idea.size", "idea.map", "idea.settle",
  "idea.map-status", "idea.apply", "idea.change", "idea.chain", "brief.check", "brief.show", "case.show", "case.check", "verdict.record", "lookback.record",
  // M17 (docs/mach-next/M17_APP_FOUNDATION.md): technical needs and a design you already have. No design.map: the
  // needs conversation records a map.
  "need.list", "need.add", "need.set", "need.retire", "need.none", "need.publish", "reconcile.needs",
  "design.list", "design.import", "design.show", "design.settle", "design.publish",
  // M18: a small change made a full slice on the product manager's word.
  "slice.widen",
];
// Commands the engine keeps only for another team's tests (docs/mach-next/M11_STUDIO_ISSUES.md). The host never reaches them.
const LEFTOVERS = [
  "slice.approve", "wave.new", "wave.add", "wave.remove", "wave.approve", "wave.renumber", "send", "send.preview", "feedback",
  "acceptance.record", "acceptance.show",
];

let binary, terminal, terminalApp, web, host, api;

before(async () => {
  ({ binary } = buildHost());
  terminal = createWorld({ claude: "none" });
  // The same terminal engine asked for the app's wording (the host passes --app): its reports must
  // equal the host's, and its artifacts must equal the plain terminal's.
  terminalApp = createWorld({ claude: "none" });
  terminalApp.app = true;
  web = createWorld({ claude: "none" });
  host = await startHost(binary, web.pm, web.env);
  api = await apiClient(host);
});

after(async () => {
  await host?.stop();
  terminal?.cleanup();
  terminalApp?.cleanup();
  web?.cleanup();
});

/** What legitimately differs between two runs: times, the two scratch folders, commit IDs, session IDs. */
function normalise(value) {
  const roots = [terminal.root, terminalApp.root, web.root].sort((a, b) => b.length - a.length);
  const text = (s) => {
    let out = s;
    for (const root of roots) out = out.split(root).join("<ROOT>").split(root.replace(/^\/private/, "")).join("<ROOT>");
    return out
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)?/g, "<TIME>")
      .replace(/\b[0-9a-f]{40}\b/g, "<COMMIT>")
      .replace(/\b[0-9a-f]{7,12}\b(?=\.\.|\s|$)/g, "<SHORT>")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<UUID>");
  };
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v)]));
  return value;
}

/** The terminal side: argv for studio.py. The web side: an op name and its typed arguments. */
const STEPS = [
  { name: "project init", argv: ["project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together"], op: ["project.init", { id: "team-space", name: "Team Space", vision: "Teams work together.", outcome: ["Teams can work together"] }] },
  { name: "project set", argv: ["project", "set", "--vision", "Teams work together without friction.", "--outcome", "Teams can work together", "--outcome", "Admins stay in control"], op: ["project.set", { vision: "Teams work together without friction.", outcome: ["Teams can work together", "Admins stay in control"] }] },
  { name: "epic add", argv: ["epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join"], op: ["epic.add", { title: "Team membership", criterion: ["Only invited people can join"] }] },
  { name: "second epic", argv: ["epic", "add", "--title", "Billing", "--criterion", "Admins see the seat count"], op: ["epic.add", { title: "Billing", criterion: ["Admins see the seat count"] }] },
  { name: "epic set", argv: ["epic", "set", "EPIC-002", "--title", "Workspace billing"], op: ["epic.set", { epic_id: "EPIC-002", title: "Workspace billing" }] },
  { name: "epic set aside", argv: ["epic", "set", "EPIC-002", "--status", "deferred"], op: ["epic.set", { epic_id: "EPIC-002", status: "deferred" }] },
  { name: "slice new", argv: ["slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate"], op: ["slice.new", { epic: "EPIC-001", title: "Invite a teammate", depends_on: [] }] },
  { name: "slice resume", argv: ["slice", "resume", "SLICE-001"], op: ["slice.resume", { slice_id: "SLICE-001" }] },
  { name: "write spec", draft: ["spec", "SLICE-001"] },
  { name: "write why", draft: ["intent", "SLICE-001"] },
  { name: "slice check ready", argv: ["slice", "check", "SLICE-001", "--ready"], op: ["slice.check", { slice_id: "SLICE-001", ready: true }] },
  { name: "slice pause", argv: ["slice", "pause", "SLICE-001", "--note", "Settled the seat rules."], op: ["slice.pause", { slice_id: "SLICE-001", note: "Settled the seat rules." }] },
  { name: "slice show", argv: ["slice", "show", "SLICE-001"], op: ["slice.show", { slice_id: "SLICE-001" }] },
  { name: "slice ready", argv: ["slice", "ready", "SLICE-001"], op: ["slice.ready", { slice_id: "SLICE-001" }] },
  { name: "second slice", argv: ["slice", "new", "--epic", "EPIC-002", "--title", "See the seat count"], op: ["slice.new", { epic: "EPIC-002", title: "See the seat count", depends_on: [] }] },
  { name: "slice set", argv: ["slice", "set", "SLICE-002", "--title", "See how many seats are used"], op: ["slice.set", { slice_id: "SLICE-002", title: "See how many seats are used" }] },
  { name: "slice renumber", argv: ["slice", "renumber", "SLICE-002"], op: ["slice.renumber", { identifier: "SLICE-002" }] },
  { name: "a third slice", argv: ["slice", "new", "--epic", "EPIC-001", "--title", "Remove a teammate"], op: ["slice.new", { epic: "EPIC-001", title: "Remove a teammate", depends_on: [] }] },
  { name: "slice move", argv: ["slice", "move", "SLICE-004", "--before", "SLICE-001"], op: ["slice.move", { slice_id: "SLICE-004", before: "SLICE-001" }] },
  { name: "the builders take it, then refresh", github: (w) => w.setStateLabel(w.issues("mach:slice")[0].number, "mach:building"), argv: ["refresh"], op: ["refresh", {}] },
  { name: "slice reopen", argv: ["slice", "reopen", "SLICE-001"], op: ["slice.reopen", { slice_id: "SLICE-001" }] },
  { name: "someone saves a newer version, then refresh", github: (w) => w.newerVersion(w.issues("mach:slice")[0].number, "\nChanged by Ben.\n"), argv: ["refresh"], op: ["refresh", {}] },
  { name: "reconcile theirs", argv: ["reconcile", "SLICE-001", "--take", "theirs"], op: ["reconcile", { slice_id: "SLICE-001", take: "theirs" }] },
  { name: "slice ready again", argv: ["slice", "ready", "SLICE-001"], op: ["slice.ready", { slice_id: "SLICE-001" }] },
  { name: "validate", argv: ["validate"], op: ["validate", {}] },
  { name: "status", argv: ["status"], op: ["status", {}] },
];

test("conformance: terminal and host leave equivalent workspaces", async (t) => {
  const wordingOnly = [];
  for (const s of STEPS) {
    await t.test(s.name, async () => {
      if (s.github) for (const w of [terminal, terminalApp, web]) s.github(w);
      let viaTerminal, viaApp, viaHost;
      if (s.draft) {
        const [kind, id] = s.draft;
        const markdown = kind === "spec" ? specFor(id) : whyFor(id);
        const rel = kind === "spec" ? `specs/slices/${id}-invite-teammate.md` : `product/intents/${id}.md`;
        // The terminal skill's interviewer writes the file, then the engine checks it.
        for (const w of [terminal, terminalApp]) {
          const path = join(w.pm, ".factory/studio/draft", rel);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, markdown);
        }
        viaTerminal = terminal.studio(terminal.pm, "slice", "check", id).json;
        viaApp = terminalApp.studio(terminalApp.pm, "slice", "check", id).json;
        const put = await api.send("PUT", `/api/drafts/${kind}/${id}`, kind === "spec" ? { markdown, name: "invite-teammate" } : { markdown });
        assert.equal(put.json?.ok, true, `PUT ${kind}: ${put.status} ${put.text}`);
        assert.equal(put.json.data.path, rel);
        viaHost = put.json.data.check;
      } else {
        const r = terminal.studio(terminal.pm, ...s.argv);
        assert.ok(r.code === 0 || (r.code === 1 && r.json), `terminal ${s.argv.join(" ")}: ${r.stderr}`);
        viaTerminal = r.json;
        viaApp = terminalApp.studio(terminalApp.pm, ...s.argv).json;
        const env = await api.op(...s.op);
        assert.equal(env?.ok, true, `host ${s.op[0]}: ${JSON.stringify(env)}`);
        viaHost = env.data;
      }
      // Artifacts: byte-identical whoever ran the operation (normalising only times, folders and commit IDs).
      assert.deepEqual(normalise(web.draftTree()), normalise(terminal.draftTree()), "the draft workspace differs from the terminal's");
      assert.deepEqual(normalise(terminalApp.draftTree()), normalise(terminal.draftTree()), "--app changed an artifact");
      assert.deepEqual(normalise(web.status()), normalise(terminal.status()), "status (read by the terminal) differs");
      // Reports: the host's equal the engine's own, in the same (app) wording.
      assert.deepEqual(normalise(viaHost), normalise(viaApp), "the host's report differs from the engine's --app report");
      if (JSON.stringify(normalise(viaApp)) !== JSON.stringify(normalise(viaTerminal))) wordingOnly.push(s.name);
    });
  }

  await t.test("reports that differ only in wording between the terminal and the app", (st) => {
    st.diagnostic(wordingOnly.join(", ") || "none");
  });

  await t.test("the issues each client saved on GitHub are the same", () => {
    const issues = (w) => normalise(w.issues().map(({ number, title, body, state, labels, comments, sub_issues, pinned }) => ({ number, title, body, state, labels, comments, sub_issues, pinned })));
    assert.equal(terminal.issues("mach:slice").length, 1);
    assert.deepEqual(issues(web), issues(terminalApp));
    assert.deepEqual(issues(terminalApp), issues(terminal), "an issue depends on --app");
    assert.deepEqual(normalise(web.gh().labels), normalise(terminal.gh().labels));
  });
});

test("allowlist: every listed operation is reachable and answers with the envelope", async (t) => {
  for (const name of ALLOWLIST) {
    await t.test(name, async () => {
      // Empty arguments: either the operation runs, or the host or engine says why not, in the envelope.
      const r = await api.send("POST", `/api/ops/${name}`, {});
      assert.ok(r.json && typeof r.json.ok === "boolean", `${name}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      if (r.json.ok) assert.ok("data" in r.json);
      else {
        assert.ok(["refused", "invalid", "conflict", "unavailable"].includes(r.json.error.kind), JSON.stringify(r.json));
        assert.equal(typeof r.json.error.message, "string");
        assert.ok(!/no operation called/i.test(r.json.error.message), `${name} is not reachable: ${r.json.error.message}`);
      }
    });
  }
});

test("allowlist: nothing outside it is reachable", async (t) => {
  const outside = [
    ...LEFTOVERS,
    "run", "factory", "factory.enable", "factory.serve", "factory.tick", "product.dispatch", "dispatch", "intake", "belt", "build", "merge",
    "slice.delete", "project.delete", "wave.send", "send.now", "STATUS", "status ", "status;rm", "status/../where", "..%2Fstatus", "%2e%2e",
    "slice", "slice.", ".status", "slice.check.ready", "__proto__", "constructor", "toString", "where\u0000", "x".repeat(300),
  ];
  const notEnvelopes = [];
  for (const name of outside) {
    await t.test(JSON.stringify(name).slice(0, 60), async () => {
      const r = await api.send("POST", `/api/ops/${encodeURI(name)}`, {});
      if (r.status >= 300 && r.status < 400) {
        // Go's router cleans the path and redirects; the target must itself be an allowlisted op.
        notEnvelopes.push(`POST /api/ops/${name} -> HTTP ${r.status} Location ${r.headers.location}`);
        const target = (r.headers.location || "").replace(/^\/api\/ops\//, "");
        assert.ok(ALLOWLIST.includes(target), `${name} redirects outside the allowlist: ${r.headers.location}`);
        return;
      }
      assert.ok(r.status >= 400, `${name}: HTTP ${r.status}`);
      assert.equal(r.json?.ok, false, `${name}: ${r.text.slice(0, 200)}`);
      assert.equal(r.json.error.kind, "invalid");
    });
  }
  await t.test("operations through other methods are refused", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const r = method === "GET" ? await api.get("/api/ops/status") : await api.send(method, "/api/ops/status", {});
      assert.ok(r.status >= 400, `${method}: HTTP ${r.status}`);
      if (r.json?.ok !== false) notEnvelopes.push(`${method} /api/ops/status -> HTTP ${r.status} ${r.headers["content-type"]} ${r.text.trim().slice(0, 60)}`);
    }
  });
  await t.test("every refusal is the contract's envelope", () => {
    assert.deepEqual(notEnvelopes, []);
  });
  await t.test("unknown argument fields are refused before the engine runs", async () => {
    const r = await api.op("status", { project: "/etc" });
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "invalid");
    const s = await api.op("slice.new", { epic: "EPIC-001", title: "x", extra: "--project=/etc" });
    assert.equal(s.ok, false);
  });
});
