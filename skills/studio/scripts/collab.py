#!/usr/bin/env python3
"""Product Studio's calls to GitHub through gh, and why one failed.

Every call is a fixed argument list. The product manager's own checkout, branch, index and stash
are never touched, and nothing here starts Factory work. Reading issues used as requests (M8) and
the writes that tell a request's issue what became of it (comments from fixed templates, and
closing it on the product manager's word) live here; the product issues of M11 are in issues.py,
which uses the same two helpers.

Standard library only. Imported by studio.py, issues.py and requests_in.py; not a command of its own.
"""

import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REMOTE = "origin"


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, errors="replace")


def git_bytes(cwd: Path, *args: str) -> Optional[bytes]:
    """A Git read whose answer is bytes, such as a picture on a branch (M21: project export reads design mocks this way). None
    when Git refuses."""
    done = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True)
    return done.stdout if done.returncode == 0 else None


def gh(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["gh", *args], cwd=str(cwd), capture_output=True, text=True, errors="replace")


# ---- why a push or a GitHub call failed ----

REASON_LIMIT = 300
CREDENTIALS_IN_URL_RE = re.compile(r"(https?://)[^/@\s]+@")
SSO_LINK_RE = re.compile(r"https://[^\s'\"<>]*(?:sso|single-sign-on)[^\s'\"<>]*", re.IGNORECASE)
# Checked in this order; the first that matches decides. Lower-case substrings of Git's or gh's output.
FAILURE_KINDS = (
    ("sso", ("saml", "single sign-on", "single-sign-on", "/sso", "sso authorization", "sso enforcement")),
    ("auth", ("authentication failed", "invalid username or password", "bad credentials", "http 401", "401 unauthorized",
              "could not read username", "could not read password", "terminal prompts disabled", "gh auth login",
              "not logged in", "authentication required", "token is expired", "token has expired", "permission denied (publickey)")),
    # GitHub's limits and outages, and this computer stopping the tool, are said as what they are: none of them is a refusal
    # of this account, and none is "no network". They are matched before the kinds whose words they also contain.
    ("rate_limit", ("rate limit", "http 429", "429 too many requests")),
    ("unavailable", ("http 500", "http 502", "http 503", "http 504", "bad gateway", "service unavailable", "gateway timeout")),
    ("blocked", ("operation not permitted", "proxyconnect", "proxy authentication required", "http 407")),
    ("rule", ("[remote rejected]", "gh006", "gh013", "protected branch", "hook declined", "push declined", "rule violation",
              "permission to ", "http 403", "403 forbidden", "returned error: 403", "resource not accessible", "must have push access",
              "not permitted", "pre-receive")),
    ("network", ("could not resolve host", "could not resolve proxy", "failed to connect", "connection refused", "connection timed out", "timed out", "network is unreachable",
                 "no route to host", "connection reset", "deadline exceeded", "dial tcp", "no such host", "error connecting to",
                 "proxy connect", "unable to access", "does not appear to be a git repository", "could not read from remote repository",
                 "ssl certificate", "ssl connect")),
    # GitHub's "Could not resolve to an issue/Repository ..." means the thing does not exist, not
    # that the network is down; it is matched after every genuine network phrase.
    ("not_found", ("could not resolve to", "http 404", "not found (http", "404 not found")),
)


