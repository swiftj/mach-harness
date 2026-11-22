"""M18 parts A to C (Product Studio): a light path for small changes.

small.py (the intent station's) decides, by fixed rules, whether a change is small, with one fixed sentence naming the
rule that decided; nothing takes an override. Product Studio starts a small change (`slice new --small`, `request pick
--small`), reports its kind, and widens it (`slice widen`, or the check by itself) without refusing it for its size or
trimming it. A project that never starts a small change behaves exactly as before.
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("ticket", "intent", "product-studio"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import product  # noqa: E402
import small  # noqa: E402
import validate_slice  # noqa: E402
from test_mach_product_studio import Base, git  # noqa: E402
from test_mach_requests import RequestBase  # noqa: E402

NAME = "SLICE-001-expired-invitation-message.md"
MESSAGE = "This invitation has expired. Ask the person who invited you for a new one."
SPEC = f"""# SLICE-001: Clearer expired invitation message

## Summary

- **Actor:** Invitee
- **Trigger:** The invitee opens an invitation link that has expired
- **Outcome:** The invitee is told who to ask for a new invitation

## Scope

### In scope

- The message shown when an expired invitation link is opened

### Out of scope

- None.

## Preconditions

- The invitation link was sent more than 7 days ago

## Invariants

- **INV-01:** An expired invitation link MUST NOT add the invitee to the workspace.

## Functional requirements

- **FR-01:** [Unwanted behavior] If the invitee opens an expired invitation link, then the system SHALL display "{MESSAGE}"

## Acceptance criteria

### Decision matrix

| Rule | Link expired (Yes / No) | Expected outcome | Side effects | Covers |
|---|---|---|---|---|
| R1 | Yes | Shows "{MESSAGE}" | None | FR-01, INV-01 |
| R2 | No | Not possible: this slice covers only expired links | None | INV-01 |

### Scenarios

#### AC-01: An expired link says who to ask

- **Covers:** FR-01, INV-01
- **Given** an invitation was sent to "sam@example.com" 8 days ago
- **When** the invitee opens the invitation link
- **Then** the system displays "{MESSAGE}"
- **And** "sam@example.com" is not a member of the workspace

## Effects on shipped behaviour

None.

## Dependencies and permissions

- **External dependencies:** None.
- **Required permissions:** None.

## Assumptions

- None.

## Accepted defaults

- None.

## Open questions

- None.
"""
INTENT = """# Intent: Clearer expired invitation message

- **Slice:** {slice_id} at specs/slices/{name}
- **Status:** Ready for approval

## Why

- **Problem:** An invitee with an expired link does not know who to ask.
- **Who it is for:** An invitee.
- **Success looks like:** The invitee asks the right person for a new invitation.

## Goal ancestry

- **Goal:** Teams can work together
- **Epic:** EPIC-001: Team membership
- **Slice:** {slice_id}: An expired link says who to ask.

## Constraints

- None.

## Risk

- **Tier:** {tier}
- **Reason:** It changes one message.

## Deferred work

