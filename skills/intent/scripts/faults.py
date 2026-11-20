#!/usr/bin/env python3
"""MACH's own internal errors, recorded on this machine so a person can report them (M14 part E).

Every MACH script with an entry point ends with the same two lines before `sys.exit(main())`:

    if __name__ == "__main__":
        import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
        with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
        sys.exit(main())

The second line finds this file beside the script's own skill folder (`intent` in the plugin, `mach-intent` in a
project install) and calls install(). If the file is missing or cannot be loaded, the line does nothing and the script
runs exactly as before. bin/mach uses the same two lines with its own two places to look.

install() puts a hook in front of Python's own handler for an uncaught exception (sys.excepthook). The hook records an
internal error and then hands the exception, unchanged, to the handler that was there before, so the traceback on
stderr and the exit code are exactly what they were. Nothing else is wrapped: no extra frame, no changed output.

What is recorded: only an uncaught exception that is not MACH's own (every exception class a MACH script defines is a
refusal, a gate or a deliberate stop), not SystemExit (argparse's usage errors and every `return n` exit through it),
not KeyboardInterrupt, not a broken pipe, not argparse.ArgumentError. One file per fingerprint, in
.factory/local/faults/<id>.json (private, in a folder that carries its own `.gitignore`), where <id> is the first 12
hex characters of the fingerprint: a SHA-256 of the script, the exception type and the innermost MACH frame's file
and function. The same fault again adds to its count and last-seen time; at most MAX_RECORDS are kept. Nothing is
recorded where there is no .factory folder. A failure to record is silent.

What a record never holds: argument values (only sub-command names that MACH's own argparse code declares),
environment values, the user's name, home folder or host name, the project's folder, repository or organisation
names, ticket IDs or titles, file contents, source lines or local variables. The exception's message is kept only
after it is redacted (the ticket station's issue_rules and the intent station's secret shapes), every path outside
MACH and every address replaced, every value known to be the project's or the machine's replaced, and every word that
appears neither in MACH's own source nor in Python's error vocabulary replaced. If the redaction helpers cannot be
loaded, the message is left out.

This file never sends anything: run.py's `report` command (selfreport.py) is the only reader that does, on a
person's yes. Standard library only; nothing is imported until a record is written.
"""

import hashlib
import json
import os
import platform
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

SCHEMA = 1
MAX_RECORDS = 50
MAX_MESSAGE = 300
MAX_FRAMES = 30
MAX_SOURCE_BYTES = 2_000_000
EXECUTION_ENV = "MACH_EXECUTION_ID"  # set by the Factory's executor on every supervised run
ID_RE = re.compile(r"^[0-9a-f]{12}$")
FINGERPRINT_RE = re.compile(r"^[0-9a-f]{64}$")
VERSION_RE = re.compile(r"^[0-9A-Za-z.+-]{1,40}$")
NAME_RE = re.compile(r"^[A-Za-z_<][A-Za-z0-9_.<>]{0,120}$")
COMMAND_RE = re.compile(r"""add_parser\(\s*["']([a-z][a-z0-9-]{0,30})["']""")
FOLDER = (".factory", "local", "faults")
HERE = os.path.dirname(os.path.realpath(__file__))
SKILLS = os.path.dirname(os.path.dirname(HERE))  # <skills>/intent/scripts/faults.py -> <skills>
PROJECT_INSTALL = os.path.basename(os.path.dirname(HERE)).startswith("mach-")
# Words Python's own error messages use, so a message keeps its meaning after every other word is replaced.
PY_WORDS = set("""
a an and are as at be by can cannot char column could decode decoder delimiter dict directory does empty encoding errno
expected expecting extra file for found from got has have in index int into invalid is item key keyword list literal
line many missing module must name no none nonetype not object of on only or out property range read required
str string such support supported than the to too type unexpected unhashable unicode utf value values was with without
write zero argument arguments attribute positional unsupported operand operands subscriptable iterable callable
concatenate base division modulo permission denied exists timeout timed refused connection reset broken pipe
recursion depth exceeded maximum unpack expected got bytes float bool tuple set path id email redacted private address
n os json subprocess int float unterminated property name enclosed double quotes
""".split())
_previous = None


