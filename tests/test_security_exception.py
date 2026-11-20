"""Tests for a person's recorded exception to a security blocker (review.py except, M12).

A high or critical security blocker from any seat, or a blocker from the security seat under review.security_veto,
rejects the round whatever the count. A person may record, on their explicit word, that one such finding is real but
accepted for exactly the commit reviewed, with their reason. These tests hold the rules: what may be excepted and
when, what the round becomes, how the merge station binds it to the commit and to its expiry, where it is recorded,
and that nothing unattended can record or use one.
"""

import io
import json
import os
import re
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
for folder in ("review", "merge", "cleanup", "run", "observe"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import cleanup  # noqa: E402
import decide  # noqa: E402
import explain  # noqa: E402
import merge  # noqa: E402
import observe  # noqa: E402
import policy  # noqa: E402
import review  # noqa: E402
import run  # noqa: E402
from test_build import git  # noqa: E402
from test_review import Base as ReviewBase, TICKET  # noqa: E402

REASON = "We accept the verbose log line for this internal build; it is rotated hourly and fixed in the next slice."
TODAY = datetime.now(timezone.utc).date()


class Base(ReviewBase):
    """A Medium-risk round the security veto rejected although two of three seats approved."""

    def security(self, impact="high", **changes):
        return self.blocker(**{"class": "security", "impact": impact, "rule": "REVIEW.md: no secrets in logs", **changes})

    def vetoed(self, risk=None, config=None, product=None, security=(), architecture=()):
        self.verified()
        if config is not None:
            self.config(config)
        if risk:
            self.edit_json("cell.json", risk=risk)
        self.r_ok("start", TICKET)
        self.vote("architecture", *architecture)
        self.vote("security", *security)
        self.vote("product", *(product if product is not None else [self.security()]))
        return self.tally()

    def decision(self, folder=None):
        return json.loads(((folder or self.round) / "decision.json").read_text())

    def top(self):
        return json.loads((self.cellroot / "review/decision.json").read_text())

    def excepted(self, *refs, by="Dana Smith", reason=REASON, extra=()):
        argv = ["except", TICKET]
        for ref in refs or ("1/product/1",):
            argv += ["--finding", ref]
        return self.r_ok(*argv, "--by", by, "--reason", reason, *extra)

    def except_refused(self, *refs, by="Dana Smith", reason=REASON, extra=(), env=None):
        argv = ["except", TICKET]
        for ref in refs or ("1/product/1",):
            argv += ["--finding", ref]
        with mock.patch.dict(os.environ, env or {}):
            return self.r_refused(*argv, "--by", by, "--reason", reason, *extra)

    def log(self):
        path = self.cellroot / "lifecycle.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []

    # --- other stations -----------------------------------------------------------------------

    def next(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.project), "next", TICKET])
        self.assertEqual(code, 0, err.getvalue())
        return json.loads(out.getvalue())

    def decide(self, *tickets):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.project), "decide", *tickets, "--json"])
        self.assertEqual(code, 0, err.getvalue())
        return json.loads(out.getvalue())

    def explain(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.project), "explain", TICKET, "--json"])
        self.assertEqual(code, 0, err.getvalue())
        return json.loads(out.getvalue())

    def m(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = merge.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def expire(self, days=1):
        """The exception's expiry moves into the past, as time passing would do."""
        past = (TODAY - timedelta(days=days)).isoformat()
        for path in (self.round / "decision.json", self.cellroot / "review/decision.json"):
            data = json.loads(path.read_text())
            for item in data.get("exceptions") or []:
                item["expires"] = past
            path.write_text(json.dumps(data))


class WhatMayBeExceptedTest(Base):
    def test_a_lone_vetoing_blocker_is_excepted_and_the_round_takes_the_count(self):
        code, done = self.vetoed()
        self.assertEqual((code, done["outcome"], done["approvals"]), (1, "REJECTED", 2))
        self.assertEqual(self.decision()["vetoing"], ["1/product/1"], "the tally records which blockers vetoed")
        votes_before = {p.name: p.read_bytes() for p in (self.round / "votes").glob("*.json")}
        findings_before = (self.round / "findings.md").read_bytes()
        head = git(self.work, "rev-parse", "HEAD").stdout.strip()
        result = self.excepted(extra=("--expires", (TODAY + timedelta(days=30)).isoformat()))
        self.assertEqual((result["outcome"], result["stage"], result["remaining"]), ("APPROVED", "approved", []))
        decision = self.decision()
        self.assertEqual(decision, self.top(), "the round's record and the latest decision agree")
        self.assertEqual((decision["outcome"], decision["outcome_before_exception"], decision["security_veto"]), ("APPROVED", "REJECTED", True))
        [item] = decision["exceptions"]
        self.assertEqual({k: item[k] for k in ("by", "round", "seat", "index", "title", "rule", "file", "class", "impact", "head", "reason")},
                         {"by": "Dana Smith", "round": "1", "seat": "product", "index": 1, "title": "Email is never validated",
                          "rule": "REVIEW.md: no secrets in logs", "file": "app/invite.py", "class": "security", "impact": "high", "head": head, "reason": REASON})
        self.assertEqual(item["expires"], (TODAY + timedelta(days=30)).isoformat())
        self.assertTrue(item["recorded_at"])
        self.assertEqual({p.name: p.read_bytes() for p in (self.round / "votes").glob("*.json")}, votes_before, "no vote is edited")
        self.assertEqual((self.round / "findings.md").read_bytes(), findings_before, "no finding is edited")
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["review"]), ("approved", "APPROVED"))
        self.assertEqual(json.loads((self.cellroot / "build.json").read_text()).get("loop", 0), 0, "no judging round is used")

    def test_an_ordinary_blocker_or_a_note_is_never_excepted(self):
        self.vetoed(product=[self.security(), self.blocker(rule="FR-02", title="A plain defect")], security=[self.note()])
        self.assertIn("an ordinary blocker is outvoted or fixed, never excepted", self.except_refused("1/product/2"))
        self.assertIn("is a note", self.except_refused("1/security/1"))
        self.assertIn("has no finding 9", self.except_refused("1/product/9"))
        self.assertIn("is not a seat on this round's panel", self.except_refused("1/general/1"))
        self.assertIn("<round>/<seat>/<n>", self.except_refused("product-1"))
        self.assertEqual(self.cell_json()["stage"], "built", "a refusal changes nothing")
        self.assertNotIn("exceptions", self.decision())

    def test_a_security_seat_blocker_vetoes_under_the_setting_and_stays_vetoing_if_the_setting_changes(self):
        code, done = self.vetoed(product=[], security=[self.blocker(rule="FR-03", title="No rate limit")])
        self.assertEqual((done["outcome"], self.decision()["security_veto"], self.decision()["vetoing"]), ("REJECTED", True, ["1/security/1"]))
        self.config({"review": {"security_veto": False}})  # switched off after the tally: the round's record decides, not today's file
        result = self.excepted("1/security/1")
        self.assertEqual(result["outcome"], "APPROVED")

    def test_refused_when_an_ordinary_blocker_still_fails_the_count(self):
        code, done = self.vetoed(architecture=[self.blocker()], product=[self.security(), self.blocker(rule="FR-02", title="Another plain defect")])
        self.assertEqual((done["outcome"], done["approvals"], self.decision()["security_veto"]), ("REJECTED", 1, False))
        self.assertFalse(self.decision()["exceptable"], "the tally records that excepting every vetoing blocker would not pass the count")
        err = self.except_refused()
        self.assertIn("would still fail with every vetoing blocker excepted", err)
        self.assertIn("the architecture seat still rejects on 1/architecture/1", err)
        self.assertIn("the product seat still rejects on 1/product/2", err)
        self.assertEqual(self.cell_json()["stage"], "built")

    def test_a_round_with_only_ordinary_blockers_has_no_veto_to_except(self):
        code, done = self.vetoed(product=[self.blocker()], architecture=[self.blocker()])
        self.assertEqual((done["outcome"], self.decision()["vetoing"], self.decision()["exceptable"]), ("REJECTED", [], False))
        self.assertEqual(self.decision()["blockers_by_seat"], {"architecture": {"vetoing": [], "other": ["1/architecture/1"]},
                                                              "product": {"vetoing": [], "other": ["1/product/1"]}})
        self.assertIn("rejected by ordinary blockers", self.except_refused())

    def test_refused_for_an_approved_round_or_a_round_not_yet_tallied(self):
        self.verified()
        self.r_ok("start", TICKET)
        self.vote("architecture")
        self.assertIn("has not been decided", self.except_refused())
        self.vote("security")
        self.vote("product")
        self.assertEqual(self.tally()[1]["outcome"], "APPROVED")
        self.assertIn("was not rejected by a security veto", self.except_refused())

    def test_a_factory_tuning_ticket_is_never_excepted(self):
        self.verified()
        self.put(self.project, {".factory/tickets/LOCAL-001.md": '---\nid: LOCAL-001\ntitle: "Tune"\nstate: open\nlabels: ["factory-tuning"]\n---\n'})
        self.r_ok("start", TICKET)
        self.vote("architecture")
        self.vote("security")
        self.vote("product", self.security())
        self.assertEqual(self.tally()[1]["outcome"], "REJECTED")
        self.assertIn("factory-tuning", self.except_refused())

    def test_every_vetoing_blocker_needs_an_exception_and_a_partial_one_is_refused(self):
        self.vetoed(product=[self.security(), self.security(impact="critical", title="SQL built by concatenation", line=1)])
        self.assertEqual(self.decision()["vetoing"], ["1/product/1", "1/product/2"])
        err = self.except_refused("1/product/1")
        self.assertIn("would still be rejected", err)
        self.assertIn("1/product/2", err, "the refusal names what still blocks")
        self.assertNotIn("exceptions", self.decision(), "nothing is written")
        both = self.excepted("1/product/1", "1/product/2")
        self.assertEqual((both["outcome"], both["stage"]), ("APPROVED", "approved"))
        self.assertEqual([e["index"] for e in self.decision()["exceptions"]], [1, 2])

    def test_several_findings_at_once_are_all_or_nothing(self):
        self.vetoed(product=[self.security(), self.security(impact="critical", title="SQL built by concatenation", line=1)])
        self.assertIn("has no finding 3", self.except_refused("1/product/1", "1/product/3"))
        self.assertNotIn("exceptions", self.decision(), "nothing is written when one of them is refused")
        self.assertEqual(self.excepted("1/product/1", "1/product/2")["outcome"], "APPROVED")


