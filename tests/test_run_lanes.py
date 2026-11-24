"""Tests for routing lanes and the drivers (M22 design, piece D): run.py names `build-lanes` when the build station's records
put a ticket's build at its lanes, hands the driver the lanes to start (lanes-start) and joins them (lanes-join), and a lane
whose builder is at work answers `worker-in-cell` to any other driver. The belt workflow runs it end to end here, against the
real run.py and build station, with fake builders that do each lane's tasks through build.py.

Every scenario runs real Git in a temporary project, as test_build_lanes does, from whose fixtures it builds.
"""

import io
import json
import os
import shutil
import subprocess
import sys
import unittest
from unittest import mock
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import run  # noqa: E402
import test_build_lanes as lanes_fixture  # noqa: E402
from test_build import IMPL, git  # noqa: E402
from test_build_lanes import HOLDER, L1, L2, LANE_PLAN, LANE_PLAN_HEAD, OTHER, README, RELEASE, THREE_LANES, TICKET  # noqa: E402

TAIL = LANE_PLAN[LANE_PLAN.index("\n## File touch map"):]
# Plans are written in pieces: test_cell_lanes holds that no single string in the suite is a plan using the additions.
BEFORE_PART = ("### Before the lanes\n"
               "- [ ] T01 [test] Table-driven test of rules R1 to R5 — `tests/test_invite.py` (FR-01, FR-02, FR-03, FR-04, FR-05, FR-07, INV-01, INV-02, INV-04)\n"
               "- [ ] T02 [impl] Invitation service — `app/invite.py` (FR-01, FR-02, FR-03, FR-04, FR-05, FR-07)\n\n"
               "### Lanes\n"
               "- [ ] T03 [test] Scenarios — `tests/test_release.py` (AC-01, AC-02, AC-03, FR-06, FR-08, FR-09, INV-03)\n"
               "- [ ] T04 [impl] Release — `app/release.py` (FR-06, FR-08)\n"
               "- [ ] T05 [docs] Describe invitations in the README — `README.md` (FR-01)\n")
BEFORE_PLAN = LANE_PLAN_HEAD + BEFORE_PART + TAIL
FIVE_PART = ("### Lanes\n" + "".join(line + "\n" for line in LANE_PLAN.split("### Lanes\n")[1].split("\n\n### After the lanes")[0].splitlines())
             + "- [ ] T05 [docs] Describe invitations in the README — `README.md` (FR-01)\n"
             + "- [ ] T06 [docs] Notes on invitations — `docs/invite.md` (FR-02)\n"
             + "- [ ] T07 [docs] Notes on release — `docs/release.md` (FR-06)\n")
FIVE_LANES = LANE_PLAN_HEAD + FIVE_PART + TAIL.replace("| `README.md` | modify | T05 |\n", "| `README.md` | modify | T05 |\n| `docs/invite.md` | create | T06 |\n"
                                                                                       "| `docs/release.md` | create | T07 |\n")
DOCS = {"T05": ("done", {"README.md": README}), "T06": ("done", {"docs/invite.md": "# Invitations\n"}),
        "T07": ("done", {"docs/release.md": "# Release\n"})}