- None.
"""
EXTRA_FRS = "".join(f"- **FR-0{n}:** [Ubiquitous] The system SHALL show line {n} of the help text on the expired link page.\n" for n in (2, 3, 4))
SHIPPED_HEAD = "| Shipped rule | Effect | In this slice | Note |\n|---|---|---|---|\n"


def spec_as(slice_id="SLICE-001", text=SPEC):
    return text.replace("# SLICE-001:", f"# {slice_id}:", 1)


def with_frs(text, rows=EXTRA_FRS):
    """The spec with more requirements, each covered by AC-01 so the spec stays valid."""
    text = text.replace(f"display \"{MESSAGE}\"\n\n## Acceptance criteria", f"display \"{MESSAGE}\"\n{rows}\n## Acceptance criteria", 1)
    ids = ", ".join(f"FR-0{n}" for n in range(2, 2 + rows.count("**FR-")))
    return text.replace("- **Covers:** FR-01, INV-01\n- **Given**", f"- **Covers:** FR-01, INV-01, {ids}\n- **Given**", 1)


def with_scenarios(text, count):
    extra = "".join(f"\n#### AC-0{n}: The message holds, case {n}\n\n- **Covers:** FR-01\n- **Given** an invitation was sent {n + 7} days ago\n"
                    f"- **When** the invitee opens the invitation link\n- **Then** the system displays \"{MESSAGE}\"\n" for n in range(2, 2 + count))
    return text.replace("is not a member of the workspace\n\n## Effects", "is not a member of the workspace\n" + extra + "\n## Effects", 1)


def with_effects(text, *rows):
    return text.replace("## Effects on shipped behaviour\n\nNone.\n", "## Effects on shipped behaviour\n\n" + SHIPPED_HEAD + "".join(r + "\n" for r in rows), 1)


def with_section(text, heading, body):
    """An optional section placed after Effects on shipped behaviour (Principles, then Policies)."""
    return text.replace("\n## Dependencies and permissions", f"\n## {heading}\n\n{body}\n## Dependencies and permissions", 1)


def analyze(text, shipped=None):
    findings, model = validate_slice.analyze(text, NAME, shipped=shipped)
    return [f for f in findings if f.severity == "error"], model


def judged(text, shipped=None, **given):
    _, model = analyze(text, shipped)
    return small.judge(model, text, **given)


class RulesTest(unittest.TestCase):
    """Part A's rules, each small and not small, with its fixed sentence."""

    def test_the_small_spec_is_valid_and_small(self):
        errors, model = analyze(SPEC, shipped=[])
        self.assertEqual(errors, [])
        found = small.judge(model, SPEC, epics=["EPIC-001"], risks=["Low"], shipped_slices=[])
        self.assertEqual(found, {"verdict": "small", "small": True, "rule": None, "sentence": small.SMALL_SENTENCE, "failed": []})
        self.assertEqual(small.SMALL_SENTENCE, "This is a small change: every rule for a small change holds.")

    def assertNotSmall(self, found, rule):
        self.assertEqual((found["verdict"], found["small"], found["rule"]), ("not small", False, rule), found)
        self.assertEqual(found["sentence"], small.sentence(rule))
        self.assertTrue(found["sentence"].startswith("This is not a small change: "))

    def test_one_actor(self):
        for actor in ("Invitee or workspace admin", "Invitee and admin", "Invitee / admin", "Invitee, admin"):
            self.assertNotSmall(judged(SPEC.replace("- **Actor:** Invitee", f"- **Actor:** {actor}")), "actor")
        self.assertTrue(judged(SPEC.replace("- **Actor:** Invitee", "- **Actor:** Invitee (with or without an account)"))["small"])
        self.assertEqual(small.sentence("actor"), "This is not a small change: a small change has one actor, and this one names more than one.")

    def test_one_capability(self):
        self.assertNotSmall(judged(SPEC, epics=["EPIC-001", "EPIC-002"]), "capability")
        self.assertTrue(judged(SPEC, epics=["EPIC-001", "EPIC-001", None])["small"])
        self.assertTrue(judged(SPEC, epics=[])["small"], "a ticket with no epic is judged on the rest")

    def test_requirements_and_scenarios(self):
        three = with_frs(SPEC, EXTRA_FRS.split("\n", 2)[0] + "\n" + EXTRA_FRS.split("\n", 2)[1] + "\n")
        self.assertEqual(analyze(three)[0], [])
        self.assertTrue(judged(three)["small"])
        four = with_frs(SPEC)
        self.assertEqual(analyze(four)[0], [])
        self.assertNotSmall(judged(four), "requirements")
        self.assertIn("at most 3 functional requirements", judged(four)["sentence"])
        self.assertTrue(judged(with_scenarios(SPEC, 3))["small"])
        self.assertEqual(analyze(with_scenarios(SPEC, 4))[0], [])
        self.assertNotSmall(judged(with_scenarios(SPEC, 4)), "scenarios")

    def test_one_decision_matrix(self):
        second = "\n\n| Rule | Seen (Yes / No) | Expected outcome | Side effects | Covers |\n|---|---|---|---|---|\n| R3 | Yes | Shown | Noted | FR-01 |\n"
        text = SPEC.replace("| R2 | No | Not possible: this slice covers only expired links | None | INV-01 |\n",
                            "| R2 | No | Not possible: this slice covers only expired links | None | INV-01 |\n" + second, 1)
        self.assertEqual(small.matrix_tables(SPEC), 1)
        self.assertEqual(small.matrix_tables(text), 2)
        self.assertNotSmall(judged(text), "matrix")
        self.assertEqual(small.matrix_tables(None), 0)

    def test_shipped_rules(self):
        shipped = ["SLICE-007/FR-01", "SLICE-007/FR-02", "SLICE-007/INV-01"]
        one = with_effects(SPEC, "| SLICE-007/FR-01 | changed | FR-01 | |", "| SLICE-007/INV-01 | kept | AC-01 | Still holds. |",
                           "| SLICE-007/FR-02 | kept | AC-01 | Still holds. |")
        self.assertEqual(analyze(one, shipped)[0], [])
        self.assertTrue(judged(one, shipped)["small"], "one changed and any number kept")
        two = with_effects(SPEC, "| SLICE-007/FR-01 | changed | FR-01 | |", "| SLICE-007/FR-02 | replaced | INV-01 | |")
        self.assertEqual(analyze(two, shipped)[0], [])
        self.assertNotSmall(judged(two, shipped), "changed-rules")
        self.assertIn("at most 1 shipped rule,", judged(two, shipped)["sentence"])
        retired = with_effects(SPEC, "| SLICE-007/FR-02 | retired | | The product manager no longer wants it. |")
        self.assertEqual(analyze(retired, shipped)[0], [])
        self.assertNotSmall(judged(retired, shipped), "retired-rule")

    def test_principles_and_policies(self):
        row = '- **PP-01** (revision 1): "A published version MUST NOT be edited in place." **{answer}:** {value}\n'
        applies = with_section(SPEC, "Principles", row.format(answer="Applies", value="INV-01."))
        self.assertTrue(judged(applies)["small"])
        self.assertTrue(judged(with_section(SPEC, "Principles", row.format(answer="Does not apply", value="It changes a message.")))["small"])
        exception = with_section(SPEC, "Principles", row.format(answer="Exception", value="The product manager accepts it for this message."))
        self.assertEqual(analyze(exception)[0], [])
        self.assertNotSmall(judged(exception), "principle-exception")
        followed = with_section(SPEC, "Policies", "- **POL-privacy** (sha256 1a2b3c4d5e6f): Followed.\n")
        self.assertTrue(judged(followed)["small"])
        for resolution in ("open.", 'accepted by Privacy team (not checked against the owner) on 2026-11-20: "Fine for this message."', "spec changed."):
            concerns = with_section(SPEC, "Policies", "- **POL-privacy** (sha256 1a2b3c4d5e6f): Concerns.\n"
                                    f'  - **POL-privacy-03**: "Messages MUST name no person." **Cannot be met:** It names the inviter. '
                                    f"**Owner:** Privacy team. **Resolution:** {resolution}\n")
            _, model = analyze(concerns)
            self.assertEqual(model["policies"][0]["answer"], "concerns", resolution)
            self.assertNotSmall(small.judge(model, concerns), "policy-concern")

    def test_permissions_and_dependencies(self):
        self.assertTrue(judged(SPEC.replace("- **Required permissions:** None.", "- **Required permissions:** None. Anyone with the link."))["small"])
        self.assertNotSmall(judged(SPEC.replace("- **Required permissions:** None.", "- **Required permissions:** Workspace admin role")),
                            "permission")
        self.assertNotSmall(judged(SPEC, depends_on=["SLICE-009"], shipped_slices=["SLICE-007"]), "unshipped-dependency")
        self.assertTrue(judged(SPEC, depends_on=["SLICE-007"], shipped_slices=["SLICE-007"])["small"])
        self.assertNotSmall(judged(SPEC, depends_on=["SLICE-007"]), "unshipped-dependency")  # nothing known to have shipped
        named = with_frs(SPEC, "- **FR-02:** [Unwanted behavior] If the help pages of SLICE-005 cannot be reached, then the system SHALL still display the message.\n")
        named = named.replace("- **External dependencies:** None.", "- **External dependencies:** The help pages from SLICE-005 (failure: FR-02)")
        self.assertEqual(analyze(named)[0], [])
        self.assertNotSmall(judged(named, shipped_slices=["SLICE-007"]), "unshipped-dependency")
        self.assertTrue(judged(named, shipped_slices=["SLICE-005"])["small"])

    def test_risk(self):
        self.assertNotSmall(judged(SPEC, risks=["High"]), "risk")
        self.assertNotSmall(judged(SPEC, risks=["Low", "High"]), "risk", )  # intent.md Low, the cell's floor High
        for tiers in (["Low"], ["Medium"], ["Medium", "Low"], [None], []):
            self.assertTrue(judged(SPEC, risks=tiers)["small"], tiers)

    def test_the_first_rule_decides_and_every_failure_is_listed(self):
        found = judged(with_frs(SPEC.replace("- **Actor:** Invitee", "- **Actor:** Invitee or admin")), risks=["High"])
        self.assertEqual((found["rule"], found["failed"]), ("actor", ["actor", "requirements", "risk"]))
        self.assertEqual(found["sentence"], small.sentence("actor"))

    def test_missing_data_is_never_evidence(self):
        self.assertTrue(small.judge({})["small"])
        self.assertTrue(small.judge({"summary": {}, "required_permissions": ""})["small"])

    def test_every_rule_has_one_sentence_naming_it(self):
        self.assertEqual(set(small.SENTENCES), set(small.RULES))
        sentences = [small.sentence(rule) for rule in small.RULES]
        self.assertEqual(len(set(sentences)), len(sentences))
        self.assertTrue(all("—" not in s and "{" not in s for s in sentences))
        self.assertEqual(small.sentence("questions"), "This is not a small change: a small change needs at most 5 questions, and this one needs more.")