class RecountTest(Base):
    """A recorded exception also clears the reject vote of a seat whose every blocker it excepts (product owner, M12 follow-up),
    so an exception works at every tier. Votes are never rewritten; the decision records both counts."""

    def test_high_risk_three_of_three_with_the_security_seats_only_blocker_excepted_awaits_a_person(self):
        code, done = self.vetoed(risk="High", product=[], security=[self.security()])
        self.assertEqual((done["outcome"], done["approvals"], done["approvals_needed"]), ("REJECTED", 2, 3))
        decision = self.decision()
        self.assertEqual((decision["security_veto"], decision["exceptable"], decision["vetoing"]), (False, True, ["1/security/1"]))
        self.assertEqual(decision["blockers_by_seat"], {"security": {"vetoing": ["1/security/1"], "other": []}})
        votes_before = {p.name: p.read_bytes() for p in (self.round / "votes").glob("*.json")}
        result = self.excepted("1/security/1")
        self.assertEqual((result["outcome"], result["stage"], result["rejects_cleared"]), ("AWAITING_HUMAN", "awaiting-human", ["security"]))
        self.assertIn("approve-human", result["next"], "an exception is not a person's approval")
        decision = self.decision()
        self.assertEqual((decision["approvals"], decision["approvals_before_exception"], decision["approvals_after_exception"],
                          decision["rejects_cleared_by_exception"], decision["outcome_before_exception"]), (2, 2, 3, ["security"], "REJECTED"))
        self.assertEqual(decision["votes"]["security"], "REJECT", "the vote stands as cast")
        self.assertEqual({p.name: p.read_bytes() for p in (self.round / "votes").glob("*.json")}, votes_before, "no vote file is rewritten")
        self.assertIsNone(decision["human_approval"])
        self.r_ok("approve-human", TICKET, "--by", "Release Owner")
        self.assertEqual(self.cell_json()["stage"], "approved")

    def test_a_seat_with_an_excepted_and_an_ordinary_blocker_still_rejects(self):
        code, done = self.vetoed(risk="High", product=[self.security(), self.blocker(rule="FR-02", title="A plain defect")])
        self.assertFalse(self.decision()["exceptable"])
        err = self.except_refused("1/product/1")
        self.assertIn("the product seat still rejects on 1/product/2", err)
        self.assertNotIn("exceptions", self.decision())
        self.assertEqual(self.cell_json()["stage"], "built")
        self.assertIsNone(decide.exception_offer(self.project, TICKET), "the walkthrough offers it only where the script would accept it")

    def test_low_risk_one_of_one_follows_the_recount(self):
        self.verified()
        self.edit_json("cell.json", risk="Low")
        self.r_ok("start", TICKET)
        self.vote("general", self.security())
        code, done = self.tally()
        self.assertEqual((done["outcome"], done["approvals"], done["approvals_needed"]), ("REJECTED", 0, 1))
        self.assertEqual(self.excepted("1/general/1")["outcome"], "APPROVED")
        self.assertEqual((self.decision()["approvals_after_exception"], self.decision()["rejects_cleared_by_exception"]), (1, ["general"]))

    def test_low_risk_with_an_ordinary_blocker_beside_the_veto_is_refused(self):
        self.verified()
        self.edit_json("cell.json", risk="Low")
        self.r_ok("start", TICKET)
        self.vote("general", self.security(), self.blocker(rule="FR-02", title="A plain defect"))
        self.tally()
        self.assertIn("the general seat still rejects on 1/general/2", self.except_refused("1/general/1"))

    def test_two_vetoing_blockers_from_two_seats_need_both_excepted(self):
        code, done = self.vetoed(risk="High", product=[self.security()], security=[self.security(title="Token in a log line", line=1)])
        self.assertEqual((done["approvals"], self.decision()["vetoing"]), (1, ["1/security/1", "1/product/1"]))
        self.assertIn("would still be rejected", self.except_refused("1/security/1"))
        self.assertIn("would still be rejected", self.except_refused("1/product/1"))
        result = self.excepted("1/security/1", "1/product/1")
        self.assertEqual((result["outcome"], result["rejects_cleared"]), ("AWAITING_HUMAN", ["product", "security"]))
        self.assertEqual(self.decision()["approvals_after_exception"], 3)

    def test_the_walkthrough_explain_and_the_pull_request_carry_the_recount(self):
        self.vetoed(risk="High", product=[], security=[self.security()])
        offer = decide.exception_offer(self.project, TICKET)
        self.assertEqual(offer["open"], ["1/security/1"])
        self.assertIn("recount", decide.exception_option(TICKET, offer)["does"])
        self.excepted("1/security/1")
        facts = self.explain()
        self.assertEqual((facts["exception_recount"]["approvals_before"], facts["exception_recount"]["approvals_after"],
                          facts["exception_recount"]["rejects_cleared"]), (2, 3, ["security"]))
        self.r_ok("approve-human", TICKET, "--by", "Release Owner")
        body = merge.pr_body(merge.Cell(self.project, TICKET))
        self.assertIn("2 approvals before the exception, 3 after (security seat)", body)


