#!/usr/bin/env python3
"""Run the test suite with one process per test class, several at a time.

    python3 tests/in_parallel.py            # every class, one worker per core
    python3 tests/in_parallel.py -j 4       # four at a time
    python3 tests/in_parallel.py test_cell  # only classes whose name contains this

Each class runs as `python3 -m unittest <module>.<Class>` from the repository
root, exactly as it would alone, so a class that passes here passes in
`python3 -m unittest discover -s tests`, which remains the plain way to run
everything in one process. A class that fails has its whole output printed.
Standard library only.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
import unittest
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, Iterator, List, Tuple

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
RAN = re.compile(r"^Ran (\d+) tests? in", re.M)
SKIPPED = re.compile(r"skipped=(\d+)")


def classes() -> Tuple[List[str], List[str]]:
    """Every test class as `module.Class`, and anything that could not be loaded."""
    found: Dict[str, None] = {}
    broken: List[str] = []

    def walk(suite: unittest.TestSuite) -> Iterator[unittest.TestCase]:
        for item in suite:
            if isinstance(item, unittest.TestSuite):
                yield from walk(item)
            else:
                yield item

    for case in walk(unittest.defaultTestLoader.discover(str(TESTS), top_level_dir=str(TESTS))):
        kind = type(case)
        if kind.__module__.startswith("unittest.loader"):  # a module that failed to import
            broken.append(case.id())
        else:
            found[f"{kind.__module__}.{kind.__qualname__}"] = None
    return list(found), broken


def run_one(name: str) -> Tuple[str, int, int, int, float, str]:
    started = time.monotonic()
    done = subprocess.run(
        [sys.executable, "-m", "unittest", name],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env={**os.environ, "MACH_FACTORY_NO_START": "1", "PYTHONPATH": os.pathsep.join(filter(None, [str(TESTS), os.environ.get("PYTHONPATH", "")]))},
    )
    ran = RAN.search(done.stdout)
    skipped = SKIPPED.search(done.stdout.rsplit("\n", 3)[-2] if done.stdout.count("\n") > 1 else "")
    return (name, done.returncode, int(ran.group(1)) if ran else 0,
            int(skipped.group(1)) if skipped else 0, time.monotonic() - started, done.stdout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("only", nargs="*", help="run only classes whose name contains one of these")
    parser.add_argument("-j", "--jobs", type=int, default=os.cpu_count() or 2, help="how many at a time")
    parser.add_argument("--slowest", type=int, default=0, metavar="N", help="list the N slowest classes")
    args = parser.parse_args()

    names, broken = classes()
    if broken:
        print("could not load: " + ", ".join(broken), file=sys.stderr)
        return 1
    if args.only:
        names = [name for name in names if any(part in name for part in args.only)]
    if not names:
        print("no test class matches", file=sys.stderr)
        return 1

    return run(names, args.jobs, args.slowest)


def run(names: List[str], jobs: int, slowest: int = 0) -> int:
    """Run these classes, `jobs` at a time; print each failure in full, then a summary. 0 when all pass."""
    started = time.monotonic()
    failed: List[str] = []
    times: List[Tuple[float, str]] = []
    tests = skipped = 0
    with ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        for future in as_completed([pool.submit(run_one, name) for name in names]):
            name, code, ran, skips, seconds, output = future.result()
            tests += ran
            skipped += skips
            times.append((seconds, name))
            if code != 0:
                failed.append(name)
                print(f"\n===== FAILED: {name} =====\n{output}", flush=True)
            else:
                print(".", end="", flush=True)

    print(f"\n{'-' * 70}\nRan {tests} tests in {len(names)} classes in {time.monotonic() - started:.1f}s, "
          f"{max(1, jobs)} at a time")
    for seconds, name in sorted(times, reverse=True)[: slowest]:
        print(f"  {seconds:7.1f}s  {name}")
    if failed:
        print(f"\nFAILED ({len(failed)} classes): " + ", ".join(sorted(failed)))
        return 1
    print(f"\nOK{f' (skipped={skipped})' if skipped else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
