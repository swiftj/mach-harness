"""Tests for audit.py: detection, scoring, tiers, blockers and the gate, on small sample repositories."""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "audit" / "scripts"))
import audit  # noqa: E402

PASSING_TEST = "import unittest\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1 + 1, 2)\n"
FAILING_TEST = PASSING_TEST.replace("1 + 1, 2", "1 + 1, 3")
README = "# Sample\n\n" + "This project exists to exercise the readiness audit. " * 6 + "\n"
HARDENED = {
    "README.md": README,
    "CLAUDE.md": "rules\n", "AGENTS.md": "agents\n", "REVIEW.md": "review\n",
    ".gitignore": "__pycache__/\n.factory/\n",
    "Makefile": "lint:\n\t@true\n",
    "mypy.ini": "[mypy]\n", ".editorconfig": "root = true\n",
    ".pre-commit-config.yaml": "repos:\n  - repo: https://github.com/gitleaks/gitleaks\n",
    "proto/app/v1/app.proto": 'syntax = "proto3";\n',
    "app/__init__.py": "", "app/core.py": "def add(a, b):\n    return a + b\n",
    "tests/test_core.py": PASSING_TEST,
}


def git(project, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    return subprocess.run(["git", "-c", "commit.gpgsign=false", *args], cwd=str(project), capture_output=True, text=True, env=env)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve() / "sample"
        self.project.mkdir()

    def write(self, files):
        for name, text in files.items():
            path = self.project / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def commit(self, message="work"):
        if not (self.project / ".git").exists():
            git(self.project, "init", "-q", "-b", "main")
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", message)

    def repo(self, files=None, **changes):
        self.write({**(HARDENED if files is None else files), **changes})
        self.commit()

    def run_audit(self, *argv, command="run"):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = audit.main(["--project", str(self.project), command, *argv])
        return code, out.getvalue(), err.getvalue()

    def report(self, *argv):
        code, out, err = self.run_audit("--json", *argv)
        self.assertIn(code, (0, 1), err)
        data = json.loads(out)
        data["exit"] = code
        data["by_check"] = {check["check"]: check for check in data["checks"]}
        return data


class TierTest(Base):
    def test_hardened_repository_is_gold(self):
        self.repo()
        r = self.report()
        self.assertEqual((r["readiness_score"], r["readiness_tier"], r["pipeline_status"], r["exit"]), (98, "Gold", "APPROVED", 0))
        self.assertEqual(r["unverified"], ["Main branch protected"])
        self.assertEqual(r["blockers"], [])
        self.assertEqual({k: (v["score"], v["max"]) for k, v in r["pillars"].items()},
                         {"environment": (25, 25), "test_health": (25, 25), "linting_security": (20, 20), "contracts": (15, 15), "git_hygiene": (13, 15)})
        self.assertEqual(r["commands"]["test"]["source"], "python")
        self.assertEqual(r["commands"]["lint"]["command"], "make lint")
        self.assertEqual(json.loads((self.project / ".factory/audit-report.json").read_text())["readiness_score"], 98)
        self.assertEqual(git(self.project, "status", "--porcelain").stdout, "", "the audit must leave the tree clean")

    def test_failing_tests_block_whatever_the_score(self):
        self.repo(**{"tests/test_core.py": FAILING_TEST})
        r = self.report()
        self.assertEqual((r["readiness_tier"], r["pipeline_status"], r["exit"]), ("Bronze", "BLOCKED", 1))
        self.assertGreaterEqual(r["readiness_score"], 80)
        self.assertEqual(r["blockers"], ["The baseline tests do not pass."])
        self.assertEqual(r["by_check"]["Suite finishes in under 5 minutes"]["note"], "Not counted: the suite did not pass.")

    def test_no_tests_is_a_blocker(self):
        files = {k: v for k, v in HARDENED.items() if not k.startswith("tests/")}
        self.repo(files)
        r = self.report()
        self.assertEqual(r["blockers"], ["There is no runnable test suite."])
        self.assertEqual(r["readiness_tier"], "Bronze")

    def test_broken_build_is_a_blocker(self):
        self.repo(**{"app/broken.py": "def oops(:\n"})
        r = self.report()
        self.assertIn("The build fails.", r["blockers"])
        self.assertIn("app/broken.py:1", r["commands"]["build"]["output_tail"])

    def test_silver_needs_human_review_and_fails_strict(self):
        files = {k: v for k, v in HARDENED.items() if k not in ("Makefile", "mypy.ini", ".pre-commit-config.yaml", "proto/app/v1/app.proto")}
        self.repo(files)
        r = self.report()
        self.assertEqual((r["readiness_score"], r["readiness_tier"], r["human_review_required"], r["exit"]), (71, "Silver", True, 0))
        self.assertEqual(self.report("--strict")["exit"], 1)
        self.assertTrue(r["recommendations"][0].endswith("(+6)"))

    def test_thresholds_come_from_config(self):
        self.repo(**{".factory/config.json": json.dumps({"audit": {"gold": 99}})})
        git(self.project, "rm", "-q", "--cached", "-r", ".factory")
        self.commit()
        self.assertEqual(self.report()["readiness_tier"], "Silver")


class CheckTest(Base):
    def test_dirty_tree_conflict_markers_and_thin_readme(self):
        self.repo(**{"README.md": "# x\n"})
        self.write({"scratch.txt": "junk\n", "app/core.py": "<<<<<<< HEAD\na = 1\n=======\na = 2\n>>>>>>> other\n"})
        r = self.report()
        checks = r["by_check"]
        self.assertEqual(checks["Clean working tree"]["score"], 0)
        self.assertIn("2 uncommitted", checks["Clean working tree"]["note"])
        self.assertIn("app/core.py", checks["No merge conflict markers"]["note"])
        self.assertIn("nearly empty", checks["README present"]["note"])
        self.assertIn("The build fails.", r["blockers"])

    def test_no_git_and_fix_creates_gitignore(self):
        self.write({k: v for k, v in HARDENED.items() if k != ".gitignore"})
        r = self.report("--fix")
        self.assertEqual(r["fixed"], ["Created .gitignore for: python."])
        self.assertIn("__pycache__/", (self.project / ".gitignore").read_text())
        self.assertEqual(r["by_check"]["Git repository with history"]["note"], "Not a git repository.")
        self.assertEqual(r["by_check"]["A .gitignore is present"]["status"], "pass")
        self.assertEqual(self.report("--fix")["fixed"], [])

    def test_no_run_marks_checks_unknown(self):
        self.repo()
        r = self.report("--no-run")
        self.assertEqual(r["commands"]["test"]["status"], "skipped")
        self.assertEqual(r["by_check"]["Every test passes"]["status"], "unknown")
        self.assertEqual(r["by_check"]["Build runs cleanly"]["status"], "pass", "the built-in syntax check needs no execution")
        self.assertEqual(r["readiness_score"], 77)
        self.assertEqual(r["readiness_tier"], "Bronze", "tests nobody ran never earn a tier")
        self.assertEqual(r["blockers"], ["The tests could not be verified here."])

    def test_command_overrides_and_missing_tools(self):
        self.repo(**{".factory/config.json": json.dumps({"audit": {"commands": {"lint": "no-such-linter-xyz ."}}})})
        r = self.report("--test-cmd", f"MACH_PROBE=1 {sys.executable} -c 'import os, sys; sys.exit(0 if os.environ.get(\"MACH_PROBE\") else 9)'")
        self.assertEqual((r["commands"]["test"]["source"], r["commands"]["test"]["status"]), ("argument", "pass"))
        self.assertEqual((r["commands"]["lint"]["source"], r["commands"]["lint"]["status"]), ("config", "unavailable"))
        self.assertEqual(r["by_check"]["Linter passes"]["status"], "unknown")
        self.assertIn("Linter passes", r["unverified"])

    def test_test_timeout_is_a_blocker(self):
        self.repo(**{".factory/config.json": json.dumps({"audit": {"timeouts": {"test": 1}}})})
        r = self.report("--test-cmd", f"{sys.executable} -c 'import time; time.sleep(10)'")
        self.assertEqual(r["commands"]["test"]["status"], "timeout")
        self.assertEqual(r["blockers"], ["The baseline tests do not pass."])

    def test_bad_config_is_an_error(self):
        self.repo(**{".factory/config.json": "{nope"})
        code, _, err = self.run_audit()
        self.assertEqual(code, 2)
        self.assertIn("not valid JSON", err)


class DetectionTest(Base):
    def commands(self, files):
        self.write(files)
        r = self.report("--no-run")
        return {kind: r["commands"][kind]["command"] for kind in ("build", "test", "lint")}, r

    def test_node(self):
        package = {"scripts": {"build": "tsc", "test": "vitest run", "lint": "eslint ."}, "dependencies": {"left-pad": "1.0.0"}}
        found, r = self.commands({"package.json": json.dumps(package), "tsconfig.json": "{}", "src/a.test.ts": "", "pnpm-workspace.yaml": ""})
        self.assertEqual(found, {"build": "npm run build", "test": "npm test", "lint": "npm run lint"})
        self.assertEqual(r["stacks"], ["node"])
        self.assertIn("node", r["by_check"]["Dependencies are locked"]["note"])
        self.assertEqual(r["by_check"]["Type checking in place"]["note"], "tsconfig.json")
        self.assertEqual(r["by_check"]["Tests exist"]["status"], "pass")

    def test_node_with_lockfile_and_default_test_stub(self):
        package = {"scripts": {"test": 'echo "Error: no test specified" && exit 1'}, "devDependencies": {"x": "1"}}
        found, r = self.commands({"package.json": json.dumps(package), "pnpm-lock.yaml": ""})
        self.assertEqual(found, {"build": "builtin:no-build-step", "test": None, "lint": None})
        self.assertEqual(r["by_check"]["Dependencies are locked"]["status"], "pass")

    def test_go_and_rust(self):
        found, r = self.commands({"go.mod": "module x\n\ngo 1.22\n", "x_test.go": "package x\n", ".golangci.yml": ""})
        self.assertEqual(found, {"build": "go build ./...", "test": "go test ./...", "lint": "golangci-lint run"})
        self.assertEqual(r["by_check"]["Type checking in place"]["note"], "statically typed language")
        for name in ("go.mod", "x_test.go", ".golangci.yml"):
            (self.project / name).unlink()
        found, r = self.commands({"Cargo.toml": "[package]\nname = 'x'\n"})
        self.assertEqual(found["test"], "cargo test --quiet")
        self.assertEqual(r["by_check"]["Dependencies are locked"]["status"], "fail")

    def test_python_pytest_ruff_and_unpinned_requirements(self):
        found, r = self.commands({"pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n[tool.mypy]\n", "requirements.txt": "requests>=2\n", "tests/test_a.py": ""})
        self.assertEqual(found, {"build": "builtin:python-syntax", "test": f"{sys.executable} -m pytest -q", "lint": "ruff check ."})
        self.assertEqual(r["by_check"]["Dependencies are locked"]["status"], "fail")
        self.assertEqual(r["by_check"]["Formatter configured"]["status"], "pass")

    def test_make_targets_win_including_included_files(self):
        found, _ = self.commands({"Makefile": "include extra.mk\nbuild:\n\t@true\n", "extra.mk": "test:\n\t@true\n", "go.mod": "module x\n"})
        self.assertEqual(found, {"build": "make build", "test": "make test", "lint": "go vet ./..."})

    def test_installed_mach_files_are_not_project_code(self):
        _, r = self.commands({".claude/skills/mach-intent/scripts/cell.py": "x = 1\n", ".factory/bin/mach": "#!/usr/bin/env python3\n", ".claude/skills/x/tests/test_a.py": ""})
        self.assertEqual(r["stacks"], [])
        self.assertEqual(r["by_check"]["Tests exist"]["status"], "fail")

    def test_empty_folder(self):
        _, r = self.commands({})
        self.assertEqual((r["readiness_score"], r["readiness_tier"]), (3, "Bronze"))
        self.assertEqual(r["blockers"], ["There is no build command.", "There is no runnable test suite."])


class GateTest(Base):
    def gate(self, *argv):
        code, out, _ = self.run_audit(*argv, command="gate")
        return code, json.loads(out)

    def test_gate_follows_the_report(self):
        self.repo()
        code, result = self.gate()
        self.assertEqual((code, result["allowed"]), (1, False))
        self.assertIn("Run the audit first", result["reason"])
        self.report()
        code, result = self.gate()
        self.assertEqual((code, result["allowed"], result["tier"], result["human_review_required"]), (0, True, "Gold", False))
        code, result = self.gate("--max-age-days", "0")
        self.assertEqual(code, 1)
        self.assertIn("days old", result["reason"])
        self.write({"app/more.py": "x = 1\n"})
        self.commit("change")
        code, result = self.gate()
        self.assertEqual(code, 1)
        self.assertIn("different commit", result["reason"])

    def test_gate_refuses_bronze_and_flags_silver(self):
        self.repo(**{"tests/test_core.py": FAILING_TEST})
        self.report()
        code, result = self.gate()
        self.assertEqual((code, result["tier"]), (1, "Bronze"))
        self.assertIn("The baseline tests do not pass.", result["reason"])
        self.write({"tests/test_core.py": PASSING_TEST, ".factory/config.json": json.dumps({"audit": {"gold": 99}})})
        git(self.project, "add", "tests")
        git(self.project, "commit", "-q", "-m", "fix")
        self.report()
        code, result = self.gate()
        self.assertEqual((code, result["tier"], result["human_review_required"]), (0, "Silver", True))


class ScorecardTest(Base):
    def test_plain_scorecard(self):
        self.repo(**{"tests/test_core.py": FAILING_TEST})
        code, out, _ = self.run_audit()
        self.assertEqual(code, 1)
        self.assertIn("Bronze  (BLOCKED)", out)
        self.assertIn("BLOCKER: The baseline tests do not pass.", out)
        self.assertIn("FAIL  0/10 Every test passes", out)
        self.assertIn("??    0/2  Main branch protected", out)

    def test_pillar_weights_total_100(self):
        self.assertEqual(sum(weight for _, _, weight in audit.PILLARS), 100)
        self.repo()
        r = self.report()
        for key, _, weight in audit.PILLARS:
            self.assertEqual(sum(c["max"] for c in r["checks"] if c["pillar"] == key), weight, key)


if __name__ == "__main__":
    unittest.main()