class WhoAndWhyTest(Base):
    def test_the_person_and_their_reason_are_required(self):
        self.vetoed()
        self.assertIn("--by must name the person", self.except_refused(by=" D "))
        self.assertIn("in the person's own words", self.except_refused(reason="ok"))
        self.assertIn("YYYY-MM-DD", self.except_refused(extra=("--expires", "next week")))
        self.assertIn("in the past", self.except_refused(extra=("--expires", (TODAY - timedelta(days=1)).isoformat())))
        self.assertEqual(self.excepted(extra=("--expires", TODAY.isoformat()))["outcome"], "APPROVED", "today is not in the past")

    def test_the_reason_is_bounded_and_redacted(self):
        self.vetoed()
        secret = "ghp_" + "a1B2c3D4e5" * 4
        self.excepted(reason=f"Accepted for now, token {secret} is a test one. " + "x" * 5000)
        stored = self.decision()["exceptions"][0]["reason"]
        self.assertNotIn(secret, stored)
        self.assertLessEqual(len(stored), review.EXCEPTION_REASON_LIMIT)

    def test_only_a_named_owner_may_grant_one_when_the_project_says_so(self):
        self.vetoed(config={"review": {"security_exception_by": ["Security Lead", "Dana Smith"]}})
        self.assertIn("review.security_exception_by", self.except_refused(by="Someone Else"))
        self.assertEqual(self.excepted(by="  dana   smith ")["outcome"], "APPROVED", "matched without regard to case or spacing")

    def test_an_empty_list_lets_any_person_grant_one_and_a_malformed_one_refuses(self):
        self.vetoed(config={"review": {"security_exception_by": "Dana Smith"}})
        self.assertIn("must be a list of names", self.except_refused())
        self.config({"review": {"security_exception_by": []}})
        self.assertEqual(self.excepted(by="Anyone At All")["outcome"], "APPROVED")

    def test_the_template_has_the_key_as_an_empty_list(self):
        template = json.loads((ROOT / "templates/config.json").read_text())
        self.assertEqual(template["review"]["security_exception_by"], [])


