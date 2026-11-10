"""Tests for observe.py: the scorecard, recurring patterns, and the checks a report must pass to be filed."""

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "observe" / "scripts"))
import observe  # noqa: E402


def run(ticket, day=1, **changes):
    """One line of runs.jsonl: a Medium web ticket merged on the first round, unless changed."""
    record = {
        "ticket_id": ticket, "slice_id": None, "title": f"Ticket {ticket}", "risk": "Medium", "app_type": "web", "mode": "headless",
        "outcome": "merged", "abandon_reason": None,
        "rounds": 1, "first_pass": True, "verify_failures": 0, "review_rejections": 0, "escalated": False, "human_approval": False,
        "deviations": [], "blockers": [], "verify_findings": [],
        "tests_seen_failing_first": 0, "tests_passing_on_first_run": 0,
        "created_at": None, "closed_at": f"2026-10-{day:02d}T12:00:00+00:00", "archive": f".factory/archive/{ticket}.tar.gz",
    }
    record.update(changes)
    return record


def blocker(rule, reviewer="architecture", title="Handler has no deadline", round_=1):
    return {"round": round_, "reviewer": reviewer, "rule": rule, "title": title, "file": "app/handler.py"}


def proposal(name="Deadline on every handler", target="`REVIEW.md`", evidence="T-1 and T-2 were both blocked for it.", change="Add under Blockers:\n  ```\n  ## Deadlines\n  ### Every handler sets a deadline.\n  ```"):
    lines = [f"### {name}"]
    if target is not None:
        lines.append(f"- **Target:** {target}")
    if evidence is not None:
        lines.append(f"- **Evidence:** {evidence}")
    if change is not None:
        lines.append(f"- **Change:** {change}")
    lines.append("- **Expected effect:** first_pass_rate should rise.")
    return "\n".join(lines)


