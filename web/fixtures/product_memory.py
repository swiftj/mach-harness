"""Fixtures for the M15 screens: what M13 and M14 added to the Product Studio engine.

Called by generate.py (python3 web/fixtures/generate.py). Each scenario drives the real engine with --app, in the same
throwaway repositories and stand-ins for gh that the engine's own tests use, and saves exactly what it printed. Nothing
here is invented: the awkward cases are made by doing the real thing (an older principle, an open policy concern, a
shipped rule replaced and retired, a PRD section no slice cites, a slice waiting for its design mocks to be committed,
a row in a Jira file that names nothing, a request filed in the idea template).

M16 adds Shape's fixtures (the shape_* scenarios at the end): every state of the Shape sketch and the awkward ones,
listed in docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 4 with the parameter that reaches each in fixture mode.
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
    # M16: Shape (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md).
    shape_board(Scenario)
    shape_verdicts(Scenario)
    shape_routes(Scenario)
    shape_map(Scenario)
    shape_look_back(Scenario)
    shape_look_back_without_github(Scenario)
    shape_publish(Scenario)
    shape_publish_to_the_folder(Scenario)
    # M16 clean-up: the states the Shape screens built by hand, and idea.show and idea.map-status in pairs.
    shape_awkward(Scenario)
    # M18: Shape's fourth route, a small change.
    shape_small_change(Scenario)


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


# ---- M16: Shape, the part of Product Studio before epics ----
#
# Every case the Shape sketch shows and the awkward ones, each made by doing the real thing in the engine's own test
# repositories (test_mach_shape and test_mach_shape_route), with one exception said where it is made: "not determined"
# high-risk areas need a computer that cannot say which files a shipped slice changed, so that one answer from Git is
# withheld for the one size it is captured for.

LOOKUP_NOTES = {
    "shipped_rules": [{"rule": "SLICE-001/FR-01", "note": "An invitation is sent by email today; a renewal would reach members the same way."},
                      {"rule": "SLICE-001/INV-02", "note": "One address, one membership: a renewal is for the member signed in."}],
    "similar": [{"idea": "IDEA-001", "note": "A reminder before the due date is about the same loans."},
                {"request": 57, "note": "Members asked for reminders by email."}],
    "principles": [{"id": "PP-01", "note": "A renewal refused today is explained by a person; here the page must do it."}],
    "policies": [{"id": "POL-privacy-02", "note": "A renewal notice must not leave the EU region."}],
}
FINDING_BRIEF_PARTS = (
    ("  - How we would know: complaints about unexpected fines after a refused renewal fall to none in a quarter.",
     "  - How we would know: not written yet"),
    ("  - How we would know: renewal calls at Central fall from about 40 a week to under 15 within two months.",
     "  - How we would know: members are happier with renewals."),
    ("## Open questions\n\nNone.",
     "## Open questions\n\n- What does a member see when a renewal is refused because someone else is waiting? Who can answer: the head of lending services."),
)


# M16 clean-up: the board's ideas by the suffix of their idea.show fixture (shapeTransport.ts answers each idea with these).
BOARD_IDEAS = {"IDEA-001": "request", "IDEA-002": "exploring", "IDEA-003": "brief-written", "IDEA-004": "fault", "IDEA-005": "not-now",
               "IDEA-006": "go", "IDEA-007": "change", "IDEA-008": "shaped-one-slice"}
FAULT_TWO = "AUTO-20261120T094000Z"
LONG_REASON = ("Not now. The branches have nobody to run reading challenges before the summer, the children's librarians are already "
               "covering two vacancies, and the schools asked us to wait until the new term so that teachers can join in. We should "
               "come back to it in September with the head of children's services, when the summer reading scheme has finished and "
               "we know how many volunteers stayed on. Nothing here says the idea is wrong; the timing is.")
HEADER_ISSUES = {"SLICE-001": 40, "SLICE-002": 41}


def headed(text):
    """A shipped spec with the header line the Factory writes at dispatch: it names the slice's epic (taken off again before
    any hash is compared). The specs the engine's own tests commit have none, so their rules carry no epic."""
    lines = text.split("\n")
    title = next(index for index, line in enumerate(lines) if line.startswith("# "))
    slice_id = next(key for key in HEADER_ISSUES if key in text)
    header = f"> Epic: Team membership (EPIC-001, issue #12). Slice issue: #{HEADER_ISSUES[slice_id]}."
    return "\n".join(lines[:title + 1] + ["", header] + lines[title + 1:])


