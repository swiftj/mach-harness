"""M18, the Factory side of a small change: the kind travels with the handoff, the intent station judges it, an engineer's
own ticket takes the short interview, and after the plan the two ways back.

The kind travels beside the approved text, never inside its SHA-256: the issue's marker and the approval comment carry
it as identifiers (issue_rules), the ready folder's slice.json carries the same record, intake takes it into the ledger
and the cell, and cell.py records it in cell.json and spec.json. A slice that is not small has none of it, so its issue
body, approval, slice.json, revision digest, cell.json and spec.json are exactly as before.
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("ticket", "intent", "product-studio", "run"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import issue_rules  # noqa: E402
import intake  # noqa: E402
import run  # noqa: E402
import small  # noqa: E402
import test_cell  # noqa: E402
from test_mach_product_intake import Base as IntakeBase  # noqa: E402
from test_small_change import EXTRA_FRS, SPEC, spec_as, with_frs  # noqa: E402

NAME = "SLICE-001-expired-invitation-message.md"
STUDIO_INTENT = """# Intent: Clearer expired invitation message

- **Slice:** {slice_id} at specs/slices/{slice_id}-expired-invitation-message.md
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
CELL_INTENT = """# Intent: Clearer expired invitation message

- **Ticket:** {ticket} (local)
- **Slice:** SLICE-001 at specs/slices/SLICE-001-expired-invitation-message.md
- **Mode:** Interactive
- **Status:** Ready for contracts

## Why

- **Problem:** An invitee with an expired link does not know who to ask.
- **Who it is for:** An invitee.
- **Success looks like:** The invitee asks the right person for a new invitation.

## Goal ancestry

- **Goal:** Not stated.
- **Epic:** Not stated.
- **Ticket:** {ticket}: Clearer expired invitation message
- **Slice:** SLICE-001: An expired link says who to ask.

## Constraints

- None.

## Risk

- **Tier:** {tier}
- **Reason:** It changes one message.

## Deferred work

- None.
"""
PLAN = """# Plan: SLICE-001: Clearer expired invitation message

- **App type:** web
- **Risk tier:** {tier}
- **Contracts:** None. This slice changes no boundary.
- **ADRs:** None.

## Contracts

- None.

## Tasks

- [ ] T01 [test] The expired link says who to ask — `tests/test_expired.py` (FR-01, INV-01, AC-01)
- [ ] T02 [impl] The message — `{file}` (FR-01, INV-01)

## File touch map

| File | Change | Tasks |
|------|--------|-------|
| `{file}` | change | T02 |

## Engineering decisions

- None.
"""
QUIET = "web/expired.py"
HIGH_RISK = "src/auth/login.py"
WHEN = "2026-11-22T10:00:00Z"
FIX = {"kind": "small", "change": "fix", "shipped_rule": "SLICE-003/FR-02", "widened": None}
ADJUSTMENT = {"kind": "small", "change": "adjustment", "shipped_rule": None, "widened": None}


def plan(file=QUIET, tier="Low"):
    return PLAN.format(file=file, tier=tier)


