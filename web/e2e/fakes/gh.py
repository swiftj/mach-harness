#!/usr/bin/env python3
"""Stand-in for gh: the same behaviour as the stand-in in tests/test_mach_product_collab.py, plus
the full argument vector of every call in state["calls"], so a test can assert exactly what reached
it. State lives in $FAKE_GH_STATE. Never touches the network.

Concurrent calls (the host's and a terminal's at once) are serialised with an exclusive lock on
$FAKE_GH_STATE.lock, held from the read to the write, and the state is replaced atomically, so no
call ever reads a half-written file or loses another's update. Tests change the state through the
same lock (lib/world.mjs setPr)."""
import fcntl
import json
import os
import sys

path = os.environ["FAKE_GH_STATE"]
lock = open(path + ".lock", "a")
fcntl.flock(lock, fcntl.LOCK_EX)
with open(path) as f:
    state = json.load(f)
args = sys.argv[1:]
state["log"].append(args[:2])
state.setdefault("calls", []).append({"argv": args, "cwd": os.getcwd()})


def done(code=0):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)
    sys.exit(code)


if len(args) < 2:
    done(0)
if args[1] in state["fail"]:
    print("gh: simulated failure: " + args[1], file=sys.stderr)
    done(1)


def value(flag):
    return args[args.index(flag) + 1]


if args[:2] == ["pr", "list"]:
    print(json.dumps([{"number": p["number"], "url": p["url"]} for p in state["prs"] if p["head"] == value("--head") and p["state"] == "OPEN"]))
elif args[:2] == ["pr", "create"]:
    number = len(state["prs"]) + 1
    state["prs"].append({"number": number, "url": "https://example.test/pull/%d" % number, "head": value("--head"), "base": value("--base"),
                         "title": value("--title"), "body": value("--body"), "state": "OPEN", "isDraft": "--draft" in args,
                         "reviewDecision": "", "mergeable": "MERGEABLE", "statusCheckRollup": [], "reviews": [], "comments": []})
    print("https://example.test/pull/%d" % number)
elif args[:2] == ["pr", "view"]:
    found = [p for p in state["prs"] if p["head"] == args[2]]
    if not found:
        print("no pull requests found", file=sys.stderr)
        done(1)
    print(json.dumps(found[-1]))
done()
