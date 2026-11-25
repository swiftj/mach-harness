"""M21, what a moved project needs to arrive as it was: principles that say the same as one here are one principle; a principle a
slice predates is "Not assessed", in both directions, and holds up no slice; a rule of a slice that came with the project ships
first; numbers the engineers took while an import stood unfinished; and marking ready in one step what was ready in the old
repository.

Uses the GitHub stand-in and the archives of test_project_import (laid out by hand). Nothing reaches the network, a Factory or
`claude`.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "studio" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
from test_mach_product_issues import FIXTURE, spec_for  # noqa: E402
from test_project_import import ImportBase, lending, sha, write_archive  # noqa: E402
import cell  # noqa: E402
import effects  # noqa: E402
import project_import  # noqa: E402
import studio  # noqa: E402
import validate_slice  # noqa: E402

VERSIONS = "A published version MUST NOT be edited in place."
WORDS = "Every message SHALL use words a member knows, as PP-01 does."
INCOMING_ROWS = (f'- **PP-01** (revision 1): "{VERSIONS}" **Applies:** INV-02, AC-01.\n'
                 f'- **PP-02** (revision 1): "{WORDS}" **Applies:** FR-03.\n')


def with_principles(text, rows):
    return text.replace("## Dependencies and permissions", "## Principles\n\n" + rows + "\n## Dependencies and permissions")


def answered_lending(**kwargs):
    """lending(), each slice's spec answering the archive's two principles as a finished spec does."""
    files, facts = lending(**kwargs)
    for name in list(files):
        if name.startswith("workspace/specs/slices/"):
            text = files[name].decode().replace("\n## Product principles\n\n- **PP-01** (revision 1): Followed. Versions stay.\n", "")
            files[name] = with_principles(text, INCOMING_ROWS).encode()
            slice_id = name.split("/")[-1][:9]
            work_name = f"workspace/product/slices/{slice_id}.json"
            work = json.loads(files[work_name])
            if work.get("spec_sha256"):
                work["spec_sha256"] = sha(files[name])
                files[work_name] = studio.canonical(work).encode()
    return files, facts


class PrinciplesTest(ImportBase):
    """Ben's project has PP-01 ("Statement 1."), PP-02 (the archive's PP-01, word for word, at revision 2) and PP-03; his
    SLICE-001 is a finished draft answering all three."""
    maxDiff = None

    def setUp(self):
        super().setUp()
        self.ben_project(slices=2)
        principles = self.artifact(self.b, "product/principles.json")
        principles["principles"][1]["revision"] = 2
        self.write_json_in(self.b, "product/principles.json", principles)
        rows = "".join(f'- **PP-0{n}** (revision {2 if n == 2 else 1}): "{VERSIONS if n == 2 else f"Statement {n}."}" **Applies:** INV-02.\n'
                       for n in (1, 2, 3))
        self.draft(self.b, "specs/slices").mkdir(parents=True, exist_ok=True)
        self.draft(self.b, "specs/slices/SLICE-001-invite-teammate.md").write_text(with_principles(spec_for("SLICE-001"), rows))
        self.draft(self.b, "product/intents").mkdir(parents=True, exist_ok=True)
        files, facts = answered_lending(principles=True)
        self.archive = write_archive(self.archives / "lending.zip", files, facts)

    def test_the_same_principle_is_one_principle_and_no_slice_is_held_up(self):
        planned = self.plan(self.b, self.archive)
        self.assertEqual(self.pairs(planned, "PP"), {"PP-01": "PP-02", "PP-02": "PP-04"})
        result = self.bring(self.b, self.archive)
        self.assertEqual(result["map"], planned["map"])
        self.assertEqual([p["id"] for p in self.artifact(self.b, "product/principles.json")["principles"]], ["PP-01", "PP-02", "PP-03", "PP-04"])
        spec = self.text(self.b, "specs/slices/SLICE-003-invite-teammate.md")
        # The row that answered the archive's PP-01 now answers PP-02 as it is here (revision 2), with the PM's answer kept.
        self.assertIn(f'- **PP-02** (revision 2): "{VERSIONS}" **Applies:** INV-02, AC-01.', spec)
        self.assertIn('- **PP-04** (revision 1): "Every message SHALL use words a member knows, as PP-02 does." **Applies:** FR-03.', spec)
        day = result["principles_not_assessed"][0]["words"].split("brought in here on ")[1][:10]
        self.assertIn(f'- **PP-01** (revision 1): "Statement 1." **Not assessed:** This slice came with the project Lending, brought in here '
                      f'on {day}, which did not have PP-01.', spec)
        self.assertIn("**PP-03** (revision 1)", spec)
        self.assertEqual([(r["slice"], r["principle"]) for r in result["principles_aligned"]][:1], [("SLICE-003", "PP-02")])
        # Ben's own draft, the other way: PP-04 came after it was written.
        mine = self.text(self.b, "specs/slices/SLICE-001-invite-teammate.md")
        self.assertIn(f'- **PP-04** (revision 1): "Every message SHALL use words a member knows, as PP-02 does." **Not assessed:** PP-04 came '
                      f'with the project Lending, brought in here on {day}, after this slice was written.', mine)
        self.assertEqual(planned["principles_not_assessed"], result["principles_not_assessed"], "the plan says the same rows")
        ways = {(r["slice"], r["principle"], r["how"]) for r in result["principles_not_assessed"]}
        self.assertIn(("SLICE-001", "PP-04", "principle_came"), ways)
        self.assertIn(("SLICE-003", "PP-01", "slice_came"), ways)
        self.assertNotIn(("SLICE-003", "PP-02", "slice_came"), ways, "the project had that one, as its own PP-01")
        # Neither side is held up by principles; each Not assessed row is a warning that says so.
        for slice_id in ("SLICE-001", "SLICE-003", "SLICE-004", "SLICE-005"):
            check = json.loads(self.run_studio(self.b, "slice", "check", slice_id, "--ready")[1])
            principle_errors = [e for e in check["errors"] if "principle" in e]
            self.assertEqual(principle_errors, [], (slice_id, check["errors"]))
        check = json.loads(self.run_studio(self.b, "slice", "check", "SLICE-001")[1])
        self.assertTrue(any("[principle-not-assessed]" in w and "PP-04 is not assessed for this slice yet" in w for w in check["warnings"]), check)
        listed = self.ok(self.b, "principle", "list")
        self.assertEqual(listed["slices_answered_under_older"], [], "nothing is flagged as answered under older principles")
        # A second run changes nothing and writes no row twice.
        before = self.text(self.b, "specs/slices/SLICE-001-invite-teammate.md")
        self.assertTrue(self.bring(self.b, self.archive)["already"])
        self.assertEqual(self.text(self.b, "specs/slices/SLICE-001-invite-teammate.md"), before)
        record = self.record(self.b, self.archive)
        self.assertEqual(record["principles_matched"], {"PP-01": {"here": "PP-02", "how": "word for word"}})
        self.assertIn("said the same as PP-02 here", project_import.lookup(studio.Studio(self.b), "PP-01")["note"])

    def test_a_not_assessed_row_no_import_wrote_is_refused(self):
        self.bring(self.b, self.archive)
        path = self.draft(self.b, "specs/slices/SLICE-001-invite-teammate.md")
        text = path.read_text()
        day = text.split("brought in here on ")[1][:10]
        path.write_text(text.replace(f"PP-04 came with the project Lending, brought in here on {day}",
                                     f"PP-04 came with the project Somewhere else, brought in here on {day}"))
        check = json.loads(self.run_studio(self.b, "slice", "check", "SLICE-001")[1])
        self.assertIn("PP-04's row says 'Not assessed', which only bringing in a project writes, and no project brought in here wrote it for "
                      "SLICE-001. Answer PP-04: does it apply, not apply, or is this slice an exception? [principle-not-assessed]",
                      " ".join(check["errors"]))
        path.write_text(text.replace("came with the project Lending, brought in here on", "arrived one day with"))
        check = json.loads(self.run_studio(self.b, "slice", "check", "SLICE-001")[1])
        self.assertTrue(any("'Not assessed' is written only by bringing in a project" in e for e in check["errors"]), check["errors"])

    def test_a_principle_changed_later_must_be_answered(self):
        self.bring(self.b, self.archive)
        self.ok(self.b, "principle", "set", "PP-04", "--statement", "Every message SHALL use words a member knows.")
        check = json.loads(self.run_studio(self.b, "slice", "check", "SLICE-001")[1])
        self.assertTrue(any("PP-04's statement is not quoted exactly" in e for e in check["errors"]), check["errors"])

    def test_a_slice_marked_ready_before_and_reopened_gets_the_row(self):
        self.bring(self.b, self.archive)
        work = self.work(self.b, "SLICE-002")
        self.draft(self.b, "specs/slices/SLICE-002-invite-teammate.md").write_text(
            with_principles(spec_for("SLICE-002"), "".join(f'- **PP-0{n}** (revision {2 if n == 2 else 1}): "{VERSIONS if n == 2 else f"Statement {n}."}" '
                                                           "**Applies:** INV-02.\n" for n in (1, 2, 3))))
        work.update(status="approved_for_engineering", spec_path="specs/slices/SLICE-002-invite-teammate.md")
        self.write_json_in(self.b, "product/slices/SLICE-002.json", work)
        flags = studio.principle_flags(studio.Studio(self.b), "SLICE-002", studio.Studio(self.b).principles())
        self.assertEqual((flags["unanswered"], flags["not_assessed"], flags["note"]), ([], ["PP-04"], None))
        rows = project_import.rows_on_reopen(studio, studio.Studio(self.b), "SLICE-002")
        self.assertEqual([(r["slice"], r["principle"]) for r in rows], [("SLICE-002", "PP-04")])
        self.assertIn("**Not assessed:** PP-04 came with the project Lending", self.text(self.b, "specs/slices/SLICE-002-invite-teammate.md"))
        self.assertEqual(project_import.rows_on_reopen(studio, studio.Studio(self.b), "SLICE-002"), [r for r in rows], "listed, not written twice")


class NotAssessedRowTest(unittest.TestCase):
    """The validator's side: the row's two fixed sentences, nothing else; current statement and revision, as any row."""

    PRINCIPLES = [{"id": "PP-01", "statement": VERSIONS, "status": "active", "revision": 1}]

    def check(self, row):
        text = with_principles(FIXTURE, row + "\n")
        findings, model = validate_slice.analyze(text, "SLICE-001-invite-teammate.md", principles=self.PRINCIPLES)
        return [(f.severity, f.rule) for f in findings if f.rule.startswith("principle")], model

    def test_the_fixed_sentences_pass_as_a_warning(self):
        for reason in ("PP-01 came with the project Lending Circle — Préstamos, brought in here on 2026-11-24, after this slice was written.",
                       "This slice came with the project Lending, brought in here on 2026-11-24, which did not have PP-01."):
            found, model = self.check(f'- **PP-01** (revision 1): "{VERSIONS}" **Not assessed:** {reason}')
            self.assertEqual(found, [("warning", "principle-not-assessed")], reason)
            self.assertEqual(model["principles_not_assessed"][0]["reason"], reason)
            self.assertNotIn("principles", model.get("principles") or [], "never counted as an answer")

    def test_anything_else_is_an_error(self):
        for row in (f'- **PP-01** (revision 1): "{VERSIONS}" **Not assessed:** We did not look at it.',
                    f'- **PP-01** (revision 1): "{VERSIONS}" **Not assessed:** PP-02 came with the project X, brought in here on 2026-11-24, '
                    "after this slice was written.",
                    f'- **PP-01** (revision 2): "{VERSIONS}" **Not assessed:** PP-01 came with the project X, brought in here on 2026-11-24, '
                    "after this slice was written.",
                    '- **PP-01** (revision 1): "Something else." **Not assessed:** PP-01 came with the project X, brought in here on 2026-11-24, '
                    "after this slice was written."):
            found, _ = self.check(row)
            self.assertIn("error", [severity for severity, _ in found], row)


class EffectsPendingTest(unittest.TestCase):
    """A row naming a rule that has not shipped: a warning only when the caller says that slice ships first (Product Studio);
    the engineers' checks never pass it, so there the row is an error until the rule has shipped."""

    TEXT = FIXTURE.replace("## Effects on shipped behaviour\n\nNone.\n",
                           "## Effects on shipped behaviour\n\n| Shipped rule | Effect | In this slice | Note |\n|---|---|---|---|\n"
                           "| SLICE-031/FR-02 | kept | AC-01 | The invitation still goes out. |\n")

    def test_pending_is_a_warning_and_nothing_else_is(self):
        parsed = effects.parse(self.TEXT)
        problems = effects.check(parsed, [], slice_id="SLICE-001", pending={"SLICE-031/FR-02": {"slice_id": "SLICE-031"}})
        self.assertEqual([(p["code"], p.get("severity")) for p in problems], [("effects-ships-first", "warning")])
        self.assertEqual([p["code"] for p in effects.check(parsed, [], slice_id="SLICE-001")], ["effects-not-shipped"])
        findings, _ = validate_slice.analyze(self.TEXT, "SLICE-001-x.md", shipped=[], pending={"SLICE-031/FR-02": {"slice_id": "SLICE-031"}})
        self.assertEqual([(f.severity, f.rule) for f in findings if f.rule.startswith("effects")], [("warning", "effects-ships-first")])

    def test_the_engineers_finalize_reads_it_as_any_other_row(self):
        """cell.py's finalize and validate check through analyze_spec, which takes no pending rules: a row naming a rule that has not
        shipped is an error there, whatever Product Studio accepted."""
        import inspect
        self.assertNotIn("pending", inspect.signature(cell.analyze_spec).parameters)
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            project = Path(folder)
            spec = project / "specs" / "slices" / "SLICE-001-x.md"
            spec.parent.mkdir(parents=True)
            spec.write_text(self.TEXT)
            findings, _ = cell.analyze_spec(project, spec, ready=True, rules=[])
            self.assertIn(("error", "effects-not-shipped"), [(f.severity, f.rule) for f in findings])


