"""M21 piece B: the reference rewriter (skills/studio/scripts/project_ids.py), pure. Design: docs/mach-next/M21_EXPORT_IMPORT.md 4.3, 5."""

import copy
import json
import random
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "studio" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
import project_ids  # noqa: E402
from project_ids import ids_in_text, numbering, rename, rewrite_record, rewrite_record_noted, rewrite_text  # noqa: E402

SHA = "a" * 64
SHA2 = "b" * 64
TIME = "2026-11-24T10:00:00Z"

# The join of scenario 2, in small: every kind moves.
MAP = {"EPIC-001": "EPIC-004", "EPIC-002": "EPIC-005", "SLICE-001": "SLICE-013", "SLICE-002": "SLICE-014", "SLICE-011": "SLICE-015",
       "IDEA-001": "IDEA-002", "PP-01": "PP-04", "PP-02": "PP-05", "TN-01": "TN-03", "PRD-01": "PRD-02", "DES-01": "DES-03"}


class PatternsTest(unittest.TestCase):
    def test_fence_and_inline_code_patterns_are_the_validators(self):
        import validate_slice
        self.assertEqual(project_ids.FENCE_RE.pattern, validate_slice.FENCE_RE.pattern)
        self.assertEqual(project_ids.FENCE_RE.flags, validate_slice.FENCE_RE.flags)
        self.assertEqual(project_ids.INLINE_CODE_RE.pattern, validate_slice.INLINE_CODE_RE.pattern)
        self.assertEqual(project_ids.INLINE_CODE_RE.flags, validate_slice.INLINE_CODE_RE.flags)

    def test_prefixes_and_widths(self):
        self.assertEqual(project_ids.PREFIXES, {"SLICE": 3, "EPIC": 3, "IDEA": 3, "PP": 2, "TN": 2, "PRD": 2, "DES": 2})

    def test_standard_library_only_and_no_file_access(self):
        source = (ROOT / "skills" / "studio" / "scripts" / "project_ids.py").read_text(encoding="utf-8")
        import ast
        imported = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add((node.module or "").split(".")[0])
        self.assertEqual(imported, {"copy", "re", "typing"})
        for word in ("open(", "Path(", "os.", "subprocess", "urllib", "socket"):
            self.assertNotIn(word, source)


class NumberingTest(unittest.TestCase):
    def test_each_prefix_numbers_from_the_first_free_with_its_width(self):
        incoming = {"SLICE": ["SLICE-001"], "EPIC": ["EPIC-001"], "IDEA": ["IDEA-001"], "PP": ["PP-01"], "TN": ["TN-01"], "PRD": ["PRD-01"], "DES": ["DES-01"]}
        first = {"SLICE": 7, "EPIC": 7, "IDEA": 7, "PP": 7, "TN": 7, "PRD": 7, "DES": 7}
        self.assertEqual(numbering(incoming, first), {"SLICE-001": "SLICE-007", "EPIC-001": "EPIC-007", "IDEA-001": "IDEA-007", "PP-01": "PP-07",
                                                      "TN-01": "TN-07", "PRD-01": "PRD-07", "DES-01": "DES-07"})

    def test_numbers_widen_past_the_width(self):
        got = numbering({"SLICE": ["SLICE-001", "SLICE-002"], "EPIC": ["EPIC-005"], "IDEA": ["IDEA-001"], "PP": ["PP-01", "PP-02"], "TN": ["TN-01"],
                         "PRD": ["PRD-01"], "DES": ["DES-02"]},
                        {"SLICE": 999, "EPIC": 1000, "IDEA": 1234, "PP": 99, "TN": 100, "PRD": 100, "DES": 99})
        self.assertEqual(got, {"SLICE-001": "SLICE-999", "SLICE-002": "SLICE-1000", "EPIC-005": "EPIC-1000", "IDEA-001": "IDEA-1234",
                               "PP-01": "PP-99", "PP-02": "PP-100", "TN-01": "TN-100", "PRD-01": "PRD-100", "DES-02": "DES-99"})

    def test_order_is_by_number_not_by_text(self):
        got = numbering({"SLICE": ["SLICE-1000", "SLICE-999", "SLICE-010"], "PP": ["PP-100", "PP-99"]}, {"SLICE": 31, "PP": 4})
        self.assertEqual(got, {"SLICE-010": "SLICE-031", "SLICE-999": "SLICE-032", "SLICE-1000": "SLICE-033", "PP-99": "PP-04", "PP-100": "PP-05"})

    def test_gaps_in_the_incoming_numbers_are_closed(self):
        got = numbering({"SLICE": ["SLICE-001", "SLICE-007", "SLICE-003"]}, {"SLICE": 13})
        self.assertEqual(got, {"SLICE-001": "SLICE-013", "SLICE-003": "SLICE-014", "SLICE-007": "SLICE-015"})

    def test_none_keeps_every_id_and_its_gaps(self):
        got = numbering({"SLICE": ["SLICE-007", "SLICE-001"], "EPIC": ["EPIC-002"]}, {"SLICE": None, "EPIC": 4})
        self.assertEqual(got, {"SLICE-001": "SLICE-001", "SLICE-007": "SLICE-007", "EPIC-002": "EPIC-004"})

    def test_same_input_same_map_and_duplicates_once(self):
        incoming = {"SLICE": ("SLICE-002", "SLICE-001", "SLICE-002")}
        self.assertEqual(numbering(incoming, {"SLICE": 5}), numbering(incoming, {"SLICE": 5}))
        self.assertEqual(numbering(incoming, {"SLICE": 5}), {"SLICE-001": "SLICE-005", "SLICE-002": "SLICE-006"})

    def test_same_number_written_two_ways_both_get_numbers(self):
        self.assertEqual(numbering({"SLICE": ["SLICE-0001", "SLICE-001"]}, {"SLICE": 2}), {"SLICE-001": "SLICE-002", "SLICE-0001": "SLICE-003"})

    def test_empty_kinds_need_no_first_number(self):
        self.assertEqual(numbering({"SLICE": [], "PP": []}, {}), {})
        self.assertEqual(numbering({}, {"SLICE": 3}), {})

    def test_refusals(self):
        with self.assertRaises(ValueError):
            numbering({"SLICE": ["SLICE-001"]}, {})  # never guessed
        with self.assertRaises(ValueError):
            numbering({"SLICE": ["EPIC-001"]}, {"SLICE": 1})
        with self.assertRaises(ValueError):
            numbering({"SLICE": ["SLICE-01"]}, {"SLICE": 1})  # too short for the kind
        with self.assertRaises(ValueError):
            numbering({"POL": ["POL-x-01"]}, {"POL": 1})
        for bad in (0, -1, "3", 2.0, True):
            with self.assertRaises(ValueError):
                numbering({"PP": ["PP-01"]}, {"PP": bad})


