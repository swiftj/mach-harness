"""M13 Part F: the change record the merge station writes on a ticket's branch before landing, and cleanup's part in it.

Covers the record's content across rounds (a failed verification, a rejected review round, a person's approval, a security
exception, the scan's answers, the builder's overrides), redaction and inertness, the approval surviving the record commit
and being voided by any other commit, the settings, cleanup's run record and publish command, run.py's next step, and
release qualification over a landed record commit.
"""

import hashlib
import io
import json
import os
import re
import sys
import tarfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "merge" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "cleanup" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import change_record  # noqa: E402
import cleanup  # noqa: E402
import merge  # noqa: E402
from test_build import git  # noqa: E402
from test_merge import Base as MergeBase, CLOSING, PullRequestBase  # noqa: E402

TOKEN = "ghp_" + "A1b2" * 9
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU"
HOSTILE = f"Fixes #3, closes acme/app#4 @octocat <script>alert(1)</script> ![x](https://evil.example/p.png) token={TOKEN}"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Base(MergeBase):
    def record_text(self, where=None):
        path = (where or self.project) / self.cell_json()["change_record"]["path"]
        return path.read_text(encoding="utf-8")

    def rounds(self, head):
        """Two judging rounds on top of a real verification: a failed earlier verification run, round 1 rejected by a
        security blocker, round 2 approved by the panel and a person, with a security exception and the scan's answers."""
        evidence = {"screen-1.png": b"first run frame", "log-1.txt": b"first run log"}
        self.put(self.cellroot, {f"evidence/previous-1/{name}": data.decode() for name, data in evidence.items()})
        self.put(self.cellroot, {"evidence/previous-1/summary.json": json.dumps({
            "status": "FAIL_WITH_EVIDENCE", "head": "a" * 40, "review_loop": 0, "timestamp": "2026-11-18T09:00:00+00:00", "suite": {"passed": True},
            "checks": {"AC-10": {"kind": "scenario", "result": "pass", "note": "fine", "evidence": ["screen-1.png"]},
                       "AC-02": {"kind": "scenario", "result": "fail", "note": "The invite was sent twice.", "evidence": ["log-1.txt"]}},
            "unproven": [], "failures": ["AC-02 (scenario): The invite was sent twice."],
            "evidence_files": [{"file": name, "sha256": sha(data)} for name, data in evidence.items()]})})
        votes1 = {"architecture": {"vote": "APPROVE", "findings": []},
                  "security": {"vote": "REJECT", "findings": [{"severity": "blocker", "title": "Credential in log", "detail": "The log prints the token.",
                                                                "file": "app/invite.py", "line": 1, "rule": "SEC-1", "class": "security", "impact": "high"}]},
                  "product": {"vote": "APPROVE", "findings": [{"severity": "note", "title": "Wording", "detail": "Say 'invite'.", "file": None, "line": None, "rule": None}]}}
        votes2 = {"architecture": {"vote": "APPROVE", "findings": []},
                  "security": {"vote": "REJECT", "findings": [{"severity": "blocker", "title": "Rate limit missing", "detail": "No limit on invites.",
                                                                "file": "app/invite.py", "line": 2, "rule": "SEC-2", "class": "security", "impact": "high"}]},
                  "product": {"vote": "APPROVE", "findings": []}}
        round1 = {"round": 1, "risk": "Medium", "outcome": "REJECTED", "approvals": 2, "approvals_needed": 2, "head": "b" * 40,
                  "decided_at": "2026-11-18T10:00:00+00:00", "votes": {k: v["vote"] for k, v in votes1.items()}}
        round2 = {"round": 2, "risk": "Medium", "outcome": "APPROVED", "approvals": 3, "approvals_needed": 2, "head": head,
                  "decided_at": "2026-11-19T10:00:00+00:00", "votes": {k: v["vote"] for k, v in votes2.items()},
                  "human_approval": {"by": "Engineer", "note": "Looks right.", "recorded_at": "2026-11-19T11:00:00+00:00"},
                  "human_approval_required": True,
                  "exceptions": [{"round": "2", "seat": "security", "index": 1, "title": "Rate limit missing", "head": head, "by": "Security lead",
                                  "reason": "A gateway limits invites for now.", "expires": "2099-01-01", "recorded_at": "2026-11-19T10:30:00+00:00"}],
                  "approvals_before_exception": 2, "approvals_after_exception": 3,
                  "security_scan": {"enabled": True, "secrets": [{"id": "s1", "file": "app/invite.py", "line": 3, "kind": "github-token", "preview": "ghp_****",
                                                                  "answer": "not_a_secret", "reason": "A test fixture."}],
                                    "dependencies": [{"id": "d1", "ecosystem": "pypi", "name": "requests", "version": "2.32.0", "change": "added", "dev": False,
                                                      "answer": "acceptable", "reason": "Widely used."}]}}
        files = {"review/round-1/decision.json": json.dumps(round1), "review/round-2/decision.json": json.dumps(round2),
                 "review/decision.json": json.dumps({**round2, "blockers": 1})}
        files.update({f"review/round-1/votes/{seat}.json": json.dumps({"reviewer": seat, **vote}) for seat, vote in votes1.items()})
        files.update({f"review/round-2/votes/{seat}.json": json.dumps({"reviewer": seat, **vote}) for seat, vote in votes2.items()})
        self.put(self.cellroot, files)
        report = json.loads((self.cellroot / "build-report.json").read_text())
        report["deviations"] = [{"type": "files-outside-plan", "task": "T02", "detail": "README.md: the docs mention the command."}]
        report["review_loop"] = 1
        (self.cellroot / "build-report.json").write_text(json.dumps(report))


