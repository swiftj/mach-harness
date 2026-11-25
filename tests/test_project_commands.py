"""M21 E: the commands that move a project by archive, `project export`, `project import` and `project imports`.

What studio.py adds on top of project_export.py and project_import.py: the three commands in its parser, their output
through studio.main, an archive refusal printed as a refusal that ends "Nothing was changed.", the app's wording (no
command or flag names), the numbers an unfinished import holds skipped by Studio's own allocators, and the
`import_unfinished` row of `saved`. The skill's `STUDIO project ...` commands are checked against the parser.

Uses the GitHub stand-in of test_mach_product_issues (IssuesBase): the clones `a` (Ada) and `b` (Ben) of acme/team-space.
Design: docs/mach-next/M21_EXPORT_IMPORT.md, sections 3, 4.4, 4.6, 4.7, 7 and 10 E.
"""

import argparse
import hashlib
import json
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "studio" / "scripts"))
from test_mach_product_issues import IssuesBase  # noqa: E402
import project_archive  # noqa: E402
import project_export  # noqa: E402
import studio  # noqa: E402

import project_import  # noqa: E402
# What a person reads in the app names no command, flag or engine file.
BANNED = re.compile(r"studio\.py|--[a-z]|\bproject (export|import|imports)\b|\bslice take\b")
NOTHING_CHANGED = "Nothing was changed."


def subcommands(parser):
    found = [action for action in parser._actions if isinstance(action, argparse._SubParsersAction)]
    return found[0].choices if found else None


def options(parser):
    return {option for action in parser._actions for option in action.option_strings}


def positionals(parser):
    return [action.dest for action in parser._actions if not action.option_strings and not isinstance(action, argparse._SubParsersAction)]


class ParserTest(unittest.TestCase):
    def setUp(self):
        self.project = subcommands(subcommands(studio.build_parser())["project"])

    def test_the_three_commands_are_under_project(self):
        self.assertTrue({"init", "set", "export", "import", "imports"} <= set(self.project))
        self.assertEqual(options(self.project["export"]) - {"-h", "--help"}, {"--out", "--only-mine"})
        self.assertEqual(options(self.project["import"]) - {"-h", "--help"}, {"--plan", "--abandon"})
        self.assertEqual(positionals(self.project["import"]), ["archive"])
        self.assertEqual(options(self.project["imports"]) - {"-h", "--help"}, set())
        self.assertEqual(positionals(self.project["imports"]), ["identifier"])

    def test_the_arguments_parse(self):
        parser = studio.build_parser()
        args = parser.parse_args(["project", "export", "--out", "/tmp/x", "--only-mine"])
        self.assertEqual((args.func, args.out, args.only_mine), (studio.cmd_project_export, "/tmp/x", True))
        args = parser.parse_args(["project", "export"])
        self.assertEqual((args.out, args.only_mine), (None, False))
        args = parser.parse_args(["project", "import", "a.zip", "--plan"])
        self.assertEqual((args.func, args.archive, args.plan), (studio.cmd_project_import, "a.zip", True))
        self.assertFalse(parser.parse_args(["project", "import", "a.zip"]).plan)
        args = parser.parse_args(["project", "import", "--abandon"])
        self.assertEqual((args.func, args.archive, args.abandon, args.plan), (studio.cmd_project_import, None, True, False))
        args = parser.parse_args(["project", "imports"])
        self.assertEqual((args.func, args.identifier), (studio.cmd_project_imports, None))
        self.assertEqual(parser.parse_args(["project", "imports", "SLICE-007"]).identifier, "SLICE-007")

    def test_every_project_command_the_skill_names_parses(self):
        """SKILL.md names commands as `STUDIO project ...`; each parses with studio.py's own parser, placeholders filled."""
        text = (ROOT / "skills" / "studio" / "SKILL.md").read_text(encoding="utf-8")
        named = re.findall(r"`STUDIO (project [^`]+)`", text)
        for needed in ("project export", "project import <path> --plan", "project import <path>", "project imports"):
            self.assertTrue(any(command.startswith(needed) for command in named), needed)
        parser = studio.build_parser()
        for command in named:
            words = [re.sub(r"^<[^>]+>$", "SLICE-007" if "ID" in word else "file.zip", word) for word in command.replace('"', "").split()]
            words = [word for word in words if not (word.startswith("[") or word.endswith("]"))]
            with self.subTest(command=command):
                parser.parse_args(words)


