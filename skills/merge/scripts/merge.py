#!/usr/bin/env python3
"""MACH merge station: land exactly what was approved, or refuse.

    merge.py plan <ticket>     say what 'run' would do and whether it is allowed; changes nothing
    merge.py run <ticket>      revalidate and merge, locally or through a pull request
    merge.py status <ticket>

An approval covers one commit. Before anything lands, this script checks that the cell's branch
is still that commit; if someone has added to it, the approval is void and the ticket goes back
to verification. If the main branch has moved on since the approval, the branch is brought up
to date and the test suite is rerun on the result, the way a merge queue does, so two tickets
that were each approved alone cannot break main together.

Settings, in .factory/config.json under "merge":
    mode    "auto"   the line merges approved tickets itself
            "manual" (default) a person merges; this script still works when a person runs it
    method  "local"  (default) merge into the main checkout with a merge commit; never pushed
            "pr"     push the branch and open a pull request, then merge it there
With an origin remote, origin/<into> is fetched first (M20 A2; see "the shared main" below).
    into    the branch tickets land on (default: the remote's default branch, else main or master)
    auto    which risk tiers the line may merge on its own in auto mode,
            default {"low": true, "medium": true, "high": true}. A High ticket only reaches
            'approved' after a person signed off in review, unless the review settings say otherwise.
    pr.inline_findings
            with the pull request method, post the approving round's findings on the pull request
            once, as one review of type comment (default true; only an explicit false turns it off)

An approval that rests on a person's security exception (review.py except), including a reject vote it cleared, is
bound to the commit like any approval, and once an exception's expiry has passed nothing is merged: the ticket waits for a person. The pull
request body lists each exception with who accepted it and why.

The change record (M13, change_record.py): as its last act before landing, the station writes <records.dir>/<ticket>.md
(default docs/changes/) on the ticket's branch and commits it alone, so it lands in the same merge commit or pull request
as the change. The approval stays bound to the reviewed commit: the station accepts its own record commit only when it
adds or changes exactly that one file on top of the approved (or revalidated) commit; any other commit voids the
approval. Settings under "records": enabled (default true; false writes nothing and the pull request says nothing of
it) and dir. The pull request body links to the record.

A pull request for a slice that came as a GitHub issue says "Refs #<n>" (never a closing keyword:
the Factory closes the slice's issue once it sees the merge on the integration branch). Posting findings never blocks or delays the merge.

Standard library only. It never force-pushes, never rewrites history, and never deletes a branch.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

TICKET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")
BYPRODUCT_RE = re.compile(
    r"(^|/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|htmlcov|\.hypothesis|node_modules|\.gradle|\.next|\.turbo|coverage)(/|$)"
    r"|\.py[co]$|(^|/)\.coverage(\..*)?$|(^|/)\.DS_Store$|\.egg-info(/|$)|\.tsbuildinfo$"
)
TIERS = ("High", "Medium", "Low")
# tickets.jira.browse_url (M13 E): an https address with no user name, password, query or fragment, ending in "/".
BROWSE_URL_RE = re.compile(r"^https://[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~-]+)*/$")
BROWSE_URL_LIMIT = 200


class MergeError(Exception):
    """A gate refused. Printed without a traceback; exit code 1. `code` names the gate's reason for the lifecycle log."""

    def __init__(self, message: str = "", code: str = "refused") -> None:
        super().__init__(message)
        self.code = code

# M6.1 station telemetry. The shared helper lives with the intent station. It is observational only: if it
# cannot be loaded, nothing is recorded and this station behaves exactly as before.
try:
    _SKILL = Path(__file__).resolve().parent.parent
    sys.path.append(str(_SKILL.parent / ("mach-intent" if _SKILL.name.startswith("mach-") else "intent") / "scripts"))
    import lifecycle  # noqa: E402
except Exception:  # noqa: BLE001
    lifecycle = None

# A person may take any ticket over (claim.py, with the intent station): a worker whose holder a take-over displaced is refused at its
# next call to this station. Every command takes --holder for that; without one, nothing is checked. If the helper cannot be
# loaded, nothing is checked and this station behaves exactly as before.
try:
    import claim as _claim  # noqa: E402
except Exception:  # noqa: BLE001
    _claim = None


def split_holder(parser: Any, argv: Optional[Sequence[str]]) -> Tuple[List[str], Optional[str]]:
    items = list(sys.argv[1:] if argv is None else argv)
    return _claim.station_argv(parser, items) if _claim is not None else (items, None)


READS = ('plan', 'status')  # commands that change nothing: a holderless call of one is never refused


def taken_over(project: Optional[Path], ticket_id: Any, holder: Optional[str], command: Optional[str] = None) -> Optional[str]:
    """The refusal for a displaced worker, or for a holderless call that changes something while a take-over stands; else None."""
    return _claim.station_stop(project, ticket_id, holder, command, READS) if _claim is not None else None

# M12's secret shapes (the intent station's scan.py), used to check the change record before it is committed.
try:
    import scan  # noqa: E402
except Exception:  # noqa: BLE001
    scan = None

# The environment of the project's commands (the intent station's command_env.py), shared with the audit, build and verify stations.
try:
    import command_env  # noqa: E402
except Exception:  # noqa: BLE001
    command_env = None

# M13: the change record, written on the ticket's branch as the station's last act before landing.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import change_record  # noqa: E402


def telemetry(*args: Any, **kwargs: Any) -> None:
    """Report what this station has just recorded to the cell's lifecycle log. Never raises."""
    if lifecycle is not None:
        lifecycle.record(*args, **kwargs)



def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, errors="replace")


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


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


class Cell:
    def __init__(self, project: Path, ticket_id: str) -> None:
        if not TICKET_ID_RE.match(ticket_id):
            raise MergeError(f"'{ticket_id}' is not a usable ticket ID.")
        self.project = project
        self.ticket_id = ticket_id
        self.root = project / ".factory" / "worktrees" / ticket_id
        self.info = load_json(self.root / "cell.json")
        if not isinstance(self.info, dict):
            raise MergeError(f"No cell for {ticket_id}.")
        if self.info.get("isolation") != "worktree" or not self.info.get("branch"):
            raise MergeError("This cell has no branch of its own, so there is nothing to merge: its work was done in the project folder.")
        self.work = self.root / "repo"
        self.branch = str(self.info["branch"])
        self.decision = load_json(self.root / "review" / "decision.json", {}) or {}
        self.build = load_json(self.root / "build-report.json", {}) or {}
        self.summary = load_json(self.root / "evidence" / "summary.json", {}) or {}
        config = load_json(project / ".factory" / "config.json", {})
        merge = config.get("merge") if isinstance(config, dict) and isinstance(config.get("merge"), dict) else {}
        self.mode = merge.get("mode") if merge.get("mode") in ("auto", "manual") else "manual"
        self.method = merge.get("method") if merge.get("method") in ("local", "pr") else "local"
        auto = merge.get("auto") if isinstance(merge.get("auto"), dict) else {}
        self.auto = {tier: auto.get(tier.lower(), True) is not False for tier in TIERS}
        pr = merge.get("pr") if isinstance(merge.get("pr"), dict) else {}
        self.inline_findings = pr.get("inline_findings") is not False
        self.revalidate_overlap = merge.get("revalidate_overlap") is not False
        self.records = change_record.settings(config)
        self.jira, self.jira_url, self.jira_problem = jira_settings(self.info, config)

    def head(self) -> str:
        return git(self.work, "rev-parse", "HEAD").stdout.strip()

    def save_info(self) -> None:
        self.info["updated_at"] = now()
        write_json(self.root / "cell.json", self.info)


def jira_settings(info: Dict[str, Any], config: Any) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """(key, browse_url, problem) for M13 part E. The key is the slice's, from cell.json, used only when it passes the ticket
    station's check of Jira's form; the browse_url only when it is a plain https address. Nothing here calls Jira."""
    product = info.get("product") if isinstance(info.get("product"), dict) else {}
    rules = issue_rules()
    key = product.get("jira") if rules is not None and rules.is_jira_key(product.get("jira")) else None
    tickets = config.get("tickets") if isinstance(config, dict) and isinstance(config.get("tickets"), dict) else {}
    jira = tickets.get("jira") if isinstance(tickets.get("jira"), dict) else {}
    url = jira.get("browse_url")
    if url is None:
        return key, None, None
    if not isinstance(url, str) or len(url) > BROWSE_URL_LIMIT or not BROWSE_URL_RE.fullmatch(url):
        return key, None, ("tickets.jira.browse_url in .factory/config.json must be an https address with no user name, password, query or fragment, "
                           f"ending in /, such as https://example.atlassian.net/browse/ (at most {BROWSE_URL_LIMIT} characters). Fix it or remove it.")
    return key, url, None


def jira_text(cell: "Cell") -> Optional[str]:
    """The key as Markdown: a link through the browse_url when one is set, else plain text. None without a key."""
    if not cell.jira:
        return None
    return f"[{cell.jira}]({cell.jira_url}{cell.jira})" if cell.jira_url else cell.jira


