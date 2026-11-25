"""M21 C, completed from GitHub: `project export` on a computer that is not the author's.

Ada (clone `a`) builds the project and marks its slices ready on the GitHub stand-in of test_mach_product_issues. Ben (clone
`b`) is a second computer on the same repository: his Product Studio workspace starts empty. Export there must take what
GitHub holds by itself, in one command, without asking and without changing Ben's workspace; say where every part came from;
list what GitHub holds that the archive lacks, with why; and say that work never marked ready lives only on Ada's computer.
What it makes must import with the existing importer.
"""

import hashlib
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "studio" / "scripts"))
from mock_pictures import png  # noqa: E402
from test_mach_product_issues import ADDRESS, IssuesBase, git  # noqa: E402
import issue_rules  # noqa: E402
import project_archive  # noqa: E402
import join as join_module  # noqa: E402
import project_export  # noqa: E402
import studio  # noqa: E402

FROM_GITHUB = project_export.FROM_GITHUB_NOTE


def tree(folder):
    return {path.relative_to(folder).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(folder.rglob("*")) if path.is_file() and not path.is_symlink()}


class GitHubBase(IssuesBase):
    def setUp(self):
        super().setUp()
        self.out = self.root / "out"
        self.out.mkdir()

    def picture(self, name, data):
        path = self.root / "files" / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(data)
        return str(path)

    def published(self, with_mock=False, principles=True):
        """Ada's project on GitHub: EPIC-001 with SLICE-001 and SLICE-002 (which depends on it), EPIC-002 with SLICE-003, all marked
        ready; principles and a technical need published; SLICE-004 a draft never marked ready, only on Ada's computer."""
        a = self.a
        self.project_and_epic(a)
        self.ok(a, "epic", "add", "--title", "Bulk invites", "--criterion", "A whole team joins at once")
        self.drafted(a)
        self.drafted(a, title="Remove a teammate", depends=["SLICE-001"])
        third = self.ok(a, "slice", "new", "--epic", "EPIC-002", "--title", "Invite a list of people")["slice"]["slice_id"]
        self.write_slice(a, third)
        if with_mock:
            self.mock = self.ok(a, "slice", "mock", "add", "SLICE-002", self.picture("form.png", png()), "--for", "AC-01")["mock"]
        for slice_id in ("SLICE-001", "SLICE-002", third):
            self.ready(slice_id)
        self.drafted(a, title="Only on Ada's computer")
        if principles:
            self.ok(a, "principle", "add", "--title", "Versions stay", "--statement", "A published version MUST NOT be edited in place.", "--reason", "Trust.")
            self.ok(a, "principle", "publish")
        self.ok(a, "need", "add", "--kind", "people", "--statement", "About forty teams use it in its first year.", "--why", "It sets the size.")
        self.ok(a, "need", "publish")
        self.ok(a, "refresh")

    def commit_mocks(self, slice_id):
        """Ada commits the ready folder's pictures to main, as the hand-off tells her to; Ben's copy fetches."""
        folder = self.draft(self.a, f"product/ready/{slice_id}/mocks")
        target = self.eng / "product/ready" / slice_id / "mocks"
        target.mkdir(parents=True, exist_ok=True)
        for path in folder.iterdir():
            (target / path.name).write_bytes(path.read_bytes())
        git(self.eng, "add", "-A")
        git(self.eng, "commit", "-q", "-m", f"design mocks for {slice_id}")
        git(self.eng, "push", "-q", "origin", "main")
        git(self.b, "fetch", "-q", "origin")

    def export(self, project, only_mine=False, out="default"):
        return project_export.export(studio, studio.Studio(project), self.out if out == "default" else out, only_mine)

    def refused_export(self, project, **kwargs):
        with self.assertRaises(studio.StudioError) as caught:
            self.export(project, **kwargs)
        message = str(caught.exception)
        self.assertTrue(message.endswith("Nothing was changed."), message)
        return message

    def members(self, result):
        return project_archive.read(Path(result["file"]))[1]


