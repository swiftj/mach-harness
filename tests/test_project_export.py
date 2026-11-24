"""M21 C: `project export`, the whole Product Studio project in one archive that names no repository.

Uses the GitHub stand-in of test_mach_product_issues (IssuesBase): the clone `a` is Ada's, on `acme/team-space`. The
project is built through Studio's own commands where they are cheap (project, epics, slices marked ready on GitHub,
a reopened slice, Jira links, a resume note, a mock, principles, a need, a PRD, a design) and the idea records by hand,
in the form Shape writes them. Export is called as piece E will call it: project_export.export(studio, Studio(root), ...).
Design: docs/mach-next/M21_EXPORT_IMPORT.md, sections 1, 2.1, 2.4, 3, 7.1 and scenarios 1, 12 and 15.
"""

import copy
import hashlib
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "studio" / "scripts"))
from mock_pictures import png  # noqa: E402
from test_mach_product_issues import REPO, IssuesBase  # noqa: E402
import project_archive  # noqa: E402
import project_export  # noqa: E402
import shape  # noqa: E402
import studio  # noqa: E402
import test_mach_product_prd as prd_tests  # noqa: E402
import test_mach_product_design as design_tests  # noqa: E402

BRIEF = "# Bulk invites\n\n## Outcomes\n\n- O-1: Admins bring a whole team in at once.\n"
SHA = hashlib.sha256(BRIEF.encode()).hexdigest()
IDEA = {"schema_version": 1, "idea_id": "IDEA-001", "title": "Let admins invite a whole team", "stage": "decided",
        "source": {"kind": "request", "repository": REPO, "number": 42}, "created": "2026-11-20T10:00:00Z", "revision": 1,
        "brief": {"sha256": SHA, "passes": True, "checked_at": "2026-11-20T11:00:00Z", "ids": {"O-1": "present"}},
        "verdict": {"decision": "go", "reason": "Teams asked for it.", "by": "ada-pm", "at": "2026-11-21T10:00:00Z", "brief_sha256": SHA, "revision": 1},
        "route": None, "made": {"epics": ["EPIC-002"], "slices": ["SLICE-003"]},
        "lookback": {"outcomes": {"O-1": {"result": "met", "note": "Teams use it.", "by": "ben-pm", "at": "2026-11-22T10:00:00Z",
                                          "comment": {"posted": True, "issue": 7}}}, "assumptions": {}},
        "issue": {"number": 7, "state": "open"}}
FAULT_IDEA = {"schema_version": 1, "idea_id": "IDEA-002", "title": "Invitations fail at night", "stage": "new",
              "source": {"kind": "fault", "ticket": "AUTO-20261120T101500Z"}, "created": "2026-11-20T10:00:00Z", "revision": 0,
              "brief": None, "verdict": None, "route": None, "made": None, "lookback": None, "issue": None}
LOOKUPS = {"shipped_rules": [], "similar": [{"request": 42, "note": "The same ask"}, {"idea": "IDEA-002", "note": "Close to it"}],
           "principles": [], "policies": []}
IDEA_MAP = {"schema_version": 1, "idea_id": "IDEA-001", "slices": [{"key": "B1", "title": "Invite many", "epic": "EPIC-002", "depends_on": []}],
            "applied": {"epics": {}, "slices": {"B1": "SLICE-003"}}}
ANSWERS = {"schema_version": 1, "slice_id": "SLICE-003", "prd_id": "PRD-01", "prd_sha256": "c" * 64, "map_slice": "M1", "revision": 1,
           "answers": [], "drafted_at": "2026-11-20T10:00:00Z", "confirmations": []}
DESIGN_MAP = {"schema_version": 1, "design_id": "DES-01", "revision": 1, "topics": {}, "other": [], "conflicts": [],
              "published": {"sha256": "d" * 64, "at": "2026-11-21T10:00:00Z", "revision": 1}}


def tree(folder):
    """Every file under a folder, by relative path, with its SHA-256: a workspace before and after."""
    return {path.relative_to(folder).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(folder.rglob("*")) if path.is_file() and not path.is_symlink()}