class ExportCommandTest(IssuesBase):
    def setUp(self):
        super().setUp()
        self.out = self.root / "out"
        self.out.mkdir()

    def built(self, project=None):
        self.project_and_epic(project)
        self.drafted(project)

    def test_export_writes_one_archive_and_prints_the_result(self):
        self.built()
        result = self.ok(self.a, "project", "export", "--out", str(self.out))
        target = Path(result["file"])
        self.assertEqual(target.parent, self.out)
        self.assertRegex(target.name, r"^mach-project-team-space-[0-9]{8}T[0-9]{6}Z\.zip$")
        data = target.read_bytes()
        self.assertEqual((result["exported"], result["bytes"], result["sha256"]), (True, len(data), hashlib.sha256(data).hexdigest()))
        self.assertFalse(result["factory_authorized"])
        self.assertEqual(result["note"], project_export.NOTE)
        manifest, members = project_archive.read(target)
        self.assertEqual(manifest["counts"]["slices"], 1)
        self.assertIn("workspace/product/slices/SLICE-001.json", members)
        self.assertEqual(self.writes(), [])

    def test_export_with_no_folder_writes_in_studio_s_export_folder(self):
        self.built()
        result = self.ok(self.a, "project", "export")
        self.assertEqual(Path(result["file"]).parent, self.a / ".factory/studio/export")

    def test_a_refusal_ends_with_nothing_was_changed(self):
        err = self.refused(self.a, "project", "export")
        self.assertIn("There is no project here yet, and GitHub holds none for this repository, so there is nothing to export. "
                      "Define the project first (project init).", err)
        self.assertTrue(err.strip().endswith(NOTHING_CHANGED), err)
        err = self.refused(self.a, "project", "export", "--out", str(self.root / "missing"))
        self.assertTrue(err.strip().endswith(NOTHING_CHANGED), err)

    def test_an_archive_refusal_is_printed_as_a_refusal(self):
        """project_archive.ArchiveError carries the sentence without its ending; studio.py adds it."""
        self.built()
        with mock.patch.object(project_export, "export", side_effect=project_archive.ArchiveError("x.zip is not a project archive from MACH.")):
            err = self.refused(self.a, "project", "export")
        self.assertEqual(err.strip(), f"refused: x.zip is not a project archive from MACH. {NOTHING_CHANGED}")
        with mock.patch.object(project_export, "export", side_effect=project_archive.ArchiveError(f"Already said. {NOTHING_CHANGED}")):
            err = self.refused(self.a, "project", "export")
        self.assertEqual(err.count(NOTHING_CHANGED), 1)

    def test_the_app_wording_names_no_command_or_flag(self):
        """Ben's own SLICE-001 clashes with Ada's on GitHub: the sentence names the fix in the app's words, the command in the terminal's."""
        self.built()
        self.ready("SLICE-001")
        self.project_and_epic(self.b)
        self.drafted(self.b, title="Ben's own")
        result = self.ok(self.b, "--app", "project", "export", "--out", str(self.out))
        (row,) = result["not_included"]
        self.assertIn("SLICE-001 here is a different draft", row["reason"])
        self.assertIn("Give your draft a new number, then export again to include both.", row["reason"])
        for line in result["in_words"] + [result["note"]]:
            self.assertIsNone(BANNED.search(line), line)
        terminal = self.ok(self.b, "project", "export", "--out", str(self.out))
        self.assertIn("(slice renumber SLICE-001)", terminal["not_included"][0]["reason"])
        err = self.refused(self.empty_copy(), "--app", "project", "export", "--only-mine")
        self.assertIn("Export everything to take the project from GitHub.", err)
        self.assertIsNone(BANNED.search(err), err)
        stopped = {"file": "mach-project-lending-20261124T130600Z.zip", "archive_sha256": "e" * 64, "started_at": "2026-11-24T10:00:00Z"}
        with mock.patch.object(project_export, "_unfinished_import", return_value=stopped):
            err = self.refused(self.a, "--app", "project", "export", "--only-mine")
        self.assertIn("Bringing in another project stopped part way here.", err)
        self.assertIsNone(BANNED.search(err), err)

    def empty_copy(self):
        """A third copy of the repository with nothing in its workspace."""
        return self.clone("c", "Cy PM")


