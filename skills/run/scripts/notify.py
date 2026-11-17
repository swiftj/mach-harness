#!/usr/bin/env python3
"""Notifications (M10): one message on each channel that is on when a ticket is waiting for a person.

Two channels, each off until a person turns it on on this machine: a webhook (Slack or Discord) and, on
macOS only, a Notification Center banner shown with /usr/bin/osascript (no shell; the words are arguments
to a fixed script, never part of it). Each channel keeps its own attempts and give-up, and fails alone.

The webhook's address is a secret. It lives only in .factory/local/notify.json, private to this user
(mode 0600), git-ignored with the rest of .factory/local/, and bound to this machine and this folder.
A missing, unreadable, symbolic-link, malformed or shared file, one written on another machine or for
another folder, or one tracked by Git, reads as off. The project's tracked settings can only forbid
notifications ("factory": {"notifications": false}); nothing tracked can turn them on or supply an address.

The address is never printed, logged, put in an event or an exception message, or taken on a command
line. Reports show its host only.

A message is built only from fixed words and identifiers: the label a person chose (or the folder's
name), the ticket ID, a fixed sentence for the kind of wait, and the command to run. It carries no link
and can approve, start or change nothing.

The same file holds the banner switch; it may hold the address, the switch or both.

Once per wait, per channel: a wait is keyed by ticket and stage in .factory/local/notify-state.json,
recorded before the message is sent. A failure is recorded with its HTTP status or kind of error, tried again on the next
occasion for that wait, and given up after MAX_ATTEMPTS. Sending never raises to its caller.

Standard library only. Imported by run.py; not a command of its own.
"""

import contextlib
import json
import os
import platform
import re
import socket
import ssl
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import policy as policy_module  # noqa: E402  (write_private, local_dir, tracked_by_git, tracked_config)

try:
    import fcntl
except ImportError:  # not POSIX: one writer is not enforced, the rest still holds
    fcntl = None

VERSION = 1
MAX_URL = 2048
MAX_FILE_BYTES = 8192
MAX_LABEL = 60
TIMEOUT_SECONDS = 5
MAX_ATTEMPTS = 5
QUIET_NEEDS = (None, "nothing", "worker-in-cell")  # stops nobody has to act on
TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
LABEL_RE = re.compile(r"[\w .,'()+-]{1,%d}" % MAX_LABEL)  # no link, no mention, no markup: no : / @ < > & *
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
DISCORD_HOSTS = ("discord.com", "discordapp.com")
LABEL_RULE = f"The label may use letters, digits, spaces and . , ' ( ) + - only, up to {MAX_LABEL} characters."

# The middle line for a ticket the supervisor parked, by a reason code its call site derives. Never the park's own text.
PARK_TEXT = {
    "budget": "The Factory's limits on runs or spending for the day stopped it; a person decides whether it goes on.",
    "risk": "Its risk tier is above what this machine runs unattended; a person runs it or decides.",
    "no-progress": "Its executions ended without moving it on; running it again would repeat that.",
    "tool-refused": "It made no progress and asked for a tool this machine does not allow; a person decides.",
    "outcome-unknown": "Its execution was lost and what it did is not known; a person checks it before it goes on.",
    "grooming": "Grooming without a person stopped; it needs a person to go on.",
    "merge": "It is approved, and this machine does not merge unattended; a person merges it.",
    "general": "The Factory stopped running it; a person decides what happens next.",
}


class NotifyError(Exception):
    """A problem the caller can fix. Its text never contains the address."""


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def config_path(root: Path) -> Path:
    return policy_module.local_dir(root) / "notify.json"


def state_path(root: Path) -> Path:
    return policy_module.local_dir(root) / "notify-state.json"


def forbidden(root: Path, config: Mapping[str, Any]) -> bool:
    """Whether the project's tracked settings, as they are on disk now, forbid notifications."""
    settings = policy_module.tracked_config(root, dict(config or {}))
    section = settings.get("factory") if isinstance(settings.get("factory"), dict) else {}
    return section.get("notifications") is False


FORBIDDEN = "This project's settings forbid notifications (factory.notifications is false). Nothing was sent or stored."


# ---- the address ----


