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
sys.path.insert(0, str(ROOT / "tests"))
import doctor  # noqa: E402
import adr_baseline_fixture  # noqa: E402

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
        adr_baseline_fixture.write(self.project)
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
        self.assertIn("/mach factory status", text)
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

    # requests (GitHub Issues as requests)
    def github_project(self, config=None, url="https://github.com/acme/widgets.git"):
        self.healthy(config)
        self.git("remote", "set-url", "origin", url)
        self.log = self.project.parent / "gh.log"

    def fake_gh(self, labels='[{"name":"mach:request"},{"name":"mach:slice"},{"name":"mach:ready"},{"name":"mach:building"},{"name":"mach:question"},{"name":"mach:shipped"}]',
                permission="write", extra=""):
        self.fake("gh", f'''echo "$@" >> "{self.log}"
{extra}
case "$1 $2" in
  "auth status") exit 0;;
  "label list") echo '{labels}'; exit 0;;
  "api user") echo octo; exit 0;;
  "label create") exit 0;;
esac
case "$2" in repos/*) echo {permission}; exit 0;; esac
exit 1''')

    def gh_calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_requests_not_emitted_without_a_github_origin(self):
        self.healthy()
        self.log = self.project.parent / "gh.log"
        self.fake_gh()
        _, checks, _, out = self.checks("--fix")
        self.assertEqual([k for k in checks if k.startswith("requests")], [])
        self.assertNotIn("Requests", out)
        self.assertEqual(self.gh_calls(), [])

    def test_requests_all_good(self):
        self.github_project()
        self.fake_gh()
        code, checks, _, _ = self.checks()
        self.assertEqual(code, 0)
        for key in ("requests.signin", "requests.labels", "requests.permission"):
            self.assertEqual(checks[key]["status"], "ok", checks[key])
        self.assertIn("acme/widgets", checks["requests.labels"]["detail"])
        self.assertEqual(sum(1 for c in self.gh_calls() if c.startswith("auth status")), 1)
        self.assertIn("auth status --hostname github.com", self.gh_calls())

    def test_requests_reuse_the_tracker_sign_in(self):
        self.github_project({"tickets": {"provider": "github"}})
        self.fake_gh()
        _, checks, _, _ = self.checks()
        self.assertEqual(checks["tracker"]["status"], "ok")
        self.assertEqual(checks["requests.signin"]["status"], "ok")
        self.assertEqual(sum(1 for c in self.gh_calls() if c.startswith("auth status")), 1)

    def test_requests_missing_labels_warn_with_one_create_line_each(self):
        self.github_project({"tickets": {"provider": "local", "github": {"request_label": "mach:ask"}}})
        self.fake_gh(labels='[{"name":"mach:ask"},{"name":"mach:ready"},{"name":"mach:building"},{"name":"mach:question"}]')
        _, checks, _, _ = self.checks()
        labels = checks["requests.labels"]
        self.assertEqual(labels["status"], "warn")
        creates = [line for line in labels["fix"].splitlines() if "gh label create" in line]
        self.assertEqual(len(creates), 2)
        self.assertIn("mach:slice", creates[0])
        self.assertIn("mach:shipped", creates[1])
        self.assertTrue(all("--repo acme/widgets" in line for line in creates))

    def test_requests_fix_creates_no_label(self):
        self.github_project()
        self.fake_gh(labels="[]")
        _, checks, _, _ = self.checks("--fix")
        self.assertEqual(checks["requests.labels"]["status"], "warn")
        self.assertFalse([c for c in self.gh_calls() if c.startswith("label create")])

    def test_requests_read_permission_warns(self):
        self.github_project()
        self.fake_gh(permission="read")
        code, checks, _, _ = self.checks()
        self.assertEqual(code, 0)
        self.assertEqual(checks["requests.permission"]["status"], "warn")

    def test_requests_timeout_is_not_checked(self):
        self.github_project()
        self.fake_gh(extra='case "$1" in auth) ;; *) exec /bin/sleep 5;; esac')
        with mock.patch.object(doctor, "GH_TIMEOUT", 1):
            code, checks, _, _ = self.checks()
        self.assertEqual(code, 0)
        self.assertEqual(checks["requests.labels"]["status"], "not_checked")
        self.assertEqual(checks["requests.permission"]["status"], "not_checked")

    def test_requests_monitor_account_needs_a_numeric_id(self):
        for accounts in (["octo-bot"], [{"login": "octo-bot"}], [{"login": "octo-bot", "id": "7"}]):
            self.github_project({"tickets": {"provider": "local", "github": {"monitor_accounts": accounts}}})
            self.fake_gh()
            code, checks, _, _ = self.checks()
            self.assertEqual(code, 1, accounts)
            self.assertEqual(checks["requests.monitors"]["status"], "fail")
            self.assertIn("matched on its numeric id; add it", checks["requests.monitors"]["detail"])
            shutil.rmtree(self.project / ".git")
            shutil.rmtree(self.project / ".factory")
        self.github_project({"tickets": {"provider": "local", "github": {"monitor_accounts": [{"login": "octo-bot", "id": 7}]}}})
        self.fake_gh()
        _, checks, _, _ = self.checks()
        self.assertEqual(checks["requests.monitors"]["status"], "ok")

    def test_requests_never_show_the_origin_credential(self):
        self.github_project(url="https://user:secret@github.com/acme/widgets.git")
        self.fake_gh()
        _, checks, _, out = self.checks()
        self.assertEqual(checks["requests.labels"]["status"], "ok")
        _, text = self.run_doctor()
        self.assertNotIn("secret", out)
        self.assertNotIn("secret", text)
        self.assertFalse([c for c in self.gh_calls() if "secret" in c or "https://" in c])

    def test_github_repo_forms(self):
        self.healthy()
        for url, want in (("git@github.com:o/r.git", "o/r"), ("ssh://git@github.com/o/r", "o/r"),
                          ("https://github.com/o/r/", "o/r"), ("https://example.com/o/r.git", None),
                          ("https://github.com.evil.test/o/r.git", None)):
            self.git("remote", "set-url", "origin", url)
            self.assertEqual(doctor.github_repo(self.project), want, url)

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
