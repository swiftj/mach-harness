#!/usr/bin/env python3
"""Files one idea as a GitHub issue in MACH's idea template, with no label (M14 part D).

    idea.py check --title "<title>" --body-file <file>   what would be filed, and whether it can be filed here; changes nothing
    idea.py file  --title "<title>" --body-file <file> --sha256 <from check>
                                                         create the issue, only after the person said yes to that exact text

The body must be exactly the idea template (issue_rules.idea_body): the hidden marker and five headed parts. Text shaped
like a credential (the shapes of skills/intent/scripts/scan.py) is refused, never filed and never printed. Everything
else is cleaned, redacted and bounded with the shared issue rules, and `check` prints exactly the text `file` would send.

The issue goes only to the repository the `origin` remote names, and carries no label: someone with write access adds
`mach:request` for a product manager to see it, which keeps the request acceptance rule (M8) as it is. Nothing here
reads or writes any other issue, starts a station or sends anything but the one issue.

Standard library only. Uses the ticket skill's issue_rules.py and the intent skill's scan.py, loaded from the sibling
skill folders whichever way MACH is installed, never copied. It does not use Product Studio's scripts (no other skill
does); it names the repository the way Product Studio's requests do: the origin remote's OWNER/REPO, confirmed by gh.
"""

import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

SKILLS = Path(__file__).resolve().parent.parent.parent
BODY_FILE_LIMIT = 70000  # bytes read from the body file; the issue_rules bound the text itself
LABEL_NOTE = ("It has no label yet: someone with the right on the repository must add the mach:request label "
              "before a product manager sees it as a request.")
NOT_A_PROMISE = "Filing an idea does not mean it will be built; a product manager decides what is made from it."


GITHUB_REMOTE_RE = re.compile(r"^(?:https://(?:[^/@\s]+@)?github\.com/|ssh://git@github\.com/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}?)(?:\.git)?/?$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$")


class IdeaError(Exception):
    pass