class EmptyWorkspaceTest(GitHubBase):
    maxDiff = None

    def test_an_empty_workspace_exports_everything_github_holds_and_changes_nothing_here(self):
        """The owner's report: the project and its slices were published from another computer; this workspace is empty."""
        self.published()
        before, writes = tree(self.b), len(self.writes())
        result = self.export(self.b)
        self.assertEqual(tree(self.b), before, "export takes nothing into the workspace and records nothing")
        self.assertEqual(len(self.writes()), writes, "export only reads GitHub")
        self.assertEqual(result["counts"], {"epics": 2, "slices": 3, "principles": 1, "needs": 1, "ideas": 0, "prds": 0, "designs": 0, "mocks": 0})
        self.assertEqual(result["from_here"], {"count": 0, "ids": []})
        self.assertEqual(result["from_github"], {"count": 8, "ids": ["project", "principles", "needs", "EPIC-001", "EPIC-002", "SLICE-001",
                                                                     "SLICE-002", "SLICE-003"]})
        self.assertEqual((result["github"]["checked"], result["github"]["problem"]), (True, None))
        self.assertEqual((result["not_included"], result["left_out"], result["chosen"], result["warnings"]), ([], [], [], []))
        self.assertIn(FROM_GITHUB, result["note"])
        self.assertEqual(result["in_words"][0], "The archive holds the project, 2 epics and 3 slices. Read from GitHub: the project, the product "
                                                "principles, the technical needs, EPIC-001, EPIC-002, SLICE-001, SLICE-002, SLICE-003.")
        self.assertEqual(result["in_words"][-1], FROM_GITHUB)

        members = self.members(result)
        project = json.loads(members["workspace/product/project.json"])
        self.assertEqual((project["project_id"], project["name"], project["outcomes"]), ("team-space", "Team Space", ["Teams can work together"]))
        # Every spec and why is exactly the approved text, which is Ada's.
        for slice_id, name in (("SLICE-001", "invite-a-teammate"), ("SLICE-002", "remove-a-teammate"), ("SLICE-003", "invite-a-list-of-people")):
            spec = members[f"workspace/specs/slices/{slice_id}-{name}.md"]
            self.assertEqual(spec, self.draft(self.a, f"specs/slices/{slice_id}-invite-teammate.md").read_bytes())
            self.assertEqual(members[f"workspace/product/intents/{slice_id}.md"], self.draft(self.a, f"product/intents/{slice_id}.md").read_bytes())
            work = json.loads(members[f"workspace/product/slices/{slice_id}.json"])
            self.assertEqual((work["status"], work["spec_sha256"]), (studio.APPROVED, hashlib.sha256(spec).hexdigest()))
            self.assertNotIn("tracking", work)
        self.assertEqual(json.loads(members["workspace/product/slices/SLICE-002.json"])["dependencies"], ["SLICE-001"])
        self.assertEqual(json.loads(members["workspace/product/principles.json"])["principles"],
                         json.loads(self.draft(self.a, "product/principles.json").read_text())["principles"])
        self.assertEqual(json.loads(members["workspace/product/needs.json"])["needs"],
                         json.loads(self.draft(self.a, "product/needs.json").read_text())["needs"])
        self.assertFalse(any("SLICE-004" in name for name in members), "a draft never marked ready is only on Ada's computer")
        facts = json.loads(members["facts.json"])
        self.assertEqual(facts["slices"]["SLICE-001"], {"was": "ready_to_build", "revision": 1, "jira": None, "request": None, "note": None,
                                                        "was_ready": True, "from_github": True})
        self.assertEqual(facts["order"], {"EPIC-001": ["SLICE-001", "SLICE-002"], "EPIC-002": ["SLICE-003"]})
        # It names no repository and no account, as any archive.
        for name, data in members.items():
            for word in (b"acme", b"team-space.git", b"ada-pm", str(self.root).encode()):
                self.assertNotIn(word, data if name != "workspace/product/project.json" else data.replace(b'"team-space"', b""), (name, word))

    def test_what_it_makes_imports_with_the_importer(self):
        """Into a new repository that is not on GitHub: every slice arrives as a draft; was_ready says which were ready."""
        self.published()
        archive = self.export(self.b)["file"]
        c = self.clone("c", "Cy PM")
        result = self.ok(c, "project", "import", archive)
        self.assertEqual(len(result["slices"]), 3)
        status = self.ok(c, "status")
        self.assertTrue(status["structurally_valid"], status["structural_errors"])
        self.assertEqual(sorted(json.loads(path.read_text())["status"] for path in self.draft(c, "product/slices").glob("SLICE-*.json")),
                         ["draft", "draft", "draft"])

    def test_with_github_out_of_reach_an_empty_workspace_refuses_and_says_what_to_do(self):
        self.published()
        self.gh_fails("issue list", once=False)
        message = self.refused_export(self.b)
        self.assertIn("There is no project here yet, and MACH could not read GitHub to take it from there.", message)
        self.assertIn("Try again when GitHub can be reached, or export on the computer where the project was made.", message)
        self.assertEqual(list(self.out.iterdir()), [])

    def test_only_mine_in_an_empty_workspace_says_how_to_take_the_project(self):
        self.published()
        message = self.refused_export(self.b, only_mine=True)
        self.assertIn("There is no project in this workspace yet, so there is nothing of yours to export. Export without --only-mine", message)

    def test_an_idea_on_github_is_named_as_not_in_the_archive(self):
        self.published()
        state = self.gh()
        body = issue_rules.shape_issue_body("IDEA-001", 1, "# Bulk invites\n\n## Outcomes\n\n- O-1: Admins bring a team in.\n")
        state["issues"]["90"] = {"number": 90, "id": 9090, "title": "Bulk invites", "body": body, "state": "OPEN", "labels": [{"name": "mach:idea"}],
                                 "comments": [], "events": [], "sub_issues": [], "author": {"login": "ada-pm"}, "updatedAt": "2026-11-17T10:00:00Z"}
        self.gh_state.write_text(json.dumps(state))
        result = self.export(self.b)
        (row,) = result["not_included"]
        self.assertEqual((row["id"], row["what"], row["issue"]), ("IDEA-001", "idea", 90))
        self.assertIn("kept only on the computer where it was written", row["reason"])
        self.assertIn(row["reason"], result["in_words"])
        self.assertEqual(result["left_out"], [])


