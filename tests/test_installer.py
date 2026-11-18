"""Tests for bin/mach and install.sh: install, update, scaffold and uninstall."""

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
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
        # The visual app's host and the Factory Floor are downloads; these tests never touch the network.
        # StudioTest and FloorTest cover them.
        for name in ("MACH_STUDIO", "MACH_FLOOR"):
            self.setenv(name, "skip")

    def setenv(self, name, value):
        previous = os.environ.get(name)
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
        self.addCleanup(lambda: os.environ.pop(name, None) if previous is None else os.environ.__setitem__(name, previous))

    def mach(self, command, *extra):
        return run(command, "--project", str(self.project), *extra)


class InstallTest(Base):
    def test_install_into_an_empty_project(self):
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        files = snapshot(self.project)
        for expected in (SKILL, ".claude/skills/mach-intent/scripts/cell.py", ".claude/skills/mach-intent/scripts/validate_slice.py",
                         ".claude/skills/mach-intent/scripts/lifecycle.py",
                         ".claude/skills/mach-intent/assets/slice-template.md", ".claude/skills/mach-intent/references/headless.md",
                         ".claude/skills/mach-ticket/SKILL.md", ".claude/skills/mach-ticket/scripts/ticket.py",
                         ".claude/skills/mach-audit/SKILL.md", ".claude/skills/mach-audit/scripts/audit.py",
                         ".claude/skills/mach-build/SKILL.md", ".claude/skills/mach-build/scripts/build.py", ".claude/agents/mach-builder.md",
                         ".claude/skills/mach-verify/SKILL.md", ".claude/skills/mach-verify/references/evidence-runners.md", ".claude/agents/mach-verifier.md",
                         ".claude/skills/mach-review/SKILL.md", ".claude/skills/mach-review/references/reviewer-brief.md", ".claude/agents/mach-reviewer.md",
                         ".claude/skills/mach-cleanup/scripts/cleanup.py", ".claude/skills/mach-observe/scripts/observe.py",
                         ".claude/skills/mach/scripts/run.py", ".claude/workflows/mach-belt.js",
                         ".claude/skills/mach-merge/SKILL.md", ".claude/skills/mach-merge/scripts/merge.py",
                         ".claude/agents/mach-contract-engineer.md", ".factory/bin/mach", ".factory/mach.mk", ".factory/config.json",
                         "REVIEW.md", "AGENTS.md", "Makefile", "CLAUDE.md", ".gitignore", ".factory/.mach-manifest.json"):
            self.assertIn(expected, files)
        self.assertFalse(any("mach-init" in name or "__pycache__" in name for name in files), "plugin-only and cache files must not be installed")
        self.assertIn(b"\nname: mach-intent\n", files[SKILL])
        self.assertIn(b"\nname: mach\n", files[".claude/skills/mach/SKILL.md"], "the run skill is the one command, /mach")
        self.assertFalse(any(name.startswith(".claude/skills/mach-run/") for name in files), "no folder is left under the old name")
        self.assertIn(b"\nname: mach-contract-engineer\n", files[".claude/agents/mach-contract-engineer.md"])
        workflow = files[".claude/workflows/mach-belt.js"]
        self.assertIn(b"/mach where", workflow)
        self.assertIn(b"  name: 'mach-belt',", workflow)
        self.assertNotIn(b"/mach:", workflow)
        self.assertTrue((self.project / ".factory/tickets").is_dir())
        self.assertTrue(os.access(self.project / ".factory/bin/mach", os.X_OK))
        config = json.loads(files[".factory/config.json"])
        self.assertEqual(config["observe"], {"every": 5})
        self.assertEqual((config["merge"]["mode"], config["merge"]["method"]), ("auto", "local"))
        self.assertEqual(config["adr"], {"dir": "docs/adr"}, "architecture decisions are read from docs/adr unless the project says otherwise")
        self.assertIn(".claude/skills/mach-intent/scripts/adr.py", files, "the shared ADR helper is installed with the intent station")

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
        self.assertEqual(json.loads((self.project / ".factory/config.json").read_text())["factory"], {"max_parallel": 3, "max_parallel_high": 1})
        done = subprocess.run([sys.executable, str(self.project / ".claude/skills/mach/scripts/run.py"), "--project", str(self.project), "product", "status"],
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


class StudioTest(Base):
    """The visual app's host: downloaded for this machine, checked, and never required."""

    def setUp(self):
        super().setUp()
        os.environ.pop("MACH_STUDIO", None)
        self.release = Path(self.tmp.name).resolve() / "release"
        self.release.mkdir()
        previous = os.environ.get("MACH_STUDIO_URL")
        os.environ["MACH_STUDIO_URL"] = self.release.as_uri()
        self.addCleanup(lambda: os.environ.pop("MACH_STUDIO_URL", None) if previous is None else os.environ.__setitem__("MACH_STUDIO_URL", previous))
        # A copy built in this checkout would be used instead of a download; these tests are about the download.
        self.local = mach.STUDIO_LOCAL_BUILD
        mach.STUDIO_LOCAL_BUILD = "apps/studio/bin/no-such-build"
        self.addCleanup(lambda: setattr(mach, "STUDIO_LOCAL_BUILD", self.local))

    def publish(self, data=b"#!/bin/sh\necho studio\n", listed=None, asset=None):
        asset = asset or mach.studio_asset()
        (self.release / asset).write_bytes(data)
        (self.release / mach.STUDIO_SUMS).write_text(f"{listed or mach.sha(data)}  {asset}\n", encoding="utf-8")
        return data

    def test_this_machine_has_a_published_build(self):
        self.assertIn((mach.studio_asset() or "").replace("mach-studio-", ""), mach.STUDIO_BUILDS)

    def test_an_intel_mac_has_no_build_and_is_told_so(self):
        system, machine = mach.platform.system, mach.platform.machine
        mach.platform.system, mach.platform.machine = (lambda: "Darwin"), (lambda: "x86_64")
        self.addCleanup(lambda: (setattr(mach.platform, "system", system), setattr(mach.platform, "machine", machine)))
        self.assertIsNone(mach.studio_asset())
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertIn("no build is published for Darwin x86_64", out)

    def test_install_downloads_checks_and_records_the_program(self):
        data = self.publish()
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        path = self.project / mach.STUDIO_DEST
        self.assertEqual(path.read_bytes(), data)
        self.assertTrue(os.access(path, os.X_OK))
        self.assertIn("downloaded and checked", out)
        manifest = json.loads((self.project / mach.MANIFEST).read_text())
        self.assertEqual(manifest["files"][mach.STUDIO_DEST], mach.sha(data))
        self.assertIn(mach.STUDIO_DEST, (self.project / ".gitignore").read_text())

    def test_scaffold_downloads_it_too_for_plugin_users(self):
        self.publish()
        code, out = self.mach("scaffold")
        self.assertEqual(code, 0, out)
        self.assertTrue((self.project / mach.STUDIO_DEST).is_file())

    def test_a_wrong_checksum_installs_nothing_and_the_rest_still_installs(self):
        self.publish(listed="0" * 64)
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / mach.STUDIO_DEST).exists())
        self.assertIn("does not match the release's published checksum", out)
        self.assertTrue((self.project / SKILL).is_file())

    def test_no_release_is_not_a_failure(self):
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / mach.STUDIO_DEST).exists())
        self.assertIn("was not installed", out)
        self.assertIn("Everything else works without it", out)

    def test_a_release_without_this_machines_build_says_so(self):
        self.publish(asset="mach-studio-plan9-mips")
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertIn("does not list", out)

    def test_a_failed_update_keeps_the_copy_already_installed(self):
        data = self.publish()
        self.mach("install")
        (self.release / mach.studio_asset()).unlink()
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.project / mach.STUDIO_DEST).read_bytes(), data)
        self.assertIn("The copy already installed was kept", out)

    def test_no_studio_and_dry_run_download_nothing(self):
        self.publish()
        code, out = self.mach("install", "--no-studio")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / mach.STUDIO_DEST).exists())
        other = self.project.parent / "other"
        other.mkdir()
        code, out = run("install", "--project", str(other), "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn("Would download", out)
        self.assertEqual(snapshot(other), {})

    def test_a_build_in_this_checkout_is_used_without_downloading(self):
        mach.STUDIO_LOCAL_BUILD = "bin/mach"  # any real file in the checkout stands in for a built host
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.project / mach.STUDIO_DEST).read_bytes(), (ROOT / "bin/mach").read_bytes())
        self.assertIn("this MACH checkout's own build", out)

    def test_only_https_or_a_local_folder_is_ever_fetched(self):
        with self.assertRaises(mach.Fail):
            mach.fetch("http://example.test/mach-studio")
        os.environ.pop("MACH_STUDIO_URL")
        self.assertEqual(mach.studio_base("1.2.3"), "https://github.com/swiftj/mach-harness/releases/download/v1.2.3")

    def test_uninstall_removes_the_program(self):
        self.publish()
        self.mach("install")
        code, out = self.mach("uninstall")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / mach.STUDIO_DEST).exists())


