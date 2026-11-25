#!/usr/bin/env python3
"""M21 C: `project export`, the whole Product Studio project in one archive that names no repository.

Reads the draft workspace (.factory/studio/draft/) and Studio's own records beside it, never GitHub, and Git only for
the shared remote's configured address (`git config --get remote.origin.url`, local). Strips every field that names
a repository, an account or an issue (STRIP), keeps what the source knew that is not a workspace file in facts.json
(the order within each epic, each slice's state as last read, Jira keys, request numbers, resume notes), then reads
every text it is about to write for the repository, a login this workspace has recorded, an absolute path on this
computer or text shaped like a secret, and refuses on any, naming the file and line. It never redacts.

Writes one file, the archive, with project_archive.write (atomically, through a temporary file beside it), in the
folder given or in .factory/studio/export/. Nothing else changes: no draft, no record, no session.

Design: docs/mach-next/M21_EXPORT_IMPORT.md, sections 1, 2.1, 2.4, 3 and 7.1. Reaches Product Studio only through the
`host` module (studio.py) and the `studio` object handed in, as prd.py and shape.py do. Standard library only.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import collab
import design
import handoff
import mocks
import prd
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


def _recorded(host: Any, studio: Any) -> Tuple[List[str], List[str]]:
    """The repositories and the GitHub logins this workspace has recorded: the remote's address, Studio's ledgers
    (issues.json, ideas.json, requests.json) and the drafts' ideas before stripping. Sorted, each once."""
    rules = host.ticket_rules()
    repositories, logins = set(), set()
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

    def __init__(self, host: Any, studio: Any):
        repositories, logins = _recorded(host, studio)
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


