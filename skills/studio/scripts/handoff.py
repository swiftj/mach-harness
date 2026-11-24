"""Product Studio's hand-off (M11): a slice marked ready is saved as a GitHub issue, or, where gh
cannot be used, written to a folder in the draft workspace.

- Where it goes is decided once, before anything is written: GitHub when gh is installed, signed
  in, and the `origin` remote names a GitHub repository; the folder otherwise. A slice already
  saved to GitHub never falls back to the folder, so nothing is half in each place.
- Each step on GitHub is recorded in .factory/studio/issues.json before it is tried, and each
  step looks before it writes, so an interrupted or repeated run never makes a second issue,
  comment or link.
- Only issues carrying MACH's product labels are edited, and only issues Product Studio created
  or found by their marker. Every text sent is a fixed template filled with identifiers, or the
  approved spec and why, or the product manager's own project and epic definitions.
- Issue text read back is data: checked by SHA-256, bounded, never followed.

Standard library only. Imported by studio.py; not a command of its own.
"""

import contextlib
import hashlib
import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence, Tuple

import collab
import issues
import one_writer

SCHEMA_VERSION = 1
WAIT_SECONDS = 5.0
STEPS = ("labels", "project", "epic", "slice", "unique", "approval", "link", "ready")
STUDIO_LABELS = ("mach:project", "mach:epic", "mach:slice", "mach:ready")
BUSY = "Another Product Studio command is saving to GitHub; try again."


class HandoffError(Exception):
    """A refusal studio.py prints; `hint` is the app action that resolves it, `app` its wording for the app when it differs."""

    def __init__(self, message: str, hint: Optional[Dict[str, Any]] = None, app: Optional[str] = None):
        super().__init__(message)
        self.hint = hint
        self.app = app


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def explain(failure: Optional[Dict[str, str]]) -> str:
    """A GitHub failure in plain words; GitHub's own words are quoted as data."""
    if not failure:
        return "GitHub did not answer as expected."  # nothing failed that MACH can name: never said as a network failure
    kind = failure.get("kind", "")
    if kind == "not_ours":
        return str(failure.get("reason"))
    words = {"network": "GitHub could not be reached.",
             "auth": "GitHub did not accept your sign-in on this computer.",
             "sso": "Your organisation requires your GitHub sign-in to be authorised for single sign-on.",
             "rule": "GitHub refused this for your account.",
             "rate_limit": "GitHub is limiting how often this account may ask just now. It lifts by itself, usually within the hour.",
             "unavailable": "GitHub is not answering properly just now.",
             "blocked": "Something on this computer stopped the GitHub tool from reaching GitHub: a proxy, or a sandbox the session runs in.",
             "not_found": "GitHub could not find it.",
             "moved": "The issue has moved to another repository."}.get(kind, "GitHub did not answer as expected.")
    reason = failure.get("reason")
    if kind == "network":
        # Said as it happened: how often it was tried, and the GitHub tool's own words, so a person can tell a passing
        # failure from a setting on this computer that stops the tool reaching GitHub.
        tried = collab.tried_words(failure)
        said = f' The GitHub tool (gh) said: "{collab.bounded(reason, 200)}".' if reason and reason != "no reason given" else ""
        return f"GitHub could not be reached{tried}.{said}"
    return f'{words} GitHub said: "{collab.bounded(reason, 200)}".' if reason and kind != "moved" else words


class Channel:
    """Where a slice marked ready goes: GitHub (with the repository and the signed-in account) or the folder."""

    def __init__(self, kind: str, repository: Optional[str] = None, login: Optional[str] = None, why: str = ""):
        self.kind, self.repository, self.login, self.why = kind, repository, login, why