class WhenTest(Base):
    def test_refused_once_a_revision_has_started(self):
        code, done = self.vetoed()
        self.ok("revise", TICKET, "--findings", done["findings"])
        self.assertIn("revision has started", self.except_refused())

    def test_refused_when_the_branch_moved_off_the_reviewed_commit(self):
        self.vetoed()
        self.commit_in_cell()
        self.assertIn("is no longer the commit the panel reviewed", self.except_refused())

    def test_refused_after_the_merge_station_sent_it_back(self):
        self.vetoed()
        self.edit_json("review/decision.json", rejected_by="merge station")
        self.assertIn("not the latest decision", self.except_refused())

    def test_an_escalated_round_can_be_excepted_and_the_round_limit_is_unchanged(self):
        code, done = self.vetoed(config={"review": {"max_loops": 1}})
        self.assertEqual((done["outcome"], self.cell_json()["stage"]), ("ESCALATE", "blocked"))
        result = self.excepted()
        self.assertEqual((result["outcome"], result["stage"]), ("APPROVED", "approved"))
        self.assertEqual(review.MAX_LOOPS, 3)

    def test_an_exception_is_refused_inside_a_supervised_execution(self):
        self.vetoed()
        err = self.except_refused(env={"MACH_EXECUTION_ID": "x0123456789ab"})
        self.assertIn("Inside a supervised Factory execution", err)
        self.assertNotIn("exceptions", self.decision())
        self.assertEqual(self.cell_json()["stage"], "built")


