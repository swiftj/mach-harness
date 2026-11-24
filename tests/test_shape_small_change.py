"""M18 part C (Shape): the fourth route, small-change.

The route is decided by the same fixed counts as the other three: one outcome, one capability, at most
intent.small_change.changed_shipped_rules shipped rules, and nothing in a high-risk area (a count that could not be
determined is never read as none). Applying it makes one draft slice of kind small through the code `slice new --small`
uses, on the product manager's word, which also says whether it is a fix or an adjustment.

These tests restore unittest's own `fail` for their class: the shared IssuesBase replaces it with a helper that sets up
a stand-in GitHub failure, which would otherwise let a failed assertIn or a failed comparison of strings pass.
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
for folder in ("ticket", "intent", "studio"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import shape  # noqa: E402
import shape_route  # noqa: E402
import studio  # noqa: E402
from test_mach_shape_route import EPIC, ONE, SEVERAL, RouteBase, brief_with  # noqa: E402

SMALL = brief_with(outcomes=1, capabilities="Lending (EPIC-001)", rules="SLICE-001/INV-02")
SMALL_NO_RULE = brief_with(outcomes=1, capabilities="Lending (EPIC-001)", rules="None.")
ONE_MAP = {"epics": [], "slices": [{"key": "S1", "title": "Renew a loan from my loans", "scope": "One loan, from the loans page",
                                    "epic": "EPIC-001", "depends_on": [], "outcomes": ["O-1"], "cites": ["9-10"]}]}


class SmallRouteRuleTest(unittest.TestCase):
    def test_each_count_on_each_side(self):
        route = shape_route.route_for
        self.assertEqual(route(1, 1, 1, 0), ("small-change", "The brief has one outcome in one capability, 1 shipped rule, at most 1, and "
                                                             "nothing in a high-risk area, so the route is a small change."))
        self.assertEqual(route(1, 0, 1, 0), ("small-change", "The brief has one outcome in one capability, 0 shipped rules, at most 1, and "
                                                             "nothing in a high-risk area, so the route is a small change."))
        self.assertEqual(route(2, 1, 1, 0)[0], "epic")  # a second outcome
        self.assertEqual(route(1, 1, 2, 0)[0], "one-slice")  # a second capability
        self.assertEqual(route(1, 1, 0, 0)[0], "one-slice")  # no capability is not one capability
        self.assertEqual(route(1, 2, 1, 0)[0], "one-slice")  # a second shipped rule
        self.assertEqual(route(1, 1, 1, 1)[0], "one-slice")  # a high-risk area
        self.assertEqual(route(1, 0, 1, None)[0], "one-slice")  # high risk not determined is never none

    def test_the_limit_setting(self):
        route = shape_route.route_for
        self.assertEqual(route(1, 0, 1, 0, 0), ("small-change", "The brief has one outcome in one capability, no shipped rule, and nothing "
                                                                "in a high-risk area, so the route is a small change."))
        self.assertEqual(route(1, 1, 1, 0, 0), ("one-slice", "The brief has one outcome and 1 shipped rule, at most three, so the route is one slice."))
        self.assertIn("no shipped rule", shape_route.route_rule(0))
        self.assertIn("at most 1 shipped rule and", shape_route.route_rule(1))

    def test_the_other_three_routes_keep_their_sentences(self):
        route = shape_route.route_for
        for counts, expected in (((1, 3, 1, 0), ("one-slice", "The brief has one outcome and 3 shipped rules, at most three, so the route is one slice.")),
                                 ((1, 4, 1, 0), ("epic", "The brief has one outcome but 4 shipped rules, more than three, inside one capability, so the route is an epic.")),
                                 ((2, 0, 1, 0), ("epic", "The brief has 2 outcomes inside one capability, so the route is an epic.")),
                                 ((3, 1, 2, 0), ("several-epics", "The brief's outcomes are in 2 different capabilities, so the route is several epics."))):
            self.assertEqual(route(*counts), expected)
            self.assertEqual(route(*counts[:3]), expected)  # the counts alone, as before M18


class SmallRouteTest(RouteBase):

    def settings(self, **values):
        config = self.a / ".factory" / "config.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(json.dumps({"intent": {"small_change": values}}))

    def test_a_brief_with_one_outcome_capability_and_rule_is_sized_a_small_change(self):
        sized = self.sized(SMALL)
        self.assertEqual((sized["route"], sized["route_words"]), ("small-change", "a small change"))
        self.assertEqual(sized["why"], "The brief has one outcome in one capability, 1 shipped rule, at most 1, and nothing in a high-risk area, "
                                       "so the route is a small change.")
        self.assertEqual(self.record()["route"]["route"], "small-change")
        self.assertIn("is a small change", sized["rule"])
        self.assertNotIn("settings_notes", sized)
        self.assertEqual(self.ok(self.a, "idea", "show", "IDEA-001")["route"]["route"], "small-change")  # the record passes its own check

    def test_the_briefs_of_the_other_routes_route_as_before(self):
        for text, route, why in ((ONE, "one-slice", "The brief has one outcome and 2 shipped rules, at most three, so the route is one slice."),
                                 (EPIC, "epic", "The brief has 2 outcomes inside one capability, so the route is an epic."),
                                 (SEVERAL, "several-epics", "The brief's outcomes are in 2 different capabilities, so the route is several epics.")):
            with self.subTest(route=route):
                sized = self.sized(text)
                self.assertEqual((sized["route"], sized["why"]), (route, why))

    def test_the_limit_comes_from_the_settings(self):
        self.settings(changed_shipped_rules=0)
        self.assertEqual(self.sized(SMALL)["route"], "one-slice")
        sized = self.sized(SMALL_NO_RULE)
        self.assertEqual(sized["why"], "The brief has one outcome in one capability, no shipped rule, and nothing in a high-risk area, "
                                       "so the route is a small change.")
        self.settings(changed_shipped_rules=2)  # out of range: read as the default, with a note
        sized = self.sized(SMALL)
        self.assertEqual(sized["route"], "small-change")
        self.assertIn("changed_shipped_rules", " ".join(sized["settings_notes"]))

    def test_a_rule_whose_slice_changed_a_high_risk_file_is_not_a_small_change(self):
        self.ship_second_slice(files=("src/auth/login.py",))
        sized = self.sized(brief_with(outcomes=1, capabilities="Lending (EPIC-001)", rules="SLICE-002/FR-01"))
        self.assertEqual((sized["route"], sized["counted"]["high_risk_areas"]), ("one-slice", 1))
        self.assertEqual(self.sized(brief_with(outcomes=1, capabilities="Lending (EPIC-001)", rules="SLICE-001/FR-01"))["route"], "small-change")

    def small_mapped(self, text=SMALL):
        self.project_and_epic()
        self.sized(text)
        self.record_map(ONE_MAP)

    def test_the_map_of_a_small_change_holds_one_slice(self):
        self.project_and_epic()
        self.sized(SMALL)
        two = {"epics": [], "slices": [ONE_MAP["slices"][0], {**ONE_MAP["slices"][0], "key": "S2", "title": "Say why it is refused"}]}
        self.assertIn("The route is a small change, so the map holds exactly one slice", self.map_refused(two))

    def test_applying_needs_the_kind_and_makes_a_draft_small_adjustment(self):
        self.small_mapped()
        step = shape_route.later_step(shape.Ideas(studio, studio.Studio(self.a)), self.record(), None)
        self.assertEqual(step["kind"], "apply")
        self.assertIn("--change fix|adjustment", step["sentence"])
        refused = self.refused(self.a, "idea", "apply", "IDEA-001")
        self.assertIn("which kind it is", refused)
        self.assertIn("Nothing was made", refused)
        self.assertEqual(self.record()["stage"], "decided")
        self.assertFalse(self.path("product/slices").is_dir() and any(self.path("product/slices").iterdir()))
        applied = self.ok(self.a, "idea", "apply", "IDEA-001", "--change", "adjustment")
        self.assertEqual((applied["stage"], applied["small_change"]), ("shaped", {"change": "adjustment", "shipped_rule": None}))
        slice_id = applied["made"]["slices"][0]
        work = json.loads(self.path(f"product/slices/{slice_id}.json").read_text())
        self.assertEqual((work["kind"], work["small"], work.get("widened")), ("small", {"change": "adjustment", "shipped_rule": None}, None))
        self.assertEqual(work["serves"], {"idea": "IDEA-001", "outcomes": ["O-1"]})
        self.assertEqual(work["status"], "draft")
        again = self.ok(self.a, "idea", "apply", "IDEA-001")  # nothing new is made, so no kind is asked for
        self.assertEqual(again["made"], {"epics": [], "slices": []})
        self.assertNotIn("small_change", again)

    def test_a_fix_is_of_the_one_rule_the_brief_touches(self):
        self.small_mapped()
        applied = self.ok(self.a, "idea", "apply", "IDEA-001", "--change", "fix")
        work = json.loads(self.path(f"product/slices/{applied['made']['slices'][0]}.json").read_text())
        self.assertEqual((work["kind"], work["small"]), ("small", {"change": "fix", "shipped_rule": "SLICE-001/INV-02"}))
        status = next(row for row in self.ok(self.a, "status")["slices"] if row["slice_id"] == work["slice_id"])
        self.assertEqual(status["kind"], "small")

    def test_a_fix_needs_a_rule_and_a_rule_in_force(self):
        self.small_mapped(SMALL_NO_RULE)
        refused = self.refused(self.a, "idea", "apply", "IDEA-001", "--change", "fix")
        self.assertIn("touches none", refused)
        self.assertEqual(self.record()["stage"], "decided")
        self.assertEqual(self.ok(self.a, "idea", "apply", "IDEA-001", "--change", "adjustment")["small_change"]["change"], "adjustment")

    def test_the_kind_is_only_for_a_small_change(self):
        self.project_and_epic()
        self.sized(ONE)
        self.record_map(ONE_MAP)
        self.assertIn("is for an idea whose route is a small change", self.refused(self.a, "idea", "apply", "IDEA-001", "--change", "fix"))
        applied = self.ok(self.a, "idea", "apply", "IDEA-001")
        work = json.loads(self.path(f"product/slices/{applied['made']['slices'][0]}.json").read_text())
        self.assertNotIn("kind", work)  # a one-slice route makes a full slice, as before
        self.assertNotIn("small_change", applied)


if __name__ == "__main__":
    unittest.main()