class HandoffRulesTest(unittest.TestCase):
    """issue_rules: the marker and the approval carry a small change's record as identifiers, outside the hashes."""

    WHY, BODY = "## Why\n\nA reason.\n", "# SLICE-004: A spec\n"

    def test_the_record_round_trips_through_the_marker_and_the_approval(self):
        for record in (FIX, ADJUSTMENT, dict(ADJUSTMENT, widened={"rule": "requirements", "at": WHEN}), dict(FIX, widened={"rule": None, "at": WHEN})):
            body = issue_rules.slice_issue_body("SLICE-004", 2, 7, [5], self.WHY, self.BODY, jira="ABC-12", small=record)
            parsed = issue_rules.parse_slice_body(body)
            self.assertEqual((parsed["small"], parsed["intact"], parsed["why"], parsed["spec"], parsed["jira"]), (record, True, self.WHY, self.BODY, "ABC-12"))
            # The text's hashes are the text's alone: the kind is beside them.
            self.assertEqual((parsed["spec_sha256"], parsed["why_sha256"]), (issue_rules.text_sha256_of(self.BODY), issue_rules.text_sha256_of(self.WHY)))
            approval = issue_rules.approval_comment("SLICE-004", 2, "ada-pm", parsed["spec_sha256"], parsed["why_sha256"], "ABC-12", None, record)
            self.assertEqual(issue_rules.approvals([approval])[0]["small"], record)
            self.assertIn("- Small change: ", approval)
        self.assertIn(" kind=small change=fix rule=SLICE-003/FR-02 widened=asked@2026-11-22T10:00:00Z -->",
                      issue_rules.slice_issue_body("SLICE-004", 1, 7, [], self.WHY, self.BODY, small=dict(FIX, widened={"rule": None, "at": WHEN})))

    def test_a_slice_that_is_not_small_is_written_and_read_exactly_as_before(self):
        body = issue_rules.slice_issue_body("SLICE-004", 1, 7, [], self.WHY, self.BODY)
        self.assertEqual(body, issue_rules.slice_issue_body("SLICE-004", 1, 7, [], self.WHY, self.BODY, small=None))
        self.assertNotIn("kind=", body)
        self.assertNotIn("small", issue_rules.parse_slice_body(body))
        approval = issue_rules.approval_comment("SLICE-004", 1, "ada-pm", "0" * 64, "1" * 64)
        self.assertNotIn("kind=", approval)
        self.assertNotIn("Small change", approval)
        self.assertNotIn("small", issue_rules.approvals([approval])[0])
        self.assertEqual(intake.digest_of("w", "s"), intake.digest_of("w", "s", None, None))

    def test_a_record_out_of_its_form_is_refused_and_an_edited_marker_is_not_intact(self):
        for bad in (dict(FIX, shipped_rule=None), dict(ADJUSTMENT, shipped_rule="SLICE-003/FR-02"), dict(FIX, change="rewrite"),
                    dict(FIX, widened={"rule": "Risk!", "at": WHEN}), dict(FIX, widened={"rule": "risk", "at": "yesterday"}),
                    dict(FIX, widened={"rule": "asked", "at": WHEN}), {k: v for k, v in FIX.items() if k != "widened"}):
            self.assertFalse(issue_rules.is_small_record(bad), bad)
            with self.assertRaises(ValueError):
                issue_rules.slice_issue_body("SLICE-004", 1, 7, [], self.WHY, self.BODY, small=bad)
        body = issue_rules.slice_issue_body("SLICE-004", 1, 7, [], self.WHY, self.BODY, small=FIX)
        edited = body.replace(" rule=SLICE-003/FR-02", "")  # a fix with no rule
        self.assertFalse(issue_rules.parse_slice_body(edited)["intact"])

    def test_an_approval_of_another_kind_is_not_accepted(self):
        body = issue_rules.slice_issue_body("SLICE-004", 1, 7, [], self.WHY, self.BODY, small=ADJUSTMENT)
        parsed = issue_rules.parse_slice_body(body)
        issue = {"state": "open", "labels": ["mach:slice", "mach:ready"], "body": body}
        events = [{"event": "labeled", "label": "mach:ready", "login": "ada-pm", "id": 3001, "type": "User", "app": False, "at": WHEN}]

        def comment(record):
            text = issue_rules.approval_comment("SLICE-004", 1, "ada-pm", parsed["spec_sha256"], parsed["why_sha256"], small=record)
            return [{"login": "ada-pm", "id": 3001, "type": "User", "app": False, "created_at": WHEN, "updated_at": WHEN, "body": text}]

        self.assertEqual(issue_rules.slice_acceptance(issue, events, comment(ADJUSTMENT), {"role_name": "write"})["state"], "accepted")
        for other in (None, dict(ADJUSTMENT, widened={"rule": "risk", "at": WHEN})):
            refused = issue_rules.slice_acceptance(issue, events, comment(other), {"role_name": "write"})
            self.assertEqual(refused["reason"], issue_rules.SLICE_NOT_ACCEPTED["small_changed"], other)

    def test_the_rule_a_question_quotes(self):
        for rule in small.RULES:
            self.assertEqual(small.sentence_in("Before. " + small.sentence(rule, {"requirements": 2}) + " After."),
                             (rule, small.sentence(rule, {"requirements": 2})))
        self.assertIsNone(small.rule_in("Which wins, FR-02 or INV-01?"))


