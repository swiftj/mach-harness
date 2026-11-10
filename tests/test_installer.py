"""Tests for bin/mach and install.sh: install, update, scaffold and uninstall."""

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_loader = SourceFileLoader("mach_cli", str(ROOT / "bin" / "mach"))
mach = module_from_spec(spec_from_loader("mach_cli", _loader))
_loader.exec_module(mach)

SKILL = ".claude/skills/mach-intent/SKILL.md"


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = mach.main(list(argv))
    return code, out.getvalue() + err.getvalue()


def snapshot(project):
    return {p.relative_to(project).as_posix(): p.read_bytes() for p in sorted(project.rglob("*")) if p.is_file()}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve() / "project"
        self.project.mkdir()

    def mach(self, command, *extra):
        return run(command, "--project", str(self.project), *extra)


class InstallTest(Base):
    def test_install_into_an_empty_project(self):
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        files = snapshot(self.project)
        for expected in (SKILL, ".claude/skills/mach-intent/scripts/cell.py", ".claude/skills/mach-intent/scripts/validate_slice.py",
                         ".claude/skills/mach-intent/assets/slice-template.md", ".claude/skills/mach-intent/references/headless.md",
                         ".claude/skills/mach-ticket/SKILL.md", ".claude/skills/mach-ticket/scripts/ticket.py",
                         ".claude/skills/mach-audit/SKILL.md", ".claude/skills/mach-audit/scripts/audit.py",
                         ".claude/skills/mach-build/SKILL.md", ".claude/skills/mach-build/scripts/build.py", ".claude/agents/mach-builder.md",
                         ".claude/skills/mach-verify/SKILL.md", ".claude/skills/mach-verify/references/evidence-runners.md", ".claude/agents/mach-verifier.md",
                         ".claude/skills/mach-review/SKILL.md", ".claude/skills/mach-review/references/reviewer-brief.md", ".claude/agents/mach-reviewer.md",
                         ".claude/skills/mach-cleanup/scripts/cleanup.py", ".claude/skills/mach-observe/scripts/observe.py",
                         ".claude/skills/mach-run/scripts/run.py", ".claude/workflows/mach-belt.js",
                         ".claude/skills/mach-merge/SKILL.md", ".claude/skills/mach-merge/scripts/merge.py",
                         ".claude/agents/mach-contract-engineer.md", ".factory/bin/mach", ".factory/mach.mk", ".factory/config.json",
                         "REVIEW.md", "AGENTS.md", "Makefile", "CLAUDE.md", ".gitignore", ".factory/.mach-manifest.json"):
            self.assertIn(expected, files)
        self.assertFalse(any("mach-init" in name or "__pycache__" in name for name in files), "plugin-only and cache files must not be installed")
        self.assertIn(b"\nname: mach-intent\n", files[SKILL])
        self.assertIn(b"\nname: mach-contract-engineer\n", files[".claude/agents/mach-contract-engineer.md"])
        workflow = files[".claude/workflows/mach-belt.js"]
        self.assertIn(b"/mach-run where", workflow)
        self.assertIn(b"  name: 'mach-belt',", workflow)
        self.assertNotIn(b"/mach:", workflow)
        self.assertTrue((self.project / ".factory/tickets").is_dir())
        self.assertTrue(os.access(self.project / ".factory/bin/mach", os.X_OK))
        config = json.loads(files[".factory/config.json"])
        self.assertEqual(config["observe"], {"every": 5})
        self.assertEqual((config["merge"]["mode"], config["merge"]["method"]), ("auto", "local"))

    def test_installed_skill_is_runnable_and_self_contained(self):
        self.mach("install")
        scripts = self.project / ".claude/skills/mach-intent/scripts"
        done = subprocess.run([sys.executable, str(scripts / "cell.py"), "--project", str(self.project), "ticket-new", "--title", "Try it"], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)["ticket_id"], "LOCAL-001")
        text = (self.project / SKILL).read_text()
        for reference in set(re.findall(r"`((?:references|assets|scripts)/[\w./-]+)`", text)):
            self.assertTrue((self.project / ".claude/skills/mach-intent" / reference).is_file(), reference)

    def test_installed_product_studio_finds_the_intent_skill(self):
        self.mach("install")
        script = self.project / ".claude/skills/mach-product-studio/scripts/studio.py"
        done = subprocess.run([sys.executable, str(script), "--project", str(self.project), "where"], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        where = json.loads(done.stdout)
        self.assertEqual(Path(where["interview_method"]), self.project / ".claude/skills/mach-intent/references/interview-method.md")
        for key in ("interview_method", "slice_template", "intent_template"):
            self.assertTrue(Path(where[key]).is_file(), key)
        self.assertIn(b"\nname: mach-product-studio\n", (self.project / ".claude/skills/mach-product-studio/SKILL.md").read_bytes())
        ignore = (self.project / ".gitignore").read_text()
        self.assertIn(".factory/studio/", ignore)
        self.assertIn(".factory/local/", ignore)
        self.assertIn(".factory/intake/", ignore)
        self.assertEqual(json.loads((self.project / ".factory/config.json").read_text())["factory"], {"max_parallel": 3})
        done = subprocess.run([sys.executable, str(self.project / ".claude/skills/mach-run/scripts/run.py"), "--project", str(self.project), "product", "status"],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)  # the installed run skill finds the installed product-studio and intent skills
        self.assertEqual(json.loads(done.stdout)["factory_started"], False)
        # Running an installed script leaves no untracked file behind.
        git = lambda *args: subprocess.run(["git", *args], cwd=str(self.project), capture_output=True, text=True)
        git("init", "-q", "-b", "main")
        git("add", "-A")
        git("-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "install")
        writing = {key: value for key, value in os.environ.items() if key not in ("PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX")}
        subprocess.run([sys.executable, str(script), "--project", str(self.project), "status"], capture_output=True, text=True, env=writing)
        subprocess.run([sys.executable, str(self.project / ".factory/bin/mach"), "status", "--project", str(self.project)], capture_output=True, env=writing)
        self.assertTrue(list((self.project / ".claude/skills").rglob("__pycache__")))
        self.assertEqual(git("status", "--porcelain").stdout, "")

    def test_second_install_changes_nothing(self):
        self.mach("install")
        before = snapshot(self.project)
        code, out = self.mach("install")
        self.assertEqual(code, 0)
        self.assertIn("already up to date", out)
        after = snapshot(self.project)
        manifest = ".factory/.mach-manifest.json"
        self.assertEqual({k: v for k, v in before.items() if k != manifest}, {k: v for k, v in after.items() if k != manifest})

    def test_existing_project_files_are_never_overwritten(self):
        mine = {"CLAUDE.md": "# My project\n\nRules.\n", ".gitignore": "node_modules/\n", "Makefile": "all:\n\techo hi\n", "REVIEW.md": "mine\n"}
        for name, text in mine.items():
            (self.project / name).write_text(text)
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.project / "Makefile").read_text(), mine["Makefile"])
        self.assertEqual((self.project / "REVIEW.md").read_text(), mine["REVIEW.md"])
        self.assertIn("include .factory/mach.mk", out)
        claude = (self.project / "CLAUDE.md").read_text()
        self.assertTrue(claude.startswith(mine["CLAUDE.md"]))
        self.assertIn("<!-- mach:begin -->", claude)
        self.assertIn(".factory/worktrees/", (self.project / ".gitignore").read_text())
        self.mach("uninstall")
        self.assertEqual({k: v.decode() for k, v in snapshot(self.project).items()}, mine, "uninstall must restore the project exactly")

    def test_dry_run_changes_nothing(self):
        code, out = self.mach("install", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("Would install", out)
        self.assertEqual(list(self.project.iterdir()), [])

    def test_changed_skill_file_is_skipped_then_replaced_with_force(self):
        self.mach("install")
        path = self.project / SKILL
        path.write_text(path.read_text() + "\nMy local rule.\n")
        (self.project / ".claude/skills/mach-intent/assets/slice-template.md").write_text("old shipped content")
        manifest = json.loads((self.project / ".factory/.mach-manifest.json").read_text())
        manifest["files"][".claude/skills/mach-intent/assets/slice-template.md"] = mach.sha(b"old shipped content")
        (self.project / ".factory/.mach-manifest.json").write_text(json.dumps(manifest))
        code, out = self.mach("install")
        self.assertEqual(code, 1)
        self.assertIn(f"SKIP     {SKILL}", out)
        self.assertIn("update   .claude/skills/mach-intent/assets/slice-template.md", out)
        self.assertIn("My local rule.", path.read_text())
        code, out = self.mach("install", "--force")
        self.assertEqual(code, 0, out)
        self.assertNotIn("My local rule.", path.read_text())
        backups = list(self.project.glob(".factory/mach-backup-*/" + SKILL))
        self.assertEqual(len(backups), 1)
        self.assertIn("My local rule.", backups[0].read_text())

    def test_install_refuses_the_mach_repository_itself(self):
        code, out = run("install", "--project", str(ROOT), "--dry-run")
        self.assertEqual(code, 2)
        self.assertIn("MACH repository itself", out)


class ScaffoldTest(Base):
    def test_scaffold_creates_factory_files_but_no_skills(self):
        code, out = self.mach("scaffold")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / ".claude").exists())
        self.assertTrue((self.project / ".factory/config.json").is_file())
        self.assertIn("/mach:intent", out)
        self.mach("uninstall")
        self.assertEqual(snapshot(self.project), {})


