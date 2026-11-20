"""M15: neighbouring shipped scenarios, chosen by rule at verify start and proven again on the built result."""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "verify" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "review" / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "merge" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import change_record  # noqa: E402
import merge  # noqa: E402
import neighbours  # noqa: E402
from test_build import SPEC, git  # noqa: E402
from test_verify import Base as VerifyBase, NOTE, TARGETS  # noqa: E402
from test_review import Base as ReviewBase  # noqa: E402

TICKET = "LOCAL-001"


def scenario(ident, *covers):
    return {"id": ident, "title": f"Scenario {ident}", "covers": list(covers), "steps": [{"keyword": "Given", "text": "a workspace"}]}


def shipped(epic="EPIC-001", gone=(), count=3):
    return {"epic_id": epic, "scenarios": [scenario(f"AC-0{n}", f"FR-0{n}") for n in range(1, count + 1)], "not_in_force": list(gone)}


class ChooseTest(unittest.TestCase):
    """The pure rule: no model, no Git."""

    def ids(self, chosen):
        return [(item["slice_id"], item["scenario"]) for item in chosen]

    def test_dependencies_first_then_the_most_recent_slices_one_scenario_each_before_a_second(self):
        table = {"SLICE-002": shipped(), "SLICE-003": shipped(), "SLICE-004": shipped(), "SLICE-009": shipped(epic="EPIC-002")}
        chosen, _ = neighbours.choose("SLICE-005", "EPIC-001", ["SLICE-002"], [], table, 4)
        self.assertEqual(self.ids(chosen), [("SLICE-002", "AC-01"), ("SLICE-004", "AC-01"), ("SLICE-003", "AC-01"), ("SLICE-002", "AC-02")])
        self.assertEqual(chosen[0]["why"], "this slice depends on it")
        self.assertEqual(chosen[1]["why"], "a recently shipped slice of the same epic")
        self.assertEqual(neighbours.choose("SLICE-005", "EPIC-001", ["SLICE-002"], [], table, 4), (chosen, []), "the same inputs give the same choice")

    def test_a_slice_whose_rule_this_spec_changes_replaces_or_retires_is_left_out_whole(self):
        table = {"SLICE-002": shipped(), "SLICE-003": shipped(), "SLICE-004": shipped()}
        for effect in ("changed", "replaced", "retired"):
            rows = [{"slice_id": "SLICE-004", "rule_id": "FR-02", "effect": effect}]
            chosen, skipped = neighbours.choose("SLICE-005", "EPIC-001", ["SLICE-004"], rows, table, 5)
            self.assertNotIn("SLICE-004", {item["slice_id"] for item in chosen}, effect)
            self.assertEqual(skipped[0]["slice_id"], "SLICE-004")
            self.assertIn("may rightly fail", skipped[0]["why"])

    def test_a_scenario_covering_a_kept_rule_or_a_rule_no_longer_in_force_is_skipped(self):
        table = {"SLICE-003": shipped(gone=["FR-03"])}
        rows = [{"slice_id": "SLICE-003", "rule_id": "FR-01", "effect": "kept"}]
        chosen, skipped = neighbours.choose("SLICE-005", "EPIC-001", [], rows, table, 5)
        self.assertEqual(self.ids(chosen), [("SLICE-003", "AC-02")])
        self.assertEqual([(item["scenario"], "keeps" in item["why"], "no longer in force" in item["why"]) for item in skipped],
                         [("AC-01", True, False), ("AC-03", False, True)])

    def test_no_epic_or_a_limit_of_zero_chooses_nothing(self):
        table = {"SLICE-002": shipped()}
        self.assertEqual(neighbours.choose("SLICE-005", None, ["SLICE-002"], [], table, 2), ([], []))
        self.assertEqual(neighbours.choose("SLICE-005", "EPIC-001", ["SLICE-002"], [], table, 0), ([], []))
        self.assertEqual(neighbours.choose("SLICE-002", "EPIC-001", [], [], table, 2), ([], []), "a slice is never its own neighbour")

    def test_the_setting(self):
        self.assertEqual(neighbours.setting({}), (2, None))
        self.assertEqual(neighbours.setting({"verify": {"neighbours": 0}}), (0, None))
        self.assertEqual(neighbours.setting({"verify": {"neighbours": 4}}), (4, None))
        for bad in (-1, 11, "3", True, None):
            limit, note = neighbours.setting({"verify": {"neighbours": bad}})
            self.assertEqual(limit, 2, bad)
            self.assertIn("whole number", note)