def default_branch(project: Path) -> str:
    """The branch tickets land on: merge.into if set, the remote's default, else main or master if they exist."""
    config = load_json(project / ".factory" / "config.json", {})
    named = (config.get("merge") or {}).get("into") if isinstance(config, dict) and isinstance(config.get("merge"), dict) else None
    if isinstance(named, str) and named.strip():
        return named.strip()
    remote = git(project, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").stdout.strip()
    if remote:
        return remote.split("/", 1)[-1]
    for name in ("main", "master"):
        if git(project, "show-ref", "--verify", "-q", f"refs/heads/{name}").returncode == 0:
            return name
    return git(project, "branch", "--show-current").stdout.strip() or "main"


# ---- the shared main (M20 A2) ----
#
# When the repository has an `origin` remote, `run` fetches origin's <into> first (a fetch changes no checkout, as
# `--fetch` and the supervisor's auto_sync never do); if origin cannot be reached, nothing is merged. Then:
#   method pr:    every check before landing is made against origin/<into>, the main the pull request merges into.
#   method local: the merge goes into this checkout, so checks are made against the local <into>, but only once it
#                 provably contains origin/<into>; if the shared main has commits this checkout lacks, nothing is merged
#                 and the engineer is told to pull. The local merge is never pushed; the result says it must be.
# `plan` reads origin as last fetched and fetches nothing. With no remote, the local checkout's HEAD is the main.

REMOTE_TIMEOUT = 120
MAX_MAIN_MOVES = 2  # times one run re-validates because the shared main moved again before the merge; then it stops


def remotes(project: Path) -> List[str]:
    return [name for name in git(project, "remote").stdout.split() if name]


def has_origin(project: Path) -> bool:
    return "origin" in remotes(project)


def git_remote(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    """git talking to the remote: bounded in time and never waiting for a password prompt."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    try:
        return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, errors="replace", timeout=REMOTE_TIMEOUT,
                              env=env, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(["git", *args], 124, "", f"no answer within {REMOTE_TIMEOUT} seconds")


def fetch_shared(project: Path, main: str) -> str:
    """Fetch origin's <main> into origin/<main> and return its commit. Refuses, plainly, when origin cannot be reached
    or has no such branch: the merge is then not attempted."""
    done = git_remote(project, "fetch", "--quiet", "--no-tags", "origin", f"+refs/heads/{main}:refs/remotes/origin/{main}")
    if done.returncode != 0:
        why = ((done.stderr or "").strip() or (done.stdout or "").strip() or "git fetch failed").splitlines()[-1]
        if "couldn't find remote ref" in why.lower():
            raise MergeError(f"The shared repository (origin) has no branch {main}, so there is nothing to test this ticket against. Nothing was merged. "
                             f"Push {main} to origin, or set merge.into in .factory/config.json.", code="no-shared-main")
        raise MergeError(f"MACH could not reach the shared repository (origin) to see what is on {main} now ({why}). Nothing was merged: "
                         f"MACH merges only after testing against origin/{main} as it is at that moment. Try again when origin can be reached.",
                         code="remote-unreachable")
    tip = shared_tip(project, main)
    if not tip:
        raise MergeError(f"After fetching, origin/{main} could not be read. Nothing was merged.", code="remote-unreachable")
    return tip


def shared_tip(project: Path, main: str) -> str:
    """origin/<main> as last fetched, or '' when this checkout has never seen it."""
    done = git(project, "rev-parse", "--verify", "-q", f"refs/remotes/origin/{main}^{{commit}}")
    return done.stdout.strip() if done.returncode == 0 else ""


def main_tip(project: Path, main: str, method: str) -> Tuple[str, str]:
    """(commit, name) of the main every check is made against: origin/<main> for a pull request when there is an
    origin, else the main checkout's HEAD (the local method merges there)."""
    if method == "pr" and has_origin(project):
        return shared_tip(project, main), f"origin/{main}"
    return git(project, "rev-parse", "HEAD").stdout.strip(), main


def shared_ahead(project: Path, main: str) -> Optional[int]:
    """How many commits origin/<main> (as last fetched) holds that the main checkout's HEAD does not; None if unknown."""
    tip = shared_tip(project, main)
    if not tip:
        return None
    done = git(project, "rev-list", "--count", f"HEAD..{tip}")
    return int(done.stdout.strip()) if done.returncode == 0 and done.stdout.strip().isdigit() else None


def remote_tip(project: Path, main: str) -> Optional[str]:
    """<main>'s commit on origin right now, read without fetching; None when origin cannot be asked."""
    done = git_remote(project, "ls-remote", "origin", f"refs/heads/{main}")
    if done.returncode != 0:
        return None
    for line in done.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == f"refs/heads/{main}" and re.fullmatch(r"[0-9a-f]{40,64}", parts[0]):
            return parts[0]
    return None


# ---- the shared main takes a slice once (M20 A1's backstop) ----
#
# Several engineers' Factories keep out of each other's way by a claim on the slice's issue, but a duplicate can still
# be built (a take-over, a stale claim). The run skill's intake owns the rule (`intake.already_landed`, used by
# `run.py next`); this station asks the same question after its fetch, and before it merges, pushes or opens anything.

_INTAKE: List[Any] = []


def intake_rules() -> Any:
    """The run skill's intake module, loaded from the sibling skill folder whichever way MACH is installed, never copied."""
    if not _INTAKE:
        found = None
        skills = Path(__file__).resolve().parent.parent.parent
        for name in ("mach-run", "run"):
            path = skills / name / "scripts" / "intake.py"
            if path.is_file():
                spec = importlib.util.spec_from_file_location("mach_intake_for_merge", path)
                found = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(found)
                break
        _INTAKE.append(found)
    if _INTAKE[0] is None:
        raise MergeError("The run skill's intake.py could not be found next to this skill, so MACH cannot tell whether this slice already shipped. "
                         "Nothing was merged. Reinstall MACH.", code="landed-unknown")
    return _INTAKE[0]


def landed_elsewhere(cell: Cell, main: str) -> Optional[str]:
    """For a cell intake opened from a slice: the plain stop, for the Factory merging on its own, when this slice revision's approved
    spec is already on the main branch and what landed is not this cell's own work; else None (landed_copy holds the rule)."""
    landed = landed_copy(cell, main)
    return landed_words(cell, landed) if landed else None


def landed_words(cell: Cell, landed: Dict[str, Any]) -> str:
    """The stop for the Factory's own merge of a copy whose slice already landed (landed_copy's answer)."""
    slice_id = str((cell.info.get("product") or {}).get("slice_id"))
    url = cell.info.get("pull_request")
    message = intake_rules().landed_message(slice_id, landed) + " Nothing was pushed or merged."
    if cell.method == "pr" and url:
        message += f" This copy's pull request ({url}) is left open."
    return message + (f" A person's merge (merge {cell.ticket_id} --by-person) brings main into this copy and lands whatever it still changes "
                      "on top, or closes it out when everything in it is already on main.")


def landed_copy(cell: Cell, main: str) -> Optional[Dict[str, Any]]:
    """For a cell intake opened from a slice: where this slice revision's approved spec already is on the main branch (local <main>,
    and origin/<main> as just fetched) when what landed is not this cell's own work ({"ref", "path", "commit"}); else None. Its own
    work: a merge recorded in the cell, its branch's commit already on that branch, or (method pr) its own pull request merged.
    An engineer's own ticket (no `product`) is not checked."""
    product = cell.info.get("product") if isinstance(cell.info.get("product"), dict) else {}
    slice_id, spec_sha256 = product.get("slice_id"), product.get("spec_sha256")
    if not slice_id or not spec_sha256 or isinstance(cell.info.get("merged"), dict):
        return None
    refs = [ref for ref in (f"refs/heads/{main}", f"refs/remotes/origin/{main}") if git(cell.project, "rev-parse", "--verify", "-q", ref).returncode == 0]
    rules = intake_rules()
    landed = rules.already_landed(cell.project, str(slice_id), spec_sha256, refs)
    if not landed:
        return None
    if git(cell.project, "merge-base", "--is-ancestor", cell.head(), landed["ref"]).returncode == 0:
        return None  # this branch is what was merged
    url = cell.info.get("pull_request")
    if cell.method == "pr" and url:
        view = load_text(gh(cell, "pr", "view", url, "--json", "state", timeout=GH_TIMEOUT).stdout)
        if view.get("state") == "MERGED":
            return None  # its own pull request, merged (squashed, perhaps, by a person)
    return landed


_CELL_MODULE: List[Any] = []


def cell_rules() -> Any:
    """The intent station's cell.py (its 0.20.0 rule for one slice on both sides of the hand-off), loaded by path, never copied."""
    if not _CELL_MODULE:
        found = None
        skills = Path(__file__).resolve().parent.parent.parent
        for name in ("mach-intent", "intent"):
            path = skills / name / "scripts" / "cell.py"
            if path.is_file():
                if str(path.parent) not in sys.path:
                    sys.path.insert(0, str(path.parent))
                spec = importlib.util.spec_from_file_location("mach_cell_for_merge", path)
                found = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(found)
                break
        _CELL_MODULE.append(found)
    if _CELL_MODULE[0] is None:
        raise MergeError("The intent skill's cell.py could not be found next to this skill. Nothing was merged. Reinstall MACH.", code="slice-id-unknown")
    return _CELL_MODULE[0]


SPEC_FILE_RE = re.compile(r"^(SLICE-[0-9]{3,})-[^/]*\.md$")


def slice_id_taken(cell: Cell, main: str) -> Optional[str]:
    """M20 A3: the plain refusal when a slice spec this branch adds has a slice ID that is already on the main branch under another
    file name, and that file is another slice (slice_id_clash holds the rule); None when nothing is taken."""
    clash = slice_id_clash(cell, main)
    if not clash:
        return None
    slice_id, path, ours = clash
    return (f"{slice_id} is already on {main} as {path}, which is another slice than this ticket's {ours}: two engineers took "
            f"one slice number. Nothing was pushed or merged. A person's merge (merge {cell.ticket_id} --by-person) gives this ticket's slice "
            "the next free number on its branch and sends the change to be verified and reviewed again.")


def slice_id_clash(cell: Cell, main: str) -> Optional[Tuple[str, str, str]]:
    """M20 A3: (the slice ID, the file on main, this branch's file) when a slice spec this branch adds has a slice ID that is already
    on the main branch (local <main>, or origin/<main> as just fetched) under another file name, and that file is another slice: two
    engineers took one number, and Git would see no conflict. The same slice under another name (a slice Product Studio handed this
    cell, by cell.py's `handed_over`) is not a clash. None when nothing is taken."""
    refs = [ref for ref in (f"refs/heads/{main}", f"refs/remotes/origin/{main}") if git(cell.project, "rev-parse", "--verify", "-q", ref).returncode == 0]
    if not refs:
        return None
    added = git(cell.work, "diff", "--name-only", "--diff-filter=A", f"{refs[-1]}...HEAD", "--", "specs/slices/").stdout.split()
    ours = {match.group(1): path for path in added if path.count("/") == 2 for match in [SPEC_FILE_RE.match(path.rsplit("/", 1)[-1])] if match}
    if not ours:
        return None
    same = set(cell_rules().handed_over(cell.info))
    for ref in refs:
        for path in git(cell.project, "ls-tree", "--name-only", ref, "--", "specs/slices/").stdout.split():
            match = SPEC_FILE_RE.match(path.rsplit("/", 1)[-1])
            if not match or match.group(1) not in ours or path == ours[match.group(1)] or match.group(1) in same:
                continue
            slice_id = match.group(1)
            return slice_id, path, ours[slice_id]
    return None


def refuse_duplicates(cell: Cell, main: str, by_person: bool = False) -> Optional[Dict[str, Any]]:
    """M20: the shared main takes a slice revision once, and a slice number once. The Factory merging on its own stops at either.
    A person's merge (`by_person`) is carried out: a second copy of a slice that already landed is returned as the meeting point
    (land_on_top lands what it still changes), and a slice number another slice holds is given the next free number on the branch
    (renumber), which sends the change to be verified and reviewed again."""
    landed = landed_copy(cell, main)
    if landed and not by_person:
        raise MergeError(landed_words(cell, landed), code="landed-elsewhere")
    clash = slice_id_clash(cell, main)
    if clash and not by_person:
        raise MergeError(slice_id_taken(cell, main) or "Its slice number is another slice's on main.", code="slice-id-taken")
    if clash:
        renumber(cell, main, *clash)
    return landed


def renumber(cell: Cell, main: str, slice_id: str, theirs: str, ours: str) -> None:
    """A person's merge of a ticket whose slice number another slice already holds on main: the spec on this branch is renamed to the
    next free number, with every mention of the old number in it, and committed on the branch. The cell records the new spec, and the
    change goes back to be verified and reviewed (no judging round is used). Raises MergeError code "renumbered" with what was done,
    so nothing is merged in this run; or code "slice-id-taken" with the exact reason when renumbering is impossible."""
    if isinstance(cell.info.get("product"), dict) and (cell.info["product"].get("slice_id") == slice_id):
        # The number is the one Product Studio gave this slice: intake finds the slice on main by it (the spec's file name and its text),
        # so renaming it here would leave the slice never seen as shipped and its issue never closed. The smallest safe thing: this copy
        # lands beside the other spec, under its own file name, and the result and the change record say that two specs share the number.
        cell.info["number_shared"] = {"slice_id": slice_id, "theirs": theirs, "ours": ours, "at": now()}
        cell.save_info()
        return
    rules = cell_rules()
    try:
        used, reserved = rules.slice_ids(cell.project)
        shared, _ = rules.shared_slice_ids(cell.project)
    except Exception as exc:  # noqa: BLE001
        raise MergeError(f"{slice_id} is another slice's number on {main}, and MACH could not read which slice numbers are free ({exc}). "
                         "Nothing was pushed or merged. Run the merge again; if it says the same, cell.py next-id shows what is wrong.",
                         code="slice-id-taken")
    taken_here = set()
    for ref in ("HEAD", f"refs/heads/{main}", f"refs/remotes/origin/{main}"):
        for name in git(cell.work, "ls-tree", "--name-only", ref, "--", "specs/slices/").stdout.split():
            match = SPEC_FILE_RE.match(name.rsplit("/", 1)[-1])
            if match:
                taken_here.add(int(match.group(1).split("-")[1]))
    highest = max([0, *used, *reserved, *shared, *taken_here])
    new_id = f"SLICE-{highest + 1:03d}"
    source = cell.work / ours
    target_rel = ours.rsplit("/", 1)[0] + "/" + new_id + ours.rsplit("/", 1)[-1][len(slice_id):]
    try:
        text = source.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise MergeError(f"{slice_id} is another slice's number on {main}, and this branch's spec {ours} could not be read ({exc}), so MACH "
                         "could not renumber it. Nothing was pushed or merged.", code="slice-id-taken")
    changed = re.sub(rf"\b{re.escape(slice_id)}\b", new_id, text)
    if git(cell.work, "mv", "--", ours, target_rel).returncode != 0:
        raise MergeError(f"{slice_id} is another slice's number on {main}, and git could not rename {ours} to {target_rel} on this branch, so "
                         "MACH could not renumber it. Nothing was pushed or merged.", code="slice-id-taken")
    (cell.work / target_rel).write_text(changed, encoding="utf-8")
    git(cell.work, "add", "--", target_rel)
    done = git(cell.work, "commit", "-q", "-m", f"Renumber {slice_id} to {new_id}: {slice_id} is another slice on {main} [{cell.ticket_id}]")
    if done.returncode != 0:
        git(cell.work, "reset", "-q", "--hard", "HEAD")
        raise MergeError(f"{slice_id} is another slice's number on {main}, and git could not commit the renumbered spec: "
                         + ((done.stderr.strip() or done.stdout.strip()).splitlines() or ["commit failed"])[-1] + ". Nothing was pushed or merged.",
                         code="slice-id-taken")
    if cell.info.get("spec_path") == ours:
        cell.info["spec_path"] = target_rel
        cell.info["spec_sha256"] = hashlib.sha256(changed.encode("utf-8")).hexdigest()
        copy = cell.root / "spec.md"
        if copy.is_file():
            copy.write_text(changed, encoding="utf-8")
    if cell.info.get("slice_id") == slice_id:
        cell.info["slice_id"] = new_id
    spec_json = cell.root / "spec.json"
    if spec_json.is_file():
        data = load_json(spec_json)
        if isinstance(data, dict) and data.get("slice_id") == slice_id:
            data["slice_id"] = new_id
            write_json(spec_json, data)
    cell.info["renumbered"] = {"from": slice_id, "to": new_id, "because": theirs, "commit": cell.head(), "at": now()}
    void_approval(cell, f"Its slice number {slice_id} is another slice's on {main}; the spec was renumbered to {new_id}.")
    raise MergeError(f"{slice_id} is already on {main} as {theirs}, another slice, so MACH gave this ticket's slice the next free number: it is "
                     f"{new_id} now, renamed on its branch as {target_rel} (commit {cell.head()[:12]}). Nothing was merged in this run: the change goes "
                     "back to be verified and reviewed on the renamed spec (no judging round is used), then it is merged.", code="renumbered")


def land_on_top(cell: Cell, main: str, main_head: str, landed: Dict[str, Any], by_person: bool) -> Optional[int]:
    """The meeting point, for a person's merge of a second copy of a slice that already landed: when, with main brought in, nothing in
    this copy differs from main, the cell is closed out as merged (as the commit that landed first) and cleanup removes it, no
    abandoning; returns the exit code then. Otherwise, the first time, main is merged into the copy and its approval is voided once, so
    it is verified and reviewed against main as it now is (code "recheck"; a conflict is recorded as the cell's main conflict, so the
    routing sheet sends it to a person to resolve); after that review, None: it lands as a change on top through the normal path, the
    change record saying that another copy landed first."""
    merged_tree = git(cell.work, "merge-tree", "--write-tree", main_head, "HEAD")
    main_tree = git(cell.work, "rev-parse", f"{main_head}^{{tree}}").stdout.strip()
    same = merged_tree.returncode == 0 and merged_tree.stdout.split() and merged_tree.stdout.split()[0] == main_tree
    slice_id = str((cell.info.get("product") or {}).get("slice_id"))
    commit = landed.get("commit") or main_head
    earlier = cell.info.get("landed_first") if isinstance(cell.info.get("landed_first"), dict) else {}
    cell.info["landed_first"] = {"slice_id": slice_id, "commit": landed.get("commit"), "ref": landed.get("ref"),
                                 **({"rechecked": earlier["rechecked"]} if earlier.get("rechecked") else {})}
    cell.save_info()
    if not same:
        if cell.info["landed_first"].get("rechecked") == commit:
            return None  # verified and reviewed against main with the other copy in it: it lands on top
        if git(cell.work, "merge-base", "--is-ancestor", main_head, "HEAD").returncode == 0:
            # main is in this copy already (a person resolved the meeting's conflict), and the approval is for this commit, after it.
            cell.info["landed_first"]["rechecked"] = commit
            cell.save_info()
            return None
        local_main = git(cell.project, "rev-parse", "HEAD").stdout.strip()
        before = cell.head()
        merged = git(cell.work, "merge", "--no-edit", "-m", f"Merge {main} into {cell.branch}: another copy of {slice_id} landed first [{cell.ticket_id}]",
                     main_head)
        if merged.returncode != 0:
            conflicts = [name for name in git(cell.work, "diff", "--name-only", "--diff-filter=U").stdout.splitlines() if name.strip()]
            git(cell.work, "merge", "--abort")
            void_approval(cell, f"Another copy of {slice_id} landed first, and bringing {main} into this copy conflicts.")
            cell.info["main_conflict"] = {"during": "meeting", "main": main, "main_commit": local_main, "branch_commit": before, "behind": None,
                                          "files": conflicts[:50], "folder": str(cell.work), "findings": None, "at": now()}
            cell.save_info()
            raise MergeError(f"Another copy of {slice_id} landed on {main} first (as {str(commit)[:12]}), and bringing {main} into this copy conflicts in "
                             f"{', '.join(conflicts[:10]) or 'some files'}. Nothing was merged. A person merges {main} into {cell.branch} in {cell.work} "
                             "and resolves it; then this copy is verified and reviewed against main and lands what it still changes.", code="main-conflict")
        cell.info["landed_first"]["rechecked"] = commit
        void_approval(cell, f"Another copy of {slice_id} landed first: this copy now holds {main} and is verified and reviewed against it once.")
        raise MergeError(f"Another copy of {slice_id} landed on {main} first (as {str(commit)[:12]}), and this copy still changes something. {main} is "
                         f"merged into it now ({cell.head()[:12]}); it goes back to be verified and reviewed against {main} as it is (no judging round "
                         "is used), and then a person's merge lands it on top, its change record saying another copy landed first.", code="recheck")
    cell.info.update({"stage": "merged", "merged": {"commit": None, "at": now(), "method": cell.method, "landed_commit": cell.head(),
                                                    "already_on_main": commit, **({"by_person": True} if by_person else {})}})
    cell.save_info()
    telemetry(cell.root, "station.exited", "merge", lambda: {"outcome": "already-on-main", "stage": "merged"})
    reason = f"Everything in this copy is already on {main}: another copy of {slice_id} landed first, as {str(commit)[:12]}."
    url = cell.info.get("pull_request")
    if cell.method == "pr" and url:  # this copy's own pull request holds nothing main does not: closed, saying why
        note = (f"Everything in this pull request is already on {main}: another copy of {inert(slice_id, 40)} landed first, as {str(commit)[:12]}. "
                "Closed by MACH.")
        closed = gh(cell, "pr", "close", str(url), "--comment", note, timeout=GH_TIMEOUT)
        reason += (f" This copy's pull request ({url}) is closed, with a comment naming that commit." if closed.returncode == 0 else
                   f" This copy's pull request ({url}) could not be closed now and is still open: it holds nothing {main} does not, so close it "
                   "on GitHub with a note naming that commit, or run this merge again and MACH tries once more.")
    print(json.dumps({"ticket_id": cell.ticket_id, "status": "ALREADY_ON_MAIN", "branch": cell.branch, "into": main, "landed_first": cell.info["landed_first"],
                      "reason": reason,
                      "next": f"Clean up with the cleanup skill for {cell.ticket_id}: it closes the cell out as merged, as {str(commit)[:12]}."},
                     indent=2, ensure_ascii=False))
    return 0


def dirty(folder: Path) -> List[str]:
    """Uncommitted project work, ignoring the factory's own files and what test runs leave behind."""
    names = [line[3:].strip().strip('"') for line in git(folder, "status", "--porcelain", "--untracked-files=all").stdout.splitlines() if line.strip()]
    return [name for name in names if not name.startswith((".factory/", ".claude/")) and not BYPRODUCT_RE.search(name)]


def run_suite(cell: Cell) -> Dict[str, Any]:
    command = (cell.build.get("tests") or {}).get("command")
    if not isinstance(command, str) or not command.strip():
        raise MergeError("The build report records no test command, so the merged result cannot be checked.")
    argv = shlex.split(command)
    if command_env is None:
        raise MergeError("The intent station's command_env.py is not installed beside this skill, so the merged result cannot be checked.")
    # One rule for every station's project commands (command_env.py): no Python byte code left in the checkout, a package
    # cache that cannot be written pointed into the project's .factory/cache/, commands.env, and a leading VAR=value.
    env, argv = command_env.environment(cell.project, cell.work, argv)
    if not argv or (shutil.which(argv[0]) is None and not (cell.work / argv[0]).is_file()):
        raise MergeError(f"'{argv[0] if argv else command}' is not installed or not on PATH, so the merged result cannot be checked.")
    try:
        done = subprocess.run(argv, cwd=str(cell.work), capture_output=True, text=True, errors="replace", timeout=600, stdin=subprocess.DEVNULL, env=env)
        code, out = done.returncode, done.stdout + ("\n" + done.stderr if done.stderr else "")
    except subprocess.TimeoutExpired:
        code, out = 124, "Still running after 600 seconds; stopped."
    tail = out.strip()[-1500:]
    hint = command_env.network_hint(out) if code not in (0, 124) else None
    if hint:  # added to the failure output the findings carry; the suite still fails and the ticket goes back as before
        tail = tail[-(1498 - len(hint)):] + "\n\n" + hint
    return {"command": command, "passed": code == 0, "exit_code": code, "output_tail": tail, **({"hint": hint} if hint else {})}


def survey(cell: Cell, by_person: bool) -> Dict[str, Any]:
    """Everything 'run' would do and every reason it may not. Shared by plan and run so they cannot disagree."""
    refusals: List[str] = []
    stage = cell.info.get("stage")
    head = cell.head()
    risk = cell.info.get("risk") if cell.info.get("risk") in TIERS else "High"
    main = default_branch(cell.project)
    main_head, compared_with = main_tip(cell.project, main, cell.method)
    plan: Dict[str, Any] = {
        "ticket_id": cell.ticket_id, "stage": stage, "branch": cell.branch, "into": main, "risk": risk, "mode": cell.mode, "method": cell.method,
        "approved_commit": cell.decision.get("head"), "branch_commit": head, "approval_valid": cell.decision.get("head") == head,
        "compared_with": compared_with, "main_commit": main_head or None,
        "behind_main": bool(main_head) and git(cell.work, "merge-base", "--is-ancestor", main_head, "HEAD").returncode != 0,
        "pull_request": cell.info.get("pull_request"),
    }
    if stage == "merged":
        refusals.append("This ticket is already merged.")
    elif stage not in ("approved", "pr-open"):
        refusals.append(f"The cell's stage is '{stage}'. Only an approved ticket can be merged.")
    if cell.decision.get("outcome") != "APPROVED":
        refusals.append("There is no approval on record for this ticket (review/decision.json).")
    elif cell.decision.get("human_approval_required") and not cell.decision.get("human_approval"):
        refusals.append("The review requires a person's approval and none is recorded.")
    lapsed = expired_exceptions(cell.decision)
    if lapsed and stage in ("approved", "pr-open") and cell.decision.get("outcome") == "APPROVED":
        plan["exception_expired"] = [f"{item.get('round')}/{item.get('seat')}/{item.get('index')}" for item in lapsed]
        refusals.append(f"The security exception for {', '.join(plan['exception_expired'])} expired on {lapsed[0].get('expires')}, so the security veto stands "
                        "again and nothing is merged. A person decides: record a new exception (except) or abandon the ticket.")
    revalidated = cell.info.get("revalidated") or {}
    # The station's own record commit (M13) keeps the approval: it adds exactly the record file on top of the approved
    # or revalidated commit, checked in Git. Any other commit on top voids it.
    plan["record_commit"] = record_holds(cell, head)
    if stage in ("approved", "pr-open") and not plan["approval_valid"] and revalidated.get("head") != head and not plan["record_commit"]:
        plan["approval_void"] = True
        refusals.append(f"The approval was for commit {str(cell.decision.get('head'))[:10]}, but the branch is now at {head[:10]}: something was added after review. "
                        "The approval no longer holds; the ticket must be verified and reviewed again.")
    if not by_person and cell.mode != "auto":
        refusals.append("Merging is set to manual in .factory/config.json (merge.mode), so a person merges this ticket. A person may run this with --by-person.")
    elif not by_person and not cell.auto[risk]:
        refusals.append(f"{risk}-risk tickets are merged by a person in this project (merge.auto.{risk.lower()} is false). A person may run this with --by-person.")
    if git(cell.project, "branch", "--show-current").stdout.strip() != main:
        refusals.append(f"The main checkout is not on {main}. Switch it to {main} before merging.")
    stray = dirty(cell.project)
    if stray and cell.method == "local":
        refusals.append(f"The main checkout has uncommitted changes ({', '.join(stray[:5])}). Commit or remove them before merging into it.")
    if dirty(cell.work):
        refusals.append("The cell has uncommitted changes. Everything in an approved cell is committed; look at what changed.")
    if cell.records["problem"]:
        refusals.append(cell.records["problem"])
    if cell.jira_problem:
        refusals.append(cell.jira_problem)
    plan["jira"] = cell.jira
    if cell.method == "local" and has_origin(cell.project):
        # M20 A2: a local merge is tested against the local main, so that main must already hold the shared main.
        ahead = shared_ahead(cell.project, main)
        plan["shared_main_ahead"] = ahead
        if ahead:
            refusals.append(f"The shared main (origin/{main}) has {ahead} commit{'s' if ahead != 1 else ''} this checkout's {main} does not have yet. "
                            f"Pull {main}, then merge again. Nothing was merged.")
    if cell.method == "pr":
        if not git(cell.project, "remote", "get-url", "origin").stdout.strip():
            refusals.append("merge.method is 'pr' but the repository has no 'origin' remote.")
        if shutil.which("gh") is None:
            refusals.append("merge.method is 'pr' but the gh tool is not installed.")
    record = cell.info.get("change_record") if isinstance(cell.info.get("change_record"), dict) else None
    plan["would"] = ([f"fetch {main} from origin and make every check below against origin/{main} (this plan reads it as last fetched)"]
                     if compared_with != main else
                     [f"fetch {main} from origin and merge only if this checkout's {main} already holds everything on origin/{main}"]
                     if has_origin(cell.project) else []) + ([] if not plan["behind_main"] else [f"bring {cell.branch} up to date with {main} and rerun the test suite"]
                     + ([f"check what landed on {main} since approval: a file this ticket also changed, or a shipped rule this ticket's spec "
                         "relies on that a landed slice changed, sends it back to be verified and reviewed again"] if cell.revalidate_overlap else [])) + (
        [] if not cell.records["enabled"] or record_on_branch(cell, record)
        else [f"add the change record (in {cell.records['dir']}/) to {cell.branch} as a commit of its own"]) + (
        [f"merge {cell.branch} into {main} with a merge commit"] if cell.method == "local"
        else [f"push {cell.branch}", f"open a pull request into {main}", "merge the pull request at the approved commit" if cell.mode == "auto" or by_person else "leave the pull request for a person to merge"])
    plan["allowed"] = not refusals
    plan["refusals"] = refusals
    return plan


def record_holds(cell: Cell, head: str) -> bool:
    """Whether the branch's tip is this station's change record commit on top of the approved or revalidated commit."""
    return change_record.holds(git, cell.work, cell.info.get("change_record"), head,
                               [cell.decision.get("head"), (cell.info.get("revalidated") or {}).get("head")])


def record_on_branch(cell: Cell, record: Optional[Dict[str, Any]]) -> bool:
    """Whether a record commit this station made is already in the branch's history (a pull request still open)."""
    commit = record.get("commit") if isinstance(record, dict) else None
    return isinstance(commit, str) and bool(re.fullmatch(r"[0-9a-f]{40,64}", commit)) and \
        git(cell.work, "merge-base", "--is-ancestor", commit, "HEAD").returncode == 0


def approved_spec_sha(cell: Cell, base: str) -> Optional[str]:
    """The SHA-256 of the ticket's spec as it is on the branch at `base`, taken the way intake takes it (the text without
    MACH's header line), so release qualification can bind the change record to the approved spec. None when it cannot be read."""
    path = cell.info.get("spec_path")
    try:
        rules = intake_rules()
    except MergeError:
        return None
    if not isinstance(path, str) or not path:
        return None
    done = subprocess.run(["git", "show", f"{base}:{path}"], cwd=str(cell.work), capture_output=True)
    if done.returncode != 0:
        return None
    return rules.text_sha(rules.without_header(done.stdout.decode("utf-8-sig", errors="replace"))[0])


def write_record(cell: Cell, revalidated: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The station's last act before landing (M13): write the change record on the ticket's branch and commit it alone.

    Written once per landing, covering every round. When a commit of it is already in the branch's history (a pull
    request still open from an earlier run), it is not written again. Refuses, committing nothing, when the text cannot
    be redacted or checked for secrets, or would still carry one."""
    earlier = cell.info.get("change_record") if isinstance(cell.info.get("change_record"), dict) else None
    if record_on_branch(cell, earlier):
        return {**earlier, "written": False, "reason": "Already on the branch from an earlier run of this station."}
    base = cell.head()

    def taken(path: str) -> bool:
        return git(cell.work, "cat-file", "-e", f"{base}:{path}").returncode == 0

    known = cell.info.get("revalidated") if isinstance(cell.info.get("revalidated"), dict) else {}
    reval = revalidated or (known if known.get("head") == base else {})
    try:
        path = change_record.path_for(cell.records["dir"], cell.ticket_id, taken, earlier.get("path") if earlier else None)
        text = change_record.render(cell.root, cell.info, cell.ticket_id, {
            "approved": cell.decision.get("head"), "revalidated": reval.get("head"), "onto": reval.get("onto"), "base": base}, issue_rules(), cell.jira_url,
            spec_sha256=approved_spec_sha(cell, base))
        text = change_record.mask(text, path, scan)
    except change_record.RecordError as exc:
        raise MergeError(str(exc), code="record-refused")
    target = cell.work / path
    inside = cell.work.resolve()
    climb = [target, *[folder for folder in target.parents if folder != cell.work and cell.work in folder.parents]]
    if any(part.is_symlink() for part in climb) or inside not in target.resolve().parents:
        raise MergeError(f"{path} does not lie plainly inside the cell's checkout (a symbolic link is in the way); no change record was written.",
                         code="record-refused")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    entry: Dict[str, Any] = {"version": change_record.VERSION, "path": path, "sha256": change_record.digest(text), "parent": base, "at": now()}
    if git(cell.work, "add", "--", path).returncode != 0:
        raise MergeError(f"git could not stage the change record {path}; nothing was merged.", code="record-failed")
    if git(cell.work, "diff", "--cached", "--quiet", "--", path).returncode == 0:
        entry["commit"] = None  # the same text is already on the branch: nothing to add
    else:
        done = git(cell.work, "commit", "-q", "-m", f"Change record for {cell.ticket_id}", "--", path)
        if done.returncode != 0:
            raise MergeError("git could not commit the change record: " + ((done.stderr.strip() or done.stdout.strip()).splitlines() or ["commit failed"])[-1],
                             code="record-failed")
        entry["commit"] = cell.head()
    cell.info["change_record"] = entry
    cell.save_info()
    if entry["commit"] and not change_record.holds(git, cell.work, entry, entry["commit"], [base]):
        raise MergeError(f"The change record commit {entry['commit'][:12]} changed more than {path}, so the approval no longer covers the branch. "
                         "Nothing was merged; the next run of this station voids the approval.", code="record-failed")
    return {**entry, "written": True}


def expired_exceptions(decision: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The security exceptions on the approving round whose expiry has passed (review.py's rule: one holds through its
    expiry day, UTC; one with no expiry holds for the commit reviewed). Only the latest for each finding counts."""
    latest: Dict[Tuple[Any, Any, Any], Dict[str, Any]] = {}
    for item in decision.get("exceptions") or []:
        if isinstance(item, dict):
            latest[(item.get("round"), item.get("seat"), item.get("index"))] = item
    today = datetime.now(timezone.utc).date()
    lapsed = []
    for item in latest.values():
        if not item.get("expires"):
            continue
        try:
            ended = datetime.strptime(str(item["expires"]), "%Y-%m-%d").date() < today
        except ValueError:
            ended = True  # an expiry that cannot be read is not trusted to be in the future
        if ended:
            lapsed.append(item)
    return lapsed


def void_approval(cell: Cell, reason: str = "The branch changed after it was approved.", **extra: Any) -> None:
    """Something was added after review, or something that landed on main touches the same ground (M13): send the
    ticket back to be verified and reviewed again. No judging round is used: a re-verification that passes goes to a
    repeat review round (round-N.1); only a failed one, like any failed verification, starts a revision."""
    cell.info.update({"stage": "built", "review": "VOID", "verification": None})
    cell.build["head"] = cell.head()
    write_json(cell.root / "build-report.json", cell.build)
    stale = cell.root / "review" / "decision.json"
    if stale.is_file():
        void = {"reason": reason, "voided_at": now(), "approved_commit": cell.decision.get("head"),
                "branch_commit": cell.build["head"], "by": "merge station", **extra}
        cell.decision.update({"outcome": "VOID", "void_reason": void["reason"], "void": void})
        write_json(stale, cell.decision)
        # The round's own record keeps who approved, when and which commit, marked voided; the re-review opens a new folder.
        findings = Path(str(cell.decision.get("findings") or ""))
        folder = findings.parent if findings.name == "findings.md" and (cell.root / "review") in findings.parents else cell.root / "review" / f"round-{cell.decision.get('round')}"
        kept = load_json(folder / "decision.json") if (folder / "decision.json").is_file() else None
        if isinstance(kept, dict) and kept.get("head") == void["approved_commit"]:
            kept.update({"void": void, "outcome_before_void": kept.get("outcome"), "outcome": "VOID"})
            write_json(folder / "decision.json", kept)
    cell.save_info()


def send_back(cell: Cell, title: str, detail: str) -> Path:
    """The up-to-date branch no longer passes: hand it to the build station as findings for a revision."""
    path = cell.root / "review" / "merge-findings.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# Merge findings for {cell.ticket_id}\n\n1. **{title}** {detail}\n", encoding="utf-8")
    head = cell.head()
    cell.build["head"] = head
    write_json(cell.root / "build-report.json", cell.build)
    write_json(cell.root / "review" / "decision.json", {**cell.decision, "outcome": "REJECTED", "head": head, "findings": str(path), "rejected_by": "merge station"})
    cell.info.update({"stage": "built", "review": "REJECTED"})
    cell.save_info()
    return path


# ---- what landed on main since approval (M13 part B, layer 4) ----

SPEC_DIR = "specs/slices/"
SLICE_FILE_RE = re.compile(r"^specs/slices/(SLICE-[0-9]{3,})-[^/]*\.md$")
SLICE_ID_RE = re.compile(r"^SLICE-[0-9]{3,}$")
OVERLAP_SHOWN = 20
LANDED_SPECS_READ = 200
_EFFECTS: List[Any] = []


def effects_parser() -> Any:
    """The intent station's one parser of `## Effects on shipped behaviour` (effects.py), loaded by path whichever way
    MACH is installed, never copied. None if it cannot be loaded."""
    if not _EFFECTS:
        found = None
        skills = Path(__file__).resolve().parent.parent.parent
        for name in ("mach-intent", "intent"):
            path = skills / name / "scripts" / "effects.py"
            if path.is_file():
                try:
                    spec = importlib.util.spec_from_file_location("mach_intent_effects", path)
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    found = module if callable(getattr(module, "parse", None)) else None
                except Exception:  # noqa: BLE001
                    found = None
                break
        _EFFECTS.append(found)
    return _EFFECTS[0]


def changed_between(cell: Cell, base: str, tip: str) -> Optional[List[str]]:
    """The files that differ between two commits (renames as a removal and an addition), or None if Git cannot say."""
    done = git(cell.work, "diff", "--name-only", "--no-renames", "-z", base, tip, "--")
    return None if done.returncode != 0 else sorted({name for name in done.stdout.split("\0") if name})


def own_effects(cell: Cell, approved: str, parser: Any) -> Tuple[Set[str], Optional[str]]:
    """The shipped rules this ticket's spec lists under Effects on shipped behaviour (any effect), read from the cell's
    spec.md (the validated copy) with the shared parser; from the spec on the approved commit if the copy is missing.
    (cell.py's spec.json is not used: the spec's text is the authority and one parser reads it.)"""
    path = cell.root / "spec.md"
    text = path.read_text(encoding="utf-8", errors="replace") if path.is_file() and not path.is_symlink() else None
    spec_path = cell.info.get("spec_path")
    if text is None and isinstance(spec_path, str) and plain_path(spec_path):
        shown = git(cell.work, "show", f"{approved}:{spec_path}")
        text = shown.stdout if shown.returncode == 0 else None
    if text is None:
        return set(), None
    parsed = parser.parse(text)
    rules = {row["shipped_rule"] for row in parsed.get("rows") or [] if isinstance(row, dict) and isinstance(row.get("shipped_rule"), str)}
    return rules, ("this ticket's own effects section has problems, so the rules it lists were read only where well formed"
                   if parsed.get("problems") else None)


def depends_on(cell: Cell) -> Set[str]:
    """The slices this ticket's slice depends on, as intake recorded them in cell.json (product.depends_on)."""
    product = cell.info.get("product") if isinstance(cell.info.get("product"), dict) else {}
    return {item for item in product.get("depends_on") or [] if isinstance(item, str) and SLICE_ID_RE.match(item)}


def landed_overlap(cell: Cell, before: str, main_head: str) -> Dict[str, Any]:
    """What landed on main between the commit that was approved and main's head, against this ticket's own change.

    (a) a file a landed commit changed that this ticket's own change also changed. The ticket's files are its diff from
        its merge base with main, as review's whole-ticket diff computes it; the change record folder and other slices'
        specs are left out, and so are the byproducts this station already ignores (caches, compiled files).
    (b) a landed slice spec whose Effects on shipped behaviour changes, replaces or retires a shipped rule this ticket's
        spec lists in its own effects section, or one that belongs to a slice this ticket's slice depends on.
    Returns {"files", "slices", "commits", "problems"}; any entry in files, slices or problems means the approval does
    not carry over. Reads Git and the cell only; changes nothing."""
    approved = cell.decision.get("head") if isinstance(cell.decision.get("head"), str) and re.fullmatch(r"[0-9a-f]{40,64}", cell.decision.get("head")) else before
    problems: List[str] = []
    landed_base = git(cell.work, "merge-base", before, main_head).stdout.strip()
    own_base = git(cell.work, "merge-base", approved, main_head).stdout.strip()
    commits = git(cell.work, "rev-list", "--no-merges", f"{before}..{main_head}").stdout.split() if landed_base else []
    landed = changed_between(cell, landed_base, main_head) if landed_base else None
    own = changed_between(cell, own_base, approved) if own_base else None
    if landed is None or own is None:
        return {"files": [], "slices": [], "commits": commits, "problems": ["Git could not say which files landed on the main branch or which this ticket changed."]}
    records_dir = cell.records["dir"].rstrip("/") + "/"
    own_spec = cell.info.get("spec_path") if isinstance(cell.info.get("spec_path"), str) else None

    def counts(name: str) -> bool:
        if name.startswith(records_dir) or BYPRODUCT_RE.search(name):
            return False
        return not (name.startswith(SPEC_DIR) and name != own_spec)

    files = sorted(set(name for name in own if counts(name)) & set(landed))
    slices: List[Dict[str, Any]] = []
    specs = [name for name in landed if SLICE_FILE_RE.match(name) and name != own_spec]
    if specs:
        parser = effects_parser()
        if parser is None:
            problems.append("The intent station's effects parser (effects.py) could not be loaded, so the specs that landed could not be read.")
        else:
            listed, own_problem = own_effects(cell, approved, parser)
            if own_problem:
                problems.append(own_problem.capitalize() + ".")
            needed = depends_on(cell)
            for name in specs[:LANDED_SPECS_READ]:
                shown = git(cell.work, "show", f"{main_head}:{name}")
                if shown.returncode != 0:
                    continue  # removed on main: it states no effect
                parsed = parser.parse(shown.stdout)
                landed_id = SLICE_FILE_RE.match(name).group(1)
                if parsed.get("problems"):
                    problems.append(f"{landed_id} ({name}) landed with an Effects on shipped behaviour section that cannot be read cleanly, "
                                    "so what it does to shipped rules is not known.")
                hits = []
                for row in parsed.get("rows") or []:
                    if not isinstance(row, dict) or row.get("effect") not in ("changed", "replaced", "retired"):
                        continue
                    rule, owner = row.get("shipped_rule"), row.get("slice_id")
                    why = ("this ticket's spec lists it" if rule in listed else
                           f"this ticket's slice depends on {owner}" if owner in needed else None)
                    if why:
                        hits.append({"rule": rule, "effect": row["effect"], "why": why})
                if hits:
                    slices.append({"slice_id": landed_id, "spec": name, "rules": hits})
            if len(specs) > LANDED_SPECS_READ:
                problems.append(f"{len(specs)} slice specs landed; only the first {LANDED_SPECS_READ} were read.")
    return {"files": files, "slices": slices, "commits": commits, "problems": problems}


def overlap_words(found: Dict[str, Any], main: str) -> List[str]:
    """Each reason the approval does not carry over, in plain words."""
    lines: List[str] = []
    for item in found["slices"][:OVERLAP_SHOWN]:
        rules = "; ".join(f"it {hit['effect']} {hit['rule']}, and {hit['why']}" for hit in item["rules"][:OVERLAP_SHOWN])
        lines.append(f"{item['slice_id']} landed on {main} ({item['spec']}): {rules}.")
    if found["files"]:
        shown = ", ".join(found["files"][:OVERLAP_SHOWN]) + (f" and {len(found['files']) - OVERLAP_SHOWN} more" if len(found["files"]) > OVERLAP_SHOWN else "")
        lines.append(f"Work that landed on {main} since approval changed files this ticket also changed: {shown}.")
    lines += found["problems"][:OVERLAP_SHOWN]
    return lines


def check_landed(cell: Cell, main: str, before: str, main_head: str) -> None:
    """After a clean merge of main and a passing suite: if what landed in between touches this ticket's ground, the
    approval does not carry over. The merge commit stays on the branch, nothing lands, and the ticket goes back to be
    verified and reviewed on the merged result, as when the branch is not the approved commit. merge.revalidate_overlap
    false switches the check off. One lifecycle record of the check; it never changes the result."""
    if not cell.revalidate_overlap:
        return
    found = landed_overlap(cell, before, main_head)
    reasons = overlap_words(found, main)

    def record() -> None:
        telemetry(cell.root, "gate.evaluated", "merge", lambda: {
            "gate": "merge.landed_overlap", "outcome": "refuse" if reasons else "pass", "reason_code": "landed-overlap" if reasons else None,
            "overridden_by_reason": False, "landed_commits": len(found["commits"]), "files": len(found["files"]),
            "slices": [item["slice_id"] for item in found["slices"]], "problems": len(found["problems"])})

    if not reasons:
        record()
        return
    path = cell.root / "review" / "merge-recheck.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# Why {cell.ticket_id} is verified and reviewed again\n\n"
                    f"The approval was for commit {str(cell.decision.get('head'))[:12]}. Since then {len(found['commits'])} commit"
                    f"{'s' if len(found['commits']) != 1 else ''} landed on {main}. Merging {main} in was clean and the test suite passes, "
                    "but what landed touches the same ground as this ticket, so the approval does not carry over:\n\n"
                    + "".join(f"- {line}\n" for line in reasons)
                    + f"\nThe branch now holds {main} merged in ({cell.head()[:12]}). Verify and review that result. "
                    "This is not a rejection: it uses no judging round unless the new verification fails.\n", encoding="utf-8")
    void_approval(cell, "Work that landed on the main branch after approval touches the same ground as this ticket.",
                  findings_path=str(path), landed_files=found["files"][:OVERLAP_SHOWN],
                  landed_slices=[item["slice_id"] for item in found["slices"]][:OVERLAP_SHOWN], main_commit=main_head)
    record()
    raise MergeError(f"{main} moved on since approval, and what landed touches the same ground as this ticket:\n- " + "\n- ".join(reasons)
                     + f"\nNothing was merged. The branch keeps {main} merged in; the ticket goes back to be verified and reviewed on that result "
                     f"(no judging round is used unless verification fails). Details: {path}.", code="landed-overlap")


