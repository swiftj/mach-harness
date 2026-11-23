"""A ticket's workspace never holds Claude Code's configuration (skills/intent/scripts/workspace.py).

Claude Code's sandbox refuses writes to `.claude/` and `.mcp.json` in the working directory and the folders above it.
A cell is a sparse worktree that leaves them out, so no Git command a station runs in a cell ever writes them.

The real sandbox is not available to these tests. They simulate its refusal honestly, in two ways:
- `guard()` puts an empty, read-only `.claude` folder in the cell, so the operating system refuses any write under it,
  the way the sandbox would (skipped when the tests run as root, who may write anywhere). A control test shows the guard
  does refuse Git's writes in a full checkout, so it reproduces the reported failure.
- `assert_holds_none()` checks, after every step, that no `.claude` folder with anything in it and no `.mcp.json` file
  exists anywhere in the cell. (A file that does not exist cannot be made read-only, so `.mcp.json` is checked this way.)
What they cannot prove: that Claude Code's sandbox refuses nothing else Git writes in a cell (its own `.git` records, the
cell's other files), or that the sandbox's rules stay as documented.
"""

import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "cleanup" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import cell  # noqa: E402
import cleanup  # noqa: E402
import doctor  # noqa: E402
import workspace  # noqa: E402
import test_cell  # noqa: E402
from test_build import RED_TEST  # noqa: E402
from test_build_on_main import MainBase, TICKET  # noqa: E402
from test_merge import Base as MergeBase  # noqa: E402
from test_cleanup import Base as CleanupBase, BRANCH  # noqa: E402

CLAUDE_FILES = {
    ".claude/agents/mach-builder.md": "builder v1\n",
    ".claude/skills/mach-build/SKILL.md": "build v1\n",
    ".claude/workflows/mach-belt.js": "belt v1\n",
    ".claude/settings.json": "{}\n",
    ".mcp.json": "{\"mcpServers\": {}}\n",
    "packages/web/.claude/agents/local.md": "nested\n",
    "packages/web/.mcp.json": "{}\n",
}
MACH_UPDATE = {
    ".claude/agents/mach-builder.md": "builder v2\n",
    ".claude/skills/mach-new/SKILL.md": "new skill\n",
    ".mcp.json": "{\"mcpServers\": {\"x\": {}}}\n",
}