class ExportBase(IssuesBase):
    def setUp(self):
        super().setUp()
        self.out = self.root / "out"
        self.out.mkdir()

    def write_json(self, relative, data):
        path = self.draft(self.a, relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(studio.canonical(data))

    def file(self, name, content):
        path = self.root / "files" / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(content) if isinstance(content, bytes) else path.write_text(content, encoding="utf-8")
        return str(path)

    def build(self):
        """Two epics; SLICE-001 ready on GitHub, SLICE-002 marked ready then reopened and changed, SLICE-003 a draft from a
        request with a Jira key, a resume note and a mock; principles and a need; two ideas; a PRD; a design."""
        a = self.a
        self.ok(a, "project", "init", "--id", "lending", "--name", "Lending", "--vision", "Members lend to each other.", "--outcome", "Loans are tracked")
        self.ok(a, "epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join")
        self.ok(a, "epic", "add", "--title", "Bulk invites", "--criterion", "A whole team joins at once")
        self.drafted()
        self.drafted(title="Remove a teammate")
        self.ready("SLICE-001")
        self.ready("SLICE-002")
        self.ok(a, "slice", "reopen", "SLICE-002")
        spec = self.draft(a, "specs/slices/SLICE-002-invite-teammate.md")
        spec.write_text(spec.read_text() + "\nA line added after it was reopened.\n")
        third = self.ok(a, "slice", "new", "--epic", "EPIC-002", "--title", "Invite a list of people")["slice"]["slice_id"]
        self.write_slice(a, third)
        path = self.draft(a, f"product/slices/{third}.json")
        work = json.loads(path.read_text())
        work["origin"] = {"kind": "github_issue", "repository": REPO, "number": 42}
        path.write_text(studio.canonical(work))
        self.ok(a, "slice", "link", third, "--jira", "TEAM-12")
        self.ok(a, "epic", "link", "EPIC-001", "--jira", "TEAM-1")
        self.ok(a, "slice", "pause", third, "--note", "Stopped at the second question.")
        self.ok(a, "slice", "mock", "add", third, self.file("form.png", png()))
        self.ok(a, "principle", "add", "--title", "Versions stay", "--statement", "A published version MUST NOT be edited in place.", "--reason", "Trust.")
        self.ok(a, "need", "add", "--kind", "people", "--statement", "About forty teams use it in its first year.", "--why", "It sets the size.")
        self.write_json("product/ideas/IDEA-001.json", IDEA)
        self.write_json("product/ideas/IDEA-002.json", FAULT_IDEA)
        self.write_json("product/ideas/IDEA-001.lookups.json", LOOKUPS)
        self.write_json("product/ideas/IDEA-001.map.json", IDEA_MAP)
        self.draft(a, "product/briefs/IDEA-001.md").parent.mkdir(parents=True, exist_ok=True)
        self.draft(a, "product/briefs/IDEA-001.md").write_text(BRIEF)
        self.ok(a, "prd", "import", self.file("team-space.md", prd_tests.PRD_TEXT))
        self.ok(a, "prd", "map", "PRD-01", "--from", self.file("map.json", json.dumps(prd_tests.MAP)))
        self.write_json("product/prds/PRD-01/answers/M1.json", ANSWERS)
        self.ok(a, "design", "import", self.file("architecture.md", design_tests.DESIGN_TEXT))
        self.write_json("product/designs/DES-01/map.json", DESIGN_MAP)
        self.ok(a, "refresh")
        self.assertTrue(self.ok(a, "validate")["valid"])

    def export(self, project=None, out="default", only_mine=False):
        return project_export.export(studio, studio.Studio(project or self.a), self.out if out == "default" else out, only_mine)

    def refused_export(self, *args, **kwargs):
        with self.assertRaises(studio.StudioError) as caught:
            self.export(*args, **kwargs)
        message = str(caught.exception)
        self.assertTrue(message.endswith("Nothing was changed."), message)
        return message

    def archive(self, result):
        return project_archive.read(Path(result["file"]))


class ExportTest(ExportBase):
    maxDiff = None

    def test_the_project_goes_into_one_archive_with_its_records_stripped_and_its_facts(self):
        """Scenario 1, the export half: every member, the strips, facts.json, the result, and nothing else changed."""
        self.build()
        draft = self.draft(self.a, "")
        before_project, before_calls = tree(self.a), len(self.gh()["calls"])
        result = self.export()
        self.assertEqual(tree(self.a), before_project)            # the workspace, Studio's records and the checkout, byte for byte
        self.assertEqual(len(self.gh()["calls"]), before_calls)   # no call to GitHub at all, read or write
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), [Path(result["file"]).name])  # one file, no temporary left

        manifest, members = self.archive(result)  # every member's size and SHA-256 checked against the manifest
        self.assertEqual(Path(result["file"]).name, f"mach-project-lending-{manifest['exported_at'].replace('-', '').replace(':', '')}.zip")
        self.assertEqual((result["exported"], result["factory_authorized"], result["left_out"]), (True, False, []))
        self.assertEqual(result["bytes"], Path(result["file"]).stat().st_size)
        self.assertEqual(result["sha256"], hashlib.sha256(Path(result["file"]).read_bytes()).hexdigest())
        self.assertEqual(result["counts"], {"epics": 2, "slices": 3, "principles": 1, "needs": 1, "ideas": 2, "prds": 1, "designs": 1, "mocks": 1})
        self.assertEqual(manifest["counts"], result["counts"])
        self.assertEqual(manifest["project_id"], "lending")
        self.assertEqual(result["warnings"], ["SLICE-002 changed since it was marked ready; the archive holds your draft."])
        self.assertIn("names no repository", result["note"])

        mock_name = json.loads((draft / "product/slices/SLICE-003.json").read_text())["mocks"][0]["sha256"] + ".png"
        expected = {"facts.json", "workspace/product/project.json", "workspace/product/principles.json", "workspace/product/needs.json",
                    "workspace/product/epics/EPIC-001.json", "workspace/product/epics/EPIC-002.json",
                    *(f"workspace/product/slices/SLICE-00{n}.json" for n in (1, 2, 3)), *(f"workspace/product/intents/SLICE-00{n}.md" for n in (1, 2, 3)),
                    *(f"workspace/specs/slices/SLICE-00{n}-invite-teammate.md" for n in (1, 2, 3)), f"workspace/product/mocks/SLICE-003/{mock_name}",
                    "workspace/product/ideas/IDEA-001.json", "workspace/product/ideas/IDEA-002.json", "workspace/product/ideas/IDEA-001.lookups.json",
                    "workspace/product/ideas/IDEA-001.map.json", "workspace/product/briefs/IDEA-001.md",
                    "workspace/product/prds/PRD-01/prd.json", "workspace/product/prds/PRD-01/document.md", "workspace/product/prds/PRD-01/map.json",
                    "workspace/product/prds/PRD-01/answers/M1.json",
                    "workspace/product/designs/DES-01/import.json", "workspace/product/designs/DES-01/design.md", "workspace/product/designs/DES-01/map.json"}
        self.assertEqual(set(members), expected)  # no ready folder, no ledger, no session, no request
        # Markdown, documents and pictures travel byte for byte; every JSON record is the source's after the documented strips.
        for member, data in members.items():
            if member == "facts.json":
                continue
            source = (draft / member[len("workspace/"):]).read_bytes()
            if member.endswith(".json"):
                record = json.loads(source)
                dropped = {"epics": ("tracking",), "slices": ("origin", "tracking")}.get(member.split("/")[2], ())
                wanted = {key: value for key, value in record.items() if key not in dropped}
                if member.endswith("IDEA-001.json"):
                    wanted = {**{k: v for k, v in record.items() if k != "issue"}, "source": {"kind": "moved"},
                              "verdict": {**record["verdict"], "by": None},
                              "lookback": {"outcomes": {"O-1": {"result": "met", "note": "Teams use it.", "by": None, "at": "2026-11-22T10:00:00Z"}},
                                           "assumptions": {}}}
                elif member.endswith("IDEA-002.json"):
                    wanted = {**{k: v for k, v in record.items() if k != "issue"}, "source": {"kind": "moved"}}
                elif member.endswith("IDEA-001.lookups.json"):
                    wanted = {**record, "similar": [{"idea": "IDEA-002", "note": "Close to it"}]}
                elif member.endswith("DES-01/map.json"):
                    wanted = {k: v for k, v in record.items() if k != "published"}
                self.assertEqual(json.loads(data), wanted, member)
                self.assertEqual(data, studio.canonical(wanted).encode(), member)
            else:
                self.assertEqual(data, source, member)
        slice3 = json.loads(members["workspace/product/slices/SLICE-003.json"])
        self.assertNotIn("origin", slice3)
        self.assertNotIn("tracking", slice3)
        self.assertNotIn("tracking", json.loads(members["workspace/product/epics/EPIC-001.json"]))

        facts = json.loads(members["facts.json"])
        self.assertEqual(members["facts.json"], project_archive.canonical(facts))
        self.assertEqual(facts["schema_version"], 1)
        self.assertEqual(facts["last_read_github_at"], self.ledger()["seen"]["refreshed_at"])
        self.assertEqual(facts["order"], {"EPIC-001": ["SLICE-001", "SLICE-002"], "EPIC-002": ["SLICE-003"]})
        self.assertEqual(facts["slices"], {
            "SLICE-001": {"was": "ready_to_build", "revision": 1, "jira": None, "request": None, "note": None},
            "SLICE-002": {"was": "interviewing", "revision": 1, "jira": None, "request": None, "note": None},
            "SLICE-003": {"was": "draft", "revision": None, "jira": "TEAM-12", "request": 42, "note": "Stopped at the second question."}})
        self.assertEqual(facts["epics"], {"EPIC-001": {"jira": "TEAM-1"}, "EPIC-002": {"jira": None}})
        self.assertEqual(facts["ideas"], {"IDEA-001": {"was_source": {"kind": "request", "number": 42}},
                                          "IDEA-002": {"was_source": {"kind": "fault", "ticket": "AUTO-20261120T101500Z"}}})
        self.assertEqual(facts["lookups_removed"], {"IDEA-001": 1})

    def test_the_order_is_the_product_manager_s(self):
        """The order within an epic lives in the ledger; facts.json carries it as effective_order gives it."""
        self.build()
        ledger_path = self.a / ".factory/studio/issues.json"
        ledger = json.loads(ledger_path.read_text())
        ledger.setdefault("order", {})["EPIC-001"] = {"slices": ["SLICE-002", "SLICE-001"], "github": None, "move": None, "taken_at": None}
        ledger_path.write_text(json.dumps(ledger))
        facts = json.loads(self.archive(self.export())[1]["facts.json"])
        self.assertEqual(facts["order"]["EPIC-001"], ["SLICE-002", "SLICE-001"])

    def test_the_same_workspace_gives_the_same_members(self):
        """Two exports differ only in the manifest's exported_at."""
        self.build()
        second = self.root / "second"
        second.mkdir()
        with mock.patch.object(studio, "now", lambda at: "2026-11-24T13:06:00Z"):
            first = self.export()
        with mock.patch.object(studio, "now", lambda at: "2026-11-25T08:00:00Z"):
            other = self.export(out=second)
        (one, members_one), (two, members_two) = self.archive(first), self.archive(other)
        self.assertEqual(members_one, members_two)
        self.assertEqual({**one, "exported_at": None}, {**two, "exported_at": None})
        self.assertNotEqual(one["exported_at"], two["exported_at"])
        with mock.patch.object(studio, "now", lambda at: "2026-11-24T13:06:00Z"):
            again = self.export(out=second)
        self.assertEqual(Path(again["file"]).read_bytes(), Path(first["file"]).read_bytes())  # the same clock: the same bytes

    def test_the_default_folder_is_studio_s_export_folder(self):
        self.build()
        result = self.export(out=None)
        self.assertEqual(Path(result["file"]).parent, self.a / ".factory/studio/export")
        self.assertTrue(Path(result["file"]).is_file())

    def test_a_minimal_project_exports(self):
        """A project with one epic and nothing else: no principles, needs, ideas, PRDs, designs or mocks members."""
        self.ok(self.a, "project", "init", "--id", "lending", "--name", "Lending", "--vision", "Members lend.", "--outcome", "Loans are tracked")
        self.ok(self.a, "epic", "add", "--title", "Loans", "--criterion", "A loan is recorded")
        manifest, members = self.archive(self.export())
        self.assertEqual(sorted(members), ["facts.json", "workspace/product/epics/EPIC-001.json", "workspace/product/project.json"])
        self.assertEqual(manifest["counts"], {"epics": 1, "slices": 0, "principles": 0, "needs": 0, "ideas": 0, "prds": 0, "designs": 0, "mocks": 0})
        facts = json.loads(members["facts.json"])
        self.assertEqual((facts["order"], facts["slices"], facts["ideas"], facts["lookups_removed"]), ({"EPIC-001": []}, {}, {}, {}))


