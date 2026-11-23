#!/usr/bin/env python3
"""MACH doctor: checks that this workstation and project are ready for the MACH line.

Read-only by default, but for one throwaway ticket workspace it makes and removes to prove one can be made
(check_workspace). It measures and reports; a check that could not be performed is
"not_checked", never "ok". With --fix it creates only the installer's standard data folders that
are missing, and only when .factory/ already exists. It never writes a settings file, never enables
or installs anything, starts no MACH station or agent, and never reads the machine-local Factory
folder (.factory/local/). Its only network access is `gh` (`auth status`, and `label list` and up to five `api`
reads when origin is on github.com), whose output is never shown: only exit codes and parsed fields are used. Standard library only.

MACH's own internal errors are recorded under .factory/local/, so this script never lists them itself: run.py's doctor
command reads them and hands main() the check and its one-line offer (extra_checks, notes), which are shown as given.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

# Mirrors MIN_PYTHON in bin/mach, the installer (tests/test_doctor.py holds the two equal).
MIN_PYTHON = (3, 8)
# Mirrors DATA_DIRS in bin/mach: the folders the installer scaffolds (tests hold the two equal).
DATA_DIRS = (".factory/tickets", ".factory/inbox", ".factory/worktrees", ".factory/archive", "specs/slices")
MANIFEST = ".factory/.mach-manifest.json"
# MACH's own files in a project, which the installer always brings to the installed version: bin/mach's
# OWN_PREFIXES and OWN_FILES (.factory/bin/ holds only MACH's programs). tests/test_doctor.py holds the two the same.
OWN_PREFIXES = (".claude/skills/mach/", ".claude/skills/mach-", ".claude/agents/mach-", ".claude/workflows/mach-", ".factory/bin/", ".factory/mach.mk")
CONFIG = ".factory/config.json"
AUDIT_REPORT = ".factory/audit-report.json"
RULE_FILES = ("CLAUDE.md", "AGENTS.md", "REVIEW.md")
# Only the Studio host: the Factory Floor's program is deliberately not named by any script
# (tests/test_mach_floor.py), so its presence is left to `mach status`.
HOSTS = ((".factory/bin/mach-studio", "Product Studio's visual app"),)
# Mirrors PROVIDERS and the default programs in skills/ticket/scripts/ticket.py.
PROVIDER_PROGRAMS = {"local": None, "github": "gh", "gitea-cli": "gt", "jira": "jira", "fossil": "fossil"}
STATUSES = ("ok", "warn", "fail", "not_checked")
GIT_TIMEOUT = 10
CLAUDE_TIMEOUT = 10
GH_TIMEOUT = 15
# MACH reads and writes GitHub Issues on github.com only, so only that host's sign-in is asked about. Without the
# host, `gh auth status` fails when any other configured host has a bad token, though this one is fine.
GH_HOST = "github.com"
# Words in `gh auth status` output that mean the network, not the sign-in, failed. The output is
# only searched for these; it is never printed, stored or returned.
NETWORK_WORDS = ("error connecting", "could not resolve", "dial tcp", "timeout", "timed out", "no such host",
                 "network is unreachable", "connection refused")


def find_project(start: Path) -> Path:
    start = start.resolve()
    parts = start.parts
    for index in range(len(parts) - 2, 0, -1):
        if parts[index] == "worktrees" and parts[index - 1] == ".factory":
            return Path(*parts[:index - 1])
    for marker in (".factory", ".git"):
        for folder in [start, *start.parents]:
            if (folder / marker).exists():
                return folder
    return start


def check(id_: str, title: str, status: str, detail: str, fix: str = "") -> Dict[str, str]:
    return {"id": id_, "title": title, "status": status, "detail": detail, "fix": fix}


def run(argv: List[str], cwd: Path, timeout: int) -> Tuple[Optional[int], str, str]:
    """Runs one program with an explicit argument list. Returns (None, "", reason) when it could not run."""
    try:
        done = subprocess.run(argv, cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL, check=False)
    except subprocess.TimeoutExpired:
        return None, "", f"did not answer within {timeout} seconds"
    except OSError as exc:
        return None, "", f"could not be started ({exc.strerror or exc})"
    return done.returncode, done.stdout or "", done.stderr or ""


def read_json(path: Path) -> Tuple[Any, str]:
    try:
        return json.loads(path.read_text(encoding="utf-8")), ""
    except OSError as exc:
        return None, f"cannot be read ({exc.strerror or exc})"
    except ValueError as exc:
        return None, f"is not valid JSON ({exc})"


# --- checks -----------------------------------------------------------------------------------

def check_git(project: Path) -> List[Dict[str, str]]:
    title = "Git"
    program = shutil.which("git")
    if not program:
        return [check("git", title, "fail", "Git is not installed or not on PATH.", "Install Git, then run this check again.")]
    code, out, err = run([program, "--version"], project, GIT_TIMEOUT)
    if code != 0:
        return [check("git", title, "not_checked", f"git --version {err.strip() or 'failed'}.", "Check that Git works in a terminal.")]
    version = out.strip()
    code, _, _ = run([program, "rev-parse", "--is-inside-work-tree"], project, GIT_TIMEOUT)
    if code is None:
        return [check("git", title, "not_checked", f"{version}; could not ask Git about the project.", "Check that Git works in this folder.")]
    if code != 0:
        return [check("git", title, "fail", f"{version}; this project is not a Git repository.",
                      "Run 'git init' and make a first commit; MACH builds each ticket in its own Git worktree.")]
    code, _, _ = run([program, "worktree", "list"], project, GIT_TIMEOUT)
    if code is None:
        return [check("git", title, "not_checked", f"{version}; 'git worktree list' did not answer.", "Check that Git works in this folder.")]
    if code != 0:
        return [check("git", title, "fail", f"{version}; 'git worktree list' fails in this project.",
                      "Update Git to a version with worktree support (2.5 or later).")]
    code, _, _ = run([program, "rev-parse", "--verify", "--quiet", "HEAD"], project, GIT_TIMEOUT)
    if code is None:
        return [check("git", title, "not_checked", f"{version}; could not find out whether the project has a commit.", "")]
    if code != 0:
        return [check("git", title, "warn", f"{version}; the repository has no commit yet, so cells work in the project folder itself.",
                      "Make a first commit so each ticket gets its own isolated worktree.")]
    return [check("git", title, "ok", f"{version}; worktrees work and the repository has commits.")]


def check_workspace(project: Path) -> List[Dict[str, str]]:
    """Makes and removes a throwaway ticket workspace the way cell.py does (workspace.py: a sparse worktree that never
    holds .claude/ or .mcp.json), detached so no branch is made, under .factory/worktrees/. Its only writes: that folder
    and Git's record of it, both removed, and extensions.worktreeConfig, which every cell sets anyway."""
    title = "Ticket workspaces"
    folder = project / ".factory" / "worktrees"
    if git_run(project, "rev-parse", "--verify", "--quiet", "HEAD") != 0 or not folder.is_dir():
        return [check("workspace", title, "not_checked", "It needs a Git repository with a commit and MACH's .factory/worktrees folder.")]
    try:
        import importlib.util
        skills = Path(__file__).resolve().parent.parent.parent
        script = next(f / "scripts" / "workspace.py" for f in (skills / "mach-intent", skills / "intent") if (f / "scripts" / "workspace.py").is_file())
        spec = importlib.util.spec_from_file_location("mach_workspace_for_doctor", script)
        workspace = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(workspace)
    except Exception as exc:  # noqa: BLE001  (a check that cannot run says so)
        return [check("workspace", title, "not_checked", f"It could not be checked ({exc.__class__.__name__}).")]
    version = workspace.git_version(project)
    too_old = workspace.version_problem(version)
    if too_old:
        return [check("workspace", title, "fail", too_old, "Install a newer Git, then run this check again.")]
    probe = folder / f".doctor-{os.getpid()}-{os.urandom(3).hex()}"
    try:
        workspace.create(project, probe, None)
    except workspace.WorkspaceError as exc:
        return [check("workspace", title, "fail", str(exc), "Fix what Git reports; until then no ticket can be opened.")]
    held = [name for name in (".claude", ".mcp.json") if (probe / name).exists()]
    done = git_run(project, "worktree", "remove", "--force", "--force", str(probe))
    if done != 0 or probe.exists():
        return [check("workspace", title, "warn", f"A throwaway workspace was made, but {probe} could not be removed.",
                      f"Run: git worktree remove --force {probe}")]
    if held:
        return [check("workspace", title, "fail", f"A throwaway workspace still held {', '.join(held)}.",
                      "Install a newer Git, then run this check again.")]
    return [check("workspace", title, "ok", f"Git {workspace.version_text(version)} makes a ticket's workspace without {workspace.LEFT_OUT}.")]


