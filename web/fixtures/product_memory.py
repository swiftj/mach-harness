"""Fixtures for the M15 screens: what M13 and M14 added to the Product Studio engine.

Called by generate.py (python3 web/fixtures/generate.py). Each scenario drives the real engine with --app, in the same
throwaway repositories and stand-ins for gh that the engine's own tests use, and saves exactly what it printed. Nothing
here is invented: the awkward cases are made by doing the real thing (an older principle, an open policy concern, a
shipped rule replaced and retired, a PRD section no slice cites, a slice waiting for its design mocks to be committed,
a row in a Jira file that names nothing, a request filed in the idea template).
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))

from mock_pictures import jpeg, png  # noqa: E402
from test_current import EFFECTS_HEAD, make_spec  # noqa: E402
from test_mach_policy_packs import OWNER, STATEMENT_1, STATEMENT_2, concern, followed, pack_text  # noqa: E402
from test_mach_product_issues import git, spec_for  # noqa: E402
from test_mach_product_prd import ANSWERS, MAP, PRD_TEXT  # noqa: E402
from test_mach_product_principles import SECOND, STATEMENT, row, with_rows  # noqa: E402

MEMBERSHIP = ("Team membership", "EPIC-001", None)
STATEMENT_3 = "An invitation MUST NOT be kept longer than 30 days."


def generate(Scenario, out: Path) -> None:
    principles_and_policies(Scenario)
    shipped_behaviour(Scenario)
    prd_onramp(Scenario)
    jira_and_mocks(Scenario)
    idea_request(Scenario)
    # M15 clean-up: the cases the screens built by hand from other fixtures.
    principles_published(Scenario)
    principles_in_the_folder(Scenario)
    policies_awkward(Scenario)
    policies_none(Scenario)
    jira_keys_awkward(Scenario)
    four_mocks(Scenario)


def run(Scenario, body):
    s = Scenario()
    s.setUp()
    try:
        body(s)
    finally:
        s.doCleanups()


def commit_to_main(s, files, message):
    """An engineer merges files to main; the product manager's copy pulls it. Studio itself never fetches."""
    for relative, text in files.items():
        path = s.eng / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    git(s.eng, "add", "-A")
    git(s.eng, "commit", "-q", "-m", message)
    git(s.eng, "push", "-q", "origin", "main")
    git(s.a, "pull", "-q")


def spec_path(s, slice_id):
    return next((s.a / ".factory/studio/draft/specs/slices").glob(f"{slice_id}-*.md"))


# ---- principles (M13 A) and policy packs (M14 A) ----

