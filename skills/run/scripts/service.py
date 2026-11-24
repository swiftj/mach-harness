#!/usr/bin/env python3
"""How the Factory Supervisor is started, woken or kept running: a detached start, Git hooks and a macOS LaunchAgent.

The detached start (start_detached) runs the supervisor as its own process group, its output in
.factory/local/supervisor.log, in one of two lifetimes:

    session     what `pull`, a recorded decision and `resume` start. It belongs to the Claude Code session it was
                started from (find_session_pid) and, when that session ends, stops its executions and exits. Nothing
                is lost: the next pull carries each ticket on from the stage it reached.
    background  what `factory start` (= `factory enable`) starts, and what the LaunchAgent runs. It runs until stopped.

Neither hooks nor the LaunchAgent is installed by cloning, installing or initialising MACH. Each is
installed only when a person asks for it (factory enable --hooks, --persistent), and each is removed
again when the Factory is disabled.

Git hooks are a courtesy, not a control. A hook only leaves a note ("something changed") for a
supervisor that is already enabled; it starts no agent, cannot fail the Git command it runs
after, and is not what authorizes anything. The supervisor reconciles on start-up and on a timer,
so a missed hook costs time, never work.

The hook text is added between markers to whatever hook file already exists, so a project's own
hooks keep working, and only the marked lines are removed again. core.hooksPath is never set; if
a project already uses it, hooks are left alone.

The LaunchAgent is a per-user service definition under ~/Library/LaunchAgents that runs the
supervisor for one project. It binds no port and listens to nothing.

Standard library only.
"""

import hashlib
import os
import plistlib
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HOOKS = ("post-merge", "post-checkout", "post-rewrite")
BEGIN = "# >>> mach factory wake (advisory; safe to remove) >>>"
END = "# <<< mach factory wake <<<"
CREATED = "# Created by MACH for the Factory's wake-up note. No other content."


class ServiceError(Exception):
    """A problem the caller can fix; run.py prints it as a refusal."""


def git(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(root), capture_output=True, text=True)


def log_path(root: Path) -> Path:
    return root / ".factory" / "local" / "supervisor.log"


NO_START_ENV = "MACH_FACTORY_NO_START"  # set (to anything) and no supervisor is started from this environment: tests set it


def serve_argv(root: Path, run_script: Path, lifetime: str = "background", session_pid: Optional[int] = None, started_by: Optional[str] = None) -> List[str]:
    argv = [sys.executable, str(run_script), "--project", str(root), "factory", "serve"]
    if lifetime == "session":
        argv += ["--lifetime", "session", "--session-pid", str(int(session_pid))]
    if started_by:
        argv += ["--started-by", started_by]
    return argv


# ---- the Claude Code session a supervisor belongs to ----


