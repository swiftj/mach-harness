"""M13 part E: a Jira key carried from the slice to the pull request. One way, identifiers only, no call to Jira.

Studio records it (`slice link`, `epic link`); the slice's issue (marker, one visible line, the approval comment) and the
ready folder carry it; intake checks it again and writes it to the ledger and the cell; the merge station puts it at the
start of the pull request's title, in the local merge commit's message and in the change record; cleanup's run record
keeps it. Every hop checks Jira's form."""

import ast
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "ticket" / "scripts"))
import issue_rules  # noqa: E402
import test_mach_product_intake as intake_tests  # noqa: E402
import test_mach_product_issues as issues_tests  # noqa: E402
import test_mach_product_order as order_tests  # noqa: E402
import test_merge as merge_tests  # noqa: E402
from test_build import git  # noqa: E402
from test_mach_product_issues import intent_for, spec_for  # noqa: E402

SPEC_SHA = "a" * 64
WHY_SHA = "b" * 64


class RulesTest(unittest.TestCase):
    def test_the_form_of_a_key(self):
        for good in ("AB-1", "ABC-123", "A1_B-99", "Z" + "Y" * 31 + "-123456789"):
            self.assertTrue(issue_rules.is_jira_key(good), good)
        for bad in (None, 1, "", "abc-1", "A-1", "AB-0", "AB-01", "1AB-2", "AB_1", "AB-1234567890", "Z" + "Y" * 32 + "-1", "AB-1 ", " AB-1",
                    "AB-1\n", "AB-1)", "[AB-1](x)", "AB-1/../x", "ÄB-1"):
            self.assertFalse(issue_rules.is_jira_key(bad), bad)

    def test_a_slice_without_a_key_renders_exactly_as_before(self):
        body = issue_rules.slice_issue_body("SLICE-001", 1, 7, [], "why\n", "spec\n")
        self.assertTrue(body.startswith("<!-- mach:slice id=SLICE-001 revision=1 epic=#7 depends=none\n     spec-sha256="))
        self.assertIn(" -->\n## Why\nwhy\n", body)
        self.assertNotIn("jira", body.lower())
        comment = issue_rules.approval_comment("SLICE-001", 1, "ada-pm", SPEC_SHA, WHY_SHA)
        self.assertNotIn("jira", comment.lower())
        self.assertNotIn("jira", issue_rules.approvals([comment])[0], "an approval without a key reads as before")
        parsed = issue_rules.parse_slice_body(body)
        self.assertEqual((parsed["intact"], parsed["jira"], parsed["jira_invalid"]), (True, None, False))

    def test_a_key_is_in_the_marker_one_line_and_the_approval(self):
        body = issue_rules.slice_issue_body("SLICE-001", 2, 7, [3], "why\n", "spec\n", follows=5, jira="ABC-12")
        self.assertIn(" jira=ABC-12 -->\nChanges #5, which has shipped.\nJira: ABC-12\n## Why\n", body)
        parsed = issue_rules.parse_slice_body(body)
        self.assertEqual((parsed["intact"], parsed["jira"], parsed["follows"], parsed["why"], parsed["spec"]), (True, "ABC-12", 5, "why\n", "spec\n"))
        comment = issue_rules.approval_comment("SLICE-001", 2, "ada-pm", SPEC_SHA, WHY_SHA, "ABC-12")
        self.assertIn("- Jira: `ABC-12`\n", comment)
        self.assertEqual(issue_rules.approvals([comment])[0]["jira"], "ABC-12")
        for call in (lambda: issue_rules.slice_issue_body("SLICE-001", 1, 7, [], "w", "s", jira="abc-1"),
                     lambda: issue_rules.approval_comment("SLICE-001", 1, "ada-pm", SPEC_SHA, WHY_SHA, "ABC-01")):
            with self.assertRaises(ValueError):
                call()

    def test_the_visible_line_must_say_the_markers_key(self):
        body = issue_rules.slice_issue_body("SLICE-001", 1, 7, [], "why\n", "spec\n", jira="ABC-12")
        self.assertFalse(issue_rules.parse_slice_body(body.replace("Jira: ABC-12\n", "Jira: ABC-13\n"))["intact"])
        self.assertFalse(issue_rules.parse_slice_body(body.replace("Jira: ABC-12\n", ""))["intact"])
        plain = issue_rules.slice_issue_body("SLICE-001", 1, 7, [], "why\n", "spec\n")
        self.assertFalse(issue_rules.parse_slice_body(plain.replace("## Why\n", "Jira: ABC-12\n## Why\n", 1))["intact"], "a line with no key in the marker")