def git_run(project: Path, *args: str) -> Optional[int]:
    code, _, _ = run(["git", *args], project, GIT_TIMEOUT)
    return code


def check_python() -> List[Dict[str, str]]:
    need = ".".join(map(str, MIN_PYTHON))
    have = platform.python_version()
    if sys.version_info[:2] >= MIN_PYTHON:
        return [check("python", "Python", "ok", f"Python {have} (the installer needs {need} or later).")]
    return [check("python", "Python", "fail", f"Python {have}; the installer needs {need} or later.",
                  f"Install Python {need} or later and make it the one 'python3' runs.")]


def check_claude(project: Path) -> List[Dict[str, str]]:
    title = "Claude Code"
    program = shutil.which("claude")
    if not program:
        return [check("claude", title, "warn", "The 'claude' program is not on PATH.",
                      "Install Claude Code's command-line program if you want to run MACH from a terminal; "
                      "the desktop app with the MACH plugin works without it.")]
    code, out, err = run([program, "--version"], project, CLAUDE_TIMEOUT)
    if code is None:
        return [check("claude", title, "not_checked", f"'claude --version' {err}.", "Check that 'claude --version' works in a terminal.")]
    if code != 0:
        return [check("claude", title, "warn", "'claude --version' failed.", "Reinstall or update Claude Code.")]
    first = (out.strip().splitlines() or [""])[0][:80]
    return [check("claude", title, "ok", f"Claude Code {first}".rstrip() + ".")]


