"""What cleanup keeps (cleanup.archive): the setting and the per-run flag, "raised to a person" decided by rule, the work an archive
no longer holds kept in Git with commands that bring it back, forget, the publish command, and archives from before."""

import json
import shlex
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import test_cleanup  # noqa: E402
from test_build import git  # noqa: E402
from test_cleanup import BRANCH, RECORD_KEYS  # noqa: E402

WHY = "Product cancelled the feature on 2026-11-01."


def run(command):
    """A printed command, run as printed (no shell)."""
    return subprocess.run(shlex.split(command), capture_output=True, text=True)


class Base(test_cleanup.Base):
    keep_archive = False

    def configure(self, **cleanup):
        path = self.project / ".factory/config.json"
        config = json.loads(path.read_text()) if path.is_file() else {}
        config["cleanup"] = cleanup
        self.put(self.project, {".factory/config.json": json.dumps(config)})

    def merged_by_the_line(self):
        """A ticket the merge station landed with no person's part: nothing raises it to a person."""
        self.worked()
        self.merge()
        tip = git(self.project, "rev-parse", BRANCH).stdout.strip()
        self.set_cell(stage="merged", merged={"commit": git(self.project, "rev-parse", "main").stdout.strip(), "at": "2026-11-20T10:00:00+00:00",
                                              "method": "local", "landed_commit": tip})

    def tarballs(self):
        return sorted(p.name for p in self.archive.glob("*.tar.gz")) if self.archive.is_dir() else []

    def refs(self):
        return git(self.project, "for-each-ref", "--format=%(refname)", "refs/mach/").stdout.split()

    def assert_no_archive(self, done):
        self.assertIsNone(done["archive"])
        self.assertEqual(self.tarballs(), [])
        self.assertIsNone(done["record"]["archive"])
        self.assertFalse(done["record"]["archive_kept"]["kept"])
        self.assertEqual(self.records()[-1]["archive"], None, "runs.jsonl is kept and appended to whatever the setting")


class SettingTest(Base):
    def test_the_default_keeps_no_archive_for_a_ticket_no_person_decided_on(self):
        self.merged_by_the_line()
        plan = self.c_ok("plan", "LOCAL-001")
        self.assertEqual((plan["raised_to_person"], plan["archive_decision"]["kept"], plan["archive_decision"]["setting"], plan["would"]["archive"]),
                         ({}, False, "none", None))
        done = self.c_ok("run", "LOCAL-001")
        self.assert_no_archive(done)
        self.assertEqual(done["record"]["raised_to_person"], [])
        self.assertEqual(done["record"]["archive_kept"], {"kept": False, "setting": "none", "chosen_by": "setting", "published": None,
                                                          "reason": "The evidence files were not kept after cleanup: the project keeps no archives (cleanup.archive is \"none\")."})
        self.assertEqual(set(done["record"]), RECORD_KEYS)
        self.assertTrue(done["branch_deleted"], "a merged branch is deleted as before: its work is on main")
        self.assertFalse(self.cellroot.exists())
        self.assertEqual(done["kept_in_git"], [])

    def test_all_keeps_every_archive_as_before(self):
        self.merged_by_the_line()
        self.configure(archive="all")
        done = self.c_ok("run", "LOCAL-001")
        self.assertEqual((done["archive"], self.tarballs(), done["record"]["archive_kept"]["kept"]), (".factory/archive/LOCAL-001.tar.gz", ["LOCAL-001.tar.gz"], True))
        self.assertIn("LOCAL-001/cell.json", self.members())

    def test_none_keeps_nothing_even_for_a_ticket_a_person_decided_on(self):
        self.merged_and_approved()  # merged by hand: a person took the merge
        self.configure(archive="none")
        done = self.c_ok("run", "LOCAL-001")
        self.assert_no_archive(done)
        self.assertEqual(done["record"]["raised_to_person"], ["merged-by-person"])

    def test_an_unusable_value_reads_as_the_default(self):
        self.merged_by_the_line()
        for value in ("sometimes", 3, None, ["all"]):
            self.configure(archive=value)
            plan = self.c_ok("plan", "LOCAL-001")
            self.assertEqual((plan["archive_decision"]["setting"], plan["archive_decision"]["kept"]), ("none", False), value)
            self.assertEqual("setting_note" in plan["archive_decision"], value is not None)
        self.configure(archive="ALL")
        self.assertIn("reads as the default", self.c_ok("run", "LOCAL-001")["setting_note"])

    def test_an_abandoned_ticket_s_work_is_deleted_whatever_the_setting_unless_a_person_keeps_it(self):
        for value, flag, kept in (("all", None, False), ("raised", None, False), ("none", None, False), ("none", "--keep-archive", True)):
            with self.subTest(value=value, flag=flag):
                self.setUp()
                self.worked()
                self.configure(archive=value)
                done = self.c_ok("run", "LOCAL-001", "--abandon", WHY, *([flag] if flag else []))
                self.assertEqual(done["record"]["archive_kept"]["kept"], kept)
                self.assertEqual(done["record"]["raised_to_person"], ["abandoned-by-person"])
                self.assertEqual(bool(self.tarballs()), kept)
                self.assertNotIn(BRANCH, self.branches(), "the branch is deleted either way: with --keep-archive its commits are in the archive")
                self.tearDown()

    def test_the_flag_says_otherwise_for_one_cleanup(self):
        self.merged_by_the_line()
        self.configure(archive="none")
        plan = self.c_ok("plan", "LOCAL-001", "--keep-archive")
        self.assertIn("--keep-archive", plan["next"])
        done = self.c_ok("run", "LOCAL-001", "--keep-archive")
        self.assertEqual((done["record"]["archive_kept"]["kept"], done["record"]["archive_kept"]["chosen_by"]), (True, "flag"))
        self.assertEqual(self.tarballs(), ["LOCAL-001.tar.gz"])

    def test_no_archive_flag_wins_over_all_and_a_person_s_part(self):
        self.merged_and_approved()
        self.configure(archive="all")
        done = self.c_ok("run", "LOCAL-001", "--no-archive")
        self.assert_no_archive(done)
        self.assertEqual(done["record"]["archive_kept"]["chosen_by"], "flag")
        self.assertIn("--no-archive", done["record"]["archive_kept"]["reason"])

    def test_both_flags_are_refused(self):
        self.merged_by_the_line()
        with self.assertRaises(SystemExit) as stopped:
            self.run_cleanup("run", "LOCAL-001", "--keep-archive", "--no-archive")
        self.assertEqual(stopped.exception.code, 2)
        self.assertTrue(self.cellroot.exists())


