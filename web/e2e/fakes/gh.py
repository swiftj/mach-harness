#!/usr/bin/env python3
"""Stand-in for gh: a thin wrapper around the stand-in the Python suite uses for GitHub issues
(FAKE_GH in tests/test_mach_product_issues.py, written beside this file as `gh-issues` by
lib/world.mjs), which keeps issues, labels, comments and sub-issues in $FAKE_GH_STATE and never
touches the network.

The wrapper adds two things the end-to-end suites need:
- every call's full argument vector and working folder, one JSON line each, in $FAKE_GH_STATE.calls;
- an exclusive lock on $FAKE_GH_STATE.lock for the whole call, so the host's calls and a terminal's
  (or a test's own change through lib/world.mjs) never interleave a read and a write."""
import fcntl
import json
import os
import subprocess
import sys

path = os.environ["FAKE_GH_STATE"]
with open(path + ".lock", "a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    with open(path + ".calls", "a") as log:
        log.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd()}) + "\n")
    issues = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gh-issues")
    done = subprocess.run([sys.executable, issues, *sys.argv[1:]])
sys.exit(done.returncode)
