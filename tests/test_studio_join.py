"""Joining a project someone else defined: a fresh clone's Product Studio takes the whole published project from GitHub by itself.

Ada defines the product on her computer (the project, two epics, slices in every state GitHub can hold) and marks them ready.
Ben clones the repository and starts Product Studio: its first refresh (the terminal's first step, and the app's own start) brings
in everything GitHub holds, exactly as Ada published it, and asks Ben for nothing. Later refreshes bring only what is new or
changed. Nothing is ever written to GitHub by joining.

Uses the GitHub stand-in of test_mach_product_issues (test_team_studio's two product managers); never real gh or the network.
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "studio" / "scripts"))
from mock_pictures import png  # noqa: E402
from test_mach_product_issues import NETWORK_DOWN, git  # noqa: E402
from test_team_studio import TwoProductManagers  # noqa: E402
import issue_rules  # noqa: E402

ONLY_THERE = ("Drafts never marked ready, PRDs, designs, ideas' working files and interview notes exist only on the computer where they were "
              "written.")


class JoinBase(TwoProductManagers):
    def factory(self, number, moment):
        """The Factory's status comment and label on a slice's issue (the ticket station's template)."""
        state = self.gh()
        issue = state["issues"][str(number)]
        marker = issue_rules.parse_slice_body(issue["body"])
        body = issue_rules.comment(moment, [f"{marker['slice_id']}@r{marker['revision']}"], "0" * 32,
                                   question="Which wins: FR-02 or INV-01?" if moment == "question" else None)["body"]
        issue["comments"].append({"login": "erin-eng", "body": body})
        issue["labels"] = [{"name": "mach:slice"}, {"name": {"building": "mach:building", "question": "mach:question", "shipped": "mach:shipped"}[moment]}]
        if moment == "shipped":
            issue["state"] = "CLOSED"
        self.gh_state.write_text(json.dumps(state))

    def slice_in(self, project, epic, title, depends=()):
        args = [arg for dep in depends for arg in ("--depends-on", dep)]
        slice_id = self.ok(project, "slice", "new", "--epic", epic, "--title", title, *args)["slice"]["slice_id"]
        self.write_slice(project, slice_id)
        return slice_id

    def with_mock(self, project, slice_id):
        picture = self.root / f"{slice_id}.png"
        picture.write_bytes(png())
        self.ok(project, "slice", "mock", "add", slice_id, str(picture))

    def commit_mocks(self, slice_id, files):
        git(self.a, "pull", "-q", "--ff-only")
        folder = self.a / "product/ready" / slice_id / "mocks"
        folder.mkdir(parents=True, exist_ok=True)
        for name in files:
            (folder / name).write_bytes((self.a / ".factory/studio/draft/product/ready" / slice_id / "mocks" / name).read_bytes())
        git(self.a, "add", "-A", "product")
        git(self.a, "commit", "-q", "-m", f"design mocks for {slice_id}")
        git(self.a, "push", "-q", "origin", "main")

    def ada_publishes(self):
        """Ada's whole project, every state GitHub can hold. Returns {slice ID: issue}."""
        a = self.ada()
        self.project_and_epic(a)
        self.ok(a, "epic", "add", "--title", "Billing", "--criterion", "Teams pay for what they use")
        issues = {}
        for slice_id in (self.slice_in(a, "EPIC-001", "Invite a teammate"),):
            issues[slice_id] = self.ready(slice_id, a)["issue"]
        issues["SLICE-002"] = self.ready(self.slice_in(a, "EPIC-001", "Remove a teammate", depends=("SLICE-001",)), a)["issue"]
        for title in ("Pay by card", "Send an invoice", "See the bill"):
            slice_id = self.slice_in(a, "EPIC-002", title)
            issues[slice_id] = self.ready(slice_id, a)["issue"]
        self.factory(issues["SLICE-003"], "building")
        self.factory(issues["SLICE-004"], "question")
        self.factory(issues["SLICE-005"], "shipped")
        issues["SLICE-006"] = self.ready(self.slice_in(a, "EPIC-001", "Rename a teammate"), a)["issue"]
        body = self.issue(issues["SLICE-006"])["body"]
        self.change_issue(issues["SLICE-006"], body=body.replace("An admin cannot bring a colleague in.", "An admin cannot bring a friend in."))
        for slice_id in (self.slice_in(a, "EPIC-001", "Picture of the list"), self.slice_in(a, "EPIC-001", "Picture of the invite")):
            self.with_mock(a, slice_id)
            ready = self.ready(slice_id, a)
            issues[slice_id] = ready["issue"]
            if slice_id == "SLICE-008":
                self.commit_mocks(slice_id, ready["mocks"]["files"])
        self.slice_in(a, "EPIC-001", "A private draft")  # SLICE-009: never marked ready, so it is not on GitHub
        return issues

    def ben_spec(self, slice_id):
        return self.draft(self.b, self.ben_slice(slice_id)["spec_path"])

    def workspace(self, project):
        draft = project / ".factory/studio/draft"
        return {str(path.relative_to(draft)): path.read_bytes() for path in sorted(draft.rglob("*")) if path.is_file()}

    def statuses(self, project):
        return {row["slice_id"]: row for row in self.ok(project, "status")["slices"]}


class FreshCloneTest(JoinBase):
    def test_the_first_refresh_brings_the_whole_published_project_with_nothing_typed(self):
        issues = self.ada_publishes()
        git(self.b, "fetch", "-q", "origin")  # a fresh clone holds the main branch as it is now
        ben = self.ben()
        before = self.status(ben)
        self.assertIsNone(before["project"])
        self.assertEqual(before["github"]["connected"], True)
        self.assertEqual([action["kind"] for action in before["next_actions"]], ["join_project"])  # never "define the project"
        writes = len(self.writes())
        result = self.ok(ben, "refresh")
        joined = result["joined"]
        self.assertEqual(len(self.writes()), writes)  # nothing is written to GitHub by joining
        self.assertEqual(joined["taken"]["project"], True)
        self.assertEqual([epic["epic_id"] for epic in joined["taken"]["epics"]], ["EPIC-001", "EPIC-002"])
        self.assertEqual(sorted(row["slice_id"] for row in joined["taken"]["slices"]), [f"SLICE-00{n}" for n in range(1, 9)])
        self.assertEqual(joined["in_words"][0], "This repository's project is Team Space. MACH brought it in from GitHub: 2 epics and 8 slices, "
                                                "3 ready, 1 being built, 1 with a question from the builders, 1 shipped and 2 to approve again.")
        self.assertIn(ONLY_THERE, joined["in_words"])
        self.assertEqual(joined["only_on_their_computer"], ONLY_THERE)
        # Ben sees what Ada published, exactly: the same project, epics, slice texts, approvals and states.
        status = self.status(ben)
        self.assertEqual((status["project"]["name"], status["project"]["issue"]), ("Team Space", self.issues("mach:project")[0]["number"]))
        self.assertEqual([epic["epic_id"] for epic in status["epics"]], ["EPIC-001", "EPIC-002"])
        rows = {row["slice_id"]: row for row in status["slices"]}
        self.assertNotIn("SLICE-009", rows)
        progress = {slice_id: row["github"]["progress"] for slice_id, row in rows.items()}
        self.assertEqual(progress, {"SLICE-001": "ready_to_build", "SLICE-002": "ready_to_build", "SLICE-003": "being_built", "SLICE-004": "question",
                                    "SLICE-005": "shipped", "SLICE-006": "ready_for_approval", "SLICE-007": "ready_for_approval",
                                    "SLICE-008": "ready_to_build"})
        self.assertEqual(rows["SLICE-002"]["dependencies"], ["SLICE-001"])
        for slice_id in ("SLICE-001", "SLICE-002", "SLICE-005", "SLICE-008"):
            self.assertEqual((rows[slice_id]["status"], rows[slice_id]["editable"]), ("approved_for_engineering", False))
            self.assertEqual(self.draft(ben, rows[slice_id]["spec"]).read_bytes(), self.draft(self.a, f"specs/slices/{slice_id}-invite-teammate.md").read_bytes())
        ledger = self.ledger(ben)["slices"]
        self.assertEqual(ledger["SLICE-006"]["not_approved"]["why"], "edited")
        self.assertEqual(ledger["SLICE-007"]["not_approved"]["why"], "mocks")
        self.assertEqual(len(self.ben_slice("SLICE-008")["mocks"]), 1)
        self.assertNotIn("mocks", self.ben_slice("SLICE-007"))
        self.assertIn("SLICE-007", " ".join(joined["warned"]))  # the picture that is missing is named, the slice still taken
        self.assertEqual(ledger["SLICE-001"]["approved_by"], "ada-pm")
        # Running it again changes nothing, and reads no slice again.
        kept = self.workspace(ben)
        calls = len(self.gh()["calls"])
        again = self.ok(ben, "refresh")["joined"]
        self.assertEqual((again["taken"]["slices"], again["taken"]["epics"], again["updated"]), ([], [], []))
        self.assertEqual(self.workspace(ben), kept)
        # Refresh reads each slice's comments, as it always has; no slice's issue is read again to be taken.
        self.assertFalse([call for call in self.gh()["calls"][calls:] if call[:2] == ["issue", "view"] and "comments" not in call])
        self.assertEqual(len(self.writes()), writes)

    def test_project_init_in_a_repository_with_a_project_takes_it_and_asks_for_nothing(self):
        self.ada_publishes()
        result = self.ok(self.ben(), "project", "init", "--name", "Something else", "--vision", "Mine.", "--outcome", "Mine too")
        self.assertEqual(result["project"]["name"], "Team Space")
        self.assertIn("The words you gave were not used: a repository holds one project.", result["note"])
        self.assertIn("This repository's project is Team Space. MACH brought it in from GitHub: 2 epics and 8 slices", result["note"])
        self.assertEqual(len(self.statuses(self.b)), 8)

    def test_project_join_in_batches_then_once_more_finishes_it(self):
        """The app shows progress: a few slices at a time, `remaining` counting down, the last batch the whole refresh."""
        self.ada_publishes()
        ben = self.ben()
        first = self.ok(ben, "project", "join", "--batch", "3")
        self.assertEqual((first["taken"]["project"], len(first["taken"]["slices"]), first["remaining"]), (True, 3, 5))
        self.assertIn("5 slices still to bring in; MACH carries on.", first["note"])
        second = self.ok(ben, "project", "join", "--batch", "3")
        self.assertEqual((second["taken"]["project"], len(second["taken"]["slices"]), second["remaining"]), (False, 3, 2))
        last = self.ok(ben, "project", "join", "--batch", "3")
        self.assertEqual((len(last["taken"]["slices"]), last["remaining"]), (2, 0))
        self.assertEqual(len(self.statuses(ben)), 8)
        self.assertIsNotNone(self.status(ben)["github"]["last_read"])  # the last batch was the whole refresh


class KeepingInStepTest(JoinBase):
    def joined(self):
        self.project_and_epic(self.ada())
        self.ready(self.drafted(self.a), self.a)
        self.ok(self.ben(), "refresh")

    def ada_publishes_version_two(self):
        self.ok(self.ada(), "slice", "reopen", "SLICE-001")
        self.write_slice(self.a, "SLICE-001", extra="\nVersion two.\n")
        return self.ready("SLICE-001", self.a)

    def test_an_unchanged_copy_here_is_brought_to_the_newer_version(self):
        self.joined()
        self.ada_publishes_version_two()
        joined = self.ok(self.ben(), "refresh")["joined"]
        (row,) = joined["updated"]
        self.assertEqual((row["slice_id"], row["was_version"], row["state"]), ("SLICE-001", 1, "ready"))
        self.assertIn("Version two.", self.ben_spec("SLICE-001").read_text())
        self.assertEqual((self.ben_slice("SLICE-001")["status"], self.ledger(self.b)["slices"]["SLICE-001"]["revision"]), ("approved_for_engineering", 2))
        self.assertTrue(list((self.b / ".factory/studio/replaced").glob("SLICE-001-yours*")))
        self.assertIn("SLICE-001 is now the newer version someone else marked ready on GitHub", joined["note"])

    def test_a_draft_changed_here_is_kept(self):
        self.joined()
        self.ok(self.ben(), "slice", "reopen", "SLICE-001")
        self.ben_spec("SLICE-001").write_text(self.ben_spec("SLICE-001").read_text() + "\nBen's change.\n")
        self.ada_publishes_version_two()
        result = self.ok(self.ben(), "refresh")
        self.assertEqual(result["joined"]["updated"], [])
        self.assertIn("Ben's change.", self.ben_spec("SLICE-001").read_text())
        row = next(row for row in result["github"]["slices"] if row["slice_id"] == "SLICE-001")
        self.assertTrue(row["newer_elsewhere"])

    def test_a_slice_the_other_product_manager_publishes_arrives_at_the_next_refresh(self):
        self.joined()
        ben_slice = self.drafted(self.ben(), title="Remove a teammate")
        self.ready(ben_slice, self.b)
        joined = self.ok(self.ada(), "refresh")["joined"]
        self.assertEqual([row["slice_id"] for row in joined["taken"]["slices"]], [ben_slice])
        self.assertEqual(self.artifact(self.a, f"product/slices/{ben_slice}.json")["status"], "approved_for_engineering")
        self.assertIn(f"MACH brought in from GitHub what others published since: 1 slice ({ben_slice}; 1 ready).", joined["note"])

    def test_a_different_draft_here_under_the_same_number_is_renumbered(self):
        self.joined()
        ben_draft = self.drafted(self.ben(), title="Ben's own idea")  # SLICE-002, never marked ready
        self.ready(self.drafted(self.ada(), title="Remove a teammate"), self.a)  # Ada's SLICE-002, unaware of Ben's draft
        joined = self.ok(self.ben(), "refresh")["joined"]
        self.assertEqual(ben_draft, "SLICE-002")
        self.assertIn("Your draft SLICE-002 is now SLICE-003, so #", joined["note"])
        self.assertEqual(self.ben_slice("SLICE-003")["title"], "Ben's own idea")
        self.assertEqual(self.ben_slice("SLICE-002")["title"], "Remove a teammate")


class WhenThereIsNothingToTakeTest(JoinBase):
    def test_github_unreachable_at_start_changes_nothing_says_so_and_is_tried_again(self):
        self.ada_publishes()
        ben = self.ben()
        self.gh_fails("issue list", once=False)
        result = self.ok(ben, "refresh")
        self.assertEqual((result["joined"]["joined"], result["refreshed"]), (False, False))
        self.assertIn(NETWORK_DOWN.split(".")[0], result["joined"]["note"])
        self.assertIn("Nothing here was changed.", result["joined"]["note"])
        self.assertFalse((ben / ".factory/studio/draft/product/project.json").exists())
        status = self.status(ben)
        self.assertTrue(status["saved"]["github_check"]["text"].startswith("MACH could not check GitHub at "))
        self.assertEqual([action["kind"] for action in status["next_actions"]], ["join_project"])  # never "define the project"
        state = self.gh()
        state["fail"], state["fail_once"] = {}, []
        self.gh_state.write_text(json.dumps(state))
        self.assertTrue(self.ok(ben, "refresh")["joined"]["taken"]["project"])
        self.assertIsNone(self.status(ben)["saved"]["github_check"])

    def test_github_holds_no_project_so_the_ways_to_start_are_offered(self):
        ben = self.ben()
        joined = self.ok(ben, "refresh")["joined"]
        self.assertEqual((joined["joined"], joined["project"]), (False, None))
        self.assertEqual(joined["note"], "GitHub holds no project for this repository yet, so there is nothing to bring in.")
        self.assertEqual([action["kind"] for action in self.status(ben)["next_actions"]], ["define_project"])

    def test_a_repository_with_no_origin(self):
        ben = self.ben()
        subprocess.run(["git", "remote", "remove", "origin"], cwd=str(ben), check=True)
        status = self.status(ben)
        self.assertEqual((status["github"]["connected"], [a["kind"] for a in status["next_actions"]]), (False, ["define_project"]))
        joined = self.ok(ben, "refresh")["joined"]
        self.assertEqual((joined["joined"], joined["github"]["connected"]), (False, False))

    def test_two_project_issues_take_the_oldest_and_say_so(self):
        self.ada_publishes()
        first = self.issues("mach:project")[0]["number"]
        second = self.second_project_issue()
        joined = self.ok(self.ben(), "refresh")["joined"]
        self.assertEqual(joined["project"]["issue"], first)
        self.assertIn(f"This repository has more than one project issue on GitHub (#{first} and #{second}). A repository holds one project, so MACH "
                      f"used #{first}, the oldest one MACH can read.", joined["note"])
        self.assertEqual(joined["extra_issues"], [second])