def revalidate(cell: Cell, main: str, main_head: str) -> Optional[Dict[str, Any]]:
    """Merge-queue step: put the approved work on top of today's main and prove the suite still passes. main_head is
    the main every check is made against: origin/<main> as just fetched when there is an origin, else the checkout's HEAD."""
    if git(cell.work, "merge-base", "--is-ancestor", main_head, "HEAD").returncode == 0:
        return None
    before = cell.head()
    merged = git(cell.work, "merge", "--no-edit", "-m", f"Merge {main} into {cell.branch} before landing [{cell.ticket_id}]", main_head)
    if merged.returncode != 0:
        conflicts = git(cell.work, "diff", "--name-only", "--diff-filter=U").stdout.split()
        git(cell.work, "merge", "--abort")
        raise MergeError(f"{main} has moved on since this ticket was approved, and bringing the branch up to date conflicts in {', '.join(conflicts) or 'some files'}. "
                         f"A person must merge {main} into {cell.branch} in {cell.work} and resolve it; the ticket then needs verifying and reviewing again.",
                         code="revalidation-conflict")
    suite = run_suite(cell)
    if not suite["passed"]:
        path = send_back(cell, f"The test suite fails once {main} is merged in.",
                         f"The ticket passed on its own, but with the current {main} merged into it `{suite['command']}` fails:\n\n```\n{suite['output_tail']}\n```")
        raise MergeError(f"With the current {main} merged in, the test suite fails, so nothing was merged. The ticket goes back to the build station: findings are in {path}."
                         + (f"\n{suite['hint']}" if suite.get("hint") else ""), code="sent-back")
    check_landed(cell, main, before, main_head)
    cell.info["revalidated"] = {"head": cell.head(), "onto": main_head, "at": now(), "tests": suite["command"]}
    cell.save_info()
    return cell.info["revalidated"]