class TokenRuleTest(unittest.TestCase):
    def test_a_swap_never_chains(self):
        text = "SLICE-001 then SLICE-002.\n"
        self.assertEqual(rewrite_text(text, {"SLICE-001": "SLICE-002", "SLICE-002": "SLICE-001"})[0], "SLICE-002 then SLICE-001.\n")
        self.assertEqual(rewrite_text(text, {"SLICE-001": "SLICE-002", "SLICE-002": "SLICE-003"})[0], "SLICE-002 then SLICE-003.\n")

    def test_prefix_clashes_and_boundaries(self):
        mapping = {"SLICE-001": "SLICE-031", "SLICE-0011": "SLICE-032"}
        out, notes = rewrite_text("SLICE-001 SLICE-0011\n", mapping)
        self.assertEqual(out, "SLICE-031 SLICE-032\n")
        self.assertEqual(notes, [])
        for untouched in ("XSLICE-001", "PRE-SLICE-001", "SLICE-001_x", "SLICE-001A", "x_SLICE-001", "éSLICE-001", "SLICE-001é",
                          "SLICE-001٣", "9SLICE-001", "SLICE-01", "PP-1", "TN-1", "PRD-1", "DES-1", "slice-001", "EPIC_001"):
            self.assertEqual(rewrite_text(untouched, {"SLICE-001": "SLICE-031", "PP-01": "PP-04"}), (untouched, []), untouched)
            self.assertEqual(ids_in_text(untouched), [], untouched)

    def test_where_a_token_is_matched(self):
        mapping = {"SLICE-011": "SLICE-031", "PP-03": "PP-07", "EPIC-001": "EPIC-004", "IDEA-002": "IDEA-009"}
        cases = {"SLICE-011/FR-02": "SLICE-031/FR-02", "specs/slices/SLICE-011-invite.md": "specs/slices/SLICE-031-invite.md",
                 "(Deferred to SLICE-011).": "(Deferred to SLICE-031).", "**PP-03** (revision 2)": "**PP-07** (revision 2)",
                 "- **Epic:** EPIC-001: Members": "- **Epic:** EPIC-004: Members", "- **Serves:** IDEA-002 O-1": "- **Serves:** IDEA-009 O-1",
                 "\"SLICE-011 said so\"": "\"SLICE-031 said so\"", "SLICE-011's": "SLICE-031's", "[SLICE-011](SLICE-011)": "[SLICE-031](SLICE-031)",
                 "SLICE-011-SLICE-011": "SLICE-031-SLICE-011"}
        for given, wanted in cases.items():
            self.assertEqual(rewrite_text(given, mapping)[0], wanted, given)

    def test_spec_local_ids_and_other_tokens_are_never_rewritten(self):
        text = "FR-01 INV-02 AC-03 R1 O-1 A-2 Q-3 POL-sec-01 TEAM-12 SLICE-001/FR-02\n"
        out, _ = rewrite_text(text, {"SLICE-001": "SLICE-009"})
        self.assertEqual(out, "FR-01 INV-02 AC-03 R1 O-1 A-2 Q-3 POL-sec-01 TEAM-12 SLICE-009/FR-02\n")

    def test_not_in_archive_is_left_and_reported(self):
        out, notes = rewrite_text("Needs SLICE-200.\nAnd PP-09 and SLICE-001.\n", {"SLICE-001": "SLICE-031"})
        self.assertEqual(out, "Needs SLICE-200.\nAnd PP-09 and SLICE-031.\n")
        self.assertEqual(notes, [{"line": 1, "id": "SLICE-200", "why": "not_in_archive"}, {"line": 2, "id": "PP-09", "why": "not_in_archive"}])

    def test_unicode_outside_the_ids_is_untouched(self):
        text = "Café — SLICE-001 «naïve» 漢字 SLICE-001 more 😀 SLICE-002\n"
        out, notes = rewrite_text(text, {"SLICE-001": "SLICE-031", "SLICE-002": "SLICE-032"})
        self.assertEqual(out, "Café — SLICE-031 «naïve» 漢字 SLICE-031 more 😀 SLICE-032\n")
        self.assertEqual(notes, [])


