"""Team audit and M20 A2: the merge station when another engineer's work reached the shared main branch first.

Builds on test_merge's pull-request setup: the project's main checkout pushes to a shared bare repository and a
stand-in for gh merges the pull request. A second clone of that repository stands in for another engineer, whose
pull request merged first. The station fetches origin and makes every check against origin/main.
"""

import hashlib
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from test_build import git  # noqa: E402
from test_merge import Base, PullRequestBase  # noqa: E402
import merge  # noqa: E402

CLASH = ("import unittest\n\n\nclass Clash(unittest.TestCase):\n    def test_clash(self):\n        import app.invite  # noqa: F401\n"
         "        self.fail('main now disagrees with this ticket')\n")


class SharedRemote(PullRequestBase):
    """A shared bare repository as origin, and another engineer's clone of it."""

    def other(self):
        return Path(self.tmp.name).resolve() / "other-engineer"

    def another_engineer_lands(self, files):
        """Another engineer's clone of the shared repository: their change is merged on the shared main branch."""
        other = self.other()
        if not other.exists():
            git(Path(self.tmp.name).resolve(), "clone", "-q", str(self.origin), str(other))
            for key, value in (("user.name", "Other Engineer"), ("user.email", "other@example.com"), ("commit.gpgsign", "false")):
                git(other, "config", key, value)
        git(other, "pull", "-q", "--no-rebase", "origin", "main")
        self.put(other, files)
        git(other, "add", "-A")
        git(other, "commit", "-q", "-m", "another engineer's merged pull request")
        git(other, "push", "-q", "origin", "HEAD:main")
        return git(other, "rev-parse", "HEAD").stdout.strip()


