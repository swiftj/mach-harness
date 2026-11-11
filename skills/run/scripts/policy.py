#!/usr/bin/env python3
"""The Factory's machine-local authorization: who may run work unattended here, and within what limits.

The policy file is .factory/local/runner.json. It is git-ignored and never leaves the machine: it
is not part of the project, of a product definition, or of anything Product Studio publishes. A
fresh clone has no such file, and no file means the Factory is disabled.

Everything here fails closed. A missing, unreadable, symlinked or malformed file; a file written
for another machine or another folder; a file other users can write: each reads as disabled.

The local grant is an upper bound. Settings tracked in the project (.factory/config.json, key
"factory") can only restrict it: turn the supervisor off, cap the autonomy, lower a limit. Nothing
tracked in Git, and nothing in a product file, can widen what this file allows.

Standard library only. Imported by run.py and supervisor.py; not a command of its own.
"""

import contextlib
import json
import os
import platform
import secrets
import shutil
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

POLICY_VERSION = 2
AUTONOMY = ("observe", "supervised")  # observe: discover, reconcile and plan. supervised: also run eligible work, stopping at every human gate
RISKS = ("Low", "Medium", "High")
CONFIRM_MINUTES = 10
LIMITS = {
    # name: (default, minimum, maximum)
    "max_parallel": (2, 1, 8),                # cells in the line at once
    "max_execution_minutes": (120, 5, 720),   # one execution is stopped after this long
    "max_runs_per_day": (20, 1, 500),         # executions started in any 24 hours
    "max_budget_usd_per_run": (25, 1, 500),   # passed to Claude as its spending limit for one execution
    "max_budget_usd_per_day": (100, 1, 5000),
    "max_attempts": (2, 1, 5),                # executions that end without moving a ticket, before a person is asked
    "poll_seconds": (300, 30, 3600),          # how often a running supervisor looks again without being woken
}
# The tools one execution may use without asking. Everything else is refused and reported for a person.
# A person consents to this exact list at activation; extra entries are added only by them.
BASE_TOOLS = ("Workflow", "Skill", "Agent", "Read", "Write", "Edit", "Glob", "Grep",
              "Bash(python3 *)", "Bash(git status *)", "Bash(git log *)", "Bash(git diff *)", "Bash(git show *)")
DISABLED = {"enabled": False, "paused": False, "autonomy": "observe", "auto_sync": False}


class PolicyError(Exception):
    """A problem the caller can fix; run.py prints it as a refusal."""


