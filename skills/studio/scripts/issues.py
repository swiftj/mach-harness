"""Product Studio's GitHub calls for the product model (M11): the project, epic and slice issues.

Every call is a fixed gh argument list on the repository the `origin` remote names (OWNER/REPO,
resolved by collab.request_repository). Each returns (answer, failure) like collab's request
calls; a failure is collab.classify's and is never raised. Text goes to GitHub only from a file
Product Studio wrote from a fixed template or the approved spec and why (--body-file), never on
the command line.

Writes, and nothing else:
- create an issue with MACH's labels, and pin the project's issue;
- replace the title and body of an issue that carries a MACH product label;
- comment the approval from its fixed template;
- add MACH's product labels, and remove only mach:ready;
- on an idea's issue (M16), set one of MACH's idea state labels and remove only the other idea state labels;
- create a missing MACH label (never overwriting one);
- add a slice as a sub-issue of its epic, and place it in the product manager's order;
- close an issue Product Studio itself made at the same moment as an earlier one holding the same ID (M20), taking
  MACH's product labels off it so neither MACH nor the Factory reads it again.

Standard library only. Imported by studio.py; not a command of its own.
"""

import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import collab

Failure = collab.Failure
ISSUE_FIELDS = "number,title,state,labels,body,url"
LIST_LIMIT = 1000
LIST_CEILING = 64000  # list_all_issues asks for more, by this much at most, while GitHub keeps filling the page it was asked for
OTHER = "other"


def _failure(reason: str, kind: str = OTHER) -> Dict[str, str]:
    return {"kind": kind, "reason": reason, "link": ""}


def is_here(found: Any, repository: str) -> bool:
    url = found.get("url") if isinstance(found, dict) else None
    return isinstance(url, str) and url.lower().startswith(f"https://github.com/{repository}/issues/".lower())


def label_names(item: Dict[str, Any]) -> List[str]:
    return [label.get("name") for label in item.get("labels") or [] if isinstance(label, dict) and isinstance(label.get("name"), str)]


def signed_in(project: Path) -> Tuple[Optional[str], Failure]:
    """The GitHub account gh is signed in as on this machine."""
    found, failure = collab._gh_json(project, "api", *collab.API_HEADERS, "user", "--jq", "{login}")
    if failure:
        return None, failure
    login = found.get("login") if isinstance(found, dict) else None
    if not collab.is_login(login):
        return None, _failure("GitHub did not say which account is signed in.")
    return login, None


def list_issues(project: Path, repository: str, label: str) -> Tuple[Optional[List[Dict[str, Any]]], Failure]:
    """Every issue carrying `label`, open or closed (at most LIST_LIMIT of them: see list_all_issues)."""
    found, failure, _ = _listed(project, repository, label, LIST_LIMIT)
    return found, failure


def list_all_issues(project: Path, repository: str, label: str) -> Tuple[Optional[List[Dict[str, Any]]], Failure, bool]:
    """Every issue carrying `label`, open or closed, and whether that is all of them. gh pages through GitHub itself up to the
    limit it is given; when GitHub fills it, the list is asked for again with a limit ten times larger, up to LIST_CEILING.
    (found, None, False) when even that was full: GitHub holds more than was read. M21: project export reads this way."""
    limit = LIST_LIMIT
    while True:
        found, failure, full = _listed(project, repository, label, limit)
        if failure or not full:
            return found, failure, failure is None
        if limit >= LIST_CEILING:
            return found, None, False
        limit = min(limit * 10, LIST_CEILING)


def _listed(project: Path, repository: str, label: str, limit: int) -> Tuple[Optional[List[Dict[str, Any]]], Failure, bool]:
    """The issues carrying `label`, and whether GitHub gave as many as were asked for (so there may be more)."""
    found, failure = collab._gh_json(project, "issue", "list", "--repo", repository, "--label", label, "--state", "all",
                                     "--limit", str(limit), "--json", ISSUE_FIELDS)
    if failure:
        return None, failure, False
    if not isinstance(found, list):
        return [], None, False
    return ([item for item in found if isinstance(item, dict) and type(item.get("number")) is int and is_here(item, repository)], None,
            len(found) >= limit)


def view(project: Path, repository: str, number: int) -> Tuple[Optional[Dict[str, Any]], Failure]:
    found, failure = collab._gh_json(project, "issue", "view", str(int(number)), "--repo", repository, "--json", ISSUE_FIELDS)
    if failure:
        return None, failure
    if not isinstance(found, dict):
        return None, _failure("GitHub's answer could not be read.")
    if not is_here(found, repository):
        return None, dict(collab.MOVED)
    return found, None


