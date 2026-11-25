"""Teams (M20): several engineers' Factories, each on their own computer and clone, taking slices from one GitHub repository.

The owner's decisions of 2026-11-23: no slice belongs to anyone in advance, and a Factory's own choice does not build a slice
another Factory is building. A Factory claims a slice on its issue just before it opens a cell; the earliest claim that counts
holds it. Another Factory's own choice (pull, product dispatch --ready, the supervisor) skips it and takes the next slice nobody is
building. And the owner's rule of 2026-11-25: an engineer who names a slice (product dispatch <slice>) gets it, whoever holds it:
it is taken over with a warning, on a branch of its own, and the copies meet at the merge. As a backstop for the Factory's own
merges, the shared main takes a slice revision once.

Builds on test_mach_product_intake: the engineer's clone `eng` is one Factory; `eng2` is a second clone of the same shared
repository, set up the same way, standing in for a second engineer's computer. Both reach the one GitHub stand-in (the same
issues, labels and comments), as two machines would. Unless a test says otherwise both are signed in to gh as the same account:
one engineer with two machines is still two Factories, told apart by the random value each keeps in .factory/local/. The
stand-in's clock reads 2026-11-17, so the tests set a long quiet spell (intake.claim_stale_days) except where staleness is tested.
"""

import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from test_mach_product_intake import Base as IntakeBase  # noqa: E402
from test_mach_product_issues import ADDRESS, git  # noqa: E402
import class_template  # noqa: E402
import intake  # noqa: E402
import issue_rules  # noqa: E402
import run  # noqa: E402

CLAIMED = "The MACH Factory is taking"
WITHDRAWN = "Withdrawn: this MACH Factory is not building"
SHIPPED = "is merged into the integration branch"


