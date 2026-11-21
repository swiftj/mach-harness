"""M16 part A: the brief's grammar and the case's (validate_brief.py), and the shared templates for an idea's issue.

The validator is pure: the shipped rules and the IDs an earlier revision took out are inputs. Every rule it holds a
brief to is exercised here, one finding at a time, with the fixture brief otherwise passing.
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for folder in ("ticket", "intent", "product-studio"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import issue_rules  # noqa: E402
import issues  # noqa: E402
import validate_brief  # noqa: E402

SHIPPED = [{"rule": "SLICE-004/FR-02", "in_force": True}, {"rule": "SLICE-004/FR-03", "in_force": True},
           {"rule": "SLICE-007/INV-01", "in_force": True}, {"rule": "SLICE-002/FR-01", "in_force": False}]

BRIEF = """# Brief: Let members renew a loan themselves

## Problem

A member who wants more time with a book has to call or come in.

## Who has it

Members with items on loan. Desk staff at Central.

## Outcomes

- **O-1:** Members renew without calling the library.
  - How we would know: renewal calls at Central fall from about 40 a week to under 15 within two months.
- **O-2:** Members are not surprised by a renewal that was refused.
  - How we would know: complaints about unexpected fines after a refused renewal fall to none in a quarter.

## Not doing

Changing how many times a loan can be renewed.

## Assumptions

- **A-1:** Most renewal calls are for items nobody is waiting for. (assumed, not confirmed)
- **A-2:** Members who renew already sign in to the catalogue. (confirmed by the head of lending services on 2026-11-18)

## Open questions

None.

## Risks

A branch loses sight of items it wanted back for a display.

## What it touches

- Capabilities: Lending (EPIC-001), Member account
- Shipped rules: SLICE-004/FR-02, SLICE-007/INV-01
"""

CASE = """# Case: Let members renew a loan themselves

## As the customer would hear it

You can now renew a loan from your account, at any hour, without calling us. If you cannot renew, the page tells you why.

## Hard questions

- **Q-1:** Who would not want this?
  - Answer: Desk staff at the small branches, who use renewal calls to check on older members.
- **Q-2:** What does it cost if A-1 is wrong?
  - Answer: Calls fall less than we hope, and O-1 is not met.
- **Q-3:** What would make us stop?
  - Not answered: the product manager wants the first month's numbers first.
