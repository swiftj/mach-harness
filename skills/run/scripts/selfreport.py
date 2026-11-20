#!/usr/bin/env python3
"""MACH reports its own defects as GitHub issues, only on a person's yes (M14 part E). Reached as `run.py report`.

    report [<fault-id>] ["<what went wrong>"]   preview: the exact title and body, and a code that expires
    report ... --print                          only print the text, for a person to file by hand
    report --confirm <code>                     file exactly the previewed text (checked by its SHA-256)
    report ... --new                            preview a new issue even when an open one has the same fingerprint

The text comes from one fixed template: what happened; the script and command; MACH's version and how it is
installed; the exception type, its redacted message and MACH's own frames; how many times and when; the doctor's
findings as check names and states only; the platform; and, when the person gave them, their own words, bounded and
made inert. Every part that is not fixed text is scrubbed (faults.scrub); the finished text is redacted with the
shared rules and the secret shapes, and refused if any shape is still found.

It goes to `report.repository` (default swiftj/mach-harness, owner/name on github.com) with `gh`, and to no other
place. Before a preview offers a new issue it searches that repository's open issues for the fault's fingerprint,
carried in a hidden marker in the body; when one is found it offers a short fixed comment there instead. The
`mach:self-report` label is added only if it already exists there: MACH never creates a label on a repository that is
not the project's. The `gh` commands it runs are exactly: `auth status --hostname github.com`, `issue list` (search),
`label list` (search), `issue create` and `issue comment`, each with `--repo github.com/<owner>/<name>`.

Refused inside a supervised Factory execution and when `report.enabled` is false in the tracked settings. Never called
by a station, an agent, the belt workflow or the supervisor. Standard library only.
"""

import contextlib
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

DEFAULT_REPOSITORY = "swiftj/mach-harness"
LABEL = "mach:self-report"
HOST = "github.com"
CONFIRM_MINUTES = 10
GH_TIMEOUT = 30
PENDING = "pending-report.json"  # beside the fault records, in the same private folder
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$")
MARKER = "<!-- mach:self-report v1 fingerprint={} -->"
SEEN_MARKER = "<!-- mach:self-report-seen v1 fingerprint={} -->"
NETWORK_WORDS = ("error connecting", "could not resolve", "dial tcp", "timeout", "timed out", "no such host",
                 "network is unreachable", "connection refused")
WORDS_LIMIT = 2000
WORDS_LINES = 20
INSTALL_WORDS = {"plugin": "the Claude Code plugin", "project": "copied into the project by the installer", None: "not known"}


class ReportError(Exception):
    """A report that cannot be made as asked; printed without a traceback."""


def settings(config: Dict[str, Any]) -> Dict[str, Any]:
    """`report` in the tracked settings: whether it is on (default yes) and the repository (owner/name on github.com)."""
    section = config.get("report") if isinstance(config.get("report"), dict) else {}
    if section.get("enabled") is False:
        raise ReportError("Reporting MACH's own errors is switched off in this project's settings (report.enabled is false).")
    repository = section.get("repository", DEFAULT_REPOSITORY)
    if not isinstance(repository, str) or not REPOSITORY_RE.match(repository) or repository.endswith((".", ".git")):
        raise ReportError("report.repository in .factory/config.json must be an owner/name on github.com, such as swiftj/mach-harness.")
    return {"repository": repository}


def stamp(moment: Optional[datetime] = None) -> str:
    return (moment or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")


def day(value: Any) -> str:
    return str(value)[:10] if isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}", value) else "unknown"


# ---- the text ------------------------------------------------------------------------------------

def inert(rules: Any, text: Any, limit: int = 200) -> str:
    """One piece of text made safe for an issue: printable, bounded, no code mark, no mention, no issue link."""
    value = " ".join("".join(ch if ch.isprintable() else " " for ch in str(text or "")[:limit * 4]).split()).replace("`", "'")
    if len(value) > limit:
        value = value[:limit - 1].rstrip() + "…"
    return rules.MENTION_RE.sub("@" + rules.BREAK, rules.REFERENCE_RE.sub(lambda m: m.group(1) + rules.BREAK, value))


