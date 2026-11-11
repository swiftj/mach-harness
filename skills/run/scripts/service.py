#!/usr/bin/env python3
"""Optional ways the Factory Supervisor is woken or kept running: Git hooks and a macOS LaunchAgent.

Neither is installed by cloning, installing or initialising MACH. Each is installed only as part of
an activation a person confirmed, and each is removed again when the Factory is disabled.

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
from typing import Any, Dict, List, Optional

HOOKS = ("post-merge", "post-checkout", "post-rewrite")
BEGIN = "# >>> mach factory wake (advisory; safe to remove) >>>"
END = "# <<< mach factory wake <<<"
CREATED = "# Created by MACH for the Factory's wake-up note. No other content."


class ServiceError(Exception):
    """A problem the caller can fix; run.py prints it as a refusal."""


def git(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(root), capture_output=True, text=True)


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
    log = root / ".factory" / "local" / "supervisor.log"
    definition = {
        "Label": label(root),
        "ProgramArguments": [sys.executable, str(run_script), "--project", str(root), "factory", "serve"],
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