class RaisedTest(Base):
    """Each signal keeps the archive under the default; the plain merged ticket above keeps none."""

    def signal(self, code, setup):
        self.setUp()
        try:
            self.merged_by_the_line()
            self.configure(archive="raised")
            setup()
            done = self.c_ok("run", "LOCAL-001")
            self.assertIn(code, done["record"]["raised_to_person"], code)
            self.assertTrue(done["record"]["archive_kept"]["kept"], code)
            self.assertIn(code, done["record"]["archive_kept"]["reason"])
            self.assertEqual(self.tarballs(), ["LOCAL-001.tar.gz"], code)
        finally:
            self.tearDown()

    def decision(self, **fields):
        return lambda: self.put(self.cellroot, {"review/round-1/decision.json": json.dumps({"round": 1, "outcome": "APPROVED", "human_approval": None, **fields})})

    def test_each_signal(self):
        ticket = "---\nid: LOCAL-001\ntitle: Invite\nstate: open\nlabels: [mach, blocked-requires-sme]\n---\nbody\n"
        cases = {
            "human-approval": self.decision(human_approval={"by": "sam", "recorded_at": "2026-11-19T11:00:00+00:00"}),
            "human-approval-required": lambda: self.put(self.cellroot, {"review/round-1/packet.json": json.dumps({"human_approval_required": True})}),
            "sent-back-by-person": self.decision(outcome="REJECTED", rejected_by="a person"),
            "security-exception": self.decision(exceptions=[{"round": "1", "seat": "security", "index": 1, "title": "x"}]),
            "adr-exception": lambda: self.set_cell(adr_exceptions=[{"adr": "ADR-0001", "by": "Lead", "reason": "for now"}]),
            "escalated": self.decision(outcome="ESCALATE"),
            "blocked": lambda: self.put(self.project, {".factory/tickets/LOCAL-001.md": ticket}),
            "needs-person": lambda: self.put(self.project, {".factory/intake/events.jsonl": json.dumps({"type": "human.required", "ticket_id": "LOCAL-001"}) + "\n"}),
            "merged-by-person": lambda: self.set_cell(merged=dict(json.loads((self.cellroot / "cell.json").read_text())["merged"], by_person=True)),
            "taken-over-by-person": lambda: self.put(self.cellroot, {"takeovers.jsonl": json.dumps({"step": "build", "at": "2026-11-20T10:00:00+00:00"}) + "\n"}),
            "replanned-by-person": lambda: self.put(self.cellroot, {"plan-history/1/replan.json": json.dumps({"replan": 1, "by": "a person", "reason": "wrong plan"})}),
        }
        for code, setup in cases.items():
            with self.subTest(code=code):
                self.signal(code, setup)

    def test_other_records_of_a_person_s_part(self):
        lane = {"earlier_holders": [{"holder": "a" * 32, "until": "2026-11-20T10:00:00+00:00"}]}
        ledger = {"slices": {"SLICE-001": {"ticket_id": "LOCAL-001", "claim": {"notes": ["Taken over from @sam, whose claim dated from 2026-11-19."]}}}}
        merge_log = {"type": "gate.evaluated", "station": "merge", "data": {"gate": "merge.run", "outcome": "pass", "by_person": True}}
        cases = [("taken-over-by-person", lambda: self.put(self.cellroot, {"lanes/L1/lane.json": json.dumps(lane)})),
                 ("taken-over-by-person", lambda: self.put(self.project, {".factory/intake/ledger.json": json.dumps(ledger)})),
                 ("merged-by-person", lambda: self.put(self.cellroot, {"lifecycle.jsonl": json.dumps(merge_log) + "\n"})),
                 ("replanned-by-person", lambda: self.set_cell(adr_replans=[{"adr": "ADR-0002", "reason": "superseded"}]))]
        for code, setup in cases:
            with self.subTest(code=code):
                self.signal(code, setup)

    def test_what_is_not_a_person_s_part_keeps_nothing(self):
        self.merged_by_the_line()
        carried = {"earlier_holders": [{"holder": "a" * 32, "until": "x", "why": "carried on from a run known to have ended"}]}
        self.put(self.cellroot, {"lanes/L1/lane.json": json.dumps(carried),
                                 "review/round-1/decision.json": json.dumps({"round": 1, "outcome": "APPROVED", "human_approval": None, "human_approval_required": False}),
                                 "plan-history/1/replan.json": json.dumps({"replan": 1, "reason": "The spec was corrected."})})
        self.put(self.project, {".factory/intake/events.jsonl": json.dumps({"type": "human.required", "ticket_id": "LOCAL-0011"}) + "\n"})
        self.configure(archive="raised")
        done = self.c_ok("run", "LOCAL-001")
        self.assertEqual(done["record"]["raised_to_person"], [])
        self.assert_no_archive(done)

    def test_the_plan_says_where_each_signal_is_recorded(self):
        self.merged_and_approved()
        self.put(self.cellroot, {"review/round-1/decision.json": json.dumps({"outcome": "APPROVED", "human_approval": {"by": "sam"}})})
        raised = self.c_ok("plan", "LOCAL-001")["raised_to_person"]
        self.assertEqual(list(raised), ["human-approval", "merged-by-person"])
        self.assertEqual(raised["human-approval"], ".factory/worktrees/LOCAL-001/review/round-1/decision.json human_approval")


