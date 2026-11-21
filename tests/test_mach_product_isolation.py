"""Product work must not change the existing line: nothing dispatches from product artifacts or the local policy."""

import ast
import hashlib
import json
import re
import shutil
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRODUCT_SCRIPTS = ROOT / "skills" / "product-studio" / "scripts"
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(PRODUCT_SCRIPTS))
from product import read_local_policy, validate_workspace  # noqa: E402
from test_run import Base  # noqa: E402

SEED = ROOT / "docs" / "mach-next" / "example-project"
ENABLED = {"schema_version": 1, "enabled": True, "paused": False, "auto_sync": True, "autonomy": "extended"}


class LineIsUnchangedTest(Base):
    """run.py names the same next step whether or not approved product work and an enabled policy are present."""

    def add_approved_product_and_enabled_policy(self):
        """A ready folder as Product Studio writes it without GitHub, and an enabled policy."""
        folder = self.project / "product/ready/SLICE-001"
        folder.mkdir(parents=True)
        spec, why = "# SLICE-001: Invite member\n\nTest-only content; not a valid MACH intent spec.\n", "# Intent: Invite member\n"
        (folder / "spec.md").write_text(spec)
        (folder / "why.md").write_text(why)
        (folder / "slice.json").write_text(json.dumps({"schema_version": 1, "slice_id": "SLICE-001", "title": "Invite member", "revision": 1,
                                                        "epic": {"epic_id": "EPIC-001", "title": "Membership"}, "dependencies": [],
                                                        "spec_sha256": hashlib.sha256(spec.encode()).hexdigest(),
                                                        "why_sha256": hashlib.sha256(why.encode()).hexdigest()}))
        local = self.project / ".factory/local"
        local.mkdir(parents=True)
        (local / "runner.json").write_text(json.dumps(ENABLED))

    def observe(self):
        code, board, err = self.run_cmd("status")
        self.assertEqual(code, 0, err)
        return {"next": self.next(), "headless": self.next("--headless"), "other": self.next(ticket="LOCAL-002"), "status": json.loads(board)}

    def check_unchanged(self):
        before = self.observe()
        self.add_approved_product_and_enabled_policy()
        self.assertTrue(read_local_policy(self.project)["enabled"])  # the policy is readable, and still starts nothing
        self.assertEqual(self.observe(), before)
        self.assertFalse((self.project / ".factory/tickets").exists())
        self.assertFalse((self.project / ".factory/worktrees/LOCAL-002").exists())

    def test_with_no_cell(self):
        (self.project / ".factory").mkdir(exist_ok=True)
        self.check_unchanged()

    def test_with_an_open_cell(self):
        self.cell_cmd("open", "LOCAL-001")
        self.check_unchanged()

    def test_with_a_built_cell(self):
        self.built()
        self.check_unchanged()


