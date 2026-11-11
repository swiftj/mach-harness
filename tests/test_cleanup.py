"""Tests for cleanup.py: the merge and approval gates, archiving, teardown, the run record, and path locking."""

import io
import json
import os
import shutil
import sys
import tarfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "cleanup" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import cleanup  # noqa: E402
from test_build import Base as BuildBase, git  # noqa: E402

BRANCH = "feature/LOCAL-001"
OBSERVE_EVERY = 5

RECORD_KEYS = {
    "ticket_id", "slice_id", "title", "risk", "app_type", "mode", "outcome", "abandon_reason", "rounds", "first_pass", "verify_failures",
    "review_rejections", "escalated", "human_approval", "deviations", "blockers", "verify_findings", "tests_seen_failing_first",
    "tests_passing_on_first_run", "created_at", "closed_at", "archive", "notes",
    # record_version 2: what landed and where, and the product slice a ticket came from
    "record_version", "integration", "product",
}
INTEGRATION_KEYS = {"branch", "into", "method", "approved_commit", "landed_commit", "merge_commit", "pull_request", "merged_at"}


class Base(BuildBase):
    def setUp(self):
        super().setUp()
        self.archive = self.project / ".factory/archive"

    def run_cleanup(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cleanup.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def c_ok(self, *argv):
        code, out, err = self.run_cleanup(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def c_refused(self, *argv):
        code, out, err = self.run_cleanup(*argv)
        self.assertEqual(code, 1, out)
        self.assertIn("refused:", err)
        return err + out

    def set_cell(self, root=None, **changes):
        path = (root or self.cellroot) / "cell.json"
        info = json.loads(path.read_text())
        info.update(changes)
        path.write_text(json.dumps(info))

    def worked(self):
        """A groomed cell with one commit of work on its branch."""
        self.groom()
        self.put(self.work, {"app/invite.py": "def invite(email):\n    return 'sent'\n"})
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "work in the cell")

    def merge(self):
        done = git(self.project, "merge", "--no-ff", "-q", "-m", "Merge LOCAL-001", BRANCH)
        self.assertEqual(done.returncode, 0, done.stderr)

    def merged_and_approved(self):
        self.worked()
        self.merge()
        self.set_cell(stage="approved")

    def branches(self):
        return git(self.project, "branch", "--format=%(refname:short)").stdout.split()

    def worktrees(self):
        return git(self.project, "worktree", "list", "--porcelain").stdout

    def snapshot(self):
        files = sorted((str(p.relative_to(self.project)), p.stat().st_size) for p in self.project.rglob("*") if p.is_file() and ".git" not in p.relative_to(self.project).parts[:1])
        return files, self.branches(), self.worktrees(), git(self.project, "rev-parse", "HEAD").stdout

    def members(self, name="LOCAL-001.tar.gz"):
        with tarfile.open(str(self.archive / name)) as tar:
            return tar.getnames()

    def read_member(self, member, name="LOCAL-001.tar.gz"):
        with tarfile.open(str(self.archive / name)) as tar:
            return tar.extractfile(member).read().decode()

    def records(self):
        return [json.loads(line) for line in (self.archive / "runs.jsonl").read_text().splitlines()]

    def handmade(self, ticket="LOCAL-009", **info):
        root = self.project / ".factory/worktrees" / ticket
        cell = {"ticket_id": ticket, "title": "Handmade", "mode": "headless", "stage": "approved", "isolation": "none", "branch": None,
                "slice_id": None, "risk": "Low", "app_type": "cli", "created_at": "2026-01-01T00:00:00+00:00"}
        cell.update(info)
        self.put(root, {"cell.json": json.dumps(cell), "intent.md": "# Intent: Handmade\n"})
        return root


class PlanTest(Base):
    def test_plan_changes_nothing(self):
        self.merged_and_approved()
        before = self.snapshot()
        plan = self.c_ok("plan", "LOCAL-001")
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.archive.exists())
        self.assertEqual((plan["allowed"], plan["refusals"], plan["outcome"], plan["merged"], plan["default_branch"], plan["stage"]), (True, [], "merged", True, "main", "approved"))
        would = plan["would"]
        self.assertEqual((would["archive"], would["remove_worktree"], would["remove_folder"], would["delete_branch"]),
                         (".factory/archive/LOCAL-001.tar.gz", ".factory/worktrees/LOCAL-001/repo", ".factory/worktrees/LOCAL-001", f"git branch -d {BRANCH}"))
        self.assertIn("LOCAL-001/cell.json", would["archive_members"])
        self.assertFalse([m for m in would["archive_members"] if m.startswith("LOCAL-001/repo")])

    def test_plan_reports_refusals_without_failing(self):
        self.worked()
        plan = self.c_ok("plan", "LOCAL-001")
        self.assertFalse(plan["allowed"])
        self.assertIn("is not merged into main", plan["refusals"][0])
        plan = self.c_ok("plan", "LOCAL-001", "--abandon", "The feature was cancelled by product.")
        self.assertEqual((plan["allowed"], plan["outcome"], plan["would"]["delete_branch"]), (True, "abandoned", f"git branch -D {BRANCH}"))
        self.assertIn("No cell for LOCAL-404", self.c_refused("plan", "LOCAL-404"))