def resolve_provider(config: Any) -> Tuple[str, str, Dict[str, Any]]:
    tickets = config.get("tickets") if isinstance(config, dict) else None
    tickets = tickets if isinstance(tickets, dict) else {}
    if os.environ.get("ISSUE_PROVIDER"):
        return os.environ["ISSUE_PROVIDER"], "the ISSUE_PROVIDER environment variable", tickets
    if tickets.get("provider"):
        return str(tickets["provider"]), "tickets.provider in .factory/config.json", tickets
    return "local", "the default", tickets


def check_tracker(project: Path, config: Any, gh_state: Optional[Dict[str, Any]] = None) -> List[Dict[str, str]]:
    title = "Ticket tracker"
    provider, source, tickets = resolve_provider(config)
    if provider not in PROVIDER_PROGRAMS:
        return [check("tracker", title, "fail", f"Unknown ticket provider '{provider}' (from {source}).",
                      f"Use one of: {', '.join(PROVIDER_PROGRAMS)}.")]
    if provider == "local":
        if not (project / ".factory").is_dir():
            return [check("tracker", title, "not_checked", "MACH is not installed here, so there is no local ticket queue yet.", "")]
        return [check("tracker", title, "ok", f"Local Markdown tickets in .factory/tickets/ (from {source}).")]
    program = PROVIDER_PROGRAMS[provider]
    commands = tickets.get("commands")
    if isinstance(commands, dict):
        override = commands.get("view") or commands.get("list")
        if isinstance(override, list) and override and isinstance(override[0], str):
            program = override[0]
    path = shutil.which(program)
    if not path:
        status = "fail" if provider == "github" else "warn"
        return [check("tracker", title, status, f"The {provider} tracker (from {source}) needs '{program}', which is not on PATH.",
                      f"Install '{program}' or change tickets.provider in .factory/config.json.")]
    if provider != "github" or program != "gh":
        return [check("tracker", title, "ok", f"The {provider} tracker (from {source}); '{program}' is on PATH. Sign-in was not checked.")]
    code, out, err = run([path, "auth", "status", "--hostname", GH_HOST], project, GH_TIMEOUT)
    if gh_state is not None:
        gh_state["auth"] = (code, (out + "\n" + err).lower())
    if code is None:
        return [check("tracker", title, "not_checked", f"GitHub tracker (from {source}); 'gh auth status' {err}.",
                      "Run 'gh auth status' yourself when the network is available.")]
    if code == 0:
        return [check("tracker", title, "ok", f"GitHub tracker (from {source}); the GitHub CLI is signed in.")]
    lowered = (out + "\n" + err).lower()
    if any(word in lowered for word in NETWORK_WORDS):
        return [check("tracker", title, "not_checked", f"GitHub tracker (from {source}); GitHub could not be reached to check the sign-in.",
                      "Run 'gh auth status' yourself when the network is available.")]
    return [check("tracker", title, "fail", f"GitHub tracker (from {source}); the GitHub CLI is not signed in.",
                  "Run 'gh auth login', then 'gh auth status' to confirm.")]


def check_own_files(project: Path, manifest: Dict[str, Any]) -> Dict[str, str]:
    """Whether MACH's own files match the install record for the installed version. MACH's scripts import each
    other across skills, so files from two versions can stop MACH from running. Same rule as bin/mach's own_code."""
    files = manifest.get("files") if isinstance(manifest.get("files"), dict) else {}
    own = sorted(dest for dest in files if isinstance(dest, str) and isinstance(files[dest], str) and dest.startswith(OWN_PREFIXES))
    changed, missing = [], []
    for dest in own:
        path = project / dest
        if not path.is_file():
            missing.append(dest)
        else:
            try:
                same = hashlib.sha256(path.read_bytes()).hexdigest() == files[dest]
            except OSError:
                same = False
            if not same:
                changed.append(dest)
    version = manifest.get("version") or "(version not recorded)"
    if not changed and not missing:
        return check("install.files", "MACH's files", "ok", f"All {len(own)} of MACH's installed files match the record for MACH {version}.")
    counts = ", ".join(f"{len(part)} {what}" for part, what in ((changed, "changed"), (missing, "missing")) if part)
    first = (changed + missing)[0]
    return check("install.files", "MACH's files", "warn",
                 f"MACH's files here do not all match the record for MACH {version} ({counts}; first: {first}), so they may come from "
                 "different versions and MACH may not run.",
                 "Run the installer again: it brings every MACH file to one version and saves any changed ones in .factory/mach-backup-<time>/ first.")