class ApprovalStillNeededTest(Base):
    def test_an_exception_is_not_a_persons_approval(self):
        """High risk with two approvals asked of three seats: the exception clears the veto, approve-human is still needed."""
        code, done = self.vetoed(risk="High", config={"review": {"high": {"approvals": 2}}})
        self.assertEqual((done["outcome"], done["approvals"]), ("REJECTED", 2))
        result = self.excepted()
        self.assertEqual((result["outcome"], result["stage"]), ("AWAITING_HUMAN", "awaiting-human"))
        self.assertIsNone(self.decision()["human_approval"])
        self.assertEqual(self.next()["needs"], "human-approval")
        self.r_ok("approve-human", TICKET, "--by", "Release Owner")
        self.assertEqual(self.cell_json()["stage"], "approved")

    def test_a_silver_readiness_tier_still_needs_a_person(self):
        self.verified()
        self.edit_json("cell.json", human_review_required=True)
        self.r_ok("start", TICKET)
        self.vote("architecture")
        self.vote("security")
        self.vote("product", self.security())
        self.tally()
        self.assertEqual(self.excepted()["outcome"], "AWAITING_HUMAN")

    def test_approve_human_is_refused_once_an_exception_expired(self):
        self.vetoed(risk="High", config={"review": {"high": {"approvals": 2}}})
        self.excepted(extra=("--expires", TODAY.isoformat()))
        self.expire()
        self.assertIn("expired", self.r_refused("approve-human", TICKET, "--by", "Release Owner"))