TIME_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$")


def comments(project: Path, repository: str, number: int) -> Tuple[Optional[List[Dict[str, Any]]], Failure]:
    """The issue's comments as {login, body, created_at}; read to find MACH's own approval and
    status comments. `created_at` is GitHub's date of the comment (UTC), or None when it gave none."""
    found, failure = collab._gh_json(project, "issue", "view", str(int(number)), "--repo", repository, "--json", "comments")
    if failure:
        return None, failure
    items = found.get("comments") if isinstance(found, dict) else None
    return [{"login": ((c.get("author") or {}).get("login") if isinstance(c.get("author"), dict) else None), "body": str(c.get("body") or ""),
             "created_at": c["createdAt"][:19] + "Z" if isinstance(c.get("createdAt"), str) and TIME_RE.fullmatch(c["createdAt"]) else None}
            for c in items or [] if isinstance(c, dict)], None


def database_id(project: Path, repository: str, number: int) -> Tuple[Optional[int], Failure]:
    """The issue's numeric id, which the sub-issue calls take instead of its number."""
    found, failure = collab._gh_json(project, "api", *collab.API_HEADERS, ISSUE_PATH.format(repository=repository, number=int(number)), "--jq", "{id}")
    if failure:
        return None, failure
    value = found.get("id") if isinstance(found, dict) else None
    return (value, None) if type(value) is int and value > 0 else (None, _failure("GitHub did not give the issue's id."))


def labels(project: Path, repository: str) -> Tuple[Optional[List[str]], Failure]:
    found, failure = collab._gh_json(project, "label", "list", "--repo", repository, "--limit", str(LIST_LIMIT), "--json", "name")
    if failure:
        return None, failure
    return [item.get("name") for item in found or [] if isinstance(item, dict) and isinstance(item.get("name"), str)], None


def create_label(project: Path, repository: str, name: str, color: str, description: str) -> Failure:
    failure = collab._gh_write(project, "label", "create", name, "--repo", repository, "--color", color, "--description", description)
    if failure and "already exists" in str(failure.get("reason") or "").lower():
        return None
    return failure


def create(project: Path, repository: str, title: str, body_file: Path, names: Sequence[str]) -> Tuple[Optional[int], Failure]:
    """Open an issue with MACH's labels; returns its number."""
    args = ["issue", "create", "--repo", repository, "--title", title, "--body-file", str(body_file)]
    for name in names:
        args += ["--label", name]
    if shutil.which("gh") is None:
        return None, dict(collab.NO_GH)
    done = collab.gh(project, *args)
    if done.returncode != 0:
        return None, collab.classify(done)
    url = next((line.strip() for line in reversed(done.stdout.splitlines()) if line.strip().startswith("https://")), "")
    found = re.fullmatch(r"https://github\.com/([^/]+/[^/]+)/issues/([0-9]{1,9})", url)
    if not found or found.group(1).lower() != repository.lower():
        return None, _failure("GitHub did not give the new issue's address.", "unknown")
    return int(found.group(2)), None


def rewrite(project: Path, repository: str, number: int, title: str, body_file: Path) -> Failure:
    return collab._gh_write(project, "issue", "edit", str(int(number)), "--repo", repository, "--title", title, "--body-file", str(body_file))


def add_labels(project: Path, repository: str, number: int, names: Sequence[str]) -> Failure:
    args = ["issue", "edit", str(int(number)), "--repo", repository]
    for name in names:
        args += ["--add-label", name]
    return collab._gh_write(project, *args)


def remove_ready(project: Path, repository: str, number: int) -> Failure:
    return collab._gh_write(project, "issue", "edit", str(int(number)), "--repo", repository, "--remove-label", READY)


def set_idea_state(project: Path, repository: str, number: int, add: str, remove: Sequence[str]) -> Failure:
    """M16: put one of MACH's idea state labels on an idea's issue and take its other idea state labels off. Refuses any
    other label, so nothing but MACH's own idea states is ever removed from an issue."""
    if add not in IDEA_STATES or any(name not in IDEA_STATES or name == add for name in remove):
        return _failure("Only MACH's idea state labels are set here.")
    args = ["issue", "edit", str(int(number)), "--repo", repository, "--add-label", add]
    for name in remove:
        args += ["--remove-label", name]
    return collab._gh_write(project, *args)