def install(script: str) -> None:
    """Put the recording hook in front of the current one. Called once by the script's entry point."""
    global _previous
    if _previous is not None:
        return
    _previous = sys.excepthook
    script_path = os.path.realpath(script)

    def hook(kind: Any, value: Any, tb: Any) -> None:
        try:
            if internal(value):
                record(value, tb, script_path, list(sys.argv), dict(os.environ), os.getcwd())
        except BaseException:  # noqa: BLE001  recording never changes what happens next
            pass
        _previous(kind, value, tb)

    sys.excepthook = hook


# ---- what counts ---------------------------------------------------------------------------------

def internal(value: Any) -> bool:
    """Whether an uncaught exception is an internal error: not MACH's own class, not a stop, not a usage error."""
    if not isinstance(value, Exception) or isinstance(value, BrokenPipeError):
        return False
    for cls in type(value).__mro__:
        module = getattr(cls, "__module__", "") or ""
        if module == "argparse":
            return False
        if module == "__main__" or module.startswith("mach_"):
            return False  # the script's own class, or a MACH helper loaded under a mach_ name
        loaded = sys.modules.get(module)
        filename = getattr(loaded, "__file__", None)
        if filename and mach_path(filename):
            return False
    return True


# ---- paths and names inside MACH ---------------------------------------------------------------

def skill_name(folder: str) -> Optional[str]:
    """A MACH skill folder's name as the plugin names it, whichever way MACH is installed; None for another skill."""
    if not PROJECT_INSTALL:
        return folder
    if folder == "mach":
        return "run"
    return folder[len("mach-"):] if folder.startswith("mach-") else None


def skill_folder(skill: str) -> str:
    """The folder a skill named as the plugin names it lives in, in this install."""
    if not PROJECT_INSTALL:
        return skill
    return "mach" if skill == "run" else "mach-" + skill


def mach_path(filename: str) -> Optional[str]:
    """A file's path inside MACH (`run/scripts/run.py`, `bin/mach`), or None when it is not one of MACH's scripts."""
    try:
        real = os.path.realpath(filename)
    except (OSError, ValueError, TypeError):
        return None
    if real.startswith(SKILLS + os.sep):
        parts = real[len(SKILLS) + 1:].split(os.sep)
        if len(parts) == 3 and parts[1] == "scripts":
            skill = skill_name(parts[0])
            if skill:
                return "/".join((skill, "scripts", parts[2]))
        return None
    if os.path.basename(real) == "mach" and os.path.basename(os.path.dirname(real)) == "bin":
        return "bin/mach"
    return None


def frames(tb: Any) -> Tuple[List[Dict[str, Any]], int]:
    """MACH's own frames, outermost first: path inside MACH, line and function. Never a source line or a local."""
    kept: List[Dict[str, Any]] = []
    outside = 0
    while tb is not None:
        code = tb.tb_frame.f_code
        where = mach_path(code.co_filename)
        if where:
            name = code.co_name if NAME_RE.match(code.co_name or "") else "?"
            kept.append({"file": where, "line": int(tb.tb_lineno or 0), "function": name})
        else:
            outside += 1
        tb = tb.tb_next
    return kept[-MAX_FRAMES:], outside


def command(script: str, argv: Sequence[str]) -> List[str]:
    """The sub-command names typed, and only names MACH's own argparse code declares: never a value."""
    names: Set[str] = set()
    folder = os.path.dirname(script)
    try:
        files = [os.path.join(folder, name) for name in sorted(os.listdir(folder)) if name.endswith(".py")][:60]
    except OSError:
        files = []
    for path in [script, *files]:
        names |= set(COMMAND_RE.findall(source(path)))
    found: List[str] = []
    for token in argv[1:]:
        if token.startswith("-"):
            continue
        if token in names:
            found.append(token)
            if len(found) == 3:
                break
        elif found:
            break
    return found


