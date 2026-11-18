"""Tests for Factory product intake and the dependency scheduler (run.py product ...), M11.

Product Studio hands a slice over as a GitHub issue marked ready, or as a ready folder. The issue
tests build slice and epic issues exactly as Product Studio writes them (issue_rules' templates),
in the stand-in for gh from test_mach_product_issues, which keeps issues, labels with their
events, comments with their times, accounts with their roles, and sub-issues. The folder tests
commit product/ready/SLICE-NNN/ to the shared repository. Nothing reaches the network.
"""

import io
import json
import subprocess
import sys
import tarfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "run" / "scripts"))
import intake  # noqa: E402
import run  # noqa: E402
from test_mach_product_issues import REPO, IssuesBase, git, intent_for, spec_for  # noqa: E402
import adr_baseline_fixture  # noqa: E402
import issue_rules  # noqa: E402

TICKET = ROOT / "skills" / "ticket" / "scripts" / "ticket.py"
EVENT_KEYS = {"schema_version", "seq", "at", "type", "source_commit", "epic_id", "issue", "slice_id", "revision", "ticket_id",
              "runner_id", "execution_id", "source", "cause", "refs", "data"}


class Base(IssuesBase):
    def setUp(self):
        super().setUp()
        # The engineer's clone is the Factory. Execution state is git-ignored there, as in a real install.
        (self.eng / ".gitignore").write_text(".factory/\n__pycache__/\n")
        (self.eng / ".factory").mkdir()
        (self.eng / ".factory/config.json").write_text(json.dumps({"tickets": {"provider": "local"}, "factory": {"max_parallel": 3}}))
        adr_baseline_fixture.write(self.eng)
        git(self.eng, "add", ".gitignore", adr_baseline_fixture.FILE)
        git(self.eng, "commit", "-q", "-m", "ignore execution state")
        git(self.eng, "push", "-q", "origin", "main")
        git(self.a, "pull", "-q", "--ff-only")
        self.set_gh(me="erin-eng")  # the account gh is signed in as on the Factory's machine
        self.folders = {}

    # ---- the Factory's commands ----

    def run_product(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run.main(["--project", str(self.eng), "product", *argv])
        return code, out.getvalue(), err.getvalue()

    def product(self, *argv):
        code, out, err = self.run_product(*argv)
        self.assertEqual(code, 0, err + out)
        return json.loads(out)

    def refused(self, *argv):
        code, out, err = self.run_product(*argv)
        self.assertEqual(code, 1, out)
        return err + out

    def plan(self):
        plan = self.product("plan")
        return plan, {row["slice_id"]: row for row in plan["slices"]}

    def events(self, since=0):
        return self.product("events", "--since", str(since))["events"]

    def tickets(self):
        folder = self.eng / ".factory/tickets"
        return sorted(p.stem for p in folder.glob("*.md")) if folder.is_dir() else []

    def ticket_text(self, ticket_id):
        return (self.eng / ".factory/tickets" / f"{ticket_id}.md").read_text()

    def ledger(self):
        return json.loads((self.eng / ".factory/intake/ledger.json").read_text())

    def cell(self, ticket_id):
        return json.loads((self.eng / ".factory/worktrees" / ticket_id / "cell.json").read_text())

    def set_cell(self, ticket_id, **changes):
        path = self.eng / ".factory/worktrees" / ticket_id / "cell.json"
        data = json.loads(path.read_text())
        data.update(changes)
        path.write_text(json.dumps(data))

    def checkout(self):
        return (subprocess.run(["git", "status", "--porcelain"], cwd=str(self.eng), capture_output=True, text=True).stdout, git(self.eng, "rev-parse", "HEAD"))

    # ---- slices as GitHub issues, as Product Studio writes them ----

    def write_state(self, state):
        self.gh_state.write_text(json.dumps(state))

    def tick(self, state):
        state["clock"] = state.get("clock", 0) + 1
        return "2026-11-17T%02d:%02d:%02dZ" % (10 + state["clock"] // 3600, (state["clock"] // 60) % 60, state["clock"] % 60)

    def new_issue(self, state, title, body, labels):
        number = state.get("next_number", 1)
        state["next_number"] = number + 1
        for name in labels:
            if name not in state["labels"]:
                state["labels"].append(name)
        state["issues"][str(number)] = {"number": number, "id": 9000 + number, "title": title, "body": body, "state": "OPEN",
                                        "labels": [{"name": name} for name in labels], "comments": [], "events": [], "sub_issues": [],
                                        "author": {"login": "ada-pm"}, "updatedAt": self.tick(state)}
        return state["issues"][str(number)]

    def label(self, state, issue, name, by="ada-pm", kind="labeled", user_type="User", app=False):
        account = state["accounts"].get(by, {"id": 7777})
        if kind == "labeled" and name not in [l["name"] for l in issue["labels"]]:
            issue["labels"].append({"name": name})
        if kind == "unlabeled":
            issue["labels"] = [l for l in issue["labels"] if l["name"] != name]
        issue["events"].append({"event": kind, "label": name, "login": by, "id": account["id"], "type": user_type, "app": app, "at": self.tick(state)})
        issue["updatedAt"] = issue["events"][-1]["at"]

    def epic(self, epic_id="EPIC-001", title="Team membership"):
        state = self.gh()
        issue = self.new_issue(state, title, issue_rules.epic_issue_body(epic_id, ["Only invited people can join"]), ["mach:epic"])
        self.write_state(state)
        return issue["number"]

    def ready(self, slice_id, epic=None, depends=(), revision=1, by="ada-pm", extra="", follows=None, title="Invite a teammate", number=None):
        """Product Studio's `slice ready`: the issue (made or replaced whole), the approval comment, then mach:ready."""
        epic = epic or self.epic_number()
        state = self.gh()
        why, spec = intent_for(slice_id), spec_for(slice_id, extra=extra)
        body = issue_rules.slice_issue_body(slice_id, revision, epic, list(depends), why, spec, follows=follows)
        if number is None:
            issue = self.new_issue(state, title, body, ["mach:slice"])
            self.label(state, issue, "mach:slice", by=by)
            state["issues"][str(epic)]["sub_issues"].append(issue["id"])
        else:
            issue = state["issues"][str(number)]
            issue["body"] = body
        at = self.tick(state)
        account = state["accounts"].get(by, {"id": 7777})
        issue["comments"].append({"login": by, "id": account["id"], "body": issue_rules.approval_comment(slice_id, revision, by, issue_rules.text_sha256_of(spec),
                                                                                                         issue_rules.text_sha256_of(why)),
                                  "created_at": at, "updated_at": at})
        self.label(state, issue, "mach:ready", by=by)
        self.write_state(state)
        return issue["number"]

    def epic_number(self):
        epics = [i for i in self.gh()["issues"].values() if "mach:epic" in [l["name"] for l in i["labels"]]]
        return epics[0]["number"] if epics else self.epic()

    def change(self, number, **changes):
        state = self.gh()
        state["issues"][str(number)].update(changes)
        state["issues"][str(number)]["updatedAt"] = self.tick(state)
        self.write_state(state)

    def labels_of(self, number):
        return sorted(l["name"] for l in self.gh()["issues"][str(number)]["labels"])

    def comments_on(self, number):
        return [c["body"] for c in self.gh()["issues"][str(number)]["comments"]]

    def gh_calls(self, since=0):
        return self.gh()["calls"][since:]

    # ---- slices as ready folders on the integration branch ----

    def slice(self, project, title, depends=(), revision=1, extra=""):
        """A slice Product Studio wrote to a ready folder (not yet committed). Returns its ID."""
        slice_id = f"SLICE-{len(self.folders) + 1:03d}"
        self.folders[slice_id] = self.folder(slice_id, title, depends, revision, extra)
        return slice_id

    def folder(self, slice_id, title, depends=(), revision=1, extra=""):
        spec, why = spec_for(slice_id, extra=extra), intent_for(slice_id)
        record = {"schema_version": 1, "slice_id": slice_id, "title": title, "revision": revision,
                  "epic": {"epic_id": "EPIC-001", "title": "Team membership"}, "dependencies": list(depends),
                  "spec_sha256": issue_rules.text_sha256_of(spec), "why_sha256": issue_rules.text_sha256_of(why)}
        return {"slice.json": json.dumps(record, indent=2, sort_keys=True) + "\n", "spec.md": spec, "why.md": why}

    def publish(self, project, *slice_ids):
        """The product manager commits the ready folders to the shared repository; the engineer's checkout is brought up to date."""
        git(self.eng, "push", "-q", "origin", "main")  # what the engineer merged is on the shared branch
        git(self.a, "pull", "-q", "--ff-only")
        for slice_id in slice_ids:
            target = self.a / "product/ready" / slice_id
            target.mkdir(parents=True, exist_ok=True)
            for name, text in self.folders[slice_id].items():
                (target / name).write_text(text)
        git(self.a, "add", "-A")
        git(self.a, "commit", "-q", "-m", f"ready {' '.join(slice_ids)}")
        git(self.a, "push", "-q", "origin", "main")
        git(self.eng, "pull", "-q", "--ff-only")

    def first(self):
        """SLICE-001 is in a ready folder on the shared main branch, and the engineer's main has it."""
        self.publish(self.a, self.slice(self.a, "Invite a teammate"))

    def chain(self):
        """SLICE-001; SLICE-002 needs 001; SLICE-003 needs 002. Taken in."""
        self.first()
        second = self.slice(self.a, "Second", depends=["SLICE-001"])
        third = self.slice(self.a, "Third", depends=[second])
        self.publish(self.a, second, third)
        self.product("intake")

    def revise(self, slice_id="SLICE-001"):
        """Product changes a slice: a new revision of its folder."""
        record = json.loads(self.folders[slice_id]["slice.json"])
        self.folders[slice_id] = self.folder(slice_id, record["title"], record["dependencies"], record["revision"] + 1, extra="\nRevised by product.\n")
        self.publish(self.a, slice_id)

    # ---- the line, standing in for the stations ----

    def integrate(self, ticket_id, cleanup=False):
        """The line finishes a ticket for real: its branch is merged into the integration branch."""
        repo = self.eng / ".factory/worktrees" / ticket_id / "repo"
        (repo / f"t{ticket_id.lower()}.py").write_text("print('built')\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"build {ticket_id}")
        landed = git(repo, "rev-parse", "HEAD").strip()
        git(self.eng, "merge", "-q", "--no-ff", "-m", f"Merge feature/{ticket_id}", f"feature/{ticket_id}")
        merge_commit = git(self.eng, "rev-parse", "HEAD").strip()
        self.set_cell(ticket_id, stage="merged", merged={"commit": merge_commit, "landed_commit": landed, "method": "local"})
        if cleanup:
            self.clean_up(ticket_id)
        return landed

    def clean_up(self, ticket_id, outcome="merged"):
        """What the cleanup station leaves: an archive holding cell.json, a run record, and no cell."""
        archive = self.eng / ".factory/archive"
        archive.mkdir(exist_ok=True)
        cell_file = self.eng / ".factory/worktrees" / ticket_id / "cell.json"
        name, number = archive / f"{ticket_id}.tar.gz", 1
        while name.exists():
            name, number = archive / f"{ticket_id}-{number}.tar.gz", number + 1
        with tarfile.open(str(name), "w:gz") as tar:
            tar.add(str(cell_file), arcname=f"{ticket_id}/cell.json")
        with (archive / "runs.jsonl").open("a") as handle:
            handle.write(json.dumps({"ticket_id": ticket_id, "outcome": outcome, "archive": str(name.relative_to(self.eng))}) + "\n")
        git(self.eng, "worktree", "remove", "--force", str(cell_file.parent / "repo"))
        git(self.eng, "branch", "-D", f"feature/{ticket_id}")
        for path in sorted(cell_file.parent.rglob("*"), reverse=True):
            path.unlink() if path.is_file() or path.is_symlink() else path.rmdir()
        cell_file.parent.rmdir()


class IssueIntakeTest(Base):
    def test_a_ready_issue_is_taken_in_as_its_own_ticket(self):
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        before = self.checkout()
        status = self.product("status")
        self.assertEqual([(s["slice_id"], s["issue"], s["status"]) for s in status["slices"]], [("SLICE-001", number, "new")])
        self.assertEqual(status["not_accepted"], [])
        preview = self.product("intake", "--dry-run")
        self.assertEqual(preview["created"], [{"slice_id": "SLICE-001", "revision": 1, "issue": number, "ticket_id": str(number)}])
        self.assertFalse((self.eng / ".factory/intake").exists())  # looking changes nothing
        calls = len(self.gh()["calls"])
        taken = self.product("intake")
        self.assertEqual(taken["created"], [{"slice_id": "SLICE-001", "revision": 1, "issue": number, "ticket_id": str(number), "adopted": False}])
        self.assertIs(taken["factory_started"], False)
        self.assertEqual(self.tickets(), [])  # the issue is the ticket: nothing is filed
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertEqual((entry["ticket_id"], entry["issue"], entry["repository"], entry["source"], entry["revision"], entry["approved_by"]),
                         (str(number), number, REPO, "github", 1, "ada-pm"))
        self.assertEqual(entry["epic"], {"epic_id": "EPIC-001", "issue": epic, "title": "Team membership"})
        self.assertIn(f"github:{REPO}#{number}@r1", self.ledger()["intakes"])
        received = self.eng / entry["stored"]
        self.assertEqual((received / "spec.md").read_text(), spec_for("SLICE-001"))
        self.assertEqual([e["type"] for e in self.events()], ["intake.validated", "slice.materialized", "dependency.resolved"])
        # Nothing else: no cell, no branch, no change to the checkout, no write to GitHub.
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        self.assertEqual(git(self.eng, "branch", "--list").split(), ["*", "main"])
        self.assertEqual(self.checkout(), before)
        made = self.gh_calls(calls)
        self.assertEqual([c for c in made if c[0] != "api" and c[:2] not in (["repo", "view"], ["issue", "list"])], [])
        # The exact reads, all in the origin remote's repository.
        shapes = sorted({" ".join(c[:2]) if c[0] != "api" else "api " + next(a for a in c if a.startswith("repos/")).split("?")[0].replace(f"repos/{REPO}/", "")
                         for c in made})
        self.assertEqual(shapes, sorted({"repo view", "issue list", f"api issues/{number}", f"api issues/{number}/events", f"api issues/{number}/comments",
                                         "api collaborators/ada-pm/permission", f"api issues/{epic}", f"api issues/{epic}/sub_issues"}))
        listing = next(c for c in made if c[:2] == ["issue", "list"])
        self.assertEqual(listing, ["issue", "list", "--repo", REPO, "--label", "mach:ready", "--state", "open", "--limit", "200", "--json", "number,labels,updatedAt"])
        for call in made:
            self.assertTrue(f"repos/{REPO}/" in " ".join(call) or REPO in call or call[:2] == ["repo", "view"], call)

    def test_repeated_intake_takes_nothing_twice_and_does_not_check_an_unchanged_issue_again(self):
        self.ready("SLICE-001")
        self.product("intake")
        ledger, events, calls = self.ledger(), self.events(), len(self.gh()["calls"])
        for _ in range(3):
            again = self.product("intake")
            self.assertEqual((again["created"], again["updated"], again["unchanged"]), ([], [], ["SLICE-001"]))
        self.assertEqual(self.events(), events)
        after = self.ledger()
        after["source"]["at"] = ledger["source"]["at"]
        self.assertEqual({key: value for key, value in after.items() if key != "checked"}, {key: value for key, value in ledger.items() if key != "checked"})
        self.assertFalse([c for c in self.gh_calls(calls) if any("/events" in a for a in c)])  # unchanged since it was checked: not checked again

    def test_several_issues_and_an_issue_number_names_the_ticket(self):
        epic = self.epic()
        first, second = self.ready("SLICE-001", epic), self.ready("SLICE-002", epic)
        taken = self.product("intake")
        self.assertEqual([(c["slice_id"], c["ticket_id"]) for c in taken["created"]], [("SLICE-001", str(first)), ("SLICE-002", str(second))])
        self.assertEqual(self.plan()[0]["dispatchable"], ["SLICE-001", "SLICE-002"])
        step = run.next_step(run.Project(self.eng), str(second), False)
        self.assertEqual((step["action"], step["needs"]), ("stop", "dispatch"))  # handed over by Product Studio: never groomed again
        self.assertIn("product dispatch SLICE-002", step["reason"])

    def test_studio_slice_ready_is_accepted_by_the_factory(self):
        """End to end: what Product Studio's own `slice ready` writes passes every check of the Factory."""
        self.set_gh(me="ada-pm")
        self.project_and_epic()
        self.drafted()
        number = self.ok(self.a, "slice", "ready", "SLICE-001")["issue"]
        self.set_gh(me="erin-eng")
        taken = self.product("intake")
        self.assertEqual([(c["slice_id"], c["ticket_id"]) for c in taken["created"]], [("SLICE-001", str(number))])
        self.assertEqual(taken["not_accepted"], [])


class AcceptanceTest(Base):
    """Design section 4: only an issue that passes every check is taken in; anything else is listed with its reason."""

    def not_accepted(self, number):
        taken = self.product("intake")
        self.assertEqual(taken["created"], [])
        found = [item for item in taken["not_accepted"] if item.get("issue") == number]
        self.assertEqual(len(found), 1, taken["not_accepted"])
        self.assertNotIn("SLICE-001", self.ledger()["slices"])
        return found[0]["reason"]

    def test_a_body_edited_after_approval(self):
        number = self.ready("SLICE-001")
        self.change(number, body=self.gh()["issues"][str(number)]["body"].replace("An admin", "Anyone"))
        self.assertIn("its body was changed after it was approved", self.not_accepted(number))

    def test_marked_ready_by_an_account_without_the_role(self):
        state = self.gh()
        state["accounts"]["rae-reader"] = {"id": 3009, "role": "read"}
        self.write_state(state)
        number = self.ready("SLICE-001", by="rae-reader")
        self.assertIn("without the triage, write, maintain or admin role", self.not_accepted(number))

    def test_the_triage_role_counts(self):
        state = self.gh()
        state["accounts"]["tess-triage"] = {"id": 3010, "role": "triage"}
        self.write_state(state)
        self.ready("SLICE-001", by="tess-triage")
        self.assertEqual(len(self.product("intake")["created"]), 1)

    def test_marked_ready_by_an_automated_account(self):
        number = self.ready("SLICE-001")
        state = self.gh()
        issue = state["issues"][str(number)]
        self.label(state, issue, "mach:ready", kind="unlabeled")
        self.label(state, issue, "mach:ready", by="ada-pm", user_type="Bot")
        self.write_state(state)
        self.assertIn("automated account", self.not_accepted(number))

    def test_the_last_ready_label_decides_who_marked_it(self):
        number = self.ready("SLICE-001")
        state = self.gh()
        state["accounts"]["ben-pm"] = {"id": 3002, "role": "write"}
        issue = state["issues"][str(number)]
        self.label(state, issue, "mach:ready", kind="unlabeled")
        self.label(state, issue, "mach:ready", by="ben-pm")  # Ben marked it ready again, but the approval is Ada's
        self.write_state(state)
        self.assertIn("no approval comment for this revision by the account that marked it ready", self.not_accepted(number))

    def test_an_edited_approval_comment(self):
        number = self.ready("SLICE-001")
        state = self.gh()
        state["issues"][str(number)]["comments"][0]["updated_at"] = "2026-11-18T09:00:00Z"
        state["issues"][str(number)]["updatedAt"] = "2026-11-18T09:00:00Z"
        self.write_state(state)
        self.assertIn("the approval comment was edited after it was written", self.not_accepted(number))

    def test_an_approval_of_other_text(self):
        number = self.ready("SLICE-001")
        state = self.gh()
        comment = state["issues"][str(number)]["comments"][0]
        comment["body"] = issue_rules.approval_comment("SLICE-001", 1, "ada-pm", "0" * 64, "1" * 64)
        state["issues"][str(number)]["updatedAt"] = self.tick(state)
        self.write_state(state)
        self.assertIn("no approval comment for this revision", self.not_accepted(number))

    def test_a_spec_that_fails_the_intent_gates(self):
        epic = self.epic()
        state = self.gh()
        why, spec = intent_for("SLICE-001"), spec_for("SLICE-001").replace("## Invariants", "## Invariant notes")
        issue = self.new_issue(state, "Broken", issue_rules.slice_issue_body("SLICE-001", 1, epic, [], why, spec), ["mach:slice"])
        issue["comments"].append({"login": "ada-pm", "id": 3001, "body": issue_rules.approval_comment("SLICE-001", 1, "ada-pm", issue_rules.text_sha256_of(spec),
                                                                                                      issue_rules.text_sha256_of(why)),
                                  "created_at": "2026-11-17T09:00:00Z", "updated_at": "2026-11-17T09:00:00Z"})
        self.label(state, issue, "mach:ready")
        self.write_state(state)
        self.assertIn("does not pass the intent station's gates", self.not_accepted(issue["number"]))

    def test_an_epic_not_written_by_product_studio(self):
        state = self.gh()
        epic = self.new_issue(state, "Somebody's epic", "Just text", ["mach:epic"])
        self.write_state(state)
        number = self.ready("SLICE-001", epic["number"])
        self.assertIn(f"its epic issue #{epic['number']} is not an epic written by MACH Product Studio", self.not_accepted(number))

    def test_each_refusal_is_said_once_and_a_good_slice_still_goes_in(self):
        epic = self.epic()
        bad = self.ready("SLICE-001", epic)
        self.change(bad, body=self.gh()["issues"][str(bad)]["body"] + "\nEdited.\n")
        good = self.ready("SLICE-002", epic)
        taken = self.product("intake")
        self.assertEqual([c["ticket_id"] for c in taken["created"]], [str(good)])
        refused = [e for e in self.events() if e["type"] == "intake.refused"]
        self.assertEqual([(e["issue"], e["slice_id"]) for e in refused], [(bad, "SLICE-001")])
        self.product("intake")
        self.assertEqual(len([e for e in self.events() if e["type"] == "intake.refused"]), 1)
        self.assertEqual(self.product("status")["not_accepted"][0]["issue"], bad)

    def test_github_out_of_reach_keeps_what_was_taken_in(self):
        number = self.ready("SLICE-001")
        self.product("intake")
        self.set_gh(fail={"*": "error connecting to api.github.com"})
        taken = self.product("intake")
        self.assertIn("GitHub could not be read (network)", " ".join(taken["notes"]))
        _, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], rows["SLICE-001"]["ticket_id"]), ("ready", str(number)))

    def test_the_slice_check_reads_only(self):
        number = self.ready("SLICE-001")
        calls = len(self.gh()["calls"])
        done = subprocess.run([sys.executable, str(TICKET), "--project", str(self.eng), "slice-check", str(number)], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        decision = json.loads(done.stdout)["decision"]
        self.assertEqual((decision["state"], decision["approved_by"], decision["spec"]), ("accepted", "ada-pm", spec_for("SLICE-001")))
        self.assertFalse([c for c in self.gh_calls(calls) if c[:2] in (["issue", "edit"], ["issue", "comment"], ["issue", "close"]) or "--method" in c])


class SchedulerTest(Base):
    def test_dependencies_by_issue_decide_what_is_ready(self):
        epic = self.epic()
        first = self.ready("SLICE-001", epic)
        self.ready("SLICE-002", epic, depends=[first])
        self.product("intake")
        plan, rows = self.plan()
        self.assertEqual(plan["dispatchable"], ["SLICE-001"])
        self.assertEqual(rows["SLICE-002"]["reasons"], [f"It waits for #{first} (SLICE-001) to be merged (now queued)."])

    def test_merging_a_dependency_unblocks_and_ships_it(self):
        epic = self.epic()
        first = self.ready("SLICE-001", epic)
        self.ready("SLICE-002", epic, depends=[first])
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.set_cell(str(first), stage="approved")
        self.assertEqual(self.plan()[1]["SLICE-002"]["state"], "blocked")  # approved is still in the line
        self.integrate(str(first), cleanup=True)
        plan, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], plan["dispatchable"]), ("completed", ["SLICE-002"]))

    def test_a_dependency_merged_before_this_factory_counts_when_its_spec_is_on_the_branch(self):
        (self.eng / "specs/slices").mkdir(parents=True)
        spec = intake.with_header(spec_for("SLICE-009"), intake.spec_header({"epic_id": "EPIC-001", "issue": 1, "title": "Old"}, 99))
        (self.eng / "specs/slices/SLICE-009-invite-a-teammate-by-email.md").write_text(spec)
        git(self.eng, "add", "-A")
        git(self.eng, "commit", "-q", "-m", "merged earlier")
        git(self.eng, "push", "-q", "origin", "main")
        epic = self.epic()
        self.ready("SLICE-001", epic, depends=[99])
        self.ready("SLICE-002", epic, depends=[98])
        self.product("intake")
        plan, rows = self.plan()
        self.assertEqual(plan["dispatchable"], ["SLICE-001"])
        self.assertEqual(rows["SLICE-001"]["depends_on"][0]["state"], "merged (its spec is on the integration branch)")
        self.assertIn("It depends on #98, which this Factory has not taken in and which is not merged.", rows["SLICE-002"]["reasons"])

    def test_the_product_managers_order_within_an_epic_then_oldest_first(self):
        one = self.epic("EPIC-001", "Membership")
        a1 = self.ready("SLICE-001", one)
        other = self.epic("EPIC-002", "Billing")
        b1 = self.ready("SLICE-002", other)
        a2 = self.ready("SLICE-003", one)
        state = self.gh()
        state["issues"][str(one)]["sub_issues"] = [9000 + a2, 9000 + a1]  # the product manager put SLICE-003 first
        state["issues"][str(one)]["updatedAt"] = self.tick(state)
        self.write_state(state)
        self.product("intake")
        plan, _ = self.plan()
        # Oldest ready first is SLICE-001, SLICE-002, SLICE-003; within EPIC-001 the product manager's order puts 003 before 001.
        self.assertEqual(plan["order"], ["SLICE-003", "SLICE-002", "SLICE-001"])
        self.assertEqual(intake.Factory.order(["SLICE-001", "SLICE-002"], {"SLICE-001": {"ready_at": "2", "epic": {"issue": 1}},
                                                                          "SLICE-002": {"ready_at": "1", "epic": {"issue": 2}}}), ["SLICE-002", "SLICE-001"])
        self.assertTrue(b1)

    def test_the_concurrency_limit(self):
        (self.eng / ".factory/config.json").write_text(json.dumps({"tickets": {"provider": "local"}, "factory": {"max_parallel": 1}}))
        epic = self.epic()
        first = self.ready("SLICE-001", epic)
        self.ready("SLICE-002", epic)
        self.product("intake")
        plan, rows = self.plan()
        self.assertEqual((plan["dispatchable"], plan["waiting_for_a_place"]), (["SLICE-001"], ["SLICE-002"]))
        self.product("dispatch", "--ready")
        plan, rows = self.plan()
        self.assertEqual((plan["dispatchable"], plan["limits"]["active"]), ([], 1))
        self.assertIn("waiting for a free place: 1 of 1", rows["SLICE-002"]["reasons"][-1])
        self.assertTrue((self.eng / ".factory/worktrees" / str(first)).is_dir())

    def test_a_cycle_is_found(self):
        epic = self.epic()
        state = self.gh()
        state["next_number"] = state["next_number"]  # the next two issues are numbered n and n + 1
        self.write_state(state)
        n = state["next_number"]
        self.ready("SLICE-001", epic, depends=[n + 1])
        self.ready("SLICE-002", epic, depends=[n])
        self.product("intake")
        plan, rows = self.plan()
        self.assertEqual(plan["cycles"], [["SLICE-001", "SLICE-002", "SLICE-001"]])
        self.assertEqual(plan["dispatchable"], [])