class FloorTest(Base):
    """The Factory Floor's observer: downloaded for this machine, checked, never required, and absent
    from releases made before it shipped (v0.12.0 has none) without that being an error."""

    def setUp(self):
        super().setUp()
        self.setenv("MACH_FLOOR", None)
        self.release = Path(self.tmp.name).resolve() / "release"
        self.release.mkdir()
        self.setenv("MACH_FLOOR_URL", self.release.as_uri())
        self.setenv("MACH_STUDIO_URL", None)
        self.local = mach.FLOOR_LOCAL_BUILD
        mach.FLOOR_LOCAL_BUILD = "apps/observer/bin/no-such-build"
        self.addCleanup(lambda: setattr(mach, "FLOOR_LOCAL_BUILD", self.local))

    def publish(self, data=b"#!/bin/sh\necho observer\n", listed=None, studio=True):
        """A release folder like the workflow makes: SHA256SUMS lists the studio and, if data, the observer."""
        lines = []
        if studio:
            body = b"studio"
            (self.release / mach.studio_asset()).write_bytes(body)
            lines.append(f"{mach.sha(body)}  {mach.studio_asset()}")
        if data is not None:
            (self.release / mach.floor_asset()).write_bytes(data)
            lines.append(f"{listed or mach.sha(data)}  {mach.floor_asset()}")
        (self.release / mach.STUDIO_SUMS).write_text("\n".join(lines) + "\n", encoding="utf-8")
        return data

    def test_the_observer_is_published_for_the_same_machines_as_the_studio(self):
        self.assertEqual(mach.floor_asset(), (mach.studio_asset() or "").replace("mach-studio-", "mach-observer-") or None)
        self.assertEqual(mach.FLOOR_DEST, ".factory/bin/mach-observer")

    def test_install_downloads_checks_records_and_ignores_it(self):
        data = self.publish()
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        path = self.project / mach.FLOOR_DEST
        self.assertEqual(path.read_bytes(), data)
        self.assertTrue(os.access(path, os.X_OK))
        self.assertIn("The Factory Floor was downloaded and checked", out)
        manifest = json.loads((self.project / mach.MANIFEST).read_text())
        self.assertEqual(manifest["files"][mach.FLOOR_DEST], mach.sha(data))
        self.assertIn(mach.FLOOR_DEST, (self.project / ".gitignore").read_text())
        self.assertFalse((self.project / mach.STUDIO_DEST).exists())  # MACH_STUDIO=skip still holds
        code, out = self.mach("status")
        self.assertEqual(code, 0, out)
        self.assertRegex(out, r"mach-observer:\s+installed \(\.factory/bin/mach-observer\)")
        self.assertRegex(out, r"mach-studio:\s+not installed")

    def test_scaffold_downloads_it_too_for_plugin_users(self):
        self.publish()
        code, out = self.mach("scaffold")
        self.assertEqual(code, 0, out)
        self.assertTrue((self.project / mach.FLOOR_DEST).is_file())

    def test_a_wrong_checksum_is_refused_and_the_rest_still_installs(self):
        self.publish(listed="0" * 64)
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / mach.FLOOR_DEST).exists())
        self.assertIn("does not match the release's published checksum", out)
        self.assertNotIn(mach.FLOOR_DEST, json.loads((self.project / mach.MANIFEST).read_text())["files"])
        self.assertTrue((self.project / SKILL).is_file())

    def test_a_wrong_checksum_on_update_says_what_was_refused_and_keeps_the_installed_copy(self):
        # M6.6 Phase 8: the note named the program as not installed, then said "nothing was installed",
        # which reads as if MACH itself was not installed. It now says the download was refused.
        data = self.publish()
        self.mach("install")
        self.publish(data=b"#!/bin/sh\necho tampered\n", listed="0" * 64)
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.project / mach.FLOOR_DEST).read_bytes(), data)
        note = next(line for line in out.splitlines() if line.startswith("The Factory Floor"))
        self.assertIn("does not match the release's published checksum, so it was refused.", note)
        self.assertIn("The copy already installed was kept.", note)
        self.assertNotIn("nothing was installed", out)

    def test_a_release_from_before_the_observer_is_one_note_and_a_successful_install(self):
        self.publish(data=None)  # like v0.12.0: SHA256SUMS lists only mach-studio-*
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / mach.FLOOR_DEST).exists())
        notes = [line for line in out.splitlines() if "Factory Floor" in line]
        self.assertEqual(len(notes), 1, out)
        self.assertIn("does not include it; it is published from a later release", notes[0])
        self.assertNotIn("error", out.lower())
        self.assertNotIn("Run the installer again", out)  # nothing to retry
        code, out = self.mach("status")
        self.assertRegex(out, r"mach-observer:\s+not installed")

    def test_studio_url_alone_also_serves_the_observer(self):
        data = self.publish()
        self.setenv("MACH_FLOOR_URL", None)
        self.setenv("MACH_STUDIO_URL", self.release.as_uri())
        self.assertEqual(mach.floor_base("9.9.9"), self.release.as_uri())
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.project / mach.FLOOR_DEST).read_bytes(), data)

    def test_a_failed_update_keeps_the_copy_already_installed(self):
        data = self.publish()
        self.mach("install")
        self.publish(data=None)
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.project / mach.FLOOR_DEST).read_bytes(), data)
        self.assertIn("The copy already installed was kept", out)

    def test_no_floor_flag_and_environment_skip_it(self):
        self.publish()
        code, out = self.mach("install", "--no-floor")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / mach.FLOOR_DEST).exists())
        self.assertIn("The Factory Floor was not installed (skipped).", out)
        code, out = self.mach("scaffold", "--no-floor")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / mach.FLOOR_DEST).exists())
        self.setenv("MACH_FLOOR", "skip")
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / mach.FLOOR_DEST).exists())

    def test_dry_run_downloads_nothing(self):
        self.publish()
        code, out = self.mach("install", "--dry-run")
        self.assertEqual(code, 0, out)
        self.assertIn(f"Would download the Factory Floor ({mach.floor_asset()})", out)
        self.assertEqual(snapshot(self.project), {})

    def test_a_build_in_this_checkout_is_used_without_downloading(self):
        mach.FLOOR_LOCAL_BUILD = "bin/mach"  # any real file in the checkout stands in for a built observer
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.project / mach.FLOOR_DEST).read_bytes(), (ROOT / "bin/mach").read_bytes())
        self.assertIn("this MACH checkout's own build", out)

    def test_uninstall_removes_it_and_leaves_an_empty_project(self):
        self.publish()
        self.mach("install")
        code, out = self.mach("uninstall")
        self.assertEqual(code, 0, out)
        self.assertIn(f"remove   {mach.FLOOR_DEST}", out)
        self.assertEqual(list(self.project.iterdir()), [], out)


