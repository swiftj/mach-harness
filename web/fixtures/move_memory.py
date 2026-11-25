"""Fixtures for M21 F in the app: taking the whole project to another repository and bringing one in.

Called by generate.py (python3 web/fixtures/generate.py, or --only move to write just these). Each scenario drives the
real engine with --app, in the same throwaway repositories and stand-in for gh as the engine's own tests, and saves
exactly what it printed. Nothing is invented: the file brought in is the one `project export` wrote in the first
repository; the import that stopped part way was really stopped, by killing the process after it had placed a few files.

The host adds `downloads` to the export's answer and `kept` to a plan's; the fixture transport (src/dev/moveTransport.ts)
adds those, as the host would. The states, with the parameter that reaches each in fixture mode, are listed there.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STUDIO = ROOT / "skills" / "studio" / "scripts"
sys.path.insert(0, str(ROOT / "tests"))

STATEMENT = "A published version MUST NOT be changed in place."

# Runs studio.py in a process of its own and kills that process, without any cleanup, once the import has placed N files.
KILLER = """
import os, signal, sys
sys.dont_write_bytecode = True
sys.path.insert(0, {scripts!r})
import studio, project_import
real, count = project_import._place, [0]
def place(source, target):
    real(source, target)
    count[0] += 1
    if count[0] >= int(sys.argv[1]):
        os.kill(os.getpid(), signal.SIGKILL)
project_import._place = place
sys.exit(studio.main(sys.argv[2:]))
"""


def generate(Scenario, out: Path) -> None:
    folder = Path(tempfile.mkdtemp(prefix="mach-move-"))
    try:
        archive = leaving(Scenario, folder)
        arriving(Scenario, archive)
        joining(Scenario, archive)
        stopped(Scenario, archive)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def run(Scenario, body):
    s = Scenario()
    s.setUp()
    try:
        os.environ.pop("MACH_EXECUTION_ID", None)
        return body(s)
    finally:
        s.doCleanups()


def leaving(Scenario, folder: Path) -> Path:
    """A project with two epics, principles published, two slices marked ready and one a draft: exported. The refusal
    before there is a project. Returns a copy of the file, outside the scenario that wrote it."""

    def body(s):
        s.capture("project.export.refused-no-project", "project", "export")
        s.ok(s.a, "project", "init", "--id", "lending", "--name", "Lending", "--vision", "Members borrow what they need.",
             "--outcome", "Members can borrow books")
        s.ok(s.a, "epic", "add", "--title", "Loans", "--criterion", "A loan has a due date")
        s.ok(s.a, "epic", "add", "--title", "Renewals", "--criterion", "A member can renew once")
        first = s.drafted(title="Borrow a book")
        second = s.drafted(title="Return a book", depends=(first,))
        s.ok(s.a, "slice", "ready", first)
        s.ok(s.a, "slice", "ready", second)
        s.ok(s.a, "slice", "new", "--epic", "EPIC-002", "--title", "Renew a loan")
        s.ok(s.a, "principle", "add", "--title", "Versions stay as published", "--statement", STATEMENT, "--reason", "Readers rely on it.")
        s.ok(s.a, "principle", "publish")
        exported = s.capture("project.export", "project", "export")
        copy = folder / Path(exported["file"]).name
        shutil.copy(exported["file"], copy)
        # Another product manager's computer, with nothing of the project in its workspace: MACH reads it from GitHub.
        s.capture("project.export.from-github", "project", "export", project=s.b)
        # GitHub cannot be read: the export says so, prominently; with nothing here either, it is refused.
        s.gh_fails("issue list", once=False)
        s.capture("project.export.github-not-read", "project", "export")
        s.capture("project.export.refused-no-project-no-github", "project", "export", project=s.b)
        return copy

    return run(Scenario, body)


def placed(s, archive: Path) -> Path:
    """The file, in this scenario's own folder, where a person's download would be."""
    files = s.root / "files"
    files.mkdir(exist_ok=True)
    target = files / archive.name
    shutil.copy(archive, target)
    return target


def arriving(Scenario, archive: Path) -> None:
    """A repository with nothing in it yet: look first, bring it in, then the lookups and the answers to a second try."""

    def body(s):
        path = placed(s, archive)
        s.capture("project.import.abandon.refused-none", "project", "import", "--abandon")
        s.capture("project.imports.none", "project", "imports")
        s.capture("status.import-empty", "status")
        s.capture("project.import.plan", "project", "import", str(path), "--plan")
        s.capture("project.import", "project", "import", str(path))
        s.capture("status.import-done", "status")
        s.capture("project.imports", "project", "imports")
        s.capture("project.imports.lookup", "project", "imports", "SLICE-002")
        s.capture("project.imports.lookup-none", "project", "imports", "SLICE-099")
        s.capture("project.import.already", "project", "import", str(path), "--plan")
        # Marking ready what was ready there, for this import already done: it stops at the principles not yet published,
        # then, once they are, carries on.
        s.capture("project.imports.ready.stopped", "project", "imports", "ready")
        s.ok(s.a, "principle", "publish")
        s.capture("project.imports.ready", "project", "imports", "ready")
        s.capture("project.imports.ready.again", "project", "imports", "ready")

    run(Scenario, body)


def joining(Scenario, archive: Path) -> None:
    """A repository with its own project, one epic and a slice: the project joins it with new numbers."""

    def body(s):
        path = placed(s, archive)
        s.ok(s.a, "project", "init", "--id", "workbench", "--name", "Workbench", "--vision", "Teams book shared rooms.",
             "--outcome", "Rooms are never double-booked")
        s.ok(s.a, "epic", "add", "--title", "Rooms", "--criterion", "Every room has a calendar")
        s.drafted(title="Add a room")
        s.capture("project.import.plan-join", "project", "import", str(path), "--plan")
        # Brought in with "also mark ready": the import is done, and marking ready says where it stopped.
        s.capture("project.import.join", "project", "import", str(path), "--ready")
        s.capture("project.imports.lookup-join", "project", "imports", "SLICE-001")

    run(Scenario, body)


def stopped(Scenario, archive: Path) -> None:
    """Bringing it in stopped part way (the process killed after four files): what status says, the export refused, a
    look at the same file again, then set aside."""

    def body(s):
        path = placed(s, archive)
        killer = s.root / "killer.py"
        killer.write_text(KILLER.format(scripts=str(STUDIO)))
        subprocess.run([sys.executable, "-B", str(killer), "4", "--project", str(s.a), "--app", "project", "import", str(path)],
                       capture_output=True, text=True, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        s.capture("status.import-unfinished", "status")
        s.capture("project.export.refused-unfinished", "project", "export")
        s.capture("project.imports.unfinished", "project", "imports")
        s.capture("project.import.plan-resuming", "project", "import", str(path), "--plan")
        s.capture("project.import.abandon", "project", "import", "--abandon")
        s.capture("status.import-set-aside", "status")
        s.capture("project.imports.set-aside", "project", "imports")

    run(Scenario, body)