def check_install(project: Path, fix: bool, created: List[str]) -> Tuple[List[Dict[str, str]], Any]:
    factory = project / ".factory"
    if not factory.is_dir():
        return [check("install", "MACH install", "fail", f"MACH is not installed here: {project} has no .factory/ folder.",
                      "Install MACH in this project (the installer, or /mach:init with the plugin).")], None
    results: List[Dict[str, str]] = []
    config, problem = read_json(project / CONFIG)
    if not (project / CONFIG).is_file():
        config = None
        results.append(check("install.config", "Settings file", "fail", f"{CONFIG} is missing.",
                             "Run the installer again; it recreates the settings file without touching anything else."))
    elif problem:
        config = None
        results.append(check("install.config", "Settings file", "fail", f"{CONFIG} {problem}.", f"Correct {CONFIG} by hand so it is a JSON object."))
    elif not isinstance(config, dict):
        config = None
        results.append(check("install.config", "Settings file", "fail", f"{CONFIG} is valid JSON but not an object.", f"Correct {CONFIG} so it is a JSON object."))
    else:
        results.append(check("install.config", "Settings file", "ok", f"{CONFIG} reads as a JSON object."))
    if (project / MANIFEST).is_file():
        manifest, problem = read_json(project / MANIFEST)
        version = manifest.get("version") if isinstance(manifest, dict) else None
        if problem or not isinstance(manifest, dict):
            results.append(check("install.manifest", "Install record", "warn", f"{MANIFEST} {problem or 'is not a JSON object'}.",
                                 "Run the installer again to rewrite its record."))
        else:
            results.append(check("install.manifest", "Install record", "ok", f"MACH {version or '(version not recorded)'} recorded in {MANIFEST}."))
            results.append(check_own_files(project, manifest))
    else:
        results.append(check("install.manifest", "Install record", "warn",
                             f"{MANIFEST} is missing, so 'mach status' and 'mach uninstall' cannot tell what was installed.",
                             "Run the installer (or /mach:init with the plugin) again; it writes the record and changes nothing you made."))
    missing = [folder for folder in DATA_DIRS if not (project / folder).is_dir()]
    if missing and fix:
        for folder in missing:
            target = project / folder
            if target.exists():  # a file in the way: never replaced
                continue
            try:
                target.mkdir(parents=True)
            except OSError:
                continue
            created.append(folder)
        missing = [folder for folder in DATA_DIRS if not (project / folder).is_dir()]
    if missing:
        results.append(check("install.folders", "Standard folders", "warn", "Missing: " + ", ".join(f"{m}/" for m in missing) + ".",
                             "Run this check again with --fix to create the missing folders."))
    else:
        done = f" Created: {', '.join(f'{c}/' for c in created)}." if created else ""
        results.append(check("install.folders", "Standard folders", "ok", "All standard folders exist." + done))
    return results, config


def check_rules(project: Path) -> List[Dict[str, str]]:
    results = []
    for name in RULE_FILES:
        if (project / name).is_file():
            results.append(check(f"rules.{name}", name, "ok", f"{name} exists."))
        else:
            results.append(check(f"rules.{name}", name, "warn", f"{name} is missing; agents work without the project's rules.",
                                 "Run the installer again; it seeds REVIEW.md and AGENTS.md and adds a MACH section to CLAUDE.md."))
    return results


def check_adr_baseline(project: Path, config: Any) -> List[Dict[str, str]]:
    """Whether every required topic (adr.required_topics) has an accepted ADR on the main branch; reads only."""
    try:
        import importlib.util
        skills = Path(__file__).resolve().parent.parent.parent
        script = next(folder / "scripts" / "adr.py" for folder in (skills / "mach-intent", skills / "intent") if (folder / "scripts" / "adr.py").is_file())
        spec = importlib.util.spec_from_file_location("mach_adr_for_doctor", script)
        adr = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(adr)
        found = adr.coverage(project, config if isinstance(config, dict) else {})
    except Exception as exc:  # noqa: BLE001  (a check that cannot run says so)
        return [check("adr.baseline", "Architecture decision baseline", "not_checked", f"It could not be checked ({exc.__class__.__name__}).")]
    if not found["required"]:
        return [check("adr.baseline", "Architecture decision baseline", "ok", "This project requires no topic (adr.required_topics is empty).")]
    if found["missing"]:
        return [check("adr.baseline", "Architecture decision baseline", "warn",
                      f"No accepted ADR on the main branch covers: {', '.join(found['missing'])}. No ticket is planned until each is covered.",
                      f"Draft them with {adr.baseline_command()}, from the repository and any technical documents you already have, "
                      "then accept and commit them by pull request.")]
    return [check("adr.baseline", "Architecture decision baseline", "ok", f"Every required topic has an accepted ADR ({', '.join(found['required'])}).")]