def principles_and_policies(Scenario):
    def body(s):
        commit_to_main(s, {"policies/privacy/policy.md": pack_text()}, "privacy pack")
        os.environ.pop("MACH_EXECUTION_ID", None)
        s.project_and_epic()
        s.capture("principle.list.empty", "principle", "list")
        s.capture("principle.add", "principle", "add", "--title", "Versions stay as published", "--statement", STATEMENT,
                  "--reason", "Readers rely on what they saw.")
        s.capture("principle.add.refused-wording", "principle", "add", "--title", "Be nice", "--statement", "Invitations should be friendly.",
                  "--reason", "People like it.")
        s.ok(s.a, "principle", "add", "--title", "Senders are named", "--statement", SECOND, "--reason", "People trust a name.")
        s.capture("principle.publish", "principle", "publish")
        # A slice answers both principles (revision 1) and the privacy pack, with one concern open.
        slice_id = s.ok(s.a, "slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")["slice"]["slice_id"]
        s.write_slice(s.a, slice_id)
        path = spec_path(s, slice_id)
        text = with_rows(spec_for(slice_id), row(), row("PP-02", 1, SECOND, "Applies", "AC-01."))
        path.write_text(concern(text))
        s.capture("slice.resume.principles-policies", "slice", "resume", slice_id)
        s.capture("slice.check.open-concern", "slice", "check", slice_id, "--ready")
        s.capture("slice.show.open-concern", "slice", "show", slice_id)
        s.capture("slice.ready.refused-open-concern", "slice", "ready", slice_id)
        s.capture("policy.list", "policy", "list")
        # The principle changes after the slice answered it: the slice is answered under an older revision.
        s.capture("principle.set", "principle", "set", "PP-01", "--statement", "A published version MUST NOT be changed in place.")
        s.capture("principle.retire", "principle", "retire", "PP-02")
        s.capture("principle.list.unpublished", "principle", "list")
        s.capture("status.principles", "status")
        s.capture("policy.accept.refused", "policy", "accept", slice_id, "POL-privacy-01", "--by", "Data protection officer",
                  "--reason", "Wrong statement entirely.")
        s.capture("policy.accept", "policy", "accept", slice_id, "POL-privacy-02", "--by", "Data protection officer",
                  "--reason", "Accepted for the pilot only.")
        s.capture("slice.show.concern-accepted", "slice", "show", slice_id)
        # Ben publishes newer principles while Ada has unpublished changes: Ada chooses.
        s.project_and_epic(s.b)
        s.set_gh(me="ben-pm")
        s.ok(s.b, "refresh")
        s.ok(s.b, "principle", "add", "--title", "Seats are counted", "--statement", "A pending invitation MUST hold a seat.", "--reason", "Billing.")
        s.ok(s.b, "principle", "publish")
        s.set_gh(me="ada-pm")
        s.capture("refresh.principles-newer-elsewhere", "refresh")
        s.capture("principle.list.newer-elsewhere", "principle", "list")
        s.capture("principle.publish.refused-newer-elsewhere", "principle", "publish")
        s.capture("reconcile.principles", "reconcile", "principles", "--take", "theirs")
    run(Scenario, body)


# ---- effects on shipped behaviour (M13 B) and how an epic works today (M13 C) ----