class SettingsTest(unittest.TestCase):
    """intent.small_change in .factory/config.json, read as other station settings are: a bad value reads as its default."""

    def test_defaults(self):
        self.assertEqual(small.settings({}), ({"requirements": 3, "scenarios": 4, "questions": 5, "changed_shipped_rules": 1}, []))
        self.assertEqual(small.settings(None)[0], small.DEFAULTS)
        template = json.loads((ROOT / "templates/config.json").read_text())
        self.assertEqual(template["intent"]["small_change"], small.DEFAULTS)

    def test_values_and_notes(self):
        limits, notes = small.settings({"intent": {"small_change": {"requirements": 2, "scenarios": 6, "questions": 3, "changed_shipped_rules": 0}}})
        self.assertEqual((limits, notes), ({"requirements": 2, "scenarios": 6, "questions": 3, "changed_shipped_rules": 0}, []))
        limits, notes = small.settings({"intent": {"small_change": {"requirements": "3", "scenarios": 0, "changed_shipped_rules": 2, "questions": True}}})
        self.assertEqual(limits, small.DEFAULTS)
        self.assertEqual(len(notes), 4)
        self.assertIn("intent.small_change.changed_shipped_rules in .factory/config.json must be a whole number from 0 to 1", " ".join(notes))
        self.assertEqual(small.settings({"intent": {"small_change": 5}})[0], small.DEFAULTS)
        self.assertEqual(len(small.settings({"intent": {"small_change": 5}})[1]), 1)

    def test_the_limits_are_applied(self):
        two = with_frs(SPEC, EXTRA_FRS.split("\n", 1)[0] + "\n")
        self.assertTrue(judged(two)["small"])
        found = judged(two, limits={"requirements": 1})
        self.assertEqual(found["rule"], "requirements")
        self.assertIn("at most 1 functional requirements", found["sentence"])
        one = with_effects(SPEC, "| SLICE-007/FR-01 | changed | FR-01 | |")
        self.assertEqual(judged(one, ["SLICE-007/FR-01"], limits={"changed_shipped_rules": 0})["rule"], "changed-rules")
        self.assertIn("at most 0 shipped rules,", small.sentence("changed-rules", {"changed_shipped_rules": 0}))