def check_audit(project: Path) -> List[Dict[str, str]]:
    path = project / AUDIT_REPORT
    if not path.is_file():
        return [check("audit", "Readiness audit", "warn", "No readiness audit has been run, so no station will build yet.",
                      "Run the audit station (/mach-audit) when you are ready.")]
    report, problem = read_json(path)
    if problem or not isinstance(report, dict):
        return [check("audit", "Readiness audit", "warn", f"{AUDIT_REPORT} {problem or 'is not a JSON object'}.", "Run the audit station (/mach-audit) again.")]
    tier, score = report.get("readiness_tier"), report.get("readiness_score")
    if tier in ("Gold", "Silver"):
        return [check("audit", "Readiness audit", "ok", f"Last audit: {tier} ({score} points). Whether it is current is decided by the audit gate.")]
    if tier:
        return [check("audit", "Readiness audit", "warn", f"Last audit: {tier} ({score} points); autonomous building is blocked.",
                      "Work through the repository-hardening ticket, then run the audit station again.")]
    return [check("audit", "Readiness audit", "warn", f"{AUDIT_REPORT} records no tier.", "Run the audit station (/mach-audit) again.")]


def check_hosts(project: Path) -> List[Dict[str, str]]:
    results = []
    for dest, what in HOSTS:
        name = Path(dest).name
        path = project / dest
        if path.is_file() and os.access(path, os.X_OK):
            results.append(check(f"hosts.{name}", name, "ok", f"{dest} is present and can run ({what})."))
        elif path.is_file():
            results.append(check(f"hosts.{name}", name, "warn", f"{dest} is present but cannot be run.",
                                 "Run the installer again to fetch a fresh copy."))
        else:
            results.append(check(f"hosts.{name}", name, "warn", f"{dest} is not installed, so {what} cannot open in a browser; the terminal still works.",
                                 "Run the installer again on a supported machine (macOS on Apple silicon, Linux) to fetch it."))
    return results


def check_remote(project: Path) -> List[Dict[str, str]]:
    program = shutil.which("git")
    if not program:
        return [check("remote", "Git remote", "not_checked", "Git is not available to ask.", "")]
    code, out, err = run([program, "remote", "get-url", "origin"], project, GIT_TIMEOUT)
    if code is None:
        return [check("remote", "Git remote", "not_checked", f"'git remote get-url origin' {err}.", "")]
    if code == 0 and out.strip():
        return [check("remote", "Git remote", "ok", "The project has a remote named origin.")]
    return [check("remote", "Git remote", "warn", "No remote: pull-request merge and Product Studio's send are unavailable.",
                  "Add a remote with 'git remote add origin <url>' if you want pull requests.")]


def github_repo(project: Path) -> Optional[str]:
    """OWNER/REPO when origin is a github.com address, else None. The URL itself is never kept or shown."""
    program = shutil.which("git")
    if not program:
        return None
    code, out, _ = run([program, "config", "--get", "remote.origin.url"], project, GIT_TIMEOUT)
    if code != 0:
        return None
    url = out.strip()
    match = (re.match(r"^(?:https?|ssh|git)://(?:[^/@]*@)?github\.com(?::\d+)?/([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", url, re.I)
             or re.match(r"^(?:[^/@\s]+@)?github\.com:([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", url, re.I))
    if not match or not all(re.match(r"^[A-Za-z0-9._-]+$", part) for part in match.groups()):
        return None
    return f"{match.group(1)}/{match.group(2)}"