class Handoff:
    def __init__(self, project: Path, home: Path, draft: Path, rules: Any, write: Callable[[Path, str], None]):
        self.project, self.home, self.draft, self.rules, self._write = project, home, draft, rules, write
        # M20: called to take the project's or an epic's text from GitHub into the workspace: adopt("project", None, fields)
        # or adopt("epic", epic_id, fields). Without it, MACH never takes text in, and so never writes over GitHub's either.
        self.adopt: Optional[Callable[[str, Optional[str], Dict[str, Any]], None]] = None
        self.text_notes: List[Dict[str, Any]] = []  # M20: what happened to the project's and epics' text in this command
        self.chosen: Dict[str, Dict[str, Any]] = {}  # M20: each epic as decided in this command, by epic ID
        self.path = home / "issues.json"
        self.outgoing = home / "outgoing"
        for item in (self.path, self.outgoing, draft / "product" / "ready"):
            if item.is_symlink():
                raise HandoffError(f"{item} is a symbolic link. Product Studio only works in a real folder inside the project.")

    # ---- the record of what was saved where ----

    @contextlib.contextmanager
    def exclusive(self) -> Iterator[None]:
        try:
            with one_writer.held(self.path, WAIT_SECONDS):
                yield
        except one_writer.Busy:
            raise HandoffError(BUSY)

    def load(self) -> Dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict) or data.get("schema_version") != SCHEMA_VERSION:
            data = {}
        clean: Dict[str, Any] = {"schema_version": SCHEMA_VERSION}
        repository = data.get("repository")
        clean["repository"] = repository if self.rules.is_repository(repository) else None
        clean["form"] = data.get("form") if data.get("form") in ("sub_issues", "task_list") else None
        project = data.get("project")
        clean["project"] = project if isinstance(project, dict) and self.rules.is_issue_number(project.get("number")) else None
        clean["epics"] = {key: value for key, value in (data.get("epics") or {}).items()
                          if isinstance(value, dict) and self.rules.is_issue_number(value.get("number"))} if isinstance(data.get("epics"), dict) else {}
        clean["slices"] = {key: value for key, value in (data.get("slices") or {}).items()
                           if isinstance(key, str) and self.rules.SLICE_ID_RE.fullmatch(key) and isinstance(value, dict)} if isinstance(data.get("slices"), dict) else {}
        clean["seen"] = data.get("seen") if isinstance(data.get("seen"), dict) else {}
        clean["order"] = clean_order(data.get("order"), self.rules)
        for kind in SETS:  # the principles (M13) always; the technical needs (M17) only once a project has them
            record = data.get(kind.name) if isinstance(data.get(kind.name), dict) else {}
            if kind.always_seen or record:
                clean[kind.name] = record if not record.get("published") or not self.rules_set(kind).problems(record.get("published")) else {}
        return clean

    def save(self, data: Dict[str, Any]) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        self._write(self.path, json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n")

    def handed_over(self) -> List[str]:
        """The slices this workspace has handed over: marked ready (to GitHub or the folder) or taken from GitHub, at any time
        since, reopened or not. The Factory's copy of one of them, outside the draft workspace, is that same slice. Reads only."""
        data = self.load()
        return sorted(key for key, entry in data["slices"].items()
                      if entry.get("number") or entry.get("ready_at") or entry.get("taken_at") or entry.get("saved"))

    @staticmethod
    def entry(data: Dict[str, Any], slice_id: str) -> Dict[str, Any]:
        found = data["slices"].setdefault(slice_id, {})
        found.setdefault("number", None)
        found.setdefault("id", None)
        found.setdefault("base_revision", 0)
        found.setdefault("shipped", [])
        found.setdefault("run", None)
        found.setdefault("saved", None)
        return found

    def for_repository(self, data: Dict[str, Any], repository: str) -> Dict[str, Any]:
        """The record for this repository. One for another repository is set aside: nothing there is ever written to."""
        if data.get("repository") not in (None, repository):
            data.update(repository=repository, form=None, project=None, epics={}, seen={},
                        slices={key: {**value, "number": None, "id": None, "run": None, "shipped": []}
                                for key, value in data["slices"].items() if value.get("saved") == "folder"},
                        **{kind.name: data[kind.name] if data[kind.name].get("saved") == "folder" else {} for kind in SETS if kind.name in data})
        data["repository"] = repository
        return data

    # ---- where it goes ----

    def channel(self) -> Channel:
        """GitHub or the folder, decided before anything is written. A passing failure (no
        network) is refused rather than sent to the folder, so one slice never ends up in both."""
        if shutil.which("gh") is None:
            return Channel("folder", why="The GitHub tool (gh) is not installed on this computer.")
        repository, failure = collab.request_repository(self.project)
        if repository is None and failure is None:
            return Channel("folder", why="This project is not connected to a GitHub repository.")
        if failure and failure.get("kind") == "auth":
            return Channel("folder", why="You are not signed in to GitHub on this computer.")
        if failure:
            raise HandoffError(f"Nothing was saved. {explain(failure)} Try again when GitHub can be reached.")
        login, failure = issues.signed_in(self.project)
        if failure and failure.get("kind") == "auth":
            return Channel("folder", why="You are not signed in to GitHub on this computer.")
        if failure or not login:
            raise HandoffError(f"Nothing was saved. {explain(failure)} Try again when GitHub can be reached.")
        return Channel("github", repository=repository, login=login)

    # ---- reading what is on GitHub ----

    def snapshot(self, repository: str) -> Dict[str, Any]:
        """The project, epic and slice issues, read once. Refuses on any failure: nothing is
        written on a partial picture."""
        found, failure = self.read(repository)
        if failure or found is None:
            raise HandoffError(f"Nothing was saved. {explain(failure)} Try again when GitHub can be reached.")
        return found

    def read(self, repository: str) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, str]]]:
        found: Dict[str, Any] = {}
        for label in ("mach:project", "mach:epic", "mach:slice"):
            listed, failure = issues.list_issues(self.project, repository, label)
            if failure:
                return None, failure
            found[label] = listed or []
        slices = []
        for item in found["mach:slice"]:
            marker = self.rules.parse_slice_body(item.get("body"))
            if marker:
                slices.append({"number": item["number"], "state": str(item.get("state") or "").lower(), "labels": issues.label_names(item),
                               "title": item.get("title"), "marker": marker, "url": item.get("url")})
        tagged = {}
        for label, kind in (("mach:project", "project"), ("mach:epic", "epic")):
            tagged[kind] = [{"number": item["number"], "id": (self.rules.product_marker(item.get("body")) or ("", None))[1],
                             "kind": (self.rules.product_marker(item.get("body")) or (None,))[0], "title": item.get("title"),
                             "body": item.get("body"), "state": str(item.get("state") or "").lower()} for item in found[label]]
        return {"slices": slices, "projects": [p for p in tagged["project"] if p["kind"] == "project"],
                "epics": [e for e in tagged["epic"] if e["kind"] == "epic"]}, None

    def own_issue(self, data: Dict[str, Any], slice_id: str, snapshot: Dict[str, Any], spec_sha: str, why_sha: str) -> Tuple[Optional[Dict[str, Any]], List[int]]:
        """This slice's own open issue, if it has one, and the numbers of issues holding its ID that are not its own."""
        entry = self.entry(data, slice_id)
        run = entry.get("run") or {}
        candidates = [item for item in snapshot["slices"] if item["marker"]["slice_id"] == slice_id]
        mine = [item for item in candidates if item["number"] == entry.get("number") and item["number"] not in entry["shipped"]]
        if not mine and not entry.get("number") and run.get("steps", {}).get("slice") == "trying":
            # Created by the interrupted run: the same revision and the same text.
            mine = [item for item in candidates if item["state"] == "open" and item["marker"]["revision"] == run.get("revision")
                    and (item["marker"]["spec_sha256"], item["marker"]["why_sha256"]) == (spec_sha, why_sha)][:1]
        own = mine[0] if mine else None
        others = [item["number"] for item in candidates if item is not own and item["number"] not in entry["shipped"]
                  and item["number"] != entry.get("number")]
        return own, others

    # ---- marking ready on GitHub ----

    def prepare(self, data: Dict[str, Any], channel: Channel, slice_id: str, title: str, epic: Dict[str, Any], project: Dict[str, Any],
                dependencies: Sequence[str], why: str, spec: str, jira: Optional[str] = None, mocks: Optional[List[Dict[str, Any]]] = None,
                small: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Every read and every decision before the first write. Returns the plan of the run, or refuses. A changed
        Jira key (M13), a changed set of design mocks (M14 C) or a changed small-change record (M18) is a change like a
        changed spec: a new revision."""
        data = self.for_repository(data, str(channel.repository))
        snapshot = self.snapshot(str(channel.repository))
        self.remember(data, snapshot)
        self.save(data)
        spec_sha, why_sha = self.rules.text_sha256_of(spec), self.rules.text_sha256_of(why)
        mocks_sha = self.rules.mocks_sha256(mocks) if mocks else None  # M14 C: the digest the marker and the approval carry
        entry = self.entry(data, slice_id)
        own, others = self.own_issue(data, slice_id, snapshot, spec_sha, why_sha)
        if others and not own:
            raise HandoffError(f"{slice_id} is already used on GitHub by another slice (#{others[0]}). Give your draft a new number, then mark it ready.",
                               {"kind": "renumber_slice", "target": slice_id})
        run = entry.get("run") or {}
        if own:
            marker = own["marker"]
            same = ((marker["spec_sha256"], marker["why_sha256"], marker.get("jira"), marker.get("mocks_sha256"), marker.get("small"))
                    == (spec_sha, why_sha, jira, mocks_sha, small))
            if marker["revision"] > entry["base_revision"] and not same and marker["revision"] != run.get("revision"):
                raise HandoffError(f"Someone else saved a newer version of {slice_id} on GitHub (version {marker['revision']}). "
                                   f"Choose yours or theirs before marking it ready.", {"kind": "reconcile", "target": slice_id})
            if "mach:shipped" in own["labels"] or own["state"] == "closed":
                if same:
                    raise HandoffError(f"{slice_id} has already shipped as #{own['number']}, exactly as it is. To change it, reopen it first.",
                                       {"kind": "reopen_slice", "target": slice_id})
                entry["shipped"] = sorted(set(entry["shipped"]) | {own["number"]})
                follows, own = own["number"], None
            else:
                follows = None
            revision = marker["revision"] if own and same else max(entry["base_revision"], marker["revision"]) + 1
        else:
            follows = max(entry["shipped"]) if entry["shipped"] else None
            revision = (run.get("revision") if run.get("spec_sha256") == spec_sha and run.get("why_sha256") == why_sha and run.get("jira") == jira
                        and run.get("mocks_sha256") == mocks_sha and run.get("small") == small and run.get("revision") else entry["base_revision"] + 1)
        depends = []
        for dependency in dependencies:
            number = self.published_number(data, snapshot, dependency)
            if number is None:
                raise HandoffError(f"{slice_id} depends on {dependency}, which is not ready yet. Mark {dependency} ready first.",
                                   {"kind": "mark_ready", "target": dependency})
            depends.append(number)
        epic_issue = self.find_epic(data, snapshot, epic)
        project_issue = self.find_project(data, snapshot, project)
        body = self.rules.slice_issue_body(slice_id, revision, epic_issue or 999999999, depends, why, spec, follows, jira, mocks, small)
        if len(body) > self.rules.ISSUE_BODY_LIMIT:
            raise HandoffError(too_large(slice_id, len(body), self.rules.ISSUE_BODY_LIMIT))
        same_run = (run.get("revision") == revision and run.get("spec_sha256") == spec_sha and run.get("why_sha256") == why_sha and run.get("jira") == jira
                    and run.get("mocks_sha256") == mocks_sha and run.get("small") == small)
        entry["run"] = {"revision": revision, "spec_sha256": spec_sha, "why_sha256": why_sha, "jira": jira, "login": channel.login,
                        **({"mocks": list(mocks), "mocks_sha256": mocks_sha} if mocks else {}),
                        **({"small": dict(small)} if small else {}),  # M18: only a small change
                        "depends": depends, "follows": follows, "title": title, "epic_id": epic["epic_id"],
                        "steps": dict(run.get("steps") or {}) if same_run else {}, "started_at": run.get("started_at") if same_run else utc_now()}
        if own:
            entry["number"] = own["number"]
        else:  # no issue of its own: one is made, and every step after the epic is done again
            entry["number"], entry["id"] = None, None
            for name in ("slice", "approval", "link", "ready"):
                if entry["run"]["steps"].get(name) == "done":
                    del entry["run"]["steps"][name]
        data["_snapshot"] = snapshot
        data["_targets"] = {"epic": epic_issue, "project": project_issue}
        return data

    def published_number(self, data: Dict[str, Any], snapshot: Dict[str, Any], slice_id: str) -> Optional[int]:
        entry = data["slices"].get(slice_id) or {}
        if entry.get("saved") == "github" and entry.get("number"):
            return entry["number"]
        listed = sorted((item for item in snapshot["slices"] if item["marker"]["slice_id"] == slice_id), key=lambda item: item["number"])
        return listed[-1]["number"] if listed else None

    def find_project(self, data: Dict[str, Any], snapshot: Dict[str, Any], project: Dict[str, Any]) -> Optional[int]:
        several = sorted(item["number"] for item in snapshot["projects"] if item["state"] == "open")
        if len(several) > 1:
            raise HandoffError(several_projects(several), several_hint(self.rules, data.get("repository"), several))
        linked = data.get("project") or {}
        if linked.get("number") in [item["number"] for item in snapshot["projects"]]:
            return linked["number"]
        same = sorted(item["number"] for item in snapshot["projects"] if item["id"] == project["project_id"] and item["state"] == "open")
        other = [item for item in snapshot["projects"] if item["id"] != project["project_id"] and item["state"] == "open"]
        if not same and other:
            raise HandoffError(f"This repository's project on GitHub is a different one ({other[0]['id']}, #{other[0]['number']}). "
                               "An engineer needs to look at this before anything is saved.")
        return same[0] if same else None

    def find_epic(self, data: Dict[str, Any], snapshot: Dict[str, Any], epic: Dict[str, Any]) -> Optional[int]:
        epic_id = epic["epic_id"]
        linked = (data["epics"].get(epic_id) or {}).get("number")
        if linked in [item["number"] for item in snapshot["epics"]]:
            return linked
        same_id = [item for item in snapshot["epics"] if item["id"] == epic_id]
        title = self.rules.issue_title(epic.get("title"))
        matching = sorted(item["number"] for item in same_id if item.get("title") == title)
        if same_id and not matching:
            raise HandoffError(f"{epic_id} is already used on GitHub by another epic (#{same_id[0]['number']}). Give your epic a new number first.",
                               {"kind": "renumber_epic", "target": epic_id})
        return matching[0] if matching else None

    def remember(self, data: Dict[str, Any], snapshot: Dict[str, Any]) -> None:
        """Keep the slice IDs GitHub uses, so a new draft never takes one of them."""
        seen = data.setdefault("seen", {})
        seen["taken"] = sorted({item["marker"]["slice_id"] for item in snapshot["slices"]})

    def run(self, data: Dict[str, Any], channel: Channel, slice_id: str, project: Dict[str, Any], epic: Dict[str, Any],
            why: str, spec: str) -> Dict[str, Any]:
        """The steps on GitHub, each recorded before it is tried. Stops at the first failure with
        everything done so far kept; running it again finishes it."""
        repository = str(channel.repository)
        snapshot, targets = data.pop("_snapshot"), data.pop("_targets")
        entry = self.entry(data, slice_id)
        run = entry["run"]
        steps = run["steps"]

        def step(name: str) -> bool:
            if steps.get(name) == "done":
                return False
            steps[name] = "trying"
            self.save(data)
            return True

        def finished(name: str) -> None:
            steps[name] = "done"
            self.save(data)

        def stop(failure: Optional[Dict[str, str]]) -> None:
            self.save(data)
            raise HandoffError(f"{slice_id} is approved, but saving it to GitHub stopped part way. {explain(failure)} "
                               "Mark it ready again to finish; nothing will be made twice.", {"kind": "finish_ready", "target": slice_id})

        if step("labels"):
            have, failure = issues.labels(self.project, repository)
            if failure:
                stop(failure)
            for name in [name for name in STUDIO_LABELS if name not in (have or [])]:
                spec_of = self.rules.PRODUCT_LABELS[name]
                failure = issues.create_label(self.project, repository, name, spec_of["color"], spec_of["description"])
                if failure:
                    stop(failure)
            finished("labels")

        if step("project"):
            number = targets["project"] or (data.get("project") or {}).get("number")
            if number is None:
                failure = self.write_project(data, repository, None, project, self.kept(data, None))
            else:
                failure = self.sync_project(data, repository, number, project, snapshot)
            if failure:
                stop(failure)
            finished("project")

        epic_number = targets["epic"] or (data["epics"].get(epic["epic_id"]) or {}).get("number")
        title = self.rules.issue_title(epic.get("title"))
        if step("epic"):
            item = next((found for found in snapshot["epics"] if found["number"] == epic_number), None) if epic_number else None
            if epic_number is None:
                epic_number, failure = self.ensure(repository, None, title, self.rules.epic_issue_body(epic["epic_id"], epic.get("acceptance_criteria") or []),
                                                   ["mach:epic"], "mach:epic", f"epic-{epic['epic_id']}")
                if failure:
                    stop(failure)
                data["epics"][epic["epic_id"]] = {"number": epic_number, "text_sha256": epic_sha(title, epic.get("acceptance_criteria"))}
                self.save(data)
                # M20: look again. Another product manager may have made this epic's issue at the same moment.
                earlier, failure = self.earlier_open(repository, "mach:epic", lambda found: found["kind"] == "epic" and found["id"] == epic["epic_id"], epic_number)
                if failure:
                    stop(failure)
                if earlier:
                    failure = self.stand_down(repository, epic_number, "epic", epic["epic_id"], earlier["number"])
                    if failure:
                        stop(failure)
                    if earlier.get("title") != title:
                        data["epics"].pop(epic["epic_id"], None)
                        entry["run"] = None
                        # Kept so status can offer the renumber until it is done or the clash is gone at a refresh.
                        data.setdefault("seen", {}).setdefault("epic_lost", {})[epic["epic_id"]] = {
                            "issue": epic_number, "holder": earlier["number"], "by": None, "at": utc_now()}
                        self.save(data)
                        raise lost_error(epic_lost_words(epic["epic_id"], epic_number, earlier["number"]), {"kind": "renumber_epic", "target": epic["epic_id"]})
                    epic_number, item = earlier["number"], earlier  # the same epic, made twice at once: the issue GitHub made first is kept
                    data["epics"][epic["epic_id"]] = {"number": epic_number}
                    self.save(data)
            # An epic not read with MACH's label is written as before, which leaves an issue no longer MACH's alone.
            chosen, write = self.sync_epic(data, epic, epic_number, item) if item is not None else (epic, True)
            if write:
                _, failure = self.ensure(repository, epic_number, title, self.rules.epic_issue_body(epic["epic_id"], chosen.get("acceptance_criteria") or []),
                                         ["mach:epic"], "mach:epic", f"epic-{epic['epic_id']}")
                if failure:
                    stop(failure)
                data["epics"][epic["epic_id"]]["text_sha256"] = epic_sha(title, chosen.get("acceptance_criteria"))
                data.setdefault("seen", {}).setdefault("text_changed", {}).pop(epic["epic_id"], None)
            if data.get("form") is None:
                _, failure = issues.sub_issues(self.project, repository, epic_number)
                if failure and not issues.unavailable(failure):
                    stop(failure)
                data["form"] = "task_list" if failure else "sub_issues"
                data["form_decided_at"] = utc_now()
            if data["form"] == "task_list":
                _, failure = self.ensure(repository, epic_number, title, self.epic_body(chosen, epic_number, snapshot, entry, slice_id, entry.get("number")),
                                         ["mach:epic"], "mach:epic", f"epic-{epic['epic_id']}")
                if failure:
                    stop(failure)
            finished("epic")
        epic_number = data["epics"][epic["epic_id"]]["number"]
        epic = self.epic_to_write(data, epic)  # the criteria the epic's task list is written with: GitHub's unless this workspace's may replace them

        if step("slice"):
            body = self.rules.slice_issue_body(slice_id, run["revision"], epic_number, run["depends"], why, spec, run.get("follows"), run.get("jira"), run.get("mocks"),
                                               run.get("small"))
            title = self.rules.issue_title(run["title"])
            names = ["mach:slice"]
            number, failure = self.ensure(repository, entry.get("number"), title, body, names, "mach:slice", f"slice-{slice_id}")
            if failure:
                stop(failure)
            entry["number"] = number
            finished("slice")

        if step("unique"):
            # M20: look again, before the approval and mach:ready. Another product manager may have made an issue holding this
            # slice ID at the same moment; the one GitHub made first keeps the number, and this one is closed, never ready.
            shipped = set(entry["shipped"])
            earlier, failure = self.earlier_open(repository, "mach:slice", lambda found: found["marker"]["slice_id"] == slice_id
                                                 and found["number"] not in shipped and "mach:shipped" not in found["labels"], entry["number"])
            if failure:
                stop(failure)
            if earlier:
                self.lose_slice(data, repository, slice_id, earlier["number"])
            finished("unique")
        number = entry["number"]

        if step("approval"):
            found, failure = issues.comments(self.project, repository, number)
            if failure:
                stop(failure)
            wanted = {"slice_id": slice_id, "revision": run["revision"], "by": run["login"], "spec_sha256": run["spec_sha256"], "why_sha256": run["why_sha256"],
                      **({"jira": run["jira"]} if run.get("jira") else {}), **({"mocks_sha256": run["mocks_sha256"]} if run.get("mocks_sha256") else {}),
                      **({"small": run["small"]} if run.get("small") else {})}
            mine = [c["body"] for c in found or [] if c.get("login") == run["login"]]
            if wanted not in self.rules.approvals(mine):
                failure = issues.comment(self.project, repository, number,
                                         self.outgoing_file("approval", self.rules.approval_comment(slice_id, run["revision"], run["login"], run["spec_sha256"], run["why_sha256"],
                                                                                                    run.get("jira"), run.get("mocks_sha256"), run.get("small"))))
                if failure:
                    stop(failure)
            finished("approval")

        if step("link"):
            failure = self.link(data, repository, epic, epic_number, slice_id, number, snapshot)
            if failure:
                stop(failure)
            finished("link")

        if step("ready"):
            current, failure = issues.view(self.project, repository, number)
            if failure:
                stop(failure)
            if issues.READY not in issues.label_names(current or {}):
                failure = issues.add_labels(self.project, repository, number, [issues.READY])
                if failure:
                    stop(failure)
            finished("ready")

        entry.update(saved="github", revision=run["revision"], base_revision=run["revision"], spec_sha256=run["spec_sha256"],
                     why_sha256=run["why_sha256"], jira=run.get("jira"), approved_by=run["login"], ready_at=utc_now(), run=None)
        if run.get("mocks_sha256") or entry.get("mocks_sha256"):
            entry["mocks_sha256"] = run.get("mocks_sha256")  # M14 C: kept only once a slice has had mocks
        if run.get("small") or entry.get("small"):
            entry["small"] = run.get("small")  # M18: kept only once a slice has been a small change
        # What was just written is what the issue now says, without waiting for the next refresh.
        seen_rows = data.setdefault("seen", {}).setdefault("slices", {}).setdefault(slice_id, [])
        row = next((item for item in seen_rows if item.get("issue") == number), None)
        if row is None:
            row = {"issue": number, "state": "open", "title": self.rules.list_title(run.get("title") or slice_id), "epic_issue": epic_number}
            seen_rows.append(row)
        labels = [name for name in self.rules.SLICE_STATE_LABELS if name == row.get("state_label") and name != "mach:question"]
        row.update(state_label="mach:building" if "mach:building" in labels else "mach:ready", revision=run["revision"], matches_approval=True,
                   approved_by=run["login"], question=None, times={**(row.get("times") or {}), "marked_ready": entry["ready_at"], "question": None})
        self.save(data)
        return {"issue": number, "url": self.rules.issue_url(repository, number), "revision": entry["revision"],
                "follows": run.get("follows"), "epic_issue": epic_number, "project_issue": data["project"]["number"]}

    def write_project(self, data: Dict[str, Any], repository: str, number: Optional[int], project: Dict[str, Any],
                      sections: Dict[str, Optional[Dict[str, Any]]], keep_seen: bool = False) -> Optional[Dict[str, str]]:
        """Create the project's issue, or bring its title and body up to date, with the published sections given (the principles
        and the technical needs, from kept()). Pinned once. `project` carries the text to write; what this workspace last saw of
        it becomes that text, unless `keep_seen` (GitHub's text was written back while someone else's change waits for a choice)."""
        body = self.rules.project_issue_body(project["project_id"], project.get("vision") or "", project.get("outcomes") or [],
                                             sections.get("principles"), sections.get("needs"))
        title = self.rules.issue_title(project.get("name"))
        made = number is None
        number, failure = self.ensure(repository, number, title, body, ["mach:project"], "mach:project", f"project-{project['project_id']}")
        if failure:
            return failure
        data["project"] = {**(data.get("project") or {}), "number": number}
        if not keep_seen:
            data["project"]["text_sha256"] = project_sha(title, project.get("vision"), project.get("outcomes"))
            data.setdefault("seen", {}).setdefault("text_changed", {}).pop("project", None)
        if made:
            self.save(data)
            # M20: look again. Someone else may have made the project's issue at the same moment; the one GitHub made first is kept.
            earlier, failure = self.earlier_open(repository, "mach:project", lambda found: found["kind"] == "project", number)
            if failure:
                return failure
            if earlier:
                failure = self.stand_down(repository, number, "project", project["project_id"], earlier["number"])
                if failure:
                    return failure
                data["project"] = {"number": earlier["number"], "pin_tried": True, "pinned": None}
                self.save(data)
                if earlier["id"] != project["project_id"]:
                    raise HandoffError(f"This repository's project on GitHub is a different one ({earlier['id']}, #{earlier['number']}). "
                                       "An engineer needs to look at this before anything is saved.")
                return self.sync_project(data, repository, earlier["number"], project, {"projects": [earlier]})
        if not data["project"].get("pin_tried"):
            # Pinned once. A repository holds only a few pinned issues, so not pinning stops nothing.
            data["project"].update(pin_tried=True, pinned=issues.pin(self.project, repository, number) is None)
        return None

    def kept(self, data: Dict[str, Any], body: Any) -> Dict[str, Optional[Dict[str, Any]]]:
        """The published sections a rewrite of the project's issue keeps, each set on its own (M13 principles, M17 needs): the
        one on GitHub when it is intact and not older than what this workspace published, else this workspace's own published
        set, else none. Marking a slice ready, or publishing one set, never changes the other."""
        found: Dict[str, Optional[Dict[str, Any]]] = {}
        for kind in SETS:
            theirs = self.rules_set(kind).parse(body)
            record = data.get(kind.name) or {}
            mine = kind.section_of(record["revision"], record["published"], record.get(kind.extra)) if record.get("saved") == "github" and record.get("published") else None
            if theirs and theirs["intact"] and (mine is None or theirs["revision"] >= mine["revision"]):
                mine = kind.section_of(theirs["revision"], theirs["items"], theirs["extra"])
            found[kind.name] = mine
        return found

    # ---- M20: shared text, and an ID made twice at the same moment ----

    def project_choice(self, data: Dict[str, Any], item: Optional[Dict[str, Any]], project: Dict[str, Any]) -> Tuple[str, Optional[Dict[str, Any]]]:
        """What to do with the project's text on its issue: ("same"|"take"|"write"|"changed", GitHub's text or None when it is
        not in MACH's form). It is written over only when GitHub still holds what this workspace last saw there."""
        title = self.rules.issue_title(project.get("name"))
        mine = project_sha(title, project.get("vision"), project.get("outcomes"))
        theirs = parse_project_text(item) if item else None
        seen = (data.get("project") or {}).get("text_sha256")
        return text_plan(seen, mine, project_sha(theirs["name"], theirs["vision"], theirs["outcomes"]) if theirs else None,
                         raw_sha(item)), theirs

    def sync_project(self, data: Dict[str, Any], repository: str, number: int, project: Dict[str, Any], snapshot: Dict[str, Any]) -> Optional[Dict[str, str]]:
        """Slice ready (and the look-again): bring the project's issue and this workspace into step without writing over anyone."""
        item = next((found for found in snapshot.get("projects") or [] if found["number"] == number), None)
        if item is None:  # not read with MACH's label: written as before, which leaves an issue no longer MACH's alone
            return self.write_project(data, repository, number, project, self.kept(data, None))
        data["project"] = {**(data.get("project") or {}), "number": number}
        plan, theirs = self.project_choice(data, item, project)
        if plan == "write":
            return self.write_project(data, repository, number, project, self.kept(data, item.get("body")))
        self.settle_text(data, "project", None, number, plan, theirs, raw_sha(item))
        if not data["project"].get("pin_tried"):  # made by a run whose answer was lost: pinned once, as when it is made
            data["project"].update(pin_tried=True, pinned=issues.pin(self.project, repository, number) is None)
        return None

    def epic_choice(self, data: Dict[str, Any], epic: Dict[str, Any], item: Dict[str, Any]) -> Tuple[str, Optional[Dict[str, Any]]]:
        title = self.rules.issue_title(epic.get("title"))
        theirs = parse_epic_text(item)
        seen = (data["epics"].get(epic["epic_id"]) or {}).get("text_sha256")
        return text_plan(seen, epic_sha(title, epic.get("acceptance_criteria")), epic_sha(theirs["title"], theirs["acceptance_criteria"]) if theirs else None,
                         raw_sha(item)), theirs

    def sync_epic(self, data: Dict[str, Any], epic: Dict[str, Any], number: int, item: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
        """The epic as it is to be written, and whether this workspace's criteria may replace GitHub's."""
        plan, theirs = self.epic_choice(data, epic, item)
        if plan == "write":
            self.chosen[epic["epic_id"]] = epic
            return epic, True
        self.settle_text(data, "epic", epic["epic_id"], number, plan, theirs, raw_sha(item))
        chosen = {**epic, "acceptance_criteria": list(theirs["acceptance_criteria"])} if theirs else epic
        self.chosen[epic["epic_id"]] = chosen
        return chosen, False

    def epic_to_write(self, data: Dict[str, Any], epic: Dict[str, Any]) -> Dict[str, Any]:
        """The epic's criteria as the task list rewrites them: as decided in this command, else GitHub's while someone else's change
        waits for a choice, else this workspace's."""
        if epic["epic_id"] in self.chosen:
            return self.chosen[epic["epic_id"]]
        waiting = ((data.get("seen") or {}).get("text_changed") or {}).get(epic["epic_id"]) or {}
        return {**epic, "acceptance_criteria": list(waiting["acceptance_criteria"])} if waiting.get("acceptance_criteria") is not None else epic

    def settle_text(self, data: Dict[str, Any], kind: str, epic_id: Optional[str], number: int, plan: str, theirs: Optional[Dict[str, Any]],
                    raw: Optional[str]) -> None:
        """Record what was decided for text this workspace does not write: the same as GitHub's, taken from GitHub, or changed by someone
        else and waiting for the product manager's choice (reconcile)."""
        key = epic_id or "project"
        record = data["project"] if kind == "project" else data["epics"].setdefault(str(epic_id), {"number": number})
        waiting = data.setdefault("seen", {}).setdefault("text_changed", {})
        if plan == "take" and theirs and self.adopt is None:
            plan = "changed"  # nothing here can take it in, so nothing is written over either
        if plan in ("same", "take") and theirs:
            if plan == "take":
                self.adopt(kind, epic_id, theirs)  # type: ignore[misc]
                self.text_notes.append({"kind": kind, "target": key, "issue": number, "taken": True})
            record["text_sha256"] = (project_sha(theirs["name"], theirs["vision"], theirs["outcomes"]) if kind == "project"
                                     else epic_sha(theirs["title"], theirs["acceptance_criteria"]))
            waiting.pop(key, None)
        else:
            waiting[key] = {"issue": number, "readable": theirs is not None, "raw_sha256": raw, "read_at": utc_now(), **(theirs or {})}
            self.text_notes.append({"kind": kind, "target": key, "issue": number, "changed": True})

    def listed_now(self, repository: str, label: str) -> Tuple[Optional[List[Dict[str, Any]]], Optional[Dict[str, str]]]:
        """One label's issues read again, in the shape read() gives them."""
        listed, failure = issues.list_issues(self.project, repository, label)
        if failure:
            return None, failure
        found = []
        for item in listed or []:
            state = str(item.get("state") or "").lower()
            if label == "mach:slice":
                marker = self.rules.parse_slice_body(item.get("body"))
                if marker:
                    found.append({"number": item["number"], "state": state, "labels": issues.label_names(item), "title": item.get("title"), "marker": marker})
            else:
                kind, ident = self.rules.product_marker(item.get("body")) or (None, None)
                found.append({"number": item["number"], "id": ident, "kind": kind, "title": item.get("title"), "body": item.get("body"), "state": state,
                              "labels": issues.label_names(item)})
        return found, None

    def earlier_open(self, repository: str, label: str, same: Callable[[Dict[str, Any]], bool], number: int) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, str]]]:
        """The first open issue GitHub made before `number` that holds the same ID, read again now; None when there is none."""
        found, failure = self.listed_now(repository, label)
        if failure:
            return None, failure
        earlier = sorted((item for item in found or [] if item["state"] == "open" and item["number"] < number and same(item)), key=lambda item: item["number"])
        return (earlier[0] if earlier else None), None

    def stand_down(self, repository: str, number: int, kind: str, ident: str, holder: int) -> Optional[Dict[str, str]]:
        """Close an issue this workspace made at the same moment as `holder`, with a comment from a fixed template, and take MACH's
        labels off it, so neither Product Studio nor the Factory reads it again. Looks before each write."""
        marker = f"<!-- mach:closed {kind}={ident} kept=#{int(holder)} -->"
        found, failure = issues.comments(self.project, repository, number)
        if failure:
            return failure
        if not any(marker in (c.get("body") or "") for c in found or []):
            what = "this repository's project" if kind == "project" else ident
            text = (f"{marker}\nMACH Product Studio closed this issue. It was made at the same moment as #{int(holder)}, which already holds {what}. "
                    f"#{int(holder)} is kept; MACH does not read this issue again.\n")
            failure = issues.comment(self.project, repository, number, self.outgoing_file(f"closed-{kind}-{ident}", text))
            if failure:
                return failure
        current, failure = issues.view(self.project, repository, number)
        if failure:
            return failure
        names = [name for name in (f"mach:{kind}", issues.READY) if name in issues.label_names(current or {})]
        if names or str((current or {}).get("state") or "").lower() != "closed":
            return issues.stand_down(self.project, repository, number, names)
        return None

    def lose_slice(self, data: Dict[str, Any], repository: str, slice_id: str, holder: int) -> None:
        """This workspace's issue for `slice_id` was made after another open one holding the same ID: close it (it never became
        ready), forget it, and refuse in plain words with the renumber that already exists."""
        entry = self.entry(data, slice_id)
        number = entry["number"]
        found, failure = issues.comments(self.project, repository, holder)
        approvals = [a for a in self.rules.approvals([c["body"] for c in found or []]) if a["slice_id"] == slice_id] if not failure else []
        by = approvals[-1]["by"] if approvals else None
        entry["lost"] = {"issue": number, "holder": holder, "by": by, "at": utc_now(), "closed": False}
        self.save(data)
        failure = self.stand_down(repository, number, "slice", slice_id, holder)
        if failure:
            raise HandoffError(f"{slice_id} is already held on GitHub by #{holder}, made at the same moment as yours (#{number}). Yours was not marked ready, "
                               f"but closing it stopped part way. {explain(failure)} Mark it ready again to finish closing it.", {"kind": "finish_ready", "target": slice_id})
        entry.update(number=None, id=None, run=None, saved=None)
        entry["lost"]["closed"] = True
        self.save(data)
        raise lost_error(slice_lost_words(slice_id, number, holder, by, app=False), {"kind": "renumber_slice", "target": slice_id},
                         slice_lost_words(slice_id, number, holder, by, app=True))

    def clashes(self, data: Dict[str, Any], repository: str, snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
        """For refresh: IDs held by more than one open issue (made at the same moment and missed then). This workspace's own later
        slice issue is closed here unless the builders already took it; everything else is only reported."""
        found: List[Dict[str, Any]] = []
        by_slice: Dict[str, List[Dict[str, Any]]] = {}
        for item in snapshot["slices"]:
            if item["state"] == "open" and "mach:shipped" not in item["labels"]:
                by_slice.setdefault(item["marker"]["slice_id"], []).append(item)
        closed: List[int] = []
        for slice_id, items in sorted(by_slice.items()):
            if len(items) < 2:
                continue
            items.sort(key=lambda item: item["number"])
            holder, later = items[0], items[1:]
            entry = data["slices"].get(slice_id) or {}
            yours = "kept" if entry.get("number") == holder["number"] else None
            for item in later:
                if entry.get("number") != item["number"] or entry.get("taken_at"):
                    continue  # only an issue this workspace made itself is closed here; one opened from GitHub is someone else's
                taken = [name for name in ("mach:building", "mach:question") if name in item["labels"]]
                if taken:
                    yours = "taken_by_builders"
                    continue
                failure = self.stand_down(repository, item["number"], "slice", slice_id, holder["number"])
                if failure:
                    yours = "not_closed"
                    continue
                entry.update(number=None, id=None, run=None, saved=None,
                             lost={"issue": item["number"], "holder": holder["number"], "by": None, "at": utc_now(), "closed": True})
                closed.append(item["number"])
                yours = "closed"
            found.append({"kind": "slice", "id": slice_id, "kept": holder["number"], "others": [item["number"] for item in later], "yours": yours,
                          "urls": issue_urls(self.rules, repository, [holder["number"], *(item["number"] for item in later)])})
        snapshot["slices"] = [item for item in snapshot["slices"] if item["number"] not in closed]
        by_epic: Dict[str, List[int]] = {}
        for item in snapshot["epics"]:
            if item["state"] == "open" and self.rules.EPIC_ID_RE.fullmatch(str(item["id"])):
                by_epic.setdefault(item["id"], []).append(item["number"])
        for epic_id, numbers in sorted(by_epic.items()):
            if len(numbers) > 1:
                numbers.sort()
                linked = (data["epics"].get(epic_id) or {}).get("number")
                found.append({"kind": "epic", "id": epic_id, "kept": numbers[0], "others": numbers[1:],
                              "yours": "kept" if linked == numbers[0] else "other" if linked in numbers[1:] else None,
                              "urls": issue_urls(self.rules, repository, numbers)})
        projects = sorted(item["number"] for item in snapshot["projects"] if item["state"] == "open")
        if len(projects) > 1:
            found.append({"kind": "project", "id": None, "kept": None, "others": projects, "yours": None,
                          "urls": issue_urls(self.rules, repository, projects)})
        for clash in found:
            clash["note"] = clash_note(clash)
        return found

    # ---- published sets: the product principles (M13) and the technical needs (M17) ----

    def rules_set(self, kind: "PublishedKind") -> Any:
        """issue_rules' PublishedSet for this kind: the section, its marker, the approval and the checks."""
        return getattr(self.rules, kind.rules_name)

    def set_folder(self, kind: "PublishedKind") -> Path:
        return self.draft / "product" / "ready" / kind.folder

    def publish_set(self, kind: "PublishedKind", project: Dict[str, Any], items: List[Dict[str, Any]], extra: Any = None) -> Dict[str, Any]:
        """Save a set: on the project's GitHub issue, in its fixed section, with an approval comment carrying its SHA-256 and the
        product manager's login; or, where gh cannot be used, as product/ready/<FOLDER>/<name>.json in the workspace. Each step
        on GitHub is recorded before it is tried and looks before it writes. The other set's section is kept as it is."""
        rules_set = self.rules_set(kind)
        sha = rules_set.sha256(items)
        with self.exclusive():
            data = self.load()
            channel = self.channel()  # GitHub or the folder, decided before anything is written
            record = data.setdefault(kind.name, {})
            if channel.kind == "folder":
                if record.get("saved") == "github" or record.get("run"):
                    raise HandoffError(f"{kind.words.capitalize()} are already saved on GitHub, and GitHub cannot be used from here: {channel.why} "
                                       "Nothing was saved. Publish them on a computer signed in to GitHub.")
                same = kind.same(record.get("sha256"), record.get(kind.extra), sha, extra) and record.get("saved") == "folder"
                revision = record["revision"] if same else int(record.get("base_revision") or 0) + 1
                self.write_set_folder(kind, revision, sha, items, extra)
                record.update(saved="folder", revision=revision, base_revision=revision, sha256=sha, published=items, approved_by=None,
                              published_at=utc_now(), issue=None, run=None, **kind.extra_field(extra))
                self.save(data)
                return {"saved_to": "folder", "revision": revision, "sha256": sha, "folder": str(self.set_folder(kind)), "why_folder": channel.why}
            repository = str(channel.repository)
            data = self.for_repository(data, repository)
            record = data.setdefault(kind.name, {})
            snapshot = self.snapshot(repository)
            self.remember(data, snapshot)
            number = self.find_project(data, snapshot, project)
            body_now = project_body(snapshot, number)
            theirs = rules_set.parse(body_now)
            run = record.get("run") or {}
            base = int(record.get("base_revision") or 0)
            if theirs and theirs["intact"] and kind.same(theirs["sha256"], theirs["extra"], sha, extra):
                revision = theirs["revision"]
            elif theirs and theirs["intact"] and theirs["revision"] > base and theirs["revision"] != run.get("revision"):
                raise HandoffError(f"Someone else published version {theirs['revision']} of {kind.words} on GitHub. Choose yours or theirs "
                                   f"before publishing (reconcile {kind.name} --take mine|theirs). Nothing was saved.", {"kind": "reconcile", "target": kind.name},
                                   app=f"Someone else published version {theirs['revision']} of {kind.words} on GitHub. Choose yours or theirs "
                                       f"on the {kind.page} page before publishing. Nothing was saved.")
            elif kind.same(run.get("sha256"), run.get(kind.extra), sha, extra) and run.get("revision"):
                revision = run["revision"]
            else:
                revision = max(base, theirs["revision"] if theirs else 0) + 1
            sections = {**self.kept(data, body_now), kind.name: kind.section_of(revision, items, extra)}
            item = next((found for found in snapshot["projects"] if found["number"] == number), None) if number else None
            keep_seen = False
            if item is not None:
                # M20: the project's own text is written as GitHub holds it unless this workspace's may replace it.
                plan, theirs_text = self.project_choice(data, item, project)
                if plan != "write":
                    if plan == "changed" and theirs_text is None:
                        raise HandoffError("Someone else changed the project on GitHub, and its text is not in the form MACH writes. Choose yours or theirs "
                                           "(reconcile project --take mine|theirs) before publishing. Nothing was saved.", {"kind": "reconcile", "target": "project"},
                                           app="Someone else changed the project on GitHub. Choose yours or theirs before publishing. Nothing was saved.")
                    self.settle_text(data, "project", None, number, plan, theirs_text, raw_sha(item))
                    project = {**project, **({key: theirs_text[key] for key in ("name", "vision", "outcomes")} if theirs_text else {})}
                    keep_seen = plan == "changed"
            body = self.rules.project_issue_body(project["project_id"], project.get("vision") or "", project.get("outcomes") or [],
                                                 sections.get("principles"), sections.get("needs"))
            if len(body) > self.rules.ISSUE_BODY_LIMIT:
                raise HandoffError(f"{kind.words.capitalize()} are too large to save: with the project's vision and outcomes the issue is {len(body):,} "
                                   f"characters, and GitHub takes at most {self.rules.ISSUE_BODY_LIMIT:,} in one issue. Nothing was saved.")
            same = run.get("revision") == revision and kind.same(run.get("sha256"), run.get(kind.extra), sha, extra)
            record["run"] = {"revision": revision, "sha256": sha, "login": channel.login, "steps": dict(run.get("steps") or {}) if same else {},
                             "started_at": run.get("started_at") if same else utc_now(), **kind.extra_field(extra)}
            steps = record["run"]["steps"]
            self.save(data)

            def step(name: str) -> bool:
                if steps.get(name) == "done":
                    return False
                steps[name] = "trying"
                self.save(data)
                return True

            def stop(failure: Optional[Dict[str, str]]) -> None:
                self.save(data)
                raise HandoffError(f"Publishing {kind.words} to GitHub stopped part way. {explain(failure)} "
                                   "Publish them again to finish; nothing will be made twice.")

            if step("labels"):
                have, failure = issues.labels(self.project, repository)
                if failure:
                    stop(failure)
                if "mach:project" not in (have or []):
                    label = self.rules.PRODUCT_LABELS["mach:project"]
                    failure = issues.create_label(self.project, repository, "mach:project", label["color"], label["description"])
                    if failure:
                        stop(failure)
                steps["labels"] = "done"
            if step("project"):
                failure = self.write_project(data, repository, number or (data.get("project") or {}).get("number"), project, sections, keep_seen)
                if failure:
                    stop(failure)
                steps["project"] = "done"
            number = data["project"]["number"]
            if step("approval"):
                found, failure = issues.comments(self.project, repository, number)
                if failure:
                    stop(failure)
                mine = [c["body"] for c in found or [] if c.get("login") == channel.login]
                if {"revision": revision, "by": channel.login, "sha256": sha} not in rules_set.approvals(mine):
                    # The only comment publishing writes: the set's fixed approval template (issue_rules.PublishedSet.approval_comment).
                    failure = issues.comment(self.project, repository, number,
                                             self.outgoing_file(f"{kind.name}-approval", rules_set.approval_comment(revision, str(channel.login), sha)))
                    if failure:
                        stop(failure)
                steps["approval"] = "done"
            record.update(saved="github", revision=revision, base_revision=revision, sha256=sha, published=items, approved_by=channel.login,
                          published_at=utc_now(), issue=number, run=None, **kind.extra_field(extra))
            data["seen"][kind.name] = {"issue": number, "revision": revision, "sha256": sha, "intact": True, "approved": True,
                                       "approved_by": channel.login, kind.name: items, **kind.extra_field(extra), "read_at": utc_now()}
            self.save(data)
            if kind.folder_too:  # the needs: the baseline reads only committed files, so the folder form is written too, same revision and hash
                self.write_set_folder(kind, revision, sha, items, extra)
            return {"saved_to": "github", "revision": revision, "sha256": sha, "issue": number, "url": self.rules.issue_url(repository, number),
                    "approved_by": channel.login, **({"folder": str(self.set_folder(kind))} if kind.folder_too else {})}

    def write_set_folder(self, kind: "PublishedKind", revision: int, sha: str, items: List[Dict[str, Any]], extra: Any = None) -> None:
        """product/ready/<FOLDER>/<name>.json, written to a temporary folder first and then renamed."""
        target = self.set_folder(kind)
        target.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{kind.folder}.", dir=str(target.parent)))
        try:
            record = {"schema_version": 1, "revision": revision, "sha256": sha, kind.name: json.loads(self.rules_set(kind).canonical(items)),
                      **kind.extra_field(extra)}
            (staging / f"{kind.name}.json").write_text(json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
            if target.exists():
                shutil.rmtree(target)
            os.replace(str(staging), str(target))
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def take_set(self, kind: "PublishedKind", revision: int, sha: str, items: List[Dict[str, Any]], extra: Any, approved_by: Optional[str]) -> None:
        """This workspace now holds the set GitHub holds (taken at refresh, or the product manager chose theirs)."""
        with self.exclusive():
            data = self.load()
            data.setdefault(kind.name, {}).update(saved="github", revision=revision, base_revision=revision, sha256=sha, published=items,
                                                  approved_by=approved_by, published_at=None, run=None, **kind.extra_field(extra))
            self.save(data)

    def keep_mine(self, kind: "PublishedKind", revision: int) -> None:
        """The product manager keeps their set: their next publish replaces the version GitHub holds."""
        with self.exclusive():
            data = self.load()
            record = data.setdefault(kind.name, {})
            record["base_revision"] = max(int(record.get("base_revision") or 0), revision)
            self.save(data)

    def read_set(self, kind: "PublishedKind", data: Dict[str, Any], repository: str, snapshot: Dict[str, Any]) -> None:
        """For refresh: the set on the project's issue, whether it is intact, and whether it carries an approval for exactly that
        revision and SHA-256 by the account it names. A failure to read keeps what was known. A project whose issue never held
        technical needs keeps no record of them, so its record is as it was before they existed."""
        linked = (data.get("project") or {}).get("number")
        numbers = [item["number"] for item in snapshot["projects"]]
        number = linked if linked in numbers else (sorted(item["number"] for item in snapshot["projects"] if item["state"] == "open") or [None])[0]
        body = project_body(snapshot, number)
        rules_set = self.rules_set(kind)
        parsed = rules_set.parse(body)
        if parsed is None:
            if kind.always_seen or kind.name in data["seen"]:
                data["seen"][kind.name] = {"issue": number, "revision": None, "read_at": utc_now()}
            return
        found, failure = issues.comments(self.project, repository, number)
        if failure:
            return
        check = rules_set.take_check(body, found or [])
        data["seen"][kind.name] = {"issue": number, "revision": parsed["revision"], "sha256": parsed["sha256"], "intact": parsed["intact"],
                                   "approved": check["problem"] is None, "approved_by": check["approved_by"], kind.name: check["items"],
                                   **kind.extra_field(check["extra"]), "read_at": utc_now()}

    def ensure(self, repository: str, number: Optional[int], title: str, body: str, names: Sequence[str], required: str,
               name: str) -> Tuple[Optional[int], Optional[Dict[str, str]]]:
        """Create the issue, or bring an existing one's title and body up to date. An existing
        issue is changed only while it carries `required`, one of MACH's own labels."""
        path = self.outgoing_file(name, body)
        if number is None:
            return issues.create(self.project, repository, title, path, names)
        current, failure = issues.view(self.project, repository, number)
        if failure:
            return None, failure
        if required not in issues.label_names(current):
            return None, {"kind": "not_ours", "reason": f"Issue #{number} on GitHub is no longer marked as part of this product, so Product Studio leaves it alone.", "link": ""}
        if current.get("title") == title and (current.get("body") or "").replace("\r\n", "\n") == body:
            return number, None
        return number, issues.rewrite(self.project, repository, number, title, path)

    def link(self, data: Dict[str, Any], repository: str, epic: Dict[str, Any], epic_number: int, slice_id: str, number: int,
             snapshot: Dict[str, Any]) -> Optional[Dict[str, str]]:
        """Put the slice under its epic, in the product manager's order (the slices' IDs)."""
        entry = self.entry(data, slice_id)
        if data.get("form") == "task_list":
            label = self.rules.epic_task_label(epic_number)
            have, failure = issues.labels(self.project, repository)
            if failure:
                return failure
            if label not in (have or []):
                failure = issues.create_label(self.project, repository, label, self.rules.PRODUCT_LABELS["mach:epic"]["color"], f"MACH: a slice of epic #{epic_number}")
                if failure:
                    return failure
            current, failure = issues.view(self.project, repository, number)
            if failure:
                return failure
            if label not in issues.label_names(current):
                failure = issues.add_labels(self.project, repository, number, [label])
                if failure:
                    return failure
            body = self.epic_body(epic, epic_number, snapshot, entry, slice_id, number)
            _, failure = self.ensure(repository, epic_number, self.rules.issue_title(epic.get("title")), body, ["mach:epic"], "mach:epic", f"epic-{epic['epic_id']}")
            return failure
        if not entry.get("id"):
            entry["id"], failure = issues.database_id(self.project, repository, number)
            if failure:
                return failure
            self.save(data)
        children, failure = issues.sub_issues(self.project, repository, epic_number)
        if failure:
            return failure
        if entry["id"] not in children:
            failure = issues.add_sub_issue(self.project, repository, epic_number, entry["id"])
            if failure:
                return failure
            children = [*children, entry["id"]]
        return self.order(data, repository, epic_number, slice_id, entry["id"], children)

    def order(self, data: Dict[str, Any], repository: str, epic_number: int, slice_id: str, child: int, children: List[int]) -> Optional[Dict[str, str]]:
        """The product manager's order (slice move), else the slices' IDs. The slice goes just after the nearest
        earlier slice this workspace knows, or just before the first later one; others keep their place."""
        rank = self.rank(data, (data["slices"][slice_id].get("run") or {}).get("epic_id"))
        known = {value.get("id"): key for key, value in data["slices"].items() if value.get("id") and key != slice_id}
        earlier = [c for c in children if c in known and rank(known[c]) < rank(slice_id)]
        later = [c for c in children if c in known and rank(known[c]) > rank(slice_id)]
        at = children.index(child)
        if earlier:
            previous = max(earlier, key=lambda c: rank(known[c]))
            if children.index(previous) != at - 1:
                return issues.place_sub_issue(self.project, repository, epic_number, child, previous, None)
        elif later:
            following = min(later, key=lambda c: rank(known[c]))
            if children.index(following) < at:
                return issues.place_sub_issue(self.project, repository, epic_number, child, None, following)
        return None

    def epic_body(self, epic: Dict[str, Any], epic_number: int, snapshot: Dict[str, Any], entry: Dict[str, Any], slice_id: str,
                  number: Optional[int]) -> str:
        """The epic's body where sub-issues are not available: its slices as a task list, in the product manager's order.
        A slice's earlier, shipped issue is listed only while no newer issue holds its place."""
        tasks: Dict[str, Tuple[int, str, bool]] = {}
        for item in sorted(snapshot["slices"], key=lambda item: item["number"]):
            if item["marker"]["epic"] == epic_number and item["marker"]["slice_id"] != slice_id:
                shipped = item["state"] == "closed" or "mach:shipped" in item["labels"]
                tasks[item["marker"]["slice_id"]] = (item["number"], item["marker"]["slice_id"], shipped)
        if number:
            tasks[slice_id] = (number, slice_id, False)
        return self.rules.epic_issue_body(epic["epic_id"], epic.get("acceptance_criteria") or [], [tasks[key] for key in sorted(tasks, key=self.rank(None, epic["epic_id"]))])

    def outgoing_file(self, name: str, text: str) -> Path:
        """Text for gh to read (--body-file): written here, never passed on the command line."""
        self.outgoing.mkdir(parents=True, exist_ok=True)
        path = self.outgoing / f"{name}.md"
        self._write(path, text)
        return path

    # ---- the folder, without gh ----

    def folder(self, slice_id: str) -> Path:
        return self.draft / "product" / "ready" / slice_id

    def write_folder(self, data: Dict[str, Any], slice_id: str, title: str, epic: Dict[str, Any], dependencies: Sequence[str],
                     why: str, spec: str, jira: Optional[str] = None, mocks: Optional[List[Dict[str, Any]]] = None,
                     mock_files: Optional[Dict[str, bytes]] = None, small: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        entry = self.entry(data, slice_id)
        spec_sha, why_sha = self.rules.text_sha256_of(spec), self.rules.text_sha256_of(why)
        mocks_sha = self.rules.mocks_sha256(mocks) if mocks else None  # M14 C: changed pictures are a new revision
        if small is not None:
            self.rules.small_suffix(small)  # M18: refuses a record that is not in its form, before anything is written
        same = ((entry.get("spec_sha256"), entry.get("why_sha256"), entry.get("jira"), entry.get("mocks_sha256"), entry.get("small"))
                == (spec_sha, why_sha, jira, mocks_sha, small) and entry.get("saved") == "folder")
        revision = entry.get("revision") if same else int(entry.get("base_revision") or 0) + 1
        record = {"schema_version": 1, "slice_id": slice_id, "title": title, "revision": revision,
                  "epic": {"epic_id": epic["epic_id"], "title": epic.get("title")}, "dependencies": list(dependencies),
                  "spec_sha256": spec_sha, "why_sha256": why_sha, **({"jira": jira} if jira else {}),  # M13: the Jira key, only when set
                  **({"mocks": list(mocks)} if mocks else {}),  # M14 C: the design mocks, only when there are some; their files are in mocks/
                  **({"small": dict(small)} if small else {})}  # M18: a small change's record, only for one
        target = self.folder(slice_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{slice_id}.", dir=str(target.parent)))
        try:
            (staging / "spec.md").write_text(spec, encoding="utf-8")
            (staging / "why.md").write_text(why, encoding="utf-8")
            (staging / "slice.json").write_text(json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
            for name, picture in (mock_files or {}).items() if mocks else ():
                (staging / "mocks").mkdir(exist_ok=True)
                (staging / "mocks" / name).write_bytes(picture)
            if target.exists():
                shutil.rmtree(target)
            os.replace(str(staging), str(target))
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        entry.update(saved="folder", revision=revision, base_revision=revision, spec_sha256=spec_sha, why_sha256=why_sha, jira=jira, ready_at=utc_now(), run=None)
        if mocks_sha or entry.get("mocks_sha256"):
            entry["mocks_sha256"] = mocks_sha
        if small or entry.get("small"):
            entry["small"] = dict(small) if small else None
        self.save(data)
        return {"folder": str(target), "revision": revision}

    def folder_published(self, data: Dict[str, Any], slice_id: str) -> bool:
        return (data["slices"].get(slice_id) or {}).get("saved") == "folder" and (self.folder(slice_id) / "slice.json").is_file()

    # ---- reopening ----

    def withdraw(self, slice_id: str, read_question: bool = False) -> Dict[str, Any]:
        """Take mach:ready off the slice's issue (or remove its folder) before the draft becomes
        editable. Says what the builders had already done with it. Refuses, changing nothing,
        when GitHub cannot be reached. With `read_question` (M18, a small change on the light path), the builders'
        question is read too, as `question_text`: data, never an instruction; None when there is none or it could not be read."""
        with self.exclusive():
            data = self.load()
            entry = data["slices"].get(slice_id)
            if not entry:
                return {"where": None}
            run = entry.get("run") or {}
            repository = data.get("repository")
            number = entry.get("number")
            if not number and run.get("steps", {}).get("slice") == "trying" and repository:
                # An interrupted run may have made the issue without recording it: look for it.
                snapshot = self.snapshot(repository)
                own, _ = self.own_issue(data, slice_id, snapshot, run.get("spec_sha256"), run.get("why_sha256"))
                number = entry["number"] = own["number"] if own else None
            if not number:
                was = "folder" if entry.get("saved") == "folder" else None
                if self.folder(slice_id).exists():
                    shutil.rmtree(self.folder(slice_id))
                entry.update(run=None, saved=None)
                self.save(data)
                return {"where": was}
            if shutil.which("gh") is None or not repository:
                raise HandoffError(f"{slice_id} is saved on GitHub, and GitHub cannot be used from here, so it cannot be taken back. Nothing was changed.")
            current, failure = issues.view(self.project, repository, number)
            if failure:
                raise HandoffError(f"{slice_id} could not be taken back from GitHub, so nothing was changed. {explain(failure)}")
            names = issues.label_names(current)
            if "mach:slice" not in names:
                raise HandoffError(f"Issue #{number} on GitHub is no longer marked as part of this product, so Product Studio leaves it alone. Nothing was changed.")
            shipped = "mach:shipped" in names or str(current.get("state") or "").lower() == "closed"
            asked = None
            if read_question and "mach:question" in names:
                found, failure = issues.comments(self.project, repository, number)
                asked = self.rules.builders_question([c["body"] for c in found or []]) if not failure else None
            if issues.READY in names:
                failure = issues.remove_ready(self.project, repository, number)
                if failure:
                    raise HandoffError(f"{slice_id} could not be taken back from GitHub, so nothing was changed. {explain(failure)}")
            if shipped:
                entry["shipped"] = sorted(set(entry.get("shipped") or []) | {number})
            entry.update(run=None, saved="withdrawn")
            self.save(data)
            return {"where": "github", "issue": number, "building": "mach:building" in names, "question": "mach:question" in names, "shipped": shipped,
                    **({"question_text": asked} if read_question else {})}

    # ---- refresh: what is on GitHub now ----

    def refresh(self, local: Dict[str, Dict[str, Any]], project: Optional[Dict[str, Any]] = None,
                epics: Optional[Dict[str, Dict[str, Any]]] = None) -> Dict[str, Any]:
        """Read the project, epics and slices from their issues, and say for each slice whether it
        still matches its approval and whether someone else saved a newer version. Never raises
        for GitHub: a problem is reported in the block. M20: also says whether someone else changed the
        project's or an epic's text (taking it when nothing here waits to be written), and which IDs more
        than one open issue holds; this workspace's own later slice issue among them is closed."""
        if shutil.which("gh") is None:
            return self.block(None, "The GitHub tool (gh) is not installed on this computer.", local)
        repository, failure = collab.request_repository(self.project)
        if repository is None:
            return self.block(None, None, local) if failure is None else self.failed(None, explain(failure), local)
        snapshot, failure = self.read(repository)
        if failure or snapshot is None:
            return self.failed(repository, explain(failure), local)
        try:
            with self.exclusive():
                data = self.for_repository(self.load(), repository)
                self.remember(data, snapshot)
                data["seen"]["clashes"] = self.clashes(data, repository, snapshot)
                self.settle_epic_lost(data, snapshot)
                self.save(data)
                self.read_text(data, snapshot, project, epics or {})
                rows = {}
                for item in snapshot["slices"]:
                    found, failure = issues.comments(self.project, repository, item["number"])
                    rows.setdefault(item["marker"]["slice_id"], []).append(self.describe(data, item, found, failure))
                data["seen"].update(refreshed_at=utc_now(), problem=None, problem_at=None, slices=rows,
                                    project=[{"number": p["number"], "project_id": p["id"], "state": p["state"],
                                              "name": (parse_project_text(p) or {}).get("name")} for p in snapshot["projects"]],
                                    epics=[{"number": e["number"], "epic_id": e["id"], "title": self.rules.list_title(e.get("title"))} for e in snapshot["epics"]])
                self.read_order(data, repository, snapshot, local)
                for kind in SETS:
                    self.read_set(kind, data, repository, snapshot)
                self.save(data)
        except HandoffError as exc:
            return self.failed(repository, str(exc), local)
        return self.block(repository, None, local, refreshed=True)

    def settle_epic_lost(self, data: Dict[str, Any], snapshot: Dict[str, Any]) -> None:
        """For refresh: an epic refused because another epic's issue took its number at the same moment is forgotten once its
        number is free again on GitHub (no open epic issue holds it), or once this workspace's epic is linked to an issue."""
        lost = data["seen"].get("epic_lost") or {}
        held = {item["id"] for item in snapshot["epics"] if item["state"] == "open"}
        for epic_id in list(lost):
            if epic_id not in held or (data["epics"].get(epic_id) or {}).get("number"):
                del lost[epic_id]

    def forget_epic_lost(self, epic_id: str) -> None:
        """epic renumber: the draft no longer uses the number another epic's issue took."""
        with self.exclusive():
            data = self.load()
            if ((data.get("seen") or {}).get("epic_lost") or {}).pop(epic_id, None) is not None:
                self.save(data)

    def read_text(self, data: Dict[str, Any], snapshot: Dict[str, Any], project: Optional[Dict[str, Any]], epics: Dict[str, Dict[str, Any]]) -> None:
        """For refresh: the project's and each epic's text on GitHub against what this workspace last saw. GitHub's is taken when
        nothing here waits to be written (or this workspace never saw it); when both changed, it waits for the product manager's choice."""
        waiting = data["seen"].setdefault("text_changed", {})
        if project:
            open_projects = [item for item in snapshot["projects"] if item["state"] == "open"]
            linked = (data.get("project") or {}).get("number")
            item = next((found for found in snapshot["projects"] if found["number"] == linked), None)
            if item is None and len(open_projects) == 1 and open_projects[0]["id"] == project.get("project_id"):
                item = open_projects[0]
            if item is not None:
                data["project"] = {**(data.get("project") or {}), "number": item["number"]}
                plan, theirs = self.project_choice(data, item, project)
                if plan == "write":
                    waiting.pop("project", None)
                else:
                    self.settle_text(data, "project", None, item["number"], plan, theirs, raw_sha(item))
        for epic_id, epic in sorted(epics.items()):
            linked = (data["epics"].get(epic_id) or {}).get("number")
            item = next((found for found in snapshot["epics"] if found["number"] == linked), None)
            if item is None and not linked:
                title = self.rules.issue_title(epic.get("title"))
                item = next((found for found in sorted(snapshot["epics"], key=lambda e: e["number"])
                             if found["id"] == epic_id and found["state"] == "open" and found.get("title") == title), None)
            if item is None:
                continue
            if linked != item["number"]:
                data["epics"][epic_id] = {"number": item["number"]}
            plan, theirs = self.epic_choice(data, {**epic, "epic_id": epic_id}, item)
            if plan == "write":
                waiting.pop(epic_id, None)
            else:
                self.settle_text(data, "epic", epic_id, item["number"], plan, theirs, raw_sha(item))

    def text_taken(self, kind: str, epic_id: Optional[str], fields: Dict[str, Any]) -> None:
        """reconcile --take theirs: this workspace now holds GitHub's text, and has seen it."""
        with self.exclusive():
            data = self.load()
            key = epic_id or "project"
            record = data["project"] if kind == "project" else data["epics"].get(str(epic_id))
            if record is not None:
                record["text_sha256"] = (project_sha(fields["name"], fields["vision"], fields["outcomes"]) if kind == "project"
                                         else epic_sha(fields["title"], fields["acceptance_criteria"]))
            (data.get("seen") or {}).get("text_changed", {}).pop(key, None)
            self.save(data)

    def text_kept(self, key: str) -> None:
        """reconcile --take mine: GitHub's version counts as seen, so the next slice marked ready writes this workspace's over it."""
        with self.exclusive():
            data = self.load()
            waiting = (data.get("seen") or {}).get("text_changed", {}).pop(key, None) or {}
            record = data["project"] if key == "project" else data["epics"].get(key)
            if record is not None and waiting:
                record["text_sha256"] = (project_sha(waiting["name"], waiting["vision"], waiting["outcomes"]) if key == "project" and waiting.get("readable")
                                         else epic_sha(waiting["title"], waiting["acceptance_criteria"]) if waiting.get("readable")
                                         else waiting.get("raw_sha256"))
            self.save(data)

    def failed(self, repository: Optional[str], problem: str, local: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        """A read of GitHub that did not finish is kept, so status can say what may be out of date."""
        try:
            with self.exclusive():
                data = self.load()
                data["seen"].update(problem=problem, problem_at=utc_now())
                self.save(data)
        except HandoffError:
            pass  # another command holds the record; the block still says what went wrong
        return self.block(repository, problem, local)

    def describe(self, data: Dict[str, Any], item: Dict[str, Any], found: Optional[List[Dict[str, Any]]], failure: Any) -> Dict[str, Any]:
        marker = item["marker"]
        latest = [a for a in self.rules.approvals([c["body"] for c in found or []]) if a["slice_id"] == marker["slice_id"] and a["revision"] == marker["revision"]]
        approved = latest[-1] if latest else None
        matches = bool(marker["intact"] and approved and (approved["spec_sha256"], approved["why_sha256"], approved.get("jira"), approved.get("mocks_sha256"),
                                                          approved.get("small"))
                       == (marker["spec_sha256"], marker["why_sha256"], marker.get("jira"), marker.get("mocks_sha256"),
                           marker.get("small")))  # M13, M14 C, M18: the key, the mocks and the small-change record too
        state_label = next((name for name in ("mach:question", "mach:shipped", "mach:building", "mach:ready") if name in item["labels"]), None)
        return {"issue": item["number"], "state": item["state"], "state_label": state_label, "revision": marker["revision"],
                "title": self.rules.list_title(item.get("title")), "epic_issue": marker["epic"],
                "matches_approval": None if failure else matches, "approved_by": approved["by"] if approved else None,
                "comments_read": failure is None,
                "question": self.rules.builders_question([c["body"] for c in found or []]) if state_label == "mach:question" else None,
                "times": self.times(marker, found or [])}

    def times(self, marker: Dict[str, Any], found: List[Dict[str, Any]]) -> Dict[str, Optional[str]]:
        """When this version was marked ready (its approval comment), and when the builders took it,
        asked their question and shipped it (MACH's status comments), as GitHub dated the comments.
        A moment with no such comment, or with no date, stays absent (None)."""
        def latest(match: Callable[[str], bool]) -> Optional[str]:
            dated = [str(c["created_at"]) for c in found if c.get("created_at") and match(str(c.get("body") or ""))]
            return max(dated) if dated else None

        def approval(body: str) -> bool:
            return any(a["slice_id"] == marker["slice_id"] and a["revision"] == marker["revision"]
                       and (a["spec_sha256"], a["why_sha256"]) == (marker["spec_sha256"], marker["why_sha256"]) for a in self.rules.approvals([body]))

        def moment(name: str) -> Callable[[str], bool]:
            return lambda body: any(found_moment == name for found_moment, _ in self.rules.MARKER_RE.findall(body))

        return {"marked_ready": latest(approval), "building": latest(moment("building")),
                "question": latest(moment("question")), "shipped": latest(moment("shipped"))}

    def block(self, repository: Optional[str], problem: Optional[str], local: Dict[str, Dict[str, Any]], refreshed: bool = False) -> Dict[str, Any]:
        data = self.load()
        seen = data.get("seen") or {}
        repo = repository or data.get("repository")
        project_number = (data.get("project") or {}).get("number")
        return {"repository": repository, "refreshed": refreshed, "problem": problem, "refreshed_at": seen.get("refreshed_at"),
                "form": data.get("form"), "project_issue": project_number,
                "project_url": self.rules.issue_url(repo, project_number) if repo and project_number else None,
                "epics": {key: value["number"] for key, value in data["epics"].items()},
                "epic_urls": {key: self.rules.issue_url(repo, value["number"]) for key, value in data["epics"].items() if repo},
                "slices": slice_rows(data, local, self.rules), "order": order_rows(data, local, self.rules),
                "principles": published_view(PRINCIPLES_KIND, data, self.rules),
                "same_id_twice": list(seen.get("clashes") or []), "changed_elsewhere": text_changed_view(data, self.rules),
                "text_taken": [note for note in self.text_notes if note.get("taken")],
                **({"needs": published_view(NEEDS_KIND, data, self.rules)} if data.get("needs") or seen.get("needs") else {})}

    def record_acceptance(self, epic_id: str, release_id: str, commit: str, decision: str, readiness_sha256: str) -> Dict[str, Any]:
        """Product's decision on one release of an epic, as a comment from a fixed template on the epic's issue. Posted once."""
        channel = self.channel()
        if channel.kind != "github":
            raise HandoffError(f"Product acceptance is recorded on the epic's GitHub issue, and GitHub cannot be used from here: {channel.why} Nothing was recorded.")
        data = self.for_repository(self.load(), str(channel.repository))
        number = (data["epics"].get(epic_id) or {}).get("number")
        if not number:
            raise HandoffError(f"{epic_id} has no issue on GitHub yet, so there is nowhere to record the decision. Nothing was recorded.")
        body = self.rules.acceptance_comment(epic_id, release_id, commit, decision, str(channel.login), readiness_sha256)
        marker = body.rsplit("\n", 1)[-1]
        found, failure = issues.comments(self.project, str(channel.repository), number)
        if failure:
            raise HandoffError(f"Nothing was recorded. {explain(failure)}")
        already = any(marker in (item.get("body") or "") and item.get("login") == channel.login for item in found or [])
        if not already:
            failure = issues.comment(self.project, str(channel.repository), number, self.outgoing_file(f"acceptance-{epic_id}", body))
            if failure:
                raise HandoffError(f"Nothing was recorded. {explain(failure)}")
        return {"issue": number, "url": self.rules.issue_url(str(channel.repository), number), "by": channel.login, "already_recorded": already}

    def epic_numbers(self) -> List[int]:
        """The numbers of the epic IDs GitHub's epic issues hold, as last read."""
        return [int(str(item.get("epic_id")).split("-")[1]) for item in (self.load().get("seen") or {}).get("epics") or []
                if isinstance(item, dict) and self.rules.EPIC_ID_RE.fullmatch(str(item.get("epic_id")))]

    def reachable(self) -> Tuple[Optional[str], Optional[str]]:
        """(repository, None) when GitHub can be read from here; (None, why not) otherwise, or (None, None) when this project is not
        on GitHub at all. Never raises."""
        if shutil.which("gh") is None:
            return None, None
        repository, failure = collab.request_repository(self.project)
        if repository is None:
            return None, explain(failure) if failure else None
        return repository, None

    def refresh_numbers(self) -> Dict[str, Any]:
        """M20: before several IDs are given out at once (prd apply, idea apply), read which slice and epic numbers GitHub's issues hold,
        so none is given out twice. Reads only; a failure is reported, never raised."""
        repository, why = self.reachable()
        if repository is None:
            return {"checked": False, "problem": why}
        snapshot, failure = self.read(repository)
        if failure or snapshot is None:
            return {"checked": False, "problem": explain(failure)}
        try:
            with self.exclusive():
                data = self.for_repository(self.load(), repository)
                self.remember(data, snapshot)
                data["seen"]["epics"] = [{"number": e["number"], "epic_id": e["id"], "title": self.rules.list_title(e.get("title"))} for e in snapshot["epics"]]
                self.save(data)
        except HandoffError as exc:
            return {"checked": False, "problem": str(exc)}
        return {"checked": True, "problem": None}

    def github_project(self) -> Dict[str, Any]:
        """M20, for project init: the project issues open on GitHub, read now. {"reachable": False, "problem": ...} when they cannot be read."""
        repository, why = self.reachable()
        if repository is None:
            return {"reachable": False, "problem": why}
        snapshot, failure = self.read(repository)
        if failure or snapshot is None:
            return {"reachable": False, "problem": explain(failure)}
        projects = sorted((item for item in snapshot["projects"] if item["state"] == "open"), key=lambda item: item["number"])
        return {"reachable": True, "repository": repository, "projects": projects}

    def link_project(self, repository: str, item: Dict[str, Any]) -> None:
        """project init took the project from its issue: this workspace has seen exactly that text."""
        theirs = parse_project_text(item) or {}
        with self.exclusive():
            data = self.for_repository(self.load(), repository)
            data["project"] = {"number": item["number"], "pin_tried": True, "pinned": None,
                               "text_sha256": project_sha(theirs.get("name"), theirs.get("vision"), theirs.get("outcomes"))}
            self.save(data)

    def taken_ids(self) -> List[int]:
        return [int(sid.split("-")[1]) for sid in (self.load().get("seen") or {}).get("taken") or [] if self.rules.SLICE_ID_RE.fullmatch(str(sid))]

    # ---- the product manager's order within an epic ----

    def rank(self, data: Optional[Dict[str, Any]], epic_id: Optional[str]) -> Callable[[str], Tuple[int, str]]:
        """A sort key for the epic's slices: the order the product manager set, then any others by slice ID."""
        return rank_key(((data if data is not None else self.load()).get("order") or {}).get(epic_id or "", {}).get("slices") or [])

    def github_order(self, repository: str, epic_number: int, body: Any, number_to_slice: Dict[int, str],
                     form: Optional[str]) -> Tuple[Optional[List[str]], Optional[List[Tuple[int, int]]], Optional[Dict[str, str]]]:
        """The epic's slices in GitHub's order (its sub-issues, or its task list where it has none), with
        the sub-issues as (id, number) when that is the form. A slice listed twice (shipped, then changed)
        takes the place of its newest issue."""
        children: Optional[List[Tuple[int, int]]] = None
        numbers: Optional[List[int]] = None
        if form != "task_list":
            children, failure = issues.sub_issue_numbers(self.project, repository, epic_number)
            if failure and not (form is None and issues.unavailable(failure)):
                return None, None, failure
            if children and not failure:
                numbers = [number for _, number in children]
            elif form == "sub_issues" and not failure:
                numbers = []
            else:
                children = None
        if numbers is None:
            numbers = self.rules.epic_tasks(body)
        return current_order(numbers, number_to_slice), children, None

    def read_order(self, data: Dict[str, Any], repository: str, snapshot: Dict[str, Any], local: Dict[str, Dict[str, Any]]) -> None:
        """For refresh: each epic's order on GitHub. Where it changed since this workspace last read or wrote
        it, another product manager changed it, and theirs is taken; a move of this workspace's own that has
        not finished is never overwritten. A failure to read one epic keeps what was known."""
        number_to_slice = {item["number"]: item["marker"]["slice_id"] for item in snapshot["slices"]}
        taken: List[str] = []
        problems: List[str] = []
        done: set = set()
        for item in sorted(snapshot["epics"], key=lambda e: e["number"]):
            epic_id = item["id"]
            linked = (data["epics"].get(epic_id) or {}).get("number")
            if not self.rules.EPIC_ID_RE.fullmatch(str(epic_id)) or epic_id in done or (linked and linked != item["number"]):
                continue
            done.add(epic_id)
            found, _, failure = self.github_order(repository, item["number"], item.get("body"), number_to_slice, data.get("form"))
            record = data["order"].setdefault(epic_id, empty_order())
            if failure or found is None:
                problems.append(epic_id)
                continue
            last = (record.get("github") or {}).get("slices") if (record.get("github") or {}).get("repository") == repository else None
            mine = effective_order(data, local, epic_id, self.rank(data, epic_id))
            pending = (record.get("move") or {}).get("state") == "trying"
            if last is not None:
                changed = relative(found, last) != relative(last, found)
            else:
                changed = not record.get("slices") and relative(found, mine) != relative(mine, found)
            if changed and not pending:
                record.update(slices=merge_order(found, mine), taken_at=utc_now())
                taken.append(epic_id)
            record["github"] = {"repository": repository, "slices": found, "read_at": utc_now()}
        data["seen"].update(order_taken=taken, order_not_read=problems)

    def arrange(self, data: Dict[str, Any], repository: str, epic: Dict[str, Any], wanted: Sequence[str],
                moved: Optional[str] = None) -> Optional[Dict[str, str]]:
        """Put the epic's slices on GitHub in the product manager's order. Reads GitHub first and moves only
        what is out of place, so a repeated or interrupted run never moves anything twice. Where either of two
        slices could be moved, the one the product manager moved (`moved`) is."""
        snapshot, failure = self.read(repository)
        if failure or snapshot is None:
            return failure or {"kind": "other", "reason": "", "link": ""}
        self.remember(data, snapshot)
        epic_number = self.find_epic(data, snapshot, epic)
        if epic_number is None:
            return None
        if (data["epics"].get(epic["epic_id"]) or {}).get("number") != epic_number:
            data["epics"][epic["epic_id"]] = {"number": epic_number}
        item = next(e for e in snapshot["epics"] if e["number"] == epic_number)
        number_to_slice = {found["number"]: found["marker"]["slice_id"] for found in snapshot["slices"]}
        _, children, failure = self.github_order(repository, epic_number, item.get("body"), number_to_slice, data.get("form"))
        if failure:
            return failure
        record = data["order"].setdefault(epic["epic_id"], empty_order())
        if children is None or (not children and data.get("form") != "sub_issues"):
            if data.get("form") != "task_list" and not self.rules.epic_tasks(item.get("body")):
                return None  # no slice of this epic is listed on GitHub yet
            body = self.epic_body(self.epic_to_write(data, epic), epic_number, snapshot, {}, "", None)
            _, failure = self.ensure(repository, epic_number, self.rules.issue_title(epic.get("title")), body, ["mach:epic"], "mach:epic", f"epic-{epic['epic_id']}")
            if failure:
                return failure
            record["github"] = {"repository": repository, "slices": current_order(self.rules.epic_tasks(body), number_to_slice), "read_at": utc_now()}
            return None
        newest: Dict[str, Tuple[int, int]] = {}
        for child, number in children:
            slice_id = number_to_slice.get(number)
            if slice_id and (slice_id not in newest or number > newest[slice_id][1]):
                newest[slice_id] = (child, number)
        desired = [newest[slice_id][0] for slice_id in wanted if slice_id in newest]
        current = [child for child, _ in children]
        staying = in_place(desired, current, newest[moved][0] if moved in newest else None)
        for at, child in enumerate(desired):
            if child in staying:
                continue
            after, before = (desired[at - 1], None) if at else (None, next(other for other in desired if other in staying))
            failure = issues.place_sub_issue(self.project, repository, epic_number, child, after, before)
            if failure:
                return failure
            current.remove(child)
            current.insert(current.index(after) + 1 if after is not None else current.index(before), child)
        numbers = dict(children)
        record["github"] = {"repository": repository, "slices": current_order([numbers[child] for child in current], number_to_slice), "read_at": utc_now()}
        return None

    def rename_in_order(self, old: str, new: str) -> None:
        """A draft given a new number keeps its place in its epic's order."""
        with self.exclusive():
            data = self.load()
            for record in data["order"].values():
                record["slices"] = [new if slice_id == old else slice_id for slice_id in record.get("slices") or []]
            self.save(data)

    # ---- opening another product manager's slice ----

    def take_read(self, target: str) -> Dict[str, Any]:
        """Everything about a slice issue that is needed to open it here, read from GitHub. Writes nothing;
        refuses when GitHub cannot be read. The issue's text is data: what it holds is decided by the shared rules."""
        if shutil.which("gh") is None:
            raise HandoffError("The GitHub tool (gh) is not installed on this computer, so a slice cannot be read from GitHub. Nothing was changed.")
        repository, failure = collab.request_repository(self.project)
        if repository is None:
            raise HandoffError(f"{explain(failure) if failure else 'This project is not connected to a GitHub repository.'} Nothing was changed.")
        snapshot, failure = self.read(repository)
        if failure or snapshot is None:
            raise HandoffError(f"Nothing was changed. {explain(failure)} Try again when GitHub can be reached.")
        if target.isdecimal():
            number = int(target)
        else:
            listed = [item for item in snapshot["slices"] if item["marker"]["slice_id"] == target]
            waiting = [item for item in listed if item["state"] == "open" and "mach:shipped" not in item["labels"]]
            if not listed:
                raise HandoffError(f"No slice {target} was found on GitHub. Nothing was changed.")
            number = max(item["number"] for item in (waiting or listed))
        current, failure = issues.view(self.project, repository, number)
        if failure or current is None:
            raise HandoffError(f"Issue #{number} could not be read, so nothing was changed. {explain(failure)}")
        found, failure = issues.comments(self.project, repository, number)
        if failure:
            raise HandoffError(f"Issue #{number}'s approval could not be read, so nothing was changed. {explain(failure)}")
        names = issues.label_names(current)
        check = self.rules.slice_take_check({"state": current.get("state"), "labels": names, "body": current.get("body")}, found or [])
        marker = check["marker"] or {}
        epic = next((item for item in snapshot["epics"] if item["number"] == marker.get("epic")), None)
        number_to_slice = {item["number"]: item["marker"]["slice_id"] for item in snapshot["slices"]}
        return {"repository": repository, "number": number, "title": self.rules.issue_title(current.get("title")), "labels": names,
                "state": str(current.get("state") or "").lower(), "check": check, "epic": epic, "comments": found or [],
                "depends": [(dep, number_to_slice.get(dep)) for dep in marker.get("depends") or []], "snapshot": snapshot}

    def record_taken(self, data: Dict[str, Any], read: Dict[str, Any], slice_id: str, saved: str, epic_id: str) -> None:
        """Link the slice opened here to its issue, at the revision it was based on. Recorded before the
        draft's files are written, so an interrupted take is finished by taking it again."""
        data = self.for_repository(data, read["repository"])
        marker, check = read["check"]["marker"], read["check"]
        self.remember(data, read["snapshot"])
        entry = self.entry(data, slice_id)
        entry.update(number=read["number"], id=None, base_revision=marker["revision"], revision=marker["revision"], spec_sha256=marker["spec_sha256"],
                     why_sha256=marker["why_sha256"], jira=marker.get("jira"), saved=saved, approved_by=check["approved_by"], run=None, taken_at=utc_now(),
                     shipped=sorted(set(entry.get("shipped") or []) | ({marker["follows"]} if marker.get("follows") else set())))
        if (data["epics"].get(epic_id) or {}).get("number") != read["epic"]["number"]:
            data["epics"][epic_id] = {"number": read["epic"]["number"]}
        item = {"number": read["number"], "state": read["state"], "labels": read["labels"], "title": read["title"], "marker": {**marker, "intact": True}}
        rows = data.setdefault("seen", {}).setdefault("slices", {}).setdefault(slice_id, [])
        rows[:] = [row for row in rows if row.get("issue") != read["number"]] + [self.describe(data, item, read["comments"], None)]
        record = data["order"].get(epic_id)
        github = (record or {}).get("github") or {}
        if record and record.get("slices") and slice_id not in record["slices"]:
            # Its place is where GitHub has it, after the nearest slice before it that the order here already lists.
            there = github.get("slices") or [] if github.get("repository") == read["repository"] else []
            before = [other for other in there[:there.index(slice_id)] if other in record["slices"]] if slice_id in there else []
            record["slices"].insert(record["slices"].index(before[-1]) + 1 if before else 0 if slice_id in there else len(record["slices"]), slice_id)
        self.save(data)


def project_body(snapshot: Dict[str, Any], number: Optional[int]) -> Optional[str]:
    """The project issue's body as last read, or None."""
    return next((item.get("body") for item in snapshot.get("projects") or [] if item.get("number") == number), None) if number else None


# ---- M20: the project's and epics' own text, and IDs made twice ----


def one_line(text: Any) -> str:
    return " ".join(str(text or "").split())


def digest(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode("utf-8")).hexdigest()


def project_sha(title: Any, vision: Any, outcomes: Any) -> str:
    """The project's own text (title, vision, outcomes) as its issue writes it; the principles and needs are not part of it."""
    return digest("project", str(title or ""), one_line(vision), [one_line(item) for item in outcomes or []])


def epic_sha(title: Any, criteria: Any) -> str:
    """An epic's own text (title, acceptance criteria); its task list is not part of it."""
    return digest("epic", str(title or ""), [one_line(item) for item in criteria or []])


def raw_sha(item: Optional[Dict[str, Any]]) -> Optional[str]:
    """The issue's title and body as read, for text not in MACH's form."""
    return "raw:" + digest(str(item.get("title") or ""), str(item.get("body") or "").replace("\r\n", "\n")) if item else None


def body_lines(item: Optional[Dict[str, Any]]) -> List[str]:
    return str((item or {}).get("body") or "").replace("\r\n", "\n").split("\n")


def parse_project_text(item: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The project's name, vision and outcomes from its issue, or None when the text is not in the form MACH writes."""
    lines = body_lines(item)
    if len(lines) < 6 or not lines[0].startswith("<!-- mach:project id=") or lines[1:2] != ["## Vision"] or lines[3:5] != ["", "## Outcomes"]:
        return None
    outcomes = []
    for line in lines[5:]:
        if not line.startswith("- "):
            break
        outcomes.append(line[2:])
    return {"name": str((item or {}).get("title") or ""), "vision": lines[2], "outcomes": outcomes} if outcomes else None


def parse_epic_text(item: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """An epic's title and acceptance criteria from its issue, or None when the text is not in the form MACH writes."""
    lines = body_lines(item)
    if len(lines) < 2 or not lines[0].startswith("<!-- mach:epic id=") or lines[1] != "## Done when":
        return None
    criteria = []
    for line in lines[2:]:
        if not line.startswith("- "):
            break
        criteria.append(line[2:])
    return {"title": str((item or {}).get("title") or ""), "acceptance_criteria": criteria}


def text_plan(seen: Optional[str], mine: str, theirs: Optional[str], raw: Optional[str]) -> str:
    """same: GitHub already holds this workspace's text. take: GitHub's changed and nothing here waits to be written (or this
    workspace never defined it), so GitHub's is taken. write: only this workspace's changed, so it may replace GitHub's. changed:
    both changed, or GitHub's is not in MACH's form: nothing is written and the product manager chooses (reconcile)."""
    if theirs is not None and theirs == mine:
        return "same"
    if theirs is not None and (seen is None or seen == mine):
        return "take"
    if seen is not None and seen in (theirs, raw):
        return "write"
    return "changed"


def text_changed_view(data: Dict[str, Any], rules: Any) -> List[Dict[str, Any]]:
    """The project's and epics' text someone else changed on GitHub while this workspace changed its own: each waits for a choice."""
    waiting = ((data.get("seen") or {}).get("text_changed") or {})
    repository = data.get("repository")
    rows = []
    for key in sorted(waiting, key=lambda k: (k != "project", k)):
        item = waiting[key]
        what = "the project" if key == "project" else key
        rows.append({"target": key, "kind": "project" if key == "project" else "epic", "issue": item.get("issue"),
                     "url": rules.issue_url(repository, item["issue"]) if repository and item.get("issue") else None,
                     "readable": bool(item.get("readable")),
                     "theirs": ({key2: item.get(key2) for key2 in ("name", "vision", "outcomes")} if key == "project"
                                else {key2: item.get(key2) for key2 in ("title", "acceptance_criteria")}) if item.get("readable") else None,
                     "note": f"Someone else changed {what} on GitHub since you last saw it, and your copy here is different. Choose yours or theirs."})
    return rows


class LostError(HandoffError):
    """Refused because GitHub made another product manager's issue for the same ID first: the approval here is undone."""


def lost_error(message: str, hint: Dict[str, Any], app: Optional[str] = None) -> LostError:
    return LostError(message, hint, app)


def slice_lost_words(slice_id: str, number: int, holder: int, by: Optional[str], app: bool) -> str:
    who = f"{by}'s" if by else "another product manager's"
    how = "Give your draft a new number, then mark it ready again." if app else f"Give your draft a new number (slice renumber {slice_id}), then mark it ready again."
    return (f"{slice_id} was marked ready at the same moment by someone else: {who} issue #{holder} was made first and keeps the number. "
            f"Your issue #{number} was closed and never marked ready, so nothing reached the builders. {how}")


def epic_lost_words(epic_id: str, number: int, holder: int) -> str:
    return (f"{epic_id} was saved at the same moment by someone else, for a different epic: their issue #{holder} was made first and keeps the number. "
            f"Your issue #{number} was closed. Give your epic a new number, then mark the slice ready again.")


def issue_urls(rules: Any, repository: Optional[str], numbers: Sequence[int]) -> Dict[str, str]:
    """Each issue's address by its number (a string, as JSON keys are), built by issue_rules; empty without a repository."""
    return {str(n): rules.issue_url(repository, n) for n in numbers if repository and rules.is_issue_number(n)}


def several_hint(rules: Any, repository: Optional[str], numbers: Sequence[int]) -> Dict[str, Any]:
    """The several-projects refusal's hint for the app: each project issue with its address, so the app links them. Issues
    are left off the end if the hint would grow past what the app's host passes on (512 bytes)."""
    urls = issue_urls(rules, repository, numbers)
    items = [{"issue": n, "url": urls.get(str(n))} for n in numbers]
    while items and len(json.dumps({"kind": "several_projects", "target": None, "issues": items}, ensure_ascii=False)) > 512:
        items.pop()
    return {"kind": "several_projects", "target": None, "issues": items}


def epic_same_moment(data: Dict[str, Any], epic_id: str, rules: Any) -> Optional[Dict[str, Any]]:
    """M20: this workspace's issue for the epic was made at the same moment as someone else's for a different epic with the
    same number, and closed; until the draft is renumbered or the number is free again. From the record alone."""
    lost = ((data.get("seen") or {}).get("epic_lost") or {}).get(epic_id)
    if not isinstance(lost, dict) or (data["epics"].get(epic_id) or {}).get("number"):
        return None
    repository = data.get("repository")
    return {**{key: lost.get(key) for key in ("issue", "holder", "by", "at")},
            "issue_url": rules.issue_url(repository, lost["issue"]) if repository and rules.is_issue_number(lost.get("issue")) else None,
            "holder_url": rules.issue_url(repository, lost["holder"]) if repository and rules.is_issue_number(lost.get("holder")) else None}


def several_projects(numbers: Sequence[int]) -> str:
    named = ", ".join(f"#{n}" for n in numbers[:-1]) + f" and #{numbers[-1]}"
    return (f"This repository has more than one project issue on GitHub ({named}). A repository holds one project, so nothing was saved. "
            "Ask someone who looks after the repository to close the one that should not be there, then try again.")


def clash_note(clash: Dict[str, Any]) -> str:
    others = ", ".join(f"#{n}" for n in clash["others"])
    if clash["kind"] == "project":
        return several_projects(clash["others"]).replace(", so nothing was saved", "")
    if clash["kind"] == "epic":
        return (f"{clash['id']} is held by more than one open issue on GitHub: #{clash['kept']} was made first, then {others}. "
                "Ask someone who looks after the repository to close the one that should not be there.")
    yours = {"kept": f" Yours is #{clash['kept']}, which keeps the number.",
             "closed": " Yours was made later, so MACH closed it: give your draft a new number and mark it ready again.",
             "taken_by_builders": " Yours was made later, and the builders have already taken it: tell the engineer before anything else.",
             "not_closed": " Yours was made later; MACH could not close it yet and tries again at the next refresh."}.get(str(clash["yours"]), "")
    return f"{clash['id']} is held by more than one open issue on GitHub: #{clash['kept']} was made first, then {others}.{yours}"


class PublishedKind:
    """What differs between the sets Product Studio publishes on the project's issue: the product principles (M13) and the
    technical needs (M17). `extra` names a set's part outside its items and its hash (the needs' kinds with nothing to say)."""

    def __init__(self, name: str, rules_name: str, folder: str, words: str, page: str, extra: Optional[str] = None, always_seen: bool = False,
                 folder_too: bool = False):
        self.name, self.rules_name, self.folder, self.words, self.page, self.extra, self.always_seen = name, rules_name, folder, words, page, extra, always_seen
        self.folder_too = folder_too  # also written to the ready folder when published on GitHub, for readers of committed files only

    def same(self, sha: Any, extra: Any, other_sha: Any, other_extra: Any) -> bool:
        """Whether two versions of the set are the same: the same SHA-256, and the same extra part when the set has one."""
        return sha == other_sha and (not self.extra or list(extra or []) == list(other_extra or []))

    def extra_field(self, extra: Any) -> Dict[str, Any]:
        return {self.extra: extra} if self.extra else {}

    def section_of(self, revision: int, items: List[Dict[str, Any]], extra: Any) -> Dict[str, Any]:
        """The set as issue_rules.project_issue_body takes it."""
        return {"revision": revision, self.name: items, **self.extra_field(list(extra or []) if self.extra else None)}


PRINCIPLES_KIND = PublishedKind("principles", "PRINCIPLES", "PRINCIPLES", "the principles", "Product principles", always_seen=True)
NEEDS_KIND = PublishedKind("needs", "NEEDS", "NEEDS", "the technical needs", "Technical needs", extra="none", folder_too=True)
SETS = (PRINCIPLES_KIND, NEEDS_KIND)


def published_view(kind: PublishedKind, data: Dict[str, Any], rules: Any) -> Dict[str, Any]:
    """Where a set is saved and what GitHub held at the last refresh, from the record alone (no network)."""
    record = data.get(kind.name) or {}
    seen = (data.get("seen") or {}).get(kind.name) or {}
    repository = data.get("repository")
    issue = record.get("issue") or seen.get("issue")
    on_github = seen.get("revision") is not None
    run = record.get("run") or {}
    differs = not kind.same(seen.get("sha256"), seen.get(kind.extra or ""), record.get("sha256"), record.get(kind.extra or ""))
    newer = bool(on_github and seen.get("approved") and seen["revision"] > int(record.get("base_revision") or 0)
                 and differs and seen["revision"] != run.get("revision"))
    changed = bool(on_github and not newer and (not seen.get("intact") or (record.get("saved") == "github" and differs
                                                                         and seen["revision"] >= int(record.get("revision") or 0))))
    return {"saved": record.get("saved") if not run else None, "unfinished": bool(run), "revision": record.get("revision"), "sha256": record.get("sha256"),
            "approved_by": record.get("approved_by"), "published_at": record.get("published_at"), "issue": issue,
            "url": rules.issue_url(repository, issue) if repository and issue else None,
            "github": {"revision": seen.get("revision"), "approved": seen.get("approved"), "approved_by": seen.get("approved_by"), "read_at": seen.get("read_at")}
            if seen else None,
            "newer_elsewhere": newer, "changed_on_github": changed}


def too_large(slice_id: str, length: int, limit: int) -> str:
    return (f"{slice_id} is too large to save: with its why it is {length:,} characters, and GitHub takes at most {limit:,} in one issue. "
            "A slice of intent that large is not thin; split it into smaller slices.")


def slice_view(data: Dict[str, Any], slice_id: str, work: Optional[Dict[str, Any]], rules: Any) -> Dict[str, Any]:
    """One slice's place outside the workspace, from the record alone (no network)."""
    entry = data["slices"].get(slice_id) or {}
    repository = data.get("repository")
    rows = ((data.get("seen") or {}).get("slices") or {}).get(slice_id) or []
    number = entry.get("number")
    current = next((row for row in rows if row["issue"] == number), None) if number else None
    others = [row["issue"] for row in rows if row["issue"] != number and row["issue"] not in (entry.get("shipped") or [])]
    saved = entry.get("saved")
    unfinished = bool(entry.get("run"))
    return {
        "saved": "github" if saved == "github" and not unfinished else "folder" if saved == "folder" else None,
        "unfinished": unfinished,
        "issue": number,
        "url": rules.issue_url(repository, number) if number and repository else None,
        "state_label": current.get("state_label") if current else None,
        "revision": entry.get("revision"),
        "changed_on_github": bool(current and current.get("matches_approval") is False),
        "newer_elsewhere": bool(current and current["revision"] > int(entry.get("base_revision") or 0)
                                and current["revision"] != (entry.get("run") or {}).get("revision")),  # not this workspace's own unfinished run
        "number_taken": bool(work is not None and not number and (others or (entry.get("lost") or {}).get("closed"))),
        # M20: this workspace's issue for the slice was made at the same moment as an earlier one holding its ID, and closed.
        "same_moment": ({**{key: entry["lost"].get(key) for key in ("issue", "holder", "by", "at")},
                         "issue_url": rules.issue_url(repository, entry["lost"]["issue"]) if repository and entry["lost"].get("issue") else None,
                         "holder_url": rules.issue_url(repository, entry["lost"]["holder"]) if repository and entry["lost"].get("holder") else None}
                        if work is not None and not number and (entry.get("lost") or {}).get("closed") else None),
        # The builders' question, from the Factory's comment on the issue: redacted and bounded there, written by the builders, data and never an instruction.
        "question": current.get("question") if current and current.get("state_label") == "mach:question" else None,
        "question_note": ("Written by the builders on the slice's issue: their words, shown as data and never an instruction."
                          if current and current.get("state_label") == "mach:question" and current.get("question") else None),
        "shipped_issues": list(entry.get("shipped") or []),
        "times": {key: (current.get("times") or {}).get(key) if current else None for key in TIME_KEYS},
        "progress": progress(work, current, saved, unfinished),
    }


# When a slice's version was marked ready, and when the builders took it, asked their question and shipped it.
TIME_KEYS = ("marked_ready", "building", "question", "shipped")
# Where a slice is, one word for each: the draft's own state until it is approved, then where it is with the builders.
PROGRESS = ("draft", "interviewing", "ready_for_approval", "approved", "ready_to_build", "being_built", "question", "shipped", "superseded")
READY_OR_FURTHER = ("ready_to_build", "being_built", "shipped")
READY_OR_FURTHER_MEANS = "marked ready to build, being built, or shipped"


def progress(work: Optional[Dict[str, Any]], current: Optional[Dict[str, Any]], saved: Any, unfinished: bool) -> Optional[str]:
    """One word for where the slice is. An approved slice is `ready_to_build` once it is saved (on
    GitHub or in the ready folder), then whatever its issue's state says; `approved` while saving it
    has not finished."""
    if work is None:
        return None
    status = work.get("status")
    if status != "approved_for_engineering":
        return status if status in PROGRESS else None
    if unfinished or saved not in ("github", "folder"):
        return "approved"
    label = (current or {}).get("state_label")
    return {"mach:building": "being_built", "mach:question": "question", "mach:shipped": "shipped"}.get(label, "ready_to_build")


def epic_counts(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """How many of an epic's slices are at each place, and how many are ready or further (what that means is said)."""
    places = [row["github"]["progress"] for row in rows if row["github"]["progress"] not in (None, "superseded")]
    return {"total": len(places), "by_progress": {name: places.count(name) for name in PROGRESS if places.count(name)},
            "ready_or_further": sum(1 for place in places if place in READY_OR_FURTHER), "ready_or_further_means": READY_OR_FURTHER_MEANS}


def slice_rows(data: Dict[str, Any], local: Dict[str, Dict[str, Any]], rules: Any) -> List[Dict[str, Any]]:
    seen = (data.get("seen") or {}).get("slices") or {}
    rows = []
    for slice_id in sorted(set(seen) | set(local) | set(data["slices"])):
        view = slice_view(data, slice_id, local.get(slice_id), rules)
        listed = seen.get(slice_id) or []
        if not listed and not view["saved"] and not view["unfinished"]:
            continue
        latest = max(listed, key=lambda row: row["issue"]) if listed else {}
        rows.append({"slice_id": slice_id, "in_workspace": slice_id in local, **view,
                     "on_github": [{key: row.get(key) for key in ("issue", "state", "state_label", "revision", "title", "matches_approval", "approved_by", "question")}
                                   for row in sorted(listed, key=lambda row: row["issue"])],
                     "title": latest.get("title") or (local.get(slice_id) or {}).get("title")})
    return rows


# ---- the product manager's order within an epic ----


def empty_order() -> Dict[str, Any]:
    return {"slices": [], "github": None, "move": None, "taken_at": None}


def clean_order(raw: Any, rules: Any) -> Dict[str, Dict[str, Any]]:
    """The order record as read back: per epic, the slice IDs in the product manager's order, GitHub's
    order as last read or written, and a move not yet finished on GitHub."""
    clean: Dict[str, Dict[str, Any]] = {}
    for epic_id, record in (raw.items() if isinstance(raw, dict) else []):
        if not isinstance(epic_id, str) or not rules.EPIC_ID_RE.fullmatch(epic_id) or not isinstance(record, dict):
            continue
        ids = lambda value: list(dict.fromkeys(item for item in value if isinstance(item, str) and rules.SLICE_ID_RE.fullmatch(item))) if isinstance(value, list) else []
        github = record.get("github") if isinstance(record.get("github"), dict) and rules.is_repository(record["github"].get("repository")) else None
        move = record.get("move") if isinstance(record.get("move"), dict) and record["move"].get("state") in ("trying", "done") else None
        clean[epic_id] = {"slices": ids(record.get("slices")), "taken_at": record.get("taken_at") if isinstance(record.get("taken_at"), str) else None,
                          "github": {**github, "slices": ids(github.get("slices"))} if github else None,
                          "move": {**move, "slices": ids(move.get("slices"))} if move else None}
    return clean


def rank_key(listed: Sequence[str]) -> Callable[[str], Tuple[int, str]]:
    """A sort key: the order the product manager set, then any other slices by slice ID."""
    listed = list(listed)
    return lambda slice_id: (listed.index(slice_id), "") if slice_id in listed else (len(listed), slice_id)


def relative(order: Sequence[str], among: Sequence[str]) -> List[str]:
    """`order` kept to the slices that are also in `among`."""
    return [slice_id for slice_id in order if slice_id in among]


def current_order(numbers: Sequence[int], number_to_slice: Dict[int, str]) -> List[str]:
    """Slice IDs in the order of their issues. A slice with several issues (shipped, then changed) is placed by its newest."""
    newest: Dict[str, Tuple[int, int]] = {}
    for at, number in enumerate(numbers):
        slice_id = number_to_slice.get(number)
        if slice_id and (slice_id not in newest or number > newest[slice_id][1]):
            newest[slice_id] = (at, number)
    return [slice_id for slice_id, _ in sorted(newest.items(), key=lambda item: item[1][0])]


def in_place(desired: Sequence[int], current: Sequence[int], moved: Optional[int] = None) -> set:
    """The largest set of sub-issues already in the wanted order relative to each other; only the others are moved.
    On a tie, the set that leaves out `moved` (the slice the product manager moved), so that slice is the one placed."""
    def largest(children: Sequence[int]) -> set:
        positions = [current.index(child) for child in children]
        best: List[List[int]] = []
        for at, position in enumerate(positions):
            longest = max((best[earlier] for earlier in range(at) if positions[earlier] < position), key=len, default=[])
            best.append(longest + [at])
        return {children[at] for at in max(best, key=len, default=[])}

    staying = largest(desired)
    if moved in staying:
        without = largest([child for child in desired if child != moved])
        if len(without) == len(staying):
            return without
    return staying


def merge_order(github: Sequence[str], mine: Sequence[str]) -> List[str]:
    """GitHub's order, with the slices only this workspace has kept just after the slice they followed here."""
    merged = list(github)
    for at, slice_id in enumerate(mine):
        if slice_id in merged:
            continue
        before = [other for other in mine[:at] if other in merged]
        merged.insert(merged.index(before[-1]) + 1 if before else 0, slice_id)
    return merged


def epic_number(data: Dict[str, Any], epic_id: str) -> Optional[int]:
    linked = (data["epics"].get(epic_id) or {}).get("number")
    if linked:
        return linked
    seen = sorted(item["number"] for item in (data.get("seen") or {}).get("epics") or [] if isinstance(item, dict) and item.get("epic_id") == epic_id)
    return seen[0] if seen else None


def issue_of(data: Dict[str, Any], slice_id: str) -> Optional[int]:
    """The slice's current issue: its own, else the newest open one GitHub holds for it, else the newest."""
    entry = data["slices"].get(slice_id) or {}
    if entry.get("number"):
        return entry["number"]
    rows = ((data.get("seen") or {}).get("slices") or {}).get(slice_id) or []
    waiting = [row["issue"] for row in rows if row.get("state") == "open" and row.get("state_label") != "mach:shipped"]
    return max(waiting or [row["issue"] for row in rows] or [0]) or None


def epic_members(data: Dict[str, Any], local: Dict[str, Dict[str, Any]], epic_id: str) -> List[str]:
    """The epic's slices: the drafts here that belong to it, and the slices GitHub lists under its issue."""
    number = epic_number(data, epic_id)
    members = {slice_id for slice_id, work in local.items() if work.get("epic_id") == epic_id}
    for slice_id, rows in ((data.get("seen") or {}).get("slices") or {}).items():
        if slice_id not in local and number and any(row.get("epic_issue") == number for row in rows):
            members.add(slice_id)
    return sorted(members)


def effective_order(data: Dict[str, Any], local: Dict[str, Dict[str, Any]], epic_id: str, rank: Callable[[str], Tuple[int, str]]) -> List[str]:
    return sorted(epic_members(data, local, epic_id), key=rank)


def order_rows(data: Dict[str, Any], local: Dict[str, Dict[str, Any]], rules: Any, epic_ids: Optional[Sequence[str]] = None) -> List[Dict[str, Any]]:
    """Each epic's slices in the product manager's order, and whether GitHub shows them in the same order."""
    seen = data.get("seen") or {}
    wanted = epic_ids if epic_ids is not None else sorted({work.get("epic_id") for work in local.values() if isinstance(work.get("epic_id"), str)}
                                                          | set(data["order"]) | set(data["epics"]))
    rows = []
    for epic_id in wanted:
        record = data["order"].get(epic_id) or empty_order()
        order = sorted(epic_members(data, local, epic_id), key=rank_key(record.get("slices") or []))
        github = record.get("github") or {}
        there = github.get("slices") if github.get("repository") == data.get("repository") else None
        slices = []
        for slice_id in order:
            number = issue_of(data, slice_id)
            row = next((item for item in (seen.get("slices") or {}).get(slice_id) or [] if item.get("issue") == number), {})
            slices.append({"slice_id": slice_id, "title": (local.get(slice_id) or {}).get("title") or row.get("title"), "in_workspace": slice_id in local,
                           "issue": number, "state_label": row.get("state_label")})
        on_github = [item["slice_id"] for item in slices if item["issue"]]
        unfinished = (record.get("move") or {}).get("state") == "trying"
        matches = None if there is None or not on_github else relative(there, order) == relative(order, there)
        taken = epic_id in (seen.get("order_taken") or [])
        note = ("Your new order is saved here but is not yet in place on GitHub. Move a slice again to finish; nothing is moved twice." if unfinished
                else "Another product manager changed this order on GitHub; their order was taken at the last refresh." if taken
                else "GitHub shows these slices in a different order from yours. Moving a slice puts your order in place." if matches is False
                else None)
        rows.append({"epic_id": epic_id, "issue": epic_number(data, epic_id), "slices": slices, "on_github": bool(on_github),
                     "github_order": list(there) if there is not None else None, "github_read_at": github.get("read_at") if there is not None else None,
                     "matches_github": matches, "unfinished": unfinished, "taken_from_github": taken,
                     "could_not_read": epic_id in (seen.get("order_not_read") or []), "note": note})
    return rows