class PlanTest(unittest.TestCase):
    """The eighth rule, once there is a plan: for the intent station's check-plan, which wires it."""

    @staticmethod
    def rate(project, name):
        return ("High", "The finding is in code for billing.") if "billing" in name else ("Medium", "Ordinary.")

    def test_each_plan_rule(self):
        clean = small.judge_plan(Path("."), ["web/expired.html", "web/expired_test.py"], risk_for=self.rate)
        self.assertEqual((clean["small"], clean["high_risk"]), (True, []))
        self.assertEqual(small.judge_plan(Path("."), ["web/a.py"], changed_contracts=["contracts/invite.proto"], risk_for=self.rate)["rule"], "contract")
        high = small.judge_plan(Path("."), ["web/a.py", "src/billing/refund.py"], risk_for=self.rate)
        self.assertEqual((high["rule"], high["high_risk"]), ("high-risk-file", [{"file": "src/billing/refund.py", "why": "The finding is in code for billing."}]))
        self.assertEqual(small.judge_plan(Path("."), ["web/a.py"], proposed_adrs=["docs/adr/0009-cache.md"], risk_for=self.rate)["rule"], "adr")
        every = small.judge_plan(Path("."), ["src/billing/x.py"], ["contracts/a.proto"], ["docs/adr/1.md"], risk_for=self.rate)
        self.assertEqual(every["failed"], ["contract", "high-risk-file", "adr"])

    def test_the_ticket_stations_rule_is_loaded(self):
        found = small.judge_plan(ROOT, ["src/auth/login.py", "README.md"])
        self.assertEqual(found["rule"], "high-risk-file")
        self.assertEqual([item["file"] for item in found["high_risk"]], ["src/auth/login.py"])
        self.assertTrue(small.judge_plan(ROOT, ["web/pages/expired.html"])["small"])