def check_requests(project: Path, config: Any, gh_state: Dict[str, Any]) -> List[Dict[str, str]]:
    """GitHub Issues as requests. Runs only for a github.com origin; read-only; creates nothing."""
    repo = github_repo(project)
    if repo is None:
        return []
    title = "Requests"
    tickets = config.get("tickets") if isinstance(config, dict) else None
    github = tickets.get("github") if isinstance(tickets, dict) else None
    github = github if isinstance(github, dict) else {}
    results: List[Dict[str, str]] = []
    path = shutil.which("gh")
    ready = False
    if not path:
        results.append(check("requests.signin", f"{title}: sign-in", "not_checked", f"The GitHub CLI ('gh') is not on PATH, so {repo} cannot be asked.",
                             "Install the GitHub CLI and run 'gh auth login' to use GitHub Issues as requests."))
    else:
        if "auth" not in gh_state:
            code, out, err = run([path, "auth", "status", "--hostname", GH_HOST], project, GH_TIMEOUT)
            gh_state["auth"] = (code, (out + "\n" + err).lower())
        code, lowered = gh_state["auth"]
        if code is None:
            results.append(check("requests.signin", f"{title}: sign-in", "not_checked", "'gh auth status' did not answer.",
                                 "Run 'gh auth status' yourself when the network is available."))
        elif code == 0:
            ready = True
            results.append(check("requests.signin", f"{title}: sign-in", "ok", f"The GitHub CLI is signed in; requests would be read from {repo}."))
        elif any(word in lowered for word in NETWORK_WORDS):
            results.append(check("requests.signin", f"{title}: sign-in", "not_checked", "GitHub could not be reached to check the sign-in.",
                                 "Run 'gh auth status' yourself when the network is available."))
        else:
            results.append(check("requests.signin", f"{title}: sign-in", "warn", f"The GitHub CLI is not signed in, so requests in {repo} cannot be read.",
                                 "Run 'gh auth login', then 'gh auth status' to confirm."))
    skipped = "Needs the GitHub CLI signed in first."
    request_label = github.get("request_label")
    request_label = request_label if isinstance(request_label, str) and request_label.strip() else "mach:request"
    wanted = [request_label, "mach:slice", "mach:ready", "mach:building", "mach:question", "mach:shipped"]
    if not ready:
        results.append(check("requests.labels", f"{title}: labels", "not_checked", skipped, ""))
    else:
        code, out, err = run([path, "label", "list", "--repo", repo, "--limit", "200", "--json", "name"], project, GH_TIMEOUT)
        names = None
        if code == 0:
            try:
                data = json.loads(out)
                if isinstance(data, list):
                    names = {item.get("name") for item in data if isinstance(item, dict)}
            except ValueError:
                names = None
        if names is None:
            why = err if code is None else "could not list the labels"
            results.append(check("requests.labels", f"{title}: labels", "not_checked", f"{repo}: 'gh label list' {why}.",
                                 "Run 'gh label list' yourself when the network is available."))
        else:
            missing = [name for name in wanted if name not in names]
            if missing:
                lines = "\n".join(f"    gh label create {shlex.quote(name)} --repo {repo}" for name in missing)
                results.append(check("requests.labels", f"{title}: labels", "warn", f"{repo} lacks the label(s): {', '.join(missing)}.",
                                     f"To create them now, run these yourself (the doctor creates none; Product Studio and the Factory add a missing label of their own when they first need it, and never the request label):\n{lines}"))
            else:
                results.append(check("requests.labels", f"{title}: labels", "ok", f"The request label and MACH's slice labels exist in {repo}."))
    if not ready:
        results.append(check("requests.permission", f"{title}: permission", "not_checked", skipped, ""))
    else:
        code, out, err = run([path, "api", "user", "--jq", ".login"], project, GH_TIMEOUT)
        login = out.strip()
        if code != 0 or not re.match(r"^[A-Za-z0-9-]+$", login):
            results.append(check("requests.permission", f"{title}: permission", "not_checked", "The signed-in account's name could not be read.",
                                 "Run 'gh api user' yourself when the network is available."))
        else:
            code, out, err = run([path, "api", f"repos/{repo}/collaborators/{login}/permission", "--jq", ".permission"], project, GH_TIMEOUT)
            level = out.strip().lower()
            if code != 0:
                results.append(check("requests.permission", f"{title}: permission", "not_checked",
                                     f"This account's permission on {repo} could not be read.",
                                     "Check that the account can see the repository."))
            elif level in ("admin", "write", "maintain"):
                results.append(check("requests.permission", f"{title}: permission", "ok",
                                     f"This account can write to {repo}, so it can confirm who labelled a request."))
            elif level in ("read", "none", "triage"):
                results.append(check("requests.permission", f"{title}: permission", "warn",
                                     f"This account has {level} access to {repo}: requests can be listed but this account may not be able to confirm who labelled them, or to send.",
                                     "Sign in with an account that has write access ('gh auth login')."))
            else:
                results.append(check("requests.permission", f"{title}: permission", "not_checked", f"This account's permission on {repo} was not recognised.", ""))
    accounts = github.get("monitor_accounts")
    if accounts is not None:
        bad = not isinstance(accounts, list) or any(
            not (isinstance(a, dict) and isinstance(a.get("login"), str) and a.get("login")
                 and isinstance(a.get("id"), int) and not isinstance(a.get("id"), bool)) for a in accounts)
        if bad:
            results.append(check("requests.monitors", f"{title}: monitoring accounts", "fail",
                                 "A monitoring account is matched on its numeric id; add it.",
                                 "Write each entry in tickets.github.monitor_accounts of .factory/config.json as {\"login\": \"name\", \"id\": 12345}."))
        else:
            results.append(check("requests.monitors", f"{title}: monitoring accounts", "ok", f"{len(accounts)} monitoring account(s), each with a login and a numeric id."))
    return results


PROTECTION_FIX = ("On GitHub, protect {branch} (Settings, then Branches or Rules): require a pull request, require status checks to pass, "
                  "and require branches to be up to date before merging. Then GitHub refuses a merge onto a {branch} that moved since the "
                  "checks ran. The doctor changes no setting.")