def warnings_brief(text):
    """A brief that passes with warnings only: a vague way to know, and an open question."""
    for old, new in FINDING_BRIEF_PARTS[1:]:
        text = text.replace(old, new, 1)
    return text


def shape_scenario(Scenario):
    """Shape's own test base with the fixtures' save and capture: SLICE-001 shipped on main, the stand-in for gh."""
    from test_mach_shape_route import LookbackTest, RouteBase

    class ShapeScenario(RouteBase):
        def runTest(self):  # pragma: no cover
            pass
        save = Scenario.save
        capture = Scenario.capture
        ship = LookbackTest.ship

        def brief(self, idea_id, text, title=None):
            if title:
                text = text.replace("# Brief: Let members renew a loan themselves", f"# Brief: {title}", 1)
            self.write_brief(idea_id, text)

        def lookups(self, idea_id, data):
            source = self.root / f"{idea_id}-lookups.json"
            source.write_text(json.dumps(data))
            return str(source)

    return ShapeScenario


def finding_brief(text):
    for old, new in FINDING_BRIEF_PARTS:
        text = text.replace(old, new, 1)
    return text


def shape_board(Scenario):
    """The ideas board: every stage, every source (typed, a request, an idea-template issue, a fault, a change to a shipped
    rule), a No kept with its reason, lookups in all three groups, a brief that passes and one with a finding and warnings,
    a case with one question not answered on purpose."""
    from test_mach_shape import FAULT, REQUEST_BODY, TEMPLATE_BODY
    from test_mach_shape_brief import CASE
    from test_mach_shape_route import EPIC, ONE, SEVERAL

    def body(s):
        commit_to_main(s, {"policies/privacy/policy.md": pack_text()}, "privacy pack")
        s.ship_second_slice()
        # The shipped specs name their epic in their header line, as the Factory writes it, so the rules looked up carry it.
        commit_to_main(s, {f"specs/slices/{name}": headed((s.eng / "specs/slices" / name).read_text())
                           for name in ("SLICE-001-invite-teammate.md", "SLICE-002-invite-teammate.md")}, "specs with their epic")
        os.environ.pop("MACH_EXECUTION_ID", None)
        s.project_and_epic()
        s.ok(s.a, "principle", "add", "--title", "Tell before refusing", "--statement", "A member MUST be told why a renewal is refused.",
             "--reason", "Members trust a reason.")
        s.capture("idea.list.empty", "idea", "list")
        s.requests_cache([(57, "Email a reminder two days before a loan is due", REQUEST_BODY, "accepted"),
                          (58, "Let members renew a loan themselves", TEMPLATE_BODY, "accepted"),
                          (59, "Not counted", "Body", "not_accepted")])
        # New: from a request issue.
        s.capture("idea.add.from-request", "idea", "add", "Email a reminder two days before a loan is due", "--from-request", "57")
        s.capture("idea.add.refused-twice", "idea", "add", "Remind me again", "--from-request", "57")
        s.capture("idea.add.refused-not-template", "idea", "add", "Email a reminder", "--from-issue", "57")
        # Exploring: from an idea-template issue, with lookups in all three groups and a brief that does not pass yet.
        s.capture("idea.add.from-issue", "idea", "add", "Let members renew a loan themselves", "--from-issue", "58")
        s.capture("idea.stage", "idea", "stage", "IDEA-002", "exploring")
        s.capture("idea.lookups", "idea", "lookups", "IDEA-002", "--from", s.lookups("IDEA-002", LOOKUP_NOTES))
        s.brief("IDEA-002", finding_brief(SEVERAL))
        s.capture("brief.check.finding", "brief", "check", "IDEA-002")
        s.capture("brief.show.finding", "brief", "show", "IDEA-002")
        s.capture("idea.show.exploring", "idea", "show", "IDEA-002")
        s.capture("idea.show.request", "idea", "show", "IDEA-001")
        # Brief written: typed by the product manager; its brief passes, its case has a question not answered on purpose.
        s.capture("idea.add", "idea", "add", "Reserve a study room online")
        s.capture("case.show.refused-none", "case", "show", "IDEA-003")
        s.brief("IDEA-003", EPIC, "Reserve a study room online")
        s.capture("brief.check.passes", "brief", "check", "IDEA-003")
        s.capture("brief.show.passes", "brief", "show", "IDEA-003")
        s.write_case("IDEA-003", CASE)
        s.capture("case.show", "case", "show", "IDEA-003")
        s.capture("case.check", "case", "check", "IDEA-003")
        s.capture("idea.show.brief-written", "idea", "show", "IDEA-003")
        # Decided No, from a fault, kept with its reason; the fault's own record on this computer is shown fenced.
        s.capture("idea.add.from-fault", "idea", "add", "Overdue fine shown twice at self-checkout", "--from-fault", FAULT)
        inbox = s.a / ".factory/inbox"
        inbox.mkdir(parents=True, exist_ok=True)
        (inbox / f"{FAULT}.json").write_text(json.dumps({"ticket_id": FAULT, "title": "TypeError in fines.py",
                                                         "body": "Seen 14 times this week at self-checkout. Stack: fines.py line 88."}))
        s.capture("verdict.record.no", "verdict", "record", "IDEA-004", "--decision", "no",
                  "--reason", "The fine is shown twice by the kiosk's own screen; it is the supplier's fault, not ours.")
        s.capture("idea.show.fault", "idea", "show", "IDEA-004")
        # The faults on this computer an idea may start from: one already started, one not.
        (inbox / f"{FAULT_TWO}.json").write_text(json.dumps({"ticket_id": FAULT_TWO, "title": "Timeout when renewing from the catalogue",
                                                             "state": "open", "occurrences_ingested": 6, "last_seen": "2026-11-20T09:40:00Z"}))
        s.capture("idea.faults", "idea", "faults")
        # Decided Not now, typed, with no brief at all.
        s.ok(s.a, "idea", "add", "Reading challenges for children")
        s.capture("verdict.record.not-now", "verdict", "record", "IDEA-005", "--decision", "not-now",
                  "--reason", "Worth doing after the summer. The branches have nobody to run it before then.")
        s.capture("idea.show.not-now", "idea", "show", "IDEA-005")
        # Decided Go.
        s.ok(s.a, "idea", "add", "Members pay fines online")
        s.brief("IDEA-006", ONE, "Members pay fines online")
        s.capture("verdict.record.go", "verdict", "record", "IDEA-006", "--decision", "go",
                  "--reason", "Members ask for it at every desk, and the payment provider is already approved.")
        s.capture("idea.show.go", "idea", "show", "IDEA-006")
        # Exploring: a change to what exists, from a shipped rule, with its starter brief.
        s.capture("idea.change", "idea", "change", "SLICE-001/INV-02", "--title", "Let one address hold two memberships")
        s.capture("idea.change.refused-replaced", "idea", "change", "SLICE-001/FR-09")
        s.capture("idea.show.change", "idea", "show", "IDEA-007")
        s.capture("brief.check.change-starter", "brief", "check", "IDEA-007")
        s.capture("brief.show.change-starter", "brief", "show", "IDEA-007")
        s.capture("brief.show.refused-none", "brief", "show", "IDEA-001")
        # Shaped into work.
        s.ok(s.a, "idea", "add", "Show members what they have on loan")
        s.brief("IDEA-008", ONE, "Show members what they have on loan")
        s.ok(s.a, "verdict", "record", "IDEA-008", "--decision", "go", "--reason", "Members ask what they have out.")
        s.ok(s.a, "idea", "size", "IDEA-008")
        s.record_map({"epics": [], "slices": [{"key": "S1", "title": "Show my loans", "scope": "The member's loans, on one page", "epic": "EPIC-001",
                                               "depends_on": [], "outcomes": ["O-1"], "cites": ["9-10"]}]}, idea_id="IDEA-008")
        s.ok(s.a, "idea", "apply", "IDEA-008")
        s.capture("idea.show.shaped-one-slice", "idea", "show", "IDEA-008")
        for idea_id, suffix in BOARD_IDEAS.items():  # each board idea's map-status, to answer beside its idea.show
            s.capture(f"idea.map-status.{suffix}", "idea", "map-status", idea_id)
        s.capture("idea.list.board", "idea", "list")
        s.capture("status.ideas", "status")
        s.capture("refresh.ideas-none-saved", "refresh")
    run(shape_scenario(Scenario), body)