class LifecycleTest(Base):
    def test_the_log_records_codes_and_never_the_reason_or_the_name(self):
        self.vetoed()
        self.excepted(extra=("--expires", (TODAY + timedelta(days=3)).isoformat()))
        records = [r for r in self.log() if r["type"] == "review.exception_recorded"]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["station"], "review")
        self.assertEqual(records[0]["data"], {"round": 1, "findings": [{"seat": "product", "index": 1, "impact": "high"}], "expires_given": True,
                                              "renewal": False, "outcome": "APPROVED"})
        text = (self.cellroot / "lifecycle.jsonl").read_text()
        self.assertNotIn("rotated hourly", text)
        self.assertNotIn("Dana", text)
        self.assertEqual([r["data"].get("stage") for r in self.log() if r["type"] == "station.exited"][-1], "approved")

    def test_the_lifecycle_schema_knows_the_record(self):
        import lifecycle
        from test_lifecycle import SCHEMA, schema_errors
        self.assertIn("review.exception_recorded", lifecycle.TYPES)
        self.vetoed()
        self.excepted(extra=("--expires", (TODAY + timedelta(days=3)).isoformat()))
        for record in self.log():
            self.assertEqual(schema_errors(record, SCHEMA), [], record)


class MergeTest(Base):
    def approved_by_exception(self, **expires):
        self.vetoed()
        extra = ("--expires", expires["on"]) if expires else ()
        self.excepted(extra=extra)
        return self.decision()["head"]

    def test_an_excepted_approval_merges_and_the_pull_request_body_says_so(self):
        head = self.approved_by_exception()
        body = merge.pr_body(merge.Cell(self.project, TICKET))
        self.assertIn("Security exceptions", body)
        self.assertIn("Dana Smith", body)
        self.assertIn("rotated hourly", body)
        self.assertIn("product seat, high impact", body)
        code, out, err = self.m("run", TICKET, "--by-person")
        self.assertEqual(code, 0, err + out)
        self.assertEqual(json.loads(out)["approved_commit"], head)

    def test_a_new_commit_voids_an_excepted_approval_as_it_voids_any(self):
        self.approved_by_exception()
        self.commit_in_cell()
        code, out, err = self.m("run", TICKET, "--by-person")
        self.assertEqual(code, 1)
        self.assertIn("The approval no longer holds", err)
        self.assertEqual((self.cell_json()["stage"], self.top()["outcome"]), ("built", "VOID"))
        kept = self.decision()
        self.assertEqual((kept["outcome"], len(kept["exceptions"])), ("VOID", 1), "the exception stays on record with the voided round")

    def test_an_expired_exception_stops_the_merge_for_a_person(self):
        self.approved_by_exception(on=TODAY.isoformat())
        self.expire()
        plan = json.loads(self.m("plan", TICKET, "--by-person")[1])
        self.assertFalse(plan["allowed"])
        code, out, err = self.m("run", TICKET, "--by-person")
        self.assertEqual(code, 1)
        self.assertIn("security exception", err)
        self.assertIn("expired", err)
        self.assertEqual(self.cell_json()["stage"], "approved", "nothing is changed: a person decides")
        step = self.next()
        self.assertEqual((step["action"], step["needs"]), ("stop", "security-exception-expired"))
        gate = [r["data"] for r in self.log() if r["type"] == "gate.evaluated" and r["station"] == "merge"][-1]
        self.assertEqual(gate["reason_code"], "exception-expired")

    def test_a_person_may_renew_an_expired_exception(self):
        self.approved_by_exception(on=TODAY.isoformat())
        self.expire()
        renewed = self.excepted(extra=("--expires", (TODAY + timedelta(days=7)).isoformat()), by="Lee Park")
        self.assertEqual((renewed["outcome"], renewed["renewal"]), ("APPROVED", True))
        items = self.decision()["exceptions"]
        self.assertEqual([(e["by"], e.get("renews")) for e in items], [("Dana Smith", None), ("Lee Park", 0)], "the expired one is kept")
        self.assertIn("is still in force", self.except_refused())
        self.assertEqual(self.next()["needs"], "merge")

    def test_revalidation_keeps_the_exception_as_it_keeps_the_approval(self):
        self.approved_by_exception()
        self.put(self.project, {"NEWS.md": "main moved\n"})
        git(self.project, "add", "NEWS.md")
        git(self.project, "commit", "-q", "-m", "main moved")
        code, out, err = self.m("run", TICKET, "--by-person")
        self.assertEqual(code, 0, err + out)
        done = json.loads(out)
        self.assertIsNotNone(done["revalidated"])
        self.assertNotEqual(done["landed_commit"], done["approved_commit"])