def their_words(F: Any, rules: Any, scan: Any, root: str, words: str) -> List[str]:
    """The person's words: cleaned, redacted and bounded by the shared rules, with every value of the project's or the
    machine's replaced, mentions and issue links broken, as quoted lines."""
    quiet = rules.quiet(words, WORDS_LIMIT)
    known = F.known_values(root, [], dict(os.environ))
    lines = [F.scrub(line, known, None, rules, scan, limit=WORDS_LIMIT) for line in quiet.splitlines() if line.strip()][:WORDS_LINES]
    return ["> " + inert(rules, line, WORDS_LIMIT) for line in lines]


def compose(F: Any, root: str, fault: Optional[Dict[str, Any]], words: Optional[str], checks: Sequence[Tuple[str, str]],
            command_name: str) -> Dict[str, Any]:
    """The title and body, from the fixed template only."""
    rules, scan = F.helpers()
    mach = F.mach_version(root) if fault is None else (fault.get("mach") or {})
    version = inert(rules, mach.get("version") or "version not known", 40)
    install = INSTALL_WORDS.get(mach.get("install"), "not known")
    facts = F.platform_facts() if fault is None else (fault.get("platform") or {})
    python = inert(rules, (fault or {}).get("python") or __import__("platform").python_version(), 20)
    system = inert(rules, f"{facts.get('system') or '?'} {facts.get('release') or ''} ({facts.get('machine') or '?'})", 100)
    lines: List[str] = []
    print_ = None
    if fault is not None:
        print_ = str(fault["fingerprint"])[:16]
        script = inert(rules, fault.get("script"), 80)
        shown = inert(rules, " ".join([os.path.basename(script), *[str(name) for name in fault.get("command") or []]]), 120)
        exception = inert(rules, fault.get("exception"), 120)
        message = "(left out: the redaction could not be loaded)" if fault.get("message_left_out") else f"`{inert(rules, fault.get('message'), 300)}`"
        count = int(fault.get("count") or 0)
        title = inert(rules, f"Internal error: {exception} in {shown}", 120)
        lines += [MARKER.format(print_), "## What happened", "",
                  f"MACH stopped with an internal error: an uncaught `{exception}` in `{script}`, running `{shown}`. "
                  "It was not one of MACH's own refusals.", "",
                  "## Details", "",
                  f"- Fingerprint: `{print_}`",
                  f"- MACH: {version}, {install}",
                  f"- Script: `{script}`",
                  f"- Command: `{shown}`",
                  f"- Exception: `{exception}`",
                  f"- Message, redacted: {message}",
                  f"- Seen: {count} time{'s' if count != 1 else ''} on this machine, first {day(fault.get('first_seen'))}, last {day(fault.get('last_seen'))}",
                  f"- In a supervised Factory execution the last time: {'yes' if fault.get('supervised') else 'no'}",
                  f"- Platform: {system}, Python {python}", "",
                  "## Traceback", ""]
        outside = int(fault.get("frames_outside_mach") or 0)
        lines.append("MACH's own frames, outermost first. Paths are inside MACH; source lines are left out"
                     + (f"; {outside} frame{'s' if outside != 1 else ''} outside MACH left out." if outside else "."))
        lines += ["", "```text"]
        for frame in (fault.get("traceback") or [])[-30:]:
            lines.append(inert(rules, f"{frame.get('file')}, line {int(frame.get('line') or 0)}, in {frame.get('function')}", 160))
        lines += ["```", ""]
    else:
        title = inert(rules, f"A problem reported by a person using MACH {version}", 120)
        lines += ["## What happened", "",
                  "A person using MACH described a problem in their own words, below. No internal error was recorded with it.", "",
                  "## Details", "",
                  f"- MACH: {version}, {install}",
                  f"- Platform: {system}, Python {python}", ""]
    lines += ["## Doctor", "", "The doctor's checks on this machine, by name and state only.", ""]
    lines += [f"- {inert(rules, name, 60)}: {inert(rules, state, 20)}" for name, state in checks[:60]] or ["- (the doctor could not be run)"]
    lines.append("")
    if words and words.strip():
        quoted = their_words(F, rules, scan, root, words)
        if quoted:
            lines += ["## In the reporter's words", "", *quoted, ""]
    lines += ["---", f"Filed with `{inert(rules, command_name, 40)}` after the person who ran it read this text. "
              "It carries no repository or ticket names, no specification or file contents and no environment values."]
    return {"title": title, "body": "\n".join(lines) + "\n", "fingerprint": print_}