class ContentTest(Base):
    def test_the_record_covers_every_round_and_lands_with_the_change(self):
        head = self.approved(mode="auto")
        self.rounds(head)
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        text = self.record_text()
        self.assertEqual(sha(text.encode()), done["change_record"]["sha256"])
        for expected in (
            "# Change record: LOCAL-001",
            "- Title: Invite a teammate by email",
            "## Why",
            "### Run 1 of 2: FAIL_WITH_EVIDENCE",
            "### Run 2 of 2: PASS",
            f"- AC-02 (scenario): fail. The invite was sent twice. Evidence: evidence/previous-1/log-1.txt (SHA-256 `{sha(b'first run log')}`).",
            f"evidence/previous-1/screen-1.png (SHA-256 `{sha(b'first run frame')}`)",
            "### Round 1: REJECTED",
            "- security, blocker, security, high impact: **Credential in log** The log prints the token. Cites: SEC-1. File: app/invite.py:1.",
            "- product, note: **Wording**",
            "### Round 2: APPROVED",
            f"reviewed commit `{head}`",
            "Approved by a person: Engineer, recorded 2026-11-19T11:00:00+00:00. Their note: \"Looks right.\"",
            "Risk tier Medium; 3 approvals, 2 needed; reviewed commit",
            "- 2/security/1: **Rate limit missing**, by Security lead at 2026-11-19T10:30:00+00:00",
            "until 2099-01-01: \"A gateway limits invites for now.\"",
            "- Approvals before the exception: 2; after: 3.",
            "- Possible secret (github-token) at app/invite.py:3: answered not_a_secret, \"A test fixture.\".",
            "- Dependency pypi requests 2.32.0 (added): answered acceptable, \"Widely used.\".",
            "- T02, files-outside-plan: README.md: the docs mention the command.",
            f"- Approved by review: `{head}`",
            f"- This record was added on top of: `{head}`",
        ):
            self.assertIn(expected, text)
        # Checks in natural order (AC-02 before AC-10), every check of the current run with its evidence's hash.
        self.assertLess(text.index("- AC-02 (scenario)"), text.index("- AC-10 (scenario)"))
        current = json.loads((self.cellroot / "evidence/summary.json").read_text())
        for entry in current["evidence_files"]:
            self.assertIn(f"evidence/{entry['file']} (SHA-256 `{entry['sha256']}`)", text)
        self.assertNotIn("ghp_****", text, "the scan's previews are never copied")
        self.assertIn("- T01 [test]", text)

    def test_the_same_inputs_give_the_same_text(self):
        head = self.approved(mode="auto")
        self.rounds(head)
        cell = merge.Cell(self.project, "LOCAL-001")
        commits = {"approved": head, "base": head}
        first = change_record.render(cell.root, cell.info, "LOCAL-001", commits, merge.issue_rules())
        cell.info["updated_at"] = "2030-01-01T00:00:00+00:00"
        self.assertEqual(first, change_record.render(cell.root, cell.info, "LOCAL-001", commits, merge.issue_rules()))
        self.assertNotIn("2030-01-01", first, "no clock time but the stations' own")

    def test_long_text_is_cut_with_a_plain_note(self):
        self.approved(mode="auto")
        self.put(self.cellroot, {"intent.md": "# Intent\n\n" + ("A reason. " * 1200)})
        self.m_ok("run", "LOCAL-001")
        text = self.record_text()
        self.assertIn(f"> (Cut at {change_record.INTENT_LIMIT} characters; the ticket's archive holds the full text when one is kept.)", text)
        self.assertLess(len(text), 20000)

    def test_the_record_says_what_is_true_of_the_evidence_whatever_cleanup_decides(self):
        """Written at merge, before cleanup decides whether the archive is kept: it names each file by its SHA-256 and says
        when the files are kept, never that they are."""
        head = self.approved(mode="auto")
        self.rounds(head)
        self.m_ok("run", "LOCAL-001")
        text = self.record_text()
        opening = text.split("\n\n")[1]
        self.assertTrue(opening.endswith(
            "Each evidence file is named here with its SHA-256. The files themselves are kept after cleanup, in the project's local archive "
            "(`.factory/archive/`), only when the project keeps archives or a person decided something on this ticket; a file that was kept "
            "can be checked against its hash here."), opening)
        self.assertNotIn("are kept in the project's local archive", text)
        self.assertNotIn("so the archive can be checked", text)
        cell = merge.Cell(self.project, "LOCAL-001")
        commits = {"approved": head, "base": head}
        self.assertEqual(change_record.render(cell.root, cell.info, "LOCAL-001", commits, merge.issue_rules()),
                         change_record.render(cell.root, cell.info, "LOCAL-001", commits, merge.issue_rules()), "the same inputs give the same text")
        facts = change_record.read_facts(text)
        self.assertEqual(sorted(facts), sorted(change_record.read_facts(text)), "the facts block keeps its shape")
        self.assertTrue(text.rstrip().endswith("```"), "the facts are still the record's last section")