def source(path: str) -> str:
    try:
        with open(path, "rb") as handle:
            return handle.read(MAX_SOURCE_BYTES).decode("utf-8", "replace")
    except OSError:
        return ""


# ---- where and what ----------------------------------------------------------------------------

def project_root(argv: Sequence[str], cwd: str) -> Optional[str]:
    """The MACH project this run belongs to: --project when it names one, else the folder above that has .factory."""
    given = None
    for index, token in enumerate(argv):
        if token == "--project" and index + 1 < len(argv):
            given = argv[index + 1]
        elif token.startswith("--project="):
            given = token.split("=", 1)[1]
    if given:
        path = os.path.realpath(os.path.join(cwd, given))
        if os.path.isdir(os.path.join(path, ".factory")):
            return path
    start = os.path.realpath(cwd)
    parts = start.split(os.sep)
    for index in range(len(parts) - 2, 0, -1):
        if parts[index] == "worktrees" and parts[index - 1] == ".factory":
            return os.sep.join(parts[:index - 1]) or os.sep
    folder = start
    while True:
        if os.path.isdir(os.path.join(folder, ".factory")):
            return folder
        parent = os.path.dirname(folder)
        if parent == folder:
            return None
        folder = parent


def mach_version(root: Optional[str]) -> Dict[str, Optional[str]]:
    """MACH's version and how it is installed: the plugin's manifest, else the project's install record."""
    plugin = os.path.join(os.path.dirname(SKILLS), ".claude-plugin", "plugin.json")
    candidates = [] if PROJECT_INSTALL else [(plugin, "plugin")]
    if root:
        candidates.append((os.path.join(root, ".factory", ".mach-manifest.json"), "project"))
    for path, kind in candidates:
        try:
            with open(path, encoding="utf-8") as handle:
                data = json.loads(handle.read(65536))
        except (OSError, ValueError):
            continue
        version = data.get("version") if isinstance(data, dict) else None
        if isinstance(version, str) and VERSION_RE.match(version):
            return {"version": version, "install": kind}
    return {"version": None, "install": "project" if PROJECT_INSTALL else None}


def exception_name(value: Any) -> str:
    cls = type(value)
    module = getattr(cls, "__module__", "") or ""
    name = cls.__qualname__ if module in ("builtins", "") else f"{module}.{cls.__qualname__}"
    return name if NAME_RE.match(name) else "Exception"


def platform_facts() -> Dict[str, str]:
    """The operating system's name and release and the processor kind: never the host name."""
    return {"system": platform.system()[:40], "release": platform.release()[:40], "machine": platform.machine()[:40]}


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- making text safe --------------------------------------------------------------------------

def _load(name: str, folders: Iterable[str]) -> Any:
    import importlib.util
    for folder in folders:
        path = os.path.join(SKILLS, folder, "scripts", name + ".py")
        if os.path.isfile(path):
            spec = importlib.util.spec_from_file_location("mach_faults_" + name, path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module
    raise ImportError(name)


def helpers() -> Tuple[Any, Any]:
    """The shared redaction (issue_rules) and secret shapes (scan). Raises when either cannot be loaded."""
    return _load("issue_rules", ("ticket", "mach-ticket")), _load("scan", ("intent", "mach-intent"))


def mask_secrets(text: str, rules: Any, scan: Any) -> str:
    text = rules.redact(text)
    for line in set(text.splitlines()):
        found, _ = scan.secrets_in_line("", line)
        for _, value in found:
            if value:
                text = text.replace(value, "<redacted>")
    return text


def secret_kinds(text: str, scan: Any) -> List[str]:
    return scan.secrets_in_text(text)


def origin_names(root: str) -> List[str]:
    """The owner and name of every remote in the project's Git settings, read from the file: no program is run."""
    git = os.path.join(root, ".git")
    config = os.path.join(git, "config")
    if os.path.isfile(git):
        try:
            with open(git, encoding="utf-8") as handle:
                pointer = handle.read(4096).strip()
            if pointer.startswith("gitdir:"):
                common = os.path.join(root, pointer[len("gitdir:"):].strip())
                config = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(common))), "config")
        except OSError:
            return []
    names: List[str] = []
    for line in source(config).splitlines()[:2000]:
        found = re.match(r"\s*url\s*=\s*(\S+)", line)
        if found:
            parts = re.split(r"[/:]", found.group(1).rstrip("/"))
            if len(parts) >= 2:
                repo = parts[-1][:-4] if parts[-1].endswith(".git") else parts[-1]
                names += [parts[-2], repo, f"{parts[-2]}/{repo}"]
    return names


