"""M13 part B, layer 4: at the merge, what landed on main since approval is checked against the ticket's own ground.

A file the ticket also changed, or a landed slice that changes, replaces or retires a shipped rule the ticket's spec
lists (or one of a slice it depends on), voids the approval: nothing lands, the ticket is verified and reviewed again on
the merged result, and that uses no judging round."""

import io
import json
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "merge" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import merge  # noqa: E402
from test_build import git  # noqa: E402
from test_merge import Base as MergeBase  # noqa: E402
import test_mach_product_intake  # noqa: E402
import test_review  # noqa: E402

TICKET_README = "# Sample\n\nAdmins can invite teammates.\n"  # what the ticket's T05 writes


def landed_spec(slice_id, rows):
    """A minimal slice spec as it lands on main: only the effects section matters to the merge station."""
    effects = "None." if not rows else "| Shipped rule | Effect | In this slice | Note |\n|---|---|---|---|\n" + "\n".join(rows)
    return f"# {slice_id}: Something else\n\n## Summary\n\nOther work.\n\n## Effects on shipped behaviour\n\n{effects}\n"


def with_effects(rows):
    """This ticket's own spec section, appended to the cell's spec copy."""
    return "\n## Effects on shipped behaviour\n\n| Shipped rule | Effect | In this slice | Note |\n|---|---|---|---|\n" + "\n".join(rows) + "\n"