def shape_verdicts(Scenario):
    """A verdict gone stale when the brief changed; Go refused without a passing brief; GitHub unreachable; recorded with
    nobody signed in, then refused for GitHub until it is recorded again."""
    from test_mach_shape_route import ONE

    def body(s):
        s.project_and_epic()
        s.ok(s.a, "idea", "add", "Let members renew a loan themselves")
        s.capture("verdict.record.refused-go-without-brief", "verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Yes.")
        s.brief("IDEA-001", ONE)
        s.ok(s.a, "verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Members ask for it at every desk.")
        s.brief("IDEA-001", ONE.replace("call or come in", "phone or visit"))
        s.capture("brief.show.stale-verdict", "brief", "show", "IDEA-001")
        s.capture("idea.show.stale-verdict", "idea", "show", "IDEA-001")
        s.capture("brief.check.stale-verdict", "brief", "check", "IDEA-001")
        s.capture("status.ideas-stale-verdict", "status")
        s.fail("*", once=False)
        s.capture("verdict.record.refused-offline", "verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Still yes.")
        s.set_gh(fail={})
        s.set_gh(signed_in=False)
        s.capture("verdict.record.no-login", "verdict", "record", "IDEA-001", "--decision", "go", "--reason", "Still yes.")
        s.set_gh(signed_in=True)
        s.capture("idea.publish.refused-no-login", "idea", "publish", "IDEA-001")
    run(shape_scenario(Scenario), body)