# ---- text from the cell on the platform ----

# An issue or pull request reference GitHub would link (#12, owner/name#12, GH-12, .../issues/12). A zero-width
# space after the marker leaves the text readable but links nothing, so no text taken from the cell can close,
# or cross-reference, an issue.
REFERENCE_RE = re.compile(r"(#|\bGH-|/issues/|/pull/|/discussions/)(?=[0-9])", re.IGNORECASE)
MENTION_RE = re.compile(r"@(?=[A-Za-z0-9_])")
BREAK = "\u200b"  # a zero-width space, written as an escape so it can be seen


def inert(value: Any, limit: int = 200) -> str:
    """One line of text from the cell made safe for a pull request: printable, bounded, linking no issue."""
    text = "" if value is None else str(value)
    text = " ".join("".join(ch if ch.isprintable() else " " for ch in text[:limit * 4]).split())
    if len(text) > limit:
        text = text[:limit - 1].rstrip() + "…"
    return MENTION_RE.sub("@" + BREAK, REFERENCE_RE.sub(lambda m: m.group(1) + BREAK, text))


_ISSUE_RULES: List[Any] = []


def issue_rules() -> Any:
    """The ticket station's shared pure rules (redaction, repository and issue number checks), loaded from the
    sibling skill folder whichever way MACH is installed, never copied. None if it cannot be loaded."""
    if not _ISSUE_RULES:
        found = None
        skills = Path(__file__).resolve().parent.parent.parent
        for name in ("mach-ticket", "ticket"):
            path = skills / name / "scripts" / "issue_rules.py"
            if path.is_file():
                try:
                    spec = importlib.util.spec_from_file_location("mach_ticket_issue_rules", path)
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    found = module
                except Exception:  # noqa: BLE001
                    found = None
                break
        _ISSUE_RULES.append(found)
    return _ISSUE_RULES[0]


