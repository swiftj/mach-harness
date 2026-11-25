"""Two product managers, each on their own computer and clone, sharing one GitHub repository (M20 A3, A4).

Began as the team audit's reproductions; each now states what a team needs and passes. Drafts stay private until a
slice is marked ready, so what is shared is checked where it becomes shared: an ID made twice at the same moment
(T6, T7), and the project's and epics' own text, which a second product manager's workspace never writes over (T5).

Uses the GitHub stand-in of test_mach_product_issues: one shared bare repository, the clones `a` (Ada) and `b` (Ben),
and gh's state in one JSON file. Which account gh is signed in as is switched with set_gh(me=...). "At the same
moment" is stood in for by hiding the other's new issues from one read of GitHub (Handoff.read); the look-again
after creating an issue is a read of its own, and sees them.
"""

import contextlib
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "studio" / "scripts"))
from test_mach_product_issues import REPO, IssuesBase  # noqa: E402
import handoff  # noqa: E402
import issue_rules  # noqa: E402
import test_mach_product_prd as prd_tests  # noqa: E402


def url(number):
    return f"https://github.com/{REPO}/issues/{number}"


class TwoProductManagers(IssuesBase):
    def ada(self):
        self.set_gh(me="ada-pm")
        return self.a

    def ben(self):
        self.set_gh(me="ben-pm")
        return self.b

    def ada_ships_first_slice(self):
        """Ada sets up the project and EPIC-001 and marks SLICE-001 ready."""
        self.project_and_epic(self.ada())
        self.drafted(self.a)
        return self.ready("SLICE-001", self.a)["issue"]

    def ben_starts_the_same_project(self, vision="Teams work together.", criterion="Only invited people can join"):
        """Ben, on his own computer, started the same project (same ID) and the same-named epic before anything Ada saved was on
        GitHub, and has not refreshed since: his workspace is private, so it started empty. (Started once Ada's issues are there,
        Product Studio brings her project in instead: test_studio_join.)"""
        project = self.ben()
        with self.hidden({item["number"] for item in self.issues()}):
            self.ok(project, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", vision, "--outcome", "Teams can work together")
        self.ok(project, "epic", "add", "--title", "Team membership", "--criterion", criterion)
        return project

    def slice_issues_for(self, slice_id):
        return [i for i in self.issues("mach:slice") if (issue_rules.parse_slice_body(i["body"]) or {}).get("slice_id") == slice_id and i["state"] == "OPEN"]

    @contextlib.contextmanager
    def hidden(self, numbers):
        """Every read of GitHub's project, epic and slice issues in the block (Handoff.read, and the one reader of the project as
        GitHub holds it) misses these issues: they were made a moment after it read GitHub."""
        real_snapshot = handoff.Handoff.snapshot_of

        def before_they_were_made(self_, found):
            snapshot = real_snapshot(self_, found)
            return {key: [item for item in value if item["number"] not in numbers] for key, value in snapshot.items()}

        with mock.patch.object(handoff.Handoff, "snapshot_of", before_they_were_made):
            yield

    @contextlib.contextmanager
    def look_again_missed(self):
        """The look-again after making an issue missed the other's too (GitHub's list was a moment behind)."""
        with mock.patch.object(handoff.Handoff, "earlier_open", lambda *args, **kwargs: (None, None)):
            yield

    def refused_app(self, project, *argv):
        code, out, err = self.run_studio(project, "--app", *argv)
        self.assertEqual(code, 1, out)
        hint = next((json.loads(line[len("refused-hint: "):]) for line in err.splitlines() if line.startswith("refused-hint: ")), None)
        return err, hint

    def status(self, project):
        return self.ok(project, "status")

    def ben_slice(self, slice_id):
        return self.artifact(self.b, f"product/slices/{slice_id}.json")

    def second_project_issue(self):
        """Someone made a second project issue by hand, beside Ada's."""
        state = self.gh()
        first = self.issues("mach:project")[0]
        number = state.get("next_number", 1)
        state["next_number"] = number + 1
        state["issues"][str(number)] = {**json.loads(json.dumps(first)), "number": number, "id": 9000 + number, "comments": [], "events": [], "pinned": False}
        self.gh_state.write_text(json.dumps(state))
        return number


class SliceNumberTest(TwoProductManagers):
    def test_the_same_next_number_is_caught_at_ready_and_renumbered(self):
        """One after the other: Ben, who never refreshed, gets SLICE-001 as well. Never blocked: marking it ready gives his draft
        the next free number, SLICE-002, before anything is written, and marks it ready under that number in the same act."""
        self.ada_ships_first_slice()
        ben = self.ben_starts_the_same_project()
        self.assertEqual(self.drafted(ben, title="Remove a teammate"), "SLICE-001")  # allocated from what this computer can see
        result = self.ready("SLICE-001", ben)
        self.assertEqual((result["saved_to"], result["slice"]["slice_id"], result["renumbered"]),
                         ("github", "SLICE-002", [{"from": "SLICE-001", "to": "SLICE-002"}]))
        self.assertIn("SLICE-001 was already used on GitHub by another slice", result["note"])
        self.assertEqual(len(self.slice_issues_for("SLICE-001")), 1)
        self.assertEqual(len(self.slice_issues_for("SLICE-002")), 1)

    def test_two_ready_at_the_same_moment_the_later_is_closed_and_carried_on(self):
        """At the same moment: both read GitHub before either wrote, so both make an issue holding SLICE-001. Ben's look-again
        finds Ada's, which GitHub made first: his is closed before it carries an approval or mach:ready. Never blocked: in the same
        act his draft gets the next free number and is marked ready under it, and he is told who holds SLICE-001 and which issue."""
        ada_issue = self.ada_ships_first_slice()
        ben = self.ben_starts_the_same_project()
        self.drafted(ben, title="Remove a teammate")
        with self.hidden({ada_issue}):
            code, out, err = self.run_studio(ben, "--app", "slice", "ready", "SLICE-001")
        self.assertEqual(code, 0, err)
        result = json.loads(out)
        (ben_issue,) = [i for i in self.issues() if i["title"] == "Remove a teammate" and i["state"] == "CLOSED"]
        self.assertIn(f"SLICE-001 was marked ready at the same moment by someone else: @ada-pm's issue #{ada_issue} was made first and keeps the number. "
                      f"MACH closed yours, #{ben_issue['number']}, before it was marked ready, so nothing reached the builders twice. "
                      "MACH gave your draft the next free number: SLICE-001 is now SLICE-002.", result["note"])
        self.assertNotIn("slice renumber", result["note"])  # the app's wording names no command
        # Ben's first issue: closed, no MACH label, no approval; a fixed comment says which issue keeps the number.
        self.assertEqual(self.labels_of(ben_issue["number"]), [])
        (comment,) = ben_issue["comments"]
        self.assertTrue(comment["body"].startswith(f"<!-- mach:closed slice=SLICE-001 kept=#{ada_issue} -->\nMACH Product Studio closed this issue."))
        self.assertEqual([i["number"] for i in self.slice_issues_for("SLICE-001")], [ada_issue])
        (now,) = self.slice_issues_for("SLICE-002")
        self.assertIn("mach:ready", self.labels_of(now["number"]))
        self.assertEqual((result["issue"], self.ben_slice("SLICE-002")["status"]), (now["number"], "approved_for_engineering"))
        # Nothing is left for Ben to do about it, and Ada is not asked to do anything.
        self.assertNotIn("renumber_slice", [a["kind"] for a in self.status(ben)["next_actions"]])
        self.assertNotIn("renumber_slice", [a["kind"] for a in self.status(self.ada())["next_actions"]])

    def test_a_moment_missed_at_ready_is_found_by_either_refresh(self):
        """The look-again itself missed Ada's issue, so two open issues hold SLICE-001, both marked ready. Ada's refresh says
        hers keeps the number; Ben's refresh says the same and closes his own (the builders have not taken it). Marking it ready
        again gives it the next free number."""
        ada_issue = self.ada_ships_first_slice()
        ben = self.ben_starts_the_same_project()
        self.drafted(ben, title="Remove a teammate")
        with self.hidden({ada_issue}), self.look_again_missed():
            ben_issue = self.ready("SLICE-001", ben)["issue"]
        self.assertEqual(len(self.slice_issues_for("SLICE-001")), 2)
        (clash,) = self.ok(self.ada(), "refresh")["github"]["same_id_twice"]
        self.assertEqual((clash["kind"], clash["id"], clash["kept"], clash["others"], clash["yours"]), ("slice", "SLICE-001", ada_issue, [ben_issue], "kept"))
        self.assertEqual(clash["urls"], {str(ada_issue): url(ada_issue), str(ben_issue): url(ben_issue)})
        self.assertIn(f"SLICE-001 is held by more than one open issue on GitHub: #{ada_issue} was made first, then #{ben_issue}. Yours is #{ada_issue}", clash["note"])
        (clash,) = self.ok(self.ben(), "refresh")["github"]["same_id_twice"]
        self.assertEqual(clash["yours"], "closed")
        self.assertIn("Yours was made later, so MACH closed it: mark it ready again, and MACH gives it the next free number.", clash["note"])
        self.assertEqual((self.issue(ben_issue)["state"], self.labels_of(ben_issue)), ("CLOSED", []))
        self.assertEqual(self.ben_slice("SLICE-001")["status"], "ready_for_approval")
        first = self.status(ben)["next_actions"][0]
        self.assertEqual((first["kind"], first["target"]), ("renumber_slice", "SLICE-001"))
        self.assertIn("Mark it ready again: MACH gives it the next free number.", first["reason"])
        self.assertEqual([i["number"] for i in self.slice_issues_for("SLICE-001")], [ada_issue])
        self.assertEqual(self.ready("SLICE-001", ben)["slice"]["slice_id"], "SLICE-002")

    def test_a_later_duplicate_the_builders_took_is_reported_not_closed(self):
        """Missed at ready, and the builders already took Ben's issue: refresh tells him so and leaves the issue alone; the merge of
        the builders' work settles it."""
        ada_issue = self.ada_ships_first_slice()
        ben = self.ben_starts_the_same_project()
        self.drafted(ben, title="Remove a teammate")
        with self.hidden({ada_issue}), self.look_again_missed():
            ben_issue = self.ready("SLICE-001", ben)["issue"]
        self.change_issue(ben_issue, labels=self.issue(ben_issue)["labels"] + [{"name": "mach:building"}])
        (clash,) = self.ok(self.ben(), "refresh")["github"]["same_id_twice"]
        self.assertEqual(clash["yours"], "taken_by_builders")
        self.assertIn("the builders have already started on it, so MACH left it open", clash["note"])
        self.assertNotIn("tell the engineer", clash["note"])
        self.assertEqual(self.issue(ben_issue)["state"], "OPEN")


class EpicNumberTest(TwoProductManagers):
    def test_an_epic_number_used_for_a_different_epic_is_given_the_next_free_number(self):
        """One after the other: the same EPIC-001 with another title. Never blocked: the epic gets the next free number before
        anything is written, and the slice is marked ready under it in the same act."""
        self.ada_ships_first_slice()
        ben = self.ben()
        with self.hidden({i["number"] for i in self.issues()}):  # Ben started before Ada's issues were there, and has not refreshed since
            self.ok(ben, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together")
        self.ok(ben, "epic", "add", "--title", "Billing", "--criterion", "Invoices are sent")
        self.drafted(ben, title="Send an invoice")
        self.ok(ben, "slice", "renumber", "SLICE-001")
        result = self.ready("SLICE-002", ben)
        self.assertIn("EPIC-001 was already used on GitHub by another epic", result["note"])
        self.assertIn("MACH gave your epic the next free number: EPIC-001 is now EPIC-002.", result["note"])
        self.assertEqual((result["saved_to"], self.ben_slice("SLICE-002")["epic_id"]), ("github", "EPIC-002"))
        self.assertEqual(sorted(i["title"] for i in self.issues("mach:epic")), ["Billing", "Team membership"])

    def test_an_epic_number_taken_at_the_same_moment_for_another_epic(self):
        """At the same moment: Ben's EPIC-001 ("Billing") is made a moment after Ada's ("Team membership"). His look-again finds
        hers: his epic's issue is closed before any slice is made under it. Never blocked: his epic gets the next free number and
        the slice is marked ready under it, in the same act, with nothing left to do about it."""
        self.ada_ships_first_slice()
        ada_epic = self.issues("mach:epic")[0]["number"]
        ben = self.ben()
        with self.hidden({i["number"] for i in self.issues()}):  # Ben started before Ada's issues were there, and has not refreshed since
            self.ok(ben, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "x", "--outcome", "y")
        self.ok(ben, "epic", "add", "--title", "Billing", "--criterion", "Invoices are sent")
        self.drafted(ben, title="Send an invoice")
        self.ok(ben, "slice", "renumber", "SLICE-001")
        with self.hidden({ada_epic}):
            result = self.ready("SLICE-002", ben)
        (ben_epic,) = [i for i in self.issues() if i["title"] == "Billing" and i["state"] == "CLOSED"]
        self.assertIn(f"EPIC-001 was saved at the same moment by someone else, for a different epic: their issue #{ada_epic} was made first and keeps "
                      f"the number. MACH closed yours, #{ben_epic['number']}. MACH gave your epic the next free number: EPIC-001 is now EPIC-002.",
                      result["note"])
        self.assertEqual(self.labels_of(ben_epic["number"]), [])
        self.assertEqual((result["saved_to"], self.ben_slice("SLICE-002")["status"], self.ben_slice("SLICE-002")["epic_id"]),
                         ("github", "approved_for_engineering", "EPIC-002"))
        status = self.status(ben)
        self.assertEqual([e["same_moment"] for e in status["epics"]], [None])
        self.assertNotIn("renumber_epic", [a["kind"] for a in status["next_actions"]])
        self.assertEqual(status["approvals_withdrawn"], [])
        self.assertIsNone(self.status(self.ada())["epics"][0]["same_moment"])
        self.assertEqual(sorted(i["title"] for i in self.issues("mach:epic")), ["Billing", "Team membership"])


class SharedProjectAndEpicTest(TwoProductManagers):
    def test_a_second_product_managers_project_text_is_taken_not_written(self):
        """Ben defined the project before Ada's issue existed, with his own vision. His first `slice ready` finds Ada's project
        issue: it is not rewritten; his workspace takes her text, and he is told."""
        self.project_and_epic(self.ada())
        self.drafted(self.a)
        ben = self.ben_starts_the_same_project(vision="A different vision Ben typed.")
        self.assertEqual(self.artifact(ben, "product/project.json")["vision"], "A different vision Ben typed.")  # GitHub had no project yet
        self.ready("SLICE-001", self.ada())
        project_issue = self.issues("mach:project")[0]["number"]
        before = self.issue(project_issue)["body"]
        self.drafted(ben, title="Remove a teammate")
        self.ok(self.ben(), "slice", "renumber", "SLICE-001")
        result = self.ready("SLICE-002", ben)
        self.assertEqual(result["project_issue"], project_issue)
        self.assertEqual(self.issue(project_issue)["body"], before)
        self.assertEqual(self.artifact(ben, "product/project.json")["vision"], "Teams work together.")
        (note,) = result["shared_text"]
        self.assertEqual((note["target"], note["taken"]), ("project", True))
        self.assertEqual(note["note"], f"The project on GitHub (#{project_issue}) holds text someone else wrote. MACH took it into your workspace "
                                       "instead of writing yours over it.")

    def test_a_second_product_managers_epic_criteria_are_taken_not_written(self):
        """The same for an epic: Ben's own criteria for the same EPIC-001 never replace Ada's on GitHub."""
        self.project_and_epic(self.ada())
        self.drafted(self.a)
        ben = self.ben_starts_the_same_project(criterion="Anyone with the link can join")
        self.ready("SLICE-001", self.ada())
        epic_issue = self.issues("mach:epic")[0]["number"]
        self.drafted(ben, title="Remove a teammate")
        self.ok(self.ben(), "slice", "renumber", "SLICE-001")
        result = self.ready("SLICE-002", ben)
        self.assertEqual(len(self.issues("mach:epic")), 1)
        self.assertIn("Only invited people can join", self.issue(epic_issue)["body"])
        self.assertNotIn("Anyone with the link", self.issue(epic_issue)["body"])
        self.assertEqual(self.artifact(ben, "product/epics/EPIC-001.json")["acceptance_criteria"], ["Only invited people can join"])
        self.assertIn(("EPIC-001", True), [(note["target"], note.get("taken")) for note in result["shared_text"]])

    def test_a_project_changed_on_both_sides_waits_for_a_choice(self):
        """Ada and Ben both hold the project. Ada changes its vision and marks a slice ready again: hers is written, since GitHub
        held what she last saw. Ben changed his too: refresh says someone else changed the project, his `slice ready` leaves
        GitHub's as it is, and reconcile applies: mine is written by his next `slice ready`."""
        self.ada_ships_first_slice()
        project_issue = self.issues("mach:project")[0]["number"]
        ben = self.ben()
        self.ok(ben, "project", "init", "--name", "x", "--vision", "y", "--outcome", "z")  # brings Ada's project in: Ben has seen its text
        self.ok(self.ada(), "project", "set", "--vision", "Teams of any size work together.")
        self.ready("SLICE-001", self.a)
        self.assertIn("Teams of any size work together.", self.issue(project_issue)["body"])
        self.ok(self.ben(), "project", "set", "--vision", "Small teams work together.")
        refreshed = self.ok(ben, "refresh")
        (changed,) = refreshed["github"]["changed_elsewhere"]
        self.assertEqual((changed["target"], changed["issue"], changed["theirs"]["vision"]), ("project", project_issue, "Teams of any size work together."))
        status = self.status(ben)
        self.assertEqual(status["project"]["changed_elsewhere"]["target"], "project")
        first = status["next_actions"][0]
        self.assertEqual((first["kind"], first["target"]), ("reconcile", "project"))
        self.assertEqual(first["reason"], "Someone else changed the project on GitHub since you last saw it, and your copy here is different. Choose yours or theirs.")
        self.assertEqual(self.drafted(ben, title="Remove a teammate"), "SLICE-002")  # refreshed, so GitHub's SLICE-001 is not given out
        code, out, err = self.run_studio(ben, "--app", "slice", "ready", "SLICE-002")
        self.assertEqual(code, 0, err)
        (note,) = json.loads(out)["shared_text"]
        self.assertEqual(note["note"], "Someone else changed the project on GitHub since you last saw it, so your copy was not written there. Choose yours or theirs.")
        self.assertIn("Teams of any size work together.", self.issue(project_issue)["body"])
        self.assertEqual(self.ok(ben, "reconcile", "project", "--take", "mine")["note"],
                         "Your copy of the project stays as it is. MACH writes it to GitHub the next time you mark a slice ready.")
        self.ready("SLICE-002", ben)
        self.assertIn("Small teams work together.", self.issue(project_issue)["body"])
        self.assertEqual(self.ok(ben, "refresh")["github"]["changed_elsewhere"], [])

    def test_an_epic_changed_on_both_sides_takes_theirs_on_request(self):
        """The same for an epic's criteria, with theirs chosen: Ben's workspace takes Ada's criteria and GitHub is left alone.
        With nothing of his own unwritten, a refresh takes Ada's next change by itself."""
        self.ada_ships_first_slice()
        epic_issue = self.issues("mach:epic")[0]["number"]
        ben = self.ben_starts_the_same_project()
        self.ok(ben, "refresh")
        self.ok(self.ada(), "epic", "set", "EPIC-001", "--criterion", "Only invited people can join", "--criterion", "An invitation can be withdrawn")
        self.ready("SLICE-001", self.a)
        self.ok(self.ben(), "epic", "set", "EPIC-001", "--criterion", "Only admins invite")
        (changed,) = self.ok(ben, "refresh")["github"]["changed_elsewhere"]
        self.assertEqual((changed["target"], changed["issue"]), ("EPIC-001", epic_issue))
        self.assertEqual(self.ok(ben, "reconcile", "EPIC-001", "--take", "theirs")["note"], "Your copy of EPIC-001 now is the version from GitHub.")
        self.assertEqual(self.artifact(ben, "product/epics/EPIC-001.json")["acceptance_criteria"],
                         ["Only invited people can join", "An invitation can be withdrawn"])
        self.assertIn("EPIC-001 has no change on GitHub to choose from.", self.refused(ben, "reconcile", "EPIC-001", "--take", "theirs"))
        # Ada changes it again; Ben has nothing unwritten, so his refresh takes it.
        self.ok(self.ada(), "epic", "set", "EPIC-001", "--criterion", "Only invited people can join")
        self.ready("SLICE-001", self.a)
        refreshed = self.ok(self.ben(), "refresh")
        self.assertEqual(refreshed["github"]["changed_elsewhere"], [])
        self.assertIn("EPIC-001", [note["target"] for note in refreshed["github"]["text_taken"]])
        self.assertEqual(self.artifact(ben, "product/epics/EPIC-001.json")["acceptance_criteria"], ["Only invited people can join"])


class OneProjectTest(TwoProductManagers):
    def test_project_init_takes_the_project_already_on_github(self):
        """Ben starts the project with his own words; the repository already has Ada's, so MACH brings hers in, with its epics and
        slices, and his words are not used."""
        ada_issue = self.ada_ships_first_slice()
        project_issue = self.issues("mach:project")[0]["number"]
        result = self.ok(self.ben(), "project", "init", "--id", "teamspace", "--name", "Teamspace", "--vision", "Mine.", "--outcome", "Mine too")
        self.assertEqual(result["taken_from_github"], project_issue)
        self.assertEqual({key: result["project"][key] for key in ("project_id", "name", "vision", "outcomes")},
                         {"project_id": "team-space", "name": "Team Space", "vision": "Teams work together.", "outcomes": ["Teams can work together"]})
        self.assertTrue(result["note"].startswith(f"This repository already has a project on GitHub (#{project_issue}), so MACH brought it in from "
                                                  "there. The words you gave were not used: a repository holds one project."), result["note"])
        self.assertEqual([row["slice_id"] for row in result["taken"]["slices"]], ["SLICE-001"])
        self.drafted(self.b, title="Remove a teammate")
        self.ready("SLICE-002", self.b)
        self.assertEqual(len(self.issues("mach:project")), 1)
        self.assertEqual(len(self.issues("mach:epic")), 1)
        self.assertEqual(len(self.slice_issues_for("SLICE-001")), 1)
        self.assertEqual(self.slice_issues_for("SLICE-001")[0]["number"], ada_issue)

    def test_status_says_a_project_is_on_github_before_the_product_is_named(self):
        """Before Ben names the product, status says (from his last refresh, without reading GitHub) that the repository already has
        a project, with its issue, address and name. Before any refresh it says nothing."""
        self.ada_ships_first_slice()
        project_issue = self.issues("mach:project")[0]["number"]
        ben = self.ben()
        self.assertIsNone(self.status(ben)["project_on_github"])
        self.ok(ben, "refresh")
        calls = len(self.gh()["calls"])
        found = self.status(ben)["project_on_github"]
        self.assertEqual(len(self.gh()["calls"]), calls)  # status reads only the record
        self.assertEqual({key: found[key] for key in ("issue", "url", "name", "readable")},
                         {"issue": project_issue, "url": url(project_issue), "name": "Team Space", "readable": True})
        marker = self.issue(project_issue)["body"].splitlines()[0]
        self.change_issue(project_issue, body=marker + "\nEdited by hand.\n")  # still MACH's project issue, its text no longer in MACH's form
        self.ok(ben, "refresh")
        found = self.status(ben)["project_on_github"]
        self.assertEqual((found["issue"], found["name"], found["readable"]), (project_issue, None, False))

    def test_several_project_issues_are_a_warning_and_closing_one_is_offered(self):
        """Two open project issues. Never blocked: project init takes the oldest, marking ready carries on with the one this
        workspace follows, both say so first and offer to close the other on the product manager's word, and refresh reports them."""
        self.ada_ships_first_slice()
        first = self.issues("mach:project")[0]["number"]
        second = self.second_project_issue()
        named = f"(#{first} and #{second})"
        result = self.ok(self.ben(), "project", "init", "--id", "team-space", "--name", "x", "--vision", "y", "--outcome", "z")
        self.assertEqual(result["taken_from_github"], first)
        self.assertIn(f"This repository has more than one project issue on GitHub {named}. A repository holds one project, so MACH used #{first}, "
                      f"the oldest one MACH can read. Closing #{second} changes nothing in your work", result["note"])
        self.assertIn(f"MACH can close #{second} for you (project close-issue {second}).", result["note"])
        self.drafted(self.ada(), title="Remove a teammate")
        ready = self.ready("SLICE-002", self.a)
        self.assertIn(f"so MACH used #{first}, the one this workspace already follows.", ready["note"])
        self.assertEqual((ready["project_issue"], len(self.slice_issues_for("SLICE-002"))), (first, 1))
        clashes = self.ok(self.ada(), "refresh")["github"]["same_id_twice"]
        self.assertIn({"kind": "project", "others": [first, second], "urls": {str(first): url(first), str(second): url(second)}},
                      [{key: c[key] for key in ("kind", "others", "urls")} for c in clashes])
        self.assertIsNone(self.status(self.a)["project_on_github"])  # two: none is the project MACH would take
        # The product manager's one yes: MACH closes the other, and the warning is gone.
        closed = self.ok(self.a, "project", "close-issue", str(second))
        self.assertEqual((closed["closed"], closed["kept"]), (second, first))
        self.assertEqual((self.issue(second)["state"], self.labels_of(second)), ("CLOSED", []))
        self.assertIn("MACH Product Studio closed this issue on a product manager's word.", self.issue(second)["comments"][-1]["body"])
        self.drafted(self.a, title="Rename a teammate")
        self.assertNotIn("warned", self.ready("SLICE-003", self.a))
        self.assertIn("is not an open project issue", self.refused(self.a, "project", "close-issue", str(second)))


    def test_two_first_readies_at_once_leave_one_project_and_one_epic(self):
        """The first `project init` and ready done by two people at once: Ben's project and epic issues are made a moment after
        Ada's. His look-again finds hers: his are closed, his slice goes under her epic, and his workspace takes her text.
        (The audit pinned two project issues and two epics here, the defect itself; the assertion now states the fix.)"""
        self.project_and_epic(self.ada())
        self.drafted(self.a)
        ben = self.ben_starts_the_same_project(vision="Ben's own vision.")
        self.drafted(ben, title="Remove a teammate")
        self.ok(ben, "slice", "renumber", "SLICE-001")
        self.ready("SLICE-001", self.ada())
        ada_issues = {i["number"] for i in self.issues()}
        self.ben()
        with self.hidden(ada_issues):
            result = self.ready("SLICE-002", ben)
        (project,), (epic,) = self.issues("mach:project"), self.issues("mach:epic")
        self.assertEqual({project["number"], epic["number"]} <= ada_issues, True)
        self.assertEqual((result["project_issue"], result["epic_issue"]), (project["number"], epic["number"]))
        self.assertIn("Teams work together.", project["body"])
        closed = [i for i in self.issues() if i["state"] == "CLOSED"]
        self.assertEqual(sorted(i["title"] for i in closed), ["Team Space", "Team membership"])
        self.assertTrue(all(i["comments"][0]["body"].startswith("<!-- mach:closed ") for i in closed))
        self.assertEqual(self.artifact(ben, "product/project.json")["vision"], "Teams work together.")
        self.assertEqual(issue_rules.parse_slice_body(self.slice_issues_for("SLICE-002")[0]["body"])["epic"], epic["number"])


class PrdNumbersTest(TwoProductManagers):
    def test_prd_apply_reads_the_numbers_on_github_first(self):
        """Ben never refreshed; GitHub holds Ada's SLICE-001. `prd apply` reads GitHub's numbers before it numbers his drafts,
        so his first draft is SLICE-002, not a second SLICE-001."""
        self.ada_ships_first_slice()
        ben = self.ben()
        self.ok(ben, "project", "init", "--id", "team-space", "--name", "x", "--vision", "y", "--outcome", "z")
        prd_file = self.root / "team-space.md"
        prd_file.write_text(prd_tests.PRD_TEXT, encoding="utf-8")
        self.ok(ben, "prd", "import", str(prd_file))
        map_file = self.root / "map.json"
        map_file.write_text(json.dumps(prd_tests.MAP), encoding="utf-8")
        self.ok(ben, "prd", "map", "PRD-01", "--from", str(map_file))
        self.ok(ben, "prd", "settle", "PRD-01", "--section", "1", "--as", "slice:M1")
        self.ok(ben, "prd", "settle", "PRD-01", "--section", "4", "--as", "out-of-scope", "--reason", "Billing belongs to the finance team.")
        self.ok(ben, "prd", "settle", "PRD-01", "--section", "5", "--as", "later")
        applied = self.ok(ben, "prd", "apply", "PRD-01")
        self.assertEqual(applied["numbers_from_github"], {"checked": True, "problem": None})
        self.assertEqual((applied["made"]["epics"], applied["made"]["slices"]), (["EPIC-002"], ["SLICE-002", "SLICE-003"]))


class TextPlanTest(unittest.TestCase):
    """The rule for the project's and epics' own text, on its own."""

    def test_the_rule(self):
        plan = handoff.text_plan
        self.assertEqual(plan("a", "b", "b", None), "same")
        self.assertEqual(plan(None, "mine", "theirs", None), "take")  # never saw it: GitHub's is taken
        self.assertEqual(plan("mine", "mine", "theirs", None), "take")  # nothing here unwritten
        self.assertEqual(plan("theirs", "mine", "theirs", None), "write")  # only this workspace changed it
        self.assertEqual(plan("old", "mine", "theirs", None), "changed")  # both changed
        self.assertEqual(plan("old", "mine", None, "raw:x"), "changed")  # GitHub's is not in MACH's form
        self.assertEqual(plan("raw:x", "mine", None, "raw:x"), "write")  # the product manager kept theirs out: mine is written

    def test_the_text_is_read_back_as_written(self):
        body = issue_rules.project_issue_body("team-space", "  Teams   work together. ", ["One", "Two"])
        self.assertEqual(handoff.parse_project_text({"title": "Team Space", "body": body}),
                         {"name": "Team Space", "vision": "Teams work together.", "outcomes": ["One", "Two"]})
        body = issue_rules.epic_issue_body("EPIC-001", ["Only invited people join"], [(7, "SLICE-001", False)])
        self.assertEqual(handoff.parse_epic_text({"title": "Members", "body": body}), {"title": "Members", "acceptance_criteria": ["Only invited people join"]})
        self.assertIsNone(handoff.parse_project_text({"title": "x", "body": "edited by hand"}))


if __name__ == "__main__":
    unittest.main()