class DispatchTest(Base):
    def test_dispatch_opens_the_cell_from_the_issue_and_starts_nothing(self):
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        before = self.checkout()
        sent = self.product("dispatch", str(number))  # named by its issue number
        ticket = str(number)
        self.assertEqual((sent["tickets"], sent["factory_started"]), ([ticket], False))
        cell = self.cell(ticket)
        self.assertEqual((cell["stage"], cell["branch"], cell["slice_id"], cell["risk"]), ("spec-ready", f"feature/{ticket}", "SLICE-001", "High"))
        self.assertEqual(cell["product"]["issue"], {"repository": REPO, "number": number})
        self.assertEqual((cell["product"]["epic_id"], cell["product"]["epic_issue"], cell["product"]["source"]), ("EPIC-001", epic, "github"))
        # The spec is committed on the ticket's branch with its header, and is otherwise the approved text.
        name = "specs/slices/SLICE-001-invite-a-teammate-by-email.md"
        committed = git(self.eng, "show", f"feature/{ticket}:{name}")
        self.assertIn(f"\n> Epic: Team membership (EPIC-001, issue #{epic}). Slice issue: #{number}.\n", committed)
        self.assertEqual(intake.without_header(committed)[0], spec_for("SLICE-001"))
        intent = (self.eng / ".factory/worktrees" / ticket / "intent.md").read_text()
        self.assertIn(f"- **Ticket:** {ticket} (github)", intent)
        self.assertIn("approved by ada-pm", intent)
        # Status on the issue: building, and ready taken off; one comment from the fixed template.
        self.assertEqual(self.labels_of(number), ["mach:building", "mach:slice"])
        self.assertEqual(len(self.comments_on(number)), 2)
        self.assertTrue(self.comments_on(number)[-1].startswith("The MACH Factory has started building SLICE-001 revision 1."))
        self.assertEqual(self.checkout(), before)
        self.assertEqual(git(self.eng, "branch", "--show-current").strip(), "main")
        step = run.next_step(run.Project(self.eng), ticket, True)
        self.assertEqual(step["action"], "plan")  # the line takes it from here, with every gate

    def test_dispatch_is_idempotent_and_a_product_tier_of_low_is_raised(self):
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        state = self.gh()
        issue = state["issues"][str(number)]
        why = intent_for("SLICE-001").replace("- **Tier:** High", "- **Tier:** Low")
        spec = spec_for("SLICE-001")
        issue["body"] = issue_rules.slice_issue_body("SLICE-001", 1, epic, [], why, spec)
        issue["comments"][0]["body"] = issue_rules.approval_comment("SLICE-001", 1, "ada-pm", issue_rules.text_sha256_of(spec), issue_rules.text_sha256_of(why))
        issue["updatedAt"] = self.tick(state)
        self.write_state(state)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.cell(str(number))["risk"], "Medium")
        again = self.product("dispatch", "SLICE-001")
        self.assertEqual(again["dispatched"][0]["already_dispatched"], True)
        self.assertEqual(len(self.comments_on(number)), 2)  # the building comment is not made twice

    def test_only_ready_slices_and_only_when_asked(self):
        epic = self.epic()
        first = self.ready("SLICE-001", epic)
        self.ready("SLICE-002", epic, depends=[first])
        self.product("reconcile")
        self.assertFalse((self.eng / ".factory/worktrees").exists())  # nothing dispatches without being asked
        sent = self.product("dispatch", "SLICE-002")
        self.assertEqual((sent["tickets"], sent["refused"][0]["state"]), ([], "blocked"))
        self.assertIn("Not in the intake ledger", " ".join(self.product("dispatch", "SLICE-404")["refused"][0]["why"]).replace("It is not", "Not"))

    def test_a_received_copy_that_changed_is_never_used(self):
        number = self.ready("SLICE-001")
        self.product("intake")
        stored = self.eng / self.ledger()["slices"]["SLICE-001"]["stored"]
        (stored / "spec.md").write_text(spec_for("SLICE-001") + "\nSlipped in.\n")
        self.assertIn("no longer matches what was approved", self.refused("dispatch", "SLICE-001"))
        self.assertFalse((self.eng / ".factory/worktrees" / str(number)).exists())