class CodeTest(unittest.TestCase):
    MAP = {"SLICE-001": "SLICE-031", "SLICE-002": "SLICE-032"}

    def test_fenced_block_left_and_noted_next_line_rewritten(self):
        text = "Before SLICE-001.\n```\nlog: SLICE-001 done\n```\nAfter SLICE-001.\n"
        out, notes = rewrite_text(text, self.MAP)
        self.assertEqual(out, "Before SLICE-031.\n```\nlog: SLICE-001 done\n```\nAfter SLICE-031.\n")
        self.assertEqual(notes, [{"line": 3, "id": "SLICE-001", "why": "in_code"}])
        self.assertEqual(ids_in_text(text), [(1, "SLICE-001", False), (3, "SLICE-001", True), (5, "SLICE-001", False)])

    def test_tilde_fence_indented_fence_and_info_string(self):
        text = "~~~\nSLICE-001\n~~~\n  ```SLICE-002\n  SLICE-002\n  ```\nSLICE-002\n"
        out, notes = rewrite_text(text, self.MAP)
        self.assertEqual(out, "~~~\nSLICE-001\n~~~\n  ```SLICE-002\n  SLICE-002\n  ```\nSLICE-032\n")
        self.assertEqual([(n["line"], n["why"]) for n in notes], [(2, "in_code"), (4, "in_code"), (5, "in_code")])

    def test_an_unclosed_fence_holds_the_rest_of_the_text(self):
        text = "SLICE-001\n```\nSLICE-001\n\nSLICE-002 at the end"
        out, notes = rewrite_text(text, self.MAP)
        self.assertEqual(out, "SLICE-031\n```\nSLICE-001\n\nSLICE-002 at the end")
        self.assertEqual([(n["line"], n["id"]) for n in notes], [(3, "SLICE-001"), (5, "SLICE-002")])

    def test_inline_code(self):
        out, notes = rewrite_text("Use `SLICE-001` not SLICE-001; `a` SLICE-002 `b`.\n", self.MAP)
        self.assertEqual(out, "Use `SLICE-001` not SLICE-031; `a` SLICE-032 `b`.\n")
        self.assertEqual(notes, [{"line": 1, "id": "SLICE-001", "why": "in_code"}])

    def test_nested_and_double_backticks(self):
        # CommonMark: ``...`` is one span even with a single backtick inside; the validator reads `` as an empty span.
        # A token either reading puts in code is left as written.
        text = "``SLICE-001 `x` SLICE-002`` and SLICE-002\n"
        out, notes = rewrite_text(text, self.MAP)
        self.assertEqual(out, "``SLICE-001 `x` SLICE-002`` and SLICE-032\n")
        self.assertEqual([n["id"] for n in notes], ["SLICE-001", "SLICE-002"])
        self.assertEqual(rewrite_text("```SLICE-001``` inline triple, SLICE-001\n", self.MAP)[0], "```SLICE-001``` inline triple, SLICE-001\n")

    def test_unmatched_backtick_is_not_code(self):
        self.assertEqual(rewrite_text("A ` lone SLICE-001\n", self.MAP), ("A ` lone SLICE-031\n", []))

    def test_code_kept_by_the_map_needs_no_check(self):
        self.assertEqual(rewrite_text("`SLICE-001`\n", {"SLICE-001": "SLICE-001"}), ("`SLICE-001`\n", []))
        self.assertEqual(rewrite_text("`SLICE-009`\n", {}), ("`SLICE-009`\n", [{"line": 1, "id": "SLICE-009", "why": "in_code"}]))


class LineEndingTest(unittest.TestCase):
    MAP = {"SLICE-001": "SLICE-031", "EPIC-001": "EPIC-004"}

    def test_crlf_text(self):
        text = "# SLICE-001: Invite\r\n\r\n```\r\nSLICE-001\r\n```\r\nEPIC-001\r\n"
        out, notes = rewrite_text(text, self.MAP)
        self.assertEqual(out, "# SLICE-031: Invite\r\n\r\n```\r\nSLICE-001\r\n```\r\nEPIC-004\r\n")
        self.assertEqual(notes, [{"line": 4, "id": "SLICE-001", "why": "in_code"}])

    def test_mixed_endings_and_no_final_newline(self):
        text = "SLICE-001\rEPIC-001\n\rSLICE-001\r\nEPIC-001"
        self.assertEqual(rewrite_text(text, self.MAP)[0], "SLICE-031\rEPIC-004\n\rSLICE-031\r\nEPIC-004")
        self.assertEqual([line for line, _, _ in ids_in_text(text)], [1, 2, 4, 5])

    def test_empty_map_and_identity_map_return_the_input(self):
        for text in ("", "\n", "SLICE-001\r\n", "no ids at all", "SLICE-001 `x` ```\nPP-01"):
            self.assertEqual(rewrite_text(text, {})[0], text)
            self.assertEqual(rewrite_text(text, {"SLICE-001": "SLICE-001", "PP-01": "PP-01"})[0], text)
        self.assertEqual(rewrite_text("SLICE-001 PP-01\n", {}), ("SLICE-001 PP-01\n", [{"line": 1, "id": "SLICE-001", "why": "not_in_archive"},
                                                                                     {"line": 1, "id": "PP-01", "why": "not_in_archive"}]))