class TwoFactories(IntakeBase):
    def setUp(self):
        super().setUp()
        self.eng2 = self.root / "eng2"
        class_template.step(self, "second factory", self.root, self.second_factory)
        for clone in (self.eng, self.eng2):
            self.quiet_days(clone, 365)

    def second_factory(self):
        """A second engineer's clone, set up as a Factory exactly like the first; files only."""
        self.clone("eng2", "Finn Engineer")
        git(self.eng2, "remote", "set-url", "origin", ADDRESS)
        git(self.eng2, "config", f"url.{self.origin}.insteadOf", ADDRESS)
        (self.eng2 / ".factory").mkdir()
        (self.eng2 / ".factory/config.json").write_text(json.dumps({"tickets": {"provider": "local"}, "factory": {"max_parallel": 3}}))

    def quiet_days(self, clone, days):
        path = clone / ".factory/config.json"
        data = json.loads(path.read_text())
        data["intake"] = {"claim_stale_days": days}
        path.write_text(json.dumps(data))

    def run2(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.eng2), *argv])
        return code, out.getvalue(), err.getvalue()

    def product2(self, *argv):
        code, out, err = self.run2("product", *argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def pull2(self):
        code, out, err = self.run2("pull", "--json")
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def ledger2(self):
        return json.loads((self.eng2 / ".factory/intake/ledger.json").read_text())

    def rows2(self):
        return {row["slice_id"]: row for row in self.product2("plan")["slices"]}

    def building_comments(self, number):
        return [body for body in self.comments_on(number) if body.startswith("The MACH Factory has started building")]

    def claim_comments(self, number):
        return [c for c in self.gh()["issues"][str(number)]["comments"] if c["body"].startswith(CLAIMED)]

    def cell_on(self, name, number):
        return (self.root / name / ".factory/worktrees" / str(number) / "cell.json").is_file()

    def token(self, clone, slice_id="SLICE-001"):
        """The claim token of the Factory in `clone` (its value is made when it first claims, as here)."""
        _, line = run.factory(run.Project(clone))
        return line.claim_token(slice_id)

    def post_claim(self, number, login, token, slice_id="SLICE-001", revision=1):
        """A claim comment as a Factory signed in as `login` posts it, straight into the stand-in."""
        state = self.gh()
        at = self.tick(state)
        state["next_cid"] = state.get("next_cid", 70000) + 1
        account = state["accounts"].get(login, {"id": 5555})
        issue = state["issues"][str(number)]
        issue["comments"].append({"login": login, "id": account["id"], "cid": state["next_cid"], "created_at": at, "updated_at": at,
                                  "body": issue_rules.claim_comment(slice_id, revision, token)})
        issue["updatedAt"] = at
        self.write_state(state)
        return state["next_cid"]


class SameSliceTwiceTest(TwoFactories):
    def test_a_factory_that_reads_after_the_other_started_skips_it(self):
        """One Factory dispatched (claimed, then mach:ready replaced by mach:building). Another Factory still sees the slice and
        shows who is building it; it does not build it."""
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.labels_of(number), ["mach:building", "mach:slice"])
        taken = self.product2("intake")
        self.assertEqual(taken["not_accepted"], [])
        row = self.rows2()["SLICE-001"]
        self.assertEqual((row["state"], row["dispatchable"]), ("blocked", False))
        self.assertRegex(row["being_built_elsewhere"], r"^SLICE-001 is being built by @erin-eng since 2026-11-17 \d\d:\d\d UTC\.$")
        status = {item["slice_id"]: item for item in self.product2("status")["slices"]}
        self.assertTrue(status["SLICE-001"]["being_built_elsewhere"].startswith("SLICE-001 is being built by @erin-eng"))
        self.assertEqual(self.product2("dispatch", "--ready")["tickets"], [], "the Factory's own choice skips it")
        self.assertFalse((self.eng2 / ".factory/worktrees").exists())
        # An engineer who names it gets it: taken over with a warning, on a branch of its own.
        taken = self.product2("dispatch", "SLICE-001")
        self.assertEqual((taken["tickets"], taken["refused"]), ([str(number)], []))
        self.assertTrue(taken["warnings"][0].startswith("@erin-eng's Factory has been building SLICE-001 since"), taken["warnings"])
        self.assertEqual(taken["dispatched"][0]["branch"], f"feature/{number}-erin-eng")
        cell = json.loads((self.eng2 / ".factory/worktrees" / str(number) / "cell.json").read_text())
        self.assertEqual(cell["branch"], f"feature/{number}-erin-eng")
        self.assertTrue([c for c in self.gh()["issues"][str(number)]["comments"] if c["body"].startswith("The MACH Factory is taking over SLICE-001")],
                        "the issue gets the take-over comment so the other team sees it")

    def test_two_factories_reading_at_the_same_moment_build_it_once(self):
        """Both Factories read SLICE-001 while it was free. The first claims it and dispatches. The second's dispatch reads the
        comments again just before opening a cell, sees the earlier claim, posts nothing, opens no cell and no branch, and says who
        has it. Its next pull takes the next slice nobody is building."""
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        second = self.ready("SLICE-002", epic, title="Remove a teammate")
        self.product2("intake")
        self.product("intake")
        self.assertEqual(self.product("dispatch", "SLICE-001")["tickets"], [str(number)])
        lost = self.product2("dispatch", "--ready", "--limit", "1")  # the Factory's own choice, read while it was free
        self.assertEqual(lost["tickets"], [])
        [refused] = lost["refused"]
        self.assertEqual(refused["state"], "being_built_elsewhere")
        self.assertRegex(refused["why"][0], r"^SLICE-001 is being built by @erin-eng since 2026-11-17 \d\d:\d\d UTC\. Nothing was started here\.$")
        self.assertEqual([self.cell_on("eng", number), self.cell_on("eng2", number)], [True, False])
        self.assertNotIn(f"feature/{number}", git(self.eng2, "branch", "--list"))
        self.assertEqual(len(self.claim_comments(number)), 1)  # the second Factory posted nothing
        self.assertEqual(self.ledger2()["slices"]["SLICE-001"]["claim_lost"]["by"], "erin-eng")
        report = self.pull2()
        self.assertEqual([item["slice_id"] for item in report["start_now"]], ["SLICE-002"])
        skipped = [item for item in report["waits"] if item["slice_id"] == "SLICE-001"]
        self.assertEqual([item["rule"] for item in skipped], ["being-built-elsewhere"])
        self.assertTrue(self.cell_on("eng2", second))

    def test_everything_ready_being_built_elsewhere_is_said_plainly(self):
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        report = self.pull2()
        self.assertEqual(report["start_now"], [])
        self.assertIn("Everything ready is being built by other Factories, so nothing new starts here.", report["in_words"])
        self.assertFalse(self.cell_on("eng2", number))

    def test_a_reopened_slice_stays_with_its_builder(self):
        """The product manager reopens a slice one Factory is building and marks revision 2 ready. That Factory holds revision 2 for a
        person, as before; any other Factory treats the slice as still being built by it."""
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        state = self.gh()
        self.label(state, state["issues"][str(number)], "mach:ready", kind="unlabeled")
        self.write_state(state)
        self.ready("SLICE-001", epic, revision=2, number=number, extra="\nA clarification.\n")
        self.assertEqual(self.labels_of(number), ["mach:building", "mach:ready", "mach:slice"])
        held = self.product("intake")
        self.assertEqual([item["slice_id"] for item in held["needs_person"]], ["SLICE-001"])
        self.product2("intake")
        row = self.rows2()["SLICE-001"]
        self.assertEqual((row["revision"], row["state"]), (2, "blocked"))
        self.assertIn("is being built by @erin-eng", row["being_built_elsewhere"])
        self.assertEqual(self.product2("dispatch", "--ready")["tickets"], [])
        self.assertFalse(self.cell_on("eng2", number))