def shipped_behaviour(Scenario):
    def body(s):
        commit_to_main(s, {
            "specs/slices/SLICE-001-invite.md": make_spec(1, "Invite by email", invs=[("INV-01", "An invitation MUST name one email address.")],
                                                          frs=[("FR-01", "The system SHALL send the invitation by email."),
                                                               ("FR-02", "The system SHALL expire an invitation after 14 days.")],
                                                          rules=[("R1", "Yes", "Sent"), ("R2", "No", "Refused")], epic=MEMBERSHIP),
            "specs/slices/SLICE-002-resend.md": make_spec(2, "Resend an invitation", frs=[("FR-01", "The system SHALL resend a pending invitation once.")],
                                                          effects_section="None.", epic=MEMBERSHIP),
            "specs/slices/SLICE-003-approval.md": make_spec(
                3, "Invite with approval", frs=[("FR-01", "The system SHALL expire an invitation after 7 days."),
                                                ("FR-02", "The system SHALL ask an owner to approve an invitation.")],
                scenarios=[("AC-01", "FR-01"), ("AC-02", "FR-02")],
                effects_section=EFFECTS_HEAD + "| SLICE-001/FR-01 | kept | AC-02 | An approved invitation is still sent by email. |\n"
                "| SLICE-001/FR-02 | replaced | FR-01 | |\n| SLICE-001/R2 | retired | | Signed-out people are sent to sign in first. |\n",
                epic=MEMBERSHIP),
        }, "three slices shipped")
        s.project_and_epic()
        s.capture("epic.current", "epic", "current", "EPIC-001", "--json")
        s.capture("epic.current.nothing-shipped", "epic", "current", "EPIC-009", "--json")
        s.capture("epic.current.refused-name", "epic", "current", "membership", "--json")
        # A draft whose effects keep a shipped rule, then a slice ships that retires that rule.
        slice_id = s.ok(s.a, "slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")["slice"]["slice_id"]
        effects = ("## Effects on shipped behaviour\n\n" + EFFECTS_HEAD
                   + "| SLICE-002/FR-01 | kept | AC-01 | A resent invitation still counts against the seats. |\n")
        s.write_slice(s.a, slice_id, extra=effects)
        s.capture("slice.resume.shipped-rules", "slice", "resume", slice_id)
        s.capture("slice.check.effects", "slice", "check", slice_id)
        s.capture("slice.show.effects", "slice", "show", slice_id)
        missing = s.ok(s.a, "slice", "new", "--epic", "EPIC-001", "--title", "Invite by link")["slice"]["slice_id"]
        s.write_slice(s.a, missing)
        path = spec_path(s, missing)
        path.write_text(path.read_text().replace("## Effects on shipped behaviour\n\nNone.\n\n", ""))
        s.capture("slice.check.effects-missing", "slice", "check", missing)
        s.capture("slice.show.effects-missing", "slice", "show", missing)
        # A section with problems: a rule that never shipped, and a kept rule with no scenario.
        broken = s.ok(s.a, "slice", "new", "--epic", "EPIC-001", "--title", "Invite again")["slice"]["slice_id"]
        s.write_slice(s.a, broken, extra="## Effects on shipped behaviour\n\n" + EFFECTS_HEAD
                      + "| SLICE-001/FR-09 | kept | AC-01 | Nothing like it shipped. |\n| SLICE-002/FR-01 | kept | | Still holds. |\n")
        s.capture("slice.show.effects-problems", "slice", "show", broken)
        commit_to_main(s, {"specs/slices/SLICE-020-no-resend.md": make_spec(
            20, "Stop resending", frs=[("FR-01", "The system SHALL show a new link instead of resending.")],
            effects_section=EFFECTS_HEAD + "| SLICE-002/FR-01 | retired | | Admins share a new link instead. |\n", epic=MEMBERSHIP)},
            "a slice that retires a rule shipped")
        s.capture("status.shipped-moved", "status")
        s.capture("refresh.shipped-moved", "refresh")
        s.capture("epic.current.after-retire", "epic", "current", "EPIC-001", "--json")
        # Two shipped slices replace the same rule (a conflict), and one names a rule that never shipped (not applied).
        commit_to_main(s, {
            "specs/slices/SLICE-021-expire-sooner.md": make_spec(
                21, "Expire sooner", frs=[("FR-01", "The system SHALL expire an invitation after 3 days.")],
                effects_section=EFFECTS_HEAD + "| SLICE-001/FR-02 | replaced | FR-01 | |\n", epic=MEMBERSHIP),
            "specs/slices/SLICE-022-reminders.md": make_spec(
                22, "Send reminders", frs=[("FR-01", "The system SHALL remind the invitee once.")],
                effects_section=EFFECTS_HEAD + "| SLICE-001/FR-09 | kept | AC-01 | Reminders never change sending. |\n", epic=MEMBERSHIP),
        }, "a conflict and effects that cannot be applied")
        s.capture("epic.current.problems", "epic", "current", "EPIC-001", "--json")
        # Specs whose shipped rules cannot be read: a file not named for a slice, and a decision matrix that cannot be parsed.
        unreadable = make_spec(23, "Invite in bulk", frs=[("FR-01", "The system SHALL invite every listed address.")],
                               rules=[("R1", "Yes", "Sent")], effects_section="None.", epic=MEMBERSHIP)
        commit_to_main(s, {
            "specs/slices/SLICE-023-bulk.md": unreadable.replace("| Rule | Signed in | Expected outcome | Side effects | Covers |", "| Rule | Outcome |"),
            "specs/slices/invite-notes.md": "# Notes on inviting\n\nNot a slice spec.\n",
        }, "specs whose rules cannot be read")
        s.capture("epic.current.unreadable", "epic", "current", "EPIC-001", "--json")
    run(Scenario, body)


# ---- the PRD on-ramp (M13 D) ----

