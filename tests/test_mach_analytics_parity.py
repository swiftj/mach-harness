"""Factory Analytics (MACH Next M6.5): the observe station's scorecard and the observer's copy of it.

The observe station computes six scorecard metrics from .factory/archive/runs.jsonl (observe.py
`scorecard`). The observer recomputes them from the same records as catalog metrics Q3, Q2, R5,
R6, G1 and G2, and the product owner's rule is that they keep numerical parity.

What these tests do, and never do:

- observe.py is imported and only its pure functions are called (`read_runs`, `select`,
  `scorecard`) on a copy of the project in a temporary folder. `collect`, `report` and
  `file-ticket` are never run: nothing is written into the repository and no ticket is filed.
- The observer is built from apps/observer when `go` is on the PATH and run on the copy, on a
  loopback port in 4390-4394, read through GET only, and stopped. Without Go those tests skip and
  say so.
- The generated runs.jsonl must have the shape cleanup.py's run_record gives a line (key order and
  nesting), checked against cleanup.py's own function on a scratch cell.
- Where the two implementations legitimately differ, the difference is written down below
  (KNOWN_DIFFERENCES, WINDOW_NOTE) and asserted as it is today, so a fix shows up as a test to
  update, never as a silent change.

Set MACH_ANALYTICS_PROJECTS to extra generated projects (colon-separated) to compare them too,
MACH_ANALYTICS_REPORT to a file to receive the comparison tables as JSON, and MACH_OBSERVER_BIN to
use an observer already built instead of building one.
"""

import contextlib
import http.cookiejar
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OBSERVE = ROOT / "skills" / "observe" / "scripts" / "observe.py"
CLEANUP = ROOT / "skills" / "cleanup" / "scripts" / "cleanup.py"
OBSERVER_SRC = ROOT / "apps" / "observer"
FIXTURES = ROOT / "tests" / "fixtures" / "analytics"
GOLDEN = ROOT / "apps" / "observer" / "internal" / "metrics" / "testdata" / "parity"
PORTS = [4390, 4391, 4392, 4393, 4394]

# Catalog metric -> observe scorecard key.
PAIRS = [("Q3", "average_rounds"), ("Q2", "first_pass_rate"), ("R5", "escalation_rate"), ("R6", "abandonment_rate"),
         ("G1", "tests_failing_first_share"), ("G2", "deviations_per_ticket")]

WINDOW_NOTE = ("observe.py analyses the HISTORY_DEPTH (20) most recently closed tickets by default; the observer folds every "
               "run record it has indexed, with no window. Parity holds when observe is given every record (depth = all).")

# Differences found by these tests on the edge and tie fixtures (and named in the frontend audit,
# part A.7), against the observer at the M6.5 baseline. Each is (fixture, metric) -> why. The test
# fails on any difference not listed here.
# The one difference left (the lead's decision): a run record whose ticket id is not usable ('bad id!') is
# refused by the observer and reported in the metric's coverage.excluded, never added to the values; observe
# keeps any non-empty ticket id. Everything else in the edge fixture (an id with spaces, fractional rounds and
# test counts, a missing or odd outcome) is read the same way by both. Rounding: the observer returns the
# unrounded ratio, so ties at the third decimal (ties-runs.jsonl) agree once rounded the way observe rounds.
BAD_ID = "bad id!"
_BAD_ID_WHY = ("the record with ticket id 'bad id!' is refused by the observer (counted in coverage.excluded, not in the value) and "
               "kept by observe, so observe has 14 records and the observer 13. Without that record the two agree exactly.")
KNOWN_DIFFERENCES = {("edge", metric): _BAD_ID_WHY for metric, _ in [("Q3", 0), ("Q2", 0), ("R5", 0), ("R6", 0), ("G1", 0), ("G2", 0)]}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


observe = load("mach_parity_observe", OBSERVE)
cleanup = load("mach_parity_cleanup", CLEANUP)


def observe_scorecard(project, depth=None):
    """observe.py's scorecard over the project's runs.jsonl: every record, or the `depth` most recent."""
    runs, skipped = observe.read_runs(project)
    selected = observe.select(runs, depth if depth is not None else max(len(runs), 1))
    return observe.scorecard([record for _, record in selected]), len(selected), skipped