def seen_again(F: Any, fault: Dict[str, Any]) -> str:
    """The short comment added to an open issue that already carries this fingerprint."""
    rules, _ = F.helpers()
    mach = fault.get("mach") or {}
    facts = fault.get("platform") or {}
    count = int(fault.get("count") or 0)
    system = inert(rules, f"{facts.get('system') or '?'} {facts.get('release') or ''} ({facts.get('machine') or '?'})", 100)
    return (SEEN_MARKER.format(str(fault["fingerprint"])[:16]) + "\n"
            f"Seen again on another machine: {count} time{'s' if count != 1 else ''}, last {day(fault.get('last_seen'))}. "
            f"MACH {inert(rules, mach.get('version') or 'version not known', 40)}, {INSTALL_WORDS.get(mach.get('install'), 'not known')}; "
            f"{system}, Python {inert(rules, fault.get('python') or '?', 20)}.\n")


def checked(F: Any, *texts: str) -> List[str]:
    """The finished text, redacted once more with the shared rules and the secret shapes. Refused if a shape remains."""
    rules, scan = F.helpers()
    done = [F.mask_secrets(text, rules, scan) for text in texts]
    left = sorted(set(kind for text in done for kind in F.secret_kinds(text, scan)))
    if left:
        raise ReportError("The report would still carry something shaped like a credential (" + ", ".join(left) + "), so it is not offered.")
    return done


def digest(kind: str, repository: str, title: str, body: str, label: Optional[str], issue: Optional[int]) -> str:
    return hashlib.sha256(json.dumps([kind, repository, title, body, label, issue], ensure_ascii=False).encode("utf-8")).hexdigest()


# ---- GitHub --------------------------------------------------------------------------------------

Runner = Callable[[List[str], Optional[str]], Tuple[Optional[int], str, str]]


def gh_runner(root: str) -> Optional[Runner]:
    program = shutil.which("gh")
    if not program:
        return None

    def run(argv: List[str], given: Optional[str] = None) -> Tuple[Optional[int], str, str]:
        try:
            done = subprocess.run([program, *argv], cwd=root, input=given, capture_output=True, text=True, timeout=GH_TIMEOUT,
                                  stdin=None if given is not None else subprocess.DEVNULL, check=False)
        except (OSError, subprocess.SubprocessError):
            return None, "", ""
        return done.returncode, done.stdout or "", done.stderr or ""

    return run


def reach(gh: Optional[Runner], repository: str) -> Optional[str]:
    """Why `gh` cannot file on that repository from here, in a plain sentence; None when it can. Its output is never shown."""
    if gh is None:
        return "The GitHub command-line program (gh) is not installed here."
    code, out, err = gh(["auth", "status", "--hostname", HOST], None)
    if code is None:
        return "The GitHub command-line program (gh) did not answer."
    if code != 0:
        if any(word in (out + "\n" + err).lower() for word in NETWORK_WORDS):
            return "GitHub could not be reached from here."
        return "The GitHub command-line program (gh) is not signed in to github.com."
    return None


