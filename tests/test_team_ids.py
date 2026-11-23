"""Team audit: numbers allocated on one computer from what that computer can see (slice IDs, ADR numbers, epic IDs).

Started as the team audit's reproductions; each now states the M20 A3 fix (the allocator reads the shared main and GitHub's
slice issues, ADR numbers count origin's branches and a collision says how to renumber, ready folders refuse one epic ID with
two titles). Each test has its own shared bare repository and clones.
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
from test_mach_product_issues import spec_for  # noqa: E402
from test_mach_product_intake import Base as IntakeBase  # noqa: E402
from test_mach_product_issues import IssuesBase  # noqa: E402
import adr  # noqa: E402
import cell  # noqa: E402
import current  # noqa: E402

CELL = ROOT / "skills" / "intent" / "scripts" / "cell.py"
RUN = ROOT / "skills" / "run" / "scripts" / "run.py"


def git(folder, *args):
    done = subprocess.run(["git", *args], cwd=str(folder), capture_output=True, text=True)
    if done.returncode != 0:
        raise AssertionError(f"git {' '.join(args)}: {done.stderr}")
    return done.stdout


ADR_TEXT = """---
status: accepted
date: 2026-11-20
---

# {title}

## Context and problem statement

{title}.

## Decision outcome

{title}.
"""


class SharedRepository(unittest.TestCase):
    """A shared bare repository and two engineers' clones of it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mach-team-ids-")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve()
        self.origin = root / "origin.git"
        git(root, "init", "-q", "--bare", "-b", "main", str(self.origin))
        self.one = self.clone(root, "one")
        (self.one / "README.md").write_text("# App\n")
        (self.one / "specs/slices").mkdir(parents=True)
        (self.one / "specs/slices/.keep").write_text("")
        git(self.one, "add", "-A")
        git(self.one, "commit", "-q", "-m", "start")
        git(self.one, "push", "-q", "origin", "HEAD:main")
        self.two = self.clone(root, "two")

    def clone(self, root, name):
        folder = root / name
        git(root, "clone", "-q", str(self.origin), str(folder))
        for key, value in (("user.name", name), ("user.email", f"{name}@example.com"), ("commit.gpgsign", "false")):
            git(folder, "config", key, value)
        return folder

    def commit_and_push(self, folder, message):
        git(folder, "add", "-A")
        git(folder, "commit", "-q", "-m", message)
        git(folder, "pull", "-q", "--no-rebase", "--no-edit", "origin", "main")  # another engineer's merge may have landed first
        git(folder, "push", "-q", "origin", "HEAD:main")

    def next_slice_id(self, folder):
        done = subprocess.run([sys.executable, str(CELL), "--project", str(folder), "next-id", "--count", "1"], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)["next"][0]


class EngineerSliceIdTest(SharedRepository):
    def test_two_engineers_grooming_one_after_the_other_take_two_slice_ids(self):
        """Scenario 6 and 10, fixed by M20 A3. `cell.py next-id` also counts the specs on origin/main as last fetched, so an
        engineer whose checkout has fetched another's merged ticket, without pulling it, takes the next number. (Two
        engineers numbering in the same minute, before either's spec reached the shared main, can still take one number:
        the merge station refuses the second, test_team_merge.ShippedOnceTest.)"""
        first = self.next_slice_id(self.one)
        (self.one / f"specs/slices/{first}-invite-a-teammate.md").write_text(spec_for(first))
        self.commit_and_push(self.one, "one's ticket merged")
        self.assertEqual(self.next_slice_id(self.two), first, "not fetched yet: nothing on this computer says it is taken")
        git(self.two, "fetch", "-q", "origin")
        second = self.next_slice_id(self.two)
        self.assertNotEqual(first, second)
        (self.two / f"specs/slices/{second}-export-invoices.md").write_text(spec_for(second))
        self.commit_and_push(self.two, "two's ticket merged")
        head = git(self.one, "ls-remote", str(self.origin), "refs/heads/main").split()[0]
        git(self.one, "fetch", "-q", "origin")
        specs, notes = current.read_specs(self.one, head)
        self.assertEqual(sorted(specs), [first, second], notes)