class Base(lanes_fixture.LaneBase):
    def run_cmd(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.project), *argv])
        return code, out.getvalue(), err.getvalue()

    def run_json(self, *argv):
        code, out, err = self.run_cmd(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def next_step(self, *extra):
        return self.run_json("next", TICKET, *extra)

    def lanes_start(self, holder=HOLDER, *extra):
        return self.run_json("lanes-start", TICKET, "--holder", holder, *extra)

    def lanes_join(self, *extra):
        return self.run_json("lanes-join", TICKET, *extra)

    def lane_file(self, name):
        return self.cellroot / "lanes" / name / "lane.json"

    def age(self, *paths, minutes=91):
        """Make a lane's builder, or a claim, look idle for `minutes`."""
        old = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat(timespec="seconds")
        for path in paths:
            data = json.loads(path.read_text())
            data.update({key: old for key in ("last_step_at", "handed_at", "at", "renewed_at") if key in data})
            path.write_text(json.dumps(data))

    def other_building(self, ticket):
        folder = self.project / ".factory/worktrees" / ticket
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.put(folder, {"cell.json": json.dumps({"ticket_id": ticket, "stage": "building"}),
                          "claim.json": json.dumps({"step": "build", "stage": "building", "holder": "c" * 32, "at": now})})
        return folder

    def build_docs(self, lane, *tasks):
        for task in tasks:
            step, files = DOCS[task]
            self.put(self.lane_work(lane), files)
            self.ok(step, TICKET, task)


class RoutingTest(Base):
    def test_a_lanes_plan_goes_to_its_lanes_once_the_build_has_started(self):
        self.ready_lanes()
        self.assertEqual(self.next_step()["action"], "build", "the builder starts the build, as always")
        self.ok("start", TICKET)
        found = self.next_step("--holder", HOLDER)
        self.assertEqual((found["action"], found["stop"], found["prompt"], found["agent_type"], found["stage"]), ("build-lanes", False, None, None, "building"))
        self.assertEqual(found["lanes"], [{"lane": "L1", "tasks": ["T01", "T02"], "status": "planned", "done": 0, "of": 2},
                                          {"lane": "L2", "tasks": ["T03", "T04"], "status": "planned", "done": 0, "of": 2}])
        self.assertIn("built in 2 lanes at the same time, each by its own builder (L1: T01, T02; L2: T03, T04)", found["reason"])
        self.assertEqual(found["claim"]["step"], "build-lanes")
        self.assertEqual(json.loads((self.cellroot / "claim.json").read_text())["step"], "build-lanes")

    def test_tasks_before_the_lanes_go_to_the_cells_builder_first(self):
        self.ready_lanes(plan=BEFORE_PLAN)
        self.ok("start", TICKET)
        self.assertEqual(self.next_step()["action"], "build")
        for task, step, files in L1:
            self.put(self.work, files)
            self.ok(step, TICKET, task)
        self.assertEqual(self.ok("next", TICKET)["status"], "LANES")
        found = self.next_step()
        self.assertEqual(found["action"], "build-lanes")
        self.assertEqual([view["tasks"] for view in found["lanes"]], [["T03", "T04"], ["T05"]])

    def test_open_lanes_stay_at_build_lanes_until_joined_then_the_cell_builds_on(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.lanes_start()
        self.assertIn("0 of 2 lanes are built; L1, L2 still to build", self.next_step("--holder", HOLDER)["reason"])
        self.build_lane("L1", L1)
        self.build_lane("L2", L2[:1])
        found = self.next_step("--holder", HOLDER)
        self.assertIn("1 of 2 lanes are built; L2 still to build, each from where it stopped", found["reason"])
        self.assertEqual([(view["status"], view["done"]) for view in found["lanes"]], [("done", 2), ("open", 1)])
        self.build_lane("L2", L2[1:])
        self.assertEqual(self.next_step("--holder", HOLDER)["reason"], "Every lane is built; the lanes are joined next, then the build goes on in the cell.")
        self.assertEqual(self.lanes_join("--holder", HOLDER)["status"], "JOINED")
        after = self.next_step("--holder", HOLDER)
        self.assertEqual((after["action"], after["agent_type"]), ("build", "mach:builder"))
        self.assertIn("continue from the next task", after["prompt"])

    def test_without_lanes_or_built_in_order_it_is_the_build_as_before(self):
        self.ready_lanes(settings={"build": {"max_lanes": 1}})
        self.ok("start", TICKET)
        self.assertEqual(self.next_step()["action"], "build")

    def test_a_ticket_built_in_order_for_want_of_places_goes_back_to_the_build(self):
        self.ready_lanes(settings={"factory": {"max_builders": 3}})
        self.other_building("OTHER-1")
        self.other_building("OTHER-2")
        self.ok("start", TICKET)
        self.assertEqual(self.next_step()["action"], "build-lanes")
        answer = self.lanes_start()
        self.assertEqual((answer["status"], answer["then"], answer["grant"], answer["free_places"]), ("SEQUENTIAL", "next", 1, 1))
        self.assertEqual([item["ticket"] for item in answer["other_tickets"]], ["OTHER-1", "OTHER-2"])
        self.assertIn("other tickets use 2", answer["reason"])
        self.assertEqual(self.next_step("--holder", HOLDER)["action"], "build")
        self.assertEqual(self.ok("next", TICKET)["task"], "T01")

    def test_a_revision_round_never_goes_to_lanes(self):
        self.through_lanes()
        self.put(self.work, {"README.md": README})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)
        findings = Path(self.tmp.name) / "findings.md"
        findings.write_text("1. Say more.\n")
        self.ok("revise", TICKET, "--findings", str(findings))
        found = self.next_step()
        self.assertEqual(found["action"], "build")
        self.assertIn("revision 1", found["prompt"])


class DigestTest(Base):
    """The digest that opens next, status and explain says how the lanes stand, and only for a build that has them."""

    def test_a_build_without_lanes_shows_the_digest_as_before(self):
        self.ready_lanes(settings={"build": {"max_lanes": 1}})
        self.ok("start", TICKET)
        digest = self.next_step()["digest"]
        self.assertEqual(set(digest), {"where", "needs_person", "time_and_cost", "elapsed_seconds", "cost_usd"}, "no lanes key at all")
        code, out, err = self.run_cmd("explain", TICKET)
        self.assertEqual(code, 0, err)
        self.assertNotIn("Lanes:", out)

    def test_a_build_in_lanes_says_how_they_stand(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.assertIn("planned in 2 lanes", self.next_step()["digest"]["lanes"])
        self.lanes_start()
        self.assertIn("The build is at its lanes: 2 lanes", self.next_step("--holder", HOLDER)["digest"]["lanes"])
        code, out, err = self.run_cmd("explain", TICKET)
        self.assertEqual(code, 0, err)
        self.assertEqual(out.count("Lanes: The build is at its lanes"), 1, "explain prints it once")


class LanesStartTest(Base):
    def test_the_lanes_to_start_with_the_grant_from_the_free_places(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        answer = self.lanes_start()
        self.assertEqual((answer["status"], answer["then"], answer["grant"], answer["free_places"], answer["max_lanes"], answer["max_builders"]),
                         ("OPEN", "lanes-start", 3, 3, 3, 3))
        self.assertEqual(answer["other_tickets"], [])
        self.assertIn("Start every lane listed at once", answer["next"])
        self.assertNotIn("holder", answer, "a holder is printed only when lanes-start made it")
        for lane, tasks in (("L1", ["T01", "T02"]), ("L2", ["T03", "T04"])):
            item = next(item for item in answer["lanes"] if item["lane"] == lane)
            self.assertEqual((item["tasks"], item["agent_type"], item["model"], item["done"], item["of"]), (tasks, "mach:builder", "sonnet", 0, 2))
            self.assertEqual(item["workdir"], str(self.lane_work(lane)))
            self.assertIn(item["workdir"], item["prompt"])
            self.assertIn(f"build.py next {TICKET} --lane {lane}", item["prompt"])
        claim = json.loads((self.cellroot / "claim.json").read_text())
        self.assertEqual((claim["step"], claim["holder"]), ("build-lanes", HOLDER), "lanes-start claims the step for its driver")

        self.build_lane("L1", L1)
        self.build_lane("L2", L2[:1])
        again = self.lanes_start()
        self.assertEqual([(item["lane"], item["done"]) for item in again["lanes"]], [("L2", 1)], "a lane that stopped part way is handed back")
        self.build_lane("L2", L2[1:])
        done = self.lanes_start()
        self.assertEqual((done["status"], done["then"], done["lanes"]), ("NONE_LEFT", "lanes-join", []))
        self.assertEqual(done["next"], run.LANE_THEN["lanes-join"])

    def test_five_lanes_and_two_free_places_come_in_three_batches(self):
        """Design 15, scenario 11: the grant is the free places; the batches are asked for one after another."""
        self.ready_lanes(plan=FIVE_LANES, settings={"factory": {"max_builders": 3}})
        self.other_building("OTHER-1")
        self.ok("start", TICKET)
        self.assertEqual([view["lane"] for view in self.next_step()["lanes"]], ["L1", "L2", "L3", "L4", "L5"])
        batches = []
        for _ in range(4):
            answer = self.lanes_start()
            if answer["status"] != "OPEN":
                break
            self.assertEqual((answer["grant"], answer["free_places"]), (2, 2))
            batches.append([item["lane"] for item in answer["lanes"]])
            for item in answer["lanes"]:
                if item["lane"] == "L1":
                    self.build_lane("L1", L1)
                elif item["lane"] == "L2":
                    self.build_lane("L2", L2)
                else:
                    self.build_docs(item["lane"], *item["tasks"])
        self.assertEqual(batches, [["L1", "L2"], ["L3", "L4"], ["L5"]])
        self.assertEqual((answer["status"], answer["then"]), ("NONE_LEFT", "lanes-join"))
        joined = self.lanes_join()
        self.assertEqual((joined["status"], joined["landed"]), ("JOINED", 7))
        self.assertEqual(self.next_step("--holder", HOLDER)["action"], "build")

    def test_with_no_other_ticket_it_opens_up_to_the_setting(self):
        self.ready_lanes(plan=FIVE_LANES, settings={"build": {"max_lanes": 4}, "factory": {"max_builders": 8}})
        self.ok("start", TICKET)
        answer = self.lanes_start()
        self.assertEqual((answer["grant"], len(answer["lanes"])), (4, 4))

    def test_a_new_holder_is_made_and_printed_and_a_bad_one_refused(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        answer = self.lanes_start("new")
        self.assertRegex(answer["holder"], r"^[0-9a-f]{32}$")
        self.assertEqual(json.loads(self.lane_file("L1").read_text())["holder"], answer["holder"])
        code, out, err = self.run_cmd("lanes-start", TICKET, "--holder", "not a holder")
        self.assertEqual((code, out), (1, ""))
        self.assertIn("--holder takes 'new' or the holder token", err)

    def test_a_ticket_that_is_not_building_has_no_lanes_to_start(self):
        self.ready_lanes()
        answer = self.lanes_start()
        self.assertEqual((answer["status"], answer["code"], answer["then"], answer["needs"]), ("REFUSED", "wrong-stage", "next", None))
        self.assertIn("is not being built (stage planned)", answer["reason"])
        self.assertFalse((self.cellroot / "claim.json").exists(), "nothing is claimed")


class StationRefusalTest(Base):
    """Every refusal of lanes-open and join is routed to who acts next, with the next command: the line itself, a wait, or a person."""

    def test_every_code_has_a_next_action(self):
        B = run.build_station()
        expected = {
            "lane-held": ("WAIT", "worker-in-cell", "wait"), "no-free-place": ("WAIT", "free-place", "wait"),
            "lanes-not-ready": ("REFUSED", None, "next"), "wrong-stage": ("REFUSED", None, "next"), "already-joined": ("REFUSED", None, "next"),
            "lanes-not-open": ("REFUSED", None, "next"), "lanes-not-done": ("REFUSED", None, "lanes-start"),
            "uncommitted-changes": ("REFUSED", "lanes-blocked", "person"),
            "lane-folder-unknown": ("REFUSED", "lanes-blocked", "person"), "worktree-failed": ("REFUSED", "lanes-blocked", "person"),
            "bad-holder": ("REFUSED", "lanes-blocked", "person"),
            "bad-grant": ("REFUSED", "lanes-blocked", "person"),
        }
        for code, (status, needs, then) in expected.items():
            answer = run.lanes_refused(TICKET, B.BuildError(f"the station's words for {code}", code=code), {})
            self.assertEqual((answer["status"], answer["needs"], answer["then"], answer["code"]), (status, needs, then, code), code)
            self.assertEqual(answer["reason"], f"the station's words for {code}")
            self.assertEqual(answer["next"], run.LANE_THEN[then])
            self.assertTrue(answer["next"])

    def test_tasks_before_the_lanes_not_done(self):
        self.ready_lanes(plan=BEFORE_PLAN)
        self.ok("start", TICKET)
        answer = self.lanes_start()
        self.assertEqual((answer["status"], answer["code"], answer["then"]), ("REFUSED", "lanes-not-ready", "next"))
        self.assertIn("The tasks before the lanes are not done yet (T01, T02)", answer["reason"])
        refusals = [json.loads(line)["data"] for line in (self.cellroot / "lifecycle.jsonl").read_text().splitlines()
                    if json.loads(line)["type"] == "gate.evaluated" and json.loads(line)["data"]["gate"] == "build.lanes-open"]
        self.assertEqual([(item["outcome"], item["reason_code"]) for item in refusals], [("refuse", "lanes-not-ready")], "recorded as the station's own command line records it")

    def test_a_stray_change_in_the_cell_is_for_a_person_and_then_it_carries_on(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.put(self.work, {"app/stray.py": "X = 1\n"})
        answer = self.lanes_start()
        self.assertEqual((answer["status"], answer["code"], answer["needs"], answer["then"]), ("REFUSED", "uncommitted-changes", "lanes-blocked", "person"))
        self.assertIn("app/stray.py", answer["reason"])
        self.assertEqual(answer["next"], run.LANE_THEN["person"])
        (self.work / "app/stray.py").unlink()
        self.assertEqual(self.lanes_start()["status"], "OPEN")

    def test_a_red_suite_at_the_lanes_is_not_for_a_person_the_plan_is_built_in_order(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        state = self.state()
        state["suite"] = "red"
        (self.cellroot / "build.json").write_text(json.dumps(state))
        answer = self.lanes_start()
        self.assertEqual((answer["status"], answer.get("needs"), answer["then"]), ("SEQUENTIAL", None, "next"))
        self.assertIn("The cell's suite is red where the lanes would open", answer["reason"])
        self.assertEqual(self.next_step("--holder", HOLDER)["action"], "build", "the cell's builder carries on")

    def test_a_folder_in_a_lanes_place_is_for_a_person_and_then_it_carries_on(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.lanes_start()
        git(self.project, "worktree", "remove", "--force", str(self.lane_work("L2")))
        self.put(self.lane_work("L2"), {"notes.txt": "mine\n"})
        answer = self.lanes_start()
        self.assertEqual((answer["code"], answer["needs"], answer["then"]), ("lane-folder-unknown", "lanes-blocked", "person"))
        shutil.move(str(self.lane_work("L2")), str(Path(self.tmp.name) / "aside"))
        self.assertEqual([item["lane"] for item in self.lanes_start()["lanes"]], ["L1", "L2"])

    def test_with_no_free_place_for_the_next_batch_the_tickets_own_place_runs_a_lane(self):
        self.ready_lanes(plan=THREE_LANES, settings={"factory": {"max_builders": 2}})
        self.ok("start", TICKET)
        self.assertEqual([item["lane"] for item in self.lanes_start()["lanes"]], ["L1", "L2"])
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        self.other_building("OTHER-1")
        self.other_building("OTHER-2")
        answer = self.lanes_start()
        self.assertEqual((answer["status"], answer["then"], answer["grant"], answer["free_places"], answer["own_place_only"]), ("OPEN", "lanes-start", 1, 0, True))
        self.assertEqual([item["lane"] for item in answer["lanes"]], ["L3"], "never waiting with nothing running")


class JoinTest(Base):
    def built(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.lanes_start()

    def test_joined(self):
        self.built()
        self.assertEqual(self.lanes_join()["code"], "lanes-not-done")
        early = self.lanes_join()
        self.assertEqual((early["status"], early["then"], early["needs"]), ("REFUSED", "lanes-start", None))
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        joined = self.lanes_join("--holder", HOLDER)
        self.assertEqual((joined["status"], joined["then"], joined["landed"], joined["set_aside"], joined["fix_task"], joined["needs"]),
                         ("JOINED", "next", 4, [], None, None))
        self.assertEqual(joined["reason"], "4 task commit(s) landed on the ticket's branch, in plan order; the whole suite passed on the joined result.")
        again = self.lanes_join()
        self.assertEqual((again["status"], again["code"], again["then"]), ("REFUSED", "already-joined", "next"))

    def test_lanes_that_do_not_pass_together_add_a_fix_task_and_the_cell_builds_on(self):
        """Design 15, scenario 7, through the line."""
        self.built()
        noisy = "import os\nos.environ['MACH_MODE'] = 'invite'\n\n" + IMPL
        self.build_lane("L1", [L1[0], ("T02", "green", {"app/invite.py": noisy})])
        self.build_lane("L2", [L2[0], ("T04", "green", {"app/release.py": "import os\n\ndef release():\n    return os.environ.get('MACH_MODE', 'released')\n"})])
        joined = self.lanes_join()
        self.assertEqual((joined["status"], joined["then"], joined["fix_task"]), ("INTERACTION", "next", "J-T01"))
        self.assertIn("the lanes do not pass together", joined["reason"])
        self.assertIn("a fix task, J-T01, was added for the cell's builder", joined["reason"])
        self.assertTrue(joined["failing"])
        self.assertEqual(self.next_step("--holder", HOLDER)["action"], "build")
        self.assertEqual(self.ok("next", TICKET)["task"], "J-T01")

    def test_a_lane_set_aside_is_said_and_its_tasks_are_built_in_the_cell(self):
        self.built()
        self.build_lane("L1", L1[:1])
        self.put(self.lane_work("L1"), {"app/invite.py": IMPL, "app/util.py": "def tidy(x):\n    return x\n"})
        self.ok("green", TICKET, "T02", "--allow-extra", "a helper")
        self.build_lane("L2", L2[:1])
        self.put(self.lane_work("L2"), {"app/release.py": RELEASE, "app/util.py": "def tidy(x):\n    return x.strip()\n"})
        self.ok("green", TICKET, "T04", "--allow-extra", "a helper")
        joined = self.lanes_join()
        self.assertEqual(joined["set_aside"], [{"lane": "L2", "tasks": ["T03", "T04"]}])
        self.assertIn("lane L2 was set aside: it changed a file another lane changed, so its tasks (T03, T04) are built again in the cell", joined["reason"])
        self.assertEqual(self.next_step("--holder", HOLDER)["action"], "build")
        self.assertEqual(self.ok("next", TICKET)["task"], "T03")

    def test_a_landing_that_cannot_be_done_is_for_a_person(self):
        self.built()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        fork = self.state()["lanes"]["fork"]
        side = self.project / ".factory/side"
        git(self.project, "worktree", "add", "-q", "--detach", str(side), fork)
        self.put(side, {"README.md": "# Other\n"})
        git(side, "commit", "-qam", "base elsewhere")
        self.put(side, {"README.md": "# Other, changed\n"})
        git(side, "commit", "-qam", "change elsewhere")
        data = json.loads(self.lane_file("L2").read_text())
        data["tasks"][1]["commit"] = git(side, "rev-parse", "HEAD").stdout.strip()
        self.lane_file("L2").write_text(json.dumps(data))
        joined = self.lanes_join()
        self.assertEqual((joined["status"], joined["needs"], joined["then"], joined["landed"]), ("REFUSED", "lanes-blocked", "person", 0))
        self.assertIn("Nothing was landed", joined["reason"])
        self.assertIn("run build.py join LOCAL-001 again", joined["next"])
        self.assertEqual(self.next_step("--holder", HOLDER)["action"], "build-lanes", "the ticket stays at its lanes, to be joined again")

    def test_stray_files_in_a_lane_are_not_for_a_person(self):
        self.built()
        self.build_lane("L1", L1)
        self.build_lane("L2", L2)
        self.put(self.lane_work("L2"), {"app/stray.py": "X = 1\n"})
        joined = self.lanes_join()
        self.assertEqual((joined["status"], joined["needs"], joined["then"], joined["landed"]), ("JOINED", None, "next", 4))
        self.assertIn("lane L2's uncommitted files (app/stray.py) were set aside under refs/mach/lane-files/LOCAL-001/L2/1, not landed", joined["reason"])
        self.assertEqual(joined["files_set_aside"][0]["ref"], "refs/mach/lane-files/LOCAL-001/L2/1")


class HandBackTest(Base):
    def test_a_lane_handed_back_counts_as_done_and_its_tasks_are_built_in_the_cell(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.lanes_start()
        self.build_lane("L1", L1)
        handed = self.run_json("lanes-hand-back", TICKET, "--lane", "L2", "--reason", "it needs a file of another lane", "--holder", HOLDER)
        self.assertEqual((handed["status"], handed["lane"], handed["finished"], handed["handed_back"], handed["then"]),
                         ("HANDED_BACK", "L2", [], ["T03", "T04"], "lanes-start"))
        self.assertEqual(handed["reason"], "Lane L2 was handed back to the cell: its tasks T03, T04 are built one at a time after the join.")
        found = self.next_step("--holder", HOLDER)
        self.assertIn("Every lane is built or handed back; the lanes are joined next", found["reason"])
        self.assertIn("Handed back to the cell, to be built one task at a time after the join: L2.", found["reason"])
        self.assertEqual([view["status"] for view in found["lanes"]], ["done", "handed-back"])
        self.assertEqual(self.lanes_start()["then"], "lanes-join")
        again = self.run_json("lanes-hand-back", TICKET, "--lane", "L2", "--reason", "again")
        self.assertEqual((again["status"], again["code"], again["then"]), ("REFUSED", "already-handed-back", "lanes-start"))
        self.assertEqual(self.lanes_join("--holder", HOLDER)["status"], "JOINED")
        self.assertEqual(self.next_step("--holder", HOLDER)["action"], "build")
        self.assertEqual(self.ok("next", TICKET)["task"], "T03")

    def test_a_lane_taken_over_by_another_driver_cannot_be_handed_back_by_the_old_one(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.lanes_start()
        self.lanes_start(OTHER, "--take-over")
        answer = self.run_json("lanes-hand-back", TICKET, "--lane", "L1", "--reason", "x", "--holder", HOLDER)
        self.assertEqual((answer["status"], answer["needs"]), ("WAIT", "worker-in-cell"))


class TestCommandTest(Base):
    """A build with no test command is never a dead end: the routing sheet tells the builder to set one, and decide offers it first."""

    def test_no_test_command_at_the_start_routes_back_to_the_builder_with_the_way_forward(self):
        self.ready_lanes(settings={"build": {"max_lanes": 1}})
        self.audit_report(commands={"test": {"command": None}, "lint": {"command": None}})
        code, _, err = self.run_build("start", TICKET)
        self.assertEqual(code, 1)
        self.assertIn("No test command is known", err)
        found = self.next_step()
        self.assertEqual((found["action"], found["stop"]), ("build", False), "never a stop, never abandoning")
        self.assertIn(f'build.py start {TICKET} --test-cmd "<command>"', found["prompt"])
        self.assertIn("the builder sets one and the build carries on", found["reason"])
        decided = self.run_json("decide", TICKET, "--json")
        (item,) = [t for t in decided.get("tickets") or [] if t.get("ticket_id") == TICKET]
        first = item["options"][0]
        self.assertEqual((first["key"], first["label"]), ("set-test-command", "Set a test command"))
        self.assertEqual(first["route"], f'build.py start {TICKET} --test-cmd "<command>"')
        self.ok("start", TICKET, "--test-cmd", lanes_fixture.test_build.TEST_CMD)
        after = self.next_step()
        self.assertNotIn("test command", after["prompt"], "once given, nothing more is said")

    def test_a_build_without_the_refusal_has_the_prompt_it_always_had(self):
        self.ready_lanes(settings={"build": {"max_lanes": 1}})
        self.assertEqual(self.next_step()["prompt"], f"Build MACH ticket {TICKET}.")


class TwoDriversTest(Base):
    """Design 15, scenario 10, and design 9: two drivers, a dead lane builder, an interrupted conversation."""

    def opened(self):
        self.ready_lanes()
        self.ok("start", TICKET)
        self.assertEqual(self.next_step("--holder", HOLDER)["action"], "build-lanes")
        self.assertEqual(self.lanes_start()["status"], "OPEN")

    def test_a_live_lane_stops_another_driver_even_after_the_claim_went_stale(self):
        self.opened()
        first = self.next_step("--holder", OTHER)
        self.assertEqual((first["action"], first["needs"]), ("stop", "worker-in-cell"), "the claim is fresh")
        self.age(self.cellroot / "claim.json")
        self.assertIsNone(run.claims().current(self.cellroot, 90), "driver A's claim.json has gone stale")
        stopped = self.next_step("--holder", OTHER)
        self.assertEqual((stopped["action"], stopped["needs"]), ("stop", "worker-in-cell"))
        self.assertEqual(stopped["other_claim"]["lanes"], ["L1", "L2"])
        self.assertEqual(stopped["other_claim"]["step"], "build-lanes")
        self.assertIn("Another worker is building lanes L1, L2 of this ticket", stopped["reason"])
        self.assertIn("A person can say to take over this step.", stopped["reason"])
        self.assertNotIn(HOLDER, json.dumps(stopped), "never the holder")
        self.assertEqual(self.next_step()["needs"], "worker-in-cell", "without a holder it is refused the same way")
        held = self.lanes_start(OTHER)
        self.assertEqual((held["status"], held["code"], held["needs"], held["then"]), ("WAIT", "worker-in-cell", "worker-in-cell", "wait"))
        self.assertEqual(json.loads(self.lane_file("L1").read_text())["holder"], HOLDER, "no lane was handed to the second driver")
        self.assertEqual(self.lanes_join("--holder", OTHER)["needs"], "worker-in-cell")
        status = self.run_json("status")
        (row,) = [row for row in status["tickets"] if row["ticket_id"] == TICKET]
        self.assertEqual(row["claim"]["lanes"], ["L1", "L2"], "the status says lane builders are at work")
        self.assertIn(TICKET, status["being_worked_on"])
        mine = self.next_step("--holder", HOLDER)
        self.assertEqual(mine["action"], "build-lanes", "the driver whose lanes they are carries on")

    def test_a_dead_lane_builder_is_taken_over_by_the_next_driver_and_resumes(self):
        self.opened()
        self.build_lane("L1", L1[:1])
        self.put(self.lane_work("L1"), {"app/invite.py": "def invite(email):\n"})  # half written when its builder died
        self.age(self.cellroot / "claim.json", self.lane_file("L1"), self.lane_file("L2"))
        found = self.next_step("--holder", OTHER)
        self.assertEqual(found["action"], "build-lanes", "idle past factory.claim_minutes: the next driver takes it")
        answer = self.lanes_start(OTHER)
        self.assertEqual([(item["lane"], item["done"]) for item in answer["lanes"]], [("L1", 1), ("L2", 0)])
        self.assertEqual(json.loads(self.lane_file("L1").read_text())["holder"], OTHER)
        self.assertEqual(self.ok("next", TICKET, "--lane", "L1")["task"], "T02", "it resumes where it stopped")
        self.put(self.lane_work("L1"), {"app/invite.py": IMPL})
        self.ok("green", TICKET, "T02")
        self.build_lane("L2", L2)
        self.assertEqual(self.lanes_join("--holder", OTHER)["status"], "JOINED")

    def test_a_person_takes_over_live_lanes(self):
        self.opened()
        taken = self.next_step("--holder", OTHER, "--take-over")
        self.assertEqual(taken["action"], "build-lanes")
        answer = self.lanes_start(OTHER, "--take-over")
        self.assertEqual([item["lane"] for item in answer["lanes"]], ["L1", "L2"])
        self.assertEqual(json.loads(self.lane_file("L2").read_text())["holder"], OTHER)
        self.assertEqual(self.next_step("--holder", HOLDER)["needs"], "worker-in-cell", "the first driver is now the other one")

    def test_the_schedule_holds_a_ticket_whose_lanes_another_driver_holds_by_the_same_rule_as_next(self):
        self.opened()
        self.age(self.cellroot / "claim.json")  # only the live lanes hold it now
        held = self.run_json("schedule", TICKET, "--holder", OTHER)
        self.assertEqual(held["start"], [])
        (item,) = held["held"]
        self.assertEqual((item["ticket_id"], item["rule"]), (TICKET, "claimed"))
        self.assertIn("another worker is building its lane(s) L1, L2, since", item["why"])
        self.assertNotIn(HOLDER, json.dumps(held), "never the holder")
        self.assertEqual(self.next_step("--holder", OTHER)["needs"], "worker-in-cell", "the routing sheet agrees")
        self.assertEqual([item["ticket_id"] for item in self.run_json("schedule", TICKET, "--holder", HOLDER)["start"]], [TICKET],
                         "the driver whose lanes they are is not held by them")
        self.assertEqual(self.run_json("schedule", TICKET)["held"][0]["rule"], "claimed", "without a holder, any live lane holds it")
        self.age(self.lane_file("L1"), self.lane_file("L2"))
        self.assertEqual([item["ticket_id"] for item in self.run_json("schedule", TICKET, "--holder", OTHER)["start"]], [TICKET],
                         "lanes idle past factory.claim_minutes hold nothing")

    def supervised(self, mine, earlier_state, runner="r-1"):
        """A ledger with two supervised executions of this ticket: an earlier one (in `earlier_state`) and this one (`mine`)."""
        ledger = {"supervisor": {"executions": {
            "x111111111111": {"ticket_id": TICKET, "state": earlier_state, "runner_id": runner},
            mine: {"ticket_id": TICKET, "state": "started", "runner_id": "r-1"}}}}
        self.put(self.project, {".factory/intake/ledger.json": json.dumps(ledger)})
        return mock.patch.dict(os.environ, {run.EXECUTION_ENV: mine})

    def test_a_new_execution_carries_on_its_ended_predecessors_lanes_at_once(self):
        earlier = run.execution_holder("x111111111111")
        self.ready_lanes()
        self.ok("start", TICKET)
        with self.supervised("x111111111111", "started"):
            self.assertEqual(self.run_json("where")["holder"], earlier, "an execution's holder is its own, the same each time")
            self.lanes_start(earlier)
        self.build_lane("L1", L1[:1])  # then the execution was killed mid-lanes; the ledger records it as ended
        with self.supervised("x222222222222", "unknown"):
            mine = self.run_json("where")["holder"]
            self.assertEqual(mine, run.execution_holder("x222222222222"))
            found = self.next_step("--holder", mine)
            self.assertEqual(found["action"], "build-lanes", "no worker-in-cell: its predecessor is known to have ended")
            self.assertIn("Carried on from this ticket's earlier Factory execution, which has ended", found["reason"])
            answer = self.lanes_start(mine)
            self.assertEqual([(item["lane"], item["done"]) for item in answer["lanes"]], [("L1", 1), ("L2", 0)], "each from where it stopped")
            self.assertEqual(json.loads(self.lane_file("L1").read_text())["earlier_holders"],
                             [{"holder": earlier, "until": json.loads(self.lane_file("L1").read_text())["handed_at"],
                               "why": "carried on from a run known to have ended"}])

    def test_an_execution_never_carries_on_from_one_still_running_or_another_machines(self):
        earlier = run.execution_holder("x111111111111")
        self.ready_lanes()
        self.ok("start", TICKET)
        with self.supervised("x111111111111", "started"):
            self.lanes_start(earlier)
        for state, runner in (("started", "r-1"), ("finished", "r-2")):
            with self.supervised("x222222222222", state, runner=runner):
                mine = self.run_json("where")["holder"]
                self.assertEqual(self.next_step("--holder", mine)["needs"], "worker-in-cell", (state, runner))
                self.assertEqual(self.lanes_start(mine)["code"], "worker-in-cell")
        self.assertEqual(json.loads(self.lane_file("L1").read_text())["holder"], earlier)

    def test_an_interrupted_conversation_carries_on_with_its_own_lanes(self):
        self.opened()
        self.build_lane("L2", L2[:1])
        # The engineer interrupted: the lane builders stopped with the conversation. The same conversation runs /mach again.
        self.assertEqual(self.next_step("--holder", HOLDER)["action"], "build-lanes")
        again = self.lanes_start()
        self.assertEqual([(item["lane"], item["done"]) for item in again["lanes"]], [("L1", 0), ("L2", 1)])


# ---------------------------------------------------------------- the belt, end to end

LANE_BUILDER = r'''
import contextlib, io, json, os, re, sys
from pathlib import Path
root, project, prompt = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
sys.dont_write_bytecode = True
sys.path[:0] = [str(root / "skills" / "build" / "scripts"), str(root / "tests")]
import build
import test_build_lanes as T
import test_run_lanes as R
work = {task: (step, files) for task, step, files in T.L1 + T.L2}
work.update(R.DOCS)
ticket = "LOCAL-001"

def call(*argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
        code = build.main(["--project", str(project), *argv])
    return code, (json.loads(out.getvalue()) if out.getvalue().strip() else {})

def do(task, workdir):
    step, files = work[task]
    for name, text in files.items():
        path = Path(workdir) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    code, _ = call(step, ticket, task)
    assert code == 0, (task, step)

lane = re.match(r"Build lane (L[0-9]+) of MACH ticket ", prompt)
holder = re.search(r"--holder ([0-9a-f]+)", prompt)
stall = os.environ.get("MACH_TEST_STALL_LANE")
stop = os.environ.get("MACH_TEST_STOP_LANE")
marker = project / ".factory" / f"stopped-{stop}"
if lane:
    name, count = lane.group(1), 0
    assert holder, "the lane prompt names the holder"
    while name != stall:  # a stalled lane's builder never gets anywhere
        code, data = call("next", ticket, "--lane", name, "--holder", holder.group(1))
        if data.get("status") == "LANE_DONE":
            break
        if name == stop and count == 1 and not marker.exists():
            marker.write_text("once")  # this builder dies after one task, the first time only
            break
        do(data["task"], data["workdir"])
        count += 1
else:
    if prompt.startswith("Build MACH ticket"):
        assert call("start", ticket)[0] == 0
    while True:
        code, data = call("next", ticket)
        if code or data.get("status") == "LANES":
            break
        if data.get("status") == "ALL_TASKS_DONE":
            assert call("finish", ticket)[0] == 0
            break
        do(data["task"], data["workdir"])
'''

BELT_HARNESS = r"""
const { execFileSync } = require('child_process')
const [PY, RUNPY, PROJECT, HELPER, ROOTDIR, HOLDER] = CONFIG
const env = Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }, EXTRA_ENV)
const asked = []
const logs = []
const workers = []
let live = 0
let most = 0
const atOnce = []
async function agent(prompt, opts) {
  opts = opts || {}
  if (opts.label === 'locate the belt script') return { project: PROJECT, run_script: RUNPY, python: PY, holder: HOLDER }
  const block = prompt.match(/```bash\n(.*)\n```/)
  if (block) {  // a relay: run the real run.py, and copy its answer as a relay would
    const rest = block[1].slice(`${PY} "${RUNPY}" --project "${PROJECT}" `.length)
    asked.push(rest)
    let out
    try {
      out = execFileSync(PY, [RUNPY, '--project', PROJECT, ...rest.match(/"[^"]*"|\S+/g).map(word => word.replace(/^"|"$/g, ''))], { encoding: 'utf8', env })
    } catch (error) {
      return { action: 'ERROR', status: 'ERROR', outcome: 'ERROR', refused: 'ERROR', reason: String(error.stderr || error.message), stop: false, agent_type: '', lanes: [], then: '' }
    }
    const data = JSON.parse(out)
    for (const key of Object.keys(data)) if (data[key] === null) data[key] = ''
    if (rest.startsWith('status')) return { audit_state: data.audit.state, observe_due: data.observe_due, factory_tuning_ready: data.factory_tuning_ready }
    if (rest.startsWith('schedule')) return { refused: '', in_force: data.ceiling.in_force, start: data.start, held: data.held }
    return data
  }
  workers.push({ prompt, agentType: opts.agentType || '', model: opts.model || '', label: opts.label || '' })
  live++
  most = Math.max(most, live)
  atOnce.push(live)
  await new Promise(resolve => setTimeout(resolve, 20))
  try {
    execFileSync(PY, [HELPER, ROOTDIR, PROJECT, prompt], { encoding: 'utf8', env })
  } finally {
    live--
  }
  return 'done'
}
async function parallel(fns) { return Promise.all(fns.map(fn => fn())) }
function phase() {}
function log(message) { logs.push(message) }
async function workflow(args, agent, parallel, pipeline, phase, log, budget) {
BODY
}
workflow(ARGS, agent, parallel, null, phase, log, null).then(result => process.stdout.write(JSON.stringify({ result, asked, logs, workers, most })))
"""


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class BeltLanesTest(Base):
    """The belt workflow against the real run.py and build station: one build-lanes step, one builder per lane at once with
    exactly what the station printed, batches inside the step, a builder that died handed back, then the join."""

    def belt(self, extra_env=None):
        helper = Path(self.tmp.name) / "lane_builder.py"
        helper.write_text(LANE_BUILDER)
        script = (ROOT / "workflows" / "belt.js").read_text(encoding="utf-8").replace("export const meta", "const meta", 1)
        config = [sys.executable, str(ROOT / "skills" / "run" / "scripts" / "run.py"), str(self.project), str(helper), str(ROOT), HOLDER]
        program = (BELT_HARNESS.replace("CONFIG", json.dumps(config)).replace("EXTRA_ENV", json.dumps(extra_env or {}))
                   .replace("ARGS", json.dumps({"tickets": [TICKET], "until": "verify"})).replace("BODY", script))
        done = subprocess.run(["node", "-e", program], capture_output=True, text=True, timeout=600)
        self.assertEqual(done.returncode, 0, done.stderr[-3000:])
        return json.loads(done.stdout)

    def lane_starts(self, got):
        return [w for w in got["workers"] if w["prompt"].startswith("Build lane ")]

    def test_two_lanes_through_the_belt(self):
        self.ready_lanes()
        got = self.belt()
        (ticket,) = got["result"]["tickets"]
        self.assertEqual((ticket["outcome"], ticket["waiting_for"]), ("stopped", "a person: stopped before verify, as asked"), got["logs"])
        self.assertEqual(ticket["stations"], ["build", "build-lanes", "build"])
        lanes = self.lane_starts(got)
        self.assertEqual([w["label"] for w in lanes], [f"{TICKET}: lane L1", f"{TICKET}: lane L2"])
        self.assertEqual({(w["agentType"], w["model"]) for w in lanes}, {("mach:builder", "sonnet")})
        cell = lanes_fixture.build.Cell(self.project, TICKET)
        for w, name in zip(lanes, ("L1", "L2")):
            self.assertEqual(w["prompt"], lanes_fixture.build.lane_prompt(cell, name, self.lane_work(name), HOLDER), "exactly as lanes-open printed it")
        self.assertEqual(got["most"], 2, "both lane builders were at work at once")
        self.assertIn(f"lanes-start {TICKET} --holder {HOLDER}", got["asked"])
        self.assertIn(f"lanes-join {TICKET} --holder {HOLDER}", got["asked"])
        self.assertTrue(any("2 lane builders at work at once (L1: T01, T02; L2: T03, T04)" in line for line in got["logs"]), got["logs"])
        self.assertTrue(any("lanes joined: 4 task commit(s) landed" in line for line in got["logs"]), got["logs"])
        self.assertEqual(json.loads((self.cellroot / "cell.json").read_text())["stage"], "built")
        self.assertEqual([subject.split(" ")[1] for subject in self.log()[:5]], ["T05", "T04", "T03", "T02", "T01"], "one commit per task, in plan order")

    def test_a_lane_whose_builder_gets_nowhere_is_handed_back_and_the_ticket_goes_on(self):
        self.ready_lanes()
        got = self.belt({"MACH_TEST_STALL_LANE": "L2"})
        (ticket,) = got["result"]["tickets"]
        self.assertEqual((ticket["outcome"], ticket["stations"]), ("stopped", ["build", "build-lanes", "build"]), got["logs"])
        self.assertEqual([w["label"].split(": ")[1] for w in self.lane_starts(got)], ["lane L1", "lane L2", "lane L2"])
        self.assertIn(f'lanes-hand-back {TICKET} --lane L2 --reason "its builder stopped twice without finishing another task" --holder {HOLDER}', got["asked"])
        state = self.state()
        self.assertEqual([lane["status"] for lane in state["lanes"]["lanes"]], ["joined", "handed-back"])
        self.assertEqual(json.loads((self.cellroot / "cell.json").read_text())["stage"], "built", "the cell's builder built L2's tasks after the join")
        self.assertIn("lane-handed-back", [d["type"] for d in state["deviations"]])

    def test_batches_and_a_builder_that_died_stay_inside_one_step(self):
        self.ready_lanes(plan=FIVE_LANES, settings={"factory": {"max_builders": 2}})
        got = self.belt({"MACH_TEST_STOP_LANE": "L1"})
        (ticket,) = got["result"]["tickets"]
        self.assertEqual(ticket["outcome"], "stopped", got["logs"])
        self.assertEqual(ticket["stations"], ["build", "build-lanes", "build"], "one build-lanes step, however many batches")
        self.assertEqual([w["label"].split(": ")[1] for w in self.lane_starts(got)], ["lane L1", "lane L2", "lane L1", "lane L3", "lane L4", "lane L5"])
        self.assertEqual(got["most"], 2, "never more builders than the free places")
        starts = [line for line in got["asked"] if line.startswith("lanes-start")]
        self.assertEqual(len(starts), 4, "L1 and L2; L1 handed back with L3; L4 and L5; then none left")
        self.assertEqual(json.loads((self.cellroot / "cell.json").read_text())["stage"], "built")


if __name__ == "__main__":
    unittest.main()
