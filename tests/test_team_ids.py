"""Team audit: numbers allocated on one computer from what that computer can see (slice IDs, ADR numbers, epic IDs).

Reproductions only. A test marked expectedFailure shows a real defect: it states what a team needs and fails today.
The others pin down behaviour that already holds. Each test has its own shared bare repository and clones.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
from test_mach_product_issues import spec_for  # noqa: E402
from test_mach_product_intake import Base as IntakeBase  # noqa: E402
import adr  # noqa: E402
import current  # noqa: E402

CELL = ROOT / "skills" / "intent" / "scripts" / "cell.py"


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
    @unittest.expectedFailure
    def test_two_engineers_grooming_at_once_take_one_slice_id(self):
        """Scenario 6 and 10: SILENT. `cell.py next-id` (and so grooming a ticket with /mach new) counts only this
        clone's main checkout, its own open cells and its own Studio drafts. Two engineers grooming at the same time
        get the same ID; both specs land on the shared main under different file names, so Git has no conflict, and
        nothing refuses the second. The current view (current.read_specs) then reads only the first, with a note."""
        first, second = self.next_slice_id(self.one), self.next_slice_id(self.two)
        (self.one / f"specs/slices/{first}-invite-a-teammate.md").write_text(spec_for(first))
        (self.two / f"specs/slices/{second}-export-invoices.md").write_text(spec_for(second))
        self.commit_and_push(self.one, "one's ticket merged")
        self.commit_and_push(self.two, "two's ticket merged")
        head = git(self.one, "ls-remote", str(self.origin), "refs/heads/main").split()[0]
        git(self.one, "fetch", "-q", "origin")
        specs, notes = current.read_specs(self.one, head)
        self.assertNotEqual(first, second, f"both took {first}; on the shared main now: {sorted(specs)}; notes: {notes}")


class AdrNumberTest(SharedRepository):
    def test_two_engineers_take_one_adr_number_and_both_stop_binding(self):
        """Scenario 6, ADR numbers: DETECTED, loudly. adr.next_number counts this clone and its own cells only, so two
        engineers' proposals take one number. Once both are on the shared main, both are problems and bind nothing,
        and cell.py check-plan (plan_adrs) refuses every plan on every machine until an engineer renumbers one."""
        first, second = adr.next_number(self.one, {}), adr.next_number(self.two, {})
        self.assertEqual(first, second)
        (self.one / "docs/adr").mkdir(parents=True)
        (self.one / f"docs/adr/{first:04d}-use-postgresql.md").write_text(ADR_TEXT.format(title="Use PostgreSQL"))
        self.commit_and_push(self.one, "one's ADR")
        alone = adr.main_listing(self.one, {})
        self.assertEqual([(r["id"], r["binding"]) for r in alone["adrs"]], [(f"ADR-{first:04d}", True)])
        (self.two / "docs/adr").mkdir(parents=True)
        (self.two / f"docs/adr/{second:04d}-use-sqlite.md").write_text(ADR_TEXT.format(title="Use SQLite"))
        self.commit_and_push(self.two, "two's ADR")
        both = adr.main_listing(self.two, {})
        self.assertEqual([r["binding"] for r in both["adrs"]], [False, False])
        self.assertTrue(all("another file has the same number" in problem for problem in both["problems"]))


class FolderEpicTest(IntakeBase):
    @unittest.expectedFailure
    def test_two_product_managers_epic_ids_mix_in_ready_folders(self):
        """Scenario 10, ready folders committed without GitHub: SILENT. An epic has no shared record in folder mode;
        each product manager's EPIC-001 is whatever their own computer numbered first. Two different epics under one
        ID are both taken in, and the Factory (its order, `release qualify --epic`) treats them as one epic."""
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


if __name__ == "__main__":
    unittest.main()