def bounded(text: str, limit: int = REASON_LIMIT) -> str:
    """Remote or reviewer text made safe to show as data: one line, no control characters, no
    credentials inside a URL, at most `limit` characters."""
    text = CREDENTIALS_IN_URL_RE.sub(r"\1", text)
    text = " ".join("".join(ch if ch.isprintable() else " " for ch in text).split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def classify(done: subprocess.CompletedProcess) -> Dict[str, str]:
    """Why a push, fetch or gh call failed, from its exit status and output.

    `kind` is one of network, auth, rule, sso, rate_limit, unavailable, blocked, not_found, other. `reason` is the remote's own words (its
    "remote:" lines when it sent any), bounded, to be shown as quoted data and never interpreted.
    `link` is the address GitHub printed for single sign-on, if any, also data."""
    raw = "\n".join(part for part in (done.stderr, done.stdout if done.returncode != 0 and not done.stderr else "") if part)
    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    said = [line[len("remote:"):].strip() for line in lines if line.lower().startswith("remote:")]
    said = [line for line in said if line]
    rest = [line for line in lines if not line.lower().startswith(("remote:", "to ", "hint:"))]
    if said:
        rejected = [line for line in rest if "[remote rejected]" in line or "[rejected]" in line]
        chosen = said + rejected
    else:
        chosen = [line for line in rest if not line.lower().startswith("error: failed to push some refs")] or rest
    text = raw.lower()
    kind = next((name for name, marks in FAILURE_KINDS if any(mark in text for mark in marks)), "other")
    if done.returncode == 0:
        kind = "other"
    link = SSO_LINK_RE.search(raw) if kind == "sso" else None
    return {"kind": kind, "reason": bounded(" ".join(chosen)) or "no reason given",
            "link": bounded(link.group(0).rstrip(".,)"), 200) if link else ""}


# manager's word. Every call returns (answer, failure); a failure is collab.classify's, never raised.

API_HEADERS = ("-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28")
EVENTS_PATH = "repos/{repository}/issues/{number}/events?per_page=100"
PERMISSION_PATH = "repos/{repository}/collaborators/{login}/permission"
EVENTS_JQ = ('.[] | select(.event=="labeled" or .event=="unlabeled") | {event, label: .label.name, '
             'login: .actor.login, id: .actor.id, type: .actor.type, app: (.performed_via_github_app != null), at: .created_at}')
PERMISSION_JQ = "{permission, role_name}"
ISSUE_LIST_FIELDS = "number,title,author,labels,updatedAt"
ISSUE_VIEW_FIELDS = "number,title,body,author,labels,state,updatedAt"
LIST_LIMIT = 100
NO_GH = {"kind": "other", "reason": "The GitHub tool (gh) is not installed on this machine.", "link": ""}
Failure = Optional[Dict[str, str]]


# A read of GitHub that fails for the network is tried again before it is reported: one dropped connection, or a computer
# just woken from sleep, is not "GitHub cannot be reached". Seconds to wait before each further try; MACH_GH_RETRY_WAITS
# replaces them (comma-separated seconds; empty for no further try). Only reads are tried again, never a write.
DEFAULT_RETRY_WAITS = (2.0, 6.0)


RETRIED_KINDS = ("network", "unavailable")  # passing failures; a refusal, a limit or a block is never tried again


def retry_waits() -> Tuple[float, ...]:
    raw = os.environ.get("MACH_GH_RETRY_WAITS")
    if raw is None:
        return DEFAULT_RETRY_WAITS
    try:
        waits = tuple(float(part) for part in raw.split(",") if part.strip())[:5]
    except ValueError:
        return DEFAULT_RETRY_WAITS
    return tuple(min(max(wait, 0.0), 30.0) for wait in waits) if all(math.isfinite(wait) for wait in waits) else DEFAULT_RETRY_WAITS


# Further tries are for a failure that passes quickly. They stop for the rest of this command once a read has used all of
# its tries (GitHub is out of reach: the next read would only wait as long again), and a try that itself took longer than
# SLOW_TRY seconds to fail is not repeated (a network that drops packets fails slowly, every time). So one command waits a few
# seconds more at most, and stays inside the time the app's host allows it.
SLOW_TRY = 5.0
_GAVE_UP: List[bool] = []


def tried_words(failure: Dict[str, str]) -> str:
    """" (tried 3 times)" for a failure that was tried more than once; nothing otherwise."""
    tries = str(failure.get("tries") or "")
    return f" (tried {tries} times)" if re.fullmatch(r"[2-9]|[1-9][0-9]", tries) else ""


def _gh_json(project: Path, *args: str, lines: bool = False) -> Tuple[Any, Failure]:
    if shutil.which("gh") is None:
        return None, dict(NO_GH)
    waits = [] if _GAVE_UP else list(retry_waits())
    tries = 0
    while True:
        started = time.monotonic()
        done = gh(project, *args)
        tries += 1
        if done.returncode == 0:
            break
        failure = classify(done)
        passing = failure["kind"] in RETRIED_KINDS
        if not passing or not waits or time.monotonic() - started > SLOW_TRY:
            if passing:
                _GAVE_UP.append(True)
            failure["tries"] = str(tries)
            return None, failure
        time.sleep(waits.pop(0))
    try:
        if lines:
            return [json.loads(line) for line in done.stdout.splitlines() if line.strip()], None
        return json.loads(done.stdout or "null"), None
    except ValueError:
        return None, {"kind": "other", "reason": "GitHub's answer could not be read.", "link": ""}


def _gh_write(project: Path, *args: str) -> Failure:
    if shutil.which("gh") is None:
        return dict(NO_GH)
    done = gh(project, *args)
    if done.returncode != 0:
        failure = classify(done)
        failure["not_found"] = "not found" in (done.stderr + done.stdout).lower()
        return failure
    return None


_RULES: List[Any] = []


def is_login(login: Any) -> bool:
    """Whether this is a GitHub account name, by the ticket skill's one rule (issue_rules.LOGIN_RE), loaded from
    the sibling skill folder whichever way MACH is installed and never copied. No rule found means no."""
    if not _RULES:
        found = None
        skills = Path(__file__).resolve().parent.parent.parent
        for name in ("mach-ticket", "ticket"):
            path = skills / name / "scripts" / "issue_rules.py"
            if path.is_file():
                spec = importlib.util.spec_from_file_location("mach_ticket_issue_rules", path)
                found = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(found)
                break
        _RULES.append(found)
    return bool(_RULES[0] and isinstance(login, str) and _RULES[0].LOGIN_RE.fullmatch(login))


GITHUB_REMOTE_RE = re.compile(r"^(?:https://(?:[^/@\s]+@)?github\.com/|ssh://git@github\.com/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}?)(?:\.git)?/?$")


def request_repository(project: Path) -> Tuple[Optional[str], Failure]:
    """OWNER/REPO of the shared remote, resolved by gh from the remote's own configured address, so
    an issue in any other repository is never read. (None, None) when the project has no shared
    remote on GitHub: then it has no requests, and gh is not called at all."""
    address = git(project, "config", "--get", f"remote.{REMOTE}.url").stdout.strip()
    named = GITHUB_REMOTE_RE.fullmatch(address)
    if not named:
        return None, None
    # Only OWNER/REPO is handed to gh, never the address itself, which may carry a credential.
    found, failure = _gh_json(project, "repo", "view", named.group(1), "--json", "nameWithOwner")
    if failure:
        return None, failure
    name = found.get("nameWithOwner") if isinstance(found, dict) else None
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}", name):
        return None, {"kind": "other", "reason": "GitHub did not name the shared repository.", "link": ""}
    return name, None