class ClaimTest(TwoFactories):
    def test_a_later_claim_is_withdrawn_and_the_earliest_holds(self):
        """Both Factories posted a claim (each read the comments before the other's claim was there). GitHub's comment order decides:
        the later one withdraws its own claim by editing it, so it never counts again, and the earlier one goes on without posting twice."""
        number = self.ready("SLICE-001", self.epic())
        self.product2("intake")
        self.product("intake")
        self.post_claim(number, "erin-eng", self.token(self.eng))
        late = self.post_claim(number, "erin-eng", self.token(self.eng2))
        second = self.product2("dispatch", "--ready", "--limit", "1")
        self.assertEqual(second["tickets"], [])
        withdrawn = next(c for c in self.gh()["issues"][str(number)]["comments"] if c.get("cid") == late)
        self.assertTrue(withdrawn["body"].startswith(WITHDRAWN + " SLICE-001 revision 1. Another Factory claimed it first."), withdrawn["body"])
        first = self.product("dispatch", "--ready", "--limit", "1")
        self.assertEqual(first["tickets"], [str(number)])
        self.assertEqual(len(self.claim_comments(number)), 1)
        self.assertEqual(self.ledger()["slices"]["SLICE-001"]["claim"]["comment_id"], late - 1)

    def test_a_claim_by_an_account_without_write_access_blocks_nobody(self):
        number = self.ready("SLICE-001", self.epic())
        state = self.gh()
        state["accounts"]["rae-reader"] = {"id": 3009, "role": "read"}
        self.write_state(state)
        self.post_claim(number, "rae-reader", "0123456789abcdef")
        self.product("intake")
        self.assertEqual(self.product("dispatch", "SLICE-001")["tickets"], [str(number)])
        self.assertEqual([c["login"] for c in self.claim_comments(number)], ["rae-reader", "erin-eng"])

    def test_github_unreachable_at_claim_time_starts_nothing(self):
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.gh_fails("api comments")
        done = self.product("dispatch", "--ready")
        self.assertEqual(done["tickets"], [], "the Factory's own choice starts nothing")
        self.assertIn("GitHub could not be reached to claim SLICE-001", done["refused"][0]["why"][0])
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        self.assertEqual(git(self.eng, "branch", "--list").split(), ["*", "main"])
        self.assertEqual(self.claim_comments(number), [])
        self.gh_fails("api comments")
        named = self.product("dispatch", "SLICE-001")
        self.assertEqual(named["tickets"], [str(number)], "an engineer who names it gets it, GitHub or not")
        self.assertTrue(any("GitHub could not be reached to claim SLICE-001" in line and "MACH builds it here anyway" in line for line in named["warnings"]))

    def test_a_claim_whose_answer_was_lost_is_this_factorys_own_next_time(self):
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.lose("issue comment")
        self.assertEqual(self.product("dispatch", "--ready")["tickets"], [])
        self.assertEqual(len(self.claim_comments(number)), 1)
        self.assertEqual(self.product("dispatch", "--ready")["tickets"], [str(number)])
        self.assertEqual(len(self.claim_comments(number)), 1)

    def test_the_claim_holds_while_the_building_label_waits_in_the_outbox(self):
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.gh_fails("issue edit labels", once=False)
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.labels_of(number), ["mach:ready", "mach:slice"])
        self.product2("intake")
        self.assertIn("is being built by @erin-eng", self.rows2()["SLICE-001"]["being_built_elsewhere"])
        self.assertEqual(self.product2("dispatch", "--ready")["tickets"], [])

    def test_two_engineers_signed_in_as_different_accounts(self):
        number = self.ready("SLICE-001", self.epic())
        self.product2("intake")
        self.product("intake")
        self.set_gh(me="ada-pm")
        self.product2("dispatch", "SLICE-001")
        self.set_gh(me="erin-eng")
        done = self.product("dispatch", "--ready", "--limit", "1")
        self.assertEqual(done["tickets"], [])
        self.assertIn("is being built by @ada-pm since", done["refused"][0]["why"][0])
        self.assertEqual([self.cell_on("eng", number), self.cell_on("eng2", number)], [False, True])

    def test_stopped_work_withdraws_its_claim(self):
        """Work abandoned on the machine that claimed it withdraws its claim. With mach:building removed and the slice marked ready
        again, another Factory takes it and claims it afresh."""
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.clean_up(str(number), outcome="abandoned")
        self.product("intake")
        [claim] = [c for c in self.gh()["issues"][str(number)]["comments"] if "mach:claim" in c["body"]]
        self.assertTrue(claim["body"].startswith(WITHDRAWN + " SLICE-001 revision 1. Its work there was stopped."), claim["body"])
        state = self.gh()
        self.label(state, state["issues"][str(number)], "mach:building", by="erin-eng", kind="unlabeled")
        self.write_state(state)
        self.ready("SLICE-001", epic, number=number)
        self.product2("intake")
        self.assertEqual(self.product2("dispatch", "SLICE-001")["tickets"], [str(number)])
        self.assertEqual(len(self.claim_comments(number)), 1)

    def test_a_reissue_on_the_same_machine_claims_again(self):
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.clean_up(str(number), outcome="abandoned")
        self.product("intake")
        self.assertEqual(self.claim_comments(number), [])
        self.product("intake", "--reissue", "SLICE-001")
        self.assertEqual(self.product("dispatch", "SLICE-001")["tickets"], [str(number)])
        self.assertEqual(len(self.claim_comments(number)), 1)

    def test_a_supervisor_dispatches_through_the_same_claim(self):
        """supervisor.py's schedule() dispatches through Factory.dispatch with by='supervisor' and an authorization; the claim is in
        dispatch itself, so an unattended Factory that read the slice before another took it skips it."""
        number = self.ready("SLICE-001", self.epic())
        self.product2("intake")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        _, line = run.factory(run.Project(self.eng2))
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(out):
            done = line.dispatch(["SLICE-001"], by="supervisor", authorize=lambda plan: (True, "the test's authorization"))
        self.assertEqual(done["tickets"], [])
        self.assertEqual(done["refused"][0]["state"], "being_built_elsewhere")
        self.assertFalse(self.cell_on("eng2", number))