class RecordTest(unittest.TestCase):
    def test_widened_records(self):
        found = judged(SPEC, risks=["High"])
        self.assertEqual(small.widening(found, "2026-11-22T10:00:00Z"), {"at": "2026-11-22T10:00:00Z", "reason": small.sentence("risk"), "rule": "risk"})
        self.assertEqual(small.asked("  It touches  billing. ", "2026-11-22T10:00:00Z"),
                         {"at": "2026-11-22T10:00:00Z", "reason": "It touches billing.", "rule": None})
        self.assertTrue(small.is_shipped_rule("SLICE-003/FR-02") and small.is_shipped_rule("SLICE-003/R4"))
        self.assertFalse(small.is_shipped_rule("SLICE-003") or small.is_shipped_rule("FR-02") or small.is_shipped_rule("SLICE-003/AC-01"))


class StudioBase(Base):
    def begin(self, *flags, title="Clearer expired invitation message"):
        self.start()
        return self.ok("slice", "new", "--epic", "EPIC-001", "--title", title, *flags)

    def write(self, slice_id="SLICE-001", text=None, tier="Low"):
        name = f"{slice_id}-expired-invitation-message.md"
        path = self.draft / "specs/slices" / name
        path.write_text(text if text is not None else spec_as(slice_id))
        (self.draft / f"product/intents/{slice_id}.md").write_text(INTENT.format(slice_id=slice_id, name=name, tier=tier))
        return path

    def work(self, slice_id="SLICE-001"):
        return self.artifact(f"product/slices/{slice_id}.json")


class StudioStartTest(StudioBase):
    def test_slice_new_small_adjustment(self):
        started = self.begin("--small", "--change", "adjustment")
        work = self.work()
        self.assertEqual((work["kind"], work["small"]), ("small", {"change": "adjustment", "shipped_rule": None}))
        self.assertNotIn("widened", work)
        self.assertEqual(started["slice"]["kind"], "small")
        self.assertTrue(product.validate_workspace(self.draft)["valid"])
        row = self.ok("status")["slices"][0]
        self.assertEqual((row["kind"], row["small"]), ("small", {"change": "adjustment", "shipped_rule": None, "light_path": True, "widened": None}))
        self.assertIs(self.ok("status")["factory_authorized"], False)
        field = self.ok("slice", "resume", "SLICE-001")["small_change"]
        self.assertEqual((field["kind"], field["light_path"], field["limits"]), ("small", True, small.DEFAULTS))
        self.assertEqual(Path(field["method"]), ROOT / "skills/intent/references/small-change.md")
        self.assertTrue(Path(field["method"]).is_file())
        self.assertEqual(field["questions_sentence"], small.sentence("questions"))
        self.assertIn("never trim the change", field["note"])

    def test_refusals_before_anything_is_written(self):
        self.start()
        self.assertIn("Say which kind of small change", self.refused("slice", "new", "--epic", "EPIC-001", "--title", "T", "--small"))
        self.assertIn("add --small", self.refused("slice", "new", "--epic", "EPIC-001", "--title", "T", "--change", "fix"))
        self.assertIn("add --small", self.refused("slice", "new", "--epic", "EPIC-001", "--title", "T", "--rule", "SLICE-001/FR-01"))
        self.assertIn("An adjustment names no shipped rule", self.refused("slice", "new", "--epic", "EPIC-001", "--title", "T", "--small",
                                                                         "--change", "adjustment", "--rule", "SLICE-001/FR-01"))
        self.assertIn("A fix names the shipped rule", self.refused("slice", "new", "--epic", "EPIC-001", "--title", "T", "--small", "--change", "fix"))
        self.assertIn("is not a shipped rule.", self.refused("slice", "new", "--epic", "EPIC-001", "--title", "T", "--small", "--change", "fix",
                                                              "--rule", "SLICE-001/AC-01"))
        self.assertIn("is not a shipped rule in force", self.refused("slice", "new", "--epic", "EPIC-001", "--title", "T", "--small", "--change", "fix",
                                                                     "--rule", "SLICE-001/FR-01"))
        self.assertEqual(list((self.draft / "product/slices").glob("*.json")), [])
        code, _, err = self.run_studio("--app", "slice", "new", "--epic", "EPIC-001", "--title", "T", "--small", "--change", "fix")
        self.assertEqual(code, 1)
        self.assertNotIn("--rule", err)
        self.assertNotIn("slice resume", err)

    def test_a_fix_names_a_shipped_rule_in_force(self):
        spec = self.project / "specs/slices/SLICE-001-invite-teammate.md"
        spec.parent.mkdir(parents=True)
        spec.write_text((ROOT / "tests/fixtures/SLICE-001-invite-teammate.md").read_text())
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "SLICE-001 shipped")
        started = self.begin("--small", "--change", "fix", "--rule", "SLICE-001/FR-03", title="Reject an email with a space")
        slice_id = started["slice"]["slice_id"]
        self.assertEqual(slice_id, "SLICE-005")  # SLICE-002 to SLICE-004 are reserved by the shipped spec's deferred work
        self.assertEqual(self.work(slice_id)["small"], {"change": "fix", "shipped_rule": "SLICE-001/FR-03"})
        self.assertIn("SLICE-001/FR-03", self.ok("slice", "resume", slice_id)["shipped_rules"]["fenced"])
        kept = with_effects(spec_as(slice_id), "| SLICE-001/INV-04 | kept | AC-01 | An address with a space is still refused. |")
        self.write(slice_id, kept)
        checked = self.ok("slice", "check", slice_id)
        self.assertEqual((checked["status"], checked["small_change"]["verdict"]["small"]), ("ready_for_approval", True))


