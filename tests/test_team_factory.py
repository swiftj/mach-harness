"""Teams (M20 A1, A5): several engineers' Factories, each on their own computer and clone, taking slices from one GitHub repository.

Began as the team audit's reproductions; each now states what a team needs and passes. Builds on test_mach_product_intake: the
engineer's clone `eng` is one Factory; `eng2` is a second clone of the same shared repository, set up the same way, standing in
for a second engineer's computer. Both reach the one GitHub stand-in (the same issues, labels and comments), as two machines
would. Unless a test says otherwise both are signed in to gh as the same account: one engineer with two machines is still two
Factories, told apart by the random value each keeps in .factory/local/.
"""

import io
import json
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from test_mach_product_intake import Base as IntakeBase  # noqa: E402
from test_mach_product_issues import ADDRESS, git  # noqa: E402
import class_template  # noqa: E402
import issue_rules  # noqa: E402
import run  # noqa: E402

CLAIMED = "The MACH Factory is taking"
WITHDRAWN = "Withdrawn: this MACH Factory is not building"


class TwoFactories(IntakeBase):
    def setUp(self):
        super().setUp()
        self.eng2 = self.root / "eng2"
        class_template.step(self, "second factory", self.root, self.second_factory)

    def second_factory(self):
        """A second engineer's clone, set up as a Factory exactly like the first; files only."""
        self.clone("eng2", "Finn Engineer")
        git(self.eng2, "remote", "set-url", "origin", ADDRESS)
        git(self.eng2, "config", f"url.{self.origin}.insteadOf", ADDRESS)
        (self.eng2 / ".factory").mkdir()
        (self.eng2 / ".factory/config.json").write_text(json.dumps({"tickets": {"provider": "local"}, "factory": {"max_parallel": 3}}))

    def product2(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.eng2), "product", *argv])
        self.assertEqual(code, 0, err.getvalue() + out.getvalue())
        return json.loads(out.getvalue())

    def ledger2(self):
        return json.loads((self.eng2 / ".factory/intake/ledger.json").read_text())

    def building_comments(self, number):
        return [body for body in self.comments_on(number) if body.startswith("The MACH Factory has started building")]

    def claim_comments(self, number):
        return [c for c in self.gh()["issues"][str(number)]["comments"] if c["body"].startswith(CLAIMED)]

    def cell_on(self, name, number):
        return (self.root / name / ".factory/worktrees" / str(number) / "cell.json").is_file()

    def token(self, clone, slice_id="SLICE-001"):
        """The claim token of the Factory in `clone` (its value is made on its first intake)."""
        secret = json.loads((clone / ".factory/local/factory.json").read_text())["factory_id"]
        return issue_rules.claim_token(secret, slice_id)

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
    def test_a_factory_that_reads_after_the_other_took_it_leaves_it_alone(self):
        """Once one Factory has dispatched and replaced mach:ready with mach:building, another Factory's intake no longer lists the issue."""
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.labels_of(number), ["mach:building", "mach:slice"])
        taken = self.product2("intake")
        self.assertEqual(taken["created"], [])
        self.assertFalse((self.eng2 / ".factory/worktrees").exists())

    def test_two_factories_that_read_before_either_dispatched_build_it_once(self):
        """Both Factories read the issue while it is mach:ready (a `pull` or a supervisor pass reads, then dispatches). The first
        claims it and dispatches. The second reads the issue's comments again just before opening a cell, sees the earlier claim,
        posts nothing, opens no cell and no branch, and says who took it. (The audit's reproduction asserted only the empty ticket
        list; the plain report, the ledger record and the single claim are checked as well.)"""
        number = self.ready("SLICE-001", self.epic())
        self.product2("intake")  # the second Factory's read
        self.product("intake")
        first = self.product("dispatch", "SLICE-001")
        self.assertEqual(first["tickets"], [str(number)])
        second = self.product2("dispatch", "SLICE-001")
        built_on = [name for name in ("eng", "eng2") if self.cell_on(name, number)]
        self.assertEqual(second["tickets"], [], f"the slice is being built on {built_on}; comments saying so: {len(self.building_comments(number))}")
        self.assertEqual(built_on, ["eng"])
        self.assertNotIn(f"feature/{number}", git(self.eng2, "branch", "--list"))
        [refused] = second["refused"]
        self.assertRegex(refused["why"][0], r"^Another Factory took SLICE-001 \(claimed by @erin-eng at 2026-11-17 \d\d:\d\d UTC\)\. Nothing was started here\.$")
        entry = self.ledger2()["slices"]["SLICE-001"]
        self.assertEqual((entry["claim_lost"]["by"], entry["available"], entry["dispatched_at"]), ("erin-eng", False, None))
        self.assertEqual(len(self.claim_comments(number)), 1)  # the second Factory posted nothing
        self.assertEqual(len(self.building_comments(number)), 1)
        # Its plan says so, and pull would not try again.
        rows = {row["slice_id"]: row for row in self.product2("plan")["slices"]}
        self.assertFalse(rows["SLICE-001"]["dispatchable"])
        self.assertIn("Another Factory took SLICE-001", " ".join(rows["SLICE-001"]["reasons"]))

    def test_a_slice_changed_while_one_factory_builds_it_is_left_to_that_factory(self):
        """The product manager reopens a slice one Factory is building and marks revision 2 ready. The issue carries mach:building and
        mach:ready together. The building Factory holds revision 2 for a person; every other Factory leaves the issue alone, and says why."""
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        # Product Studio: reopen (mach:ready off), then ready again as revision 2 (body, approval, mach:ready on).
        state = self.gh()
        self.label(state, state["issues"][str(number)], "mach:ready", kind="unlabeled")
        self.write_state(state)
        self.ready("SLICE-001", epic, revision=2, number=number, extra="\nA clarification.\n")
        self.assertEqual(self.labels_of(number), ["mach:building", "mach:ready", "mach:slice"])
        held = self.product("intake")
        self.assertEqual([item["slice_id"] for item in held["needs_person"]], ["SLICE-001"])  # the first Factory waits for a person
        taken = self.product2("intake")
        self.assertEqual(taken["created"], [])
        [refused] = [item for item in taken["not_accepted"] if item["issue"] == number]
        self.assertRegex(refused["reason"], r"^Not accepted here: SLICE-001 is being built by another Factory \(claimed by @erin-eng at .+ UTC\)\.$")
        second = self.product2("dispatch", "SLICE-001")
        self.assertEqual(second["tickets"], [], "a second Factory dispatched revision 2 while the first is building revision 1")
        self.assertFalse(self.cell_on("eng2", number))