class SharedMainMovedTest(SharedRemote):
    def test_the_local_checkout_moving_is_revalidated(self):
        """The merge queue step holds for work this machine has: main moved in the local checkout and was pushed, the
        suite fails, nothing lands."""
        self.approved(mode="auto", method="pr")
        self.put(self.project, {"tests/test_clash.py": CLASH})
        self.commit_main()
        git(self.project, "push", "-q", "origin", "main")
        self.assertIn("the test suite fails, so nothing was merged", self.m_refused("run", "LOCAL-001"))
        self.assertFalse(any(call[:2] == ["pr", "merge"] for call in self.calls()))

    def test_shared_main_moving_is_revalidated(self):
        """Scenario 6, fixed by M20 A2. The same clash, merged on the shared main by another engineer's pull request and
        fetched here (as the supervisor's auto_sync and `--fetch` do). The station re-validates against origin/main, so
        the suite runs on the combination, fails, and nothing is merged."""
        self.approved(mode="auto", method="pr")
        landed = self.another_engineer_lands({"tests/test_clash.py": CLASH})
        git(self.project, "fetch", "-q", "origin")
        self.assertEqual(git(self.project, "rev-parse", "origin/main").stdout.strip(), landed)
        code, out, err = self.m("run", "LOCAL-001")
        merged = any(call[:2] == ["pr", "merge"] for call in self.calls())
        self.assertFalse(merged, f"the pull request was merged without testing it against {landed[:10]} on the shared main (exit {code})")
        self.assertIn("the test suite fails, so nothing was merged", err)
        self.assertEqual(json.loads((self.cellroot / "review/decision.json").read_text())["rejected_by"], "merge station")

    def test_the_station_fetches_the_shared_main_itself(self):
        """Nothing fetched beforehand: the station fetches origin's main, brings the branch up to date with it, reruns
        the suite there and merges."""
        head = self.approved(mode="auto", method="pr")
        landed = self.another_engineer_lands({"app/elsewhere.py": "VALUE = 2\n"})
        self.assertNotEqual(git(self.project, "rev-parse", "origin/main").stdout.strip(), landed, "not fetched yet")
        self.assertEqual(self.m_ok("plan", "LOCAL-001")["compared_with"], "origin/main")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["compared_with"], done["tested_on"], done["revalidated"]["onto"]), ("MERGED", "origin/main", landed, landed))
        self.assertNotEqual(done["landed_commit"], head)
        self.assertEqual(git(self.work, "merge-base", "--is-ancestor", landed, done["landed_commit"]).returncode, 0)
        self.assertNotIn("main_moved_again", done)

    def test_an_unreachable_remote_merges_nothing(self):
        self.approved(mode="auto", method="pr")
        git(self.project, "remote", "set-url", "origin", str(Path(self.tmp.name).resolve() / "gone.git"))
        err = self.m_refused("run", "LOCAL-001")
        self.assertIn("could not reach the shared repository (origin)", err)
        self.assertIn("Nothing was merged", err)
        self.assertEqual(self.calls(), [], "no pull request, no merge")
        self.assertEqual(self.cell_json()["stage"], "approved")

    def test_a_shared_main_that_moves_before_the_merge_is_revalidated(self):
        """Another engineer lands between this station's re-validation and its merge: the station sees origin's main
        moved when it reads it again just before merging, says so, re-validates on the new main and then merges."""
        self.approved(mode="auto", method="pr")
        landed = []
        real = merge.post_findings

        def meanwhile(cell, url, head):
            if not landed:
                landed.append(self.another_engineer_lands({"app/meanwhile.py": "VALUE = 3\n"}))
            return real(cell, url, head)

        with mock.patch.object(merge, "post_findings", meanwhile):
            done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertEqual(len(done["main_moved_again"]), 1)
        self.assertIn("moved again", done["main_moved_again"][0])
        self.assertIn("re-validating", done["main_moved_again"][0])
        self.assertEqual((done["tested_on"], done["revalidated"]["onto"]), (landed[0], landed[0]))
        self.assertEqual(sum(1 for call in self.calls() if call[:2] == ["pr", "merge"]), 1)
        merged = next(call for call in self.calls() if call[:2] == ["pr", "merge"])
        self.assertEqual(merged[merged.index("--match-head-commit") + 1], done["landed_commit"])
        self.assertEqual(git(self.project, "ls-remote", str(self.origin), "refs/heads/feature/LOCAL-001").stdout.split()[0], done["landed_commit"])

    def test_a_shared_main_that_keeps_moving_stops_after_a_few_tries(self):
        self.approved(mode="auto", method="pr")
        count = []

        def meanwhile(cell, url, head):
            count.append(self.another_engineer_lands({f"app/busy{len(count)}.py": "VALUE = 4\n"}))
            return {"posted": False, "reason": "test"}

        with mock.patch.object(merge, "post_findings", meanwhile):
            err = self.m_refused("run", "LOCAL-001")
        self.assertIn(f"origin/main moved {merge.MAX_MAIN_MOVES + 1} times", err)
        self.assertIn("Nothing was merged; the pull request stays open", err)
        self.assertEqual(len(count), merge.MAX_MAIN_MOVES + 1, "bounded: re-validated MAX_MAIN_MOVES times, never a loop")
        self.assertFalse(any(call[:2] == ["pr", "merge"] for call in self.calls()))
        self.assertEqual(self.cell_json()["stage"], "pr-open")

    def test_github_refusing_a_moved_base_is_revalidated(self):
        """With "require branches to be up to date", GitHub refuses the merge when main moved at the last moment. The
        station reads origin's main again, sees it moved, re-validates and merges on the next try."""
        self.approved(mode="auto", method="pr")
        real = merge.gh
        refused = []

        def platform(cell, *args, **kwargs):
            if list(args[:2]) == ["pr", "merge"] and not refused:
                refused.append(self.another_engineer_lands({"app/late.py": "VALUE = 5\n"}))
                return subprocess.CompletedProcess(["gh", *args], 1, "", "Head branch is out of date. Review and try the merge again.\n")
            return real(cell, *args, **kwargs)

        with mock.patch.object(merge, "gh", platform):
            done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["tested_on"], len(done["main_moved_again"])), ("MERGED", refused[0], 1))
        self.assertNotIn("warning", done)

    def test_a_merge_onto_an_untested_main_is_reported(self):
        """Without GitHub's up-to-date rule, main can move in the instant between the last read and the merge. That
        cannot be undone; the station sees it in the merge commit's first parent and says so plainly."""
        self.approved(mode="auto", method="pr")
        real = merge.gh
        made = {}

        def platform(cell, *args, **kwargs):
            if list(args[:2]) == ["pr", "merge"]:
                moved = self.another_engineer_lands({"app/instant.py": "VALUE = 6\n"})
                other = self.other()
                tip = args[args.index("--match-head-commit") + 1]
                git(other, "fetch", "-q", "origin", "feature/LOCAL-001")
                git(other, "merge", "-q", "--no-ff", "-m", "Merge pull request #12", tip)
                git(other, "push", "-q", "origin", "HEAD:main")
                made.update(moved=moved, merge=git(other, "rev-parse", "HEAD").stdout.strip())
                return subprocess.CompletedProcess(["gh", *args], 0, "", "")
            if list(args[:2]) == ["pr", "view"] and made:
                return subprocess.CompletedProcess(["gh", *args], 0, json.dumps({"state": "MERGED", "mergeCommit": {"oid": made["merge"]}}), "")
            return real(cell, *args, **kwargs)

        with mock.patch.object(merge, "gh", platform):
            done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["merge_commit"], done["untested_base"]), ("MERGED", made["merge"], made["moved"]))
        self.assertIn("was not tested with", done["warning"])
        self.assertIn("up to date before merging", done["warning"])