class StripTest(unittest.TestCase):
    """Each STRIP entry removes exactly the fields section 1.2 lists, and nothing else; the record given is left as it was."""

    def check(self, kind, record, wanted):
        given = copy.deepcopy(record)
        self.assertEqual(project_export.STRIP[kind](record), wanted, kind)
        self.assertEqual(record, given, f"{kind}: the record given is not changed")

    def test_the_kinds_are_the_rewriter_s(self):
        self.assertEqual(set(project_export.STRIP), {"project", "epic", "slice", "principles", "needs", "idea", "lookups", "idea_map", "prd_meta",
                                                     "prd_map", "prd_answers", "design_meta", "design_map"})

    def test_each_strip(self):
        epic = {"epic_id": "EPIC-001", "title": "T", "tracking": {"jira": "TEAM-1"}, "serves": {"idea": "IDEA-001", "outcomes": ["O-1"]}}
        self.check("epic", epic, {k: v for k, v in epic.items() if k != "tracking"})
        work = {"slice_id": "SLICE-001", "status": "approved_for_engineering", "spec_sha256": "a" * 64, "origin": {"kind": "github_issue", "repository": REPO, "number": 4},
                "tracking": {"jira": "TEAM-2"}, "mocks": [{"sha256": "b" * 64}], "source": {"kind": "prd"}, "small": {"change": "adjustment", "shipped_rule": None}}
        self.check("slice", work, {k: v for k, v in work.items() if k not in ("origin", "tracking")})  # status and spec_sha256 change at import, not here
        self.check("idea", IDEA, {**{k: v for k, v in IDEA.items() if k != "issue"}, "source": {"kind": "moved"}, "verdict": {**IDEA["verdict"], "by": None},
                                  "lookback": {"outcomes": {"O-1": {"result": "met", "note": "Teams use it.", "by": None, "at": "2026-11-22T10:00:00Z"}},
                                               "assumptions": {}}})
        for source in ({"kind": "idea", "repository": REPO, "number": 3}, {"kind": "idea", "number": 3}, {"kind": "fault", "ticket": "AUTO-20261120T101500Z"}):
            self.assertEqual(project_export.STRIP["idea"]({**FAULT_IDEA, "source": source})["source"], {"kind": "moved"})
        for source in ({"kind": "typed"}, {"kind": "change", "rule": "SLICE-007/FR-01"}):
            self.check("idea", {**FAULT_IDEA, "source": source}, {**{k: v for k, v in FAULT_IDEA.items() if k != "issue"}, "source": source})
        self.check("lookups", LOOKUPS, {**LOOKUPS, "similar": [{"idea": "IDEA-002", "note": "Close to it"}]})
        self.check("design_map", DESIGN_MAP, {k: v for k, v in DESIGN_MAP.items() if k != "published"})
        for kind, record in (("project", {"project_id": "lending", "name": "Lending"}), ("principles", {"principles": [{"id": "PP-01"}]}),
                             ("needs", {"needs": [], "none": ["data"]}), ("idea_map", IDEA_MAP), ("prd_meta", {"prd_id": "PRD-01", "sha256": "c" * 64}),
                             ("prd_map", {"slices": []}), ("prd_answers", ANSWERS), ("design_meta", {"design_id": "DES-01"})):
            self.check(kind, record, record)

    def test_a_stripped_idea_keeps_the_form_shape_writes_but_for_moved(self):
        stripped = project_export.STRIP["idea"]({**IDEA, "source": {"kind": "typed"}})
        self.assertEqual(shape.record_problems(stripped, studio.ticket_rules()), [])