class StudioCheckTest(StudioBase):
    def test_a_small_spec_stays_small_and_is_marked_ready(self):
        self.begin("--small", "--change", "adjustment")
        self.write()
        checked = self.ok("slice", "check", "SLICE-001")
        self.assertEqual(checked["status"], "ready_for_approval")
        self.assertEqual(checked["small_change"]["verdict"]["verdict"], "small")
        self.assertNotIn("widened", self.work())
        ready = self.ok("slice", "ready", "SLICE-001")
        self.assertEqual((ready["ready"], ready["small_change"]["light_path"]), (True, True))
        work = self.work()
        self.assertEqual((work["status"], work["kind"]), ("approved_for_engineering", "small"))
        self.assertTrue(product.validate_workspace(self.draft)["valid"])
        # The kind travels with the slice (M18 part D): in the ready folder's slice.json, as identifiers.
        self.assertEqual(ready["saved_to"], "folder")  # no GitHub repository here
        record = json.loads((Path(ready["folder"]) / "slice.json").read_text())
        self.assertEqual(record["small"], {"kind": "small", "change": "adjustment", "shipped_rule": None, "widened": None})

    def test_the_check_widens_a_slice_that_is_not_small_and_loses_nothing(self):
        self.begin("--small", "--change", "adjustment")
        path = self.write(text=with_frs(SPEC))
        intent = self.draft / "product/intents/SLICE-001.md"
        before = (path.read_bytes(), intent.read_bytes(), self.work())
        code, out, err = self.run_studio("slice", "check", "SLICE-001")
        self.assertEqual(code, 0, err + out)  # never refused for its size
        checked = json.loads(out)
        self.assertEqual(checked["status"], "ready_for_approval")
        field = checked["small_change"]
        self.assertEqual((field["light_path"], field["widened_now"], field["widened"]["rule"]), (False, True, "requirements"))
        self.assertEqual(field["widened"]["reason"], small.sentence("requirements"))
        self.assertIn(small.sentence("requirements"), field["note"])
        work = self.work()
        self.assertEqual(work["widened"], field["widened"])
        self.assertTrue(product._is_timestamp(work["widened"]["at"]))
        self.assertEqual((path.read_bytes(), intent.read_bytes()), before[:2], "the spec and the why are never trimmed")
        for key in ("slice_id", "title", "epic_id", "dependencies", "kind", "small", "revision"):
            self.assertEqual(work[key], before[2][key], key)
        # A full slice from then on: a later check does not judge it again, and a smaller spec does not bring it back.
        path.write_text(SPEC)
        again = self.ok("slice", "check", "SLICE-001")["small_change"]
        self.assertNotIn("verdict", again)
        self.assertEqual(self.work()["widened"], work["widened"])
        row = self.ok("status")["slices"][0]
        self.assertEqual((row["small"]["light_path"], row["small"]["widened"]), (False, work["widened"]))
        resumed = self.ok("slice", "resume", "SLICE-001")["small_change"]
        self.assertEqual(Path(resumed["method"]).name, "interview-method.md")
        self.assertNotIn("questions_sentence", resumed)
        self.assertIn("is a full slice now", resumed["note"])
        shown = self.ok("slice", "show", "SLICE-001")
        self.assertEqual(shown["check"]["small_change"]["widened"], work["widened"])

    def test_show_records_nothing(self):
        self.begin("--small", "--change", "adjustment")
        self.write(text=with_frs(SPEC))
        shown = self.ok("slice", "show", "SLICE-001")
        self.assertEqual(shown["check"]["small_change"]["verdict"]["rule"], "requirements")
        self.assertNotIn("widened", self.work())

    def test_ready_that_widens_does_not_mark_it_ready_in_that_act(self):
        self.begin("--small", "--change", "adjustment")
        self.write(tier="High")
        code, out, err = self.run_studio("slice", "ready", "SLICE-001")
        self.assertEqual(code, 0, err + out)  # never refused for its size
        ready = json.loads(out)
        self.assertEqual((ready["ready"], ready["widened"], ready["small_change"]["widened_now"], ready["small_change"]["widened"]["rule"]),
                         (False, True, True, "risk"))
        self.assertIs(ready["factory_authorized"], False)
        self.assertTrue(ready["note"].startswith(small.sentence("risk") + " It was not marked ready"))
        self.assertIn("the interview carries on in full", ready["note"])
        work = self.work()
        self.assertEqual((work["status"] != "approved_for_engineering", work["widened"]["reason"]), (True, small.sentence("risk")))
        self.assertFalse((self.draft / "product/ready/SLICE-001").exists(), "nothing was handed over")
        self.assertTrue(product.validate_workspace(self.draft)["valid"])
        # The interview carries on in full; then it is marked ready again, as the full slice it now is.
        again = self.ok("slice", "ready", "SLICE-001")
        self.assertEqual((again["ready"], again["small_change"]["light_path"]), (True, False))
        self.assertNotIn("widened_now", again["small_change"])
        self.assertEqual(self.work()["status"], "approved_for_engineering")

    def test_a_slice_widened_earlier_is_marked_ready_as_before(self):
        self.begin("--small", "--change", "adjustment")
        self.write(tier="High")
        self.ok("slice", "widen", "SLICE-001", "--why", "It touches access.")
        ready = self.ok("slice", "ready", "SLICE-001")
        self.assertEqual((ready["ready"], ready["small_change"]["widened"]["rule"]), (True, None))
        self.assertEqual(self.work()["status"], "approved_for_engineering")

    def test_a_refused_ready_still_keeps_the_widening(self):
        self.begin("--small", "--change", "adjustment")
        self.write(text=with_frs(SPEC).replace("## Open questions\n\n- None.", "## Open questions\n\n- Who signs the help text? Follow up: Support lead."))
        self.assertIn("open question", self.refused("slice", "ready", "SLICE-001"))
        self.assertEqual(self.work()["widened"]["rule"], "requirements")

    def test_the_settings_are_used(self):
        (self.project / ".factory").mkdir(exist_ok=True)
        (self.project / ".factory/config.json").write_text(json.dumps({"intent": {"small_change": {"requirements": 4, "scenarios": "x"}}}))
        self.begin("--small", "--change", "adjustment")
        self.write(text=with_frs(SPEC))
        self.assertTrue(self.ok("slice", "check", "SLICE-001")["small_change"]["verdict"]["small"])
        resumed = self.ok("slice", "resume", "SLICE-001")["small_change"]
        self.assertEqual(resumed["limits"]["requirements"], 4)
        self.assertIn("intent.small_change.scenarios", resumed["settings_notes"][0])