class KeptInGitTest(Base):
    """With no archive, nothing a person might want back is lost: the printed commands show it and bring it back."""

    def check(self, entry):
        shown = run(entry["show"])
        self.assertEqual(shown.returncode, 0, shown.stderr)
        brought = run(entry["bring_back"])
        self.assertEqual(brought.returncode, 0, brought.stderr)
        return shown.stdout

    def test_a_replanned_build_s_refs_and_set_aside_lanes_stay_in_git(self):
        self.worked()
        self.configure(archive="none")
        before = git(self.work, "rev-parse", "HEAD").stdout.strip()
        self.put(self.work, {"app/old_plan.py": "OLD = 1\n"})
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "the old plan's work")
        old = git(self.work, "rev-parse", "HEAD").stdout.strip()
        refs = ["refs/mach/replan/LOCAL-001/1", "refs/mach/lanes-set-aside/LOCAL-001/L2/1", "refs/mach/lane-files/LOCAL-001/L1/1"]
        for ref in refs:
            git(self.project, "update-ref", ref, old)
        git(self.work, "reset", "-q", "--hard", before)
        self.merge()
        self.set_cell(stage="merged", merged={"commit": git(self.project, "rev-parse", "main").stdout.strip(), "at": "x", "method": "local", "landed_commit": before})
        plan = self.c_ok("plan", "LOCAL-001")
        self.assertEqual((plan["would"]["delete_replan_refs"], plan["would"]["bundle_replans"]), ([], False))
        done = self.c_ok("run", "LOCAL-001")
        self.assert_no_archive(done)
        self.assertEqual(sorted(self.refs()), sorted(refs), "every ref MACH kept stays")
        self.assertEqual(done["replan_refs_deleted"], [])
        listed = {item["name"]: item for item in done["kept_in_git"]}
        self.assertEqual(sorted(listed), sorted(refs))
        for ref in refs:
            self.assertIn("the old plan's work", self.check(listed[ref]))
            self.assertIn("OLD = 1", git(self.project, "show", f"{ref.replace('refs/mach/', 'recovered/')}:app/old_plan.py").stdout)
        self.assertIn("files_back", listed["refs/mach/lane-files/LOCAL-001/L1/1"])
        self.assertEqual(sorted(item["ref"] for item in done["record"]["kept_in_git"]["refs"]), sorted(refs))



