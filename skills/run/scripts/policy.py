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
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import executor  # noqa: E402  (the boundary's flags and environment; the probe uses exactly what an execution uses)

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


BY_HAND = "a person can still run that ticket by hand (/mach)"


def security_review_problems(config: Dict[str, Any]) -> List[str]:
    """Tracked review settings that take the security check away from unattended work. Each one refuses unattended
    execution; none changes a threshold or the manual path. Reads only the project's review settings, never a product file."""
    review = config.get("review") if isinstance(config.get("review"), dict) else {}
    problems = []
    if review.get("security_veto") is False:
        problems.append(f"review.security_veto is false: a security blocker could be outvoted. Unattended execution is refused while that is so; {BY_HAND}.")
    for tier in ("medium", "high"):
        override = review.get(tier) if isinstance(review.get(tier), dict) else {}
        seats = override.get("reviewers")
        if isinstance(seats, int) and 0 < seats < 2:  # exactly the values review.py turns into a single general seat
            problems.append(f"review.{tier}.reviewers is {seats}: {tier.capitalize()}-risk tickets would be reviewed without the security seat. "
                            f"Unattended execution is refused while that is so; {BY_HAND}.")
    high = review.get("high") if isinstance(review.get("high"), dict) else {}
    if high.get("human_approval") is False:
        problems.append(f"review.high.human_approval is false: High-risk tickets would merge without a person's approval. Unattended execution is refused while that is so; {BY_HAND}.")
    security = config.get("security") if isinstance(config.get("security"), dict) else {}
    scan = security.get("scan") if isinstance(security.get("scan"), dict) else {}
    if scan.get("enabled") is False:
        problems.append("security.scan.enabled is false: no commit would be checked for a secret and no new dependency shown to the security seat. "
                        f"Unattended execution is refused while that is so; {BY_HAND}.")
    return problems