def check_address(url: Any) -> Optional[str]:
    """Why this address may not be used, or None. https only, a host, no user name or password, bounded length."""
    if not isinstance(url, str) or not url:
        return "No address was given."
    if len(url) > MAX_URL:
        return f"The address is longer than {MAX_URL} characters."
    if any(not 33 <= ord(character) <= 126 for character in url):
        return "The address may contain only printable characters, without spaces."
    try:
        parts = urllib.parse.urlsplit(url)
        port_ok = parts.port is None or parts.port > 0
    except ValueError:
        return "The address is not a valid web address."
    if parts.scheme.lower() != "https":
        return "The address must start with https://."
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        return "The address may not carry a user name or password."
    if not parts.hostname:
        return "The address must name a host."
    if not port_ok:
        return "The address has an invalid port."
    return None


def host_of(url: str) -> str:
    return (urllib.parse.urlsplit(url).hostname or "").lower()


def is_discord(host: str) -> bool:
    return any(host == name or host.endswith("." + name) for name in DISCORD_HOSTS)


def body_for(url: str, text: str) -> bytes:
    """Slack-shaped {"text": ...}, or Discord-shaped {"content": ...} for a Discord host."""
    key = "content" if is_discord(host_of(url)) else "text"
    return json.dumps({key: text}, ensure_ascii=False).encode("utf-8")


def address_from_file(path: Path) -> str:
    """The address a person wrote into a file: one line, nothing else. The file's contents are never echoed."""
    try:
        path = Path(path)
        if not path.is_file():
            raise OSError("not a file")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise NotifyError(f"The file given to --from-file is larger than {MAX_FILE_BYTES} bytes; it should hold only the address.")
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise NotifyError("The file given to --from-file cannot be read.") from None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) != 1:
        raise NotifyError("The file given to --from-file must hold the address on one line and nothing else.")
    return lines[0]


def address_from_env(name: str) -> str:
    if not isinstance(name, str) or not ENV_NAME_RE.match(name):
        raise NotifyError("--from-env takes the name of an environment variable, such as MACH_NOTIFY_URL, not its value.")
    value = (os.environ.get(name) or "").strip()
    if not value:
        raise NotifyError(f"The environment variable {name} is not set, or is empty, in the shell this runs in.")
    return value


def clean_label(label: Any) -> str:
    if not isinstance(label, str) or not LABEL_RE.fullmatch(label.strip()):
        raise NotifyError(LABEL_RULE)
    return label.strip()


def default_label(root: Path) -> str:
    """The project folder's name, reduced to the label's characters."""
    name = re.sub(r"[^\w .,'()+-]", "-", Path(root).name).strip()[:MAX_LABEL].strip()
    return name or "project"


# ---- the stored setting: a webhook address, the banner switch, or both ----

CHANNELS = ("webhook", "banner")
NO_ADDRESS = "No address is stored on this machine for this project."
NO_BANNER = "The banner is not turned on here."
NOT_A_MAC = "Banners are shown only on macOS, and this machine is not a Mac."
FORBIDDEN_WHY = "This project's settings forbid notifications (factory.notifications is false)."


def system_name() -> str:
    """The operating system's name (platform.system()); a banner needs "Darwin". Replaced in tests."""
    return platform.system()


def unsafe(root: Path) -> Optional[str]:
    """Why the file on disk cannot be this machine's setting, whatever it says; None when nothing is wrong with where it came from."""
    path = config_path(root)
    if path.is_symlink() or policy_module.local_dir(root).is_symlink() or (root / ".factory").is_symlink():
        return "The notification setting or its folder is a symbolic link."
    if not path.is_file():
        return None
    if policy_module.tracked_by_git(root, path):
        return "The notification setting is tracked by Git, so it did not come from a person on this machine. Remove it from Git and set it again here."
    info = path.stat()
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        return "The notification setting is not owned by the current user."
    if info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        return "The notification setting can be read or changed by other users of this machine. Set it again here."
    return None


