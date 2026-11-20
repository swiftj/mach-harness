"""M15: review noise. A note's weight (important or nit), the per-seat cap on nits, and a person's rating of a finding."""

import json
import os
import shutil
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "review" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "merge" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "cleanup" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import change_record  # noqa: E402
import cleanup  # noqa: E402
import merge  # noqa: E402
from test_review import Base, PANEL, TICKET  # noqa: E402

DECIDED = ("outcome", "approvals", "approvals_needed", "votes", "blockers", "security_veto", "security_blockers", "vetoing",
           "blockers_by_seat", "exceptable", "human_approval_required")


def nit(n):
    return {"severity": "note", "weight": "nit", "title": f"Nit number {n}", "detail": "A clearer variable name would read better in this function."}


def important(**changes):
    finding = {"severity": "note", "weight": "important", "title": "Weak test for FR-02", "detail": "The test would pass if the seat were never held."}
    finding.update(changes)
    return finding


class WeightTest(Base):
    def setUp(self):
        super().setUp()
        self.verified()
        self.r_ok("start", TICKET)

    def test_a_weight_is_for_a_note_and_is_important_or_nit(self):
        self.assertIn("'weight' is for a note", self.bad(self.blocker(weight="important")))
        self.assertIn("must be 'important' or 'nit'", self.bad(important(weight="minor")))
        self.assertIn("never a nit", self.bad(dict(nit(1), **{"class": "security", "impact": "low"})))
        self.assertIn("never a nit", self.bad(dict(nit(1), impact="low"), role="security"))

    def test_a_note_without_a_weight_is_stored_as_before(self):
        self.vote("architecture", self.note(), important())
        stored = json.loads((self.round / "votes" / "architecture.json").read_text())
        self.assertNotIn("weight", stored["findings"][0], "an unweighted note keeps its shape, and reads as important")
        self.assertEqual(stored["findings"][1]["weight"], "important")
        self.assertNotIn("nits_dropped", stored)

    def test_the_default_cap_keeps_the_first_five_nits_in_the_seats_order(self):
        listed = [nit(1), self.blocker(), nit(2), important(), nit(3), nit(4), nit(5), nit(6), self.note(), nit(7)]
        done = self.vote("product", *listed)
        self.assertEqual((done["vote"], done["blockers"], done["nits_dropped"], done["nit_cap"]), ("REJECT", 1, 2, 5))
        stored = json.loads((self.round / "votes" / "product.json").read_text())
        self.assertEqual([f["title"] for f in stored["findings"]],
                         ["Nit number 1", "Email is never validated", "Nit number 2", "Weak test for FR-02", "Nit number 3", "Nit number 4",
                          "Nit number 5", "README could say more"])
        self.assertEqual((stored["nits_dropped"], stored["nit_cap"]), (2, 5))

    def test_the_cap_is_a_setting_and_never_drops_a_blocker_or_an_important_note(self):
        for cap, kept in ((2, 2), (0, 0)):
            with self.subTest(cap=cap):
                shutil.rmtree(self.round / "votes", ignore_errors=True)
                self.config({"review": {"nit_cap": cap}})
                self.r_ok("start", TICKET)
                self.vote("architecture", self.blocker(), *[nit(n) for n in range(1, 5)], important(), self.note())
                stored = json.loads((self.round / "votes" / "architecture.json").read_text())
                self.assertEqual(sum(1 for f in stored["findings"] if f.get("weight") == "nit"), kept)
                self.assertEqual(sum(1 for f in stored["findings"] if f["severity"] == "blocker"), 1)
                self.assertEqual(sum(1 for f in stored["findings"] if f["severity"] == "note" and f.get("weight") != "nit"), 2)
                self.assertEqual(stored["nits_dropped"], 4 - kept)
        self.config({"review": {"nit_cap": "lots"}})
        self.r_ok("start", TICKET)
        self.assertEqual(json.loads((self.round / "packet.json").read_text())["nit_cap"], 5, "an unusable setting reads as 5")

    def test_findings_md_lists_important_notes_and_the_kept_nits_with_the_count(self):
        self.config({"review": {"nit_cap": 1}})
        self.r_ok("start", TICKET)
        self.vote("architecture", important(), nit(1), nit(2), nit(3))
        self.vote("security")
        self.vote("product", self.note())
        self.tally()
        text = (self.round / "findings.md").read_text()
        notes, nits = text.index("## Notes: do not block"), text.index("## Nits: do not block")
        self.assertLess(notes, nits)
        self.assertLess(notes, text.index("Weak test for FR-02"))
        self.assertLess(notes, text.index("README could say more"))
        self.assertLess(nits, text.index("Nit number 1"))
        self.assertNotIn("Nit number 2", text)
        self.assertIn("- 2 more nits from the architecture seat not listed: review.nit_cap keeps 1 per seat.", text)