def shape_routes(Scenario):
    """Size and route: one slice, an epic with high-risk areas not determined, several epics reaching sign-in and billing;
    sizing refused without a Go; a route gone stale."""
    from test_mach_shape_route import EPIC, ONE, brief_with

    def body(s):
        import shape_route  # noqa: E402  (the engine's own module, as studio loads it)
        s.ship_second_slice(files=("src/auth/login.py", "src/billing/invoice.py", "src/catalogue/search.py"))
        s.project_and_epic()
        s.go(ONE, "IDEA-001", "Renew one loan from my loans")
        s.capture("idea.size.one-slice", "idea", "size", "IDEA-001")
        s.go(EPIC, "IDEA-002", "Let members renew a loan themselves")
        real = shape_route.changed_files
        shape_route.changed_files = lambda *args: None  # this computer cannot say which files SLICE-001 changed
        try:
            s.capture("idea.size.epic", "idea", "size", "IDEA-002")
        finally:
            shape_route.changed_files = real
        s.go(brief_with(rules="SLICE-002/FR-01, SLICE-001/FR-01"), "IDEA-003", "Renew loans and pay fines in one place")
        s.capture("idea.size.several-epics", "idea", "size", "IDEA-003")
        s.capture("idea.show.sized", "idea", "show", "IDEA-003")  # a Go and a route, no map yet
        s.capture("idea.map-status.sized", "idea", "map-status", "IDEA-003")
        s.ok(s.a, "idea", "add", "Reading challenges for children")
        s.capture("idea.size.refused-no-go", "idea", "size", "IDEA-004")
        s.brief("IDEA-001", ONE.replace("call or come in", "phone or visit"))
        s.capture("idea.show.stale-route", "idea", "show", "IDEA-001")
        s.capture("idea.map-status.stale-route", "idea", "map-status", "IDEA-001")
        s.capture("idea.map.refused-stale", "idea", "map", "IDEA-001", "--from", s.map_file({"epics": [], "slices": []}))
        s.capture("status.ideas-routes", "status")
    run(shape_scenario(Scenario), body)


def shape_small_change(Scenario):
    """M18: the small-change route: one outcome in one capability, one shipped rule, nothing in a high-risk area. Its map
    holds one slice; applying it is refused until the product manager says which kind it is, then makes a small draft."""
    from test_mach_shape_route import brief_with

    def body(s):
        s.project_and_epic()
        s.go(brief_with(outcomes=1, capabilities="Lending (EPIC-001)", rules="SLICE-001/INV-02"), "IDEA-001", "Say who to ask when a renewal is refused")
        s.capture("idea.size.small-change", "idea", "size", "IDEA-001")
        s.record_map({"epics": [], "slices": [{"key": "S1", "title": "Say who to ask", "scope": "The refusal message on the loans page",
                                               "epic": "EPIC-001", "depends_on": [], "outcomes": ["O-1"], "cites": ["9-10"]}]})
        s.capture("idea.show.small-change", "idea", "show", "IDEA-001")
        s.capture("idea.map-status.small-change", "idea", "map-status", "IDEA-001")
        s.capture("idea.apply.refused-small-kind", "idea", "apply", "IDEA-001")
        s.capture("idea.apply.small-change", "idea", "apply", "IDEA-001", "--change", "adjustment")
    run(shape_scenario(Scenario), body)


