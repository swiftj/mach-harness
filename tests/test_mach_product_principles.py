"""M13 part A: product principles.

A principle is one sentence that must hold in every slice. Product Studio keeps them in the draft
workspace and publishes them in a fixed section of the project's issue with an approval comment (or,
without GitHub, to product/ready/PRINCIPLES/). Every spec answers every active principle, and the
validator holds it to that when it is given the principles. The engineer's path reads the published
principles through the ticket station or the committed folder; the review station lets a blocker
cite a principle only when the spec lists it.

The GitHub tests use the stand-in for gh from test_mach_product_issues: nothing reaches the network.
"""

import io
import json
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("ticket", "intent", "review", "run", "studio"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import cell  # noqa: E402
import issue_rules  # noqa: E402
import review  # noqa: E402
import ticket  # noqa: E402
import validate_slice  # noqa: E402
from test_mach_product_issues import FIXTURE, REPO, IssuesBase, git, spec_for  # noqa: E402
from test_mach_product_intake import Base as IntakeBase  # noqa: E402

STATEMENT = "A published version MUST NOT be edited in place."
SECOND = "An invitation MUST name the person who sent it."


def principle(ident="PP-01", statement=STATEMENT, status="active", revision=1, title="Versions stay as published"):
    return {"id": ident, "title": title, "statement": statement, "reason": "Readers rely on what they saw.", "status": status, "revision": revision}


def with_rows(spec, *rows):
    """The spec with a Principles section holding these rows, where the template puts it."""
    section = "## Principles\n\n" + "\n".join(rows) + "\n\n"
    return spec.replace("## Dependencies and permissions", section + "## Dependencies and permissions", 1)


def row(ident="PP-01", revision=1, statement=STATEMENT, answer="Applies", value="INV-02, AC-01."):
    return f'- **{ident}** (revision {revision}): "{statement}" **{answer}:** {value}'


def errors(findings, rule=None):
    return [f for f in findings if f.severity == "error" and (rule is None or f.rule == rule)]


class RulesTest(unittest.TestCase):
    """issue_rules: the published section, its hash, the approval and what counts."""

    def setUp(self):
        self.items = [principle(), principle("PP-02", SECOND, status="retired", title="Senders are named")]
        self.body = issue_rules.project_issue_body("team-space", "Teams work.", ["Teams can work"], {"revision": 3, "principles": self.items})

    def comment(self, body, login="ada-pm", edited=False, app=False):
        return {"login": login, "id": 1, "type": "User", "app": app, "created_at": "2026-11-20T10:00:00Z",
                "updated_at": "2026-11-20T11:00:00Z" if edited else "2026-11-20T10:00:00Z", "body": body}

    def test_the_section_reads_back_exactly_and_the_project_body_is_unchanged_without_principles(self):
        parsed = issue_rules.parse_principles_section(self.body)
        self.assertEqual((parsed["intact"], parsed["revision"], parsed["principles"]), (True, 3, self.items))
        self.assertEqual(parsed["sha256"], issue_rules.principles_sha256(self.items))
        self.assertIn("## Product principles\n\n<!-- mach:principles revision=3 sha256=", self.body)
        self.assertTrue(self.body.endswith("\n\nWritten by MACH Product Studio.\n"))
        plain = issue_rules.project_issue_body("team-space", "Teams work.", ["Teams can work"])
        self.assertEqual(plain, "<!-- mach:project id=team-space -->\n## Vision\nTeams work.\n\n## Outcomes\n- Teams can work\n\nWritten by MACH Product Studio.\n")
        self.assertIsNone(issue_rules.parse_principles_section(plain))
        self.assertEqual(issue_rules.product_marker(self.body), ("project", "team-space"))

    def test_an_edit_on_github_is_caught(self):
        for edited in (self.body.replace("in place", "in-place"), self.body.replace("(revision 1, retired)", "(revision 1, active)"),
                       self.body.replace("Readers rely", "People rely", 1)):
            parsed = issue_rules.parse_principles_section(edited)
            self.assertFalse(parsed["intact"], edited)
            self.assertIsNone(parsed["principles"])

    def test_the_hash_ignores_order_and_binds_every_field(self):
        self.assertEqual(issue_rules.principles_sha256(self.items), issue_rules.principles_sha256(list(reversed(self.items))))
        changed = [dict(self.items[0], reason="Another reason."), self.items[1]]
        self.assertNotEqual(issue_rules.principles_sha256(self.items), issue_rules.principles_sha256(changed))

    def test_what_counts_for_the_factory(self):
        sha = issue_rules.principles_sha256(self.items)
        approval = issue_rules.principles_approval_comment(3, "ada-pm", sha)
        self.assertIn("<!-- mach:principles-approval revision=3 by=ada-pm sha256=", approval)
        write = {"ada-pm": {"permission": "write", "role_name": "write"}}
        decide = issue_rules.principles_acceptance
        accepted = decide(self.body, [self.comment(approval)], write)
        self.assertEqual((accepted["state"], accepted["approved_by"], accepted["principles"]), ("accepted", "ada-pm", self.items))
        self.assertEqual(decide(self.body, [self.comment(approval, edited=True)], write)["reason"], issue_rules.PRINCIPLES_NOT_ACCEPTED["approval_edited"])
        self.assertEqual(decide(self.body, [self.comment(approval, login="mallory")], write)["reason"], issue_rules.PRINCIPLES_NOT_ACCEPTED["no_approval"])
        self.assertEqual(decide(self.body, [self.comment(approval, app=True)], write)["reason"], issue_rules.PRINCIPLES_NOT_ACCEPTED["no_approval"])
        other = issue_rules.principles_approval_comment(2, "ada-pm", sha)
        self.assertEqual(decide(self.body, [self.comment(other)], write)["state"], "not_accepted")
        reader = {"ada-pm": {"permission": "read", "role_name": "read"}}
        self.assertEqual(decide(self.body, [self.comment(approval)], reader)["reason"], issue_rules.PRINCIPLES_NOT_ACCEPTED["no_role"])
        self.assertEqual(decide(self.body, [self.comment(approval)], {"ada-pm": None})["reason"], issue_rules.PRINCIPLES_NOT_ACCEPTED["unconfirmed"])
        self.assertEqual(decide(self.body.replace("in place", "in-place"), [self.comment(approval)], write)["reason"], issue_rules.PRINCIPLES_NOT_ACCEPTED["edited"])
        self.assertEqual(decide("<!-- mach:project id=x -->\n", [], write)["state"], "none")

    def test_the_folder_form_is_checked_by_its_hash(self):
        sha = issue_rules.principles_sha256(self.items)
        record = {"schema_version": 1, "revision": 2, "sha256": sha, "principles": self.items}
        self.assertEqual(issue_rules.principles_folder_check(record)["state"], "accepted")
        tampered = dict(record, principles=[dict(self.items[0], statement="A published version MAY be edited in place.")] + self.items[1:])
        self.assertIn("SHA-256 does not match", issue_rules.principles_folder_check(tampered)["reason"])
        self.assertEqual(issue_rules.principles_folder_check(dict(record, extra=1))["state"], "not_accepted")

    def test_a_principle_that_could_forge_markers_is_refused(self):
        for bad in (dict(principle(), statement='It MUST say "yes".'), dict(principle(), statement="It MUST hold.\nSecond line."),
                    dict(principle(), title="Bold ** title"), dict(principle(), statement="It MUST hold <!-- x -->.")):
            self.assertTrue(issue_rules.principle_problems([bad]), bad)
            with self.assertRaises(ValueError):
                issue_rules.principles_section(1, [bad])


class ValidatorTest(unittest.TestCase):
    """validate_slice: the Principles section, held to the principles it is given."""

    NAME = "SLICE-001-invite-teammate-by-email.md"

    def check(self, text, principles=None, ready=True):
        return validate_slice.analyze(text, self.NAME, principles=validate_slice.principles_shape(principles) if principles is not None else None, ready=ready)

    def test_a_project_without_principles_changes_nothing(self):
        findings, model = self.check(FIXTURE)
        self.assertEqual(errors(findings), [])
        self.assertNotIn("principles", model)
        findings, model = self.check(FIXTURE, principles=[principle(status="retired")])
        self.assertEqual(errors(findings), [])

    def test_every_active_principle_is_answered(self):
        findings, _ = self.check(FIXTURE, [principle()])
        self.assertEqual([f.rule for f in errors(findings)], ["principle-unanswered"])
        text = with_rows(FIXTURE, row())
        findings, model = self.check(text, [principle(), principle("PP-02", SECOND)])
        self.assertEqual([f.rule for f in errors(findings)], ["principle-unanswered"])
        self.assertIn("PP-02 is not answered", errors(findings)[0].message)
        text = with_rows(FIXTURE, row(), row("PP-02", statement=SECOND, answer="Does not apply", value="This slice sends no invitation text."))
        findings, model = self.check(text, [principle(), principle("PP-02", SECOND)])
        self.assertEqual(errors(findings), [])
        self.assertEqual(model["principles"], [
            {"id": "PP-01", "revision": 1, "statement": STATEMENT, "answer": "applies", "upheld_by": ["INV-02", "AC-01"], "reason": None},
            {"id": "PP-02", "revision": 1, "statement": SECOND, "answer": "does_not_apply", "upheld_by": [], "reason": "This slice sends no invitation text."}])

    def test_the_statement_is_quoted_exactly_and_the_revision_is_current(self):
        findings, _ = self.check(with_rows(FIXTURE, row(statement="A published version MUST NOT change.")), [principle()])
        self.assertEqual([f.rule for f in errors(findings)], ["principle-quote"])
        findings, _ = self.check(with_rows(FIXTURE, row(revision=1)), [principle(revision=2)])
        self.assertEqual([f.rule for f in errors(findings)], ["principle-revision"])
        self.assertIn("answered under revision 1; it is now revision 2", errors(findings)[0].message)

    def test_each_answer_is_checked_on_its_own(self):
        findings, _ = self.check(with_rows(FIXTURE, row(value="INV-09, AC-01.")), [principle()])
        self.assertEqual([f.rule for f in errors(findings)], ["principle-applies"])
        findings, _ = self.check(with_rows(FIXTURE, row(value="R1.")), [principle()])
        self.assertEqual([f.rule for f in errors(findings)], ["principle-applies"])
        findings, _ = self.check(with_rows(FIXTURE, row(answer="Does not apply", value="")), [principle()])
        self.assertEqual([f.rule for f in errors(findings)], ["principle-reason"])
        findings, _ = self.check(with_rows(FIXTURE, row(answer="Exception", value="None.")), [principle()])
        self.assertEqual([f.rule for f in errors(findings)], ["principle-reason"])
        findings, model = self.check(with_rows(FIXTURE, row(answer="Exception", value="Admins asked for corrections in place this quarter.")), [principle()])
        self.assertEqual(errors(findings), [])
        self.assertEqual(model["principles"][0]["answer"], "exception")
        findings, _ = self.check(with_rows(FIXTURE, row(), "- PP-02 applies too."), [principle()])
        self.assertEqual([f.rule for f in errors(findings)], ["principle-format"])
        findings, _ = self.check(with_rows(FIXTURE, row(), row()), [principle()])
        self.assertEqual([f.rule for f in errors(findings)], ["duplicate-id"])

    def test_unknown_and_retired_principles(self):
        findings, _ = self.check(with_rows(FIXTURE, row(), row("PP-07", statement=SECOND)), [principle()])
        self.assertEqual([f.rule for f in errors(findings)], ["principle-unknown"])
        findings, _ = self.check(with_rows(FIXTURE, row()), [principle(status="retired")])
        self.assertEqual(errors(findings), [])
        self.assertIn("principle-retired", [f.rule for f in findings])

    def test_without_the_principles_a_section_is_still_checked_on_its_own(self):
        findings, model = self.check(with_rows(FIXTURE, row()))
        self.assertEqual(errors(findings), [])
        self.assertEqual(model["principles"][0]["upheld_by"], ["INV-02", "AC-01"])
        findings, _ = self.check(with_rows(FIXTURE, row(value="FR-99.")))
        self.assertEqual([f.rule for f in errors(findings)], ["principle-applies"])
        findings, _ = self.check(with_rows(FIXTURE, "- None."))
        self.assertEqual(errors(findings), [])

    def test_the_section_sits_after_acceptance_criteria(self):
        moved = FIXTURE.replace("## Open questions", "## Principles\n\n" + row() + "\n\n## Open questions", 1)
        findings, _ = self.check(moved, [principle()])
        self.assertIn("section-order", [f.rule for f in errors(findings)])

    def test_the_command_line_takes_the_principles_as_a_file(self):
        with tempfile.TemporaryDirectory() as folder:
            spec = Path(folder) / self.NAME
            spec.write_text(with_rows(FIXTURE, row()))
            principles = Path(folder) / "principles.json"
            principles.write_text(json.dumps({"principles": [principle(revision=2)]}))
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = validate_slice.main([str(spec), "--principles", str(principles)])
            self.assertEqual(code, 1)
            self.assertIn("[principle-revision]", out.getvalue())
            principles.write_text(json.dumps({"principles": [principle()]}))
            with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()):
                code = validate_slice.main([str(spec), "--principles", str(principles), "--export"])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue())["principles"][0]["id"], "PP-01")
            principles.write_text("[1]")
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as err:
                self.assertEqual(validate_slice.main([str(spec), "--principles", str(principles)]), 2)
            self.assertIn("cannot read the principles", err.getvalue())

    def test_a_statement_is_held_to_the_invariants_keywords_and_names_no_technology(self):
        rules = lambda text: sorted(f.rule for f in validate_slice.statement_findings("PP-01", text) if f.severity == "error")
        self.assertEqual(rules(STATEMENT), [])
        self.assertEqual(rules("A published version SHOULD NOT be edited in place."), ["inv-keyword"])
        self.assertEqual(rules("A published version is never edited in place."), ["inv-keyword"])
        self.assertEqual(rules("A published version MUST NOT be edited in the database."), ["implementation-detail"])