class LocalMethodTest(Base):
    """M20 A2: with no remote, merge.method local works exactly as before."""

    def test_without_a_remote_local_works_as_before(self):
        head = self.approved(mode="auto")
        self.assertEqual(self.m_ok("plan", "LOCAL-001")["compared_with"], "main")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["compared_with"], done["revalidated"]), ("MERGED", "main", None))
        self.assertNotIn("note", done, "nothing to push without a remote")
        self.assertEqual(git(self.project, "merge-base", "--is-ancestor", head, "main").returncode, 0)


class LocalMethodWithRemoteTest(SharedRemote):
    """M20 A2: merge.method local with an origin remote. origin's main is fetched; the local main must already hold it;
    the merge is then local exactly as before, tested against the local main, never pushed, and the result says so."""

    def test_local_main_holding_the_shared_main_merges_locally_and_says_to_push(self):
        head = self.approved(mode="auto")
        origin_before = git(self.project, "ls-remote", str(self.origin), "refs/heads/main").stdout.split()[0]
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["compared_with"]), ("MERGED", "main"))
        self.assertIn("Merged on this machine only", done["note"])
        self.assertIn("Push main to origin", done["note"])
        self.assertEqual(git(self.project, "merge-base", "--is-ancestor", head, "main").returncode, 0)
        self.assertEqual(git(self.project, "ls-remote", str(self.origin), "refs/heads/main").stdout.split()[0], origin_before, "never pushed")
        self.assertEqual(self.calls(), [], "no gh at all")

    def test_a_shared_main_ahead_of_this_checkout_is_refused_until_pulled(self):
        self.approved(mode="auto")
        self.another_engineer_lands({"app/one.py": "VALUE = 1\n"})
        self.another_engineer_lands({"app/two.py": "VALUE = 2\n"})
        err = self.m_refused("run", "LOCAL-001")
        self.assertIn("The shared main (origin/main) has 2 commits this checkout's main does not have yet. Pull main, then merge again.", err)
        self.assertEqual(self.main_log(), ["work"], "nothing merged")
        self.assertEqual(self.cell_json()["stage"], "approved")
        git(self.project, "pull", "-q", "--no-rebase", "origin", "main")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertTrue((self.project / "app/one.py").is_file() and (self.project / "app/invite.py").is_file())

    def test_unpushed_local_commits_are_tested_against(self):
        """The local main is what the ticket lands on, so its unpushed commits count, as before M20."""
        self.approved(mode="auto")
        self.put(self.project, {"tests/test_clash.py": CLASH})
        self.commit_main()
        self.assertIn("the test suite fails, so nothing was merged", self.m_refused("run", "LOCAL-001"))
        self.assertNotIn("Merge LOCAL-001", " ".join(self.main_log()))

    def test_an_unreachable_remote_merges_nothing_locally_either(self):
        self.approved(mode="auto")
        git(self.project, "remote", "set-url", "origin", str(Path(self.tmp.name).resolve() / "gone.git"))
        err = self.m_refused("run", "LOCAL-001")
        self.assertIn("could not reach the shared repository (origin)", err)
        self.assertEqual(self.main_log(), ["work"])


SPEC = "# SLICE-001: Invite a teammate\n\nAn admin invites a colleague by email.\n"
NEWER = SPEC + "\nThe invitation lasts seven days.\n"