def load_setting(root: Path) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """(the stored setting, None), (None, None) when there is none, or (None, why it cannot be this machine's setting)."""
    path = config_path(root)
    try:
        problem = unsafe(root)
        if problem:
            return None, problem
        if not path.is_file():
            return None, None
        with path.open("rb") as handle:
            raw = handle.read(MAX_FILE_BYTES + 1)
        if len(raw) > MAX_FILE_BYTES:
            return None, "The notification setting is too large to be one."
        data = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None, "The notification setting cannot be read."
    if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != VERSION:
        return None, f"The notification setting is not version {VERSION}."
    label = data.get("label")
    if not isinstance(label, str) or not LABEL_RE.fullmatch(label):
        return None, "The stored label is not valid."
    for field in ("created_at", "machine", "project_root"):
        if not isinstance(data.get(field), str) or not data[field].strip():
            return None, f"The notification setting has no '{field}'."
    if data["machine"] != platform.node():
        return None, "The notification setting was written on another machine. It does not travel: set it again here."
    if Path(data["project_root"]) != Path(root):
        return None, "The notification setting was written for a different folder. It does not follow a copied or moved project: set it again here."
    return data, None


def read(root: Path, config: Mapping[str, Any]) -> Dict[str, Any]:
    """Which channels are on here. Each is off unless everything checks out; the address is in webhook.url only."""

    def off(why_webhook: Optional[str], why_banner: Optional[str], why: Optional[str] = None, forbidden_here: bool = False) -> Dict[str, Any]:
        return {"on": False, "label": None, "forbidden_by_project": forbidden_here, "why": why,
                "webhook": {"on": False, "url": None, "host": None, "why": why_webhook}, "banner": {"on": False, "why": why_banner}}

    if forbidden(root, config):
        return off(FORBIDDEN_WHY, FORBIDDEN_WHY, FORBIDDEN_WHY, True)
    data, problem = load_setting(root)
    if problem:
        return off(problem, problem, problem)
    if data is None:
        return off(NO_ADDRESS, NO_BANNER)
    url = data.get("url")
    if url is None:
        webhook = {"on": False, "url": None, "host": None, "why": NO_ADDRESS}
    elif check_address(url):
        webhook = {"on": False, "url": None, "host": None, "why": "The stored address is not one MACH sends to (https, a host, no user name or password)."}
    else:
        webhook = {"on": True, "url": url, "host": host_of(url), "why": None}
    switch = data.get("banner", False)
    if type(switch) is not bool:
        banner = {"on": False, "why": "The stored banner switch is not valid."}
    elif not switch:
        banner = {"on": False, "why": NO_BANNER}
    elif system_name() != "Darwin":
        banner = {"on": False, "why": NOT_A_MAC + " The stored switch is ignored here."}
    else:
        banner = {"on": True, "why": None}
    return {"on": webhook["on"] or banner["on"], "label": data["label"], "forbidden_by_project": False, "why": None,
            "webhook": webhook, "banner": banner, "created_at": data["created_at"]}


def ignored_by_git(root: Path, path: Path) -> bool:
    """False only when Git says this file would be committed. Not a Git repository, or no Git: nothing to commit it to."""
    try:
        relative = path.relative_to(root).as_posix()
        done = subprocess.run(["git", "check-ignore", "-q", "--", relative], cwd=str(root), capture_output=True, timeout=30)
    except (OSError, ValueError, subprocess.SubprocessError):
        return True
    return done.returncode != 1


def current(root: Path) -> Dict[str, Any]:
    """The setting to change: what is stored, when it is this machine's own; otherwise nothing (it is replaced)."""
    data, problem = load_setting(root)
    return dict(data) if data and not problem else {}


def write_setting(root: Path, data: Dict[str, Any], label: Optional[str]) -> Dict[str, Any]:
    """Store what remains of the setting for this machine and folder; with neither channel left, remove the file."""
    path = config_path(root)
    if path.is_symlink() or policy_module.local_dir(root).is_symlink() or (root / ".factory").is_symlink():
        raise NotifyError("The notification setting or its folder is a symbolic link; nothing was written.")
    if policy_module.tracked_by_git(root, path):
        raise NotifyError("The notification setting is tracked by Git; nothing was written over it. Remove it from Git first.")
    kept = {key: data[key] for key in ("url", "banner") if key in data and data[key] not in (None, False)}
    if not kept:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()
        return {}
    if not ignored_by_git(root, path):
        raise NotifyError(".factory/local/ is not ignored by Git, so this setting could be committed. Add it to .gitignore first; nothing was stored.")
    stored = {"version": VERSION, **kept, "label": label if label is not None else data.get("label") or default_label(root),
              "created_at": data.get("created_at") or stamp(), "machine": platform.node(), "project_root": str(root)}
    policy_module.write_private(path, json.dumps(stored, indent=2, sort_keys=True) + "\n")
    with contextlib.suppress(OSError):
        os.chmod(str(path), 0o600)
    return stored