def ready_with_jira(test, slice_id, jira, marker_key=None, line_key=None, approved_key="same"):
    """Product Studio's slice ready on the stand-in, with a key; the marker's, the line's and the approval's key can differ."""
    epic = test.epic_number()
    state = test.gh()
    why, spec = intent_for(slice_id), spec_for(slice_id)
    body = issue_rules.slice_issue_body(slice_id, 1, epic, [], why, spec, jira=jira)
    if marker_key is not None:
        body = body.replace(f" jira={jira} -->", f" jira={marker_key} -->", 1)
    if line_key is not None:
        body = body.replace(f"Jira: {jira}\n", f"Jira: {line_key}\n", 1)
    issue = test.new_issue(state, "Invite a teammate", body, ["mach:slice"])
    test.label(state, issue, "mach:slice")
    state["issues"][str(epic)]["sub_issues"].append(issue["id"])
    at = test.tick(state)
    approved = jira if approved_key == "same" else approved_key
    issue["comments"].append({"login": "ada-pm", "id": 3001, "created_at": at, "updated_at": at,
                              "body": issue_rules.approval_comment(slice_id, 1, "ada-pm", issue_rules.text_sha256_of(spec), issue_rules.text_sha256_of(why), approved)})
    test.label(state, issue, "mach:ready")
    test.write_state(state)
    return issue["number"]


class IntakeTest(intake_tests.Base):
    def not_accepted(self, number):
        taken = self.product("intake")
        found = [item for item in taken["not_accepted"] if item.get("issue") == number]
        self.assertEqual((len(found), taken["created"]), (1, []), taken)
        return found[0]["reason"]

    def test_the_key_reaches_the_ledger_and_the_cell(self):
        number = ready_with_jira(self, "SLICE-001", "ABC-12")
        self.product("intake")
        self.assertEqual(self.ledger()["slices"]["SLICE-001"]["jira"], "ABC-12")
        self.product("dispatch", str(number))
        self.assertEqual(self.cell(str(number))["product"]["jira"], "ABC-12")

    def test_no_key_is_null_everywhere(self):
        number = self.ready("SLICE-001")
        self.product("intake")
        self.product("dispatch", str(number))
        self.assertIsNone(self.ledger()["slices"]["SLICE-001"]["jira"])
        self.assertIsNone(self.cell(str(number))["product"]["jira"])

    def test_a_malformed_key_is_refused_in_plain_words(self):
        number = ready_with_jira(self, "SLICE-001", "ABC-12", marker_key="abc-12)", line_key="abc-12)", approved_key=None)
        self.assertEqual(self.not_accepted(number), issue_rules.SLICE_NOT_ACCEPTED["bad_jira"])

    def test_an_oversized_key_is_refused_in_plain_words(self):
        huge = "ABC-" + "1" * 400
        number = ready_with_jira(self, "SLICE-001", "ABC-12", marker_key=huge, line_key=huge, approved_key=None)
        self.assertIn("not in Jira's form", self.not_accepted(number))
        self.assertNotIn(huge, json.dumps(self.ledger()))

    def test_a_key_changed_after_approval_is_refused(self):
        number = ready_with_jira(self, "SLICE-001", "ABC-12", marker_key="ABC-13", line_key="ABC-13")
        self.assertEqual(self.not_accepted(number), issue_rules.SLICE_NOT_ACCEPTED["jira_changed"])
        number = ready_with_jira(self, "SLICE-002", "ABC-12", line_key="ABC-99")
        self.assertIn("changed after it was approved", self.not_accepted(number))

    def test_a_key_added_to_an_approval_without_one_is_refused(self):
        number = ready_with_jira(self, "SLICE-001", "ABC-12", approved_key=None)
        self.assertEqual(self.not_accepted(number), issue_rules.SLICE_NOT_ACCEPTED["jira_changed"])

    def test_a_folder_carries_the_key_and_a_bad_one_is_refused(self):
        good = self.slice(self.a, "Invite")
        record = json.loads(self.folders[good]["slice.json"])
        record["jira"] = "ABC-7"
        self.folders[good]["slice.json"] = json.dumps(record)
        bad = self.slice(self.a, "Other")
        record = json.loads(self.folders[bad]["slice.json"])
        record["jira"] = "abc-7; rm"
        self.folders[bad]["slice.json"] = json.dumps(record)
        self.publish(self.a, good, bad)
        taken = self.product("intake")
        self.assertEqual([item["slice_id"] for item in taken["created"]], [good])
        self.assertIn("is not in Jira's form", taken["not_accepted"][0]["reason"])
        self.product("dispatch", good)
        self.assertEqual(self.cell("LOCAL-001")["product"]["jira"], "ABC-7")

    def test_the_cell_never_takes_an_unchecked_key(self):
        number = ready_with_jira(self, "SLICE-001", "ABC-12")
        self.product("intake")
        path = self.eng / ".factory/intake/ledger.json"
        ledger = json.loads(path.read_text())
        ledger["slices"]["SLICE-001"]["jira"] = "<script>"  # a ledger edited by hand
        path.write_text(json.dumps(ledger))
        self.product("dispatch", str(number))
        self.assertIsNone(self.cell(str(number))["product"]["jira"])

    def test_studio_to_factory_end_to_end(self):
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        self.drafted()
        self.ok(self.a, "slice", "link", "SLICE-001", "--jira", "TEAM-42")
        number = self.ok(self.a, "slice", "ready", "SLICE-001")["issue"]
        self.set_gh(me="erin-eng")
        taken = self.product("intake")
        self.assertEqual((taken["not_accepted"], self.ledger()["slices"]["SLICE-001"]["jira"]), ([], "TEAM-42"))
        self.product("dispatch", str(number))
        self.assertEqual(self.cell(str(number))["product"]["jira"], "TEAM-42")