"""


def brief(old, new, count=1):
    assert old in BRIEF, old
    return BRIEF.replace(old, new, count)


def check(text, shipped=SHIPPED, removed=()):
    findings, model = validate_brief.analyze(text, shipped, removed)
    return findings, model


def rules_of(findings, severity="error"):
    return sorted({f.rule for f in findings if f.severity == severity})


class BriefTest(unittest.TestCase):
    def assert_error(self, text, rule, removed=(), shipped=SHIPPED):
        findings, _ = check(text, shipped, removed)
        self.assertIn(rule, rules_of(findings), [f.message for f in findings])
        return [f for f in findings if f.rule == rule]

    def test_the_fixture_passes_and_its_model(self):
        findings, model = check(BRIEF)
        self.assertEqual(rules_of(findings), [])
        self.assertEqual(rules_of(findings, "warning"), [])
        self.assertEqual(model["title"], "Let members renew a loan themselves")
        self.assertEqual([(o["id"], o["how_we_would_know"][:16]) for o in model["outcomes"]], [("O-1", "renewal calls at"), ("O-2", "complaints about")])
        self.assertEqual([(a["id"], a["state"], a["confirmed_by"], a["confirmed_on"]) for a in model["assumptions"]],
                         [("A-1", "assumed", None, None), ("A-2", "confirmed", "the head of lending services", "2026-11-18")])
        self.assertEqual(model["touches"], {"capabilities": [{"name": "Lending", "epic_id": "EPIC-001"}, {"name": "Member account", "epic_id": None}],
                                            "shipped_rules": ["SLICE-004/FR-02", "SLICE-007/INV-01"]})
        self.assertEqual(model["open_questions"], [])
        self.assertEqual(model["sections"], list(validate_brief.SECTIONS))

    def test_a_missing_or_empty_required_section(self):
        for name in validate_brief.REQUIRED:
            start = BRIEF.index(f"## {name}")
            end = BRIEF.find("\n## ", start + 3)
            cut = BRIEF[:start] + (BRIEF[end + 1:] if end > 0 else "")
            self.assert_error(cut, "brief-missing-section")
        self.assert_error(brief("A member who wants more time with a book has to call or come in.\n", ""), "brief-empty-section")
        self.assert_error(brief("Members with items on loan. Desk staff at Central.", "None."), "brief-empty-section")

    def test_none_is_an_answer_where_the_grammar_allows_it(self):
        text = brief("Changing how many times a loan can be renewed.", "None.")
        text = text.replace("A branch loses sight of items it wanted back for a display.", "None.")
        start, end = text.index("- **A-1:**"), text.index("## Open questions")
        text = text[:start] + "None.\n\n" + text[end:]
        text = text.replace("- Shipped rules: SLICE-004/FR-02, SLICE-007/INV-01", "- Shipped rules: None.")
        findings, model = check(text)
        self.assertEqual(rules_of(findings), [], [f.message for f in findings])
        self.assertEqual((model["assumptions"], model["touches"]["shipped_rules"], model["not_doing"], model["risks"]), ([], [], None, None))
        # Optional sections may be left out altogether.
        for name in ("Not doing", "Open questions", "Risks"):
            start = BRIEF.index(f"## {name}")
            end = BRIEF.index("\n## ", start + 3)
            self.assertEqual(rules_of(check(BRIEF[:start] + BRIEF[end + 1:])[0]), [], name)

    def test_an_outcome_with_no_way_to_know(self):
        for how in ("  - How we would know: not written yet", "  - How we would know:", "  - How we would know: TBD"):
            text = brief("  - How we would know: complaints about unexpected fines after a refused renewal fall to none in a quarter.", how)
            found = self.assert_error(text, "brief-outcome-how")
            self.assertIn("O-2 has no way to know it happened", found[0].message)
        text = brief("  - How we would know: complaints about unexpected fines after a refused renewal fall to none in a quarter.\n", "")
        self.assert_error(text, "brief-outcome-how")

    def test_a_how_with_no_measure_is_a_warning(self):
        findings, _ = check(brief("complaints about unexpected fines after a refused renewal fall to none in a quarter.", "members feel happier."))
        self.assertEqual(rules_of(findings), [])
        self.assertIn("brief-how-vague", rules_of(findings, "warning"))

    def test_a_duplicate_or_malformed_id(self):
        self.assert_error(brief("- **O-2:**", "- **O-1:**"), "brief-duplicate-id")
        self.assert_error(brief("- **A-2:**", "- **A-1:**"), "brief-duplicate-id")
        for bad in ("- **O1:**", "- **O-01:**", "- **o-2:**"):
            self.assert_error(brief("- **O-2:**", bad), "brief-malformed-id")
        self.assert_error(brief("- **A-2:**", "- **A2:**"), "brief-malformed-id")
        self.assert_error(brief("SLICE-007/INV-01", "SLICE-7/INV-1"), "brief-malformed-id")
        findings, _ = check(brief("- **O-1:** Members renew", "- **O-3:** Members renew"))
        self.assertIn("brief-id-order", rules_of(findings, "warning"))

    def test_an_id_taken_out_earlier_is_never_reused(self):
        found = self.assert_error(BRIEF, "brief-id-reused", removed=["O-2"])
        self.assertIn("O-2 was taken out of an earlier revision", found[0].message)
        self.assertEqual(rules_of(check(BRIEF, removed=["O-3", "A-3"])[0]), [])

    def test_an_assumption_with_no_state(self):
        found = self.assert_error(brief(" (assumed, not confirmed)", ""), "brief-assumption-state")
        self.assertIn("A-1 has no state", found[0].message)
        self.assert_error(brief("(confirmed by the head of lending services on 2026-11-18)", "(confirmed by the head of lending services)"), "brief-assumption-state")

    def test_a_shipped_rule_not_in_force_or_not_shipped(self):
        found = self.assert_error(brief("SLICE-007/INV-01", "SLICE-002/FR-01"), "brief-rule-not-in-force")
        self.assertIn("no longer in force", found[0].message)
        self.assert_error(brief("SLICE-007/INV-01", "SLICE-009/FR-01"), "brief-rule-not-shipped")
        self.assert_error(BRIEF, "brief-rule-not-shipped", shipped=[])  # nothing shipped: every named rule is refused
        self.assertEqual(rules_of(check(BRIEF, shipped=None)[0]), [])  # not given: not checked

    def test_technology_in_an_outcome_is_an_error_and_elsewhere_a_warning(self):
        found = self.assert_error(brief("Members renew without calling the library.", "Members renew through the renewal API endpoint."), "brief-technology")
        self.assertIn("names technology (api, endpoint)", found[0].message)
        findings, _ = check(brief("has to call or come in.", "has to call or come in, and the database is slow."))
        self.assertEqual(rules_of(findings), [])
        self.assertIn("brief-technology", rules_of(findings, "warning"))

    def test_text_shaped_like_a_secret_is_refused_without_its_value(self):
        token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
        found = self.assert_error(brief("Desk staff at Central.", f"Desk staff at Central. Their token is {token}."), "brief-secret")
        self.assertNotIn(token, json.dumps([f.message for f in found]))

    def test_warnings_never_errors(self):
        text = brief("## Open questions\n\nNone.", "## Open questions\n\n- What does a member see when a renewal is refused?")
        text = text.replace("has to call or come in.", "probably has to call or come in.")
        findings, model = check(text)
        self.assertEqual(rules_of(findings), [])
        self.assertEqual(rules_of(findings, "warning"), ["brief-hidden-assumption", "brief-open-question"])
        self.assertEqual(model["open_questions"], ["What does a member see when a renewal is refused?"])
        # An assumption stated as a fact in the prose.
        stated = brief("Desk staff at Central.", "Desk staff at Central. Most renewal calls are for items nobody is waiting for.")
        self.assertIn("brief-hidden-assumption", rules_of(check(stated)[0], "warning"))

    def test_the_grammar_itself(self):
        self.assert_error(brief("# Brief: Let members", "# Idea: Let members"), "brief-title")
        self.assert_error(brief("## Risks", "## Dangers"), "brief-heading")
        self.assert_error(brief("## Risks", "### Risks"), "brief-heading")
        self.assert_error(BRIEF + "\n## Problem\n\nAgain.\n", "brief-duplicate-section")
        moved = BRIEF.replace("## Who has it\n\nMembers with items on loan. Desk staff at Central.\n\n", "")
        moved = moved.replace("## What it touches", "## Who has it\n\nMembers with items on loan.\n\n## What it touches")
        self.assert_error(moved, "brief-section-order")
        self.assert_error(brief("- **O-1:** Members renew", "Members renew\n- **O-1:** Members renew"), "brief-outcome-line")
        self.assert_error(brief("  - How we would know: renewal calls", "  - How we would know: x\n  - How we would know: renewal calls"), "brief-outcome-line")
        self.assert_error(brief("- Capabilities: Lending (EPIC-001), Member account", "- Capabilities:"), "brief-capability")
        self.assert_error(brief("- Shipped rules: SLICE-004/FR-02, SLICE-007/INV-01\n", ""), "brief-touches-line")
        self.assert_error(brief("A branch loses sight", "<what could go wrong> A branch loses sight"), "brief-placeholder")
        self.assert_error("", "brief-title")

    def test_the_script_reads_only_and_says_what_it_found(self):
        path = Path(self.id().replace(".", "_") + ".md")
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / path.name
            target.write_text(BRIEF)
            shipped = Path(folder) / "shipped.json"
            shipped.write_text(json.dumps({"rules": SHIPPED}))
            done = subprocess.run([sys.executable, str(ROOT / "skills/product-studio/scripts/validate_brief.py"), "brief", str(target), "--shipped", str(shipped)],
                                  capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertTrue(json.loads(done.stdout)["valid"])
            done = subprocess.run([sys.executable, str(ROOT / "skills/product-studio/scripts/validate_brief.py"), "brief", str(target), "--removed", "O-1"],
                                  capture_output=True, text=True)
            self.assertEqual(done.returncode, 1)
            self.assertEqual(sorted(Path(folder).iterdir()), sorted([target, shipped]))


class CaseTest(unittest.TestCase):
    def setUp(self):
        self.model = check(BRIEF)[1]

    def case_rules(self, text, severity="error"):
        return rules_of(validate_brief.analyze_case(text, self.model)[0], severity)

    def test_the_fixture_passes_and_its_model(self):
        findings, model = validate_brief.analyze_case(CASE, self.model)
        self.assertEqual(rules_of(findings) + rules_of(findings, "warning"), [])
        self.assertEqual((model["customer_sentences"], model["answered"], model["not_answered"], model["open"]), (2, 2, 1, 0))
        self.assertTrue(model["customer"].startswith("You can now renew a loan from your account"))  # the words, for the app
        self.assertEqual([q["state"] for q in model["questions"]], ["answered", "answered", "not_answered"])

    def test_a_question_not_answered_is_refused_until_answered_or_marked(self):
        text = CASE.replace("  - Not answered: the product manager wants the first month's numbers first.\n", "")
        self.assertIn("case-unanswered", self.case_rules(text))
        self.assertEqual(self.case_rules(CASE.replace("Not answered: the product manager wants the first month's numbers first.", "Not answered.")), [])
        self.assertIn("case-unanswered", self.case_rules(CASE.replace("  - Answer: Desk staff at the small branches, who use renewal calls to check on older members.",
                                                                      "  - Answer:")))
        self.assertIn("case-answer-line", self.case_rules(CASE.replace("  - Answer: Calls fall", "  - Answer: Yes.\n  - Answer: Calls fall")))

    def test_the_case_has_its_sentences(self):
        self.assertIn("case-sentences", self.case_rules(CASE.replace("You can now renew a loan from your account, at any hour, without calling us. If you cannot renew, the page tells you why.",
                                                                     "None.")))
        self.assertIn("case-sentences", self.case_rules(CASE.replace("If you cannot renew, the page tells you why.", "One. Two. Three. Four. Five. Six.")))
        self.assertIn("case-sentences", self.case_rules(CASE.replace("You can now renew a loan from your account, at any hour, without calling us. If you cannot renew, the page tells you why.",
                                                                     "renew online")))

    def test_the_grammar_ids_references_and_secrets(self):
        self.assertIn("case-missing-section", self.case_rules(CASE[:CASE.index("## Hard questions")]))
        self.assertIn("case-empty-section", self.case_rules(CASE[:CASE.index("- **Q-1:**")]))
        self.assertIn("case-duplicate-id", self.case_rules(CASE.replace("- **Q-2:**", "- **Q-1:**")))
        self.assertIn("case-malformed-id", self.case_rules(CASE.replace("- **Q-2:**", "- **Q2:**")))
        self.assertIn("case-title", self.case_rules(CASE.replace("# Case:", "# Pitch:")))
        self.assertIn("case-unknown-id", self.case_rules(CASE.replace("A-1 is wrong", "A-7 is wrong"), "warning"))
        self.assertIn("case-secret", self.case_rules(CASE.replace("older members.", "older members. AKIA" + "ABCDEFGHIJKLMNOP")))
        self.assertIn("case-technology", self.case_rules(CASE.replace("without calling us.", "through our new API."), "warning"))


class IssueTemplateTest(unittest.TestCase):
    """issue_rules: the idea's issue body, the verdict comment, their strict parsers and the one state label."""

    def test_the_body_reads_back_exactly_and_an_edit_is_caught(self):
        body = issue_rules.shape_issue_body("IDEA-019", 3, BRIEF, {"kind": "request", "repository": "acme/x", "number": 57})
        self.assertTrue(body.startswith("<!-- mach:shape idea=IDEA-019 revision=3 brief-sha256="))
        self.assertIn(" from=request:#57 -->\n", body)
        parsed = issue_rules.parse_shape_body(body)
        self.assertEqual((parsed["idea_id"], parsed["revision"], parsed["brief"], parsed["intact"], parsed["source"]),
                         ("IDEA-019", 3, BRIEF, True, {"kind": "request", "number": 57}))
        self.assertTrue(issue_rules.parse_shape_body(body.rstrip("\n"))["intact"])  # GitHub may drop the last newline
        self.assertTrue(issue_rules.parse_shape_body(body.replace("\n", "\r\n"))["intact"])
        edited = issue_rules.parse_shape_body(body.replace("40 a week", "50 a week"))
        self.assertEqual((edited["intact"], edited["brief"]), (False, None))
        self.assertFalse(issue_rules.parse_shape_body(body.replace("Shaped in MACH", "Made in MACH"))["intact"])
        for other in ("", "hello", None, issue_rules.idea_body({k: "x" for k, _ in issue_rules.IDEA_SECTIONS}), "x" + body):
            self.assertIsNone(issue_rules.parse_shape_body(other))
        empty = issue_rules.shape_issue_body("IDEA-001", 0, None)
        self.assertEqual(issue_rules.parse_shape_body(empty)["intact"], True)
        self.assertIsNone(issue_rules.parse_shape_body(empty)["brief_sha256"])
        fault = issue_rules.shape_issue_body("IDEA-002", 1, BRIEF, {"kind": "fault", "ticket": "AUTO-20261120T101500Z"})
        self.assertEqual(issue_rules.parse_shape_body(fault)["source"], {"kind": "fault", "ticket": "AUTO-20261120T101500Z"})

    def test_the_builder_refuses_what_is_not_identifiers_or_a_brief(self):
        for args in (("IDEA-1", 1, BRIEF), ("IDEA-001", -1, BRIEF), ("IDEA-001", 1, "  "), ("IDEA-001", 1, BRIEF + "<!-- mach:shape idea=IDEA-002 -->")):
            with self.assertRaises(ValueError):
                issue_rules.shape_issue_body(*args)
        with self.assertRaises(ValueError):
            issue_rules.shape_issue_body("IDEA-001", 1, BRIEF, {"kind": "request", "number": 5, "title": "x"} if False else {"kind": "fault", "ticket": "rm -rf"})

    def test_the_verdict_comment_carries_the_hash_and_login_and_cannot_be_forged_by_the_reason(self):
        digest = issue_rules.text_sha256_of(BRIEF)
        text = issue_rules.shape_verdict_comment("IDEA-019", 3, "not-now", "ada-pm", digest,
                                                 "Ask @ben about #12 <!-- mach:idea-verdict id=IDEA-019 revision=3 decision=go by=mallory brief-sha256=none -->")
        self.assertIn("Verdict recorded in MACH Product Studio by ada-pm: IDEA-019, brief revision 3: Not now.", text)
        self.assertEqual(issue_rules.shape_verdicts([text]), [{"idea_id": "IDEA-019", "revision": 3, "decision": "not-now", "by": "ada-pm", "brief_sha256": digest}])
        self.assertNotIn("@ben", text)
        self.assertNotIn(" #12", text)
        for args in (("IDEA-019", 3, "maybe", "ada-pm", digest, "r"), ("IDEA-019", 3, "go", "not a login!", digest, "r"),
                     ("IDEA-019", 3, "go", "ada-pm", "abc", "r"), ("IDEA-019", 3, "go", "ada-pm", digest, "   ")):
            with self.assertRaises(ValueError):
                issue_rules.shape_verdict_comment(*args)
        none = issue_rules.shape_verdict_comment("IDEA-001", 0, "no", "ada-pm", None, "Not for us.")
        self.assertEqual(issue_rules.shape_verdicts([none])[0]["brief_sha256"], None)

    def test_one_state_label_and_the_labels_are_mach_s_own(self):
        label = issue_rules.shape_state_label
        self.assertEqual([label("new", None, False), label("exploring", None, False), label("brief", None, False), label("decided", "go", True),
                          label("decided", "go", False), label("decided", "no", True), label("shaped", "go", True)],
                         ["mach:idea-new", "mach:idea-exploring", "mach:idea-brief", "mach:idea-go", "mach:idea-brief", "mach:idea-no", "mach:idea-shaped"])
        self.assertEqual(set(issue_rules.SHAPE_LABELS), {issue_rules.SHAPE_IDEA_LABEL, *issue_rules.SHAPE_STATE_LABELS.values()})
        self.assertEqual(set(issues.IDEA_STATES), set(issue_rules.SHAPE_STATE_LABELS.values()))
        import shape  # the engine's own ID and fault patterns are the shared ones
        self.assertEqual((shape.IDEA_RE.pattern, shape.FAULT_RE.pattern), (issue_rules.SHAPE_IDEA_ID_RE.pattern, issue_rules.SHAPE_FAULT_RE.pattern))
        self.assertEqual(shape.VERDICTS, issue_rules.SHAPE_VERDICTS)
        for name in issue_rules.SHAPE_LABELS:
            self.assertTrue(name.startswith("mach:idea"))
            self.assertNotIn(name, ("mach:ready", "mach:slice", "mach:request"))  # nothing the Factory or the request intake reads


if __name__ == "__main__":
    unittest.main()
