"""M17 part A: technical needs.

A technical need is what the product requires of whatever is built, said without technology. Product Studio
keeps them in the draft workspace (product/needs.json) and publishes them the way it publishes the principles:
a fixed section of the project's issue with an approval comment, or, without GitHub, product/ready/NEEDS/.
Every rewrite of the project's issue keeps both sections. Intake never takes the NEEDS folder for a slice.

The GitHub tests use the stand-in for gh from test_mach_product_issues: nothing reaches the network.
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("ticket", "intent", "run", "studio"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import issue_rules  # noqa: E402
import validate_slice  # noqa: E402
from test_mach_product_issues import IssuesBase, git  # noqa: E402
from test_mach_product_intake import Base as IntakeBase  # noqa: E402

PEOPLE = "About two hundred staff use it from two offices, busiest on Monday mornings."
GIVEN = "It runs on the company's PostgreSQL cluster."
STATEMENT = "A published version MUST NOT be edited in place."


def need(ident="TN-01", kind="people", statement=PEOPLE, status="active", revision=1, **given):
    return {"need_id": ident, "kind": kind, "statement": statement, "why": "It sets the size.", "status": status, "revision": revision, **given}


def given(ident="TN-02"):
    return need(ident, "given", GIVEN, said_by="Jo Bloggs, CTO", said_on="2026-11-20")


class RulesTest(unittest.TestCase):
    """issue_rules: the needs section, its hash, the approval, the folder form; the principles section beside it."""

    def setUp(self):
        self.items = [need(), given()]
        self.principles = [{"id": "PP-01", "title": "Versions stay", "statement": STATEMENT, "reason": "Trust.", "status": "active", "revision": 1}]
        self.body = issue_rules.project_issue_body("team-space", "Teams work.", ["Teams can work"], {"revision": 2, "principles": self.principles},
                                                   {"revision": 3, "needs": self.items, "none": ["connections", "never"]})

    def test_both_sections_read_back_exactly(self):
        parsed = issue_rules.parse_needs_section(self.body)
        self.assertEqual((parsed["intact"], parsed["revision"], parsed["needs"], parsed["none"]), (True, 3, self.items, ["connections", "never"]))
        self.assertEqual(parsed["sha256"], issue_rules.needs_sha256(self.items))
        self.assertIn("## Technical needs\n\n<!-- mach:needs revision=3 sha256=", self.body)
        self.assertLess(self.body.index("## Product principles"), self.body.index("## Technical needs"))
        self.assertTrue(issue_rules.parse_principles_section(self.body)["intact"])
        self.assertTrue(self.body.endswith("\n\nWritten by MACH Product Studio.\n"))
        plain = issue_rules.project_issue_body("team-space", "Teams work.", ["Teams can work"])
        self.assertIsNone(issue_rules.parse_needs_section(plain))
        only = issue_rules.project_issue_body("team-space", "Teams work.", ["Teams can work"], None, {"revision": 1, "needs": self.items})
        self.assertTrue(issue_rules.parse_needs_section(only)["intact"])
        self.assertIsNone(issue_rules.parse_principles_section(only))

    def test_an_edit_on_github_is_caught_and_the_hash_binds_the_needs(self):
        for edited in (self.body.replace("Monday", "Friday"), self.body.replace("(people, revision 1", "(data, revision 1"),
                       self.body.replace("on 2026-11-20", "on 2026-11-19")):
            self.assertFalse(issue_rules.parse_needs_section(edited)["intact"], edited)
        self.assertEqual(issue_rules.needs_sha256(self.items), issue_rules.needs_sha256(list(reversed(self.items))))

    def test_the_approval_and_the_take_check(self):
        sha = issue_rules.needs_sha256(self.items)
        approval = issue_rules.needs_approval_comment(3, "ada-pm", sha)
        self.assertTrue(approval.endswith(f"<!-- mach:needs-approval revision=3 by=ada-pm sha256={sha} -->"))
        comment = {"login": "ada-pm", "body": approval}
        self.assertEqual(issue_rules.needs_take_check(self.body, [comment])["needs"], self.items)
        self.assertEqual(issue_rules.needs_take_check(self.body, [dict(comment, login="mallory")])["problem"], "no_approval")
        self.assertEqual(issue_rules.needs_take_check(self.body.replace("Monday", "Friday"), [comment])["problem"], "edited")
        # A principles approval is not a needs approval.
        self.assertEqual(issue_rules.needs_take_check(self.body, [{"login": "ada-pm", "body": issue_rules.principles_approval_comment(3, "ada-pm", sha)}])["problem"],
                         "no_approval")

    def test_the_folder_form(self):
        record = {"schema_version": 1, "revision": 2, "sha256": issue_rules.needs_sha256(self.items), "needs": self.items, "none": ["never"]}
        self.assertEqual(issue_rules.needs_folder_check(record)["state"], "accepted")
        self.assertIn("SHA-256 does not match", issue_rules.needs_folder_check(dict(record, needs=[need(statement="Ten people.")]))["reason"])
        self.assertEqual(issue_rules.needs_folder_check({k: v for k, v in record.items() if k != "none"})["state"], "not_accepted")

    def test_shape_rules(self):
        for bad in (dict(need(), kind="speed"), dict(need(), said_by="Jo", said_on="2026-11-20"), {k: v for k, v in given().items() if k != "said_on"},
                    dict(given(), said_on="2026-13-01"), dict(need(), statement="It holds <!-- x -->."), dict(need(), statement="Two\nlines.")):
            self.assertTrue(issue_rules.need_problems([bad]), bad)
        self.assertTrue(issue_rules.needs_none_problems([need()], ["people"]))
        self.assertTrue(issue_rules.needs_none_problems([], ["never", "data"]))
        self.assertEqual(issue_rules.needs_none_problems([need(status="retired")], ["people"]), [])

    def test_the_technology_check_is_the_validators_own(self):
        found = validate_slice.need_findings("TN-01", "Data is kept in a SQL database for seven years.")
        self.assertEqual([f.rule for f in found], ["implementation-detail"])
        self.assertIn("record it as a given", found[0].message)
        self.assertEqual(validate_slice.need_findings("TN-01", PEOPLE), [])
        principle = validate_slice.statement_findings("PP-01", "The cache MUST hold every version.")
        self.assertIn("architecture decision (ADR)", [f for f in principle if f.rule == "implementation-detail"][0].message)


class StudioTest(IssuesBase):
    """Product Studio: the need commands, publishing, refresh and reconcile."""

    def setUp(self):
        super().setUp()
        self.project_and_epic()

    def add(self, kind="people", statement=PEOPLE, project=None, *extra):
        return self.ok(project or self.a, "need", "add", "--kind", kind, "--statement", statement, "--why", "It sets the size.", *extra)

    def add_given(self, project=None, said_by="Jo Bloggs, CTO"):
        return self.add("given", GIVEN, project, "--said-by", said_by, "--said-on", "2026-11-20")

    def test_add_set_retire_none_and_list(self):
        self.assertEqual(self.add()["need"], need())
        self.assertEqual(self.add_given()["need"], given())
        self.assertIn("names technology", self.refused(self.a, "need", "add", "--kind", "data", "--statement", "Orders are kept in a database.", "--why", "W."))
        self.assertIn("names technology (postgres)", self.refused(self.a, "need", "add", "--kind", "data", "--statement", "Guests are kept on Postgres.", "--why", "W."))
        self.assertIn("names technology (aws)", self.refused(self.a, "need", "add", "--kind", "people", "--statement", "Hosts reach it through AWS.", "--why", "W."))
        self.assertIn("says who decided it", self.refused(self.a, "need", "add", "--kind", "given", "--statement", GIVEN, "--why", "W."))
        self.assertIn("only a given", self.refused(self.a, "need", "add", "--kind", "data", "--statement", "Kept seven years.", "--why", "W.",
                                                   "--said-by", "Jo", "--said-on", "2026-11-20"))
        self.assertIn("not a date", self.refused(self.a, "need", "add", "--kind", "given", "--statement", GIVEN, "--why", "W.", "--said-by", "Jo", "--said-on", "20 Nov"))
        self.assertIn("in the future", self.refused(self.a, "need", "add", "--kind", "given", "--statement", GIVEN, "--why", "W.", "--said-by", "Jo", "--said-on", "2999-01-01"))
        self.assertIn("not a policy pack", self.refused(self.a, "need", "add", "--kind", "given", "--statement", GIVEN, "--why", "W.",
                                                        "--said-by", "POL-hosting", "--said-on", "2026-11-20"))
        changed = self.ok(self.a, "need", "set", "TN-01", "--statement", "About three hundred staff use it from two offices.")
        self.assertEqual(changed["need"]["revision"], 2)
        self.assertEqual(self.ok(self.a, "need", "set", "TN-01", "--why", "Another reason.")["need"]["revision"], 2)
        self.assertIn("names technology", self.refused(self.a, "need", "set", "TN-01", "--statement", "Served from a cache."))
        self.assertEqual(self.ok(self.a, "need", "retire", "TN-02")["need"]["status"], "retired")
        self.assertIn("is retired", self.refused(self.a, "need", "set", "TN-02", "--why", "Back."))
        self.assertIn("already has TN-01", self.refused(self.a, "need", "none", "--kind", "people"))
        self.assertTrue(self.ok(self.a, "need", "none", "--kind", "connections")["changed"])
        self.assertFalse(self.ok(self.a, "need", "none", "--kind", "connections")["changed"])
        listed = self.ok(self.a, "need", "list")
        self.assertEqual((listed["active"], listed["retired"], listed["nothing_to_say"]), (["TN-01"], ["TN-02"], ["connections"]))
        self.assertEqual(listed["unanswered"], ["data", "never", "priority", "given"])
        self.assertFalse(listed["factory_authorized"])
        # A need of a kind answers it: "nothing to say" goes.
        self.add("connections", "It sends invoices to the finance team's existing system.")
        self.assertEqual(self.ok(self.a, "need", "list")["nothing_to_say"], [])
        data = json.loads(self.draft(self.a, "product/needs.json").read_text())
        self.assertEqual(set(data), {"schema_version", "project_id", "needs", "none"})
        code, out, _ = self.run_studio(self.a, "validate")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls_since_init(), [])  # nothing here reaches GitHub

    def test_ids_are_never_reused(self):
        self.add()
        self.add_given()
        self.ok(self.a, "need", "retire", "TN-02")
        self.ok(self.a, "need", "publish")
        # Even with TN-02 gone from the draft, the published record keeps the number taken.
        path = self.draft(self.a, "product/needs.json")
        data = json.loads(path.read_text())
        data["needs"] = data["needs"][:1]
        path.write_text(json.dumps(data))
        self.assertEqual(self.add("data", "It keeps names and email addresses for seven years.")["need"]["need_id"], "TN-03")

    def test_publishing_saves_the_section_and_the_approval_once(self):
        self.add()
        self.ok(self.a, "need", "none", "--kind", "never")
        published = self.ok(self.a, "need", "publish")
        self.assertEqual((published["saved_to"], published["revision"], published["approved_by"]), ("github", 1, "ada-pm"))
        (project,) = self.issues("mach:project")
        parsed = issue_rules.parse_needs_section(project["body"])
        self.assertEqual((parsed["intact"], parsed["revision"], parsed["needs"], parsed["none"]), (True, 1, [need()], ["never"]))
        (comment,) = project["comments"]
        self.assertEqual(comment["body"], issue_rules.needs_approval_comment(1, "ada-pm", parsed["sha256"]))
        # The folder form is written too, with the same revision and hash, for the baseline that reads committed files only.
        record = json.loads(self.draft(self.a, "product/ready/NEEDS/needs.json").read_text())
        self.assertEqual((record["revision"], record["sha256"], record["needs"], record["none"]), (1, parsed["sha256"], [need()], ["never"]))
        self.assertEqual(issue_rules.needs_folder_check(record)["state"], "accepted")
        self.assertIn("product/ready/NEEDS", published["ways_on"][0])
        before = self.gh()
        self.assertEqual(self.ok(self.a, "need", "publish")["revision"], 1)
        new = [call for call in self.gh()["calls"][len(before["calls"]):] if call[:2] not in (["issue", "list"], ["issue", "view"], ["label", "list"], ["repo", "view"])
               and not (call[0] == "api" and "--method" not in call)]
        self.assertEqual(new, [])  # the same needs again: nothing written
        self.ok(self.a, "need", "set", "TN-01", "--statement", "About three hundred staff use it.")
        self.assertTrue(self.ok(self.a, "status")["needs"]["unpublished_changes"])
        self.assertEqual(self.ok(self.a, "need", "publish")["revision"], 2)
        project = self.issues("mach:project")[0]
        self.assertEqual(issue_rules.parse_needs_section(project["body"])["revision"], 2)
        self.assertEqual(len(project["comments"]), 2)
        record = json.loads(self.draft(self.a, "product/ready/NEEDS/needs.json").read_text())
        self.assertEqual((record["revision"], record["sha256"]), (2, issue_rules.parse_needs_section(project["body"])["sha256"]))
        status = self.ok(self.a, "status")
        self.assertEqual((status["needs"]["unpublished_changes"], status["needs"]["published"]["revision"]), (False, 2))
        self.assertTrue(status["saved"]["everything_saved"])

    def test_an_interrupted_publish_finishes_without_making_anything_twice(self):
        self.add()
        self.lose("issue comment")
        self.assertIn("stopped part way", self.refused(self.a, "need", "publish"))
        self.assertTrue(self.ok(self.a, "status")["needs"]["published"]["unfinished"])
        self.assertIn("needs_unfinished", [row["kind"] for row in self.ok(self.a, "status")["saved"]["not_saved"]])
        self.ok(self.a, "need", "publish")
        self.assertEqual(len(self.issues("mach:project")[0]["comments"]), 1)

    def test_both_sections_survive_every_rewrite_of_the_project_issue(self):
        self.ok(self.a, "principle", "add", "--title", "Versions stay", "--statement", STATEMENT, "--reason", "Trust.")
        self.ok(self.a, "principle", "publish")
        self.add()
        self.ok(self.a, "need", "publish")
        body = self.issues("mach:project")[0]["body"]
        self.assertTrue(issue_rules.parse_principles_section(body)["intact"])
        self.assertTrue(issue_rules.parse_needs_section(body)["intact"])
        # Publishing the principles again keeps the needs; marking a slice ready keeps both.
        self.ok(self.a, "principle", "set", "PP-01", "--reason", "Readers trust it.")
        self.ok(self.a, "principle", "publish")
        body = self.issues("mach:project")[0]["body"]
        self.assertEqual((issue_rules.parse_principles_section(body)["revision"], issue_rules.parse_needs_section(body)["revision"]), (2, 1))
        slice_id = self.drafted()
        spec = self.draft(self.a, f"specs/slices/{slice_id}-invite-teammate.md")
        from test_mach_product_principles import row, with_rows
        spec.write_text(with_rows(spec.read_text(), row()))
        self.ready(slice_id)
        body = self.issues("mach:project")[0]["body"]
        self.assertTrue(issue_rules.parse_principles_section(body)["intact"])
        parsed = issue_rules.parse_needs_section(body)
        self.assertEqual((parsed["intact"], parsed["needs"]), (True, [need()]))
        # Needs published after the slice keep the principles.
        self.add("data", "It keeps names and email addresses for seven years.")
        self.ok(self.a, "need", "publish")
        body = self.issues("mach:project")[0]["body"]
        self.assertEqual((issue_rules.parse_principles_section(body)["revision"], issue_rules.parse_needs_section(body)["revision"]), (2, 2))

    def test_a_project_without_needs_is_exactly_as_before(self):
        slice_id = self.drafted()
        self.ready(slice_id)
        self.ok(self.a, "refresh")
        status = self.ok(self.a, "status")
        self.assertNotIn("needs", status)
        self.assertNotIn("needs", self.ok(self.a, "refresh")["github"])
        self.assertNotIn("needs", self.ledger())
        self.assertNotIn("needs", self.ledger()["seen"])
        self.assertIsNone(issue_rules.parse_needs_section(self.issues("mach:project")[0]["body"]))

    def test_without_gh_the_needs_go_to_the_folder(self):
        self.set_gh(signed_in=False)
        self.add()
        self.add_given()
        self.ok(self.a, "need", "none", "--kind", "never")
        published = self.ok(self.a, "need", "publish")
        self.assertEqual(published["saved_to"], "folder")
        record = json.loads(self.draft(self.a, "product/ready/NEEDS/needs.json").read_text())
        self.assertEqual(set(record), {"schema_version", "revision", "sha256", "needs", "none"})
        self.assertEqual((record["revision"], record["none"], issue_rules.needs_folder_check(record)["state"]), (1, ["never"], "accepted"))
        self.assertEqual(self.ok(self.a, "need", "publish")["revision"], 1)  # the same again: the same version
        self.ok(self.a, "need", "none", "--kind", "priority")
        self.assertEqual(self.ok(self.a, "need", "publish")["revision"], 2)  # the kinds with nothing to say are part of a version
        self.assertEqual(self.issues(), [])

    def test_another_product_managers_needs_are_taken_at_refresh_or_chosen(self):
        self.add()
        self.ok(self.a, "need", "publish")
        self.set_gh(me="ben-pm")
        # The project is on GitHub, so starting it takes it from there, with its needs and their approval.
        joined = self.ok(self.b, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.",
                         "--outcome", "Teams can work together")
        self.assertTrue(joined["taken"]["needs"])
        self.assertEqual(self.ok(self.b, "need", "list")["needs"], [need()])
        self.assertEqual(self.add("data", "It keeps names for seven years.", self.b)["need"]["need_id"], "TN-02")
        self.assertEqual(self.ok(self.b, "need", "publish")["revision"], 2)
        # Ada has an unpublished change of her own, so refresh does not take Ben's: she chooses.
        self.set_gh(me="ada-pm")
        self.ok(self.a, "need", "set", "TN-01", "--why", "Ada's reason.")
        refreshed = self.ok(self.a, "refresh")
        self.assertNotIn("needs_taken", refreshed)
        self.assertTrue(refreshed["github"]["needs"]["newer_elsewhere"])
        self.assertEqual(self.add("never", "A customer never sees another customer's invoices.")["need"]["need_id"], "TN-03")  # TN-02 was seen on GitHub
        self.ok(self.a, "reconcile", "needs", "--take", "theirs")
        listed = self.ok(self.a, "need", "list")
        self.assertEqual((listed["active"], listed["unpublished_changes"]), (["TN-01", "TN-02"], False))

    def test_keeping_mine_replaces_theirs_on_the_next_publish(self):
        self.add()
        self.ok(self.a, "need", "publish")
        self.project_and_epic(self.b)
        self.set_gh(me="ben-pm")
        self.ok(self.b, "refresh")
        self.ok(self.b, "need", "set", "TN-01", "--why", "Ben's reason.")
        self.ok(self.b, "need", "publish")
        self.set_gh(me="ada-pm")
        self.ok(self.a, "need", "set", "TN-01", "--why", "Ada's reason.")
        self.assertIn("no newer version", self.refused(self.a, "reconcile", "needs", "--take", "mine"))  # not refreshed yet
        self.ok(self.a, "refresh")
        self.ok(self.a, "reconcile", "needs", "--take", "mine")
        self.assertEqual(self.ok(self.a, "need", "publish")["revision"], 3)
        self.assertEqual(issue_rules.parse_needs_section(self.issues("mach:project")[0]["body"])["needs"][0]["why"], "Ada's reason.")

    def test_publishing_mine_over_a_newer_version_replaces_it_and_keeps_theirs(self):
        """Never blocked: publishing replaces the newer technical needs someone else published; theirs is kept whole."""
        self.add()
        self.ok(self.a, "need", "publish")
        self.project_and_epic(self.b)
        self.set_gh(me="ben-pm")
        self.ok(self.b, "refresh")
        self.ok(self.b, "need", "set", "TN-01", "--why", "Ben's reason.")
        self.ok(self.b, "need", "publish")
        self.set_gh(me="ada-pm")
        self.ok(self.a, "need", "set", "TN-01", "--why", "Ada's reason.")
        published = self.ok(self.a, "need", "publish")  # not even refreshed: the act still goes ahead
        self.assertEqual(published["revision"], 3)
        self.assertIn("@ben-pm published version 2 of the technical needs on GitHub", published["note"])
        self.assertIn("Yours is now version 3 and replaces it.", published["note"])
        (folder,) = (self.a / ".factory/studio/replaced").glob("needs-version-2-*")
        kept = json.loads((folder / "needs.json").read_text())
        self.assertEqual(kept["needs"][0]["why"], "Ben's reason.")
        self.assertEqual(issue_rules.parse_needs_section(self.issues("mach:project")[0]["body"])["needs"][0]["why"], "Ada's reason.")

    def test_an_adr_serving_an_older_revision_is_flagged(self):
        self.set_gh(signed_in=False)
        self.add()
        self.ok(self.a, "need", "publish")
        self.ok(self.a, "need", "set", "TN-01", "--statement", "About three hundred staff use it.")
        self.ok(self.a, "need", "publish")
        adr = self.a / "docs" / "adr" / "0001-size-for-three-hundred.md"
        adr.parent.mkdir(parents=True)
        adr.write_text("---\nstatus: accepted\nserves: TN-01@1\n---\n\n# Size for the staff\n")
        git(self.a, "add", "docs")
        git(self.a, "commit", "-q", "-m", "adr")
        listed = self.ok(self.a, "need", "list")
        self.assertEqual(listed["adrs_behind"], [{"adr": "ADR-0001", "file": "docs/adr/0001-size-for-three-hundred.md", "need_id": "TN-01",
                                                  "served_revision": 1, "revision_now": 2}])
        self.assertEqual(self.ok(self.a, "status")["needs"]["adrs_behind"][0]["adr"], "ADR-0001")


class IntakeTest(IntakeBase):
    def test_the_needs_folder_is_not_a_slice(self):
        items = [need()]
        record = {"schema_version": 1, "revision": 1, "sha256": issue_rules.needs_sha256(items), "needs": items, "none": []}
        self.first()
        target = self.a / "product/ready/NEEDS"
        target.mkdir(parents=True)
        (target / "needs.json").write_text(json.dumps(record))
        git(self.a, "add", "-A")
        git(self.a, "commit", "-q", "-m", "needs")
        git(self.a, "push", "-q", "origin", "main")
        git(self.eng, "pull", "-q", "--ff-only")
        taken = self.product("intake")
        self.assertEqual([row["slice_id"] for row in taken["created"]], ["SLICE-001"])
        self.assertEqual(taken["not_accepted"], [])


if __name__ == "__main__":
    unittest.main()