def shipped_spec(number, epic="EPIC-001"):
    slice_id = f"SLICE-{number:03d}"
    lines = SPEC.replace("SLICE-001", slice_id).split("\n")
    lines[1:1] = ["", f"> Epic: Teams ({epic}, issue #9). Slice issue: #{20 + number}."]
    return f"specs/slices/{slice_id}-invite-teammate.md", "\n".join(lines)


EFFECTS = """## Effects on shipped behaviour

| Shipped rule | Effect | In this slice | Note |
|---|---|---|---|
| SLICE-004/FR-01 | changed | FR-01 | The invitation is sent at once. |

"""


class Steps:
    def ship(self, *numbers, epic="EPIC-001"):
        self.put(self.project, dict(shipped_spec(number, epic) for number in numbers))
        git(self.project, "add", "specs")
        git(self.project, "commit", "-q", "-m", "shipped slices")
        return git(self.project, "rev-parse", "HEAD").stdout.strip()

    def in_epic(self, depends_on=()):
        path = self.cellroot / "cell.json"
        info = json.loads(path.read_text())
        info["product"] = {"slice_id": "SLICE-001", "epic_id": "EPIC-001", "depends_on": list(depends_on)}
        path.write_text(json.dumps(info))

    def configure(self, data):
        self.put(self.project, {".factory/config.json": json.dumps(data)})


class VerifyNeighboursTest(Steps, VerifyBase):
    def setUp(self):
        super().setUp()
        self.built()

    def test_start_lists_the_neighbours_with_the_shipped_scenario_text_and_records_the_choice(self):
        commit = self.ship(2, 3, 4)
        self.in_epic(depends_on=["SLICE-002"])
        started = self.v_ok("start", TICKET)
        prove = {item["id"]: item for item in started["prove"]}
        self.assertEqual([item["id"] for item in started["prove"]], TARGETS + ["NEIGHBOUR-1", "NEIGHBOUR-2"])
        first = prove["NEIGHBOUR-1"]
        self.assertEqual((first["kind"], first["slice_id"], first["scenario"], first["why"]), ("neighbour", "SLICE-002", "AC-01", "this slice depends on it"))
        self.assertEqual((prove["NEIGHBOUR-2"]["slice_id"], prove["NEIGHBOUR-2"]["scenario"]), ("SLICE-004", "AC-01"))
        self.assertEqual(first["steps"][1], {"keyword": "When", "text": 'the admin invites "sam@example.com"'})
        self.assertEqual((started["neighbours"]["commit"], started["neighbours"]["epic_id"], started["neighbours"]["limit"]), (commit, "EPIC-001", 2))
        self.assertNotIn("neighbours_note", started)
        results = json.loads((self.evidence / "results.json").read_text())
        self.assertEqual([item["id"] for item in results["neighbours"]["chosen"]], ["NEIGHBOUR-1", "NEIGHBOUR-2"])

        for target in TARGETS + ["NEIGHBOUR-1", "NEIGHBOUR-2"]:
            self.record(target)
        self.assertEqual(self.v_ok("finish", TICKET)["status"], "PASS")
        summary = json.loads((self.evidence / "summary.json").read_text())
        self.assertEqual(summary["checks"]["NEIGHBOUR-1"]["kind"], "neighbour")
        self.assertEqual(summary["neighbours"]["commit"], commit)
        self.assertEqual([(c["id"], c["slice_id"], c["scenario"], c["result"]) for c in summary["neighbours"]["checks"]],
                         [("NEIGHBOUR-1", "SLICE-002", "AC-01", "pass"), ("NEIGHBOUR-2", "SLICE-004", "AC-01", "pass")])
        self.assertEqual(summary["neighbour_failures"], [])

    def test_a_neighbour_must_be_proven_and_one_that_fails_goes_back_to_the_build_station_with_its_own_wording(self):
        self.ship(2, 3)
        self.in_epic()
        self.v_ok("start", TICKET)
        for target in TARGETS + ["NEIGHBOUR-1"]:
            self.record(target)
        self.assertIn("Not proven yet: NEIGHBOUR-2", self.v_refused("finish", TICKET))
        self.record("NEIGHBOUR-2", result="fail", note="Followed the shipped steps; the Members page showed 3 of 5 seats, not 4 of 5.")
        code, out, _ = self.run_verify("finish", TICKET)
        self.assertEqual(code, 1)
        done = json.loads(out)
        self.assertEqual(done["status"], "FAIL_WITH_EVIDENCE")
        self.assertTrue(done["failures"][0].startswith("NEIGHBOUR-2: a shipped scenario of SLICE-002 (AC-01) no longer holds:"), done["failures"])
        findings = (self.evidence / "findings.md").read_text()
        self.assertIn("## A shipped scenario no longer holds", findings)
        self.assertIn("product manager's decision", findings)
        self.assertIn("product-answer", findings)
        self.assertEqual(json.loads((self.evidence / "summary.json").read_text())["neighbour_failures"], ["SLICE-002"])
        self.assertEqual(self.cell_json()["stage"], "built")

    def test_a_slice_the_spec_changes_a_rule_of_is_never_a_neighbour(self):
        self.ship(2, 3, 4)
        self.in_epic()
        spec = self.cellroot / "spec.md"
        spec.write_text(spec.read_text().replace("## Effects on shipped behaviour\n\nNone.\n\n", EFFECTS))
        started = self.v_ok("start", TICKET)
        chosen = [(item["slice_id"], item["scenario"]) for item in started["prove"] if item["kind"] == "neighbour"]
        self.assertEqual(chosen, [("SLICE-003", "AC-01"), ("SLICE-002", "AC-01")])

    def assert_unchanged(self, said):
        started = self.v_ok("start", TICKET)
        self.assertEqual([item["id"] for item in started["prove"]], TARGETS)
        self.assertIn(said, started["neighbours_note"])
        self.assertNotIn("neighbours", json.loads((self.evidence / "results.json").read_text()))

    def test_no_epic_means_no_neighbours(self):
        self.ship(2)
        self.assert_unchanged("belongs to no epic")

    def test_nothing_shipped_in_the_epic_means_no_neighbours(self):
        self.ship(2, epic="EPIC-002")
        self.in_epic()
        self.assert_unchanged("is eligible")

    def test_a_setting_of_zero_switches_it_off(self):
        self.ship(2)
        self.in_epic()
        self.configure({"verify": {"neighbours": 0}})
        self.assert_unchanged("verify.neighbours is 0")

    def test_no_git_history_on_the_integration_branch_is_said_once(self):
        self.in_epic()
        self.configure({"factory": {"integration_branch": "no-such-branch"}})
        started = self.v_ok("start", TICKET)
        self.assertEqual([item["id"] for item in started["prove"]], TARGETS)
        self.assertIn("No neighbouring shipped scenarios", started["neighbours_note"])

    def test_without_the_helper_there_are_no_neighbours(self):
        import verify
        saved = verify.neighbours
        verify.neighbours = None
        try:
            self.ship(2)
            self.in_epic()
            started = self.v_ok("start", TICKET)
        finally:
            verify.neighbours = saved
        self.assertEqual([item["id"] for item in started["prove"]], TARGETS)
        self.assertIn("not installed", started["neighbours_note"])


