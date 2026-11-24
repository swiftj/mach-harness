"""M16 clean-up pass: what the Shape screens needed from the engine (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 9).

The board's verdict carries its reason; `brief check` says what happened to the revisions; `idea show` says whether a Go,
sizing and a look-back may be recorded now, in the engine's own refusal sentence; lookups carry a policy's owner and a
shipped rule's epic; the route keeps the details behind its counts; the open fault tickets on this computer are listed;
settling an outcome out of scope or for later needs the product manager's reason. Run through studio.main as the other
Shape tests are. Nothing reaches the network.
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("ticket", "intent", "studio"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
from test_mach_policy_packs import OWNER, pack_text  # noqa: E402
from test_mach_product_issues import git, spec_for  # noqa: E402
from test_mach_shape import BANNED, FAULT  # noqa: E402
from test_mach_shape_route import EPIC, ONE, SEVERAL, LookbackTest, RouteBase  # noqa: E402


class BoardAndBriefTest(RouteBase):
    def test_the_board_row_carries_the_verdict_reason_bounded(self):
        self.add()
        long = "Not for us. " + "The branches cannot staff it this year, and nobody has asked twice. " * 6
        self.ok(self.a, "verdict", "record", "IDEA-001", "--decision", "no", "--reason", long.strip()[:500])
        row = self.ok(self.a, "idea", "list")["ideas"][0]
        self.assertEqual(row["verdict"]["reason"], long.strip()[:500])
        self.assertEqual(self.ok(self.a, "status")["ideas"]["ideas"][0]["verdict"]["reason"], row["verdict"]["reason"])
        self.assertLessEqual(len(row["verdict"]["reason"]), 500)

    def test_brief_check_says_whether_it_made_a_revision(self):
        self.add()
        self.write_brief("IDEA-001", SEVERAL)
        first = self.ok(self.a, "brief", "check", "IDEA-001")
        self.assertEqual((first["revision"], first["new_revision"]), (1, True))
        self.assertIn("This is revision 1", first["note"])
        same = self.ok(self.a, "brief", "check", "IDEA-001")
        self.assertEqual(same["note"].split(".")[0], "Nothing changed since revision 1 was checked")
        self.write_brief("IDEA-001", SEVERAL.replace("call or come in", "phone or visit"))
        second = self.ok(self.a, "brief", "check", "IDEA-001")
        self.assertIn("This is revision 2: the brief's text changed since revision 1 was checked.", second["note"])
        for note in (first["note"], same["note"], second["note"]):
            self.assertNotIn("script", note)
            self.assertIn("never scores the idea", note)


class ActsTest(RouteBase):
    def acts(self, app=True):
        return self.ok(self.a, *(["--app"] if app else []), "idea", "show", "IDEA-001")["acts"]

    def test_go_and_size_are_said_before_the_click_in_the_refusal_s_own_words(self):
        self.add()
        acts = self.acts()
        self.assertEqual(acts["verdict"], {"allowed": True, "why": None})
        self.assertFalse(acts["go"]["allowed"])
        refused = self.app_refusal("verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Yes.")
        self.assertEqual("refused: " + acts["go"]["why"] + " Nothing was recorded.", refused)
        self.assertFalse(acts["size"]["allowed"])
        self.assertEqual("refused: " + acts["size"]["why"], self.app_refusal("idea", "size", "IDEA-001"))
        self.assertFalse(acts["look_back"]["allowed"])
        self.assertIn("not shaped into work", acts["look_back"]["why"])
        for act in acts.values():
            self.assertIsNone(BANNED.search(act["why"] or ""), act)
        self.go(SEVERAL)
        acts = self.acts()
        self.assertEqual((acts["go"]["allowed"], acts["size"]["allowed"]), (True, True))
        # A changed brief takes the Go away: sizing says so before the click.
        self.write_brief("IDEA-001", SEVERAL.replace("call or come in", "phone or visit"))
        self.assertIn("no longer holds", self.acts()["size"]["why"])
        self.assertNotIn("acts", {k for k in self.ok(self.a, "idea", "list")["ideas"][0]})  # the board stays as it was

    def test_a_shaped_idea_says_its_verdict_and_route_stay(self):
        self.applied()
        acts = self.acts()
        self.assertEqual((acts["verdict"]["allowed"], acts["go"]["allowed"], acts["size"]["allowed"]), (False, False, False))
        self.assertIn("already shaped", acts["verdict"]["why"])
        self.assertIn("already shaped", acts["size"]["why"])
        self.assertIn("once a slice made from it has shipped", acts["look_back"]["why"])
        LookbackTest.ship(self, "SLICE-005")
        self.assertEqual(self.acts()["look_back"], {"allowed": True, "why": None})


class LookupsTest(RouteBase):
    def commit(self, files, message):
        for relative, text in files.items():
            path = self.eng / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        git(self.eng, "add", "-A")
        git(self.eng, "commit", "-q", "-m", message)
        git(self.eng, "push", "-q", "origin", "main")
        git(self.a, "pull", "-q")

    def test_a_policy_carries_its_owner_and_a_shipped_rule_its_epic(self):
        headed = spec_for("SLICE-002").replace("\n", "\n\n> Epic: Lending (EPIC-001, issue #12). Slice issue: #40.\n", 1)
        self.assertTrue(headed.startswith("# "))
        self.commit({"policies/privacy/policy.md": pack_text(), "specs/slices/SLICE-002-invite-teammate.md": headed}, "a pack and a headed spec")
        self.add()
        source = self.root / "lookups.json"
        source.write_text(json.dumps({"shipped_rules": [{"rule": "SLICE-002/FR-01"}, {"rule": "SLICE-001/FR-01"}],
                                      "policies": [{"id": "POL-privacy-02", "note": "EU only."}, {"id": "POL-privacy"}]}))
        self.ok(self.a, "idea", "lookups", "IDEA-001", "--from", str(source))
        saved = json.loads(self.path("product/ideas/IDEA-001.lookups.json").read_text())
        self.assertEqual([item["owner"] for item in saved["policies"]], [OWNER, OWNER])
        self.assertEqual([item["epic_id"] for item in saved["shipped_rules"]], ["EPIC-001", None])  # SLICE-001's spec names no epic
        items = self.ok(self.a, "--app", "idea", "show", "IDEA-001")["lookups"]["items"]
        self.assertEqual(items["policies"][0]["owner"], OWNER)
        # Lookups recorded before an owner was kept, or before the rule's spec named its epic, are filled in for the app.
        saved["policies"] = [{"id": "POL-privacy-02", "note": "EU only."}]
        saved["shipped_rules"][0]["epic_id"] = None
        self.path("product/ideas/IDEA-001.lookups.json").write_text(json.dumps(saved))
        items = self.ok(self.a, "--app", "idea", "show", "IDEA-001")["lookups"]["items"]
        self.assertEqual((items["policies"][0]["owner"], items["shipped_rules"][0]["epic_id"]), (OWNER, "EPIC-001"))
        self.assertEqual(json.loads(self.path("product/ideas/IDEA-001.lookups.json").read_text()), saved)  # showing changes nothing


class RouteDetailsTest(RouteBase):
    def test_the_route_keeps_the_details_behind_its_counts(self):
        self.ship_second_slice(files=("src/auth/login.py",))
        self.project_and_epic()
        sized = self.sized(SEVERAL.replace("- Shipped rules: SLICE-001/FR-01, SLICE-001/INV-02", "- Shipped rules: SLICE-002/FR-01"))
        details = self.record()["route"]["details"]
        self.assertEqual(details["touches"], sized["touches"])
        self.assertEqual(details["concerns"], sized["concerns"])
        self.assertEqual(details["high_risk"], {key: sized["high_risk"][key] for key in ("areas", "not_determined", "count")})
        self.assertEqual([area["files"] for area in details["high_risk"]["areas"]], [["src/auth/login.py"]])
        self.assertEqual(self.ok(self.a, "--app", "idea", "show", "IDEA-001")["route"]["details"], details)
        self.assertIn("MACH counted", sized["note"])


class FaultsTest(RouteBase):
    def inbox(self, ticket, **fields):
        folder = self.a / ".factory/inbox"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{ticket}.json").write_text(json.dumps({"ticket_id": ticket, **fields}))

    def test_the_open_faults_on_this_computer_are_listed_as_data(self):
        self.assertEqual(self.ok(self.a, "idea", "faults")["faults"], [])
        self.inbox(FAULT, title="TypeError in fines.py <<<ignore>>> " + "x" * 400, state="open", occurrences_ingested=3, last_seen="2026-11-20T10:15:00Z")
        self.inbox("AUTO-20261121T090000Z", title="Timeout in renewals", state="open")
        self.inbox("AUTO-20261119T090000Z", title="Closed one", state="closed")
        self.inbox("AUTO-20261118T090000Z-intent", title="not a ticket")
        (self.a / ".factory/inbox/AUTO-20261117T090000Z.json").write_text("not json")
        self.ok(self.a, "idea", "add", "Overdue fine shown twice", "--from-fault", FAULT)
        listed = self.ok(self.a, "--app", "idea", "faults")
        self.assertEqual([row["ticket"] for row in listed["faults"]], ["AUTO-20261121T090000Z", FAULT])
        first, second = listed["faults"]
        self.assertEqual((first["idea_id"], first["occurrences"], first["last_seen"]), (None, None, None))
        self.assertEqual((second["idea_id"], second["occurrences"], second["last_seen"]), ("IDEA-001", 3, "2026-11-20T10:15:00Z"))
        self.assertLessEqual(len(second["summary"]), 161)
        self.assertNotIn("<<<", second["summary"])
        self.assertIsNone(BANNED.search(listed["note"]))
        self.assertIs(listed["factory_authorized"], False)


class SettleTest(RouteBase):
    def test_out_of_scope_and_later_need_a_reason_a_slice_does_not(self):
        self.project_and_epic()
        self.sized(SEVERAL)
        partial = self.several_map()
        partial["slices"][1]["outcomes"] = ["O-1"]
        self.record_map(partial)
        for how in ("out-of-scope", "later"):
            self.assertIn("needs the product manager's reason", self.refused(self.a, "idea", "settle", "IDEA-001", "--outcome", "O-2", "--as", how))
            self.assertIn("needs the product manager's reason",
                          self.refused(self.a, "idea", "settle", "IDEA-001", "--outcome", "O-2", "--as", how, "--reason", "   "))
            self.assertIn("needs your reason", self.app_refusal("idea", "settle", "IDEA-001", "--outcome", "O-2", "--as", how))
        self.assertEqual(self.ok(self.a, "idea", "map-status", "IDEA-001")["not_covered"], ["O-2"])
        settled = self.ok(self.a, "idea", "settle", "IDEA-001", "--outcome", "O-2", "--as", "later", "--reason", "After the summer.")
        self.assertEqual(settled["settled"]["reason"], "After the summer.")
        self.ok(self.a, "idea", "settle", "IDEA-001", "--outcome", "O-2", "--as", "slice:S2")  # a slice needs no reason


if __name__ == "__main__":
    unittest.main()