class StatusTest(Base):
    def test_a_status_write_is_recorded_before_it_is_tried_and_retried(self):
        number = self.ready("SLICE-001")
        self.product("intake")
        self.set_gh(fail={"issue edit labels": "error connecting to api.github.com"})
        sent = self.product("dispatch", "SLICE-001")
        self.assertEqual(sent["issue_status"], {"pending": 1})
        (write,) = self.ledger()["status"].values()
        self.assertEqual((write["moment"], write["state"], write["kind"], write["attempts"]), ("building", "pending", "network", 1))
        self.assertTrue(self.cell(str(number)))  # the line was not held up
        self.set_gh(fail={})
        self.product("intake")
        self.assertEqual([w["state"] for w in self.ledger()["status"].values()], ["done"])
        self.assertIn("mach:building", self.labels_of(number))

    def test_shipped_closes_the_issue_once_the_merge_is_on_the_branch(self):
        number = self.ready("SLICE-001")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.set_cell(str(number), stage="approved")
        self.product("intake")
        self.assertEqual(self.gh()["issues"][str(number)]["state"], "OPEN")  # approved is not shipped
        self.integrate(str(number))
        self.product("intake")
        self.assertEqual((self.gh()["issues"][str(number)]["state"], self.labels_of(number)), ("CLOSED", ["mach:shipped", "mach:slice"]))
        self.assertTrue(self.comments_on(number)[-1].startswith("SLICE-001 revision 1 is merged into the integration branch."))
        self.product("intake")
        self.assertEqual(len(self.comments_on(number)), 3)  # once

    def test_status_comments_off_stops_comments_not_labels(self):
        (self.eng / ".factory/config.json").write_text(json.dumps({"tickets": {"provider": "local", "github": {"status_comments": False}}}))
        number = self.ready("SLICE-001")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.assertEqual((self.labels_of(number), len(self.comments_on(number))), (["mach:building", "mach:slice"], 1))

    def test_a_blocked_cell_is_said_on_its_issue(self):
        number = self.ready("SLICE-001")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.set_cell(str(number), stage="blocked")
        self.product("intake")
        self.assertTrue(self.comments_on(number)[-1].startswith("Work on SLICE-001 revision 1 is blocked and waits for an engineer."))

    def test_the_builders_question_and_the_product_managers_answer(self):
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        asked = subprocess.run([sys.executable, str(ROOT / "skills/intent/scripts/cell.py"), "--project", str(self.eng), "spec-question", str(number),
                                "--question", "FR-02 and INV-01 disagree about seats for @ben-pm, see #12; password=hunter2. Which wins?"],
                               capture_output=True, text=True)
        self.assertEqual(asked.returncode, 0, asked.stderr)
        step = run.next_step(run.Project(self.eng), str(number), True)
        self.assertEqual((step["action"], step["needs"]), ("stop", "product-answer"))
        self.product("intake")
        self.assertIn("mach:question", self.labels_of(number))
        question = self.comments_on(number)[-1]
        self.assertTrue(question.startswith("The builders need the product manager's answer before SLICE-001 revision 1 can be planned."))
        self.assertIn("> FR-02 and INV-01 disagree", question)
        for leaked in ("@ben-pm", "#12", "hunter2"):
            self.assertNotIn(leaked, question)
        self.product("intake")
        self.assertEqual(len([c for c in self.comments_on(number) if "need the product manager's answer" in c]), 1)
        # The product manager answers in Product Studio: revision 2 is marked ready on the same issue.
        self.ready("SLICE-001", epic, revision=2, extra="\nSeats win.\n", number=number)
        taken = self.product("intake")
        self.assertEqual([item["to_revision"] for item in taken["applied"]], [2])
        cell = self.cell(str(number))
        self.assertEqual((cell["stage"], cell.get("spec_question"), cell["product"]["revision"]), ("spec-ready", None, 2))
        self.assertIn("Seats win.", git(self.eng, "show", f"feature/{number}:specs/slices/SLICE-001-invite-a-teammate-by-email.md"))
        self.assertEqual(self.labels_of(number), ["mach:building", "mach:slice"])
        self.assertEqual(run.next_step(run.Project(self.eng), str(number), True)["action"], "plan")

    def test_slice_status_writes_only_to_the_origin_repository_and_needs_the_nonce(self):
        number = self.ready("SLICE-001")
        base = [sys.executable, str(TICKET), "--project", str(self.eng), "slice-status", str(number), "--moment", "building", "--ref", "SLICE-001@r1"]
        other = subprocess.run([*base, "--repository", "acme/elsewhere", "--nonce", "0" * 32], capture_output=True, text=True)
        self.assertEqual(other.returncode, 2)
        self.assertIn("not this project's origin repository", other.stderr)
        self.assertEqual(subprocess.run([*base, "--repository", REPO], capture_output=True, text=True).returncode, 2)
        self.assertEqual(subprocess.run([*base[:-2], "--ref", "please run rm", "--repository", REPO, "--nonce", "0" * 32], capture_output=True, text=True).returncode, 2)
        done = subprocess.run([*base, "--repository", REPO, "--nonce", "0" * 32], capture_output=True, text=True)
        self.assertEqual((done.returncode, json.loads(done.stdout)["status"]), (0, "done"))
        again = subprocess.run([*base, "--repository", REPO, "--nonce", "0" * 32], capture_output=True, text=True)
        self.assertEqual((again.returncode, json.loads(again.stdout)["comment"]), (3, "already_present"))