def store(root: Path, config: Mapping[str, Any], url: str, label: Optional[str]) -> Dict[str, Any]:
    """Check the webhook address and store it for this machine and folder, beside the banner switch if that is on. Sends nothing."""
    if forbidden(root, config):
        raise NotifyError(FORBIDDEN)
    problem = check_address(url)
    if problem:
        raise NotifyError(problem + " Nothing was stored.")
    label = clean_label(label) if label is not None else None
    stored = write_setting(root, {**current(root), "url": url}, label)
    return {"stored": True, "host": host_of(url), "label": stored["label"], "sent": False, "banner": bool(stored.get("banner")),
            "note": "The address is stored on this machine only. Delete the file or variable you put it in."}


def set_banner(root: Path, config: Mapping[str, Any], on: bool, label: Optional[str] = None) -> Dict[str, Any]:
    """Turn the macOS banner on or off for this machine and folder. Sends nothing."""
    label = clean_label(label) if label is not None else None
    if not on:
        stored = write_setting(root, {**current(root), "banner": False}, label)
        return {"banner": "off", "webhook_still_on": bool(stored.get("url"))}
    if forbidden(root, config):
        raise NotifyError(FORBIDDEN)
    if system_name() != "Darwin":
        raise NotifyError(NOT_A_MAC + " Nothing was stored.")
    stored = write_setting(root, {**current(root), "banner": True}, label)
    return {"banner": "on", "label": stored["label"], "webhook_still_on": bool(stored.get("url")), "sent": False,
            "note": "macOS may hide banners from scripts until notifications are allowed for the program shown (often Script Editor) in System Settings."}


def remove(root: Path) -> Dict[str, Any]:
    """Remove the stored webhook address. The banner switch, if on, stays."""
    path = config_path(root)
    data = current(root)
    if data:
        existed = bool(data.get("url"))
        data.pop("url", None)
        stored = write_setting(root, data, None)
    else:  # nothing this machine can use: whatever is there goes
        existed = path.is_file() or path.is_symlink()
        with contextlib.suppress(FileNotFoundError):
            path.unlink()
        stored = {}
    banner = bool(stored.get("banner"))
    return {"removed": existed, "webhook": "off", "banner_still_on": banner,
            "still_on": ["banner"] if banner else [], "note": "The macOS banner is still on here; notify banner off turns it off." if banner else "Nothing is on here now."}


# ---- the state of each wait ----


def empty_state() -> Dict[str, Any]:
    return {"version": VERSION, "waits": {}, "last_sent": {}, "last_test": None}


def load_state(root: Path) -> Dict[str, Any]:
    path = state_path(root)
    try:
        if path.is_symlink() or not path.is_file():
            return empty_state()
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return empty_state()
    if not isinstance(data, dict) or not isinstance(data.get("waits"), dict):
        return empty_state()
    state = {**empty_state(), **data}
    if not isinstance(state.get("last_sent"), dict):
        state["last_sent"] = {}
    return state


def save_state(root: Path, state: Dict[str, Any]) -> None:
    policy_module.write_private(state_path(root), json.dumps(state, indent=2, sort_keys=True) + "\n")


@contextlib.contextmanager
def locked(root: Path) -> Iterator[None]:
    """One writer of the state file at a time on this machine."""
    if fcntl is None:
        yield
        return
    path = policy_module.local_dir(root) / "notify.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield
    finally:
        with contextlib.suppress(OSError):
            fcntl.flock(handle, fcntl.LOCK_UN)
        os.close(handle)


# ---- sending to a webhook ----


class RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """An address that redirects is a failure: the message is never carried to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 (urllib's signature)
        return None


def make_opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(RefuseRedirects)


def post(url: str, text: str, opener: Optional[urllib.request.OpenerDirector] = None) -> Tuple[bool, Optional[str]]:
    """One POST. Returns (sent, kind of error). Never raises, and the error never holds the address or the response."""
    try:
        request = urllib.request.Request(url, data=body_for(url, text), method="POST",
                                         headers={"Content-Type": "application/json", "User-Agent": "MACH-notify"})
        with (opener or make_opener()).open(request, timeout=TIMEOUT_SECONDS) as response:
            status = getattr(response, "status", None) or response.getcode()
        return (True, None) if 200 <= int(status) < 300 else (False, f"http-{int(status)}")
    except urllib.error.HTTPError as exc:
        code = exc.code
        with contextlib.suppress(Exception):
            exc.close()
        return False, "redirect-refused" if 300 <= code < 400 else f"http-{code}"
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return False, "timeout"
        if isinstance(reason, ssl.SSLError):
            return False, "tls-error"
        return False, "network-error"
    except (socket.timeout, TimeoutError):
        return False, "timeout"
    except ssl.SSLError:
        return False, "tls-error"
    except Exception:
        return False, "error"


# ---- a banner on this Mac ----

OSASCRIPT = "/usr/bin/osascript"
# Fixed script lines. The words are arguments to its run handler, never part of the script text.
BANNER_SCRIPT = ("on run argv",
                 "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
                 "end run")


def banner_argv(body: str, title: str, subtitle: str) -> List[str]:
    argv = [OSASCRIPT]
    for line in BANNER_SCRIPT:
        argv += ["-e", line]
    return argv + [body, title, subtitle]


def run_osascript(argv: List[str], timeout: float) -> Tuple[bool, Optional[str]]:
    """Run osascript with no shell. (ran, kind of error). Replaced in tests: the real one is never run there."""
    try:
        done = subprocess.run(argv, shell=False, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except OSError:
        return False, "osascript-failed-to-start"
    return (True, None) if done.returncode == 0 else (False, f"exit-{done.returncode}")


def show_banner(body: str, title: str, subtitle: str) -> Tuple[bool, Optional[str]]:
    """One Notification Center banner, no sound. "Ran" means osascript exited 0: whether macOS showed it is not known. Never raises."""
    try:
        if not Path(OSASCRIPT).is_file():
            return False, "osascript-missing"
        return run_osascript(banner_argv(body, title, subtitle), TIMEOUT_SECONDS)
    except Exception:
        return False, "error"


def message(label: str, ticket_id: str, middle: str, command: str) -> str:
    return f"MACH · {label}: {ticket_id} is waiting for a person.\n{middle}\nIn Claude Code: {command}"


def trial_message(label: str, command: str) -> str:
    return f"MACH · {label}: this is a test message.\nNothing is waiting; notifications are on for this project on this machine.\nIn Claude Code: {command}"


def banner_texts(label: str, ticket_id: str, middle: str, command: str) -> Tuple[str, str, str]:
    """(body, title, subtitle): the webhook message's words, split the way a banner shows them."""
    return f"{middle}\nIn Claude Code: {command}", f"MACH · {label}", f"{ticket_id} is waiting for a person."


def trial_banner_texts(label: str, command: str) -> Tuple[str, str, str]:
    return (f"Nothing is waiting; notifications are on for this project on this machine.\nIn Claude Code: {command}", f"MACH · {label}",
            "This is a test message.")


