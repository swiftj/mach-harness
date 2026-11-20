"""M14 part C: design mocks. An approved picture bound to an interface slice, and the built screen shown beside it.

Studio attaches a picture by its content (`slice mock add`), records its SHA-256 and facts in the work order, and binds the
list's digest into the approval. A slice saved as an issue names its pictures by hash only; the pictures reach the Factory as
files committed at product/ready/SLICE-NNN/mocks/, and intake holds the slice, "waiting for its design mocks", until each is
there and matches. A ready folder carries its pictures inside. Intake keeps them, and dispatch puts them in the cell's mocks/
with a manifest. The verify station requires one side-by-side record per mock for web, desktop and mobile slices; a binding
mock that differs fails the check. The change record lists each mock's hash and result. Nothing reaches the network."""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "ticket" / "scripts"))
import issue_rules  # noqa: E402
import test_mach_product_intake as intake_tests  # noqa: E402
import test_mach_product_issues as issues_tests  # noqa: E402
import test_verify as verify_tests  # noqa: E402
from mock_pictures import jpeg, png  # noqa: E402
from test_build import git  # noqa: E402
from test_mach_product_issues import intent_for, spec_for  # noqa: E402

SPEC_SHA = "a" * 64
WHY_SHA = "b" * 64


def mock_item(data, scenario="AC-01", binding=False, note=None):
    facts, problem = issue_rules.image_facts(data)
    assert problem is None, problem
    return {**facts, "for": scenario, "binding": binding, "note": note}


class RulesTest(unittest.TestCase):
    def test_pictures_are_judged_by_their_content(self):
        self.assertEqual(issue_rules.image_facts(png(4, 3))[0]["format"], "png")
        self.assertEqual({k: v for k, v in issue_rules.image_facts(jpeg(5, 2))[0].items() if k != "sha256"},
                         {"format": "jpeg", "width": 5, "height": 2, "bytes": len(jpeg(5, 2))})
        self.assertEqual(issue_rules.image_facts(png(640, 480))[0]["width"], 640)
        for bad in (b"", b"hello, this is text renamed to .png", png()[:-12], png() + b"x", jpeg()[:-2], b"\x89PNG\r\n\x1a\n" + b"\x00" * 30):
            facts, problem = issue_rules.image_facts(bad)
            self.assertIsNone(facts, bad[:20])
            self.assertTrue(problem)
        self.assertIn("pixels", issue_rules.image_facts(png(20000, 1))[1])
        self.assertIn("larger than 5 MB", issue_rules.image_facts(png() + b"\x00" * (5 * 1024 * 1024))[1])

    def test_a_slice_without_mocks_renders_exactly_as_before(self):
        body = issue_rules.slice_issue_body("SLICE-001", 1, 7, [], "why\n", "spec\n")
        self.assertNotIn("mocks", body)
        self.assertNotIn("mocks_sha256", issue_rules.parse_slice_body(body))
        self.assertNotIn("mocks", issue_rules.approval_comment("SLICE-001", 1, "ada-pm", SPEC_SHA, WHY_SHA))

    def test_the_marker_lists_and_approves_the_mocks_by_hash(self):
        items = sorted([mock_item(png(), "AC-02", True, "The invite form"), mock_item(jpeg(), None)], key=lambda item: item["sha256"])
        body = issue_rules.slice_issue_body("SLICE-001", 1, 7, [], "why\n", "spec\n", jira="ABC-1", mocks=items)
        digest = issue_rules.mocks_sha256(items)
        self.assertIn(f" jira=ABC-1 mocks={digest} -->\nJira: ABC-1\nDesign mocks (the pictures are files in product/ready/SLICE-001/mocks/", body)
        self.assertIn("for AC-02, binding. Note: The invite form\n", body)
        self.assertIn("for the whole slice.\n## Why\n", body)
        parsed = issue_rules.parse_slice_body(body)
        self.assertEqual((parsed["intact"], parsed["mocks"], parsed["mocks_sha256"], parsed["why"]), (True, items, digest, "why\n"))
        for edited in (body.replace(", binding.", "."), body.replace(" Note: The invite form", " Note: Another form"), body.replace("for AC-02", "for AC-03")):
            self.assertFalse(issue_rules.parse_slice_body(edited)["intact"])
        comment = issue_rules.approval_comment("SLICE-001", 1, "ada-pm", SPEC_SHA, WHY_SHA, mocks_sha256=digest)
        self.assertIn(f"- Design mocks SHA-256: `{digest}`\n", comment)
        self.assertEqual(issue_rules.approvals([comment])[0]["mocks_sha256"], digest)

    def test_the_form_of_the_list(self):
        good = mock_item(png(), "AC-01", True)
        self.assertEqual(issue_rules.mock_problems([good]), [])
        for bad in ([], [good] * 2, [{**good, "binding": True, "for": None}], [{**good, "for": "R1"}], [{**good, "note": "a `b`"}],
                    [{**good, "format": "gif"}], [{**good, "extra": 1}], [mock_item(png(shade=n)) for n in range(5)]):
            self.assertTrue(issue_rules.mock_problems(bad), bad)
        with self.assertRaises(ValueError):
            issue_rules.slice_issue_body("SLICE-001", 1, 7, [], "w", "s", mocks=[{**good, "width": 0}])