def git(folder, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    return subprocess.run(["git", *args], cwd=str(folder), capture_output=True, text=True, env=env)


def put(folder, files):
    for name, text in files.items():
        path = Path(folder) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


class Sandbox:
    """The two simulations of the sandbox's refusal, for any test class."""

    def guard(self, work):
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("as root, a read-only folder refuses nothing")
        folder = Path(work) / ".claude"
        self.assertFalse(folder.exists(), "a cell holds no .claude folder")
        folder.mkdir()
        os.chmod(folder, 0o555)
        self.addCleanup(lambda: folder.is_dir() and os.chmod(folder, 0o755))  # cleanup may have removed the cell
        return folder

    def assert_holds_none(self, work):
        found = []
        for top, dirs, names in os.walk(str(work)):
            dirs[:] = [d for d in dirs if d != ".git"]
            here = Path(top)
            if here.name == ".claude" and (dirs or names):
                found.append(str(here.relative_to(work)))
            found += [str((here / name).relative_to(work)) for name in names if name == ".mcp.json"]
        self.assertEqual(found, [], "the cell holds Claude Code configuration")

    def assert_clean(self, work):
        self.assertEqual(git(work, "status", "--porcelain", "--untracked-files=all").stdout, "", "nothing shows as changed or deleted")


class ProtectedPathTest(unittest.TestCase):
    def test_what_a_cell_never_holds(self):
        for name in (".claude/agents/x.md", ".claude", "./.claude/settings.json", "packages/web/.claude/skills/a/SKILL.md", ".mcp.json",
                     "tools/.mcp.json", "`.claude/workflows/mach-belt.js`"):
            self.assertTrue(workspace.protected(name), name)
        for name in ("src/claude.py", "docs/.claude.md", "CLAUDE.md", "mcp.json", ".mcp.json.example", "claude/agents/x.md", ""):
            self.assertFalse(workspace.protected(name), name)

    def test_the_git_version_needed(self):
        self.assertIsNone(workspace.version_problem((2, 36, 0)))
        self.assertIsNone(workspace.version_problem((3, 0, 0)))
        self.assertIn("needs Git 2.36 or later; this is Git 2.35.8", workspace.version_problem((2, 35, 8)))
        self.assertIn("could not read Git's version", workspace.version_problem(None))


class OpenTest(test_cell.Base, Sandbox):
    def setUp(self):
        super().setUp()
        put(self.project, CLAUDE_FILES)
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "claude config")

    def test_a_cell_leaves_out_claude_config_and_the_branch_keeps_it(self):
        info = self.open()
        work = Path(info["workdir"])
        self.assertEqual(info["isolation"], "worktree")
        self.assertTrue((work / "README.md").is_file())
        self.assert_holds_none(work)
        self.assert_clean(work)
        self.assertEqual(git(work, "diff", "--name-status", "HEAD").stdout, "")
        self.assertTrue(workspace.is_sparse(work))
        self.assertEqual(git(work, "show", "HEAD:.claude/agents/mach-builder.md").stdout, "builder v1\n", "the branch still carries the files")
        skipped = {line[2:] for line in git(work, "ls-files", "-t").stdout.splitlines() if line.startswith("S ")}
        self.assertEqual(skipped, set(CLAUDE_FILES))
        # The main checkout is untouched: full, clean, not sparse.
        self.assertFalse(workspace.is_sparse(self.project))
        for name in CLAUDE_FILES:
            self.assertTrue((self.project / name).is_file(), name)
        self.assertEqual(git(self.project, "status", "--porcelain").stdout, "")

    def test_git_operations_in_a_cell_never_write_claude_config(self):
        cut_before = git(self.project, "rev-parse", "HEAD").stdout.strip()
        work = Path(self.open()["workdir"])
        self.guard(work)
        put(work, {"src/app.py": "A = 1\n"})
        self.assertEqual(git(work, "add", "-A").returncode, 0)
        self.assertEqual(git(work, "commit", "-q", "-m", "cell work").returncode, 0)
        put(self.project, MACH_UPDATE)  # a MACH update lands on main mid-ticket
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "update MACH")
        main_head = git(self.project, "rev-parse", "HEAD").stdout.strip()
        steps = [
            ("merge", ["merge", "--no-ff", "--no-edit", main_head]),
            ("stash", ["stash", "push", "-u", "-q", "-m", "workspace-test"]),
            ("stash pop", ["stash", "pop", "-q"]),
            ("commit", ["commit", "-qam", "more"]),
            ("reset", ["reset", "-q", "--hard", "HEAD~1"]),
            ("checkout old", ["checkout", "-q", "--detach", cut_before]),
            ("checkout branch", ["checkout", "-q", "feature/LOCAL-001"]),
            ("rebase", ["rebase", "-q", main_head]),
        ]
        for label, argv in steps:
            if label == "stash":
                put(work, {"src/app.py": "A = 2\n", "src/new.py": "B = 1\n"})
            if label == "commit":
                put(work, {"src/app.py": "A = 3\n"})
                self.assertEqual(git(work, "add", "-A").returncode, 0)
            done = git(work, *argv)
            self.assertEqual(done.returncode, 0, f"{label}: {done.stderr}")
            self.assert_holds_none(work)
        self.assert_clean(work)
        self.assertEqual(git(work, "show", "HEAD:.claude/agents/mach-builder.md").stdout, "builder v2\n")
        self.assertEqual(git(work, "show", "HEAD:.claude/skills/mach-new/SKILL.md").stdout, "new skill\n")
        self.assertEqual(git(work, "diff", "--name-only", f"{main_head}..HEAD").stdout.split(), ["src/app.py"],
                         "the ticket's own change names no Claude Code file")

    def test_a_conflict_is_aborted_without_writing_claude_config(self):
        work = Path(self.open()["workdir"])
        self.guard(work)
        put(work, {"README.md": "cell\n"})
        git(work, "commit", "-qam", "cell")
        put(self.project, {"README.md": "main\n", **MACH_UPDATE})
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "main")
        self.assertNotEqual(git(work, "merge", "--no-ff", "--no-commit", "main").returncode, 0)
        self.assertEqual(git(work, "diff", "--name-only", "--diff-filter=U").stdout.split(), ["README.md"])
        self.assertEqual(git(work, "merge", "--abort").returncode, 0)
        self.assert_holds_none(work)
        self.assert_clean(work)

    def test_the_guard_refuses_git_in_a_full_checkout(self):
        """Control: in a cell made the old way (a full checkout), the same refusal stops Git, as the team reported."""
        old = self.project / ".factory/worktrees/OLD-1/repo"
        self.assertEqual(git(self.project, "worktree", "add", "-q", "-b", "feature/OLD-1", str(old)).returncode, 0)
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("as root, a read-only folder refuses nothing")
        folders = [Path(top) for top, _, _ in os.walk(str(old / ".claude"))]
        for folder in folders:
            os.chmod(folder, 0o555)
        self.addCleanup(lambda: [os.chmod(folder, 0o755) for folder in folders])
        put(self.project, MACH_UPDATE)
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "update MACH")
        self.assertNotEqual(git(old, "merge", "--no-edit", "main").returncode, 0, "the guard refuses Git's write under .claude")

    def test_making_the_cell_under_the_guard(self):
        """The guard is in place the moment Git has registered the worktree, before any file is written."""
        real = workspace.git

        def guarded(args, cwd):
            done = real(args, cwd)
            if list(args[:2]) == ["worktree", "add"] and done.returncode == 0:
                self.guard(self.project / ".factory/worktrees/LOCAL-001/repo")
            return done

        with mock.patch.object(workspace, "git", guarded):
            info = self.open()
        self.assert_holds_none(Path(info["workdir"]))
        self.assert_clean(Path(info["workdir"]))

    def test_a_cell_made_before_keeps_its_full_checkout(self):
        old = self.project / ".factory/worktrees/OLD-1/repo"
        git(self.project, "worktree", "add", "-q", "-b", "feature/OLD-1", str(old))
        put(old.parent, {"cell.json": json.dumps({"ticket_id": "OLD-1", "title": "", "mode": "interactive", "stage": "interview",
                                                  "isolation": "worktree", "branch": "feature/OLD-1", "created_at": "2026-11-01T00:00:00+00:00"})})
        self.open()  # a new cell turns on per-worktree configuration for the repository
        self.assertEqual(json.loads(test_cell.run("open", "OLD-1", project=self.project)[1])["workdir"], str(old))
        self.assertFalse(workspace.is_sparse(old))
        self.assertTrue((old / ".claude/agents/mach-builder.md").is_file())
        self.assert_clean(old)
        put(old, {"src/old.py": "X = 1\n"})
        git(old, "add", "-A")
        self.assertEqual(git(old, "commit", "-q", "-m", "old work").returncode, 0)
        put(self.project, MACH_UPDATE)
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "update MACH")
        self.assertEqual(git(old, "merge", "--no-edit", "main").returncode, 0)
        self.assertEqual((old / ".claude/agents/mach-builder.md").read_text(), "builder v2\n")
        self.assert_clean(old)