class ReviewAndRecordTest(Steps, ReviewBase):
    """The choice reaches the review packet's product seat and the change record."""

    def test_the_packet_and_the_change_record_show_the_neighbours(self):
        self.built()
        commit = self.ship(2)
        self.in_epic()
        self.run_verify("start", TICKET)
        (self.evidence / "consumer-run.log").write_text("ok\n")
        for target in TARGETS + ["NEIGHBOUR-1", "NEIGHBOUR-2"]:
            self.run_verify("record", TICKET, target, "--result", "pass", "--evidence", "consumer-run.log", "--note", NOTE)
        self.assertEqual(self.run_verify("finish", TICKET)["status"], "PASS")
        self.r_ok("start", TICKET)
        packet = json.loads((self.round / "packet.json").read_text())
        near = packet["neighbours"]
        self.assertEqual((near["for_seat"], near["commit"], near["epic_id"]), ("product", commit, "EPIC-001"))
        self.assertEqual([(c["id"], c["slice_id"], c["scenario"], c["result"]) for c in near["checks"]], [("NEIGHBOUR-1", "SLICE-002", "AC-01", "pass"), ("NEIGHBOUR-2", "SLICE-002", "AC-02", "pass")])
        info = json.loads((self.cellroot / "cell.json").read_text())
        text = change_record.render(self.cellroot, info, TICKET, {"approved": commit, "base": commit}, merge.issue_rules())
        self.assertIn(f"Shipped scenarios of neighbouring slices proven again, read at commit `{commit}`", text)
        self.assertIn('- NEIGHBOUR-1: SLICE-002 AC-01 "Admin invites a teammate" (a recently shipped slice of the same epic): pass.', text)

    def test_a_packet_without_neighbours_is_as_before(self):
        self.verified()
        self.r_ok("start", TICKET)
        self.assertNotIn("neighbours", json.loads((self.round / "packet.json").read_text()))


if __name__ == "__main__":
    unittest.main()