class PartialWorkspaceTest(GitHubBase):
    """A workspace with part of the project: bringing it in stopped after the project and its epics (as `project join --batch`
    leaves it until it carries on), so the slices are still only on GitHub. Export reads them from there by itself."""

    maxDiff = None

    def adopted(self):
        """Ben's project and epics came from GitHub, and no slice yet (each join below takes none)."""
        real = join_module.join
        with mock.patch.object(join_module, "join", lambda host, studio_, found=None, batch=None: real(host, studio_, found, 0)):
            self.ok(self.b, "project", "init", "--name", "anything", "--vision", "anything", "--outcome", "anything")
            self.ok(self.b, "refresh")

    def test_after_project_init_and_refresh_the_slices_still_come_from_github(self):
        """The trial's silent archive: the project adopted here and refreshed, no slice taken. It must not be nearly empty."""
        self.published()
        self.adopted()
        result = self.export(self.b)
        self.assertEqual(result["counts"]["slices"], 3)
        self.assertEqual(result["counts"]["epics"], 2)
        self.assertEqual(result["from_here"]["ids"], ["project", "principles", "needs", "EPIC-001", "EPIC-002"])  # refresh took the sets
        self.assertEqual(result["from_github"]["ids"], ["SLICE-001", "SLICE-002", "SLICE-003"])
        self.assertIn(FROM_GITHUB, result["note"])

    def test_a_slice_taken_here_is_from_here_and_the_rest_from_github(self):
        self.published()
        self.adopted()
        self.ok(self.b, "slice", "take", str(self.slice_issue("SLICE-001")[0]["number"]))
        result = self.export(self.b)
        self.assertEqual(result["from_here"]["ids"], ["project", "principles", "needs", "EPIC-001", "EPIC-002", "SLICE-001"])
        self.assertEqual(result["from_github"]["ids"], ["SLICE-002", "SLICE-003"])
        self.assertEqual(result["counts"]["slices"], 3)
        self.assertEqual(result["chosen"], [])

    def test_only_mine_leaves_github_s_slices_out_and_says_so(self):
        self.published()
        self.adopted()
        result = self.export(self.b, only_mine=True)
        self.assertEqual(result["left_out"], ["SLICE-001", "SLICE-002", "SLICE-003"])
        self.assertEqual(result["from_github"]["count"], 0)
        self.assertNotIn(FROM_GITHUB, result["note"])
        self.assertIn("Left out, as you asked: 3 slices of this project on GitHub but not in your workspace", result["warnings"][0])
        self.assertEqual(self.members(result).keys() & {"workspace/product/slices/SLICE-001.json"}, set())

    def test_with_github_out_of_reach_what_is_here_is_exported_and_what_may_be_missing_is_said(self):
        self.published()
        self.adopted()
        self.gh_fails("issue list", once=False)
        result = self.export(self.b)
        self.assertFalse(result["github"]["checked"])
        self.assertIn("GitHub could not be reached", result["github"]["problem"])
        self.assertEqual(result["counts"]["slices"], 0)
        self.assertEqual(result["left_out"], ["SLICE-001", "SLICE-002", "SLICE-003"])
        self.assertTrue(all("GitHub could not be read now" in row["reason"] for row in result["not_included"]))
        self.assertIn("may be missing", result["note"])
        self.assertTrue(any(line.startswith("MACH could not read GitHub just now") for line in result["in_words"]))

    def test_a_draft_of_its_own_under_the_same_number_keeps_github_s_out_and_says_how(self):
        """Ben drafted his own SLICE-001; GitHub's SLICE-001 and SLICE-002 (which depends on it) cannot come in under those numbers."""
        self.published()
        self.adopted()
        self.ok(self.b, "epic", "add", "--title", "Ben's own", "--criterion", "Something")
        # Ben's own draft numbered SLICE-001 is a different slice from GitHub's SLICE-001.
        studio_b = studio.Studio(self.b)
        work = {"schema_version": 1, "slice_id": "SLICE-001", "project_id": "team-space", "epic_id": "EPIC-003", "revision": 1, "title": "Ben's",
                "status": "draft", "dependencies": [], "open_questions": [], "spec_path": None, "spec_sha256": None}
        studio_b.path("slice", "SLICE-001").parent.mkdir(parents=True, exist_ok=True)
        studio_b.path("slice", "SLICE-001").write_text(studio.canonical(work))
        result = self.export(self.b)
        ids = {row["id"]: row for row in result["not_included"]}
        self.assertIn("Two different slices use the number SLICE-001: your draft here and #", ids["SLICE-001"]["reason"])
        self.assertIn("The archive holds the one from this workspace. Giving your draft a new number in Product Studio (slice renumber SLICE-001) "
                      "lets both come; then export again.", ids["SLICE-001"]["reason"])
        self.assertEqual(ids["SLICE-002"]["reason"], "SLICE-002 depends on SLICE-001, which is not in the archive, so SLICE-002 from GitHub is not either.")
        self.assertEqual(result["left_out"], ["SLICE-001", "SLICE-002"])
        self.assertIn("SLICE-003", result["from_github"]["ids"])


