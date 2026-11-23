"""Team audit: the merge station when another engineer's work reached the shared main branch first.

Reproduction only; the test marked expectedFailure shows a real defect. Builds on test_merge's pull-request setup:
the project's main checkout pushes to a shared bare repository and a stand-in for gh merges the pull request. A
second clone of that repository stands in for another engineer, whose pull request merged first.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from test_build import git  # noqa: E402
from test_merge import PullRequestBase  # noqa: E402

CLASH = ("import unittest\n\n\nclass Clash(unittest.TestCase):\n    def test_clash(self):\n        import app.invite  # noqa: F401\n"
         "        self.fail('main now disagrees with this ticket')\n")


class SharedMainMovedTest(PullRequestBase):
    def another_engineer_lands(self, files):
        """Another engineer's clone of the shared repository: their change is merged on the shared main branch."""
        other = Path(self.tmp.name).resolve() / "other-engineer"
        git(Path(self.tmp.name).resolve(), "clone", "-q", str(self.origin), str(other))
        for key, value in (("user.name", "Other Engineer"), ("user.email", "other@example.com"), ("commit.gpgsign", "false")):
            git(other, "config", key, value)
        self.put(other, files)
        git(other, "add", "-A")
        git(other, "commit", "-q", "-m", "another engineer's merged pull request")
        git(other, "push", "-q", "origin", "HEAD:main")
        return git(other, "rev-parse", "HEAD").stdout.strip()

    def test_the_local_checkout_moving_is_revalidated(self):
        """The merge queue step holds for work this machine has: main moved in the local checkout, the suite fails,
        nothing lands (as RevalidationTest shows for the local method)."""
        self.approved(mode="auto", method="pr")
        self.put(self.project, {"tests/test_clash.py": CLASH})
        self.commit_main()
        self.assertIn("the test suite fails, so nothing was merged", self.m_refused("run", "LOCAL-001"))
        self.assertFalse(any(call[:2] == ["pr", "merge"] for call in self.calls()))

    @unittest.expectedFailure
    def test_shared_main_moving_is_not_revalidated(self):
        """Scenario 6: SILENT. The same clash, merged on the shared main by another engineer's pull request. The
        engineer's machine has even fetched it (as the supervisor's auto_sync and `--fetch` do). merge.py revalidate()
        compares with the main checkout's HEAD (`git rev-parse HEAD`), never origin/main, so it sees nothing to
        revalidate, runs no suite, skips the landed-overlap check, and merges the pull request. GitHub then makes a
        merge commit of two changes that were never tested together."""
        self.approved(mode="auto", method="pr")
        landed = self.another_engineer_lands({"tests/test_clash.py": CLASH})
        git(self.project, "fetch", "-q", "origin")
        self.assertEqual(git(self.project, "rev-parse", "origin/main").stdout.strip(), landed)
        code, out, err = self.m("run", "LOCAL-001")
        merged = any(call[:2] == ["pr", "merge"] for call in self.calls())
        self.assertFalse(merged, f"the pull request was merged without testing it against {landed[:10]} on the shared main (exit {code})")


if __name__ == "__main__":
    unittest.main()