class AdrNumberTest(SharedRepository):
    def write_adr(self, folder, number, slug, title, extra=""):
        (folder / "docs/adr").mkdir(parents=True, exist_ok=True)
        (folder / f"docs/adr/{number:04d}-{slug}.md").write_text(ADR_TEXT.format(title=title) + extra)
        return f"docs/adr/{number:04d}-{slug}.md"

    def test_the_next_number_counts_the_shared_main_as_last_fetched(self):
        """M20 A3: an ADR merged on the shared main counts once this clone has fetched, before it pulls."""
        self.write_adr(self.one, adr.next_number(self.one, {}), "use-postgresql", "Use PostgreSQL")
        self.commit_and_push(self.one, "one's ADR")
        self.assertEqual(adr.next_number(self.two, {}), 1, "not fetched yet: nothing here says 0001 is taken")
        git(self.two, "fetch", "-q", "origin")
        self.assertEqual(adr.next_number(self.two, {}), 2)

    def test_the_next_number_counts_open_pull_request_branches(self):
        """An ADR proposed on another engineer's branch, pushed for a pull request and not merged yet, counts too."""
        self.write_adr(self.one, adr.next_number(self.one, {}), "use-postgresql", "Use PostgreSQL")
        git(self.one, "checkout", "-q", "-b", "adr-postgresql")
        git(self.one, "add", "-A")
        git(self.one, "commit", "-q", "-m", "propose")
        git(self.one, "push", "-q", "origin", "adr-postgresql")
        git(self.two, "fetch", "-q", "origin")
        self.assertEqual(adr.next_number(self.two, {}), 2)
        git(self.two, "update-ref", "refs/pull/7/head", "refs/remotes/origin/adr-postgresql")  # a pull request's ref, where it was fetched
        git(self.two, "update-ref", "-d", "refs/remotes/origin/adr-postgresql")
        self.assertEqual(adr.next_number(self.two, {}), 2)

    def test_two_engineers_take_one_adr_number_and_the_refusal_says_how_to_renumber(self):
        """Scenario 6, ADR numbers. Two engineers who pick a number in the same hour, neither having fetched the other's,
        still take one number. Once both are on the shared main, neither binds and every plan is refused; the problem names
        both files, which one came later, and the command that renumbers it. The renumber makes both bind again."""
        first, second = adr.next_number(self.one, {}), adr.next_number(self.two, {})
        self.assertEqual(first, second)
        self.write_adr(self.one, first, "use-sqlite", "Use SQLite")
        with mock.patch.dict(os.environ, {"GIT_COMMITTER_DATE": "2026-11-20T10:00:00", "GIT_AUTHOR_DATE": "2026-11-20T10:00:00"}):
            self.commit_and_push(self.one, "one's ADR")
        alone = adr.main_listing(self.one, {})
        self.assertEqual([(r["id"], r["binding"]) for r in alone["adrs"]], [(f"ADR-{first:04d}", True)])
        later = self.write_adr(self.two, second, "add-a-cache", "Add a cache", "\nSee ADR-0001 for the store.\n")
        (self.two / "docs/architecture").mkdir()
        (self.two / "docs/architecture/overview.md").write_text("| storage | ADR-0001 | Use SQLite | accepted | - |\n| cache | ADR-0001 | Add a cache | accepted | - |\n"
                                                        "Read [the cache](../adr/0001-add-a-cache.md).\n")
        with mock.patch.dict(os.environ, {"GIT_COMMITTER_DATE": "2026-11-20T11:00:00", "GIT_AUTHOR_DATE": "2026-11-20T11:00:00"}):
            self.commit_and_push(self.two, "two's ADR")
        both = adr.main_listing(self.two, {})
        self.assertEqual([r["binding"] for r in both["adrs"]], [False, False])
        command = f"/mach:run adr renumber {later}, then commit the change by pull request"
        self.assertEqual(len(both["problems"]), 2)
        for problem in both["problems"]:
            self.assertIn("another file has the same number", problem)
            self.assertIn("Neither binds until the later one is renumbered: " + command, problem)
        self.assertIn("docs/adr/0001-use-sqlite.md: another file has the same number: docs/adr/0001-add-a-cache.md", " ".join(both["problems"]))
        done = adr.renumber(self.two, {}, later)
        self.assertEqual((done["from"]["id"], done["to"]), ("ADR-0001", {"id": "ADR-0002", "file": "docs/adr/0002-add-a-cache.md"}))
        self.assertFalse((self.two / later).exists())
        overview = (self.two / "docs/architecture/overview.md").read_text()
        self.assertIn("| cache | ADR-0002 | Add a cache |", overview)
        self.assertIn("| storage | ADR-0001 | Use SQLite |", overview)
        self.assertIn("(../adr/0002-add-a-cache.md)", overview)
        self.assertIn("See ADR-0002 for the store.", (self.two / "docs/adr/0002-add-a-cache.md").read_text(), "its own mentions")
        self.assertEqual(done["check_by_hand"], ["docs/architecture/overview.md"], "the storage row's ADR-0001 is the other one's, and is left")
        self.assertNotEqual(git(self.two, "status", "--porcelain"), "", "written, never committed")
        self.assertTrue(git(self.two, "log", "-1", "--format=%s").startswith("Merge branch"), "nothing committed by the renumber")
        self.commit_and_push(self.two, "renumber")
        fixed = adr.main_listing(self.two, {})
        self.assertEqual([(r["id"], r["binding"]) for r in fixed["adrs"]], [("ADR-0001", True), ("ADR-0002", True)])

    def test_renumbering_a_number_nobody_shares_changes_every_reference(self):
        self.write_adr(self.one, 1, "use-sqlite", "Use SQLite")
        self.write_adr(self.one, 2, "add-a-cache", "Add a cache", "\nBuilt on ADR-0001.\n")
        done = adr.renumber(self.one, {}, "0001-use-sqlite.md")
        self.assertEqual((done["to"]["file"], done["check_by_hand"]), ("docs/adr/0003-use-sqlite.md", []))
        self.assertIn("Built on ADR-0003.", (self.one / "docs/adr/0002-add-a-cache.md").read_text())

    def test_the_renumber_command(self):
        self.write_adr(self.one, 1, "use-sqlite", "Use SQLite")
        (self.one / ".factory").mkdir()
        done = subprocess.run([sys.executable, str(RUN), "--project", str(self.one), "adr", "renumber", "docs/adr/0001-use-sqlite.md"],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout)
        self.assertEqual((result["status"], result["committed"], result["to"]["id"]), ("RENUMBERED", False, "ADR-0002"))
        self.assertIn("open a pull request", result["next"])
        wrong = subprocess.run([sys.executable, str(RUN), "--project", str(self.one), "adr", "renumber", "README.md"], capture_output=True, text=True)
        self.assertNotEqual(wrong.returncode, 0)
        self.assertIn("is not an ADR file", wrong.stderr + wrong.stdout)