class UninstallTest(Base):
    def test_uninstall_leaves_an_empty_project_empty(self):
        self.mach("install")
        subprocess.run([sys.executable, str(self.project / ".claude/skills/mach-intent/scripts/cell.py"), "--project", str(self.project), "status"], capture_output=True)
        code, out = self.mach("uninstall")
        self.assertEqual(code, 0, out)
        self.assertEqual(list(self.project.iterdir()), [], out)

    def test_uninstall_keeps_project_data_and_changed_files(self):
        self.mach("install")
        (self.project / ".factory/tickets/LOCAL-001.md").write_text("ticket")
        (self.project / "specs/slices/SLICE-001-x.md").write_text("spec")
        (self.project / "REVIEW.md").write_text("our own rules\n")
        (self.project / ".factory/config.json").write_text('{"tickets": {"provider": "github"}}')
        code, out = self.mach("uninstall")
        self.assertEqual(code, 0)
        left = set(snapshot(self.project))
        self.assertEqual(left, {".factory/tickets/LOCAL-001.md", "specs/slices/SLICE-001-x.md", "REVIEW.md", ".factory/config.json", ".factory/.mach-manifest.json"})
        self.assertIn("keep     REVIEW.md", out)
        self.assertIn("your project's data", out)
        code, out = self.mach("uninstall", "--force")
        self.assertEqual(code, 0)
        left = set(snapshot(self.project))
        self.assertIn(".factory/tickets/LOCAL-001.md", left)
        self.assertNotIn("REVIEW.md", left)
        self.assertTrue(any(name.endswith("/REVIEW.md") and "mach-backup-" in name for name in left))

    def test_uninstall_from_the_installed_copy(self):
        self.mach("install")
        done = subprocess.run([sys.executable, ".factory/bin/mach", "uninstall"], cwd=self.project, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(list(self.project.iterdir()), [])

    def test_installed_copy_cannot_install(self):
        self.mach("install")
        done = subprocess.run([sys.executable, ".factory/bin/mach", "install"], cwd=self.project, capture_output=True, text=True)
        self.assertEqual(done.returncode, 2)
        self.assertIn("can only report status and uninstall", done.stderr)

    def test_uninstall_when_not_installed(self):
        code, out = self.mach("uninstall")
        self.assertEqual(code, 0)
        self.assertIn("not installed", out)


class StatusTest(Base):
    def test_status_reports_changes(self):
        self.assertEqual(self.mach("status")[0], 1)
        self.mach("install")
        (self.project / ".factory/mach.mk").write_text("changed")
        code, out = self.mach("status")
        self.assertEqual(code, 0)
        self.assertIn("/mach-intent", out)
        self.assertIn("changed  .factory/mach.mk", out)


class BlockTest(unittest.TestCase):
    def test_block_round_trip(self):
        for original in ("", "# Title\n", "# Title\n\ntext\n", "no newline at end"):
            with self.subTest(original=original):
                added = mach.with_block(original, "CLAUDE.md", "body")
                self.assertEqual(mach.with_block(added, "CLAUDE.md", "body"), added)
                expected = original if original.endswith("\n") or not original else original + "\n"
                self.assertEqual(mach.strip_block(added, "CLAUDE.md"), expected)


class InstallScriptTest(Base):
    def sh(self, *args, **env):
        return subprocess.run(["bash", str(ROOT / "install.sh"), *args], cwd=self.project, capture_output=True, text=True, env={**os.environ, **env})

    def test_one_line_install_and_uninstall(self):
        done = self.sh(MACH_SOURCE=str(ROOT))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((self.project / SKILL).is_file())
        done = self.sh("uninstall")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(list(self.project.iterdir()), [])


class PackagingTest(unittest.TestCase):
    def test_plugin_manifests_agree(self):
        plugin = json.loads((ROOT / ".claude-plugin/plugin.json").read_text())
        market = json.loads((ROOT / ".claude-plugin/marketplace.json").read_text())
        self.assertEqual(plugin["name"], "mach")
        self.assertRegex(plugin["version"], r"^\d+\.\d+\.\d+$")
        self.assertEqual([(p["name"], p["source"]) for p in market["plugins"]], [("mach", "./")])

    def test_every_skill_has_front_matter_and_its_files(self):
        for skill in (ROOT / "skills").iterdir():
            text = (skill / "SKILL.md").read_text()
            head = text.split("\n---", 1)[0]
            self.assertIn(f"\nname: {skill.name}\n", head + "\n")
            self.assertRegex(head, r"\ndescription: \S")
            for reference in set(re.findall(r"`((?:references|assets|scripts)/[\w./-]+)`", text)):
                self.assertTrue((skill / reference).is_file(), f"{skill.name}: {reference}")


if __name__ == "__main__":
    unittest.main()