class ReleaseTest(TwoFactories):
    def test_a_stale_claim_is_taken_by_pull(self):
        """A claim with no activity for longer than intake.claim_stale_days holds nothing: the plan shows it as free to take and the
        next pull takes it. An open pull request from the slice's branch is mentioned."""
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.quiet_days(self.eng2, 1)  # the stand-in's clock is days behind today's
        state = self.gh()
        state["pulls"] = [{"head": f"feature/{number}", "number": 77, "url": "https://github.com/acme/team-space/pull/77", "author": {"login": "ben-pm"}}]
        self.write_state(state)
        self.product2("intake")
        row = self.rows2()["SLICE-001"]
        self.assertTrue(row["dispatchable"])
        self.assertRegex(row["being_built_elsewhere"], r"^Claimed by @erin-eng, no activity for \d+ days: free to take\.$")
        report = self.pull2()
        self.assertEqual([item["slice_id"] for item in report["start_now"]], ["SLICE-001"], report["in_words"])
        self.assertTrue(self.cell_on("eng2", number))
        notes = self.ledger2()["slices"]["SLICE-001"]["claim"]["notes"]
        self.assertTrue(any(note.startswith("Taken from @erin-eng") for note in notes), notes)
        self.assertTrue(any("open pull request for SLICE-001 already exists: #77 by @ben-pm" in note for note in notes), notes)

    def test_an_engineer_takes_a_slice_over_by_naming_it(self):
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.product2("intake")
        self.assertEqual(self.product2("dispatch", "--ready")["tickets"], [])
        self.set_gh(me="ada-pm")
        done = self.product2("dispatch", "SLICE-001")  # naming it is enough: no flag, no plan first, no second yes
        self.set_gh(me="erin-eng")
        self.assertEqual(done["tickets"], [str(number)])
        self.assertEqual(done["dispatched"][0]["branch"], f"feature/{number}-ada-pm", "both Factories' branches can be on origin at once")
        self.assertTrue(done["dispatched"][0]["notes"][0].startswith("Taken over from @erin-eng"))
        taken = [c for c in self.gh()["issues"][str(number)]["comments"] if c["body"].startswith("The MACH Factory is taking over SLICE-001 revision 1")]
        self.assertEqual([c["login"] for c in taken], ["ada-pm"])
        # Every Factory now reads the slice as the taker's: a third look from the first machine's clone of the ledger is not needed;
        # the rule itself says so.
        comments = issue_rules.issue_comments([{**c, "comment_id": c.get("cid"), "type": "User", "app": False} for c in self.gh()["issues"][str(number)]["comments"]])
        holder = issue_rules.claim_holder(issue_rules.claims(comments), "SLICE-001", 1, True, lambda login: True)
        self.assertEqual((holder["login"], holder["takeover"]), ("ada-pm", True))

    def test_a_take_over_is_never_unattended(self):
        self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.product2("intake")
        _, line = run.factory(run.Project(self.eng2))
        with self.assertRaisesRegex(Exception, "engineer's explicit word"):
            line.dispatch(["SLICE-001"], by="supervisor", authorize=lambda plan: (True, "ok"), take_over=True)
        with mock.patch.dict(os.environ, {"MACH_EXECUTION_ID": "exec-1"}):
            code, out, err = self.run2("product", "dispatch", "SLICE-001", "--take-over")
        self.assertEqual(code, 1)  # refused: inside a supervised execution nothing is taken over
        self.assertIn("execution", err + out)
        code, out, err = self.run2("product", "dispatch", "--ready", "--take-over")
        self.assertEqual(code, 1)
        self.assertFalse(self.cell_on("eng2", 1))