def parent_of(pid: int) -> Tuple[Optional[int], str]:
    """(parent pid, command name) of a process, from ps; (None, "") when it cannot be read. Replaced in tests."""
    try:
        done = subprocess.run(["ps", "-o", "ppid=,comm=", "-p", str(int(pid))], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None, ""
    line = done.stdout.strip()
    if done.returncode != 0 or not line:
        return None, ""
    parts = line.split(None, 1)
    try:
        return int(parts[0]), (parts[1] if len(parts) > 1 else "")
    except ValueError:
        return None, ""


def find_session_pid(start: Optional[int] = None) -> Optional[int]:
    """The Claude Code process this command descends from: the nearest ancestor whose program is named claude; failing that,
    the top-most ancestor that is not pid 1 (the session leader). None when no ancestor can be read. Replaced in tests."""
    pid = start if start is not None else os.getpid()
    chain: List[Tuple[int, str]] = []
    seen = set()
    while pid and pid > 1 and pid not in seen and len(chain) < 64:
        seen.add(pid)
        parent, name = parent_of(pid)
        if parent is None:
            break
        if pid != (start if start is not None else os.getpid()):
            chain.append((pid, name))
        pid = parent
    for ancestor, name in chain:
        if Path(name.strip()).name.lower() in ("claude", "claude.exe") or Path(name.strip()).name.lower().startswith("claude"):
            return ancestor
    return chain[-1][0] if chain else None


def start_detached(root: Path, run_script: Path, lifetime: str = "background", session_pid: Optional[int] = None, started_by: Optional[str] = None) -> int:
    """Start `factory serve` for this project in its own session and process group, detached from the caller, with its
    output appended to .factory/local/supervisor.log. Returns its process ID.

    lifetime "session": the supervisor watches `session_pid` (the Claude Code process it was started from) and pauses its
    work and exits when that ends. "background": it runs until stopped. Tests replace this function, and set
    MACH_FACTORY_NO_START so a subprocess they run can never start one."""
    if os.environ.get(NO_START_ENV):
        raise ServiceError(f"Starting the supervisor is switched off in this environment ({NO_START_ENV} is set).")
    if lifetime == "session" and not session_pid:
        raise ServiceError("A supervisor tied to this session needs the session's process, and none was given.")
    log = log_path(root)
    for path in (root / ".factory", log.parent, log):
        if path.is_symlink():
            raise ServiceError(f"{path} is a symbolic link; the supervisor's log is not written through one.")
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("ab") as out:
        os.chmod(str(log), 0o600)
        process = subprocess.Popen(serve_argv(root, run_script, lifetime, session_pid, started_by), cwd=str(root), stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                                   start_new_session=True, close_fds=True)
    return process.pid


def hooks_dir(root: Path) -> Optional[Path]:
    """This repository's own hooks folder, or None when the project manages hooks itself."""
    if git(root, "config", "--get", "core.hooksPath").stdout.strip():
        return None
    found = git(root, "rev-parse", "--git-path", "hooks").stdout.strip()
    return (root / found).resolve() if found else None


def block(root: Path, run_script: Path, event: str) -> str:
    """The lines added to a hook. In the background, silent, and unable to fail the Git command."""
    command = " ".join(shlex.quote(part) for part in (sys.executable, str(run_script), "--project", str(root), "factory", "wake", "--event", event))
    return f"{BEGIN}\n( {command} >/dev/null 2>&1 & ) >/dev/null 2>&1 || true\n{END}\n"


def strip(text: str) -> str:
    out, skipping = [], False
    for line in text.splitlines(keepends=True):
        if line.strip() == BEGIN:
            skipping = True
        elif line.strip() == END:
            skipping = False
        elif not skipping:
            out.append(line)
    return "".join(out)


def install_hooks(root: Path, run_script: Path) -> Dict[str, Any]:
    folder = hooks_dir(root)
    if folder is None:
        return {"installed": [], "skipped": "This project sets core.hooksPath and manages its own hooks, so none were added. The supervisor still looks on a timer."}
    folder.mkdir(parents=True, exist_ok=True)
    installed = []
    for event in HOOKS:
        path = folder / event
        if path.is_symlink():
            continue  # somebody else's arrangement: leave it alone
        existing = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
        body = strip(existing)
        if not body.strip():
            body = f"#!/bin/sh\n{CREATED}\n"
        elif not body.endswith("\n"):
            body += "\n"
        path.write_text(body + block(root, run_script, event), encoding="utf-8")
        os.chmod(str(path), (path.stat().st_mode | 0o755) if existing else 0o755)
        installed.append(event)
    return {"installed": installed, "skipped": None}


def remove_hooks(root: Path) -> List[str]:
    folder = hooks_dir(root)
    removed = []
    for event in HOOKS if folder else ():
        path = folder / event
        if not path.is_file() or path.is_symlink():
            continue
        existing = path.read_text(encoding="utf-8", errors="replace")
        if BEGIN not in existing:
            continue
        body = strip(existing)
        if body.strip() in ("#!/bin/sh", f"#!/bin/sh\n{CREATED}"):
            path.unlink()  # MACH created it and nothing else is in it
        else:
            path.write_text(body, encoding="utf-8")
        removed.append(event)
    return removed


def hooks_status(root: Path) -> List[str]:
    folder = hooks_dir(root)
    return [event for event in HOOKS if folder and (folder / event).is_file() and BEGIN in (folder / event).read_text(encoding="utf-8", errors="replace")]


# ---- a per-user LaunchAgent (macOS), only ever after explicit consent ----


def label(root: Path) -> str:
    return "com.mach.factory." + hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:12]


def agent_path(root: Path) -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{label(root)}.plist"


def launchctl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["launchctl", *args], capture_output=True, text=True)


def install_agent(root: Path, run_script: Path) -> Dict[str, Any]:
    """Register a service that runs this project's supervisor for this user. Binds no port."""
    if sys.platform != "darwin":
        raise ServiceError("A persistent supervisor is only supported on macOS in this version.")
    if shutil.which("launchctl") is None:
        raise ServiceError("launchctl is not available, so the service cannot be registered.")
    path = agent_path(root)
    log = log_path(root)
    definition = {
        "Label": label(root),
        "ProgramArguments": serve_argv(root, run_script),  # a background supervisor: it runs until stopped
        "WorkingDirectory": str(root),
        "RunAtLoad": True,
        # Start it again if it crashes; leave it stopped when it exits cleanly, which it does once the Factory is disabled.
        "KeepAlive": {"SuccessfulExit": False},
        "ProcessType": "Background",
        "StandardOutPath": str(log), "StandardErrorPath": str(log),
        # The commands the line needs (claude, git, gh) are found the way they were when a person enabled this.
        "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(Path.home())},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as out:
        plistlib.dump(definition, out)
    os.chmod(str(path), 0o600)
    domain = f"gui/{os.getuid()}"
    launchctl("bootout", f"{domain}/{label(root)}")  # a stale registration of the same service, if any
    loaded = launchctl("bootstrap", domain, str(path))
    if loaded.returncode != 0:
        path.unlink()
        raise ServiceError("The service could not be registered: " + (loaded.stderr.strip() or loaded.stdout.strip() or "launchctl gave no reason"))
    return {"label": label(root), "definition": str(path), "log": str(log)}


def remove_agent(root: Path) -> bool:
    path = agent_path(root)
    present = path.exists()
    if sys.platform == "darwin" and shutil.which("launchctl") is not None and present:
        launchctl("bootout", f"gui/{os.getuid()}/{label(root)}")
    if present:
        path.unlink()
    return present


def agent_status(root: Path) -> Dict[str, Any]:
    return {"installed": agent_path(root).exists(), "label": label(root), "definition": str(agent_path(root))}