class StudioTest(issues_tests.IssuesBase):
    def test_slice_link_checks_the_form_and_stores_tracking(self):
        self.project_and_epic()
        self.drafted()
        calls = len(self.gh()["calls"])
        self.assertIn("not a Jira issue key", self.refused(self.a, "slice", "link", "SLICE-001", "--jira", "team-42"))
        linked = self.ok(self.a, "slice", "link", "SLICE-001", "--jira", "TEAM-42")
        self.assertEqual((linked["slice"]["tracking"], linked["jira"], linked["factory_authorized"]), ({"jira": "TEAM-42"}, "TEAM-42", False))
        self.assertTrue(self.ok(self.a, "validate")["valid"])
        unlinked = self.ok(self.a, "slice", "link", "SLICE-001", "--no-jira")
        self.assertNotIn("tracking", unlinked["slice"])
        self.assertEqual(len(self.gh()["calls"]), calls, "linking calls nothing: neither GitHub nor Jira")

    def test_the_issue_and_approval_carry_the_slices_key_else_the_epics(self):
        self.project_and_epic()
        self.ok(self.a, "epic", "link", "EPIC-001", "--jira", "TEAM-1")
        self.drafted()
        number = self.ready()["issue"]
        issue = self.issue(number)
        self.assertIn("\nJira: TEAM-1\n## Why\n", issue["body"])
        self.assertEqual(issue_rules.parse_slice_body(issue["body"])["jira"], "TEAM-1")
        self.assertEqual(issue_rules.approvals([issue["comments"][-1]["body"]])[0]["jira"], "TEAM-1")
        # A changed key needs the slice marked ready again, and it is a new revision.
        self.assertIn("reopen it first", self.refused(self.a, "slice", "link", "SLICE-001", "--jira", "TEAM-2"))
        self.ok(self.a, "slice", "reopen", "SLICE-001")
        self.ok(self.a, "slice", "link", "SLICE-001", "--jira", "TEAM-2")
        again = self.ready()
        self.assertEqual((again["issue"], again["revision"]), (number, 2))
        issue = self.issue(number)
        self.assertEqual(issue_rules.parse_slice_body(issue["body"])["jira"], "TEAM-2")
        self.assertEqual([a["jira"] for a in issue_rules.approvals([c["body"] for c in issue["comments"]])], ["TEAM-1", "TEAM-2"])

    def test_without_a_key_the_issue_is_as_before(self):
        self.project_and_epic()
        self.drafted()
        issue = self.issue(self.ready()["issue"])
        self.assertNotIn("Jira", issue["body"])
        self.assertNotIn("jira", issue["comments"][-1]["body"])

    def test_epic_link_names_slices_already_ready_with_the_old_key(self):
        self.project_and_epic()
        self.drafted()
        self.ready()
        linked = self.ok(self.a, "epic", "link", "EPIC-001", "--jira", "TEAM-1")
        self.assertEqual((linked["epic"]["tracking"], linked["already_ready"]), ({"jira": "TEAM-1"}, ["SLICE-001"]))
        self.assertIn("reopen and mark each ready again", linked["note"])

    def test_the_folder_carries_the_key(self):
        issues_tests.WithoutGhTest.no_gh(self)
        self.project_and_epic()
        self.drafted()
        self.ok(self.a, "slice", "link", "SLICE-001", "--jira", "TEAM-42")
        result = self.ready()
        record = json.loads((Path(result["folder"]) / "slice.json").read_text())
        self.assertEqual((record["jira"], record["revision"]), ("TEAM-42", 1))
        self.ok(self.a, "slice", "reopen", "SLICE-001")
        self.ok(self.a, "slice", "link", "SLICE-001", "--no-jira")
        record = json.loads((Path(self.ready()["folder"]) / "slice.json").read_text())
        self.assertEqual(("jira" in record, record["revision"]), (False, 2))


