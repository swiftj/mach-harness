#!/usr/bin/env python3
"""The Factory's execution adapter: start one unattended Claude Code run for a ticket, and read what happened.

One execution is one `claude -p` process that launches the existing MACH belt workflow for one
ticket. This module builds that command, starts it detached behind a small wrapper, and turns
its output into facts a supervisor can act on.

The command is fixed and explicit:

    claude -p "<a fixed prompt naming the workflow and the ticket>"
        --output-format stream-json --verbose     structured events and a final result
        --restricted                              the person's own settings files, plugins, agents and
                                                  hooks are not loaded; file tools stay in the project
        --strict-mcp-config                       no MCP server is loaded at all
        --plugin-dir <MACH, at a stable path>     the only skills, agents and workflow the run has
        --permission-mode default                 nothing is allowed unless it is listed
        --permission-prompts none                 anything that would ask is refused, never asked
        --tools <the built-in tools the list names>
        [--max-budget-usd <limit>, only when a spending limit is set]  --session-id <a new id>
        [--add-dir <the MACH plugin, when it lives outside the project>]
        --disallowedTools <edits to MACH itself and to the Factory's local state>
        --allowedTools <the list a person consented to>

Without `--restricted`, allow rules in the person's own Claude settings (for example
`Bash(curl:*)` or `Bash(git push:*)`) are added to the list, and every plugin, MCP server, agent and
hook they have installed is loaded into the run: then the list bounds nothing. With it, a use that
is not listed is refused, the refusal is in the output, and the supervisor raises it to a person.
Restricted mode also drops the project's own .claude/ skills, agents and workflows, so MACH is
loaded explicitly as a plugin (`plugin()`). Nothing here ever passes a flag that skips permission
checks.

The run gets a minimal environment (`environment()`): it signs in with the person's own Claude Code
login, and no API key, token or other credential in the supervisor's environment reaches it.

The wrapper exists so that an execution outlives the supervisor that started it and still leaves a
record: it writes started.json when the process is running and result.json when it ends, whatever
happened to the supervisor meanwhile. Its command line carries the execution ID, so a process ID
can be checked against the execution it is supposed to be.

What the ticket's state is afterwards is never taken from this output. It is read from the cell's
own records by run.py, as always.

Standard library only.
"""

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
EXECUTION_ID_RE = re.compile(r"^x[0-9a-f]{12}$")
ENV = {"CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS": "0",  # wait for the workflow however long it runs
       "GIT_TERMINAL_PROMPT": "0"}                    # a Git command that wants a password fails instead of hanging
GRACE_SECONDS = 20
WORKFLOW = "mach:belt"  # MACH is always loaded as the plugin named mach, whichever way it is installed
# What the run inherits from the supervisor's environment, and nothing else. No API key or token: the
# run signs in with the person's own Claude Code login. CLAUDE_CONFIG_DIR is a folder, needed to find that login.
PASSED_ENV = ("HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SHELL", "TERM", "CLAUDE_CONFIG_DIR")
PROXY_ENV = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy")  # passed only without a user:password part
# The execution's own ID, so the station scripts the run starts can stamp their lifecycle records with it (M6.1).
# The same name as lifecycle.ENV in the intent station. An identifier, never a credential.
EXECUTION_ENV = "MACH_EXECUTION_ID"
CREDENTIAL_NAME_RE = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE", re.IGNORECASE)
# The flags the boundary depends on. A Claude Code whose --help lacks any of them is refused by the preflight.
REQUIRED_FLAGS = ("--restricted", "--strict-mcp-config", "--plugin-dir", "--permission-mode", "--permission-prompts", "--tools",
                  "--allowedTools", "--disallowedTools", "--add-dir", "--max-budget-usd", "--session-id", "--output-format")