class InertTest(Base):
    def test_the_record_ends_with_the_facts_release_qualification_reads(self):
        head = self.approved(mode="auto")
        self.rounds(head)
        self.set_cell(contracts=["proto/invite.yaml"], product={"slice_id": "SLICE-007", "revision": 3, "epic_id": "EPIC-002", "depends_on": ["SLICE-010", "SLICE-002"],
                                                                "issue": {"repository": "acme/app", "number": 41}})
        done = self.m_ok("run", "LOCAL-001")
        text = self.record_text()
        facts = change_record.read_facts(text)
        self.assertEqual(done["change_record"]["sha256"], sha(text.encode()))
        self.assertEqual(self.cell_json()["change_record"]["version"], 2)
        self.assertTrue(text.rstrip().endswith("```"), "the facts are the record's last section")
        spec_path = self.cell_json()["spec_path"]
        self.assertEqual(facts["spec"], {"path": spec_path, "sha256": sha(git(self.project, "show", f"{head}:{spec_path}").stdout.encode())})
        self.assertEqual((facts["version"], facts["ticket_id"], facts["slice_id"], facts["revision"], facts["epic_id"], facts["issue"]),
                         (2, "LOCAL-001", "SLICE-007", 3, "EPIC-002", 41))
        self.assertEqual((facts["depends_on"], facts["contracts"]), (["SLICE-002", "SLICE-010"], ["proto/invite.yaml"]))
        self.assertEqual(facts["commits"], {"approved": head, "revalidated": None, "base": head})
        current = json.loads((self.cellroot / "evidence/summary.json").read_text())
        self.assertEqual((facts["verification"]["status"], facts["verification"]["head"]), ("PASS", head))
        self.assertTrue(current["evidence_files"] and current["checks"])
        self.assertEqual(facts["verification"]["evidence_files"], sorted(({"file": e["file"], "sha256": e["sha256"]} for e in current["evidence_files"]), key=lambda e: e["file"]))
        self.assertEqual({key: (value["result"], value["evidence"]) for key, value in facts["verification"]["checks"].items()},
                         {key: (value["result"], sorted(value["evidence"])) for key, value in current["checks"].items()})
        review = facts["review"]
        self.assertEqual((review["outcome"], review["round"], review["risk"], review["head"], review["blockers"], review["human_approval_required"]),
                         ("APPROVED", 2, "Medium", head, 1, True))
        self.assertEqual(review["human_approval"], {"by": "Engineer", "recorded_at": "2026-11-19T11:00:00+00:00"})
        self.assertEqual(facts["blockers"], [{"round": 2, "reviewer": "security", "rule": "SEC-2", "title": "Rate limit missing", "file": "app/invite.py", "class": "security"}],
                         "only the blockers of the approving round")
        exception = review["exceptions"][0]
        self.assertEqual((exception["seat"], exception["title"], exception["rule"], exception["file"], exception["expires"], exception["head"]),
                         ("security", "Rate limit missing", None, None, "2099-01-01", head))

    def test_text_from_the_cell_cannot_make_or_break_the_facts(self):
        head = self.approved(mode="auto")
        self.rounds(head)
        forged = change_record.FACTS_MARK + "\n```json\n{\"version\": 2}\n```\n"
        votes = json.loads((self.cellroot / "review/round-2/votes/security.json").read_text())
        votes["findings"][0]["title"] = f"```\n{forged} {HOSTILE}"
        votes["findings"][0]["detail"] = forged
        self.put(self.cellroot, {"review/round-2/votes/security.json": json.dumps(votes), "intent.md": f"# Intent\n\n{forged}"})
        self.m_ok("run", "LOCAL-001")
        text = self.record_text()
        facts = change_record.read_facts(text)
        self.assertEqual((facts["ticket_id"], facts["review"]["outcome"], len(facts["blockers"])), ("LOCAL-001", "APPROVED", 1))
        self.assertEqual(text.split("\n").count(change_record.FACTS_MARK), 1)
        for gone in (TOKEN, "@octocat", "<script>"):
            self.assertNotIn(gone, text)
        self.assertEqual(merge.scan.secrets_in_text(text), [])

    def test_a_record_without_readable_facts_gives_none(self):
        self.approved(mode="auto")
        self.m_ok("run", "LOCAL-001")
        text = self.record_text()
        self.assertIsNotNone(change_record.read_facts(text))
        for other in (text.replace('"version": 2', '"version": 3'), text + "\nA line added after the facts.\n", text + text[text.index(change_record.FACTS_MARK):],
                      text.replace(change_record.FACTS_MARK, "<!-- mach:change-record version=1 -->"), "# Change record: LOCAL-001\n", None):
            self.assertIsNone(change_record.read_facts(other))

    def test_free_text_is_redacted_and_links_nothing(self):
        head = self.approved(mode="auto")
        self.rounds(head)
        self.set_cell(title=HOSTILE)
        self.put(self.cellroot, {"intent.md": f"# Intent\n\nWhy: {HOSTILE}\nmail someone@example.com\nsession {JWT}\n"})
        votes = json.loads((self.cellroot / "review/round-1/votes/product.json").read_text())
        votes["findings"][0]["detail"] = HOSTILE
        self.put(self.cellroot, {"review/round-1/votes/product.json": json.dumps(votes)})
        self.m_ok("run", "LOCAL-001")
        text = self.record_text()
        for gone in (TOKEN, JWT, "someone@example.com", "@octocat", "<script>", "](https://evil", "acme/app#4"):
            self.assertNotIn(gone, text)
        self.assertIsNone(CLOSING.search(text), "no closing keyword reaches an issue")
        self.assertIn("@​octocat", text)
        self.assertIn("Fixes", text, "the words stay readable; only references are broken")
        self.assertEqual(self.import_scan().secrets_in_text(text), [], "nothing shaped like a secret is left")

    def import_scan(self):
        return merge.scan

    def test_a_secret_the_masking_cannot_remove_refuses_the_record_and_nothing_lands(self):
        self.approved(mode="auto")

        class Stubborn:
            @staticmethod
            def secrets_in_line(path, line):
                return ([("jwt", "")] if line.startswith("# Change record") else []), []

        with self.assertRaises(change_record.RecordError):
            change_record.mask("# Change record: X\nrest\n", "docs/changes/X.md", Stubborn)
        with mock.patch.object(merge, "scan", Stubborn):
            refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("shaped like a secret", refusal)
        self.assertEqual(self.main_log(), ["work"])
        self.assertNotIn("change_record", self.cell_json())
        self.assertEqual(git(self.work, "status", "--porcelain").stdout, "", "nothing written to the branch")

    def test_without_the_shared_helpers_nothing_is_written_or_merged(self):
        self.approved(mode="auto")
        with mock.patch.object(merge, "scan", None):
            self.assertIn("scan.py could not be loaded", self.m_refused("run", "LOCAL-001"))
        with mock.patch.object(merge, "issue_rules", lambda: None):
            self.assertIn("issue_rules.py) could not be loaded", self.m_refused("run", "LOCAL-001"))
        self.assertEqual(self.main_log(), ["work"])