def _github_only(studio: Any, ledger: Dict[str, Any], local: Dict[str, Dict[str, Any]], epic_ids: Sequence[str]) -> List[Tuple[str, Optional[int]]]:
    """The slices of this project's epics that GitHub held at the last refresh and this workspace does not: (ID, issue)."""
    found = sorted({slice_id for epic_id in epic_ids for slice_id in handoff.epic_members(ledger, local, epic_id) if slice_id not in local},
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


def collect(host: Any, studio: Any, only_mine: bool) -> Tuple[Dict[str, bytes], Dict[str, Any], List[str]]:
    """Every member of the archive (facts.json among them; the manifest is project_archive.write's), the facts, and the
    warnings. Raises host.StudioError with the sentences of section 7.1. Reads only."""
    files, facts, warnings, _, _ = _collect(host, studio, only_mine)
    return files, facts, warnings


def _collect(host: Any, studio: Any, only_mine: bool) -> Tuple[Dict[str, bytes], Dict[str, Any], List[str], Dict[str, int], List[str]]:
    """collect's work, with the manifest's counts and the slices left out (--only-mine) as well."""
    rules = host.ticket_rules()
    if not studio.path("project").is_file() and not studio.path("project").is_symlink():
        raise refusal(host, "There is no project here yet, so there is nothing to export.")
    _no_links(host, studio)
    report = studio.structural()
    if not report["valid"]:
        raise refusal(host, "The project's files are not consistent, so they were not exported: " + "; ".join(report["errors"][:5])
                      + host.say(". Run status to see what needs fixing.", ". The project home shows what needs fixing."))

    files: Dict[str, bytes] = {}
    warnings: List[str] = []

    def add_json(member: str, kind: str, record: Dict[str, Any]) -> Dict[str, Any]:
        stripped = STRIP[kind](record)
        files[member] = host.canonical(stripped).encode("utf-8")
        return stripped

    def add_text(member: str, path: Path) -> None:
        data = _read(host, path, member)
        _text(host, data, member)
        files[member] = data

    draft = studio.draft
    project = _record(host, _read(host, studio.path("project"), "workspace/product/project.json"), "workspace/product/project.json")
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
    for slice_id, data in local.items():
        try:
            spec = studio.spec_of(slice_id)
        except host.StudioError as exc:
            raise refusal(host, str(exc))
        if spec is not None:
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
    for name, key, kind in (("principles.json", "principles", "principles"), ("needs.json", "needs", "needs")):
        path = draft / "product" / name
        if path.is_file():
            member = f"workspace/product/{name}"
            record = add_json(member, kind, _record(host, _read(host, path, member), member))
            counts[key] = len(record.get(key) or [])

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

    # What the source knew that is not a workspace file (section 2.1).
    hand = studio.handoff()
    ledger = hand.load()
    left_out = _github_only(studio, ledger, local, sorted(epics))
    if left_out and not only_mine:
        first = next((issue for _, issue in left_out if issue), None)
        many = len(left_out) != 1
        raise refusal(host, f"{len(left_out)} slice{'s' if many else ''} of this project {'are' if many else 'is'} on GitHub but not in your workspace: "
                            + ", ".join(_named(*item) for item in left_out) + ". "
                            + host.say(f"Open {'each' if many else 'it'} here first (slice take {first}), or export without {'them' if many else 'it'} "
                                       "(project export --only-mine).",
                                       f"Open {'each' if many else 'it'} here first, or export without {'them' if many else 'it'}."))
    if left_out:
        warnings.append(f"Left out, as you asked: {len(left_out)} slice{'s' if len(left_out) != 1 else ''} of this project on GitHub but not in your "
                        f"workspace ({', '.join(_named(*item) for item in left_out)}).")

    session = studio.session()
    editable = getattr(host, "EDITABLE_SLICE", ("draft", "interviewing", "ready_for_approval"))
    slice_facts: Dict[str, Dict[str, Any]] = {}
    for slice_id, data in local.items():
        view = handoff.slice_view(ledger, slice_id, data, rules)
        origin = data.get("origin") if isinstance(data.get("origin"), dict) else {}
        note = (session.get("notes") or {}).get(slice_id)
        note = note.get("note") if isinstance(note, dict) and isinstance(note.get("note"), str) else None
        slice_facts[slice_id] = {"was": view["progress"], "revision": view["revision"] if type(view["revision"]) is int else None,
                                 "jira": (data.get("tracking") or {}).get("jira") if isinstance(data.get("tracking"), dict) else None,
                                 "request": origin.get("number") if type(origin.get("number")) is int else None, "note": note}
        if _changed_since_ready(rules, studio, ledger["slices"].get(slice_id) or {}, data, slice_id, editable):
            warnings.append(f"{slice_id} changed since it was marked ready; the archive holds your draft.")
        if view["newer_elsewhere"]:
            warnings.append(f"Someone else saved a newer version of {slice_id} on GitHub; the archive holds the version in this workspace.")
    seen = ledger.get("seen") or {}
    facts = {
        "schema_version": FACTS_VERSION,
        "last_read_github_at": seen.get("refreshed_at") if isinstance(seen.get("refreshed_at"), str) else None,
        "order": {epic_id: [slice_id for slice_id in handoff.effective_order(ledger, local, epic_id, hand.rank(ledger, epic_id)) if slice_id in local]
                  for epic_id in sorted(epics)},
        "slices": slice_facts,
        "epics": {epic_id: {"jira": (data.get("tracking") or {}).get("jira") if isinstance(data.get("tracking"), dict) else None}
                  for epic_id, data in sorted(epics.items())},
        "ideas": idea_facts,
        "lookups_removed": lookups_removed,
    }
    files[project_archive.FACTS] = project_archive.canonical(facts)

    # Nothing in any text may name the repository, an account, a folder here, or a secret (section 2.4). Resume notes are
    # read on their own first, so the sentence names the slice rather than the archive's facts.
    scanner = _Scanner(host, studio)
    for slice_id, row in sorted(slice_facts.items()):
        found = scanner.first(row["note"]) if row["note"] else None
        if found:
            line, kind, value = found
            sentence = _found_sentence(project_archive.FACTS, line, kind, value).replace("The archive's facts", f"{slice_id}'s resume note", 1)
            raise refusal(host, sentence.replace("Take it out of the workspace", "Save the note again without it", 1))
    for member in sorted(files):
        if project_archive.kind_of(member) == "mock":
            in_picture = scanner.in_bytes(files[member])
            if in_picture:
                raise refusal(host, _picture_sentence(member, *in_picture))
            continue
        found = scanner.first(files[member].decode("utf-8"))
        if found:
            raise refusal(host, _found_sentence(member, *found))
    return files, facts, warnings, counts, [slice_id for slice_id, _ in left_out]


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
    files, facts, warnings, counts, left_out = _collect(host, studio, only_mine)
    project = json.loads(files["workspace/product/project.json"].decode("utf-8"))
    exported_at = host.now(None)
    target = folder / f"mach-project-{project['project_id']}-{exported_at.replace('-', '').replace(':', '')}.zip"
    meta = {"mach_version": _mach_version(host, studio), "exported_at": exported_at, "project_id": project["project_id"], "counts": counts}
    try:
        project_archive.write(target, files, meta)
    except project_archive.ArchiveError as exc:
        raise refusal(host, str(exc))
    except OSError as exc:
        raise refusal(host, f"The archive could not be written to {folder}: {exc.strerror or exc}.")
    data = target.read_bytes()
    return {"exported": True, "file": str(target), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "counts": counts,
            "left_out": left_out, "warnings": warnings, "stays_behind": list(STAYS_BEHIND), "factory_authorized": False, "note": NOTE}