class CellBase(test_cell.Base):
    def groom(self, ticket="LOCAL-001", spec=None, tier="Low", *flags):
        code, out, err = test_cell.run("open", ticket, *flags, project=self.project)
        self.assertEqual(code, 0, err)
        info = json.loads(out)
        Path(info["specs_dir"]).mkdir(parents=True, exist_ok=True)
        (Path(info["specs_dir"]) / NAME).write_text(spec if spec is not None else spec_as(), encoding="utf-8")
        Path(info["intent_path"]).write_text(CELL_INTENT.format(ticket=ticket, tier=tier), encoding="utf-8")
        return info

    def cell(self, ticket="LOCAL-001"):
        return json.loads((self.project / ".factory/worktrees" / ticket / "cell.json").read_text())

    def set_cell(self, ticket="LOCAL-001", **changes):
        path = self.project / ".factory/worktrees" / ticket / "cell.json"
        data = json.loads(path.read_text())
        data.update(changes)
        path.write_text(json.dumps(data))

    def cmd(self, *argv):
        return test_cell.run(*argv, project=self.project)

    def finalize(self, ticket="LOCAL-001"):
        return self.cmd("finalize", ticket, "--spec", f"specs/slices/{NAME}", "--allow-open")

    def spec_json(self, ticket="LOCAL-001"):
        return json.loads((self.project / ".factory/worktrees" / ticket / "spec.json").read_text())


class EngineerStartTest(CellBase):
    """An engineer's own ticket: the short interview on their word or on the ticket's small-change label."""

    def test_on_the_engineers_word(self):
        info = self.groom("LOCAL-001", None, "Low", "--small")
        state = self.cell()
        self.assertEqual((state["kind"], state["small"]), ("small", {"from": "engineer"}))
        self.assertNotIn("widened", state)
        field = info["small_change"]
        self.assertEqual((field["light_path"], field["limits"], Path(field["method"]).name), (True, small.DEFAULTS, "small-change.md"))
        self.assertTrue(Path(field["method"]).is_file())
        self.assertEqual(field["rules"]["questions"], small.sentence("questions"))
        self.assertIn("never trim the change", field["note"])

    def test_on_the_tickets_label(self):
        code, out, _ = self.cmd("ticket-new", "--title", "Clearer expired invitation message", "--label", "small-change")
        ticket = json.loads(out)["ticket_id"]
        self.groom(ticket)
        self.assertEqual(self.cell(ticket)["small"], {"from": "label"})

    def test_headless_and_fault_tickets_are_never_small(self):
        code, _, err = self.cmd("open", "LOCAL-001", "--headless", "--small")
        self.assertEqual(code, 2)
        self.assertIn("never a small change", err)
        self.assertFalse((self.project / ".factory/worktrees/LOCAL-001").exists(), "refused before anything is made")
        code, _, err = self.cmd("open", "AUTO-20261120T101500Z", "--small")
        self.assertEqual(code, 2)
        code, out, _ = self.cmd("ticket-new", "--title", "Labelled", "--label", "small-change")
        ticket = json.loads(out)["ticket_id"]
        self.assertEqual(self.cmd("open", ticket, "--headless")[0], 0)
        self.assertNotIn("kind", self.cell(ticket), "a label does not make headless grooming small")

    def test_a_ticket_past_grooming_is_not_taken_as_small(self):
        self.groom()
        self.assertEqual(self.finalize()[0], 0)
        code, out, _ = self.cmd("open", "LOCAL-001", "--small")
        self.assertIn("is not taken as a small change", json.loads(out)["small_note"])
        self.assertNotIn("kind", self.cell())

    def test_a_ticket_that_is_not_small_is_exactly_as_before(self):
        info = self.groom()
        self.assertNotIn("small_change", info)
        code, out, _ = self.cmd("validate", "LOCAL-001", "--spec", f"specs/slices/{NAME}")
        self.assertNotIn("small change:", out)
        self.assertEqual(self.finalize()[0], 0)
        self.assertFalse({"kind", "small", "widened"} & set(self.cell()))
        self.assertFalse({"kind", "widened"} & set(self.spec_json()))
        # Not judged for its size, however big: four requirements and High risk.
        self.groom("LOCAL-002", with_frs(SPEC), "High")
        self.assertEqual(self.finalize("LOCAL-002")[0], 0)
        self.assertEqual(self.cell("LOCAL-002")["stage"], "spec-ready")


