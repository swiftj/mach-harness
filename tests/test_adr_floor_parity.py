"""The Factory Floor reads ADRs in Go (apps/observer/internal/adr), never through Python. adr.py is the authority.

One shared fixture, tests/fixtures/adr-parity, is parsed here by adr.py and in apps/observer/internal/adr/adr_test.go by the
Go reader, and both are held to the same expected.json: number, title, status, topics, superseded-by, whether it binds,
how many problems it has, and the baseline's coverage. When adr.py changes a rule, this test fails until the fixture's
expected values, and the Go reader, follow.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
import adr  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "adr-parity"


def topics(record):
    return [item[len("topic:"):] for item in record["applies_to"] if item.startswith("topic:") and adr.TOPIC_RE.match(item[len("topic:"):])]


class FloorParity(unittest.TestCase):
    def setUp(self):
        self.expected = json.loads((FIXTURE / "expected.json").read_text(encoding="utf-8"))

    def test_every_file_parses_as_expected(self):
        records, _ = adr.read_folder(adr.files_on_disk(FIXTURE, self.expected["dir"]), self.expected["dir"])
        got = [{"file": record["file"], "id": record["id"], "number": record["number"], "title": record["title"], "status": record["status"],
                "superseded_by": record["superseded_by"], "topics": topics(record), "binding": record["binding"],
                "problem_count": len(record["problems"])} for record in records]
        self.assertEqual(got, self.expected["adrs"])

    def test_the_baseline_coverage(self):
        # The fixture is a folder inside this repository, not a project of its own: read it as a project with no commit,
        # where adr.py reads the working tree, as the Floor does.
        with mock.patch.object(adr, "head_of", return_value=None):
            found = adr.coverage(FIXTURE, {})
        self.assertEqual(found["missing"], self.expected["missing"])
        self.assertEqual({row["topic"]: row["covered_by"] for row in found["topics"]}, self.expected["covered_by"])

    def test_the_fixture_covers_what_the_floor_shows(self):
        statuses = {item["status"] for item in self.expected["adrs"]}
        self.assertTrue({"accepted", "proposed", "superseded", "rejected", "deprecated", None} <= statuses)
        self.assertTrue(any(item["superseded_by"] for item in self.expected["adrs"]))
        self.assertTrue(any(item["problem_count"] for item in self.expected["adrs"]))
        self.assertTrue(self.expected["missing"])


if __name__ == "__main__":
    unittest.main()