TOOL_NAME_RE = re.compile(r"^[A-Z][A-Za-z]*$")
PLUGIN_FOLDER = "claude-plugin"
PLUGIN_STAMP = ".mach-factory-plugin.json"
NOT_FOR_THE_FACTORY = ("studio", "idea")  # people's skills (a product manager's, anyone's idea); an unattended run has no use for them


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def folder(root: Path, execution_id: str) -> Path:
    if not EXECUTION_ID_RE.match(execution_id):
        raise ValueError(f"'{execution_id}' is not an execution ID.")
    return root / ".factory" / "local" / "executions" / execution_id


def prompt(workflow: str, tickets: Sequence[str], until: Optional[str]) -> str:
    """The whole instruction given to the unattended run. It contains ticket IDs and nothing a
    product manager or a ticket wrote."""
    for ticket in tickets:
        if not TICKET_ID_RE.match(ticket):
            raise ValueError(f"'{ticket}' is not a usable ticket ID.")
    args: Dict[str, Any] = {"tickets": list(tickets)}
    if until:
        args["until"] = until
    return (f"Run the workflow named {workflow} with args {json.dumps(args)}. Use the Workflow tool. "
            "When it has finished, reply with only the JSON it returned. If you are refused, say so and stop.")


def builtin_tools(tools: Sequence[str]) -> List[str]:
    """The built-in tools a run is given: exactly those the consented list names ('Bash(git log *)' names Bash).
    Restricted mode removes every other built-in tool, so nothing outside the list even exists in the run."""
    names = [tool.strip().split("(", 1)[0] for tool in tools]
    return list(dict.fromkeys(name for name in names if TOOL_NAME_RE.match(name)))


def protected(root: Path, plugin_dir: Path) -> List[str]:
    """Edits no run may make with the file tools, whatever the allow list says: MACH's own code and the
    Factory's machine-local state (its policy, its records of executions). A second layer only: a run that
    may run Python could still write files, so this does not replace the allow list."""
    paths = [Path(plugin_dir), root / ".factory" / "local", root / ".claude"]
    return list(dict.fromkeys(f"Edit(/{path}/**)" for path in paths))


def boundary_flags(plugin_dir: Path, tools: Sequence[str], add_dirs: Sequence[Path] = (), denied: Sequence[str] = ()) -> List[str]:
    """Everything that makes the allow list a real boundary. Shared with the preflight's probe, so what is
    checked is what is run."""
    flags = ["--restricted", "--strict-mcp-config", "--plugin-dir", str(plugin_dir),
             "--permission-mode", "default", "--permission-prompts", "none", "--tools", ",".join(builtin_tools(tools))]
    for folder in add_dirs:
        flags += ["--add-dir", str(folder)]
    if denied:
        flags += ["--disallowedTools", *denied]
    return flags


def command(claude: str, workflow: str, tickets: Sequence[str], until: Optional[str], tools: Sequence[str], budget_usd: Optional[float], session_id: str,
            plugin_dir: Path, add_dirs: Sequence[Path] = (), denied: Sequence[str] = ()) -> List[str]:
    """`budget_usd` None: no spending limit was set on this machine or in the project, so Claude is given none."""
    for tool in tools:
        if tool.strip() in ("Bash", "Bash(*)", "*") or "dangerously" in tool:
            raise ValueError("The tool list may not allow every shell command.")
    if not Path(plugin_dir).is_absolute():
        raise ValueError("The MACH plugin folder must be an absolute path.")
    budget = ["--max-budget-usd", format(budget_usd, "g")] if budget_usd is not None else []
    # --allowedTools stays last: it takes every word after it, and it is exactly the tool list in the authorization.
    return [claude, "-p", prompt(workflow, tickets, until), "--output-format", "stream-json", "--verbose",
            *boundary_flags(plugin_dir, tools, add_dirs, denied),
            *budget, "--session-id", session_id, "--allowedTools", *tools]