class GateTest(Base):
    def assert_untouched(self):
        self.assertTrue((self.work / "app/invite.py").is_file())
        self.assertTrue((self.cellroot / "cell.json").is_file())
        self.assertIn(BRANCH, self.branches())
        self.assertFalse((self.archive / "runs.jsonl").exists())

    def test_refused_when_the_branch_is_not_merged(self):
        self.worked()
        self.set_cell(stage="approved")
        refusal = self.c_refused("run", "LOCAL-001")
        self.assertIn(f"The branch {BRANCH} is not merged into main", refusal)
        self.assertIn("does not merge", refusal)
        self.assert_untouched()
        self.assertFalse(self.archive.exists(), "a refused run archives nothing")

    def test_refused_when_merged_but_not_approved(self):
        self.worked()
        self.merge()
        self.set_cell(stage="verified")
        refusal = self.c_refused("run", "LOCAL-001")
        self.assertIn("review has not approved this ticket (the cell's stage is 'verified')", refusal)
        self.assertIn("--abandon is not the fix", refusal)
        self.assert_untouched()
        self.set_cell(stage="merged")
        self.assertEqual(self.c_ok("run", "LOCAL-001")["status"], "CLEANED")

    def test_cleanup_says_when_an_observe_pass_is_due_and_records_reviewer_notes(self):
        self.merged_and_approved()
        self.put(self.cellroot, {"review/round-1/votes/product.json": json.dumps({"reviewer": "product", "vote": "APPROVE", "summary": "ok", "findings": [
            {"severity": "note", "title": "Refusal box touches the button", "detail": "No gap between them.", "file": "index.html", "line": 3, "rule": None}]})})
        self.put(self.project, {".factory/archive/runs.jsonl": "".join(json.dumps({"ticket_id": f"T-{n}"}) + "\n" for n in range(1, 5))})
        done = self.c_ok("run", "LOCAL-001")
        self.assertEqual((done["observe_due"], done["finished_since_last_observe_pass"]), (True, OBSERVE_EVERY))
        self.assertIn("run the observe skill with --auto", done["next"])
        self.assertEqual(done["record"]["notes"], [{"round": 1, "reviewer": "product", "title": "Refusal box touches the button", "file": "index.html"}])

    def test_refused_with_uncommitted_changes(self):
        self.merged_and_approved()
        self.put(self.work, {"notes.txt": "half an idea\n"})
        refusal = self.c_refused("run", "LOCAL-001")
        self.assertIn("uncommitted changes (notes.txt)", refusal)
        self.assertTrue((self.work / "notes.txt").is_file())
        self.assert_untouched()

    def test_every_refusal_is_listed(self):
        self.worked()
        self.put(self.work, {"notes.txt": "x\n"})
        refusal = self.c_refused("run", "LOCAL-001")
        self.assertIn("- The branch", refusal)
        self.assertIn("- The cell's worktree has uncommitted changes", refusal)

    def test_failed_archive_deletes_nothing(self):
        self.merged_and_approved()
        self.archive.write_text("a file where the archive folder should be")
        refusal = self.c_refused("run", "LOCAL-001")
        self.assertIn("Archiving failed, so nothing was deleted", refusal)
        self.assertTrue((self.work / "app/invite.py").is_file())
        self.assertIn(BRANCH, self.branches())
        self.assertEqual(list((self.project / ".factory/tmp").iterdir()), [], "no partial archive is left behind")