def shape_map(Scenario):
    """The map: an outcome no slice carries, settled to a slice and out of scope, applied, applied again; the chain."""
    from test_mach_shape_route import EPIC, SEVERAL

    def body(s):
        s.project_and_epic()
        s.sized(SEVERAL)
        partial = s.several_map()
        partial["slices"] = partial["slices"][:1]
        partial["epics"] = partial["epics"][:1]
        partial["slices"].append({"key": "S2", "title": "Renew from the catalogue", "scope": "One loan, from the catalogue", "epic": "EPIC-001",
                                  "depends_on": ["S1"], "outcomes": ["O-1"], "cites": ["9"]})
        s.capture("idea.map.uncovered", "idea", "map", "IDEA-001", "--from", s.map_file(partial))
        s.capture("idea.map-status.uncovered", "idea", "map-status", "IDEA-001")
        s.capture("idea.show.uncovered", "idea", "show", "IDEA-001")
        s.capture("status.ideas-settle", "status")
        s.capture("idea.apply.refused-unsettled", "idea", "apply", "IDEA-001")
        s.capture("idea.settle.refused-carried", "idea", "settle", "IDEA-001", "--outcome", "O-1", "--as", "later")
        s.capture("idea.settle", "idea", "settle", "IDEA-001", "--outcome", "O-2", "--as", "slice:S2", "--reason", "The catalogue says why.")
        s.capture("idea.map-status.settled", "idea", "map-status", "IDEA-001")
        s.capture("idea.show.settled", "idea", "show", "IDEA-001")
        s.capture("status.ideas-apply", "status")
        s.capture("idea.apply", "idea", "apply", "IDEA-001")
        s.capture("idea.apply.again", "idea", "apply", "IDEA-001")
        s.capture("idea.map-status.applied", "idea", "map-status", "IDEA-001")
        s.capture("idea.show.applied", "idea", "show", "IDEA-001")
        s.write_slice(s.a, "SLICE-005")
        s.capture("slice.show.from-idea", "slice", "show", "SLICE-005")
        s.capture("slice.resume.from-idea", "slice", "resume", "SLICE-005")
        s.capture("idea.chain", "idea", "chain", "IDEA-001")
        s.capture("idea.show.shaped", "idea", "show", "IDEA-001")
        s.capture("idea.map-status.shaped", "idea", "map-status", "IDEA-001")
        # An epic route whose second outcome is out of scope, in the product manager's words.
        s.go(EPIC, "IDEA-002", "Renew loans from the catalogue")
        s.ok(s.a, "idea", "size", "IDEA-002")
        s.record_map({"epics": [], "slices": [{"key": "S1", "title": "Renew from the catalogue", "scope": "One loan", "epic": "EPIC-001",
                                               "depends_on": [], "outcomes": ["O-1"], "cites": ["9-10"]},
                                              {"key": "S2", "title": "Renew every loan at once", "scope": "All loans", "epic": "EPIC-001",
                                               "depends_on": ["S1"], "outcomes": ["O-1"], "cites": ["9"]}]}, idea_id="IDEA-002")
        s.capture("idea.settle.out-of-scope", "idea", "settle", "IDEA-002", "--outcome", "O-2", "--as", "out-of-scope",
                  "--reason", "Refusals are explained by the desk for now.")
        s.capture("idea.show.mapped", "idea", "show", "IDEA-002")
        s.capture("idea.map-status.mapped", "idea", "map-status", "IDEA-002")
    run(shape_scenario(Scenario), body)