class AuthorsWorkspaceTest(GitHubBase):
    def test_the_author_s_workspace_takes_nothing_from_github_and_says_nothing_more(self):
        self.published()
        result = self.export(self.a)
        self.assertEqual(result["from_github"], {"count": 0, "ids": []})
        self.assertEqual((result["not_included"], result["chosen"], result["left_out"]), ([], [], []))
        self.assertEqual(result["note"], project_export.NOTE)
        self.assertNotIn(FROM_GITHUB, result["in_words"])
        self.assertEqual(result["in_words"], ["The archive holds the project, 2 epics and 4 slices, all from this workspace."])
        self.assertEqual(result["counts"]["slices"], 4)
        facts = json.loads(self.members(result)["facts.json"])
        self.assertEqual((facts["slices"]["SLICE-001"]["was_ready"], facts["slices"]["SLICE-004"]["was_ready"]), (True, False))

    def test_a_newer_version_on_github_is_used_unless_you_changed_yours(self):
        """Ben took SLICE-001; Ada then saved version 2. Ben's approved copy is older: the archive holds version 2. Once Ben
        reopens and changes his, the archive holds his draft and says so."""
        self.published(principles=False)
        self.ok(self.b, "project", "init", "--name", "anything", "--vision", "anything", "--outcome", "anything")
        self.ok(self.b, "refresh")
        number = self.slice_issue("SLICE-001")[0]["number"]
        self.ok(self.b, "slice", "take", str(number))
        self.ok(self.a, "slice", "reopen", "SLICE-001")
        spec = self.draft(self.a, "specs/slices/SLICE-001-invite-teammate.md")
        spec.write_text(spec.read_text() + "\nA line Ada added in version 2.\n")
        self.ok(self.a, "slice", "ready", "SLICE-001")
        result = self.export(self.b)
        (chosen,) = result["chosen"]
        self.assertEqual((chosen["id"], chosen["used"], chosen["issue"]), ("SLICE-001", "github", number))
        self.assertIn("version 2", chosen["note"])
        members = self.members(result)
        held = [data for name, data in members.items() if name.startswith("workspace/specs/slices/SLICE-001-")]
        self.assertEqual(held, [spec.read_bytes()])
        self.assertIn("SLICE-001", result["from_github"]["ids"])
        self.assertNotIn("SLICE-001", result["from_here"]["ids"])
        self.assertEqual(json.loads(members["facts.json"])["slices"]["SLICE-001"]["revision"], 2)
        # Ben reopens and changes his copy: his draft wins.
        self.ok(self.b, "slice", "reopen", "SLICE-001")
        mine = self.draft(self.b, "specs/slices/SLICE-001-invite-a-teammate.md")
        mine.write_text(mine.read_text() + "\nBen's own line.\n")
        result = self.export(self.b)
        (chosen,) = result["chosen"]
        self.assertEqual(chosen["used"], "here")
        self.assertIn("so the archive holds your draft", chosen["note"])
        self.assertIn(b"Ben's own line.", [d for n, d in self.members(result).items() if n.startswith("workspace/specs/slices/SLICE-001-")][0])