class Notifier:
    """Sends the once-per-wait message on each channel that is on. Built from fixed text: `needs_text` is the run script's
    sentence per kind of wait, `command` the decide command in this install's form. `opener` replaces the HTTP sender
    (tests only); the banner's runner is replaced in tests through run_osascript."""

    def __init__(self, root: Path, config: Mapping[str, Any], needs_text: Mapping[str, str], command: str,
                 opener: Optional[urllib.request.OpenerDirector] = None):
        self.root = Path(root)
        self.config = config
        self.needs_text = dict(needs_text)
        self.command = command
        self.opener = opener

    def middle(self, kind: str) -> str:
        sort, _, value = kind.partition(":")
        if sort == "parked":
            return PARK_TEXT.get(value, PARK_TEXT["general"])
        return self.needs_text.get(value, "A person is needed.")

    def wait(self, ticket_id: str, stage: Optional[str], needs: Optional[str]) -> Dict[str, Any]:
        """A ticket stopped for a person (the step's `needs`)."""
        if needs in QUIET_NEEDS:
            return {"sent": False, "why": "nobody has to act"}
        return self.announce(ticket_id, stage, f"needs:{needs}")

    def parked(self, ticket_id: str, stage: Optional[str], code: str) -> Dict[str, Any]:
        """A ticket the supervisor parked for a person, by reason code."""
        return self.announce(ticket_id, stage, f"parked:{code if code in PARK_TEXT else 'general'}")

    def announce(self, ticket_id: str, stage: Optional[str], kind: str) -> Dict[str, Any]:
        try:
            return self._announce(ticket_id, stage, kind)
        except Exception:  # a notification never changes what its caller does
            return {"sent": False, "why": "error"}

    def deliver(self, channel: str, settings: Dict[str, Any], ticket_id: str, kind: str) -> Tuple[bool, Optional[str]]:
        middle = self.middle(kind)
        if channel == "webhook":
            return post(settings["webhook"]["url"], message(settings["label"], ticket_id, middle, self.command), self.opener)
        return show_banner(*banner_texts(settings["label"], ticket_id, middle, self.command))

    def _announce(self, ticket_id: str, stage: Optional[str], kind: str) -> Dict[str, Any]:
        if not isinstance(ticket_id, str) or not TICKET_ID_RE.match(ticket_id) or (stage is not None and not isinstance(stage, str)):
            return {"sent": False, "why": "not a ticket"}
        settings = read(self.root, self.config)
        channels = [channel for channel in CHANNELS if settings[channel]["on"]]
        if not channels:
            return {"sent": False, "why": "off"}
        todo: List[str] = []
        with locked(self.root):
            state = load_state(self.root)
            wait = state["waits"].get(ticket_id)
            if not (isinstance(wait, dict) and wait.get("stage") == stage and isinstance(wait.get("channels"), dict)):
                wait = {"stage": stage, "kind": kind, "first_seen_at": stamp(), "channels": {}}
                state["waits"][ticket_id] = wait
            for channel in channels:  # each channel keeps its own attempts and give-up
                record = wait["channels"].setdefault(channel, {"attempts": 0, "state": "pending", "last_error": None})
                if record.get("state") == "sent":
                    continue
                if record.get("state") == "given-up" or int(record.get("attempts") or 0) >= MAX_ATTEMPTS:
                    record["state"] = "given-up"
                    continue
                record["attempts"] = int(record.get("attempts") or 0) + 1
                record["last_try_at"] = stamp()
                todo.append(channel)
            save_state(self.root, state)  # recorded before it is sent: a second caller sees this wait
        if not todo:
            return {"sent": False, "why": "already sent or given up for this wait"}
        results = {channel: self.deliver(channel, settings, ticket_id, kind) for channel in todo}
        with locked(self.root):
            state = load_state(self.root)
            wait = state["waits"].get(ticket_id)
            if isinstance(wait, dict) and wait.get("stage") == stage and isinstance(wait.get("channels"), dict):
                for channel, (sent, error) in results.items():
                    record = wait["channels"].get(channel)
                    if not isinstance(record, dict):
                        continue
                    if sent:
                        record.update({"state": "sent", "sent_at": stamp(), "last_error": None})
                        state["last_sent"][channel] = {"ticket_id": ticket_id, "stage": stage, "at": record["sent_at"]}
                    else:
                        record["last_error"] = error
                        if int(record.get("attempts") or 0) >= MAX_ATTEMPTS:
                            record.update({"state": "given-up", "given_up_at": stamp()})
                save_state(self.root, state)
        return {"sent": any(sent for sent, _ in results.values()), "channels": {channel: {"sent": sent, "error": error} for channel, (sent, error) in results.items()}}

    def pending(self) -> List[Tuple[str, Optional[str], str]]:
        """Waits with a channel not yet sent nor given up: (ticket, stage, kind). Reads the state file only, never the setting."""
        try:
            waits = load_state(self.root)["waits"]
            return [(ticket, wait.get("stage"), str(wait.get("kind") or "parked:general")) for ticket, wait in sorted(waits.items())
                    if isinstance(wait, dict) and isinstance(wait.get("channels"), dict)
                    and any(isinstance(record, dict) and record.get("state") == "pending" for record in wait["channels"].values())]
        except Exception:
            return []

    def retry(self, still_waiting: Callable[[str, Optional[str]], bool]) -> None:
        """The next occasion for each pending wait the caller confirms is still waiting at the same stage."""
        for ticket_id, stage, kind in self.pending():
            try:
                if still_waiting(ticket_id, stage):
                    self.announce(ticket_id, stage, kind)
            except Exception:
                continue

    def test(self, command: str) -> Dict[str, Any]:
        """One test message on each channel that is on, on a person's word. Honours a project that forbids notifications."""
        if forbidden(self.root, self.config):
            raise NotifyError(FORBIDDEN)
        settings = read(self.root, self.config)
        if not settings["on"]:
            reasons = settings["why"] or f"{settings['webhook']['why']} {settings['banner']['why']}"
            raise NotifyError(f"Notifications are off here: {reasons} Nothing was sent.")
        result: Dict[str, Any] = {"label": settings["label"]}
        if settings["webhook"]["on"]:
            sent, error = post(settings["webhook"]["url"], trial_message(settings["label"], command), self.opener)
            result["webhook"] = {"on": True, "sent": sent, "error": error, "host": settings["webhook"]["host"]}
        else:
            result["webhook"] = {"on": False, "why_off": settings["webhook"]["why"]}
        if settings["banner"]["on"]:
            ran, error = show_banner(*trial_banner_texts(settings["label"], command))
            result["banner"] = {"on": True, "ran": ran, "error": error,
                                "meaning": "ran means osascript exited 0; MACH cannot see whether macOS displayed the banner."}
        else:
            result["banner"] = {"on": False, "why_off": settings["banner"]["why"]}
        with contextlib.suppress(Exception):
            with locked(self.root):
                state = load_state(self.root)
                state["last_test"] = {"at": stamp(), **{channel: {key: result[channel].get(key) for key in ("sent", "ran", "error") if key in result[channel]}
                                                        for channel in CHANNELS if result[channel]["on"]}}
                save_state(self.root, state)
        return result