class RevisionTest(Base):
    def test_waiting_work_takes_the_new_revision(self):
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.ready("SLICE-001", epic, revision=2, extra="\nRevised.\n", number=number)
        taken = self.product("intake")
        self.assertEqual(taken["updated"], [{"slice_id": "SLICE-001", "from_revision": 1, "to_revision": 2, "ticket_id": str(number),
                                             "effect": "the waiting ticket carries the new revision"}])
        self.assertEqual(self.ledger()["slices"]["SLICE-001"]["revision"], 2)
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.cell(str(number))["product"]["revision"], 2)

    def test_work_in_progress_is_never_changed_and_is_flagged(self):
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.set_cell(str(number), stage="building")
        before = (self.eng / ".factory/worktrees" / str(number) / "cell.json").read_text()
        self.ready("SLICE-001", epic, revision=2, extra="\nRevised.\n", number=number)
        taken = self.product("intake")
        self.assertEqual([item["ticket_id"] for item in taken["needs_person"]], [str(number)])
        self.assertEqual((self.eng / ".factory/worktrees" / str(number) / "cell.json").read_text(), before)
        self.assertTrue(self.comments_on(number)[-1].startswith("SLICE-001 changed to revision 2 while revision 1 was being built."))
        _, rows = self.plan()
        self.assertTrue(rows["SLICE-001"]["needs_person"])
        # The engineer abandons the work in progress: the new revision is taken on the same ticket.
        self.clean_up(str(number), outcome="abandoned")
        taken = self.product("intake")
        self.assertEqual(taken["updated"][0]["to_revision"], 2)
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertEqual((entry["ticket_id"], entry["revision"], entry["history"][-1]["outcome"]), (str(number), 2, "abandoned"))
        self.assertEqual(self.plan()[1]["SLICE-001"]["state"], "ready")

    def test_a_shipped_slice_changed_is_a_new_issue_and_new_work(self):
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.integrate(str(number), cleanup=True)
        self.product("intake")
        self.assertEqual(self.gh()["issues"][str(number)]["state"], "CLOSED")
        follow = self.ready("SLICE-001", epic, revision=2, extra="\nVersion two.\n", follows=number)
        taken = self.product("intake")
        self.assertEqual((taken["updated"][0]["ticket_id"], taken["updated"][0]["effect"]), (str(follow), "new work after shipping"))
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertEqual((entry["ticket_id"], entry["issue"], entry["follows"], entry["depends"]), (str(follow), follow, number, []))
        self.assertEqual(entry["history"][-1]["ticket_id"], str(number))
        self.assertEqual(self.plan()[0]["dispatchable"], ["SLICE-001"])

    def test_a_slice_taken_back_by_the_product_manager_waits(self):
        epic = self.epic()
        number = self.ready("SLICE-001", epic)
        self.product("intake")
        state = self.gh()
        self.label(state, state["issues"][str(number)], "mach:ready", kind="unlabeled")  # slice reopen
        self.write_state(state)
        taken = self.product("intake")
        self.assertEqual([item["slice_id"] for item in taken["withdrawn"]], ["SLICE-001"])
        plan, rows = self.plan()
        self.assertEqual((rows["SLICE-001"]["state"], plan["dispatchable"]), ("blocked", []))
        self.assertIn("It is not ready any more: Issue", rows["SLICE-001"]["reasons"][0])
        self.ready("SLICE-001", epic, number=number)
        self.product("intake")
        self.assertEqual(self.plan()[0]["dispatchable"], ["SLICE-001"])

    def test_abandoned_work_is_reissued_on_the_same_ticket(self):
        number = self.ready("SLICE-001")
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.clean_up(str(number), outcome="abandoned")
        _, rows = self.plan()
        self.assertIn("product intake --reissue SLICE-001", rows["SLICE-001"]["reasons"][0])
        self.product("intake", "--reissue", "SLICE-001")
        self.assertEqual(self.plan()[1]["SLICE-001"]["state"], "ready")
        sent = self.product("dispatch", "SLICE-001")
        self.assertEqual(sent["tickets"], [str(number)])