class StudioTest(issues_tests.IssuesBase):
    def picture(self, name, data):
        path = self.root / "pictures" / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(data)
        return str(path)

    def test_add_checks_the_picture_the_scenario_and_the_limit(self):
        self.project_and_epic()
        self.drafted()
        calls = len(self.gh()["calls"])
        self.assertIn("not a whole PNG or JPEG", self.refused(self.a, "slice", "mock", "add", "SLICE-001", self.picture("renamed.png", b"plain text, not a picture")))
        self.assertIn("cannot be a design mock", self.refused(self.a, "slice", "mock", "add", "SLICE-001", self.picture("big.png", png() + b"\0" * (5 * 1024 * 1024))))
        self.assertIn("not a scenario in SLICE-001's spec", self.refused(self.a, "slice", "mock", "add", "SLICE-001", self.picture("a.png", png()), "--for", "AC-99"))
        self.assertIn("binding for one scenario", self.refused(self.a, "slice", "mock", "add", "SLICE-001", self.picture("a.png", png()), "--binding"))
        added = self.ok(self.a, "slice", "mock", "add", "SLICE-001", self.picture("a.png", png()), "--for", "AC-02", "--binding", "--note", "The invite form")
        self.assertEqual((added["mock"]["for"], added["mock"]["binding"], added["factory_authorized"]), ("AC-02", True, False))
        stored = self.draft(self.a, f"product/mocks/SLICE-001/{added['mock']['sha256']}.png")
        self.assertEqual(stored.read_bytes(), png())
        self.assertIn("already attached", self.refused(self.a, "slice", "mock", "add", "SLICE-001", self.picture("again.png", png())))
        for shade in (1, 2, 3):
            self.ok(self.a, "slice", "mock", "add", "SLICE-001", self.picture(f"s{shade}.png", png(shade=shade)))
        self.assertIn("already has 4 design mocks", self.refused(self.a, "slice", "mock", "add", "SLICE-001", self.picture("j.jpg", jpeg())))
        listed = self.ok(self.a, "slice", "mock", "list", "SLICE-001")["mocks"]
        self.assertEqual((len(listed), [row["problem"] for row in listed]), (4, [None] * 4))
        self.assertTrue(self.ok(self.a, "validate")["valid"])
        removed = self.ok(self.a, "slice", "mock", "remove", "SLICE-001", added["mock"]["sha256"][:10])
        self.assertEqual(removed["removed"]["sha256"], added["mock"]["sha256"])
        self.assertFalse(stored.exists())
        self.assertEqual(len(self.gh()["calls"]), calls, "attaching a picture reaches no one")

    def test_marking_ready_on_github_binds_the_mocks_and_writes_them_to_commit(self):
        self.project_and_epic()
        self.drafted()
        sha = self.ok(self.a, "slice", "mock", "add", "SLICE-001", self.picture("a.png", png()), "--for", "AC-01")["mock"]["sha256"]
        result = self.ready()
        issue = self.issue(result["issue"])
        parsed = issue_rules.parse_slice_body(issue["body"])
        self.assertTrue(parsed["intact"])
        self.assertEqual([item["sha256"] for item in parsed["mocks"]], [sha])
        self.assertEqual(issue_rules.approvals([issue["comments"][-1]["body"]])[0]["mocks_sha256"], parsed["mocks_sha256"])
        self.assertNotIn(png().decode("latin-1")[8:20], issue["body"], "the picture's bytes never go into the issue")
        delivered = self.draft(self.a, f"product/ready/SLICE-001/mocks/{sha}.png")
        self.assertEqual(delivered.read_bytes(), png())
        self.assertEqual((result["mocks"]["commit_as"], result["mocks"]["files"]), ("product/ready/SLICE-001/mocks/", [f"{sha}.png"]))
        self.assertIn("holds SLICE-001 until its design mocks are on the main branch", result["note"])
        # A changed mock needs the slice reopened, and marking it ready again is a new revision.
        self.assertIn("reopen it first", self.refused(self.a, "slice", "mock", "remove", "SLICE-001", sha[:8]))
        self.ok(self.a, "slice", "reopen", "SLICE-001")
        self.ok(self.a, "slice", "mock", "remove", "SLICE-001", sha[:8])
        again = self.ready()
        self.assertEqual((again["issue"], again["revision"], "mocks" in again), (result["issue"], 2, False))
        self.assertNotIn("Design mocks", self.issue(result["issue"])["body"])
        self.assertFalse(delivered.exists())

    def test_without_mocks_the_issue_and_the_result_are_as_before(self):
        self.project_and_epic()
        self.drafted()
        result = self.ready()
        self.assertNotIn("mocks", result)
        self.assertNotIn("mocks", self.issue(result["issue"])["body"])
        self.assertFalse(self.draft(self.a, "product/ready/SLICE-001").exists())

    def test_the_folder_carries_the_pictures(self):
        issues_tests.WithoutGhTest.no_gh(self)
        self.project_and_epic()
        self.drafted()
        sha = self.ok(self.a, "slice", "mock", "add", "SLICE-001", self.picture("a.jpg", jpeg()))["mock"]["sha256"]
        result = self.ready()
        folder = Path(result["folder"])
        record = json.loads((folder / "slice.json").read_text())
        self.assertEqual(([item["sha256"] for item in record["mocks"]], record["revision"]), ([sha], 1))
        self.assertEqual((folder / "mocks" / f"{sha}.jpg").read_bytes(), jpeg())
        self.assertIn(str(folder / "mocks" / f"{sha}.jpg"), result["files"])


