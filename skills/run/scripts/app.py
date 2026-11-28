#!/usr/bin/env python3
"""MACH's two apps in the browser: Product Studio (/mach-studio) and the Factory Floor (/mach floor).

    app.py                      Product Studio for this project, the release MACH has here, open in the browser
    app.py link                 the same, without a browser: a fresh link to open
    app.py stop                 stop this project's Product Studio
    app.py floor [link|stop]    the same three for the Factory Floor
    --no-browser  never open a browser      --json  answer in JSON      --project <folder>

    app.py for-skill studio|run   what the studio and run skills' first line runs, with the words the person typed after
                                  the command on standard input. It does something, and prints anything, only when those
                                  words are exactly an app's own form: for studio, nothing at all (open), "link" or
                                  "stop"; for run, "floor", "floor link", "floor stop" or "studio". Every other input
                                  prints nothing, so the skill goes on as usual. What it prints stands between the lines
                                  MACH-ANSWER-BEGIN and MACH-ANSWER-END. The words never reach a shell: the skill hands them over
                                  in a quoted here-document, and they are only compared here.

Every step is decided here, with no judgement left to whoever runs it:

1. Which release: the MACH this script belongs to (the plugin's or checkout's .claude-plugin/plugin.json, or the
   project's install record, .factory/.mach-manifest.json). Which program: a copy built in a MACH checkout when it is
   that release (or a local build, "dev"); otherwise .factory/bin/<program>, which MACH's installer brings to that
   release first (`mach programs`: the same download and the same checksum and provenance checks as `install`).
   A program that cannot be fetched never stops the app: the one here is used, and the answer says why and how to
   bring it up to date.
2. Whether one runs: the program holds an exclusive lock on its folder's `lock` file while it runs, and writes
   `host.json` (its release, process and port) and `link` (the next unused one-time link) beside it. The release that
   runs is reused; an older one is stopped (SIGTERM, only after its command line shows it is this program for this
   project) and the right one started. A lock left by a program that is gone is free, so its files are ignored.
3. Starting: in its own session and process group, detached from this command so it keeps running for the session,
   output to `app.log` in its folder; Product Studio with `--project`, `--engine` (this MACH's studio.py) and
   `--no-open`; the Factory Floor with `--project` and `--mach-run` (this MACH's run.py).
4. Opening: the link, checked to be a loopback one-time link, is passed to this computer's own opener (`open` on
   macOS, `xdg-open` on Linux) and to nothing else. Once opened it is spent, so the answer gives the fresh one.

Tests replace `start_detached`, `process_alive`, `command_line`, `open_in_browser`, `signal_process`, `lock_held` and
`run_installer`, and set MACH_APP_NO_START, so no test can start a program or open a browser. Standard library only.
"""

import argparse
import errno
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

try:
    import fcntl
except ImportError:  # Windows: MACH's programs are built for macOS and Linux only
    fcntl = None  # type: ignore

NO_START_ENV = "MACH_APP_NO_START"  # set (to anything) and nothing here starts a program, signals one or opens a browser
LINK_RE = re.compile(r"^http://127\.0\.0\.1:\d{1,5}/\?t=[A-Za-z0-9_-]{16,}$")
PRINTED_RE = re.compile(r"^Open: (\S+)\s*$", re.MULTILINE)
START_WAIT = 30.0  # seconds a starting program has to show its link
STOP_WAIT = 20.0  # seconds a stopped program has to let go of its lock (Product Studio ends its interviews first)
FRESH_WAIT = 5.0  # seconds to wait, after a browser opened a link, for the program's next one
POLL = 0.1
MANIFEST = ".factory/.mach-manifest.json"


class App(NamedTuple):
    key: str        # "studio" or "floor"
    title: str      # how a person reads it, at the start of a sentence
    program: str    # the program's file name
    folder: str     # its own folder in the project: lock, host.json, link, app.log
    build: str      # a copy built in a MACH checkout, relative to the checkout
    held: str       # what it says when another one runs for the project


