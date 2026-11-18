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
- create a missing MACH label (never overwriting one);
- add a slice as a sub-issue of its epic, and place it in the product manager's order.

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
    if not isinstance(login, str) or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})", login):
        return None, _failure("GitHub did not say which account is signed in.")
    return login, None


def list_issues(project: Path, repository: str, label: str) -> Tuple[Optional[List[Dict[str, Any]]], Failure]:
    """Every issue carrying `label`, open or closed."""
    found, failure = collab._gh_json(project, "issue", "list", "--repo", repository, "--label", label, "--state", "all",
                                     "--limit", str(LIST_LIMIT), "--json", ISSUE_FIELDS)
    if failure:
        return None, failure
    if not isinstance(found, list):
        return [], None
    return [item for item in found if isinstance(item, dict) and type(item.get("number")) is int and is_here(item, repository)], None


def view(project: Path, repository: str, number: int) -> Tuple[Optional[Dict[str, Any]], Failure]:
    found, failure = collab._gh_json(project, "issue", "view", str(int(number)), "--repo", repository, "--json", ISSUE_FIELDS)
    if failure:
        return None, failure
    if not isinstance(found, dict):
        return None, _failure("GitHub's answer could not be read.")
    if not is_here(found, repository):
        return None, dict(collab.MOVED)
    return found, None


def comments(project: Path, repository: str, number: int) -> Tuple[Optional[List[Dict[str, Any]]], Failure]:
    """The issue's comments as {login, body}; read to find MACH's own approval comments."""
    found, failure = collab._gh_json(project, "issue", "view", str(int(number)), "--repo", repository, "--json", "comments")
    if failure:
        return None, failure
    items = found.get("comments") if isinstance(found, dict) else None
    return [{"login": ((c.get("author") or {}).get("login") if isinstance(c.get("author"), dict) else None), "body": str(c.get("body") or "")}
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


def comment(project: Path, repository: str, number: int, body_file: Path) -> Failure:
    return collab._gh_write(project, "issue", "comment", str(int(number)), "--repo", repository, "--body-file", str(body_file))


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


READY = "mach:ready"
ISSUE_PATH = "repos/{repository}/issues/{number}"
SUB_ISSUES_PATH = "repos/{repository}/issues/{number}/sub_issues"
PRIORITY_PATH = "repos/{repository}/issues/{number}/sub_issues/priority"


def unavailable(failure: Failure) -> bool:
    """True when GitHub answered that sub-issues are not available on this repository (not a
    passing failure): not found or gone, or the feature refused."""
    text = str((failure or {}).get("reason") or "").lower()
    return bool(failure) and failure.get("kind") in ("not_found", "rule", OTHER) and any(
        mark in text for mark in ("404", "410", "not found", "gone", "sub-issue", "sub_issue", "not enabled", "not available"))
