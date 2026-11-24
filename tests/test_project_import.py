"""M21 D: `project import`, a project brought in from an archive, as a new project or joining the one here.

Uses the GitHub stand-in of test_mach_product_issues (IssuesBase). Archives are either made by the real export
(project_export, piece C) from Ada's clone `a`, or laid out here by hand and written with project_archive.write, so each
case holds exactly what it needs. After an export, the stand-in's issues are wiped: the destination is "another
repository" whose GitHub holds nothing of the source. Import is called as piece E will call it:
project_import.run(studio, Studio(root), archive). Design: docs/mach-next/M21_EXPORT_IMPORT.md, sections 4 to 7, and the
scenarios of section 9 listed for piece D.
"""

import hashlib
import json
import os
import subprocess
import sys
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "studio" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "ticket" / "scripts"))
from test_mach_product_issues import REPO, git, intent_for, spec_for  # noqa: E402
from test_project_export import ExportBase  # noqa: E402
import issue_rules  # noqa: E402
import mocks  # noqa: E402
import needs  # noqa: E402
import prd  # noqa: E402
import design  # noqa: E402
import project_archive  # noqa: E402
import project_export  # noqa: E402
import project_import  # noqa: E402
import shape  # noqa: E402
import studio  # noqa: E402

TIME = "2026-11-20T10:00:00Z"
NOTHING = "Nothing was changed."
EFFECTS = ("## Effects on shipped behaviour\n\n| Shipped rule | Effect | In this slice | Note |\n|---|---|---|---|\n"
           "| SLICE-001/FR-02 | kept | AC-01 | The invitation still goes out. |\n")
DOC = "# Plan\n\nMembers lend to each other.\n\n## Scope\n\nLoans are tracked.\n"


def canonical(data):
    return studio.canonical(data).encode("utf-8")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def tree(project):
    """Every file under the project except Git's own folder, with its bytes' SHA-256, and what `git status` says."""
    files = {path.relative_to(project).as_posix(): sha(path.read_bytes()) for path in sorted(project.rglob("*"))
             if path.is_file() and ".git" not in path.relative_to(project).parts[:1]}
    status = subprocess.run(["git", "status", "--porcelain"], cwd=str(project), capture_output=True, text=True).stdout
    return files, status


def draft_tree(project, leave_out=("session.json",)):
    folder = project / ".factory/studio/draft"
    return {path.relative_to(folder).as_posix(): sha(path.read_bytes()) for path in sorted(folder.rglob("*"))
            if path.is_file() and path.name not in leave_out}


# ---- an archive laid out by hand (section 2.1) ----


def lending(project_id="lending", slices=4, extra=None, principles=True):
    """A small project: EPIC-001 and EPIC-002, SLICE-001..n (SLICE-002 depends on SLICE-001; SLICE-001's spec reserves
    SLICE-007 with a pointer; SLICE-003's spec names SLICE-001/FR-02 under its effects; SLICE-004 a small change to that
    rule), principles PP-01 and PP-02, need TN-01, IDEA-001 (whose route made EPIC-002 and SLICE-003 and whose brief names
    EPIC-002), PRD-01 with a map and answers, DES-01 with a map whose conflict is against PP-01. Returns (files, facts)."""
    files = {}

    def put(rel, value):
        files["workspace/" + rel] = canonical(value) if isinstance(value, dict) else value.encode("utf-8") if isinstance(value, str) else value

    put("product/project.json", {"schema_version": 1, "project_id": project_id, "name": "Lending", "revision": 1, "status": "active",
                                 "vision": "Members lend to each other; see EPIC-001.", "outcomes": ["Loans are tracked"]})
    for n, title in ((1, "Team membership"), (2, "Bulk invites")):
        epic = {"schema_version": 1, "epic_id": f"EPIC-00{n}", "project_id": project_id, "revision": 1, "title": title, "status": "open",
                "acceptance_criteria": [f"SLICE-00{n} works"]}
        if n == 2:
            epic["serves"] = {"idea": "IDEA-001", "outcomes": ["O-1"]}
        put(f"product/epics/EPIC-00{n}.json", epic)
    pp = "\n## Product principles\n\n- **PP-01** (revision 1): Followed. Versions stay.\n"
    for n in range(1, slices + 1):
        sid = f"SLICE-{n:03d}"
        work = {"schema_version": 1, "slice_id": sid, "project_id": project_id, "epic_id": "EPIC-001" if n != 3 else "EPIC-002", "revision": 2,
                "title": f"Slice {n} after SLICE-001" if n > 1 else "Invite a teammate", "status": "approved_for_engineering" if n == 1 else "draft",
                "dependencies": ["SLICE-001"] if n == 2 else [], "open_questions": [],
                "spec_path": f"specs/slices/{sid}-invite-teammate.md" if n == 1 else None, "spec_sha256": None}
        extra_text = EFFECTS if n == 3 else ""
        spec = spec_for(sid, "SLICE-007" if n == 1 else None, extra_text) + (pp if n == 1 else "")
        if n == 1:
            work["spec_sha256"] = sha(spec.encode())
        if n == 3:
            work["serves"] = {"idea": "IDEA-001", "outcomes": ["O-1"]}
        if n == 4:
            work.update(kind="small", small={"change": "fix", "shipped_rule": "SLICE-001/FR-02"})
        put(f"product/slices/{sid}.json", work)
        put(f"specs/slices/{sid}-invite-teammate.md", spec)
        put(f"product/intents/{sid}.md", intent_for(sid))
    if principles:
        put("product/principles.json", {"schema_version": 1, "project_id": project_id, "principles": [
            {"id": "PP-01", "title": "Versions stay", "statement": "A published version MUST NOT be edited in place.", "reason": "Trust.",
             "status": "active", "revision": 1},
            {"id": "PP-02", "title": "Plain words", "statement": "Every message SHALL use words a member knows, as PP-01 does.", "reason": "Clarity.",
             "status": "active", "revision": 1}]})
        put("product/needs.json", {"schema_version": 1, "project_id": project_id, "none": ["never"], "needs": [
            {"need_id": "TN-01", "kind": "people", "statement": "About forty teams use it.", "why": "It sets the size.", "status": "active", "revision": 1}]})
    brief = "# Bulk invites\n\n## Outcomes\n\n- O-1: Admins bring a whole team in at once.\n\n- Capabilities: Bulk invites (EPIC-002)\n"
    put("product/briefs/IDEA-001.md", brief)
    put("product/ideas/IDEA-001.json", {
        "schema_version": 1, "idea_id": "IDEA-001", "title": "Let admins invite a whole team", "stage": "shaped", "source": {"kind": "moved"},
        "created": TIME, "revision": 1, "brief": {"sha256": shape.sha(brief), "passes": True, "checked_at": TIME, "ids": {"O-1": "present"}},
        "verdict": {"decision": "go", "reason": "Teams asked for it.", "by": None, "at": TIME, "brief_sha256": shape.sha(brief), "revision": 1},
        "route": {"route": "epic", "counted": {"outcomes": 1, "high_risk_not_determined": []}, "why": "One outcome over EPIC-002.", "at": TIME,
                  "revision": 1, "brief_sha256": shape.sha(brief), "details": {"made_from": "EPIC-002"}},
        "made": {"epics": ["EPIC-002"], "slices": ["SLICE-003"]}, "lookback": None, "issue": None})
    put("product/ideas/IDEA-001.map.json", {"schema_version": 1, "idea_id": "IDEA-001", "brief_sha256": shape.sha(brief), "route": "epic", "revision": 1,
                                            "settled": {},
                                            "epics": [{"key": "E1", "title": "Bulk invites", "criteria": ["A whole team joins"]}],
                                            "slices": [{"key": "B1", "title": "Invite many", "scope": "Many", "epic": "E1", "depends_on": [],
                                                        "cites": [[1, 2]], "outcomes": ["O-1"]}],
                                            "applied": {"epics": {"E1": "EPIC-002"}, "slices": {"B1": "SLICE-003"}}, "mapped_at": TIME})
    doc = DOC.encode()
    put("product/prds/PRD-01/document.md", doc)
    put("product/prds/PRD-01/prd.json", {"schema_version": 1, "prd_id": "PRD-01", "name": "plan.md", "format": "markdown", "file": "document.md",
                                         "bytes": len(doc), "sha256": sha(doc), "line_count": 7, "sections": [], "imported_at": TIME})
    put("product/prds/PRD-01/map.json", {"schema_version": 1, "prd_id": "PRD-01", "prd_sha256": sha(doc), "revision": 1, "epics": [],
                                         "slices": [{"key": "M1", "title": "Invite", "scope": "One", "epic": "EPIC-001", "depends_on": [], "cites": [[1, 3]]}],
                                         "settled": {}, "applied": {"epics": {}, "slices": {"M1": "SLICE-002"}}})
    put("product/prds/PRD-01/answers/M1.json", {"schema_version": 1, "slice_id": "SLICE-002", "prd_id": "PRD-01", "prd_sha256": sha(doc), "map_slice": "M1",
                                                "revision": 1, "answers": [], "drafted_at": TIME, "confirmations": []})
    put("product/designs/DES-01/design.md", doc)
    put("product/designs/DES-01/import.json", {"schema_version": 1, "design_id": "DES-01", "name": "design.md", "format": "markdown", "file": "design.md",
                                               "bytes": len(doc), "sha256": sha(doc), "line_count": 7, "sections": [], "imported_at": TIME})
    put("product/designs/DES-01/map.json", {"schema_version": 1, "design_id": "DES-01", "revision": 1, "topics": {}, "other": [],
                                            "conflicts": [{"n": 1, "lines": [[1, 1]], "against": "PP-01", "note": "", "settled": None}]})
    for rel, value in (extra or {}).items():
        put(rel, value)
    facts = {"schema_version": 1, "last_read_github_at": TIME, "order": {"EPIC-001": ["SLICE-002", "SLICE-001"] + [f"SLICE-{n:03d}" for n in range(4, slices + 1)],
                                                                       "EPIC-002": ["SLICE-003"]},
             "slices": {"SLICE-001": {"was": "shipped", "revision": 3, "jira": "TEAM-12", "request": 42, "note": "Stopped at SLICE-002's question."},
                        "SLICE-002": {"was": "being_built", "revision": 1, "jira": None, "request": None, "note": None},
                        "SLICE-003": {"was": "ready_to_build", "revision": 1, "jira": None, "request": None, "note": None}},
             "epics": {"EPIC-001": {"jira": "TEAM-1"}, "EPIC-002": {"jira": None}},
             "ideas": {"IDEA-001": {"was_source": {"kind": "request", "number": 42}}}, "lookups_removed": {}}
    return files, facts