class NoFallbackTest(test_cell.Base, Sandbox):
    def leftovers(self, ticket="LOCAL-001"):
        return {"folder": (self.project / ".factory/worktrees" / ticket).exists(),
                "branch": bool(git(self.project, "branch", "--list", f"feature/{ticket}").stdout.strip()),
                "worktree": f".factory/worktrees/{ticket}" in git(self.project, "worktree", "list", "--porcelain").stdout}

    def test_git_refusing_stops_the_ticket_and_leaves_nothing(self):
        git(self.project, "branch", "feature/LOCAL-001")
        elsewhere = Path(self.tmp.name) / "elsewhere"
        git(self.project, "worktree", "add", "-q", str(elsewhere), "feature/LOCAL-001")
        code, out, err = test_cell.run("open", "LOCAL-001", project=self.project)
        self.assertEqual((code, out), (2, ""))
        self.assertIn("LOCAL-001 was not opened, and no work happens in the project root instead.", err)
        self.assertIn("git worktree add said: fatal: 'feature/LOCAL-001' is already used by worktree", err)
        self.assertIn("Nothing was left behind.", err)
        self.assertIn("/mach doctor", err)
        self.assertEqual(self.leftovers(), {"folder": False, "branch": True, "worktree": False}, "the branch was there before, so it stays")

    def test_a_failure_after_the_worktree_is_made_undoes_all_of_it(self):
        real = workspace.git

        def failing(args, cwd):
            if args[:1] == ["sparse-checkout"]:
                return subprocess.CompletedProcess(args, 128, "", "fatal: simulated refusal\n")
            return real(args, cwd)

        with mock.patch.object(workspace, "git", failing):
            code, _, err = test_cell.run("open", "LOCAL-001", project=self.project)
        self.assertEqual(code, 2)
        self.assertIn("git sparse-checkout set said: fatal: simulated refusal.", err)
        self.assertEqual(self.leftovers(), {"folder": False, "branch": False, "worktree": False})
        self.assertEqual(git(self.project, "status", "--porcelain").stdout, "")
        self.assertEqual(self.open()["isolation"], "worktree", "once Git can, the ticket opens")

    def test_an_old_git_is_named(self):
        with mock.patch.object(workspace, "git_version", return_value=(2, 30, 1)):
            code, _, err = test_cell.run("open", "LOCAL-001", project=self.project)
        self.assertEqual(code, 2)
        self.assertIn("A ticket's workspace needs Git 2.36 or later; this is Git 2.30.1. Nothing was made.", err)
        self.assertEqual(self.leftovers(), {"folder": False, "branch": False, "worktree": False})

    def test_an_existing_cell_folder_is_kept(self):
        """A cell folder that was already there (its ticket handed over, say) keeps what it had; only what open made goes."""
        root = self.project / ".factory/worktrees/LOCAL-001"
        put(root, {"from-studio.json": "{}\n"})
        with mock.patch.object(workspace, "git_version", return_value=None):
            code, _, err = test_cell.run("open", "LOCAL-001", project=self.project)
        self.assertEqual(code, 2)
        self.assertEqual(sorted(p.name for p in root.iterdir()), ["from-studio.json"])