class MocksTest(GitHubBase):
    def test_pictures_come_from_main_checked_against_the_approved_hash(self):
        self.published(with_mock=True)
        self.commit_mocks("SLICE-002")
        result = self.export(self.b)
        self.assertEqual(result["counts"]["mocks"], 1)
        members = self.members(result)
        self.assertEqual(members[f"workspace/product/mocks/SLICE-002/{self.mock['sha256']}.png"], png())
        self.assertEqual(json.loads(members["workspace/product/slices/SLICE-002.json"])["mocks"][0]["sha256"], self.mock["sha256"])
        self.assertTrue(json.loads(members["facts.json"])["slices"]["SLICE-002"]["was_ready"])
        self.assertEqual(result["not_included"], [])

    def test_pictures_not_on_main_are_left_out_by_name_and_the_slice_comes_without_them(self):
        self.published(with_mock=True)
        result = self.export(self.b)
        (row,) = result["not_included"]
        self.assertEqual((row["id"], row["what"]), ("SLICE-002", "design mocks"))
        self.assertIn("SLICE-002's design mocks are not in the archive", row["reason"])
        self.assertIn("commit product/ready/SLICE-002/mocks/ to the main branch", row["reason"])
        members = self.members(result)
        self.assertNotIn("mocks", json.loads(members["workspace/product/slices/SLICE-002.json"]))
        self.assertFalse(json.loads(members["facts.json"])["slices"]["SLICE-002"]["was_ready"], "without its mocks it is not the approved version")
        self.assertEqual(result["left_out"], [])

    def test_a_picture_on_main_that_is_not_the_approved_one_is_left_out(self):
        self.published(with_mock=True)
        folder = self.draft(self.a, "product/ready/SLICE-002/mocks")
        (path,) = folder.iterdir()
        path.write_bytes(png(shade=9))
        self.commit_mocks("SLICE-002")
        result = self.export(self.b)
        self.assertEqual([row["what"] for row in result["not_included"]], ["design mocks"])