def write_archive(path, files, facts, project_id="lending"):
    members = dict(files)
    members["facts.json"] = canonical(facts)
    counts = {"slices": sum(1 for name in files if name.startswith("workspace/product/slices/"))}
    project_archive.write(path, members, {"mach_version": "0.24.0", "exported_at": "2026-11-24T13:06:00Z", "project_id": project_id, "counts": counts})
    return path


class ImportBase(ExportBase):
    """Ada's clone `a` is the source; Ben's `b` and the engineer's `eng` are destinations in "another repository"."""

    def setUp(self):
        super().setUp()
        self.archives = self.root / "archives"
        self.archives.mkdir()

    def hand_archive(self, name="lending.zip", project_id="lending", **kwargs):
        files, facts = lending(project_id, **kwargs)
        return write_archive(self.archives / name, files, facts, project_id)

    def real_archive(self):
        """Ada's project (test_project_export's build), exported; then GitHub's issues are wiped: the destination is another repository."""
        self.build()
        result = project_export.export(studio, studio.Studio(self.a), self.archives, False)
        self.another_repository()
        return Path(result["file"])

    def another_repository(self):
        self.set_gh(issues={}, labels=[], calls=[], next_number=1)

    def plan(self, project, archive):
        return project_import.plan(studio, studio.Studio(project), archive)

    def bring(self, project, archive):
        return project_import.run(studio, studio.Studio(project), archive)

    def refused_import(self, project, archive, sentence, plan=False):
        before = tree(project)
        writes = len(self.writes())
        with self.assertRaises(studio.StudioError) as caught:
            (self.plan if plan else self.bring)(project, archive)
        message = str(caught.exception)
        self.assertEqual(message, sentence)
        self.assertTrue(message.endswith(NOTHING), message)
        self.assertEqual(tree(project), before, "a refusal changes nothing")
        self.assertEqual(len(self.writes()), writes)
        return message

    def record(self, project, archive):
        return json.loads((project / ".factory/studio/imports" / f"{sha(Path(archive).read_bytes())[:16]}.json").read_text())

    def work(self, project, slice_id):
        return self.artifact(project, f"product/slices/{slice_id}.json")

    def text(self, project, relative):
        return self.draft(project, relative).read_text()

    def pairs(self, result, kind):
        return dict(map(tuple, result["map"][kind]))

    def github_issue(self, label, body, title="An issue"):
        state = self.gh()
        number = state.get("next_number", 1)
        state["next_number"] = number + 1
        state["issues"][str(number)] = {"number": number, "id": 9000 + number, "title": title, "body": body, "labels": [{"name": label}],
                                        "state": "OPEN", "comments": [], "events": [], "sub_issues": [], "pinned": False}
        self.gh_state.write_text(json.dumps(state))
        return number

    def ben_project(self, epics=2, slices=10):
        """Ben's own project here: team-space, EPIC-001..epics, SLICE-001..slices (work orders only), PP-01..03, TN-01..02, IDEA-001."""
        b = self.b
        self.ok(b, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together")
        for n in range(1, epics + 1):
            self.write_json_in(b, f"product/epics/EPIC-{n:03d}.json", {"schema_version": 1, "epic_id": f"EPIC-{n:03d}", "project_id": "team-space",
                                                                       "revision": 1, "title": f"Epic {n}", "status": "open", "acceptance_criteria": []})
        for n in range(1, slices + 1):
            self.write_json_in(b, f"product/slices/SLICE-{n:03d}.json", {
                "schema_version": 1, "slice_id": f"SLICE-{n:03d}", "project_id": "team-space", "epic_id": "EPIC-001", "revision": 1,
                "title": f"Ben's slice {n}", "status": "draft", "dependencies": [], "open_questions": [], "spec_path": None, "spec_sha256": None})
        self.write_json_in(b, "product/principles.json", {"schema_version": 1, "project_id": "team-space", "principles": [
            {"id": f"PP-0{n}", "title": f"Ben's {n}", "statement": "A published version MUST NOT be edited in place." if n == 2 else f"Statement {n}.",
             "reason": "Because.", "status": "active", "revision": 1} for n in (1, 2, 3)]})
        self.write_json_in(b, "product/needs.json", {"schema_version": 1, "project_id": "team-space", "none": [], "needs": [
            {"need_id": f"TN-0{n}", "kind": "data", "statement": f"Need {n}.", "why": "Because.", "status": "active", "revision": 1} for n in (1, 2)]})
        self.write_json_in(b, "product/ideas/IDEA-001.json", {"schema_version": 1, "idea_id": "IDEA-001", "title": "Ben's idea", "stage": "new",
                                                              "source": {"kind": "typed"}, "created": TIME, "revision": 0, "brief": None, "verdict": None,
                                                              "route": None, "made": None, "lookback": None, "issue": None})
        self.assertTrue(self.ok(b, "validate")["valid"])

    def write_json_in(self, project, relative, data):
        path = self.draft(project, relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(studio.canonical(data))


# ---- scenario 1, the import half: a real export into an empty destination ----


class RoundTripTest(ImportBase):
    maxDiff = None

    def test_a_real_export_arrives_whole_in_another_repository(self):
        archive = self.real_archive()
        result = self.bring(self.b, archive)
        self.assertEqual(self.writes(), [], "import writes nothing to GitHub")
        self.assertEqual((result["mode"], result["from_project"], result["into_project"], result["renumbered"]), ("new", "lending", "lending", False))
        self.assertTrue(result["imported"])
        self.assertFalse(result["factory_authorized"])
        _, members = project_archive.read(archive)
        kinds = {name: kind for name, kind in self.member_kinds(members)}
        for member, data in members.items():
            if not member.startswith("workspace/"):
                continue
            rel = member[len("workspace/"):]
            here = self.draft(self.b, rel).read_bytes()
            kind = kinds.get(member)
            if kind is None:  # Markdown, PRD and design documents, mocks: byte for byte
                self.assertEqual(here, data, rel)
                self.assertEqual(here, self.draft(self.a, rel).read_bytes(), rel)
                continue
            source = json.loads(self.draft(self.a, rel).read_text())
            expected = project_export.STRIP[kind](source)
            if kind == "slice":
                expected.update(status="draft", spec_sha256=None)
            self.assertEqual(json.loads(here), expected, rel)
        report = self.ok(self.b, "validate")
        self.assertTrue(report["valid"], report)
        for slice_id in ("SLICE-001", "SLICE-002", "SLICE-003"):
            work = self.work(self.b, slice_id)
            self.assertEqual((work["status"], work["spec_sha256"]), ("draft", None))
            self.assertNotIn("origin", work)
            self.assertNotIn("tracking", work)
        ledger = self.ledger(self.b)
        facts = json.loads(members["facts.json"])
        self.assertEqual(ledger["order"]["EPIC-001"]["slices"], facts["order"]["EPIC-001"])
        self.assertEqual(ledger["order"]["EPIC-001"]["slices"], ["SLICE-001", "SLICE-002"], "the source's order within the epic")
        session = json.loads((self.b / ".factory/studio/session.json").read_text())
        self.assertEqual(session["notes"]["SLICE-003"]["note"], "Stopped at the second question.")
        rows = {row["from"]: row for row in result["slices"]}
        self.assertEqual(rows["SLICE-001"]["was"], "ready_to_build")
        self.assertEqual(rows["SLICE-001"]["was_words"], "ready to build in the old repository")
        self.assertEqual(result["left_behind"]["jira"], {"SLICE-003": "TEAM-12"})
        self.assertEqual(result["left_behind"]["epic_jira"], {"EPIC-001": "TEAM-1"})
        self.assertEqual(result["left_behind"]["idea_sources"]["IDEA-001"], {"kind": "request", "number": 42})
        self.assertEqual(result["left_behind"]["lookups_removed"], {"IDEA-001": 1})
        idea = self.artifact(self.b, "product/ideas/IDEA-001.json")
        self.assertEqual(idea["source"], {"kind": "moved"})
        ideas = shape.Ideas(studio, studio.Studio(self.b))
        self.assertTrue(shape.verdict_holds(idea, shape.current_brief_sha(ideas, "IDEA-001")), "no renumbering: the verdict still holds")
        self.assertEqual(shape.source_view(ideas, idea["source"])["words"], "Came from another repository; its source is not kept here.")
        self.assertIn("Every slice is a draft here", result["note"])
        self.assertIn("Nothing was sent to GitHub", result["note"])
        self.assertEqual(self.ok(self.b, "status")["project"]["project_id"], "lending")
        self.assertNotIn(".factory", tree(self.b)[1], "the workspace stays out of git status")

    def member_kinds(self, members):
        patterns = [("workspace/product/project.json", "project"), ("workspace/product/epics/", "epic"), ("workspace/product/slices/", "slice"),
                    ("workspace/product/principles.json", "principles"), ("workspace/product/needs.json", "needs")]
        for member in members:
            if not member.endswith(".json") or not member.startswith("workspace/"):
                continue
            if member.endswith(".lookups.json"):
                yield member, "lookups"
            elif member.endswith(".map.json"):
                yield member, "idea_map"
            elif member.startswith("workspace/product/ideas/"):
                yield member, "idea"
            elif member.startswith("workspace/product/prds/"):
                yield member, ("prd_meta" if member.endswith("/prd.json") else "prd_map" if member.endswith("/map.json") else "prd_answers")
            elif member.startswith("workspace/product/designs/"):
                yield member, ("design_meta" if member.endswith("/import.json") else "design_map")
            else:
                yield member, next(kind for start, kind in patterns if member.startswith(start))

    def test_joining_a_project_here_from_a_real_export(self):
        """Joining with overlapping numbers from a real export: Ben's project holds EPIC-001..002 and SLICE-001..010."""
        archive = self.real_archive()
        self.ben_project()
        result = self.bring(self.b, archive)
        self.assertEqual(self.writes(), [])
        self.assertEqual(result["mode"], "join")
        self.assertEqual(self.pairs(result, "EPIC"), {"EPIC-001": "EPIC-003", "EPIC-002": "EPIC-004"})
        self.assertEqual(self.pairs(result, "SLICE"), {"SLICE-001": "SLICE-011", "SLICE-002": "SLICE-012", "SLICE-003": "SLICE-013"})
        self.assertEqual(self.pairs(result, "PP"), {"PP-01": "PP-04"})
        self.assertEqual(self.pairs(result, "IDEA"), {"IDEA-001": "IDEA-002", "IDEA-002": "IDEA-003"})
        self.assertTrue(self.ok(self.b, "validate")["valid"])
        for slice_id in ("SLICE-011", "SLICE-012", "SLICE-013"):
            self.assertEqual(self.work(self.b, slice_id)["project_id"], "team-space")
        self.assertEqual(self.work(self.b, "SLICE-013")["epic_id"], "EPIC-004")
        self.assertTrue(self.text(self.b, "specs/slices/SLICE-011-invite-teammate.md").startswith("# SLICE-011: "))
        self.assertEqual([p["id"] for p in self.artifact(self.b, "product/principles.json")["principles"]], ["PP-01", "PP-02", "PP-03", "PP-04"])
        self.assertEqual(result["same_principles"], [{"incoming": "PP-04", "here": "PP-02",
                                                      "words": "PP-04 says the same as PP-02; retire one if they are the same."}])
        self.assertEqual(result["left_behind"]["project"]["name"], "Lending")
        self.assertEqual(self.artifact(self.b, "product/project.json")["name"], "Team Space", "joining never writes the project")


# ---- scenarios 2, 3, 7, 8, 14 and 16: joining with overlapping numbers, every reference rewritten ----


class JoinTest(ImportBase):
    maxDiff = None

    def setUp(self):
        super().setUp()
        self.ben_project()
        # GitHub holds SLICE-011 and EPIC-003, which Ben's workspace does not; origin/main holds SLICE-012's spec.
        self.github_issue("mach:project", "<!-- mach:project id=team-space -->\nTeam Space\n")
        self.github_issue("mach:epic", "<!-- mach:epic id=EPIC-003 -->\nSomeone's epic\n")
        self.github_issue("mach:slice", issue_rules.slice_marker("SLICE-011", 1, 2, [], "a" * 64, "b" * 64) + "body")
        (self.eng / "specs" / "slices").mkdir(parents=True)
        (self.eng / "specs/slices/SLICE-012-x.md").write_text("# SLICE-012: Someone's slice\n")
        git(self.eng, "add", "-A")
        git(self.eng, "commit", "-q", "-m", "a slice on main")
        git(self.eng, "push", "-q", "origin", "main")
        git(self.b, "fetch", "-q", "origin")
        self.archive = self.hand_archive()
        self.set_gh(calls=[])

    def test_numbers_follow_everything_counted_here(self):
        """Scenario 2."""
        result = self.bring(self.b, self.archive)
        self.assertEqual(self.writes(), [], "import writes nothing to GitHub")
        self.assertEqual((result["mode"], result["into_project"]), ("join", "team-space"))
        self.assertEqual(self.pairs(result, "EPIC"), {"EPIC-001": "EPIC-004", "EPIC-002": "EPIC-005"})
        self.assertEqual(self.pairs(result, "SLICE"), {"SLICE-001": "SLICE-013", "SLICE-002": "SLICE-014", "SLICE-003": "SLICE-015",
                                                       "SLICE-004": "SLICE-016", "SLICE-007": "SLICE-017"})
        self.assertEqual(self.pairs(result, "PP"), {"PP-01": "PP-04", "PP-02": "PP-05"})
        self.assertEqual(self.pairs(result, "TN"), {"TN-01": "TN-03"})
        self.assertEqual(self.pairs(result, "IDEA"), {"IDEA-001": "IDEA-002"})
        self.assertEqual(self.pairs(result, "PRD"), {"PRD-01": "PRD-01"})
        self.assertEqual(self.pairs(result, "DES"), {"DES-01": "DES-01"})
        counted = result["numbers_counted"]
        self.assertEqual((counted["SLICE"]["highest_used"], counted["SLICE"]["github_read"], counted["SLICE"]["origin_main_read"]), (12, True, True))
        self.assertEqual(counted["EPIC"]["highest_used"], 3)
        for slice_id in ("SLICE-013", "SLICE-014", "SLICE-015", "SLICE-016"):
            self.assertEqual(self.work(self.b, slice_id)["project_id"], "team-space")
        for epic_id in ("EPIC-004", "EPIC-005"):
            self.assertEqual(self.artifact(self.b, f"product/epics/{epic_id}.json")["project_id"], "team-space")
        self.assertEqual(self.artifact(self.b, "product/principles.json")["project_id"], "team-space")
        self.assertTrue(self.ok(self.b, "validate")["valid"])
        self.assertEqual(result["structural_errors"], [])
        self.assertEqual(self.artifact(self.b, "product/needs.json")["none"], [], "joining never merges the incoming 'nothing to say'")

    def test_every_reference_is_rewritten(self):
        """Scenario 3: records, text, file names, pointers (one to a reserved ID with no slice), principle rows, rules, made, applied, against."""
        self.bring(self.b, self.archive)
        b = self.b
        self.assertEqual(self.work(b, "SLICE-014")["dependencies"], ["SLICE-013"])
        self.assertEqual(self.work(b, "SLICE-014")["epic_id"], "EPIC-004")
        self.assertEqual(self.work(b, "SLICE-013")["spec_path"], "specs/slices/SLICE-013-invite-teammate.md")
        self.assertEqual(self.work(b, "SLICE-013")["status"], "draft")
        self.assertIsNone(self.work(b, "SLICE-013")["spec_sha256"])
        self.assertEqual(self.work(b, "SLICE-016")["small"]["shipped_rule"], "SLICE-013/FR-02")
        self.assertEqual(self.work(b, "SLICE-015")["serves"]["idea"], "IDEA-002")
        spec = self.text(b, "specs/slices/SLICE-013-invite-teammate.md")
        self.assertTrue(spec.startswith("# SLICE-013: "))
        self.assertIn("(Deferred to SLICE-017)", spec)
        self.assertIn("**PP-04** (revision 1)", spec)
        self.assertNotIn("SLICE-001", spec)
        self.assertIn("| SLICE-013/FR-02 | kept |", self.text(b, "specs/slices/SLICE-015-invite-teammate.md"))
        why = self.text(b, "product/intents/SLICE-014.md")
        self.assertIn("- **Slice:** SLICE-014 at specs/slices/SLICE-014-invite-teammate.md", why)
        self.assertIn("- **Epic:** EPIC-004: Team membership", why)
        self.assertFalse(self.draft(b, "product/slices/SLICE-017.json").exists(), "a reserved ID gets a number, not a slice")
        idea = self.artifact(b, "product/ideas/IDEA-002.json")
        self.assertEqual(idea["made"], {"epics": ["EPIC-005"], "slices": ["SLICE-015"]})
        self.assertEqual(idea["route"]["details"], {"made_from": "EPIC-005"})
        self.assertEqual(self.artifact(b, "product/ideas/IDEA-002.map.json")["applied"], {"epics": {"E1": "EPIC-005"}, "slices": {"B1": "SLICE-015"}})
        self.assertEqual(self.artifact(b, "product/prds/PRD-01/map.json")["applied"]["slices"], {"M1": "SLICE-014"})
        self.assertEqual(self.artifact(b, "product/prds/PRD-01/answers/M1.json")["slice_id"], "SLICE-014")
        self.assertEqual(self.artifact(b, "product/designs/DES-01/map.json")["conflicts"][0]["against"], "PP-04")
        self.assertEqual(self.draft(b, "product/prds/PRD-01/document.md").read_bytes(), DOC.encode(), "a document is never rewritten")
        self.assertEqual(self.artifact(b, "product/epics/EPIC-005.json")["serves"]["idea"], "IDEA-002")
        principles = {p["id"]: p for p in self.artifact(b, "product/principles.json")["principles"]}
        self.assertEqual(principles["PP-05"]["statement"], "Every message SHALL use words a member knows, as PP-04 does.")
        self.assertEqual(self.ledger(b)["order"]["EPIC-004"]["slices"], ["SLICE-014", "SLICE-013", "SLICE-016"])
        session = json.loads((b / ".factory/studio/session.json").read_text())
        self.assertEqual(session["notes"]["SLICE-013"]["note"], "Stopped at SLICE-014's question.")

    def test_an_idea_s_verdict_is_stale_when_its_brief_was_rewritten(self):
        """Scenario 7."""
        result = self.bring(self.b, self.archive)
        ideas = shape.Ideas(studio, studio.Studio(self.b))
        record = ideas.load("IDEA-002")
        self.assertIn("- Capabilities: Bulk invites (EPIC-005)", ideas.brief_text("IDEA-002"))
        view = shape.verdict_view(record, shape.current_brief_sha(ideas, "IDEA-002"))
        self.assertTrue(view["stale"])
        self.assertIn("The brief changed after this verdict was recorded", view["stale_note"])
        self.assertIsNone(record["verdict"]["by"])
        self.assertTrue(any("The verdict on IDEA-002 no longer holds" in line for line in result["after"]), result["after"])

    def test_principles_arrive_unpublished_and_ready_waits_for_them(self):
        """Scenario 8."""
        result = self.bring(self.b, self.archive)
        listed = self.ok(self.b, "principle", "list")
        self.assertEqual([p["id"] for p in listed["principles"]], ["PP-01", "PP-02", "PP-03", "PP-04", "PP-05"])
        self.assertIn("Publish the principles before any slice can be marked ready: 2 came with the project.", result["after"])
        self.assertEqual(result["same_principles"][0]["words"], "PP-04 says the same as PP-02; retire one if they are the same.")
        refused = self.refused(self.b, "slice", "ready", "SLICE-014")
        self.assertIn("the product principles have changes that are not published", refused)
        self.assertEqual(self.writes(), [])

    def test_rules_shipped_in_the_old_repository_are_listed_and_checked(self):
        """Scenario 16."""
        planned = self.plan(self.b, self.archive)
        rows = {(row["of"], row["where"]): row for row in planned["shipped_rules"]}
        self.assertEqual(rows[("SLICE-015", "effects")]["rule"], "SLICE-013/FR-02")
        self.assertEqual(rows[("SLICE-016", "small")]["rule"], "SLICE-013/FR-02")
        self.assertIn("1 slice names shipped rules of the old repository under 'Effects on shipped behaviour' (SLICE-015); "
                      "each needs those rows answered again here.", planned["after"])
        self.assertTrue(any(line.startswith("SLICE-016 is a small change to SLICE-013/FR-02") for line in planned["after"]))
        self.bring(self.b, self.archive)
        _, out, _ = self.run_studio(self.b, "slice", "check", "SLICE-015")
        self.assertIn("SLICE-013/FR-02 is not in any shipped spec: no spec of SLICE-013 has shipped. [effects-not-shipped]", out)

    def test_the_plan_writes_nothing_and_the_import_says_when_numbers_moved(self):
        """Scenario 14."""
        before = draft_tree(self.b)
        planned = self.plan(self.b, self.archive)
        self.assertEqual((planned["plan"], planned["writes"], planned["factory_authorized"]), (True, "nothing", False))
        self.assertEqual(draft_tree(self.b), before, "the plan writes nothing to the draft")
        self.assertEqual(self.writes(), [])
        self.assertTrue(planned["note"].startswith("Would bring in 4 slices in 2 epics from the project 'Lending'."), planned["note"])
        self.github_issue("mach:slice", issue_rules.slice_marker("SLICE-013", 1, 2, [], "a" * 64, "b" * 64) + "body")  # someone took SLICE-013
        result = self.bring(self.b, self.archive)
        self.assertEqual(self.pairs(result, "SLICE")["SLICE-001"], "SLICE-014")
        self.assertIn({"id": "SLICE-001", "planned": "SLICE-013", "now": "SLICE-014"}, result["numbers_moved"])
        self.assertIn("The numbers moved since the plan: ", result["note"])

    def test_the_plan_s_map_is_the_import_s_when_nothing_changed(self):
        planned = self.plan(self.b, self.archive)
        result = self.bring(self.b, self.archive)
        self.assertEqual(planned["map"], result["map"])
        self.assertEqual(result["numbers_moved"], [])
        self.assertFalse((self.b / ".factory/studio/imports" / f"{sha(self.archive.read_bytes())[:16]}.plan.json").exists())

    def test_check_by_hand_and_not_in_archive(self):
        files, facts = lending()
        spec = files["workspace/specs/slices/SLICE-002-invite-teammate.md"].decode()
        spec += "\n```\nSLICE-001 as an example\n```\nSee `EPIC-002` and SLICE-200.\n"
        files["workspace/specs/slices/SLICE-002-invite-teammate.md"] = spec.encode()
        archive = write_archive(self.archives / "coded.zip", files, facts)
        planned = self.plan(self.b, archive)
        coded = [(row["file"], row["id"]) for row in planned["check_by_hand"]]
        self.assertIn(("specs/slices/SLICE-014-invite-teammate.md", "SLICE-001"), coded)
        self.assertIn(("specs/slices/SLICE-014-invite-teammate.md", "EPIC-002"), coded)
        missing = [row for row in planned["not_in_archive"] if row["id"] == "SLICE-200"]
        self.assertEqual(missing[0]["here"], "SLICE-200 is not used in this repository yet; whatever is given that number here will be a "
                                             "different item from the one the text meant")
        self.assertIsInstance(missing[0]["line"], int)


# ---- scenarios 17 and 18: a new project whose numbers clash, the same project twice ----


class NewProjectTest(ImportBase):
    def test_a_new_project_with_a_clashing_number_is_numbered_on(self):
        """Scenario 18: no project here, but specs/slices/SLICE-001-x.md on main."""
        (self.b / "specs" / "slices").mkdir(parents=True)
        (self.b / "specs/slices/SLICE-001-x.md").write_text("# SLICE-001: An engineer's own\n")
        git(self.b, "add", "-A")
        git(self.b, "commit", "-q", "-m", "an engineer's slice")
        archive = self.hand_archive()
        planned = self.plan(self.b, archive)
        self.assertEqual(planned["mode"], "new")
        self.assertEqual(self.pairs(planned, "SLICE")["SLICE-001"], "SLICE-002")
        self.assertEqual(self.pairs(planned, "EPIC"), {"EPIC-001": "EPIC-001", "EPIC-002": "EPIC-002"})
        self.assertEqual(planned["why_numbered"], ["SLICE-001 is already used in this repository, so every slice that comes in takes the next "
                                                   "free number, from SLICE-002."])
        result = self.bring(self.b, archive)
        self.assertEqual(result["into_project"], "lending")
        self.assertTrue(self.ok(self.b, "validate")["valid"])
        self.assertEqual(self.work(self.b, "SLICE-002")["title"], "Invite a teammate")

    def test_a_new_project_keeps_its_ids_and_its_verdict(self):
        archive = self.hand_archive()
        result = self.bring(self.b, archive)
        self.assertFalse(result["renumbered"])
        ideas = shape.Ideas(studio, studio.Studio(self.b))
        self.assertTrue(shape.verdict_holds(ideas.load("IDEA-001"), shape.current_brief_sha(ideas, "IDEA-001")))
        self.assertEqual(self.artifact(self.b, "product/needs.json")["none"], ["never"])
        self.assertEqual(self.work(self.b, "SLICE-001")["status"], "draft")
        self.assertIn("in the old repository 1 was shipped, 1 was being built and 1 was ready to build.", result["note"])

    def test_a_superseded_slice_stays_superseded(self):
        files, facts = lending()
        work = json.loads(files["workspace/product/slices/SLICE-004.json"])
        work["status"] = "superseded"
        files["workspace/product/slices/SLICE-004.json"] = canonical(work)
        facts["slices"]["SLICE-004"] = {"was": "superseded", "revision": 1, "jira": None, "request": None, "note": None}
        result = self.bring(self.b, write_archive(self.archives / "replaced.zip", files, facts))
        self.assertEqual(self.work(self.b, "SLICE-004")["status"], "superseded")
        self.assertEqual(result["superseded"], ["SLICE-004"])
        self.assertIn("except 1 slice replaced in the old repository, which stays replaced", result["note"])

    def test_the_same_project_twice_is_refused(self):
        """Scenario 17."""
        self.ok(self.b, "project", "init", "--id", "lending", "--name", "Lending", "--vision", "v", "--outcome", "o")
        self.refused_import(self.b, self.hand_archive(), "The archive is of the project 'lending', which is already here. "
                                                         "Importing it would make a second copy of every epic and slice. Nothing was changed.")

    def test_paths_are_studio_s_own(self):
        here = studio.Studio(self.b)
        self.assertEqual(here.draft / project_import.rel_epic("EPIC-004"), here.path("epic", "EPIC-004"))
        self.assertEqual(here.draft / project_import.rel_slice("SLICE-004"), here.path("slice", "SLICE-004"))
        self.assertEqual(here.draft / project_import.rel_intent("SLICE-004"), here.intent_path("SLICE-004"))
        self.assertEqual((here.draft / project_import.rel_mock("SLICE-004", "a" * 64, ".png")).parent, mocks.folder(here, "SLICE-004"))
        ideas = shape.Ideas(studio, here)
        for part, path in (("idea", ideas.path), ("lookups", ideas.lookups_path), ("idea_map", ideas.map_path), ("brief", ideas.brief_path),
                           ("case", ideas.case_path)):
            self.assertEqual(here.draft / project_import.rel_idea("IDEA-004", part), path("IDEA-004"))
        self.assertEqual((here.draft / project_import.rel_document("PRD", "PRD-04", "prd.json")).parent, prd.Prds(studio, here).folder("PRD-04"))
        self.assertEqual((here.draft / project_import.rel_document("DES", "DES-04", "import.json")).parent, design.Designs(studio, here).folder("DES-04"))
        self.assertEqual(here.draft / project_import.PRINCIPLES_REL, here.principles_path)
        self.assertEqual(here.draft / project_import.NEEDS_REL, needs.path(here))


# ---- scenarios 6, 11 and 13: stopping half-way and running again ----


def product_valid(project):
    import product
    return product.validate_workspace(project / ".factory/studio/draft")["valid"]


class HalfWayTest(ImportBase):
    maxDiff = None

    def setUp(self):
        super().setUp()
        self.archive = self.hand_archive()
        self.placed = []
        self.real_place = project_import._place

    def counting(self, fail_at=None, check=None):
        def place(source, target):
            if check:
                check(target)
            if fail_at is not None and fail_at(target):
                raise OSError(28, "No space left on device")
            self.placed.append(target)
            self.real_place(source, target)
        return mock.patch.object(project_import, "_place", place)

    def stopped(self, project, fail_at=None, check=None):
        with self.counting(fail_at, check), self.assertRaises(studio.StudioError) as caught:
            self.bring(project, self.archive)
        return str(caught.exception)

    def finish(self, project):
        with self.counting():
            return self.bring(project, self.archive)

    def test_a_dependent_slice_waits_and_the_workspace_is_whole_at_each_step(self):
        """Scenario 6: stopped between SLICE-001 and SLICE-002, which depends on it; the workspace is consistent at that moment."""
        seen = []

        def check(target):
            if target.name == "SLICE-002.json":
                seen.append(product_valid(self.b))

        message = self.stopped(self.b, fail_at=lambda target: target.name == "SLICE-002.json", check=check)
        self.assertEqual(message, "Bringing in stopped part way: no space left on device. Run it again with the same file; "
                                  "nothing already brought in is repeated.")
        self.assertEqual(seen, [True])
        self.assertTrue(self.draft(self.b, "product/slices/SLICE-001.json").exists())
        self.assertFalse(self.draft(self.b, "product/slices/SLICE-002.json").exists())
        self.assertTrue(product_valid(self.b))
        self.finish(self.b)
        self.assertTrue(product_valid(self.b))

    def half_way(self, fail_at, after_order=False):
        if after_order:
            with self.counting(), mock.patch.object(project_import, "place_notes", side_effect=OSError(5, "Input/output error")), \
                    self.assertRaises(studio.StudioError):
                self.bring(self.b, self.archive)
        else:
            self.stopped(self.b, fail_at=fail_at)
        here = studio.Studio(self.b)
        waiting = project_import.unfinished(here)
        self.assertEqual(waiting["file"], "lending.zip")
        self.assertEqual(waiting["text"], "Bringing in the project from lending.zip stopped part way. Run it again with the same file to finish, "
                                          "or set it aside.")
        self.assertIsNone(self.record(self.b, self.archive)["finished_at"])
        self.assertEqual(project_import.reserved_numbers(here, "SLICE"), [1, 2, 3, 4, 7])
        self.assertEqual(project_import.reserved_numbers(here, "IDEA"), [1])
        # Every allocator piece D reaches skips the reserved numbers (Studio.next_id and next_principle_id are piece E's to wire).
        self.assertEqual(shape.Ideas(studio, here).next_id(), "IDEA-002")
        self.assertEqual(needs.next_id(here, []), "TN-02")
        self.assertEqual(self.ok(self.b, "prd", "import", self.file("other.md", "# Other\n\nText.\n"))["prd"]["prd_id"], "PRD-02")
        # Another archive is refused while this one is unfinished.
        other = self.hand_archive("other.zip", project_id="other-project")
        self.refused_import(self.b, other, "Bringing in lending.zip stopped part way. Finish it first: run the import again with that file, "
                                           "or set it aside. Nothing was changed.")
        self.set_gh(calls=[])
        result = self.finish(self.b)
        self.assertTrue(result["resumed"])
        self.assertIsNone(project_import.unfinished(here))
        return result

    def check_whole(self):
        self.bring(self.eng, self.archive)  # a clean import elsewhere, for comparison
        clean = draft_tree(self.eng)
        mine = draft_tree(self.b)
        mine.pop("product/prds/PRD-02/prd.json")
        mine.pop("product/prds/PRD-02/document.md")
        self.assertEqual(mine, clean)
        names = [p.relative_to(self.b / ".factory/studio/draft").as_posix() for p in self.placed if self.b in p.parents]
        self.assertEqual(len(names), len(set(names)), "each file was placed once")
        self.assertEqual(sorted(names), sorted(self.record(self.b, self.archive)["targets"]))
        again = self.bring(self.b, self.archive)
        self.assertTrue(again["already"])
        self.assertTrue(again["note"].startswith("Already brought in on 20"), again["note"])
        self.assertTrue(again["note"].endswith(" Nothing was changed."))
        self.assertEqual(self.writes(), [])
        self.assertFalse((self.b / ".factory/studio/imports" / sha(self.archive.read_bytes())[:16]).exists(), "staging removed")

    def test_stopped_after_the_epics(self):
        """Scenario 11: stopped after the epics (at the first spec), after half the slices, and after the order."""
        self.half_way(lambda target: target.parent.name == "slices" and target.parent.parent.name == "specs")
        self.check_whole()

    def test_stopped_after_half_the_slices(self):
        self.half_way(lambda target: target.name == "SLICE-003.json")
        self.check_whole()

    def test_stopped_after_the_order(self):
        result = self.half_way(None, after_order=True)
        self.assertEqual(result["placed"].get("notes"), 1)
        self.assertGreater(result["already_there"], 0)
        self.check_whole()

    def test_a_file_placed_by_something_else_stops_the_import(self):
        """Nothing of SLICE-002 was placed yet: a work order of that number is another slice's, and renumbering it is the way on."""
        self.stopped(self.b, fail_at=lambda target: target.name == "EPIC-002.json")
        self.write_json_in(self.b, "product/slices/SLICE-002.json", {
            "schema_version": 1, "slice_id": "SLICE-002", "project_id": "lending", "epic_id": "EPIC-001", "revision": 1, "title": "Someone else's",
            "status": "draft", "dependencies": [], "open_questions": [], "spec_path": None, "spec_sha256": None})
        with self.assertRaises(studio.StudioError) as caught:
            self.bring(self.b, self.archive)
        self.assertEqual(str(caught.exception), "Bringing in stopped: SLICE-002 is now used by another slice here (product/slices/SLICE-002.json), "
                                                "made after the numbers were given out. Give that slice a new number (slice renumber SLICE-002), "
                                                "then run the import again with the same file.")
        self.assertIsNotNone(project_import.unfinished(studio.Studio(self.b)), "the record stays")

    def test_a_stray_file_of_one_of_the_import_s_own_slices_is_never_renumbering_advice(self):
        """SLICE-002's spec and why were placed before the stop: SLICE-002 is the import's own, so a work order of that number that
        is not the import's is a stray file to move, never a slice to renumber."""
        self.stopped(self.b, fail_at=lambda target: target.name == "SLICE-002.json")
        self.write_json_in(self.b, "product/slices/SLICE-002.json", {
            "schema_version": 1, "slice_id": "SLICE-002", "project_id": "lending", "epic_id": "EPIC-001", "revision": 1, "title": "Someone else's",
            "status": "draft", "dependencies": [], "open_questions": [], "spec_path": None, "spec_sha256": None})
        with self.assertRaises(studio.StudioError) as caught:
            self.bring(self.b, self.archive)
        message = str(caught.exception)
        self.assertEqual(message, "Bringing in stopped: product/slices/SLICE-002.json is in the workspace but is not the file this import brings "
                                  "in for SLICE-002, which came with the project. Move that file out of the workspace, then run the import "
                                  "again with the same file.")
        self.assertNotIn("renumber", message)

    def test_another_spec_of_a_given_number_stops_it_too(self):
        self.stopped(self.b, fail_at=lambda target: target.name == "EPIC-001.json")
        self.draft(self.b, "specs/slices").mkdir(parents=True, exist_ok=True)
        self.draft(self.b, "specs/slices/SLICE-004-another.md").write_text("# SLICE-004: Another\n")
        with self.assertRaises(studio.StudioError) as caught:
            self.bring(self.b, self.archive)
        self.assertIn("SLICE-004 is now used by another slice here (specs/slices/SLICE-004-another.md)", str(caught.exception))

    def test_a_file_you_changed_after_it_was_brought_in_is_kept(self):
        """Point 1 of the review: the import stops after placing SLICE-001 (joining Ben's project, so it is SLICE-011); the person edits
        it; the second run keeps their version, counts it as done, says so, and finishes."""
        self.ben_project()
        self.stopped(self.b, fail_at=lambda target: target.name == "SLICE-012.json")
        path = self.draft(self.b, "product/slices/SLICE-011.json")
        work = json.loads(path.read_text())
        work.update(title="Edited by the PM while the import stood unfinished", revision=work["revision"] + 1)
        path.write_text(studio.canonical(work))
        spec = self.draft(self.b, "specs/slices/SLICE-012-invite-teammate.md")
        spec.write_text(spec.read_text() + "\nAdded by the PM.\n")
        result = self.finish(self.b)
        self.assertTrue(result["imported"])
        self.assertEqual(self.work(self.b, "SLICE-011")["title"], "Edited by the PM while the import stood unfinished")
        self.assertTrue(self.text(self.b, "specs/slices/SLICE-012-invite-teammate.md").endswith("\nAdded by the PM.\n"))
        self.assertEqual([(row["file"], row["how"]) for row in result["kept_yours"]],
                         [("specs/slices/SLICE-012-invite-teammate.md", "yours"), ("product/slices/SLICE-011.json", "yours")])
        self.assertIn("You changed SLICE-011's work order after it was brought in; your version was kept.", result["note"])
        self.assertIn("You changed SLICE-012's spec after it was brought in; your version was kept.", result["note"])
        self.assertIsNone(project_import.unfinished(studio.Studio(self.b)))
        self.assertTrue(self.ok(self.b, "validate")["valid"])
        record = self.record(self.b, self.archive)
        self.assertIn("product/slices/SLICE-011.json", record["placed"])
        self.assertEqual(record["kept_yours"], ["specs/slices/SLICE-012-invite-teammate.md", "product/slices/SLICE-011.json"])

    def test_a_slice_renumbered_while_the_import_stood_is_not_brought_in_again(self):
        """The earlier advice, followed: the PM renumbered one of the import's own slices. The import finishes and does not bring
        the old number back."""
        self.ben_project()
        self.stopped(self.b, fail_at=lambda target: target.name == "SLICE-012.json")
        self.ok(self.b, "slice", "renumber", "SLICE-011")
        result = self.finish(self.b)
        self.assertTrue(result["imported"])
        self.assertFalse(self.draft(self.b, "product/slices/SLICE-011.json").exists())
        gone = [row for row in result["kept_yours"] if row["how"] == "gone"]
        self.assertIn("SLICE-011's work order was brought in, then moved or removed here; MACH did not bring it in again.",
                      [row["words"] for row in gone])
        self.assertIsNone(project_import.unfinished(studio.Studio(self.b)))

    def test_an_unfinished_import_can_be_set_aside(self):
        """What it placed stays exactly where it is and is listed; its numbers are free; staging, the log and the plan are gone; the
        record is kept, renamed; a second setting aside finds nothing."""
        self.ben_project()
        self.plan(self.b, self.archive)
        self.stopped(self.b, fail_at=lambda target: target.name == "SLICE-012.json")
        here = studio.Studio(self.b)
        before = draft_tree(self.b)
        result = project_import.set_aside(studio, here, None)
        self.assertEqual(draft_tree(self.b), before, "every file already placed stays exactly where it is")
        ids = [row["id"] for row in result["brought_in"]]
        for ident in ("EPIC-003", "EPIC-004", "SLICE-011", "SLICE-012", "IDEA-002", "PP-04", "TN-03", "PRD-01", "DES-01"):
            self.assertIn(ident, ids)
        partly = next(row for row in result["brought_in"] if row["id"] == "SLICE-013")
        self.assertEqual(partly["files"], ["product/intents/SLICE-013.md", "specs/slices/SLICE-013-invite-teammate.md"], "its work order never came")
        row = next(row for row in result["brought_in"] if row["id"] == "SLICE-011")
        self.assertEqual(row["was"], "SLICE-001")
        self.assertEqual(row["files"], ["product/intents/SLICE-011.md", "product/slices/SLICE-011.json", "specs/slices/SLICE-011-invite-teammate.md"])
        self.assertTrue(result["note"].startswith("MACH stopped bringing in the project from lending.zip and set it aside. What it had already "
                                                  "brought in stays where it is: "), result["note"])
        self.assertTrue(result["note"].endswith("Keep them, or remove them if you do not want them. The numbers it was holding are free "
                                                "again, and nothing else was changed."), result["note"])
        self.assertIsNone(project_import.unfinished(here))
        self.assertEqual(project_import.reserved_numbers(here, "SLICE"), [])
        names = sorted(p.name for p in (self.b / ".factory/studio/imports").iterdir())
        self.assertEqual(len(names), 1)
        self.assertRegex(names[0], r"^[0-9a-f]{16}\.set-aside-[0-9]{8}T[0-9]{6}Z\.json$")
        kept = json.loads((self.b / ".factory/studio/imports" / names[0]).read_text())
        self.assertIsNotNone(kept["set_aside_at"])
        self.assertIn("product/slices/SLICE-011.json", kept["placed"])
        with self.assertRaises(studio.StudioError) as caught:
            project_import.set_aside(studio, here, None)
        self.assertEqual(str(caught.exception), "No project is part way through being brought in here, so there is nothing to set aside. "
                                                "Nothing was changed.")
        other = self.hand_archive("other.zip", project_id="other-project")
        self.assertTrue(self.plan(self.b, other)["plan"], "another import is no longer blocked")

    def test_the_lookup_of_what_an_id_was_or_became(self):
        self.ben_project()
        self.bring(self.b, self.archive)
        here = studio.Studio(self.b)
        found = project_import.lookup(here, "SLICE-002")
        self.assertEqual([row["words"][:len("SLICE-002 of 'Lending' is SLICE-012 here (brought in on ")] for row in found["found"]],
                         ["SLICE-002 of 'Lending' is SLICE-012 here (brought in on "])
        became = project_import.lookup(here, "SLICE-012")
        self.assertTrue(became["found"][0]["words"].startswith("SLICE-012 here was SLICE-002 of 'Lending' (brought in on "))
        listed = project_import.lookup(here, None)
        self.assertEqual(listed["imports"][0]["from_project"], "lending")
        self.assertEqual(listed["imports"][0]["counts"]["SLICE"], 5)
        with self.assertRaises(studio.StudioError):
            project_import.lookup(here, "not-an-id")


# ---- what the review found: every record readable after import, links to what did not come, sets with answers beside items ----


REAL_LOOKUPS = {"schema_version": 1, "idea_id": "IDEA-001", "recorded_at": TIME, "shipped_commit": "a" * 40,
                "shipped_rules": [{"rule": "SLICE-001/FR-02", "in_force": True, "epic_id": "EPIC-001", "note": "The rule to change."}],
                "similar": [{"request": 42, "note": "Asked for"}, {"idea": "IDEA-001", "note": "Itself"}],
                "principles": [{"id": "PP-01", "status": "active", "note": "Versions stay"}],
                "policies": [{"id": "POL-sec-01", "owner": "Security", "note": "Applies"}]}


class ReadersTest(ImportBase):
    """After an import, every reader in Studio can read every record it brought in; a record a reader could not handle is
    refused before anything is placed."""
    maxDiff = None

    READS = (("status",), ("validate",), ("idea", "list"), ("idea", "show", "IDEA-001"), ("idea", "map-status", "IDEA-001"),
             ("idea", "chain", "IDEA-001"), ("prd", "list"), ("prd", "show", "PRD-01"), ("prd", "status", "PRD-01"), ("design", "list"),
             ("design", "show", "DES-01"), ("need", "list"), ("principle", "list"), ("slice", "show", "SLICE-001"),
             ("slice", "show", "SLICE-003"), ("slice", "check", "SLICE-002"))

    def read_everything(self, project, rename=None):
        for argv in self.READS:
            argv = tuple((rename or {}).get(word, word) for word in argv)
            code, out, err = self.run_studio(project, *argv)
            self.assertNotIn("Traceback", err, argv)
            if argv[:2] != ("slice", "check"):
                self.assertEqual(code, 0, f"{argv}: {err}{out}")
            json.loads(out) if code == 0 and argv[:2] != ("slice", "check") else None

    def test_a_real_export_brought_in_is_read_by_every_command(self):
        archive = self.real_archive()
        self.bring(self.b, archive)
        self.read_everything(self.b)
        prds = self.ok(self.b, "prd", "status", "PRD-01")
        self.assertTrue(prds["coverage"])

    def test_a_joined_project_is_read_by_every_command(self):
        self.ben_project()
        files, facts = lending(extra={"product/ideas/IDEA-001.lookups.json": REAL_LOOKUPS})
        result = self.bring(self.b, write_archive(self.archives / "full.zip", files, facts))
        self.read_everything(self.b, {"IDEA-001": "IDEA-002", "SLICE-001": "SLICE-011", "SLICE-002": "SLICE-012", "SLICE-003": "SLICE-013"})
        self.assertEqual(self.pairs(result, "IDEA"), {"IDEA-001": "IDEA-002"})
        lookups = self.artifact(self.b, "product/ideas/IDEA-002.lookups.json")
        self.assertEqual(lookups["idea_id"], "IDEA-002", "the lookups' own idea is renumbered with the idea")
        self.assertNotIn("shipped_commit", lookups, "a commit of the old repository never arrives")
        self.assertEqual(lookups["shipped_rules"][0]["rule"], "SLICE-011/FR-02")
        self.assertEqual(lookups["similar"], [{"idea": "IDEA-002", "note": "Itself"}])
        self.assertEqual(self.ok(self.b, "idea", "show", "IDEA-002")["lookups"]["counts"],
                         {"shipped_rules": 1, "similar": 1, "principles": 1, "policies": 1})

    def test_a_prd_whose_sections_an_archive_made_up_is_read_from_its_document(self):
        files, facts = lending()
        meta = json.loads(files["workspace/product/prds/PRD-01/prd.json"])
        meta["sections"] = [{"n": 1}]
        files["workspace/product/prds/PRD-01/prd.json"] = canonical(meta)
        self.bring(self.b, write_archive(self.archives / "sections.zip", files, facts))
        sections = self.artifact(self.b, "product/prds/PRD-01/prd.json")["sections"]
        self.assertEqual([s["title"] for s in sections], ["Plan", "Scope"])
        self.assertEqual(self.ok(self.b, "prd", "status", "PRD-01")["prd"]["sections"], 2)
        self.read_everything(self.b)

    def refused_record(self, change, words):
        files, facts = lending()
        change(files)
        message = self.refused_import(self.b, write_archive(self.archives / "odd.zip", files, facts), mock.ANY)
        self.assertIn(words, message)
        self.assertFalse(self.draft(self.b, "product").exists(), "nothing was placed")

    def edit(self, member, update):
        def change(files):
            name = "workspace/" + member
            record = json.loads(files[name])
            update(record)
            files[name] = canonical(record)
        return change

    def test_each_kind_a_reader_could_not_read_is_refused_before_anything_is_placed(self):
        cases = {
            "an idea": (self.edit("product/ideas/IDEA-001.json", lambda r: r.update(made={"epics": "EPIC-002", "slices": []})),
                        "holds an idea that is not in the form Product Studio writes (IDEA-001: "),
            "an idea's map": (self.edit("product/ideas/IDEA-001.map.json", lambda r: r["slices"][0].pop("cites")),
                              "(IDEA-001: a slice of its map does not cite the lines it rests on)"),
            "an idea's map's outcomes": (self.edit("product/ideas/IDEA-001.map.json", lambda r: r["slices"][0].pop("outcomes")),
                                         "its outcomes are not the brief's outcomes"),
            "lookups": (lambda files: files.update({"workspace/product/ideas/IDEA-001.lookups.json": canonical(
                            {**REAL_LOOKUPS, "similar": [{"idea": "IDEA-001", "note": "x", "extra": {"a": 1}}]})}),
                        "an entry of similar holds extra, which Shape never writes"),
            "a PRD map": (self.edit("product/prds/PRD-01/map.json", lambda r: r["slices"][0].pop("cites")),
                          "(PRD-01: a slice of its map does not cite the lines it rests on)"),
            "a PRD map's settlement": (self.edit("product/prds/PRD-01/map.json", lambda r: r.update(settled={"2": {"as": "later", "by": "x"}})),
                                       "the settlement of 2 holds fields Product Studio never writes"),
            "a PRD map's section number": (self.edit("product/prds/PRD-01/map.json", lambda r: r.update(settled={"two": {"as": "later"}})),
                                           "it settles 'two', which is not one of its document's parts"),
            "a PRD's answers": (self.edit("product/prds/PRD-01/answers/M1.json",
                                          lambda r: r.update(answers=[{"n": 1, "kind": "guess", "question": "Q?", "answer": None, "cites": [],
                                                                       "state": "pending"}])),
                                "its answers for M1 are not in the form Product Studio writes"),
            "a design map": (self.edit("product/designs/DES-01/map.json", lambda r: r.update(topics={"storage": {"lines": [[1, 1]]}})),
                             "its map's topic storage has no state Product Studio knows"),
            "a design conflict": (self.edit("product/designs/DES-01/map.json", lambda r: r["conflicts"][0].pop("lines")),
                                  "a conflict in its map is not in the form Product Studio writes"),
            "a need": (self.edit("product/needs.json", lambda r: r["needs"][0].pop("statement")), "holds the technical needs that is not in the form"),
            "a principle": (self.edit("product/principles.json", lambda r: r["principles"][0].update(id="PP-1")), "holds the principles that is not in the form"),
            "a slice": (self.edit("product/slices/SLICE-003.json", lambda r: r.update(serves={"idea": "IDEA-001"})), "holds a slice that is not in the form"),
            "an epic": (self.edit("product/epics/EPIC-001.json", lambda r: r.update(acceptance_criteria="SLICE-001 works")), "holds an epic that is not in the form"),
        }
        for name, (change, words) in cases.items():
            with self.subTest(name):
                self.refused_record(change, words)

    def test_a_deeply_nested_value_is_refused_with_a_sentence(self):
        deep = '{"a":' * 900 + "1" + "}" * 900
        files, facts = lending()
        files["workspace/product/ideas/IDEA-001.lookups.json"] = ('{"principles": [{"id": "PP-01", "note": ' + deep + "}]}").encode()
        message = self.refused_import(self.b, write_archive(self.archives / "deep.zip", files, facts), mock.ANY, plan=True)
        self.assertIn("(IDEA-001: it is nested more deeply than any record Product Studio writes)", message)
        files, facts = lending()
        files["workspace/product/ideas/IDEA-001.json"] = files["workspace/product/ideas/IDEA-001.json"].replace(
            b'"route": {', b'"route": {"deep": ' + deep.encode() + b", ", 1)
        message = self.refused_import(self.b, write_archive(self.archives / "deep2.zip", files, facts), mock.ANY)
        self.assertIn("it is nested more deeply than any record Product Studio writes", message)

    def test_the_archive_is_read_once_and_keyed_to_the_bytes_read(self):
        archive = self.hand_archive()
        original = archive.read_bytes()
        real = project_archive.read_with_sha256

        def read_then_change(path):
            found = real(path)
            Path(path).write_bytes(original + b"changed afterwards")  # the file changes once it has been read
            return found

        with mock.patch.object(project_archive, "read_with_sha256", side_effect=read_then_change) as reader:
            result = self.bring(self.b, archive)
        self.assertEqual(reader.call_count, 1)
        self.assertEqual(result["archive"]["sha256"], sha(original))
        self.assertTrue((self.b / ".factory/studio/imports" / f"{sha(original)[:16]}.json").is_file())
        self.assertEqual(json.loads((self.b / ".factory/studio/imports" / f"{sha(original)[:16]}.json").read_text())["archive_sha256"], sha(original))


class LinksTest(ImportBase):
    """Links to IDs that are not in the archive (an --only-mine export, an item deleted at the source)."""
    maxDiff = None

    def dangling(self):
        files, facts = lending()

        def edit(member, update):
            record = json.loads(files["workspace/" + member])
            update(record)
            files["workspace/" + member] = canonical(record)

        edit("product/ideas/IDEA-001.json", lambda r: r["made"]["slices"].append("SLICE-009"))
        edit("product/slices/SLICE-002.json", lambda r: r.update(serves={"idea": "IDEA-009", "outcomes": ["O-1"]},
                                                                  source={"kind": "prd", "prd_id": "PRD-07", "sha256": "c" * 64,
                                                                          "lines": [[1, 2]], "map_slice": "M9"}))
        edit("product/epics/EPIC-001.json", lambda r: r.update(serves={"idea": "IDEA-009", "outcomes": ["O-1"]}))
        edit("product/prds/PRD-01/map.json", lambda r: (r["applied"]["slices"].update(M2="SLICE-009"),
                                                        r["slices"].append({"key": "M2", "title": "Two", "scope": "Two", "epic": "EPIC-001",
                                                                            "depends_on": ["SLICE-009"], "cites": [[1, 2]]})))
        files["workspace/product/ideas/IDEA-001.lookups.json"] = canonical({**REAL_LOOKUPS, "similar": [{"idea": "IDEA-009", "note": "Gone"}],
                                                                           "principles": [{"id": "PP-09", "status": "active", "note": "Gone"}]})
        name = "workspace/specs/slices/SLICE-002-invite-teammate.md"
        files[name] = files[name] + b"\nSee SLICE-009 for the rest.\n"
        return write_archive(self.archives / "dangling.zip", files, facts)

    def test_joining_takes_out_links_to_what_did_not_come_and_lists_each(self):
        self.ben_project()
        result = self.bring(self.b, self.dangling())
        idea = self.artifact(self.b, "product/ideas/IDEA-002.json")
        self.assertEqual(idea["made"]["slices"], ["SLICE-013"], "Ben's SLICE-009 is not recorded as made by the idea")
        work = self.work(self.b, "SLICE-012")
        self.assertNotIn("serves", work)
        self.assertNotIn("source", work)
        self.assertNotIn("serves", self.artifact(self.b, "product/epics/EPIC-003.json"))
        prd_map = self.artifact(self.b, "product/prds/PRD-01/map.json")
        self.assertEqual(prd_map["applied"]["slices"], {"M1": "SLICE-012"})
        self.assertEqual(prd_map["slices"][1]["depends_on"], [])
        lookups = self.artifact(self.b, "product/ideas/IDEA-002.lookups.json")
        self.assertEqual((lookups["similar"], lookups["principles"]), ([], []))
        dropped = {(row["field"], row["id"], row["how"]) for row in result["links_dropped"]}
        self.assertEqual(dropped, {("made.slices", "SLICE-009", "dropped"), ("serves", "IDEA-009", "cleared"), ("source", "PRD-07", "cleared"),
                                   ("applied.slices", "SLICE-009", "dropped"), ("slice M2's depends_on", "SLICE-009", "dropped"),
                                   ("similar", "IDEA-009", "dropped"), ("principles", "PP-09", "dropped")})
        self.assertEqual([row["file"] for row in result["links_dropped"] if row["id"] == "IDEA-009" and row["field"] == "serves"],
                         ["product/epics/EPIC-003.json", "product/slices/SLICE-012.json"])
        self.assertTrue(any(line.startswith("8 links to things that did not come with the project") for line in result["after"]), result["after"])
        text = next(row for row in result["not_in_archive"] if row["id"] == "SLICE-009")
        self.assertEqual(text["here"], "SLICE-009 in this repository is \"Ben's slice 9\", a different item from the one the text meant")
        self.assertTrue(any("now names whatever has that number here, a different item" in line for line in result["after"]), result["after"])
        self.assertTrue(self.ok(self.b, "validate")["valid"])

    def test_a_new_project_keeps_them_as_written_and_lists_them(self):
        result = self.bring(self.b, self.dangling())
        self.assertFalse(result["renumbered"])
        self.assertEqual(result["links_dropped"], [])
        self.assertIn("SLICE-009", self.artifact(self.b, "product/ideas/IDEA-001.json")["made"]["slices"])
        self.assertEqual(self.work(self.b, "SLICE-002")["serves"]["idea"], "IDEA-009")
        listed = {(row.get("field"), row["id"]) for row in result["not_in_archive"]}
        self.assertTrue({("made.slices[1]", "SLICE-009"), ("serves.idea", "IDEA-009"), ("source.prd_id", "PRD-07"),
                         ("applied.slices.M2", "SLICE-009"), ("similar[0].idea", "IDEA-009")} <= listed, listed)
        self.assertEqual(next(row for row in result["not_in_archive"] if row["id"] == "SLICE-009" and not row.get("field"))["here"],
                         "SLICE-009 is not used in this repository")

    def test_a_link_a_record_cannot_do_without_refuses_before_github_is_read(self):
        """A small change's shipped rule, a map slice's epic and a design conflict's principle cannot be cleared: refused, in
        either mode, with nothing changed (not even Studio's cache of GitHub)."""
        files, facts = lending()
        work = json.loads(files["workspace/product/slices/SLICE-004.json"])
        work["small"]["shipped_rule"] = "SLICE-009/FR-02"
        files["workspace/product/slices/SLICE-004.json"] = canonical(work)
        sentence = ("small.zip cannot be brought in as it is: SLICE-004 is a small change to SLICE-009/FR-02, and SLICE-009 did not come with "
                    "the project, so that rule would be another slice's here. Export it again from the old repository with that item in the "
                    "project. Nothing was changed.")
        self.refused_import(self.b, write_archive(self.archives / "small.zip", files, facts), sentence)
        self.ben_project()
        self.refused_import(self.b, self.archives / "small.zip", sentence)
        files, facts = lending()
        design_map = json.loads(files["workspace/product/designs/DES-01/map.json"])
        design_map["conflicts"][0]["against"] = "PP-09"
        files["workspace/product/designs/DES-01/map.json"] = canonical(design_map)
        message = self.refused_import(self.b, write_archive(self.archives / "against.zip", files, facts), mock.ANY)
        self.assertIn("conflict 1 of DES-01 is against PP-09, which did not come with the project.", message)

    def test_emphasis_and_joined_words_around_an_id_are_rewritten(self):
        self.ben_project()
        files, facts = lending()
        files["workspace/product/intents/SLICE-002.md"] += b"\nThis waits for _SLICE-001_ and __EPIC-001__, see SLICE-001_notes and SLICE-001a.\n"
        result = self.bring(self.b, write_archive(self.archives / "italic.zip", files, facts))
        last = self.text(self.b, "product/intents/SLICE-012.md").splitlines()[-1]
        self.assertEqual(last, "This waits for _SLICE-011_ and __EPIC-003__, see SLICE-011_notes and SLICE-001a.")
        near = [row for row in result["check_by_hand"] if row["file"] == "product/intents/SLICE-012.md"]
        self.assertEqual([(row["id"], row["why"]) for row in near],
                         [("SLICE-001", "SLICE-001 with more letters or digits after it; left as written, though SLICE-001 is now SLICE-011")])


class SetsTest(ImportBase):
    def test_a_new_project_keeps_its_nothing_to_say_answers_on_needs(self):
        files, facts = lending()
        files["workspace/product/needs.json"] = canonical({"schema_version": 1, "project_id": "lending", "none": ["people", "never"], "needs": []})
        self.bring(self.b, write_archive(self.archives / "none.zip", files, facts))
        self.assertEqual(self.artifact(self.b, "product/needs.json"), {"schema_version": 1, "project_id": "lending", "none": ["people", "never"],
                                                                       "needs": []})
        kinds = {row["kind"]: row["nothing_to_say"] for row in self.ok(self.b, "need", "list")["kinds"]}
        self.assertEqual((kinds["people"], kinds["never"], kinds["data"]), (True, True, False))

    def test_joining_keeps_this_project_s_own_answers_and_says_so(self):
        self.ben_project()
        result = self.bring(self.b, self.hand_archive())
        self.assertEqual(self.artifact(self.b, "product/needs.json")["none"], [])
        self.assertEqual(result["needs_none_left_behind"], ["never"])
        self.assertIn("The project's 'nothing to say' answers on technical needs (never) were not brought in: they answered for the other "
                      "project, and this project's own answers stay as they are.", result["after"])


# ---- section 7.2: every refusal, with its sentence; each changes nothing ----


class RefusalTest(ImportBase):
    def test_no_file(self):
        missing = self.archives / "missing.zip"
        self.refused_import(self.b, missing, f"There is no file at {missing}. Nothing was changed.")

    def test_not_an_archive(self):
        path = self.archives / "notes.zip"
        path.write_text("hello")
        self.refused_import(self.b, path, "notes.zip is not a project archive from MACH. Nothing was changed.")

    def test_a_newer_format(self):
        path = self.archives / "newer.zip"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("mach-project.json", json.dumps({"format": "mach-project-archive", "format_version": 2}))
        self.refused_import(self.b, path, "newer.zip was made by a newer MACH (archive format 2). Update MACH here, then import it again. "
                                          "Nothing was changed.")

    def test_unsafe_names(self):
        path = self.archives / "escape.zip"
        with zipfile.ZipFile(self.hand_archive()) as source, zipfile.ZipFile(path, "w") as archive:
            archive.writestr("mach-project.json", source.read("mach-project.json"))
            archive.writestr("../x", "x")
        self.refused_import(self.b, path, "escape.zip is not in a form MACH can read safely: a file in it would be written outside the project (../x). "
                                          "Nothing was changed.")

    def test_changed_since_export(self):
        good = self.hand_archive()
        path = self.archives / "changed.zip"
        with zipfile.ZipFile(good) as source, zipfile.ZipFile(path, "w") as target:
            for info in source.infolist():
                data = source.read(info.filename)
                if info.filename == "workspace/specs/slices/SLICE-002-invite-teammate.md":
                    data = data.replace(b"Invite", b"Invade", 1)
                target.writestr(info, data)
        self.refused_import(self.b, path, "changed.zip has been changed since it was exported: workspace/specs/slices/SLICE-002-invite-teammate.md "
                                          "does not match the archive's own list. Nothing was changed.")

    def test_a_slice_not_in_studio_s_form(self):
        files, facts = lending()
        work = json.loads(files["workspace/product/slices/SLICE-002.json"])
        work["slice_id"] = "SLICE-003"
        files["workspace/product/slices/SLICE-002.json"] = canonical(work)
        path = write_archive(self.archives / "odd.zip", files, facts)
        self.refused_import(self.b, path, "odd.zip holds a slice that is not in the form Product Studio writes "
                                          "(SLICE-002: its slice_id differs from its file name). Nothing was changed.")

    def test_a_spec_whose_title_names_another_slice(self):
        files, facts = lending()
        name = "workspace/specs/slices/SLICE-002-invite-teammate.md"
        files[name] = files[name].replace(b"# SLICE-002:", b"# SLICE-009:", 1)
        path = write_archive(self.archives / "title.zip", files, facts)
        self.refused_import(self.b, path, "title.zip holds a slice that is not in the form Product Studio writes "
                                          "(SLICE-002: its spec's title names SLICE-009, not SLICE-002). Nothing was changed.")

    def test_an_inconsistent_project(self):
        files, facts = lending()
        work = json.loads(files["workspace/product/slices/SLICE-001.json"])
        work["dependencies"] = ["SLICE-002"]
        files["workspace/product/slices/SLICE-001.json"] = canonical(work)
        path = write_archive(self.archives / "cycle.zip", files, facts)
        message = self.refused_import(self.b, path, mock.ANY)
        self.assertIn("dependency cycle", message)

    def test_your_own_workspace_has_problems(self):
        self.ok(self.b, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "v", "--outcome", "o")
        broken = self.draft(self.b, "product/epics/EPIC-001.json")
        broken.parent.mkdir(parents=True, exist_ok=True)
        broken.write_text("{}")
        message = self.refused_import(self.b, self.hand_archive(), mock.ANY)
        self.assertTrue(message.startswith("Your own workspace has problems that must be fixed first: product/epics/EPIC-001.json: "), message)

    def test_a_project_on_github_not_yet_here(self):
        archive = self.hand_archive()
        self.github_issue("mach:project", "<!-- mach:project id=team-space -->\nTeam Space\n")
        self.refused_import(self.b, archive, "This repository already has a project on GitHub (#1), and your workspace does not have it yet. "
                                             "Define the project first, which takes it from GitHub (project init), then bring the archive in; "
                                             "its epics join that project. Nothing was changed.")

    def test_several_projects_on_github(self):
        archive = self.hand_archive()
        self.github_issue("mach:project", "<!-- mach:project id=team-space -->\nTeam Space\n")
        self.github_issue("mach:project", "<!-- mach:project id=team-space -->\nTeam Space\n")
        self.refused_import(self.b, archive, "This repository has several project issues on GitHub (#1, #2). One repository holds one project. "
                                             "Close the one that should not be there, then try again. Nothing was changed.")

    def test_a_supervised_execution(self):
        archive = self.hand_archive()
        with mock.patch.dict(os.environ, {"MACH_EXECUTION_ID": "run-1"}):
            self.refused_import(self.b, archive, "Bringing in a project is a product manager's act; a supervised execution does not do it. "
                                                 "Nothing was changed.")

    def test_the_plan_refuses_the_same_way(self):
        self.ok(self.b, "project", "init", "--id", "lending", "--name", "Lending", "--vision", "v", "--outcome", "o")
        self.refused_import(self.b, self.hand_archive(), "The archive is of the project 'lending', which is already here. "
                                                         "Importing it would make a second copy of every epic and slice. Nothing was changed.", plan=True)

    def test_an_idea_with_a_repository_in_its_source_arrives_moved(self):
        files, facts = lending()
        idea = json.loads(files["workspace/product/ideas/IDEA-001.json"])
        idea.update(source={"kind": "request", "repository": REPO, "number": 42}, issue={"number": 7, "state": "open"})
        idea["verdict"]["by"] = "ada-pm"
        files["workspace/product/ideas/IDEA-001.json"] = canonical(idea)
        archive = write_archive(self.archives / "named.zip", files, facts)
        self.bring(self.b, archive)
        text = self.draft(self.b, "product/ideas/IDEA-001.json").read_text()
        for word in ("acme", "ada-pm"):
            self.assertNotIn(word, text)
        self.assertNotIn("acme", json.dumps(self.record(self.b, archive)))


if __name__ == "__main__":
    unittest.main()