def spec_sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class ShippedOnceTest(SharedRemote):
    """M20: the shared main takes a slice revision once. Two Factories built SLICE-001; the other one's copy landed first
    (pushed from another engineer's clone). The Factory's own merge of this cell stops with intake's sentence, and nothing is merged,
    pushed, opened or closed."""

    def slice_cell(self, sha=None, **config):
        head = self.approved(**config)
        self.set_cell(product={"slice_id": "SLICE-001", "spec_sha256": sha or spec_sha(SPEC), "revision": 1})
        return head

    def other_copy_lands(self, text=SPEC):
        return self.another_engineer_lands({"specs/slices/SLICE-001-invite-a-teammate.md": text})

    def assert_refused(self, err, landed):
        self.assertIn(f"SLICE-001 was already shipped from another Factory (merged as {landed[:12]}). This copy was not merged.", err)
        self.assertIn("Nothing was pushed or merged.", err)
        self.assertNotIn("--abandon", err, "a stop never suggests abandoning")
        self.assertIn("A person's merge (merge LOCAL-001 --by-person) brings main into this copy", err)

    def test_local_merge_is_refused_once_the_other_copy_landed(self):
        self.slice_cell(mode="auto")
        landed = self.other_copy_lands()
        git(self.project, "pull", "-q", "--no-rebase", "origin", "main")
        origin_before = git(self.project, "ls-remote", str(self.origin), "refs/heads/main").stdout.split()[0]
        plan = self.m_ok("plan", "LOCAL-001")  # the plan says it before anything is run
        self.assertFalse(plan["allowed"])
        self.assert_refused("\n".join(plan["refusals"]), landed)
        self.assert_refused(self.m_refused("run", "LOCAL-001"), landed)
        self.assertNotIn("Merge LOCAL-001", " ".join(self.main_log()))
        self.assertEqual(self.cell_json()["stage"], "approved", "left for cleanup")
        self.assertEqual(git(self.project, "ls-remote", str(self.origin), "refs/heads/main").stdout.split()[0], origin_before)
        self.assertEqual(self.calls(), [])

    def test_local_merge_is_refused_even_before_this_checkout_pulled(self):
        """The fetched origin/main counts too: the refusal comes before the "pull first" one."""
        self.slice_cell(mode="auto")
        landed = self.other_copy_lands()
        self.assert_refused(self.m_refused("run", "LOCAL-001"), landed)

    def test_pull_request_is_not_opened(self):
        self.slice_cell(mode="auto", method="pr")
        landed = self.other_copy_lands()
        self.assert_refused(self.m_refused("run", "LOCAL-001"), landed)
        self.assertEqual(self.calls(), [], "no pull request opened, nothing closed")
        self.assertEqual(git(self.project, "ls-remote", str(self.origin), "refs/heads/feature/LOCAL-001").stdout, "", "the branch was not pushed")
        self.assertEqual(self.cell_json()["stage"], "approved")

    def test_its_own_open_pull_request_stays_open_with_a_note(self):
        self.slice_cell(mode="auto", method="pr")
        with mock.patch.dict(os.environ, {"FAKE_GH_BLOCK": "1"}):
            code, out, _ = self.m("run", "LOCAL-001")
        self.assertEqual((code, json.loads(out)["status"]), (3, "PR_OPEN"))
        landed = self.other_copy_lands()
        before = len(self.calls())
        err = self.m_refused("run", "LOCAL-001")
        self.assert_refused(err, landed)
        self.assertIn("This copy's pull request (https://github.com/acme/app/pull/12) is left open.", err)
        self.assertEqual([call[:2] for call in self.calls()[before:]], [["pr", "view"]], "only read: not merged, not closed, nothing commented")
        self.assertEqual(self.cell_json()["stage"], "pr-open")

    def test_a_newer_revision_of_the_slice_is_not_refused(self):
        self.slice_cell(sha=spec_sha(NEWER), mode="auto", method="pr")
        self.other_copy_lands(SPEC)
        self.assertEqual(self.m_ok("run", "LOCAL-001")["status"], "MERGED")

    def test_an_engineers_own_ticket_is_not_checked_for_a_landed_copy(self):
        """No `product`: there is no approved revision to compare, so the same spec already on main is not a refusal."""
        self.approved(mode="auto", method="pr")
        path = "specs/slices/SLICE-001-invite-teammate.md"
        self.another_engineer_lands({path: (self.work / path).read_text()})
        git(self.project, "fetch", "-q", "origin")
        cell = merge.Cell(self.project, "LOCAL-001")
        self.assertEqual((merge.landed_elsewhere(cell, "main"), merge.slice_id_taken(cell, "main")), (None, None))
        err = self.m_refused("run", "LOCAL-001")
        self.assertNotIn("already shipped", err)
        self.assertIn("changed files this ticket also changed", err, "the station's own overlap check, as before")

    def test_its_own_merge_having_landed_is_not_refused(self):
        """The pull request was opened, then a person merged it on GitHub; the spec on main is this cell's own. The station's
        next run records the merge."""
        self.slice_cell(mode="auto", method="pr")
        with mock.patch.dict(os.environ, {"FAKE_GH_BLOCK": "1"}):
            self.m("run", "LOCAL-001")
        tip = git(self.project, "ls-remote", str(self.origin), "refs/heads/feature/LOCAL-001").stdout.split()[0]
        self.another_engineer_lands({})
        other = self.other()
        git(other, "fetch", "-q", "origin", "feature/LOCAL-001")
        self.put(other, {"specs/slices/SLICE-001-invite-a-teammate.md": SPEC})
        git(other, "add", "-A")
        git(other, "commit", "-q", "-m", "the spec, as the cell's branch would carry it")
        git(other, "merge", "-q", "--no-ff", "-m", "Merge pull request #12", tip)
        git(other, "push", "-q", "origin", "HEAD:main")
        (Path(self.tmp.name).resolve() / "merged.flag").write_text("merged")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertEqual(self.cell_json()["stage"], "merged")

    def approved_adding(self, files, **config):
        """Approved, with `files` committed on the branch before review (as a groomed ticket's spec is)."""
        self.verified()
        self.put(self.work, files)
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "the ticket's spec")
        head = git(self.work, "rev-parse", "HEAD").stdout.strip()
        self.put(self.cellroot, {"review/decision.json": json.dumps({
            "outcome": "APPROVED", "head": head, "round": 1, "votes": {"architecture": "APPROVE", "security": "APPROVE", "product": "APPROVE"},
            "blockers": 0, "human_approval_required": False, "human_approval": None})})
        self.set_cell(stage="approved", review="APPROVED")
        self.put(self.project, {".factory/config.json": json.dumps({"merge": config})})
        return head

    def test_a_slice_id_taken_on_main_by_another_slice_is_refused(self):
        """M20 A3: two engineers numbered their own tickets in the same minute and both took SLICE-001. The other one's spec
        reached the shared main first, under another file name; Git would see no conflict. This one is refused."""
        self.approved(mode="auto", method="pr")  # an engineer's own ticket: its branch adds specs/slices/SLICE-001-invite-teammate.md
        self.other_copy_lands()
        err = self.m_refused("run", "LOCAL-001")
        self.assertIn("SLICE-001 is already on main as specs/slices/SLICE-001-invite-a-teammate.md, which is another slice than this ticket's "
                      "specs/slices/SLICE-001-invite-teammate.md: two engineers took one slice number. Nothing was pushed or merged.", err)
        self.assertIn("A person's merge (merge LOCAL-001 --by-person) gives this ticket's slice the next free number", err)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.cell_json()["stage"], "approved")
        plan = self.m_ok("plan", "LOCAL-001")  # run fetched the shared main; the plan reads it as fetched and says the same
        self.assertFalse(plan["allowed"])
        self.assertIn("two engineers took one slice number", "\n".join(plan["refusals"]))
        self.assertEqual(self.calls(), [], "the plan opens and closes nothing")

    def test_the_same_slice_handed_over_under_another_file_name_is_not_refused(self):
        """A slice Product Studio handed this cell is one slice whatever its file is called (the 0.20.0 rule): a newer revision
        whose title, and so file name, changed merges."""
        self.approved_adding({"specs/slices/SLICE-001-invite-a-colleague.md": NEWER}, mode="auto", method="pr")
        self.set_cell(product={"slice_id": "SLICE-001", "spec_sha256": spec_sha(NEWER), "revision": 2})
        self.other_copy_lands()
        self.assertEqual(self.m_ok("run", "LOCAL-001")["status"], "MERGED")

    def test_a_local_merge_already_recorded_is_its_own(self):
        self.slice_cell(mode="auto")
        self.set_cell(merged={"commit": "a" * 40, "method": "local"})
        self.other_copy_lands()
        git(self.project, "pull", "-q", "--no-rebase", "origin", "main")
        cell = merge.Cell(self.project, "LOCAL-001")
        self.assertIsNone(merge.landed_elsewhere(cell, "main"))


if __name__ == "__main__":
    unittest.main()