class CheckedAsTakenTest(GitHubBase):
    def test_an_issue_changed_after_approval_is_left_out_with_why(self):
        self.published()
        (issue,) = self.slice_issue("SLICE-003")
        self.change_issue(issue["number"], body=issue["body"] + "\nAn edit on GitHub.\n")
        result = self.export(self.b)
        (row,) = result["not_included"]
        self.assertEqual((row["id"], row["issue"]), ("SLICE-003", issue["number"]))
        self.assertIn("was changed on GitHub after it was approved", row["reason"])
        self.assertEqual(result["left_out"], ["SLICE-003"])
        self.assertEqual(result["counts"]["slices"], 2)

    def test_a_spec_on_github_naming_an_account_is_left_out_and_so_are_its_dependents(self):
        """The archive's scan applies to what GitHub holds: the approver's login in a spec keeps the slice (and SLICE-002, which
        depends on it) out, with why; nothing that names the account is written."""
        a = self.a
        self.project_and_epic(a)
        self.drafted(a)
        spec = self.draft(a, "specs/slices/SLICE-001-invite-teammate.md")
        spec.write_text(spec.read_text() + "\nAsk ada-pm before changing this.\n")
        self.drafted(a, title="Remove a teammate", depends=["SLICE-001"])
        self.ready("SLICE-001")
        self.ready("SLICE-002")
        result = self.export(self.b)
        ids = {row["id"]: row["reason"] for row in result["not_included"]}
        self.assertIn("names the GitHub account ada-pm on line", ids["SLICE-001"])
        self.assertIn("Change it on the computer where it was written and mark it ready again", ids["SLICE-001"])
        self.assertIn("SLICE-002 depends on SLICE-001", ids["SLICE-002"])
        for data in self.members(result).values():
            self.assertNotIn(b"ada-pm", data)


class ListingTest(GitHubBase):
    """GitHub holding more issues than one listing gives: export reads on until it has them all, or says it could not."""

    def test_more_slice_issues_than_one_listing_holds_are_all_read(self):
        self.published()
        self.assertEqual(len(self.issues("mach:slice")), 3)
        with mock.patch.object(project_export.issues, "LIST_LIMIT", 2), \
                mock.patch.object(project_export.issues, "LIST_CEILING", 20):
            result = self.export(self.b)
        self.assertEqual(result["counts"]["slices"], 3)
        self.assertEqual(result["not_included"], [])
        limits = [call[call.index("--limit") + 1] for call in self.gh()["calls"] if call[:2] == ["issue", "list"] and "mach:slice" in call]
        self.assertEqual(limits[-2:], ["2", "20"], "a full page is asked for again, larger")

    def test_more_than_can_be_read_is_said_not_left_silent(self):
        self.published()
        with mock.patch.object(project_export.issues, "LIST_LIMIT", 2), mock.patch.object(project_export.issues, "LIST_CEILING", 2):
            result = self.export(self.b)
        rows = [row for row in result["not_included"] if row["what"] == "listing"]
        self.assertEqual([row["id"] for row in rows], ["epics", "slices"])  # two of each: a full list may hold more
        self.assertEqual(rows[1]["reason"], "GitHub holds more slice issues for this repository than MACH could read (2), so the archive may lack "
                                            "some slices. Close the issues that are long finished, then export again.")
        self.assertIn(rows[1]["reason"], result["in_words"])
        self.assertEqual(result["counts"]["slices"], 2)

    def test_refresh_reads_through_the_same_one_reader(self):
        """refresh reads the project as GitHub holds it through the one reader export uses: each list to its end, once."""
        self.published()
        calls = len(self.gh()["calls"])
        with mock.patch.object(project_export.issues, "LIST_LIMIT", 2):
            self.ok(self.b, "refresh")
        listed = [call[call.index("--label") + 1] + "@" + call[call.index("--limit") + 1] for call in self.gh()["calls"][calls:]
                  if call[:2] == ["issue", "list"] and call[call.index("--label") + 1] in ("mach:project", "mach:epic", "mach:slice")]
        self.assertEqual(sorted(listed), ["mach:epic@2", "mach:epic@20", "mach:project@2", "mach:slice@2", "mach:slice@20"])