class MappingRefusedTest(unittest.TestCase):
    def test_a_map_must_be_one_to_one_and_keep_kinds(self):
        for bad in ({"SLICE-001": "EPIC-001"}, {"SLICE-001": "SLICE-003", "SLICE-002": "SLICE-003"}, {"SLICE-01": "SLICE-002"},
                    {"POL-a-01": "POL-a-02"}, {"SLICE-001": 5}):
            with self.assertRaises(ValueError):
                rewrite_text("x", bad)
            with self.assertRaises(ValueError):
                rewrite_record("epic", epic(), bad, None)
            with self.assertRaises(ValueError):
                rename("product/epics/EPIC-001.json", bad)

    def test_unknown_record_kind_and_bad_project_id(self):
        with self.assertRaises(ValueError):
            rewrite_record("ledger", {}, MAP, None)
        with self.assertRaises(ValueError):
            rewrite_record("epic", epic(), MAP, "Team Space")
        with self.assertRaises(TypeError):
            rewrite_text(b"SLICE-001", MAP)


# ---- records, every field of 5.1 ----


def project():
    return {"schema_version": 1, "project_id": "lending", "name": "Lending SLICE-001", "revision": 2, "status": "active",
            "vision": "Members borrow; see SLICE-001 and `SLICE-002`.", "outcomes": ["EPIC-001 ships", "Nothing else"]}


def epic():
    return {"schema_version": 1, "epic_id": "EPIC-001", "project_id": "lending", "revision": 1, "title": "After EPIC-002", "status": "open",
            "acceptance_criteria": ["SLICE-001 done", "PP-01 holds"], "tracking": {"jira": "TEAM-1"},
            "serves": {"idea": "IDEA-001", "outcomes": ["O-1"]}}


def work_order():
    return {"schema_version": 1, "slice_id": "SLICE-002", "project_id": "lending", "epic_id": "EPIC-001", "revision": 3,
            "title": "Invite after SLICE-001", "status": "draft", "dependencies": ["SLICE-001", "SLICE-011"],
            "open_questions": ["Does SLICE-011 cover it?", "`SLICE-001` as typed"], "spec_path": "specs/slices/SLICE-002-invite-member.md",
            "spec_sha256": None, "source": {"kind": "prd", "prd_id": "PRD-01", "sha256": SHA, "lines": [[1, 4]], "map_slice": "M1"},
            "serves": {"idea": "IDEA-001", "outcomes": ["O-1", "O-2"]}, "kind": "small", "small": {"change": "fix", "shipped_rule": "SLICE-011/FR-02"},
            "widened": {"at": TIME, "reason": "Grew past SLICE-011/INV-01", "rule": None},
            "mocks": [{"sha256": SHA, "format": "png", "width": 10, "height": 10, "bytes": 99, "for": "AC-01", "binding": True, "note": "SLICE-001 screen"}],
            "tracking": {"jira": "TEAM-12"}, "origin": {"kind": "github_issue", "repository": "acme/lending", "number": 42}}


def principles():
    return {"schema_version": 1, "project_id": "lending", "principles": [
        {"id": "PP-01", "title": "Plain words, PP-02", "statement": "As SLICE-001 shows", "reason": "EPIC-001", "status": "active", "revision": 2},
        {"id": "PP-02", "title": "Quiet", "statement": "No noise", "reason": "Why", "status": "retired", "revision": 1}]}


def needs_record():
    return {"schema_version": 1, "project_id": "lending", "none": ["never"], "needs": [
        {"need_id": "TN-01", "kind": "data", "statement": "Keep SLICE-001's data", "why": "PP-01", "status": "active", "revision": 1},
        {"need_id": "TN-02", "kind": "given", "statement": "Postgres", "why": "TN-01 asks", "status": "active", "revision": 1,
         "said_by": "POL-data-01", "said_on": "2026-11-01"}]}


def idea():
    return {"schema_version": 1, "idea_id": "IDEA-001", "title": "Like IDEA-001 before", "stage": "shaped",
            "source": {"kind": "change", "rule": "SLICE-011/INV-01"}, "created": TIME, "revision": 2,
            "brief": {"sha256": SHA, "passes": True, "checked_at": TIME, "ids": {"O-1": "present"}},
            "verdict": {"decision": "go", "reason": "SLICE-001 needs it", "by": None, "at": TIME, "brief_sha256": SHA, "revision": 2},
            "route": {"route": "epic", "counted": {"outcomes": 2, "high_risk_not_determined": ["SLICE-011/FR-02"]}, "why": "Touches EPIC-001",
                      "at": TIME, "revision": 2, "brief_sha256": SHA,
                      "details": {"touches": {"outcomes": ["O-1"], "capabilities": ["Invites"], "shipped_rules": ["SLICE-011/FR-02"]},
                                  "concerns": {"principles": ["PP-01"], "policies": ["POL-sec-01"]},
                                  "high_risk": {"areas": [{"area": "auth SLICE-001", "rules": ["SLICE-011/FR-02"], "files": ["specs/slices/SLICE-011-x.md"],
                                                           "file_count": 1}], "not_determined": ["SLICE-011/INV-01"], "count": 1},
                                  "made_from": "EPIC-001", "idea": "IDEA-001"}},
            "made": {"epics": ["EPIC-001"], "slices": ["SLICE-001", "SLICE-002"]},
            "lookback": {"outcomes": {"O-1": {"result": "met", "note": "SLICE-001 did it", "by": None, "at": TIME}},
                         "assumptions": {"A-1": {"result": "wrong", "note": "Not EPIC-002", "by": None, "at": TIME}}},
            "issue": None}


