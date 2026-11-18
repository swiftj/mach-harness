"""Settling a drafted ADR's open points (decided 2026-11-18, after the first live baseline): the baseline is an interview,
and each answer is written into the ADR by `run.py adr settle`, never free-hand.

Covered here: the file before and after (the point leaves the open list, the answer joins the decision in MADR form, the
evidence stays), a revised decision, a point recorded as not decided, every refusal (unknown ADR, not proposed, no such
point, no points left, unattended), the open points `adr list` and `adr baseline` report, resuming (a second baseline
run gathers and redrafts nothing and lists what is left), and that accept refuses while a point is open and succeeds
after the last one, but never for an empty decision.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
for folder in ("intent", "run"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import adr  # noqa: E402
import baseline  # noqa: E402
from test_adr import UNATTENDED  # noqa: E402
from test_adr_baseline import PYTHON_REPO, Repository, Uncovered  # noqa: E402
from test_review import TICKET  # noqa: E402

POINTS = ["Which Python versions are supported and tested", "Whether type checking is used"]
DRAFT = adr.render("Use Python and the standard library", applies_to=["topic:language"], context="Written down for the baseline.",
                   options=["Python"], decision="The code is Python and uses only the standard library.", consequences=["Good, because it has no dependencies."],
                   evidence=["pyproject.toml: manifest", ".python-version: runtime version file (3.12)"], open_points=POINTS)


class SettleTextTest(unittest.TestCase):
    def test_a_point_leaves_the_open_list_and_its_answer_joins_the_decision(self):
        self.assertEqual(adr.open_points(DRAFT), POINTS)
        text, point = adr.settle(DRAFT, 1, "3.9 to 3.12, and CI tests both ends.")
        self.assertEqual(point, POINTS[0])
        self.assertEqual(adr.open_points(text), POINTS[1:])
        parts = adr.decision_parts(text)
        self.assertEqual(parts["decision"], "The code is Python and uses only the standard library.")
        self.assertEqual(parts["settled"], ["Which Python versions are supported and tested: 3.9 to 3.12, and CI tests both ends."])
        self.assertIn("- .python-version: runtime version file (3.12)", text, "the evidence is kept")
        self.assertEqual(adr.parse(text, "docs/adr/0001-x.md")["problems"], [])
        last, _ = adr.settle(text, 1, "No: there is no type checker, and none is adopted now.")
        self.assertEqual(adr.open_points(last), [])
        self.assertNotIn(adr.OPEN_POINTS_MARK, last)
        self.assertIn("## More Information\n\nEvidence in the repository", last)
        self.assertLess(last.index(adr.SETTLED_MARK), last.index("### Consequences"), "the answers sit inside Decision Outcome")

    def test_a_revised_decision_and_a_point_not_decided(self):
        text, _ = adr.settle(DRAFT, 2, "Not now; revisit when the API grows.", not_decided=True,
                             decision="The code is Python 3.9 or later and uses only the standard library.")
        parts = adr.decision_parts(text)
        self.assertEqual(parts["decision"], "The code is Python 3.9 or later and uses only the standard library.")
        self.assertEqual(parts["not_decided"], ["Whether type checking is used: Not now; revisit when the API grows."])
        self.assertEqual(parts["settled"], [])
        self.assertIn(adr.NOT_DECIDED_MARK, text)

    def test_the_more_information_section_goes_when_nothing_is_left_in_it(self):
        draft = adr.render("Keep no data", applies_to=["topic:storage"], context="Written down for the baseline.", options=["None"],
                           decision="The library keeps no data.", consequences=["Good."], open_points=["Whether a cache is used"])
        text, _ = adr.settle(draft, 1, "No cache.")
        self.assertNotIn("## More Information", text)

    def test_refusals(self):
        cases = {"no open point 3": (DRAFT, 3), "no open point 0": (DRAFT, 0), "not proposed": (DRAFT.replace("status: proposed", "status: accepted"), 1),
                 "no open points left": (adr.render("Keep no data", context="Why now here.", options=["A"], decision="Chosen here.", consequences=["Good."]), 1),
                 "cannot be read": ("# no header\n", 1)}
        for expected, (text, point) in cases.items():
            with self.subTest(expected=expected):
                with self.assertRaises(adr.ADRError) as raised:
                    adr.settle(text, point, "An answer.")
                self.assertIn(expected, str(raised.exception))
        with self.assertRaises(adr.ADRError):
            adr.settle(DRAFT, 1, "")
        with self.assertRaises(adr.ADRError):
            adr.settle(DRAFT, 1, "An answer.", decision="Short")

    def test_accept_waits_for_the_last_point_and_never_takes_an_empty_decision(self):
        with self.assertRaises(adr.ADRError) as raised:
            adr.accept_text(DRAFT, "Ana")
        self.assertIn("still lists 2 open point(s)", str(raised.exception))
        text, _ = adr.settle(DRAFT, 1, "3.12 only.")
        text, _ = adr.settle(text, 1, "Left for later.", not_decided=True)
        self.assertTrue(adr.parse(adr.accept_text(text, "Ana"), "docs/adr/0001-x.md")["binding"])
        empty = text.replace("The code is Python and uses only the standard library.\n", "")
        with self.assertRaises(adr.ADRError) as raised:
            adr.accept_text(empty, "Ana")
        self.assertIn("its decision is empty", str(raised.exception))


class SettleCommandTest(Repository):
    def setUp(self):
        self.make(PYTHON_REPO)
        code, out, err = self.run_cmd("adr", "baseline")
        self.assertEqual(code, 0, err)
        code, out, err = self.run_cmd("adr", "new", "--baseline", "language", "--title", "Use Python and the standard library",
                                      "--context", "Written down for the baseline.", "--decision", "The code is Python and uses only the standard library.",
                                      "--option", "Python with the standard library only", "--consequence", "Good, because nothing needs installing.",
                                      *[arg for point in POINTS for arg in ("--open-point", point)])
        self.assertEqual(code, 0, err)
        self.written = json.loads(out)
        self.path = self.project / self.written["file"]

    def settle(self, *argv, env=None, code=0):
        got, out, err = self.run_cmd("adr", "settle", *argv, env=env)
        self.assertEqual(got, code, err + out)
        return json.loads(out) if code == 0 else err

    def test_settle_reports_what_is_left_and_accept_follows_the_last_point(self):
        result = self.settle("ADR-0001", "--point", "2", "--answer", "No type checker for now.")
        self.assertEqual((result["status"], result["point"]["text"], result["recorded_as"], result["open_left"], result["committed"]),
                         ("SETTLED", POINTS[1], "settled", 1, False))
        self.assertEqual(result["open_points"], [{"number": 1, "text": POINTS[0]}])
        code, _, err = self.run_cmd("adr", "accept", "ADR-0001", "--by", "Ana")
        self.assertEqual(code, 1)
        self.assertIn("still lists 1 open point(s)", err)
        result = self.settle("ADR-0001", "--point", "1", "--answer", "3.9 to 3.12.", "--decision", "The code is Python 3.9 to 3.12 with the standard library only.")
        self.assertEqual((result["open_left"], result["decision_revised"]), (0, True))
        code, out, err = self.run_cmd("adr", "accept", "ADR-0001", "--by", "Ana")
        self.assertEqual(code, 0, err)
        self.assertIn("status: accepted", self.path.read_text())

    def test_refusals_change_nothing(self):
        before = self.path.read_text()
        self.assertIn("no such ADR", self.settle("ADR-0009", "--point", "1", "--answer", "x y", code=1))
        self.assertIn("no open point 5", self.settle("ADR-0001", "--point", "5", "--answer", "x y", code=1))
        self.assertIn("engineer's answer", self.settle("ADR-0001", "--point", "1", "--answer", "x y", env=UNATTENDED, code=1))
        self.assertEqual(self.path.read_text(), before)
        self.path.write_text(before.replace("status: proposed", "status: rejected"))
        self.assertIn("not proposed", self.settle("ADR-0001", "--point", "1", "--answer", "x y", code=1))

    def test_list_and_baseline_report_the_open_points_and_a_second_baseline_resumes(self):
        code, out, err = self.run_cmd("adr", "list")
        listed = json.loads(out)
        self.assertEqual(listed["adrs"][0]["open_points"], POINTS)
        self.assertEqual(listed["open_points_left"], [{"id": "ADR-0001", "file": self.written["file"], "open_points": POINTS}])
        before = self.path.read_text()
        with mock.patch.object(baseline, "gather", side_effect=AssertionError("gathered again")):
            code, out, err = self.run_cmd("adr", "baseline")
        self.assertEqual(code, 0, err)
        again = json.loads(out)
        self.assertNotIn("language", [item["topic"] for item in again["to_draft"]])
        self.assertEqual(again["open_points_left"], [{"topic": "language", "id": "ADR-0001", "file": self.written["file"],
                                                      "open_points": [{"number": 1, "text": POINTS[0]}, {"number": 2, "text": POINTS[1]}]}])
        self.assertEqual(again["ready_to_accept"], [])
        self.assertEqual(self.path.read_text(), before, "nothing is redrafted")
        self.settle("ADR-0001", "--point", "1", "--answer", "3.12 only.")
        self.settle("ADR-0001", "--point", "1", "--answer", "Left for later.", "--not-decided")
        code, out, err = self.run_cmd("adr", "baseline")
        again = json.loads(out)
        self.assertEqual((again["open_points_left"], again["ready_to_accept"]), ([], ["ADR-0001"]))
        self.assertEqual(again["tickets_waiting"], [])


class WaitingTicketsTest(Uncovered):
    def test_the_baseline_names_the_tickets_waiting_for_it(self):
        self.spec_ready()
        self.assertEqual(self.json_cmd("adr", "baseline")["tickets_waiting"], [TICKET])


if __name__ == "__main__":
    unittest.main()
