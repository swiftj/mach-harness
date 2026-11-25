#!/usr/bin/env python3
"""M21 C: `project export`, the whole Product Studio project in one archive that names no repository.

Reads the draft workspace (.factory/studio/draft/) and Studio's own records beside it, and completes the picture from GitHub:
what this repository's issues hold that the workspace does not (the project itself in an empty workspace, its principles and
technical needs, epics, and slices marked ready from another computer, with their design mocks from the main branch), read
now through the same reader and checks as `slice take`, into memory. Nothing is recorded: no draft, no ledger, no session.
Git is read only for the shared remote's configured address and for design mocks' pictures on its main branch (cat-file, no
checkout). Strips every field that names a repository, an account or an issue (STRIP), keeps what the source knew that is not
a workspace file in facts.json (the order within each epic, each slice's state, Jira keys, request numbers, resume notes,
whether it was ready), then reads every text it is about to write for the repository, a login this workspace or GitHub's
issues name, an absolute path on this computer or text shaped like a secret, and refuses on any, naming the file and line.
It never redacts. A slice read from GitHub that fails a check is left out, and the result says which and why.

Writes one file, the archive, with project_archive.write (atomically, through a temporary file beside it), in the
folder given or in .factory/studio/export/, under a name no other export holds. Nothing else changes.

Design: docs/mach-next/M21_EXPORT_IMPORT.md, sections 1, 2.1, 2.4, 3 and 7.1. Reaches Product Studio only through the
`host` module (studio.py) and the `studio` object handed in, as prd.py and shape.py do. Standard library only.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import collab
import design
import handoff
import issues
import mocks
import prd
import product
import project_archive
import shape

FACTS_VERSION = 1
NOTHING_CHANGED = "Nothing was changed."
EXPORT_FOLDER = "export"  # under .factory/studio/
STAYS_BEHIND = ["approvals", "GitHub issues and their numbers", "Jira keys (listed in the archive for the report)", "requests", "ready folders"]
NOTE = "The project is in one file. It names no repository and no account. Nothing was sent anywhere."

# Ledger keys whose values are GitHub logins (issues.json, ideas.json, requests.json, and the drafts' ideas before stripping).
LOGIN_KEYS = ("by", "approved_by", "login", "author", "labelled_by", "picked_up_by")
MACH_ID_RE = re.compile(r"^[A-Z]+-[0-9]+$")  # a slice, epic, idea or rule ID is never taken for a login
SOURCE_MOVED = ("idea", "request", "fault")   # an idea's source that names an issue or ticket elsewhere becomes {"kind": "moved"}


# ---- the strips (section 1.2): each returns a new record, the one given is left as it was ----


def _without(record: Dict[str, Any], *keys: str) -> Dict[str, Any]:
    out = copy.deepcopy(record)
    for key in keys:
        out.pop(key, None)
    return out


def strip_idea(record: Dict[str, Any]) -> Dict[str, Any]:
    """The idea without its issue, with no login on its verdict or look-backs, no look-back comment, and a source that
    named an issue or ticket elsewhere as {"kind": "moved"} (what it was is kept in facts.json)."""
    out = _without(record, "issue")
    if isinstance(out.get("verdict"), dict):
        out["verdict"]["by"] = None
    lookback = out.get("lookback")
    if isinstance(lookback, dict):
        for entries in lookback.values():
            for entry in (entries.values() if isinstance(entries, dict) else []):
                if isinstance(entry, dict):
                    entry.pop("comment", None)
                    if "by" in entry:
                        entry["by"] = None
    if isinstance(out.get("source"), dict) and out["source"].get("kind") in SOURCE_MOVED:
        out["source"] = {"kind": "moved"}
    return out


def strip_lookups(record: Dict[str, Any]) -> Dict[str, Any]:
    """The lookups without the similar entries that name a request (an issue number in a repository the archive does not name)
    and without shipped_commit (a commit of this repository, which anyone can search for on GitHub to find the repository)."""
    out = copy.deepcopy(record)
    out.pop("shipped_commit", None)
    if isinstance(out.get("similar"), list):
        out["similar"] = [item for item in out["similar"] if not (isinstance(item, dict) and "request" in item)]
    return out


def _same(record: Dict[str, Any]) -> Dict[str, Any]:
    return copy.deepcopy(record)


STRIP: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    "project": _same,
    "epic": lambda record: _without(record, "tracking"),
    "slice": lambda record: _without(record, "origin", "tracking"),
    "principles": _same,
    "needs": _same,
    "idea": strip_idea,
    "lookups": strip_lookups,
    "idea_map": _same,
    "prd_meta": _same,
    "prd_map": _same,
    "prd_answers": _same,
    "design_meta": _same,
    "design_map": lambda record: _without(record, "published"),
}


# ---- what a member is, in the product manager's words ----

_WHAT: Sequence[Tuple["re.Pattern[str]", str, str]] = tuple((re.compile(pattern), what, noun) for pattern, what, noun in (
    (r"facts\.json", "The archive's facts", "workspace"),
    (r"workspace/product/project\.json", "The project's record", "project"),
    (r"workspace/product/epics/(EPIC-[0-9]+)\.json", "{}'s record", "epic"),
    (r"workspace/product/slices/(SLICE-[0-9]+)\.json", "{}'s work order", "work order"),
    (r"workspace/product/intents/(SLICE-[0-9]+)\.md", "{}'s why", "why"),
    (r"workspace/specs/slices/(SLICE-[0-9]+)-.*\.md", "{}'s spec", "spec"),
    (r"workspace/product/principles\.json", "The product principles", "principles"),
    (r"workspace/product/needs\.json", "The technical needs", "technical needs"),
    (r"workspace/product/ideas/(IDEA-[0-9]+)\.json", "{}'s record", "idea"),
    (r"workspace/product/ideas/(IDEA-[0-9]+)\.lookups\.json", "{}'s lookups", "lookups"),
    (r"workspace/product/ideas/(IDEA-[0-9]+)\.map\.json", "{}'s map", "map"),
    (r"workspace/product/briefs/(IDEA-[0-9]+)\.md", "{}'s brief", "brief"),
    (r"workspace/product/briefs/(IDEA-[0-9]+)\.case\.md", "{}'s case", "case"),
    (r"workspace/product/prds/(PRD-[0-9]+)/prd\.json", "{}'s record", "record"),
    (r"workspace/product/prds/(PRD-[0-9]+)/map\.json", "{}'s map", "map"),
    (r"workspace/product/prds/(PRD-[0-9]+)/document\.(?:md|txt)", "{}'s document", "document"),
    (r"workspace/product/prds/(PRD-[0-9]+)/answers/.*\.json", "{}'s drafted answers", "answers"),
    (r"workspace/product/designs/(DES-[0-9]+)/import\.json", "{}'s record", "record"),
    (r"workspace/product/designs/(DES-[0-9]+)/map\.json", "{}'s map", "map"),
    (r"workspace/product/designs/(DES-[0-9]+)/design\.(?:md|txt)", "{}'s document", "document"),
    (r"workspace/product/mocks/(SLICE-[0-9]+)/.*", "{}'s design mock", "design mock"),
))


def described(member: str) -> Tuple[str, str]:
    """(what, noun): "SLICE-004's spec", "spec"."""
    for pattern, what, noun in _WHAT:
        found = pattern.fullmatch(member)
        if found:
            return what.format(*found.groups()), noun
    return member, "file"


def refusal(host: Any, sentence: str, hint: Optional[Dict[str, Any]] = None) -> Exception:
    """Product Studio's refusal, ending with "Nothing was changed." (section 7)."""
    return host.StudioError(sentence if NOTHING_CHANGED in sentence else f"{sentence} {NOTHING_CHANGED}", hint)


# ---- what must never be inside (section 2.4) ----


def _remote_repository(address: str) -> Optional[str]:
    """OWNER/REPO from the shared remote's configured address: GitHub's forms, or any other host's URL or scp form. A local
    path names no repository."""
    found = collab.GITHUB_REMOTE_RE.fullmatch(address)
    if found:
        return found.group(1)
    found = re.fullmatch(r"(?:[A-Za-z][A-Za-z0-9+.-]*://[^/]+/|[^/@\s:]+@[^/:\s]+:)(?:.*/)?([A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}?)(?:\.git)?/?",
                         address)
    return found.group(1) if found else None


def _json_file(path: Path) -> Any:
    try:
        if path.is_symlink() or not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError):
        return None


def _walk(value: Any, visit: Callable[[str, Any], None]) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            visit(str(key), item)
            _walk(item, visit)
    elif isinstance(value, list):
        for item in value:
            _walk(item, visit)


def _recorded(host: Any, studio: Any, more_repositories: Sequence[str] = (), more_logins: Sequence[str] = ()) -> Tuple[List[str], List[str]]:
    """The repositories and the GitHub logins this workspace has recorded: the remote's address, Studio's ledgers
    (issues.json, ideas.json, requests.json) and the drafts' ideas before stripping; and those GitHub's issues named as export
    read them now (`more_*`). Sorted, each once."""
    rules = host.ticket_rules()
    repositories = {item for item in more_repositories if rules.is_repository(item)}
    logins = {item for item in more_logins if isinstance(item, str) and rules.LOGIN_RE.fullmatch(item) and not MACH_ID_RE.fullmatch(item)}
    address = collab.git(studio.project, "config", "--get", f"remote.{collab.REMOTE}.url").stdout.strip()
    named = _remote_repository(address) if address else None
    if named:
        repositories.add(named)

    def visit(key: str, value: Any) -> None:
        if key == "repository" and rules.is_repository(value):
            repositories.add(value)
        if key in LOGIN_KEYS:
            for item in (value if isinstance(value, list) else [value]):
                if isinstance(item, str) and rules.LOGIN_RE.fullmatch(item) and not MACH_ID_RE.fullmatch(item):
                    logins.add(item)

    sources = [_json_file(studio.home / name) for name in ("issues.json", "ideas.json", "requests.json")]
    ideas_folder = studio.draft / "product" / "ideas"
    if ideas_folder.is_dir() and not ideas_folder.is_symlink():
        sources += [_json_file(path) for path in sorted(ideas_folder.glob("IDEA-*.json"))]
    for source in sources:
        _walk(source, visit)
    return sorted(repositories, key=str.lower), sorted(logins, key=str.lower)


