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
        shutil.copytree(SEED / "product", self.project / "product")
        spec = self.project / "specs/slices/SLICE-001-invite-member.md"
        spec.parent.mkdir(parents=True, exist_ok=True)
        spec.write_text("# SLICE-001: Invite member\n\nTest-only content; not a valid MACH intent spec.\n")
        for relative, change in (
            ("product/slices/SLICE-001.json", {"status": "approved_for_engineering", "open_questions": [],
                                               "spec_path": "specs/slices/SLICE-001-invite-member.md",
                                               "spec_sha256": hashlib.sha256(spec.read_bytes()).hexdigest()}),
            ("product/delivery-waves/WAVE-001.json", {"status": "approved_for_engineering",
                                                      "approval": {"actor": "PM A", "approved_at": "2026-11-10T14:00:00Z"}}),
        ):
            path = self.project / relative
            path.write_text(json.dumps({**json.loads(path.read_text()), **change}))
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
        report = validate_workspace(self.project)
        self.assertTrue(report["valid"], report["errors"])
        self.assertFalse(report["factory_authorized"])
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
        intake = ROOT / "skills" / "run" / "scripts" / "intake.py"
        found = []
        for top in ("skills", "agents", "workflows", "bin"):
            for path in sorted((ROOT / top).rglob("*")):
                if path.is_file() and "__pycache__" not in path.parts and "product-studio" not in path.parts and path != intake and path.suffix in (".py", ".js", ""):
                    text = path.read_text(encoding="utf-8", errors="ignore")
                    found += [f"{path.relative_to(ROOT)}: {word}" for word in ("studio.py", "product.py", "collab.py", "import product", "import studio", "import collab") if word in text]
        self.assertEqual(found, [])
        source = intake.read_text()
        self.assertNotIn("import studio", source)
        self.assertEqual(set(re.findall(r"self\.collab\.(\w+)", source)), {"files_at", "tracked", "git_bytes"})
        self.assertEqual(set(re.findall(r"self\.product\.(\w+)", source)), {"validate_workspace"})

    def test_intake_reads_git_and_starts_nothing(self):
        """Intake and the scheduler only query Git. Tickets and cells are made by the ticket and
        intent stations' own scripts; no agent, workflow or background process is started, and the
        machine-local Factory policy is never read."""
        source = (ROOT / "skills" / "run" / "scripts" / "intake.py").read_text()
        used = set(re.findall(r"git\(self\.root, \"([a-z-]+)\"", source)) | set(re.findall(r"git_bytes\(self\.root, \"([a-z-]+)\"", source))
        self.assertEqual(used, {"symbolic-ref", "show-ref", "rev-parse", "merge-base", "diff", "rev-list", "check-ignore", "show"})
        runs = re.findall(r"subprocess\.run\(\[([^\]]*)\]", source)
        self.assertEqual(len(runs), 1)
        self.assertTrue(runs[0].startswith("sys.executable, str(path)"))  # only another station's script, with this Python
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
        tree = ast.parse((PRODUCT_SCRIPTS / "product.py").read_text())
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
        # the shared project, and a contribution built in a temporary worktree
        "fetch", "worktree", "add", "commit", "merge", "update-ref", "push",
    }

    def test_studio_uses_only_the_git_and_gh_commands_it_is_meant_to(self):
        """Product Studio may read, fetch, build a contribution in its own temporary worktree and
        push that one branch. It may never rewrite history or move the product manager's checkout."""
        sources = {name: (PRODUCT_SCRIPTS / name).read_text() for name in ("studio.py", "collab.py", "requests_in.py")}
        for name in ("studio.py", "requests_in.py"):
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
        self.assertTrue({"fetch", "push", "worktree"} <= used, used)
        self.assertEqual(used - self.GIT_ALLOWED, set())
        gh_used = set(re.findall(r"gh\([a-z_.]+, \"pr\", \"([a-z]+)\"", sources["collab.py"])) | set(re.findall(r"\[\"pr\", \"([a-z]+)\"", sources["collab.py"]))
        self.assertEqual(gh_used, {"list", "create", "view"})  # never merge, close, review or edit
        collab_source = sources["collab.py"]
        self.assertEqual(set(re.findall(r"gh(?:_json|_write)?\([a-z_.]+, \"issue\", \"([a-z]+)\"", collab_source)), {"list", "view", "edit", "comment", "close"})
        self.assertEqual(set(re.findall(r"gh(?:_json|_write)?\([a-z_.]+, \"label\", \"([a-z]+)\"", collab_source)), {"create"})
        self.assertEqual(set(re.findall(r"gh(?:_json|_write)?\([a-z_.]+, \"repo\", \"([a-z]+)\"", collab_source)), {"view"})
        self.assertEqual(set(re.findall(r"gh(?:_json|_write)?\([a-z_.]+, \"([a-z]+)\"", collab_source)), {"pr", "issue", "label", "repo", "api"})
        # gh api only reads, and only the two paths that say who labelled an issue and what access that account has.
        api_calls = re.findall(r"gh(?:_json|_write)?\([a-z_.]+, \"api\"[^\n]*", collab_source)
        self.assertEqual(len(api_calls), 2, api_calls)
        self.assertTrue(all(call.startswith("gh_json(") for call in api_calls), api_calls)  # a read, never a write
        self.assertEqual(sorted(re.search(r"(EVENTS_PATH|PERMISSION_PATH)\.format", call).group(1) for call in api_calls), ["EVENTS_PATH", "PERMISSION_PATH"])
        self.assertIn('EVENTS_PATH = "repos/{repository}/issues/{number}/events?per_page=100"', collab_source)
        self.assertIn('PERMISSION_PATH = "repos/{repository}/collaborators/{login}/permission"', collab_source)
        for flag in ("\"-X\"", "\"--method\"", "\"-F\"", "\"--field\"", "\"--raw-field\"", "\"--input\""):
            self.assertNotIn(flag, collab_source, flag)
        # A label is added only from MACH's own status labels, never removed by Studio, and never created with --force.
        edits = re.findall(r"\"issue\", \"edit\"[^\n]*", collab_source)
        self.assertTrue(edits)
        self.assertTrue(all("\"--add-label\", label" in edit for edit in edits), edits)
        self.assertIn("if label not in labels:", collab_source)
        self.assertNotIn("--remove-label", collab_source)
        studio_source = sources["studio.py"] + sources["requests_in.py"]
        self.assertNotIn("STATUS_LABELS[", studio_source)
        self.assertIn("rules.STATUS_LABELS)", sources["requests_in.py"])
        self.assertNotIn("--force", re.search(r"\"label\", \"create\"[^\n]*\n[^\n]*", collab_source).group(0))
        for source in sources.values():
            for word in ("--force", "\"-f\"", "--force-with-lease", "\"reset\"", "\"checkout\"", "\"switch\"", "\"rebase\"", "\"stash\"", "\"pull\"",
                         "\"clean\"", "--no-verify", "--no-gpg-sign", "--admin", "--auto", "runner.json", "read_local_policy", "run.py", "ticket-new",
                         "cell_dir", "write_cell", "ticket.py", "import ticket", "--delete", "\"lock\"", "\"transfer\""):
                self.assertNotIn(word, source, word)
        # studio.py has its own `slice reopen`; no GitHub reopen exists anywhere Studio reaches GitHub.
        for name in ("collab.py", "requests_in.py"):
            for word in ("reopen", "lock", "transfer"):
                self.assertNotIn(word, re.sub(r"(?i)\bblock\w*|\bclock\w*|\blocal\w*", "", sources[name]), (name, word))
        # A push names an exact commit and a branch under the product prefix; nothing else is pushed.
        pushes = re.findall(r"git\([^\n]*\"push\"[^\n]*", "\n".join(sources.values()))
        self.assertEqual(len(pushes), 1)
        self.assertIn("refs/heads/{branch}", pushes[0])
        self.assertIn("branch = studio.shared.prefix + wave_id", sources["studio.py"])

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
        self.assertEqual(paths, ["\"user\"", "ISSUE_PATH", "PRIORITY_PATH", "SUB_ISSUES_PATH", "SUB_ISSUES_PATH"])
        writes = [call for call in api if "--method" in call]
        self.assertEqual(sorted(re.search(r"\"--method\", \"([A-Z]+)\"", call).group(1) for call in writes), ["PATCH", "POST"])
        self.assertTrue(all(call.startswith("_gh_write(") for call in writes) and all(call.startswith("_gh_json(") for call in api if call not in writes))
        self.assertIn('SUB_ISSUES_PATH = "repos/{repository}/issues/{number}/sub_issues"', issues_source)
        self.assertIn('PRIORITY_PATH = "repos/{repository}/issues/{number}/sub_issues/priority"', issues_source)
        self.assertIn('ISSUE_PATH = "repos/{repository}/issues/{number}"', issues_source)
        removals = re.findall(r"--remove-label[^\n]*", issues_source)
        self.assertEqual(removals, ['--remove-label", READY)'])
        self.assertIn('READY = "mach:ready"', issues_source)
        self.assertNotIn("--body\"", issues_source)  # text goes in a file written from a template, never on the command line
        # studio.py reads issues only to settle a slice someone else changed; it writes through handoff.py.
        studio_source = (PRODUCT_SCRIPTS / "studio.py").read_text()
        self.assertEqual(set(re.findall(r"\bissues\.([a-z_]+)\(", studio_source)), {"view", "comments"})

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
        for name in ("product.py", "studio.py", "collab.py", "requests_in.py", "issues.py", "handoff.py"):
            source = (PRODUCT_SCRIPTS / name).read_text()
            self.assertNotIn('"factory_authorized": True', source)
        for name in ("product.py", "studio.py"):
            self.assertIn('"factory_authorized": False', (PRODUCT_SCRIPTS / name).read_text())


if __name__ == "__main__":
    unittest.main()