def ticket_names(root: str) -> List[str]:
    """Ticket IDs and titles this project holds (cells, local tickets, the inbox), so a message never carries one."""
    found: List[str] = []
    factory = os.path.join(root, ".factory")
    for folder, suffix in (("worktrees", ""), ("tickets", ".md"), ("inbox", ".json")):
        try:
            entries = sorted(os.listdir(os.path.join(factory, folder)))[:500]
        except OSError:
            continue
        for entry in entries:
            if suffix and not entry.endswith(suffix):
                continue
            found.append(entry[:-len(suffix)] if suffix else entry)
            if folder == "tickets":
                head = source(os.path.join(factory, folder, entry))[:4000]
                title = re.search(r"^title:\s*[\"']?(.+?)[\"']?\s*$", head, re.MULTILINE)
                if title:
                    found.append(title.group(1))
    return found


def known_values(root: Optional[str], argv: Sequence[str], env: Dict[str, str], exclude: Iterable[str] = ()) -> List[str]:
    """Every value that is the person's, the project's or the machine's and could appear in a message."""
    values: Set[str] = set()
    for token in argv[1:]:
        if token.startswith("-"):
            if "=" in token:
                values.add(token.split("=", 1)[1])
            continue
        values.add(token)
    values |= {value for value in env.values() if len(value) >= 4}
    for read in (lambda: __import__("getpass").getuser(), lambda: __import__("socket").gethostname(), platform.node,
                 lambda: os.path.expanduser("~")):
        try:
            value = read()
        except Exception:  # noqa: BLE001
            continue
        if value:
            values.add(value)
            values.add(value.split(".")[0])
            values.add(os.path.basename(value))
    if root:
        values.add(root)
        home = os.path.expanduser("~")
        inside = root[len(home):] if root.startswith(home + os.sep) else root
        values |= {part for part in inside.split(os.sep) if len(part) >= 3}
        values |= set(origin_names(root))
        values |= set(ticket_names(root))
    leave = set(exclude)
    return sorted((v for v in values if v and v.strip() and v not in leave and v not in ("/", ".", "..")), key=len, reverse=True)


PATH_RE = re.compile(r"(?<![\w.:/-])(?:~|/)[^\s'\"`,;()\[\]{}<>]*")
URL_RE = re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]{1,20}://[^\s'\"`<>]+")
TICKETLIKE_RE = re.compile(r"\b[A-Za-z][A-Za-z0-9_]*-\d+\b")
ISSUE_RE = re.compile(r"#\d+\b")
WORD_RE = re.compile(r"[A-Za-z0-9_]+")
# While text is scrubbed, what was replaced is held as a private-use character no value can contain, so a later
# step never rewrites an earlier replacement; each becomes its <word> at the end.
HELD = {"\ue010": "<address>", "\ue011": "<path>", "\ue012": "<value>", "\ue013": "<id>", "\ue014": "#<n>"}
MACH_HELD = 0xE100  # a path inside MACH is held as one character from here up, and kept as it is


def vocabulary(files: Iterable[str]) -> Set[str]:
    words = set(PY_WORDS)
    for path in [os.path.realpath(__file__), *files]:
        words |= {word.lower() for word in WORD_RE.findall(source(path))}
    return words