REMOTE_RE = re.compile(r"^(?:[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/\s]+@)?[^/\s]+/|[^@/\s:]+@[^:/\s]+:)([^/\s]+/[^/\s]+?)(?:\.git)?/?$")
PR_URL_RE = re.compile(r"^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)/pull/([0-9]{1,9})$")


def origin_repository(project: Path) -> Optional[str]:
    """owner/name of the origin remote as configured (before any URL rewriting), or None."""
    rules = issue_rules()
    url = git(project, "config", "--get", "remote.origin.url").stdout.strip()
    found = REMOTE_RE.match(url)
    if rules is None or not found or not rules.is_repository(found.group(1)):
        return None
    return found.group(1)


def refs_line(cell: Cell) -> Optional[str]:
    """'Refs #<n>' for a slice whose issue is in this repository, 'Refs owner/name#<n>' otherwise; None if the cell
    names no slice issue or what it names is not a valid repository and issue number. Never a closing keyword: the
    Factory closes a slice's issue itself once the merge is seen on the integration branch."""
    rules = issue_rules()
    product = cell.info.get("product")
    issue = product.get("issue") if isinstance(product, dict) else None
    if rules is None or not isinstance(issue, dict):
        return None
    repository, number = issue.get("repository"), issue.get("number")
    if not rules.is_repository(repository) or not rules.is_issue_number(number):
        return None
    here = origin_repository(cell.project)
    return f"Refs #{number}" if here is not None and here.lower() == repository.lower() else f"Refs {repository}#{number}"