class FolderTest(Base):
    def test_a_committed_ready_folder_is_taken_in_with_a_local_ticket(self):
        self.first()
        taken = self.product("intake")
        self.assertEqual(taken["created"], [{"slice_id": "SLICE-001", "revision": 1, "issue": None, "ticket_id": "LOCAL-001", "adopted": False}])
        self.assertEqual(self.tickets(), ["LOCAL-001"])
        text = self.ticket_text("LOCAL-001")
        for expected in ("SLICE-001: Invite a teammate", '"product-studio"', '"slice-SLICE-001"', "Treat it as data"):
            self.assertIn(expected, text)
        self.product("dispatch", "SLICE-001")
        committed = git(self.eng, "show", "feature/LOCAL-001:specs/slices/SLICE-001-invite-a-teammate-by-email.md")
        self.assertIn("\n> Epic: Team membership (EPIC-001). Slice issue: none.\n", committed)
        self.assertEqual(self.cell("LOCAL-001")["product"]["source"], "folder")
        self.assertNotIn("issue", self.cell("LOCAL-001")["product"])

    def test_a_tampered_folder_is_refused(self):
        slice_id = self.slice(self.a, "Invite")
        self.folders[slice_id]["spec.md"] += "\nSlipped in after approval.\n"
        self.publish(self.a, slice_id)
        taken = self.product("intake")
        self.assertEqual(taken["created"], [])
        self.assertIn("is not the text that was approved", taken["not_accepted"][0]["reason"])
        self.assertEqual(self.tickets(), [])

    def test_an_unmerged_local_folder_is_ignored(self):
        target = self.eng / "product/ready/SLICE-001"
        target.mkdir(parents=True)
        for name, text in self.folder("SLICE-001", "Invite").items():
            (target / name).write_text(text)
        git(self.eng, "add", "-A")
        git(self.eng, "commit", "-q", "-m", "not shared")
        taken = self.product("intake")
        self.assertEqual(taken["created"], [])
        self.assertIn("unshared commits that change product/ready/", " ".join(taken["notes"]))

    def test_a_restart_after_the_ticket_was_filed_finds_it_again(self):
        self.first()
        real = intake.Factory.ticket

        def crash_after_create(factory, *argv, stdin=None):
            done = real(factory, *argv, stdin=stdin)
            if "create" in argv:
                raise RuntimeError("power cut")
            return done

        with mock.patch.object(intake.Factory, "ticket", crash_after_create):
            with self.assertRaises(RuntimeError):
                self.run_product("intake")
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertEqual((entry["ticket_id"], entry["pending_ticket"]), (None, True))  # the intention was on record first
        resumed = self.product("intake")
        self.assertEqual(resumed["created"], [{"slice_id": "SLICE-001", "revision": 1, "issue": None, "ticket_id": "LOCAL-001", "adopted": True}])
        self.assertEqual(self.tickets(), ["LOCAL-001"])
        self.assertEqual([e["type"] for e in self.events()].count("slice.materialized"), 1)

    def test_import_takes_a_handed_over_folder_in_once(self):
        folder = self.root / "handed-over" / "SLICE-001"
        folder.mkdir(parents=True)
        for name, text in self.folder("SLICE-001", "Invite").items():
            (folder / name).write_text(text)
        imported = self.product("import", str(folder))
        self.assertEqual([c["ticket_id"] for c in imported["created"]], ["LOCAL-001"])
        self.assertEqual(self.ledger()["slices"]["SLICE-001"]["source"], "import")
        self.assertEqual(self.product("import", str(folder))["unchanged"], ["SLICE-001"])
        self.assertEqual(self.tickets(), ["LOCAL-001"])
        (folder / "why.md").write_text("changed\n")
        self.assertIn("It was not imported", self.refused("import", str(folder)))
        (folder / "extra.txt").write_text("x")
        self.assertIn("exactly slice.json, spec.md and why.md", self.refused("import", str(folder)))

    def test_import_is_an_engineers_act(self):
        folder = self.root / "handed-over" / "SLICE-001"
        folder.mkdir(parents=True)
        for name, text in self.folder("SLICE-001", "Invite").items():
            (folder / name).write_text(text)
        with mock.patch.dict("os.environ", {"MACH_EXECUTION_ID": "x000000000001"}):
            self.assertIn("a supervised execution", self.refused("import", str(folder)) + " ")

    def test_product_studios_folder_is_imported(self):
        """End to end: Product Studio's `slice ready` without gh writes the folder the Factory imports."""
        import os
        (self.root / "bin" / "gh").unlink()
        os.environ["PATH"] = os.pathsep.join(p for p in os.environ["PATH"].split(os.pathsep) if not (Path(p) / "gh").exists())
        self.project_and_epic()
        self.drafted()
        result = self.ok(self.a, "slice", "ready", "SLICE-001")
        imported = self.product("import", result["folder"])
        self.assertEqual([c["slice_id"] for c in imported["created"]], ["SLICE-001"])


