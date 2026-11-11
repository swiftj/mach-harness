#!/usr/bin/env python3
"""Regenerate the fixtures in this folder from the real Product Studio engine.

Every file here is the exact JSON studio.py printed in a real scenario (a local bare repository as
the shared remote, a stand-in for gh), with temporary paths replaced by /project. Nothing is
invented, so the web application is developed and tested against what the engine really returns.

Run from the repository root:  python3 web/fixtures/generate.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
from test_mach_product_collab import AT, Base  # noqa: E402

OUT = Path(__file__).resolve().parent


class Scenario(Base):
    def runTest(self):  # pragma: no cover - driven by hand below
        pass

    def save(self, name, data):
        text = json.dumps(data, indent=2, ensure_ascii=False).replace(str(self.root), "/project-root").replace("/project-root/a", "/project").replace("/project-root/b", "/project")
        (OUT / f"{name}.json").write_text(text + "\n")

    def capture(self, name, project, *argv):
        code, out, err = self.run_studio(project, *argv)
        data = json.loads(out) if out.strip().startswith("{") else None
        self.save(name, {"exit_code": code, "data": data, "refused": err.replace("refused: ", "", 1).strip() if code else None})
        return data


def main():
    s = Scenario()
    s.setUp()
    try:
        a, b = s.a, s.b
        s.capture("status.empty", a, "status")
        s.capture("where", a, "where")
        s.capture("project.init", a, "project", "init", "--id", "team-space", "--name", "Team Space", "--vision", "Teams work together without friction.",
                  "--outcome", "Teams can work together", "--outcome", "Admins stay in control of who has access")
        s.capture("epic.add", a, "epic", "add", "--title", "Team membership", "--criterion", "Only invited people can join", "--criterion", "Admins can see who is invited")
        s.capture("status.project-and-epic", a, "status")
        s.capture("slice.new", a, "slice", "new", "--epic", "EPIC-001", "--title", "Invite a teammate")
        s.capture("slice.approve.refused-no-spec", a, "slice", "approve", "SLICE-001")
        s.capture("slice.resume.no-spec", a, "slice", "resume", "SLICE-001")
        s.write_slice(a, "SLICE-001")
        s.capture("slice.pause", a, "slice", "pause", "SLICE-001", "--note", "Settled who may invite and the seat limit. Next: do invitations expire?")
        s.capture("slice.check.ready", a, "slice", "check", "SLICE-001")
        s.capture("slice.resume.ready", a, "slice", "resume", "SLICE-001")
        s.capture("slice.show.ready", a, "slice", "show", "SLICE-001")
        s.capture("status.slice-ready", a, "status")
        s.capture("slice.approve.refused-epic", a, "slice", "approve", "SLICE-001")
        s.capture("epic.approve", a, "epic", "approve", "EPIC-001")
        s.capture("slice.approve", a, "slice", "approve", "SLICE-001")
        s.capture("wave.new", a, "wave", "new", "--slice", "SLICE-001")
        s.capture("wave.approve", a, "wave", "approve", "WAVE-001", "--at", AT)
        s.capture("slice.show.approved", a, "slice", "show", "SLICE-001")
        s.capture("status.wave-approved", a, "status")
        s.capture("send.dry-run", a, "send", "WAVE-001", "--dry-run")
        s.capture("feedback.not-sent", a, "feedback")
        s.capture("send", a, "send", "WAVE-001")
        s.capture("feedback.waiting", a, "feedback")
        s.set_pr(1, reviewDecision="CHANGES_REQUESTED", reviews=[{"author": {"login": "erin"}, "state": "CHANGES_REQUESTED", "body": "Say what happens when the email address is malformed."}],
                 comments=[{"author": {"login": "sam"}, "body": "Do invitations ever expire?"}])
        s.capture("feedback.changes-requested", a, "feedback")
        s.set_pr(1, reviewDecision="", reviews=[], comments=[], statusCheckRollup=[{"name": "validate-product", "conclusion": "FAILURE"}])
        s.capture("feedback.blocked-by-check", a, "feedback")
        s.set_pr(1, statusCheckRollup=[])
        s.land("product/WAVE-001")
        s.capture("feedback.accepted", a, "feedback")
        s.capture("refresh.after-accept", a, "refresh")
        s.capture("status.published", a, "status")
        # A second product manager joins.
        s.capture("refresh.second-pm-arrives", b, "refresh")
        s.capture("status.second-pm", b, "status")
        # A draft with open questions and validator errors.
        open_slice = s.ok(b, "slice", "new", "--epic", "EPIC-001", "--title", "Remove a teammate")["slice"]["slice_id"]
        s.write_slice(b, open_slice)
        spec = s.draft(b, f"specs/slices/{open_slice}-invite-teammate.md")
        spec.write_text(spec.read_text().replace("## Open questions\n\n- None.", "## Open questions\n\n- Does a removed teammate keep access until the end of the billing period? Follow up: ask Finance.\n- Can an admin remove themselves? Follow up: ask the product owner."))
        s.capture("slice.check.open-questions", b, "slice", "check", open_slice)
        s.capture("slice.show.open-questions", b, "slice", "show", open_slice)
        text = spec.read_text()
        spec.write_text(text[:text.index("## Invariants")] + text[text.index("## Functional requirements"):])
        s.capture("slice.check.errors", b, "slice", "check", open_slice)
        spec.write_text(text)
        s.ok(b, "slice", "check", open_slice)
        # Conflicts: the same epic field, and the same spec, changed in both places.
        s.ok(b, "epic", "set", "EPIC-001", "--title", "People and access", "--criterion", "Only invited people can join")
        s.upstream("product/epics/EPIC-001.json", lambda d: d.update(title="Membership", acceptance_criteria=["Only invited people can join", "Invitations expire after 14 days"]))
        s.ok(b, "slice", "reopen", "SLICE-001")
        s.write_slice(b, "SLICE-001", extra="\nBen's wording.\n")
        # Ada revises the same slice properly, and engineering accepts her revision.
        s.ok(a, "refresh")
        s.ok(a, "slice", "reopen", "SLICE-001")
        revised = s.draft(a, "specs/slices/SLICE-001-invite-teammate.md")
        revised.write_text(revised.read_text().replace("SHALL reserve one seat for the invitee", "SHALL reserve one seat for the invitee for 14 days"))
        s.ok(a, "slice", "approve", "SLICE-001")
        revision_wave = s.new_wave(a, "SLICE-001")
        s.ok(a, "send", revision_wave)
        s.land(f"product/{revision_wave}")
        s.ok(a, "refresh")
        s.upstream("product/project.json", lambda d: d.update(vision="Teams work together without friction, wherever they are."))
        s.capture("refresh.conflicts", b, "refresh")
        s.capture("status.conflicts", b, "status")
        s.capture("reconcile.field", b, "reconcile", "EPIC-001", "--take", "mine", "--field", "title")
        s.capture("reconcile.refused-unknown", b, "reconcile", "EPIC-404", "--take", "mine")
        # A collision: Ada's SLICE numbers land first.
        ada = s.new_slice(a, title="Resend an invitation")
        ada_wave = s.new_wave(a, ada)
        s.ok(a, "send", ada_wave)
        s.land(f"product/{ada_wave}")
        s.capture("refresh.collision", b, "refresh")
        s.capture("slice.renumber", b, "slice", "renumber", open_slice)
        s.capture("status.after-renumber", b, "status")
        s.capture("validate", b, "validate")
        # Offline.
        import subprocess
        subprocess.run(["git", "remote", "set-url", "origin", str(s.root / "gone.git")], cwd=str(b), check=True)
        s.capture("refresh.offline", b, "refresh")
        s.capture("send.refused-offline", b, "send", "WAVE-001")
    finally:
        s.doCleanups()
    print("wrote", len(list(OUT.glob("*.json"))), "fixtures to", OUT)


if __name__ == "__main__":
    main()