class RunRecordTest(Base):
    def test_cleanup_counts_exceptions_without_the_reason_or_the_name(self):
        self.vetoed()
        self.excepted(extra=("--expires", (TODAY + timedelta(days=3)).isoformat()))
        record = cleanup.run_record(cleanup.Cell(self.project, TICKET), "abandoned", "test", "x.tar.gz")
        self.assertEqual(record["record_version"], 2, "an optional field added: the version stays, as M8 decided for origin")
        [item] = record["security_exceptions"]
        self.assertEqual({k: item[k] for k in ("round", "seat", "index", "impact", "class", "rule")},
                         {"round": 1, "seat": "product", "index": 1, "impact": "high", "class": "security", "rule": "REVIEW.md: no secrets in logs"})
        self.assertTrue(item["expires"])
        self.assertNotIn("reason", item)
        self.assertNotIn("by", item)
        blocker = next(b for b in record["blockers"] if b["reviewer"] == "product")
        self.assertEqual((blocker["class"], blocker["impact"], blocker["excepted"]), ("security", "high", True))


class ExplainAndDecideTest(Base):
    def test_explain_shows_who_and_why_and_marks_the_blocker(self):
        self.vetoed()
        self.excepted()
        report = self.explain()
        [item] = report["security_exceptions"]
        self.assertEqual((item["ref"], item["by"], item["expired"]), ("1/product/1", "Dana Smith", False))
        self.assertIn("rotated hourly", item["reason"])
        blocker = next(b for b in report["outvoted_blockers"] if b["seat"] == "product")
        self.assertTrue(blocker["excepted"])

    def test_decide_offers_it_only_where_the_script_would_accept_it_and_never_recommends_it(self):
        self.vetoed()
        self.assertEqual(self.decide()["order"], [], "a rejected round is the builder's: nothing waits unprompted")
        [item] = self.decide(TICKET)["tickets"]
        self.assertEqual(item["state"], "security-veto")
        options = {o["key"]: o for o in item["options"]}
        self.assertEqual(options["exception"]["route"], f'except {TICKET} 1/product/1 "<why>"')
        self.assertTrue(options["exception"]["needs_reason"])
        self.assertFalse(any(o["recommended"] for o in item["options"]))
        self.assertEqual(item["recommendation"], {"basis": "judgement"})
        self.assertIn("revise", options)

    def test_decide_does_not_offer_it_when_the_count_failed_or_a_revision_started(self):
        # The product seat's veto comes with an ordinary blocker, and architecture rejects too: excepting the veto cannot pass the count.
        code, done = self.vetoed(architecture=[self.blocker()], product=[self.security(), self.blocker(rule="FR-02", title="A plain defect")])
        self.assertEqual(self.decide(TICKET)["tickets"], [])
        self.setUp()
        code, done = self.vetoed()
        self.ok("revise", TICKET, "--findings", done["findings"])
        self.assertEqual(self.decide(TICKET)["tickets"], [])

    def test_decide_offers_renewal_once_it_expired(self):
        self.vetoed()
        self.excepted(extra=("--expires", TODAY.isoformat()))
        self.expire()
        [item] = self.decide()["tickets"]
        self.assertEqual(item["state"], "exception-expired")
        self.assertEqual([o["key"] for o in item["options"]], ["exception", "abandon"])
        self.assertFalse(any(o["recommended"] for o in item["options"]))

    def test_an_escalated_round_lists_it_beside_abandoning(self):
        self.vetoed(config={"review": {"max_loops": 1}})
        [item] = self.decide()["tickets"]
        self.assertEqual(item["state"], "escalated")
        self.assertEqual([o["key"] for o in item["options"]], ["exception", "abandon"])


