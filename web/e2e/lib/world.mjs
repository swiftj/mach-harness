// A throwaway world for one run: a local bare repository as the shared remote, reached by the
// product managers' clones through a github.com address (url.insteadOf), an engineer's clone with
// MACH scaffolded (bin/mach scaffold, committed and pushed), the stand-in gh for GitHub issues the
// Python suite uses, (optionally) a scripted stand-in claude first on PATH, and Git configuration
// isolated from the person's own. Nothing reaches the network.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { e2e, engine, keepScratch, machCli, repo, scratch } from "./env.mjs";

const python = process.env.E2E_PYTHON || "python3";
/** The GitHub repository the stand-in gh answers for, and the address the clones use for it. */
export const REPO = "acme/team-space";
const ADDRESS = `https://github.com/${REPO}.git`;

function git(cwd, env, ...args) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function createWorld({ claude = "fake", turns, clones = ["pm"] } = {}) {
  const root = scratch("mach-e2e-world");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n");
  const pyShebang = `#!${execFileSync(python, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim()}\n`;
  const install = (source, name) => {
    const target = join(bin, name);
    writeFileSync(target, readFileSync(source, "utf8").replace(/^#!.*\n/, pyShebang));
    chmodSync(target, 0o755);
    return target;
  };
  install(join(e2e, "fakes/gh.py"), "gh");
  // The Python suite's own stand-in for GitHub issues, reused as it is (fakes/gh.py wraps it).
  const issuesStandIn = execFileSync(python, ["-I", "-B", "-c", `import sys; sys.path[:0] = [${JSON.stringify(join(repo, "tests"))}, ${JSON.stringify(join(repo, "skills/ticket/scripts"))}]
from test_mach_product_issues import FAKE_GH; sys.stdout.write(FAKE_GH)`], { encoding: "utf8" });
  writeFileSync(join(bin, "gh-issues"), issuesStandIn.replace(/^#!.*\n/, pyShebang), { mode: 0o755 });
  let claudePath = null;
  if (claude === "fake") {
    // On PATH, as the host finds it by default. Its config and call log live beside it.
    claudePath = install(join(e2e, "fakes/claude.py"), "claude");
    writeFileSync(join(bin, "config.json"), JSON.stringify({ fixture: join(repo, "tests/fixtures/SLICE-001-invite-teammate.md"), engine, turns: turns ?? [] }));
  }
  const ghState = join(root, "gh.json");
  writeFileSync(ghState, JSON.stringify({ repo: REPO, me: "ada-pm", issues: {}, labels: [], fail: {}, calls: [] }));
  // PATH: our bin first, so `gh` (and, with the stand-in, `claude`) resolve to the stand-ins before
  // any real one. With claude "none" a non-executable placeholder shadows the real one.
  if (claude === "none") writeFileSync(join(bin, "claude"), "not a program\n");
  const env = {
    ...process.env,
    PATH: [bin, process.env.PATH || ""].join(":"),
    FAKE_GH_STATE: ghState,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of ["ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[name];

  const origin = join(root, "origin.git");
  git(root, env, "init", "-q", "--bare", "-b", "main", origin);
  const clone = (name, person, onGithub = true) => {
    const folder = join(root, name);
    git(root, env, "clone", "-q", origin, folder);
    git(folder, env, "config", "user.name", person);
    git(folder, env, "config", "user.email", `${name}@example.test`);
    if (onGithub) {
      git(folder, env, "remote", "set-url", "origin", ADDRESS);
      git(folder, env, "config", `url.${origin}.insteadOf`, ADDRESS);
    }
    return folder;
  };
  const eng = clone("eng", "Erin Engineer", false);
  writeFileSync(join(eng, "README.md"), "# Team Space\n");
  writeFileSync(join(eng, "app.py"), "print('hello')\n");
  git(eng, env, "add", "-A");
  git(eng, env, "commit", "-q", "-m", "start");
  execFileSync(python, [machCli, "scaffold", "--no-studio", "--project", eng], { env, stdio: "ignore" });
  git(eng, env, "add", "-A");
  git(eng, env, "commit", "-q", "-m", "scaffold MACH");
  git(eng, env, "push", "-q", "origin", "main");
  const people = { pm: "Ada PM", direct: "Dan Direct", other: "Ben PM" };
  const projects = Object.fromEntries(clones.map((name) => [name, clone(name, people[name] || name)]));

  const world = {
    root,
    bin,
    env,
    origin,
    eng,
    pm: projects.pm,
    projects,
    claudePath,
    app: false,
    /** The stand-in gh's issues, labels and comments. */
    gh: () => JSON.parse(readFileSync(ghState, "utf8")),
    /** Every gh call: { argv, cwd }. */
    ghCalls: () => (existsSync(`${ghState}.calls`) ? readFileSync(`${ghState}.calls`, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
    /** Issues carrying a label, by number. */
    issues(label) {
      return Object.values(world.gh().issues)
        .filter((i) => !label || i.labels.some((l) => l.name === label))
        .sort((a, b) => a.number - b.number);
    },
    /**
     * Changes GitHub the way someone else would, under the stand-in's own lock (fakes/gh.py): a
     * Python body that edits `state` (the stand-in's state) with issue_rules at hand.
     */
    onGithub(pythonBody, ...args) {
      const script = `import fcntl, json, os, sys
sys.path.insert(0, ${JSON.stringify(join(repo, "skills/ticket/scripts"))})
import issue_rules
path, args = sys.argv[1], json.loads(sys.argv[2])
lock = open(path + ".lock", "a")
fcntl.flock(lock, fcntl.LOCK_EX)
state = json.load(open(path))
${pythonBody}
tmp = path + ".world.tmp"
json.dump(state, open(tmp, "w"))
os.replace(tmp, path)`;
      execFileSync(python, ["-I", "-B", "-c", script, ghState, JSON.stringify(args)], { env });
    },
    /** The builders' state label on a slice's issue, as the Factory would set it. */
    setStateLabel(number, label) {
      world.onGithub(`issue = state["issues"][str(args[0])]
issue["labels"] = [l for l in issue["labels"] if l["name"] not in issue_rules.SLICE_STATE_LABELS] + [{"name": args[1]}]`, number, label);
    },
    /** Another product manager saves the next version of a slice, with their own approval. */
    newerVersion(number, extra) {
      world.onGithub(`issue = state["issues"][str(args[0])]
marker = issue_rules.parse_slice_body(issue["body"])
spec = marker["spec"] + args[1]
revision = marker["revision"] + 1
issue["body"] = issue_rules.slice_issue_body(marker["slice_id"], revision, marker["epic"], marker["depends"], marker["why"], spec)
issue["comments"].append({"login": "ben-pm", "body": issue_rules.approval_comment(marker["slice_id"], revision, "ben-pm", issue_rules.text_sha256_of(spec), marker["why_sha256"])})`, number, extra);
    },
    claudeCalls() {
      const folder = join(bin, "calls");
      if (!existsSync(folder)) return [];
      return readdirSync(folder).sort().map((name) => JSON.parse(readFileSync(join(folder, name), "utf8")));
    },
    /** The engine run directly, as the terminal skill runs it. */
    studio(project, ...args) {
      // world.app: word reports as the host asks the engine to (--app); artifacts must not depend on it.
      const done = spawnSync(python, ["-I", "-B", engine, "--project", project, ...(world.app ? ["--app"] : []), ...args], { env, encoding: "utf8" });
      let json = null;
      try {
        json = JSON.parse(done.stdout);
      } catch {
        /* not JSON */
      }
      return { code: done.status, json, stdout: done.stdout, stderr: done.stderr };
    },
    status(project = world.pm) {
      const r = world.studio(project, "status");
      if (r.code !== 0) throw new Error(`status failed: ${r.stderr}`);
      return r.json;
    },
    /**
     * The PM's checkout, byte for byte: HEAD, local branches, the raw index file, the stash, the
     * Git config, and every file outside .git and .factory. Read without taking Git's optional
     * locks, so taking the snapshot cannot itself refresh the index.
     */
    checkout(project = world.pm) {
      const hash = (b) => createHash("sha256").update(b).digest("hex");
      const files = {};
      const walk = (folder) => {
        for (const name of readdirSync(folder)) {
          const path = join(folder, name);
          const rel = relative(project, path);
          if (rel === ".git" || rel === ".factory") continue;
          const st = statSync(path);
          if (st.isDirectory()) walk(path);
          else files[rel] = hash(readFileSync(path));
        }
      };
      walk(project);
      const quiet = { ...env, GIT_OPTIONAL_LOCKS: "0" };
      return {
        head: readFileSync(join(project, ".git/HEAD"), "utf8"),
        headCommit: git(project, quiet, "rev-parse", "HEAD").trim(),
        branches: git(project, quiet, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
        stash: git(project, quiet, "stash", "list"),
        index: existsSync(join(project, ".git/index")) ? hash(readFileSync(join(project, ".git/index"))) : null,
        config: hash(readFileSync(join(project, ".git/config"))),
        status: git(project, quiet, "status", "--porcelain=v1", "--untracked-files=all"),
        files,
      };
    },
    /** Every file of .factory/studio/draft, by path. */
    draftTree(project = world.pm) {
      const home = join(project, ".factory/studio/draft");
      const tree = {};
      const walk = (folder) => {
        if (!existsSync(folder)) return;
        for (const name of readdirSync(folder)) {
          const path = join(folder, name);
          if (statSync(path).isDirectory()) walk(path);
          else tree[relative(home, path)] = readFileSync(path, "utf8");
        }
      };
      walk(home);
      return tree;
    },
    cleanup() {
      if (!keepScratch) rmSync(root, { recursive: true, force: true });
    },
  };
  return world;
}
