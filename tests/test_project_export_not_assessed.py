"""M21: a project that was joined can be moved again. Its "Not assessed" rows travel in facts.json `not_assessed`, each with the
import that wrote it; a row no import here vouches for does not travel and is said; and a slice marked ready before a principle came
carries the principle it was never assessed against.

Builds on test_project_import_seamless.PrinciplesTest: Ben (`b`) has brought Ada's Lending in, joining his project.
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "studio" / "scripts"))
from test_mach_product_issues import intent_for, spec_for  # noqa: E402
import test_project_import_seamless as seamless  # noqa: E402  (the module, so its own tests are not collected here again)
from test_project_import_seamless import VERSIONS, with_principles  # noqa: E402
import project_archive  # noqa: E402
import project_export  # noqa: E402
import project_import  # noqa: E402
import studio  # noqa: E402


class NotAssessedTravelsTest(seamless.PrinciplesTest):
    # The setup is PrinciplesTest's; its own tests run in their module, not again here.
    test_the_same_principle_is_one_principle_and_no_slice_is_held_up = None
    test_a_not_assessed_row_no_import_wrote_is_refused = None
    test_a_principle_changed_later_must_be_answered = None
    test_a_slice_marked_ready_before_and_reopened_gets_the_row = None

    def joined(self):
        # Ben's SLICE-002 was marked ready before the import: PP-04 (which came with Lending) is not assessed for it, virtually, as
        # the import's record lists it.
        work = self.work(self.b, "SLICE-002")
        self.draft(self.b, "specs/slices/SLICE-002-invite-teammate.md").write_text(
            with_principles(spec_for("SLICE-002"), "".join(f'- **PP-0{n}** (revision {2 if n == 2 else 1}): "{VERSIONS if n == 2 else f"Statement {n}."}" '
                                                           "**Applies:** INV-02.\n" for n in (1, 2, 3))))
        work.update(status="approved_for_engineering", spec_path="specs/slices/SLICE-002-invite-teammate.md")
        work["spec_sha256"] = studio.sha(self.draft(self.b, "specs/slices/SLICE-002-invite-teammate.md").read_bytes())
        self.write_json_in(self.b, "product/slices/SLICE-002.json", work)
        why = self.draft(self.b, "product/intents/SLICE-002.md")
        why.write_text(intent_for("SLICE-002"))
        hand = studio.Studio(self.b).handoff()  # marked ready to the folder, as slice ready records it: the approved hashes
        with hand.exclusive():
            ledger = hand.load()
            ledger["slices"]["SLICE-002"] = {"saved": "folder", "spec_sha256": work["spec_sha256"], "why_sha256": studio.sha(why.read_bytes())}
            hand.save(ledger)
        result = self.bring(self.b, self.archive)
        return result["principles_not_assessed"][0]["words"].split("brought in here on ")[1][:10]

    def exported(self):
        out = self.root / "out-again"
        out.mkdir(exist_ok=True)
        result = project_export.export(studio, studio.Studio(self.b), out, False)
        return result, json.loads(project_archive.read(Path(result["file"]))[1]["facts.json"])

    def test_every_vouched_row_and_every_virtual_one_travels(self):
        day = self.joined()
        result, facts = self.exported()
        rows = {(row["slice"], row["principle"]): row for row in facts["not_assessed"]}
        self.assertEqual(rows[("SLICE-003", "PP-01")], {"slice": "SLICE-003", "principle": "PP-01", "how": "slice_came", "project": "Lending", "day": day})
        self.assertEqual(rows[("SLICE-001", "PP-04")], {"slice": "SLICE-001", "principle": "PP-04", "how": "principle_came", "project": "Lending", "day": day})
        self.assertEqual(rows[("SLICE-002", "PP-04")], {"slice": "SLICE-002", "principle": "PP-04", "how": "principle_came", "project": "Lending", "day": day},
                         "marked ready before the principle came: computed, not written in its spec")
        self.assertNotIn("Not assessed", self.text(self.b, "specs/slices/SLICE-002-invite-teammate.md"), "export writes nothing")
        self.assertFalse(any("'Not assessed'" in line for line in result["in_words"]))

    def test_a_row_no_import_vouches_for_does_not_travel_and_is_said(self):
        day = self.joined()
        path = self.draft(self.b, "specs/slices/SLICE-001-invite-teammate.md")
        path.write_text(path.read_text().replace(f"PP-04 came with the project Lending, brought in here on {day}",
                                                 f"PP-04 came with the project Somewhere else, brought in here on {day}"))
        result, facts = self.exported()
        self.assertNotIn(("SLICE-001", "PP-04"), {(row["slice"], row["principle"]) for row in facts["not_assessed"]})
        self.assertIn("SLICE-001's spec says PP-04 is 'Not assessed', but no project brought in here wrote that row, so it does not travel as one: "
                      "in the new place it has to be answered.", result["in_words"])

    def test_a_computer_with_no_record_of_the_import_says_so_and_holds_back_what_it_cannot_vouch_for(self):
        """Exported where the project that was brought in has no record (another computer): the rows cannot be vouched for, and
        SLICE-002, ready but not answering PP-04, comes as a draft (was_ready false) with what to do."""
        self.joined()
        import shutil
        shutil.rmtree(self.b / ".factory/studio/imports")
        result, facts = self.exported()
        self.assertIn("SLICE-001's spec says PP-04 is 'Not assessed'. This computer has no record of the project that was brought in, so it "
                      "cannot vouch for the row. Export on the computer where that project was brought in to carry it; otherwise it has to be "
                      "answered in the new place.", result["in_words"])
        self.assertFalse(facts["slices"]["SLICE-002"]["was_ready"])
        self.assertIn("SLICE-002 was ready there, but it does not answer PP-04, which joined the project later; this computer has no record of "
                      "that. It comes as a draft: export on the computer where the project was brought in, or answer PP-04 in the new place.",
                      result["in_words"])

    def test_with_the_record_a_ready_slice_stays_ready(self):
        self.joined()
        result, facts = self.exported()
        self.assertTrue(facts["slices"]["SLICE-002"]["was_ready"], "its row is vouched for and is written where it arrives")

    def test_an_importer_that_does_not_know_the_list_still_brings_the_archive_in(self):
        self.joined()
        result, facts = self.exported()
        self.assertTrue(facts["not_assessed"])
        c = self.clone("c", "Cy PM")
        found = project_import.run(studio, studio.Studio(c), Path(result["file"]))
        self.assertTrue(found["slices"])


if __name__ == "__main__":
    unittest.main()