class RunTest(Base):
    def test_successful_run_after_merge(self):
        self.ready()
        self.ok("start", "LOCAL-001")
        self.build_through("T05")
        self.ok("finish", "LOCAL-001")
        report = json.loads((self.cellroot / "build-report.json").read_text())
        report["review_loop"] = 1
        report["deviations"] = [{"task": "T02", "type": "test-amended", "detail": "The expected word was wrong.", "loop": 0, "at": "x"}]
        report["tests_passing_on_first_run"] = ["T03"]
        blocker = {"severity": "blocker", "title": "Email is not validated", "detail": "d", "file": "app/invite.py", "line": 1, "rule": "SEC-2"}
        note = {"severity": "note", "title": "Naming", "detail": "d", "file": None, "line": None, "rule": None}
        self.put(self.cellroot, {
            "build-report.json": json.dumps(report),
            "evidence/previous-1/summary.json": json.dumps({"status": "FAIL_WITH_EVIDENCE", "failures": ["R4 (matrix rule): accepted, expected refusal."]}),
            "evidence/previous-1/run.log": "old run\n",
            "evidence/summary.json": json.dumps({"status": "PASS", "failures": []}),
            "evidence/consumer-run.log": "AC-01 ok\n",
            "review/round-1/votes/security.json": json.dumps({"reviewer": "security", "vote": "REJECT", "summary": "s", "findings": [blocker, note]}),
            "review/round-1/votes/architecture.json": json.dumps({"reviewer": "architecture", "vote": "APPROVE", "summary": "s", "findings": []}),
            "review/round-1/decision.json": json.dumps({"outcome": "REJECTED", "human_approval": None, "round": 1}),
            "review/round-2/votes/security.json": json.dumps({"reviewer": "security", "vote": "APPROVE", "summary": "s", "findings": [note]}),
            "review/round-2/decision.json": json.dumps({"outcome": "APPROVED", "human_approval": {"by": "sam"}, "round": 2}),
            "review/decision.json": json.dumps({"outcome": "APPROVED", "human_approval": {"by": "sam"}, "round": 2}),
        })
        self.merge()
        self.set_cell(stage="approved")
        main_head = git(self.project, "rev-parse", "main").stdout

        done = self.c_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["outcome"], done["archive"], done["branch_deleted"]), ("CLEANED", "merged", ".factory/archive/LOCAL-001.tar.gz", True))
        self.assertEqual(done["removed"], [".factory/worktrees/LOCAL-001/repo", ".factory/worktrees/LOCAL-001"])
        self.assertIn("closed", done["next"])

        names = self.members()
        for member in ("cell.json", "intent.md", "spec.md", "spec.json", "plan.md", "build.json", "build-report.json", "review/round-1/votes/security.json",
                       "review/round-2/decision.json", "evidence/summary.json", "evidence/previous-1/run.log", "evidence/consumer-run.log"):
            self.assertIn(f"LOCAL-001/{member}", names)
        self.assertFalse([n for n in names if n.startswith("LOCAL-001/repo")], "the worktree is not archived")
        self.assertFalse([n for n in names if n.endswith("invite.py")])

        self.assertFalse(self.cellroot.exists())
        self.assertNotIn("LOCAL-001", self.worktrees())
        self.assertNotIn(BRANCH, self.branches())
        self.assertEqual(git(self.project, "rev-parse", "main").stdout, main_head, "main is not moved")
        self.assertEqual(git(self.project, "status", "--porcelain").stdout, "", "the main checkout is not changed")
        self.assertTrue((self.project / "app/invite.py").is_file(), "the merged code stays")

        records = self.records()
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record, done["record"])
        self.assertEqual(set(record), RECORD_KEYS)
        landed = record["integration"]
        self.assertEqual((record["record_version"], record["product"], set(landed)), (2, None, INTEGRATION_KEYS))
        self.assertEqual((landed["branch"], landed["into"], landed["method"]), (BRANCH, "main", "manual"))
        self.assertRegex(landed["landed_commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(git(self.project, "merge-base", "--is-ancestor", landed["landed_commit"], "main").returncode, 0, "the commit it names is on main")
        self.assertEqual({key: record[key] for key in ("ticket_id", "slice_id", "title", "risk", "app_type", "mode", "outcome", "abandon_reason", "archive")},
                         {"ticket_id": "LOCAL-001", "slice_id": "SLICE-001", "title": "Invite a teammate by email", "risk": "Medium", "app_type": "library",
                          "mode": "interactive", "outcome": "merged", "abandon_reason": None, "archive": ".factory/archive/LOCAL-001.tar.gz"})
        self.assertEqual((record["rounds"], record["first_pass"], record["verify_failures"], record["review_rejections"], record["escalated"], record["human_approval"]),
                         (2, False, 1, 1, False, True))
        self.assertEqual(record["deviations"], [{"type": "test-amended", "task": "T02", "detail": "The expected word was wrong."}])
        self.assertEqual(record["blockers"], [{"round": 1, "reviewer": "security", "rule": "SEC-2", "title": "Email is not validated", "file": "app/invite.py"}])
        self.assertEqual(record["verify_findings"], ["R4 (matrix rule): accepted, expected refusal."])
        self.assertEqual((record["tests_seen_failing_first"], record["tests_passing_on_first_run"]), (2, 1))
        self.assertTrue(record["created_at"] and record["closed_at"])

        self.assertIn("No cell for LOCAL-001", self.c_refused("run", "LOCAL-001"))

    def test_escalation_is_recorded_and_missing_artifacts_count_as_zero(self):
        self.merged_and_approved()
        self.put(self.cellroot, {"review/round-1/decision.json": json.dumps({"outcome": "ESCALATE", "human_approval": None, "round": 1}),
                                 "evidence/summary.json": "not json"})
        record = self.c_ok("run", "LOCAL-001")["record"]
        self.assertEqual((record["rounds"], record["first_pass"], record["verify_failures"], record["review_rejections"], record["escalated"], record["human_approval"]),
                         (0, False, 0, 1, True, False))
        self.assertEqual((record["deviations"], record["blockers"], record["verify_findings"], record["tests_seen_failing_first"], record["tests_passing_on_first_run"]),
                         ([], [], [], 0, 0))

    def test_existing_archive_is_not_overwritten(self):
        self.merged_and_approved()
        self.put(self.archive, {"LOCAL-001.tar.gz": "an earlier archive", "LOCAL-001-2.tar.gz": "another"})
        done = self.c_ok("run", "LOCAL-001")
        self.assertEqual(done["archive"], ".factory/archive/LOCAL-001-3.tar.gz")
        self.assertEqual((self.archive / "LOCAL-001.tar.gz").read_text(), "an earlier archive")
        self.assertEqual((self.archive / "LOCAL-001-2.tar.gz").read_text(), "another")
        self.assertIn("LOCAL-001/cell.json", self.members("LOCAL-001-3.tar.gz"))
        self.assertEqual(self.records()[0]["archive"], ".factory/archive/LOCAL-001-3.tar.gz")

    def test_run_record_is_appended(self):
        self.put(self.archive, {"runs.jsonl": json.dumps({"ticket_id": "OLD-1"}) + "\n"})
        self.merged_and_approved()
        self.c_ok("run", "LOCAL-001")
        self.assertEqual([r["ticket_id"] for r in self.records()], ["OLD-1", "LOCAL-001"])

    def test_cell_without_a_worktree(self):
        root = self.handmade()
        self.put(root, {"build-report.json": json.dumps({"review_loop": 0, "tests_seen_failing_first": 3, "tests_passing_on_first_run": []})})
        self.set_cell(root, stage="built")
        self.assertIn("Review has not approved this ticket", self.c_refused("run", "LOCAL-009"))
        self.set_cell(root, stage="approved")
        before = git(self.project, "status", "--porcelain").stdout, self.branches(), sorted(p.name for p in self.project.iterdir())
        plan = self.c_ok("plan", "LOCAL-009")
        self.assertEqual((plan["allowed"], plan["merged"], plan["would"]["remove_worktree"], plan["would"]["delete_branch"]), (True, None, None, None))
        done = self.c_ok("run", "LOCAL-009")
        self.assertEqual((done["removed"], done["branch_deleted"]), ([".factory/worktrees/LOCAL-009"], False))
        self.assertFalse(root.exists())
        self.assertEqual((git(self.project, "status", "--porcelain").stdout, self.branches(), sorted(p.name for p in self.project.iterdir())), before)
        self.assertEqual(sorted(self.members("LOCAL-009.tar.gz")), ["LOCAL-009/build-report.json", "LOCAL-009/cell.json", "LOCAL-009/intent.md"])
        record = self.records()[0]
        self.assertEqual(set(record), RECORD_KEYS)
        self.assertEqual((record["rounds"], record["first_pass"], record["slice_id"], record["risk"], record["mode"], record["tests_seen_failing_first"]), (1, True, None, "Low", "headless", 3))

    def test_cell_whose_worktree_folder_is_already_gone(self):
        self.merged_and_approved()
        shutil.rmtree(self.work)
        done = self.c_ok("run", "LOCAL-001")
        self.assertEqual((done["removed"], done["branch_deleted"]), ([".factory/worktrees/LOCAL-001"], True))
        self.assertNotIn("LOCAL-001", self.worktrees())

    def test_default_branch_comes_from_origin_head(self):
        self.merged_and_approved()
        git(self.project, "checkout", "-q", "-b", "scratch", "main~1")
        self.assertFalse(self.c_ok("plan", "LOCAL-001")["merged"], "without origin/HEAD the checked-out branch is the default")
        git(self.project, "update-ref", "refs/remotes/origin/main", "main")
        git(self.project, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
        plan = self.c_ok("plan", "LOCAL-001")
        self.assertEqual((plan["default_branch"], plan["merged"], plan["allowed"]), ("main", True, True))
        done = self.c_ok("run", "LOCAL-001")
        self.assertFalse(self.cellroot.exists())
        self.assertFalse(done["branch_deleted"], "git branch -d refuses because the checked-out branch lacks the merge; -D is never used")
        self.assertIn(f"git kept the branch {BRANCH}", done["branch_note"])
        self.assertIn(BRANCH, self.branches())


class AbandonTest(Base):
    WHY = "Product cancelled the feature on 2026-11-01."

    def test_abandon_needs_a_reason(self):
        self.worked()
        self.assertIn("at least 10 characters", self.c_refused("run", "LOCAL-001", "--abandon", "  no   "))
        self.assertIn("at least 10 characters", self.c_refused("run", "LOCAL-001", "--abandon", ""))
        self.assertTrue(self.work.is_dir())
        self.assertIn(BRANCH, self.branches())

    def test_abandon_saves_uncommitted_work_and_force_deletes_the_branch(self):
        self.worked()
        self.put(self.work, {"app/invite.py": "def invite(email):\n    return 'half done'\n", "scratch/idea.txt": "untracked idea\n"})
        tip = git(self.project, "rev-parse", BRANCH).stdout.strip()
        done = self.c_ok("run", "LOCAL-001", "--abandon", self.WHY)
        self.assertEqual((done["outcome"], done["branch_deleted"]), ("abandoned", True))
        names = self.members()
        self.assertIn("LOCAL-001/uncommitted.patch", names)
        self.assertIn("+    return 'half done'", self.read_member("LOCAL-001/uncommitted.patch"))
        self.assertEqual(self.read_member("LOCAL-001/untracked/scratch/idea.txt"), "untracked idea\n")
        self.assertFalse([n for n in names if n.startswith("LOCAL-001/repo")])
        self.assertFalse(self.cellroot.exists())
        self.assertNotIn(BRANCH, self.branches(), "an unmerged branch needs -D")
        self.assertNotEqual(git(self.project, "merge-base", "--is-ancestor", tip, "main").returncode, 0, "nothing was merged")
        self.assertFalse((self.project / "app/invite.py").exists(), "the main checkout is not touched")
        record = self.records()[0]
        self.assertEqual((record["outcome"], record["abandon_reason"], record["first_pass"]), ("abandoned", self.WHY, False))
        self.assertEqual(set(record), RECORD_KEYS)
        self.assertIsNone(record["integration"], "nothing landed, so nothing is claimed")

    def test_blocked_cell_is_abandoned_as_escalated(self):
        self.worked()
        self.set_cell(stage="blocked")
        self.assertIn("is not merged", self.c_refused("run", "LOCAL-001"))
        self.assertTrue(self.c_ok("run", "LOCAL-001", "--abandon", self.WHY)["record"]["escalated"])


    def test_abandon_bundles_unmerged_commits_and_they_can_be_restored(self):
        self.worked()
        tip = git(self.project, "rev-parse", BRANCH).stdout.strip()
        plan = self.c_ok("plan", "LOCAL-001", "--abandon", self.WHY)
        self.assertEqual((plan["would"]["bundle_branch"], plan["unmerged_commits"]), (True, 2))
        done = self.c_ok("run", "LOCAL-001", "--abandon", self.WHY)
        self.assertEqual((done["bundle"], done["branch_deleted"]), ("LOCAL-001/branch.bundle", True))
        self.assertIn(f"git fetch LOCAL-001/branch.bundle {BRANCH}:{BRANCH}", done["restore"])
        self.assertIn("LOCAL-001/branch.bundle", self.members())
        self.assertEqual(list((self.project / ".factory/tmp").iterdir()), [])
        out = Path(self.tmp.name).resolve() / "out"
        with tarfile.open(str(self.archive / "LOCAL-001.tar.gz")) as tar:
            data = tar.extractfile("LOCAL-001/branch.bundle").read()
        out.mkdir()
        (out / "branch.bundle").write_bytes(data)
        self.assertEqual(git(self.project, "bundle", "verify", str(out / "branch.bundle")).returncode, 0)
        clone = Path(self.tmp.name).resolve() / "clone"
        self.assertEqual(git(self.project.parent, "clone", "-q", "--no-local", str(self.project), str(clone)).returncode, 0)
        self.assertNotEqual(git(clone, "cat-file", "-e", tip).returncode, 0, "the fresh clone does not have the abandoned commits")
        fetched = git(clone, "fetch", "-q", str(out / "branch.bundle"), f"{BRANCH}:{BRANCH}")
        self.assertEqual(fetched.returncode, 0, fetched.stderr)
        self.assertEqual(git(clone, "rev-parse", BRANCH).stdout.strip(), tip)
        self.assertIn("return 'sent'", git(clone, "show", f"{BRANCH}:app/invite.py").stdout)

    def test_failed_bundle_deletes_nothing(self):
        self.worked()
        real = cleanup.bundle_branch

        def broken(cell, refs, path):
            raise cleanup.CleanupError("git could not bundle the branch.")
        cleanup.bundle_branch = broken
        self.addCleanup(setattr, cleanup, "bundle_branch", real)
        refusal = self.c_refused("run", "LOCAL-001", "--abandon", self.WHY)
        self.assertIn("Archiving failed, so nothing was deleted", refusal)
        self.assertTrue((self.work / "app/invite.py").is_file())
        self.assertIn(BRANCH, self.branches())
        self.assertFalse((self.archive / "LOCAL-001.tar.gz").exists())
        self.assertFalse((self.archive / "runs.jsonl").exists())

    def test_abandoning_a_merged_branch_needs_no_bundle(self):
        self.worked()
        self.merge()
        done = self.c_ok("run", "LOCAL-001", "--abandon", self.WHY)
        self.assertEqual((done["bundle"], done["restore"]), (None, None))
        self.assertNotIn("LOCAL-001/branch.bundle", self.members())


class MergedAsTest(Base):
    def squashed(self):
        self.worked()
        self.base = git(self.project, "rev-parse", "main").stdout.strip()
        self.tip = git(self.project, "rev-parse", BRANCH).stdout.strip()
        self.assertEqual(git(self.project, "merge", "--squash", "-q", BRANCH).returncode, 0)
        self.assertEqual(git(self.project, "commit", "-q", "-m", "Invite a teammate (squashed)").returncode, 0)
        self.landed = git(self.project, "rev-parse", "main").stdout.strip()
        self.set_cell(stage="approved")

    def test_squash_merge_is_cleaned_with_merged_as(self):
        self.squashed()
        refusal = self.c_refused("run", "LOCAL-001")
        self.assertIn("is not merged into main", refusal)
        self.assertIn("--merged-as <the commit it landed as>", refusal)
        plan = self.c_ok("plan", "LOCAL-001", "--merged-as", "main")
        self.assertEqual((plan["allowed"], plan["outcome"], plan["merged"], plan["merged_as"], plan["would"]["delete_branch"], plan["would"]["bundle_branch"]),
                         (True, "merged", False, self.landed, f"git branch -D {BRANCH}", False))
        self.assertIn(f"--merged-as {self.landed}", plan["next"])
        done = self.c_ok("run", "LOCAL-001", "--merged-as", self.landed[:10])
        self.assertEqual((done["outcome"], done["merged_as"], done["branch_deleted"]), ("merged", self.landed, True))
        self.assertFalse(self.cellroot.exists())
        self.assertNotIn(BRANCH, self.branches())
        self.assertEqual(git(self.project, "rev-parse", "main").stdout.strip(), self.landed)
        record = self.records()[0]
        self.assertEqual(set(record), RECORD_KEYS, "the run record grows only by a versioned change")
        self.assertEqual((record["integration"]["method"], record["integration"]["landed_commit"], record["integration"]["into"]),
                         ("squash-or-rebase", self.landed, "main"))
        self.assertEqual((record["outcome"], record["abandon_reason"]), ("merged", None))
        self.assertEqual(json.loads(self.read_member("LOCAL-001/cell.json"))["merged_as"], self.landed)

    def test_merged_as_claims_are_checked(self):
        self.squashed()
        git(self.project, "branch", "side", self.base)
        self.assertIn("is not a commit in this repository", self.c_refused("run", "LOCAL-001", "--merged-as", "0123456789abcdef0123456789abcdef01234567"))
        self.assertIn("is not a commit in this repository", self.c_refused("run", "LOCAL-001", "--merged-as=--all"))
        self.assertIn("is not on the default branch", self.c_refused("run", "LOCAL-001", "--merged-as", self.tip))
        self.assertIn("is not newer than the point where", self.c_refused("run", "LOCAL-001", "--merged-as", self.base))
        self.assertIn("contradict each other", self.c_refused("run", "LOCAL-001", "--merged-as", self.landed, "--abandon", "Changed our minds about it."))
        self.set_cell(stage="verified")
        refusal = self.c_refused("run", "LOCAL-001", "--merged-as", self.landed)
        self.assertIn("review has not approved this ticket", refusal)
        self.assertNotIn("--merged-as <", self.c_refused("run", "LOCAL-001"), "the hint is only for an approved ticket")
        self.assertTrue(self.work.is_dir())
        self.assertIn(BRANCH, self.branches())
        self.assertFalse(self.archive.exists())

    def test_merged_as_on_a_cell_without_a_branch_is_refused(self):
        self.commit_main()
        self.handmade()
        self.assertIn("applies only to a cell with its own branch", self.c_refused("run", "LOCAL-009", "--merged-as", "main"))


class ByproductTest(Base):
    LEFTOVERS = {"src/__pycache__/x.pyc": "x", "mod.pyc": "x", ".pytest_cache/v/cache/lastfailed": "{}", ".pytest_cache/README.md": "x", ".coverage": "x",
                 "node_modules/pkg/index.js": "x"}

    def test_test_run_byproducts_do_not_block_a_normal_run(self):
        self.merged_and_approved()
        self.put(self.work, self.LEFTOVERS)
        self.assertIn(".pytest_cache/README.md", git(self.work, "status", "--porcelain", "--untracked-files=all").stdout, "the project does not ignore them")
        plan = self.c_ok("plan", "LOCAL-001")
        self.assertEqual((plan["allowed"], plan["uncommitted"]), (True, []))
        self.assertEqual(self.c_ok("run", "LOCAL-001")["status"], "CLEANED")
        self.assertFalse(self.cellroot.exists())

    def test_byproducts_are_not_saved_as_untracked_work(self):
        self.worked()
        self.put(self.work, dict(self.LEFTOVERS, **{"scratch/idea.txt": "keep me\n"}))
        self.assertEqual(self.c_ok("plan", "LOCAL-001", "--abandon", "Product cancelled the feature.")["uncommitted"], ["scratch/idea.txt"])
        self.c_ok("run", "LOCAL-001", "--abandon", "Product cancelled the feature.")
        self.assertEqual([n for n in self.members() if n.startswith("LOCAL-001/untracked/")], ["LOCAL-001/untracked/scratch/idea.txt"])


class PathLockTest(Base):
    def test_bad_ticket_ids_are_refused(self):
        self.handmade()
        for ticket in ("../LOCAL-009", "LOCAL-009/../LOCAL-009", ".", "..", "LOCAL-009/", "/tmp/x", "-rf"):
            code, _, err = self.run_cleanup("run", "--", ticket)
            self.assertEqual((code, "is not a usable ticket ID" in err), (1, True), ticket)
        self.assertTrue((self.project / ".factory/worktrees/LOCAL-009/cell.json").is_file())

    def test_symlinked_cell_folder_is_refused(self):
        outside = Path(self.tmp.name).resolve() / "precious"
        self.put(outside, {"cell.json": json.dumps({"ticket_id": "LOCAL-777", "stage": "approved", "isolation": "none"}), "thesis.txt": "irreplaceable\n"})
        base = self.project / ".factory/worktrees"
        base.mkdir(parents=True)
        os.symlink(str(outside), str(base / "LOCAL-777"))
        for command in ("plan", "run"):
            self.assertIn("is a symbolic link", self.c_refused(command, "LOCAL-777"))
        self.assertIn("is a symbolic link", self.c_refused("run", "LOCAL-777", "--abandon", "Trying to get around the gate."))
        self.assertEqual((outside / "thesis.txt").read_text(), "irreplaceable\n")
        self.assertFalse(self.archive.exists())
        self.assertIn("symbolic link", self.c_ok("orphans")["orphans"][0]["reasons"][0])

    def test_symlinked_worktrees_folder_or_repo_is_refused(self):
        self.merged_and_approved()
        other = self.handmade("LOCAL-010", isolation="worktree", branch="feature/LOCAL-010")
        os.symlink(str(self.work), str(other / "repo"))
        self.assertIn("repo is a symbolic link", self.c_refused("run", "LOCAL-010", "--abandon", "Trying to remove another cell."))
        self.assertTrue((self.work / "app/invite.py").is_file())
        factory = self.project / ".factory"
        moved = Path(self.tmp.name).resolve() / "elsewhere"
        self.put(moved, {"worktrees/LOCAL-020/cell.json": json.dumps({"ticket_id": "LOCAL-020", "stage": "approved", "isolation": "none"})})
        shutil.move(str(factory / "worktrees"), str(factory / "worktrees.real"))
        os.symlink(str(moved / "worktrees"), str(factory / "worktrees"))
        self.assertIn("does not resolve to a folder inside", self.c_refused("run", "LOCAL-020"))
        self.assertTrue((moved / "worktrees/LOCAL-020/cell.json").is_file())

    def test_only_the_cells_own_feature_branch_is_ever_deleted(self):
        self.worked()
        self.set_cell(branch="main")
        refusal = self.c_refused("run", "LOCAL-001", "--abandon", "Trying to delete the main branch.")
        self.assertIn("names the branch 'main', not 'feature/LOCAL-001'", refusal)
        self.assertIn("main", self.branches())
        self.assertTrue(self.work.is_dir())

    def test_folder_without_cell_json_is_not_removed(self):
        self.put(self.project, {".factory/worktrees/STRAY-1/notes.md": "someone's notes\n"})
        self.assertIn("no readable cell.json", self.c_refused("run", "STRAY-1", "--abandon", "It looks like a leftover."))
        self.assertTrue((self.project / ".factory/worktrees/STRAY-1/notes.md").is_file())


class ListingTest(Base):
    def test_orphans_lists_and_prune_only_drops_git_records(self):
        self.worked()
        self.put(self.project, {".factory/worktrees/STRAY-1/notes.md": "x\n"})
        found = self.c_ok("orphans")
        self.assertEqual(([o["ticket_id"] for o in found["orphans"]], found["prunable_worktrees"], found["pruned"]), (["STRAY-1"], [], False))
        self.assertIn("No readable cell.json", found["orphans"][0]["reasons"][0])

        self.merge()
        early = {o["ticket_id"]: o for o in self.c_ok("orphans")["orphans"]}["LOCAL-001"]
        self.assertIn("merged before approval", early["reasons"][0])
        self.assertNotIn("suggest", early)
        self.set_cell(stage="approved")
        ready = {o["ticket_id"]: o for o in self.c_ok("orphans")["orphans"]}["LOCAL-001"]
        self.assertEqual((ready["reasons"], ready["suggest"]), ([f"The branch {BRANCH} is merged into main."], "cleanup.py plan LOCAL-001"))

        shutil.rmtree(self.work)
        before = self.snapshot()
        found = self.c_ok("orphans")
        broken = {o["ticket_id"]: o for o in found["orphans"]}["LOCAL-001"]
        self.assertIn("repo/ is missing", broken["reasons"][0])
        self.assertEqual(len(found["prunable_worktrees"]), 1)
        self.assertTrue(found["prunable_worktrees"][0]["path"].endswith(".factory/worktrees/LOCAL-001/repo"))
        self.assertEqual(self.snapshot(), before, "orphans changes nothing")

        pruned = self.c_ok("orphans", "--prune")
        self.assertEqual((pruned["pruned"], pruned["prunable_worktrees_left"]), (True, []))
        self.assertNotIn("LOCAL-001", self.worktrees())
        self.assertTrue((self.cellroot / "cell.json").is_file(), "prune removes no files")
        self.assertTrue((self.project / ".factory/worktrees/STRAY-1/notes.md").is_file())
        self.assertIn(BRANCH, self.branches())

    def test_status_lists_every_cell(self):
        self.assertEqual(self.c_ok("status"), {"default_branch": "main", "cells": []})
        self.worked()
        self.handmade()
        self.put(self.project, {".factory/worktrees/STRAY-1/notes.md": "x\n"})
        cells = {c["ticket_id"]: c for c in self.c_ok("status")["cells"]}
        self.assertEqual(sorted(cells), ["LOCAL-001", "LOCAL-009", "STRAY-1"])
        self.assertEqual((cells["LOCAL-001"]["stage"], cells["LOCAL-001"]["branch"], cells["LOCAL-001"]["merged"], cells["LOCAL-001"]["isolation"]), ("planned", BRANCH, False, "worktree"))
        self.assertEqual((cells["LOCAL-009"]["stage"], cells["LOCAL-009"]["merged"]), ("approved", None))
        self.assertEqual(cells["STRAY-1"]["problem"], "no readable cell.json")
        self.merge()
        self.assertTrue({c["ticket_id"]: c for c in self.c_ok("status")["cells"]}["LOCAL-001"]["merged"])


if __name__ == "__main__":
    unittest.main()
