// A throwaway world for one run: a local bare repository as the shared remote, an engineer's clone
// with MACH scaffolded (bin/mach scaffold, committed and pushed), the product manager's clone, a
// stand-in gh and (optionally) a scripted stand-in claude first on PATH, and Git configuration
// isolated from the person's own. Nothing reaches the network.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { e2e, engine, keepScratch, machCli, repo, scratch } from "./env.mjs";

const python = process.env.E2E_PYTHON || "python3";

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
  let claudePath = null;
  if (claude === "fake") {
    // On PATH, as the host finds it by default. Its config and call log live beside it.
    claudePath = install(join(e2e, "fakes/claude.py"), "claude");
    writeFileSync(join(bin, "config.json"), JSON.stringify({ fixture: join(repo, "tests/fixtures/SLICE-001-invite-teammate.md"), engine, turns: turns ?? [] }));
  }
  const ghState = join(root, "gh.json");
  writeFileSync(ghState, JSON.stringify({ prs: [], fail: [], log: [], calls: [] }));
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
  const clone = (name, person) => {
    const folder = join(root, name);
    git(root, env, "clone", "-q", origin, folder);
    git(folder, env, "config", "user.name", person);
    git(folder, env, "config", "user.email", `${name}@example.test`);
    return folder;
  };
  const eng = clone("eng", "Erin Engineer");
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
    gh: () => JSON.parse(readFileSync(ghState, "utf8")),
    /** Changes a pull request the way a reviewer would, under the stand-in gh's own lock (fakes/gh.py). */
    setPr(number, changes) {
      const script = `import fcntl, json, os, sys
path, number, changes = sys.argv[1], int(sys.argv[2]), json.loads(sys.argv[3])
lock = open(path + ".lock", "a")
fcntl.flock(lock, fcntl.LOCK_EX)
state = json.load(open(path))
state["prs"][number - 1].update(changes)
tmp = path + ".setpr.tmp"
json.dump(state, open(tmp, "w"))
os.replace(tmp, path)`;
      execFileSync(python, ["-I", "-B", "-c", script, ghState, String(number), JSON.stringify(changes)], { env });
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
    /** Engineering accepts a contribution: merge its branch into main and push; the PR shows merged. */
    land(branch) {
      git(eng, env, "fetch", "-q", "origin");
      git(eng, env, "merge", "-q", "--ff-only", "origin/main");
      git(eng, env, "merge", "-q", "--no-ff", "-m", `Merge ${branch}`, `origin/${branch}`);
      git(eng, env, "push", "-q", "origin", "main");
      world.gh().prs.forEach((pr, i) => {
        if (pr.head === branch && pr.state === "OPEN") world.setPr(i + 1, { state: "MERGED" });
      });
    },
    /** Someone else's accepted change on the shared main: edit a product file directly. */
    upstream(rel, pythonEdit) {
      git(eng, env, "fetch", "-q", "origin");
      git(eng, env, "merge", "-q", "--ff-only", "origin/main");
      const path = join(eng, rel);
      if (rel.endsWith(".json")) {
        const script = `import json,sys; sys.path.insert(0, ${JSON.stringify(join(repo, "skills/product-studio/scripts"))}); sys.path.insert(0, ${JSON.stringify(join(repo, "skills/intent/scripts"))})
import studio
p = ${JSON.stringify(path)}
d = json.load(open(p))
${pythonEdit}
d["revision"] += 1
open(p, "w").write(studio.canonical(d))`;
        execFileSync(python, ["-I", "-B", "-c", script], { env });
      } else {
        writeFileSync(path, pythonEdit(readFileSync(path, "utf8")));
      }
      git(eng, env, "add", "-A");
      git(eng, env, "commit", "-q", "-m", `change ${rel}`);
      git(eng, env, "push", "-q", "origin", "main");
    },
    /** Files changed by a branch on the shared remote, relative to the remote's main. */
    branchFiles(branch) {
      return git(origin, env, "diff", "--name-only", `main...${branch}`).split("\n").filter(Boolean);
    },
    remoteBranches() {
      return git(origin, env, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean);
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