STUDIO = App("studio", "Product Studio", "mach-studio", ".factory/local/studio", "apps/studio/bin/mach-studio",
             "another Product Studio is already running for this project")
FLOOR = App("floor", "The Factory Floor", "mach-observer", ".factory/local/observer", "apps/observer/bin/mach-observer",
            "another observer is already running for this project")
APPS = {"studio": STUDIO, "floor": FLOOR}


class Stop(Exception):
    """Nothing is running and there is nothing to give: the sentence says why and what to do."""


# ---- where MACH is ----


def mach_root() -> Path:
    """The MACH this script belongs to: the plugin or checkout folder (skills/run/scripts/app.py), or, in a project
    install, the project's .claude folder (.claude/skills/mach/scripts/app.py)."""
    return Path(__file__).resolve().parents[3]


def plugin_version(root: Path) -> Optional[str]:
    try:
        return json.loads((root / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def installed_version(root: Path, project: Path) -> Optional[str]:
    """The MACH release whose programs belong here: the plugin's (or checkout's), else the project's install record."""
    version = plugin_version(root)
    if version:
        return version
    try:
        return json.loads((project / MANIFEST).read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError, AttributeError):
        return None


def plugin_form(root: Path) -> bool:
    return (root / ".claude-plugin").is_dir()


def command_name(root: Path, app: "App") -> str:
    """How a person types the command that opens `app`: /mach-studio and /mach floor in a project install,
    /mach:studio and /mach:run floor with the plugin."""
    if app is STUDIO:
        return "/mach:studio" if plugin_form(root) else "/mach-studio"
    return "/mach:run floor" if plugin_form(root) else "/mach floor"


def sibling_script(skill: str, script: str) -> Optional[Path]:
    """Another MACH skill's script beside this one: skills/<skill>/ in the plugin, .claude/skills/mach-<skill>/ (or
    .claude/skills/mach/ for the run skill) in a project."""
    skills = Path(__file__).resolve().parents[2]
    for name in (skill, "mach" if skill == "run" else f"mach-{skill}"):
        path = skills / name / "scripts" / script
        if path.is_file():
            return path
    return None


def find_project(start: Path) -> Path:
    """The nearest folder at or above `start` that holds .factory or .git, as the programs find it; `start` when none."""
    start = start.resolve()
    for folder in (start, *start.parents):
        if (folder / ".factory").exists() or (folder / ".git").exists():
            return folder
    return start


def installer(root: Path, project: Path) -> Optional[Path]:
    """MACH's installer: the plugin's or checkout's bin/mach, else the copy the installer keeps in the project."""
    for path in (root / "bin" / "mach", project / ".factory" / "bin" / "mach"):
        if path.is_file():
            return path
    return None


# ---- what the tests replace ----


def run_installer(path: Path, argv: List[str]) -> Tuple[int, str, str]:
    """Run MACH's installer with these arguments; (exit status, stdout, stderr)."""
    try:
        done = subprocess.run([sys.executable, str(path), *argv], capture_output=True, text=True, timeout=600, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, "", str(exc)
    return done.returncode, done.stdout, done.stderr


def program_version(path: Path) -> Optional[str]:
    """The release a program says it was built for ('<name> <release>' from --version); None when it cannot say."""
    try:
        done = subprocess.run([str(path), "--version"], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    words = done.stdout.split()
    return words[1] if done.returncode == 0 and len(words) == 2 else None


def start_detached(argv: List[str], cwd: Path, log: Path) -> int:
    """Start a program in its own session and process group, detached from this command, its output appended to `log`."""
    if os.environ.get(NO_START_ENV):
        raise OSError(f"starting MACH's apps is switched off in this environment ({NO_START_ENV} is set)")
    with open(str(log), "ab") as out:
        os.chmod(str(log), 0o600)
        process = subprocess.Popen(argv, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=out, stderr=out, start_new_session=True, close_fds=True)
    return process.pid


def process_alive(pid: int) -> bool:
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    try:  # a child of this command that has exited is a zombie until it is reaped: it is not running
        done, _ = os.waitpid(pid, os.WNOHANG)
        return done == 0
    except ChildProcessError:
        return True


def command_line(pid: int) -> str:
    """A process's whole command line, from ps; "" when it cannot be read."""
    try:
        done = subprocess.run(["ps", "-ww", "-o", "command=", "-p", str(int(pid))], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError, ValueError):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def all_processes() -> List[Tuple[int, str]]:
    """Every process on this computer as (pid, command line), from ps; [] when it cannot be read."""
    try:
        done = subprocess.run(["ps", "-ww", "-axo", "pid=,command="], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return []
    found = []
    for line in done.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isdigit():
            found.append((int(parts[0]), parts[1]))
    return found


def signal_process(pid: int) -> None:
    if os.environ.get(NO_START_ENV):
        raise OSError(f"stopping MACH's apps is switched off in this environment ({NO_START_ENV} is set)")
    os.kill(pid, signal.SIGTERM)


def lock_held(path: Path) -> bool:
    """Whether a running program holds its exclusive lock on `path`. A missing file, or one nobody holds, is not held.
    The file is opened without being created or followed, and the probe lets go at once."""
    if fcntl is None:
        return False
    try:
        fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        return exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES)
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def browser_opener() -> Optional[str]:
    """This computer's own opener for a web address: `open` on macOS, `xdg-open` on Linux; None elsewhere."""
    system = platform.system()
    name = "open" if system == "Darwin" else "xdg-open" if system == "Linux" else None
    return shutil.which(name) if name else None


def open_in_browser(link: str) -> Optional[str]:
    """Open the link with this computer's own opener, the link as its one argument; None, or why it could not."""
    if os.environ.get(NO_START_ENV):
        return f"opening a browser is switched off in this environment ({NO_START_ENV} is set)"
    if not LINK_RE.match(link):
        return "the link is not one of MACH's own"
    opener = browser_opener()
    if opener is None:
        return "this computer has no browser opener MACH knows (open on macOS, xdg-open on Linux)"
    try:
        done = subprocess.run([opener, link], capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return f"{Path(opener).name} could not run ({exc.__class__.__name__})"
    if done.returncode != 0:
        return f"{Path(opener).name} did not open it"
    return None


# ---- the program's own files ----


def private_file(path: Path, limit: int = 4096) -> Optional[str]:
    """A small regular file, never followed through a link; None when it is missing or not one."""
    try:
        fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not (info.st_mode & 0o170000 == 0o100000) or info.st_size > limit:
            return None
        return os.read(fd, limit).decode("utf-8", "replace")
    finally:
        os.close(fd)


def read_link(folder: Path) -> Optional[str]:
    text = (private_file(folder / "link") or "").strip()
    return text if LINK_RE.match(text) else None


def read_host(folder: Path) -> Dict[str, Any]:
    try:
        host = json.loads(private_file(folder / "host.json") or "")
    except ValueError:
        return {}
    return host if isinstance(host, dict) else {}


def is_ours(app: App, pid: int, project: Path) -> bool:
    """Whether a process is verifiably this project's `app`: its program is named exactly that and its command line
    names this project with --project. Nothing else is ever signalled."""
    if type(pid) is not int or pid <= 0 or pid == os.getpid() or not process_alive(pid):
        return False
    words = command_line(pid)
    return bool(words) and Path(words.split()[0]).name == app.program and names_project(words, project)


def names_project(words: str, project: Path) -> bool:
    """Whether a command line passes exactly this project with --project (not a folder whose name starts the same)."""
    return f" --project {project} " in f" {words} "


def find_running(app: App, project: Path) -> Optional[Dict[str, Any]]:
    """The program running for this project, or None: {"pid": int or None, "version": str or None}. The lock says
    whether one runs; host.json which release and process it is. A program from before host.json was written says
    neither, so its process is looked for by its command line (exactly one, or none is named)."""
    folder = project / app.folder
    if not lock_held(folder / "lock"):
        return None
    host = read_host(folder)
    pid = host.get("pid")
    if host.get("program") == app.program and type(pid) is int and is_ours(app, pid, project):
        return {"pid": pid, "version": host.get("version") if isinstance(host.get("version"), str) else None}
    found = [pid for pid, words in all_processes()
             if words.split() and Path(words.split()[0]).name == app.program and names_project(words, project) and pid != os.getpid()]
    return {"pid": found[0] if len(found) == 1 else None, "version": None}


def stop_running(app: App, running: Dict[str, Any], project: Path) -> Optional[str]:
    """Stop the running program, checked again just before it is signalled. None, or why it was not stopped."""
    pid = running.get("pid")
    if pid is None or not is_ours(app, pid, project):
        return "MACH cannot tell which process it is"
    try:
        signal_process(pid)
    except OSError as exc:
        return str(exc)
    deadline = time.monotonic() + STOP_WAIT
    while time.monotonic() < deadline:
        if not lock_held(project / app.folder / "lock"):
            return None
        time.sleep(POLL)
    return f"it did not stop within {int(STOP_WAIT)} seconds"


def prepare_folder(project: Path, app: App) -> Path:
    """The program's own folder (made private when missing); a link in its place is refused."""
    folder = project / app.folder
    for path in (project / ".factory" / "local", folder):
        if path.is_symlink():
            raise Stop(f"{path.relative_to(project)} is a symbolic link, so MACH does not start {article(app)} there.")
        if not path.is_dir():
            path.mkdir(mode=0o700)
    return folder


def article(app: App) -> str:
    return "Product Studio" if app is STUDIO else "the Factory Floor"


# ---- which program ----


def choose_program(app: App, root: Path, project: Path, version: Optional[str], check_newer: bool) -> Dict[str, Any]:
    """The program to start: {"path", "version", "updated", "problem", "newer"}. path is None when there is none."""
    chosen: Dict[str, Any] = {"path": None, "version": None, "updated": False, "problem": None, "newer": None}
    built = root / app.build
    if built.is_file():
        found = program_version(built)
        if found == "dev" or (found and found == version):
            chosen.update(path=built, version=found)
            return chosen
    here = project / ".factory" / "bin" / app.program
    mach = installer(root, project)
    if mach is None:
        chosen["problem"] = "MACH's installer is not in this project, so MACH could not check the program here."
    elif version:
        argv = ["programs", "--project", str(project), "--only", app.program, "--release", version, "--json"] + (["--newer"] if check_newer else [])
        code, out, err = run_installer(mach, argv)
        try:
            answer = json.loads(out)
            result = answer["programs"][0]
            chosen.update(updated=bool(result.get("updated")), problem=result.get("problem"), newer=answer.get("newer"))
        except (ValueError, KeyError, IndexError, TypeError):
            said = " ".join((err or out).split())
            said = said[len("error: "):] if said.startswith("error: ") else said
            chosen["problem"] = (said[:300].rstrip(".") + ".") if said else "MACH's installer could not check the program here."
    if here.is_file():
        chosen.update(path=here, version=program_version(here))
    return chosen


# ---- the one command ----


def words_of(version: Optional[str]) -> str:
    return "a local build" if version == "dev" else (version or "an earlier release")


def named(app: App, version: Optional[str]) -> str:
    """'Product Studio 0.26.0', 'Product Studio (a local build)', or just 'Product Studio' when its release is not known."""
    return f"{app.title} {version}" if version and version != "dev" else f"{app.title} (a local build)" if version == "dev" else app.title


def act(app: App, action: str, project: Path, browser: bool, check_newer: bool = True) -> Dict[str, Any]:
    root = mach_root()
    command = command_name(root, app)
    result: Dict[str, Any] = {"app": app.key, "action": action, "opened": False, "running": None, "version": None, "link": None,
                              "program": None, "updated_program": False, "log": None, "in_words": [], "problem": None}
    said: List[str] = result["in_words"]
    if not (project / ".factory").is_dir():
        raise Stop(f"{project} has no .factory folder, so MACH cannot keep {article(app)} running for it. "
                   f"Run MACH's installer in this project (or /mach:init with the plugin), then {command} again.")
    folder = project / app.folder
    running = find_running(app, project)

    if action == "stop":
        if running is None:
            said.append(f"{app.title} was not running for this project.")
            return result
        why = stop_running(app, running, project)
        if why:
            result["problem"] = f"{app.title} is running for this project, but MACH did not stop it: {why}."
            said.append(result["problem"] + f" Quitting the program named {app.program} (in Activity Monitor on a Mac) stops it.")
        else:
            said.append(f"{app.title} is stopped.")
        return result

    version = installed_version(root, project)
    program = choose_program(app, root, project, version, check_newer)
    result.update(program=str(program["path"]) if program["path"] else None, updated_program=program["updated"])
    right = program["path"] is not None and (program["version"] == "dev" or (version is not None and program["version"] == version))
    notes: List[str] = []
    if program["path"] is not None and not right:
        why = f" ({program['problem'].rstrip('.')})" if program["problem"] else ""
        notes.append(f"This {article(app)} is for MACH {words_of(program['version'])}, not {version}{why}. "
                     "Running MACH's installer again brings it up to date.")
    if program["newer"]:
        notes.append(f"MACH {program['newer']} is available; this project has {version}. Running MACH's installer again updates it.")

    replaced, replaced_from = False, None
    if running is not None:
        # Replaced only by the right release: an older program here never stops a newer one that runs.
        same = running["version"] is not None and running["version"] == program["version"]
        if program["path"] is None or same or not right:
            result["running"] = "already"
        else:
            why = stop_running(app, running, project)
            if why:
                result["running"] = "already"
                notes.append(f"{app.title} from MACH {words_of(running['version'])} is running for this project, and MACH left it running "
                             f"because {why}. To start {words_of(program['version'])}, stop that one, then {command} again.")
            else:
                replaced, replaced_from = True, running["version"]
                running = None
    if running is None:
        if program["path"] is None:
            why = program["problem"] or "MACH's installer did not fetch it"
            raise Stop(f"{app.title} is not installed on this computer ({why.rstrip('.')}). "
                       f"Running MACH's installer again in this project fetches it; then {command} again.")
        link, log = start(app, project, Path(program["path"]), command)
        result.update(log=str(log), version=program["version"], running="replaced" if replaced else "started")
    else:
        link = read_link(folder)
        result["version"] = running["version"] or program["version"]
        log = folder / "app.log"
        result["log"] = str(log) if log.is_file() else None
        if link is None:
            raise Stop(f"{app.title} is running for this project but has no unused link left. "
                       f"{command} stop, then {command}, starts it again with a new one.")

    shown = result["version"]
    if result["running"] == "replaced":
        said.append(f"An older {app.title.replace('The ', '')} ({words_of(replaced_from)}) was running for this project; "
                    f"MACH stopped it and started {words_of(shown)}.")
        if app is STUDIO:
            said.append("Your drafts were saved as you wrote them; a reply the interviewer was still writing was stopped, and you can ask again.")

    if browser and action == "open":
        why = open_in_browser(link)
        if why is None:
            result["opened"] = True
            said.insert(0, f"{named(app, shown)} is open in your browser.")
            if result["running"] == "already":
                said.insert(1, "It was already running.")
            fresh = wait_for_fresh(folder, link)
            result["link"] = fresh
            said.append(f"For another browser on this computer, this link works once: {fresh}" if fresh
                        else f"For another browser on this computer, {command} link gives a fresh link.")
        else:
            result["link"] = link
            result["problem"] = f"MACH could not open a browser here: {why}."
            said.insert(0, f"{named(app, shown)} is running, but MACH could not open a browser here: {why}.")
            said.append(f"Open this link in a browser on this computer; it works once: {link}")
    else:
        result["link"] = link
        was = "was already" if result["running"] == "already" else "is"
        said.insert(0, f"{named(app, shown)} {was} running on this computer.")
        said.append(f"Open this link in a browser on this computer; it works once: {link}")
    said.extend(notes)
    if program["problem"] and not right and not result["problem"]:
        result["problem"] = program["problem"]
    return result


def start(app: App, project: Path, program: Path, command: str) -> Tuple[str, Path]:
    """Start the program detached, and wait for its link: (link, log)."""
    folder = prepare_folder(project, app)
    log = folder / "app.log"
    if log.is_symlink():
        raise Stop(f"{log.relative_to(project)} is a symbolic link, so MACH does not write {article(app)}'s output through it.")
    argv = [str(program), "--project", str(project)]
    if app is STUDIO:
        engine = sibling_script("studio", "studio.py")
        argv += (["--engine", str(engine)] if engine else []) + ["--no-open"]
    else:
        run_py = sibling_script("run", "run.py")
        argv += ["--mach-run", str(run_py)] if run_py else []
    offset = log.stat().st_size if log.is_file() else 0
    try:
        pid = start_detached(argv, project, log)
    except OSError as exc:
        raise Stop(f"MACH could not start {article(app)}: {exc}.")
    deadline = time.monotonic() + START_WAIT
    while time.monotonic() < deadline:
        host = read_host(folder)
        if host.get("pid") == pid:
            link = read_link(folder)
            if link:
                return link, log
        printed = PRINTED_RE.search(read_from(log, offset))
        if printed and LINK_RE.match(printed.group(1)) and host.get("pid") is None:
            return read_link(folder) or printed.group(1), log  # a program from before host.json: its printed link
        if not process_alive(pid):
            said = last_words(read_from(log, offset), app)
            raise Stop(f"{app.title} stopped as it started: {said} Its output is in {log.relative_to(project)}.")
        time.sleep(POLL)
    raise Stop(f"{app.title} did not show its link within {int(START_WAIT)} seconds. It may still be starting: "
               f"{command} link gives its link once it is ready. Its output is in {log.relative_to(project)}.")


def read_from(log: Path, offset: int) -> str:
    try:
        with open(str(log), "rb") as handle:
            handle.seek(offset)
            return handle.read(64 * 1024).decode("utf-8", "replace")
    except OSError:
        return ""


def last_words(text: str, app: App) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    line = lines[-1] if lines else "it said nothing"
    line = line[len(app.program) + 2:] if line.startswith(app.program + ": ") else line
    return (line[:300].rstrip(".") + ".")


def wait_for_fresh(folder: Path, used: str) -> Optional[str]:
    """After a browser opened `used`, the program's next unused link, once it has made it."""
    deadline = time.monotonic() + FRESH_WAIT
    while time.monotonic() < deadline:
        link = read_link(folder)
        if link and link != used:
            return link
        time.sleep(POLL)
    return None


USAGE = ("MACH did not understand {words!r}. {studio} opens Product Studio; {studio} link gives its link without a browser; "
         "{studio} stop stops it. {floor}, {floor} link and {floor} stop do the same for the Factory Floor.")

ANSWER_BEGIN = "MACH-ANSWER-BEGIN"
ANSWER_END = "MACH-ANSWER-END"
EXECUTION_ENV = "MACH_EXECUTION_ID"  # set inside a supervised Factory execution, where no app is ever opened
SKILL_FORMS = {
    # (skill, the words typed after its command) -> (app, action)
    ("studio", ""): ("studio", "open"),
    ("studio", "link"): ("studio", "link"),
    ("studio", "stop"): ("studio", "stop"),
    ("run", "floor"): ("floor", "open"),
    ("run", "floor link"): ("floor", "link"),
    ("run", "floor stop"): ("floor", "stop"),
    ("run", "studio"): ("studio", "open"),
}
WORDS_LIMIT = 4096  # more than any app form: a longer input is never one


def skill_form(skill: str, typed: str) -> Optional[Tuple[str, str]]:
    """The app and action the person's words name for this skill, or None when they are anything else. Case and the
    spaces around and between words do not count; nothing else is forgiven."""
    return SKILL_FORMS.get((skill, " ".join(typed.lower().split())))


def terminal_line(root: Path) -> str:
    studio = command_name(root, STUDIO)
    return f"To work here in the terminal instead, type {studio} status, or say what you want after {studio}."


def for_skill(skill: str, typed: str, project: Optional[Path]) -> str:
    """What a skill's first line shows before the model replies: MACH's answer between its two lines, or "" (print
    nothing) for any words that are not exactly an app's own form, and always inside a supervised Factory execution."""
    form = skill_form(skill, typed)
    if form is None or os.environ.get(EXECUTION_ENV):
        return ""
    app, action = APPS[form[0]], form[1]
    project = project.resolve() if project else find_project(Path.cwd())
    try:
        said = list(act(app, action, project, browser=True)["in_words"])
    except Stop as stop:
        said = [str(stop)]
    if app is STUDIO and action == "open":
        said.append(terminal_line(mach_root()))
    return "\n".join([ANSWER_BEGIN, *said, ANSWER_END]) + "\n"


def read_typed(stream: Any) -> Optional[str]:
    """The person's words from standard input, or None when there are none to read (a terminal) or too many."""
    try:
        if stream is None or stream.isatty():
            return None
        text = stream.read(WORDS_LIMIT + 1)
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return text if len(text) <= WORDS_LIMIT else None


def parse(argv: List[str]) -> Tuple[argparse.Namespace, Optional[str]]:
    parser = argparse.ArgumentParser(prog="app.py", description=__doc__.split("\n")[0])
    parser.add_argument("words", nargs="*", help="[floor] [open|link|stop]")
    parser.add_argument("--no-browser", action="store_true", help="never open a browser; give the link")
    parser.add_argument("--json", action="store_true", help="answer in JSON")
    parser.add_argument("--project", type=Path, default=None, help="the project folder (default: the nearest one at or above this folder)")
    args = parser.parse_args(argv)
    words = [word for text in args.words for word in text.lower().split()]
    app, action, unknown = "studio", "open", []
    for word in words:
        if word in ("floor", "observer", "factory-floor"):
            app = "floor"
        elif word in ("studio", "product-studio"):
            app = "studio"
        elif word in ("open", "link", "stop"):
            action = word
        else:
            unknown.append(word)
    args.app, args.action = app, action
    return args, (" ".join(unknown) if unknown else None)


def main_for_skill(argv: List[str], stdin: Any = None) -> int:
    """`app.py for-skill <studio|run> [--project <folder>]`, the words on standard input. Always succeeds, so a skill
    never fails to load because of it; anything unexpected prints nothing."""
    skill = argv[0] if argv else ""
    project = None
    if len(argv) == 3 and argv[1] == "--project":
        project = Path(argv[2])
    elif len(argv) != 1:
        return 0
    if skill not in ("studio", "run"):
        return 0
    typed = read_typed(sys.stdin if stdin is None else stdin)
    if typed is None:
        return 0
    try:
        sys.stdout.write(for_skill(skill, typed, project))
    except Exception:  # never stop a skill from loading; the fault recorder below still hears of it
        return 0
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["for-skill"]:
        return main_for_skill(argv[1:])
    args, unknown = parse(argv)
    app = APPS[args.app]
    if unknown:
        result = {"app": app.key, "action": None, "opened": False, "running": None, "version": None, "link": None, "program": None,
                  "updated_program": False, "log": None,
                  "problem": USAGE.format(words=unknown, studio=command_name(mach_root(), STUDIO), floor=command_name(mach_root(), FLOOR))}
        result["in_words"] = [result["problem"]]
        code = 2
    else:
        project = (args.project.resolve() if args.project else find_project(Path.cwd()))
        try:
            result = act(app, args.action, project, browser=not args.no_browser)
            # 0 whenever the app runs and its link was given (or opened), even if the browser could not be opened.
            code = (1 if result["problem"] else 0) if args.action == "stop" else (0 if result["running"] else 1)
        except Stop as stop:
            result = {"app": app.key, "action": args.action, "opened": False, "running": None, "version": None, "link": None, "program": None,
                      "updated_program": False, "log": None, "problem": str(stop), "in_words": [str(stop)]}
            code = 1
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("\n".join(result["in_words"]))
    return code


if __name__ == "__main__":
    import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
    sys.exit(main())