def environment(base: Mapping[str, str]) -> Dict[str, str]:
    """The run's whole environment: what it needs to find its programs and the person's own login, and nothing
    that carries a credential. A key or token in the supervisor's environment never reaches the run."""
    env = {name: base[name] for name in PASSED_ENV if base.get(name)}
    for name in PROXY_ENV:
        value = base.get(name)
        if value and "@" not in value:
            env[name] = value
    env.update(ENV)
    return {name: value for name, value in env.items() if not CREDENTIAL_NAME_RE.search(name)}


# ---- MACH as the run's only plugin ----


class PluginError(Exception):
    """MACH could not be prepared as a plugin for an unattended run; nothing is started."""


def plugin(root: Path, run_script: Path) -> Dict[str, Any]:
    """Where the run loads MACH from, and the workflow's name there.

    Restricted mode ignores the project's .claude/ folder, so MACH is always loaded with --plugin-dir:
    - installed as a plugin: that plugin's own folder;
    - installed by script into .claude/: a plugin generated from those installed files, at a stable path in
      the project's git-ignored local state (.factory/local/claude-plugin/), never a temporary folder.
    In both cases the names are the plugin's: mach:belt, mach:builder, /mach:run.
    """
    skill = Path(run_script).resolve().parent.parent
    if skill.name == "mach" or skill.name.startswith("mach-"):
        folder = project_plugin(root)
        return {"kind": "project", "plugin_dir": folder, "workflow": WORKFLOW, "add_dirs": [], "denied": protected(root, folder)}
    folder = skill.parent.parent
    if not (folder / ".claude-plugin" / "plugin.json").is_file():
        raise PluginError(f"MACH's run skill at {skill} is neither in a plugin nor installed in a project's .claude folder.")
    outside = not inside(folder, root)
    # Restricted mode keeps the file tools inside the working folders; reviewers read their briefs from the plugin.
    # A project that is itself MACH's source (MACH building MACH) keeps its own files editable.
    denied = protected(root, folder) if not inside(root, folder) else protected(root, root / ".factory" / "local")
    return {"kind": "plugin", "plugin_dir": folder, "workflow": WORKFLOW, "add_dirs": [folder] if outside else [], "denied": denied}


def inside(path: Path, folder: Path) -> bool:
    try:
        Path(path).resolve().relative_to(Path(folder).resolve())
        return True
    except ValueError:
        return False


def unprefixed(text: str, name: str) -> str:
    """The installer's renaming undone: front matter 'name: mach-build' back to 'name: build'."""
    if not text.startswith("---\n"):
        return text
    end = text.find("\n---", 4)
    if end < 0:
        return text
    installed = "mach" if name == "run" else f"mach-{name}"  # the run skill is plain 'mach' in a project
    head = re.sub(rf"(?m)^name:\s*{re.escape(installed)}\s*$", f"name: {name}", text[:end], count=1)
    return head + text[end:]