class Base(MergeBase):
    def land_on_main(self, files, message="landed"):
        self.put(self.project, files)
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", message)
        return git(self.project, "rev-parse", "HEAD").stdout.strip()

    def overlap_records(self):
        path = self.cellroot / "lifecycle.jsonl"
        lines = [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.is_file() else []
        return [item["data"] for item in lines if item.get("type") == "gate.evaluated" and (item.get("data") or {}).get("gate") == "merge.landed_overlap"]

    def assert_sent_back(self, refusal, approved):
        cell = self.cell_json()
        self.assertEqual((cell["stage"], cell["review"]), ("built", "VOID"))
        self.assertNotIn("revalidated", cell, "nothing is recorded as revalidated")
        self.assertNotIn("change_record", cell, "no change record exists on this path: it is written only at landing")
        self.assertEqual(self.main_log()[0], "landed", "nothing landed on main")
        head = git(self.work, "rev-parse", "HEAD").stdout.strip()
        parents = git(self.work, "rev-list", "--parents", "-n", "1", head).stdout.split()
        self.assertEqual(parents[1], approved, "the merge of main stays on the branch, on top of the approved commit")
        decision = json.loads((self.cellroot / "review/decision.json").read_text())
        self.assertEqual((decision["outcome"], decision["void"]["approved_commit"], decision["void"]["branch_commit"]), ("VOID", approved, head))
        self.assertTrue(Path(decision["void"]["findings_path"]).is_file())
        self.assertEqual(json.loads((self.cellroot / "build-report.json").read_text())["head"], head)
        step = self.next()
        self.assertEqual(step["action"], "verify", "verified and reviewed again on the merged result")
        return decision


class TriggerTest(Base):
    def test_a_file_this_ticket_also_changed_voids_the_approval(self):
        approved = self.approved(mode="auto")
        self.land_on_main({"README.md": TICKET_README})  # the same edit: the merge is clean, the suite passes
        refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("changed files this ticket also changed: README.md", refusal)
        self.assertIn("Nothing was merged", refusal)
        decision = self.assert_sent_back(refusal, approved)
        self.assertEqual(decision["void"]["landed_files"], ["README.md"])
        self.assertIn("README.md", (self.cellroot / "review/merge-recheck.md").read_text())
        record = self.overlap_records()
        self.assertEqual([(item["outcome"], item["reason_code"], item["files"], item["landed_commits"]) for item in record],
                         [("refuse", "landed-overlap", 1, 1)])

    def test_a_landed_slice_changing_a_rule_this_spec_lists_voids_the_approval(self):
        approved = self.approved(mode="auto")
        spec = self.cellroot / "spec.md"
        spec.write_text(spec.read_text() + with_effects(["| SLICE-003/FR-02 | kept | AC-01 | Still holds. |"]))
        self.land_on_main({"specs/slices/SLICE-004-late-returns.md": landed_spec("SLICE-004", ["| SLICE-003/FR-02 | replaced | FR-01 | |"]),
                           "app/returns.py": "RETURNS = True\n"})
        refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("SLICE-004 landed on main (specs/slices/SLICE-004-late-returns.md): it replaced SLICE-003/FR-02, and this ticket's spec lists it.", refusal)
        self.assertNotIn("changed files this ticket also changed", refusal, "another slice's spec is not a file overlap")
        decision = self.assert_sent_back(refusal, approved)
        self.assertEqual(decision["void"]["landed_slices"], ["SLICE-004"])
        self.assertEqual(self.overlap_records()[0]["slices"], ["SLICE-004"])

    def test_a_landed_slice_retiring_a_rule_of_a_slice_this_one_depends_on_voids_the_approval(self):
        approved = self.approved(mode="auto")
        self.set_cell(product={"slice_id": "SLICE-001", "revision": 1, "depends_on": ["SLICE-003"]})
        self.land_on_main({"specs/slices/SLICE-004-late-returns.md": landed_spec("SLICE-004", ["| SLICE-003/INV-01 | retired | | The product manager's reason. |"])})
        refusal = self.m_refused("run", "LOCAL-001")
        self.assertIn("it retired SLICE-003/INV-01, and this ticket's slice depends on SLICE-003", refusal)
        self.assert_sent_back(refusal, approved)


class NoTriggerTest(Base):
    def test_unrelated_files_and_slices_land_and_the_ticket_merges(self):
        approved = self.approved(mode="auto")
        spec = self.cellroot / "spec.md"
        spec.write_text(spec.read_text() + with_effects(["| SLICE-003/FR-02 | kept | AC-01 | Still holds. |"]))
        self.set_cell(product={"slice_id": "SLICE-001", "revision": 1, "depends_on": ["SLICE-003"]})
        self.land_on_main({"app/later.py": "VALUE = 1\n",
                           "specs/slices/SLICE-004-other.md": landed_spec("SLICE-004", ["| SLICE-003/FR-02 | kept | AC-01 | Not touched. |",
                                                                                        "| SLICE-002/FR-01 | changed | FR-01 | |"]),
                           "specs/slices/SLICE-005-quiet.md": landed_spec("SLICE-005", []),
                           "docs/changes/LOCAL-009.md": "another ticket's change record\n",
                           "app/__pycache__/x.pyc": "byproduct\n"})
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertEqual(git(self.project, "merge-base", "--is-ancestor", approved, "main").returncode, 0)
        record = self.overlap_records()
        self.assertEqual([(item["outcome"], item["files"], item["slices"]) for item in record], [("pass", 0, [])])

    def test_main_not_moved_makes_no_check(self):
        self.approved(mode="auto")
        self.assertEqual(self.m_ok("run", "LOCAL-001")["status"], "MERGED")
        self.assertEqual(self.overlap_records(), [])

    def test_the_setting_switches_the_check_off(self):
        self.approved(mode="auto", revalidate_overlap=False)
        self.land_on_main({"README.md": TICKET_README})
        self.assertNotIn("check what landed", " ".join(self.m_ok("plan", "LOCAL-001")["would"]))
        done = self.m_ok("run", "LOCAL-001")
        self.assertEqual(done["status"], "MERGED")
        self.assertEqual(self.overlap_records(), [], "no check, no record")

    def test_the_template_has_the_setting_on(self):
        template = json.loads((ROOT / "templates/config.json").read_text())
        self.assertIs(template["merge"]["revalidate_overlap"], True)

    def test_a_missing_effects_parser_does_not_let_a_landed_spec_through(self):
        self.approved(mode="auto")
        self.land_on_main({"specs/slices/SLICE-004-late.md": landed_spec("SLICE-004", [])})
        merge._EFFECTS[:] = [None]
        self.addCleanup(merge._EFFECTS.clear)
        self.assertIn("effects parser (effects.py) could not be loaded", self.m_refused("run", "LOCAL-001"))
        self.assertEqual(self.cell_json()["stage"], "built")


class NoRoundTest(test_review.Base):
    """A pass of the check's re-verification and re-review uses no judging round."""

    def m(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = merge.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def test_reverified_and_reviewed_again_in_the_same_round(self):
        self.verified()
        self.r_ok("start", test_review.TICKET)
        self.cast()
        self.assertEqual(self.tally()[1]["outcome"], "APPROVED")
        self.put(self.project, {".factory/config.json": json.dumps({"merge": {"mode": "auto"}})})
        self.put(self.project, {"README.md": TICKET_README})
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "landed")
        code, _, err = self.m("run", test_review.TICKET)
        self.assertEqual(code, 1)
        self.assertIn("README.md", err)
        loop = json.loads((self.cellroot / "build-report.json").read_text()).get("review_loop", 0)
        self.assertEqual(loop, 0, "voiding uses no round")
        self.run_verify("start", test_review.TICKET)
        (self.evidence / "consumer-run.log").write_text("AC-01 ok\n")
        for target in test_review.TARGETS:
            self.run_verify("record", test_review.TICKET, target, "--result", "pass", "--evidence", "consumer-run.log", "--note", test_review.NOTE)
        self.assertEqual(self.run_verify("finish", test_review.TICKET)["status"], "PASS")
        started = self.r_ok("start", test_review.TICKET)
        self.assertEqual((started["round"], Path(started["packet"]).parent.name), (1, "round-1.1"), "the same judging round, repeated")
        self.round = self.cellroot / "review" / "round-1.1"
        self.cast()
        self.assertEqual(self.tally()[1]["outcome"], "APPROVED")
        self.assertEqual(json.loads((self.cellroot / "build-report.json").read_text()).get("review_loop", 0), 0)
        code, out, err = self.m("run", test_review.TICKET)
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["status"], "MERGED", "main has not moved again: the re-reviewed merge result lands")




class IntakeDependsTest(test_mach_product_intake.Base):
    def test_dispatch_records_the_slices_this_one_depends_on(self):
        epic = self.epic()
        first = self.ready("SLICE-001", epic)
        second = self.ready("SLICE-002", epic, depends=[first])
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.cell(str(first))["product"]["depends_on"], [])
        self.integrate(str(first), cleanup=True)
        self.product("dispatch", "SLICE-002")
        self.assertEqual(self.cell(str(second))["product"]["depends_on"], ["SLICE-001"], "by issue, resolved to the slice")


if __name__ == "__main__":
    unittest.main()