def project_with(runs_text):
    folder = Path(tempfile.mkdtemp(prefix="mach-parity-"))
    for sub in ("intake", "worktrees", "archive", "local"):
        (folder / ".factory" / sub).mkdir(parents=True)
    (folder / ".factory" / "archive" / "runs.jsonl").write_text(runs_text, encoding="utf-8")
    return folder


def report(name, rows):
    path = os.environ.get("MACH_ANALYTICS_REPORT")
    if not path:
        return
    data = {}
    with contextlib.suppress(OSError, ValueError):
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    data[name] = rows
    Path(path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def table(title, rows):
    lines = [f"\n{title}", f"  {'metric':<4} {'observe key':<26} {'observe':>9} {'observer':>9} {'equal':>6}"]
    for r in rows:
        lines.append(f"  {r['metric']:<4} {r['observe_key']:<26} {str(r['observe']):>9} {str(r['observer']):>9} {('yes' if r['equal'] else 'NO'):>6}")
    print("\n".join(lines), file=sys.stderr)


# ---------------------------------------------------------------- the observer, built and run on a copy

class Observer:
    binary = None
    build_error = None
    ports = list(PORTS)

    @classmethod
    def build(cls):
        if cls.binary or cls.build_error:
            return cls.binary
        prebuilt = os.environ.get("MACH_OBSERVER_BIN")
        if prebuilt:
            cls.binary = Path(prebuilt)
            return cls.binary
        go = shutil.which("go")
        if not go:
            cls.build_error = "Go is not installed: the observer cannot be built, so observer-side parity is not checked."
            return None
        out = Path(tempfile.mkdtemp(prefix="mach-parity-bin-")) / "mach-observer"
        done = subprocess.run([go, "build", "-o", str(out), "./cmd/mach-observer"], cwd=OBSERVER_SRC, capture_output=True, text=True)
        if done.returncode != 0:
            cls.build_error = "the observer did not build: " + done.stderr.strip()[-400:]
            return None
        cls.binary = out
        return out

    def __init__(self, project):
        self.project = project
        self.proc = None
        self.peak_rss_kb = 0
        self.ingest_seconds = None

    def __enter__(self):
        port = self.ports.pop(0)
        self.ports.append(port)
        self.log = open(self.project / ".observer-test.log", "w+")
        started = time.monotonic()
        self.proc = subprocess.Popen([str(self.binary), "--project", str(self.project), "--port", str(port)], stdout=self.log, stderr=subprocess.STDOUT)
        link = None
        for _ in range(200):
            self.log.seek(0)
            found = re.search(r"^Open: (\S+)", self.log.read(), re.MULTILINE)
            if found:
                link = found.group(1)
                break
            if self.proc.poll() is not None:
                break
            time.sleep(0.05)
        if not link:
            self.__exit__(None, None, None)
            raise AssertionError("the observer printed no link")
        self.origin = link.split("/?")[0].split("/#")[0].rstrip("/")
        if not self.origin.startswith("http://127.0.0.1:"):
            raise AssertionError("not a loopback origin: " + self.origin)
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.opener.open(link, timeout=10).read()
        self.wait_until_settled(started)
        return self

    def rss(self):
        done = subprocess.run(["ps", "-o", "rss=", "-p", str(self.proc.pid)], capture_output=True, text=True)
        with contextlib.suppress(ValueError):
            self.peak_rss_kb = max(self.peak_rss_kb, int(done.stdout.strip() or 0))

    def get(self, path):
        with self.opener.open(self.origin + path, timeout=30) as reply:
            body = json.loads(reply.read())
        assert body.get("ok"), body
        return body["data"]

    def wait_until_settled(self, started, timeout=600):
        """Until ingest has caught up, the projection has no lag, and two readings of the metrics agree."""
        last = None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.rss()
            health = self.get("/api/v1/health")
            ingest = health.get("ingest") or {}
            lag = ((health.get("freshness") or {}).get("projection") or {}).get("lag_events")
            # Only the metrics: the reply's envelope carries its own generation time (generated_ms), which changes every request.
            metrics = json.dumps(self.get("/api/v1/analytics/metrics?ids=Q2,Q3,R5,R6,G1,G2").get("metrics"), sort_keys=True)
            if not ingest.get("catching_up") and lag == 0 and ingest.get("ticks", 0) > 2 and metrics == last:
                self.ingest_seconds = round(time.monotonic() - started, 2)
                return
            last = metrics
            time.sleep(0.4)
        raise AssertionError("the observer did not settle in time")

    def metrics(self, last_runs=None):
        query = "/api/v1/analytics/metrics?ids=" + ",".join(m for m, _ in PAIRS) + (f"&last_runs={last_runs}" if last_runs else "")
        rows = self.get(query)["metrics"]
        return {row["id"]: row for row in rows}

    def __exit__(self, *exc):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.log.close()
        return False


def same(observe_value, observer_value):
    """Equal at observe's precision. observe rounds with Python's round(v, 3); an observer value given
    to more places is rounded the same way first. A value the observer rounded itself is compared as is."""
    if observe_value is None or observer_value is None:
        return observe_value is None and observer_value is None
    return observe_value == observer_value or observe_value == round(observer_value, 3)


def compare(observe_card, observer_rows):
    rows = []
    for metric, key in PAIRS:
        o = observe_card[key]
        r = observer_rows[metric]
        rows.append({"metric": metric, "observe_key": key, "observe": o["value"], "observer": r.get("value"),
                     "equal": same(o["value"], r.get("value")), "observe_met": o["met"], "observer_met": r.get("met"),
                     "observer_numerator": r.get("numerator_value"), "observer_denominator": r.get("denominator_value"),
                     "observer_null_reason": r.get("null_reason")})
    return rows


def generated_projects():
    """The medium project, generated by mach-synth (seed 1) when Go is present, plus any named in MACH_ANALYTICS_PROJECTS."""
    found = []
    extra = os.environ.get("MACH_ANALYTICS_PROJECTS", "")
    for item in [p for p in extra.split(":") if p]:
        found.append((Path(item).name, Path(item)))
    return found


# ---------------------------------------------------------------- tests

class RunRecordShapeTest(unittest.TestCase):
    """The generator writes run records the way cleanup.py's run_record does: same keys, same order, same nesting, json.dumps formatting."""

    def cleanup_shapes(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            root = project / ".factory" / "worktrees" / "SYN-001"
            (root / "review" / "round-1" / "votes").mkdir(parents=True)
            (root / "evidence").mkdir()
            (root / "cell.json").write_text(json.dumps({"ticket_id": "SYN-001", "stage": "approved", "risk": "Medium", "app_type": "cli", "mode": "headless",
                                                        "branch": "feature/SYN-001", "created_at": "2026-11-01T10:00:00+00:00",
                                                        "merged": {"method": "local", "commit": "abc1234", "at": "2026-11-01T11:00:00+00:00"},
                                                        "product": {"slice_id": "SLICE-001", "revision": 1, "wave_id": "WAVE-001"}}))
            (root / "build-report.json").write_text(json.dumps({"review_loop": 0, "tests_seen_failing_first": 1, "tests_passing_on_first_run": [],
                                                                "deviations": [{"type": "scope", "task": "T2", "detail": "x"}]}))
            (root / "review" / "round-1" / "decision.json").write_text(json.dumps({"outcome": "APPROVED", "head": "abc1234", "human_approval": None}))
            (root / "review" / "round-1" / "votes" / "security.json").write_text(json.dumps({"reviewer": "security", "findings": [
                {"severity": "blocker", "rule": "FR-01", "title": "t", "file": "f"}, {"severity": "note", "title": "n", "file": "f"}]}))
            cell = cleanup.Cell(project, "SYN-001")
            record = cleanup.run_record(cell, "merged", None, ".factory/archive/SYN-001.tar.gz", {"outcome": "merged", "default_branch": "main"})
        return record

    def test_generated_records_have_cleanups_shape(self):
        reference = self.cleanup_shapes()
        nested = {"integration": list(reference["integration"]), "product": list(reference["product"]),
                  "deviations": list(reference["deviations"][0]), "blockers": list(reference["blockers"][0]), "notes": list(reference["notes"][0])}
        lines = (FIXTURES / "medium" / "runs.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertGreater(len(lines), 40)
        seen = set()
        for line in lines:
            record = json.loads(line)
            self.assertEqual(line, json.dumps(record, ensure_ascii=False), "not written the way json.dumps writes it")
            self.assertEqual(list(record), list(reference), record["ticket_id"])
            for key, keys in nested.items():
                value = record[key]
                for item in value if isinstance(value, list) else [value] if value else []:
                    self.assertEqual(list(item), keys, f"{record['ticket_id']} {key}")
                    seen.add(key)
            self.assertIn(record["outcome"], ("merged", "abandoned"))
            self.assertEqual(record["first_pass"], record["outcome"] == "merged" and record["rounds"] == 1)
        self.assertEqual(seen, set(nested), "every nested shape occurs in the fixture")


class ScorecardGroundTruthTest(unittest.TestCase):
    """observe.py's scorecard over the medium fixture equals the generator's independently computed ground truth."""

    def test_all_records_and_default_window(self):
        expected = json.loads((FIXTURES / "medium" / "expected.json").read_text(encoding="utf-8"))["observe_scorecard"]
        project = project_with((FIXTURES / "medium" / "runs.jsonl").read_text(encoding="utf-8"))
        try:
            for depth, name in ((None, "all_finished"), (observe.HISTORY_DEPTH, "observe_default_depth_20")):
                card, analysed, skipped = observe_scorecard(project, depth)
                self.assertEqual(skipped, 0)
                self.assertEqual(analysed, expected[name]["tickets"], name)
                for _, key in PAIRS:
                    # The truth carries the unrounded ratio: observe's rounding (Python round, half-even) is applied here.
                    self.assertEqual(card[key]["value"], round(expected[name][key]["value"], 3), f"{name} {key}")
        finally:
            shutil.rmtree(project)

    def test_golden_observe_values_are_current(self):
        """The golden file the Go side can test against holds what observe.py computes today."""
        golden = json.loads((GOLDEN / "observe-golden.json").read_text(encoding="utf-8"))
        for name, source in (("medium", FIXTURES / "medium" / "runs.jsonl"), ("edge", FIXTURES / "edge-runs.jsonl"), ("ties", FIXTURES / "ties-runs.jsonl")):
            self.assertEqual((GOLDEN / f"{name}-runs.jsonl").read_text(encoding="utf-8"), source.read_text(encoding="utf-8"), name)
            project = project_with(source.read_text(encoding="utf-8"))
            try:
                card, analysed, skipped = observe_scorecard(project)
            finally:
                shutil.rmtree(project)
            self.assertEqual(golden[name], {"tickets_analyzed": analysed, "skipped_malformed_lines": skipped, "scorecard": card}, name)


@unittest.skipUnless(shutil.which("go"), "Go is not installed: the observer cannot be built, so observer-side parity is not checked.")
class ObserverParityTest(unittest.TestCase):
    """The observer's Q3, Q2, R5, R6, G1 and G2 against observe.py's scorecard over the same runs.jsonl."""

    @classmethod
    def setUpClass(cls):
        if not Observer.build():
            raise AssertionError(Observer.build_error)  # Go is present (the class is skipped otherwise): a failed build is a failure

    def run_pair(self, name, source_project):
        tmp = Path(tempfile.mkdtemp(prefix="mach-parity-copy-"))
        try:
            copy = tmp / "project"
            shutil.copytree(source_project, copy, ignore=shutil.ignore_patterns("local"))
            (copy / ".factory" / "local" / "executions").mkdir(parents=True, exist_ok=True)
            if (source_project / ".factory" / "local" / "executions").is_dir():
                shutil.rmtree(copy / ".factory" / "local" / "executions")
                shutil.copytree(source_project / ".factory" / "local" / "executions", copy / ".factory" / "local" / "executions")
            before = (copy / ".factory" / "archive" / "runs.jsonl").read_bytes()
            all_card, analysed, skipped = observe_scorecard(copy)
            window_card, _, _ = observe_scorecard(copy, observe.HISTORY_DEPTH)
            with Observer(copy) as obs:
                rows = compare(all_card, obs.metrics())
                # The same window as observe's default, when the observer serves last_runs (M6.5).
                windowed = compare(window_card, obs.metrics(last_runs=observe.HISTORY_DEPTH))
                stats = {"ingest_seconds": obs.ingest_seconds, "peak_rss_mb": round(obs.peak_rss_kb / 1024, 1)}
            self.assertEqual((copy / ".factory" / "archive" / "runs.jsonl").read_bytes(), before, "runs.jsonl changed")
            self.assertFalse((copy / ".factory" / "observations" / "metrics.json").exists(), "observe wrote its metrics")
            window = [{"metric": m, "observe_key": k, "observe": window_card[k]["value"], "observer": next(r["observer"] for r in rows if r["metric"] == m),
                       "equal": window_card[k]["value"] == next(r["observer"] for r in rows if r["metric"] == m)} for m, k in PAIRS]
            table(f"{name}: observe (every record, {analysed} tickets, {skipped} skipped) vs observer   [{stats}]", rows)
            table(f"{name}: observe default window (last {observe.HISTORY_DEPTH}) vs observer (no window) -- documented difference: {WINDOW_NOTE}", window)
            table(f"{name}: observe default window (last {observe.HISTORY_DEPTH}) vs observer with last_runs={observe.HISTORY_DEPTH}", windowed)
            report(name, {"all": rows, "window_20": window, "window_20_last_runs": windowed, "stats": stats, "tickets_analyzed": analysed, "skipped": skipped})
            self.windowed = windowed
            return rows, window
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_generated_medium_project(self):
        out = Path(tempfile.mkdtemp(prefix="mach-parity-gen-"))
        try:
            project = out / "medium"
            done = subprocess.run(["go", "run", "./internal/testkit/cmd/mach-synth", "--out", str(project), "--analytics", "--cells", "60", "--waves", "8", "--seed", "1"],
                                  cwd=OBSERVER_SRC, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual((project / ".factory" / "archive" / "runs.jsonl").read_text(encoding="utf-8"),
                             (FIXTURES / "medium" / "runs.jsonl").read_text(encoding="utf-8"), "the generator no longer reproduces the medium fixture")
            rows, _ = self.run_pair("medium", project)
            expected = json.loads((project / "expected.json").read_text(encoding="utf-8"))["observe_scorecard"]["all_finished"]
        finally:
            shutil.rmtree(out, ignore_errors=True)
        if any(r["observer"] is not None for r in self.windowed):  # an observer that serves last_runs
            for row in self.windowed:
                self.assertTrue(row["equal"], ("last_runs", row))
        for row in rows:
            self.assertTrue(row["equal"], row)
            truth = expected[row["observe_key"]]
            self.assertEqual(row["observer_denominator"], truth["denominator"], row)
            self.assertAlmostEqual(row["observer_numerator"], truth["numerator"], places=3, msg=row)

    def test_projects_named_in_the_environment(self):
        projects = generated_projects()
        if not projects:
            self.skipTest("MACH_ANALYTICS_PROJECTS names no project")
        for name, project in projects:
            with self.subTest(project=name):
                rows, _ = self.run_pair(name, project)
                for row in rows:
                    self.assertTrue(row["equal"], row)

    def test_edge_and_tie_fixtures_differ_only_where_documented(self):
        differing = set()
        for name in ("edge", "ties"):
            project = project_with((FIXTURES / f"{name}-runs.jsonl").read_text(encoding="utf-8"))
            try:
                rows, _ = self.run_pair(name, project)
            finally:
                shutil.rmtree(project, ignore_errors=True)
            differing |= {(name, row["metric"]) for row in rows if not row["equal"]}
        for key in sorted(differing | set(KNOWN_DIFFERENCES)):
            print(f"  {key}: {'differs' if key in differing else 'equal now'} -- {KNOWN_DIFFERENCES.get(key, 'NOT DOCUMENTED')}", file=sys.stderr)
        self.assertEqual(differing, set(KNOWN_DIFFERENCES))

    def test_edge_fixture_without_the_refused_id_agrees_exactly(self):
        """The documented edge differences have one cause: remove the record with the unusable ticket id and every metric agrees."""
        lines = (FIXTURES / "edge-runs.jsonl").read_text(encoding="utf-8").splitlines()
        kept = [line for line in lines if f'"ticket_id": "{BAD_ID}"' not in line]
        self.assertEqual(len(kept), len(lines) - 1)
        project = project_with("\n".join(kept) + "\n")
        try:
            rows, _ = self.run_pair("edge-without-bad-id", project)
        finally:
            shutil.rmtree(project, ignore_errors=True)
        for row in rows:
            self.assertTrue(row["equal"], row)

if __name__ == "__main__":
    unittest.main()