class EngineerJudgeTest(CellBase):
    """The station judges a small change at validate and finalize, and widens it with the rule's sentence; never refuses it."""

    def test_a_small_spec_stays_small_and_is_exported_with_its_kind(self):
        self.groom("LOCAL-001", None, "Low", "--small")
        code, out, _ = self.cmd("validate", "LOCAL-001", "--spec", f"specs/slices/{NAME}")
        self.assertEqual(code, 0, out)
        self.assertIn("small change: " + small.SMALL_SENTENCE, out)
        code, out, _ = self.finalize()
        self.assertEqual(code, 0, out)
        self.assertIn('"status": "READY"', out)
        self.assertEqual(self.cell()["stage"], "spec-ready")
        export = self.spec_json()
        self.assertEqual(export["kind"], "small")
        self.assertNotIn("widened", export)

    def test_validate_widens_and_the_check_is_otherwise_unchanged(self):
        info = self.groom("LOCAL-001", with_frs(SPEC), "Low", "--small")
        spec = Path(info["specs_dir"]) / NAME
        before = spec.read_bytes()
        code, out, _ = self.cmd("validate", "LOCAL-001", "--spec", f"specs/slices/{NAME}")
        self.assertEqual(code, 0, "never refused for its size")
        self.assertIn("small change: " + small.sentence("requirements") + " It left the light path", out)
        widened = self.cell()["widened"]
        self.assertEqual((widened["rule"], widened["reason"], widened["by"]), ("requirements", small.sentence("requirements"), "validate"))
        self.assertEqual(spec.read_bytes(), before, "the spec is never trimmed")
        # A full ticket from then on: not judged again, and finalize makes it ready.
        code, out, _ = self.finalize()
        self.assertNotIn("small change:", out)
        self.assertEqual(self.cell()["stage"], "spec-ready")
        self.assertEqual(self.spec_json()["widened"], widened)
        reopened = json.loads(self.cmd("open", "LOCAL-001")[1])["small_change"]
        self.assertEqual((reopened["light_path"], Path(reopened["method"]).name), (False, "interview-method.md"))

    def test_finalize_that_widens_does_not_make_it_ready_in_that_act(self):
        self.groom("LOCAL-001", None, "High", "--small")
        code, out, _ = self.finalize()
        self.assertEqual(code, 0, out)
        self.assertIn('"status": "WIDENED"', out)
        self.assertIn(small.sentence("risk") + " It left the light path, so it is not ready yet", out)
        state = self.cell()
        self.assertEqual((state["stage"], state["widened"]["rule"], state["widened"]["by"]), ("spec-open", "risk", "finalize"))
        self.assertFalse((self.project / ".factory/worktrees/LOCAL-001/spec.json").exists())
        self.groom("LOCAL-002", None, "High", "--small")
        code, out, _ = self.cmd("finalize", "LOCAL-002", "--spec", f"specs/slices/{NAME}")
        self.assertEqual((code, '"status": "WIDENED"' in out), (1, True), "without --allow-open, as with open questions")
        # After the full interview, finalize again: ready, with the kind and the widening in spec.json.
        code, out, _ = self.finalize()
        self.assertIn('"status": "READY"', out)
        export = self.spec_json()
        self.assertEqual((export["kind"], export["widened"]["rule"]), ("small", "risk"))

    def test_the_risk_floor_the_cell_holds_counts(self):
        self.groom("LOCAL-001", None, "Low", "--small")
        self.set_cell(risk_floor={"from": "Low", "to": "High", "why": "Monitoring raised it."})
        self.cmd("validate", "LOCAL-001", "--spec", f"specs/slices/{NAME}")
        self.assertEqual(self.cell()["widened"]["rule"], "risk")

    def test_widen_by_rule_or_on_the_engineers_word(self):
        self.groom("LOCAL-001", None, "Low", "--small")
        code, out, _ = self.cmd("widen", "LOCAL-001", "--by-rule", "questions")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["widened"]["reason"], small.sentence("questions"))
        code, _, err = self.cmd("widen", "LOCAL-001", "--why", "Again.")
        self.assertIn("already left the light path", err)
        self.groom("LOCAL-002", None, "Low", "--small")
        self.assertIn("is not a rule", self.cmd("widen", "LOCAL-002", "--by-rule", "too-big")[2])
        self.assertIn("Give the reason", self.cmd("widen", "LOCAL-002", "--why", "  ")[2])
        self.assertEqual(self.cmd("widen", "LOCAL-002", "--why", "  It also changes  the reminder. ")[0], 0)
        self.assertEqual((self.cell("LOCAL-002")["widened"]["reason"], self.cell("LOCAL-002")["widened"]["rule"]), ("It also changes the reminder.", None))
        self.groom("LOCAL-003")
        self.assertIn("not a small change", self.cmd("widen", "LOCAL-003", "--why", "W.")[2])