def project_files(root: Path) -> Dict[str, bytes]:
    """The plugin's files, built from a script install's .claude/ folder by undoing the installer's renames."""
    source = root / ".claude"
    files: Dict[str, bytes] = {}
    stations = []
    skills = source / "skills"
    for skill in sorted([*skills.glob("mach-*"), skills / "mach"]) if skills.is_dir() else []:
        station = "run" if skill.name == "mach" else skill.name[len("mach-"):]
        if skill.is_symlink() or not skill.is_dir() or station in NOT_FOR_THE_FACTORY:
            continue
        stations.append(station)
        for path in sorted(skill.rglob("*")):
            relative = path.relative_to(skill)
            if path.is_symlink() or not path.is_file() or "__pycache__" in relative.parts:
                continue
            data = path.read_bytes()
            if relative.as_posix() == "SKILL.md":
                text = unprefixed(data.decode("utf-8"), station)
                # A skill that runs another skill's script names its folder: .claude/skills/mach-studio/ (or .claude/skills/mach/
                # for the run skill) in a project, skills/studio/ (skills/run/) here.
                text = re.sub(r"(\$\{CLAUDE_SKILL_DIR\}/\.\./)mach-([a-z0-9-]+)/", r"\1\2/", text)
                text = re.sub(r"(\$\{CLAUDE_SKILL_DIR\}/\.\./)mach/", r"\1run/", text)
                data = text.encode("utf-8")
            files[f"skills/{station}/{relative.as_posix()}"] = data
    if "run" not in stations:
        raise PluginError("MACH's run skill is not installed in this project's .claude/skills.")
    agents = source / "agents"
    for path in sorted(agents.glob("mach-*.md")) if agents.is_dir() else []:
        if path.is_symlink() or not path.is_file():
            continue
        name = path.stem[len("mach-"):]
        files[f"agents/{name}.md"] = unprefixed(path.read_text(encoding="utf-8"), name).encode("utf-8")
    workflows = source / "workflows"
    belt = workflows / "mach-belt.js"
    if belt.is_symlink() or not belt.is_file():
        raise PluginError("The MACH belt workflow is not installed in this project's .claude/workflows.")
    for path in sorted(workflows.glob("mach-*.js")):
        if path.is_symlink() or not path.is_file():
            continue
        name = path.stem[len("mach-"):]
        installed = path.read_text(encoding="utf-8")
        # Only a skill command where a person would type one: never a path such as .claude/skills/mach-build/ or
        # .claude/skills/mach/. In a project the run skill's command is plain /mach.
        text = re.sub(r"(?<![\w./-])/mach-(%s)\b" % "|".join(map(re.escape, stations)), r"/mach:\1", installed)
        text = re.sub(r"(?<![\w./-])/mach(?![\w:/.-])", "/mach:run", text)
        text = text.replace(f"  name: 'mach-{name}',", f"  name: '{name}',", 1)
        if re.sub(r"/mach:run\b", "/mach", text).replace("/mach:", "/mach-").replace(f"  name: '{name}',", f"  name: 'mach-{name}',", 1) != installed:
            raise PluginError(f"The installed workflow {path.name} could not be mapped back to MACH's plugin names.")
        files[f"workflows/{name}.js"] = text.encode("utf-8")
    version = "0.0.0"
    manifest = read_json(root / ".factory" / ".mach-manifest.json")
    if manifest and isinstance(manifest.get("version"), str) and re.match(r"^[0-9A-Za-z.+-]{1,40}$", manifest["version"]):
        version = manifest["version"]
    files[".claude-plugin/plugin.json"] = (json.dumps({"name": "mach", "version": version,
                                                       "description": "MACH as installed in this project, loaded by the Factory for unattended runs. Generated; do not edit."},
                                                      indent=2) + "\n").encode("utf-8")
    return files


def project_plugin(root: Path) -> Path:
    """Write the generated plugin, or leave it alone when it already matches what is installed.

    The path never changes. It is rebuilt only when the installed files change, beside the old one and then
    swapped in, so a run that is reading it sees a whole plugin."""
    local = root / ".factory" / "local"
    for path in (root / ".factory", local):
        if path.is_symlink():
            raise PluginError(f"{path} is a symbolic link; the Factory's plugin is not written through one.")
    target = local / PLUGIN_FOLDER
    if target.is_symlink():
        raise PluginError(f"{target} is a symbolic link; the Factory's plugin is not written through one.")
    files = project_files(root)
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode("utf-8") + b"\0" + hashlib.sha256(files[name]).digest())
    stamp = read_json(target / PLUGIN_STAMP)
    if target.is_dir() and stamp and stamp.get("digest") == digest.hexdigest():
        return target
    local.mkdir(parents=True, exist_ok=True)
    os.chmod(str(local), 0o700)
    fresh = local / f"{PLUGIN_FOLDER}.next-{os.getpid()}"
    shutil.rmtree(str(fresh), ignore_errors=True)
    for name, data in files.items():
        path = fresh / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    write_json(fresh / PLUGIN_STAMP, {"digest": digest.hexdigest(), "generated_at": now(), "from": ".claude"})
    old = local / f"{PLUGIN_FOLDER}.old-{os.getpid()}"
    if target.exists():
        os.replace(str(target), str(old))
    os.replace(str(fresh), str(target))
    shutil.rmtree(str(old), ignore_errors=True)
    return target