class StudioTest(IssuesBase):
    """Product Studio: the principle commands, publishing, the gates and refresh."""

    def setUp(self):
        super().setUp()
        self.project_and_epic()

    def add(self, statement=STATEMENT, title="Versions stay as published", project=None):
        return self.ok(project or self.a, "principle", "add", "--title", title, "--statement", statement, "--reason", "Readers rely on what they saw.")

    def answered(self, slice_id="SLICE-001", rows=None, project=None):
        project = project or self.a
        spec = self.draft(project, f"specs/slices/{slice_id}-invite-teammate.md")
        spec.write_text(with_rows(spec_for(slice_id), *(rows or [row()])))

    def test_add_set_retire_and_list(self):
        self.assertEqual(self.add()["principle"], principle(title="Versions stay as published"))
        self.assertEqual(self.add(SECOND, "Senders are named")["principle"]["id"], "PP-02")
        self.assertIn("inv-keyword", self.refused(self.a, "principle", "add", "--title", "Soft", "--statement", "Versions SHOULD stay.", "--reason", "Why."))
        self.assertIn("architecture decision", self.refused(self.a, "principle", "add", "--title", "Tech", "--statement",
                                                             "The cache MUST hold every version.", "--reason", "Why."))
        self.assertIn("double quotation marks", self.refused(self.a, "principle", "add", "--title", "Q", "--statement", 'It MUST say "hi".', "--reason", "Why."))
        changed = self.ok(self.a, "principle", "set", "PP-01", "--statement", "A published version MUST NOT be changed in place.")
        self.assertEqual(changed["principle"]["revision"], 2)
        self.assertEqual(self.ok(self.a, "principle", "set", "PP-01", "--reason", "Another reason.")["principle"]["revision"], 2)
        self.assertEqual(self.ok(self.a, "principle", "retire", "PP-02")["principle"]["status"], "retired")
        self.assertIn("is retired", self.refused(self.a, "principle", "set", "PP-02", "--title", "Back"))
        listed = self.ok(self.a, "principle", "list")
        self.assertEqual((listed["active"], listed["retired"], listed["unpublished_changes"]), (["PP-01"], ["PP-02"], True))
        code, out, _ = self.run_studio(self.a, "validate")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.calls_since_init(), [])  # nothing here reaches GitHub

    def test_publishing_saves_the_section_and_the_approval_once(self):
        self.add()
        published = self.ok(self.a, "principle", "publish")
        self.assertEqual((published["saved_to"], published["revision"], published["approved_by"]), ("github", 1, "ada-pm"))
        (project,) = self.issues("mach:project")
        parsed = issue_rules.parse_principles_section(project["body"])
        self.assertEqual((parsed["intact"], parsed["revision"], parsed["principles"][0]["statement"]), (True, 1, STATEMENT))
        self.assertTrue(project["pinned"])
        (comment,) = project["comments"]
        self.assertEqual(comment["body"], issue_rules.principles_approval_comment(1, "ada-pm", parsed["sha256"]))
        before = self.gh()
        self.ok(self.a, "principle", "publish")
        new = [call for call in self.gh()["calls"][len(before["calls"]):] if call[:2] not in (["issue", "list"], ["issue", "view"], ["label", "list"], ["repo", "view"])
               and not (call[0] == "api" and "--method" not in call)]
        self.assertEqual(new, [])  # the same principles again: nothing written
        self.ok(self.a, "principle", "set", "PP-01", "--statement", "A published version MUST NOT be changed in place.")
        self.assertEqual(self.ok(self.a, "principle", "publish")["revision"], 2)
        project = self.issues("mach:project")[0]
        self.assertEqual(issue_rules.parse_principles_section(project["body"])["revision"], 2)
        self.assertEqual(len(project["comments"]), 2)
        self.assertEqual(self.ok(self.a, "status")["principles"]["unpublished_changes"], False)

    def test_an_interrupted_publish_finishes_without_making_anything_twice(self):
        self.add()
        self.lose("issue comment")
        self.assertIn("stopped part way", self.refused(self.a, "principle", "publish"))
        self.assertTrue(self.ok(self.a, "status")["principles"]["published"]["unfinished"])
        self.ok(self.a, "principle", "publish")
        (project,) = self.issues("mach:project")
        self.assertEqual(len(project["comments"]), 1)
        self.gh_fails("issue edit body")
        self.ok(self.a, "principle", "set", "PP-01", "--reason", "Readers trust it.")
        self.assertIn("stopped part way", self.refused(self.a, "principle", "publish"))
        self.ok(self.a, "principle", "publish")
        self.assertEqual(len(self.issues("mach:project")), 1)
        self.assertEqual(len(self.issues("mach:project")[0]["comments"]), 2)

    def test_a_slice_answers_the_principles_and_waits_for_them_to_be_published(self):
        self.add()
        slice_id = self.drafted()
        check = self.run_studio(self.a, "slice", "check", slice_id, "--ready")
        self.assertIn("[principle-unanswered]", check[1])
        self.answered(slice_id)
        refused = self.refused(self.a, "slice", "ready", slice_id)
        self.assertIn("not published", refused)
        self.assertEqual(self.calls_since_init(), [])
        resumed = self.ok(self.a, "slice", "resume", slice_id)
        self.assertEqual(resumed["principles"]["active"][0]["statement"], STATEMENT)
        self.ok(self.a, "principle", "publish")
        self.ready(slice_id)
        # Marking a slice ready rewrites the project's issue and keeps the published principles in it.
        parsed = issue_rules.parse_principles_section(self.issues("mach:project")[0]["body"])
        self.assertEqual((parsed["intact"], parsed["revision"]), (True, 1))
        marker = issue_rules.parse_slice_body(self.slice_issue(slice_id)[0]["body"])
        self.assertIn('- **PP-01** (revision 1): "A published version MUST NOT be edited in place." **Applies:**', marker["spec"])

    def test_a_project_without_principles_is_exactly_as_before(self):
        slice_id = self.drafted()
        self.ready(slice_id)
        status = self.ok(self.a, "status")
        self.assertNotIn("principles", status)
        self.assertNotIn("principles", status["slices"][0])
        self.assertIsNone(issue_rules.parse_principles_section(self.issues("mach:project")[0]["body"]))
        self.assertNotIn("principles", self.ok(self.a, "slice", "resume", self.drafted(title="Remove a teammate")))

    def test_a_slice_answered_under_an_older_revision_is_flagged(self):
        self.add()
        self.ok(self.a, "principle", "publish")
        slice_id = self.drafted()
        self.answered(slice_id)
        self.ready(slice_id)
        self.ok(self.a, "principle", "set", "PP-01", "--statement", "A published version MUST NOT be changed in place.")
        self.ok(self.a, "principle", "add", "--title", "Senders", "--statement", SECOND, "--reason", "Trust.")
        status = self.ok(self.a, "status")
        self.assertEqual(status["principles"]["slices_answered_under_older"], [slice_id])
        flags = status["slices"][0]["principles"]
        self.assertEqual((flags["older"], flags["unanswered"]), (["PP-01"], ["PP-02"]))
        self.assertIn("reopen it", flags["note"])
        self.assertEqual(status["slices"][0]["status"], "approved_for_engineering")  # flagged, never changed
        self.assertIn("not published", status["principles"]["next"])

    def test_another_product_managers_principles_are_taken_at_refresh_or_chosen(self):
        self.add()
        self.ok(self.a, "principle", "publish")
        self.project_and_epic(self.b)
        self.set_gh(me="ben-pm")
        refreshed = self.ok(self.b, "refresh")
        self.assertEqual(refreshed["principles_taken"]["revision"], 1)
        self.assertEqual(self.ok(self.b, "principle", "list")["principles"][0]["statement"], STATEMENT)
        self.ok(self.b, "principle", "add", "--title", "Senders", "--statement", SECOND, "--reason", "Trust.")
        self.assertEqual(self.ok(self.b, "principle", "publish")["revision"], 2)
        # Ada has an unpublished change of her own, so refresh does not take Ben's: she chooses.
        self.set_gh(me="ada-pm")
        self.ok(self.a, "principle", "set", "PP-01", "--reason", "Ada's reason.")
        refreshed = self.ok(self.a, "refresh")
        self.assertNotIn("principles_taken", refreshed)
        self.assertTrue(refreshed["github"]["principles"]["newer_elsewhere"])
        self.ok(self.a, "reconcile", "principles", "--take", "theirs")
        self.assertEqual(self.ok(self.a, "principle", "list")["active"], ["PP-01", "PP-02"])
        self.assertFalse(self.ok(self.a, "principle", "list")["unpublished_changes"])

    def test_publishing_mine_over_a_newer_version_replaces_it_and_keeps_theirs(self):
        """Never blocked: the product manager asked to publish their principles, so they replace the newer version someone else
        published, which is kept whole; reconcile --take theirs is still there."""
        self.add()
        self.ok(self.a, "principle", "publish")
        self.project_and_epic(self.b)
        self.set_gh(me="ben-pm")
        self.ok(self.b, "refresh")
        self.ok(self.b, "principle", "add", "--title", "Senders", "--statement", SECOND, "--reason", "Trust.")
        self.ok(self.b, "principle", "publish")
        self.set_gh(me="ada-pm")
        self.ok(self.a, "principle", "set", "PP-01", "--reason", "Ada's reason.")
        self.ok(self.a, "refresh")
        published = self.ok(self.a, "principle", "publish")
        self.assertEqual(published["revision"], 3)
        self.assertIn("@ben-pm published version 2 of the principles on GitHub", published["note"])
        self.assertIn("Yours is now version 3 and replaces it. Theirs is kept in the edit history of the project's issue", published["note"])
        self.assertRegex(published["note"], r"\.factory/studio/replaced/principles-version-2-\d{8}T\d+Z/")
        (folder,) = (self.a / ".factory/studio/replaced").glob("principles-version-2-*")
        kept = json.loads((folder / "principles.json").read_text())
        self.assertEqual((kept["revision"], [item["id"] for item in kept["principles"]]), (2, ["PP-01", "PP-02"]))
        parsed = issue_rules.parse_principles_section(self.issues("mach:project")[0]["body"])
        self.assertEqual(parsed["principles"][0]["reason"], "Ada's reason.")

    def test_keeping_mine_replaces_theirs_on_the_next_publish(self):
        self.add()
        self.ok(self.a, "principle", "publish")
        self.project_and_epic(self.b)
        self.set_gh(me="ben-pm")
        self.ok(self.b, "refresh")
        self.ok(self.b, "principle", "set", "PP-01", "--reason", "Ben's reason.")
        self.ok(self.b, "principle", "publish")
        self.set_gh(me="ada-pm")
        self.ok(self.a, "principle", "set", "PP-01", "--reason", "Ada's reason.")
        self.ok(self.a, "refresh")
        self.ok(self.a, "reconcile", "principles", "--take", "mine")
        self.assertEqual(self.ok(self.a, "principle", "publish")["revision"], 3)
        parsed = issue_rules.parse_principles_section(self.issues("mach:project")[0]["body"])
        self.assertEqual(parsed["principles"][0]["reason"], "Ada's reason.")

    def test_without_gh_the_principles_go_to_the_folder(self):
        self.set_gh(signed_in=False)
        self.add()
        published = self.ok(self.a, "principle", "publish")
        self.assertEqual(published["saved_to"], "folder")
        record = json.loads(self.draft(self.a, "product/ready/PRINCIPLES/principles.json").read_text())
        self.assertEqual(issue_rules.principles_folder_check(record)["state"], "accepted")
        self.assertEqual(record["revision"], 1)
        self.assertEqual(self.issues(), [])

    def test_publishing_uses_only_the_gh_calls_the_hand_off_already_may(self):
        """The allow-list in test_mach_product_isolation holds the source; this holds what publishing actually ran."""
        self.add()
        self.ok(self.a, "principle", "publish")
        self.ok(self.a, "refresh")
        allowed = {("repo", "view"), ("api", "user"), ("issue", "list"), ("issue", "view"), ("issue", "create"), ("issue", "edit"), ("issue", "comment"),
                   ("issue", "pin"), ("label", "list"), ("label", "create")}
        used = {(call[0], "user" if "user" in call else call[1]) if call[0] == "api" else tuple(call[:2]) for call in self.gh()["calls"]}
        api = [call for call in self.gh()["calls"] if call[0] == "api"]
        self.assertEqual(used - allowed, set())
        self.assertFalse([call for call in api if "--method" in call])