PACK_DIGEST = "3f9a1c2b4d5e" + "6f" * 26
PRINCIPLES_SHA = "ab" * 32
MAIN_COMMIT = "c" * 40


class ProductRulesTest(Base):
    """M15: the principles the spec answered, the policy packs with their digests and each concern's resolution, and the
    spec's effects on shipped behaviour: from spec.json and cell.json only, and absent when the spec has no such section."""

    def answered(self, hostile=""):
        spec = json.loads((self.cellroot / "spec.json").read_text())
        spec["principles"] = [
            {"id": "PP-10", "revision": 1, "statement": "Never surprise an admin.", "answer": "does_not_apply", "upheld_by": [], "reason": "No admin sees this."},
            {"id": "PP-02", "revision": 3, "statement": "Every invite can be undone.", "answer": "applies", "upheld_by": ["INV-02", "AC-01"], "reason": None},
            {"id": "PP-03", "revision": 2, "statement": "Ask once.", "answer": "exception", "upheld_by": [], "reason": "Launch needs it. " + hostile}]
        spec["policies"] = [
            {"pack": "POL-privacy", "sha256": PACK_DIGEST[:12], "answer": "concerns", "concerns": [
                {"statement_id": "POL-privacy-2", "statement": "Personal data is kept 30 days at most.", "why": "Invites are kept for the audit.",
                 "owner": "Data protection officer (@dana)", "resolution": "accepted", "by": "dana (checked against the pack's owner)", "on": "2026-11-18",
                 "words": "Audit needs a year; reviewed with legal. " + hostile, "owner_check": "checked against the pack's owner"},
                {"statement_id": "POL-privacy-3", "statement": "No tracking.", "why": "A pixel counts opens.", "owner": "Data protection officer (@dana)",
                 "resolution": "spec_changed"}]},
            {"pack": "POL-access", "sha256": "0123456789ab", "answer": "followed", "concerns": []}]
        spec["effects"] = [
            {"shipped_rule": "SLICE-003/FR-10", "slice_id": "SLICE-003", "rule_id": "FR-10", "effect": "retired", "in_slice": None, "note": "Nobody uses it."},
            {"shipped_rule": "SLICE-003/FR-02", "slice_id": "SLICE-003", "rule_id": "FR-02", "effect": "changed", "in_slice": "FR-01", "note": ""},
            {"shipped_rule": "SLICE-002/INV-01", "slice_id": "SLICE-002", "rule_id": "INV-01", "effect": "kept", "in_slice": "AC-02", "note": ""}]
        self.put(self.cellroot, {"spec.json": json.dumps(spec)})
        self.set_cell(principles={"source": "folder", "revision": 4, "sha256": PRINCIPLES_SHA, "read_at": "2026-11-17T09:00:00+00:00"},
                      policies={"commit": MAIN_COMMIT, "dir": "policies", "checked_against_packs": True, "checked_at": "2026-11-17T09:00:00+00:00",
                                "packs": [{"id": "POL-privacy", "sha256": PACK_DIGEST[:12], "answer": "concerns", "copy": "policies/POL-privacy.md",
                                           "matches_main": True, "digest": PACK_DIGEST}]},
                      shipped={"commit": MAIN_COMMIT, "branch": "main", "rules": 3, "checked_at": "2026-11-17T09:00:00+00:00"})

    def render(self):
        cell = merge.Cell(self.project, "LOCAL-001")
        return change_record.render(cell.root, cell.info, "LOCAL-001", {"approved": "d" * 40, "base": "d" * 40}, merge.issue_rules())

    def test_the_three_sections_land_with_the_change(self):
        self.approved(mode="auto")
        self.answered()
        self.m_ok("run", "LOCAL-001")
        text = self.record_text()
        for expected in (
            "## Product principles",
            f"Answered against the published principles, revision 4 (SHA-256 `{PRINCIPLES_SHA}`).",
            "- PP-02 (revision 3) \"Every invite can be undone.\": applies, upheld by AC-01, INV-02.",
            "- PP-03 (revision 2) \"Ask once.\": an exception, the product manager's decision: \"Launch needs it.\"",
            "- PP-10 (revision 1) \"Never surprise an admin.\": does not apply: No admin sees this.",
            "## Policy packs",
            f"Packs read at commit `{MAIN_COMMIT}`.",
            "- POL-access (digest `0123456789ab`): followed.",
            f"- POL-privacy (digest `{PACK_DIGEST[:12]}`, SHA-256 `{PACK_DIGEST}`): concerns.",
            "  - POL-privacy-2 \"Personal data is kept 30 days at most.\" cannot be met: Invites are kept for the audit. Owner: Data protection officer (@\u200bdana). "
            "Accepted by dana (checked against the pack's owner) on 2026-11-18: \"Audit needs a year; reviewed with legal.\"",
            "  - POL-privacy-3 \"No tracking.\" cannot be met: A pixel counts opens. Owner: Data protection officer (@\u200bdana). Resolved by changing the spec.",
            "this guards against accident, not forgery.",
            "## Effects on shipped behaviour",
            f"Shipped rules read at commit `{MAIN_COMMIT}`.",
            "- SLICE-002/INV-01: kept, proven again by AC-02.",
            "- SLICE-003/FR-02: changed, by FR-01 in this slice.",
            "- SLICE-003/FR-10: retired. Note: \"Nobody uses it.\"",
        ):
            self.assertIn(expected, text)
        # Sorted by ID, and placed after the why and before the plan.
        self.assertLess(text.index("- PP-02"), text.index("- PP-03"))
        self.assertLess(text.index("- PP-03"), text.index("- PP-10"))
        self.assertLess(text.index("## Why"), text.index("## Product principles"))
        self.assertLess(text.index("## Product principles"), text.index("## Policy packs"))
        self.assertLess(text.index("## Policy packs"), text.index("## Effects on shipped behaviour"))
        self.assertLess(text.index("## Effects on shipped behaviour"), text.index("## Plan"))

    def test_a_spec_without_the_sections_gives_exactly_the_record_it_gave_before(self):
        self.approved(mode="auto")
        spec = json.loads((self.cellroot / "spec.json").read_text())
        self.assertEqual(spec.pop("effects"), [], "the fixture's spec says 'None.' for effects, a section the record shows")
        self.assertFalse({"principles", "policies"} & set(spec))
        self.put(self.cellroot, {"spec.json": json.dumps(spec)})
        before = self.render()
        (self.cellroot / "spec.json").unlink()
        self.assertEqual(before, self.render(), "spec.json without the sections adds nothing")
        for heading in ("## Product principles", "## Policy packs", "## Effects on shipped behaviour"):
            self.assertNotIn(heading, before)
        # cell.json's own records alone never make a section appear: the spec decides.
        self.set_cell(principles={"source": "folder", "revision": 4, "sha256": PRINCIPLES_SHA}, shipped={"commit": MAIN_COMMIT},
                      policies={"commit": MAIN_COMMIT, "packs": []})
        self.assertEqual(before, self.render())

    def test_a_principle_the_slice_predates_is_one_line_after_the_answers(self):
        """M21: a Not assessed row (a project brought in from another repository) is listed as written, never as an answer."""
        self.approved(mode="auto")
        self.answered()
        spec = json.loads((self.cellroot / "spec.json").read_text())
        reason = "This slice came with the project lending, brought in here on 2026-11-20, which did not have PP-11."
        spec["principles_not_assessed"] = [{"id": "PP-11", "revision": 1, "statement": "A loan MUST NOT be changed after signing.",
                                            "reason": reason, "how": "slice_came", "project": "lending", "day": "2026-11-20"}]
        self.put(self.cellroot, {"spec.json": json.dumps(spec)})
        text = self.render()
        self.assertIn(f"- PP-11 (revision 1) \"A loan MUST NOT be changed after signing.\": not assessed: {reason}", text)
        self.assertLess(text.index("- PP-10"), text.index("- PP-11"))
        spec["principles"] = []  # only Not assessed rows: listed, never "None."
        self.put(self.cellroot, {"spec.json": json.dumps(spec)})
        text = self.render()
        self.assertIn("- PP-11 (revision 1)", text)
        self.assertNotIn("## Product principles\n\nAnswered against the published principles, revision 4 (SHA-256 "
                         f"`{PRINCIPLES_SHA}`).\n\n- None.", text)

    def test_none_answers_and_unknown_checks_are_said_plainly(self):
        self.approved(mode="auto")
        self.answered()
        spec = json.loads((self.cellroot / "spec.json").read_text())
        spec["effects"] = []
        spec["principles"] = []
        concern = spec["policies"][0]["concerns"][0]
        concern.pop("owner_check")
        concern["by"] = "Dana"  # a resolution line written by hand carries no check
        spec["policies"][0]["concerns"].append({"statement_id": "POL-privacy-4", "statement": "Ask first.", "why": "Not yet.", "owner": "Data protection officer (@dana)",
                                                "resolution": "open"})
        self.put(self.cellroot, {"spec.json": json.dumps(spec)})
        self.set_cell(policies={"commit": MAIN_COMMIT, "packs": [{"id": "POL-privacy", "matches_main": False, "digest": None}]})
        text = self.render()
        self.assertIn("## Effects on shipped behaviour\n\nShipped rules read at commit", text)
        self.assertIn("- None: this slice changes no shipped behaviour.", text)
        self.assertIn("## Product principles\n\nAnswered against the published principles, revision 4", text)
        self.assertIn("Accepted by Dana (how the name was checked is not recorded) on 2026-11-18", text)
        self.assertIn("  - POL-privacy-4 \"Ask first.\" cannot be met: Not yet. Owner: Data protection officer (@\u200bdana). Still open.", text)
        self.assertIn(f"- POL-privacy (digest `{PACK_DIGEST[:12]}`): concerns.", text, "no full digest unless the kept copy matched main")

    def test_free_text_in_the_sections_is_inert_redacted_and_deterministic(self):
        self.approved(mode="auto")
        self.answered(hostile=HOSTILE)
        first = self.render()
        self.set_cell(updated_at="2030-01-01T00:00:00+00:00")
        self.assertEqual(first, self.render())
        section = first[first.index("## Product principles"):first.index("## Plan")]
        for gone in (TOKEN, "@octocat", "<script>", "](https://evil", "acme/app#4"):
            self.assertNotIn(gone, section)
        self.assertIsNone(CLOSING.search(section))
        self.assertIn("@\u200boctocat", section)