class ProjectIssueTextTest(GitHubBase):
    """A line in what the project's issue holds that the archive must not carry: the sets are left out and named; the project's
    own record refuses, saying where it is changed. Neither asks the person to take the project in here first."""

    def account_in(self, section):
        state = self.gh()
        (issue,) = [item for item in state["issues"].values() if "mach:project" in [label["name"] for label in item["labels"]]]
        issue["body"] = issue["body"].replace("Teams work together.", "Teams work together; ask ada-pm.") if section == "vision" else issue["body"]
        self.gh_state.write_text(json.dumps(state))
        return issue["number"]

    def test_principles_naming_an_account_are_left_out_and_named(self):
        a = self.a
        self.project_and_epic(a)
        self.drafted(a)
        self.ok(a, "principle", "add", "--title", "Ada decides", "--statement", "A published version MUST NOT be edited in place by anyone but ada-pm.",
                "--reason", "Trust.")
        self.ok(a, "principle", "publish")
        self.ok(a, "refresh")
        result = self.export(self.b)
        (row,) = result["not_included"]
        number = row["issue"]
        self.assertEqual(row["reason"], f"The product principles on GitHub (the project's issue, #{number}) name the GitHub account ada-pm, "
                                        "so they are not in the archive. Change that line in Product Studio on any computer that has the project, this "
                                        "one included, and publish them again; then export again.")
        self.assertNotIn("principles", result["from_github"]["ids"])
        self.assertEqual(result["counts"]["principles"], 0)
        self.assertNotIn("workspace/product/principles.json", self.members(result))

    def test_the_project_s_record_naming_an_account_refuses_and_says_where_to_change_it(self):
        self.published(principles=False)
        number = self.account_in("vision")
        message = self.refused_export(self.b)
        self.assertEqual(message, f"The project's record on GitHub (the project's issue, #{number}) names the GitHub account ada-pm, and "
                                  "the archive must not, so nothing was exported. Change it in Product Studio on any computer that has the project, "
                                  "this one included, and save it to GitHub again by marking a slice ready; then export again. Nothing was changed.")


class MisfitTest(unittest.TestCase):
    def test_the_first_thing_that_does_not_fit_in_plain_words(self):
        said = project_export._misfit(studio, "product/slices/SLICE-004.json: unknown dependency 'SLICE-099'", {"SLICE-004": 12})
        self.assertEqual(said, "What GitHub holds and what is in this workspace do not fit together, so nothing was exported: SLICE-004 depends on "
                               "SLICE-099, which is neither in this workspace nor on GitHub. SLICE-004 came from GitHub (#12): the product manager who "
                               "marked it ready can put it right in Product Studio and mark it ready again, then export again, or export only what is "
                               "here (project export --only-mine).")
        said = project_export._misfit(studio, "product/slices/SLICE-002.json: epic_id is unknown", {})
        self.assertIn("SLICE-002 belongs to an epic that is neither in this workspace nor on GitHub. SLICE-002 is in this workspace: put it right "
                      "here in Product Studio, then export again", said)