def pr_title(cell: Cell) -> str:
    """The pull request's title; a slice's Jira key (M13), checked, comes first, which Jira's GitHub integration reads."""
    small = " (small change)" if change_record.small_change_words(cell.info) == "a small change" else ""  # M18: beside the ticket
    title = inert(f"{cell.ticket_id}{small}: {cell.info.get('title') or cell.info.get('slice_id') or 'change'}", 240)
    return f"{cell.jira} {title}" if cell.jira else title


def pr_body(cell: Cell) -> str:
    checks = cell.summary.get("checks") or {}
    checks = checks if isinstance(checks, dict) else {}
    votes = cell.decision.get("votes") or {}
    votes = votes if isinstance(votes, dict) else {}
    human = cell.decision.get("human_approval") or {}
    evidence = [entry.get("file") for entry in cell.summary.get("evidence_files") or [] if isinstance(entry, dict)]
    passed = sum(1 for c in checks.values() if isinstance(c, dict) and c.get("result") == "pass")
    small = change_record.small_change_words(cell.info)  # M18: a small change, said beside the ticket
    lines = [
        f"**Ticket:** {inert(cell.ticket_id)}" + (f", {inert(small, 300)}" if small else "") + "  ",
        f"**Slice:** {inert(cell.info.get('slice_id'))} (`{inert(cell.info.get('spec_path'))}`)  ",
        f"**Risk tier:** {inert(cell.info.get('risk'))}" + (f"  \n**Jira:** {jira_text(cell)}" if cell.jira else ""),
        "",
        "## Verification",
        f"{inert(cell.summary.get('status', 'unknown'))}: {passed} of {len(checks)} checks passed, "
        "run by an independent verifier against the built slice.",
        "",
        "## Review",
        f"Round {inert(cell.decision.get('round'))}: " + ", ".join(f"{inert(seat, 40)} {inert(vote, 20)}" for seat, vote in votes.items())
        + f". Blockers: {inert(cell.decision.get('blockers', 0))}.",
        f"Approved by a person: {inert(human.get('by') if isinstance(human, dict) else human)}." if human else "No person's approval was required for this ticket.",
        "",
        *exceptions_section(cell),
        *scan_section(cell),
        "## Build",
        f"{inert(cell.build.get('diff', ''), 400)}. Tests seen failing before their code was written: {inert(cell.build.get('tests_seen_failing_first', 0))}. "
        f"Gate overrides recorded: {len(cell.build.get('deviations') or [])}.",
        "",
        f"Approved commit: `{inert(cell.decision.get('head'), 64)}`. Evidence ({len(evidence)} files) and the reviewers' findings are kept with the ticket's cell until cleanup, which keeps them in an archive when the project does (cleanup.archive).",
        "",
        *record_section(cell),
        "Opened by the MACH merge station.",
    ]
    refs = refs_line(cell)
    if refs:
        lines += ["", refs]
    return "\n".join(lines)


def record_section(cell: Cell) -> List[str]:
    """Where the change record is (M13): a link pinned to the commit that added it when the repository is on GitHub, else its
    path. Nothing when records are off or none was written."""
    record = cell.info.get("change_record") if isinstance(cell.info.get("change_record"), dict) else None
    path = record.get("path") if record else None
    if not cell.records["enabled"] or not isinstance(path, str) or not change_record.PATH_RE.match(path):
        return []
    commit = record.get("commit") if isinstance(record.get("commit"), str) and re.fullmatch(r"[0-9a-f]{40,64}", record.get("commit")) else None
    repository = origin_repository(cell.project)
    where = f"[`{path}`](https://github.com/{repository}/blob/{commit}/{path})" if repository and commit else f"`{path}`"
    return [f"Change record: {where}, added to this branch by the merge station. It lists every verification check and review round, "
            "with the SHA-256 of each evidence file.", ""]


def exceptions_section(cell: Cell) -> List[str]:
    """Each security exception the approval rests on: the finding, who accepted it, their reason (redacted, bounded,
    linking nothing) and its expiry. Nothing when the approval needed none."""
    items = [item for item in cell.decision.get("exceptions") or [] if isinstance(item, dict)]
    if not items:
        return []
    rules = issue_rules()
    lines = ["## Security exceptions",
             "The review panel's security veto was excepted by a person for the approved commit. The finding stands: it was accepted, not fixed."]
    before, after = cell.decision.get("approvals_before_exception"), cell.decision.get("approvals_after_exception")
    if isinstance(before, int) and isinstance(after, int) and after != before:
        cleared = [inert(seat, 40) for seat in cell.decision.get("rejects_cleared_by_exception") or []][:3]
        lines.append(f"Reject votes that rested only on excepted findings were counted as approvals: {before} approvals before the exception, "
                     f"{after} after" + (f" ({', '.join(cleared)} seat)." if cleared else "."))
    for item in items[:20]:
        reason = item.get("reason") if isinstance(item.get("reason"), str) else ""
        reason = rules.redact(reason) if rules is not None else reason
        impact = item.get("impact") if item.get("impact") in IMPACTS else "unstated"
        seat = inert(item.get("seat"), 40)
        lines.append(f"- {inert(item.get('round'), 10)}/{seat}/{inert(item.get('index'), 10)} ({seat} seat, {impact} impact): "
                     f"**{inert(item.get('title'), TITLE_LIMIT)}**, breaks {inert(item.get('rule'), RULE_LIMIT)}. Accepted by {inert(item.get('by'), 80)}"
                     + (f", until {inert(item.get('expires'), 10)}" if item.get("expires") else "") + f": \"{inert(reason, DETAIL_LIMIT)}\""
                     + (" (renews an expired one)" if item.get("renews") is not None else ""))
    return lines + [""]


def scan_section(cell: Cell) -> List[str]:
    """What the security scan flagged and how the security seat answered: counts, places and package names, never a
    secret's value. Nothing when the scan flagged nothing; one line when it was switched off."""
    summary = cell.decision.get("security_scan")
    if not isinstance(summary, dict):
        return []
    if summary.get("enabled") is False:
        return ["## Security scan", "The security scan was switched off for this review (security.scan.enabled is false): no secret candidate "
                "or new dependency was checked.", ""]
    secrets = [item for item in summary.get("secrets") or [] if isinstance(item, dict)]
    deps = [item for item in summary.get("dependencies") or [] if isinstance(item, dict)]
    if not secrets and not deps:
        return []
    lines = ["## Security scan"]
    for item in secrets[:20]:
        lines.append(f"- Possible secret ({inert(item.get('kind'), 40)}) at `{inert(item.get('file'), 200)}:{inert(item.get('line'), 10)}`"
                     + (", recorded by the builder as not a secret" if item.get("overridden_by_builder") else "")
                     + f": answered {inert(item.get('answer'), 20)} by the security seat.")
    for item in deps[:30]:
        lines.append(f"- {inert(item.get('ecosystem'), 20)} `{inert(item.get('name'), 120)}` {inert(item.get('version'), 60)} "
                     f"({inert(item.get('change'), 10)}{', development only' if item.get('dev') else ''}): answered {inert(item.get('answer'), 20)}.")
    if deps:
        lines.append("Dependencies were not checked against a vulnerability database: a model's knowledge ends at its training date.")
    return lines + [""]


def gh(cell: Cell, *args: str, stdin: Optional[str] = None, timeout: Optional[int] = None) -> subprocess.CompletedProcess:
    """Run gh in the main checkout. With a timeout, a hung or missing gh comes back as a failure, never an exception."""
    try:
        return subprocess.run(["gh", *args], cwd=str(cell.project), capture_output=True, text=True, errors="replace",
                              input=stdin, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(["gh", *args], 124, "", f"gh did not answer within {timeout} seconds")
    except OSError as exc:
        if timeout is None:
            raise
        return subprocess.CompletedProcess(["gh", *args], 127, "", f"gh could not be started: {exc.strerror or exc}")


# ---- the approving round's findings on the pull request ----

GH_TIMEOUT = 60
MAX_POST_ATTEMPTS = 3
MAX_POSTED_FINDINGS = 60
DETAIL_LIMIT = 600
TITLE_LIMIT = 200
RULE_LIMIT = 120
SEAT_RE = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")
IMPACTS = ("critical", "high", "medium", "low")
PATH_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._+-]{1,255}$")
HUNK_RE = re.compile(r"^@@ -[0-9]+(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@")


def plain_path(value: Any) -> Optional[str]:
    """A file path that is a plain relative path inside the repository, or None."""
    if not isinstance(value, str) or not value or len(value) > 400:
        return None
    parts = value.split("/")
    if any(part in ("", ".", "..") or not PATH_SEGMENT_RE.match(part) for part in parts) or parts[0] == ".git":
        return None
    return value


def diff_lines(cell: Cell) -> Optional[Dict[str, Set[int]]]:
    """For each file, the right-side lines inside the pull request's diff: the branch against its merge base
    with the main branch, with Git's default three lines of context. None if Git cannot say."""
    main_head = main_tip(cell.project, default_branch(cell.project), cell.method)[0]
    base = git(cell.work, "merge-base", main_head, "HEAD").stdout.strip() if main_head else ""
    if not re.fullmatch(r"[0-9a-f]{40,64}", base):
        return None
    done = git(cell.work, "-c", "core.quotePath=true", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=3", "-M",
               "--src-prefix=a/", "--dst-prefix=b/", base, "HEAD")
    if done.returncode != 0:
        return None
    lines: Dict[str, Set[int]] = {}
    current: Optional[str] = None
    old_left = new_left = 0
    for line in done.stdout.splitlines():
        if old_left > 0 or new_left > 0:
            tag = line[:1]
            if tag == "\\":
                continue
            if tag in (" ", ""):
                old_left, new_left = old_left - 1, new_left - 1
            elif tag == "-":
                old_left -= 1
            elif tag == "+":
                new_left -= 1
            continue
        if line.startswith("diff --git "):
            current = None
        elif line.startswith("+++ "):
            name = line[4:]
            current = name[2:] if name.startswith("b/") else None  # a deleted file, or a quoted name: nothing inline
        elif line.startswith("@@"):
            found = HUNK_RE.match(line)
            if not found:
                continue
            old_left = int(found.group(1)) if found.group(1) is not None else 1
            start, count = int(found.group(2)), int(found.group(3)) if found.group(3) is not None else 1
            new_left = count
            if current is not None and count:
                lines.setdefault(current, set()).update(range(start, start + count))
    return lines


def approving_findings(cell: Cell) -> Tuple[Optional[int], List[Tuple[str, Dict[str, Any]]]]:
    """(round, [(seat, finding)]) from the approving round's votes, blockers first, seats in name order."""
    number = cell.decision.get("round")
    if type(number) is not int or number < 1:
        return None, []
    folder = cell.root / "review" / f"round-{number}" / "votes"
    found: List[Tuple[str, Dict[str, Any]]] = []
    for path in sorted(folder.glob("*.json")) if folder.is_dir() else []:
        seat = path.stem
        vote = load_json(path, {})
        if not SEAT_RE.match(seat) or not isinstance(vote, dict) or not isinstance(vote.get("findings"), list):
            continue
        found += [(seat, finding) for finding in vote["findings"] if isinstance(finding, dict)]
    # Blockers first, then important notes (a note without a weight is important), then the nits the review station kept (M15).
    found.sort(key=lambda pair: 0 if pair[1].get("severity") == "blocker" else 2 if pair[1].get("weight") == "nit" else 1)
    return number, found


def nits_dropped(cell: Cell, number: Optional[int]) -> int:
    """M15: how many nits the approving round's seats listed beyond review.nit_cap; they were never kept, so never posted."""
    folder = cell.root / "review" / f"round-{number}" / "votes"
    total = 0
    for path in sorted(folder.glob("*.json")) if type(number) is int and folder.is_dir() else []:
        vote = load_json(path, {})
        if isinstance(vote, dict) and type(vote.get("nits_dropped")) is int and vote["nits_dropped"] > 0:
            total += vote["nits_dropped"]
    return total