def prd_onramp(Scenario):
    def body(s):
        s.project_and_epic()
        document = s.root / "files" / "team-space.md"
        document.parent.mkdir()
        document.write_text(PRD_TEXT, encoding="utf-8")
        (s.root / "files" / "map.json").write_text(json.dumps(MAP))
        (s.root / "files" / "answers.json").write_text(json.dumps(ANSWERS))
        (s.root / "files" / "slides.pdf").write_bytes(b"%PDF-1.4\n")
        s.capture("prd.list.empty", "prd", "list")
        s.capture("prd.import", "prd", "import", str(document))
        s.capture("prd.import.again", "prd", "import", str(document))
        s.capture("prd.import.refused-format", "prd", "import", str(s.root / "files" / "slides.pdf"))
        s.capture("prd.list", "prd", "list")
        s.capture("prd.show", "prd", "show", "PRD-01")
        s.capture("prd.show.lines", "prd", "show", "PRD-01", "--lines", "5-9")
        s.capture("prd.status.no-map", "prd", "status", "PRD-01")
        s.capture("prd.map", "prd", "map", "PRD-01", "--from", str(s.root / "files" / "map.json"))
        waiting = s.capture("prd.status.uncovered", "prd", "status", "PRD-01")["not_covered"]
        s.capture("prd.apply.refused-unsettled", "prd", "apply", "PRD-01")
        s.capture("prd.settle", "prd", "settle", "PRD-01", "--section", str(waiting[0]), "--as", "slice:M1", "--reason", "The opening belongs to inviting.")
        for section in waiting[1:-1]:
            s.ok(s.a, "prd", "settle", "PRD-01", "--section", str(section), "--as", "later", "--reason", "Not this quarter.")
        s.capture("prd.status.one-left", "prd", "status", "PRD-01")
        s.capture("prd.settle.out-of-scope", "prd", "settle", "PRD-01", "--section", str(waiting[-1]), "--as", "out-of-scope")
        applied = s.capture("prd.apply", "prd", "apply", "PRD-01")
        first = applied["made"]["slices"][0]
        s.capture("prd.status.applied", "prd", "status", "PRD-01")
        s.capture("slice.resume.from-prd", "slice", "resume", first)
        s.capture("prd.confirm.refused-nothing-drafted", "prd", "confirm", first, "--accept", "all")
        s.capture("prd.draft", "prd", "draft", first, "--from", str(s.root / "files" / "answers.json"))
        # Four drafted answers waiting: two drafted, one contradiction, one the PRD does not settle.
        s.capture("slice.show.prd-drafted", "slice", "show", first)
        s.capture("slice.resume.prd-drafted", "slice", "resume", first)
        s.capture("slice.check.prd-pending", "slice", "check", first)
        s.capture("prd.confirm.refused-contradiction", "prd", "confirm", first, "--accept", "3")
        s.capture("prd.confirm", "prd", "confirm", first, "--accept", "1", "--discuss", "2")
        s.capture("status.prds", "status")
    run(Scenario, body)


# ---- the Jira key, export and keys back (M13 E), design mocks (M14 C) ----