class ReadyOnlyWhenApprovedTest(GitHubBase):
    """was_ready only for exactly the approved text; shipped only as the Factory says it."""

    def facts(self, result):
        return json.loads(self.members(result)["facts.json"])

    def test_a_why_changed_after_approval_comes_as_a_draft(self):
        """The approval covers the spec, the why and the mocks; the structural check sees only the spec."""
        self.published()
        why = self.draft(self.a, "product/intents/SLICE-002.md")
        why.write_text(why.read_text() + "\nA line added after it was approved.\n")
        result = self.export(self.a)
        self.assertIn("SLICE-002 was changed here after it was approved, so it comes as a draft, not as ready.", result["warnings"])
        self.assertIn("SLICE-002 was changed here after it was approved, so it comes as a draft, not as ready.", result["in_words"])
        self.assertEqual(result["chosen"], [], "GitHub's copy is the approved one; this workspace's text is what the PM has")
        row = self.facts(result)["slices"]["SLICE-002"]
        self.assertEqual((row["was"], row["was_ready"]), ("interviewing", False))
        members = self.members(result)
        work = json.loads(members["workspace/product/slices/SLICE-002.json"])
        self.assertEqual((work["status"], work["spec_sha256"]), ("interviewing", None))
        self.assertEqual(members["workspace/product/intents/SLICE-002.md"], why.read_bytes())
        self.assertTrue(self.facts(result)["slices"]["SLICE-001"]["was_ready"])

    def test_an_issue_closed_without_being_built_comes_as_a_draft(self):
        self.published()
        (issue,) = self.slice_issue("SLICE-003")
        self.change_issue(issue["number"], state="CLOSED")
        result = self.export(self.b)
        row = self.facts(result)["slices"]["SLICE-003"]
        self.assertEqual((row["was"], row["was_ready"]), ("interviewing", False))
        self.assertIn(f"SLICE-003's issue (#{issue['number']}) was closed without being built, so it comes as a draft.", result["in_words"])
        self.assertEqual(json.loads(self.members(result)["workspace/product/slices/SLICE-003.json"])["status"], "interviewing")

    def test_an_issue_the_factory_shipped_comes_as_shipped_and_ready(self):
        self.published()
        (issue,) = self.slice_issue("SLICE-003")
        self.change_issue(issue["number"], state="CLOSED", labels=issue["labels"] + [{"name": "mach:shipped"}])
        result = self.export(self.b)
        row = self.facts(result)["slices"]["SLICE-003"]
        self.assertEqual((row["was"], row["was_ready"]), ("shipped", True))
        self.assertFalse(any("closed without being built" in line for line in result["in_words"]))

    def test_an_epic_s_jira_key_is_reported_against_the_epic(self):
        """GitHub carries one key per slice, its own or else its epic's: a key two slices of one epic carry is the epic's."""
        a = self.a
        self.project_and_epic(a)
        self.ok(a, "epic", "link", "EPIC-001", "--jira", "TEAM-1")
        self.drafted(a)
        self.drafted(a, title="Remove a teammate")
        self.ok(a, "epic", "add", "--title", "Bulk invites", "--criterion", "A whole team joins at once")
        third = self.ok(a, "slice", "new", "--epic", "EPIC-002", "--title", "Invite a list")["slice"]["slice_id"]
        self.write_slice(a, third)
        self.ok(a, "slice", "link", third, "--jira", "TEAM-12")
        for slice_id in ("SLICE-001", "SLICE-002", third):
            self.ready(slice_id)
        facts = self.facts(self.export(self.b))
        self.assertEqual(facts["epics"]["EPIC-001"], {"jira": "TEAM-1"})
        self.assertEqual((facts["slices"]["SLICE-001"]["jira"], facts["slices"]["SLICE-002"]["jira"]), (None, None))
        self.assertEqual(facts["slices"][third]["jira"], "TEAM-12")


class MockWordsTest(GitHubBase):
    def test_pictures_missing_for_a_slice_read_from_github_say_where_to_commit_them(self):
        self.published(with_mock=True)
        (row,) = self.export(self.b)["not_included"]
        self.assertTrue(row["reason"].endswith("SLICE-002 is in the archive without them. On the computer where it was marked ready, commit "
                                               "product/ready/SLICE-002/mocks/ to the main branch; then fetch here and export again."), row["reason"])


class OneNameEachTest(GitHubBase):
    def test_two_exports_in_the_same_second_keep_both(self):
        self.published()
        with mock.patch.object(studio, "now", lambda at: "2026-11-24T13:06:00Z"):
            first = self.export(self.a)
            second = self.export(self.a)
        self.assertNotEqual(first["file"], second["file"])
        self.assertEqual(Path(first["file"]).name, "mach-project-team-space-20261124T130600Z.zip")
        self.assertEqual(Path(second["file"]).name, "mach-project-team-space-20261124T130600Z-2.zip")
        self.assertEqual(Path(first["file"]).read_bytes(), Path(second["file"]).read_bytes())
        self.assertEqual(sorted(path.name for path in self.out.iterdir()), sorted([Path(first["file"]).name, Path(second["file"]).name]))

    def test_a_refused_archive_leaves_no_name_behind(self):
        self.published()
        with mock.patch.dict(project_archive.LIMITS, {"archive": 1024}):
            self.refused_export(self.a)
        self.assertEqual(list(self.out.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