def comment(project: Path, repository: str, number: int, body_file: Path) -> Failure:
    return collab._gh_write(project, "issue", "comment", str(int(number)), "--repo", repository, "--body-file", str(body_file))


def stand_down(project: Path, repository: str, number: int, names: Sequence[str]) -> Failure:
    """M20: take MACH's product labels `names` off an issue Product Studio made, then close it. Only MACH's own labels."""
    if any(name not in STAND_DOWN_LABELS for name in names):
        return _failure("Only MACH's product labels are taken off here.")
    if names:
        args = ["issue", "edit", str(int(number)), "--repo", repository]
        for name in names:
            args += ["--remove-label", name]
        failure = collab._gh_write(project, *args)
        if failure:
            return failure
    return collab._gh_write(project, "issue", "close", str(int(number)), "--repo", repository)


STAND_DOWN_LABELS = ("mach:project", "mach:epic", "mach:slice", "mach:ready")


def pin(project: Path, repository: str, number: int) -> Failure:
    return collab._gh_write(project, "issue", "pin", str(int(number)), "--repo", repository)


def sub_issues(project: Path, repository: str, number: int) -> Tuple[Optional[List[int]], Failure]:
    """The ids of the epic's sub-issues, in their order."""
    found, failure = collab._gh_json(project, "api", "--paginate", *collab.API_HEADERS, SUB_ISSUES_PATH.format(repository=repository, number=int(number)),
                                     "--jq", ".[] | {id}", lines=True)
    if failure:
        return None, failure
    return [item["id"] for item in found or [] if isinstance(item, dict) and type(item.get("id")) is int], None


def add_sub_issue(project: Path, repository: str, number: int, child: int) -> Failure:
    """Make `child` (an issue id) a sub-issue of the epic, moving it from any other parent."""
    return collab._gh_write(project, "api", "--method", "POST", *collab.API_HEADERS, SUB_ISSUES_PATH.format(repository=repository, number=int(number)),
                            "-F", f"sub_issue_id={int(child)}", "-F", "replace_parent=true")


def place_sub_issue(project: Path, repository: str, number: int, child: int, after: Optional[int], before: Optional[int]) -> Failure:
    """Move the sub-issue to just after `after`, or just before `before` (issue ids)."""
    where = ["-F", f"after_id={int(after)}"] if after is not None else ["-F", f"before_id={int(before or 0)}"]
    return collab._gh_write(project, "api", "--method", "PATCH", *collab.API_HEADERS, PRIORITY_PATH.format(repository=repository, number=int(number)),
                            "-F", f"sub_issue_id={int(child)}", *where)


def sub_issue_numbers(project: Path, repository: str, number: int) -> Tuple[Optional[List[Tuple[int, int]]], Failure]:
    """The epic's sub-issues as (id, number), in their order: read to compare with the product manager's order."""
    found, failure = collab._gh_json(project, "api", "--paginate", *collab.API_HEADERS, SUB_ISSUES_PATH.format(repository=repository, number=int(number)),
                                     "--jq", ".[] | {id, number}", lines=True)
    if failure:
        return None, failure
    return [(item["id"], item["number"]) for item in found or [] if isinstance(item, dict) and type(item.get("id")) is int and type(item.get("number")) is int], None


READY = "mach:ready"
# M16: the idea state labels (issue_rules.SHAPE_STATE_LABELS; tests hold the two the same). Product Studio owns them all.
IDEA_STATES = ("mach:idea-new", "mach:idea-exploring", "mach:idea-brief", "mach:idea-go", "mach:idea-not-now", "mach:idea-no", "mach:idea-shaped")
ISSUE_PATH = "repos/{repository}/issues/{number}"
SUB_ISSUES_PATH = "repos/{repository}/issues/{number}/sub_issues"
PRIORITY_PATH = "repos/{repository}/issues/{number}/sub_issues/priority"


def unavailable(failure: Failure) -> bool:
    """True when GitHub answered that sub-issues are not available on this repository (not a
    passing failure): not found or gone, or the feature refused."""
    text = str((failure or {}).get("reason") or "").lower()
    return bool(failure) and failure.get("kind") in ("not_found", "rule", OTHER) and any(
        mark in text for mark in ("404", "410", "not found", "gone", "sub-issue", "sub_issue", "not enabled", "not available"))