def write_json(path: Path, data: Dict[str, Any]) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(str(temporary), str(path))


def read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def prepare(root: Path, execution_id: str, argv: Sequence[str], timeout_minutes: float, watch: Optional[Dict[str, Any]] = None) -> Path:
    """Write what the wrapper will run. Kept on disk so a restart can see exactly what was asked.
    `watch` ({"session_pid"}): started by a supervisor tied to a Claude Code session, the run ends when that session
    process is gone, recorded as "session-ended", unless the supervisor has meanwhile become a background one."""
    home = folder(root, execution_id)
    home.mkdir(parents=True, exist_ok=True)
    os.chmod(str(home), 0o700)
    spec = {"execution_id": execution_id, "argv": list(argv), "cwd": str(root), "timeout_seconds": int(timeout_minutes * 60), "prepared_at": now()}
    if watch:
        spec["watch"] = {"session_pid": watch.get("session_pid")}
    write_json(home / "spec.json", spec)
    return home


SESSION_ENDED = "session-ended"  # how an execution ended when the Claude Code session its supervisor belonged to ended
READY_SECONDS = 10  # how long a stop waits for a wrapper that has just been started to say it is ready
SESSION_MARK = "session-ended"   # the file a supervisor leaves in an execution's folder before it stops it for that reason
STOPPED_BY_PERSON = "stopped-by-person"  # how an execution ended when a person stopped the Factory (/mach stop)
STOP_MARK = "stopped-by-person"          # the file factory stop leaves in an execution's folder before it stops it
TAKEN_OVER = "taken-over-by-person"  # how an execution ended when a person took its ticket over (run.py next, by a person)
TAKEN_OVER_MARK = "taken-over-by-person"  # the file a person's take-over leaves in the execution's folder before it stops it
PAUSED = (SESSION_ENDED, STOPPED_BY_PERSON, TAKEN_OVER)  # ends that pause the work: nothing parked, no attempt counted


def process_alive(pid: Any) -> bool:
    """Whether a process exists. Replaced in tests."""
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def background_now(root: Path) -> bool:
    """Whether the supervisor became a background one after this run started (factory start converts a session one)."""
    for path in (root / ".factory" / "local" / "supervisor.json", root / ".factory" / "local" / "lifetime.json"):
        data = read_json(path)
        if data and data.get("lifetime") == "background":
            return True
    return False


def session_gone(root: Path, watch: Optional[Dict[str, Any]]) -> bool:
    """For a run tied to a session: whether its supervisor or its session has ended. False for any other run."""
    if not watch or background_now(root):
        return False
    # The session only. A supervisor that ends while the session lives (disabled, a lost lease, a crash) leaves its runs to
    # finish, and the next supervisor adopts them, as for any run.
    session = watch.get("session_pid")
    return type(session) is int and not process_alive(session)