def jira_and_mocks(Scenario):
    def body(s):
        files = s.root / "files"
        files.mkdir()
        (files / "invite.png").write_bytes(png())
        (files / "whole.jpg").write_bytes(jpeg())
        (files / "notes.png").write_text("not a picture")
        s.project_and_epic()
        first = s.drafted()
        second = s.drafted(title="Remove a teammate", depends=(first,))
        s.capture("epic.link", "epic", "link", "EPIC-001", "--jira", "TEAM-1")
        s.capture("slice.link", "slice", "link", first, "--jira", "TEAM-12")
        s.capture("slice.link.refused-form", "slice", "link", first, "--jira", "team 12")
        s.capture("slice.link.remove", "slice", "link", second, "--no-jira")
        s.capture("slice.mock.list.empty", "slice", "mock", "list", first)
        s.capture("slice.mock.add", "slice", "mock", "add", first, str(files / "invite.png"), "--for", "AC-01", "--binding", "--note", "The invite form")
        whole = s.capture("slice.mock.add.whole", "slice", "mock", "add", first, str(files / "whole.jpg"))["mock"]["sha256"]
        s.capture("slice.mock.add.refused-not-a-picture", "slice", "mock", "add", first, str(files / "notes.png"))
        s.capture("slice.mock.add.refused-binding", "slice", "mock", "add", first, str(files / "whole.jpg"), "--binding")
        s.capture("slice.mock.list", "slice", "mock", "list", first)
        s.capture("slice.mock.remove", "slice", "mock", "remove", first, whole[:12])
        s.capture("slice.show.mocks-and-jira", "slice", "show", first)
        # Marked ready on GitHub: the picture waits in the workspace for the product manager to commit it.
        s.capture("slice.ready.with-mocks", "slice", "ready", first)
        s.capture("slice.mock.add.refused-ready", "slice", "mock", "add", first, str(files / "whole.jpg"))
        s.ok(s.a, "epic", "link", "EPIC-001", "--jira", "TEAM-2")
        s.capture("status.jira-mocks", "status")
        s.capture("jira.export", "jira", "export")
        s.capture("jira.export.all", "jira", "export", "--state", "all", "--flavour", "data-center")
        s.capture("jira.export.refused-epic", "jira", "export", "--epic", "EPIC-009")
        keys = files / "jira-keys.csv"
        keys.write_text("Issue key,Summary,Custom field (MACH ID),Labels,Labels\r\n"
                        f"TEAM-30,Remove a teammate,{second},mach,{second}\r\n"
                        "TEAM-31,Something else,,mach,other\r\n"
                        f"TEAM-32,Invite a teammate,{first},mach,{first}\r\n"
                        "team 33,Bad key,EPIC-001,mach,EPIC-001\r\n")
        s.capture("jira.keys.dry-run", "jira", "keys", str(keys), "--dry-run")
        s.capture("jira.keys", "jira", "keys", str(keys))
        s.capture("jira.keys.refused-not-csv", "jira", "keys", str(files / "invite.png"))
    run(Scenario, body)


# ---- a request filed in the idea template (M14 D) ----

def idea_request(Scenario):
    from test_idea import IdeaBase, labeled  # noqa: E402

    class IdeaScenario(IdeaBase):
        def runTest(self):  # pragma: no cover
            pass
        save = Scenario.save
        capture = Scenario.capture

    def body(s):
        if s.file().returncode != 0:
            raise RuntimeError("the idea was not filed")
        s.issue("43", labels=[{"name": "mach:request"}], events=[labeled("erin-eng", 2001)], updatedAt="2026-11-20T10:00:00Z")
        s.capture("refresh.idea-request", "refresh")
        s.capture("request.list.idea", "request", "list")
        s.capture("request.show.idea", "request", "show", "43")
        s.capture("request.show.plain", "request", "show", "42")
        s.ready(s.a)
        picked = s.capture("request.pick.idea", "request", "pick", "43", "--epic", "EPIC-001", "--title", "Admins add colleagues")
        s.capture("slice.resume.idea-request", "slice", "resume", picked["slice"]["slice_id"])
    run(IdeaScenario, body)


# ---- M15 clean-up: the principles in every state the screens show ----