class ProvenanceTest(Base):
    """M7: after the checksum, a program from the project's GitHub release is checked for build
    provenance with `gh attestation verify`. The release is served by a stand-in for fetch (no network)
    and `gh` is a fake on PATH (simulated: no real attestation is verified here)."""

    def setUp(self):
        super().setUp()
        for name in ("MACH_STUDIO", "MACH_STUDIO_URL", "MACH_FLOOR_URL", "MACH_REPO", mach.REQUIRE_PROVENANCE_ENV):
            self.setenv(name, None)
        self.release = Path(self.tmp.name).resolve() / "release"
        self.release.mkdir()
        self.local = mach.STUDIO_LOCAL_BUILD
        mach.STUDIO_LOCAL_BUILD = "apps/studio/bin/no-such-build"
        self.addCleanup(lambda: setattr(mach, "STUDIO_LOCAL_BUILD", self.local))
        self.fetched = []
        real_fetch = mach.fetch

        def fetch(url):
            self.fetched.append(url)
            if url.startswith("file://"):
                return real_fetch(url)
            path = self.release / url.rsplit("/", 1)[1]
            if not path.is_file():
                raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
            return path.read_bytes()

        mach.fetch = fetch
        self.addCleanup(lambda: setattr(mach, "fetch", real_fetch))
        # PATH holds Git (the installer needs it) and, when a test asks, a fake gh; never the real gh.
        self.bin = Path(self.tmp.name).resolve() / "bin"
        self.bin.mkdir()
        (self.bin / "git").symlink_to(shutil.which("git"))
        self.setenv("PATH", str(self.bin))
        self.log = Path(self.tmp.name).resolve() / "gh-args"
        self.setenv("FAKE_GH_LOG", str(self.log))
        self.data = b"#!/bin/sh\necho studio\n"
        (self.release / mach.studio_asset()).write_bytes(self.data)
        (self.release / mach.STUDIO_SUMS).write_text(f"{mach.sha(self.data)}  {mach.studio_asset()}\n", encoding="utf-8")

    def fake_gh(self, exit_code):
        gh = self.bin / "gh"
        gh.write_text('#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "$FAKE_GH_LOG"\n'
                      f'[ -f "$3" ] && echo present >> "$FAKE_GH_LOG"\nexit {exit_code}\n', encoding="utf-8")
        gh.chmod(0o755)

    def note(self, out):
        return next(line for line in out.splitlines() if line.startswith("The visual Product Studio app"))

    def test_the_download_comes_from_the_projects_github_release(self):
        self.mach("install")
        version = mach.source_version(ROOT)
        self.assertEqual(self.fetched[0], f"https://github.com/swiftj/mach-harness/releases/download/v{version}/{mach.STUDIO_SUMS}")

    def test_verified_provenance_is_named(self):
        self.fake_gh(0)
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.project / mach.STUDIO_DEST).read_bytes(), self.data)
        self.assertIn("checked against the release's checksum and its build provenance was verified with the GitHub CLI "
                      "(gh attestation verify, swiftj/mach-harness)", self.note(out))
        args = self.log.read_text().split("\n")
        self.assertEqual(args[:2], ["attestation", "verify"])
        self.assertEqual(Path(args[2]).name, mach.studio_asset())
        self.assertEqual(args[3:7], ["--repo", "swiftj/mach-harness", "--signer-workflow", "swiftj/mach-harness/.github/workflows/release.yml"])
        self.assertIn("present", args)  # gh was given the downloaded file itself
        self.assertFalse(Path(args[2]).exists(), "the copy handed to gh is removed afterwards")
        record = json.loads((self.project / mach.MANIFEST).read_text())["programs"][mach.STUDIO_DEST]
        self.assertEqual(record["version"], mach.source_version(ROOT))
        self.assertEqual(record["asset"], mach.studio_asset())
        self.assertIn("build provenance was verified", record["checked"])

    def test_the_repository_comes_from_where_the_release_url_does(self):
        self.fake_gh(0)
        self.setenv("MACH_REPO", "someone/fork")
        self.mach("install")
        self.assertTrue(self.fetched[0].startswith("https://github.com/someone/fork/releases/download/"))
        self.assertIn("--repo\nsomeone/fork\n", self.log.read_text())

    def test_without_gh_the_checksum_alone_is_said_plainly(self):
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertTrue((self.project / mach.STUDIO_DEST).is_file())
        note = self.note(out)
        self.assertIn("checked against the release's checksum; its build provenance was not verified (GitHub CLI not available)", note)
        self.assertNotIn("was verified", note)

    def test_gh_not_signed_in_is_the_same_as_no_gh(self):
        self.fake_gh(mach.GH_AUTH_REQUIRED)
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertTrue((self.project / mach.STUDIO_DEST).is_file())
        self.assertIn("its build provenance was not verified (GitHub CLI not available)", self.note(out))

    def test_failed_provenance_refuses_the_program_and_the_rest_installs(self):
        self.fake_gh(1)
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / mach.STUDIO_DEST).exists())
        self.assertNotIn(mach.STUDIO_DEST, json.loads((self.project / mach.MANIFEST).read_text())["files"])
        self.assertIn("matched the release's checksum, but its build provenance did not verify (gh attestation verify, swiftj/mach-harness), "
                      "so it was refused and removed", self.note(out))
        self.assertFalse(Path(self.log.read_text().split("\n")[2]).exists())
        self.assertTrue((self.project / SKILL).is_file())

    def test_failed_provenance_on_update_keeps_the_installed_copy(self):
        self.fake_gh(0)
        self.mach("install")
        tampered = b"#!/bin/sh\necho tampered\n"
        (self.release / mach.studio_asset()).write_bytes(tampered)
        (self.release / mach.STUDIO_SUMS).write_text(f"{mach.sha(tampered)}  {mach.studio_asset()}\n", encoding="utf-8")
        self.fake_gh(1)
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertEqual((self.project / mach.STUDIO_DEST).read_bytes(), self.data)
        self.assertIn("The copy already installed was kept.", self.note(out))

    def test_require_provenance_refuses_when_it_cannot_be_verified(self):
        self.setenv(mach.REQUIRE_PROVENANCE_ENV, "1")
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertFalse((self.project / mach.STUDIO_DEST).exists())
        self.assertIn("its build provenance could not be verified (GitHub CLI not available) and MACH_REQUIRE_PROVENANCE=1 requires it, "
                      "so it was refused", self.note(out))
        self.fake_gh(0)
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertTrue((self.project / mach.STUDIO_DEST).is_file())

    def test_a_mirror_or_local_folder_is_checksum_only_and_says_why(self):
        self.fake_gh(1)  # would refuse, but must not be asked: a mirror carries no attestation
        self.setenv("MACH_STUDIO_URL", self.release.as_uri())
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertTrue((self.project / mach.STUDIO_DEST).is_file())
        self.assertFalse(self.log.exists())
        self.assertIn("checked against the release's checksum; its build provenance was not verified "
                      "(MACH_STUDIO_URL points at a local or mirrored release, which carries no attestation)", self.note(out))
        record = json.loads((self.project / mach.MANIFEST).read_text())["programs"][mach.STUDIO_DEST]
        self.assertEqual(record["source"], "MACH_STUDIO_URL (a mirror or local folder)")
        self.assertNotIn(str(self.release), json.dumps(record))  # no local path in the manifest
        other = self.project.parent / "other"
        other.mkdir()
        self.setenv(mach.REQUIRE_PROVENANCE_ENV, "1")
        code, out = run("install", "--project", str(other))
        self.assertFalse((other / mach.STUDIO_DEST).exists())
        self.assertIn("MACH_REQUIRE_PROVENANCE=1 requires it, so it was refused", self.note(out))

    def test_no_message_says_checked_without_naming_the_check(self):
        for exit_code in (None, 0):
            if exit_code is not None:
                self.fake_gh(exit_code)
            _, out = run("install", "--project", str(self.project))
            for line in out.splitlines():
                if "checked" in line and line.startswith("The visual"):
                    self.assertIn("checked against the release's checksum", line)

    def test_a_missing_asset_or_release_is_one_plain_line(self):
        (self.release / mach.studio_asset()).unlink()
        _, out = self.mach("install")
        self.assertIn(f"was not installed: release v{mach.source_version(ROOT)} does not have the file {mach.studio_asset()}.", self.note(out))
        self.assertNotIn("Errno", self.note(out))
        self.assertNotIn("HTTP", self.note(out))
        (self.release / mach.STUDIO_SUMS).unlink()
        _, out = self.mach("install")
        self.assertIn(f"release v{mach.source_version(ROOT)} was not found, or it has no checksum file (SHA256SUMS)", self.note(out))


