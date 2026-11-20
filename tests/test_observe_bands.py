"""Tests for the control bands over the Factory's own measures (M15): observe.py bands, its tiers, dismissals,
and the observe pass it makes due through run.py status."""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "observe" / "scripts"))
import observe  # noqa: E402


def record(n, **changes):
    """One finished ticket: merged on the first round, closing one minute after the one before."""
    base = {"ticket_id": f"T-{n:03d}", "outcome": "merged", "rounds": 1, "first_pass": True, "escalated": False, "deviations": [],
            "tests_seen_failing_first": 4, "tests_passing_on_first_run": 0, "closed_at": f"2026-10-01T{n // 60:02d}:{n % 60:02d}:00+00:00"}
    base.update(changes)
    return base


def history(count, failing=(), escalated=(), deviations=None):
    """`count` tickets; the numbered ones in `failing` took a second round; `deviations` maps a number to how many."""
    out = []
    for n in range(1, count + 1):
        changes = {}
        if n in failing:
            changes.update(first_pass=False, rounds=2)
        if n in escalated:
            changes.update(escalated=True)
        if deviations and n in deviations:
            changes.update(deviations=[{"type": "scope", "detail": "x"}] * deviations[n])
        out.append(record(n, **changes))
    return out


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve() / "sample"
        (self.project / ".factory").mkdir(parents=True)
        patcher = mock.patch.dict(os.environ)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("MACH_EXECUTION_ID", None)

    def runs(self, records):
        path = self.project / observe.RUNS
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")

    def settings(self, bands):
        (self.project / ".factory/config.json").write_text(json.dumps({"observe": {"every": 5, "bands": bands}}))

    def call(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = observe.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def bands(self):
        code, out, err = self.call("bands")
        self.assertEqual(code, 0, err)
        return json.loads(out)


class RulesTest(unittest.TestCase):
    """The four Western Electric zone rules, each on its own, against a baseline of mean 0 and standard deviation 1."""

    def signals(self, values):
        return {(rule, side) for rule, side, _ in observe.rule_signals(values, len(values) - 1, 0.0, 1.0)}

    def test_rule_1_one_point_beyond_three_sigma(self):
        self.assertIn((1, 1), self.signals([0, 0, 3.1]))
        self.assertIn((1, -1), self.signals([0, 0, -3.1]))
        self.assertNotIn((1, 1), self.signals([0, 0, 3.0]))

    def test_rule_2_two_of_three_beyond_two_sigma_same_side(self):
        self.assertIn((2, 1), self.signals([2.5, 0, 2.1]))
        self.assertNotIn((2, 1), self.signals([2.5, 0, 0, 2.1]))
        self.assertNotIn((2, 1), self.signals([-2.5, 0, 2.1]))

    def test_rule_3_four_of_five_beyond_one_sigma_same_side(self):
        self.assertIn((3, -1), self.signals([-1.5, -1.2, 0, -1.1, -1.4]))
        self.assertNotIn((3, -1), self.signals([-1.5, 0, 0, -1.1, -1.4]))

    def test_rule_4_eight_in_a_row_one_side(self):
        self.assertIn((4, 1), self.signals([0.2] * 8))
        self.assertNotIn((4, 1), self.signals([0.2] * 7 + [0.0] + [0.2]))
        self.assertNotIn((4, 1), self.signals([0.2] * 7))

    def test_the_latest_ticket_must_be_part_of_the_pattern(self):
        self.assertEqual(self.signals([3.5, 0.0]), set())

    def test_no_spread_means_any_value_off_the_mean_is_beyond(self):
        found = {(rule, side) for rule, side, _ in observe.rule_signals([0, 0, 1], 2, 0.0, 0.0)}
        self.assertIn((1, 1), found)


class BandsTest(Base):
    def test_not_enough_tickets_is_never_a_band(self):
        self.runs(history(20))
        result = self.bands()
        for name, entry in result["measures"].items():
            self.assertEqual(entry["state"], observe.NOT_ENOUGH, name)
            self.assertNotIn("band", entry)
        self.assertEqual((result["say"], result["observe_pass_due"], result["tier"]), (None, [], 0))

    def test_a_steady_factory_is_inside_every_band(self):
        self.runs(history(40, failing=(5, 14, 23, 32)))
        result = self.bands()
        fp = result["measures"]["first_pass_rate"]
        self.assertEqual(fp["state"], "inside")
        self.assertEqual(fp["sample"]["baseline"], 30)
        self.assertEqual(fp["sample"]["recent"], 8)
        self.assertEqual(fp["sample"]["recent_tickets"], [f"T-{n:03d}" for n in range(33, 41)])
        self.assertEqual(fp["sample"]["baseline_tickets"][0], "T-003")
        self.assertIsNone(result["say"])

    def test_slow_drift_is_caught_and_makes_a_pass_due(self):
        # 32 tickets with three failures, then the last 8 all fail their first round: rule 4 (8 in a row below) and rule 3.
        self.runs(history(40, failing=(5, 14, 23, *range(33, 41))))
        result = self.bands()
        fp = result["measures"]["first_pass_rate"]
        self.assertEqual(fp["state"], "outside")
        rules = {s["rule"] for s in fp["signals"] if s["direction"] == "worse"}
        self.assertIn(4, rules)
        self.assertEqual(fp["breach"]["tier"], 3)
        self.assertIn("first_pass_rate", result["say"])
        self.assertTrue(result["say"].startswith("A Factory measure is outside its control band: "))
        due = {d["measure"]: d for d in result["observe_pass_due"]}
        self.assertIn("first_pass_rate", due)
        signal = next(s for s in fp["signals"] if s["rule"] == 4)
        self.assertEqual(signal["tickets"], [f"T-{n:03d}" for n in range(33, 41)])

    def test_a_single_spike_is_tier_two_said_but_no_pass(self):
        self.runs(history(40, deviations={38: 9}))
        result = self.bands()
        dev = result["measures"]["deviations_per_ticket"]
        self.assertEqual(dev["state"], "outside")
        self.assertEqual(dev["breach"]["tier"], 2)
        self.assertEqual(dev["breach"]["since"], "T-038")
        self.assertIn("deviations_per_ticket", result["say"])
        self.assertEqual(result["observe_pass_due"], [])

    def test_an_improvement_is_only_recorded(self):
        self.runs(history(40, failing=tuple(range(1, 33, 2))))
        result = self.bands()
        fp = result["measures"]["first_pass_rate"]
        self.assertTrue(any(s["direction"] == "better" and s["tier"] == 1 for s in fp["signals"]))
        self.assertNotIn("breach", fp)
        self.assertIsNone(result["say"])

    def test_the_same_record_gives_the_same_answer(self):
        self.runs(history(40, failing=(5, 14, 23, *range(33, 41))))
        first, second = self.bands(), self.bands()
        first.pop("recorded"), second.pop("recorded")
        self.assertEqual(first, second)
        self.assertEqual(observe.bands_summary(self.project), observe.bands_summary(self.project))

    def test_signals_are_recorded_once(self):
        self.runs(history(40, failing=(5, 14, 23, *range(33, 41))))
        self.assertGreater(self.bands()["recorded"], 0)
        self.assertEqual(self.bands()["recorded"], 0)
        lines = (self.project / observe.BANDS_LOG).read_text().splitlines()
        self.assertTrue(all(json.loads(line)["key"] for line in lines))

    def test_a_pass_after_the_breach_is_no_longer_due(self):
        self.runs(history(40, failing=(5, 14, 23, *range(33, 41))))
        last = self.project / observe.LAST_PASS
        last.parent.mkdir(parents=True, exist_ok=True)
        last.write_text(json.dumps({"runs_total": 40}))
        result = self.bands()
        self.assertEqual(result["observe_pass_due"], [])
        self.assertIn("first_pass_rate", result["say"], "a breach is still said after a pass; only the pass is no longer due")

    def test_collect_names_the_breach_for_the_report(self):
        self.runs(history(40, failing=(5, 14, 23, *range(33, 41))))
        code, out, err = self.call("collect")
        self.assertEqual(code, 0, err)
        metrics = json.loads(out)
        self.assertEqual(metrics["bands"]["measures"]["first_pass_rate"]["state"], "outside")
        self.assertIn("scorecard", metrics)


class SettingsTest(Base):
    def test_the_template_carries_the_defaults(self):
        template = json.loads((ROOT / "templates" / "config.json").read_text())
        self.assertEqual(template["observe"]["bands"], observe.BAND_DEFAULTS)

    def test_window_and_minimum_come_from_the_settings(self):
        self.settings({"window": 10, "min_sample": 10, "recent": 4})
        self.runs(history(12))
        fp = self.bands()["measures"]["first_pass_rate"]
        self.assertEqual((fp["sample"]["baseline"], fp["sample"]["recent"]), (10, 2))

    def test_only_watched_measures_are_reported(self):
        self.settings({"measures": ["escalation_rate"]})
        self.runs(history(40))
        self.assertEqual(list(self.bands()["measures"]), ["escalation_rate"])

    def test_a_tier_without_observe_pass_makes_none_due(self):
        self.settings({"tiers": {"1": ["record"], "2": ["record", "say"], "3": ["record", "say"]}})
        self.runs(history(40, failing=(5, 14, 23, *range(33, 41))))
        self.assertEqual(self.bands()["observe_pass_due"], [])

    def test_bad_settings_compute_no_band_and_say_why(self):
        for bad in ({"window": 2}, {"min_sample": 40, "window": 30}, {"measures": ["speed"]}, {"rules": {"5": 2}},
                    {"tiers": {"1": ["start-agent"], "2": [], "3": []}}, {"surprise": 1}):
            self.settings(bad)
            self.runs(history(40, failing=range(33, 41)))
            result = self.bands()
            self.assertTrue(result["problems"], bad)
            self.assertEqual((result["measures"], result["observe_pass_due"]), ({}, []))

    def test_switched_off(self):
        self.settings({"enabled": False})
        self.runs(history(40, failing=range(33, 41)))
        self.assertEqual(self.bands()["enabled"], False)


class DismissTest(Base):
    def drift(self, upto=40):
        self.runs(history(upto, failing=(5, 14, 23, *range(33, min(upto, 40) + 1)), escalated=()))

    def test_dismissal_is_recorded_and_shown_and_stops_the_pass(self):
        self.drift()
        code, out, err = self.call("bands", "dismiss", "first_pass_rate", "--reason", "Two new engineers joined this sprint.", "--by", "engineering-lead")
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["since"], self.bands()["measures"]["first_pass_rate"]["breach"]["since"])
        result = self.bands()
        fp = result["measures"]["first_pass_rate"]
        self.assertEqual(fp["state"], "outside, dismissed")
        self.assertEqual(fp["breach"]["dismissed"]["by"], "engineering-lead")
        self.assertNotIn("first_pass_rate", [d["measure"] for d in result["observe_pass_due"]])
        self.assertNotIn("first_pass_rate", result["say"] or "")

    def test_raised_again_only_after_it_returns_inside_and_leaves_again(self):
        self.drift()
        self.call("bands", "dismiss", "first_pass_rate", "--reason", "Two new engineers joined this sprint.")
        # Back inside: forty more steady tickets.
        records = history(40, failing=(5, 14, 23, *range(33, 41)))
        records += [record(n) for n in range(41, 81)]
        self.runs(records)
        self.assertEqual(self.bands()["measures"]["first_pass_rate"]["state"], "inside")
        # And out again: a new breach, not dismissed.
        records += [record(n, first_pass=False, rounds=2) for n in range(81, 89)]
        self.runs(records)
        fp = self.bands()["measures"]["first_pass_rate"]
        self.assertEqual(fp["state"], "outside")
        self.assertIsNone(fp["breach"]["dismissed"])

    def test_refusals(self):
        self.drift()
        self.assertEqual(self.call("bands", "dismiss", "first_pass_rate", "--reason", "short")[0], 2)
        code, _, err = self.call("bands", "dismiss", "escalation_rate", "--reason", "Nothing is wrong here at all.")
        self.assertEqual(code, 1)
        self.assertIn("no breach", err)
        with mock.patch.dict(os.environ, {"MACH_EXECUTION_ID": "x"}):
            code, _, err = self.call("bands", "dismiss", "first_pass_rate", "--reason", "Two new engineers joined this sprint.")
        self.assertEqual(code, 1)
        self.assertIn("person", err)
        self.assertFalse((self.project / observe.BANDS_DISMISSED).exists())