class StudioWidenTest(StudioBase):
    def test_widen_on_the_product_managers_word(self):
        self.begin("--small", "--change", "adjustment")
        self.write()
        revision = self.work()["revision"]
        widened = self.ok("slice", "widen", "SLICE-001", "--why", "  It should also  change the reminder email. ")
        self.assertIs(widened["factory_authorized"], False)
        work = self.work()
        self.assertEqual((work["widened"]["reason"], work["widened"]["rule"], work["revision"]), ("It should also change the reminder email.", None, revision + 1))
        self.assertEqual(widened["small_change"]["widened"], work["widened"])
        self.assertEqual(Path(widened["small_change"]["method"]).name, "interview-method.md")
        self.assertIn("is already a full slice", self.refused("slice", "widen", "SLICE-001", "--why", "Again."))
        self.assertNotIn("verdict", self.ok("slice", "check", "SLICE-001")["small_change"])
        self.assertTrue(product.validate_workspace(self.draft)["valid"])

    def test_widen_by_a_rule_an_answer_showed(self):
        self.begin("--small", "--change", "adjustment")
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Second", "--small", "--change", "adjustment")
        rules = self.ok("slice", "resume", "SLICE-001")["small_change"]["rules"]
        self.assertEqual((rules["actor"], rules["questions"]), (small.sentence("actor"), small.sentence("questions")))
        self.ok("slice", "widen", "SLICE-001", "--by-rule", "questions")
        widened = self.work()["widened"]
        self.assertEqual((widened["reason"], widened["rule"]), (small.sentence("questions"), "questions"))
        self.assertIn("is not a rule for a small change", self.refused("slice", "widen", "SLICE-002", "--by-rule", "too-big"))
        with self.assertRaises(SystemExit):  # a reason or a rule is required
            self.run_studio("slice", "widen", "SLICE-002")
        self.assertNotIn("widened", self.work("SLICE-002"))

    def test_widen_refusals(self):
        self.begin()
        self.assertIn("not a small change", self.refused("slice", "widen", "SLICE-001", "--why", "W."))
        self.ok("slice", "new", "--epic", "EPIC-001", "--title", "Second", "--small", "--change", "adjustment")
        self.assertIn("Give the reason", self.refused("slice", "widen", "SLICE-002", "--why", "   "))
        self.write("SLICE-002")
        self.ok("slice", "ready", "SLICE-002")
        self.assertIn("reopen it first", self.refused("slice", "widen", "SLICE-002", "--why", "W."))