class ClaimTest(TwoFactories):
    def test_a_later_claim_is_withdrawn_and_the_earliest_holds(self):
        """Both Factories posted a claim (each read the comments before the other's claim was there). GitHub's comment order decides:
        the later one withdraws its own claim by editing it, so it never counts again, and the earlier one goes on without posting twice."""
        number = self.ready("SLICE-001", self.epic())
        self.product2("intake")
        self.product("intake")
        self.post_claim(number, "erin-eng", self.token(self.eng))  # the first Factory's claim, posted first
        late = self.post_claim(number, "erin-eng", self.token(self.eng2))  # the second's, a moment later
        second = self.product2("dispatch", "SLICE-001")
        self.assertEqual(second["tickets"], [])
        self.assertIn("Another Factory took SLICE-001 (claimed by @erin-eng", second["refused"][0]["why"][0])
        withdrawn = next(c for c in self.gh()["issues"][str(number)]["comments"] if c.get("cid") == late)
        self.assertTrue(withdrawn["body"].startswith(WITHDRAWN + " SLICE-001 revision 1. Another Factory claimed it first."), withdrawn["body"])
        first = self.product("dispatch", "SLICE-001")
        self.assertEqual(first["tickets"], [str(number)])
        self.assertEqual(len(self.claim_comments(number)), 1)  # its own earlier claim counts as its own: nothing posted again
        self.assertEqual(self.ledger()["slices"]["SLICE-001"]["claim"]["comment_id"], late - 1)

    def test_a_claim_by_an_account_without_write_access_blocks_nobody(self):
        """Only a claim whose author has the triage role or above counts: the rule mach:ready uses."""
        number = self.ready("SLICE-001", self.epic())
        state = self.gh()
        state["accounts"]["rae-reader"] = {"id": 3009, "role": "read"}
        self.write_state(state)
        self.post_claim(number, "rae-reader", "0123456789abcdef")
        taken = self.product("intake")
        self.assertEqual([item["slice_id"] for item in taken["created"]], ["SLICE-001"])
        done = self.product("dispatch", "SLICE-001")
        self.assertEqual(done["tickets"], [str(number)])
        self.assertEqual([c["login"] for c in self.claim_comments(number)], ["rae-reader", "erin-eng"])

    def test_github_unreachable_at_claim_time_starts_nothing(self):
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.gh_fails("api comments")
        done = self.product("dispatch", "SLICE-001")
        self.assertEqual(done["tickets"], [])
        self.assertIn("GitHub could not be reached to claim SLICE-001", done["refused"][0]["why"][0])
        self.assertIn("nothing was made", done["refused"][0]["why"][0])
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        self.assertEqual(git(self.eng, "branch", "--list").split(), ["*", "main"])
        self.assertEqual(self.claim_comments(number), [])
        self.assertEqual(self.labels_of(number), ["mach:ready", "mach:slice"])
        self.assertEqual(self.product("dispatch", "SLICE-001")["tickets"], [str(number)])  # once GitHub answers

    def test_a_claim_whose_answer_was_lost_is_this_factorys_own_next_time(self):
        """The claim reached GitHub, and the answer did not come back. Nothing is started; the next dispatch finds the claim by its
        token and goes on, without posting a second one."""
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.lose("issue comment")
        done = self.product("dispatch", "SLICE-001")
        self.assertEqual(done["tickets"], [])
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        self.assertEqual(len(self.claim_comments(number)), 1)
        self.assertEqual(self.product("dispatch", "SLICE-001")["tickets"], [str(number)])
        self.assertEqual(len(self.claim_comments(number)), 1)

    def test_the_claim_holds_while_the_building_label_waits_in_the_outbox(self):
        """The first Factory's mach:building write failed and waits to be retried, so the issue still carries only mach:ready. The claim
        comment is the claim: another Factory does not take the slice in, and says who holds it."""
        number = self.ready("SLICE-001", self.epic())
        self.product("intake")
        self.gh_fails("issue edit labels", once=False)
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.labels_of(number), ["mach:ready", "mach:slice"])
        self.assertEqual(len(self.claim_comments(number)), 1)
        taken = self.product2("intake")
        self.assertEqual(taken["created"], [])
        [refused] = [item for item in taken["not_accepted"] if item["issue"] == number]
        self.assertIn("is being built by another Factory (claimed by @erin-eng", refused["reason"])

    def test_two_engineers_signed_in_as_different_accounts(self):
        number = self.ready("SLICE-001", self.epic())
        self.product2("intake")
        self.product("intake")
        self.set_gh(me="ada-pm")  # the second machine's account: any account with write access
        self.product2("dispatch", "SLICE-001")
        self.set_gh(me="erin-eng")
        done = self.product("dispatch", "SLICE-001")
        self.assertEqual(done["tickets"], [])
        self.assertIn("(claimed by @ada-pm at", done["refused"][0]["why"][0])
        self.assertEqual([self.cell_on("eng", number), self.cell_on("eng2", number)], [False, True])

    def test_stopped_work_withdraws_its_claim_and_a_person_can_release_the_slice(self):
        """Work abandoned on the machine that claimed it withdraws its claim. A person then removes mach:building on GitHub and the
        product manager marks the slice ready again: another Factory takes it and claims it afresh."""
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.clean_up(str(number), outcome="abandoned")
        self.product("intake")
        [claim] = [c for c in self.gh()["issues"][str(number)]["comments"] if "mach:claim" in c["body"]]
        self.assertTrue(claim["body"].startswith(WITHDRAWN + " SLICE-001 revision 1. Its work there was stopped."), claim["body"])
        self.assertEqual(self.claim_comments(number), [])
        # Still mach:building, so nobody else takes it until a person says so.
        self.assertEqual(self.product2("intake")["created"], [])
        state = self.gh()
        self.label(state, state["issues"][str(number)], "mach:building", by="erin-eng", kind="unlabeled")
        self.write_state(state)
        self.ready("SLICE-001", epic, number=number)
        self.assertEqual([item["slice_id"] for item in self.product2("intake")["created"]], ["SLICE-001"])
        self.assertEqual(self.product2("dispatch", "SLICE-001")["tickets"], [str(number)])
        self.assertEqual(len(self.claim_comments(number)), 1)

    def test_a_reissue_on_the_same_machine_claims_again(self):
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.clean_up(str(number), outcome="abandoned")
        self.product("intake")
        self.assertEqual(self.claim_comments(number), [])
        self.product("intake", "--reissue", "SLICE-001")
        self.assertEqual(self.product("dispatch", "SLICE-001")["tickets"], [str(number)])
        self.assertEqual(len(self.claim_comments(number)), 1)
        self.assertEqual(self.product("intake")["not_accepted"], [])

    def test_a_supervisor_dispatches_through_the_same_claim(self):
        """supervisor.py's schedule() dispatches through Factory.dispatch with by='supervisor' and an authorization; the claim is
        in dispatch itself, so an unattended Factory that read the issue before another Factory took it does not build it."""
        number = self.ready("SLICE-001", self.epic())
        self.product2("intake")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        _, line = run.factory(run.Project(self.eng2))
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(out):
            done = line.dispatch(["SLICE-001"], by="supervisor", authorize=lambda plan: (True, "the test's authorization"))
        self.assertEqual(done["tickets"], [])
        self.assertIn("Another Factory took SLICE-001", done["refused"][0]["why"][0])
        self.assertFalse(self.cell_on("eng2", number))


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
        rows = {row["slice_id"]: row for row in self.product2("plan")["slices"]}
        self.assertTrue(rows["SLICE-002"]["dispatchable"], f"SLICE-002 on the second machine: {rows['SLICE-002']['state']}: {rows['SLICE-002']['reasons']}")
        self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-001"]["dispatchable"]), ("completed", False))
        self.assertIn("Another Factory built it", rows["SLICE-001"]["reasons"][0])
        self.product2("intake")  # records it; writes nothing to the issue the other Factory owns
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
        # Revision 2 of SLICE-001 is marked ready before the second machine first reads it.
        state = self.gh()
        self.label(state, state["issues"][str(first)], "mach:building", by="erin-eng", kind="unlabeled")
        self.write_state(state)
        self.ready("SLICE-001", epic, revision=2, number=first, extra="\nA clarification.\n")
        self.product2("intake")
        rows = {row["slice_id"]: row for row in self.product2("plan")["slices"]}
        self.assertNotEqual(rows["SLICE-001"]["state"], "completed")
        self.assertFalse(rows["SLICE-002"]["dispatchable"])


if __name__ == "__main__":
    unittest.main()