class AfterThePlanTest(CellBase):
    """check-plan: what only a plan can show. An engineer's own ticket goes back to the interview in full; a Product Studio
    slice stops with the product manager's question."""

    def planned(self, file, ticket="LOCAL-001", tier="Low", product=False):
        info = self.groom(ticket, None, tier, *(() if product else ("--small",)))
        if product:  # as intake leaves a slice from Product Studio before finalize
            self.set_cell(ticket, kind="small", small={"from": "product-studio", "change": "adjustment", "shipped_rule": None})
        self.assertEqual(self.finalize(ticket)[0], 0)
        if product:
            self.set_cell(ticket, product={"slice_id": "SLICE-001", "revision": 1, "epic_id": "EPIC-001", "depends_on": [], "source": "github"})
        Path(info["plan_path"]).write_text(plan(file), encoding="utf-8")
        return info

    def test_a_plan_that_keeps_it_small(self):
        self.planned(QUIET)
        code, out, _ = self.cmd("check-plan", "LOCAL-001")
        self.assertEqual(code, 0, out)
        self.assertIn("small change: " + small.SMALL_SENTENCE, out)
        self.assertIn('"status": "PLANNED"', out)
        state = self.cell()
        self.assertEqual((state["stage"], state["kind"]), ("planned", "small"))
        self.assertNotIn("widened", state)
        self.assertEqual(self.spec_json()["kind"], "small", "the plan's rewrite of spec.json keeps the kind")

    def test_an_engineers_ticket_goes_back_to_the_interview_in_full(self):
        info = self.planned(HIGH_RISK)
        code, out, _ = self.cmd("check-plan", "LOCAL-001")
        self.assertEqual(code, 0, out)
        found = json.loads(out)
        self.assertEqual((found["status"], found["stage"], found["widened"]["rule"]), ("WIDENED", "spec-open", "high-risk-file"))
        self.assertEqual(found["high_risk"][0]["file"], HIGH_RISK)
        state = self.cell()
        self.assertEqual((state["stage"], state["widened"]["by"], state["widened"]["reason"]), ("spec-open", "check-plan", small.sentence("high-risk-file")))
        self.assertFalse(Path(info["plan_path"]).exists())
        self.assertTrue((Path(info["cell_dir"]) / "plan-history/1/plan.md").is_file(), "the plan is kept on record")
        self.assertFalse(Path(info["spec_json_path"]).exists())
        self.assertIn("left the light path", self.cmd("check-plan", "LOCAL-001")[2])
        self.assertEqual(run.next_step(run.Project(self.project), "LOCAL-001", False)["action"], "groom", "the interview carries on with a person")
        self.assertEqual(run.next_step(run.Project(self.project), "LOCAL-001", True)["needs"], "answers")
        # The full interview, then ready and planned again: judged no more.
        self.assertIn('"status": "READY"', self.finalize()[1])
        Path(info["plan_path"]).write_text(plan(HIGH_RISK, "High"), encoding="utf-8")
        code, out, _ = self.cmd("check-plan", "LOCAL-001")
        self.assertIn('"status": "PLANNED"', out)

    def test_a_plan_raised_to_high_is_not_small(self):
        info = self.planned(QUIET)
        Path(info["plan_path"]).write_text(plan(QUIET, "High"), encoding="utf-8")
        self.assertEqual(json.loads(self.cmd("check-plan", "LOCAL-001")[1])["widened"]["rule"], "risk")

    def test_a_product_studio_slice_stops_with_the_product_managers_question(self):
        info = self.planned(HIGH_RISK, product=True)
        code, out, _ = self.cmd("check-plan", "LOCAL-001")
        self.assertEqual(code, 0, out)
        found = json.loads(out)
        self.assertEqual(found["status"], "STOPPED")
        state = self.cell()
        question = state["spec_question"]
        self.assertEqual((state["stage"], question["small_change"]), ("spec-ready", "high-risk-file"))
        self.assertTrue(question["text"].startswith(small.sentence("high-risk-file") + " SLICE-001 was started in Product Studio as a small change"))
        self.assertEqual(small.rule_in(question["text"]), "high-risk-file")
        self.assertNotIn("widened", state, "the product manager's slice is widened in Product Studio, not here")
        self.assertTrue((Path(info["cell_dir"]) / "plan-history/1/plan.md").is_file())
        step = run.next_step(run.Project(self.project), "LOCAL-001", True)
        self.assertEqual((step["action"], step["needs"]), ("stop", "product-answer"))