class TakeTest(order_tests.TakeBase):
    def test_another_product_managers_slice_keeps_its_key(self):
        self.project_and_epic(self.a)
        slice_id = self.drafted(self.a)
        self.ok(self.a, "slice", "link", slice_id, "--jira", "TEAM-42")
        number = self.ready(slice_id, self.a)["issue"]
        self.set_gh(me="ben-pm")
        # Starting the project in a repository that has one on GitHub brings it in, its slices too.
        joined = self.ok(self.b, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together")
        self.assertEqual([(row["slice_id"], row["issue"]) for row in joined["taken"]["slices"]], [(slice_id, number)])
        self.assertEqual(self.artifact(self.b, f"product/slices/{slice_id}.json")["tracking"], {"jira": "TEAM-42"})


class MergeTest(merge_tests.PullRequestBase):
    def with_key(self, key="TEAM-42", browse_url=None, **merge):
        head = self.approved(**merge)
        self.set_cell(product={"slice_id": "SLICE-001", "revision": 1, "jira": key})
        if browse_url is not None:
            config = json.loads((self.project / ".factory/config.json").read_text())
            config["tickets"] = {"jira": {"browse_url": browse_url}}
            self.put(self.project, {".factory/config.json": json.dumps(config)})
        return head

    def record_text(self):
        return (self.work / "docs/changes/LOCAL-001.md").read_text()  # the record is committed on the ticket's branch

    def test_a_local_merge_puts_the_key_in_the_merge_commit_and_the_record(self):
        self.with_key(mode="auto")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["jira"], "TEAM-42")
        self.assertEqual(self.main_log()[0], "TEAM-42 Merge LOCAL-001: Invite a teammate by email")
        self.assertIn("\n- Jira: TEAM-42\n", self.record_text())

    def test_the_pull_request_title_starts_with_the_key_and_the_body_links_it(self):
        self.with_key(browse_url="https://example.atlassian.net/browse/", mode="auto", method="pr")
        self.m_ok("run", "LOCAL-001")
        create = next(call for call in self.calls() if call[:2] == ["pr", "create"])
        title, body = create[create.index("--title") + 1], create[create.index("--body") + 1]
        self.assertEqual(title, "TEAM-42 LOCAL-001: Invite a teammate by email")
        self.assertIn("**Jira:** [TEAM-42](https://example.atlassian.net/browse/TEAM-42)", body)
        self.assertIn("\n- Jira: [TEAM-42](https://example.atlassian.net/browse/TEAM-42)\n", self.record_text())
        self.assertEqual([call[:2] for call in self.calls()], [["pr", "create"], ["pr", "view"], ["pr", "merge"], ["pr", "view"]],
                         "the key adds no call: no Jira, no other gh command")

    def test_no_key_changes_nothing(self):
        self.approved(mode="auto", method="pr")
        self.m_ok("run", "LOCAL-001")
        create = next(call for call in self.calls() if call[:2] == ["pr", "create"])
        self.assertEqual(create[create.index("--title") + 1], "LOCAL-001: Invite a teammate by email")
        self.assertNotIn("Jira", create[create.index("--body") + 1])
        self.assertNotIn("Jira", self.record_text())

    def test_an_unchecked_key_in_the_cell_reaches_nothing(self):
        self.with_key(key="TEAM-42 [x](https://evil.example/)", mode="auto")
        done = self.m_ok("run", "LOCAL-001")
        self.assertIsNone(done["jira"])
        self.assertEqual(self.main_log()[0], "Merge LOCAL-001: Invite a teammate by email")
        self.assertNotIn("evil", self.record_text())

    def test_a_browse_url_that_is_not_plain_https_refuses_the_merge(self):
        self.with_key(mode="auto")
        for url in ("http://example.atlassian.net/browse/", "https://user:pw@example.atlassian.net/browse/", "https://example.atlassian.net/browse",
                    "https://example.atlassian.net/browse/?q=1/", "javascript:alert(1)//", "https://" + "a" * 300 + ".net/", 7):
            with self.subTest(url=url):
                self.put(self.project, {".factory/config.json": json.dumps({"merge": {"mode": "auto"}, "tickets": {"jira": {"browse_url": url}}})})
                self.assertIn("tickets.jira.browse_url", self.m_refused("run", "LOCAL-001"))
                self.assertEqual(self.cell_json()["stage"], "approved")

    def test_the_run_record_keeps_the_key(self):
        sys.path.insert(0, str(ROOT / "skills" / "cleanup" / "scripts"))
        import cleanup  # noqa: E402
        self.with_key(mode="auto")
        cell = cleanup.Cell(self.project, "LOCAL-001")
        self.assertEqual(cleanup.run_record(cell, "merged", None, "x.tar.gz")["jira"], "TEAM-42")
        self.set_cell(product={"slice_id": "SLICE-001", "jira": "nope"})
        self.assertNotIn("jira", cleanup.run_record(cleanup.Cell(self.project, "LOCAL-001"), "merged", None, "x.tar.gz"))
        self.set_cell(product={"slice_id": "SLICE-001"})
        self.assertNotIn("jira", cleanup.run_record(cleanup.Cell(self.project, "LOCAL-001"), "merged", None, "x.tar.gz"))