class SupervisorReadinessTest(Base):
    """One reconcile step, one guarded way into the line, one writer at a time."""

    def line(self):
        return run.factory(run.Project(self.eng))[1]

    def test_reconcile_is_intake_and_a_recorded_plan_and_never_dispatches(self):
        self.first()
        second = self.slice(self.a, "Second", depends=["SLICE-001"])
        third = self.slice(self.a, "Third", depends=[second])
        self.publish(self.a, second, third)
        first = self.product("reconcile")
        self.assertEqual([c["slice_id"] for c in first["intake"]["created"]], ["SLICE-001", "SLICE-002", "SLICE-003"])
        self.assertEqual((first["plan"]["dispatchable"], first["factory_started"]), (["SLICE-001"], False))
        self.assertEqual(first["last_event"], len(self.events()))
        seq = first["last_event"]
        again = self.product("reconcile")
        self.assertEqual((again["intake"]["created"], again["last_event"]), ([], seq))
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        self.assertFalse((self.eng / ".factory/intake/lock").exists())

    def test_the_plan_lists_what_a_driver_would_run(self):
        self.chain()
        self.assertEqual(self.plan()[0]["runnable"], [])
        self.product("dispatch", "SLICE-001")
        self.assertEqual(self.plan()[0]["runnable"], [{"slice_id": "SLICE-001", "ticket_id": "LOCAL-001", "next": "plan"}])
        self.set_cell("LOCAL-001", stage="awaiting-human")
        plan, _ = self.plan()
        self.assertEqual((plan["runnable"], plan["needs_person"]), ([], ["SLICE-001"]))

    def test_only_an_engineer_dispatches_without_authorization(self):
        self.chain()
        line = self.line()
        with self.assertRaises(intake.IntakeError) as refused:
            line.dispatch(["SLICE-001"], by="supervisor")
        self.assertIn("brought no authorization", str(refused.exception))
        seen = []

        def paused(plan):
            seen.append(plan["dispatchable"])
            return False, "the Factory is paused"

        with self.assertRaises(intake.IntakeError) as refused:
            line.dispatch(["SLICE-001"], by="supervisor", authorize=paused)
        self.assertIn("not authorized: the Factory is paused", str(refused.exception))
        with self.assertRaises(intake.IntakeError):
            line.dispatch(["SLICE-001"], by="supervisor", authorize=lambda plan: ("yes", "truthy is not True"))
        self.assertEqual(seen, [["SLICE-001"]])
        self.assertFalse((self.eng / ".factory/worktrees").exists())
        done = line.dispatch(["SLICE-001"], by="supervisor", authorize=lambda plan: (True, "enabled; supervised; preflight passed"))
        self.assertEqual((done["tickets"], done["factory_started"]), (["LOCAL-001"], False))
        scheduled = [e for e in self.events() if e["type"] == "work.scheduled"][0]
        self.assertEqual((scheduled["data"]["by"], scheduled["data"]["authorization"]), ("supervisor", "enabled; supervised; preflight passed"))

    def test_one_writer_at_a_time(self):
        self.chain()
        lock = self.eng / ".factory/intake/lock"
        import os
        held = {"pid": os.getpid(), "host": intake.platform.node(), "at": intake.now(), "purpose": "dispatch"}
        lock.write_text(json.dumps(held))
        for argv in (("intake",), ("reconcile",), ("dispatch", "SLICE-001")):
            self.assertIn("Another dispatch is running on this Factory", self.refused(*argv))
        self.product("plan")
        self.product("status")
        self.product("intake", "--dry-run")
        self.assertEqual(json.loads(lock.read_text()), held)

    def test_a_lock_left_by_a_dead_process_is_taken_over(self):
        self.chain()
        lock = self.eng / ".factory/intake/lock"
        gone = subprocess.Popen([sys.executable, "-c", "pass"])
        gone.wait()
        lock.write_text(json.dumps({"pid": gone.pid, "host": intake.platform.node(), "at": intake.now(), "purpose": "intake"}))
        self.assertEqual(self.product("dispatch", "SLICE-001")["tickets"], ["LOCAL-001"])
        self.assertFalse(lock.exists())

    def test_a_lock_on_another_machine_is_respected_until_it_is_old(self):
        self.chain()
        lock = self.eng / ".factory/intake/lock"
        lock.write_text(json.dumps({"pid": 1, "host": "another-machine", "at": intake.now(), "purpose": "reconcile"}))
        self.assertIn("another-machine", self.refused("intake"))
        lock.write_text(json.dumps({"pid": 1, "host": "another-machine", "at": "2026-01-01T00:00:00Z", "purpose": "reconcile"}))
        self.product("intake")
        lock.write_text("not json")
        self.product("intake")
        self.assertFalse(lock.exists())

    def test_the_lock_is_released_when_a_step_fails(self):
        self.first()
        with mock.patch.object(intake.Factory, "materialize", side_effect=RuntimeError("power cut")):
            with self.assertRaises(RuntimeError):
                self.run_product("intake")
        self.assertFalse((self.eng / ".factory/intake/lock").exists())
        self.product("intake")

    def test_events_survive_a_crash_between_the_ledger_and_the_log(self):
        self.first()
        self.product("intake")
        line = self.line()
        ledger = line.ledger()
        line.emit(ledger, "human.required", slice_id="SLICE-001", reason="test")
        intake.write_atomic(line.ledger_path, intake.canonical(ledger))
        before = len(self.events())
        line.save(line.ledger())
        line.save(line.ledger())
        events = self.events()
        self.assertEqual(len(events), before + 1)
        self.assertEqual([e["seq"] for e in events], list(range(1, len(events) + 1)))