def scrub(text: str, known: Sequence[str], vocab: Optional[Set[str]], rules: Any, scan: Any, limit: int = MAX_MESSAGE) -> str:
    """One line of text with nothing of the person's, the project's or the machine's left in it.

    In order: addresses, then paths (a path inside MACH is kept as its path inside MACH), then every known value,
    then the shared redaction and secret shapes, then anything shaped like a ticket ID or an issue number, then
    (with a vocabulary) every word that is neither MACH's nor Python's."""
    text = "".join(ch if ch.isprintable() and not "\ue000" <= ch <= "\uf8ff" else " " for ch in str(text)[:limit * 12])
    text = " ".join(text.split())
    text = URL_RE.sub("\ue010", text)
    kept: List[str] = []

    def path(match: "re.Match[str]") -> str:
        inside = mach_path(os.path.expanduser(match.group(0)))
        if inside and len(kept) < 200:
            kept.append(inside)
            return chr(MACH_HELD + len(kept) - 1)
        return "\ue011"

    text = PATH_RE.sub(path, text)
    for value in known:
        if len(value) >= 4:
            text = re.sub(re.escape(value), "\ue012", text, flags=re.IGNORECASE)
        else:
            text = re.sub(r"(?<![A-Za-z0-9_])" + re.escape(value) + r"(?![A-Za-z0-9_])", "\ue012", text)
    text = mask_secrets(text, rules, scan)
    text = TICKETLIKE_RE.sub("\ue013", text)
    text = ISSUE_RE.sub("\ue014", text)
    if vocab is not None:
        def word(match: "re.Match[str]") -> str:
            token = match.group(0)
            if token.lower() in vocab or (token.isdigit() and len(token) <= 6):
                return token
            return "…"

        text = WORD_RE.sub(word, text)
        text = re.sub(r"…(?:[\s_.\-/:'\"]*…)+", "…", text)
    text = "".join(kept[ord(ch) - MACH_HELD] if MACH_HELD <= ord(ch) < MACH_HELD + len(kept) else ch for ch in text)
    for held, shown in HELD.items():
        text = text.replace(held, shown)
    if len(text) > limit:
        text = text[:limit - 1].rstrip() + "…"
    return text


# ---- the record --------------------------------------------------------------------------------

def folder(root: str) -> str:
    return os.path.join(root, *FOLDER)


def write_private(path: str, text: str) -> None:
    """Write a file only this user can read, atomically, in a folder that is never followed through a link."""
    local = os.path.dirname(os.path.dirname(path))
    for part in (local, os.path.dirname(path)):
        if os.path.islink(part):
            raise OSError("a link stands where the private folder belongs")
        if not os.path.isdir(part):
            os.mkdir(part, 0o700)
    ignore = os.path.join(os.path.dirname(path), ".gitignore")
    if not os.path.exists(ignore):
        with open(ignore, "w", encoding="utf-8") as handle:
            handle.write("*\n")
    if os.path.islink(path):
        raise OSError("a link stands where the record belongs")
    temporary = path + ".tmp"
    handle = os.open(temporary, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "w", encoding="utf-8") as out:
        out.write(text)
    os.replace(temporary, path)


def fingerprint(script: str, exception: str, innermost: Optional[Dict[str, Any]]) -> str:
    where = f"{innermost['file']}\n{innermost['function']}" if innermost else "\n"
    return hashlib.sha256(f"{script}\n{exception}\n{where}".encode("utf-8")).hexdigest()