class TallyUnchangedTest(Base):
    """No vote, threshold, veto or round rule depends on a note or its weight: the tally is identical with and without nits."""

    def decide(self, pattern, with_nits):
        shutil.rmtree(self.round / "votes", ignore_errors=True)
        for path in (self.round / "decision.json", self.cellroot / "review" / "decision.json"):
            path.unlink(missing_ok=True)
        for role in PANEL:
            findings = list(pattern.get(role, []))
            if with_nits:
                findings += [nit(n) for n in range(1, 9)] + [important()]
            self.vote(role, *findings)
        self.tally()
        decision = json.loads((self.round / "decision.json").read_text())
        return {key: decision.get(key) for key in DECIDED}

    def test_the_tally_is_identical_with_and_without_nits(self):
        self.verified()
        self.r_ok("start", TICKET)
        patterns = {
            "everyone approves": {},
            "one seat rejects": {"architecture": [self.blocker()]},
            "two seats reject": {"architecture": [self.blocker()], "product": [self.blocker()]},
            "security seat veto": {"security": [self.blocker()]},
            "high-impact security blocker": {"product": [self.blocker(**{"class": "security", "impact": "high"})]},
        }
        for name, pattern in patterns.items():
            with self.subTest(name):
                self.assertEqual(self.decide(pattern, True), self.decide(pattern, False))


class RateTest(Base):
    def setUp(self):
        super().setUp()
        self.verified()
        self.r_ok("start", TICKET)
        self.vote("architecture", self.blocker(), nit(1))
        self.vote("security")
        self.vote("product", important())

    def test_a_rating_is_kept_beside_the_round_and_never_in_a_vote(self):
        before = (self.round / "votes" / "architecture.json").read_bytes()
        done = self.r_ok("rate", TICKET, "--finding", "1/architecture/2", "--not-useful", "--by", "the tech lead")
        self.assertEqual((done["status"], done["rating"]), ("RATED", "not-useful"))
        self.r_ok("rate", TICKET, "--finding", "1/product/1", "--useful")
        self.r_ok("rate", TICKET, "--finding", "1/architecture/2", "--useful", "--by", "the tech lead")
        self.r_ok("rate", TICKET, "--finding", "1/architecture/1", "--useful", "--by", "the product manager")
        self.assertEqual((self.round / "votes" / "architecture.json").read_bytes(), before, "a vote file is never rewritten")
        ratings = json.loads((self.round / "ratings.json").read_text())["ratings"]
        self.assertEqual([(r["finding"], r["rating"], r["by"], r["severity"], r["weight"]) for r in ratings],
                         [("1/product/1", "useful", "a person", "note", "important"),
                          ("1/architecture/2", "useful", "the tech lead", "note", "nit"),
                          ("1/architecture/1", "useful", "the product manager", "blocker", None)])

    def test_a_rating_names_a_real_finding_and_is_a_persons_word(self):
        self.assertIn("must be <round>/<seat>/<n>", self.r_refused("rate", TICKET, "--finding", "first", "--useful"))
        self.assertIn("no finding 1/security/1", self.r_refused("rate", TICKET, "--finding", "1/security/1", "--useful"))
        self.assertIn("no finding 2/product/1", self.r_refused("rate", TICKET, "--finding", "2/product/1", "--useful"))
        with mock.patch.dict(os.environ, {"MACH_EXECUTION_ID": "exec-1"}):
            self.assertIn("a person's word", self.r_refused("rate", TICKET, "--finding", "1/product/1", "--useful"))
        self.assertFalse((self.round / "ratings.json").exists())

    def test_ratings_and_weights_reach_cleanups_run_record(self):
        self.tally()
        self.r_ok("rate", TICKET, "--finding", "1/architecture/2", "--not-useful", "--by", "the tech lead")
        record = cleanup.run_record(cleanup.Cell(self.project, TICKET), "merged", None, "archive.tar.gz")
        self.assertEqual(record["finding_ratings"], [{"round": 1, "finding": "1/architecture/2", "rating": "not-useful", "seat": "architecture",
                                                      "severity": "note", "weight": "nit", "rule": None}])
        self.assertNotIn("the tech lead", json.dumps(record), "who rated stays with the cell, never in the run log")
        self.assertEqual([(n["reviewer"], n.get("weight")) for n in record["notes"]], [("architecture", "nit"), ("product", "important")])
        self.assertNotIn("nits_dropped", record)


class ShownTest(Base):
    """The pull request review text and the change record show each note's weight, and the count of nits not kept."""

    def test_pull_request_text_and_change_record(self):
        self.verified()
        self.config({"review": {"nit_cap": 1}})
        self.r_ok("start", TICKET)
        self.vote("architecture", nit(1), important(), nit(2), nit(3))
        self.vote("security")
        self.vote("product", self.note())
        self.assertEqual(self.tally()[1]["outcome"], "APPROVED")
        cell = merge.Cell(self.project, TICKET)
        number, found = merge.approving_findings(cell)
        self.assertEqual([f["title"] for _, f in found], ["Weak test for FR-02", "README could say more", "Nit number 1"],
                         "important notes, then the kept nits")
        rules = merge.issue_rules()
        self.assertEqual(merge.finding_text(rules, "architecture", nit(1))["label"], "**architecture** · note · nit")
        self.assertEqual(merge.finding_text(rules, "product", self.note())["label"], "**product** · note", "an unweighted note is shown as before")
        self.assertEqual(merge.nits_dropped(cell, number), 2)
        head = json.loads((self.round / "decision.json").read_text())["head"]
        review = merge.findings_review(cell, rules, number, found, head)
        self.assertIn("2 more nits the reviewers listed were not kept", review["body"])
        text = change_record.render(cell.root, cell.info, TICKET, {"approved": head, "base": head}, rules)
        self.assertIn("- architecture, note, nit: **Nit number 1**", text)
        self.assertIn("- architecture, note, important: **Weak test for FR-02**", text)
        self.assertIn("- 2 more nits from architecture not kept (review.nit_cap).", text)


if __name__ == "__main__":
    unittest.main()