class ShippedOnceTest(TwoFactories):
    def test_a_copy_of_a_slice_that_already_landed_is_not_merged(self):
        """The backstop. Two copies exist (here because one engineer took the slice over); the first lands on the shared main. The
        other Factory's next step stops before its merge and says so; it writes nothing to the issue that suggests it shipped."""
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.product2("intake")
        self.product2("dispatch", "SLICE-001", "--take-over")
        self.integrate(str(number))
        git(self.eng, "push", "-q", "origin", "main")
        self.product("intake")
        self.assertEqual(self.issue(number)["state"], "CLOSED")
        self.assertEqual(len([body for body in self.comments_on(number) if SHIPPED in body]), 1)
        git(self.eng2, "fetch", "-q", "origin")
        landed = git(self.eng, "log", "--first-parent", "--diff-filter=A", "--format=%H", "main", "--", "specs/slices/").split()[-1]
        step = run.next_step(run.Project(self.eng2), str(number), True)
        self.assertEqual((step["action"], step["needs"]), ("stop", "landed-elsewhere"))
        self.assertTrue(step["reason"].startswith(f"SLICE-001 was already shipped from another Factory (merged as {landed[:12]}). This copy was not merged."),
                        step["reason"])
        self.assertNotIn("--abandon", step["reason"], "the Factory's stop never suggests abandoning")
        self.assertIn(f"A person who names this ticket (/mach {number}, or merge {number}) carries it on", step["reason"])
        calls = len(self.gh()["calls"])
        row = self.rows2()["SLICE-001"]
        self.assertEqual((row["state"], row["needs_person"], row["waiting_for"]), ("active", True, "landed-elsewhere"))
        self.product2("reconcile")
        self.assertEqual([call for call in self.gh()["calls"][calls:] if call[:2] in (["issue", "comment"], ["issue", "edit"], ["issue", "close"], ["issue", "reopen"])], [])
        self.assertEqual(len([body for body in self.comments_on(number) if SHIPPED in body]), 1)

    def test_a_newer_revision_than_the_one_that_landed_is_new_work(self):
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.integrate(str(number))
        spec = json.loads((self.eng / ".factory/worktrees" / str(number) / "cell.json").read_text())["product"]["spec_sha256"]
        sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
        import intake
        self.assertEqual(intake.already_landed(self.eng, "SLICE-001", spec, ["refs/heads/main"])["ref"], "refs/heads/main")
        self.assertIsNone(intake.already_landed(self.eng, "SLICE-001", "0" * 64, ["refs/heads/main"]))
        self.assertIsNone(intake.already_landed(self.eng, "SLICE-002", spec, ["refs/heads/main"]))