class NeverSmallTest(StudioBase):
    """A project that never starts a small change: no field anywhere, exactly as before."""

    def test_no_kind_anywhere(self):
        self.begin()
        self.write()
        for report in (self.ok("slice", "check", "SLICE-001"), self.ok("slice", "resume", "SLICE-001"), self.ok("slice", "show", "SLICE-001")["check"]):
            self.assertNotIn("small_change", report)
        self.assertFalse({"kind", "small", "widened"} & set(self.work()))
        self.assertFalse({"kind", "small"} & set(self.ok("status")["slices"][0]))
        ready = self.ok("slice", "ready", "SLICE-001")
        self.assertNotIn("small_change", ready)
        self.assertFalse({"kind", "small", "widened"} & set(self.work()))
        self.assertNotIn("small", json.loads((Path(ready["folder"]) / "slice.json").read_text()), "the ready folder is exactly as before")

    def test_a_full_slice_is_never_judged_for_size(self):
        self.begin()
        self.write(text=with_frs(SPEC), tier="High")
        self.assertEqual(self.ok("slice", "check", "SLICE-001")["status"], "ready_for_approval")
        self.assertNotIn("widened", self.work())


class StructureTest(StudioBase):
    def test_the_structural_validator_holds_the_fields(self):
        self.begin("--small", "--change", "adjustment")
        path = self.draft / "product/slices/SLICE-001.json"
        good = json.loads(path.read_text())
        for bad in (dict(good, kind="tiny"), {k: v for k, v in good.items() if k != "small"}, {k: v for k, v in good.items() if k != "kind"},
                    dict(good, small={"change": "fix", "shipped_rule": None}), dict(good, small={"change": "adjustment", "shipped_rule": "SLICE-001/FR-01"}),
                    dict(good, small={"change": "rewrite", "shipped_rule": None}),
                    dict(good, widened={"at": "yesterday", "reason": "R.", "rule": None}),
                    dict(good, widened={"at": "2026-11-22T10:00:00Z", "reason": " ", "rule": None}),
                    dict(good, widened={"at": "2026-11-22T10:00:00Z", "reason": "R.", "rule": "Risk!"}),
                    dict({k: v for k, v in good.items() if k not in ("kind", "small")}, widened={"at": "2026-11-22T10:00:00Z", "reason": "R.", "rule": None})):
            path.write_text(json.dumps(bad))
            self.assertFalse(product.validate_workspace(self.draft)["valid"], bad)
        path.write_text(json.dumps(dict(good, widened={"at": "2026-11-22T10:00:00Z", "reason": "R.", "rule": "risk"})))
        self.assertTrue(product.validate_workspace(self.draft)["valid"])


class RequestPickTest(RequestBase):
    def test_request_pick_small(self):
        self.ready(self.a)
        self.request(self.a)
        self.assertIn("add --small", self.refused(self.a, "request", "pick", "42", "--epic", "EPIC-001", "--title", "Invite", "--change", "fix"))
        self.assertEqual(self.comments(), [], "refused before anything reached GitHub")
        picked = self.ok(self.a, "request", "pick", "42", "--epic", "EPIC-001", "--title", "Invite", "--small", "--change", "adjustment")
        work = self.artifact(self.a, f"product/slices/{picked['slice']['slice_id']}.json")
        self.assertEqual((work["kind"], work["small"]["change"], work["origin"]["number"]), ("small", "adjustment", 42))
        self.assertTrue(product.validate_workspace(self.a / ".factory/studio/draft")["valid"])


class DocumentsTest(unittest.TestCase):
    def test_the_method_is_written_for_the_model_in_plain_english(self):
        text = (ROOT / "skills/intent/references/small-change.md").read_text()
        self.assertNotIn("—", text)
        for words in ("fix", "adjustment", "yes-or-no", "recommend", "confirm", "never trim", "slice widen"):
            self.assertIn(words, text.lower())
        studio_skill = (ROOT / "skills/product-studio/SKILL.md").read_text()
        self.assertIn("small-change.md", studio_skill)
        self.assertIn("slice widen", studio_skill)


if __name__ == "__main__":
    unittest.main()