class NoNetworkTest(unittest.TestCase):
    """Nothing that carries the key can reach Jira: no network library is imported, and no command names Jira."""

    FILES = ["skills/ticket/scripts/issue_rules.py", "skills/studio/scripts/studio.py", "skills/studio/scripts/handoff.py",
             "skills/studio/scripts/product.py", "skills/studio/scripts/jira_export.py", "skills/run/scripts/intake.py", "skills/merge/scripts/merge.py",
             "skills/merge/scripts/change_record.py", "skills/cleanup/scripts/cleanup.py"]

    def test_no_network_library_and_no_command_names_jira(self):
        for name in self.FILES:
            source = (ROOT / name).read_text()
            imported = set()
            for node in ast.walk(ast.parse(source)):
                if isinstance(node, ast.Import):
                    imported |= {alias.name.split(".")[0] for alias in node.names}
                elif isinstance(node, ast.ImportFrom):
                    imported.add((node.module or "").split(".")[0])
            self.assertFalse(imported & {"socket", "http", "urllib", "requests", "ssl", "ftplib", "smtplib", "xmlrpc"}, (name, imported))
            for call in re.findall(r"\b(?:git|gh|subprocess\.run|_gh_json|_gh_write|gh_read|gh_call)\([^\n]*", source):
                self.assertNotIn("jira", call.lower(), (name, call))
                self.assertNotIn("browse_url", call, (name, call))


if __name__ == "__main__":
    unittest.main()