class SplitChainTest(TwoFactories):
    def test_a_slice_whose_dependency_shipped_from_another_machine_can_be_built(self):
        """The second Factory took in SLICE-001 and SLICE-002 (which depends on it) while both were ready. The first Factory built and
        merged SLICE-001. On the second machine, with the merge pulled, the plan reads SLICE-001's approved spec on the integration
        branch: SLICE-001 is done (built elsewhere, nothing written to its issue from here) and SLICE-002 can be dispatched."""
        epic = self.epic()
        first = self.ready("SLICE-001", epic)
        self.ready("SLICE-002", epic, depends=[first], title="Remove a teammate")
        self.product2("intake")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.integrate(str(first))
        git(self.eng, "push", "-q", "origin", "main")
        git(self.eng2, "pull", "-q", "--ff-only")
        self.product2("intake")
        calls = len(self.gh()["calls"])
        rows = self.rows2()
        self.assertTrue(rows["SLICE-002"]["dispatchable"], f"SLICE-002 on the second machine: {rows['SLICE-002']['state']}: {rows['SLICE-002']['reasons']}")
        self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-001"]["dispatchable"]), ("completed", False))
        self.assertIn("Another Factory built it", rows["SLICE-001"]["reasons"][0])
        self.product2("intake")
        self.assertEqual([call for call in self.gh()["calls"][calls:] if call[:2] in (["issue", "comment"], ["issue", "edit"], ["issue", "close"])], [])

    def test_a_dependency_merged_at_another_revision_still_waits(self):
        """Only the revision this Factory took in counts: an older spec of the dependency on the branch is not it."""
        epic = self.epic()
        first = self.ready("SLICE-001", epic)
        self.ready("SLICE-002", epic, depends=[first], title="Remove a teammate")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.integrate(str(first))
        git(self.eng, "push", "-q", "origin", "main")
        git(self.eng2, "pull", "-q", "--ff-only")
        state = self.gh()
        self.label(state, state["issues"][str(first)], "mach:building", by="erin-eng", kind="unlabeled")
        self.write_state(state)
        self.ready("SLICE-001", epic, revision=2, number=first, extra="\nA clarification.\n")
        self.product2("intake")
        rows = self.rows2()
        self.assertNotEqual(rows["SLICE-001"]["state"], "completed")
        self.assertFalse(rows["SLICE-002"]["dispatchable"])