def lookups():
    return {"shipped_rules": [{"rule": "SLICE-011/FR-02", "in_force": True, "epic_id": "EPIC-001", "note": "SLICE-011 rule"}],
            "similar": [{"idea": "IDEA-001", "note": "Like IDEA-001"}, {"request": 42, "note": "#42 SLICE-002"}],
            "principles": [{"id": "PP-02", "status": "active", "note": "PP-02 and PP-01"}],
            "policies": [{"id": "POL-sec-01", "owner": "security", "note": "see TN-01"}]}


def idea_map():
    return {"schema_version": 1, "idea_id": "IDEA-001", "brief_sha256": SHA, "route": "epic", "revision": 1,
            "epics": [{"key": "E1", "title": "New EPIC-002", "criteria": ["SLICE-001 works"]}],
            "slices": [{"key": "M1", "title": "After SLICE-001", "scope": "Like EPIC-001", "epic": "E1", "depends_on": [], "cites": [[1, 2]], "outcomes": ["O-1"]},
                       {"key": "M2", "title": "Two", "scope": "Two", "epic": "EPIC-001", "depends_on": ["M1", "SLICE-001"], "cites": [[3, 3]], "outcomes": ["O-1"]},
                       {"key": "PP-01", "title": "Key that looks like an ID", "scope": "x", "epic": "PP-01", "depends_on": ["PP-01"], "cites": [[1, 1]], "outcomes": []}],
            "settled": {"O-2": {"at": TIME, "as": "out-of-scope", "reason": "SLICE-002 has it"}, "O-3": {"at": TIME, "as": "slice", "slice": "M1"}},
            "applied": {"epics": {"E1": "EPIC-002"}, "slices": {"M1": "SLICE-001", "M2": "trying"}}, "mapped_at": TIME}


def prd_map():
    data = idea_map()
    del data["idea_id"], data["brief_sha256"], data["route"]
    data.update(prd_id="PRD-01", prd_sha256=SHA2)
    data["settled"] = {"4": {"at": TIME, "as": "later", "reason": "After SLICE-002"}}
    return data


def prd_meta():
    return {"schema_version": 1, "prd_id": "PRD-01", "name": "PRD-01 SLICE-001.md", "format": "md", "bytes": 10, "sha256": SHA, "line_count": 4,
            "sections": [{"n": 1, "title": "SLICE-001 heading"}], "file": "document.md"}


def prd_answers():
    return {"schema_version": 1, "slice_id": "SLICE-001", "prd_id": "PRD-01", "prd_sha256": SHA, "map_slice": "M1", "revision": 1,
            "answers": [{"n": 1, "kind": "drafted", "question": "SLICE-001?", "answer": "SLICE-002"}], "drafted_at": TIME, "confirmations": []}


def design_meta():
    return {"schema_version": 1, "design_id": "DES-01", "name": "DES-01.md", "format": "md", "bytes": 10, "sha256": SHA, "line_count": 3,
            "sections": [], "file": "design.md"}


def design_map():
    return {"schema_version": 1, "design_id": "DES-01", "design_sha256": SHA, "required_topics": ["storage"], "revision": 1,
            "topics": [{"topic": "storage", "state": "decided", "lines": [[1, 2]], "summary": "SLICE-001 store"}], "other": [],
            "conflicts": [{"n": 1, "lines": [[1, 1]], "against": "PP-01", "note": "PP-01 says", "settled": None},
                          {"n": 2, "lines": [[2, 2]], "against": "TN-01", "note": "", "settled": None},
                          {"n": 3, "lines": [[3, 3]], "against": "POL-sec-01", "note": "", "settled": None}],
            "mapped_at": TIME, "published": {"sha256": SHA}}