class UnattendedTest(unittest.TestCase):
    """No unattended path can reach the command: the script refuses it, and no instruction or workflow prescribes it."""

    # No instruction an unattended run follows prescribes it: tests/test_unattended_commands.py holds that with the other commands.

    def test_the_belt_and_the_supervisor_never_name_it(self):
        for name in ("workflows/belt.js", "skills/run/scripts/supervisor.py", "skills/run/scripts/executor.py", "skills/run/scripts/monitoring.py",
                     "skills/run/scripts/pull.py", "skills/run/scripts/intake.py"):
            text = (ROOT / name).read_text()
            self.assertNotIn("security_exception", text, name)
            self.assertIsNone(re.search(r"['\"]except['\"]|\bexcept <ticket>|\bexcept [A-Z]+-\d", text), name)

    def test_the_consented_tool_list_is_unchanged(self):
        self.assertEqual(policy.BASE_TOOLS, ("Workflow", "Skill", "Agent", "Read", "Write", "Edit", "Glob", "Grep",
                                             "Bash(python3 *)", "Bash(git status *)", "Bash(git log *)", "Bash(git diff *)", "Bash(git show *)"))

    def test_the_supervisor_still_refuses_weakened_review_settings(self):
        weakened = {"review": {"security_veto": False, "security_exception_by": ["Dana Smith"]}}
        self.assertEqual(len(policy.security_review_problems(weakened)), 1)
        self.assertEqual(policy.security_review_problems({"review": {"security_exception_by": ["Dana Smith"]}}), [],
                         "naming who may grant an exception weakens nothing the supervisor checks")

    def test_observe_never_proposes_an_exception(self):
        self.assertFalse(observe.allowed_target(".factory/worktrees/LOCAL-001/review/round-1/decision.json"))
        self.assertFalse(observe.allowed_target(".factory/config.json"))
        self.assertNotIn("except", re.findall(r"review\.py\W+(\w+)", (ROOT / "skills/observe/scripts/observe.py").read_text()))
        self.assertNotIn("security_exception", (ROOT / "skills/observe/scripts/observe.py").read_text())


if __name__ == "__main__":
    unittest.main()