class EventsTest(Base):
    def test_every_event_is_versioned_ordered_and_typed(self):
        epic = self.epic()
        first = self.ready("SLICE-001", epic)
        self.ready("SLICE-002", epic, depends=[first])
        self.product("intake")
        self.product("dispatch", "SLICE-001")
        self.integrate(str(first))
        self.ready("SLICE-001", epic, revision=2, extra="\nRevised.\n", number=first)
        self.product("intake")
        result = self.product("events")
        events = result["events"]
        self.assertEqual((result["schema_version"], result["event_types"]), (3, list(intake.EVENT_TYPES)))
        self.assertNotIn("wave.discovered", intake.EVENT_TYPES)
        self.assertEqual([e["seq"] for e in events], list(range(1, len(events) + 1)))
        for event in events:
            self.assertEqual(set(event), EVENT_KEYS)
            self.assertEqual(event["schema_version"], 3)
            self.assertEqual((event["runner_id"], event["source"], event["execution_id"]), (None, "intake", None))
            self.assertRegex(event["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual({e["type"] for e in events}, {"intake.validated", "slice.materialized", "dependency.resolved", "dependency.blocked",
                                                       "work.scheduled", "slice.integrated", "revision.superseded"})
        blocked = next(e for e in events if e["type"] == "dependency.blocked")
        self.assertEqual((blocked["slice_id"], blocked["epic_id"], blocked["data"]["reasons"]),
                         ("SLICE-002", "EPIC-001", [f"It waits for #{first} (SLICE-001) to be merged (now queued)."]))
        scheduled = next(e for e in events if e["type"] == "work.scheduled")
        self.assertEqual((scheduled["ticket_id"], scheduled["issue"], scheduled["data"]["by"], scheduled["data"]["stage"]), (str(first), first, "engineer", "spec-ready"))

    def test_schema_files_describe_the_events_and_the_ledger(self):
        schemas = ROOT / "docs/mach-next/schemas"
        event = json.loads((schemas / "factory-event.schema.json").read_text())
        self.assertEqual(sorted(event["required"]), sorted(EVENT_KEYS))
        self.assertEqual(event["properties"]["type"]["enum"], list(intake.EVENT_TYPES))
        self.assertEqual(event["properties"]["schema_version"], {"const": intake.EVENT_VERSION})
        ledger = json.loads((schemas / "intake-ledger.schema.json").read_text())
        self.assertEqual(ledger["properties"]["schema_version"], {"const": intake.LEDGER_VERSION})
        self.ready("SLICE-001")
        self.product("intake")
        self.assertEqual(sorted(set(self.ledger()) - {"status_nonce"}), sorted(ledger["required"]))
        entry = self.ledger()["slices"]["SLICE-001"]
        self.assertTrue(set(ledger["properties"]["slices"]["additionalProperties"]["required"]) <= set(entry))