class SmallChangeTest(Base):
    """M18: the record and the pull request say "small change" beside the ticket, read from cell.json; when it became a full
    slice, that it began as one and the rule's fixed sentence, never the person's own words. Every other ticket is as before."""

    SENTENCE = "This is not a small change: a small change is Low or Medium risk, and this one is High."

    def texts(self):
        cell = merge.Cell(self.project, "LOCAL-001")
        record = change_record.render(cell.root, cell.info, "LOCAL-001", {"approved": "d" * 40, "base": "d" * 40}, merge.issue_rules())
        return record, merge.pr_title(cell), merge.pr_body(cell)

    def test_a_ticket_that_is_not_small_is_exactly_as_before(self):
        self.approved(mode="auto")
        before = self.texts()
        self.set_cell(kind=None)  # a kind that is not small says nothing
        self.assertEqual(self.texts(), before)
        self.assertNotIn("small change", "\n".join(before).lower())

    def test_a_small_change_is_said_beside_the_ticket(self):
        self.approved(mode="auto")
        record, title, body = self.before_and_after(kind="small", small={"from": "engineer"})
        self.assertIn("- Ticket: LOCAL-001, a small change\n", record)
        self.assertTrue(title.startswith("LOCAL-001 (small change): "), title)
        self.assertIn("**Ticket:** LOCAL-001, a small change  \n", body)

    def test_one_that_became_a_full_slice_says_so_with_the_rules_sentence(self):
        self.approved(mode="auto")
        record, title, body = self.before_and_after(kind="small", small={"from": "engineer"},
                                                    widened={"at": "2026-11-22T10:00:00Z", "reason": self.SENTENCE, "rule": "risk", "by": "finalize"})
        words = "a full slice that began as a small change. " + self.SENTENCE
        self.assertIn(f"- Ticket: LOCAL-001, {words}\n", record)
        self.assertIn(f"**Ticket:** LOCAL-001, {words}  \n", body)
        self.assertNotIn("small change", title, "a full slice's title is a full slice's")

    def test_a_persons_words_for_the_widening_are_never_repeated(self):
        self.approved(mode="auto")
        record, _, body = self.before_and_after(kind="small", small={"from": "engineer"},
                                                widened={"at": "2026-11-22T10:00:00Z", "reason": "It also changes the reminder email.", "rule": None, "by": "engineer"})
        for text in (record, body):
            self.assertIn("a full slice that began as a small change, made a full slice on a person's word", text)
            self.assertNotIn("reminder", text)

    def before_and_after(self, **cell):
        before = self.texts()
        self.set_cell(**cell)
        after = self.texts()
        for old, new in zip(before, after):
            self.assertNotIn("light path", new.lower())
            self.assertNotRegex(new, r"\bkind\b")
            # Only the line beside the ticket (and the title) changes.
            changed = [line for line in new.splitlines() if line not in old.splitlines()]
            self.assertLessEqual(len(changed), 1, changed)
        return after