class TicketCheckTest(IssuesBase):
    """ticket.py principles-check: read only, and the Factory's rule for what counts."""

    def setUp(self):
        super().setUp()
        self.project_and_epic()
        self.ok(self.a, "principle", "add", "--title", "Versions", "--statement", STATEMENT, "--reason", "Readers rely on it.")
        self.ok(self.a, "principle", "publish")
        self.set_gh(me="erin-eng")

    def check(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            self.assertEqual(ticket.main(["--project", str(self.eng), "principles-check", *argv]), 0)
        return json.loads(out.getvalue())

    def test_published_principles_count(self):
        before = len(self.gh()["calls"])
        found = self.check()
        self.assertEqual((found["decision"]["state"], found["decision"]["approved_by"], found["number"]), ("accepted", "ada-pm", self.issues("mach:project")[0]["number"]))
        self.assertEqual(found["decision"]["principles"][0]["statement"], STATEMENT)
        calls = self.gh()["calls"][before:]
        self.assertFalse([call for call in calls if call[:2] in (["issue", "edit"], ["issue", "comment"], ["issue", "create"]) or "--method" in call])

    def test_an_edited_section_or_a_reader_approval_does_not_count(self):
        number = self.issues("mach:project")[0]["number"]
        body = self.issue(number)["body"]
        self.change_issue(number, body=body.replace("in place", "in-place"))
        self.assertEqual(self.check(str(number))["decision"]["reason"], issue_rules.PRINCIPLES_NOT_ACCEPTED["edited"])
        self.change_issue(number, body=body)
        state = self.gh()
        state["accounts"]["ada-pm"]["role"] = "read"
        self.gh_state.write_text(json.dumps(state))
        self.assertEqual(self.check()["decision"]["reason"], issue_rules.PRINCIPLES_NOT_ACCEPTED["no_role"])

    def test_no_principles_is_none(self):
        number = self.issues("mach:project")[0]["number"]
        self.change_issue(number, body=issue_rules.project_issue_body("team-space", "Teams work together.", ["Teams can work together"]))
        self.assertEqual(self.check()["decision"]["state"], "none")

    def test_several_project_issues_are_named(self):
        """M20: the check names the issues, so the Factory can stop and say which."""
        first = self.issues("mach:project")[0]["number"]
        second = second_project_issue(self)
        decision = self.check()["decision"]
        self.assertEqual((decision["state"], decision["reason"], decision["project_issues"]),
                         ("not_accepted", issue_rules.PRINCIPLES_NOT_ACCEPTED["several"], [first, second]))
        self.assertNotIn("project_issues", self.check(str(first))["decision"], "an issue named by number is read as before")


def second_project_issue(test):
    """Someone made a second project issue by hand, beside the first."""
    state = test.gh()
    first = test.issues("mach:project")[0]
    number = state.get("next_number", 1)
    state["next_number"] = number + 1
    state["issues"][str(number)] = {**json.loads(json.dumps(first)), "number": number, "id": 9000 + number, "comments": [], "events": [], "pinned": False}
    test.gh_state.write_text(json.dumps(state))
    return number


class EngineerPathTest(IssuesBase):
    """cell.py principles: the engineer's ticket reads the published principles, and the spec is held to them."""

    def setUp(self):
        super().setUp()
        self.set_gh(me="erin-eng")
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            self.assertEqual(cell.main(["--project", str(self.eng), "open", "LOCAL-001"]), 0)
        self.cell = json.loads(out.getvalue())

    def cell_run(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cell.main(["--project", str(self.eng), *argv])
        return code, out.getvalue() + err.getvalue()

    def spec(self, text):
        path = Path(self.cell["specs_dir"]) / "SLICE-001-invite-teammate-by-email.md"
        path.write_text(text)
        return "specs/slices/" + path.name

    def test_published_principles_are_read_and_the_spec_must_answer_them(self):
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        self.ok(self.a, "principle", "add", "--title", "Versions", "--statement", STATEMENT, "--reason", "Readers rely on it.")
        self.ok(self.a, "principle", "publish")
        self.set_gh(me="erin-eng")
        code, out = self.cell_run("principles", "LOCAL-001")
        self.assertEqual(code, 0, out)
        shown = json.loads(out)
        self.assertEqual((shown["principles"]["source"], [item["id"] for item in shown["principles"]["active"]]), ("github", ["PP-01"]))
        relative = self.spec(FIXTURE)
        code, out = self.cell_run("validate", "LOCAL-001", "--spec", relative)
        self.assertEqual(code, 1)
        self.assertIn("[principle-unanswered]", out)
        self.spec(with_rows(FIXTURE, row()))
        code, out = self.cell_run("validate", "LOCAL-001", "--spec", relative)
        self.assertEqual(code, 0, out)

    def test_the_committed_folder_is_read_when_github_has_none(self):
        items = [principle()]
        record = {"schema_version": 1, "revision": 1, "sha256": issue_rules.principles_sha256(items), "principles": items}
        folder = self.eng / "product/ready/PRINCIPLES"
        folder.mkdir(parents=True)
        (folder / "principles.json").write_text(json.dumps(record))
        git(self.eng, "add", "product")
        git(self.eng, "commit", "-q", "-m", "principles")
        code, out = self.cell_run("principles", "LOCAL-001")
        self.assertEqual(code, 0, out)
        shown = json.loads(out)
        self.assertEqual(shown["principles"]["source"], "folder")
        self.assertEqual(shown["principles"]["revision"], 1)
        kept = json.loads((Path(self.cell["cell_dir"]) / "principles.json").read_text())
        self.assertEqual((kept["source"], kept["sha256"]), ("folder", record["sha256"]))
        record["principles"][0]["statement"] = "A published version MAY be edited in place."
        (folder / "principles.json").write_text(json.dumps(record))
        git(self.eng, "commit", "-q", "-am", "tampered")
        code, out = self.cell_run("principles", "LOCAL-001")
        self.assertIsNone(json.loads(out)["principles"])
        self.assertIn("SHA-256 does not match", " ".join(json.loads(out)["tried"]))

    def test_several_project_issues_stop_grooming_and_name_them(self):
        """M20: with two open project issues, grooming stops with one sentence naming them, and the spec cannot be validated
        as if there were no principles. Once a person closes one, grooming carries on with the principles."""
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        self.ok(self.a, "principle", "add", "--title", "Versions", "--statement", STATEMENT, "--reason", "Readers rely on it.")
        self.ok(self.a, "principle", "publish")
        first = self.issues("mach:project")[0]["number"]
        second = second_project_issue(self)
        self.set_gh(me="erin-eng")
        code, out = self.cell_run("principles", "LOCAL-001")
        self.assertEqual(code, 2, out)
        sentence = (f"This repository has more than one open project issue (#{first} and #{second}), so MACH cannot tell which one holds the product "
                    "principles, and grooming stops here rather than go on without them: a person closes the one that should not be there, then "
                    "grooming carries on.")
        self.assertIn(sentence, out)
        self.assertFalse((Path(self.cell["cell_dir"]) / "principles.json").exists())
        code, out = self.cell_run("validate", "LOCAL-001", "--spec", self.spec(FIXTURE))
        self.assertEqual(code, 2, "never checked as if there were no principles")
        self.assertIn(sentence, out)
        self.change_issue(second, state="CLOSED")
        code, out = self.cell_run("principles", "LOCAL-001")
        self.assertEqual(code, 0, out)
        self.assertEqual([item["id"] for item in json.loads(out)["principles"]["active"]], ["PP-01"])
        code, out = self.cell_run("validate", "LOCAL-001", "--spec", self.spec(FIXTURE))
        self.assertIn("[principle-unanswered]", out)

    def test_none_readable_means_no_section_said_once(self):
        code, out = self.cell_run("principles", "LOCAL-001")
        self.assertEqual(code, 0, out)
        shown = json.loads(out)
        self.assertIsNone(shown["principles"])
        self.assertIn("no Principles section", shown["note"])
        self.assertFalse((Path(self.cell["cell_dir"]) / "principles.json").exists())
        code, out = self.cell_run("validate", "LOCAL-001", "--spec", self.spec(FIXTURE))
        self.assertEqual(code, 0, out)


class ReviewCitationTest(unittest.TestCase):
    """review.py: a blocker may cite a principle only when the spec lists it, and never one the product manager excepted."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        rows = [{"id": "PP-01", "revision": 1, "statement": STATEMENT, "answer": "applies", "upheld_by": ["INV-02"], "reason": None},
                {"id": "PP-02", "revision": 1, "statement": SECOND, "answer": "exception", "upheld_by": [], "reason": "Agreed with legal."},
                {"id": "PP-03", "revision": 1, "statement": "x MUST y.", "answer": "does_not_apply", "upheld_by": [], "reason": "Not here."}]
        (self.root / "spec.json").write_text(json.dumps({"principles": rows}))
        self.cell = types.SimpleNamespace(root=self.root)

    def test_citations(self):
        review.check_principle_citation(self.cell, "Finding 1", "PP-01")
        review.check_principle_citation(self.cell, "Finding 1", "PP-03 plainly applies")
        review.check_principle_citation(self.cell, "Finding 1", "FR-04")
        with self.assertRaises(review.ReviewError) as caught:
            review.check_principle_citation(self.cell, "Finding 1", "PP-09")
        self.assertIn("does not list", str(caught.exception))
        with self.assertRaises(review.ReviewError) as caught:
            review.check_principle_citation(self.cell, "Finding 1", "PP-02")
        self.assertIn("not the panel's to reopen", str(caught.exception))

    def test_the_packet_shows_an_exception_as_the_product_managers_decision(self):
        packet = review.packet_principles(self.cell)
        self.assertEqual([item["id"] for item in packet["applies"]], ["PP-01"])
        self.assertEqual(packet["exceptions"][0]["decided_by"], "the product manager")
        self.assertEqual(packet["exceptions"][0]["reason"], "Agreed with legal.")
        self.assertNotIn("not_assessed", packet)
        (self.root / "spec.json").write_text(json.dumps({"slice_id": "SLICE-001"}))
        self.assertIsNone(review.packet_principles(self.cell))
        with self.assertRaises(review.ReviewError):
            review.check_principle_citation(self.cell, "Finding 1", "PP-01")

    def test_the_packet_shows_a_principle_the_slice_predates_one_line_each(self):
        """M21: a Not assessed row is in the packet as data, with a note that it is not a finding by itself; a blocker may cite it."""
        spec = json.loads((self.root / "spec.json").read_text())
        reason = "PP-04 came with the project lending, brought in here on 2026-11-20, after this slice was written."
        spec["principles_not_assessed"] = [{"id": "PP-04", "revision": 2, "statement": "A loan MUST NOT be changed after signing.",
                                            "reason": reason, "how": "principle_came", "project": "lending", "day": "2026-11-20"}]
        (self.root / "spec.json").write_text(json.dumps(spec))
        packet = review.packet_principles(self.cell)
        self.assertEqual(packet["not_assessed"], [f"PP-04 (revision 2) \"A loan MUST NOT be changed after signing.\": not assessed. {reason}"])
        self.assertIn("not a finding by itself", packet["not_assessed_note"])
        self.assertEqual([item["id"] for item in packet["applies"]], ["PP-01"])
        review.check_principle_citation(self.cell, "Finding 1", "PP-04")


class IntakeTest(IntakeBase):
    def test_the_principles_folder_is_not_a_slice(self):
        items = [principle()]
        record = {"schema_version": 1, "revision": 1, "sha256": issue_rules.principles_sha256(items), "principles": items}
        self.first()
        target = self.a / "product/ready/PRINCIPLES"
        target.mkdir(parents=True)
        (target / "principles.json").write_text(json.dumps(record))
        git(self.a, "add", "-A")
        git(self.a, "commit", "-q", "-m", "principles")
        git(self.a, "push", "-q", "origin", "main")
        git(self.eng, "pull", "-q", "--ff-only")
        taken = self.product("intake")
        self.assertEqual([row["slice_id"] for row in taken["created"]], ["SLICE-001"])
        self.assertEqual(taken["not_accepted"], [])


if __name__ == "__main__":
    unittest.main()