class RecordTest(unittest.TestCase):
    def rewritten(self, kind, record, project_id=None):
        before = copy.deepcopy(record)
        out = rewrite_record(kind, record, MAP, project_id)
        self.assertEqual(record, before, "the input is never changed")
        self.assertIsNot(out, record)
        return out

    def assertOnly(self, before, after, changes):
        """`after` equals `before` with exactly `changes` (dotted paths) applied."""
        expected = copy.deepcopy(before)
        for path, value in changes.items():
            target = expected
            keys = path.split(".")
            for key in keys[:-1]:
                target = target[int(key)] if isinstance(target, list) else target[key]
            last = keys[-1]
            if isinstance(target, list):
                target[int(last)] = value
            else:
                target[last] = value
        self.assertEqual(after, expected)

    def test_project(self):
        out = self.rewritten("project", project(), "team-space")
        self.assertOnly(project(), out, {"project_id": "team-space", "vision": "Members borrow; see SLICE-013 and `SLICE-002`.",
                                         "outcomes": ["EPIC-004 ships", "Nothing else"]})
        self.assertEqual(self.rewritten("project", project())["project_id"], "lending")
        self.assertEqual(self.rewritten("project", project())["name"], "Lending SLICE-001")  # not a field 5.1 lists

    def test_epic(self):
        out = self.rewritten("epic", epic(), "team-space")
        self.assertOnly(epic(), out, {"epic_id": "EPIC-004", "project_id": "team-space", "title": "After EPIC-005",
                                      "acceptance_criteria": ["SLICE-013 done", "PP-04 holds"], "serves.idea": "IDEA-002"})
        self.assertEqual(self.rewritten("epic", epic())["project_id"], "lending")

    def test_slice(self):
        out = self.rewritten("slice", work_order(), "team-space")
        self.assertOnly(work_order(), out, {
            "slice_id": "SLICE-014", "project_id": "team-space", "epic_id": "EPIC-004", "dependencies": ["SLICE-013", "SLICE-015"],
            "spec_path": "specs/slices/SLICE-014-invite-member.md", "source.prd_id": "PRD-02", "serves.idea": "IDEA-002",
            "small.shipped_rule": "SLICE-015/FR-02", "title": "Invite after SLICE-013",
            "open_questions": ["Does SLICE-015 cover it?", "`SLICE-001` as typed"], "widened.reason": "Grew past SLICE-015/INV-01"})
        self.assertEqual(out["mocks"][0]["note"], "SLICE-001 screen")  # not listed: left exactly
        _, notes = rewrite_record_noted("slice", work_order(), MAP, None)
        self.assertEqual(notes, [{"field": "open_questions[1]", "line": 1, "id": "SLICE-001", "why": "in_code"}])

    def test_slice_adjustment_and_null_spec(self):
        data = work_order()
        data.update(small={"change": "adjustment", "shipped_rule": None}, spec_path=None)
        out = self.rewritten("slice", data)
        self.assertIsNone(out["small"]["shipped_rule"])
        self.assertIsNone(out["spec_path"])

    def test_principles(self):
        out = self.rewritten("principles", principles(), "team-space")
        self.assertOnly(principles(), out, {"project_id": "team-space", "principles.0.id": "PP-04", "principles.0.title": "Plain words, PP-05",
                                            "principles.0.statement": "As SLICE-013 shows", "principles.0.reason": "EPIC-004",
                                            "principles.1.id": "PP-05"})

    def test_needs(self):
        out = self.rewritten("needs", needs_record(), "team-space")
        self.assertOnly(needs_record(), out, {"project_id": "team-space", "needs.0.need_id": "TN-03", "needs.0.statement": "Keep SLICE-013's data",
                                              "needs.0.why": "PP-04", "needs.1.why": "TN-03 asks"})
        self.assertEqual(out["needs"][1]["need_id"], "TN-02")  # not in the map: left, and noted
        _, notes = rewrite_record_noted("needs", needs_record(), MAP, None)
        self.assertIn({"field": "needs[1].need_id", "line": None, "id": "TN-02", "why": "not_in_archive"}, notes)
        self.assertEqual(out["needs"][1]["said_by"], "POL-data-01")

    def test_idea(self):
        out = self.rewritten("idea", idea())
        details = idea()["route"]["details"]
        details["touches"]["shipped_rules"] = ["SLICE-015/FR-02"]
        details["concerns"]["principles"] = ["PP-04"]
        details["high_risk"]["areas"][0]["rules"] = ["SLICE-015/FR-02"]
        details["high_risk"]["not_determined"] = ["SLICE-015/INV-01"]
        details["made_from"], details["idea"] = "EPIC-004", "IDEA-002"
        self.assertOnly(idea(), out, {"idea_id": "IDEA-002", "title": "Like IDEA-002 before", "source.rule": "SLICE-015/INV-01",
                                      "verdict.reason": "SLICE-013 needs it", "route.why": "Touches EPIC-004", "route.details": details,
                                      "made.epics": ["EPIC-004"], "made.slices": ["SLICE-013", "SLICE-014"],
                                      "route.counted.high_risk_not_determined": ["SLICE-015/FR-02"],
                                      "lookback.outcomes.O-1.note": "SLICE-013 did it", "lookback.assumptions.A-1.note": "Not EPIC-005"})
        # Left exactly: the hashes (5.3), route.counted's numbers, an area's free text and a file path.
        self.assertEqual(out["route"]["counted"]["outcomes"], 2)
        self.assertEqual(out["verdict"]["brief_sha256"], SHA)
        self.assertEqual(out["route"]["details"]["high_risk"]["areas"][0]["area"], "auth SLICE-001")
        self.assertEqual(out["route"]["details"]["high_risk"]["areas"][0]["files"], ["specs/slices/SLICE-011-x.md"])

    def test_counted_rules_agree_with_route_details_after_a_renumber(self):
        out = self.rewritten("idea", idea())
        self.assertEqual(out["route"]["counted"]["high_risk_not_determined"], ["SLICE-015/FR-02"])
        details = out["route"]["details"]
        self.assertTrue(set(out["route"]["counted"]["high_risk_not_determined"])
                        <= set(details["touches"]["shipped_rules"]) | set(details["high_risk"]["areas"][0]["rules"]))
        odd = idea()
        odd["route"]["counted"]["high_risk_not_determined"] = ["SLICE-099/FR-01"]
        _, notes = rewrite_record_noted("idea", odd, MAP, None)
        self.assertIn({"field": "route.counted.high_risk_not_determined[0]", "line": None, "id": "SLICE-099", "why": "not_in_archive"}, notes)

    def test_map_epics_words_are_prose(self):
        for kind, make in (("idea_map", idea_map), ("prd_map", prd_map)):
            data = make()
            data["epics"].append({"key": "E2", "title": "`EPIC-001` as typed", "criteria": ["Unknown EPIC-777"]})
            out, notes = rewrite_record_noted(kind, data, MAP, None)
            self.assertEqual(out["epics"][0], {"key": "E1", "title": "New EPIC-005", "criteria": ["SLICE-013 works"]}, kind)
            self.assertEqual(out["epics"][1], data["epics"][1], kind)
            self.assertIn({"field": "epics[1].title", "line": 1, "id": "EPIC-001", "why": "in_code"}, notes)
            self.assertIn({"field": "epics[1].criteria[0]", "line": 1, "id": "EPIC-777", "why": "not_in_archive"}, notes)

    def test_idea_sources_other_than_change_are_left(self):
        for source in ({"kind": "typed"}, {"kind": "moved"}, {"kind": "fault", "ticket": "AUTO-20261120T101500Z"},
                       {"kind": "request", "repository": None, "number": 42}):
            data = idea()
            data["source"] = source
            self.assertEqual(self.rewritten("idea", data)["source"], source)

    def test_lookups(self):
        out = self.rewritten("lookups", lookups())
        self.assertOnly(lookups(), out, {"shipped_rules.0.rule": "SLICE-015/FR-02", "shipped_rules.0.epic_id": "EPIC-004",
                                         "shipped_rules.0.note": "SLICE-015 rule", "similar.0.idea": "IDEA-002", "similar.0.note": "Like IDEA-002",
                                         "similar.1.note": "#42 SLICE-014", "principles.0.id": "PP-05", "principles.0.note": "PP-05 and PP-04",
                                         "policies.0.note": "see TN-03"})

    def test_idea_map(self):
        out = self.rewritten("idea_map", idea_map())
        self.assertOnly(idea_map(), out, {"idea_id": "IDEA-002", "epics.0.title": "New EPIC-005", "epics.0.criteria": ["SLICE-013 works"],
                                          "slices.0.title": "After SLICE-013", "slices.0.scope": "Like EPIC-004",
                                          "slices.1.epic": "EPIC-004", "slices.1.depends_on": ["M1", "SLICE-013"],
                                          "settled.O-2.reason": "SLICE-014 has it",
                                          "applied": {"epics": {"E1": "EPIC-005"}, "slices": {"M1": "SLICE-013", "M2": "trying"}}})
        # A map key is not an ID, even one shaped like a principle's.
        self.assertEqual(out["slices"][2]["epic"], "PP-01")
        self.assertEqual(out["slices"][2]["depends_on"], ["PP-01"])
        self.assertEqual(out["epics"][0]["key"], "E1")

    def test_prd_map(self):
        out = self.rewritten("prd_map", prd_map())
        self.assertOnly(prd_map(), out, {"prd_id": "PRD-02", "epics.0.title": "New EPIC-005", "epics.0.criteria": ["SLICE-013 works"],
                                         "slices.0.title": "After SLICE-013", "slices.0.scope": "Like EPIC-004",
                                         "slices.1.epic": "EPIC-004", "slices.1.depends_on": ["M1", "SLICE-013"], "settled.4.reason": "After SLICE-014",
                                         "applied": {"epics": {"E1": "EPIC-005"}, "slices": {"M1": "SLICE-013", "M2": "trying"}}})
        self.assertEqual(out["prd_sha256"], SHA2)

    def test_prd_meta_and_answers(self):
        self.assertOnly(prd_meta(), self.rewritten("prd_meta", prd_meta()), {"prd_id": "PRD-02"})
        self.assertOnly(prd_answers(), self.rewritten("prd_answers", prd_answers()), {"slice_id": "SLICE-013", "prd_id": "PRD-02"})

    def test_design_meta_and_map(self):
        self.assertOnly(design_meta(), self.rewritten("design_meta", design_meta()), {"design_id": "DES-03"})
        self.assertOnly(design_map(), self.rewritten("design_map", design_map()),
                        {"design_id": "DES-03", "conflicts.0.against": "PP-04", "conflicts.1.against": "TN-03"})

    def test_identity_map_returns_an_equal_record_for_every_kind(self):
        identity = {key: key for key in MAP}
        for kind, make in (("project", project), ("epic", epic), ("slice", work_order), ("principles", principles), ("needs", needs_record),
                           ("idea", idea), ("lookups", lookups), ("idea_map", idea_map), ("prd_map", prd_map), ("prd_meta", prd_meta),
                           ("prd_answers", prd_answers), ("design_meta", design_meta), ("design_map", design_map)):
            record = make()
            self.assertEqual(json.dumps(rewrite_record(kind, record, identity, None), sort_keys=True), json.dumps(make(), sort_keys=True), kind)

    def test_every_listed_kind_is_handled(self):
        self.assertEqual(set(project_ids.RECORD_KINDS), {"project", "epic", "slice", "principles", "needs", "idea", "lookups", "idea_map",
                                                         "prd_map", "prd_answers", "prd_meta", "design_meta", "design_map"})
        self.assertEqual(set(project_ids.REWRITERS), set(project_ids.RECORD_KINDS))

    def test_a_record_of_unexpected_shape_is_left_where_it_is_odd(self):
        odd = {"epic_id": 7, "serves": "IDEA-001", "acceptance_criteria": "SLICE-001", "title": None}
        self.assertEqual(rewrite_record("epic", odd, MAP, None), odd)