def now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(moment: Optional[datetime] = None) -> str:
    return (moment or now()).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(value: Any) -> Optional[datetime]:
    try:
        return datetime.strptime(str(value), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def local_dir(root: Path) -> Path:
    return root / ".factory" / "local"


def policy_path(root: Path) -> Path:
    return local_dir(root) / "runner.json"


def write_private(path: Path, text: str) -> None:
    """Write a file only this user can read or change, atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(str(path.parent), 0o700)
    temporary = path.with_name(path.name + ".tmp")
    handle = os.open(str(temporary), os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "w", encoding="utf-8") as out:
        out.write(text)
    os.replace(str(temporary), str(path))


def interpreter() -> str:
    """The Python the stations' scripts are run with. Its exact path has to be allowed by name."""
    return sys.executable


def default_tools() -> List[str]:
    return [*BASE_TOOLS, f"Bash({interpreter()} *)"]


def read(root: Path) -> Dict[str, Any]:
    """The policy in force on this machine for this project folder. Disabled unless everything checks out."""
    path = policy_path(root)
    disabled = {**DISABLED, "source": "default-disabled", "problems": []}

    def refuse(problem: str) -> Dict[str, Any]:
        return {**disabled, "source": "invalid-file", "problems": [problem]}

    try:
        if path.is_symlink() or local_dir(root).is_symlink() or (root / ".factory").is_symlink():
            return refuse("The policy file or its folder is a symbolic link.")
        if not path.is_file():
            return disabled
        mode = path.stat().st_mode
        if mode & (stat.S_IWGRP | stat.S_IWOTH):
            return refuse("The policy file can be changed by other users of this machine.")
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        return refuse(f"The policy file cannot be read: {exc}")
    if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data["schema_version"] != POLICY_VERSION:
        return refuse("The policy file is not version %d." % POLICY_VERSION)
    problems = []
    for field in ("enabled", "paused", "auto_sync", "allow_merge", "persistent"):
        if type(data.get(field)) is not bool:
            problems.append(f"'{field}' must be true or false")
    if data.get("autonomy") not in AUTONOMY:
        problems.append("'autonomy' must be observe or supervised")
    for field in ("runner_id", "machine", "project_root", "source_branch", "claude", "enabled_by", "enabled_at"):
        if not isinstance(data.get(field), str) or not data[field].strip():
            problems.append(f"'{field}' is missing")
    if data.get("max_risk") not in RISKS:
        problems.append("'max_risk' must be Low, Medium or High")
    limits = data.get("limits")
    if not isinstance(limits, dict):
        problems.append("'limits' is missing")
    else:
        for name, (_, low, high) in LIMITS.items():
            value = limits.get(name)
            if type(value) not in (int, float) or isinstance(value, bool) or not low <= value <= high:
                problems.append(f"limit '{name}' must be a number from {low} to {high}")
    tools = data.get("allowed_tools")
    if not isinstance(tools, list) or not tools or any(not isinstance(tool, str) or not tool.strip() or "\n" in tool for tool in tools):
        problems.append("'allowed_tools' must be a list of tool names")
    elif any(tool.strip() in ("Bash", "Bash(*)", "*") or "dangerously" in tool for tool in tools):
        problems.append("'allowed_tools' may not allow every shell command")
    if not isinstance(data.get("excluded_slices"), list) or any(not isinstance(item, str) for item in data.get("excluded_slices") or []):
        problems.append("'excluded_slices' must be a list")
    if problems:
        return refuse("The policy file is not valid: " + "; ".join(problems) + ".")
    if data["machine"] != platform.node():
        return refuse(f"The policy was written on another machine ('{data['machine']}'). Authorization does not travel: enable the Factory here.")
    if Path(data["project_root"]) != root:
        return refuse("The policy was written for a different folder. Authorization does not follow a copied or moved project: enable the Factory here.")
    return {**data, "source": "local-file", "problems": []}


def effective(policy: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
    """The policy after the project's own restrictions. The project can narrow the local grant, never widen it."""
    result = {**policy, "restricted_by_project": []}
    if policy.get("source") != "local-file":
        return result
    section = config.get("factory") if isinstance(config.get("factory"), dict) else {}
    limits = dict(policy["limits"])
    if section.get("supervisor") is False and policy["enabled"]:
        result["enabled"] = False
        result["restricted_by_project"].append("factory.supervisor is false: this project does not allow unattended execution")
    ceiling = section.get("autonomy_ceiling")
    if ceiling == "observe" and policy["autonomy"] == "supervised":
        result["autonomy"] = "observe"
        result["restricted_by_project"].append("factory.autonomy_ceiling is observe")
    for name in ("max_parallel", "max_execution_minutes", "max_runs_per_day", "max_budget_usd_per_run", "max_budget_usd_per_day", "max_attempts"):
        value = section.get(name)
        if type(value) in (int, float) and not isinstance(value, bool) and 0 < value < limits[name]:
            limits[name] = value
            result["restricted_by_project"].append(f"factory.{name} is {value}")
    if section.get("allow_merge") is False and policy["allow_merge"]:
        result["allow_merge"] = False
        result["restricted_by_project"].append("factory.allow_merge is false")
    ceiling = section.get("max_risk")
    if ceiling in RISKS and RISKS.index(ceiling) < RISKS.index(policy["max_risk"]):
        result["max_risk"] = ceiling
        result["restricted_by_project"].append(f"factory.max_risk is {ceiling}")
    result["limits"] = limits
    return result


def running(policy: Dict[str, Any]) -> bool:
    return bool(policy.get("enabled")) and policy.get("source") == "local-file"


def may_execute(policy: Dict[str, Any]) -> Tuple[bool, str]:
    """Whether agents may be started right now under this (effective) policy."""
    if policy.get("source") != "local-file":
        return False, "the Factory is not enabled on this machine" + (f" ({policy['problems'][0]})" if policy.get("problems") else "")
    if not policy.get("enabled"):
        return False, "the Factory is disabled" + (f" ({policy['restricted_by_project'][0]})" if policy.get("restricted_by_project") else "")
    if policy.get("paused"):
        return False, "the Factory is paused"
    if policy.get("autonomy") != "supervised":
        return False, "the Factory is in observe mode, which never starts work"
    return True, f"runner {policy.get('runner_id')}; supervised"


def build(root: Path, request: Dict[str, Any], enabled_by: str, claude: str, source_branch: str, excluded: Sequence[str]) -> Dict[str, Any]:
    limits = {name: default for name, (default, _, _) in LIMITS.items()}
    for name, value in (request.get("limits") or {}).items():
        if name not in LIMITS:
            raise PolicyError(f"'{name}' is not a limit. Limits: {', '.join(LIMITS)}.")
        _, low, high = LIMITS[name]
        if type(value) not in (int, float) or isinstance(value, bool) or not low <= value <= high:
            raise PolicyError(f"'{name}' must be a number from {low} to {high}.")
        limits[name] = value
    tools = list(dict.fromkeys([*default_tools(), *[tool.strip() for tool in request.get("extra_tools") or [] if tool.strip()]]))
    return {
        "schema_version": POLICY_VERSION, "enabled": True, "paused": False, "autonomy": request["autonomy"],
        "auto_sync": bool(request.get("auto_sync")), "allow_merge": bool(request.get("allow_merge")), "persistent": bool(request.get("persistent")),
        "max_risk": request.get("max_risk") or "High", "limits": limits, "allowed_tools": tools,
        "excluded_slices": sorted(set(excluded)), "source_branch": source_branch, "claude": claude,
        "runner_id": str(uuid.uuid4()), "machine": platform.node(), "project_root": str(root),
        "enabled_by": enabled_by, "enabled_at": stamp(),
    }


def save(root: Path, policy: Dict[str, Any]) -> None:
    data = {key: value for key, value in policy.items() if key not in ("source", "problems", "restricted_by_project")}
    write_private(policy_path(root), json.dumps(data, indent=2, sort_keys=True) + "\n")


# ---- a pending activation: asked for, shown to a person, not yet confirmed ----


def pending_path(root: Path) -> Path:
    return local_dir(root) / "pending-enable.json"


def propose(root: Path, request: Dict[str, Any], summary: Dict[str, Any]) -> Dict[str, Any]:
    """Record an activation that a person has not confirmed yet, with a code that expires."""
    pending = {"code": secrets.token_hex(3), "expires_at": stamp(now() + timedelta(minutes=CONFIRM_MINUTES)), "request": request, "summary": summary}
    write_private(pending_path(root), json.dumps(pending, indent=2, sort_keys=True) + "\n")
    return pending


def take_pending(root: Path, code: str) -> Dict[str, Any]:
    path = pending_path(root)
    try:
        if path.is_symlink():
            raise ValueError("symlink")
        pending = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise PolicyError("Nothing is waiting to be confirmed. Ask for the activation first; it shows what will be enabled and gives a code.")
    expires = parse(pending.get("expires_at"))
    if not isinstance(pending, dict) or not expires or now() > expires:
        with contextlib.suppress(OSError):
            path.unlink()
        raise PolicyError("That confirmation has expired. Ask for the activation again and read what it shows.")
    if not isinstance(code, str) or not secrets.compare_digest(code.strip(), str(pending.get("code"))):
        raise PolicyError("That is not the confirmation code for the pending activation. Nothing was enabled.")
    with contextlib.suppress(OSError):
        path.unlink()
    return pending


# ---- preflight ----


def check(name: str, ok: bool, detail: str, required: bool = True) -> Dict[str, Any]:
    return {"check": name, "ok": bool(ok), "required": required, "detail": detail}


def probe_claude(claude: str, root: Path) -> Tuple[bool, str]:
    """Ask Claude Code for one word, without any tool, to prove it runs unattended and is signed in."""
    try:
        done = subprocess.run([claude, "-p", "Reply with the single word READY and nothing else.", "--output-format", "json",
                               "--permission-mode", "default", "--max-budget-usd", "1"],
                              cwd=str(root), capture_output=True, text=True, timeout=180, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"Claude Code did not answer: {exc}"
    try:
        result = json.loads(done.stdout)
    except ValueError:
        return False, "Claude Code did not return a structured result: " + ((done.stderr or done.stdout).strip().splitlines() or ["no output"])[-1][:200]
    if done.returncode != 0 or result.get("is_error"):
        return False, f"Claude Code reported an error ({result.get('subtype') or done.returncode})."
    return True, "Claude Code answered a non-interactive request."


def preflight(root: Path, config: Dict[str, Any], request: Dict[str, Any], *, git: Any, audit: Dict[str, Any], integration: Dict[str, Any],
              m3_problem: Optional[str], workflow_installed: bool, lease_holder: Optional[str], ignored: bool, probe: bool = True) -> List[Dict[str, Any]]:
    """Everything that must be true before this machine may run work unattended. Deterministic except the Claude probe."""
    supervised = request["autonomy"] == "supervised"
    checks = [check("mach_project", (root / ".factory" / "config.json").is_file(), "This folder is a MACH project." if (root / ".factory" / "config.json").is_file()
                    else "No .factory/config.json: install MACH in this project first.")]
    checks.append(check("product_intake", m3_problem is None, m3_problem or "Product intake and the scheduler load."))
    checks.append(check("repository", not integration.get("problems"), "; ".join(integration.get("problems") or []) or f"The integration branch is '{integration.get('branch')}'."))
    head_branch = git(root, "branch", "--show-current").stdout.strip()
    on_branch = bool(integration.get("branch")) and head_branch == integration.get("branch")
    checks.append(check("checkout", on_branch, f"The main checkout is on '{head_branch or 'no branch'}'" + ("." if on_branch else f"; cells are opened from '{integration.get('branch')}', so switch to it."),
                        required=supervised))
    checks.append(check("local_state_private", ignored, "Machine-local state (.factory/local/) is ignored by Git." if ignored
                        else ".factory/local/ is not ignored by Git, so authorization could be committed. Add it to .gitignore."))
    checks.append(check("toolchain", sys.version_info >= (3, 8) and shutil.which("git") is not None, f"Python {platform.python_version()} and git are available."))
    merge = config.get("merge") if isinstance(config.get("merge"), dict) else {}
    if request.get("allow_merge") and merge.get("method") == "pr":
        checks.append(check("gh", shutil.which("gh") is not None, "The GitHub tool is available for pull requests." if shutil.which("gh") else "merge.method is 'pr' but gh is not installed."))
    claude = shutil.which("claude")
    checks.append(check("claude_installed", claude is not None, f"Claude Code is at {claude}." if claude else "Claude Code (the 'claude' command) is not on the PATH.", required=supervised))
    checks.append(check("workflow_installed", workflow_installed, "The MACH belt workflow is installed." if workflow_installed else "The MACH belt workflow is not installed in this project or plugin.",
                        required=supervised))
    if supervised:
        if claude and probe:
            ok, detail = probe_claude(claude, root)
            checks.append(check("claude_ready", ok, detail))
        state = audit.get("state")
        checks.append(check("audit", state in ("ok", "off"), {"ok": f"The readiness audit is current: {audit.get('tier')}.", "off": "This project has switched the audit gate off.",
                                                              "missing": "There is no readiness audit report. Run the audit first.", "stale": "The readiness audit is out of date. Run it again.",
                                                              "bronze": "The repository's readiness tier is Bronze; unattended building is not allowed."}.get(str(state), f"Audit state: {state}.")))
        review = config.get("review") if isinstance(config.get("review"), dict) else {}
        checks.append(check("security_review", review.get("security_veto") is not False,
                            "A security reviewer's blocker cannot be outvoted." if review.get("security_veto") is not False
                            else "review.security_veto is false: a security blocker could be outvoted. Unattended execution is refused while that is so."))
    free = shutil.disk_usage(str(root)).free // (1024 * 1024)
    wanted = (request.get("limits") or {}).get("max_parallel", LIMITS["max_parallel"][0])
    cpus = os.cpu_count() or 1
    checks.append(check("resources", free >= 1024 and wanted <= max(1, cpus), f"{free} MB free; {cpus} processors; {wanted} cell(s) at once requested."
                        + ("" if free >= 1024 else " At least 1024 MB free is needed.") + ("" if wanted <= max(1, cpus) else " That is more cells than processors.")))
    checks.append(check("ownership", lease_holder is None, "No other supervisor owns this project." if lease_holder is None else f"Another supervisor is running here: {lease_holder}."))
    if request.get("persistent"):
        checks.append(check("persistent_service", sys.platform == "darwin", "A per-user LaunchAgent can be installed." if sys.platform == "darwin"
                            else "A persistent supervisor is only supported on macOS in this version."))
    section = config.get("factory") if isinstance(config.get("factory"), dict) else {}
    checks.append(check("project_allows", section.get("supervisor") is not False, "The project allows a supervisor." if section.get("supervisor") is not False
                        else "factory.supervisor is false in this project's settings: unattended execution is not allowed here."))
    return checks