class DeletedForGoodTest(Base):
    """An abandoned ticket's work is deleted from this machine: cell, worktree, local branch and every ref MACH kept for it. Nothing
    is archived and nothing is kept in Git, unless a person asks with --keep-archive. Remote branches are never touched."""

    def abandon_with_everything(self):
        self.worked()
        self.put(self.work, {"app/invite.py": "def invite(email):\n    return 'half done'\n", "scratch/idea.txt": "untracked idea\n"})
        for ref in ("refs/mach/replan/LOCAL-001/1", "refs/mach/lane-files/LOCAL-001/L1/1", "refs/mach/cell-files/LOCAL-001/taken-over-1",
                    "refs/mach/replan/LOCAL-0011/1"):
            git(self.project, "update-ref", ref, BRANCH)
        git(self.project, "update-ref", f"refs/remotes/origin/{BRANCH}", BRANCH)

    def test_the_plan_says_plainly_what_is_deleted_for_good(self):
        self.abandon_with_everything()
        plan = self.c_ok("plan", "LOCAL-001", "--abandon", WHY)
        self.assertTrue(plan["deletes_for_good"])
        self.assertEqual(plan["deletes"], {"unmerged_commits": 2, "uncommitted_files": 2, "lane_commits": 0, "refs": 3, "branch": BRANCH})
        self.assertEqual(plan["in_words"], f"Abandoning LOCAL-001 deletes its work from this machine for good: 2 unmerged commits and 2 uncommitted files go, "
                                           f"with its cell, its worktrees, its local branch {BRANCH} and the 3 refs MACH kept for it. Nothing is archived or kept. "
                                           "Remote branches and GitHub are not touched. To keep an archive instead, a person asks for it with --keep-archive.")
        self.assertEqual((plan["would"]["archive"], plan["would"]["delete_branch"], plan["keep_in_git"]), (None, f"git branch -D {BRANCH}", []))
        self.assertIn("deleted for good", plan["next"])

    def test_abandon_deletes_the_cell_the_branch_and_every_ref_and_keeps_nothing(self):
        self.abandon_with_everything()
        done = self.c_ok("run", "LOCAL-001", "--abandon", WHY)
        self.assert_no_archive(done)
        self.assertTrue(done["branch_deleted"])
        self.assertNotIn(BRANCH, self.branches())
        self.assertEqual(self.refs(), ["refs/mach/replan/LOCAL-0011/1"], "every ref of this ticket goes; another ticket's stays")
        self.assertEqual(git(self.project, "rev-parse", "--verify", "-q", f"refs/remotes/origin/{BRANCH}").returncode, 0, "a remote branch is never touched")
        self.assertFalse(self.cellroot.exists())
        self.assertEqual((done["kept_in_git"], done["restore"]), ([], None))
        self.assertNotIn("kept_in_git", done["record"])
        self.assertIn("deleted its work from this machine for good", done["in_words"])
        self.assertEqual(done["record"]["archive_kept"]["chosen_by"], "abandon")

    def test_keep_archive_keeps_it_as_before(self):
        self.abandon_with_everything()
        done = self.c_ok("run", "LOCAL-001", "--abandon", WHY, "--keep-archive")
        self.assertEqual(self.tarballs(), ["LOCAL-001.tar.gz"])
        self.assertIn("LOCAL-001/branch.bundle", self.members())
        self.assertIn("git fetch", done["restore"])