def integration_branch(project: Path, config: Any) -> str:
    """The branch tickets land on, as the merge station reads it: merge.into, origin's default branch, else main."""
    merge = config.get("merge") if isinstance(config, dict) else None
    named = merge.get("into") if isinstance(merge, dict) else None
    if isinstance(named, str) and re.match(r"^[A-Za-z0-9._/-]{1,200}$", named.strip()):
        return named.strip()
    program = shutil.which("git")
    if program:
        code, out, _ = run([program, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], project, GIT_TIMEOUT)
        if code == 0 and out.strip().startswith("origin/"):
            return out.strip().split("/", 1)[1]
    return "main"


def protection_from_rules(data: Any) -> Optional[Tuple[bool, bool]]:
    """(up to date required, checks required) from the branch's active rules (rulesets), or None if not a list."""
    if not isinstance(data, list):
        return None
    strict = checks = False
    for rule in data:
        if isinstance(rule, dict) and rule.get("type") == "required_status_checks":
            params = rule.get("parameters") if isinstance(rule.get("parameters"), dict) else {}
            strict = strict or params.get("strict_required_status_checks_policy") is True
            checks = checks or bool(params.get("required_status_checks"))
    return strict, checks


def check_merge_protection(project: Path, config: Any, gh_state: Dict[str, Any]) -> List[Dict[str, str]]:
    """M20 A2: whether GitHub refuses a merge onto an integration branch that moved since the checks ran. Read-only: two
    `gh api` reads (the branch's active rules, then its classic protection). Runs only for a github.com origin."""
    repo = github_repo(project)
    if repo is None:
        return []
    branch = integration_branch(project, config)
    title = f"Merge protection on {branch}"
    fix = PROTECTION_FIX.format(branch=branch)
    path = shutil.which("gh")
    if not path:
        return [check("merge.protection", title, "not_checked", f"The GitHub CLI ('gh') is not on PATH, so {repo}'s settings for {branch} cannot be read.", fix)]
    if "auth" not in gh_state:
        code, out, err = run([path, "auth", "status", "--hostname", GH_HOST], project, GH_TIMEOUT)
        gh_state["auth"] = (code, (out + "\n" + err).lower())
    if gh_state["auth"][0] != 0:
        return [check("merge.protection", title, "not_checked", "Needs the GitHub CLI signed in first.", fix)]
    code, out, _ = run([path, "api", f"repos/{repo}/rules/branches/{branch}"], project, GH_TIMEOUT)
    try:
        ruled = protection_from_rules(json.loads(out)) if code == 0 else None
    except ValueError:
        ruled = None
    if ruled == (True, True):
        return [check("merge.protection", title, "ok", f"{repo} requires {branch} to be up to date and its checks to pass before a merge (a ruleset).")]
    code, out, err = run([path, "api", f"repos/{repo}/branches/{branch}/protection/required_status_checks"], project, GH_TIMEOUT)
    if code is None:
        return [check("merge.protection", title, "not_checked", f"'gh api' {err}.", fix)]
    if code != 0:
        if "branch not protected" in (out + "\n" + err).lower() or "required status checks not enabled" in (out + "\n" + err).lower():
            missing = "is not protected" if "branch not protected" in (out + "\n" + err).lower() else "requires no status checks"
            return [check("merge.protection", title, "warn",
                          f"{branch} in {repo} {missing}, so GitHub can merge a pull request onto a {branch} that moved since its checks ran.", fix)]
        return [check("merge.protection", title, "not_checked",
                      f"{repo}'s protection for {branch} could not be read (reading it needs admin access to the repository).", fix)]
    try:
        data = json.loads(out)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        return [check("merge.protection", title, "not_checked", f"{repo}'s protection for {branch} was not recognised.", fix)]
    strict = data.get("strict") is True or bool(ruled and ruled[0])
    checks = bool(data.get("contexts") or data.get("checks")) or bool(ruled and ruled[1])
    if strict and checks:
        return [check("merge.protection", title, "ok", f"{repo} requires {branch} to be up to date and its checks to pass before a merge.")]
    lacking = " and ".join(([] if strict else ["branches to be up to date"]) + ([] if checks else ["any status check"]))
    return [check("merge.protection", title, "warn",
                  f"{branch} in {repo} does not require {lacking} before merging, so GitHub can merge a pull request onto a {branch} that moved since its checks ran.", fix)]


LOCAL_METHOD_FIX = ("For a team, set merge.method to \"pr\" in .factory/config.json: MACH then tests each ticket against origin's "
                    "{branch} and merges it through a pull request. A person working alone can keep \"local\".")