def report(*proposals, drop=None):
    parts = {
        "Analyzed data": "6 tickets, T-1 to T-6.",
        "Patterns": "### review-blocker: fr-04\nRecurs in T-1 and T-2.",
        "Proposed changes": "\n\n".join(proposals) if proposals else "- None.",
        "Not proposed": "- Raising the three-round limit: a person's decision.",
    }
    return "# MACH observation report\n\n" + "\n\n".join(f"## {name}\n{body}" for name, body in parts.items() if name != drop) + "\n"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name).resolve() / "sample"
        (self.project / ".factory").mkdir(parents=True)

    def write(self, name, text):
        path = self.project / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def runs(self, *records, extra_lines=()):
        lines = [json.dumps(record) for record in records] + list(extra_lines)
        self.write(observe.RUNS, "\n".join(lines) + "\n")

    def call(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = observe.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def collect(self, *argv):
        code, out, err = self.call("collect", *argv)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def six(self):
        """Six tickets, T-1 to T-6, closed on consecutive days."""
        self.runs(*[run(f"T-{n}", day=n) for n in range(1, 7)])

    def file_report(self, text, name="draft.md"):
        path = self.write(f"{observe.OBSERVATIONS}/{name}", text)
        return self.call("report", "--file", str(path))

    def refused(self, text, reason):
        code, out, err = self.file_report(text)
        self.assertEqual((code, out), (1, ""), err)
        self.assertIn(reason, err)
        self.assertEqual(list((self.project / observe.OBSERVATIONS).glob("observation-*.md")), [])
        return err


class CollectTest(Base):
    def test_missing_archive_is_not_enough_data(self):
        metrics = self.collect()
        self.assertEqual((metrics["sample"]["tickets_analyzed"], metrics["sample"]["enough_data"], metrics["sample"]["id_range"]), (0, False, None))
        self.assertEqual(metrics["patterns"], [])
        self.assertEqual({entry["value"] for entry in metrics["scorecard"].values()}, {None})
        self.assertEqual({entry["met"] for entry in metrics["scorecard"].values()}, {None})
        self.assertEqual(metrics["open_cells"], {"total": 0, "by_stage": {}, "blocked": []})
        self.assertIsNone(metrics["audit"])

    def test_empty_archive_file(self):
        self.write(observe.RUNS, "\n\n")
        self.assertEqual(self.collect()["sample"]["tickets_analyzed"], 0)

    def test_metrics_file_matches_what_is_printed(self):
        self.six()
        metrics = self.collect()
        self.assertEqual(json.loads((self.project / observe.METRICS).read_text()), metrics)
        self.assertTrue(metrics["sample"]["enough_data"])
        self.assertEqual(len(metrics["sample"]["runs_sha256"]), 64)

    def test_scorecard_arithmetic(self):
        self.runs(
            run("T-1", 1, tests_seen_failing_first=9, tests_passing_on_first_run=1),
            run("T-2", 2, tests_seen_failing_first=5),
            run("T-3", 3, rounds=2, first_pass=False, tests_seen_failing_first=3, tests_passing_on_first_run=1,
                deviations=[{"type": "test-amended", "task": "T3", "detail": "x"}, {"type": "no-baseline", "task": None, "detail": "y"}]),
            run("T-4", 4, rounds=3, first_pass=False, escalated=True, tests_seen_failing_first=2, deviations=[{"type": "test-amended", "task": "T1", "detail": "z"}]),
            run("T-5", 5, outcome="abandoned", abandon_reason="superseded", rounds=3, first_pass=False, escalated=True),
        )
        card = self.collect()["scorecard"]
        # merged: T-1..T-4, rounds 1+1+2+3 = 7 over 4
        self.assertEqual((card["average_rounds"]["value"], card["average_rounds"]["target"], card["average_rounds"]["met"]), (1.75, "< 1.3", False))
        self.assertEqual((card["first_pass_rate"]["value"], card["first_pass_rate"]["target"], card["first_pass_rate"]["met"]), (0.5, "> 0.85", False))
        self.assertEqual((card["escalation_rate"]["value"], card["escalation_rate"]["met"]), (0.4, False))
        self.assertEqual((card["abandonment_rate"]["value"], card["abandonment_rate"]["target"], card["abandonment_rate"]["met"]), (0.2, None, None))
        # 19 seen failing of 21 recorded test tasks
        self.assertEqual((card["tests_failing_first_share"]["value"], card["tests_failing_first_share"]["met"]), (0.905, True))
        self.assertEqual((card["deviations_per_ticket"]["value"], card["deviations_per_ticket"]["target"]), (0.6, None))
        self.assertIn("7 judging rounds over 4 merged tickets", card["average_rounds"]["basis"])

    def test_targets_met_on_a_clean_sample(self):
        self.runs(*[run(f"T-{n}", n, tests_seen_failing_first=4) for n in range(1, 6)])
        card = self.collect()["scorecard"]
        self.assertEqual([card[name]["met"] for name in ("average_rounds", "first_pass_rate", "escalation_rate", "tests_failing_first_share")], [True] * 4)
        self.assertEqual((card["average_rounds"]["value"], card["first_pass_rate"]["value"], card["escalation_rate"]["value"]), (1.0, 1.0, 0.0))

    def test_history_depth_takes_the_most_recent_by_closed_at(self):
        self.runs(run("NEW-2", 20), run("OLD-1", 1), run("NEW-1", 19), run("OLD-2", 2), run("NEW-3", 21, closed_at="2026-10-21T12:00:00Z"), run("NODATE", closed_at=None))
        sample = self.collect("--history-depth", "3")["sample"]
        self.assertEqual(sample["ticket_ids"], ["NEW-1", "NEW-2", "NEW-3"])
        self.assertEqual(sample["id_range"], {"first": "NEW-1", "last": "NEW-3"})
        self.assertEqual(sample["date_range"], {"from": "2026-10-19T12:00:00+00:00", "to": "2026-10-21T12:00:00Z"})
        self.assertEqual((sample["tickets_analyzed"], sample["tickets_on_record"], sample["enough_data"]), (3, 6, False))
        self.assertTrue(self.collect("--history-depth", "3", "--min-tickets", "3")["sample"]["enough_data"])

    def test_malformed_lines_are_skipped_and_counted(self):
        self.runs(run("T-1"), run("T-2", 2), extra_lines=["{not json", "[1, 2]", '"text"', '{"title": "no ticket id"}', ""])
        sample = self.collect()["sample"]
        self.assertEqual((sample["tickets_analyzed"], sample["skipped_malformed_lines"]), (2, 4))

    def test_records_with_missing_or_odd_fields_do_not_crash(self):
        self.runs({"ticket_id": "T-1"}, {"ticket_id": "T-2", "outcome": "merged", "rounds": "two", "blockers": "none", "deviations": [3], "verify_findings": [None, 7]})
        metrics = self.collect()
        self.assertEqual(metrics["sample"]["tickets_analyzed"], 2)
        self.assertIsNone(metrics["scorecard"]["average_rounds"]["value"])
        self.assertEqual(metrics["by_risk"], {"unknown": {"tickets": 2, "merged": 1, "first_pass": 0, "first_pass_rate": 0.0}})

    def test_bad_flags_are_an_error(self):
        code, _, err = self.call("collect", "--history-depth", "0")
        self.assertEqual(code, 2)
        self.assertIn("error:", err)


class PatternTest(Base):
    def patterns(self, *records, argv=()):
        self.runs(*records)
        # These tests are about grouping and thresholds, so the sample-size floor is lowered.
        return self.collect("--min-tickets", "1", *argv)["patterns"]

    def test_no_patterns_are_reported_on_too_small_a_sample(self):
        records = [run(f"T-{n}", n, blockers=[blocker("FR-04")]) for n in range(1, 4)]
        self.runs(*records)
        metrics = self.collect()
        self.assertEqual((metrics["sample"]["enough_data"], metrics["patterns"]), (False, []))

    def test_rule_broken_in_one_ticket_is_not_a_pattern(self):
        records = [run("T-1", 1, blockers=[blocker("FR-04"), blocker("FR-04", round_=2)])] + [run(f"T-{n}", n) for n in range(2, 7)]
        self.assertEqual(self.patterns(*records), [])

    def test_rule_broken_in_two_of_six_is_a_pattern_and_spellings_merge(self):
        records = [
            run("T-1", 1, blockers=[blocker("FR-04 ", title="No deadline on create"), blocker("fr-04", round_=2, title="Still no deadline")]),
            run("T-2", 2, blockers=[blocker("fr-04", reviewer="security", title="No deadline on delete")]),
        ] + [run(f"T-{n}", n) for n in range(3, 7)]
        found = self.patterns(*records)
        self.assertEqual(len(found), 1)
        self.assertEqual({k: found[0][k] for k in ("kind", "key", "tickets", "count", "share")},
                         {"kind": "review-blocker", "key": "fr-04", "tickets": ["T-1", "T-2"], "count": 3, "share": 0.333})
        self.assertEqual(found[0]["examples"], ["T-1: No deadline on create", "T-1: Still no deadline", "T-2: No deadline on delete"])

    def test_whitespace_inside_a_rule_is_collapsed(self):
        records = [run("T-1", 1, blockers=[blocker("No  Inline\tStyles")]), run("T-2", 2, blockers=[blocker("no inline styles")])]
        self.assertEqual([p["key"] for p in self.patterns(*records)], ["no inline styles"])

    def test_two_tickets_below_the_share_threshold_is_not_a_pattern(self):
        records = [run("T-1", 1, blockers=[blocker("fr-04")]), run("T-2", 2, blockers=[blocker("fr-04")])] + [run(f"T-{n}", n) for n in range(3, 15)]
        self.assertEqual(self.patterns(*records), [])  # 2 of 14 is 14%
        self.assertEqual(len(self.collect("--min-share", "0.1")["patterns"]), 1)
        self.assertEqual(self.collect("--min-share", "0.1", "--min-tickets-per-pattern", "3")["patterns"], [])
        self.assertEqual(self.collect("--min-share", "0.1")["pattern_thresholds"], {"min_tickets": 2, "min_share": 0.1})

    def test_blockers_without_a_rule_group_by_reviewer(self):
        records = [
            run("T-1", 1, blockers=[blocker(None, reviewer="Security", title="Token logged")]),
            run("T-2", 2, blockers=[blocker("", reviewer="security", title="Password logged")]),
            run("T-3", 3, blockers=[blocker(None, reviewer="product", title="Wrong copy")]),
        ]
        found = self.patterns(*records)
        self.assertEqual([(p["key"], p["tickets"]) for p in found], [("(no rule) security", ["T-1", "T-2"])])

    def test_blockers_per_reviewer_are_reported(self):
        self.runs(run("T-1", 1, blockers=[blocker("a"), blocker("b"), blocker("c", reviewer="security")]), run("T-2", 2, blockers=[blocker("d")]))
        self.assertEqual(self.collect()["blockers_by_reviewer"], [
            {"reviewer": "architecture", "tickets": ["T-1", "T-2"], "count": 3, "share": 1.0},
            {"reviewer": "security", "tickets": ["T-1"], "count": 1, "share": 0.5},
        ])

    def test_deviations_group_by_type(self):
        records = [
            run("T-1", 1, deviations=[{"type": "files-outside-plan", "task": "T2", "detail": "touched app/util.py"}, {"type": "test-amended", "task": "T3", "detail": "loosened"}]),
            run("T-2", 2, deviations=[{"type": "files-outside-plan", "task": None, "detail": "touched README.md"}]),
            run("T-3", 3, deviations=[{"type": "files-outside-plan", "task": "T1", "detail": "touched setup.py"}]),
        ]
        found = self.patterns(*records)
        self.assertEqual([(p["kind"], p["key"], p["tickets"], p["count"]) for p in found], [("deviation", "files-outside-plan", ["T-1", "T-2", "T-3"], 3)])
        self.assertEqual(found[0]["examples"][0], "T-1: touched app/util.py")

    def test_verify_findings_group_by_kind_of_target(self):
        records = [
            run("T-1", 1, verify_findings=["AC-06 (scenario): expected 'Saved', saw 'Save failed'", "R5 (matrix rule): refusal changed the record"]),
            run("T-2", 2, verify_findings=["AC-01 (scenario): wrong message", "The test suite fails when rerun in the cell (exit code 1); see evidence/test-suite.log."]),
            run("T-3", 3, verify_findings=["R2 (matrix rule): no message shown", "The test suite fails when rerun in the cell (exit code 2); see evidence/test-suite.log.",
                                           "A contract file is missing or malformed; see evidence/contract-check.log."]),
        ]
        found = {p["key"]: p for p in self.patterns(*records)}
        self.assertEqual({key: p["tickets"] for key, p in found.items()}, {"scenario": ["T-1", "T-2"], "matrix rule": ["T-1", "T-3"], "test suite": ["T-2", "T-3"]})
        self.assertEqual({p["kind"] for p in found.values()}, {"verify-failure"})

    def test_finding_kinds(self):
        for text, kind in (("AC-06 (scenario): x", "scenario"), ("AC-12: x", "scenario"), ("R5 (matrix rule): x", "matrix rule"), ("R5: x", "matrix rule"),
                           ("H-edge-case (holdout): x", "holdout"), ("The test suite fails", "test suite"), ("A contract file is missing", "contract"),
                           ("Something else went wrong", "other"), ("Note: the page was slow", "other")):
            self.assertEqual(observe.finding_kind(text), kind, text)

    def test_patterns_sort_by_number_of_tickets(self):
        records = [
            run("T-1", 1, blockers=[blocker("a"), blocker("b")], deviations=[{"type": "no-baseline", "task": None, "detail": ""}]),
            run("T-2", 2, blockers=[blocker("a"), blocker("b")], deviations=[{"type": "no-baseline", "task": None, "detail": ""}]),
            run("T-3", 3, blockers=[blocker("b")], deviations=[{"type": "no-baseline", "task": None, "detail": ""}]),
            run("T-4", 4, deviations=[{"type": "no-baseline", "task": None, "detail": ""}]),
        ]
        self.assertEqual([(p["key"], len(p["tickets"])) for p in self.patterns(*records)], [("b", 3), ("a", 2)], "no-baseline is a starting condition, not a pattern")


class ContextTest(Base):
    def test_by_risk_and_by_app_type(self):
        self.runs(
            run("T-1", 1, risk="High", app_type="api"),
            run("T-2", 2, risk="High", app_type="api", first_pass=False, rounds=2),
            run("T-3", 3, risk="High", app_type="web", outcome="abandoned", first_pass=False),
            run("T-4", 4, risk="Medium", app_type="web"),
            run("T-5", 5, risk=None, app_type=None),
        )
        metrics = self.collect()
        self.assertEqual(metrics["by_risk"], {
            "High": {"tickets": 3, "merged": 2, "first_pass": 1, "first_pass_rate": 0.5},
            "Medium": {"tickets": 1, "merged": 1, "first_pass": 1, "first_pass_rate": 1.0},
            "unknown": {"tickets": 1, "merged": 1, "first_pass": 1, "first_pass_rate": 1.0},
        })
        self.assertEqual({name: (group["tickets"], group["first_pass_rate"]) for name, group in metrics["by_app_type"].items()},
                         {"api": (2, 0.5), "web": (2, 1.0), "unknown": (1, 1.0)})

    def test_open_cells_and_blocked_list(self):
        for ticket, stage in (("T-7", "building"), ("T-8", "blocked"), ("T-9", "building"), ("T-10", "blocked")):
            self.write(f".factory/worktrees/{ticket}/cell.json", json.dumps({"ticket_id": ticket, "stage": stage, "risk": "Medium"}))
        self.write(".factory/worktrees/T-11/cell.json", "{broken")
        (self.project / ".factory/worktrees/empty").mkdir()
        self.assertEqual(self.collect()["open_cells"], {"total": 5, "by_stage": {"blocked": 2, "building": 2, "unreadable": 1}, "blocked": ["T-10", "T-8"]})

    def test_audit_section(self):
        self.write(observe.AUDIT_REPORT, json.dumps({"readiness_score": 84, "readiness_tier": "Silver", "timestamp": "2026-10-01T00:00:00+00:00", "checks": []}))
        self.assertEqual(self.collect()["audit"], {"readiness_score": 84, "readiness_tier": "Silver", "timestamp": "2026-10-01T00:00:00+00:00"})
        self.write(observe.AUDIT_REPORT, "not json")
        self.assertIsNone(self.collect()["audit"])


class ReportTest(Base):
    def test_missing_metrics(self):
        self.six()
        self.refused(report(), "Run 'collect' first")

    def test_stale_metrics_after_a_ticket_finishes(self):
        self.six()
        self.collect()
        self.runs(*[run(f"T-{n}", day=n) for n in range(1, 8)])
        self.refused(report(), "out of date")
        self.collect()
        self.assertEqual(self.file_report(report())[0], 0)

    def test_older_tickets_outside_the_window_do_not_make_metrics_stale(self):
        self.six()
        self.collect("--history-depth", "5", "--min-tickets", "2")
        self.runs(run("T-0", day=1, closed_at="2026-09-01T00:00:00+00:00"), *[run(f"T-{n}", day=n) for n in range(1, 7)])
        self.assertEqual(self.file_report(report())[0], 0)

    def test_missing_heading(self):
        self.six()
        self.collect()
        for heading in observe.REQUIRED_HEADINGS:
            self.refused(report(drop=heading), f"no '## {heading}' heading")

    def test_proposal_missing_a_field(self):
        self.six()
        self.collect()
        self.refused(report(proposal(target=None)), "has no '- **Target:**' line")
        self.refused(report(proposal(evidence=None)), "has no '- **Evidence:**' line")
        self.refused(report(proposal(change=None)), "has no '- **Change:**' line")
        self.refused(report(proposal(change="")), "has no '- **Change:**' line")

    def test_every_problem_is_listed(self):
        self.six()
        self.collect()
        err = self.refused(report(proposal(target=None, evidence=None), drop="Not proposed"), "Target")
        self.assertIn("Evidence", err)
        self.assertIn("Not proposed", err)

    def test_evidence_must_cite_two_tickets_from_the_sample(self):
        self.six()
        self.collect()
        self.refused(report(proposal(evidence="T-1 was blocked for it.")), "cites 1 ticket ID(s)")
        self.refused(report(proposal(evidence="T-1 and T-1 again.")), "cites 1 ticket ID(s)")
        self.refused(report(proposal(evidence="GIT-900 and GIT-901 both show it.")), "cites 0 ticket ID(s)")
        self.refused(report(proposal(evidence="T-1 and T-99 both show it.")), "cites 1 ticket ID(s)")
        self.refused(report(proposal(evidence="T-10 and T-11, also XT-1 and T-2x.")), "cites 0 ticket ID(s)")

    def test_tickets_outside_the_history_window_do_not_count(self):
        self.six()
        self.collect("--history-depth", "5")
        self.refused(report(proposal(evidence="T-1 and T-2.")), "cites 1 ticket ID(s)")

    def test_disallowed_targets(self):
        self.six()
        self.collect()
        for target in ("`skills/build/scripts/build.py`", "`.factory/config.json`", "`README.md`", "`../REVIEW.md`", "`/etc/REVIEW.md`", "`docs/references/x.md`", "`skills/build/NOTSKILL.md`", "Makefile"):
            self.refused(report(proposal(target=target)), "targets '")

    def test_allowed_targets(self):
        for target in ("REVIEW.md", "CLAUDE.md", "AGENTS.md", "./REVIEW.md", "skills/build/SKILL.md", ".claude/skills/mach-build/SKILL.md", "skills/verify/references/evidence-runners.md"):
            self.assertTrue(observe.allowed_target(observe.target_path(target)), target)
        self.assertEqual(observe.target_path("`CLAUDE.md`, section 6"), "CLAUDE.md")
        self.assertEqual(observe.target_path("REVIEW.md."), "REVIEW.md")

    def test_more_than_five_proposals(self):
        self.six()
        self.collect()
        self.refused(report(*[proposal(name=f"Change {n}") for n in range(6)]), "proposes 6 changes; the limit is 5")
        self.assertEqual(self.file_report(report(*[proposal(name=f"Change {n}") for n in range(5)]))[0], 0)

    def test_no_proposals_without_enough_data(self):
        self.runs(run("T-1", 1), run("T-2", 2))
        self.assertFalse(self.collect()["sample"]["enough_data"])
        self.refused(report(proposal()), "must propose nothing")
        code, out, err = self.file_report(report())
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["proposed_changes"], 0)

    def test_valid_report_is_filed_and_a_second_gets_a_suffix(self):
        self.six()
        self.collect()
        text = report(proposal(), proposal(name="Plan lists every file", target="`skills/build/SKILL.md`", evidence="`T-3`, `T-4` and T-5."))
        with mock.patch.object(observe, "today", return_value="20261109"):
            code, out, err = self.file_report(text)
            self.assertEqual(code, 0, err)
            first = json.loads(out)
            code, out, err = self.file_report(report())
            second = json.loads(out)
            third = json.loads(self.file_report(report())[1])
        folder = self.project / observe.OBSERVATIONS
        self.assertEqual((first["status"], first["report"]), ("FILED", str(folder / "observation-20261109.md")))
        self.assertEqual(first["proposed_targets"], ["REVIEW.md", "skills/build/SKILL.md"])
        self.assertEqual(first["proposed_changes"], 2)
        self.assertEqual((second["report"], third["report"]), (str(folder / "observation-20261109-2.md"), str(folder / "observation-20261109-3.md")))
        self.assertEqual((folder / "observation-20261109.md").read_text(), text, "an earlier report is never overwritten")
        self.assertEqual(second["proposed_targets"], [])

    def test_headings_inside_fenced_change_text_are_not_structure(self):
        self.six()
        self.collect()
        change = "Replace the section:\n  ```markdown\n  ## Not proposed\n  ### Another heading\n  - **Target:** `bin/mach`\n  ```"
        code, out, err = self.file_report(report(proposal(change=change)))
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["proposed_targets"], ["REVIEW.md"])

    def test_unreadable_report_file(self):
        self.six()
        self.collect()
        code, _, err = self.call("report", "--file", str(self.project / "nowhere.md"))
        self.assertEqual(code, 2)
        self.assertIn("Cannot read the report file", err)

    def test_filing_changes_nothing_but_the_observations_folder(self):
        self.six()
        self.write("REVIEW.md", "rules\n")
        self.collect()
        self.file_report(report(proposal()))
        self.assertEqual((self.project / "REVIEW.md").read_text(), "rules\n")
        self.assertEqual(sorted(p.name for p in self.project.iterdir()), [".factory", "REVIEW.md"])
        self.assertEqual(sorted(p.name for p in (self.project / ".factory").iterdir()), ["archive", "observations"])