class GroomExitTest(CellBase):
    """Part D: the groom station's exit event carries the kind, read from the cell, and nothing else changes; a ticket that is
    not small exits exactly as before. Only a rule's code reaches the event, never the person's words for a widening."""

    BEFORE_READY = {"outcome", "stage", "slice_id", "risk", "invariants", "functional_requirements", "matrix_rules", "matrix_cases",
                    "scenarios", "open_questions"}

    def exits(self, ticket="LOCAL-001"):
        import lifecycle
        from test_lifecycle import SCHEMA, schema_errors
        records = lifecycle.read(self.project / ".factory/worktrees" / ticket)
        for record in records:
            self.assertEqual(schema_errors(record, SCHEMA), [], record)
        return [r["data"] for r in records if r["type"] == "station.exited" and r["station"] == "groom"]

    def test_a_ticket_that_is_not_small_exits_exactly_as_before(self):
        self.groom()
        self.assertEqual(self.finalize()[0], 0)
        (data,) = self.exits()
        self.assertEqual(set(data), self.BEFORE_READY)
        self.assertEqual(json.dumps(data, sort_keys=True), json.dumps({
            "outcome": "spec-ready", "stage": "spec-ready", "slice_id": "SLICE-001", "risk": "Low", "invariants": data["invariants"],
            "functional_requirements": data["functional_requirements"], "matrix_rules": data["matrix_rules"], "matrix_cases": data["matrix_cases"],
            "scenarios": data["scenarios"], "open_questions": data["open_questions"]}, sort_keys=True))

    def test_a_small_change_on_the_light_path(self):
        self.groom("LOCAL-001", None, "Low", "--small")
        self.assertEqual(self.finalize()[0], 0)
        (data,) = self.exits()
        self.assertEqual(set(data) - self.BEFORE_READY, {"kind", "widened"})
        self.assertEqual((data["kind"], data["widened"]), ("small", False))

    def test_widened_by_a_rule_carries_its_code(self):
        self.groom("LOCAL-001", None, "High", "--small")
        self.finalize()  # widens: saved at spec-open
        self.finalize()  # after the full interview: ready
        first, second = self.exits()
        self.assertEqual((first["outcome"], first["kind"], first["widened"], first["widened_rule"]), ("spec-open", "small", True, "risk"))
        self.assertEqual(set(first), {"outcome", "stage", "slice_id", "kind", "widened", "widened_rule"})
        self.assertEqual((second["outcome"], second["widened"], second["widened_rule"]), ("spec-ready", True, "risk"))

    def test_widened_on_the_engineers_word_carries_no_words(self):
        self.groom("LOCAL-001", None, "Low", "--small")
        self.assertEqual(self.cmd("widen", "LOCAL-001", "--why", "It also changes the reminder email.")[0], 0)
        self.assertEqual(self.finalize()[0], 0)
        (data,) = self.exits()
        self.assertEqual((data["kind"], data["widened"], data["widened_rule"]), ("small", True, None))
        raw = (self.project / ".factory/worktrees/LOCAL-001/lifecycle.jsonl").read_text()
        self.assertNotIn("reminder", raw)

