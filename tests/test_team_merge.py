"""Team audit and M20 A2: the merge station when another engineer's work reached the shared main branch first.

Builds on test_merge's pull-request setup: the project's main checkout pushes to a shared bare repository and a
stand-in for gh merges the pull request. A second clone of that repository stands in for another engineer, whose
pull request merged first. The station fetches origin and makes every check against origin/main.
"""

import json
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


class SharedMainMovedTest(PullRequestBase):
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
    """M20 A2: merge.method local is for a repository with no remote; with one, it is refused with the fix."""

    def test_without_a_remote_local_works_as_before(self):
        head = self.approved(mode="auto")
        self.assertEqual(self.m_ok("plan", "LOCAL-001")["compared_with"], "main")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["compared_with"], done["revalidated"]), ("MERGED", "main", None))
        self.assertEqual(git(self.project, "merge-base", "--is-ancestor", head, "main").returncode, 0)

    def test_with_a_shared_remote_local_is_refused(self):
        self.approved(mode="auto", method="local")
        shared = Path(self.tmp.name).resolve() / "shared.git"
        git(Path(self.tmp.name).resolve(), "init", "-q", "--bare", str(shared))
        git(self.project, "remote", "add", "origin", str(shared))
        self.assertFalse(self.m_ok("plan", "LOCAL-001")["allowed"])
        err = self.m_refused("run", "LOCAL-001")
        self.assertIn("merge.method is 'local', but this repository has a shared remote (origin)", err)
        self.assertIn('Set merge.method to "pr"', err)
        self.assertEqual(self.main_log(), ["work"], "nothing merged into the checkout")
        self.assertEqual(self.cell_json()["stage"], "approved")


if __name__ == "__main__":
    unittest.main()