def check_merge_method(project: Path, config: Any, gh_state: Dict[str, Any]) -> List[Dict[str, str]]:
    """M20 A2: merge.method local (the default) merges on this machine and never pushes, which suits one person, not a
    team. Whether others push cannot be seen from Git, so the signal is GitHub's: more than one collaborator with write
    access. Read-only (`gh api .../collaborators`); runs only for a github.com origin and the local method."""
    merge = config.get("merge") if isinstance(config, dict) else None
    method = merge.get("method") if isinstance(merge, dict) else None
    if method == "pr":
        return []
    repo = github_repo(project)
    if repo is None:
        return []
    branch = integration_branch(project, config)
    title = "Merge method for a team"
    fix = LOCAL_METHOD_FIX.format(branch=branch)
    path = shutil.which("gh")
    if not path:
        return [check("merge.method", title, "not_checked", f"merge.method is local; the GitHub CLI ('gh') is not on PATH, so who can push to {repo} cannot be read.", fix)]
    if "auth" not in gh_state:
        code, out, err = run([path, "auth", "status", "--hostname", GH_HOST], project, GH_TIMEOUT)
        gh_state["auth"] = (code, (out + "\n" + err).lower())
    if gh_state["auth"][0] != 0:
        return [check("merge.method", title, "not_checked", "merge.method is local; needs the GitHub CLI signed in first to see who can push.", fix)]
    code, out, _ = run([path, "api", f"repos/{repo}/collaborators?per_page=100", "--jq", "[.[] | select(.permissions.push)] | length"], project, GH_TIMEOUT)
    writers = out.strip()
    if code != 0 or not writers.isdigit():
        return [check("merge.method", title, "not_checked", f"merge.method is local; who can push to {repo} could not be read.", fix)]
    if int(writers) > 1:
        return [check("merge.method", title, "warn",
                      f"merge.method is local, and {writers} people can push to {repo}. A local merge lands on this machine only and is never pushed by MACH.", fix)]
    return [check("merge.method", title, "ok", f"merge.method is local, and only one person can push to {repo}.")]


# --- running and reporting --------------------------------------------------------------------

def diagnose(project: Path, fix: bool = False) -> Dict[str, Any]:
    created: List[str] = []
    checks: List[Dict[str, str]] = []
    checks += check_git(project)
    checks += check_workspace(project)
    checks += check_python()
    checks += check_claude(project)
    install, config = check_install(project, fix, created)
    gh_state: Dict[str, Any] = {}
    checks += check_tracker(project, config, gh_state)
    checks += install
    checks += check_rules(project)
    checks += check_adr_baseline(project, config)
    checks += check_audit(project)
    checks += check_hosts(project)
    checks += check_remote(project)
    checks += check_requests(project, config, gh_state)
    checks += check_merge_protection(project, config, gh_state)
    checks += check_merge_method(project, config, gh_state)
    summary = {status: sum(1 for c in checks if c["status"] == status) for status in STATUSES}
    return {"project": str(project), "checks": checks, "summary": summary, "created": created}


def render(result: Dict[str, Any]) -> str:
    words = {"ok": "ok", "warn": "warning", "fail": "FAILED", "not_checked": "not checked"}
    lines = [f"MACH check of {result['project']}", ""]
    for c in result["checks"]:
        lines.append(f"  {words[c['status']]:<12} {c['title']}: {c['detail']}")
    todo = [c for c in result["checks"] if c["status"] in ("fail", "warn") and c["fix"]]
    if result["created"]:
        lines += ["", "Created:"] + [f"  {folder}/" for folder in result["created"]]
    if todo:
        lines += ["", "What to do:"] + [f"  - {c['title']}: {c['fix']}" for c in todo]
    lines += result.get("notes") or []
    lines += ["", "The Factory supervisor is not checked here; for it, run /mach factory status."]
    s = result["summary"]
    lines.append(f"{s['ok']} ok, {s['warn']} warnings, {s['fail']} failed, {s['not_checked']} not checked.")
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None, project: Optional[Path] = None, extra_checks: Sequence[Dict[str, str]] = (),
         notes: Sequence[str] = ()) -> int:
    parser = argparse.ArgumentParser(prog="doctor", description="Check that this workstation and project are ready for MACH. Read-only unless --fix.")
    parser.add_argument("--fix", action="store_true", help="create the installer's standard folders that are missing; nothing else")
    parser.add_argument("--json", action="store_true", help="print the result as JSON")
    args = parser.parse_args(argv)
    root = Path(project).resolve() if project is not None else find_project(Path.cwd())
    result = diagnose(root, fix=args.fix)
    if extra_checks or notes:  # handed in by run.py (the internal-error check); this script reads nothing for them
        result["checks"] += list(extra_checks)
        result["summary"] = {status: sum(1 for c in result["checks"] if c["status"] == status) for status in STATUSES}
        result["notes"] = ["", *notes] if notes else []
    if args.json:
        shown = {"checks": result["checks"], "summary": result["summary"], "created": result["created"]}
        if notes:
            shown["notes"] = list(notes)
        print(json.dumps(shown, indent=2))
    else:
        print(render(result))
    return 1 if result["summary"]["fail"] else 0


if __name__ == "__main__":
    import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
    sys.exit(main())