def find_open(gh: Runner, repository: str, print_: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """An open issue there whose body carries this fingerprint's marker; or why it could not be looked for."""
    code, out, _ = gh(["issue", "list", "--repo", f"{HOST}/{repository}", "--state", "open", "--search", print_,
                       "--json", "number,url,body", "--limit", "20"], None)
    if code != 0:
        return None, f"{repository} could not be searched from this account (no access, or GitHub could not be reached)."
    try:
        found = json.loads(out)
    except ValueError:
        return None, f"GitHub's answer about {repository} could not be read."
    marker = MARKER.format(print_)
    for item in found if isinstance(found, list) else []:
        number, url, body = (item.get("number"), item.get("url"), item.get("body")) if isinstance(item, dict) else (None, None, None)
        if isinstance(number, int) and isinstance(body, str) and marker in body and isinstance(url, str) and issue_url(repository, url):
            return {"number": number, "url": url}, None
    return None, None


def label_there(gh: Runner, repository: str) -> bool:
    code, out, _ = gh(["label", "list", "--repo", f"{HOST}/{repository}", "--search", LABEL, "--json", "name", "--limit", "20"], None)
    if code != 0:
        return False
    try:
        names = json.loads(out)
    except ValueError:
        return False
    return any(isinstance(item, dict) and item.get("name") == LABEL for item in names if isinstance(names, list))


def issue_url(repository: str, url: str) -> Optional[int]:
    found = re.match(r"^https://github\.com/([^/\s]+)/([^/\s]+)/issues/(\d+)(?:#issuecomment-\d+)?$", url.strip())
    if not found or f"{found.group(1)}/{found.group(2)}".lower() != repository.lower():
        return None
    return int(found.group(3))


# ---- the pending report --------------------------------------------------------------------------

def pending_path(F: Any, root: str) -> str:
    return os.path.join(F.folder(root), PENDING)


def propose(F: Any, root: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    entry = {**entry, "code": secrets.token_hex(3), "expires_at": stamp(datetime.now(timezone.utc) + timedelta(minutes=CONFIRM_MINUTES))}
    F.write_private(pending_path(F, root), json.dumps(entry, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
    return entry


def take(F: Any, root: str, code: str) -> Dict[str, Any]:
    path = pending_path(F, root)
    try:
        if os.path.islink(path):
            raise ValueError("link")
        with open(path, encoding="utf-8") as handle:
            entry = json.load(handle)
    except (OSError, ValueError):
        raise ReportError("Nothing is waiting to be confirmed. Ask for the report first; it shows the exact text and gives a code.")
    try:
        expired = datetime.now(timezone.utc) > datetime.strptime(str(entry.get("expires_at")), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        expired = True
    if expired:
        with contextlib.suppress(OSError):
            os.remove(path)
        raise ReportError("That confirmation has expired. Ask for the report again and read what it shows.")
    if not isinstance(code, str) or not secrets.compare_digest(code.strip(), str(entry.get("code"))):
        raise ReportError("That is not the code of the report waiting to be confirmed. Nothing was sent.")
    with contextlib.suppress(OSError):
        os.remove(path)
    if digest(entry.get("kind"), entry.get("repository"), entry.get("title"), entry.get("body"), entry.get("label"), entry.get("issue")) != entry.get("sha256"):
        raise ReportError("The waiting report is not the text that was shown, so nothing was sent. Ask for the report again.")
    return entry


# ---- the command ---------------------------------------------------------------------------------

def choose(F: Any, root: str, target: Sequence[str]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """The fault and the person's words a command names. No fault named and no words: the latest unreported fault."""
    target = list(target or [])
    fault = None
    if target and F.ID_RE.match(target[0]):
        fault = F.load(root, target[0])
        if fault is None:
            raise ReportError(f"No internal error {target[0]} is recorded on this machine. The status, next and doctor commands list them.")
        target = target[1:]
    words = " ".join(target).strip() or None
    if fault is None and words is None:
        waiting = F.unreported(root)
        if not waiting:
            raise ReportError("MACH has recorded no unreported internal error on this machine. To report a problem in your own words, "
                              "give them: report \"<what went wrong>\".")
        fault = waiting[0]
    return fault, words


def by_hand(repository: str, title: str, body: str) -> str:
    return (f"Nothing was sent. To file it by hand, open https://github.com/{repository}/issues/new and paste this title and body.\n\n"
            f"Title: {title}\n\n{body}")


def run(root: str, config: Dict[str, Any], F: Any, target: Sequence[str], *, print_only: bool = False, confirm: Optional[str] = None,
        new: bool = False, command_name: str = "/mach report", doctor: Optional[Callable[[], List[Tuple[str, str]]]] = None,
        gh: Optional[Runner] = None) -> Any:
    """Preview, print or confirm. Returns a dict for JSON, or the text to print with --print."""
    repository = settings(config)["repository"]
    gh = gh if gh is not None else gh_runner(root)
    if confirm is not None:
        if target or print_only or new:
            raise ReportError("--confirm takes only the code: it files exactly the text that was shown.")
        return file(F, root, take(F, root, confirm), gh)
    fault, words = choose(F, root, target)
    try:
        checks = list(doctor()) if doctor is not None else []
    except Exception:  # noqa: BLE001  a report is still possible without the doctor's findings
        checks = []
    made = compose(F, root, fault, words, checks, command_name)
    title, body = checked(F, made["title"], made["body"])
    if print_only:
        return by_hand(repository, title, body)
    why = reach(gh, repository)
    duplicate = None
    if why is None and fault is not None and not new:
        duplicate, why = find_open(gh, repository, made["fingerprint"])
    if why is not None:
        return {"sent": False, "can_file": False, "why": why, "repository": repository, "title": title, "body": body,
                "by_hand": f"https://github.com/{repository}/issues/new",
                "next": "Nothing was sent. Tell the person why in one sentence, and give them the title and body to file by hand if they want to."}
    if duplicate is not None:
        (comment,) = checked(F, seen_again(F, fault))
        entry = {"kind": "comment", "repository": repository, "title": None, "body": comment, "label": None, "issue": duplicate["number"],
                 "issue_url": duplicate["url"], "fault_id": fault["id"]}
    else:
        label = LABEL if label_there(gh, repository) else None
        entry = {"kind": "issue", "repository": repository, "title": title, "body": body, "label": label, "issue": None, "issue_url": None,
                 "fault_id": fault["id"] if fault else None}
    entry["sha256"] = digest(entry["kind"], repository, entry["title"], entry["body"], entry["label"], entry["issue"])
    entry = propose(F, root, entry)
    shown = {"sent": False, "can_file": True, "kind": entry["kind"], "repository": repository, "public": True,
             "title": entry["title"], "body": entry["body"], "label": entry["label"], "sha256": entry["sha256"],
             "confirm_with": entry["code"], "expires_at": entry["expires_at"]}
    if duplicate is not None:
        shown["duplicate"] = duplicate
        shown["new_issue_instead"] = "report " + fault["id"] + " --new"
        shown["next"] = ("Nothing has been sent. An open issue there already has this fingerprint: show the person its address and this comment "
                         "in full, say it goes to a public repository, and only on their yes run report --confirm with this code.")
    else:
        shown["next"] = ("Nothing has been sent. Show the person the title and body in full, say it goes to a public repository, "
                         "and only on their yes run report --confirm with this code. Add nothing to the text.")
    return shown


def file(F: Any, root: str, entry: Dict[str, Any], gh: Optional[Runner]) -> Dict[str, Any]:
    """File the confirmed text, exactly as previewed."""
    repository = entry["repository"]
    why = reach(gh, repository)
    if why is not None:
        raise ReportError(why + " Nothing was sent; the report command with --print gives the text to file by hand.")
    if entry["kind"] == "comment":
        argv = ["issue", "comment", str(int(entry["issue"])), "--repo", f"{HOST}/{repository}", "--body-file", "-"]
    else:
        argv = ["issue", "create", "--repo", f"{HOST}/{repository}", "--title", entry["title"], "--body-file", "-"]
        if entry.get("label") == LABEL:
            argv += ["--label", LABEL]
    code, out, _ = gh(argv, entry["body"])
    url = (out or "").strip().splitlines()[-1].strip() if (out or "").strip() else ""
    number = issue_url(repository, url) if code == 0 else None
    if number is None:
        raise ReportError(f"GitHub did not accept it, or its answer could not be read; nothing is known to have been filed on {repository}. "
                          "The report command with --print gives the text to file by hand.")
    address = entry.get("issue_url") if entry["kind"] == "comment" else url
    if entry.get("fault_id"):
        try:
            F.mark_reported(root, entry["fault_id"], address, entry["kind"])
        except Exception:  # noqa: BLE001  it was filed; failing to note that only means the offer stays
            pass
    return {"sent": True, "kind": entry["kind"], "repository": repository, "url": url, "issue": number,
            "fault_id": entry.get("fault_id")}