def _paths(studio: Any) -> List[str]:
    """The project's absolute path and the home folder, as written and as resolved; never "/" alone."""
    found = set()
    for path in (studio.project, Path.home()):
        for form in (str(path), str(Path(path).resolve())):
            if form and form.rstrip("/\\"):
                found.add(form.rstrip("/\\"))
    return sorted(found, key=lambda item: (-len(item), item))


def forbidden(host: Any, studio: Any) -> List[str]:
    """Every text the archive must not hold: the repository as OWNER/REPO and github.com/OWNER/REPO, every login this
    workspace has recorded, the project's absolute path and the home folder."""
    repositories, logins = _recorded(host, studio)
    forms = [form for repository in repositories for form in (repository, f"github.com/{repository}")]
    return forms + logins + _paths(studio)


# A login made only of letters and shorter than this may be an ordinary word ("ux", "max", "design"): it is matched only where
# it reads as an account. A login with a digit, hyphen or underscore, or this long or longer, is matched as a whole word
# anywhere: ordinary words that long are rare as logins, and a plain-letter login that long is almost always a name or handle.
DISTINCT_LOGIN_LENGTH = 8
# The words Studio's records and people use for an account beside it: "by ada", "approved by: ada", "author ada", "owner: @ada".
PEOPLE_WORDS = (r"by|approved[ _]by|accepted[ _]by|asked[ _]by|labell?ed[ _]by|picked[ _]up[ _]by|author|login|owner|user|account|"
                r"assignee|reviewer|cc")


def distinctive_login(login: str) -> bool:
    """True when a login cannot be an ordinary word: it holds a digit, hyphen or underscore, or is DISTINCT_LOGIN_LENGTH or longer."""
    return bool(re.search(r"[0-9_-]", login)) or len(login) >= DISTINCT_LOGIN_LENGTH


def login_patterns(logins: Sequence[str], tail: str = "(?![A-Za-z0-9-])") -> List["re.Pattern[str]"]:
    """The patterns that find a recorded login as an account in text, case-insensitively; group 1 is the login found. `tail` is
    what may not follow it."""
    found: List["re.Pattern[str]"] = []
    ordered = sorted(logins, key=len, reverse=True)
    distinct = [login for login in ordered if distinctive_login(login)]
    if distinct:
        found.append(re.compile("(?<![A-Za-z0-9-])(" + "|".join(map(re.escape, distinct)) + ")" + tail, re.IGNORECASE))
    if ordered:
        names = "|".join(map(re.escape, ordered))
        found.append(re.compile(r"(?<![A-Za-z0-9_.@-])@(" + names + ")" + tail, re.IGNORECASE))       # @ux
        found.append(re.compile(r"github\.com[/:](" + names + ")" + tail, re.IGNORECASE))             # github.com/ux
        found.append(re.compile(r"(?<![A-Za-z0-9])(?:" + PEOPLE_WORDS + r")[\"']?[ \t]*[:=]?[ \t]*[\"']?@?(" + names + ")" + tail,
                                re.IGNORECASE))                                                       # by ux, "by": "ux"
    return found


class _Scanner:
    """One pass over each line of a text: the repository (case-insensitive), a login where it reads as an account (see
    login_patterns), an absolute path, and the secret shapes of the intent station's scan.py."""

    def __init__(self, host: Any, studio: Any, more_repositories: Sequence[str] = (), more_logins: Sequence[str] = ()):
        repositories, logins = _recorded(host, studio, more_repositories, more_logins)
        self.rules: List[Tuple[str, "re.Pattern[str]"]] = []
        if repositories:
            self.rules.append(("repository", re.compile("(?<![A-Za-z0-9_.-])(" + "|".join(map(re.escape, repositories)) + ")(?![A-Za-z0-9_-])",
                                                        re.IGNORECASE)))
        self.rules += [("login", pattern) for pattern in login_patterns(logins)]
        self.rules.append(("path", re.compile("(" + "|".join(map(re.escape, _paths(studio))) + ")(?![A-Za-z0-9_.-])")))
        # In a picture's data the bytes after a name are arbitrary (a chunk's checksum follows its text), so nothing is asked of them.
        self.byte_rules: List[Tuple[str, "re.Pattern[str]"]] = []
        if repositories:
            self.byte_rules.append(("repository", re.compile("(?<![A-Za-z0-9_.-])(" + "|".join(map(re.escape, repositories)) + ")", re.IGNORECASE)))
        distinct = sorted((login for login in logins if distinctive_login(login)), key=len, reverse=True)
        if distinct:
            self.byte_rules.append(("login", re.compile("(?<![A-Za-z0-9-])(" + "|".join(map(re.escape, distinct)) + ")", re.IGNORECASE)))
        if logins:  # a short login of letters only: where it reads as an account, with a separator, so chance bytes do not match
            names = "|".join(map(re.escape, sorted(logins, key=len, reverse=True)))
            self.byte_rules.append(("login", re.compile(r"(?:github\.com/|(?<![A-Za-z0-9])(?:" + PEOPLE_WORDS + r")[\"']?(?:[ \t]*[:=][ \t]*|[ \t]+)[\"']?@?)("
                                                        + names + ")", re.IGNORECASE)))
        self.byte_rules.append(("path", re.compile("(" + "|".join(map(re.escape, _paths(studio))) + ")")))
        host.intent_modules()
        import scan  # noqa: E402  the intent station's secret shapes, loaded as change_record's caller loads them
        self.scan = scan

    def first(self, text: str) -> Optional[Tuple[int, str, str]]:
        """(line, kind, what was found) for the first finding, or None."""
        for number, line in enumerate(text.split("\n"), 1):
            for kind, pattern in self.rules:
                found = pattern.search(line)
                if found:
                    return number, kind, found.group(1)
            if self.scan.secrets_in_line("", line)[0]:
                return number, "secret", ""
        return None

    def in_bytes(self, data: bytes) -> Optional[Tuple[str, str]]:
        """(kind, what was found) in a picture's bytes read as Latin-1, so text a PNG or JPEG carries (a comment, an author, a
        path the picture was saved from) is read as text is; the secret shapes are left to text, as a picture's data would
        match them by chance."""
        text = data.decode("latin-1")
        for kind, pattern in self.byte_rules:
            found = pattern.search(text)
            if found:
                return kind, found.group(1)
        return None


def _found_sentence(member: str, line: int, kind: str, value: str) -> str:
    what, noun = described(member)
    fix = (f"Take it out of the {noun}, import the document again, then export again." if noun == "document"
           else f"Take it out of the {noun}, then export again.")
    if kind == "repository":
        return f"{what} names this repository ({value}) on line {line}. The archive must not name the repository, so nothing was exported. {fix}"
    if kind == "login":
        return f"{what} names the GitHub account {value} on line {line}. The archive must not name an account, so nothing was exported. {fix}"
    if kind == "path":
        return (f"{what} names a folder on this computer ({value}) on line {line}. The archive must not name a folder on this computer, "
                f"so nothing was exported. {fix}")
    return f"{what} holds text shaped like a password or key on line {line}. The archive must not carry a secret, so nothing was exported. {fix}"


def _picture_sentence(member: str, kind: str, value: str) -> str:
    what, _ = described(member)
    digest = member.rsplit("/", 1)[-1][:12]
    named = {"repository": f"this repository ({value})", "login": f"the GitHub account {value}",
             "path": f"a folder on this computer ({value})"}[kind]
    must = {"repository": "the repository", "login": "an account", "path": "a folder on this computer"}[kind]
    return (f"{what} {digest} holds text naming {named} inside the picture file. The archive must not name {must}, so nothing was "
            "exported. Save the picture again without that text, add it to the slice in place of this one, then export again.")


# ---- reading the workspace ----


def _read(host: Any, path: Path, member: str) -> bytes:
    """A file's bytes, never more than its member's limit plus one byte (project_archive.write refuses the larger)."""
    limit = project_archive.LIMITS[project_archive.kind_of(member) or "json"]
    try:
        with path.open("rb") as handle:
            return handle.read(limit + 1)
    except OSError as exc:
        what, _ = described(member)
        raise refusal(host, f"{what} cannot be read ({exc.strerror or exc}), so the project was not exported.")


def _text(host: Any, data: bytes, member: str) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        what, _ = described(member)
        raise refusal(host, f"{what} cannot be read as text, so the project was not exported.")


def _record(host: Any, data: bytes, member: str) -> Dict[str, Any]:
    text = _text(host, data, member)
    try:
        record = json.loads(text)
    except (ValueError, RecursionError):
        record = None
    if not isinstance(record, dict):
        what, _ = described(member)
        raise refusal(host, f"{what} is not in the form Product Studio writes, so the project was not exported: it is not a JSON object.")
    return record


def _no_links(host: Any, studio: Any) -> None:
    """A symbolic link anywhere under the draft refuses: nothing is read through one."""
    for folder, folders, files in os.walk(str(studio.draft), followlinks=False):
        for name in sorted(folders + files):
            path = Path(folder) / name
            if path.is_symlink():
                raise refusal(host, f"{path.relative_to(studio.draft).as_posix()} in the workspace is a symbolic link, so the project was not exported. "
                                    "Product Studio only works with real files.")


def _unfinished_import(studio: Any) -> Optional[Dict[str, Any]]:
    """An import that stopped part way (section 4.6): piece D's own answer when it is installed, else its record read here."""
    try:
        import project_import  # noqa: E402  piece D
        return project_import.unfinished(studio)
    except ImportError:
        pass
    folder = studio.home / "imports"
    if not folder.is_dir() or folder.is_symlink():
        return None
    for path in sorted(folder.glob("*.json")):
        record = _json_file(path)
        if isinstance(record, dict) and "finished_at" in record and record.get("finished_at") is None:
            return {"file": path.name, "archive_sha256": record.get("archive_sha256"), "started_at": record.get("started_at")}
    return None


def _github_only(ledger: Dict[str, Any], local: Dict[str, Dict[str, Any]]) -> List[Tuple[str, Optional[int]]]:
    """The slices GitHub held at the last refresh that this workspace does not: (ID, issue). Used only when GitHub cannot be read
    now, to say what the archive may be missing."""
    seen = ((ledger.get("seen") or {}).get("slices") or {})
    found = sorted((slice_id for slice_id in seen if slice_id not in local and product.SLICE_RE.fullmatch(str(slice_id))),
                   key=lambda slice_id: int(slice_id.split("-")[1]))
    return [(slice_id, handoff.issue_of(ledger, slice_id)) for slice_id in found]


def _named(slice_id: str, issue: Optional[int]) -> str:
    return f"{slice_id} (#{issue})" if issue else slice_id