def status(root: Path, config: Mapping[str, Any]) -> Dict[str, Any]:
    """Each channel on its own: on or off, the last message, failures. Changes nothing; never shows the address."""
    settings = read(root, config)
    state = load_state(root)
    waits = state["waits"]

    def rows(channel: str, wanted: str) -> List[Dict[str, Any]]:
        found = []
        for ticket_id, wait in sorted(waits.items()):
            record = (wait.get("channels") or {}).get(channel) if isinstance(wait, dict) and isinstance(wait.get("channels"), dict) else None
            if isinstance(record, dict) and record.get("state") == wanted and (wanted != "pending" or record.get("last_error")):
                found.append({"ticket_id": ticket_id, "stage": wait.get("stage"), "attempts": record.get("attempts"),
                              "last_error": record.get("last_error"), "last_try_at": record.get("last_try_at")})
        return found

    webhook, banner = settings["webhook"], settings["banner"]
    return {"on": settings["on"], "label": settings["label"], "forbidden_by_project": settings["forbidden_by_project"], "why_off": settings["why"],
            "webhook": {"on": webhook["on"], "why_off": webhook["why"], "host": webhook["host"], "last_sent": state["last_sent"].get("webhook"),
                        "failing": rows("webhook", "pending"), "given_up": rows("webhook", "given-up")},
            "banner": {"on": banner["on"], "why_off": banner["why"], "last_ran": state["last_sent"].get("banner"),
                       "failing": rows("banner", "pending"), "given_up": rows("banner", "given-up"),
                       "meaning": "ran means osascript exited 0; MACH cannot see whether macOS displayed the banner."},
            "last_test": state.get("last_test"), "max_attempts": MAX_ATTEMPTS,
            "sends": "One message on each channel that is on when a ticket waits for a person in unattended work, once per wait. It can approve, start or change nothing."}