def tracked_config(root: Any, fallback: Dict[str, Any]) -> Dict[str, Any]:
    """The project's tracked settings as they are on disk now, so a change made after enabling is seen on the next pass."""
    try:
        data = json.loads((Path(root) / ".factory" / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return fallback
    return data if isinstance(data, dict) else fallback


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


def tracked_by_git(root: Path, path: Path) -> bool:
    """Whether a file is in Git's index or in HEAD's tree. A grant that arrived through Git is no grant."""
    try:
        relative = path.relative_to(root).as_posix()
    except ValueError:
        return False
    for argv in (["git", "ls-files", "--error-unmatch", "--", relative], ["git", "cat-file", "-e", f"HEAD:{relative}"]):
        try:
            if subprocess.run(argv, cwd=str(root), capture_output=True, timeout=30).returncode == 0:
                return True
        except (OSError, subprocess.SubprocessError):
            continue
    return False


def untrusted(root: Path) -> Optional[str]:
    """Why the policy file on disk cannot be a local grant, whatever it says; None when nothing is wrong with where it came from."""
    path = policy_path(root)
    if path.is_symlink() or local_dir(root).is_symlink() or (root / ".factory").is_symlink():
        return "The policy file or its folder is a symbolic link."
    if not path.is_file():
        return None
    if tracked_by_git(root, path):
        return ("The policy file is tracked by Git, so it came from the repository, not from a person on this machine. "
                "Remove it from Git (git rm --cached .factory/local/runner.json), then enable the Factory here.")
    info = path.stat()
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        return "The policy file is not owned by the current user."
    if info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        return "The policy file can be changed by other users of this machine."
    return None


def read(root: Path) -> Dict[str, Any]:
    """The policy in force on this machine for this project folder. Disabled unless everything checks out."""
    path = policy_path(root)
    disabled = {**DISABLED, "source": "default-disabled", "problems": []}

    def refuse(problem: str) -> Dict[str, Any]:
        return {**disabled, "source": "invalid-file", "problems": [problem]}

    try:
        problem = untrusted(root)
        if problem:
            return refuse(problem)
        if not path.is_file():
            return disabled
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
    if "monitoring_requests" in data and type(data["monitoring_requests"]) is not bool:  # optional (M8): missing reads as false
        problems.append("'monitoring_requests' must be true or false")
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
    if data["autonomy"] != "observe":
        accepted = data.get("execution_risk_accepted")
        if not isinstance(accepted, dict) or accepted.get("accepted") is not True or not isinstance(accepted.get("at"), str):
            return refuse("Supervised execution needs a person to accept the execution risk (no operating-system sandbox), and this authorization records no "
                          "acceptance. Enable the Factory again and confirm with --accept-execution-risk.")
        if accepted.get("tools_digest") != tools_digest(data["allowed_tools"]):
            return refuse("The allowed tool list changed since a person accepted the execution risk for it, so the acceptance needs renewing. "
                          "Enable the Factory again and confirm with --accept-execution-risk.")
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
    # Monitoring requests (M8 D7): only this machine's explicit grant, only in supervised autonomy; the project can forbid it, never grant it.
    granted = policy.get("monitoring_requests") is True
    if granted and section.get("monitoring_requests") is False:
        granted = False
        result["restricted_by_project"].append("factory.monitoring_requests is false: issues from monitoring accounts are not taken in unattended")
    result["monitoring_requests"] = granted and result.get("autonomy") == "supervised"
    # Re-checked on every pass and before every dispatch, from the file on disk: a tracked change after enabling holds the line.
    result["security_review_problems"] = security_review_problems(tracked_config(policy.get("project_root"), config) if policy.get("project_root") else config)
    result["restricted_by_project"] += result["security_review_problems"]
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
    if policy.get("security_review_problems"):
        return False, policy["security_review_problems"][0]
    if policy.get("autonomy") != "supervised":
        return False, "the Factory is in observe mode, which never starts work"
    return True, f"runner {policy.get('runner_id')}; supervised"


# ---- the residual risk a person accepts for modes that start agents ----

# A Bash pattern that runs one of these with any arguments runs any program: an interpreter, a shell, or a launcher.
UNRESTRICTED_RE = re.compile(r"^Bash\((?:\S*/)?(python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|lua|sh|bash|zsh|dash|ksh|fish|env|xargs|exec|"
                             r"npx|npm|pnpm|yarn|uv|uvx|pip[0-9.]*|make|osascript|open|sudo|su|ssh|docker|podman) \*\)$")


def tools_digest(tools: Sequence[str]) -> str:
    """The SHA-256 of the exact allowed-tool list a person accepted (order kept)."""
    return hashlib.sha256(json.dumps(list(tools), ensure_ascii=False).encode("utf-8")).hexdigest()


def execution_risk(tools: Sequence[str]) -> Dict[str, Any]:
    """What one execution can do on this machine, worked out from the allowed tools at this moment."""
    unrestricted = [tool for tool in tools if UNRESTRICTED_RE.match(tool.strip())]
    lines = []
    if unrestricted:
        lines.append(f"With {', '.join(unrestricted)} allowed, an execution can run any program as this user, read and change this user's files "
                     "(not only this project's), and use the network.")
    else:
        shells = [tool for tool in tools if tool.startswith("Bash(")]
        lines.append("An execution can run these commands as this user: " + ", ".join(shells) + "." if shells else "An execution can run no shell command.")
    lines.append("MACH's gates (tests, verification, review, merge) check what is merged, not what an execution does outside the repository while it runs.")
    lines.append("There is no operating-system sandbox: nothing but the tool list stands between an execution and this machine.")
    return {"unrestricted_tools": unrestricted, "statement": lines, "tools_digest": tools_digest(tools),
            "to_accept": "Confirm with --confirm <code> --accept-execution-risk, only after the person has read this and said yes."}


def accept_execution_risk(policy: Dict[str, Any], by: str) -> Dict[str, Any]:
    policy["execution_risk_accepted"] = {"accepted": True, "by": by, "at": stamp(), "tools_digest": tools_digest(policy["allowed_tools"])}
    return policy


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
    monitoring = request.get("monitoring_requests") is True
    if monitoring and request.get("autonomy") != "supervised":
        raise PolicyError("--monitoring-requests needs --autonomy supervised: monitoring requests are groomed and built by executions.")
    built = {
        "schema_version": POLICY_VERSION, "enabled": True, "paused": False, "autonomy": request["autonomy"],
        "auto_sync": bool(request.get("auto_sync")), "allow_merge": bool(request.get("allow_merge")), "persistent": bool(request.get("persistent")),
        "max_risk": request.get("max_risk") or "High", "limits": limits, "allowed_tools": tools,
        "excluded_slices": sorted(set(excluded)), "source_branch": source_branch, "claude": claude,
        "runner_id": str(uuid.uuid4()), "machine": platform.node(), "project_root": str(root),
        "enabled_by": enabled_by, "enabled_at": stamp(),
        "execution_risk_accepted": None,  # set at confirmation, for a mode that starts agents, only on a person's explicit acceptance
    }
    if monitoring:
        built["monitoring_requests"] = True  # written only when granted: a file without it reads as false
    return built


def save(root: Path, policy: Dict[str, Any]) -> None:
    if tracked_by_git(root, policy_path(root)):
        raise PolicyError("The policy file .factory/local/runner.json is tracked by Git; nothing was written over it. "
                          "Remove it from Git (git rm --cached .factory/local/runner.json) and enable the Factory again.")
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


def load_pending(root: Path) -> Dict[str, Any]:
    """The pending activation, read without using it up; empty when there is none or it cannot be read."""
    path = pending_path(root)
    try:
        if path.is_symlink():
            return {}
        pending = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return pending if isinstance(pending, dict) else {}


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


def missing_flags(claude: str, root: Path) -> Tuple[Optional[List[str]], str]:
    """The flags the execution boundary depends on that this Claude Code does not offer, from its own --help."""
    try:
        done = subprocess.run([claude, "--help"], cwd=str(root), capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
                              env=executor.environment(os.environ))
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"Claude Code did not answer --help: {exc}"
    offered = set(re.findall(r"(?<![\w-])--[a-zA-Z][\w-]*", done.stdout or ""))
    return [flag for flag in executor.REQUIRED_FLAGS if flag not in offered], ""


def probe_claude(claude: str, root: Path, boundary: Dict[str, Any], workflow: str) -> Tuple[bool, str]:
    """Prove that Claude Code can run unattended here inside the same boundary an execution gets: the same
    restricted flags, the same MACH plugin, the same minimal environment, no tool at all. Fails closed."""
    missing, problem = missing_flags(claude, root)
    if missing is None:
        return False, problem
    if missing:
        return False, ("This Claude Code lacks " + ", ".join(missing) + ", which unattended execution depends on to keep your own settings, "
                       "plugins and MCP servers out of the run. Update Claude Code (2.1.322 or later was verified).")
    argv = [claude, "-p", "Reply with the single word READY and nothing else.", "--output-format", "stream-json", "--verbose",
            *executor.boundary_flags(boundary["plugin_dir"], [], boundary.get("add_dirs") or []), "--max-budget-usd", "1"]
    try:
        done = subprocess.run(argv, cwd=str(root), capture_output=True, text=True, timeout=180, stdin=subprocess.DEVNULL, env=executor.environment(os.environ))
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"Claude Code did not answer: {exc}"
    init: Optional[Dict[str, Any]] = None
    result: Optional[Dict[str, Any]] = None
    for line in (done.stdout or "").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "system" and event.get("subtype") == "init" and init is None:
            init = event
        if isinstance(event, dict) and event.get("type") == "result":
            result = event
    if result is None:
        return False, "Claude Code did not return a structured result: " + ((done.stderr or done.stdout or "").strip().splitlines() or ["no output"])[-1][:200]
    if done.returncode != 0 or result.get("is_error"):
        return False, f"Claude Code reported an error ({result.get('subtype') or done.returncode})."
    if init is None:
        return False, "Claude Code did not report how it started, so the boundary could not be confirmed."
    if init.get("permissionMode") != "default":
        return False, f"Claude Code started in permission mode '{init.get('permissionMode')}', not 'default'."
    if init.get("mcp_servers"):
        return False, "MCP servers were loaded despite --strict-mcp-config: " + ", ".join(str((item or {}).get("name")) for item in init["mcp_servers"])[:200] + "."
    if init.get("tools"):
        return False, "Tools were available although none were asked for: " + ", ".join(map(str, init["tools"]))[:200] + "."
    if workflow not in (init.get("skills") or []):
        return False, f"The MACH workflow {workflow} did not load from {boundary['plugin_dir']} in restricted mode."
    return True, f"Claude Code answered inside the execution boundary (restricted, no MCP servers, MACH loaded from {boundary['plugin_dir']})."


def preflight(root: Path, config: Dict[str, Any], request: Dict[str, Any], *, git: Any, audit: Dict[str, Any], integration: Dict[str, Any],
              m3_problem: Optional[str], workflow_installed: bool, lease_holder: Optional[str], ignored: bool, probe: bool = True,
              boundary: Optional[Callable[[], Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
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
    problem = untrusted(root)
    checks.append(check("local_policy_file", problem is None, problem or "No policy file, or one written on this machine by this user."))
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
            if not ignored:  # the MACH plugin for the run is written to .factory/local/, which must not reach Git first
                ok, detail = False, "Not checked: .factory/local/ must be ignored by Git before the execution boundary can be prepared there."
            elif boundary is None:
                ok, detail = False, "Not checked: there is no execution boundary to check."
            else:
                try:
                    prepared = boundary()
                except (executor.PluginError, OSError, UnicodeError) as exc:
                    ok, detail = False, f"MACH could not be prepared as the run's plugin: {exc}"
                else:
                    ok, detail = probe_claude(claude, root, prepared, prepared["workflow"])
            checks.append(check("claude_ready", ok, detail))
        state = audit.get("state")
        checks.append(check("audit", state in ("ok", "off"), {"ok": f"The readiness audit is current: {audit.get('tier')}.", "off": "This project has switched the audit gate off.",
                                                              "missing": "There is no readiness audit report. Run the audit first.", "stale": str(audit.get("reason") or "The readiness audit must run again."),
                                                              "bronze": "The repository's readiness tier is Bronze; unattended building is not allowed."}.get(str(state), f"Audit state: {state}.")))
        problems = security_review_problems(config)
        checks.append(check("security_review", not problems,
                            "A security reviewer's blocker cannot be outvoted, Medium and High panels keep the security seat, and High risk keeps a person's approval."
                            if not problems else " ".join(problems)))
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