def _changed_since_ready(rules: Any, studio: Any, entry: Dict[str, Any], data: Dict[str, Any], slice_id: str, editable: Sequence[str]) -> bool:
    """The same test as studio.saved_state: a slice marked ready, reopened, whose spec or why differ from what was approved."""
    if data.get("status") not in editable or not entry.get("spec_sha256"):
        return False
    spec, intent = studio.spec_of(slice_id), studio.intent_path(slice_id)
    try:
        now = (rules.text_sha256_of(spec.read_text(encoding="utf-8")) if spec else None,
               rules.text_sha256_of(intent.read_text(encoding="utf-8")) if intent.is_file() else None)
    except (OSError, UnicodeDecodeError):
        return True
    return now != (entry.get("spec_sha256"), entry.get("why_sha256"))


def _studio_errors(host: Any, call: Callable[[], Any]) -> Any:
    """Shape's and the PRD on-ramp's own refusals, as Product Studio's, with the ending."""
    try:
        return call()
    except (shape.ShapeError, prd.PrdError) as exc:
        raise refusal(host, str(exc))


# ---- what GitHub holds (read now, recorded nowhere) ----


def _read_github(host: Any, studio: Any) -> Dict[str, Any]:
    """The project's, epics' and slices' issues and the idea issues, read once, now. Nothing is recorded: not the ledger, not
    the workspace. `checked` is False with `problem` when GitHub could not be read; `connected` is False when the project is
    not on GitHub at all (then there is nothing there to miss)."""
    rules = host.ticket_rules()
    hand = studio.handoff()
    found: Dict[str, Any] = {"checked": False, "connected": False, "problem": None, "repository": None, "snapshot": None, "read_at": None,
                             "ideas": [], "hand": hand, "incomplete": []}
    repository, why = hand.reachable()
    if repository is None:
        if why is None:  # no gh, or a remote that is not GitHub: only the first leaves something unread
            address = collab.git(studio.project, "config", "--get", f"remote.{collab.REMOTE}.url").stdout.strip()
            if address and collab.GITHUB_REMOTE_RE.fullmatch(address):
                why = "The GitHub tool (gh) is not installed on this computer."
        found.update(connected=why is not None, problem=why)
        return found
    found.update(connected=True, repository=repository)
    lists: Dict[str, List[Dict[str, Any]]] = {}
    failure = None
    for label in (*handoff.SNAPSHOT_LABELS, rules.SHAPE_IDEA_LABEL):  # each read to its end; a list GitHub holds more of is named
        listed, failure, whole = issues.list_all_issues(studio.project, repository, label)
        if failure:
            found["problem"] = handoff.explain(failure)
            return found
        lists[label] = listed or []
        if not whole:
            found["incomplete"].append(label)
    snapshot = hand.snapshot_of(lists)
    listed = lists[rules.SHAPE_IDEA_LABEL]
    ideas = set()
    for item in listed or []:
        marker = rules.parse_shape_body(item.get("body"))
        if marker and rules.is_issue_number(item.get("number")):
            ideas.add((str(marker["idea_id"]), item["number"]))
    found.update(checked=True, snapshot=snapshot, read_at=host.now(None), ideas=sorted(ideas))
    return found


LISTED_WHAT = {"mach:project": ("project", "project issues", "the project"), "mach:epic": ("epics", "epic issues", "epics"),
               "mach:slice": ("slices", "slice issues", "slices"), "mach:idea": ("ideas", "idea issues", "ideas")}


def _unread(github: Dict[str, Any]) -> List[Dict[str, Any]]:
    """A row for each kind of issue GitHub held more of than MACH could read: the archive may lack some, and says so."""
    rows = []
    for label in github.get("incomplete") or []:
        ident, issues_word, lacks = LISTED_WHAT.get(label, (label, f"issues labelled {label}", "them"))
        rows.append({"id": ident, "what": "listing", "issue": None,
                     "reason": f"GitHub holds more {issues_word} for this repository than MACH could read ({issues.LIST_CEILING:,}), so the archive "
                               f"may lack some {lacks}. Close the issues that are long finished, then export again."})
    return rows


def _no_project_here(host: Any, github: Dict[str, Any]) -> Tuple[Dict[str, Any], int]:
    """No project in this workspace: the project as its issue on GitHub holds it, read as `project init` reads it (asking for no
    words), or a refusal that says why there is none to take and what to do."""
    define = host.say("Define the project first (project init).", "Define the project first.")
    if not github["checked"]:
        if github["connected"]:
            raise refusal(host, f"There is no project here yet, and MACH could not read GitHub to take it from there. {github['problem']} "
                                "Try again when GitHub can be reached, or export on the computer where the project was made.")
        raise refusal(host, f"There is no project here yet, and this project is not on GitHub, so there is nothing to export. {define}")
    open_ = sorted((item for item in github["snapshot"]["projects"] if item["state"] == "open"), key=lambda item: item["number"])
    if not open_:
        raise refusal(host, f"There is no project here yet, and GitHub holds none for this repository, so there is nothing to export. {define}")
    if len(open_) > 1:
        raise refusal(host, handoff.several_projects([item["number"] for item in open_]).replace("so nothing was saved", "so nothing was exported"))
    item = open_[0]
    theirs = handoff.parse_project_text(item)
    if theirs is None or not product.PROJECT_RE.fullmatch(str(item.get("id") or "")):
        raise refusal(host, f"There is no project here yet, and the project on GitHub (#{item['number']}) is not in the form MACH writes, so it could "
                            "not be taken and nothing was exported. Ask the person who looks after the repository to check it.")
    return ({"schema_version": 1, "project_id": item["id"], "name": theirs["name"], "revision": 1, "status": "draft",
             "vision": theirs["vision"], "outcomes": list(theirs["outcomes"])}, item["number"])


def _project_issue(github: Dict[str, Any], ledger: Dict[str, Any], project: Dict[str, Any]) -> Tuple[Optional[int], Optional[str]]:
    """This project's issue on GitHub, as handoff.find_project finds it, without refusing: (number or None, why GitHub's
    epics and slices are not this project's)."""
    projects = github["snapshot"]["projects"]
    several = sorted(item["number"] for item in projects if item["state"] == "open")
    if len(several) > 1:
        return None, handoff.several_projects(several).replace(" so nothing was saved.", " so nothing was taken from GitHub.")
    linked = (ledger.get("project") or {}).get("number") if ledger.get("repository") == github["repository"] else None
    if linked in [item["number"] for item in projects]:
        return linked, None
    same = sorted(item["number"] for item in projects if item["id"] == project["project_id"] and item["state"] == "open")
    other = [item for item in projects if item["id"] != project["project_id"] and item["state"] == "open"]
    if not same and other:
        return None, (f"This repository's project on GitHub is a different one ({other[0]['id']}, #{other[0]['number']}), so nothing was taken "
                      "from GitHub.")
    return (same[0] if same else None), None


def _main_ref(studio: Any) -> str:
    """The shared remote's main branch as this copy last fetched it (refs/remotes/origin/HEAD, else origin/main). Read only."""
    head = collab.git(studio.project, "symbolic-ref", "-q", "--short", f"refs/remotes/{collab.REMOTE}/HEAD").stdout.strip()
    return head if re.fullmatch(r"[A-Za-z0-9._/-]{1,200}", head or "") else f"{collab.REMOTE}/main"


def _picture(host: Any, studio: Any, ref: str, slice_id: str, name: str) -> Optional[bytes]:
    """A design mock's picture for a slice saved as an issue: the copy in this workspace when there is one (the product manager's
    own ready folder, or the draft's), else the file committed at product/ready/SLICE-NNN/mocks/ on the main branch, read with
    Git without touching the checkout. None when there is none; the caller checks it against the approved hash."""
    rules = host.ticket_rules()
    for path in (mocks.folder(studio, slice_id) / name, studio.draft / "product" / "ready" / slice_id / "mocks" / name):
        if path.is_file() and not path.is_symlink():
            with path.open("rb") as handle:
                return handle.read(rules.MOCK_MAX_BYTES + 1)
    where = f"{ref}:product/ready/{slice_id}/mocks/{name}"
    size = collab.git(studio.project, "cat-file", "-s", where)
    if size.returncode != 0 or not size.stdout.strip().isdigit() or int(size.stdout.strip()) > rules.MOCK_MAX_BYTES:
        return None
    return collab.git_bytes(studio.project, "cat-file", "blob", where)


GITHUB_PROBLEMS = {
    "not_ours": "{slice_id}: issue #{number} is not in the form Product Studio writes, so it is not in the archive.",
    "edited": "{slice_id}: the text of #{number} was changed on GitHub after it was approved, so it is not in the archive. The product manager "
              "who approved it can mark it ready again to put the approved version back; then export again.",
    "no_approval": "{slice_id}: #{number} has no approval for the version it holds, so it is not in the archive. Marking it ready again on the "
                   "computer where it was written gives it one; then export again.",
}


def _found_words(kind: str, value: str, line: Optional[int]) -> str:
    at = f" on line {line}" if line else "" if line == 0 else " inside the picture file"  # 0: a record read whole, where a line means nothing
    if kind == "repository":
        return f"names this repository ({value}){at}"
    if kind == "login":
        return f"names the GitHub account {value}{at}"
    if kind == "path":
        return f"names a folder on this computer ({value}){at}"
    return f"holds text shaped like a password or key{at}"


def _plural(words: str) -> str:
    """_found_words for a plural subject: "names" -> "name", "holds" -> "hold"."""
    head, _, rest = words.partition(" ")
    return f"{head[:-1] if head in ('names', 'holds') else head} {rest}"


def _unit_finding(scanner: "_Scanner", unit: Dict[str, bytes]) -> Optional[Tuple[str, str]]:
    """The first thing in a unit read from GitHub that the archive must not hold: (member, words), or None."""
    for member in sorted(unit):
        if project_archive.kind_of(member) == "mock":
            found = scanner.in_bytes(unit[member])
            if found:
                return member, _found_words(found[0], found[1], None)
            continue
        found_text = scanner.first(unit[member].decode("utf-8"))
        if found_text:
            line, kind, value = found_text
            return member, _found_words(kind, value, line)
    return None


