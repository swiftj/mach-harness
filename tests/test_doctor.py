"""Tests for the workstation check, skills/run/scripts/doctor.py."""
import ast
import builtins
import contextlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
import doctor  # noqa: E402

REAL_GIT = shutil.which("git")
SECRET = "gho_FAKEtoken1234567890"


def installer_constant(name):
    tree = ast.parse((ROOT / "bin" / "mach").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found in bin/mach")


@unittest.skipUnless(REAL_GIT, "git is needed")
class DoctorTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.project = root / "project"
        self.project.mkdir()
        self.bin = root / "bin"
        self.bin.mkdir()
        (self.bin / "git").symlink_to(REAL_GIT)
        env = {"PATH": str(self.bin), "HOME": str(root), "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("ISSUE_PROVIDER", None)

    # helpers
    def fake(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(path.stat().st_mode | stat.S_IEXEC)

    def git(self, *args):
        subprocess.run([REAL_GIT, *args], cwd=self.project, check=True, capture_output=True)

    def healthy(self, config=None):
        self.git("init", "-q")
        factory = self.project / ".factory"
        factory.mkdir()
        (factory / "config.json").write_text(json.dumps(config or {"tickets": {"provider": "local"}}))
        (factory / ".mach-manifest.json").write_text(json.dumps({"version": "0.13.0", "files": {}}))
        for folder in doctor.DATA_DIRS:
            (self.project / folder).mkdir(parents=True, exist_ok=True)
        for name in doctor.RULE_FILES:
            (self.project / name).write_text("# rules\n")
        (factory / "audit-report.json").write_text(json.dumps({"readiness_tier": "Gold", "readiness_score": 95}))
        (factory / "bin").mkdir()
        for dest, _ in doctor.HOSTS:
            path = self.project / dest
            path.write_text("#!/bin/sh\n")
            path.chmod(0o755)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "first")
        self.git("remote", "add", "origin", "https://example.invalid/repo.git")
        self.fake("claude", 'echo "9.9.9 (Claude Code)"')

    def run_doctor(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = doctor.main(list(argv), project=self.project)
        return code, out.getvalue()

    def checks(self, *argv):
        code, out = self.run_doctor("--json", *argv)
        data = json.loads(out)
        return code, {c["id"]: c for c in data["checks"]}, data, out

    def tree(self):
        return sorted(str(p.relative_to(self.project)) for p in self.project.rglob("*") if ".git" not in p.relative_to(self.project).parts[:1])

    # tests
    def test_mirrors_the_installer(self):
        self.assertEqual(doctor.MIN_PYTHON, installer_constant("MIN_PYTHON"))
        self.assertEqual(doctor.DATA_DIRS, installer_constant("DATA_DIRS"))
        self.assertEqual(doctor.MANIFEST, installer_constant("MANIFEST"))

    def test_healthy_project_passes(self):
        self.healthy()
        code, checks, data, _ = self.checks()
        self.assertEqual(code, 0)
        self.assertEqual({c["status"] for c in checks.values()}, {"ok"}, checks)
        self.assertEqual(data["created"], [])
        self.assertEqual(sum(data["summary"].values()), len(checks))
        code, text = self.run_doctor()
        self.assertEqual(code, 0)
        self.assertIn("/mach-run factory status", text)
        self.assertIn("0 failed", text)

    def test_missing_factory_is_a_failure_not_a_crash(self):
        code, checks, _, _ = self.checks("--fix")
        self.assertEqual(code, 1)
        self.assertEqual(checks["install"]["status"], "fail")
        self.assertIn("not installed", checks["install"]["detail"])
        self.assertFalse((self.project / ".factory").exists())
        self.assertEqual(checks["git"]["status"], "fail")  # not a repository
        self.assertEqual(checks["tracker"]["status"], "not_checked")

    def test_no_commit_is_a_warning(self):
        self.healthy()
        shutil.rmtree(self.project / ".git")
        self.git("init", "-q")
        _, checks, _, _ = self.checks()
        self.assertEqual(checks["git"]["status"], "warn")
        self.assertEqual(checks["remote"]["status"], "warn")

    def test_missing_folder_reported_and_created_only_with_fix(self):
        self.healthy()
        (self.project / ".factory/inbox").rmdir()
        code, checks, data, _ = self.checks()
        self.assertEqual(code, 0)
        self.assertEqual(checks["install.folders"]["status"], "warn")
        self.assertIn(".factory/inbox", checks["install.folders"]["detail"])
        self.assertFalse((self.project / ".factory/inbox").exists())
        self.assertEqual(data["created"], [])
        before = self.tree()
        code, checks, data, _ = self.checks("--fix")
        self.assertEqual(data["created"], [".factory/inbox"])
        self.assertEqual(checks["install.folders"]["status"], "ok")
        self.assertEqual(sorted(set(self.tree()) - set(before)), [".factory/inbox"])
        self.assertEqual(set(before) - set(self.tree()), set())
        self.assertFalse((self.project / ".factory/local").exists())
        _, text = self.run_doctor("--fix")
        self.assertNotIn("Created:", text)

    def test_fix_creates_only_standard_folders(self):
        self.git("init", "-q")
        (self.project / ".factory").mkdir()
        (self.project / "keep.txt").write_text("x")
        before = self.tree()
        _, checks, data, _ = self.checks("--fix")
        added = sorted(set(self.tree()) - set(before))
        expected = sorted({str(Path(f)) for d in doctor.DATA_DIRS for f in [d, *[str(p) for p in Path(d).parents if str(p) not in (".", ".factory")]]})
        self.assertEqual(added, expected)
        self.assertEqual(sorted(data["created"]), sorted(doctor.DATA_DIRS))
        self.assertFalse((self.project / ".factory/local").exists())
        self.assertFalse((self.project / ".factory/config.json").exists())
        self.assertEqual(checks["install.config"]["status"], "fail")
        self.assertEqual(checks["install.manifest"]["status"], "warn")

    def test_malformed_config_fails(self):
        self.healthy()
        (self.project / ".factory/config.json").write_text("{not json")
        code, checks, _, _ = self.checks()
        self.assertEqual(code, 1)
        self.assertEqual(checks["install.config"]["status"], "fail")
        (self.project / ".factory/config.json").write_text("[1, 2]")
        code, checks, _, _ = self.checks()
        self.assertEqual(code, 1)
        self.assertEqual(checks["install.config"]["status"], "fail")

    def test_github_signed_out_fails_without_relaying_output(self):
        self.healthy({"tickets": {"provider": "github"}})
        self.fake("gh", f'echo "Logged in with token {SECRET}"; echo "token {SECRET} is invalid" >&2; exit 1')
        code, checks, _, out = self.checks()
        self.assertEqual(code, 1)
        self.assertEqual(checks["tracker"]["status"], "fail")
        self.assertNotIn(SECRET, out)
        _, text = self.run_doctor()
        self.assertNotIn(SECRET, text)
        self.assertNotIn("gho_", text)

    def test_github_signed_in_is_ok(self):
        self.healthy({"tickets": {"provider": "github"}})
        self.fake("gh", f'echo "{SECRET}"; exit 0')
        code, checks, _, out = self.checks()
        self.assertEqual(code, 0)
        self.assertEqual(checks["tracker"]["status"], "ok")
        self.assertNotIn(SECRET, out)

    def test_github_unreachable_is_not_checked(self):
        self.healthy({"tickets": {"provider": "github"}})
        self.fake("gh", 'echo "error connecting to api.github.com" >&2; exit 1')
        _, checks, _, _ = self.checks()
        self.assertEqual(checks["tracker"]["status"], "not_checked")

    def test_github_timeout_is_not_checked(self):
        self.healthy({"tickets": {"provider": "github"}})
        self.fake("gh", "exec /bin/sleep 5")
        with mock.patch.object(doctor, "GH_TIMEOUT", 1):
            code, checks, _, _ = self.checks()
        self.assertEqual(checks["tracker"]["status"], "not_checked")
        self.assertEqual(code, 0)

    def test_provider_from_environment_and_other_trackers(self):
        self.healthy()
        os.environ["ISSUE_PROVIDER"] = "jira"
        _, checks, _, _ = self.checks()
        self.assertEqual(checks["tracker"]["status"], "warn")
        self.assertIn("ISSUE_PROVIDER", checks["tracker"]["detail"])
        self.fake("jira", "exit 0")
        _, checks, _, _ = self.checks()
        self.assertEqual(checks["tracker"]["status"], "ok")
        os.environ["ISSUE_PROVIDER"] = "nonsense"
        code, checks, _, _ = self.checks()
        self.assertEqual(checks["tracker"]["status"], "fail")
        self.assertEqual(code, 1)

    def test_claude_absent_is_a_warning(self):
        self.healthy()
        (self.bin / "claude").unlink()
        code, checks, _, _ = self.checks()
        self.assertEqual(code, 0)
        self.assertEqual(checks["claude"]["status"], "warn")

    def test_missing_rules_audit_hosts_warn(self):
        self.healthy()
        (self.project / "AGENTS.md").unlink()
        (self.project / ".factory/audit-report.json").unlink()
        (self.project / ".factory/bin/mach-studio").unlink()
        (self.project / ".factory/.mach-manifest.json").unlink()
        code, checks, _, _ = self.checks()
        self.assertEqual(code, 0)
        for key in ("rules.AGENTS.md", "audit", "hosts.mach-studio", "install.manifest"):
            self.assertEqual(checks[key]["status"], "warn", key)
        self.assertFalse((self.project / ".factory/audit-report.json").exists())  # never runs the audit

    def test_machine_local_folder_is_never_opened(self):
        self.healthy()
        local = self.project / ".factory" / "local"
        local.mkdir()
        planted = local / ("runner" + ".json")
        planted.write_text('{"enabled": true}')
        planted.chmod(0)
        self.addCleanup(planted.chmod, 0o600)
        touched = []
        real_open, real_read = builtins.open, Path.read_text

        def spy_open(file, *a, **k):
            if "local" in Path(str(file)).parts:
                touched.append(str(file))
            return real_open(file, *a, **k)

        def spy_read(self_, *a, **k):
            if "local" in self_.parts:
                touched.append(str(self_))
            return real_read(self_, *a, **k)

        with mock.patch("builtins.open", spy_open), mock.patch.object(Path, "read_text", spy_read):
            code, checks, _, out = self.checks("--fix")
            _, text = self.run_doctor()
        self.assertEqual(code, 0)
        self.assertEqual(touched, [])
        for output in (out, text):
            self.assertNotIn("runner", output)
            self.assertNotIn(".factory/local", output)

    def test_source_rules(self):
        source = (ROOT / "skills/run/scripts/doctor.py").read_text(encoding="utf-8")
        self.assertNotIn("runner" + ".json", source)
        self.assertNotIn("shell" + "=True", source)
        self.assertNotIn("os.system", source)
        self.assertNotIn("Popen", source)
        self.assertNotIn("urllib", source)
        self.assertNotIn("socket", source)
        self.assertNotIn('"-p"', source)
        for call in ast.walk(ast.parse(source)):
            if isinstance(call, ast.Call) and getattr(call.func, "attr", "") == "run" and getattr(call.func.value, "id", "") == "subprocess":
                self.assertIn("timeout", {k.arg for k in call.keywords})


if __name__ == "__main__":
    unittest.main()