class RenameTest(unittest.TestCase):
    def test_every_path_form(self):
        cases = {
            "specs/slices/SLICE-001-invite-member.md": "specs/slices/SLICE-013-invite-member.md",
            "product/intents/SLICE-001.md": "product/intents/SLICE-013.md",
            "product/slices/SLICE-001.json": "product/slices/SLICE-013.json",
            "product/epics/EPIC-001.json": "product/epics/EPIC-004.json",
            "product/mocks/SLICE-002/" + SHA + ".png": "product/mocks/SLICE-014/" + SHA + ".png",
            "product/mocks/SLICE-002/" + SHA + ".jpg": "product/mocks/SLICE-014/" + SHA + ".jpg",
            "product/mocks/SLICE-002": "product/mocks/SLICE-014",
            "product/mocks/SLICE-002/": "product/mocks/SLICE-014/",
            "product/ideas/IDEA-001.json": "product/ideas/IDEA-002.json",
            "product/ideas/IDEA-001.lookups.json": "product/ideas/IDEA-002.lookups.json",
            "product/ideas/IDEA-001.map.json": "product/ideas/IDEA-002.map.json",
            "product/briefs/IDEA-001.md": "product/briefs/IDEA-002.md",
            "product/briefs/IDEA-001.case.md": "product/briefs/IDEA-002.case.md",
            "product/prds/PRD-01": "product/prds/PRD-02",
            "product/prds/PRD-01/prd.json": "product/prds/PRD-02/prd.json",
            "product/prds/PRD-01/document.md": "product/prds/PRD-02/document.md",
            "product/prds/PRD-01/document.txt": "product/prds/PRD-02/document.txt",
            "product/prds/PRD-01/map.json": "product/prds/PRD-02/map.json",
            "product/prds/PRD-01/answers/M1.json": "product/prds/PRD-02/answers/M1.json",
            "product/designs/DES-01": "product/designs/DES-03",
            "product/designs/DES-01/import.json": "product/designs/DES-03/import.json",
            "product/designs/DES-01/design.md": "product/designs/DES-03/design.md",
            "product/designs/DES-01/design.txt": "product/designs/DES-03/design.txt",
            "product/designs/DES-01/map.json": "product/designs/DES-03/map.json",
            "product/project.json": "product/project.json",
            "product/principles.json": "product/principles.json",
            "product/needs.json": "product/needs.json",
        }
        for given, wanted in cases.items():
            self.assertEqual(rename(given, MAP), wanted, given)

    def test_kebab_holding_digits_and_wide_numbers(self):
        self.assertEqual(rename("specs/slices/SLICE-1000-slice-001-fix.md", {"SLICE-1000": "SLICE-031"}), "specs/slices/SLICE-031-slice-001-fix.md")
        self.assertEqual(rename("product/slices/SLICE-001.json", {"SLICE-001": "SLICE-1000"}), "product/slices/SLICE-1000.json")

    def test_refused(self):
        for bad in ("product/slices/SLICE-009.json", "../product/slices/SLICE-001.json", "/product/slices/SLICE-001.json",
                    "product/slices/../SLICE-001.json", "product\\slices\\SLICE-001.json", "product/slices/SLICE-001.md",
                    "workspace/product/slices/SLICE-001.json", "product/ready/SLICE-001/spec.md", "specs/slices/SLICE-001.md",
                    "specs/slices/SLICE-001-Invite.md", "product/mocks/SLICE-001/x.png", "product/prds/PRD-01/other.md",
                    "product/epics/EPIC-01.json", "product/slices/SLICE-001.json/", "", "product/project.json/"):
            with self.assertRaises(ValueError, msg=bad):
                rename(bad, MAP)
        with self.assertRaises(TypeError):
            rename(Path("product/project.json"), MAP)