class _FromGitHub:
    """What GitHub holds that this workspace does not, read through the same reader and checks as `slice take` (handoff.
    read_slice_issue, issue_rules.slice_take_check, the spec validator), into memory: nothing is written to the workspace or the
    ledger. Fills `files` and says, for every slice, epic, idea or set GitHub holds that the archive lacks, why."""

    def __init__(self, host: Any, studio: Any, github: Dict[str, Any], ledger: Dict[str, Any], project: Dict[str, Any], project_issue: Optional[int]):
        self.host, self.studio, self.github, self.ledger, self.project = host, studio, github, ledger, project
        self.rules = host.ticket_rules()
        self.hand = github["hand"]
        self.repository = github["repository"]
        self.snapshot = github["snapshot"]
        self.project_issue = project_issue
        self.same_repository = ledger.get("repository") == self.repository
        self.logins: set = set()
        self.not_included: List[Dict[str, Any]] = []
        self.chosen: List[Dict[str, Any]] = []
        self.ids: List[str] = []
        self.files: Dict[str, bytes] = {}
        self.slice_facts: Dict[str, Dict[str, Any]] = {}
        self.epics: Dict[str, Dict[str, Any]] = {}       # epic ID -> record, for epics read from GitHub
        self.slices: Dict[str, Dict[str, Any]] = {}      # slice ID -> work order, for slices read from GitHub
        self.replaced: List[str] = []                    # local slices whose newer version on GitHub the archive holds
        self.numbers: Dict[str, int] = {}                # epic or slice ID read from GitHub -> its issue
        self.notes: List[str] = []                       # sentences about what came, read with the warnings
        self.mocks = 0

    def leave(self, ident: str, what: str, issue: Optional[int], reason: str) -> None:
        self.not_included.append({"id": ident, "what": what, "issue": issue, "reason": reason})

    def entry(self, slice_id: str) -> Dict[str, Any]:
        return (self.ledger["slices"].get(slice_id) or {}) if self.same_repository else {}

    # -- the sets on the project's issue --

    def sets(self, here: Dict[str, bool]) -> Dict[str, Dict[str, Any]]:
        """The principles and technical needs from the project's issue, for a workspace that has none of its own."""
        if self.project_issue is None or all(here.values()):
            return {}
        found, logins, problem = self.hand.published_sets(self.repository, self.snapshot, self.project_issue)
        self.logins |= set(logins)
        records: Dict[str, Dict[str, Any]] = {}
        for kind, words in (("principles", "the product principles"), ("needs", "the technical needs")):
            if here.get(kind):
                continue
            if problem:
                self.leave(kind, kind, self.project_issue, f"MACH could not read the approval of {words} on the project's issue "
                                                           f"(#{self.project_issue}): {problem} So they are not in the archive. Export again to try once more.")
                continue
            item = found.get(kind)
            if item is None:
                continue
            if not item["approved"]:
                self.leave(kind, kind, self.project_issue, f"The project's issue (#{self.project_issue}) holds {words}, but not with an approval for "
                                                           "the version it holds, so they are not in the archive. Publishing them again gives them one.")
                continue
            if item.get("approved_by"):
                self.logins.add(item["approved_by"])
            if kind == "principles":
                records[kind] = {"schema_version": 1, "project_id": self.project["project_id"],
                                 "principles": json.loads(self.rules.principles_canonical(item["items"]))}
            else:
                none = [name for name in self.rules.NEED_KINDS if name in (item.get("extra") or [])]
                records[kind] = {"schema_version": 1, "project_id": self.project["project_id"],
                                 "needs": json.loads(self.rules.needs_canonical(item["items"])), "none": none}
        return records

    # -- epics and slices --

    def chosen_epics(self) -> Dict[str, Dict[str, Any]]:
        """Each epic ID's issue: the lowest-numbered open one, else the lowest-numbered."""
        by_id: Dict[str, List[Dict[str, Any]]] = {}
        for item in self.snapshot["epics"]:
            if product.EPIC_RE.fullmatch(str(item.get("id") or "")):
                by_id.setdefault(item["id"], []).append(item)
        return {ident: sorted(items, key=lambda item: (item["state"] != "open", item["number"]))[0] for ident, items in by_id.items()}

    def epic_fits(self, epic_issue: Dict[str, Any], local_epics: Dict[str, Dict[str, Any]], github_epics: Dict[str, Dict[str, Any]]) -> Optional[str]:
        """None when the slice's epic issue is the epic the archive holds under that ID; otherwise why not, as `slice take` says it."""
        epic_id = epic_issue["id"]
        if epic_id in local_epics:
            linked = (self.ledger["epics"].get(epic_id) or {}).get("number") if self.same_repository else None
            if linked == epic_issue["number"]:
                return None
            if not linked and self.rules.issue_title(local_epics[epic_id].get("title")) == self.rules.issue_title(epic_issue.get("title")):
                return None
            return (f"belongs to {epic_id} on GitHub (#{epic_issue['number']}), and {epic_id} here is a different epic. "
                    + self.host.say(f"Give your epic a new number (epic renumber {epic_id}), then export again.",
                                    "Give your epic a new number, then export again."))
        chosen = github_epics.get(epic_id)
        if chosen is not None and chosen["number"] != epic_issue["number"]:
            return (f"belongs to {epic_id} on GitHub (#{epic_issue['number']}), and another epic on GitHub (#{chosen['number']}) holds {epic_id} "
                    "too. Ask the person who looks after the repository to close the one that should not be there, then export again.")
        return None

    def vet(self, read: Dict[str, Any], slice_id: str, spec_name: Optional[str]) -> Tuple[Optional[str], Dict[str, Any]]:
        """The take checks for one slice issue read now: (why it cannot be in the archive, or None; what it holds)."""
        check, number, labels = read["check"], read["number"], read["labels"]
        # Shipped is what the Factory says with mach:shipped (handoff.describe's state_label, handoff.progress); an issue closed
        # without it was closed by a person, not built. Both are checked as `slice take` checks an open one.
        shipped = SHIPPED_LABEL in labels
        closed = not shipped and (read.get("state") == "closed" or check["problem"] == "shipped")
        if check["problem"] == "shipped":  # shipped work is not opened as a draft, but it is the project's: the same checks
            check = self.rules.slice_take_check({"state": "open", "labels": [name for name in labels if name != SHIPPED_LABEL], "body": read["body"]},
                                                read["comments"])
        if check["problem"]:
            return GITHUB_PROBLEMS.get(check["problem"], GITHUB_PROBLEMS["not_ours"]).format(slice_id=slice_id, number=number), {}
        marker = check["marker"]
        if marker["slice_id"] != slice_id:
            return GITHUB_PROBLEMS["not_ours"].format(slice_id=slice_id, number=number), {}
        if check.get("approved_by"):
            self.logins.add(check["approved_by"])
        self.logins |= {str(item.get("login")) for item in read["comments"] if item.get("login")}
        epic_issue = read["epic"]
        if epic_issue is None or not product.EPIC_RE.fullmatch(str(epic_issue.get("id"))):
            return (f"{slice_id}: the epic #{number} belongs to on GitHub (#{marker.get('epic')}) was not written by Product Studio, so the slice "
                    "is not in the archive."), {}
        depends = []
        for dependency, dependency_id in read["depends"]:
            if dependency_id is None:
                return f"{slice_id} depends on #{dependency}, which is not a slice Product Studio wrote, so it is not in the archive.", {}
            depends.append(dependency_id)
        spec, why = check["spec"], check["why"]
        title = read["title"] or slice_id
        name = spec_name or f"{slice_id}-{self.host.kebab(title)}.md"
        spec_path = self.studio.draft / "specs" / "slices" / name
        others = self.studio.cell.specs_sharing_ids(self.studio.project, spec_path, [*self.hand.handed_over(), slice_id])
        findings, model = self.studio.validate_slice.analyze(spec, name, others, ready=True)
        errors = [f"{finding.message} [{finding.rule}]" for finding in findings if finding.severity == "error"]
        if model.get("slice_id") != slice_id:
            errors.append(f"the spec's title names {model.get('slice_id')}, not {slice_id}")
        if errors or model.get("open_questions"):
            return (f"{slice_id}: the spec in #{number} does not pass the spec check ({(errors or ['it has open questions'])[0]}), so it is not "
                    "in the archive."), {}
        ready_like = shipped or (not closed and bool({"mach:ready", "mach:building", "mach:question"} & set(labels)))
        was = ("shipped" if shipped else "interviewing" if closed else "question" if "mach:question" in labels
               else "being_built" if "mach:building" in labels else "ready_to_build" if "mach:ready" in labels else "interviewing")
        return None, {"marker": marker, "spec": spec, "why": why, "title": title, "name": name, "epic_issue": epic_issue, "depends": depends,
                      "ready_like": ready_like, "was": was, "number": number, "closed": closed}

    def unit(self, slice_id: str, held: Dict[str, Any], ref: str, here: bool = False) -> Tuple[Dict[str, bytes], Dict[str, Any], Optional[str]]:
        """The archive members of one slice read from GitHub, its work order as `slice take` writes it, and why its design mocks
        are left out (or None)."""
        rules, host = self.rules, self.host
        marker, ready_like = held["marker"], held["ready_like"]
        spec_bytes, why_bytes = held["spec"].encode("utf-8"), held["why"].encode("utf-8")
        work = {"schema_version": 1, "slice_id": slice_id, "project_id": self.project["project_id"], "epic_id": held["epic_issue"]["id"], "revision": 1,
                "title": held["title"], "status": host.APPROVED if ready_like else "interviewing", "dependencies": held["depends"],
                "open_questions": [], "spec_path": f"specs/slices/{held['name']}", "spec_sha256": host.sha(spec_bytes) if ready_like else None}
        host.with_tracking(work, marker.get("jira"))
        unit = {f"workspace/specs/slices/{held['name']}": spec_bytes, f"workspace/product/intents/{slice_id}.md": why_bytes}
        mocks_left = None
        items = marker.get("mocks") or []
        if items:
            pictures: Dict[str, bytes] = {}
            for item in items:
                name = rules.mock_file_name(item)
                data = _picture(host, self.studio, ref, slice_id, name)
                if data is None or rules.check_mock_file(item, data) is not None:
                    where = (f"Commit product/ready/{slice_id}/mocks/ to the main branch, fetch it here, then export again." if here else
                             f"On the computer where it was marked ready, commit product/ready/{slice_id}/mocks/ to the main branch; then fetch "
                             "here and export again.")
                    mocks_left = (f"{slice_id}'s design mocks are not in the archive: the picture {item['sha256'][:12]} is not on {ref} in this copy "
                                  f"of the repository, or is not the approved one. {slice_id} is in the archive without them. {where}")
                    break
                pictures[f"workspace/product/mocks/{slice_id}/{name}"] = data
            if mocks_left is None:
                work["mocks"] = [dict(item) for item in items]
                unit.update(pictures)
        unit[f"workspace/product/slices/{slice_id}.json"] = host.canonical(STRIP["slice"](work)).encode("utf-8")
        return unit, work, mocks_left

    def complete(self, local: Dict[str, Dict[str, Any]], local_epics: Dict[str, Dict[str, Any]], scanner_for: Callable[[], "_Scanner"],
                 slice_now: Callable[[str], Tuple[Optional[str], Optional[str]]], spec_names: Dict[str, str], editable: Sequence[str],
                 changed_here: Sequence[str] = ()) -> None:
        """Every slice and epic GitHub holds that the archive does not, in dependency order; and, for a slice here that someone
        else saved a newer version of on GitHub, that version when this workspace's is the approved one (yours stays when you
        changed it). `slice_now(ID)` gives a local slice's spec and why SHA-256 as they are now."""
        rules, host = self.rules, self.host
        github_epics = {ident: item for ident, item in self.chosen_epics().items() if ident not in local_epics}
        by_id: Dict[str, List[Dict[str, Any]]] = {}
        for item in self.snapshot["slices"]:
            by_id.setdefault(item["marker"]["slice_id"], []).append(item)

        wanted: Dict[str, Tuple[int, Optional[str]]] = {}  # slice ID -> (issue, local spec name when it would replace the slice here)
        clashed: set = set()  # slices here that are not the slice GitHub holds under the same ID: GitHub's dependents cannot lean on them
        for slice_id, items in sorted(by_id.items()):
            numbers = [item["number"] for item in items]
            entry = self.entry(slice_id)
            if slice_id not in local:
                waiting = [item for item in items if item["state"] == "open" and SHIPPED_LABEL not in item["labels"]]
                wanted[slice_id] = (max(item["number"] for item in (waiting or items)), None)
                continue
            own = entry.get("number") if entry.get("number") in numbers else None
            if own is None:
                if entry.get("number") or entry.get("taken_at"):
                    continue  # handed over from here; its issue is not among GitHub's now, so nothing there is newer
                issue = max(numbers)
                clashed.add(slice_id)
                self.leave(slice_id, "slice", issue, f"Two different slices use the number {slice_id}: your draft here and #{issue} on GitHub. The "
                                                     f"archive holds the one from this workspace. Giving your draft a new number in Product Studio "
                                                     + host.say(f"(slice renumber {slice_id}) ", "") + "lets both come; then export again.")
                continue
            if slice_id in changed_here:
                continue  # approved here, then changed: the archive holds this workspace's text as a draft (said in _collect)
            item = next(item for item in items if item["number"] == own)
            theirs = (item["marker"].get("spec_sha256"), item["marker"].get("why_sha256"))
            if theirs == slice_now(slice_id):
                continue
            base = entry.get("revision") or entry.get("base_revision") or 0
            newer = type(item["marker"].get("revision")) is int and item["marker"]["revision"] > base
            if local[slice_id].get("status") in editable:
                if newer:
                    self.chosen.append({"id": slice_id, "used": "here", "issue": own,
                                        "note": f"Someone else saved a newer version of {slice_id} on GitHub (version {item['marker']['revision']}, #{own}); "
                                                f"you have changed {slice_id} here, so the archive holds your draft."})
                continue
            if newer:
                wanted[slice_id] = (own, spec_names.get(slice_id))
            else:
                self.chosen.append({"id": slice_id, "used": "here", "issue": own,
                                    "note": f"{slice_id}'s text on GitHub (#{own}) is not the version approved here, so the archive holds the "
                                            "approved version from this workspace."})

        reads: Dict[str, Dict[str, Any]] = {}
        for slice_id, (number, spec_name) in sorted(wanted.items()):
            try:
                read = self.hand.read_slice_issue(self.repository, self.snapshot, number)
            except handoff.HandoffError:
                reason = (f"{slice_id} (#{number}) could not be read from GitHub just now, so it is not in the archive. Export again to try once more.")
                self.keep_or_leave(slice_id, number, reason, local)
                continue
            reason, held = self.vet(read, slice_id, spec_name)
            if reason is None:
                reason = self.epic_fits(held["epic_issue"], local_epics, github_epics)
                reason = f"{slice_id} {reason}" if reason else None
            if reason:
                self.keep_or_leave(slice_id, number, reason, local)
                continue
            reads[slice_id] = held

        scanner = scanner_for()
        ref = _main_ref(self.studio)
        epic_units: Dict[str, Tuple[Dict[str, bytes], Dict[str, Any]]] = {}
        bad_epics: Dict[str, str] = {}
        for epic_id, item in sorted(github_epics.items()):
            record = {"schema_version": 1, "epic_id": epic_id, "project_id": self.project["project_id"], "revision": 1,
                      "title": rules.issue_title(item.get("title")) or epic_id, "status": "open", "acceptance_criteria": rules.epic_criteria(item.get("body"))}
            unit = {f"workspace/product/epics/{epic_id}.json": host.canonical(STRIP["epic"](record)).encode("utf-8")}
            finding = _unit_finding(scanner, unit)
            if finding:
                bad_epics[epic_id] = (f"{epic_id}'s record, as GitHub holds it (#{item['number']}), {finding[1]}. The archive must not, so {epic_id} "
                                      "and its slices from GitHub are not in it. Change it on the computer where it was written and mark one of its "
                                      "slices ready again, then export again.")
                self.leave(epic_id, "epic", item["number"], bad_epics[epic_id])
                continue
            epic_units[epic_id] = (unit, record)
            self.numbers[epic_id] = item["number"]

        units: Dict[str, Tuple[Dict[str, bytes], Dict[str, Any], Optional[str], Dict[str, Any]]] = {}
        for slice_id, held in sorted(reads.items()):
            epic_id = held["epic_issue"]["id"]
            if epic_id in bad_epics:
                self.keep_or_leave(slice_id, held["number"], f"{slice_id} belongs to {epic_id}, which is not in the archive (see {epic_id}).", local)
                continue
            unit, work, mocks_left = self.unit(slice_id, held, ref, here=slice_id in local)
            finding = _unit_finding(scanner, unit)
            if finding:
                what, _ = described(finding[0])
                self.keep_or_leave(slice_id, held["number"], f"{what}, as GitHub holds it (#{held['number']}), {finding[1]}. The archive must not, so "
                                                             f"{slice_id} from GitHub is not in it. Change it on the computer where it was written and mark "
                                                             "it ready again, then export again.", local)
                continue
            units[slice_id] = (unit, work, mocks_left, held)

        # Dependency order: a slice comes in once everything it depends on is in the archive; one that depends on a slice that is not
        # stays out, and says which.
        included = set(local) - clashed
        pending = dict(units)
        while pending:
            moved = False
            for slice_id in sorted(pending):
                unit, work, mocks_left, held = pending[slice_id]
                missing = [dep for dep in work["dependencies"] if dep not in included and dep not in pending]
                if missing:
                    del pending[slice_id]
                    self.keep_or_leave(slice_id, held["number"],
                                       f"{slice_id} depends on {missing[0]}, which is not in the archive, so {slice_id} from GitHub is not either.", local)
                    moved = True
                elif all(dep in included for dep in work["dependencies"]):
                    del pending[slice_id]
                    self.take(slice_id, unit, work, mocks_left, held, local)
                    included.add(slice_id)
                    moved = True
            if not moved:
                for slice_id in sorted(pending):
                    self.keep_or_leave(slice_id, pending[slice_id][3]["number"],
                                       f"{slice_id} depends on slices that depend on it in turn, so it is not in the archive.", local)
                break

        for epic_id, (unit, record) in sorted(epic_units.items()):
            self.files.update(unit)
            self.epics[epic_id] = record
            self.ids.append(epic_id)

    def keep_or_leave(self, slice_id: str, number: int, reason: str, local: Dict[str, Dict[str, Any]]) -> None:
        """A slice GitHub holds that cannot come from there: not in the archive, or, when this workspace has it, kept from here."""
        if slice_id in local:
            self.chosen.append({"id": slice_id, "used": "here", "issue": number,
                                "note": f"Someone else saved a newer version of {slice_id} on GitHub (#{number}), but it could not be taken: "
                                        f"{reason} The archive holds the version in this workspace."})
        else:
            self.leave(slice_id, "slice", number, reason)

    def take(self, slice_id: str, unit: Dict[str, bytes], work: Dict[str, Any], mocks_left: Optional[str], held: Dict[str, Any],
             local: Dict[str, Dict[str, Any]]) -> None:
        if slice_id in local:
            self.replaced.append(slice_id)
            self.chosen.append({"id": slice_id, "used": "github", "issue": held["number"],
                                "note": f"Someone else saved a newer version of {slice_id} on GitHub (version {held['marker']['revision']}, "
                                        f"#{held['number']}); the archive holds that version, since yours here was not changed."})
        self.files.update(unit)
        self.slices[slice_id] = work
        self.numbers[slice_id] = held["number"]
        self.ids.append(slice_id)
        self.mocks += len(work.get("mocks") or [])
        if mocks_left:
            self.leave(slice_id, "design mocks", held["number"], mocks_left)
        if held.get("closed"):
            self.notes.append(f"{slice_id}'s issue (#{held['number']}) was closed without being built, so it comes as a draft.")
        self.slice_facts[slice_id] = {"was": held["was"], "revision": held["marker"]["revision"], "jira": held["marker"].get("jira"),
                                      "request": None, "note": None, "was_ready": bool(held["ready_like"] and not mocks_left), "from_github": True}

    def ideas(self, local_ideas: Sequence[str]) -> None:
        """Ideas saved as issues that are not here: an idea's record, lookups and working files are not in its issue."""
        for idea_id, number in self.github["ideas"]:
            if idea_id not in local_ideas:
                self.leave(idea_id, "idea", number, f"{idea_id} (#{number}) is on GitHub, but an idea's record, lookups and working files are kept only "
                                                    "on the computer where it was written (its issue holds the brief alone), so it is not in the archive. "
                                                    "Export there to include it.")

    def only_mine(self, local: Dict[str, Dict[str, Any]], local_ideas: Sequence[str]) -> None:
        """--only-mine: what GitHub holds that this workspace does not, left out as asked."""
        by_id: Dict[str, List[int]] = {}
        for item in self.snapshot["slices"]:
            by_id.setdefault(item["marker"]["slice_id"], []).append(item["number"])
        for slice_id, numbers in sorted(by_id.items(), key=lambda pair: int(pair[0].split("-")[1])):
            if slice_id not in local:
                self.leave(slice_id, "slice", max(numbers), f"{slice_id} (#{max(numbers)}) is on GitHub but not in your workspace; it was left out, as you asked.")
        self.ideas(local_ideas)