class IntakeTest(IntakeBase):
    """Studio to the issue or the folder, to intake, to the cell, with the kind intact; and both ways back."""

    def studio_small(self, tier="Low", *flags):
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        self.ok(self.a, "slice", "new", "--epic", "EPIC-001", "--title", "Clearer expired invitation message", "--small", "--change", "adjustment", *flags)
        self.draft(self.a, f"specs/slices/{NAME}").write_text(spec_as())
        self.draft(self.a, "product/intents/SLICE-001.md").write_text(STUDIO_INTENT.format(slice_id="SLICE-001", tier=tier))

    def factory(self):
        self.set_gh(me="erin-eng")

    def cell_spec_json(self, ticket):
        return json.loads((self.eng / ".factory/worktrees" / ticket / "spec.json").read_text())

    def check_plan(self, ticket, file):
        (self.eng / ".factory/worktrees" / ticket / "plan.md").write_text(plan(file, "Medium"))
        done = test_cell.run("check-plan", ticket, project=self.eng)
        self.assertEqual(done[0], 0, done[1] + done[2])
        return json.loads(done[1][done[1].index("{"):])

    def test_the_round_trip_and_the_way_back_through_product_studio(self):
        self.studio_small()
        ready = self.ok(self.a, "slice", "ready", "SLICE-001")
        number = ready["issue"]
        marker = issue_rules.parse_slice_body(self.gh()["issues"][str(number)]["body"])
        self.assertEqual((marker["small"], marker["intact"]), (ADJUSTMENT, True))
        self.assertEqual(issue_rules.approvals(self.comments_on(number))[0]["small"], ADJUSTMENT)
        # The Factory takes it in with its kind, and the cell records it.
        self.factory()
        taken = self.product("intake")
        self.assertEqual((taken["created"][0]["slice_id"], taken["not_accepted"]), ("SLICE-001", []))
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertEqual(entry["small"], ADJUSTMENT)
        why, spec = (self.eng / entry["stored"] / "why.md").read_text(), (self.eng / entry["stored"] / "spec.md").read_text()
        self.assertEqual(entry["digest"], intake.digest_of(why, spec, None, issue_rules.small_suffix(ADJUSTMENT)), "the kind is part of the revision's identity")
        self.assertNotEqual(entry["digest"], intake.digest_of(why, spec))
        self.product("dispatch", "SLICE-001")
        ticket = str(number)
        state = self.cell(ticket)
        self.assertEqual((state["stage"], state["kind"], state["small"]), ("spec-ready", "small", {"from": "product-studio", "change": "adjustment", "shipped_rule": None}))
        self.assertNotIn("widened", state)
        self.assertEqual(self.cell_spec_json(ticket)["kind"], "small")
        # After the plan: a file in a high-risk area. The slice stops with the product manager's question on its issue.
        self.assertEqual(self.check_plan(ticket, HIGH_RISK)["status"], "STOPPED")
        self.product("intake")
        self.assertIn("mach:question", self.labels_of(number))
        self.assertIn(small.sentence("high-risk-file"), self.comments_on(number)[-1])
        # The product manager reopens it: it comes back widened, with the Factory's reason.
        self.set_gh(me="ada-pm")
        reopened = self.ok(self.a, "slice", "reopen", "SLICE-001")
        self.assertEqual((reopened["small_change"]["widened_now"], reopened["small_change"]["widened"]["rule"]), (True, "high-risk-file"))
        self.assertEqual(reopened["slice"]["widened"]["reason"], small.sentence("high-risk-file"))
        self.assertIn(small.sentence("high-risk-file"), reopened["note"])
        self.assertNotIn("question_text", reopened["github"])
        self.assertEqual(Path(self.ok(self.a, "slice", "resume", "SLICE-001")["small_change"]["method"]).name, "interview-method.md")
        # The full interview, then marked ready again: a new revision that carries the widening.
        again = self.ok(self.a, "slice", "ready", "SLICE-001")
        self.assertEqual((again["ready"], again["revision"]), (True, 2))
        widened = issue_rules.parse_slice_body(self.gh()["issues"][str(number)]["body"])["small"]["widened"]
        self.assertEqual(widened["rule"], "high-risk-file")
        # The Factory takes the answer: the question is settled, the cell is a full slice, and it plans again.
        self.factory()
        applied = self.product("intake")
        self.assertEqual([item["to_revision"] for item in applied["applied"]], [2])
        state = self.cell(ticket)
        self.assertEqual((state["stage"], state.get("spec_question"), state["product"]["revision"]), ("spec-ready", None, 2))
        self.assertEqual((state["widened"]["rule"], state["widened"]["by"], state["widened"]["reason"]),
                         ("high-risk-file", "product-studio", small.sentence("high-risk-file")))
        self.assertEqual(self.cell_spec_json(ticket)["widened"], state["widened"])
        self.assertEqual(run.next_step(run.Project(self.eng), ticket, True)["action"], "plan")
        self.assertEqual(self.check_plan(ticket, HIGH_RISK)["status"], "PLANNED", "judged no more")

    def test_widened_on_the_product_managers_word_reaches_the_cell(self):
        self.studio_small()
        self.ok(self.a, "slice", "widen", "SLICE-001", "--why", "It also changes the reminder email.")
        self.ok(self.a, "slice", "ready", "SLICE-001")
        self.factory()
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        state = self.cell(str(self.ledger()["slices"]["SLICE-001"]["ticket_id"]))
        self.assertEqual((state["widened"]["rule"], state["widened"]["by"]), (None, "product-studio"))
        self.assertIn("off the light path", state["widened"]["reason"])

    def test_a_ready_folder_carries_the_kind(self):
        slice_id = self.slice(self.a, "Clearer expired invitation message")
        files = self.folders[slice_id]
        files["spec.md"], files["why.md"] = spec_as(slice_id), STUDIO_INTENT.format(slice_id=slice_id, tier="Low")
        record = json.loads(files["slice.json"])
        record.update(spec_sha256=issue_rules.text_sha256_of(files["spec.md"]), why_sha256=issue_rules.text_sha256_of(files["why.md"]),
                      small=dict(ADJUSTMENT, widened={"rule": "questions", "at": WHEN}))
        files["slice.json"] = json.dumps(record, indent=2, sort_keys=True) + "\n"
        self.publish(self.a, slice_id)
        taken = self.product("intake")
        self.assertEqual(taken["not_accepted"], [])
        self.product("dispatch", slice_id)
        state = self.cell(self.ledger()["slices"][slice_id]["ticket_id"])
        self.assertEqual((state["kind"], state["widened"]["rule"], state["widened"]["reason"]), ("small", "questions", small.sentence("questions")))

    def test_a_folder_with_a_record_out_of_its_form_is_not_accepted(self):
        slice_id = self.slice(self.a, "Clearer expired invitation message")
        record = json.loads(self.folders[slice_id]["slice.json"])
        record["small"] = dict(FIX, shipped_rule=None)
        self.folders[slice_id]["slice.json"] = json.dumps(record)
        self.publish(self.a, slice_id)
        self.assertIn("small-change record", self.product("intake")["not_accepted"][0]["reason"])

    def test_a_slice_that_is_not_small_is_handed_over_exactly_as_before(self):
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        self.drafted()
        number = self.ok(self.a, "slice", "ready", "SLICE-001")["issue"]
        issue = self.gh()["issues"][str(number)]
        why, spec = self.draft(self.a, "product/intents/SLICE-001.md").read_text(), self.draft(self.a, "specs/slices/SLICE-001-invite-teammate.md").read_text()
        self.assertEqual(issue["body"], issue_rules.slice_issue_body("SLICE-001", 1, issue_rules.parse_slice_body(issue["body"])["epic"], [], why, spec))
        self.factory()
        self.product("intake")
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertNotIn("small", entry)
        self.assertEqual(entry["digest"], intake.digest_of(why, spec))
        self.product("dispatch", "SLICE-001")
        self.assertFalse({"kind", "small", "widened"} & set(self.cell(str(number))))
        self.assertFalse({"kind", "widened"} & set(self.cell_spec_json(str(number))))


if __name__ == "__main__":
    unittest.main()