class NothingIsWiredInTest(unittest.TestCase):
    def test_no_station_reads_the_local_policy(self):
        """No station, agent, workflow or Product Studio script reads the machine-local policy. Only the
        supervisor's own modules in the run skill do, and only they can be affected by it."""
        found = []
        for top in ("skills", "agents", "workflows", "templates", "bin"):
            for path in sorted((ROOT / top).rglob("*")):
                # Two files may name it: the read-only reader from M0, and the run skill's policy module that owns it.
                if path.is_file() and "__pycache__" not in path.parts and path not in (PRODUCT_SCRIPTS / "product.py", ROOT / "skills/run/scripts/policy.py"):
                    if "runner.json" in path.read_text(encoding="utf-8", errors="ignore"):
                        found.append(str(path.relative_to(ROOT)))
        self.assertEqual(found, [])

    def test_only_intake_reaches_into_product_studio_and_only_to_read(self):
        """No station, agent or workflow calls Product Studio's scripts, with one exception: the run
        skill's intake module reuses its validator and its read-from-Git helper. It never publishes."""
        found = []
        for top in ("skills", "agents", "workflows", "bin"):
            for path in sorted((ROOT / top).rglob("*")):
                if path.is_file() and "__pycache__" not in path.parts and "product-studio" not in path.parts and path.suffix in (".py", ".js", ""):
                    text = path.read_text(encoding="utf-8", errors="ignore")
                    found += [f"{path.relative_to(ROOT)}: {word}" for word in ("studio.py", "product.py", "collab.py", "import product", "import studio", "import collab") if word in text]
        self.assertEqual(found, [])
        source = (ROOT / "skills" / "run" / "scripts" / "intake.py").read_text()
        for word in ("self.collab", "self.product", "sibling(\"product-studio\")"):
            self.assertNotIn(word, source)  # M11: the Factory reads what Product Studio handed over, never its scripts

    def test_intake_reads_git_and_starts_nothing(self):
        """Intake and the scheduler only query Git. Tickets and cells are made by the ticket and
        intent stations' own scripts; no agent, workflow or background process is started, and the
        machine-local Factory policy is never read."""
        source = (ROOT / "skills" / "run" / "scripts" / "intake.py").read_text()
        used = set(re.findall(r"git\(self\.root, \"([a-z-]+)\"", source)) | set(re.findall(r"git_bytes\(\"([a-z-]+)\"", source))
        self.assertEqual(used, {"symbolic-ref", "show-ref", "rev-parse", "merge-base", "diff", "rev-list", "check-ignore", "show", "ls-tree"})
        runs = sorted(re.findall(r"subprocess\.run\(\[([^\]]*)\]", source))
        self.assertEqual(runs, ["\"git\", *args", "sys.executable, str(path), \"--project\", str(self.root), *argv"])  # Git reads, and another station's script
        self.assertEqual(set(re.findall(r"self\.script\(\"(\w+)\", \"([\w.]+)\"", source)), {("ticket", "ticket.py"), ("intent", "cell.py")})
        for word in ("runner.json", "read_local_policy", "claude", "Workflow", "launchctl", "LaunchAgent", "hooks", "Popen", "os.system", "socket", "http",
                     "\"fetch\"", "\"push\"", "\"checkout\"", "\"switch\"", "\"reset\"", "\"pull\""):
            self.assertNotIn(word, source, word)
        run_source = (ROOT / "skills" / "run" / "scripts" / "run.py").read_text()
        self.assertEqual(run_source.count('"fetch"'), 1)  # only behind the explicit --fetch flag
        self.assertIn("if args.fetch:", run_source)
        for name in ("intake.py", "run.py"):
            text = (ROOT / "skills" / "run" / "scripts" / name).read_text()
            self.assertNotIn('"factory_started": True', text)

    def test_monitoring_reads_no_local_policy_and_starts_only_the_ticket_station(self):
        """M8 D7: monitoring.py is told whether the grant is in force; it never reads the machine-local policy, never
        imports Product Studio or the supervisor's modules, and reaches GitHub only through the ticket station's script."""
        source = (ROOT / "skills" / "run" / "scripts" / "monitoring.py").read_text()
        tree = ast.parse(source)
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertEqual(imported, {"json", "os", "sys", "datetime", "pathlib", "typing", "issue_rules"})
        for word in ("runner.json", "subprocess", "Popen", "os.system", "claude", "Workflow", "socket", "http", "studio", "collab", "\"fetch\"", "\"push\""):
            self.assertNotIn(word, source, word)
        self.assertEqual(set(re.findall(r"self\.line\.ticket\(\"([\w-]+)\"", source)), {"list", "request-check"})

    def test_the_validator_cannot_start_or_serve_anything(self):
        """Standard-library reading and checking only: no processes, no network, no writing."""
        allowed = {"argparse", "datetime", "hashlib", "json", "re", "sys", "pathlib", "typing"}
        # The two lines every entry point carries (M14: they load MACH's own fault recorder, skills/intent/scripts/faults.py)
        # are held by tests/test_faults.py; everything else here is held as before.
        lines = (PRODUCT_SCRIPTS / "product.py").read_text().splitlines()
        wrapper = [line for line in lines if line.startswith(("    import contextlib as _c, os as _o, runpy as _r", "    with _c.suppress(Exception): _r.run_path("))]
        self.assertEqual(len(wrapper), 2)
        tree = ast.parse("\n".join(line for line in lines if line not in wrapper))
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [(node.module or "").split(".")[0]]
            for name in names:
                self.assertIn(name, allowed, f"product.py imports {name}")
            if isinstance(node, ast.Attribute):
                self.assertNotIn(node.attr, ("write_text", "write_bytes", "unlink", "mkdir", "rename", "system", "popen"))
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertNotIn(node.func.id, ("open", "exec", "eval", "__import__"))

    GIT_ALLOWED = {
        # reading
        "rev-parse", "check-ignore", "config", "remote", "symbolic-ref", "ls-tree", "show", "cat-file", "for-each-ref", "diff", "merge-base",
        # M16 B: Shape's sizing lists the integration commits that added or changed a shipped slice's spec, to find what it changed. A read.
        "rev-list",
        # (M11: no fetch, worktree, commit or push: a slice reaches the builders as an issue or a folder)
    }

    def test_studio_uses_only_the_git_and_gh_commands_it_is_meant_to(self):
        """Product Studio may read, fetch, build a contribution in its own temporary worktree and
        push that one branch. It may never rewrite history or move the product manager's checkout."""
        sources = {name: (PRODUCT_SCRIPTS / name).read_text() for name in ("studio.py", "collab.py", "requests_in.py", "prd.py", "shape.py", "validate_brief.py",
                                                                            "shape_route.py")}
        for name in ("studio.py", "requests_in.py", "prd.py", "shape.py", "validate_brief.py", "shape_route.py"):
            imported = set()
            for node in ast.walk(ast.parse(sources[name])):
                if isinstance(node, ast.Import):
                    imported |= {alias.name.split(".")[0] for alias in node.names}
                elif isinstance(node, ast.ImportFrom):
                    imported.add((node.module or "").split(".")[0])
            self.assertFalse(imported & {"subprocess", "socket", "http", "urllib", "shutil"}, (name, imported))  # Git and gh go through collab.py
        used = set()
        for source in sources.values():
            used |= set(re.findall(r"git\(\[\"([a-z-]+)\"", source))                          # cell.git(["config", ...], project)
            used |= set(re.findall(r"git(?:_bytes)?\([a-z_.]+, \"([a-z-]+)\"", source))         # collab.git(project, "fetch", ...)
            used |= set(re.findall(r"\[\"git\", \"([a-z-]+)\"", source))                       # subprocess.run(["git", "cat-file", ...])
        self.assertEqual(used - self.GIT_ALLOWED, set())
        self.assertFalse(used & {"fetch", "push", "worktree", "commit", "merge"}, used)
        collab_source = sources["collab.py"]
        self.assertEqual(set(re.findall(r"gh(?:_json|_write)?\([a-z_.]+, \"issue\", \"([a-z]+)\"", collab_source)), {"list", "view", "comment", "close"})
        self.assertEqual(set(re.findall(r"gh(?:_json|_write)?\([a-z_.]+, \"repo\", \"([a-z]+)\"", collab_source)), {"view"})
        self.assertEqual(set(re.findall(r"gh(?:_json|_write)?\([a-z_.]+, \"([a-z]+)\"", collab_source)), {"issue", "repo", "api"})
        # gh api only reads, and only the two paths that say who labelled an issue and what access that account has.
        api_calls = re.findall(r"gh(?:_json|_write)?\([a-z_.]+, \"api\"[^\n]*", collab_source)
        self.assertEqual(len(api_calls), 2, api_calls)
        self.assertTrue(all(call.startswith("gh_json(") for call in api_calls), api_calls)  # a read, never a write
        self.assertEqual(sorted(re.search(r"(EVENTS_PATH|PERMISSION_PATH)\.format", call).group(1) for call in api_calls), ["EVENTS_PATH", "PERMISSION_PATH"])
        self.assertIn('EVENTS_PATH = "repos/{repository}/issues/{number}/events?per_page=100"', collab_source)
        self.assertIn('PERMISSION_PATH = "repos/{repository}/collaborators/{login}/permission"', collab_source)
        for flag in ("\"-X\"", "\"--method\"", "\"-F\"", "\"--field\"", "\"--raw-field\"", "\"--input\""):
            self.assertNotIn(flag, collab_source, flag)
        # A request's issue gets no label from Product Studio (M11): its progress is told by comments.
        for word in ("--add-label", "--remove-label", "\"label\", \"create\"", "STATUS_LABELS", "GROOMING"):
            self.assertNotIn(word, collab_source + sources["requests_in.py"], word)
        for source in sources.values():
            for word in ("--force", "\"-f\"", "--force-with-lease", "\"reset\"", "\"checkout\"", "\"switch\"", "\"rebase\"", "\"stash\"", "\"pull\"",
                         "\"clean\"", "--no-verify", "--no-gpg-sign", "--admin", "--auto", "runner.json", "read_local_policy", "run.py", "ticket-new",
                         "cell_dir", "write_cell", "ticket.py", "import ticket", "--delete", "\"lock\"", "\"transfer\""):
                self.assertNotIn(word, source, word)
        # studio.py has its own `slice reopen`; no GitHub reopen exists anywhere Studio reaches GitHub.
        for name in ("collab.py", "requests_in.py"):
            for word in ("reopen", "lock", "transfer"):
                self.assertNotIn(word, re.sub(r"(?i)\bblock\w*|\bclock\w*|\blocal\w*", "", sources[name]), (name, word))
        self.assertFalse(re.findall(r"git\([^\n]*\"push\"", "\n".join(sources.values())))  # nothing is ever pushed
        # M13 D: the PRD on-ramp reaches neither Git nor GitHub at all, so a PRD's text has no way there.
        self.assertFalse(re.findall(r"\b(?:git|git_bytes|gh|gh_json|gh_write)\(", sources["prd.py"]))
        for word in ("collab", "issues.", "handoff", "requests_in", "import subprocess", "urllib", "socket"):
            self.assertNotIn(word, sources["prd.py"], word)
        # M16: the brief's validator is pure; it reads no file, runs nothing and reaches neither Git nor GitHub.
        validator = sources["validate_brief.py"]
        self.assertFalse(re.findall(r"\b(?:git|git_bytes|gh|gh_json|gh_write)\(", validator))
        for word in ("collab", "issues", "handoff", "requests_in", "open(", "write_text", "unlink", "os.system"):
            self.assertNotIn(word, validator.split("def main(")[0], word)
        # M16 B: sizing reads Git only to list what a shipped slice changed: these three reads and no other Git command.
        route = sources["shape_route.py"]
        self.assertEqual(set(re.findall(r"git\(\[\"([a-z-]+)\"", route)), {"rev-list", "rev-parse", "diff"})

    def test_studio_reaches_the_run_skill_only_for_the_compiler_and_it_only_reads_git(self):
        """M13 C: `epic current` loads the run skill's current.py and nothing else of the run skill. current.py, and the
        intake function it borrows to name the integration branch, only read Git: no fetch, no push, no write."""
        source = (PRODUCT_SCRIPTS / "studio.py").read_text()
        self.assertEqual(re.findall(r'/ "scripts" / "([a-z_]+\.py)"', source), ["current.py"])
        for name in ("intake.py", "supervisor.py", "executor.py", "policy.py", "Factory("):
            self.assertNotIn(name, source)
        current = (ROOT / "skills" / "run" / "scripts" / "current.py").read_text()
        self.assertEqual(set(re.findall(r'_git\(root, "([a-z-]+)"', current)), {"rev-parse", "merge-base", "ls-tree", "cat-file"})
        self.assertEqual(re.findall(r"subprocess\.run\(\[\"git\", \*args\]", current), ['subprocess.run(["git", *args]'] * 2)
        intake_source = (ROOT / "skills" / "run" / "scripts" / "intake.py").read_text()
        borrowed = intake_source[intake_source.index("    def integration(self)"):intake_source.index("    def git_bytes(")]
        self.assertEqual(set(re.findall(r"git\(self\.root, \"([a-z-]+)\"", borrowed)), {"symbolic-ref", "show-ref", "rev-parse", "merge-base", "diff", "rev-list"})

    def test_the_hand_off_uses_only_the_gh_calls_it_is_meant_to(self):
        """M11: issues.py holds every GitHub call that saves a slice as an issue; handoff.py decides and
        records, and reaches GitHub only through it. No Git at all, no closing, deleting, locking or
        transferring an issue, and only mach:ready is ever removed."""
        sources = {name: (PRODUCT_SCRIPTS / name).read_text() for name in ("issues.py", "handoff.py")}
        for name, source in sources.items():
            imported = set()
            for node in ast.walk(ast.parse(source)):
                if isinstance(node, ast.Import):
                    imported |= {alias.name.split(".")[0] for alias in node.names}
                elif isinstance(node, ast.ImportFrom):
                    imported.add((node.module or "").split(".")[0])
            self.assertFalse(imported & {"subprocess", "socket", "http", "urllib"}, (name, imported))
            for word in ("git(", "git_bytes(", "\"push\"", "\"close\"", "\"delete\"", "\"lock\"", "\"transfer\"", "\"reopen\"", "--force", "runner.json",
                         "read_local_policy", "run.py", "ticket.py", "import ticket", "\"DELETE\""):
                self.assertFalse(word in source, (name, word))
        handoff_source = sources["handoff.py"]
        self.assertFalse(re.findall(r"collab\.(gh|_gh_json|_gh_write)\(", handoff_source))  # GitHub only through issues.py
        issues_source = sources["issues.py"]
        calls = set(re.findall(r"_gh_(?:json|write)\(project, \"([a-z]+)\", \"([a-z]+|--[a-z]+)\"", issues_source))
        calls |= set(re.findall(r"args = \[\"(issue)\", \"([a-z]+)\"", issues_source))
        self.assertEqual(calls, {("issue", "list"), ("issue", "view"), ("issue", "create"), ("issue", "edit"), ("issue", "comment"), ("issue", "pin"),
                                 ("label", "list"), ("label", "create"), ("api", "--paginate"), ("api", "--method")} | {("api", "--method")})
        api = re.findall(r"_gh_(?:json|write)\(project, \"api\"[^\n]*", issues_source)
        paths = sorted(re.search(r"(\"user\"|ISSUE_PATH|SUB_ISSUES_PATH|PRIORITY_PATH)", call).group(1) for call in api)
        self.assertEqual(paths, ["\"user\"", "ISSUE_PATH", "PRIORITY_PATH", "SUB_ISSUES_PATH", "SUB_ISSUES_PATH", "SUB_ISSUES_PATH"])
        # The sub-issues are read twice over (ids to link, ids and numbers to compare orders); the order is written only by PRIORITY_PATH.
        self.assertEqual(sorted(re.findall(r'"--jq", "(\.\[\] \| \{[a-z, ]+\})"', issues_source)), [".[] | {id, number}", ".[] | {id}"])
        writes = [call for call in api if "--method" in call]
        self.assertEqual(sorted(re.search(r"\"--method\", \"([A-Z]+)\"", call).group(1) for call in writes), ["PATCH", "POST"])
        self.assertTrue(all(call.startswith("_gh_write(") for call in writes) and all(call.startswith("_gh_json(") for call in api if call not in writes))
        self.assertIn('SUB_ISSUES_PATH = "repos/{repository}/issues/{number}/sub_issues"', issues_source)
        self.assertIn('PRIORITY_PATH = "repos/{repository}/issues/{number}/sub_issues/priority"', issues_source)
        self.assertIn('ISSUE_PATH = "repos/{repository}/issues/{number}"', issues_source)
        removals = re.findall(r"--remove-label[^\n]*", issues_source)
        self.assertEqual(removals, ['--remove-label", READY)', '--remove-label", name]'])
        self.assertIn('READY = "mach:ready"', issues_source)
        # M16: the second removal is an idea's own state labels, and only those: set_idea_state refuses any other name first.
        states = issues_source[issues_source.index("def set_idea_state("):issues_source.index("def comment(")]
        self.assertIn("if add not in IDEA_STATES or any(name not in IDEA_STATES or name == add for name in remove):", states)
        self.assertIn('--remove-label", name]', states)
        self.assertTrue(all(name.startswith("mach:idea-") for name in re.search(r"IDEA_STATES = \(([^)]*)\)", issues_source).group(1).replace('"', "").split(", ")))
        self.assertNotIn("--body\"", issues_source)  # text goes in a file written from a template, never on the command line
        # studio.py reads issues only to settle a slice someone else changed; it writes through handoff.py.
        studio_source = (PRODUCT_SCRIPTS / "studio.py").read_text()
        self.assertEqual(set(re.findall(r"\bissues\.([a-z_]+)\(", studio_source)), {"view", "comments"})
        # M13: publishing the principles added no GitHub call. handoff.py uses exactly these of issues.py's calls.
        self.assertEqual(set(re.findall(r"\bissues\.([a-z_]+)\(", handoff_source)),
                         {"add_labels", "add_sub_issue", "comment", "comments", "create", "create_label", "database_id", "label_names", "labels",
                          "list_issues", "pin", "place_sub_issue", "remove_ready", "rewrite", "signed_in", "sub_issue_numbers", "sub_issues",
                          "unavailable", "view"})
        # M17: the principles and the technical needs are published by one shared function, publish_set.
        publish = handoff_source[handoff_source.index("    def publish_set("):handoff_source.index("    def write_set_folder(")]
        self.assertEqual(set(re.findall(r"\bissues\.([a-z_]+)\(", publish)), {"labels", "create_label", "comments", "comment"})
        self.assertIn("rules_set.approval_comment(", publish)  # the only comment it writes is the set's fixed approval template
        # M16: Shape reaches GitHub only through issues.py (and handoff's channel, which decides GitHub or the folder), with exactly
        # these calls. Publishing writes the idea's issue from its fixed template, its labels, and the one verdict comment template.
        shape_source = (PRODUCT_SCRIPTS / "shape.py").read_text()
        self.assertFalse(re.findall(r"collab\.|\b(?:git|git_bytes|gh|gh_json|gh_write|_gh_json|_gh_write)\(", shape_source))
        self.assertEqual(set(re.findall(r"\bissues\.([a-z_]+)\(", shape_source)),
                         {"labels", "create_label", "list_issues", "create", "view", "label_names", "rewrite", "set_idea_state", "comments", "comment"})
        self.assertEqual(set(re.findall(r"\bhandoff\.([A-Za-z_]+)\b", shape_source)) - {"py"}, {"explain", "HandoffError"})  # "handoff.py" in prose
        self.assertEqual(re.findall(r"\.handoff\(\)\.([a-z_]+)\(", shape_source), ["channel"] * 4)
        idea_publish = shape_source[shape_source.index("def publish("):shape_source.index("def remember(")]
        self.assertEqual(set(re.findall(r"\bissues\.([a-z_]+)\(", idea_publish)),
                         {"labels", "create_label", "list_issues", "create", "view", "label_names", "rewrite", "set_idea_state", "comments", "comment"})
        self.assertIn("rules.shape_issue_body(", idea_publish)
        self.assertEqual(re.findall(r"text = rules\.([a-z_]+)\(", idea_publish), ["shape_verdict_comment"])  # the only comment it writes
        refresh = shape_source[shape_source.index("def refresh("):shape_source.index("# ---- the board and one idea ----")]
        self.assertEqual(set(re.findall(r"\bissues\.([a-z_]+)\(", refresh)), {"list_issues", "comments"})  # refresh only reads
        for word in ("mach:ready", "mach:slice", "mach:request", "issues.close", "\"close\"", "\"delete\"", "\"lock\"", "transfer", "pin(", "push", "runner.json",
                     "ticket.py", "cell.py", "start_slice", "add_epic"):
            self.assertNotIn(word, shape_source, word)
        # M16 B: Part B reaches GitHub only through Part A's comment_once, for the one look-back comment from its fixed template; it reads
        # the hand-off's own record (load) and asks its channel who is signed in; it makes epics and draft slices only through Studio's own
        # epic add and slice new (host.add_epic, host.start_slice, by way of prd.apply_map), and nothing in it reaches the Factory.
        route = (PRODUCT_SCRIPTS / "shape_route.py").read_text()
        self.assertFalse(re.findall(r"collab\.|\bissues\.|\b(?:gh|gh_json|gh_write|_gh_json|_gh_write)\(", route))
        self.assertEqual(set(re.findall(r"\bshape\.(comment_once)\(", route)), {"comment_once"})
        self.assertEqual(re.findall(r"text = rules\.([a-z_]+)\(", route), ["shape_lookback_comment"])
        self.assertEqual(sorted(set(re.findall(r"\.handoff\(\)\.([a-z_]+)\(", route))), ["channel", "load"])
        self.assertEqual(set(re.findall(r"\bhandoff\.([A-Za-z_]+)\(", route)), {"slice_view"})
        self.assertEqual(set(re.findall(r"\bhost\.(add_epic|start_slice)\(", route)), {"add_epic", "start_slice"})
        for word in ("mach:ready", "mach:slice", "mach:request", "\"close\"", "\"delete\"", "\"lock\"", "transfer", "pin(", "push", "runner.json",
                     "ticket.py", "cell.py", "intake", "Factory(", "subprocess", "claude -p"):
            self.assertNotIn(word, route, word)
        # M13 E: linking a slice or an epic to Jira reaches neither GitHub nor Jira; the key travels only in the fixed templates.
        for name in ("cmd_slice_link", "cmd_epic_link", "jira_key", "with_tracking", "effective_jira", "link_slice", "link_epic"):
            body = studio_source[studio_source.index(f"def {name}("):]
            body = body[:body.index("\ndef ", 1)]
            for word in ("issues.", "collab.", "handoff()", "requests()", "gh(", "git(", "http", "urllib", "socket"):
                self.assertNotIn(word, body, (name, word))
        # M13 E: the Jira export and the keys back read the workspace and the last refresh; they reach neither Git, GitHub nor a network,
        # and they write only through Studio's own write and link helpers.
        export = (PRODUCT_SCRIPTS / "jira_export.py").read_text()
        self.assertFalse(re.findall(r"\b(?:git|git_bytes|gh|gh_json|gh_write|_gh_json|_gh_write)\(", export))
        for word in ("collab", "issues.", "requests()", "import subprocess", "urllib", "socket", "import http", "import os", "shutil"):
            self.assertNotIn(word, export, word)
        self.assertEqual(set(re.findall(r"\bhandoff\.([a-z_]+)\(", export)), {"order_rows", "slice_view", "epic_number"})
        self.assertEqual(set(re.findall(r"\.(write_text|write_bytes|unlink|rename|rmdir)\(", export)), set())

    def test_the_principles_check_only_reads(self):
        """M13: ticket.py principles-check reads the project's issue, its comments and the approver's role; it writes nothing."""
        source = (ROOT / "skills" / "ticket" / "scripts" / "ticket.py").read_text()
        body = source[source.index("def cmd_principles_check("):source.index("def cmd_slice_status(")]
        self.assertEqual(sorted(set(re.findall(r"gh_read\(ctx, (\"[^\"]+\", \"[^\"]+\")", body))), ['"issue", "list"'])
        self.assertEqual(set(re.findall(r"\b(read_[a-z]+)\(", body)), {"read_issue", "read_comments", "read_permission"})
        for word in ("gh_call(", "--method", "\"edit\"", "\"comment\"", "\"close\"", "\"create\"", "write_text", "--add-label"):
            self.assertNotIn(word, body, word)

    def test_studio_imports_only_the_rules_from_the_ticket_skill(self):
        """Product Studio shares the ticket skill's issue rules and nothing else from it."""
        ticket_modules = {path.stem for path in (ROOT / "skills" / "ticket" / "scripts").glob("*.py")}
        self.assertIn("issue_rules", ticket_modules)
        found = set()
        for path in sorted((ROOT / "skills" / "product-studio").rglob("*.py")):
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.Import):
                    found |= {alias.name.split(".")[0] for alias in node.names} & ticket_modules
                elif isinstance(node, ast.ImportFrom):
                    found |= {(node.module or "").split(".")[0]} & ticket_modules
        self.assertEqual(found, {"issue_rules"})

    def test_issue_rules_is_pure(self):
        """The shared rules decide and format; they run nothing, write nothing and reach nothing."""
        tree = ast.parse((ROOT / "skills" / "ticket" / "scripts" / "issue_rules.py").read_text())
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [(node.module or "").split(".")[0]]
            for name in names:
                self.assertIn(name, {"hashlib", "json", "re", "typing", "unicodedata"}, f"issue_rules.py imports {name}")
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertNotIn(node.func.id, ("open", "eval", "exec", "__import__", "compile"))
            if isinstance(node, ast.Attribute):
                self.assertFalse(node.attr.startswith("write_") or node.attr in ("unlink", "mkdir", "system", "popen", "run"), node.attr)
            if isinstance(node, ast.Name):
                self.assertNotIn(node.id, ("subprocess", "os", "socket"))

    def test_report_never_authorizes(self):
        for name in ("product.py", "studio.py", "collab.py", "requests_in.py", "issues.py", "handoff.py", "prd.py", "jira_export.py", "shape.py", "validate_brief.py",
                     "shape_route.py", "needs.py"):
            source = (PRODUCT_SCRIPTS / name).read_text()
            self.assertNotIn('"factory_authorized": True', source)
        for name in ("product.py", "studio.py", "prd.py", "jira_export.py", "shape.py", "shape_route.py", "needs.py"):
            self.assertIn('"factory_authorized": False', (PRODUCT_SCRIPTS / name).read_text())


if __name__ == "__main__":
    unittest.main()