SHIPPED_LABEL = "mach:shipped"
FROM_GITHUB_NOTE = ("Drafts never marked ready, PRDs, designs, ideas' working files and interview notes exist only on the computer where they were "
                    "written. Export there to include them.")


KIND_ORDER = ("project", "principles", "needs", "EPIC", "SLICE", "IDEA", "PRD", "DES")


def _ordered(ids: Sequence[str]) -> List[str]:
    """The project, its sets, then epics, slices, ideas, PRDs and designs, each by number."""
    def key(ident: str) -> Tuple[int, int]:
        kind, _, number = ident.partition("-")
        return KIND_ORDER.index(kind if kind in KIND_ORDER else ident), int(number) if number.isdigit() else 0
    return sorted(dict.fromkeys(ids), key=key)


def _misfit(host: Any, error: str, numbers: Dict[str, int]) -> str:
    """The refusal when what GitHub holds and what is here do not fit together: the first thing that does not, in plain words,
    where it came from, and what resolves it."""
    location, _, message = error.partition(": ")
    found = re.search(r"(SLICE|EPIC)-[0-9]+", location)
    ident = found.group(0) if found else None
    known = re.fullmatch(r"unknown dependency '(.+)'", message)
    if ident and known:
        plain = f"{ident} depends on {known.group(1)}, which is neither in this workspace nor on GitHub"
    elif ident and message == "epic_id is unknown":
        plain = f"{ident} belongs to an epic that is neither in this workspace nor on GitHub"
    elif ident:
        plain = f"{described('workspace/' + location)[0]} does not fit with the rest ({message})"
    else:
        plain = f"{location} does not fit with the rest ({message})"
    if ident in numbers:
        where = (f"{ident} came from GitHub (#{numbers[ident]}): the product manager who marked it ready can put it right in Product Studio "
                 "and mark it ready again")
    else:
        where = f"{ident or 'It'} is in this workspace: put it right here in Product Studio"
    return (f"What GitHub holds and what is in this workspace do not fit together, so nothing was exported: {plain}. {where}, then export again, or "
            + host.say("export only what is here (project export --only-mine).", "export only what is in this workspace."))