def sibling(station: str, script: str) -> Any:
    """Another MACH skill's script, from its folder under either install's name."""
    for name in (f"mach-{station}", station):
        path = SKILLS / name / "scripts" / f"{script}.py"
        if path.is_file():
            spec = importlib.util.spec_from_file_location(f"mach_idea_{script}", path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            return module
    raise IdeaError(f"The MACH {station} skill is not installed next to this one, so the idea cannot be checked here. "
                    "Give the person the text to paste into a new issue instead.")


def prepared(title: str, body_file: Path) -> Dict[str, Any]:
    """The exact title and body that would be filed, or a refusal in plain words."""
    rules, scan = sibling("ticket", "issue_rules"), sibling("intent", "scan")
    try:
        raw = body_file.read_bytes()[:BODY_FILE_LIMIT + 1]
    except OSError:
        raise IdeaError(f"Could not read {body_file}.")
    if len(raw) > BODY_FILE_LIMIT:
        raise IdeaError("The idea is too long to file as one issue. Shorten it.")
    body = raw.decode("utf-8", errors="replace").replace("\r\n", "\n")
    kinds = scan.secrets_in_text(title + "\n" + body)
    if kinds:
        raise IdeaError("The idea holds something shaped like a password, key or token (" + ", ".join(kinds) + "). "
                        "It was not filed. Take it out, then show the person the text again.")
    parts = rules.parse_idea_body(body)
    if parts is None:
        raise IdeaError("The text is not in the idea template: it must start with " + rules.IDEA_MARKER + " and then have exactly these "
                        "headings, in this order, each with something under it: " + ", ".join(h for _, h in rules.IDEA_SECTIONS) + ".")
    final_title, _ = rules.bound_text(title, rules.TITLE_LIMIT, one_line=True)
    if not final_title.strip():
        raise IdeaError("The idea needs a short title.")
    final_body = rules.idea_body(parts)
    # True when cleaning or redaction (an email address masked, say) or the template's own spacing changed the text:
    # the person is then shown the new text and asked again.
    changed = final_title != " ".join(title.split()) or final_body.strip() != body.strip()
    return {"title": final_title, "body": final_body, "changed": changed, "sha256": rules.text_sha256(final_title, final_body),
            "open_questions": len(rules.idea_questions(parts["open_questions"]))}


def run(project: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(list(args), cwd=str(project), capture_output=True, text=True, errors="replace")


def said(done: subprocess.CompletedProcess) -> str:
    """What gh said, one line, bounded, with no credential inside an address."""
    text = re.sub(r"(https?://)[^/@\s]+@", r"\1", done.stderr or done.stdout or "")
    text = " ".join("".join(ch if ch.isprintable() else " " for ch in text).split())
    return (text[:299] + "…") if len(text) > 300 else (text or "no reason given")


def repository(project: Path) -> Dict[str, Any]:
    """Where the idea would be filed: the repository the origin remote names, as GitHub confirms it. Only OWNER/REPO is
    handed to gh, never the address itself, which may carry a credential."""
    if shutil.which("gh") is None:
        return {"repository": None, "can_file": False, "why_not": "The GitHub tool (gh) is not installed here."}
    address = run(project, "git", "config", "--get", "remote.origin.url").stdout.strip() if shutil.which("git") else ""
    named = GITHUB_REMOTE_RE.fullmatch(address)
    if not named:
        return {"repository": None, "can_file": False, "why_not": "This folder has no GitHub repository as its origin."}
    done = run(project, "gh", "repo", "view", named.group(1), "--json", "nameWithOwner")
    try:
        name = json.loads(done.stdout).get("nameWithOwner") if done.returncode == 0 else None
    except (ValueError, AttributeError):
        name = None
    if not isinstance(name, str) or not REPOSITORY_RE.fullmatch(name):
        lowered = (done.stderr or "").lower()
        words = ("gh is not signed in to GitHub on this computer." if any(w in lowered for w in ("gh auth login", "not logged in", "http 401", "bad credentials"))
                 else "GitHub could not be reached." if any(w in lowered for w in ("could not resolve host", "error connecting", "timed out", "dial tcp"))
                 else "GitHub did not confirm the repository.")
        return {"repository": None, "can_file": False, "why_not": words}
    return {"repository": name, "can_file": True, "why_not": None}


def cmd_check(project: Path, args: argparse.Namespace) -> Dict[str, Any]:
    return {**prepared(args.title, Path(args.body_file)), **repository(project), "filed": False,
            "label_note": LABEL_NOTE, "not_a_promise": NOT_A_PROMISE}


def cmd_file(project: Path, args: argparse.Namespace) -> Dict[str, Any]:
    text = prepared(args.title, Path(args.body_file))
    if args.sha256 != text["sha256"]:
        raise IdeaError("This is not the text the person said yes to (its sha256 differs from the one check printed). "
                        "Run check again, show the person the exact title and body, and ask again. Nothing was filed.")
    where = repository(project)
    if not where["can_file"]:
        raise IdeaError(where["why_not"] + " Nothing was filed. Give the person the text to paste into a new issue instead.")
    handle, path = tempfile.mkstemp(prefix="mach-idea-", suffix=".md")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(text["body"])
        # No --label: the person, or someone with the right, labels it as a request.
        done = run(project, "gh", "issue", "create", "--repo", where["repository"], "--title", text["title"], "--body-file", path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if done.returncode != 0:
        raise IdeaError(f"GitHub did not create the issue. GitHub said: \"{said(done)}\"")
    url = next((line.strip() for line in reversed(done.stdout.splitlines()) if line.strip().startswith("https://")), "")
    found = re.fullmatch(r"https://github\.com/([^/\s]+/[^/\s]+)/issues/([0-9]{1,9})", url)
    if not found or found.group(1).lower() != where["repository"].lower():
        raise IdeaError("GitHub did not give the new issue's address. Look on GitHub before filing it again, so it is not filed twice.")
    return {"filed": True, "repository": where["repository"], "number": int(found.group(2)), "url": url,
            "title": text["title"], "label_note": LABEL_NOTE, "not_a_promise": NOT_A_PROMISE}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="idea.py", description="File one idea as a GitHub issue in MACH's idea template, with no label.")
    parser.add_argument("--project", type=Path, default=None, help="the project folder (default: the current folder)")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, func, words in (("check", cmd_check, "what would be filed, and whether it can be filed here; changes nothing"),
                              ("file", cmd_file, "create the issue (only after the person said yes to the exact text)")):
        p = sub.add_parser(name, help=words)
        p.add_argument("--title", required=True)
        p.add_argument("--body-file", required=True)
        if name == "file":
            p.add_argument("--sha256", required=True, help="the sha256 check printed for the text the person said yes to")
        p.set_defaults(func=func)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    project = (args.project or Path.cwd()).resolve()
    try:
        print(json.dumps(args.func(project, args), indent=2, ensure_ascii=False))
        return 0
    except IdeaError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