def finding_text(rules: Any, seat: str, finding: Dict[str, Any]) -> Dict[str, Any]:
    """One finding as it may leave the machine: redacted by the ticket station's rules, bounded, mentions and
    issue references broken, control characters gone."""
    def safe(value: Any, limit: int, one_line: bool) -> str:
        text, _ = rules.bound_text(value if isinstance(value, str) else "", limit, one_line=one_line)
        return MENTION_RE.sub("@" + BREAK, REFERENCE_RE.sub(lambda m: m.group(1) + BREAK, text))

    severity = finding.get("severity") if finding.get("severity") in ("blocker", "note") else "note"
    label = f"**{seat}** · {severity}"
    if severity == "note" and finding.get("weight") in ("important", "nit"):  # M15: shown only when the reviewer gave one
        label += f" · {finding['weight']}"
    if finding.get("class") == "security":
        impact = finding.get("impact") if finding.get("impact") in IMPACTS else "unstated"
        label += f" · security, {impact} impact"
    line = finding.get("line")
    return {"label": label, "title": safe(finding.get("title"), TITLE_LIMIT, True) or "(no title)",
            "detail": safe(finding.get("detail"), DETAIL_LIMIT, False), "rule": safe(finding.get("rule"), RULE_LIMIT, True),
            "path": plain_path(finding.get("file")), "had_file": bool(finding.get("file")),
            "line": line if type(line) is int and 0 < line < 10 ** 7 else None}


def comment_text(item: Dict[str, Any]) -> str:
    parts = [f"{item['label']}: **{item['title']}**"]
    if item["detail"]:
        parts.append(item["detail"])
    if item["rule"]:
        parts.append(f"Cites: {item['rule']}")
    return "\n\n".join(parts)


def summary_text(item: Dict[str, Any]) -> str:
    if item["path"]:
        where = f"`{item['path']}" + (f":{item['line']}`" if item["line"] else "`")
    else:
        where = "file not shown" if item["had_file"] else "no file"
    detail = " ".join(item["detail"].split())
    return f"- {item['label']}, {where}: **{item['title']}**" + (f" {detail}" if detail else "") + (f" Cites: {item['rule']}." if item["rule"] else "")


def findings_review(cell: Cell, rules: Any, number: int, found: List[Tuple[str, Dict[str, Any]]], head: str) -> Dict[str, Any]:
    """The review to post: inline comments for findings on lines in the diff, the rest in the summary."""
    in_diff = diff_lines(cell) or {}
    shown, hidden = found[:MAX_POSTED_FINDINGS], len(found) - min(len(found), MAX_POSTED_FINDINGS)
    inline: List[Dict[str, Any]] = []
    listed: List[Dict[str, Any]] = []
    for seat, finding in shown:
        item = finding_text(rules, seat, finding)
        if item["path"] and item["line"] and item["line"] in in_diff.get(item["path"], set()):
            inline.append(item)
        else:
            listed.append(item)
    approved = cell.decision.get("head")
    approved = approved if isinstance(approved, str) and re.fullmatch(r"[0-9a-f]{40,64}", approved) else head
    record = cell.info.get("change_record") if isinstance(cell.info.get("change_record"), dict) else {}
    on_record = record.get("commit") == head
    updated = (record.get("parent") if on_record else head) != approved
    how = (["brought up to date with the main branch, with the tests rerun"] if updated else []) + (["with its change record added"] if on_record else [])
    moved = "" if approved == head else f" This pull request is at `{head[:12]}`: the approved commit {', and '.join(how) or 'as it was approved'}."
    intro = [f"The MACH review panel approved commit `{approved[:12]}` in round {number}.{moved} Its findings follow, as the reviewers wrote them, "
             "with likely secrets masked and mentions broken. They are information for whoever reads this pull request; the merge does not wait on them."]
    if inline:
        intro.append(f"{len(inline)} finding{'s are' if len(inline) != 1 else ' is'} attached to the lines {'they concern' if len(inline) != 1 else 'it concerns'}.")
    if listed:
        intro += ["", "Findings not on a line of this diff:", *[summary_text(item) for item in listed]]
    if hidden:
        intro += ["", f"{hidden} more finding{'s are' if hidden != 1 else ' is'} not shown here; every finding is kept with the ticket's cell."]
    dropped = nits_dropped(cell, number)
    if dropped:
        intro += ["", f"{dropped} more nit{'s' if dropped != 1 else ''} the reviewers listed {'were' if dropped != 1 else 'was'} not kept: the review station keeps a few per reviewer."]
    return {"body": "\n".join(intro), "inline": inline, "listed": listed, "hidden": hidden,
            "payload": {"commit_id": head, "event": "COMMENT", "body": "\n".join(intro),
                        "comments": [{"path": item["path"], "line": item["line"], "side": "RIGHT", "body": comment_text(item)} for item in inline]}}


def last_line(done: subprocess.CompletedProcess, fallback: str) -> str:
    text = ((done.stderr or "").strip() or (done.stdout or "").strip()).splitlines() or [fallback]
    rules = issue_rules()
    line = " ".join(text[-1].split())[:200]
    return rules.redact(line) if rules is not None else line


def post_findings(cell: Cell, url: str, head: str) -> Dict[str, Any]:
    """Post the approving round's findings on the pull request once. Never raises, never blocks the merge;
    what happened is recorded in cell.json and returned for the station's result."""
    if not cell.inline_findings:
        return {"posted": False, "reason": "merge.pr.inline_findings is false in .factory/config.json."}
    record = cell.info.get("pull_request_findings")
    record = record if isinstance(record, dict) and record.get("pull_request") == url else None
    if record and record.get("how") in ("review", "comment", "nothing to post"):
        return {"posted": False, "reason": f"Already done for this pull request ({record['how']}, {record.get('at')}).",
                **({"inline": record.get("inline"), "summary": record.get("summary")} if record["how"] != "nothing to post" else {})}
    attempts = int(record.get("attempts") or 0) if record else 0
    if attempts >= MAX_POST_ATTEMPTS:
        return {"posted": False, "reason": f"Not tried again: posting failed {attempts} times. The findings are kept with the ticket's cell."}

    def keep(how: str, **fields: Any) -> Dict[str, Any]:
        entry = {"pull_request": url, "round": number, "head": head, "at": now(), "how": how, "attempts": attempts + 1, **fields}
        cell.info["pull_request_findings"] = entry
        cell.save_info()
        return entry

    number, found = approving_findings(cell)
    if not found:
        keep("nothing to post", inline=0, summary=0)
        return {"posted": False, "reason": "The approving round recorded no findings, so there was nothing to post."}
    rules = issue_rules()
    if rules is None:
        keep("failed", reason="the ticket station's shared rules could not be loaded")
        return {"posted": False, "reason": "The ticket station's shared rules could not be loaded, so reviewer text could not be redacted; nothing was posted."}
    from_url = PR_URL_RE.match(url)
    repository = origin_repository(cell.project) or (from_url.group(1) if from_url and rules.is_repository(from_url.group(1)) else None)
    if repository is None or not from_url:
        keep("failed", reason="the pull request's repository and number could not be established")
        return {"posted": False, "reason": "The pull request's repository and number could not be established, so nothing was posted."}
    pull = int(from_url.group(2))
    review = findings_review(cell, rules, number, found, head)
    counts = {"inline": len(review["inline"]), "summary": len(review["listed"]), "not_shown": review["hidden"]}
    made = gh(cell, "api", "--method", "POST", f"repos/{repository}/pulls/{pull}/reviews", "--input", "-",
              stdin=json.dumps(review["payload"]), timeout=GH_TIMEOUT)
    if made.returncode == 0:
        keep("review", **counts)
        return {"posted": True, "how": "review", **counts}
    why = last_line(made, "gh api failed")
    plain = review["body"] + ("\n\n" + "\n".join(summary_text(item) for item in review["inline"]) if review["inline"] else "")
    said = gh(cell, "pr", "comment", str(pull), "--repo", repository, "--body-file", "-", stdin=plain, timeout=GH_TIMEOUT)
    if said.returncode == 0:
        counts = {"inline": 0, "summary": counts["inline"] + counts["summary"], "not_shown": review["hidden"]}
        keep("comment", review_failed=why, **counts)
        return {"posted": True, "how": "comment", "review_failed": why, **counts}
    reason = f"The review could not be created ({why}), nor a plain comment ({last_line(said, 'gh pr comment failed')})."
    entry = keep("failed", reason=reason)
    return {"posted": False, "reason": reason + f" Attempt {entry['attempts']} of {MAX_POST_ATTEMPTS}; the merge went ahead."}


def land_by_pr(cell: Cell, main: str, merge_now: bool, tested_on: str) -> Dict[str, Any]:
    """Push, open (once) and merge the pull request. tested_on is the origin/<main> commit the branch was re-validated
    against. Immediately before merging, origin's <main> is read again; if it moved, nothing is merged and the result
    says {"main_moved": <commit>} so the caller re-validates. GitHub's merge is bound to the head commit
    (--match-head-commit); it has no such guard for the base, so after merging the merge commit's first parent is
    compared with tested_on and any difference is reported."""
    head = cell.head()
    pushed = git(cell.work, "push", "-u", "origin", cell.branch)
    if pushed.returncode != 0:
        raise MergeError("The branch could not be pushed: " + (pushed.stderr.strip().splitlines() or ["git push failed"])[-1])
    url = cell.info.get("pull_request")
    if not url:
        made = gh(cell, "pr", "create", "--head", cell.branch, "--base", main, "--title", pr_title(cell), "--body", pr_body(cell))
        found = re.search(r"https?://\S+/pull/\d+", made.stdout + made.stderr)
        if not found:
            raise MergeError("The pull request could not be opened: " + ((made.stderr.strip() or made.stdout.strip()).splitlines() or ["gh pr create failed"])[-1])
        url = found.group(0)
        cell.info["pull_request"] = url
        cell.info["stage"] = "pr-open"
        cell.save_info()
    try:
        posted = post_findings(cell, url, head)
    except Exception as exc:  # noqa: BLE001  posting findings never stands in the merge's way
        posted = {"posted": False, "reason": f"Posting the findings failed unexpectedly ({type(exc).__name__}); the merge went ahead."}
    state = gh(cell, "pr", "view", url, "--json", "state,mergeCommit,headRefOid")
    view = load_text(state.stdout)
    merged_here = False
    if view.get("state") != "MERGED" and merge_now:
        tip = remote_tip(cell.project, main)
        if tip is None:
            return {"merged": False, "pull_request": url, "findings_posted": posted,
                    "note": f"The pull request is open, but MACH could not read origin's {main} once more just before merging, so it did not merge. Run this again."}
        if tip != tested_on:
            return {"merged": False, "pull_request": url, "findings_posted": posted, "main_moved": tip}
        done = gh(cell, "pr", "merge", url, "--merge", "--match-head-commit", head)
        if done.returncode != 0:
            tip = remote_tip(cell.project, main)
            if tip is not None and tip != tested_on:  # GitHub refused because the base moved (an up-to-date rule), or it moved meanwhile
                return {"merged": False, "pull_request": url, "findings_posted": posted, "main_moved": tip}
            return {"merged": False, "pull_request": url, "findings_posted": posted,
                    "note": "The pull request is open but could not be merged yet: " + ((done.stderr.strip() or done.stdout.strip()).splitlines() or ["gh pr merge failed"])[-1]}
        merged_here = True
        view = load_text(gh(cell, "pr", "view", url, "--json", "state,mergeCommit,headRefOid").stdout)
    if view.get("state") != "MERGED":
        return {"merged": False, "pull_request": url, "findings_posted": posted, "note": "The pull request is open and waiting to be merged."}
    git_remote(cell.project, "fetch", "--quiet", "origin")
    untested = None
    oid = (view.get("mergeCommit") or {}).get("oid") if isinstance(view.get("mergeCommit"), dict) else None
    if merged_here and isinstance(oid, str) and re.fullmatch(r"[0-9a-f]{40,64}", oid) and git(cell.project, "cat-file", "-e", f"{oid}^{{commit}}").returncode == 0:
        parents = git(cell.project, "rev-list", "--parents", "-n", "1", oid).stdout.split()[1:]
        if parents and parents[0] != tested_on and parents[0] != head:
            untested = parents[0]
    # Keep the main checkout level with the platform, so the next ticket starts from what just landed.
    synced = False
    if git(cell.project, "branch", "--show-current").stdout.strip() == main and not dirty(cell.project):
        synced = git(cell.project, "merge", "--ff-only", f"origin/{main}").returncode == 0
    landed = {"merged": True, "pull_request": url, "merge_commit": (view.get("mergeCommit") or {}).get("oid"), "main_checkout_updated": synced,
              "findings_posted": posted}
    if untested:
        landed["untested_base"] = untested
        landed["warning"] = (f"origin/{main} moved in the moment between MACH's last check and GitHub's merge: GitHub merged onto {untested[:10]}, "
                             f"which this ticket was not tested with (it was tested on {tested_on[:10]}). Run the test suite on {main} now. "
                             f"Requiring branches to be up to date before merging, on GitHub, closes this gap.")
    return landed