def launch(root: Path, execution_id: str, run_script: Path) -> int:
    """Start the wrapper detached, in its own session, and return its process ID."""
    home = folder(root, execution_id)
    with (home / "wrapper.log").open("ab") as log:
        process = subprocess.Popen([sys.executable, str(run_script), "--project", str(root), "factory", "exec", execution_id],
                                   cwd=str(root), stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    return process.pid


def wrapper(root: Path, execution_id: str) -> int:
    """Run one prepared execution to its end and record how it ended. This is the detached process."""
    home = folder(root, execution_id)
    spec = read_json(home / "spec.json")
    if not spec or (home / "result.json").exists() or (home / "started.json").exists():
        return 2  # nothing prepared, or this execution was already started once: never run it twice
    env = environment(os.environ)  # never the supervisor's whole environment: no key or token reaches the run
    env[EXECUTION_ENV] = execution_id  # inherited by the run's shell commands, so station scripts can say which execution ran them
    interrupted = {"signal": None}

    def stop(number: int, frame: Any) -> None:
        interrupted["signal"] = number

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    started = time.time()
    with (home / "stream.jsonl").open("wb") as out, (home / "stderr.log").open("wb") as err:
        try:
            child = subprocess.Popen(spec["argv"], cwd=spec["cwd"], env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err)
        except OSError as exc:
            write_json(home / "result.json", {"execution_id": execution_id, "ended": "could-not-start", "exit_code": None, "error": str(exc), "ended_at": now()})
            return 1
        write_json(home / "started.json", {"execution_id": execution_id, "wrapper_pid": os.getpid(), "child_pid": child.pid, "started_at": now()})
        ended = "exited"
        root = Path(spec["cwd"])
        while True:
            try:
                code: Optional[int] = child.wait(timeout=1)
                break
            except subprocess.TimeoutExpired:
                pass
            too_long = time.time() - started > spec["timeout_seconds"]
            session_over = session_gone(root, spec.get("watch"))
            if session_over or (home / SESSION_MARK).exists():
                session_over = True
            by_person = (home / STOP_MARK).exists()
            taken = (home / TAKEN_OVER_MARK).exists()
            if interrupted["signal"] is not None or too_long or session_over or by_person or taken:
                ended = (TAKEN_OVER if taken else STOPPED_BY_PERSON if by_person else SESSION_ENDED if session_over else
                         "timed-out" if too_long and interrupted["signal"] is None else "interrupted")
                child.terminate()
                try:
                    code = child.wait(timeout=GRACE_SECONDS)
                except subprocess.TimeoutExpired:
                    child.kill()
                    code = child.wait()
                break
    write_json(home / "result.json", {"execution_id": execution_id, "ended": ended, "exit_code": code, "ended_at": now(), "seconds": int(time.time() - started)})
    return 0


def command_of(pid: int) -> str:
    try:
        return subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def alive(pid: Any, execution_id: str) -> bool:
    """Whether this process ID is still the wrapper of this execution, not some later process that reused the number."""
    return type(pid) is int and pid > 0 and execution_id in command_of(pid)


def stop(pid: Any, execution_id: str, root: Optional[Path] = None) -> bool:
    """Ask a running execution to stop. The wrapper ends its Claude process and records the interruption.
    A wrapper that has only just been started has not yet said it is ready (started.json): a signal then would end it
    before it could record anything, so it is given a few seconds to get there first."""
    if not alive(pid, execution_id):
        return False
    if root is not None:
        ready, deadline = folder(root, execution_id) / "started.json", time.time() + READY_SECONDS
        while not ready.exists() and time.time() < deadline and alive(pid, execution_id):
            time.sleep(0.1)
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    return True


def end_for_session(root: Path, pid: Any, execution_id: str) -> bool:
    """Stop a running execution because its session ended: the mark first, so the wrapper records "session-ended"."""
    return marked_stop(root, pid, execution_id, SESSION_MARK)


def end_by_person(root: Path, pid: Any, execution_id: str) -> bool:
    """Stop a running execution because a person stopped the Factory (/mach stop): the mark first, so the wrapper records
    "stopped-by-person". Like a session's end, it pauses the work; the next pull or factory start carries it on."""
    return marked_stop(root, pid, execution_id, STOP_MARK)


def end_for_takeover(root: Path, pid: Any, execution_id: str) -> bool:
    """Stop a running execution because a person took its ticket over: the mark first, so the wrapper records "taken-over-by-person".
    Nothing is parked and no attempt counted; the ticket is the person's from then on."""
    return marked_stop(root, pid, execution_id, TAKEN_OVER_MARK)


def marked_stop(root: Path, pid: Any, execution_id: str, mark: str) -> bool:
    try:
        (folder(root, execution_id) / mark).write_text(now() + "\n", encoding="utf-8")
    except OSError:
        pass
    return stop(pid, execution_id, root)


def paused_how(root: Path, execution_id: str) -> Optional[str]:
    """How a run was paused, from the mark left in its folder: "taken-over-by-person", "stopped-by-person", "session-ended", or None."""
    home = folder(root, execution_id)
    if (home / TAKEN_OVER_MARK).exists():
        return TAKEN_OVER
    if (home / STOP_MARK).exists():
        return STOPPED_BY_PERSON
    if (home / SESSION_MARK).exists():
        return SESSION_ENDED
    return None


def tool_summary(name: Any, tool_input: Any) -> str:
    """Enough of a refused request for a person to recognise it, and no more: the program a shell
    command would have run, and its subcommand if it has one. Never arguments, paths, variables or file contents."""
    if name == "Bash" and isinstance(tool_input, dict):
        words = str(tool_input.get("command") or "").split()
        while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
            words.pop(0)  # VAR=value prefixes can carry anything
        if not words:
            return "Bash"
        program = Path(words[0]).name[:30]
        sub = words[1] if len(words) > 1 and re.match(r"^[a-z][a-z-]{1,20}$", words[1]) and program in ("git", "gh", "npm", "pnpm", "yarn", "make", "cargo", "go", "docker", "pip", "uv") else ""
        return f"Bash: {program} {sub}".strip()
    return re.sub(r"[^A-Za-z0-9_:.-]", "", str(name))[:60]


def outcome(root: Path, execution_id: str) -> Dict[str, Any]:
    """What is known about an execution from the files it left: started or not, ended or not, and Claude's own report."""
    home = folder(root, execution_id)
    started = read_json(home / "started.json")
    result = read_json(home / "result.json")
    report: Dict[str, Any] = {"execution_id": execution_id, "started": started is not None, "ended": result is not None,
                              "wrapper_pid": (started or {}).get("wrapper_pid"), "started_at": (started or {}).get("started_at"),
                              "how": (result or {}).get("ended"), "exit_code": (result or {}).get("exit_code"), "ended_at": (result or {}).get("ended_at"),
                              "session_id": None, "is_error": None, "subtype": None, "cost_usd": None, "refused_tools": [], "workflow": None}
    if report["how"] == "exited" and isinstance(report["exit_code"], int) and report["exit_code"] < 0:
        # The wrapper was not asked to stop, but Claude Code ended on a signal (exit code -N): something killed it.
        report["how"] = "killed"
    stream = home / "stream.jsonl"
    if not stream.is_file():
        return report
    last: Optional[Dict[str, Any]] = None
    refused: List[str] = []
    try:
        with stream.open("r", encoding="utf-8", errors="replace") as lines:
            for line in lines:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                report["session_id"] = report["session_id"] or event.get("session_id")
                if event.get("type") == "system" and event.get("subtype") == "permission_denied":
                    refused.append(tool_summary(event.get("tool_name"), event.get("tool_input")))
                if event.get("type") == "result":
                    last = event
                    refused += [tool_summary(item.get("tool_name"), item.get("tool_input")) for item in event.get("permission_denials") or [] if isinstance(item, dict)]
    except OSError:
        return report
    report["refused_tools"] = sorted(set(refused))
    if last is not None:
        report.update({"is_error": bool(last.get("is_error")), "subtype": last.get("subtype"), "cost_usd": last.get("total_cost_usd")})
        text = last.get("result")
        if isinstance(text, str):
            try:
                parsed = json.loads(text[text.index("{"):text.rindex("}") + 1])
            except ValueError:
                parsed = None
            if isinstance(parsed, dict):
                # Only the workflow's own summary of where each ticket stopped; never free text.
                tickets = [{key: str(item.get(key))[:200] for key in ("ticket", "outcome", "stage", "waiting_for") if item.get(key) is not None}
                           for item in parsed.get("tickets") or [] if isinstance(item, dict)]
                report["workflow"] = {"tickets": tickets, "error": str(parsed["error"])[:300] if parsed.get("error") else None}
    return report