class CheckPlanTest(test_cell.Base):
    ready = test_cell.CheckPlanTest.ready

    def check(self, plan):
        self.ready(plan=plan)
        return test_cell.run("check-plan", "LOCAL-001", project=self.project)

    def refused(self, plan, name):
        code, out, _ = self.check(plan)
        self.assertEqual(code, 1, out)
        self.assertIn(f"error: plan.md: the plan changes {name}, which is Claude Code configuration that a ticket's workspace never holds, "
                      "so a person makes that change outside the factory", out)
        self.assertEqual(json.loads((self.project / ".factory/worktrees/LOCAL-001/cell.json").read_text())["stage"], "spec-ready")

    def test_a_task_that_changes_a_claude_file_is_refused(self):
        self.refused(test_cell.PLAN.replace("`src/invite.ts` (FR-01, FR-02)", "`src/invite.ts`, `.claude/agents/reviewer.md` (FR-01, FR-02)"),
                     ".claude/agents/reviewer.md")

    def test_a_touch_map_row_for_mcp_json_is_refused(self):
        self.refused(test_cell.PLAN.replace("| `src/invite.ts` | create | T02, T04 |", "| `src/invite.ts` | create | T02, T04 |\n| `.mcp.json` | edit | T04 |"),
                     ".mcp.json")

    def test_prose_that_mentions_the_path_is_not_refused(self):
        plan = test_cell.PLAN.replace("## Engineering decisions\n\n- None.",
                                      "## Engineering decisions\n\n- Nothing here touches `.claude/agents/` or `.mcp.json`; the factory leaves them to people.")
        plan = plan.replace("T02 [impl] Invitation service", "T02 [impl] Invitation service (not `.claude/settings.json`)")
        code, out, _ = self.check(plan)
        self.assertEqual(code, 0, out)


class DoctorTest(test_cell.Base):
    def test_the_doctor_makes_and_removes_a_throwaway_workspace(self):
        (self.project / ".factory/worktrees").mkdir(parents=True)
        put(self.project, {".claude/settings.json": "{}\n"})
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "config")
        branches = git(self.project, "branch").stdout
        [found] = doctor.check_workspace(self.project)
        self.assertEqual(found["status"], "ok", found)
        self.assertIn("makes a ticket's workspace without the .claude folder and .mcp.json", found["detail"])
        self.assertEqual(list((self.project / ".factory/worktrees").iterdir()), [])
        self.assertEqual(len(git(self.project, "worktree", "list").stdout.splitlines()), 1)
        self.assertEqual(git(self.project, "branch").stdout, branches)
        self.assertEqual(git(self.project, "status", "--porcelain").stdout, "")

    def test_the_doctor_reports_an_old_git(self):
        (self.project / ".factory/worktrees").mkdir(parents=True)
        # The doctor loads its own copy of workspace.py, so Git itself answers with an old version.
        fake = Path(self.tmp.name) / "bin"
        fake.mkdir()
        (fake / "git").write_text("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'git version 2.20.1'; exit 0; fi\nexec %s \"$@\"\n" % subprocess.run(
            ["which", "git"], capture_output=True, text=True).stdout.strip())
        os.chmod(fake / "git", 0o755)
        with mock.patch.dict(os.environ, {"PATH": f"{fake}{os.pathsep}{os.environ['PATH']}"}):
            [found] = doctor.check_workspace(self.project)
        self.assertEqual((found["status"], found["fix"]), ("fail", "Install a newer Git, then run this check again."))
        self.assertIn("needs Git 2.36 or later; this is Git 2.20.1", found["detail"])

    def test_without_a_commit_or_the_factory_folder_it_is_not_checked(self):
        self.assertEqual(doctor.check_workspace(self.project)[0]["status"], "not_checked")