def principles_published(Scenario):
    def body(s):
        s.project_and_epic()
        s.ok(s.a, "principle", "add", "--title", "Versions stay as published", "--statement", STATEMENT, "--reason", "Readers rely on what they saw.")
        s.capture("principle.list.never-published", "principle", "list")
        s.ok(s.a, "principle", "publish")
        s.capture("principle.list.published", "principle", "list")
        s.capture("status.principles-published", "status")
        # Publishing stops part way: the comment that approves the new version is lost.
        s.ok(s.a, "principle", "set", "PP-01", "--reason", "Readers trust what they saw.")
        s.lose("issue comment")
        s.capture("principle.publish.refused-stopped", "principle", "publish")
        s.capture("principle.list.unfinished", "principle", "list")
        s.capture("status.principles-unfinished", "status")
        s.ok(s.a, "principle", "publish")
        # Someone edits the principles in the project's issue after they were approved.
        state = s.gh()
        for issue in state["issues"].values():
            if "mach:project" in [label["name"] for label in issue["labels"]]:
                issue["body"] = issue["body"].replace("MUST NOT be edited in place", "should not be edited in place")
        s.set_gh(issues=state["issues"])
        s.ok(s.a, "refresh")
        s.capture("principle.list.changed-on-github", "principle", "list")
        # GitHub cannot be reached at all.
        s.ok(s.a, "principle", "set", "PP-01", "--reason", "Readers rely on it.")
        s.fail("*", once=False)
        s.capture("principle.publish.refused-offline", "principle", "publish")
        s.set_gh(fail={})
        s.ok(s.a, "principle", "publish")
        # Ben publishes a newer version while Ada has a change of her own: she keeps hers.
        s.project_and_epic(s.b)
        s.set_gh(me="ben-pm")
        s.ok(s.b, "refresh")
        s.ok(s.b, "principle", "add", "--title", "Senders are named", "--statement", SECOND, "--reason", "People trust a name.")
        s.ok(s.b, "principle", "publish")
        s.set_gh(me="ada-pm")
        s.ok(s.a, "principle", "set", "PP-01", "--reason", "Ada's reason.")
        s.ok(s.a, "refresh")
        s.capture("reconcile.principles.mine", "reconcile", "principles", "--take", "mine")
    run(Scenario, body)


def principles_in_the_folder(Scenario):
    def body(s):
        s.set_gh(signed_in=False)
        s.project_and_epic()
        s.ok(s.a, "principle", "add", "--title", "Versions stay as published", "--statement", STATEMENT, "--reason", "Readers rely on what they saw.")
        s.capture("principle.publish.folder", "principle", "publish")
        s.capture("principle.list.folder", "principle", "list")
    run(Scenario, body)


# ---- M15 clean-up: policy packs ----

DPO = "Data protection officer (@dana-dpo)"


def policies_none(Scenario):
    def body(s):
        os.environ.pop("MACH_EXECUTION_ID", None)
        s.project_and_epic()
        s.capture("policy.list.empty", "policy", "list")
        commit_to_main(s, {"policies/brand/policy.md": pack_text("brand", title="Brand").replace("id: POL-brand", "id: POL-branding"),
                           "policies/security/README.md": "The security pack is still being written.\n"}, "a malformed pack and a folder without policy.md")
        s.capture("policy.list.problems", "policy", "list")
    run(Scenario, body)