class ApprovalBindingTest(PullRequestBase):
    def open_pr(self):
        head = self.approved(mode="auto", method="pr")
        with mock.patch.dict(os.environ, {"FAKE_GH_BLOCK": "1"}):
            code, out, _ = self.m("run", "LOCAL-001")
        self.assertEqual(code, 3, out)
        return head, self.cell_json()["change_record"]

    def test_the_record_commit_keeps_the_approval_across_runs(self):
        head, record = self.open_pr()
        plan = self.m_ok("plan", "LOCAL-001")
        self.assertEqual((plan["approval_valid"], plan["record_commit"], plan["allowed"]), (False, True, True))
        self.assertNotIn("change record", " ".join(plan["would"]), "not written twice")
        self.assertEqual(self.next()["action"], "merge")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["status"], done["change_record"]["written"], done["change_record"]["commit"]), ("MERGED", False, record["commit"]))
        merged = [call for call in self.calls() if call[:2] == ["pr", "merge"]]
        self.assertEqual({call[call.index("--match-head-commit") + 1] for call in merged}, {record["commit"]})
        self.assertEqual(git(self.work, "log", "--format=%s", f"{head}..HEAD").stdout.splitlines(), ["Change record for LOCAL-001"])

    def test_any_other_commit_after_the_record_voids_the_approval(self):
        self.open_pr()
        self.put(self.work, {"app/extra.py": "LATER = True\n"})
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "added after the record")
        self.assertTrue(self.m_ok("plan", "LOCAL-001")["approval_void"])
        self.assertIn("something was added after review", self.m_refused("run", "LOCAL-001"))
        self.assertEqual((self.cell_json()["stage"], self.cell_json()["review"]), ("built", "VOID"))

    def test_a_record_commit_that_changes_another_file_is_not_the_stations(self):
        head = self.approved(mode="auto")
        self.put(self.work, {"docs/changes/LOCAL-001.md": "# hand made\n", "app/extra.py": "SNEAKY = True\n"})
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "Change record for LOCAL-001")
        tip = git(self.work, "rev-parse", "HEAD").stdout.strip()
        self.set_cell(change_record={"path": "docs/changes/LOCAL-001.md", "commit": tip, "parent": head, "sha256": "0" * 64})
        plan = self.m_ok("plan", "LOCAL-001")
        self.assertEqual((plan["record_commit"], plan.get("approval_void")), (False, True))
        self.assertEqual(self.next()["reason"], "The branch changed after it was approved; the merge station will void the approval and return it to verification.")

    def test_a_record_commit_on_another_base_or_not_on_record_is_not_the_stations(self):
        head = self.approved(mode="auto")
        self.put(self.work, {"docs/changes/LOCAL-001.md": "# hand made\n"})
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "a record nobody recorded")
        tip = git(self.work, "rev-parse", "HEAD").stdout.strip()
        self.assertTrue(self.m_ok("plan", "LOCAL-001")["approval_void"], "cell.json names no record commit")
        self.set_cell(change_record={"path": "docs/changes/LOCAL-001.md", "commit": tip, "parent": "c" * 40, "sha256": "0" * 64})
        self.assertTrue(self.m_ok("plan", "LOCAL-001")["approval_void"], "its parent is not the approved commit")
        self.set_cell(change_record={"path": "docs/changes/LOCAL-001.md", "commit": tip, "parent": head, "sha256": "0" * 64})
        self.assertFalse(self.m_ok("plan", "LOCAL-001").get("approval_void"), "exactly the record, on the approved commit")

    def test_the_line_routes_an_approved_ticket_with_its_record_to_merge_not_to_voiding(self):
        """A local merge that failed after the record commit leaves the cell approved with the record on its branch."""
        head = self.approved(mode="auto")
        merge.write_record(merge.Cell(self.project, "LOCAL-001"), None)
        self.assertNotEqual(git(self.work, "rev-parse", "HEAD").stdout.strip(), head)
        step = self.next()
        self.assertEqual((step["action"], step["reason"]), ("merge", "Approved; the project's settings let the line merge it."))
        self.assertEqual(self.m_ok("run", "LOCAL-001")["status"], "MERGED")

    def test_the_pull_request_links_the_record_at_the_commit_that_added_it(self):
        self.approved(mode="auto", method="pr")
        address = "https://github.com/acme/app.git"
        git(self.project, "config", f"url.{self.origin}.insteadOf", address)
        git(self.project, "remote", "set-url", "origin", address)
        self.m_ok("run", "LOCAL-001")
        record = self.cell_json()["change_record"]
        created = next(call for call in self.calls() if call[:2] == ["pr", "create"])
        body = created[created.index("--body") + 1]
        self.assertIn(f"Change record: [`docs/changes/LOCAL-001.md`](https://github.com/acme/app/blob/{record['commit']}/docs/changes/LOCAL-001.md)", body)