class NumbersTest(ImportBase):
    """The engineers' allocator and an import that stopped part way, from both sides."""
    maxDiff = None

    def setUp(self):
        super().setUp()
        self.archive = self.hand_archive()
        self.real_place = project_import._place

    def stop_at(self, name):
        def place(source, target):
            if target.name == name:
                raise OSError(28, "No space left on device")
            self.real_place(source, target)
        with mock.patch.object(project_import, "_place", place), self.assertRaises(studio.StudioError):
            self.bring(self.b, self.archive)

    def next_id(self, project):
        with mock.patch("sys.stdout") as out:
            cell.cmd_next_id(project, mock.Mock(count=2))
        return json.loads("".join(call.args[0] for call in out.write.call_args_list))["next"]

    def test_the_engineers_allocator_skips_what_an_unfinished_import_holds(self):
        self.stop_at("EPIC-001.json")
        used, _ = cell.slice_ids(self.b)
        self.assertEqual(sorted(n for n in used if "being brought in" in used[n]), [1, 2, 3, 4, 7])
        self.assertEqual(self.next_id(self.b), ["SLICE-008", "SLICE-009"])
        project_import.set_aside(studio, studio.Studio(self.b), None)
        self.assertEqual(self.next_id(self.b), ["SLICE-001", "SLICE-002"], "set aside, the numbers are free again")

    def test_a_number_taken_meanwhile_by_nothing_placed_is_given_another(self):
        """Stopped before any slice was placed (its PRD's map and answers, which name SLICE-002, were). An engineer's spec on this
        checkout now holds SLICE-002: the import gives that slice the next free number and puts its own placed files right."""
        self.stop_at("SLICE-001-invite-teammate.md")
        (self.b / "specs" / "slices").mkdir(parents=True)
        (self.b / "specs/slices/SLICE-002-fix-login.md").write_text("# SLICE-002: Fix login\n\nAn engineer's own ticket.\n")
        planned = self.plan(self.b, self.archive)
        self.assertEqual(self.pairs(planned, "SLICE")["SLICE-002"], "SLICE-008")
        result = self.bring(self.b, self.archive)
        self.assertEqual(self.pairs(result, "SLICE")["SLICE-002"], "SLICE-008")
        self.assertEqual(result["renumbered_on_resume"][0]["words"], "SLICE-002 of the project was to be SLICE-002 here, but specs/slices/"
                                                                     "SLICE-002-fix-login.md in this repository now uses SLICE-002, so it is SLICE-008.")
        self.assertIn(result["renumbered_on_resume"][0]["words"], result["after"])
        self.assertEqual(self.artifact(self.b, "product/prds/PRD-01/map.json")["applied"]["slices"], {"M1": "SLICE-008"})
        self.assertEqual(self.artifact(self.b, "product/prds/PRD-01/answers/M1.json")["slice_id"], "SLICE-008")
        self.assertFalse(self.draft(self.b, "product/slices/SLICE-002.json").exists())
        self.assertEqual(self.work(self.b, "SLICE-008")["dependencies"], ["SLICE-001"])
        self.assertTrue(self.ok(self.b, "validate")["valid"])
        self.assertEqual(self.record(self.b, self.archive)["map"]["SLICE-002"], "SLICE-008")
        self.assertIn("SLICE-008 here was SLICE-002", project_import.lookup(studio.Studio(self.b), "SLICE-008")["note"])
        check = json.loads(self.run_studio(self.b, "slice", "check", "SLICE-001")[1])
        self.assertFalse([e for e in check["errors"] if "duplicate-slice-id" in e])

    def test_a_number_taken_meanwhile_of_something_placed_stops_with_what_to_do(self):
        self.stop_at("SLICE-002.json")  # SLICE-002's spec and why are placed; its work order is not
        ticket = self.b / ".factory/worktrees/LOCAL-007/repo/specs/slices"
        ticket.mkdir(parents=True)
        (ticket / "SLICE-002-fix-login.md").write_text("# SLICE-002: Fix login\n")
        with self.assertRaises(studio.StudioError) as caught:
            self.bring(self.b, self.archive)
        self.assertEqual(str(caught.exception),
                         "Bringing in stopped: SLICE-002 is the number this import gave SLICE-002 of the project Lending, and part of it is already "
                         "here, but the engineers' ticket LOCAL-007 (its spec SLICE-002-fix-login.md) now uses SLICE-002 for another slice. Ask the "
                         "engineer working on it to give their slice another number, then bring the same file in again. Or set this import aside: "
                         "what it already brought in stays where it is.")
        self.assertNotIn("cell.py", str(caught.exception))
        self.assertIsNotNone(project_import.unfinished(studio.Studio(self.b)))