class RunWiringTest(Base):
    """run.py status: the fixed line, and an observe pass due from a tier-3 breach."""

    def status(self):
        sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
        import run as run_module  # noqa: E402
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run_module.main(["--project", str(self.project), "status"])
        self.assertEqual(code, 0, err.getvalue())
        return json.loads(out.getvalue())

    def test_status_says_the_line_and_makes_the_pass_due(self):
        (self.project / ".factory/config.json").write_text(json.dumps({"observe": {"every": 50}}))  # the count rule alone: 40 of 50, not due
        self.runs(history(40, failing=(5, 14, 23, *range(33, 41))))
        board = self.status()
        self.assertTrue(board["observe_due"])
        self.assertTrue(board["control_bands"].startswith("A Factory measure is outside its control band: "))

    def test_steady_status_is_unchanged(self):
        self.runs(history(40))
        last = self.project / observe.LAST_PASS
        last.parent.mkdir(parents=True, exist_ok=True)
        last.write_text(json.dumps({"runs_total": 40}))
        board = self.status()
        self.assertFalse(board["observe_due"])
        self.assertIsNone(board["control_bands"])

    def test_bands_command_is_routed(self):
        self.runs(history(40))
        sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
        import run as run_module  # noqa: E402
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = run_module.main(["--project", str(self.project), "bands"])
        self.assertEqual(code, 0)
        self.assertIn("first_pass_rate", json.loads(out.getvalue())["measures"])


class NeverActsTest(unittest.TestCase):
    def test_bands_start_nothing_and_file_nothing(self):
        source = (ROOT / "skills" / "observe" / "scripts" / "observe.py").read_text()
        start = source.index("# ---------------------------------------------------------------- control bands (M15)")
        block = source[start:source.index("def build_parser")]
        for forbidden in ("subprocess", "ticket.py", "claude", "file-ticket", "sibling("):
            self.assertNotIn(forbidden, block, forbidden)


if __name__ == "__main__":
    unittest.main()