class NothingNamedTest(ExportBase):
    """Section 2.4 and scenario 12: no repository, account, folder here or secret inside, and a text that names one refuses."""

    def test_the_archive_names_no_repository_account_or_folder(self):
        self.build()
        named = project_export.forbidden(studio, studio.Studio(self.a))
        for needle in (REPO, f"github.com/{REPO}", "ada-pm", "ben-pm", str(self.a), str(Path.home())):
            self.assertIn(needle, named)
        _, members = self.archive(self.export())
        for member, data in members.items():
            text = data.decode("utf-8", errors="replace").lower()
            for needle in (REPO, "github.com/acme", "ada-pm", "ben-pm", str(self.root).lower(), str(self.root.resolve()).lower(), str(Path.home()).lower()):
                self.assertNotIn(needle.lower(), text, member)

    def refuses_with_nothing_written(self, sentence_part):
        before = tree(self.a)
        message = self.refused_export()
        self.assertIn(sentence_part, message)
        self.assertEqual(list(self.out.iterdir()), [])
        self.assertEqual(tree(self.a), before)
        return message

    def test_a_spec_naming_the_repository_is_refused(self):
        self.build()
        spec = self.draft(self.a, "specs/slices/SLICE-003-invite-teammate.md")
        lines = spec.read_text().split("\n")
        lines.insert(4, "See https://github.com/Acme/Team-Space/issues/3 for the request.")
        spec.write_text("\n".join(lines))
        message = self.refuses_with_nothing_written("SLICE-003's spec names this repository (Acme/Team-Space) on line 5.")
        self.assertIn("The archive must not name the repository, so nothing was exported. Take it out of the spec, then export again.", message)

    def test_a_brief_naming_a_recorded_login_is_refused(self):
        self.build()
        self.draft(self.a, "product/briefs/IDEA-001.md").write_text(BRIEF + "\nAsk @Ben-PM before the launch.\n")
        self.refuses_with_nothing_written("IDEA-001's brief names the GitHub account Ben-PM on line 7. The archive must not name an account")

    def test_a_login_only_inside_a_longer_name_is_not_one(self):
        self.build()
        self.draft(self.a, "product/briefs/IDEA-001.md").write_text(BRIEF + "\nThe ada-pmx team and xben-pm agree.\n")
        self.export()

    def test_a_work_order_title_naming_a_login_is_refused_by_line(self):
        self.build()
        path = self.draft(self.a, "product/slices/SLICE-003.json")
        work = json.loads(path.read_text())
        work["title"] = "Invite a list of people, as ada-pm asked"
        path.write_text(studio.canonical(work))
        stripped = studio.canonical(project_export.STRIP["slice"](work)).split("\n")
        line = next(n for n, text in enumerate(stripped, 1) if "ada-pm" in text)
        self.refuses_with_nothing_written(f"SLICE-003's work order names the GitHub account ada-pm on line {line}.")

    def test_a_why_holding_a_secret_is_refused(self):
        self.build()
        why = self.draft(self.a, "product/intents/SLICE-001.md")
        why.write_text(why.read_text() + "\nThe token is ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" + "\n")
        line = len(why.read_text().split("\n")) - 1
        self.refuses_with_nothing_written(f"SLICE-001's why holds text shaped like a password or key on line {line}.")

    def test_a_folder_on_this_computer_is_refused(self):
        self.build()
        self.draft(self.a, "product/briefs/IDEA-001.md").write_text(BRIEF + f"\nNotes in {Path.home()}/Desktop/notes.txt\n")
        self.refuses_with_nothing_written("IDEA-001's brief names a folder on this computer")

    def test_a_resume_note_naming_an_account_is_refused_by_slice(self):
        self.build()
        self.ok(self.a, "slice", "pause", "SLICE-003", "--note", "Ask ben-pm about the limit.")
        message = self.refuses_with_nothing_written("SLICE-003's resume note names the GitHub account ben-pm on line 1.")
        self.assertIn("Save the note again without it, then export again.", message)