def record(value: Any, tb: Any, script: str, argv: Sequence[str], env: Dict[str, str], cwd: str) -> Optional[str]:
    """Record one internal error. Returns the record's path, or None when there is no project to record it in."""
    root = project_root(argv, cwd)
    if root is None:
        return None
    name = mach_path(script) or os.path.basename(script)[:60]
    kept, outside = frames(tb)
    exception = exception_name(value)
    print_ = fingerprint(name, exception, kept[-1] if kept else None)
    names = command(script, argv)
    try:
        rules, scan = helpers()
        try:
            raw = str(value)
        except Exception:  # noqa: BLE001
            raw = ""
        sources = {os.path.join(SKILLS, skill_folder(frame["file"].split("/")[0]), *frame["file"].split("/")[1:]) for frame in kept if frame["file"] != "bin/mach"}
        sources.add(script)
        message: Optional[str] = scrub(raw, known_values(root, argv, env, names), vocabulary(sorted(sources)), rules, scan)
    except Exception:  # noqa: BLE001  without the shared redaction the message is left out
        message = None
    path = os.path.join(folder(root), print_[:12] + ".json")
    moment = now()
    existing = read(path)
    if existing and existing.get("fingerprint") == print_:
        data = existing
        data["count"] = int(data.get("count") or 0) + 1
        data["last_seen"] = moment
    else:
        data = {"schema": SCHEMA, "id": print_[:12], "fingerprint": print_, "first_seen": moment, "last_seen": moment, "count": 1, "reported": None}
    data.update({"mach": mach_version(root), "script": name, "command": names, "exception": exception, "message": message,
                 "message_left_out": message is None, "traceback": kept, "frames_outside_mach": outside,
                 "platform": platform_facts(), "python": platform.python_version()[:20],
                 "supervised": bool(env.get(EXECUTION_ENV))})
    write_private(path, json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
    prune(folder(root), keep=path)
    return path


def read(path: str) -> Optional[Dict[str, Any]]:
    try:
        if os.path.islink(path):
            return None
        with open(path, encoding="utf-8") as handle:
            data = json.loads(handle.read(1_000_000))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not ID_RE.match(str(data.get("id"))) or not FINGERPRINT_RE.match(str(data.get("fingerprint"))):
        return None
    return data


def prune(where: str, keep: str) -> None:
    """At most MAX_RECORDS: the reported ones go first, then the least recently seen."""
    entries = [os.path.join(where, name) for name in os.listdir(where) if name.endswith(".json") and ID_RE.match(name[:-5])]
    if len(entries) <= MAX_RECORDS:
        return
    dated = []
    for path in entries:
        data = read(path) or {}
        dated.append((data.get("reported") is None, str(data.get("last_seen") or ""), path))
    for _, _, path in sorted(dated)[:len(entries) - MAX_RECORDS]:
        if path != keep:
            try:
                os.remove(path)
            except OSError:
                pass


# ---- reading, for run.py -----------------------------------------------------------------------

def records(root: str) -> List[Dict[str, Any]]:
    """Every readable record, most recently seen first. Reads only; never creates the folder."""
    where = folder(str(root))
    if os.path.islink(where) or not os.path.isdir(where):
        return []
    found = []
    for name in sorted(os.listdir(where))[:MAX_RECORDS * 4]:
        if name.endswith(".json") and ID_RE.match(name[:-5]):
            data = read(os.path.join(where, name))
            if data and data["id"] == name[:-5]:
                found.append(data)
    return sorted(found, key=lambda item: str(item.get("last_seen") or ""), reverse=True)


def unreported(root: str) -> List[Dict[str, Any]]:
    return [item for item in records(root) if not item.get("reported")]


def load(root: str, fault_id: str) -> Optional[Dict[str, Any]]:
    if not ID_RE.match(fault_id or ""):
        return None
    data = read(os.path.join(folder(str(root)), fault_id + ".json"))
    return data if data and data["id"] == fault_id else None


def mark_reported(root: str, fault_id: str, url: str, how: str) -> None:
    """After a person filed it: the address of the issue it was filed as or added to, and when."""
    path = os.path.join(folder(str(root)), fault_id + ".json")
    data = read(path)
    if data is None:
        return
    data["reported"] = {"at": now(), "url": url, "as": how, "count": data.get("count")}
    write_private(path, json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n")


def offer(count: int, report_command: str) -> str:
    """The one line status, next and doctor add while unreported internal errors exist."""
    errors = "internal error" if count == 1 else "internal errors"
    return f"MACH hit {count} {errors} on this machine. {report_command} shows what would be sent."


def summary(item: Dict[str, Any]) -> str:
    """One fault in a few identifiers: its id, exception, script, command and count."""
    script = os.path.basename(str(item.get("script") or "?"))
    words = " ".join([script, *[str(name) for name in item.get("command") or []]])
    count = int(item.get("count") or 0)
    return f"{item['id']} ({item.get('exception')} in {words}, {count} time{'s' if count != 1 else ''})"
