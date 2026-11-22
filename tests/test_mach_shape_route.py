"""M16 part B: Shape's sizing and routing, the map and apply, change what exists, looking back and the chain (shape_route.py).

Run through studio.main in temporary Git projects with the stand-in for gh from test_mach_product_issues, as Part A's tests
are. The route's rule is tested on every branch, and its staleness; the map is the PRD on-ramp's, so its own refusals are
tested only where Shape adds to them (outcomes, the route's shape). A slice made from an idea names what it serves in its
why, and the Factory repeats it in the spec's header line, which is taken off again before any hash is checked. Nothing
reaches the network.
"""

import argparse
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("ticket", "intent", "product-studio"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
import collab  # noqa: E402
import intake  # noqa: E402
import issue_rules  # noqa: E402
import shape  # noqa: E402
import shape_route  # noqa: E402
import studio  # noqa: E402
from test_mach_product_issues import git, intent_for, spec_for  # noqa: E402
from test_mach_product_intake import Base as IntakeBase  # noqa: E402
from test_mach_shape import ShapeBase  # noqa: E402
from test_mach_shape_brief import BRIEF  # noqa: E402

O2 = ("- **O-2:** Members are not surprised by a renewal that was refused.\n"
      "  - How we would know: complaints about unexpected fines after a refused renewal fall to none in a quarter.\n")
EFFECTS = ("## Effects on shipped behaviour\n\n| Shipped rule | Effect | In this slice | Note |\n|---|---|---|---|\n"
           "| SLICE-001/INV-02 | kept | AC-01 | Still one per address. |\n| SLICE-001/FR-09 | replaced | FR-09 | |\n")


def brief_with(outcomes=2, capabilities="Lending (EPIC-001), Member account", rules="SLICE-001/FR-01, SLICE-001/INV-02"):
    text = BRIEF if outcomes == 2 else BRIEF.replace(O2, "")
    text = text.replace("- Capabilities: Lending (EPIC-001), Member account", f"- Capabilities: {capabilities}")
    return text.replace("- Shipped rules: SLICE-004/FR-02, SLICE-007/INV-01", f"- Shipped rules: {rules}")


SEVERAL = brief_with()
EPIC = brief_with(capabilities="Lending (EPIC-001)")
ONE = brief_with(outcomes=1, capabilities="Lending (EPIC-001)")


class RouteBase(ShapeBase):
    def go(self, text=SEVERAL, idea_id="IDEA-001", title="Let members renew a loan themselves"):
        if not self.path(f"product/ideas/{idea_id}.json").exists():
            self.add(title)
        self.write_brief(idea_id, text)
        return self.ok(self.a, "verdict", "record", idea_id, "--decision", "go", "--reason", "Members ask for it at every desk.")

    def sized(self, text=SEVERAL, idea_id="IDEA-001"):
        self.go(text, idea_id)
        return self.ok(self.a, "idea", "size", idea_id)

    def map_file(self, data):
        source = self.root / "map.json"
        source.write_text(json.dumps(data))
        return str(source)

    def record_map(self, data, idea_id="IDEA-001"):
        return self.ok(self.a, "idea", "map", idea_id, "--from", self.map_file(data))

    def map_refused(self, data, idea_id="IDEA-001"):
        return self.refused(self.a, "idea", "map", idea_id, "--from", self.map_file(data))

    def several_map(self):
        return {"epics": [{"key": "E1", "title": "Renew loans yourself", "criteria": ["A member renews without calling"]},
                          {"key": "E2", "title": "Member notices", "criteria": ["A refusal says why"]}],
                "slices": [{"key": "S1", "title": "Renew a loan from my loans", "scope": "One loan, from the loans page", "epic": "E1",
                            "depends_on": [], "outcomes": ["O-1"], "cites": ["9-10"]},
                           {"key": "S2", "title": "Say why a renewal is refused", "scope": "The reason, on the loans page", "epic": "E2",
                            "depends_on": ["S1"], "outcomes": ["O-2"], "cites": ["11-12"]}]}

    def ship_second_slice(self, files=(), effects=EFFECTS):
        """SLICE-002 shipped on main: the fixture's rules again, keeping SLICE-001/INV-02 and replacing SLICE-001/FR-09."""
        spec = self.eng / "specs" / "slices" / "SLICE-002-invite-teammate.md"
        spec.write_text(spec_for("SLICE-002", extra=effects))
        for name in files:
            target = self.eng / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("# code\n")
        git(self.eng, "add", "-A")
        git(self.eng, "commit", "-q", "-m", "SLICE-002 shipped")
        git(self.eng, "push", "-q", "origin", "main")
        git(self.a, "pull", "-q")

    def applied(self, text=SEVERAL, data=None):
        self.project_and_epic()
        self.sized(text)
        self.record_map(data or self.several_map())
        return self.ok(self.a, "idea", "apply", "IDEA-001")


class RouteRuleTest(unittest.TestCase):
    def test_every_branch_of_the_rule(self):
        self.assertEqual(shape_route.route_for(1, 0, 1)[0], "one-slice")
        self.assertEqual(shape_route.route_for(1, 3, 2)[0], "one-slice")  # one outcome and at most three rules, whatever the capabilities
        self.assertEqual(shape_route.route_for(1, 4, 1), ("epic", "The brief has one outcome but 4 shipped rules, more than three, inside one capability, so the route is an epic."))
        self.assertEqual(shape_route.route_for(2, 0, 1), ("epic", "The brief has 2 outcomes inside one capability, so the route is an epic."))
        self.assertEqual(shape_route.route_for(1, 4, 2)[0], "several-epics")
        self.assertEqual(shape_route.route_for(3, 1, 2), ("several-epics", "The brief's outcomes are in 2 different capabilities, so the route is several epics."))
        self.assertEqual(shape_route.route_for(1, 1, 1)[1], "The brief has one outcome and 1 shipped rule, at most three, so the route is one slice.")

    def test_capabilities_are_counted_by_epic_or_name(self):
        model = {"touches": {"capabilities": [{"name": "Lending", "epic_id": "EPIC-001"}, {"name": "Lending again", "epic_id": "EPIC-001"},
                                              {"name": "Member  Account", "epic_id": None}, {"name": "member account", "epic_id": None}]}}
        self.assertEqual(shape_route.capability_count(model), 2)


class SizeTest(RouteBase):
    def test_size_needs_a_go_that_holds_for_the_brief_as_it_is(self):
        self.add()
        self.assertIn("needs a Go verdict", self.refused(self.a, "idea", "size", "IDEA-001"))
        self.write_brief("IDEA-001", SEVERAL)
        self.ok(self.a, "verdict", "record", "IDEA-001", "--decision", "not-now", "--reason", "Later.")
        self.assertIn("needs a Go verdict", self.refused(self.a, "idea", "size", "IDEA-001"))
        self.go()
        self.write_brief("IDEA-001", SEVERAL.replace("call or come in", "phone or visit"))
        self.assertIn("no longer holds", self.refused(self.a, "idea", "size", "IDEA-001"))
        self.assertIsNone(self.record().get("route"))

    def test_the_three_routes_from_the_brief_and_the_counts_recorded(self):
        for text, route in ((ONE, "one-slice"), (EPIC, "epic"), (SEVERAL, "several-epics")):
            with self.subTest(route=route):
                sized = self.sized(text)
                self.assertEqual(sized["route"], route)
                recorded = self.record()["route"]
                self.assertEqual((recorded["route"], recorded["why"], recorded["revision"]), (route, sized["why"], self.record()["revision"]))
                self.assertEqual(recorded["counted"]["shipped_rules"], 2)
                self.assertEqual(recorded["counted"]["high_risk_areas"], 0)  # SLICE-001's commit changed only its spec
                self.assertIs(sized["factory_authorized"], False)
        self.assertEqual(self.record()["route"]["counted"]["capabilities"], 2)
        self.assertEqual(self.record()["route"]["counted"]["outcomes"], 2)
        many = brief_with(outcomes=1, capabilities="Lending (EPIC-001)",
                          rules="SLICE-001/FR-01, SLICE-001/FR-02, SLICE-001/FR-03, SLICE-001/FR-04")
        self.assertEqual(self.sized(many)["route"], "epic")
        self.assertEqual(self.sized(brief_with(outcomes=1, rules="SLICE-001/FR-01, SLICE-001/FR-02, SLICE-001/FR-03, SLICE-001/FR-04"))["route"],
                         "several-epics")

    def test_concerns_come_from_the_lookups(self):
        self.go(EPIC)
        project = self.a / ".factory/studio/draft/product"
        self.project_and_epic()
        self.ok(self.a, "principle", "add", "--title", "Tell before charging", "--statement", "A member MUST be told before any charge.",
                "--reason", "Trust.")
        source = self.root / "lookups.json"
        source.write_text(json.dumps({"shipped_rules": [{"rule": "SLICE-001/FR-01", "note": "seat"}], "principles": [{"id": "PP-01", "note": "charges"}]}))
        self.ok(self.a, "idea", "lookups", "IDEA-001", "--from", str(source))
        counted = self.ok(self.a, "idea", "size", "IDEA-001")["counted"]
        self.assertEqual((counted["principle_concerns"], counted["policy_concerns"], counted["shipped_rules_looked_up"]), (1, 0, 1))
        self.assertTrue(project.is_dir())

    def test_a_changed_brief_makes_the_route_stale_as_it_does_the_verdict(self):
        self.sized(SEVERAL)
        self.assertEqual(self.ok(self.a, "status")["ideas"]["ideas"][0]["next"]["kind"], "map")
        self.write_brief("IDEA-001", SEVERAL.replace("call or come in", "phone or visit"))
        view = shape_route.route_view(shape.Ideas(studio, studio.Studio(self.a)), self.record())
        self.assertTrue(view["stale"])
        self.assertIn("no longer holds", self.refused(self.a, "idea", "map", "IDEA-001", "--from", self.map_file(self.several_map())))
        self.ok(self.a, "brief", "check", "IDEA-001")
        self.assertEqual(self.ok(self.a, "status")["ideas"]["ideas"][0]["next"]["kind"], "record_verdict")
        self.ok(self.a, "verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Still yes.")
        self.assertEqual(self.ok(self.a, "status")["ideas"]["ideas"][0]["next"]["kind"], "size")
        self.ok(self.a, "idea", "size", "IDEA-001")
        self.assertFalse(shape_route.route_view(shape.Ideas(studio, studio.Studio(self.a)), self.record())["stale"])


class HighRiskTest(RouteBase):
    def test_high_risk_areas_are_the_scan_rule_on_what_the_rules_slices_changed(self):
        self.ship_second_slice(files=("src/auth/login.py", "src/billing/invoice.py", "src/catalogue/search.py"))
        self.go(brief_with(rules="SLICE-002/FR-01, SLICE-001/FR-01"))
        sized = self.ok(self.a, "idea", "size", "IDEA-001")
        self.assertEqual(sized["counted"]["high_risk_areas"], 2)
        areas = {area["area"]: area for area in sized["high_risk"]["areas"]}
        self.assertEqual(sorted(len(area["files"]) for area in areas.values()), [1, 1])
        self.assertTrue(any("sign-in" in name for name in areas) and any("billing" in name for name in areas))
        self.assertTrue(all(area["rules"] == ["SLICE-002/FR-01"] for area in areas.values()))
        self.assertIn("integration branch", sized["high_risk"]["basis"])
        self.assertEqual(sized["route"], "several-epics")  # counted, never part of the rule

    def test_nothing_local_to_decide_is_not_determined_never_guessed(self):
        here = studio.Studio(self.a)
        here._shipped = {"commit": None, "branch": None, "rules": [], "in_force": [], "notes": []}
        found = shape_route.high_risk(studio, here, ["SLICE-001/FR-01"])
        self.assertEqual((found["count"], found["not_determined"]), (None, ["SLICE-001/FR-01"]))
        self.assertIn("Not determined", found["not_determined_note"])
        self.assertIsNone(shape_route.changed_files(studio.Studio(self.a), git(self.a, "rev-parse", "HEAD").strip(), "specs/slices/SLICE-404-none.md"))
        self.assertEqual(shape_route.high_risk(studio, studio.Studio(self.a), [])["count"], 0)


class MapTest(RouteBase):
    def test_map_settle_and_apply_with_their_refusals(self):
        self.project_and_epic()
        self.go(SEVERAL)
        self.assertIn("has not been sized", self.map_refused(self.several_map()))
        self.ok(self.a, "idea", "size", "IDEA-001")
        bad = self.several_map()
        del bad["slices"][0]["outcomes"]
        self.assertIn("'outcomes' lists the brief's outcomes", self.map_refused(bad))
        bad = self.several_map()
        bad["slices"][0]["outcomes"] = ["O-9"]
        self.assertIn("O-9 is not an outcome of the brief", self.map_refused(bad))
        bad = self.several_map()
        bad["slices"][0]["cites"] = ["9-900"]
        self.assertIn("the brief has", self.map_refused(bad))
        bad = self.several_map()
        bad["slices"][1]["epic"] = "E1"
        bad["epics"] = bad["epics"][:1]
        self.assertIn("more than one epic", self.map_refused(bad))
        self.assertFalse(self.path("product/ideas/IDEA-001.map.json").exists())
        partial = self.several_map()
        partial["slices"] = partial["slices"][:1]
        partial["epics"] = partial["epics"][:1]
        partial["slices"].append({"key": "S2", "title": "Renew from the catalogue", "scope": "One loan, from the catalogue", "epic": "EPIC-001",
                                  "depends_on": ["S1"], "outcomes": ["O-1"], "cites": ["9"]})
        recorded = self.record_map(partial)
        self.assertEqual((recorded["not_covered"], recorded["can_apply"]), (["O-2"], False))
        self.assertEqual(self.ok(self.a, "status")["ideas"]["ideas"][0]["next"]["kind"], "settle")
        self.assertIn("Nothing was made", self.refused(self.a, "idea", "apply", "IDEA-001"))
        self.assertIn("already carried by S1", self.refused(self.a, "idea", "settle", "IDEA-001", "--outcome", "O-1", "--as", "later"))
        self.assertIn("has no slice S9", self.refused(self.a, "idea", "settle", "IDEA-001", "--outcome", "O-2", "--as", "slice:S9"))
        self.assertIn("not a way to settle", self.refused(self.a, "idea", "settle", "IDEA-001", "--outcome", "O-2", "--as", "never"))
        self.assertIn("not an outcome of", self.refused(self.a, "idea", "settle", "IDEA-001", "--outcome", "O-7", "--as", "later"))
        settled = self.ok(self.a, "idea", "settle", "IDEA-001", "--outcome", "O-2", "--as", "slice:S2", "--reason", "The catalogue says why.")
        self.assertEqual((settled["can_apply"], settled["settled"]["as"]), (True, "slice"))
        self.assertEqual(self.ok(self.a, "status")["ideas"]["ideas"][0]["next"]["kind"], "apply")
        self.assertEqual(self.ok(self.a, "idea", "map-status", "IDEA-001")["map"]["slices"][1]["outcomes"], ["O-1", "O-2"])
        applied = self.ok(self.a, "idea", "apply", "IDEA-001")
        self.assertEqual((applied["made"]["epics"], applied["made"]["slices"], applied["stage"]), (["EPIC-002"], ["SLICE-005", "SLICE-006"], "shaped"))
        epic = self.artifact(self.a, "product/epics/EPIC-002.json")
        self.assertEqual(epic["serves"], {"idea": "IDEA-001", "outcomes": ["O-1"]})
        self.assertNotIn("serves", self.artifact(self.a, "product/epics/EPIC-001.json"))  # an existing epic the map names is not changed
        second = self.artifact(self.a, "product/slices/SLICE-006.json")
        self.assertEqual((second["serves"], second["epic_id"], second["dependencies"], second["status"]),
                         ({"idea": "IDEA-001", "outcomes": ["O-1", "O-2"]}, "EPIC-001", ["SLICE-005"], "draft"))
        self.assertEqual(self.record()["made"], {"epics": ["EPIC-002"], "slices": ["SLICE-005", "SLICE-006"]})
        self.assertEqual(self.record()["stage"], "shaped")
        self.assertTrue(self.ok(self.a, "validate")["valid"])
        # Applying again makes nothing twice; nothing more can be mapped, settled or decided.
        again = self.ok(self.a, "idea", "apply", "IDEA-001")
        self.assertEqual((again["made"], again["kept"]["slices"]), ({"epics": [], "slices": []}, ["SLICE-005", "SLICE-006"]))
        self.assertEqual(sorted(p.name for p in self.path("product/slices").glob("*.json")), ["SLICE-005.json", "SLICE-006.json"])
        self.assertIn("already shaped", self.map_refused(self.several_map()))
        self.assertIn("already been applied", self.refused(self.a, "idea", "settle", "IDEA-001", "--outcome", "O-2", "--as", "later"))
        self.assertIn("already shaped", self.refused(self.a, "verdict", "record", "IDEA-001", "--decision", "no", "--reason", "No."))
        self.assertIn("already shaped", self.refused(self.a, "idea", "size", "IDEA-001"))
        self.assertEqual(self.gh()["calls"][-1] if self.gh()["calls"] else None, ["api", *collab.API_HEADERS, "user", "--jq", "{login}"])  # only the login was read

    def test_the_route_decides_the_shape_of_the_map(self):
        self.project_and_epic()
        self.sized(ONE)
        one = {"epics": [], "slices": [{"key": "S1", "title": "Renew a loan", "scope": "One loan", "epic": "EPIC-001", "depends_on": [],
                                        "outcomes": ["O-1"], "cites": ["9-10"]}]}
        two = json.loads(json.dumps(one))
        two["slices"].append({**one["slices"][0], "key": "S2", "title": "Renew another", "depends_on": ["S1"]})
        self.assertIn("exactly one slice", self.map_refused(two))
        self.assertTrue(self.record_map(one)["can_apply"])
        made = self.ok(self.a, "idea", "apply", "IDEA-001")["made"]
        self.assertEqual(made, {"epics": [], "slices": ["SLICE-005"]})
        self.assertEqual(self.record()["made"], {"epics": [], "slices": ["SLICE-005"]})

    def test_an_epic_route_keeps_every_slice_in_one_epic(self):
        self.project_and_epic()
        self.sized(EPIC)
        mapped = self.several_map()
        self.assertIn("every slice in the map is in one epic", self.map_refused(mapped))
        mapped["slices"][1]["epic"] = "E1"
        mapped["epics"] = mapped["epics"][:1]
        self.assertTrue(self.record_map(mapped)["can_apply"])

    def test_a_brief_changed_after_the_map_stops_apply(self):
        self.project_and_epic()
        self.sized(SEVERAL)
        self.record_map(self.several_map())
        self.write_brief("IDEA-001", SEVERAL.replace("call or come in", "phone or visit"))
        self.assertIn("no longer holds", self.refused(self.a, "idea", "apply", "IDEA-001"))
        self.assertFalse(self.path("product/slices").exists() and list(self.path("product/slices").glob("*.json")))

    def test_an_apply_cut_short_is_finished_by_the_next(self):
        self.project_and_epic()
        self.sized(SEVERAL)
        self.record_map(self.several_map())
        real = studio.start_slice
        calls = []

        def fail_second(*args, **kwargs):
            calls.append(1)
            if len(calls) == 2:
                raise studio.StudioError("the disk filled up")
            return real(*args, **kwargs)

        studio.start_slice = fail_second
        try:
            self.refused(self.a, "idea", "apply", "IDEA-001")
        finally:
            studio.start_slice = real
        self.assertEqual(self.record()["stage"], "decided")
        done = self.ok(self.a, "idea", "apply", "IDEA-001")
        self.assertEqual((done["made"]["slices"], done["kept"]["slices"]), (["SLICE-006"], ["SLICE-005"]))
        self.assertEqual(self.record()["made"], {"epics": ["EPIC-002", "EPIC-003"], "slices": ["SLICE-005", "SLICE-006"]})


class ServesTest(RouteBase):
    def test_a_slice_made_from_an_idea_names_it_in_its_why_and_resume_shows_the_brief_as_earlier_words(self):
        self.applied()
        self.write_slice(self.a, "SLICE-005")
        result = json.loads(self.run_studio(self.a, "slice", "check", "SLICE-005")[1])
        self.assertEqual(result["serves_problems"], ["the why must name the idea and outcomes this slice serves in its header, once, as "
                                                     "'- **Serves:** IDEA-001 O-1'"])
        self.assertFalse(result["ready"])
        self.assertIn("'- **Serves:** IDEA-001 O-1'", self.refused(self.a, "slice", "ready", "SLICE-005"))
        intent = self.path("product/intents/SLICE-005.md")
        intent.write_text(intent.read_text().replace("- **Status:**", "- **Serves:** IDEA-001 O-2\n- **Status:**", 1))
        self.assertIn("it says '- **Serves:** IDEA-001 O-2'", json.loads(self.run_studio(self.a, "slice", "check", "SLICE-005")[1])["serves_problems"][0])
        intent.write_text(intent.read_text().replace("IDEA-001 O-2", "IDEA-001 O-1"))
        result = json.loads(self.run_studio(self.a, "slice", "check", "SLICE-005")[1])
        self.assertEqual((result["serves_problems"], result["ready"]), ([], True))
        # A slice not made from an idea is checked exactly as before: no serves_problems at all.
        plain = self.ok(self.a, "slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")["slice"]["slice_id"]
        self.write_slice(self.a, plain)
        self.assertNotIn("serves_problems", json.loads(self.run_studio(self.a, "slice", "check", plain)[1]))
        self.assertNotIn("idea", self.ok(self.a, "slice", "resume", plain))
        resumed = self.ok(self.a, "slice", "resume", "SLICE-005")["idea"]
        self.assertEqual((resumed["idea_id"], resumed["outcomes"], resumed["why_line"], resumed["brief_matches_map"]),
                         ("IDEA-001", ["O-1"], "- **Serves:** IDEA-001 O-1", True))
        self.assertTrue(resumed["fenced"].startswith("<<<SHAPE-BRIEF-DATA idea=IDEA-001"))
        self.assertIn("Members renew without calling the library.", resumed["fenced"])
        self.assertIn("never a settled answer", resumed["note"])
        self.assertEqual(resumed["scope"], "One loan, from the loans page")
        # The brief changing later is said, and only the outcomes it serves are shown.
        self.write_brief("IDEA-001", SEVERAL.replace("call or come in", "phone or visit"))
        later = self.ok(self.a, "slice", "show", "SLICE-005")["idea"]
        self.assertFalse(later["brief_matches_map"])
        self.assertIn("changed after the map was made", later["brief_note"])

    def test_the_spec_header_carries_the_outcomes_and_comes_off_before_hashing(self):
        spec = spec_for("SLICE-004")
        why = intent_for("SLICE-004").replace("- **Status:**", "- **Serves:** IDEA-003 O-1, O-2\n- **Status:**", 1)
        serves = intake.serves_of(why)
        self.assertEqual(serves, ("IDEA-003", "O-1, O-2"))
        header = intake.spec_header({"epic_id": "EPIC-002", "issue": 41, "title": "Renewals"}, 57, serves)
        self.assertEqual(header, "> Epic: Renewals (EPIC-002, issue #41). Slice issue: #57. Serves: IDEA-003 O-1, O-2.")
        text = intake.with_header(spec, header)
        back, found = intake.without_header(text)
        self.assertEqual(intake.text_sha(back), intake.text_sha(spec))
        self.assertEqual((found.group(2), found.group(4), found.group(5), found.group(6)), ("EPIC-002", "57", "IDEA-003", "O-1, O-2"))
        self.assertIsNone(intake.serves_of(intent_for("SLICE-004")))
        self.assertIsNone(intake.serves_of(why.replace("- **Status:**", "- **Serves:** IDEA-004 O-1\n- **Status:**", 1)))  # twice: none
        self.assertIsNone(intake.serves_of(why.replace("IDEA-003 O-1, O-2", "IDEA-003 the renewals")))
        plain = intake.spec_header({"epic_id": "EPIC-002", "issue": 41, "title": "Renewals"}, 57)
        self.assertEqual(intake.without_header(intake.with_header(spec, plain))[0], spec)


class DispatchServesTest(IntakeBase):
    def test_the_factory_writes_the_outcomes_in_the_header_and_the_approved_spec_is_unchanged(self):
        epic = self.epic()
        state = self.gh()
        why = intent_for("SLICE-001").replace("- **Status:**", "- **Serves:** IDEA-003 O-1, O-2\n- **Status:**", 1)
        spec = spec_for("SLICE-001")
        issue = self.new_issue(state, "Invite a teammate", issue_rules.slice_issue_body("SLICE-001", 1, epic, [], why, spec), ["mach:slice"])
        self.label(state, issue, "mach:slice")
        state["issues"][str(epic)]["sub_issues"].append(issue["id"])
        at = self.tick(state)
        issue["comments"].append({"login": "ada-pm", "id": 3001, "created_at": at, "updated_at": at,
                                  "body": issue_rules.approval_comment("SLICE-001", 1, "ada-pm", issue_rules.text_sha256_of(spec), issue_rules.text_sha256_of(why))})
        self.label(state, issue, "mach:ready")
        self.write_state(state)
        self.product("intake")
        ticket = str(issue["number"])
        self.product("dispatch", ticket)
        committed = git(self.eng, "show", f"feature/{ticket}:specs/slices/SLICE-001-invite-a-teammate-by-email.md")
        self.assertIn(f"\n> Epic: Team membership (EPIC-001, issue #{epic}). Slice issue: #{issue['number']}. Serves: IDEA-003 O-1, O-2.\n", committed)
        self.assertEqual(intake.without_header(committed)[0], spec)
        self.assertEqual(self.cell(ticket)["stage"], "spec-ready")
        self.assertIn("- **Serves:** IDEA-003 O-1, O-2", (self.eng / ".factory/worktrees" / ticket / "intent.md").read_text())


class ChangeTest(RouteBase):
    def test_a_change_starts_from_a_rule_with_its_dependents_and_goes_the_same_way(self):
        self.ship_second_slice()
        self.assertIn("not in any shipped spec", self.refused(self.a, "idea", "change", "SLICE-009/FR-01"))
        self.assertIn("not a shipped rule's ID", self.refused(self.a, "idea", "change", "SLICE-001"))
        self.assertIn("SLICE-002/FR-09 took its place", self.refused(self.a, "idea", "change", "SLICE-001/FR-09"))
        made = self.ok(self.a, "idea", "change", "SLICE-001/INV-02")
        self.assertEqual((made["idea_id"], made["stage"]), ("IDEA-001", "exploring"))
        record = self.record()
        self.assertEqual((record["source"], record["title"]), ({"kind": "change", "rule": "SLICE-001/INV-02"}, "Change SLICE-001/INV-02"))
        lookups = json.loads(self.path("product/ideas/IDEA-001.lookups.json").read_text())
        rules = [item["rule"] for item in lookups["shipped_rules"]]
        self.assertEqual(rules[0], "SLICE-001/INV-02")
        self.assertIn("SLICE-002/FR-01", rules)  # SLICE-002 declared an effect on it
        self.assertTrue(all(rule.startswith("SLICE-002/") for rule in rules[1:]))
        self.assertIn("declared SLICE-001/INV-02 kept (AC-01)", lookups["shipped_rules"][1]["note"])
        starter = self.path("product/briefs/IDEA-001.md").read_text()
        self.assertIn("- Shipped rules: SLICE-001/INV-02", starter)
        checked = self.ok(self.a, "brief", "check", "IDEA-001")
        self.assertFalse(checked["passes"])  # the starter is the PM's to fill in
        self.assertIn("placeholder", " ".join(checked["errors"]))
        self.assertIn("needs a Go verdict", self.refused(self.a, "idea", "size", "IDEA-001"))  # no shortcut
        self.assertIn("Go needs a brief that passes", self.refused(self.a, "verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Yes."))
        replaced = self.ok(self.a, "idea", "change", "SLICE-002/FR-09", "--title", "Show seats differently")
        lookups = json.loads(self.path(f"product/ideas/{replaced['idea_id']}.lookups.json").read_text())
        self.assertEqual([(item["rule"], item["in_force"]) for item in lookups["shipped_rules"]], [("SLICE-002/FR-09", True), ("SLICE-001/FR-09", False)])
        self.assertEqual(self.ok(self.a, "idea", "show", "IDEA-001")["source"], {"kind": "change", "words": "A change to a rule that has shipped",
                                                                                 "rule": "SLICE-001/INV-02"})

    def test_a_filled_in_change_is_decided_and_sized_like_any_idea_and_published_with_its_rule(self):
        made = self.ok(self.a, "idea", "change", "SLICE-001/INV-02")
        self.write_brief(made["idea_id"], ONE.replace("- Shipped rules: SLICE-001/FR-01, SLICE-001/INV-02", "- Shipped rules: SLICE-001/INV-02"))
        self.ok(self.a, "verdict", "record", made["idea_id"], "--decision", "go", "--reason", "One address, one membership, stays; the message changes.")
        self.assertEqual(self.ok(self.a, "idea", "size", made["idea_id"])["route"], "small-change")  # M18: one outcome, one capability, one rule
        self.ok(self.a, "idea", "publish", made["idea_id"])
        body = self.idea_issues()[0]["body"]
        self.assertIn("from=rule:SLICE-001/INV-02", body.splitlines()[0])
        self.assertEqual(issue_rules.parse_shape_body(body)["source"], {"kind": "change", "rule": "SLICE-001/INV-02"})


class LookbackTest(RouteBase):
    def ship(self, slice_id):
        """What a refresh leaves when the slice's issue carries mach:shipped: the slice approved and saved, its issue seen shipped."""
        work = self.path(f"product/slices/{slice_id}.json")
        data = json.loads(work.read_text())
        data["status"] = "approved_for_engineering"
        work.write_text(json.dumps(data))
        ledger_path = self.a / ".factory/studio/issues.json"
        ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {"schema_version": 1, "slices": {}, "epics": {}}
        ledger.setdefault("slices", {})[slice_id] = {"saved": "github", "number": 50, "revision": 1, "base_revision": 1, "shipped": [], "run": None, "id": 9050}
        ledger.setdefault("seen", {})["slices"] = {slice_id: [{"issue": 50, "state_label": "mach:shipped", "revision": 1, "matches_approval": True}]}
        ledger["seen"]["refreshed_at"] = "2026-11-20T12:00:00Z"
        ledger_path.write_text(json.dumps(ledger))

    def test_look_back_waits_for_a_shipped_slice_then_is_recorded_and_posted_once(self):
        self.go(SEVERAL)
        self.assertIn("not shaped into work", self.refused(self.a, "lookback", "record", "IDEA-001", "--outcome", "O-1", "--result", "met", "--note", "Down to 11."))
        self.project_and_epic()
        self.ok(self.a, "idea", "size", "IDEA-001")
        self.record_map(self.several_map())
        self.ok(self.a, "idea", "apply", "IDEA-001")
        self.ok(self.a, "idea", "publish", "IDEA-001")
        number = self.idea_issues()[0]["number"]
        self.assertEqual(self.labels_of(number), ["mach:idea", "mach:idea-shaped"])
        self.assertEqual(self.ok(self.a, "status")["ideas"]["ideas"][0]["next"]["kind"], "none")
        self.assertIn("once a slice made from it has shipped", self.refused(self.a, "lookback", "record", "IDEA-001", "--outcome", "O-1",
                                                                            "--result", "met", "--note", "Down to 11."))
        self.ship("SLICE-005")
        self.assertEqual(self.ok(self.a, "status")["ideas"]["ideas"][0]["next"]["kind"], "look_back")
        self.assertIn("is looked back on as met, not-met or too-early", self.refused(self.a, "lookback", "record", "IDEA-001", "--outcome", "O-1",
                                                                                    "--result", "wrong", "--note", "x"))
        self.assertIn("not an outcome of", self.refused(self.a, "lookback", "record", "IDEA-001", "--outcome", "O-5", "--result", "met", "--note", "x"))
        self.not_a_choice("lookback", "record", "IDEA-001", "--outcome", "O-1", "--assumption", "A-1", "--result", "met", "--note", "x")
        done = self.ok(self.a, "lookback", "record", "IDEA-001", "--outcome", "O-1", "--result", "met", "--note", "Calls at Central were down to 11 a week.")
        self.assertEqual((done["comment"]["posted"], done["comment"]["issue"], done["shipped_slices"]), (True, number, ["SLICE-005"]))
        comments = [c["body"] for c in self.issue(number)["comments"]]
        found = issue_rules.shape_lookbacks(comments)
        self.assertEqual([(f["item"], f["result"], f["by"]) for f in found], [("O-1", "met", "ada-pm")])
        self.assertIn("In their words: Calls at Central were down to 11 a week.", comments[-1])
        again = self.ok(self.a, "lookback", "record", "IDEA-001", "--outcome", "O-1", "--result", "met", "--note", "Calls at Central were down to 11 a week.")
        self.assertEqual((again["comment"]["posted"], again["comment"]["why"]), (False, "already_there"))
        self.assertEqual(len(self.issue(number)["comments"]), len(comments))
        self.ok(self.a, "lookback", "record", "IDEA-001", "--assumption", "A-1", "--result", "unknown", "--note", "We did not count held items.")
        entry = self.record()["lookback"]
        self.assertEqual((entry["outcomes"]["O-1"]["result"], entry["outcomes"]["O-1"]["by"], entry["assumptions"]["A-1"]["result"]), ("met", "ada-pm", "unknown"))
        self.assertEqual(entry["outcomes"]["O-1"]["comment"], {"posted": False, "why": "already_there", "issue": number})
        self.assertEqual(self.ok(self.a, "status")["ideas"]["ideas"][0]["next"]["kind"], "look_back")  # O-2 and A-2 wait
        self.assertIn("secret", self.refused(self.a, "lookback", "record", "IDEA-001", "--outcome", "O-2", "--result", "met",
                                             "--note", "token ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"))
        self.assertIsNone(self.record()["lookback"]["outcomes"].get("O-2"))  # refused: nothing recorded

    def test_without_github_it_is_kept_here(self):
        self.applied(text=ONE, data={"epics": [], "slices": [{"key": "S1", "title": "Renew a loan", "scope": "One loan", "epic": "EPIC-001",
                                                              "depends_on": [], "outcomes": ["O-1"], "cites": ["9"]}]})
        self.ship("SLICE-005")
        done = self.ok(self.a, "lookback", "record", "IDEA-001", "--outcome", "O-1", "--result", "too-early", "--note", "One month of numbers only.")
        self.assertEqual(done["comment"], {"posted": False, "why": "not_on_github"})
        self.assertIn("kept here only", done["note"])
        self.assertEqual(self.writes(), [])

    def test_the_comment_template_and_its_parser(self):
        text = issue_rules.shape_lookback_comment("IDEA-001", "A-2", "wrong", "ada-pm", "@someone said #12 <!-- mach:x --> was fine")
        self.assertNotIn("@someone", text)  # mentions are broken, so nobody is notified
        self.assertEqual(text.count("<!--"), 1)  # no marker survives in their words
        self.assertEqual(issue_rules.shape_lookbacks([text])[0]["item"], "A-2")
        for bad in (("IDEA-1", "O-1", "met"), ("IDEA-001", "O-1", "wrong"), ("IDEA-001", "A-1", "met"), ("IDEA-001", "B-1", "met")):
            with self.assertRaises(ValueError):
                issue_rules.shape_lookback_comment(bad[0], bad[1], bad[2], "ada-pm", "x")


class ChainTest(RouteBase):
    def test_the_chain_reads_only_and_says_what_is_missing(self):
        self.applied()
        self.write_slice(self.a, "SLICE-005")
        before = sorted(str(p) for p in (self.a / ".factory").rglob("*") if p.is_file())
        chain = self.ok(self.a, "idea", "chain", "IDEA-001")
        after = sorted(str(p) for p in (self.a / ".factory").rglob("*") if p.is_file())
        self.assertEqual(before, after)
        rows = {row["outcome"]: row for row in chain["outcomes"]}
        self.assertEqual((rows["O-1"]["slices"], rows["O-2"]["slices"]), (["SLICE-005"], ["SLICE-006"]))
        self.assertIn("no look-back is recorded", rows["O-1"]["missing"])
        self.assertIsNone(rows["O-1"]["lookback"])
        slices = {row["slice_id"]: row for row in chain["slices"]}
        self.assertEqual(slices["SLICE-005"]["spec"]["functional_requirements"][:2], ["FR-01", "FR-02"])
        self.assertEqual(slices["SLICE-005"]["spec"]["scenarios"], ["AC-01", "AC-02", "AC-03"])
        self.assertIsNone(slices["SLICE-006"]["spec"])
        self.assertIn("no spec has been written yet", slices["SLICE-006"]["missing"])
        self.assertEqual(slices["SLICE-005"]["progress"], "draft")
        self.assertEqual([(e["epic_id"], e["acceptance"]) for e in chain["epics"]], [("EPIC-002", None), ("EPIC-003", None)])
        self.assertIn("keeps no copy", chain["epics"][0]["missing"])
        self.assertIs(chain["factory_authorized"], False)
        self.path("product/slices/SLICE-006.json").unlink()
        gone = {row["slice_id"]: row for row in self.ok(self.a, "idea", "chain", "IDEA-001")["slices"]}
        self.assertEqual(gone["SLICE-006"]["missing"], ["this slice is not in this workspace"])


class AppAndInstructionsTest(RouteBase):
    BANNED = re.compile(r"studio\.py|--[a-z]|\bbranch\b|\b(idea (size|map|settle|map-status|apply|change|chain)|lookback record)\b")

    def test_refusals_and_next_steps_for_the_app_name_no_command(self):
        self.project_and_epic()
        self.go(SEVERAL)
        for argv in (("idea", "map", "IDEA-001", "--from", self.map_file(self.several_map())), ("idea", "apply", "IDEA-001"),
                     ("idea", "change", "SLICE-009/FR-01"), ("lookback", "record", "IDEA-001", "--outcome", "O-1", "--result", "met", "--note", "x")):
            code, out, err = self.run_studio(self.a, "--app", *argv)
            self.assertEqual(code, 1, out)
            self.assertIsNone(self.BANNED.search(err), err)
        steps = []
        self.ok(self.a, "idea", "size", "IDEA-001")
        steps.append(self.ok(self.a, "--app", "status")["ideas"]["ideas"][0]["next"])
        partial = self.several_map()
        partial["slices"][1]["outcomes"] = ["O-1"]
        self.record_map(partial)
        steps.append(self.ok(self.a, "--app", "status")["ideas"]["ideas"][0]["next"])
        self.ok(self.a, "idea", "settle", "IDEA-001", "--outcome", "O-2", "--as", "later", "--reason", "After the summer.")
        steps.append(self.ok(self.a, "--app", "status")["ideas"]["ideas"][0]["next"])
        sized = self.ok(self.a, "--app", "idea", "size", "IDEA-001")
        self.assertEqual([step["kind"] for step in steps], ["map", "settle", "apply"])
        for text in [step["sentence"] for step in steps] + [sized["note"], sized["high_risk"]["basis"]]:
            self.assertIsNone(self.BANNED.search(text), text)

    def test_every_command_the_instructions_name_exists_in_the_engine(self):
        """references/shape.md names commands as `STUDIO <command> ...`; each, and each option it shows, is in studio.py's parser."""
        parser = studio.build_parser()

        def choices(action_parser):
            found = [a for a in action_parser._actions if isinstance(a, argparse._SubParsersAction)]
            return found[0].choices if found else None

        top = choices(parser)
        text = (ROOT / "skills" / "product-studio" / "references" / "shape.md").read_text()
        named = re.findall(r"`STUDIO ([^`]+)`", text)
        self.assertGreater(len(named), 20)
        for command in named:
            words = command.split()
            group = top.get(words[0])
            self.assertIsNotNone(group, command)
            target = group
            if choices(group) is not None:
                self.assertIn(words[1], choices(group), command)
                target = choices(group)[words[1]]
            options = {option for action in target._actions for option in action.option_strings}
            for flag in re.findall(r"(?<![\w-])(--[a-z][a-z-]*)", command):
                self.assertIn(flag, options, command)
        for needed in ("idea size", "idea map", "idea settle", "idea map-status", "idea apply", "idea change", "idea chain", "lookback record",
                       "idea renumber", "idea lookups", "brief check", "verdict record"):
            self.assertIn(f"`STUDIO {needed}", text, needed)


if __name__ == "__main__":
    unittest.main()