class RefusalTest(ExportBase):
    """Scenario 15 and the other sentences of 7.1: each refuses, writes nothing and changes nothing."""

    def refuses(self, sentence_part, **kwargs):
        before = tree(self.a)
        message = self.refused_export(**kwargs)
        self.assertIn(sentence_part, message)
        self.assertEqual(list(self.out.iterdir()), [])
        self.assertEqual(tree(self.a), before)
        return message

    def test_no_project(self):
        self.refuses("There is no project here yet, so there is nothing to export.")

    def test_an_invalid_workspace(self):
        self.build()
        path = self.draft(self.a, "product/slices/SLICE-003.json")
        work = json.loads(path.read_text())
        work["dependencies"] = ["SLICE-099"]
        path.write_text(studio.canonical(work))
        message = self.refuses("The project's files are not consistent, so they were not exported: product/slices/SLICE-003.json: unknown dependency 'SLICE-099'")
        self.assertIn("Run status to see what needs fixing.", message)

    def test_slices_only_on_github_refuse_unless_only_mine(self):
        self.build()
        ledger_path = self.a / ".factory/studio/issues.json"
        ledger = json.loads(ledger_path.read_text())
        epic_issue = ledger["epics"]["EPIC-001"]["number"]
        for slice_id, issue in (("SLICE-009", 41), ("SLICE-012", 51)):
            ledger["seen"]["slices"][slice_id] = [{"issue": issue, "epic_issue": epic_issue, "state": "open", "state_label": "mach:ready", "revision": 1}]
        ledger_path.write_text(json.dumps(ledger))
        message = self.refuses("2 slices of this project are on GitHub but not in your workspace: SLICE-009 (#41), SLICE-012 (#51). "
                               "Open each here first (slice take 41), or export without them (project export --only-mine).")
        result = self.export(only_mine=True)
        self.assertEqual(result["left_out"], ["SLICE-009", "SLICE-012"])
        self.assertIn("Left out, as you asked: 2 slices of this project on GitHub but not in your workspace (SLICE-009 (#41), SLICE-012 (#51)).",
                      result["warnings"])
        manifest, members = self.archive(result)
        self.assertFalse(any("SLICE-009" in name or "SLICE-012" in name for name in members))
        facts = json.loads(members["facts.json"])
        self.assertEqual(facts["order"]["EPIC-001"], ["SLICE-001", "SLICE-002"])
        self.assertEqual(sorted(facts["slices"]), ["SLICE-001", "SLICE-002", "SLICE-003"])

    def test_an_unfinished_import(self):
        self.build()
        imports = self.a / ".factory/studio/imports"
        imports.mkdir()
        (imports / "0123456789abcdef.json").write_text(json.dumps({"schema_version": 1, "archive_sha256": "e" * 64, "started_at": "2026-11-24T10:00:00Z",
                                                                    "finished_at": None}))
        self.refuses("Bringing in another project stopped part way here. Finish it first (run the import again with the same file), then export.")
        record = json.loads((imports / "0123456789abcdef.json").read_text())
        (imports / "0123456789abcdef.json").write_text(json.dumps({**record, "finished_at": "2026-11-24T10:05:00Z"}))
        self.export()

    def test_a_supervised_execution(self):
        self.build()
        with mock.patch.dict(os.environ, {"MACH_EXECUTION_ID": "run-1"}):
            self.refuses("Exporting a project is a product manager's act; a supervised execution does not do it.")

    def test_an_idea_record_not_in_shape_s_form(self):
        self.build()
        self.write_json("product/ideas/IDEA-002.json", {**FAULT_IDEA, "stage": "dreaming"})
        self.refuses("IDEA-002's record is not in the form Product Studio writes, so the project was not exported: stage is one of")

    def test_a_prd_whose_copy_changed(self):
        self.build()
        document = self.draft(self.a, "product/prds/PRD-01/document.md")
        document.write_text(document.read_text() + "One more line.\n")
        self.refuses("The copy of PRD-01 in the workspace no longer matches what was imported, so the project was not exported. Import the document again.")

    def test_a_design_record_naming_no_document(self):
        self.build()
        path = self.draft(self.a, "product/designs/DES-01/import.json")
        self.write_json("product/designs/DES-01/import.json", {**json.loads(path.read_text()), "file": "../x.md"})
        self.refuses("DES-01's record is not in the form Product Studio writes, so the project was not exported: it names no document.")

    def test_a_mock_that_is_not_its_picture(self):
        self.build()
        (picture,) = self.draft(self.a, "product/mocks/SLICE-003").iterdir()
        picture.write_bytes(png(shade=9))
        sha = picture.stem
        self.refuses(f"SLICE-003's design mock {sha[:12]} is not a picture Product Studio can check, so the project was not exported.")

    def test_a_spec_that_is_not_text(self):
        self.build()
        self.draft(self.a, "specs/slices/SLICE-003-invite-teammate.md").write_bytes(b"# SLICE-003: x\n\xff\xfe broken\n")
        self.refuses("SLICE-003's spec cannot be read as text, so the project was not exported.")

    def test_a_symbolic_link_in_the_workspace(self):
        self.build()
        os.symlink(str(self.root / "files" / "form.png"), str(self.draft(self.a, "product/briefs/IDEA-009.md")))
        self.refuses("product/briefs/IDEA-009.md in the workspace is a symbolic link, so the project was not exported.")

    def test_a_folder_that_is_not_one(self):
        self.build()
        self.refuses("is not a folder on this computer.", out=self.root / "nowhere")
        link = self.root / "linked"
        os.symlink(str(self.out), str(link))
        self.refuses("is a symbolic link. Choose a real folder.", out=link)

    def test_an_archive_too_large(self):
        """project_archive.write gives the sentence; export adds the ending."""
        self.build()
        with mock.patch.dict(project_archive.LIMITS, {"archive": 1024}):
            self.refuses("more than the 1 KB an archive may be. Remove design mocks that are no longer needed, then export again.")


if __name__ == "__main__":
    unittest.main()