class PrerequisiteTest(Base):
    """M7: a missing Git (or too old a Python) is said in words a person can act on, not a traceback."""

    def setUp(self):
        super().setUp()
        self.bin = Path(self.tmp.name).resolve() / "bin"
        self.bin.mkdir()

    def test_install_without_git_says_how_to_get_it_and_writes_nothing(self):
        self.setenv("PATH", str(self.bin))
        code, out = self.mach("install")
        self.assertEqual(code, 2, out)
        self.assertIn(mach.GIT_MISSING, out)
        self.assertIn("xcode-select --install", out)
        self.assertEqual(list(self.project.iterdir()), [])
        code, out = self.mach("scaffold")
        self.assertEqual(code, 2, out)
        self.assertIn("MACH needs Git", out)

    def test_a_git_that_does_not_run_counts_as_missing(self):
        # A Mac without Apple's command line tools has /usr/bin/git, which only offers to install them.
        git = self.bin / "git"
        git.write_text("#!/bin/sh\necho 'xcrun: error: invalid active developer path' >&2\nexit 1\n", encoding="utf-8")
        git.chmod(0o755)
        self.setenv("PATH", str(self.bin))
        code, out = self.mach("install")
        self.assertEqual(code, 2, out)
        self.assertIn(mach.GIT_MISSING, out)

    def test_too_old_a_python_is_refused_plainly(self):
        minimum = mach.MIN_PYTHON
        mach.MIN_PYTHON = (99, 0)
        self.addCleanup(lambda: setattr(mach, "MIN_PYTHON", minimum))
        code, out = self.mach("install")
        self.assertEqual(code, 2, out)
        self.assertIn("MACH needs Python 99.0 or later", out)
        self.assertEqual(list(self.project.iterdir()), [])

    def test_the_minimum_python_is_the_one_the_skills_declare(self):
        self.assertEqual(mach.MIN_PYTHON, (3, 8))
        for skill in ("intent", "build", "run"):
            self.assertIn('"python3 >= 3.8', (ROOT / "skills" / skill / "SKILL.md").read_text())

    def test_product_studio_without_git_gives_the_same_plain_message(self):
        self.mach("install")
        script = self.project / ".claude/skills/mach-product-studio/scripts/studio.py"
        done = subprocess.run([sys.executable, str(script), "--project", str(self.project), "status"], capture_output=True, text=True,
                              env={**os.environ, "PATH": str(self.bin)})
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertNotIn("Traceback", done.stderr)
        self.assertIn(mach.GIT_MISSING, done.stderr)