def _not_assessed(host: Any, studio: Any, files: Dict[str, bytes], local: Dict[str, Dict[str, Any]]) -> Tuple[List[Dict[str, str]], List[Tuple[str, str]]]:
    """The Not assessed rows that travel (facts.json `not_assessed`), and the rows no import here vouches for: (slice, principle).
    (a) every Not assessed row in a spec the archive holds, with the import record that wrote it (project_import.not_assessed_problems
    finds none against it); (b) for a slice of this workspace already marked ready, each principle that came with a project brought
    in after it and that its spec does not answer (what `principle list` computes and reopening writes)."""
    import project_import  # noqa: E402  as studio.py imports it, where it is used
    validate = studio.validate_slice
    rows: Dict[Tuple[str, str], Dict[str, str]] = {}
    unvouched: List[Tuple[str, str]] = []
    for member in sorted(files):
        found = re.fullmatch(r"workspace/specs/slices/(SLICE-[0-9]+)-.*\.md", member)
        if not found:
            continue
        slice_id = found.group(1)
        for line in files[member].decode("utf-8").splitlines():
            row = validate.NOT_ASSESSED_ROW_RE.match(line.strip())
            if not row:
                continue
            said = validate.not_assessed_reason(row.group(1), row.group(4))
            if said is None or project_import.not_assessed_problems(studio, slice_id, [{"id": row.group(1), **said}]):
                unvouched.append((slice_id, row.group(1)))
                continue
            rows[(slice_id, row.group(1))] = {"slice": slice_id, "principle": row.group(1), "how": said["how"], "project": said["project"],
                                              "day": said["day"]}
    current = {item["id"]: item for item in project_import.active_here(studio)}
    for _, record in project_import._records(studio):  # noqa: SLF001  the import records, read as rows_on_reopen reads them
        if record.get("mode") != "join" or not record.get("finished_at"):
            continue
        came = [current[i] for i in (record.get("merges") or {}).get("principles") or [] if i in current]
        project = str(record.get("from_project_name") or record.get("from_project"))
        day = str(record.get("day") or record.get("started_at") or "")[:10]
        for slice_id, data in sorted(local.items()):
            if data.get("status") != host.APPROVED or slice_id in project_import.slices_of(record):
                continue
            for item in project_import.rows_for_slices_here(host, studio, came, project_import.slices_of(record), project, day, write=False,
                                                            only=[slice_id], editable=False):
                rows.setdefault((slice_id, item["principle"]), {"slice": slice_id, "principle": item["principle"], "how": "principle_came",
                                                                "project": project, "day": day})
    return [rows[key] for key in sorted(rows, key=lambda key: (int(key[0].split("-")[1]), key[1]))], unvouched


def _combined_errors(files: Dict[str, bytes]) -> List[str]:
    """The structural check of the workspace the archive holds, staged in a temporary folder that is removed again."""
    with tempfile.TemporaryDirectory(prefix="mach-export-") as folder:
        root = Path(folder)
        for member, data in files.items():
            if member.startswith("workspace/"):
                path = root / member[len("workspace/"):]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
        return list(product.validate_workspace(root)["errors"])


def collect(host: Any, studio: Any, only_mine: bool) -> Tuple[Dict[str, bytes], Dict[str, Any], List[str]]:
    """Every member of the archive (facts.json among them; the manifest is project_archive.write's), the facts, and the
    warnings. Raises host.StudioError with the sentences of section 7.1. Writes nothing."""
    files, facts, warnings, _, _ = _collect(host, studio, only_mine)
    return files, facts, warnings