class SettingsTest(PullRequestBase):
    def test_records_off_writes_nothing_and_the_pull_request_says_nothing(self):
        head = self.approved(mode="auto", method="pr")
        config = json.loads((self.project / ".factory/config.json").read_text())
        (self.project / ".factory/config.json").write_text(json.dumps({**config, "records": {"enabled": False}}))
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual((done["landed_commit"], done["change_record"]["written"]), (head, False))
        self.assertNotIn("change_record", self.cell_json())
        created = next(call for call in self.calls() if call[:2] == ["pr", "create"])
        self.assertNotIn("Change record", created[created.index("--body") + 1])
        self.assertFalse((self.work / "docs/changes").exists())

    def configure(self, records, **rest):
        if not (self.cellroot / "review/decision.json").is_file():
            self.approved(mode="auto")
        (self.project / ".factory/config.json").write_text(json.dumps({"merge": {"mode": "auto"}, "records": records, **rest}))

    def test_another_folder_is_used(self):
        self.configure({"dir": "history/changes/"})
        self.assertEqual(self.m_ok("run", "LOCAL-001")["change_record"]["path"], "history/changes/LOCAL-001.md")
        self.assertTrue((self.project / "history/changes/LOCAL-001.md").is_file())

    def test_an_unusable_folder_or_one_among_the_adrs_refuses_the_merge(self):
        for value in ("../outside", ".factory/changes", "/abs", "docs/ch anges", 7):
            self.configure({"dir": value})
            self.assertIn("is not a folder inside the repository", self.m_refused("run", "LOCAL-001"), value)
        for records, adr in (({"dir": "docs/adr/changes"}, {}), ({"dir": "decisions"}, {"dir": "decisions/adr"}), ({}, {"dir": "docs/changes"})):
            self.configure(records, adr=adr)
            self.assertIn("overlap", self.m_refused("run", "LOCAL-001"))
        self.assertEqual(self.main_log(), ["work"])
        self.configure({"enabled": False, "dir": "../outside"})
        self.assertEqual(self.m_ok("run", "LOCAL-001")["status"], "MERGED", "settings for records that are off are not read")

    def test_an_earlier_life_of_the_ticket_keeps_its_record(self):
        self.put(self.project, {"docs/changes/LOCAL-001.md": "# An earlier record\n"})
        self.commit_main()
        self.approved(mode="auto")
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["change_record"]["path"], "docs/changes/LOCAL-001-2.md")
        self.assertEqual((self.project / "docs/changes/LOCAL-001.md").read_text(), "# An earlier record\n")