class UninstallCacheTest(Base):
    """M7: uninstall removes the compiled copies (__pycache__) of the scripts it removes, says so, and
    leaves any other file in a __pycache__ folder alone."""

    def test_compiled_copies_of_installed_scripts_are_listed_and_removed_others_kept(self):
        self.mach("install")
        cache = self.project / ".claude/skills/mach-intent/scripts/__pycache__"
        cache.mkdir(exist_ok=True)
        (cache / "cell.cpython-39.pyc").write_bytes(b"compiled")
        (cache / "mine.cpython-39.pyc").write_bytes(b"not MACH's")
        code, out = self.mach("uninstall", "--dry-run")
        self.assertIn("remove   .claude/skills/mach-intent/scripts/__pycache__/", out)
        self.assertTrue((cache / "cell.cpython-39.pyc").is_file())
        code, out = self.mach("uninstall")
        self.assertEqual(code, 0, out)
        self.assertIn("remove   .claude/skills/mach-intent/scripts/__pycache__/", out)
        self.assertFalse((cache / "cell.cpython-39.pyc").exists())
        self.assertEqual(sorted(p.name for p in cache.iterdir()), ["mine.cpython-39.pyc"])
        left = {p.relative_to(self.project).as_posix() for p in self.project.rglob("*") if p.is_file()}
        self.assertEqual(left, {".claude/skills/mach-intent/scripts/__pycache__/mine.cpython-39.pyc"})


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

    def test_install_sh_is_valid_shell(self):
        done = subprocess.run(["sh", "-n", str(ROOT / "install.sh")], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        done = subprocess.run(["bash", "-n", str(ROOT / "install.sh")], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)


REPO = "swiftj/mach-harness"
NEW, OLD = "0.13.0-rc.2", "0.12.0"  # a release with a source archive (a candidate, so the suffix is exercised); the last one without


def source_tree(folder, prefix, version):
    """What `git archive --prefix=<prefix>/` gives for the parts the installer needs, at `version`."""
    tree = folder / prefix
    for part in (".claude-plugin", "bin", "skills", "agents", "workflows", "templates"):
        shutil.copytree(ROOT / part, tree / part, ignore=shutil.ignore_patterns("__pycache__", ".DS_Store"))
    plugin = tree / ".claude-plugin/plugin.json"
    plugin.write_text(json.dumps({**json.loads(plugin.read_text()), "version": version}), encoding="utf-8")
    return tree


def targz(tree, path):
    import tarfile
    with tarfile.open(path, "w:gz") as archive:
        archive.add(tree, arcname=tree.name)
    return path.read_bytes()


class SourceArchiveTest(Base):
    """M7 (2): install.sh installs a release's source archive, checked against SHA256SUMS and, with gh,
    its attestation, before any of it runs. No network: a fake `curl` on PATH maps every https:// URL to a
    folder (simulated GitHub), and `gh` is a fake script (simulated: no real attestation is verified)."""

    @classmethod
    def setUpClass(cls):
        cls.built = tempfile.TemporaryDirectory()
        here = Path(cls.built.name).resolve()
        cls.good = targz(source_tree(here, f"mach-{NEW}", NEW), here / "new.tar.gz")
        cls.old = targz(source_tree(here, f"mach-harness-{OLD}", OLD), here / "old.tar.gz")
        cls.main = targz(source_tree(here, "mach-harness-main", "0.13.1"), here / "main.tar.gz")

    @classmethod
    def tearDownClass(cls):
        cls.built.cleanup()

    def setUp(self):
        super().setUp()
        base = Path(self.tmp.name).resolve()
        self.web, self.bin, self.temp = base / "web", base / "bin", base / "tmp"
        for folder in (self.web, self.bin, self.temp):
            folder.mkdir()
        # PATH: only the tools install.sh and bin/mach use, never a real gh.
        for tool in ("bash", "sh", "env", "tar", "gzip", "mktemp", "rm", "mkdir", "awk", "tr", "cat", "git",
                     "shasum", "sha256sum", "perl", "dirname", "uname", "ls"):
            found = shutil.which(tool)
            if found:
                (self.bin / tool).symlink_to(found)
        (self.bin / "python3").symlink_to(sys.executable)
        curl = self.bin / "curl"
        curl.write_text('#!/bin/sh\nn=$#\nfor a in "$@"; do\n  case "$a" in\n    https://*\\?*) a="file://$FAKE_WEB/$(printf %s "${a#https://}" | tr "?=&" "___")" ;;\n'
                        '    https://*) a="file://$FAKE_WEB/${a#https://}" ;;\n'
                        '    =https) a="=https,file" ;;\n  esac\n  set -- "$@" "$a"\ndone\nshift "$n"\n'
                        f'exec {shutil.which("curl")} "$@"\n', encoding="utf-8")
        curl.chmod(0o755)
        self.gh_log = base / "gh-args"
        self.release(NEW, self.good)
        self.write(f"api.github.com/repos/{REPO}/releases/latest", json.dumps({"tag_name": f"v{NEW}"}).encode())

    def write(self, path, data):
        target = self.web / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def release(self, version, archive, listed=None, sums=True):
        folder = f"github.com/{REPO}/releases/download/v{version}"
        name = f"mach-{version}-source.tar.gz"
        if archive is not None:
            self.write(f"{folder}/{name}", archive)
        if sums:
            lines = [f"{mach.sha(b'studio')}  mach-studio-darwin-arm64"]
            if listed is not False:
                lines.append(f"{listed or mach.sha(archive)}  {name}")
            self.write(f"{folder}/SHA256SUMS", ("\n".join(lines) + "\n").encode())

    def fake_gh(self, exit_code):
        gh = self.bin / "gh"
        gh.write_text(f'#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "{self.gh_log}"\nexit {exit_code}\n', encoding="utf-8")
        gh.chmod(0o755)

    def sh(self, *args, **env):
        base = {key: value for key, value in os.environ.items() if not key.startswith("MACH_") or key in ("MACH_STUDIO", "MACH_FLOOR")}
        base.update(PATH=str(self.bin), FAKE_WEB=str(self.web), TMPDIR=str(self.temp))
        return subprocess.run([shutil.which("bash"), str(ROOT / "install.sh"), *args], cwd=self.project, capture_output=True, text=True,
                              env={**base, **env})

    def note(self, done):
        return next(line for line in (done.stdout + done.stderr).splitlines() if line.startswith(("MACH source:", "error:")))

    def assert_refused(self, done, words):
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertIn(words, done.stderr)
        self.assertIn("Nothing was installed", done.stderr)
        self.assertEqual(list(self.project.iterdir()), [], "nothing is written to the project")
        self.assertEqual(list(self.temp.iterdir()), [], "the downloads are removed")

    def source_record(self):
        return json.loads((self.project / mach.MANIFEST).read_text())["source"]

    def test_the_newest_release_is_checked_and_installed_and_the_manifest_says_how(self):
        done = self.sh()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((self.project / SKILL).is_file())
        self.assertEqual(json.loads((self.project / mach.MANIFEST).read_text())["version"], NEW)
        expected = (f"MACH source: github.com/{REPO} release v{NEW} (mach-{NEW}-source.tar.gz), checked against the release's checksum; "
                    f"its build provenance was not verified ({mach.NO_GH}).")
        self.assertEqual(self.note(done), expected)
        self.assertEqual(self.source_record(), {"from": f"github.com/{REPO} release v{NEW} (mach-{NEW}-source.tar.gz)",
                                                "checked": f"checked against the release's checksum; its build provenance was not verified ({mach.NO_GH})"})
        self.assertEqual(list(self.temp.iterdir()), [])

    def test_a_fake_gh_that_verifies_is_named_with_the_same_words_as_the_programs(self):
        self.fake_gh(0)
        done = self.sh(MACH_VERSION=NEW)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("checked against the release's checksum and its build provenance was verified with the GitHub CLI "
                      f"(gh attestation verify, {REPO}).", self.note(done))
        args = self.gh_log.read_text().split("\n")
        self.assertEqual(args[:2], ["attestation", "verify"])
        self.assertEqual(Path(args[2]).name, f"mach-{NEW}-source.tar.gz")
        self.assertEqual(args[3:7], ["--repo", REPO, "--signer-workflow", f"{REPO}/{mach.RELEASE_WORKFLOW}"])
        self.assertIn("build provenance was verified", self.source_record()["checked"])
        self.assertEqual(list(self.temp.iterdir()), [])

    def test_a_fake_gh_that_fails_refuses_before_anything_runs(self):
        self.fake_gh(1)
        done = self.sh()
        self.assert_refused(done, f"mach-{NEW}-source.tar.gz matched the release's checksum, but its build provenance did not verify "
                                  f"(gh attestation verify, {REPO}), so it was refused and removed")

    def test_gh_not_signed_in_is_the_same_as_no_gh(self):
        self.fake_gh(mach.GH_AUTH_REQUIRED)
        done = self.sh()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(f"its build provenance was not verified ({mach.NO_GH})", self.note(done))

    def test_a_tampered_archive_is_refused_nothing_installed_downloads_removed(self):
        self.release(NEW, self.good[:-40] + b"tampered" * 5, listed=mach.sha(self.good))
        self.fake_gh(0)  # would pass: the checksum must refuse it first
        done = self.sh()
        self.assert_refused(done, f"mach-{NEW}-source.tar.gz does not match the release's published checksum, so it was refused")
        self.assertFalse(self.gh_log.exists(), "gh is not asked about a file that failed its checksum")

    def test_require_provenance_without_gh_is_refused(self):
        done = self.sh(MACH_REQUIRE_PROVENANCE="1")
        self.assert_refused(done, f"its build provenance could not be verified ({mach.NO_GH}) and MACH_REQUIRE_PROVENANCE=1 requires it, so it was refused")
        self.fake_gh(0)
        done = self.sh(MACH_REQUIRE_PROVENANCE="1")
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_the_default_install_of_an_old_release_points_at_a_newer_verifiable_candidate(self):
        """With no version asked for, the newest full release is installed; when that one predates source
        archives and a later candidate exists, the person is told how to get the one that can be verified."""
        self.write(f"codeload.github.com/{REPO}/tar.gz/refs/tags/v{OLD}", self.old)
        self.write(f"api.github.com/repos/{REPO}/releases/latest", json.dumps({"tag_name": f"v{OLD}"}).encode())
        listing = [{"tag_name": f"v{NEW}", "prerelease": True, "draft": False}, {"tag_name": f"v{OLD}", "prerelease": False, "draft": False}]
        self.write(f"api.github.com/repos/{REPO}/releases_per_page_30", json.dumps(listing).encode())  # the fake curl maps ?= to _
        done = self.sh()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(f"A later release candidate, v{NEW}, is available and its source can be verified.", done.stdout)
        self.assertIn(f"run this again with MACH_VERSION={NEW} set", done.stdout)
        shutil.rmtree(self.project)
        self.project.mkdir()
        done = self.sh(MACH_VERSION=OLD)  # asked for by name: no suggestion
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("A later release candidate", done.stdout)

    def test_a_release_before_source_archives_installs_with_a_note_unless_provenance_is_required(self):
        self.write(f"codeload.github.com/{REPO}/tar.gz/refs/tags/v{OLD}", self.old)
        done = self.sh(MACH_VERSION=OLD)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((self.project / SKILL).is_file())
        self.assertEqual(self.note(done), f"MACH source: github.com/{REPO} tag v{OLD}; it was not verified (release v{OLD} predates MACH's "
                                          "source archives, so its source has no checksum or attestation).")
        self.assertIn("not verified", self.source_record()["checked"])
        shutil.rmtree(self.project)
        self.project.mkdir()
        self.assert_refused(self.sh(MACH_VERSION=f"v{OLD}", MACH_REQUIRE_PROVENANCE="yes"), "MACH_REQUIRE_PROVENANCE=1 requires it")

    def test_a_newer_release_without_its_archive_is_refused_never_installed_unchecked(self):
        self.write(f"codeload.github.com/{REPO}/tar.gz/refs/tags/v{NEW}", self.good)  # a fallback must not be taken
        self.release(NEW, None, listed=False)
        self.assert_refused(self.sh(), f"release v{NEW} does not list mach-{NEW}-source.tar.gz in its SHA256SUMS")
        shutil.rmtree(self.web / f"github.com/{REPO}/releases/download/v{NEW}")
        self.assert_refused(self.sh(), f"release v{NEW} was not found, or it has no checksum file (SHA256SUMS)")
        self.release(NEW, None, listed="a" * 64)  # listed, but the file is missing
        self.assert_refused(self.sh(), f"release v{NEW} does not have the file mach-{NEW}-source.tar.gz")

    def test_an_archive_that_names_another_version_is_refused(self):
        self.release("0.14.0", self.good)
        self.assert_refused(self.sh(MACH_VERSION="0.14.0"), f"the downloaded source says it is MACH '{NEW}', not 0.14.0")

    def test_a_branch_only_by_explicit_choice_and_said_to_be_unverified(self):
        self.write(f"codeload.github.com/{REPO}/tar.gz/refs/heads/main", self.main)
        done = self.sh(MACH_REF="main")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((self.project / SKILL).is_file())
        self.assertEqual(self.note(done), f"MACH source: github.com/{REPO} branch main; it was not verified (a branch has no checksum "
                                          "or build provenance; install a release to have it checked).")
        self.assertEqual(self.source_record()["from"], f"github.com/{REPO} branch main")
        shutil.rmtree(self.project)
        self.project.mkdir()
        self.assert_refused(self.sh(MACH_REF="main", MACH_REQUIRE_PROVENANCE="1"), "MACH_REQUIRE_PROVENANCE=1 requires it")

    def test_a_local_copy_says_it_was_not_verified_and_records_no_path(self):
        done = self.sh(MACH_SOURCE=str(ROOT))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("MACH source: the local copy named by MACH_SOURCE; it was not verified", self.note(done))
        self.assertEqual(self.source_record()["from"], "a local copy (MACH_SOURCE)")
        self.assertNotIn(str(ROOT), (self.project / mach.MANIFEST).read_text())

    def test_only_one_source_may_be_chosen(self):
        self.assert_refused(self.sh(MACH_REF="main", MACH_VERSION=NEW), "set only one of MACH_SOURCE, MACH_REF and MACH_VERSION")

    def test_flags_and_upgrade_still_work(self):
        done = self.sh("install", "--no-studio", "--no-floor", MACH_STUDIO="", MACH_FLOOR="")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("The visual Product Studio app was not installed (skipped).", done.stdout)
        self.assertIn("The Factory Floor was not installed (skipped).", done.stdout)
        self.write(f"codeload.github.com/{REPO}/tar.gz/refs/tags/v{OLD}", self.old)
        shutil.rmtree(self.project)
        self.project.mkdir()
        self.assertEqual(self.sh(MACH_VERSION=OLD).returncode, 0)
        self.fake_gh(0)
        done = self.sh()  # upgrade v0.12.0 -> v0.13.0 over the existing install
        self.assertEqual(done.returncode, 0, done.stderr)
        manifest = json.loads((self.project / mach.MANIFEST).read_text())
        self.assertEqual(manifest["version"], NEW)
        self.assertIn("build provenance was verified", manifest["source"]["checked"])

    def test_bin_mach_run_directly_records_that(self):
        code, out = self.mach("install")
        self.assertEqual(code, 0, out)
        self.assertIn("run directly", self.source_record()["checked"])


class PackagingTest(unittest.TestCase):
    def test_the_release_workflow_publishes_what_the_installer_downloads(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        targets = re.search(r"for target in ([a-z0-9/ ]+); do", workflow).group(1).split()
        published = {f"mach-studio-{t.replace('/', '-')}" for t in targets}
        expected = {f"mach-studio-{build}" for build in mach.STUDIO_BUILDS}
        self.assertNotIn("mach-studio-darwin-amd64", expected)
        self.assertEqual(published, expected)
        self.assertIn(f"> {mach.STUDIO_SUMS}", workflow)
        self.assertIn('tags: ["v*"]', workflow)

    def test_the_release_workflow_builds_smokes_and_attests_the_observer(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        self.assertIn('OUT="$PWD/dist/mach-observer-${target%/*}-${target#*/}" sh apps/observer/build.sh', workflow)
        self.assertIn("sha256sum mach-studio-* mach-observer-* mach-*-source.tar.gz > SHA256SUMS", workflow)
        self.assertIn("sh apps/observer/smoke.sh", workflow)
        smoked = set(re.findall(r"observer: (mach-observer-[a-z0-9-]+) \}", workflow))
        self.assertEqual(smoked, {f"mach-observer-{build}" for build in mach.STUDIO_BUILDS})
        self.assertRegex(workflow, r"subject-path: \|\n\s+dist/mach-studio-\*\n\s+dist/mach-observer-\*")
        self.assertNotIn("windows", workflow.lower())

    def test_the_release_workflow_publishes_and_attests_the_source_archive_install_sh_checks(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        script = (ROOT / "install.sh").read_text(encoding="utf-8")
        self.assertIn('git archive --format=tar --prefix="mach-$PLUGIN_VERSION/" HEAD | gzip -9n > "dist/mach-$PLUGIN_VERSION-source.tar.gz"', workflow)
        self.assertRegex(workflow, r"dist/mach-observer-\*\n\s+dist/mach-\*-source\.tar\.gz\n\s+dist/SHA256SUMS")
        self.assertLess(workflow.index("-source.tar.gz > SHA256SUMS"), workflow.index("attest-build-provenance"))
        self.assertIn('ARCHIVE="mach-$VERSION-source.tar.gz"', script)
        # install.sh verifies the archive itself (the downloaded bin/mach cannot vouch for its own archive),
        # with the same command, rule and words as bin/mach.
        for words in (f'RELEASE_WORKFLOW="{mach.RELEASE_WORKFLOW}"', f'NO_GH="{mach.NO_GH}"', f"GH_AUTH_REQUIRED={mach.GH_AUTH_REQUIRED}",
                      'gh attestation verify "$WORK/$ARCHIVE" --repo "$REPO" --signer-workflow "$REPO/$RELEASE_WORKFLOW"',
                      "checked against the release's checksum and its build provenance was verified with the GitHub CLI (gh attestation verify, $REPO)",
                      "checked against the release's checksum; its build provenance was not verified ($REASON)",
                      "but its build provenance did not verify (gh attestation verify, $REPO), so it was refused and removed",
                      "and MACH_REQUIRE_PROVENANCE=1 requires it, so it was refused"):
            self.assertIn(words, script)
        self.assertNotIn("refs/heads/$REF\" | tar", script)  # nothing is piped from a download into tar unchecked
        self.assertIn("codeload.github.com/$REPO/tar.gz/refs/heads/$REF", script)  # only under an explicit MACH_REF

    def test_the_release_workflow_pins_its_tools_stamps_versions_and_publishes_sboms(self):
        # M7: third-party actions by full commit SHA (a tag can be moved), Go by patch release, syft by version.
        workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        uses = re.findall(r"uses: (\S+)(.*)", workflow)
        self.assertTrue(uses)
        for action, comment in uses:
            self.assertRegex(action, r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$", action)
            self.assertRegex(comment, r"^ # v\d+\.\d+\.\d+$", action)
        self.assertRegex(workflow, r'go-version: "\d+\.\d+\.\d+"')
        self.assertNotIn("go-version-file", workflow)
        self.assertRegex(workflow, r"syft-version: v\d+\.\d+\.\d+")
        self.assertIn('-o "spdx-json=$file.spdx.json"', workflow)
        self.assertRegex(workflow, r"subject-path: \|\n\s+dist/mach-studio-\*\n\s+dist/mach-observer-\*\n\s+dist/mach-\*-source\.tar\.gz\n\s+dist/SHA256SUMS")
        self.assertLess(workflow.index("attest-build-provenance"), workflow.index("download-syft"))  # SBOMs are not attested subjects
        self.assertIn("export VERSION", workflow)
        for app in ("studio", "observer"):
            self.assertIn('-ldflags "-X main.version=${VERSION:-dev}"', (ROOT / "apps" / app / "build.sh").read_text(encoding="utf-8"))
            self.assertIn(f'"dist/${{{{ matrix.{"file" if app == "studio" else "observer"} }}}}" --version', workflow)

    def test_plugin_manifests_agree(self):
        plugin = json.loads((ROOT / ".claude-plugin/plugin.json").read_text())
        market = json.loads((ROOT / ".claude-plugin/marketplace.json").read_text())
        self.assertEqual(plugin["name"], "mach")
        self.assertRegex(plugin["version"], r"^\d+\.\d+\.\d+(-rc\.\d+)?$")  # a release candidate carries -rc.N
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