def _collect(host: Any, studio: Any, only_mine: bool) -> Tuple[Dict[str, bytes], Dict[str, Any], List[str], Dict[str, int], Dict[str, Any]]:
    """collect's work, with the manifest's counts and the report: where each part came from and what GitHub holds that the
    archive lacks."""
    rules = host.ticket_rules()
    here = studio.path("project").is_file() or studio.path("project").is_symlink()
    if not here and only_mine:
        raise refusal(host, "There is no project in this workspace yet, so there is nothing of yours to export. "
                            + host.say("Export without --only-mine to take the project from GitHub.", "Export everything to take the project from GitHub."))
    _no_links(host, studio)
    if here:
        report = studio.structural()
        if not report["valid"]:
            raise refusal(host, "The project's files are not consistent, so they were not exported: " + "; ".join(report["errors"][:5])
                          + host.say(". Run status to see what needs fixing.", ". The project home shows what needs fixing."))
    github = _read_github(host, studio)
    hand = github["hand"]
    ledger = hand.load()

    files: Dict[str, bytes] = {}
    warnings: List[str] = []
    from_here: List[str] = []

    def add_json(member: str, kind: str, record: Dict[str, Any]) -> Dict[str, Any]:
        stripped = STRIP[kind](record)
        files[member] = host.canonical(stripped).encode("utf-8")
        return stripped

    def add_text(member: str, path: Path) -> None:
        data = _read(host, path, member)
        _text(host, data, member)
        files[member] = data

    draft = studio.draft
    project_issue: Optional[int] = None
    taken_problem: Optional[str] = None
    if here:
        project = _record(host, _read(host, studio.path("project"), "workspace/product/project.json"), "workspace/product/project.json")
        from_here.append("project")
        if github["checked"]:
            project_issue, taken_problem = _project_issue(github, ledger, project)
    else:
        project, project_issue = _no_project_here(host, github)
    add_json("workspace/product/project.json", "project", project)

    # Epics and slices: their files, as the structural check has just read them.
    epics: Dict[str, Dict[str, Any]] = {}
    for path in sorted((draft / "product" / "epics").glob("EPIC-*.json")):
        member = f"workspace/product/epics/{path.name}"
        if project_archive.kind_of(member):
            epics[path.stem] = _record(host, _read(host, path, member), member)
            add_json(member, "epic", epics[path.stem])
    local: Dict[str, Dict[str, Any]] = {}
    for path in sorted((draft / "product" / "slices").glob("SLICE-*.json")):
        member = f"workspace/product/slices/{path.name}"
        if project_archive.kind_of(member):
            local[path.stem] = _record(host, _read(host, path, member), member)
            add_json(member, "slice", local[path.stem])

    mock_count = 0
    spec_names: Dict[str, str] = {}
    for slice_id, data in local.items():
        try:
            spec = studio.spec_of(slice_id)
        except host.StudioError as exc:
            raise refusal(host, str(exc))
        if spec is not None:
            spec_names[slice_id] = spec.name
            add_text(f"workspace/specs/slices/{spec.name}", spec)
        intent = studio.intent_path(slice_id)
        if intent.is_file():
            add_text(f"workspace/product/intents/{slice_id}.md", intent)
        for item in mocks.listed(data):
            name = rules.mock_file_name(item)
            member = f"workspace/product/mocks/{slice_id}/{name}"
            path = mocks.folder(studio, slice_id) / name
            picture = _read(host, path, member) if path.is_file() else None
            if picture is None or rules.check_mock_file(item, picture) is not None:
                raise refusal(host, f"{slice_id}'s design mock {item['sha256'][:12]} is not a picture Product Studio can check, so the project was not exported.")
            files[member] = picture
            mock_count += 1

    counts = {"epics": len(epics), "slices": len(local), "principles": 0, "needs": 0, "ideas": 0, "prds": 0, "designs": 0, "mocks": mock_count}
    sets_here = {}
    for name, key, kind in (("principles.json", "principles", "principles"), ("needs.json", "needs", "needs")):
        path = draft / "product" / name
        sets_here[key] = path.is_file()
        if path.is_file():
            member = f"workspace/product/{name}"
            record = add_json(member, kind, _record(host, _read(host, path, member), member))
            counts[key] = len(record.get(key) or [])
            from_here.append(key)

    # Ideas, with their lookups, maps, briefs and cases.
    ideas = _studio_errors(host, lambda: shape.Ideas(host, studio))
    idea_facts: Dict[str, Dict[str, Any]] = {}
    lookups_removed: Dict[str, int] = {}
    for idea_id in ideas.ids():
        member = f"workspace/product/ideas/{idea_id}.json"
        record = _record(host, _read(host, ideas.path(idea_id), member), member)
        problems = shape.record_problems(record, rules) or ([] if record.get("idea_id") == idea_id else ["its ID does not match its file"])
        if problems:
            raise refusal(host, f"{idea_id}'s record is not in the form Product Studio writes, so the project was not exported: {'; '.join(problems[:3])}.")
        add_json(member, "idea", record)
        source = record["source"]
        was = None
        if source.get("kind") in ("idea", "request"):
            was = {"kind": source["kind"], "number": source["number"]}
        elif source.get("kind") == "fault":
            was = {"kind": "fault", "ticket": source["ticket"]}
        idea_facts[idea_id] = {"was_source": was}
        path = ideas.lookups_path(idea_id)
        if path.is_file():
            member = f"workspace/product/ideas/{idea_id}.lookups.json"
            lookups = _record(host, _read(host, path, member), member)
            stripped = add_json(member, "lookups", lookups)
            removed = len(lookups.get("similar") or []) - len(stripped.get("similar") or []) if isinstance(lookups.get("similar"), list) else 0
            if removed:
                lookups_removed[idea_id] = removed
        path = ideas.map_path(idea_id)
        if path.is_file():
            member = f"workspace/product/ideas/{idea_id}.map.json"
            add_json(member, "idea_map", _record(host, _read(host, path, member), member))
        for path, member in ((ideas.brief_path(idea_id), f"workspace/product/briefs/{idea_id}.md"),
                             (ideas.case_path(idea_id), f"workspace/product/briefs/{idea_id}.case.md")):
            if path.is_file():
                add_text(member, path)
    counts["ideas"] = len(idea_facts)

    # PRDs and designs: the record, the document exactly as imported (its SHA-256 checked), the map, a PRD's drafted answers.
    documents_here: List[str] = []
    for documents, top, kinds, counted in ((_studio_errors(host, lambda: prd.Prds(host, studio)), "prds", ("prd_meta", "prd_map"), "prds"),
                                           (_studio_errors(host, lambda: design.Designs(host, studio)), "designs", ("design_meta", "design_map"), "designs")):
        for ident in documents.ids():
            base = f"workspace/product/{top}/{ident}"
            folder = documents.folder(ident)
            member = f"{base}/{documents.META}"
            meta = _record(host, _read(host, folder / documents.META, member), member)
            problem = (None if meta.get(documents.ID_KEY) == ident else "its ID does not match its folder") or \
                      (None if meta.get("file") in (f"{documents.BASE}.md", f"{documents.BASE}.txt") else "it names no document") or \
                      (None if isinstance(meta.get("sha256"), str) and project_archive.HEX_RE.fullmatch(meta["sha256"]) else "it holds no SHA-256")
            if problem:
                raise refusal(host, f"{ident}'s record is not in the form Product Studio writes, so the project was not exported: {problem}.")
            raw, intact = documents.document(meta)
            if not intact:
                raise refusal(host, f"The copy of {ident} in the workspace no longer matches what was imported, so the project was not exported. "
                                    "Import the document again.")
            add_json(member, kinds[0], meta)
            document_member = f"{base}/{meta['file']}"
            _text(host, raw, document_member)
            files[document_member] = raw
            path = folder / "map.json"
            if path.is_file():
                add_json(f"{base}/map.json", kinds[1], _record(host, _read(host, path, f"{base}/map.json"), f"{base}/map.json"))
            answers = folder / "answers"
            if top == "prds" and answers.is_dir():
                for path in sorted(answers.glob("*.json")):
                    member = f"{base}/answers/{path.name}"
                    if prd.MAP_KEY_RE.fullmatch(path.stem) and project_archive.kind_of(member):
                        add_json(member, "prd_answers", _record(host, _read(host, path, member), member))
            counts[counted] += 1
            documents_here.append(ident)

    def slice_now(slice_id: str) -> Tuple[Optional[str], Optional[str]]:
        spec, intent = studio.spec_of(slice_id), studio.intent_path(slice_id)
        try:
            return (rules.text_sha256_of(spec.read_text(encoding="utf-8")) if spec else None,
                    rules.text_sha256_of(intent.read_text(encoding="utf-8")) if intent.is_file() else None)
        except (OSError, UnicodeDecodeError):
            return None, None

    # An approved slice is ready only while its spec, why and design mocks are exactly what was approved (the hashes the approval
    # and the ledger carry: handoff's spec_sha256, why_sha256, mocks_sha256). One changed here since comes as a draft.
    changed_here: List[str] = []
    for slice_id, data in local.items():
        if data.get("status") != host.APPROVED:
            continue
        entry = ledger["slices"].get(slice_id) or {}
        listed_mocks = mocks.listed(data)
        if (not entry.get("spec_sha256") or not entry.get("why_sha256") or slice_now(slice_id) != (entry["spec_sha256"], entry["why_sha256"])
                or (rules.mocks_sha256(listed_mocks) if listed_mocks else None) != entry.get("mocks_sha256")):
            changed_here.append(slice_id)
            files[f"workspace/product/slices/{slice_id}.json"] = host.canonical(STRIP["slice"]({**data, "status": "interviewing",
                                                                                                "spec_sha256": None})).encode("utf-8")

    # What GitHub holds that this workspace does not (read now, through `slice take`'s reader and checks; recorded nowhere).
    editable = getattr(host, "EDITABLE_SLICE", ("draft", "interviewing", "ready_for_approval"))
    completion: Optional[_FromGitHub] = None
    if github["checked"] and taken_problem is None:
        completion = _FromGitHub(host, studio, github, ledger, project, project_issue)
        if not here:
            completion.ids.append("project")
        if only_mine:
            completion.only_mine(local, idea_facts)
        else:
            for key, record in completion.sets(sets_here).items():
                member = f"workspace/product/{key}.json"
                completion.files[member] = host.canonical(STRIP[key](record)).encode("utf-8")
                completion.ids.append(key)

            completion.complete(local, epics, lambda: _Scanner(host, studio, [github["repository"]], sorted(completion.logins)),
                                slice_now, spec_names, editable, changed_here)
            completion.ideas(idea_facts)
        for slice_id in completion.replaced:  # the newer version from GitHub stands in for the approved one here
            for member in [m for m in files if m in (f"workspace/product/slices/{slice_id}.json", f"workspace/product/intents/{slice_id}.md")
                           or m.startswith(f"workspace/product/mocks/{slice_id}/")
                           or (slice_id in spec_names and m == f"workspace/specs/slices/{spec_names[slice_id]}")]:
                if member.startswith("workspace/product/mocks/"):
                    mock_count -= 1
                del files[member]
            local.pop(slice_id)
        files.update(completion.files)
        for key in ("principles", "needs"):
            if key in completion.ids:
                counts[key] = len(json.loads(completion.files[f"workspace/product/{key}.json"]).get(key) or [])
        counts["epics"] += len(completion.epics)
        counts["slices"] = len(local) + len(completion.slices)
        counts["mocks"] = mock_count + completion.mocks
    if taken_problem:
        warnings.append(taken_problem)

    # Not checked now: what the last refresh knew that this workspace lacks, said as what the archive may be missing.
    maybe_missing: List[Tuple[str, Optional[int]]] = []
    if not github["checked"]:
        maybe_missing = _github_only(ledger, local)

    from_here = _ordered(from_here + list(epics) + list(local) + list(idea_facts) + documents_here)
    from_github = _ordered(completion.ids) if completion else []
    not_included = _unread(github) + (list(completion.not_included) if completion else [])
    if not github["checked"] and github["connected"]:
        at = ((ledger.get("seen") or {}).get("refreshed_at")) if ledger.get("seen") else None
        for slice_id, issue in maybe_missing:
            not_included.append({"id": slice_id, "what": "slice", "issue": issue,
                                 "reason": f"{_named(slice_id, issue)} was on GitHub at the last refresh ({host.clock(at)}) and is not in your workspace; "
                                           "GitHub could not be read now, so it is not in the archive."})
    left_out = sorted({row["id"] for row in not_included if row["what"] == "slice"}, key=lambda ident: int(ident.split("-")[1]))
    if only_mine and left_out:
        named = [f"{row['id']} (#{row['issue']})" if row.get("issue") else row["id"] for row in not_included if row["what"] == "slice"]
        warnings.append(f"Left out, as you asked: {len(named)} slice{'s' if len(named) != 1 else ''} of this project on GitHub but not in your "
                        f"workspace ({', '.join(named)}).")

    session = studio.session()
    slice_facts: Dict[str, Dict[str, Any]] = {}
    for slice_id, data in local.items():
        view = handoff.slice_view(ledger, slice_id, data, rules)
        origin = data.get("origin") if isinstance(data.get("origin"), dict) else {}
        note = (session.get("notes") or {}).get(slice_id)
        note = note.get("note") if isinstance(note, dict) and isinstance(note.get("note"), str) else None
        slice_facts[slice_id] = {"was": view["progress"], "revision": view["revision"] if type(view["revision"]) is int else None,
                                 "jira": (data.get("tracking") or {}).get("jira") if isinstance(data.get("tracking"), dict) else None,
                                 "request": origin.get("number") if type(origin.get("number")) is int else None, "note": note,
                                 "was_ready": data.get("status") == host.APPROVED and slice_id not in changed_here}
        if slice_id in changed_here:
            slice_facts[slice_id]["was"] = "interviewing"
            warnings.append(f"{slice_id} was changed here after it was approved, so it comes as a draft, not as ready.")
        if _changed_since_ready(rules, studio, ledger["slices"].get(slice_id) or {}, data, slice_id, editable):
            warnings.append(f"{slice_id} changed since it was marked ready; the archive holds your draft.")
        if view["newer_elsewhere"] and (completion is None or only_mine):
            warnings.append(f"Someone else saved a newer version of {slice_id} on GitHub; the archive holds the version in this workspace.")
    all_epics = {**epics, **(completion.epics if completion else {})}
    all_slices = {**local, **(completion.slices if completion else {})}
    epic_jira: Dict[str, str] = {}
    if completion:
        slice_facts.update(completion.slice_facts)
        warnings += completion.notes
        # 4b. GitHub carries one key per slice, the slice's own or else its epic's. A key two or more slices of one epic carry, or
        # the key this workspace's epic has, is the epic's: reported against the epic, not as each slice's own.
        by_epic: Dict[Tuple[str, str], List[str]] = {}
        for slice_id, row in completion.slice_facts.items():
            if row.get("jira"):
                by_epic.setdefault((completion.slices[slice_id]["epic_id"], row["jira"]), []).append(slice_id)
        for (epic_id, key), members in by_epic.items():
            here_key = (epics.get(epic_id, {}).get("tracking") or {}).get("jira") if isinstance(epics.get(epic_id, {}).get("tracking"), dict) else None
            if len(members) > 1 or here_key == key:
                for slice_id in members:
                    slice_facts[slice_id]["jira"] = None
                if epic_id in completion.epics:
                    epic_jira[epic_id] = key
    seen = ledger.get("seen") or {}
    order: Dict[str, List[str]] = {}
    for epic_id in sorted(all_epics):
        listed = [slice_id for slice_id in handoff.effective_order(ledger, local, epic_id, hand.rank(ledger, epic_id)) if slice_id in all_slices]
        listed += sorted((slice_id for slice_id, work in all_slices.items() if work.get("epic_id") == epic_id and slice_id not in listed),
                         key=lambda slice_id: int(slice_id.split("-")[1]))
        order[epic_id] = listed
    facts = {
        "schema_version": FACTS_VERSION,
        "last_read_github_at": seen.get("refreshed_at") if isinstance(seen.get("refreshed_at"), str) else github["read_at"],
        "order": order,
        "slices": {slice_id: slice_facts[slice_id] for slice_id in sorted(slice_facts)},
        "epics": {epic_id: {"jira": (data.get("tracking") or {}).get("jira") if isinstance(data.get("tracking"), dict) else epic_jira.get(epic_id)}
                  for epic_id, data in sorted(all_epics.items())},
        "ideas": idea_facts,
        "lookups_removed": lookups_removed,
    }
    not_assessed, unvouched = _not_assessed(host, studio, files, local)
    if not_assessed:  # M21: optional; an importer that does not know it ignores it
        facts["not_assessed"] = not_assessed
    for slice_id, principle in unvouched:
        warnings.append(f"{slice_id}'s spec says {principle} is 'Not assessed', but no project brought in here wrote that row, so it does not "
                        "travel as one: in the new place it has to be answered.")
    files[project_archive.FACTS] = project_archive.canonical(facts)

    if from_github:  # what came from GitHub must fit what is here: the same structural check the workspace passes
        errors = _combined_errors(files)
        if errors:
            raise refusal(host, _misfit(host, errors[0], completion.numbers if completion else {}))

    # Nothing in any text may name the repository, an account, a folder here, or a secret (section 2.4). Resume notes are
    # read on their own first, so the sentence names the slice rather than the archive's facts.
    scanner = _Scanner(host, studio, [github["repository"]] if github["repository"] else [], sorted(completion.logins) if completion else [])
    for slice_id, row in sorted(slice_facts.items()):
        found = scanner.first(row["note"]) if row["note"] else None
        if found:
            line, kind, value = found
            sentence = _found_sentence(project_archive.FACTS, line, kind, value).replace("The archive's facts", f"{slice_id}'s resume note", 1)
            raise refusal(host, sentence.replace("Take it out of the workspace", "Save the note again without it", 1))
    from_github_members = set(completion.files) if completion else set()
    if completion and not here:
        from_github_members.add("workspace/product/project.json")
    for member in sorted(files):
        if member not in files:
            continue
        if project_archive.kind_of(member) == "mock":
            in_picture = scanner.in_bytes(files[member])
            if in_picture:
                raise refusal(host, _picture_sentence(member, *in_picture))
            continue
        found = scanner.first(files[member].decode("utf-8"))
        if found:
            sentence = _found_sentence(member, *found)
            if member in from_github_members and member != "workspace/product/project.json":
                # The principles or needs from the project's issue: left out and named, as a slice or epic read from GitHub is.
                key = "principles" if member.endswith("principles.json") else "needs"
                what, _ = described(member)
                del files[member]
                counts[key] = 0
                from_github = [ident for ident in from_github if ident != key]
                not_included.append({"id": key, "what": key, "issue": project_issue,
                                     "reason": f"{what} on GitHub (the project's issue, #{project_issue}) {_plural(_found_words(found[1], found[2], 0))}, so "
                                               "they are not in the archive. Change that line in Product Studio on any computer that has the project, "
                                               "this one included, and publish them again; then export again."})
                continue
            if member in from_github_members:  # the project's record from its issue: the archive cannot be without it
                sentence = (f"The project's record on GitHub (the project's issue, #{project_issue}) {_found_words(found[1], found[2], 0)}, and the "
                            "archive must not, so nothing was exported. Change it in Product Studio on any computer that has the project, this one "
                            "included, and save it to GitHub again by marking a slice ready; then export again.")
            raise refusal(host, sentence)

    report = {"from_here": from_here, "from_github": from_github, "not_included": not_included, "left_out": left_out,
              "chosen": list(completion.chosen) if completion else [],
              "github": {"checked": github["checked"], "problem": github["problem"] if github["connected"] else None, "read_at": github["read_at"]},
              "connected": github["connected"], "maybe_missing": maybe_missing}
    return files, facts, warnings, counts, report