def shape_look_back(Scenario):
    """Look back: not yet allowed (nothing shipped), allowed once a slice shipped, recorded and posted once on the idea's
    issue, the same words not posted again, an assumption, a note refused; the chain with a result."""
    from test_mach_shape_route import SEVERAL

    def body(s):
        s.project_and_epic()
        s.sized(SEVERAL)
        s.record_map(s.several_map())
        s.ok(s.a, "idea", "apply", "IDEA-001")
        s.capture("idea.publish.shaped", "idea", "publish", "IDEA-001")
        s.capture("lookback.record.refused-not-shipped", "lookback", "record", "IDEA-001", "--outcome", "O-1", "--result", "met",
                  "--note", "Calls at Central were down to 11 a week.")
        s.capture("status.ideas-shaped", "status")
        s.ship("SLICE-005")
        s.capture("status.ideas-look-back", "status")
        s.capture("idea.show.look-back", "idea", "show", "IDEA-001")
        s.capture("idea.map-status.look-back", "idea", "map-status", "IDEA-001")
        s.capture("lookback.record", "lookback", "record", "IDEA-001", "--outcome", "O-1", "--result", "met",
                  "--note", "Calls at Central were down to 11 a week by the start of March.")
        s.capture("lookback.record.again", "lookback", "record", "IDEA-001", "--outcome", "O-1", "--result", "met",
                  "--note", "Calls at Central were down to 11 a week by the start of March.")
        s.capture("lookback.record.assumption", "lookback", "record", "IDEA-001", "--assumption", "A-1", "--result", "wrong",
                  "--note", "About half the calls were about held items. O-1 was met anyway.")
        s.capture("lookback.record.too-early", "lookback", "record", "IDEA-001", "--outcome", "O-2", "--result", "too-early",
                  "--note", "One quarter has not passed yet.")
        s.capture("lookback.record.refused-secret", "lookback", "record", "IDEA-001", "--assumption", "A-2", "--result", "confirmed",
                  "--note", "token ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")
        s.capture("idea.show.looked-back", "idea", "show", "IDEA-001")
        s.capture("idea.map-status.looked-back", "idea", "map-status", "IDEA-001")
        s.capture("idea.chain.looked-back", "idea", "chain", "IDEA-001")
    run(shape_scenario(Scenario), body)


def shape_look_back_without_github(Scenario):
    """Look back with nobody signed in to GitHub: kept on this computer only."""
    from test_mach_shape_route import ONE

    def body(s):
        s.set_gh(signed_in=False)
        s.applied(text=ONE, data={"epics": [], "slices": [{"key": "S1", "title": "Renew a loan", "scope": "One loan", "epic": "EPIC-001",
                                                           "depends_on": [], "outcomes": ["O-1"], "cites": ["9"]}]})
        s.ship("SLICE-005")
        s.capture("lookback.record.folder", "lookback", "record", "IDEA-001", "--outcome", "O-1", "--result", "too-early",
                  "--note", "One month of numbers only.")
    run(shape_scenario(Scenario), body)


def shape_publish(Scenario):
    """Published to GitHub, again with nothing to change, changed on GitHub after its verdict, publishing stopped part way,
    and another product manager's idea holding the same number."""
    from test_mach_shape_route import ONE

    def body(s):
        s.project_and_epic()
        s.go(ONE, "IDEA-001", "Let members renew a loan themselves")
        s.capture("idea.publish", "idea", "publish", "IDEA-001")
        s.capture("idea.publish.again", "idea", "publish", "IDEA-001")
        s.capture("idea.show.on-github", "idea", "show", "IDEA-001")
        s.capture("refresh.ideas", "refresh")
        number = s.idea_issues()[0]["number"]
        s.change_issue(number, body=s.issue(number)["body"].replace("under 15", "under 5"))
        s.capture("refresh.ideas-changed", "refresh")
        s.capture("status.ideas-changed", "status")
        s.capture("idea.list.changed", "idea", "list")
        s.capture("idea.show.changed", "idea", "show", "IDEA-001")
        s.ok(s.a, "idea", "publish", "IDEA-001")  # publishing again puts the saved brief back
        # Stopped part way: the issue is made, the verdict comment's answer is lost.
        s.go(ONE, "IDEA-002", "Members pay fines online")
        s.lose("issue comment")
        s.capture("idea.publish.refused-stopped", "idea", "publish", "IDEA-002")
        s.capture("status.ideas-unfinished", "status")
        s.capture("idea.show.unfinished", "idea", "show", "IDEA-002")
        s.capture("idea.publish.finished", "idea", "publish", "IDEA-002")
        # Ben's IDEA-003 is on GitHub; Ada's own IDEA-003 must take another number.
        s.set_gh(me="ben-pm")
        s.ok(s.b, "idea", "add", "Their idea")
        s.ok(s.b, "idea", "add", "Their second idea")
        s.ok(s.b, "idea", "add", "Their third idea")
        s.ok(s.b, "idea", "publish", "IDEA-003")
        s.set_gh(me="ada-pm")
        s.ok(s.a, "idea", "add", "Reserve a study room online")
        s.capture("idea.publish.refused-number-taken", "idea", "publish", "IDEA-003")
        s.ok(s.a, "refresh")  # the next read of GitHub sees Ben's IDEA-003
        s.capture("idea.show.number-taken", "idea", "show", "IDEA-003")
        s.capture("status.ideas-number-taken", "status")
        s.capture("idea.renumber", "idea", "renumber", "IDEA-003")
    run(shape_scenario(Scenario), body)