class SignOfLifeTest(TwoFactories):
    """A Factory that holds a claim and whose work on the slice has really moved posts a sign of life, at most once per half the
    quiet spell, so a slow build whose branch is not on GitHub keeps its claim. Days pass here: the stand-in for GitHub and the
    Factories' clock both read this machine's clock moved on by the same amount; commits in the cell are dated in that time."""

    def setUp(self):
        super().setUp()
        state = self.gh()
        state["clock_offset"] = 0
        self.write_state(state)
        for clone in (self.eng, self.eng2):
            self.quiet_days(clone, 3)  # a sign is due once the claim's last activity is a day and a half old

    def at(self, days):
        """GitHub and both Factories `days` from now (a context manager for the Factories' clock)."""
        state = self.gh()
        state["clock_offset"] = int(days * 86400)
        self.write_state(state)
        shift = timedelta(days=days)

        class Later(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime.now(tz) + shift

        return mock.patch.object(intake, "datetime", Later)

    def work_moves(self, number, days):
        """A commit on the slice's branch in the first Factory's cell, dated `days` from now: the build moved then."""
        repo = self.eng / ".factory/worktrees" / str(number) / "repo"
        self.assertTrue(repo.is_dir())
        stamp = (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        (repo / f"progress-{days}.txt").write_text(stamp + "\n")
        env = {**os.environ, "GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp}
        for argv in (["add", "-A"], ["commit", "-q", "-m", f"work at {stamp}"]):
            subprocess.run(["git", *argv], cwd=str(repo), env=env, check=True, capture_output=True)

    def signs(self, number):
        return [c for c in self.gh()["issues"][str(number)]["comments"] if "<!-- mach:alive v1 " in c["body"]]

    def alive(self):
        return self.ledger()["slices"]["SLICE-001"]["claim"].get("alive") or {}

    def building(self):
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.assertEqual(self.product("dispatch", "SLICE-001")["tickets"], [str(number)])
        return number

    def test_a_slow_build_that_keeps_moving_keeps_its_claim(self):
        number = self.building()
        self.work_moves(number, 1.5)
        with self.at(2):
            self.product("intake")
        [first] = self.signs(number)
        self.assertEqual(first["login"], "erin-eng")
        self.assertRegex(first["body"], r"^The MACH Factory that claimed SLICE-001 revision 1 is still building it: its work last moved at "
                                        r"\d{4}-\d\d-\d\d \d\d:\d\d UTC\.\n\n<!-- mach:alive v1 slice=SLICE-001 revision=1 factory=[0-9a-f]{16} moved=")
        self.work_moves(number, 3.5)
        with self.at(4):  # more than claim_stale_days after the claim
            self.product("intake")
            self.assertEqual(len(self.signs(number)), 2)
            self.product2("intake")
            row = self.rows2()["SLICE-001"]
            self.assertFalse(row["dispatchable"])
            self.assertRegex(row["being_built_elsewhere"], r"^SLICE-001 is being built by @erin-eng since ")
            report = self.pull2()
        self.assertEqual(report["start_now"], [])
        self.assertFalse(self.cell_on("eng2", number))
        self.assertEqual(len(self.claim_comments(number)), 1)

    def test_a_build_that_has_not_moved_posts_nothing_and_goes_stale(self):
        number = self.building()
        with self.at(2):
            self.product("intake")
        with self.at(4):
            self.product("intake")
            self.assertEqual(self.signs(number), [])
            self.product2("intake")
            self.assertRegex(self.rows2()["SLICE-001"]["being_built_elsewhere"], r"^Claimed by @erin-eng, no activity for \d+ days: free to take\.$")
            report = self.pull2()
        self.assertEqual([item["slice_id"] for item in report["start_now"]], ["SLICE-001"], report["in_words"])
        self.assertTrue(self.cell_on("eng2", number))

    def test_no_sign_of_life_more_often_than_the_interval(self):
        number = self.building()
        self.work_moves(number, 1.5)
        with self.at(2):
            self.product("intake")
        checked = self.alive()["checked_at"]
        self.work_moves(number, 2.2)
        with self.at(2.5):
            self.product("intake")
            self.product("reconcile")
        self.assertEqual(len(self.signs(number)), 1)
        self.assertEqual(self.alive()["checked_at"], checked)  # no GitHub call for it: none was due
        # The ticket station refuses too, from what GitHub says: a sign was posted after --due-before.
        _, line = run.factory(run.Project(self.eng))
        with self.at(2.5):
            stamp = (datetime.now(timezone.utc) + timedelta(days=2.4)).strftime("%Y-%m-%dT%H:%M:%SZ")
            due = (datetime.now(timezone.utc) + timedelta(days=1.9)).strftime("%Y-%m-%dT%H:%M:%SZ")
            done = line.ticket("slice-alive", str(number), "--repository", "acme/team-space", "--slice", "SLICE-001", "--revision", "1",
                               "--token", line.claim_token("SLICE-001"), "--moved-at", stamp, "--due-before", due)
        answer = json.loads(done.stdout)
        self.assertEqual((done.returncode, answer["status"], answer["kind"], answer["posted"]), (0, "skipped", "not_due", False))
        self.assertEqual(len(self.signs(number)), 1)
        # Another Factory's token never posts for a claim it does not hold.
        done = line.ticket("slice-alive", str(number), "--repository", "acme/team-space", "--slice", "SLICE-001", "--revision", "1",
                           "--token", "0123456789abcdef", "--moved-at", stamp, "--due-before", stamp)
        self.assertEqual(json.loads(done.stdout)["kind"], "not_held")
        self.assertEqual(len(self.signs(number)), 1)

    def test_a_failed_post_does_not_fail_the_plan(self):
        number = self.building()
        self.work_moves(number, 1.5)
        self.gh_fails("issue comment")
        with self.at(2):
            self.product("intake")
            self.assertEqual(self.product("plan")["slices"][0]["state"], "active")
        self.assertEqual(self.signs(number), [])
        self.assertEqual(self.alive()["kind"], "network")
        self.assertTrue(self.alive()["next_at"])
        with self.at(2.01):  # within the hour: not tried again
            self.product("intake")
        self.assertEqual(self.signs(number), [])
        with self.at(2.1):
            self.product("intake")
        self.assertEqual(len(self.signs(number)), 1)
        self.assertIsNone(self.alive()["kind"])


class SignOfLifeRuleTest(unittest.TestCase):
    """What counts as a sign of life for a claim, read from the issue's comments alone."""

    TOKEN = "0123456789abcdef"

    def comment(self, body, login="erin-eng", at="2026-11-17T10:00:00Z", updated=None, cid=1):
        return {"login": login, "id": 5001, "type": "User", "app": False, "created_at": at, "updated_at": updated or at, "body": body, "comment_id": cid}

    def active_at(self, *later):
        comments = [self.comment(issue_rules.claim_comment("SLICE-001", 1, self.TOKEN)), *later]
        [claim] = issue_rules.claims(comments)
        return claim["active_at"]

    def test_only_the_exact_unedited_sign_by_the_claims_account_with_its_token_counts(self):
        sign = issue_rules.alive_comment("SLICE-001", 1, self.TOKEN, "2026-11-20T08:00:00Z")
        at = "2026-11-20T09:00:00Z"
        self.assertEqual(self.active_at(self.comment(sign, at=at, cid=2)), "2026-11-20T08:00:00Z")
        self.assertEqual(self.active_at(self.comment(sign, at=at, updated="2026-11-20T09:05:00Z", cid=2)), "2026-11-17T10:00:00Z")  # edited
        self.assertEqual(self.active_at(self.comment(sign, login="ada-pm", at=at, cid=2)), "2026-11-17T10:00:00Z")  # another account
        other = issue_rules.alive_comment("SLICE-001", 1, "fedcba9876543210", "2026-11-20T08:00:00Z")
        self.assertEqual(self.active_at(self.comment(other, at=at, cid=2)), "2026-11-17T10:00:00Z")  # another token
        self.assertEqual(self.active_at(self.comment(sign + " ", at=at, cid=2)), "2026-11-17T10:00:00Z")  # not the template
        self.assertEqual(self.active_at(self.comment(sign.replace("still building", "done building"), at=at, cid=2)), "2026-11-17T10:00:00Z")
        bot = {**self.comment(sign, at=at, cid=2), "app": True}
        self.assertEqual(self.active_at(bot), "2026-11-17T10:00:00Z")
        # A stated time later than the post itself counts only up to the post.
        ahead = issue_rules.alive_comment("SLICE-001", 1, self.TOKEN, "2026-12-30T00:00:00Z")
        self.assertEqual(self.active_at(self.comment(ahead, at=at, cid=2)), at)

    def test_the_template_takes_only_known_values(self):
        for args in (("SLICE-001", 1, self.TOKEN, "yesterday"), ("SLICE-001", 1, self.TOKEN, "2026-11-20T08:00:00Z -->"),
                     ("SLICE-001", 1, "nothex", "2026-11-20T08:00:00Z"), ("slice", 1, self.TOKEN, "2026-11-20T08:00:00Z")):
            with self.assertRaises(ValueError):
                issue_rules.alive_comment(*args)


if __name__ == "__main__":
    unittest.main()