class ImportCommandTest(IssuesBase):
    """Ada exports her project; Ben, in a clone of the same repository standing in for another one, brings it in."""

    def setUp(self):
        super().setUp()
        self.out = self.root / "out"
        self.out.mkdir()

    def exported(self):
        self.ok(self.a, "project", "init", "--id", "lending", "--name", "Lending", "--vision", "Members lend to each other.", "--outcome", "Loans are tracked")
        self.ok(self.a, "epic", "add", "--title", "Loans", "--criterion", "A loan is recorded")
        self.drafted(self.a, title="Record a loan")
        self.drafted(self.a, title="Repay a loan")
        return self.ok(self.a, "project", "export", "--out", str(self.out))["file"]

    def own_project(self):
        """Ben's own project, with EPIC-001 and SLICE-001..002, so what arrives is renumbered."""
        self.project_and_epic(self.b)
        self.drafted(self.b)
        self.drafted(self.b, title="Remove a teammate")

    def draft_tree(self, project):
        folder = project / ".factory/studio/draft"
        return {path.relative_to(folder).as_posix(): path.read_bytes() for path in sorted(folder.rglob("*")) if path.is_file()}

    def test_the_plan_through_main_writes_nothing(self):
        archive = self.exported()
        self.own_project()
        before = self.draft_tree(self.b)
        plan = self.ok(self.b, "project", "import", archive, "--plan")
        self.assertTrue(plan["plan"])
        self.assertEqual(plan["mode"], "join")
        self.assertFalse(plan["factory_authorized"])
        self.assertEqual(dict(map(tuple, plan["map"]["SLICE"])), {"SLICE-001": "SLICE-003", "SLICE-002": "SLICE-004"})
        self.assertEqual(dict(map(tuple, plan["map"]["EPIC"])), {"EPIC-001": "EPIC-002"})
        self.assertEqual(self.draft_tree(self.b), before)
        self.assertIsNone(project_import.unfinished(studio.Studio(self.b)))
        self.assertTrue(self.ok(self.b, "status")["saved"]["everything_saved"])
        self.assertEqual(self.writes(), [])

    def test_the_import_through_main_brings_the_project_in_as_drafts(self):
        archive = self.exported()
        self.own_project()
        result = self.ok(self.b, "project", "import", archive)
        self.assertFalse(result["factory_authorized"])
        self.assertIn("Nothing was sent to GitHub.", result["note"])
        for slice_id in ("SLICE-003", "SLICE-004"):
            work = self.artifact(self.b, f"product/slices/{slice_id}.json")
            self.assertEqual((work["status"], work["epic_id"], work["project_id"]), ("draft", "EPIC-002", "team-space"))
        self.assertTrue(self.ok(self.b, "validate")["valid"])
        self.assertTrue(self.ok(self.b, "status")["saved"]["everything_saved"])
        self.assertEqual(self.writes(), [])
        found = self.ok(self.b, "project", "imports", "SLICE-002")
        self.assertIn("SLICE-004", json.dumps(found))
        again = self.ok(self.b, "project", "import", archive)
        self.assertIn("Already brought in on", json.dumps(again))

    def test_an_archive_that_is_not_one_is_refused_with_nothing_changed(self):
        self.own_project()
        bogus = self.root / "not-an-archive.zip"
        bogus.write_text("hello")
        err = self.refused(self.b, "project", "import", str(bogus), "--plan")
        self.assertIn("is not a project archive from MACH.", err)
        self.assertTrue(err.strip().endswith(NOTHING_CHANGED), err)
        err = self.refused(self.b, "--app", "project", "import", str(self.root / "missing.zip"))
        self.assertTrue(err.strip().endswith(NOTHING_CHANGED), err)

    def test_an_import_stopped_part_way_holds_its_numbers_and_shows_in_saved(self):
        """A real stop while placing Ada's second slice: status shows the row, Studio's own allocators skip the map's numbers,
        export refuses, and running the import again through main finishes it."""
        archive = self.exported()
        self.own_project()
        real = project_import._place

        def place(source, target):
            if target.name == "SLICE-004.json":
                raise OSError(28, "No space left on device")
            real(source, target)

        with mock.patch.object(project_import, "_place", place):
            err = self.refused(self.b, "project", "import", archive)
        self.assertIn("Bringing in stopped part way: no space left on device.", err)
        name = Path(archive).name
        saved = self.ok(self.b, "status")["saved"]
        row = next(row for row in saved["not_saved"] if row["kind"] == "import_unfinished")
        self.assertEqual(row["text"], f"Bringing in the project from {name} stopped part way. Run it again with the same file to finish, "
                                      "or set it aside.")
        app_row = next(row for row in self.ok(self.b, "--app", "status")["saved"]["not_saved"] if row["kind"] == "import_unfinished")
        self.assertIsNone(BANNED.search(app_row["text"]), app_row["text"])
        here = studio.Studio(self.b)
        self.assertEqual(project_import.reserved_numbers(here, "SLICE"), [3, 4])
        self.assertEqual(here.next_id("slice"), "SLICE-005")
        self.assertEqual(here.next_id("epic"), "EPIC-003")
        self.assertIn("Bringing in another project stopped part way here.", self.refused(self.b, "project", "export"))
        result = self.ok(self.b, "project", "import", archive)
        self.assertTrue(result["imported"])
        self.assertTrue(self.ok(self.b, "status")["saved"]["everything_saved"])
        self.assertEqual(here.next_id("slice"), "SLICE-005")
        self.assertEqual(self.writes(), [])

    def test_an_import_stopped_part_way_can_be_set_aside(self):
        """Through main: the import stops after the epic; setting it aside frees its numbers, keeps the epic it placed where it
        is, lists it, and no longer blocks export or another import. Nothing else is changed."""
        archive = self.exported()
        self.own_project()
        real = project_import._place

        def place(source, target):
            if target.parent.name == "slices" and target.parent.parent.name == "specs":
                raise OSError(28, "No space left on device")
            real(source, target)

        with mock.patch.object(project_import, "_place", place):
            self.refused(self.b, "project", "import", archive)
        here = studio.Studio(self.b)
        self.assertEqual(project_import.reserved_numbers(here, "SLICE"), [3, 4])
        before = self.draft_tree(self.b)
        err = self.refused(self.b, "project", "import", "--abandon", "--plan")
        self.assertTrue(err.strip().endswith(NOTHING_CHANGED), err)
        result = self.ok(self.b, "project", "import", "--abandon")
        self.assertTrue(result["set_aside"])
        self.assertFalse(result["factory_authorized"])
        self.assertEqual(result["brought_in"], [{"id": "EPIC-002", "was": "EPIC-001", "files": ["product/epics/EPIC-002.json"]}])
        self.assertEqual(result["note"], f"MACH stopped bringing in the project from {Path(archive).name} and set it aside. What it had already "
                                         "brought in stays where it is: EPIC-002 (listed under brought_in). Keep it, or remove it if you do "
                                         "not want it. The numbers it was holding are free again, and nothing else was changed.")
        self.assertEqual(self.draft_tree(self.b), before, "every file already placed stays exactly where it is; nothing else changes")
        self.assertIsNone(project_import.unfinished(here))
        for kind in ("SLICE", "EPIC", "PP", "TN", "IDEA", "PRD", "DES"):
            self.assertEqual(project_import.reserved_numbers(here, kind), [], kind)
        self.assertEqual(here.next_id("slice"), "SLICE-003", "the numbers it held are free again")
        self.assertEqual(here.next_id("epic"), "EPIC-003", "the epic it placed is counted as any epic here is")
        self.assertEqual(studio.next_principle_id(here, []), "PP-01")
        self.assertTrue(self.ok(self.b, "status")["saved"]["everything_saved"])
        imports = self.b / ".factory/studio/imports"
        self.assertEqual([p.name for p in imports.iterdir() if not p.name.endswith(".json")], [], "staging and the log are removed")
        found = self.ok(self.b, "project", "imports", "EPIC-001")
        self.assertIn("set aside on", found["note"])
        self.assertIn("nothing to set aside", self.refused(self.b, "project", "import", "--abandon"))
        self.assertTrue(self.ok(self.b, "project", "export", "--out", str(self.out))["exported"])
        again = self.ok(self.b, "project", "import", archive, "--plan")  # the same archive can be brought in afresh
        self.assertEqual(dict(map(tuple, again["map"]["EPIC"])), {"EPIC-001": "EPIC-003"})
        self.assertEqual(self.writes(), [])

    # ---- the numbers an unfinished import holds, and the row in `saved` (studio.py's own wiring) ----

    def test_studio_s_allocators_skip_the_numbers_an_unfinished_import_holds(self):
        self.own_project()
        held = {"SLICE": [7, 8], "EPIC": [5], "PP": [4]}
        with mock.patch.object(project_import, "reserved_numbers", side_effect=lambda _studio, kind: held.get(kind, [])) as reserved:
            self.assertEqual(self.ok(self.b, "slice", "new", "--epic", "EPIC-001", "--title", "Leave a team")["slice"]["slice_id"], "SLICE-009")
            self.assertEqual(self.ok(self.b, "epic", "add", "--title", "Billing", "--criterion", "A bill is sent")["epic"]["epic_id"], "EPIC-006")
            added = self.ok(self.b, "principle", "add", "--title", "Versions stay", "--statement", "A published version MUST NOT be edited in place.",
                            "--reason", "Trust.")
            self.assertIn("PP-05", json.dumps(added))
        kinds = {call.args[1] for call in reserved.call_args_list}
        self.assertTrue({"SLICE", "EPIC", "PP"} <= kinds, kinds)

    def test_an_unfinished_import_is_a_row_in_saved(self):
        self.own_project()
        stopped = {"file": "mach-project-lending-20261124T130600Z.zip", "archive_sha256": "e" * 64, "started_at": "2026-11-24T13:07:00Z"}
        with mock.patch.object(project_import, "unfinished", return_value=stopped):
            saved = self.ok(self.b, "status")["saved"]
            app = self.ok(self.b, "--app", "status")["saved"]
        self.assertFalse(saved["everything_saved"])
        row = next(row for row in saved["not_saved"] if row["kind"] == "import_unfinished")
        self.assertEqual(row["text"], "Bringing in the project from mach-project-lending-20261124T130600Z.zip stopped part way. "
                                      "Run it again with the same file to finish, or set it aside.")
        app_row = next(row for row in app["not_saved"] if row["kind"] == "import_unfinished")
        self.assertIsNone(BANNED.search(app_row["text"]), app_row["text"])
        self.assertTrue(self.ok(self.b, "status")["saved"]["everything_saved"])


if __name__ == "__main__":
    unittest.main()