def _in_words(host: Any, counts: Dict[str, int], report: Dict[str, Any]) -> List[str]:
    """Every sentence a person reads about this export, in order."""
    said: List[str] = []
    holds = (f"The archive holds the project, {counts['epics']} epic{'s' if counts['epics'] != 1 else ''} and {counts['slices']} "
             f"slice{'s' if counts['slices'] != 1 else ''}")
    github_ids = [ident for ident in report["from_github"]]
    if github_ids:
        named = ", ".join("the project" if ident == "project" else "the product principles" if ident == "principles"
                          else "the technical needs" if ident == "needs" else ident for ident in github_ids)
        said.append(f"{holds}. Read from GitHub: {named}." + (" Everything else is from this workspace." if report["from_here"] else ""))
    else:
        said.append(f"{holds}, all from this workspace.")
    said += [row["note"] for row in report["chosen"]]
    said += [row["reason"] for row in report["not_included"]]
    if not report["github"]["checked"] and report["connected"]:
        said.append(f"MACH could not read GitHub just now, so it did not check what GitHub holds: {report['github']['problem']} The archive holds what "
                    "is in this workspace; slices, epics or ideas saved on GitHub from another computer may be missing. Export again when GitHub can "
                    "be reached to include them.")
    if github_ids:
        said.append(FROM_GITHUB_NOTE)
    return said


def _out_folder(host: Any, studio: Any, out: Optional[Path]) -> Path:
    if out is None:
        folder = studio.home / EXPORT_FOLDER
        if folder.is_symlink():
            raise refusal(host, f"{folder} is a symbolic link. Choose a real folder.")
        return folder
    folder = Path(os.path.abspath(str(Path(out).expanduser())))
    if folder.is_symlink():
        raise refusal(host, f"{folder} is a symbolic link. Choose a real folder.")
    if not folder.is_dir():
        raise refusal(host, f"{folder} is not a folder on this computer.")
    return folder


def _reserve(host: Any, folder: Path, stem: str) -> Path:
    """The archive's name, held: mach-project-<id>-<time>.zip, or with -2, -3 ... after the time when an archive of that name is
    already there (two exports in the same second never replace each other). The empty file made here is replaced whole."""
    folder.mkdir(parents=True, exist_ok=True)
    for number in range(1, 1000):
        target = folder / (f"{stem}.zip" if number == 1 else f"{stem}-{number}.zip")
        try:
            os.close(os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644))
        except FileExistsError:
            continue
        return target
    raise refusal(host, f"{folder} already holds a thousand archives of this project made in the same second. Choose another folder.")


def _mach_version(host: Any, studio: Any) -> Optional[str]:
    """MACH's version as faults.mach_version reads it; None when it cannot be read (said, not guessed)."""
    try:
        host.intent_modules()
        import faults  # noqa: E402
        version = faults.mach_version(str(studio.project)).get("version")
    except Exception:  # noqa: BLE001  an unreadable install record: the version is not known
        return None
    return version if isinstance(version, str) and 0 < len(version) <= 64 else None


def export(host: Any, studio: Any, out: Optional[Path], only_mine: bool) -> Dict[str, Any]:
    """`project export`: the archive written to `out` (or .factory/studio/export/), and the result of section 3."""
    if host.policies_helper().unattended():
        raise refusal(host, "Exporting a project is a product manager's act; a supervised execution does not do it.")
    folder = _out_folder(host, studio, out)
    if _unfinished_import(studio):
        raise refusal(host, host.say("Bringing in another project stopped part way here. Finish it first (run the import again with the same file), "
                                     "or set it aside, then export.",
                                     "Bringing in another project stopped part way here. Finish it first (bring the same file in again), "
                                     "or set it aside, then export."))
    files, facts, warnings, counts, report = _collect(host, studio, only_mine)
    project = json.loads(files["workspace/product/project.json"].decode("utf-8"))
    exported_at = host.now(None)
    meta = {"mach_version": _mach_version(host, studio), "exported_at": exported_at, "project_id": project["project_id"], "counts": counts}
    target = _reserve(host, folder, f"mach-project-{project['project_id']}-{exported_at.replace('-', '').replace(':', '')}")
    try:
        project_archive.write(target, files, meta)
    except BaseException as exc:
        if target.is_file() and not target.is_symlink() and target.stat().st_size == 0:
            target.unlink()  # the name held for this archive, never written: let it go again
        if isinstance(exc, project_archive.ArchiveError):
            raise refusal(host, str(exc))
        if isinstance(exc, OSError):
            raise refusal(host, f"The archive could not be written to {folder}: {exc.strerror or exc}.")
        raise
    data = target.read_bytes()
    said = _in_words(host, counts, report)
    note = NOTE
    if report["from_github"]:
        note = f"{NOTE} {FROM_GITHUB_NOTE}"
    if not report["github"]["checked"] and report["connected"]:
        note = f"{note} MACH could not read GitHub just now, so slices, epics or ideas saved there from another computer may be missing."
    return {"exported": True, "file": str(target), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "counts": counts,
            "from_here": {"count": len(report["from_here"]), "ids": report["from_here"]},
            "from_github": {"count": len(report["from_github"]), "ids": report["from_github"]},
            "github": report["github"], "not_included": report["not_included"], "chosen": report["chosen"],
            "left_out": report["left_out"], "warnings": warnings, "stays_behind": list(STAYS_BEHIND), "factory_authorized": False,
            "note": note, "in_words": said + warnings}