def list_requests(project: Path, repository: str, label: str) -> Tuple[Optional[List[Dict[str, Any]]], Failure]:
    found, failure = _gh_json(project, "issue", "list", "--repo", repository, "--label", label, "--state", "open",
                              "--limit", str(LIST_LIMIT), "--json", ISSUE_LIST_FIELDS)
    if failure:
        return None, failure
    return [item for item in found if isinstance(item, dict)] if isinstance(found, list) else [], None


def view_issue(project: Path, repository: str, number: int) -> Tuple[Optional[Dict[str, Any]], Failure]:
    found, failure = _gh_json(project, "issue", "view", str(int(number)), "--repo", repository, "--json", ISSUE_VIEW_FIELDS)
    if failure:
        return None, failure
    return (found, None) if isinstance(found, dict) else (None, {"kind": "other", "reason": "GitHub's answer could not be read.", "link": ""})


def issue_label_events(project: Path, repository: str, number: int) -> Tuple[Optional[List[Any]], Failure]:
    """Every labeled and unlabeled event on the issue, all pages."""
    return _gh_json(project, "api", "--paginate", *API_HEADERS, EVENTS_PATH.format(repository=repository, number=int(number)),
                    "--jq", EVENTS_JQ, lines=True)


def collaborator_permission(project: Path, repository: str, login: str) -> Tuple[Optional[Dict[str, Any]], Failure]:
    if not is_login(login):
        return None, {"kind": "other", "reason": "not an account name", "link": ""}
    found, failure = _gh_json(project, "api", *API_HEADERS, PERMISSION_PATH.format(repository=repository, login=login), "--jq", PERMISSION_JQ)
    if failure:
        return None, failure
    return (found, None) if isinstance(found, dict) else (None, {"kind": "other", "reason": "GitHub's answer could not be read.", "link": ""})


def issue_comments(project: Path, repository: str, number: int) -> Tuple[Optional[List[Dict[str, str]]], Failure]:
    """The issue's comments as (login, body): who wrote a picked-up comment on a request."""
    found, failure = _gh_json(project, "issue", "view", str(int(number)), "--repo", repository, "--json", "comments")
    if failure:
        return None, failure
    comments = found.get("comments") if isinstance(found, dict) else None
    return [{"login": str((c.get("author") or {}).get("login") or "") if isinstance(c.get("author"), dict) else "", "body": str(c.get("body") or "")}
            for c in comments or [] if isinstance(c, dict)], None


def issue_comment_bodies(project: Path, repository: str, number: int) -> Tuple[Optional[List[str]], Failure]:
    """The issue's comment texts, only to find a status marker MACH already wrote."""
    found, failure = _gh_json(project, "issue", "view", str(int(number)), "--repo", repository, "--json", "comments")
    if failure:
        return None, failure
    comments = found.get("comments") if isinstance(found, dict) else None
    return [str(c.get("body") or "") for c in comments or [] if isinstance(c, dict)], None


MOVED = {"kind": "moved", "reason": "The issue has moved to another repository.", "link": ""}


def issue_is_here(project: Path, repository: str, number: int) -> Failure:
    """Checked before every write: the issue as GitHub finds it now must still live in
    `repository`. An issue moved to another repository is still found by its old number, at its
    new address, and is never written to."""
    found, failure = _gh_json(project, "issue", "view", str(int(number)), "--repo", repository, "--json", "number,url")
    if failure:
        return failure
    url = found.get("url") if isinstance(found, dict) else None
    if not isinstance(url, str) or not url.lower().startswith(f"https://github.com/{repository}/issues/".lower()):
        return dict(MOVED)
    return None


def comment_on_issue(project: Path, repository: str, number: int, body: str) -> Failure:
    return issue_is_here(project, repository, number) or _gh_write(project, "issue", "comment", str(int(number)), "--repo", repository, "--body", body)


def close_issue(project: Path, repository: str, number: int) -> Failure:
    return issue_is_here(project, repository, number) or _gh_write(project, "issue", "close", str(int(number)), "--repo", repository, "--reason", "completed")