PUBLISH = '''import pathlib, shutil, sys
archive, ticket, out = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
if ticket == "fail":
    sys.stderr.write("upload refused: token=abcdefabcdefabcdef\\n")
    sys.exit(4)
out.mkdir(parents=True, exist_ok=True)
shutil.copy(archive, out / pathlib.Path(archive).name)
'''


class CleanupTest(Base):
    def merged(self, publish=None):
        self.approved(mode="auto")
        if publish is not None:
            config = json.loads((self.project / ".factory/config.json").read_text())
            (self.project / ".factory/config.json").write_text(json.dumps({**config, "records": {"publish_command": publish}}))
        self.m_ok("run", "LOCAL-001")
        return self.cell_json()["change_record"]

    def clean(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cleanup.main(["--project", str(self.project), "run", "LOCAL-001"])
        self.assertEqual(code, 0, err.getvalue() + out.getvalue())
        result = json.loads(out.getvalue())
        self.assertEqual(result["status"], "CLEANED")
        return result

    def script(self):
        path = Path(self.tmp.name) / "publish.py"
        path.write_text(PUBLISH)
        return path

    def test_the_run_record_names_the_record_and_its_hash(self):
        written = self.merged()
        self.clean()
        line = json.loads((self.project / ".factory/archive/runs.jsonl").read_text().splitlines()[-1])
        self.assertEqual(line["change_record"], {"path": "docs/changes/LOCAL-001.md", "sha256": written["sha256"], "commit": written["commit"]})
        self.assertEqual(sha((self.project / "docs/changes/LOCAL-001.md").read_bytes()), written["sha256"])
        self.assertEqual(line["record_version"], 2)
        self.assertEqual(line["integration"]["landed_commit"], written["commit"])
        self.assertNotIn("records_publish", line, "no publish command, no field")
        code, out, err = self.run_cmd("explain", "LOCAL-001", "--json")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["run_record"]["change_record"], "docs/changes/LOCAL-001.md", "explain names where the record landed")

    def test_the_archive_can_be_checked_against_the_record(self):
        self.merged()
        # A ticket merged by the line with no person's part keeps no archive by default (cleanup.archive "raised"); a project
        # that keeps every archive can check each kept file against the record.
        config = json.loads((self.project / ".factory/config.json").read_text())
        (self.project / ".factory/config.json").write_text(json.dumps({**config, "cleanup": {"archive": "all"}}))
        self.clean()
        text = (self.project / "docs/changes/LOCAL-001.md").read_text()
        with tarfile.open(str(self.project / ".factory/archive/LOCAL-001.tar.gz")) as tar:
            for member in tar.getmembers():
                if member.isfile() and "/evidence/" in member.name and not member.name.endswith(("summary.json", "results.json")):
                    digest = sha(tar.extractfile(member).read())
                    self.assertIn(f"`{digest}`", text, member.name)

    def test_the_publish_command_gets_the_archive(self):
        out = Path(self.tmp.name) / "published"
        self.merged([sys.executable, str(self.script()), "{archive}", "{ticket}", str(out)])
        result = self.clean()
        self.assertEqual(result["published"], {"ran": True, "ok": True, "exit_code": 0, "note": None})
        self.assertTrue((out / "LOCAL-001.tar.gz").is_file())
        line = json.loads((self.project / ".factory/archive/runs.jsonl").read_text().splitlines()[-1])
        self.assertEqual(line["records_publish"]["ok"], True)

    def test_a_failing_publish_command_never_blocks_cleanup(self):
        self.merged([sys.executable, str(self.script()), "{archive}", "fail", "unused"])
        result = self.clean()
        self.assertEqual((result["published"]["ok"], result["published"]["exit_code"]), (False, 4))
        self.assertIn("upload refused", result["published"]["note"])
        self.assertNotIn("abcdefabcdefabcdef", result["published"]["note"], "its output is redacted")
        self.assertFalse(self.cellroot.exists())
        line = json.loads((self.project / ".factory/archive/runs.jsonl").read_text().splitlines()[-1])
        self.assertEqual(line["records_publish"]["exit_code"], 4)

    def test_a_missing_or_malformed_publish_command_is_recorded_not_fatal(self):
        self.merged(["no-such-publisher-tool"])
        self.assertIn("not installed", self.clean()["published"]["note"])

    def test_a_malformed_publish_command_is_recorded(self):
        self.merged("upload {archive}")
        self.assertIn("must be a list of strings", self.clean()["published"]["note"])


try:
    import test_release_qualify  # noqa: E402
    ReleaseBase = test_release_qualify.Base
except Exception:  # noqa: BLE001
    ReleaseBase = None


if ReleaseBase is not None:
    class ReleaseTest(ReleaseBase):
        """Release qualification compares the contract and the verified commit with what review approved: a landed record
        commit, which adds only the record file, changes neither."""

        def test_a_landed_record_commit_leaves_the_release_qualified(self):
            commit = self.built(contract=("proto/api.yaml", "version: 1\n"))
            self.configure(integration_command=f"{sys.executable} check.py")
            self.scan(commit)
            data = self.readiness(self.release("qualify", "SLICE-001", "--release", "r1")["release_id"])
            checks = {c["id"]: c["status"] for c in data["checks"]}
            self.assertEqual(checks["contract.SLICE-001.proto/api.yaml"], "pass")
            self.assertEqual(checks["slice.SLICE-001.verification"], "pass")
            self.assertEqual(data["outcome"], "qualified")
            self.assertTrue((self.eng / "docs/changes/LOCAL-001.md").is_file())


if __name__ == "__main__":
    unittest.main()