class ReadyTest(ImportBase):
    """Every slice arrives as a draft; on the PM's word, what was ready in the old repository is marked ready in one step."""
    maxDiff = None

    def setUp(self):
        super().setUp()
        files, facts = answered_lending()
        self.archive = write_archive(self.archives / "lending.zip", files, facts)

    def test_the_plan_says_how_many_and_the_import_marks_none(self):
        planned = self.plan(self.b, self.archive)
        self.assertEqual(planned["ready_in_source"]["slices"], ["SLICE-001", "SLICE-002", "SLICE-003"])
        self.assertTrue(planned["ready_in_source"]["words"].startswith("3 slices were ready in the old repository (SLICE-001, SLICE-002 and "
                                                                       "SLICE-003). On your word, MACH can mark them ready here in one step"))
        self.assertTrue(planned["ready_in_source"]["words"].endswith("That step first publishes the product principles and technical needs "
                                                                     "that came with the project, as they then stand here."))
        self.assertTrue(planned["note"].endswith(" Nothing was sent to GitHub. 3 of them were ready in the old repository and can be marked "
                                                 "ready here in one step (project imports ready), on your word, which first publishes the "
                                                 "principles and technical needs that came with them."), planned["note"])
        self.assertNotIn("when you have checked it", planned["note"], "one instruction, not two")
        with mock.patch.object(studio, "APP", True):
            self.assertNotIn("(project imports ready)", self.plan(self.b, self.archive)["note"], "no command in the app")
        self.bring(self.b, self.archive)
        self.assertEqual({self.work(self.b, s)["status"] for s in ("SLICE-001", "SLICE-002", "SLICE-003")}, {"draft"})
        self.assertEqual(self.record(self.b, self.archive)["was_ready"], {"SLICE-001": True, "SLICE-002": True, "SLICE-003": True})

    def test_ready_in_one_step_dependencies_first_stopping_at_the_first_refusal(self):
        self.bring(self.b, self.archive)
        # Publishing what came is refused: it stops there, with that reason, and nothing is marked ready.
        with mock.patch.object(studio, "publish_principles", side_effect=studio.StudioError("Someone else published newer principles.")):
            first = json.loads(self.run_studio(self.b, "project", "imports", "ready")[1])
        self.assertEqual((first["published_first"], first["marked_ready"], first["stopped_at"]["slice"]), ([], [], None))
        self.assertTrue(first["note"].startswith("Stopped before marking anything ready: publishing the product principles was refused. "
                                                 "Someone else published newer principles. Still to mark ready: SLICE-001, SLICE-002 and SLICE-003."),
                        first["note"])
        self.assertEqual(self.work(self.b, "SLICE-001")["status"], "draft")
        # One step: the principles and needs that came are published first, then the slices are marked ready.
        code, out, err = self.run_studio(self.b, "project", "imports", "ready")
        result = json.loads(out)
        self.assertEqual(result["published_first"], ["principles", "needs"])
        self.assertTrue(result["note"].startswith("Published the product principles and the technical needs first, as they stand in this "
                                                  "workspace, so the builders have what these slices answer. Marked "), result["note"])
        self.assertFalse(studio.Studio(self.b).unpublished(self.ledger(self.b)))
        done = [row["slice"] for row in result["marked_ready"]]
        self.assertEqual(done[:1], ["SLICE-001"], "a dependency first")
        for slice_id in done:
            self.assertEqual(self.work(self.b, slice_id)["status"], "approved_for_engineering")
            self.assertTrue(self.slice_issue_numbered(slice_id), slice_id)
        if result["complete"]:
            self.assertEqual(code, 0)
            self.assertEqual(result["left"], [])
        else:
            self.assertEqual(code, 1)
            stopped = result["stopped_at"]["slice"]
            self.assertEqual(result["left"][0], stopped)
            self.assertIn(f"Stopped at {stopped}: ", result["note"])
            self.assertIn(f"ask again and MACH carries on from {stopped}", result["note"])
            self.assertEqual(self.work(self.b, stopped)["status"] != "approved_for_engineering", True)
        self.assertEqual(result["not_ready_in_source"], ["SLICE-004"])
        again = json.loads(self.run_studio(self.b, "project", "imports", "ready")[1])
        self.assertEqual(again["already_ready"], done, "a slice marked ready is left as it is")
        self.assertEqual(again["marked_ready"], [])

    def slice_issue_numbered(self, slice_id):
        return bool((self.ledger(self.b)["slices"].get(slice_id) or {}).get("number"))

    def test_the_archive_s_own_word_comes_first(self):
        files, facts = answered_lending()
        facts["slices"]["SLICE-003"]["was_ready"] = False
        archive = write_archive(self.archives / "told.zip", files, facts)
        planned = self.plan(self.b, archive)
        self.assertEqual(planned["ready_in_source"]["slices"], ["SLICE-001", "SLICE-002"])
        # Ready there, but not whole in the file (the exporter's word, as for a slice whose mock pictures were not on main): said.
        self.assertEqual(planned["ready_in_source"]["held_back"], ["SLICE-003"])
        self.assertTrue(any(line.startswith("SLICE-003 was ready in the old repository, but the file does not hold its approved version whole")
                            for line in planned["after"]), planned["after"])

    def test_a_slice_from_github_without_its_mocks_arrives(self):
        """What export writes for a ready slice read from GitHub whose pictures were not on main: the work order lists no mock, the
        facts say was_ready false and from_github true. It arrives as a draft; nothing is refused."""
        files, facts = answered_lending()
        facts["slices"]["SLICE-002"].update(was_ready=False, from_github=True)
        result = self.bring(self.b, write_archive(self.archives / "nomocks.zip", files, facts))
        self.assertTrue(result["imported"])
        self.assertEqual(result["ready_in_source"]["held_back"], ["SLICE-002"])
        self.assertNotIn("SLICE-002", result["ready_in_source"]["slices"])
        self.assertEqual(self.record(self.b, self.archives / "nomocks.zip")["was_ready"], {"SLICE-001": True, "SLICE-003": True})

    def test_refused_in_a_supervised_execution_and_before_anything_is_brought_in(self):
        with mock.patch.object(studio.policies_helper(), "unattended", return_value=True):
            code, out, err = self.run_studio(self.b, "project", "import", str(self.archive), "--ready")
        self.assertEqual(code, 1)
        self.assertIn("Marking slices ready is a product manager's act; a supervised execution does not do it.", err)
        self.assertFalse(self.draft(self.b, "product/project.json").exists())
        code, out, err = self.run_studio(self.b, "project", "imports", "ready")
        self.assertEqual(code, 1)
        self.assertIn("No project has been brought in here, so there is nothing to mark ready.", err)

    def test_import_and_ready_in_one_command(self):
        code, out, err = self.run_studio(self.b, "project", "import", str(self.archive), "--ready")
        result = json.loads(out)
        self.assertTrue(result["imported"])
        self.assertIn("ready", result)
        self.assertEqual(code, 0 if result["ready"]["complete"] else 1)
        self.assertIn(result["ready"]["note"], result["note"])


if __name__ == "__main__":
    unittest.main()