class GitHubSliceIdTest(IssuesBase):
    """M20 A3: on GitHub, an engineer numbering their own ticket also counts every slice issue's ID, read through the ticket station."""

    def next_id(self, env):
        out = io.StringIO()
        with mock.patch.dict(os.environ, env), redirect_stdout(out), redirect_stderr(io.StringIO()):
            self.assertEqual(cell.main(["--project", str(self.eng), "next-id"]), 0)
        return json.loads(out.getvalue())

    def test_a_slice_issue_holds_its_number(self):
        self.project_and_epic()
        self.drafted()
        self.ready("SLICE-001")
        self.set_gh(me="erin-eng")
        self.assertEqual(self.next_id({"ISSUE_PROVIDER": "local"})["next"][0], "SLICE-001", "nothing on this computer holds it")
        found = self.next_id({"ISSUE_PROVIDER": "github"})
        self.assertEqual((found["next"][0], found.get("not_counted")), ("SLICE-002", None))
        self.assertIn({"id": "SLICE-001", "file": "a slice issue on GitHub (SLICE-001)"}, found["existing"])

    def test_github_out_of_reach_is_said_plainly(self):
        self.gh_fails("issue list", once=False)
        found = self.next_id({"ISSUE_PROVIDER": "github"})
        self.assertEqual(found["next"][0], "SLICE-001")
        self.assertEqual(len(found["not_counted"]), 1)
        self.assertIn("GitHub could not be read", found["not_counted"][0])
        self.assertIn("slice IDs held only by issues on GitHub were not counted", found["not_counted"][0])


class FolderEpicTest(IntakeBase):
    def test_two_product_managers_epic_ids_mix_in_ready_folders(self):
        """Scenario 10, ready folders committed without GitHub, fixed by M20 A3. An epic has no shared record in folder mode;
        each product manager's EPIC-001 is whatever their own computer numbered first. Intake takes in the first slice and
        refuses the folder whose EPIC-001 has another title, saying so, so the Factory never treats two epics as one."""
        first = self.slice(self.a, "Invite a teammate")
        second = self.slice(self.a, "Send an invoice")
        record = json.loads(self.folders[second]["slice.json"])
        record["epic"] = {"epic_id": "EPIC-001", "title": "Billing"}  # Ben's EPIC-001, numbered on his computer
        self.folders[second]["slice.json"] = json.dumps(record, indent=2, sort_keys=True) + "\n"
        self.publish(self.a, first, second)
        report = self.product("intake")
        said = json.dumps({key: report.get(key) for key in ("notes", "not_accepted", "refused")})
        entries = self.ledger()["slices"]
        titles = sorted({entry["epic"]["title"] for entry in entries.values()})
        self.assertIn("EPIC-001", said, f"both taken in under EPIC-001 as {titles}, and intake said nothing about it")
        self.assertEqual(sorted(entries), [first])
        refused = next(item for item in report["not_accepted"] if item["slice_id"] == second)
        self.assertIn(f"its epic is EPIC-001 \"Billing\", but {first}'s epic EPIC-001 is", refused["reason"])


if __name__ == "__main__":
    unittest.main()