class RulesTest(unittest.TestCase):
    def test_the_spec_header_round_trips(self):
        spec = spec_for("SLICE-007")
        header = intake.spec_header({"epic_id": "EPIC-002", "issue": 41, "title": "Billing <!-- x --> (v2)"}, 57)
        self.assertEqual(header, "> Epic: Billing -- x -- v2 (EPIC-002, issue #41). Slice issue: #57.")
        text = intake.with_header(spec, header)
        back, found = intake.without_header(text)
        self.assertEqual((back, found.group(2), found.group(3), found.group(4)), (spec, "EPIC-002", "41", "57"))
        self.assertNotIn("<!--", text)
        self.assertEqual(intake.without_header(spec), (spec, None))

    def test_status_comments_name_identifiers_only(self):
        nonce = "0" * 32
        self.assertTrue(issue_rules.comment("building", ["SLICE-007@r2"], nonce)["body"].startswith("The MACH Factory has started building SLICE-007 revision 2."))
        self.assertTrue(issue_rules.comment("changed", ["SLICE-007@r1", "SLICE-007@r2"], nonce)["body"].startswith("SLICE-007 changed to revision 2"))
        for moment, refs in (("building", ["SLICE-007"]), ("shipped", ["#4"]), ("question", ["SLICE-007@r1"])):
            with self.assertRaises(ValueError):
                issue_rules.comment(moment, refs, nonce)
        asked = issue_rules.comment("question", ["SLICE-007@r1"], nonce, question="Ask @someone about #3 and ghp_" + "a" * 36)["body"]
        self.assertNotIn("@someone", asked)
        self.assertNotIn("ghp_", asked)


if __name__ == "__main__":
    unittest.main()