class StatusTest(Base):
    def test_status_with_nothing_collected(self):
        code, out, _ = self.call("status")
        status = json.loads(out)
        self.assertEqual((code, status["metrics"], status["reports"]), (0, None, []))
        self.assertIn("collect", status["next"])

    def test_status_summarizes_metrics_and_lists_reports(self):
        records = [run("T-1", 1, blockers=[blocker("fr-04")]), run("T-2", 2, blockers=[blocker("fr-04")], rounds=2, first_pass=False)] + [run(f"T-{n}", n) for n in range(3, 7)]
        self.runs(*records)
        self.write(".factory/worktrees/T-8/cell.json", json.dumps({"ticket_id": "T-8", "stage": "blocked"}))
        self.collect()
        with mock.patch.object(observe, "today", return_value="20261109"):
            self.file_report(report(proposal()))
            self.file_report(report())
        code, out, _ = self.call("status")
        status = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual(status["metrics"]["sample"]["tickets_analyzed"], 6)
        self.assertTrue(status["metrics"]["up_to_date"])
        self.assertEqual(status["metrics"]["scorecard"]["first_pass_rate"], {"value": 0.833, "target": "> 0.85", "met": False})
        self.assertEqual(status["metrics"]["patterns"], [{"kind": "review-blocker", "key": "fr-04", "tickets": ["T-1", "T-2"]}])
        self.assertEqual(status["metrics"]["blocked_cells"], ["T-8"])
        self.assertEqual([(Path(r["file"]).name, r["proposed_changes"]) for r in status["reports"]], [("observation-20261109-2.md", 0), ("observation-20261109.md", 1)])
        self.assertIsNone(status["next"])
        self.runs(*records, run("T-7", 7))
        status = json.loads(self.call("status")[1])
        self.assertFalse(status["metrics"]["up_to_date"])
        self.assertIn("out of date", status["next"])


if __name__ == "__main__":
    unittest.main()