def load_text(text: str) -> Dict[str, Any]:
    try:
        data = json.loads(text)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def cmd_plan(cell: Cell, args: argparse.Namespace) -> int:
    plan = survey(cell, args.by_person)
    # M20: what `run` would refuse after its fetch, said here too, against the main branch as last fetched: this slice already
    # shipped from another Factory, or its slice number is another slice's on main. Reads only.
    for check in (landed_elsewhere, slice_id_taken):
        try:
            found = check(cell, plan["into"])
        except MergeError as exc:
            found = str(exc)
        if found:
            plan["refusals"].append(found)
            plan["allowed"] = False
    print(json.dumps(plan, indent=2, ensure_ascii=False))
    return 0


def gate(cell: Cell, plan: Dict[str, Any]) -> None:
    """Refuse on the survey's refusals; a void approval is recorded as void first."""
    if plan.get("approval_void"):
        void_approval(cell)
        # The merge station had the ticket and sent it back to be verified again: its visit carries the stage cell.json now
        # holds ("built"), as a refusal inside land() does, so the log and cell.json agree.
        telemetry(cell.root, "station.entered", "merge", lambda: {"stage": plan["stage"], "method": cell.method, "behind_main": bool(plan["behind_main"])},
                  once=True)
        telemetry(cell.root, "gate.evaluated", "merge", lambda: {"gate": "merge.run", "outcome": "refuse", "reason_code": "approval-void",
                                                                 "overridden_by_reason": False})
        telemetry(cell.root, "station.exited", "merge", lambda: {"outcome": "approval-void", "stage": cell.info.get("stage")})
        exc = MergeError(plan["refusals"][-1] if len(plan["refusals"]) == 1 else "\n- " + "\n- ".join(plan["refusals"]), code="approval-void")
        exc.recorded = True
        raise exc
    if plan["refusals"]:
        raise MergeError(plan["refusals"][0] if len(plan["refusals"]) == 1 else "\n- " + "\n- ".join(plan["refusals"]),
                         code="exception-expired" if plan.get("exception_expired") else "merge-refused")


def cmd_run(cell: Cell, args: argparse.Namespace) -> int:
    plan = survey(cell, args.by_person)
    gate(cell, plan)
    if has_origin(cell.project):
        # M20 A2: see the shared main as it is now, then survey again against it. Unreachable: nothing is merged.
        fetch_shared(cell.project, plan["into"])
    landed = refuse_duplicates(cell, plan["into"], args.by_person)  # M20: before anything is merged, pushed or opened
    if has_origin(cell.project):
        plan = survey(cell, args.by_person)
        gate(cell, plan)
    if landed:
        tip = plan["main_commit"] or ""
        closed = land_on_top(cell, plan["into"], tip, landed, args.by_person) if tip else None
        if closed is not None:
            return closed
    telemetry(cell.root, "gate.evaluated", "merge", lambda: {"gate": "merge.run", "outcome": "pass", "reason_code": None, "overridden_by_reason": False,
                                                             "by_person": bool(args.by_person)})
    telemetry(cell.root, "station.entered", "merge", lambda: {"stage": plan["stage"], "method": cell.method, "behind_main": bool(plan["behind_main"])})
    try:
        return land(cell, args, plan)
    except MergeError as exc:
        telemetry(cell.root, "gate.evaluated", "merge", lambda: {"gate": "merge.land", "outcome": "refuse", "reason_code": exc.code, "overridden_by_reason": False})
        telemetry(cell.root, "station.exited", "merge", lambda: {"outcome": exc.code, "stage": cell.info.get("stage")})
        exc.recorded = True
        raise


def land(cell: Cell, args: argparse.Namespace, plan: Dict[str, Any]) -> int:
    main = plan["into"]
    tested_on = plan["main_commit"]
    if not tested_on:
        raise MergeError(f"{plan['compared_with']} could not be read, so there is nothing to test this ticket against. Nothing was merged.", code="no-shared-main")
    revalidated: Optional[Dict[str, Any]] = None
    moves: List[str] = []
    landed: Dict[str, Any] = {}
    while True:
        revalidated = revalidate(cell, main, tested_on) or revalidated
        record = write_record(cell, revalidated) if cell.records["enabled"] else None
        if cell.method == "local":
            break
        landed = land_by_pr(cell, main, cell.mode == "auto" or args.by_person, tested_on)
        if not landed.get("main_moved"):
            break
        # The shared main moved after re-validation: re-validate against where it is now, a bounded number of times.
        moves.append(f"origin/{main} moved again (now {landed['main_moved'][:10]}); re-validating.")
        telemetry(cell.root, "gate.evaluated", "merge", lambda: {"gate": "merge.main_moved", "outcome": "refuse", "reason_code": "main-moved",
                                                                 "overridden_by_reason": False, "times": len(moves)})
        if len(moves) > MAX_MAIN_MOVES:
            raise MergeError(f"origin/{main} moved {len(moves)} times while this ticket was being merged, each time after it had been tested. "
                             f"Nothing was merged; the pull request stays open ({landed.get('pull_request')}). Run the merge again later.", code="main-moving")
        tested_on = fetch_shared(cell.project, main)
        if refuse_duplicates(cell, main, args.by_person):  # what moved the shared main may be this slice, from another Factory
            closed = land_on_top(cell, main, tested_on, landed_copy(cell, main) or {}, args.by_person)
            if closed is not None:
                return closed
    head = cell.head()
    result: Dict[str, Any] = {"ticket_id": cell.ticket_id, "branch": cell.branch, "into": main, "method": cell.method,
                              "approved_commit": cell.decision.get("head"), "landed_commit": head, "revalidated": revalidated, "jira": cell.jira,
                              "compared_with": plan["compared_with"], "tested_on": tested_on,
                              "change_record": {key: record.get(key) for key in ("path", "sha256", "commit", "written")} if record
                              else {"written": False, "reason": "records.enabled is false in .factory/config.json."}}
    if moves:
        result["main_moved_again"] = moves
    shared = cell.info.get("number_shared") if isinstance(cell.info.get("number_shared"), dict) else None
    if shared:
        result["warnings"] = [f"{shared['slice_id']} is also on {main} as {shared['theirs']}, another slice. This copy lands beside it as {shared['ours']}: "
                              f"{shared['slice_id']} is the number Product Studio gave this slice, and MACH follows the slice by it. The other spec, "
                              f"{shared['theirs']}, can be given a free number on {main} by an ordinary change (cell.py next-id names one)."]
    if command_env is not None and command_env.notices(cell.project):  # only when a package cache was pointed elsewhere
        result["caches"] = command_env.notices(cell.project)
    if cell.method == "local":
        title = cell.info.get("title") or cell.info.get("slice_id") or "change"
        message = (f"{cell.jira} " if cell.jira else "") + f"Merge {cell.ticket_id}: {title}"  # a checked Jira key first (M13)
        merged = git(cell.project, "merge", "--no-ff", "-m", message, cell.branch)
        if merged.returncode != 0:
            git(cell.project, "merge", "--abort")
            raise MergeError("git could not merge the branch into the main checkout: " + ((merged.stderr.strip() or merged.stdout.strip()).splitlines() or ["merge failed"])[-1],
                             code="merge-failed")
        result.update({"status": "MERGED", "merge_commit": git(cell.project, "rev-parse", "HEAD").stdout.strip()})
        if has_origin(cell.project):
            result["note"] = (f"Merged on this machine only. Push {main} to origin for others to get it; MACH does not push.")
    else:
        result.update(landed)
        result["status"] = "MERGED" if landed["merged"] else "PR_OPEN"
    if result["status"] == "MERGED":
        # A person's merge (--by-person) is recorded: cleanup keeps the archive of a ticket a person decided on (cleanup.archive).
        cell.info.update({"stage": "merged", "merged": {"commit": result.get("merge_commit"), "at": now(), "method": cell.method, "landed_commit": head,
                                                        **({"by_person": True} if args.by_person else {})}})
        cell.save_info()
        telemetry(cell.root, "merge.completed", "merge", lambda: {
            "method": cell.method, "approved_commit": lifecycle.short(result["approved_commit"]), "landed_commit": lifecycle.short(head),
            "merge_commit": lifecycle.short(result.get("merge_commit")), "revalidated": revalidated is not None,
            "pull_request": int(re.search(r"/pull/(\d+)", result["pull_request"]).group(1)) if result.get("pull_request") else None})
        telemetry(cell.root, "station.exited", "merge", lambda: {"outcome": "merged", "stage": "merged"})
        result["next"] = f"Merged. Clean up with the cleanup skill for {cell.ticket_id}."
    else:
        telemetry(cell.root, "station.exited", "merge", lambda: {"outcome": "pr-open", "stage": cell.info.get("stage"),
                                                                 "pull_request": int(re.search(r"/pull/(\d+)", result["pull_request"]).group(1))})
        result["next"] = "The pull request is open. Run this again once it can be merged, or merge it on the platform; then clean up."
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["status"] == "MERGED" else 3


def cmd_status(cell: Cell, args: argparse.Namespace) -> int:
    print(json.dumps({**{key: cell.info.get(key) for key in ("ticket_id", "stage", "branch", "risk", "pull_request", "pull_request_findings", "revalidated", "change_record", "merged")},
                      "mode": cell.mode, "method": cell.method, "approved_commit": cell.decision.get("head"), "branch_commit": cell.head()}, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH merge station.")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, func, text in (("plan", cmd_plan, "say what run would do; changes nothing"), ("run", cmd_run, "revalidate and merge")):
        p = sub.add_parser(name, help=text)
        p.add_argument("ticket_id")
        p.add_argument("--by-person", action="store_true", help="a person is merging: allowed whatever merge.mode and merge.auto say")
        p.set_defaults(func=func)
    p = sub.add_parser("status", help="show the cell's merge state")
    p.add_argument("ticket_id")
    p.set_defaults(func=cmd_status)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    argv, holder = split_holder(parser, argv)
    args = parser.parse_args(argv)
    project = None
    try:
        project = args.project.resolve() if args.project else find_project(Path.cwd())
        if getattr(args, "by_person", False) and os.environ.get("MACH_EXECUTION_ID"):
            raise MergeError("--by-person is a person's word, and this runs inside a supervised Factory execution. Nothing was merged; "
                             "the project's merge settings decide what the Factory merges.", code="not-a-person")
        # A person's own merge is never mistaken for the worker taken over; any other holderless run is checked.
        stop = taken_over(project, args.ticket_id, holder, None if getattr(args, "by_person", False) else args.command)
        if stop:
            raise MergeError(stop, code="taken-over")
        return args.func(Cell(project, args.ticket_id), args)
    except MergeError as exc:
        if exc.code in ("renumbered", "recheck"):  # a person's merge carried the copy on: not a refusal, the ticket goes on
            print(json.dumps({"ticket_id": args.ticket_id, "status": "RENUMBERED" if exc.code == "renumbered" else "RECHECK", "reason": str(exc),
                              "next": "The change goes back to be verified and reviewed; check the routing sheet (next) and carry on."},
                             indent=2, ensure_ascii=False))
            return 3
        print(f"refused: {exc}", file=sys.stderr)
        if project is not None and args.command == "run" and not getattr(exc, "recorded", False):
            telemetry(project / ".factory" / "worktrees" / args.ticket_id, "gate.evaluated", "merge", lambda: {
                "gate": "merge.run", "outcome": "refuse", "reason_code": exc.code, "overridden_by_reason": False})
        return 1


if __name__ == "__main__":
    import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
    sys.exit(main())