class PropertyTest(unittest.TestCase):
    """Random texts with a fixed seed: the identity map returns the input; a permutation and then its inverse return it."""

    ALPHABET = ["SLICE-", "EPIC-", "IDEA-", "PP-", "TN-", "PRD-", "DES-", "X", "-", "_", "0", "1", "2", "9", "/FR-02", " ", "`", "``", "```",
                "~~~", "\n", "\r\n", "\r", "é", "漢", "😀", " ", "(Deferred to ", ").", "\"", "**", "a", "SLICE-001", "SLICE-0011",
                "PP-01", "EPIC-002", "IDEA-010", "TN-03", "PRD-04", "DES-05", "SLICE-999", "SLICE-1000"]

    def texts(self, rng, count):
        for _ in range(count):
            yield "".join(rng.choice(self.ALPHABET) for _ in range(rng.randint(0, 80)))

    def test_identity_and_inverse(self):
        rng = random.Random(20261124)
        ids = sorted({ident for text in self.texts(random.Random(1), 400) for _, ident, _ in ids_in_text(text)}
                     | {"SLICE-001", "SLICE-0011", "PP-01", "EPIC-002", "IDEA-010", "TN-03", "PRD-04", "DES-05", "SLICE-999", "SLICE-1000"})
        identity = {ident: ident for ident in ids}
        by_kind = {}
        for ident in ids:
            by_kind.setdefault(ident.split("-")[0], []).append(ident)
        for round_ in range(40):
            permutation = {}
            for group in by_kind.values():
                shuffled = list(group)
                rng.shuffle(shuffled)
                permutation.update(zip(group, shuffled))
            inverse = {new: old for old, new in permutation.items()}
            for text in self.texts(rng, 50):
                self.assertEqual(rewrite_text(text, identity)[0], text)
                self.assertEqual(rewrite_text(text, {})[0], text)
                once, _ = rewrite_text(text, permutation)
                self.assertEqual(rewrite_text(once, inverse)[0], text, (round_, text, permutation))
                self.assertEqual(len(ids_in_text(once)), len(ids_in_text(text)))


if __name__ == "__main__":
    unittest.main()