def policies_awkward(Scenario):
    def body(s):
        pack = pack_text(owner=DPO)
        commit_to_main(s, {"policies/privacy/policy.md": pack}, "privacy pack owned by a named person")
        os.environ.pop("MACH_EXECUTION_ID", None)
        s.project_and_epic()
        s.ok(s.a, "principle", "add", "--title", "Versions stay as published", "--statement", STATEMENT, "--reason", "Readers rely on what they saw.")
        s.ok(s.a, "principle", "add", "--title", "Senders are named", "--statement", SECOND, "--reason", "People trust a name.")
        s.ok(s.a, "principle", "publish")
        applies = (row(), row("PP-02", 1, SECOND, "Applies", "AC-01."))

        def drafted(title, text):
            slice_id = s.ok(s.a, "slice", "new", "--epic", "EPIC-001", "--title", title)["slice"]["slice_id"]
            s.write_slice(s.a, slice_id)
            spec_path(s, slice_id).write_text(text(spec_for(slice_id)))
            return slice_id

        followed_one = drafted("Invite a teammate", lambda text: followed(with_rows(text, *applies), pack))
        s.capture("slice.show.policy-followed", "slice", "show", followed_one)
        changed = drafted("Remove a teammate", lambda text: concern(with_rows(text, *applies), resolution="spec changed.", owner=DPO, pack=pack))
        s.capture("slice.show.concern-spec-changed", "slice", "show", changed)
        excepted = drafted("Rename the workspace", lambda text: followed(with_rows(
            text, row("PP-01", 1, STATEMENT, "Does not apply", "Renaming changes no published version."),
            row("PP-02", 1, SECOND, "Exception", "The pilot sends from a shared address for one month.")), pack))
        s.capture("slice.show.principle-exceptions", "slice", "show", excepted)
        waiting = drafted("Leave the workspace", lambda text: concern(with_rows(text, *applies), owner=DPO, pack=pack))
        s.capture("policy.accept.refused-owner", "policy", "accept", waiting, "POL-privacy-02", "--by", "Data protection officer",
                  "--reason", "Accepted for the pilot only.")
        s.capture("policy.accept.checked", "policy", "accept", waiting, "POL-privacy-02", "--by", "dana-dpo", "--reason", "Accepted for the pilot only.")
        # The pack gains a statement after these slices answered it.
        commit_to_main(s, {"policies/privacy/policy.md": pack_text(owner=DPO, statements=(STATEMENT_1, STATEMENT_2, STATEMENT_3))}, "a third privacy statement")
        s.capture("policy.list.older", "policy", "list")
        s.capture("status.policies-changed", "status")
    run(Scenario, body)


# ---- M15 clean-up: Jira keys back with slices to reopen, and a description cut to fit ----

def jira_keys_awkward(Scenario):
    def body(s):
        s.project_and_epic()
        first = s.drafted()
        s.ready(first)
        s.capture("epic.link.already-ready", "epic", "link", "EPIC-001", "--jira", "TEAM-5")
        s.capture("epic.link.remove", "epic", "link", "EPIC-001", "--no-jira")
        long_why = s.drafted(title="Remove a teammate")
        intent = s.draft(s.a, f"product/intents/{long_why}.md")
        intent.write_text(intent.read_text().replace("An admin cannot bring a colleague in.", "word " * 4000))
        keys = s.root / "files" / "jira-keys.csv"
        keys.parent.mkdir()
        keys.write_text("Issue key,Summary,Custom field (MACH ID),Labels,Labels\r\n"
                        "TEAM-5,Team membership,EPIC-001,mach,EPIC-001\r\n"
                        f"TEAM-6,Invite a teammate,{first},mach,{first}\r\n")
        s.capture("jira.keys.reopen", "jira", "keys", str(keys))
        s.capture("jira.export.cut", "jira", "export", "--state", "all")
    run(Scenario, body)


# ---- M15 clean-up: four design mocks, one of them changed in the workspace ----

def four_mocks(Scenario):
    def body(s):
        files = s.root / "files"
        files.mkdir()
        s.project_and_epic()
        first = s.drafted()
        pictures = [("form.png", png(shade=10), ("--for", "AC-01", "--binding", "--note", "The invite form")),
                    ("sent.png", png(shade=80), ("--note", "After sending")),
                    ("error.png", png(shade=160), ("--note", "When the address is wrong")),
                    ("mobile.jpg", jpeg(), ())]
        for name, data, options in pictures:
            (files / name).write_bytes(data)
            s.ok(s.a, "slice", "mock", "add", first, str(files / name), *options)
        s.capture("slice.show.four-mocks", "slice", "show", first)
        # One picture in the workspace is changed by hand: the list says so.
        changed = sorted((s.a / ".factory/studio/draft/product/mocks" / first).glob("*.png"))[0]
        changed.write_bytes(png(shade=200))
        s.capture("slice.mock.list.problem", "slice", "mock", "list", first)
    run(Scenario, body)