class ForgetTest(Base):
    def abandoned_without_archive(self):
        """What an older cleanup kept in Git for a finished ticket: MACH's refs for it and the ticket's branch, named in its run record."""
        self.merged_by_the_line()
        self.configure(archive="none")
        tip = git(self.project, "rev-parse", BRANCH).stdout.strip()
        git(self.project, "update-ref", "refs/mach/replan/LOCAL-001/1", BRANCH)
        git(self.project, "update-ref", "refs/mach/replan/LOCAL-0011/1", BRANCH)
        done = self.c_ok("run", "LOCAL-001")
        git(self.project, "branch", BRANCH, tip)
        lines = self.records()
        lines[-1]["kept_in_git"] = {"branch": {"name": BRANCH, "commit": tip}, "refs": []}
        (self.archive / "runs.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines))
        return done

    def test_forget_lists_without_the_flag_and_deletes_with_it(self):
        self.abandoned_without_archive()
        self.put(self.archive, {"LOCAL-001.tar.gz": "an archive from before"})
        before = (self.refs(), self.branches(), self.tarballs())
        listed = self.c_ok("forget", "LOCAL-001")
        self.assertEqual((self.refs(), self.branches(), self.tarballs()), before, "without --confirm nothing is deleted")
        self.assertEqual(listed["status"], "LISTED")
        entry = listed["tickets"][0]
        self.assertEqual(([r["ref"] for r in entry["refs"]], entry["branch"]["name"], entry["archives"]),
                         (["refs/mach/replan/LOCAL-001/1"], BRANCH, [".factory/archive/LOCAL-001.tar.gz"]))
        self.assertIn("cleanup.py forget LOCAL-001 --confirm", listed["note"])
        done = self.c_ok("forget", "LOCAL-001", "--confirm")
        self.assertEqual(done["status"], "FORGOTTEN")
        self.assertEqual(sorted(done["tickets"][0]["deleted"]), sorted(["refs/mach/replan/LOCAL-001/1", BRANCH, ".factory/archive/LOCAL-001.tar.gz"]))
        self.assertEqual(self.refs(), ["refs/mach/replan/LOCAL-0011/1"], "another ticket's ref is never touched")
        self.assertNotIn(BRANCH, self.branches())
        self.assertEqual(self.tarballs(), [])
        self.assertEqual(len(self.records()), 1, "runs.jsonl is kept")
        self.assertIn("Nothing is kept for LOCAL-001", self.c_ok("forget", "LOCAL-001")["note"])

    def test_forget_refuses_a_ticket_still_open(self):
        self.worked()
        git(self.project, "update-ref", "refs/mach/replan/LOCAL-001/1", BRANCH)
        refusal = self.c_refused("forget", "LOCAL-001", "--confirm")
        self.assertIn("still open in the line", refusal)
        self.assertEqual(self.refs(), ["refs/mach/replan/LOCAL-001/1"])
        self.assertIn(BRANCH, self.branches())

    def test_a_branch_that_moved_since_cleanup_is_not_deleted(self):
        self.abandoned_without_archive()
        git(self.project, "branch", "-f", BRANCH, "main")
        entry = self.c_ok("forget", "LOCAL-001", "--confirm")["tickets"][0]
        self.assertIsNone(entry["branch"])
        self.assertIn("moved after cleanup kept it", entry["left"][0])
        self.assertIn(BRANCH, self.branches())

    def test_forget_older_than_days(self):
        self.abandoned_without_archive()
        self.handmade()
        self.c_ok("run", "LOCAL-009")
        lines = self.records()
        lines[0]["closed_at"] = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat(timespec="seconds")
        (self.archive / "runs.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines))
        self.handmade("LOCAL-0011")  # open in the line again
        lines.append({"ticket_id": "LOCAL-0011", "closed_at": "2020-01-01T00:00:00+00:00", "archive": None})
        (self.archive / "runs.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines))
        listed = self.c_ok("forget", "--older-than", "30")
        self.assertEqual([entry["ticket_id"] for entry in listed["tickets"]], ["LOCAL-001"], "LOCAL-009 is too recent; LOCAL-0011 is open")
        self.assertEqual(listed["skipped"], [{"ticket_id": "LOCAL-0011", "why": "still open in the line: it has a cell again"}])
        self.c_ok("forget", "--older-than", "30", "--confirm")
        self.assertEqual(self.refs(), ["refs/mach/replan/LOCAL-0011/1"])
        self.assertNotIn(BRANCH, self.branches())

    def test_forget_needs_one_ticket_or_days(self):
        self.assertIn("Name one ticket", self.c_refused("forget"))
        self.assertIn("Name one ticket", self.c_refused("forget", "LOCAL-001", "--older-than", "3"))
        self.assertIn("not a usable ticket ID", self.c_refused("forget", "../x"))


PUBLISH = '''import pathlib, shutil, sys
archive, out = sys.argv[1], pathlib.Path(sys.argv[2])
if out.name == "fail":
    sys.exit(4)
out.mkdir(parents=True, exist_ok=True)
shutil.copy(archive, out / pathlib.Path(archive).name)
'''


class PublishTest(Base):
    def publisher(self, out, archive=None):
        script = Path(self.tmp.name) / "publish.py"
        script.write_text(PUBLISH)
        path = self.project / ".factory/config.json"
        config = json.loads(path.read_text()) if path.is_file() else {}
        config["records"] = {"publish_command": [sys.executable, str(script), "{archive}", str(out)]}
        if archive:
            config["cleanup"] = {"archive": archive}
        self.put(self.project, {".factory/config.json": json.dumps(config)})

    def test_an_archive_not_kept_is_made_sent_then_removed(self):
        self.merged_by_the_line()
        out = Path(self.tmp.name) / "published"
        self.publisher(out)
        plan = self.c_ok("plan", "LOCAL-001")
        self.assertEqual(plan["would"]["archive"], ".factory/archive/LOCAL-001.tar.gz")
        self.assertIn("then removed from this machine", plan["archive_then"])
        done = self.c_ok("run", "LOCAL-001")
        self.assertTrue((out / "LOCAL-001.tar.gz").is_file(), "the command got the archive")
        self.assert_no_archive(done)
        self.assertEqual(done["record"]["archive_kept"]["published"], True)
        self.assertIn("sent by records.publish_command and is not kept here", done["record"]["archive_kept"]["reason"])

    def test_a_kept_archive_is_sent_and_kept(self):
        self.merged_by_the_line()
        out = Path(self.tmp.name) / "published"
        self.publisher(out, archive="all")
        done = self.c_ok("run", "LOCAL-001")
        self.assertTrue((out / "LOCAL-001.tar.gz").is_file())
        self.assertEqual((done["archive"], self.tarballs(), done["record"]["archive_kept"]["published"]), (".factory/archive/LOCAL-001.tar.gz", ["LOCAL-001.tar.gz"], True))

    def test_a_failed_publish_keeps_the_archive_it_could_not_send(self):
        self.merged_by_the_line()
        self.publisher(Path(self.tmp.name) / "fail")
        done = self.c_ok("run", "LOCAL-001")
        self.assertEqual((done["published"]["ok"], done["archive"], self.tarballs()), (False, ".factory/archive/LOCAL-001.tar.gz", ["LOCAL-001.tar.gz"]))
        self.assertEqual((done["record"]["archive_kept"]["kept"], done["record"]["archive_kept"]["published"]), (True, False))
        self.assertIn("did not send the archive, so it is kept here", done["record"]["archive_kept"]["reason"])


class OldArchivesTest(Base):
    def test_archives_from_before_are_untouched_and_mentioned_once(self):
        self.put(self.archive, {"OLD-1.tar.gz": "from before", "OLD-2-2.tar.gz": "also"})
        self.merged_by_the_line()
        first = self.c_ok("run", "LOCAL-001")
        self.assertEqual(first["archives_from_before"]["count"], 2)
        self.assertIn("cleanup.py forget --older-than <days> --confirm", first["archives_from_before"]["note"])
        self.handmade(stage="merged", merged={"commit": None, "at": "2026-11-20T10:00:00+00:00", "method": "local", "landed_commit": None})
        second = self.c_ok("run", "LOCAL-009")
        self.assertNotIn("archives_from_before", second, "said once per project")
        self.assertEqual(self.tarballs(), ["OLD-1.tar.gz", "OLD-2-2.tar.gz"])
        self.assertEqual((self.archive / "OLD-1.tar.gz").read_text(), "from before")
        self.assertEqual([r["ticket_id"] for r in self.records()], ["LOCAL-001", "LOCAL-009"])

    def test_nothing_is_said_when_every_archive_is_kept(self):
        self.put(self.archive, {"OLD-1.tar.gz": "from before"})
        self.merged_by_the_line()
        self.configure(archive="all")
        self.assertNotIn("archives_from_before", self.c_ok("run", "LOCAL-001"))


if __name__ == "__main__":
    unittest.main()