class BuildTest(MainBase, Sandbox):
    """The build station's own Git work in a cell: a MACH update merged in at the start, the tasks' commits, the report."""

    def sample_project(self):
        super().sample_project()
        self.put(self.project, CLAUDE_FILES)
        self.commit_main()

    def test_a_mach_update_on_main_is_merged_at_start_without_writing_claude_config(self):
        self.groom()
        self.guard(self.work)
        self.main_commit(MACH_UPDATE, "update MACH")
        self.audit_report()
        started = self.ok("start", TICKET)
        self.assertIn("1 commit(s) behind main", started["synced_with_main"])
        self.assert_holds_none(self.work)
        self.assert_clean(self.work)
        self.assertEqual(git(self.work, "show", "HEAD:.claude/agents/mach-builder.md").stdout, "builder v2\n")
        self.build_through("T05")
        self.ok("finish", TICKET)
        self.assert_holds_none(self.work)
        self.assertFalse([name for name in self.report()["files_changed"] if workspace.protected(name)])

    def test_a_task_that_writes_claude_config_in_the_cell_is_refused(self):
        """Without the sandbox an agent could still write there; the build station refuses it, with no override."""
        self.ready()
        self.ok("start", TICKET)
        before = self.head()
        self.put(self.work, {"tests/test_invite.py": RED_TEST, ".claude/agents/extra.md": "{}\n"})
        refusal = self.refused("red", TICKET, "T01", "--allow-extra", "it is needed")
        self.assertIn("T01 writes Claude Code configuration (.claude/agents/extra.md), which a ticket's workspace never holds.", refusal)
        self.assertEqual(self.head(), before, "nothing was committed")


class MergeTest(MergeBase, Sandbox):
    """Verification, the merge station's re-validation and landing, then cleanup's archive and removal, in a sparse cell."""

    def sample_project(self):
        super().sample_project()
        self.put(self.project, CLAUDE_FILES)
        self.commit_main()

    def test_a_mach_update_after_approval_is_revalidated_landed_and_cleaned_up(self):
        head = self.approved(mode="auto")
        self.assert_holds_none(self.work)
        self.guard(self.work)
        self.put(self.project, MACH_UPDATE)
        self.commit_main()
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertNotEqual(done["revalidated"]["head"], head)
        self.assert_holds_none(self.work)
        self.assert_clean(self.work)
        self.assertEqual((self.project / ".claude/agents/mach-builder.md").read_text(), "builder v2\n", "main keeps the update")
        self.assertTrue((self.project / "app/invite.py").is_file())
        self.assertEqual(git(self.project, "status", "--porcelain").stdout, "")
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cleanup.main(["--project", str(self.project), "run", "LOCAL-001"])
        self.assertEqual(code, 0, err.getvalue() + out.getvalue())
        self.assertFalse(self.cellroot.exists())
        self.assertNotIn("LOCAL-001", git(self.project, "worktree", "list").stdout)


class AbandonTest(CleanupBase, Sandbox):
    WHY = "The feature was cancelled by product."

    def sample_project(self):
        super().sample_project()
        self.put(self.project, CLAUDE_FILES)
        self.commit_main()

    def test_abandon_bundles_the_branch_and_saves_no_claude_config_as_a_change(self):
        self.worked()
        self.guard(self.work)
        self.put(self.work, {"app/invite.py": "def invite(email):\n    return 'half done'\n", "scratch/idea.txt": "untracked idea\n"})
        done = self.c_ok("run", "LOCAL-001", "--abandon", self.WHY)
        self.assertEqual((done["outcome"], done["branch_deleted"]), ("abandoned", True))
        names = self.members()
        self.assertIn("LOCAL-001/branch.bundle", names)
        patch = self.read_member("LOCAL-001/uncommitted.patch")
        self.assertIn("+    return 'half done'", patch)
        self.assertNotIn(".claude", patch)
        self.assertNotIn(".mcp.json", patch)
        self.assertFalse([name for name in names if ".claude" in name or name.endswith(".mcp.json")])
        self.assertFalse(self.cellroot.exists())
        self.assertNotIn(BRANCH, self.branches())


if __name__ == "__main__":
    unittest.main()