def shape_awkward(Scenario):
    """The states the screens built by altering other fixtures: a brief with warnings only; a case with every question
    answered and one with a question that has no answer; a decided idea with a long reason; a map with route blockers; an
    idea file that cannot be read; no fault on this computer."""
    from test_mach_shape_brief import CASE
    from test_mach_shape_route import EPIC, SEVERAL

    not_answered = "  - Not answered: the product manager wants the first month's numbers first.\n"

    def body(s):
        s.project_and_epic()
        s.ok(s.a, "idea", "add", "Let members renew a loan themselves")
        s.brief("IDEA-001", warnings_brief(SEVERAL))
        s.capture("brief.check.warnings", "brief", "check", "IDEA-001")
        s.capture("brief.show.warnings", "brief", "show", "IDEA-001")
        s.capture("brief.check.unchanged", "brief", "check", "IDEA-001")  # checked again with nothing changed
        s.write_case("IDEA-001", CASE.replace(not_answered, "  - Answer: Fewer than 20 renewals online in the first month.\n"))
        s.capture("case.show.all-answered", "case", "show", "IDEA-001")
        s.capture("case.check.all-answered", "case", "check", "IDEA-001")
        s.write_case("IDEA-001", CASE.replace(not_answered, ""))
        s.capture("case.show.unanswered", "case", "show", "IDEA-001")
        s.capture("case.check.unanswered", "case", "check", "IDEA-001")
        s.ok(s.a, "idea", "add", "Reading challenges for children")
        s.capture("verdict.record.long-reason", "verdict", "record", "IDEA-002", "--decision", "not-now", "--reason", LONG_REASON)
        s.capture("idea.show.long-reason", "idea", "show", "IDEA-002")
        # A map with route blockers: the brief changed after the map was recorded, so the Go and the route no longer hold.
        s.go(EPIC, "IDEA-003", "Renew loans from the catalogue")
        s.ok(s.a, "idea", "size", "IDEA-003")
        s.record_map({"epics": [], "slices": [{"key": "S1", "title": "Renew from the catalogue", "scope": "One loan", "epic": "EPIC-001",
                                               "depends_on": [], "outcomes": ["O-1"], "cites": ["9-10"]},
                                              {"key": "S2", "title": "Say why a renewal is refused", "scope": "The reason", "epic": "EPIC-001",
                                               "depends_on": ["S1"], "outcomes": ["O-2"], "cites": ["11-12"]}]}, idea_id="IDEA-003")
        s.brief("IDEA-003", EPIC.replace("call or come in", "phone or visit"))
        s.capture("idea.map-status.blockers", "idea", "map-status", "IDEA-003")
        s.capture("idea.show.blockers", "idea", "show", "IDEA-003")
        s.capture("idea.list.long-reason", "idea", "list")
        s.capture("status.ideas-long-reason", "status")
        # An idea's record that cannot be read: the board lists it as unreadable, and showing it is refused.
        s.path("product/ideas/IDEA-004.json").write_text("{ not json")
        s.capture("idea.list.unreadable", "idea", "list")
        s.capture("status.ideas-unreadable", "status")
        s.capture("idea.show.refused-unreadable", "idea", "show", "IDEA-004")
        s.capture("idea.faults.empty", "idea", "faults")
    run(shape_scenario(Scenario), body)


def shape_publish_to_the_folder(Scenario):
    """No GitHub on this computer: the idea and its verdict go to the ready folder in the workspace."""
    from test_mach_shape_route import ONE

    def body(s):
        s.set_gh(signed_in=False)
        s.project_and_epic()
        s.go(ONE, "IDEA-001", "Let members renew a loan themselves")
        s.capture("idea.publish.folder", "idea", "publish", "IDEA-001")
        s.capture("status.ideas-folder", "status")
        s.capture("idea.show.folder", "idea", "show", "IDEA-001")
    run(shape_scenario(Scenario), body)