class TakeTest(intake_tests.Base):
    def test_a_slice_with_mocks_is_not_taken_from_github(self):
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        self.drafted()
        picture = self.root / "a.png"
        picture.write_bytes(png())
        self.ok(self.a, "slice", "mock", "add", "SLICE-001", str(picture))
        number = self.ok(self.a, "slice", "ready", "SLICE-001")["issue"]
        self.ok(self.b, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together.", "--outcome", "Teams can work together")
        self.set_gh(me="ben-pm")
        self.assertIn("has design mocks", self.refused_studio(self.b, "slice", "take", str(number)))

    def refused_studio(self, project, *argv):
        code, out, err = self.run_studio(project, *argv)
        self.assertEqual(code, 1, out)
        return err


class IntakeTest(intake_tests.Base):
    def commit_pictures(self, slice_id, files):
        """The product manager commits the pictures to the shared main branch; the engineer's checkout is brought up to date."""
        git(self.a, "pull", "-q", "--ff-only")
        folder = self.a / "product/ready" / slice_id / "mocks"
        folder.mkdir(parents=True, exist_ok=True)
        for name, data in files.items():
            (folder / name).write_bytes(data)
        git(self.a, "add", "-A")
        git(self.a, "commit", "-q", "-m", f"design mocks for {slice_id}")
        git(self.a, "push", "-q", "origin", "main")
        git(self.eng, "pull", "-q", "--ff-only")

    def studio_ready(self, data=None, binding=True):
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        self.drafted()
        picture = self.root / "screen.png"
        picture.write_bytes(data or png())
        args = ["--for", "AC-01"] + (["--binding"] if binding else [])
        mock = self.ok(self.a, "slice", "mock", "add", "SLICE-001", str(picture), *args)["mock"]
        result = self.ok(self.a, "slice", "ready", "SLICE-001")
        self.set_gh(me="erin-eng")
        return result, mock

    def test_an_issue_waits_for_its_mocks_then_reaches_the_cell(self):
        result, mock = self.studio_ready()
        number = result["issue"]
        taken = self.product("intake")
        self.assertEqual(taken["created"], [])
        waiting = [item for item in taken["not_accepted"] if item.get("issue") == number]
        self.assertEqual(waiting[0]["waiting"], "mocks")
        self.assertIn("Waiting for its design mocks", waiting[0]["reason"])
        self.assertIn(f"product/ready/SLICE-001/mocks/{mock['sha256']}.png: it is not there", waiting[0]["reason"])
        self.assertNotIn("SLICE-001", self.ledger()["slices"])
        # The product manager commits exactly what Studio wrote for them.
        delivered = Path(result["mocks"]["folder"])
        self.commit_pictures("SLICE-001", {path.name: path.read_bytes() for path in delivered.iterdir()})
        taken = self.product("intake")
        self.assertEqual(([c["slice_id"] for c in taken["created"]], taken["not_accepted"]), (["SLICE-001"], []))
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertEqual([item["sha256"] for item in entry["mocks"]], [mock["sha256"]])
        self.assertEqual((self.eng / entry["stored"] / "mocks" / f"{mock['sha256']}.png").read_bytes(), png())
        self.product("dispatch", str(number))
        cell = self.cell(str(number))
        self.assertEqual(([item["sha256"] for item in cell["product"]["mocks"]], cell["product"]["mocks"][0]["binding"]), ([mock["sha256"]], True))
        folder = self.eng / ".factory/worktrees" / str(number) / "mocks"
        manifest = json.loads((folder / "manifest.json").read_text())
        self.assertEqual(manifest["mocks"][0]["file"], f"{mock['sha256']}.png")
        self.assertEqual((folder / f"{mock['sha256']}.png").read_bytes(), png())

    def test_a_picture_that_does_not_match_its_hash_is_held(self):
        result, mock = self.studio_ready()
        self.commit_pictures("SLICE-001", {f"{mock['sha256']}.png": png(shade=9)})
        taken = self.product("intake")
        self.assertEqual(taken["created"], [])
        self.assertIn("its SHA-256 is not the approved one", taken["not_accepted"][0]["reason"])
        self.commit_pictures("SLICE-001", {f"{mock['sha256']}.png": b"text where a picture should be"})
        self.assertIn("not a whole PNG or JPEG", self.product("intake")["not_accepted"][0]["reason"])

    def test_mocks_changed_after_approval_are_refused(self):
        result, mock = self.studio_ready()
        state = self.gh()
        issue = state["issues"][str(result["issue"])]
        other = mock_item(png(shade=5), "AC-01", True)
        issue["body"] = issue_rules.slice_issue_body("SLICE-001", 1, result["epic_issue"], [], intent_for("SLICE-001"), spec_for("SLICE-001"), mocks=[other])
        issue["updatedAt"] = self.tick(state)
        self.write_state(state)
        taken = self.product("intake")
        self.assertEqual(taken["not_accepted"][0]["reason"], issue_rules.SLICE_NOT_ACCEPTED["mocks_changed"])

    def test_a_ready_folder_carries_its_pictures_and_a_tampered_one_is_refused(self):
        good, bad = self.slice(self.a, "Invite"), self.slice(self.a, "Other")
        pictures = {}
        for slice_id, data in ((good, png()), (bad, jpeg())):
            item = mock_item(data, "AC-01")
            record = json.loads(self.folders[slice_id]["slice.json"])
            record["mocks"] = [item]
            self.folders[slice_id]["slice.json"] = json.dumps(record)
            pictures[slice_id] = {issue_rules.mock_file_name(item): data if slice_id == good else jpeg(6, 2)}
        self.publish(self.a, good, bad)
        for slice_id, files in pictures.items():
            self.commit_pictures(slice_id, files)
        taken = self.product("intake")
        self.assertEqual([item["slice_id"] for item in taken["created"]], [good])
        self.assertIn("is not the approved picture", taken["not_accepted"][0]["reason"])
        self.product("dispatch", good)
        self.assertTrue((self.eng / ".factory/worktrees/LOCAL-001/mocks/manifest.json").is_file())

    def test_a_folder_without_mocks_still_needs_exactly_its_three_files(self):
        self.first()
        self.commit_pictures("SLICE-001", {"stray.png": png()})
        taken = self.product("intake")
        self.assertEqual(taken["created"], [])
        self.assertIn("holds pictures that its slice.json does not list", taken["not_accepted"][0]["reason"])

    def test_a_slice_without_mocks_is_taken_in_and_dispatched_as_before(self):
        number = self.ready("SLICE-001")
        self.product("intake")
        self.assertNotIn("mocks", self.ledger()["slices"]["SLICE-001"])
        self.product("dispatch", str(number))
        self.assertNotIn("mocks", self.cell(str(number))["product"])
        self.assertFalse((self.eng / ".factory/worktrees" / str(number) / "mocks").exists())


class VerifyTest(verify_tests.Base):
    def setUp(self):
        super().setUp()
        self.built()

    def with_mocks(self, *items, app_type="web"):
        cell = self.cell_json()
        cell["app_type"] = app_type
        (self.cellroot / "cell.json").write_text(json.dumps(cell))
        folder = self.cellroot / "mocks"
        folder.mkdir()
        listed = []
        for data, scenario, binding in items:
            item = mock_item(data, scenario, binding)
            (folder / issue_rules.mock_file_name(item)).write_bytes(data)
            listed.append({**item, "file": issue_rules.mock_file_name(item)})
        (folder / "manifest.json").write_text(json.dumps({"schema_version": 1, "mocks": sorted(listed, key=lambda item: item["sha256"])}))
        return self.v_ok("start", "LOCAL-001")

    def prove_all(self):
        for target in verify_tests.TARGETS:
            self.record(target)
        (self.evidence / "flow.webm").write_bytes(b"video")

    def screen(self, name="screen.png", data=None):
        (self.evidence / name).write_bytes(data or png(8, 8))
        return name

    def test_each_mock_needs_a_side_by_side_record(self):
        started = self.with_mocks((png(), "AC-01", True))
        mock = started["compare_with_mocks"][0]
        self.assertEqual((mock["id"], mock["for"], mock["binding"]), ("MOCK-1", "AC-01", True))
        self.assertEqual((self.cellroot / mock["file"]).read_bytes(), png())
        self.prove_all()
        self.screen()
        out = self.v_refused("finish", "LOCAL-001")
        self.assertIn("No side-by-side record for MOCK-1 (the design mock for AC-01, binding)", out)
        self.assertIn("mocks_remaining", self.v_ok("status", "LOCAL-001"))
        note = "Opened the invite form after AC-01 and set it beside the mock."
        base = ["compare", "LOCAL-001", "MOCK-1", "--note", note]
        self.assertIn("must include a picture", self.v_refused(*base, "--result", "matches", "--capture", self.capture("form.log", "text")))
        self.assertIn("approved design mock, not evidence", self.v_refused(*base, "--result", "matches", "--capture", mock["file"][len("evidence/"):]))
        self.assertIn("each difference in plain words", self.v_refused(*base, "--result", "differs", "--capture", self.screen()))
        self.assertIn("approved design mock, not evidence", self.v_refused("record", "LOCAL-001", "AC-01", "--result", "pass", "--evidence",
                                                                          mock["file"][len("evidence/"):], "--note", note))
        self.v_ok(*base, "--result", "matches", "--capture", self.screen())
        done = self.v_ok("finish", "LOCAL-001")
        self.assertEqual(done["status"], "PASS")
        summary = json.loads((self.evidence / "summary.json").read_text())
        self.assertEqual((summary["mocks"]["MOCK-1"]["result"], summary["mocks"]["MOCK-1"]["capture"], summary["mock_findings"]), ("matches", ["screen.png"], []))
        self.assertEqual(summary["checks"]["MOCK-1"]["evidence"], [mock["file"][len("evidence/"):], "screen.png"], "the mock is catalogued beside the capture")
        self.assertNotIn(mock["file"][len("evidence/"):], summary["evidence_kinds"]["screenshot"], "the mock never counts as a screenshot")

    def test_a_binding_mock_that_differs_fails_the_check(self):
        self.with_mocks((png(), "AC-01", True))
        self.prove_all()
        self.v_ok("compare", "LOCAL-001", "MOCK-1", "--result", "differs", "--capture", self.screen(), "--difference", "The Send button is missing below the email field.",
                  "--note", "Opened the invite form after AC-01 and set it beside the mock.")
        code, out, _ = self.run_verify("finish", "LOCAL-001")
        self.assertEqual((code, json.loads(out)["status"]), (1, "FAIL_WITH_EVIDENCE"))
        self.assertIn("MOCK-1 (design mock): differs:", (self.evidence / "findings.md").read_text())
        self.assertIn("The Send button is missing", (self.evidence / "findings.md").read_text())

    def test_a_non_binding_difference_or_no_comparison_goes_to_the_product_seat(self):
        self.with_mocks((png(), "AC-01", False), (jpeg(), None, False))
        self.prove_all()
        self.v_ok("compare", "LOCAL-001", "MOCK-1" if mock_item(png())["sha256"] < mock_item(jpeg())["sha256"] else "MOCK-2", "--result", "differs",
                  "--capture", self.screen(), "--difference", "The heading is larger than in the mock.", "--note", "Compared the invite form with the mock.")
        other = "MOCK-2" if mock_item(png())["sha256"] < mock_item(jpeg())["sha256"] else "MOCK-1"
        self.v_ok("compare", "LOCAL-001", other, "--result", "cannot-compare", "--note", "The mock shows a mobile layout this web slice has no screen for.")
        self.assertEqual(self.v_ok("finish", "LOCAL-001")["status"], "PASS")
        summary = json.loads((self.evidence / "summary.json").read_text())
        self.assertEqual(len(summary["mock_findings"]), 2)
        self.assertTrue(any("differs: The heading is larger" in item for item in summary["mock_findings"]))
        self.assertTrue(any("could not be compared" in item for item in summary["mock_findings"]))

    def test_a_binding_mock_that_could_not_be_compared_is_not_proven(self):
        self.with_mocks((png(), "AC-01", True))
        self.prove_all()
        self.v_ok("compare", "LOCAL-001", "MOCK-1", "--result", "cannot-compare", "--note", "The screen needs a login the test project has no account for.")
        code, out, _ = self.run_verify("finish", "LOCAL-001")
        self.assertNotEqual(code, 0)
        self.assertIn("INCOMPLETE_EVIDENCE", out)
        self.assertIn("it is binding, so it is not proven", out)

    def test_a_changed_mock_in_the_cell_stops_verification(self):
        cell = self.cell_json()
        cell["app_type"] = "web"
        (self.cellroot / "cell.json").write_text(json.dumps(cell))
        folder = self.cellroot / "mocks"
        folder.mkdir()
        item = mock_item(png())
        (folder / issue_rules.mock_file_name(item)).write_bytes(png(shade=3))
        (folder / "manifest.json").write_text(json.dumps({"mocks": [{**item, "file": issue_rules.mock_file_name(item)}]}))
        self.assertIn("is not the approved picture", self.v_refused("start", "LOCAL-001"))

    def test_other_app_types_and_slices_without_mocks_are_unchanged(self):
        started = self.with_mocks((png(), "AC-01", True), app_type="library")
        self.assertNotIn("compare_with_mocks", started)
        for target in verify_tests.TARGETS:
            self.record(target)
        self.assertEqual(self.v_ok("finish", "LOCAL-001")["status"], "PASS")
        summary = json.loads((self.evidence / "summary.json").read_text())
        self.assertNotIn("mocks", summary)


class ChangeRecordTest(unittest.TestCase):
    def test_the_record_lists_each_mocks_hash_and_result(self):
        sys.path.insert(0, str(ROOT / "skills" / "merge" / "scripts"))
        import change_record  # noqa: E402
        t = change_record.Text(issue_rules)
        lines = change_record.mock_lines(t, {"MOCK-1": {"sha256": "c" * 64, "for": "AC-02", "binding": True, "result": "differs",
                                                        "differences": ["The Send button is missing."]},
                                             "MOCK-2": {"sha256": "nope", "for": None, "binding": False, "result": "matches"}})
        self.assertIn(f"- MOCK-1: SHA-256 `{'c' * 64}`, for AC-02, binding: differs. The Send button is missing.", lines)
        self.assertIn("- MOCK-2: SHA-256 (not recorded), for the whole slice: matches.", lines)
        self.assertEqual(change_record.mock_lines(t, None), [])


if __name__ == "__main__":
    unittest.main()
