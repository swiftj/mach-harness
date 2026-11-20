#!/usr/bin/env python3
"""MACH's secrets and dependency scan: pure functions over a unified diff.

    secrets(diff)       candidates for a committed credential, read from the diff's ADDED lines only
    dependencies(diff)  every dependency a manifest change adds or changes the version of, and lock files changed alone

It finds candidates; it judges nothing. The build station refuses a commit that holds a candidate unless the builder
records why it is not a secret, and the review station hands every candidate and every new dependency to the security
seat, on a strong model, to answer. Nothing here is a vulnerability check: no package is looked up anywhere.

It lives with the intent station's other shared helpers (lifecycle.py, adr.py, claim.py) because the build and review
stations both use it and both already load that folder.

A secret's value is never returned. A candidate carries its file, line, kind and a preview of at most its first four
characters followed by a fixed mask. No network, no subprocess, no file reads: the same diff gives the same output.
Standard library only.
"""

import math
import re
from typing import Any, Dict, List, Optional, Tuple

VERSION = 1
MAX_SECRETS = 50
MAX_SKIPPED = 50
MAX_DEPENDENCIES = 200
MAX_LINE = 20000
MASK = "****"
GENERIC_MIN = 16
GENERIC_ENTROPY = 3.2
NO_VULNERABILITY_DATABASE = ("Dependencies were not checked against a vulnerability database: a model's knowledge ends at its training date. "
                             "Known-vulnerable versions it does not know of will not be caught here.")

# ---------------------------------------------------------------- the diff


# M15: a ticket the ticket station filed from a scanner's export (ticket.py ingest-scan) carries this label and a
# risk-medium or risk-high label. Its tier is a floor, held as product and monitoring work hold theirs: cell.py finalize
# raises the cell's tier to it and records `risk_floor`, and review.py never seats a panel below it.
SCAN_LABEL = "security-scan"
SCAN_FLOOR_WHY = {"Medium": "a security-scan ticket is never groomed or reviewed below Medium",
                  "High": "a security-scan ticket labelled risk-high is never groomed or reviewed below High"}


def risk_floor(labels: Any) -> Optional[str]:
    """The lowest risk tier a ticket with these labels may have: High for security-scan with risk-high, Medium for any
    other security-scan ticket, None for every other ticket. The labels are the source; nothing else is read."""
    names = {str(label).strip().lower() for label in labels or []} if isinstance(labels, (list, tuple, set)) else set()
    if SCAN_LABEL not in names:
        return None
    return "High" if "risk-high" in names else "Medium"


def parse_diff(diff: str) -> List[Dict[str, Any]]:
    """Each file in a unified diff: its new path (old path for a deletion), and its lines in order as
    (sign, old line number or None, new line number or None, text), sign being '+', '-' or ' '."""
    files: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    old = new = left_old = left_new = 0
    for raw in (diff or "").split("\n"):
        in_hunk = left_old > 0 or left_new > 0
        if in_hunk and current is not None:
            if raw.startswith("\\"):
                continue
            sign, text = raw[:1], raw[1:]
            if sign == "+" and left_new > 0:
                current["lines"].append(("+", None, new, text))
                new, left_new = new + 1, left_new - 1
                continue
            if sign == "-" and left_old > 0:
                current["lines"].append(("-", old, None, text))
                old, left_old = old + 1, left_old - 1
                continue
            if sign in (" ", "") and left_old > 0 and left_new > 0:
                current["lines"].append((" ", old, new, text))
                old, new, left_old, left_new = old + 1, new + 1, left_old - 1, left_new - 1
                continue
            left_old = left_new = 0  # a malformed hunk: stop reading it
        if raw.startswith("diff --git "):
            current = {"file": None, "old_file": None, "lines": [], "binary": False}
            files.append(current)
            match = re.match(r"^diff --git a/(.*) b/(.*)$", raw)
            if match:
                current["old_file"], current["file"] = match.group(1), match.group(2)
            continue
        if raw.startswith("--- ") and (current is None or current["lines"] or current.get("headed")):
            current = {"file": None, "old_file": None, "lines": [], "binary": False}  # a diff without the git header line
            files.append(current)
        if current is None:
            continue
        if raw.startswith("--- "):
            name = raw[4:].split("\t")[0]
            current["old_file"] = None if name == "/dev/null" else (name[2:] if name.startswith("a/") else name)
            current["headed"] = True
            continue
        if raw.startswith("+++ "):
            name = raw[4:].split("\t")[0]
            current["file"] = None if name == "/dev/null" else (name[2:] if name.startswith("b/") else name)
            continue
        if raw.startswith("Binary files ") or raw.startswith("GIT binary patch"):
            current["binary"] = True
            continue
        if raw.startswith("deleted file mode"):
            current["deleted_mode"] = True
        if raw.startswith("new file mode"):
            current["new_mode"] = True
        hunk = re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", raw)
        if hunk:
            old, new = int(hunk.group(1)), int(hunk.group(3))
            left_old = int(hunk.group(2)) if hunk.group(2) is not None else 1
            left_new = int(hunk.group(4)) if hunk.group(4) is not None else 1
            if left_old == 0:
                old += 1
            if left_new == 0:
                new += 1
    for item in files:
        item["path"] = item["file"] or item["old_file"] or ""
        item["deleted"] = item["file"] is None
    return [item for item in files if item["path"]]


# ---------------------------------------------------------------- secrets

SECRET_RULES: Tuple[Tuple[str, "re.Pattern[str]", int], ...] = (
    # (kind, pattern, group holding the value; 0 is the whole match)
    ("private-key", re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----"), 0),
    ("aws-access-key-id", re.compile(r"(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Z0-9])"), 0),
    ("aws-secret-access-key", re.compile(r"(?i)aws_?secret_?(?:access_?)?key[\"']?\s*(?:[:=]|:=|=>)\s*[\"']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])"), 1),
    ("github-token", re.compile(r"(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})"), 0),
    ("slack-token", re.compile(r"(?<![A-Za-z0-9])xox[abposre]-[A-Za-z0-9-]{10,}"), 0),
    ("slack-webhook", re.compile(r"https://hooks\.slack\.com/services/T[A-Za-z0-9_]+/B[A-Za-z0-9_]+/[A-Za-z0-9_]+"), 0),
    ("stripe-live-key", re.compile(r"(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{16,}"), 0),
    ("google-api-key", re.compile(r"(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])"), 0),
    ("jwt", re.compile(r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), 0),
    ("api-key", re.compile(r"(?<![A-Za-z0-9_-])sk-(?:proj-|ant-[a-z0-9]+-|live-|test-)?[A-Za-z0-9_-]{20,}"), 0),
    ("url-password", re.compile(r"(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,20}://[^\s:/@\"'`<>]+:([^\s@/\"'`<>]+)@[^\s/\"'`<>]+"), 1),
)
SECRET_NAME = r"[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_.-]?key|apikey|credential|private[_.-]?key|access[_.-]?key|auth[_.-]?key)[A-Za-z0-9_.-]*"
GENERIC_QUOTED = re.compile(r"(?i)[\"']?(" + SECRET_NAME + r")[\"']?\s*(?::=|=>|==?|:)\s*(?:[rbuf]{0,2})([\"'`])([^\"'`\s]*)\2")
GENERIC_BARE = re.compile(r"(?i)^\s*(?:export\s+)?(" + SECRET_NAME + r")\s*[=:]\s*([^\s\"'`#]+)\s*(?:#.*)?$")
BARE_FILES = re.compile(r"(?:^|/)\.env(?:\.[^/]*)?$|\.(?:env|properties|ini|cfg|conf|ya?ml|toml)$")
PLACEHOLDER = re.compile(
    r"(?i)x{4,}|\*{3,}|\.{3}|changeme|change[_-]me|replace[_-]?me|your[_-]|example|placeholder|dummy|redacted|sample|not[_-]?a[_-]?secret|"
    r"<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%\([^)]*\)s|^\$[A-Za-z_][A-Za-z0-9_]*$|^%[A-Za-z_]+%$|^\{[A-Za-z_][A-Za-z0-9_.]*\}$|^%s$|"
    r"process\.env|os\.environ|os\.getenv|getenv\(|ENV\[|System\.getenv|secrets\.|vault:|^none$|^null$|^true$|^false$")
ENV_READ = re.compile(r"process\.env|os\.environ|os\.getenv|getenv\(|ENV\[|System\.getenv|Environment\.GetEnvironmentVariable|std::env::var")
LOCK_FILE = re.compile(r"(?:^|/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|uv\.lock|"
                       r"Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum|packages\.lock\.json|gradle\.lockfile|bun\.lockb?)$")
TEST_PATH = re.compile(r"(?:^|/)(?:tests?|__tests__|spec|specs|fixtures?|testdata|test_data|__fixtures__|mocks?)/"
                       r"|(?:^|/)(?:test_[^/]*|[^/]*_test\.[A-Za-z0-9]+|[^/]*\.(?:test|spec)\.[A-Za-z0-9]+|conftest\.py)$")


def entropy(value: str) -> float:
    """Shannon entropy in bits per character."""
    if not value:
        return 0.0
    counts: Dict[str, int] = {}
    for char in value:
        counts[char] = counts.get(char, 0) + 1
    return -sum(count / len(value) * math.log2(count / len(value)) for count in counts.values())


def preview(value: str) -> str:
    """At most the first four characters, and fewer for a short value, then a fixed mask: never the value."""
    return value[:min(4, len(value) // 4)] + MASK


def placeholder(value: str, line: str) -> bool:
    return bool(PLACEHOLDER.search(value)) or bool(ENV_READ.search(line))


def secrets_in_line(path: str, text: str) -> Tuple[List[Tuple[str, str]], List[Tuple[str, str]]]:
    """(kind, value) found on one added line, and (kind, rule that skipped it) for each candidate set aside."""
    text = text[:MAX_LINE]
    found: List[Tuple[str, str]] = []
    skipped: List[Tuple[str, str]] = []
    spans: List[Tuple[int, int]] = []
    for kind, pattern, group in SECRET_RULES:
        for match in pattern.finditer(text):
            value = match.group(group)
            if kind != "private-key" and PLACEHOLDER.search(value):
                skipped.append((kind, "placeholder"))
                continue
            found.append((kind, value))
            spans.append(match.span())
    for match in list(GENERIC_QUOTED.finditer(text)) + ([] if not BARE_FILES.search(path) else list(GENERIC_BARE.finditer(text))):
        value = match.group(3) if match.re is GENERIC_QUOTED else match.group(2)
        if any(start <= match.start(match.lastindex) < end for start, end in spans):
            continue  # already a specific shape
        reason = None
        if LOCK_FILE.search(path):
            reason = "lockfile"
        elif TEST_PATH.search(path):
            reason = "test-path"
        elif placeholder(value, text):
            reason = "placeholder"
        elif len(value) < GENERIC_MIN:
            reason = "short-value"
        elif entropy(value) < GENERIC_ENTROPY:
            reason = "low-entropy"
        if reason:
            if value:
                skipped.append(("assigned-secret", reason))
            continue
        found.append(("assigned-secret", value))
    return found, skipped


def secrets(diff: str) -> Dict[str, Any]:
    """Candidates for a committed secret on the diff's added lines, sorted by file, line and kind."""
    candidates: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    for item in parse_diff(diff):
        if item["binary"] or item["deleted"]:
            continue
        for sign, _, number, text in item["lines"]:
            if sign != "+":
                continue
            found, set_aside = secrets_in_line(item["path"], text)
            for kind, value in found:
                candidates.append({"file": item["path"], "line": number, "kind": kind, "preview": preview(value)})
            for kind, rule in set_aside:
                skipped.append({"file": item["path"], "line": number, "kind": kind, "skipped_by": rule})
    order = lambda entry: (entry["file"], entry["line"] or 0, entry["kind"], entry.get("preview") or entry.get("skipped_by") or "")  # noqa: E731
    candidates = sorted({(c["file"], c["line"], c["kind"], c["preview"]): c for c in candidates}.values(), key=order)
    skipped = sorted({(s["file"], s["line"], s["kind"], s["skipped_by"]): s for s in skipped}.values(), key=order)
    return {"version": VERSION, "candidates": candidates[:MAX_SECRETS], "truncated": len(candidates) > MAX_SECRETS, "total": len(candidates),
            "skipped": skipped[:MAX_SKIPPED], "skipped_total": len(skipped)}


def secrets_in_text(text: str) -> List[str]:
    """The kinds of secret a piece of free text (a reason, a finding) would carry. Used to refuse such text."""
    kinds: List[str] = []
    for line in (text or "").splitlines() or [""]:
        found, _ = secrets_in_line("", line)
        kinds += [kind for kind, _ in found]
    return sorted(set(kinds))


# ---------------------------------------------------------------- dependencies

MANIFESTS: Tuple[Tuple["re.Pattern[str]", str, str], ...] = (
    (re.compile(r"(?:^|/)package\.json$"), "npm", "package_json"),
    (re.compile(r"(?:^|/)composer\.json$"), "composer", "composer_json"),
    (re.compile(r"(?:^|/)(?:[^/]*requirements[^/]*|constraints[^/]*)\.(?:txt|in)$"), "pypi", "requirements"),
    (re.compile(r"(?:^|/)pyproject\.toml$"), "pypi", "pyproject"),
    (re.compile(r"(?:^|/)Pipfile$"), "pypi", "pipfile"),
    (re.compile(r"(?:^|/)setup\.cfg$"), "pypi", "setup_cfg"),
    (re.compile(r"(?:^|/)setup\.py$"), "pypi", "setup_py"),
    (re.compile(r"(?:^|/)go\.mod$"), "go", "go_mod"),
    (re.compile(r"(?:^|/)Cargo\.toml$"), "cargo", "cargo"),
    (re.compile(r"(?:^|/)Gemfile$"), "rubygems", "gemfile"),
    (re.compile(r"(?:^|/)pom\.xml$"), "maven", "pom"),
    (re.compile(r"(?:^|/)build\.gradle(?:\.kts)?$"), "maven", "gradle"),
    (re.compile(r"\.csproj$"), "nuget", "csproj"),
)
REQUIREMENT = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*((?:===?|>=|<=|~=|!=|>|<)\s*[^;#\s,]+(?:\s*,\s*(?:===?|>=|<=|~=|!=|>|<)\s*[^;#\s,]+)*)?\s*(?:;.*)?$")
DEV_GROUPS = {"dev", "development", "test", "tests", "testing", "lint", "linting", "docs", "doc", "typing", "types", "check", "qa"}


def manifest_kind(path: str) -> Optional[Tuple[str, str]]:
    for pattern, ecosystem, parser in MANIFESTS:
        if pattern.search(path):
            return ecosystem, parser
    return None


def is_manifest(path: str) -> bool:
    return manifest_kind(path) is not None


def is_lock_file(path: str) -> bool:
    return bool(LOCK_FILE.search(path))


def pep503(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def requirement(text: str) -> Optional[Tuple[str, Optional[str]]]:
    text = text.strip()
    if not text or text.startswith(("#", "-", "git+", "http:", "https:", "file:", ".", "/")) or "://" in text:
        return None
    match = REQUIREMENT.match(text.split(" #")[0])
    if not match:
        return None
    return match.group(1), (re.sub(r"\s+", "", match.group(3)) if match.group(3) else None)


Dep = Dict[str, Any]


def add(found: Dict[str, Dep], name: str, version: Optional[str], dev: Optional[bool], scope: str, key: Optional[str] = None) -> None:
    found.setdefault(key or name.lower(), {"name": name, "version": version, "dev": dev, "scope": scope})


def parse_json_sections(lines: List[str], sections: Dict[str, Optional[bool]], skip: "re.Pattern[str]" = re.compile(r"$^")) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    section = None
    for line in lines:
        head = re.match(r'^\s*"([^"]+)"\s*:\s*\{\s*(\}\s*,?)?\s*$', line)
        if head:
            section = head.group(1) if head.group(1) in sections and not head.group(2) else None
            continue
        if section and re.match(r"^\s*\}", line):
            section = None
            continue
        entry = re.match(r'^\s*"([^"]+)"\s*:\s*"([^"]*)"', line)
        if section and entry and not skip.search(entry.group(1)):
            add(found, entry.group(1), entry.group(2), sections[section], section)
    return found


def parse_package_json(lines: List[str]) -> Dict[str, Dep]:
    return parse_json_sections(lines, {"dependencies": False, "devDependencies": True, "peerDependencies": False,
                                       "optionalDependencies": False})


def parse_composer_json(lines: List[str]) -> Dict[str, Dep]:
    return parse_json_sections(lines, {"require": False, "require-dev": True}, re.compile(r"^(?:php|ext-.*|lib-.*|composer-.*)$"))


def parse_requirements(lines: List[str], path: str) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    dev = bool(re.search(r"(?i)(?:^|[-_./])(?:dev|test|tests|lint|docs?)(?:[-_.]|$)", path.rsplit("/", 1)[-1]))
    for line in lines:
        parsed = requirement(line)
        if parsed:
            add(found, parsed[0], parsed[1], dev, "requirements", pep503(parsed[0]))
    return found


def toml_value_version(rest: str) -> Optional[str]:
    rest = rest.strip()
    quoted = re.match(r'^["\']([^"\']*)["\']', rest)
    if quoted:
        return quoted.group(1)
    inline = re.search(r'\bversion\s*=\s*["\']([^"\']*)["\']', rest)
    return inline.group(1) if inline else None


def parse_pyproject(lines: List[str]) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    table = ""
    array: Optional[Tuple[Optional[bool], str]] = None
    for line in lines:
        stripped = line.split("#", 1)[0].rstrip() if '"' not in line.split("#", 1)[0] else line.rstrip()
        head = re.match(r"^\s*\[+\s*([^\]]+?)\s*\]+\s*$", stripped)
        if head and array is None:
            table = head.group(1).strip()
            continue
        if array is None:
            key = re.match(r"^\s*([A-Za-z0-9_.\"-]+)\s*=\s*\[(.*)$", stripped)
            if key:
                name = key.group(1).strip('"')
                dev: Optional[bool] = None
                if table == "project" and name == "dependencies":
                    dev = False
                elif table == "project.optional-dependencies":
                    dev = name.lower() in DEV_GROUPS or None
                elif table == "dependency-groups":
                    dev = name.lower() in DEV_GROUPS or None
                elif table == "build-system" and name == "requires":
                    dev = True
                else:
                    continue
                array = (dev, f"{table}.{name}")
                stripped = key.group(2)
            elif table in ("tool.poetry.dependencies", "tool.poetry.dev-dependencies") or re.match(r"^tool\.poetry\.group\.[^.]+\.dependencies$", table):
                entry = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$", stripped)
                if entry and entry.group(1).lower() != "python":
                    group = re.match(r"^tool\.poetry\.group\.([^.]+)\.dependencies$", table)
                    dev = table.endswith("dev-dependencies") or bool(group and group.group(1).lower() in DEV_GROUPS)
                    add(found, entry.group(1), toml_value_version(entry.group(2)), dev, table, pep503(entry.group(1)))
                continue
            else:
                continue
        for item in re.findall(r'"([^"]+)"|\'([^\']+)\'', stripped):
            parsed = requirement(item[0] or item[1])
            if parsed:
                add(found, parsed[0], parsed[1], array[0], array[1], pep503(parsed[0]))
        if "]" in re.sub(r'"[^"]*"|\'[^\']*\'', "", stripped):
            array = None
    return found


def parse_pipfile(lines: List[str]) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    table = ""
    for line in lines:
        head = re.match(r"^\s*\[\s*([^\]]+?)\s*\]\s*$", line)
        if head:
            table = head.group(1)
            continue
        entry = re.match(r"^\s*\"?([A-Za-z0-9][A-Za-z0-9._-]*)\"?\s*=\s*(.+)$", line)
        if entry and table in ("packages", "dev-packages"):
            add(found, entry.group(1), toml_value_version(entry.group(2)), table == "dev-packages", table, pep503(entry.group(1)))
    return found


def parse_setup_cfg(lines: List[str]) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    section, key = "", None
    for line in lines:
        head = re.match(r"^\s*\[\s*([^\]]+?)\s*\]\s*$", line)
        if head:
            section, key = head.group(1), None
            continue
        start = re.match(r"^([A-Za-z0-9_.-]+)\s*=\s*(.*)$", line)
        if start:
            key = start.group(1)
            rest = start.group(2)
        elif key and re.match(r"^\s+\S", line):
            rest = line
        else:
            key = None if line.strip() == "" or not line[:1].isspace() else key
            continue
        if section == "options" and key in ("install_requires", "setup_requires", "tests_require"):
            dev, scope = key != "install_requires", key
        elif section == "options.extras_require":
            dev, scope = (key or "").lower() in DEV_GROUPS or None, f"extras.{key}"
        else:
            continue
        parsed = requirement(rest)
        if parsed:
            add(found, parsed[0], parsed[1], dev, scope, pep503(parsed[0]))
    return found


def parse_setup_py(lines: List[str]) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    active: Optional[Tuple[bool, str]] = None
    for line in lines:
        start = re.search(r"\b(install_requires|tests_require|setup_requires)\s*=\s*\[(.*)$", line)
        if start:
            active = (start.group(1) != "install_requires", start.group(1))
            line = start.group(2)
        if active is None:
            continue
        for item in re.findall(r'"([^"]+)"|\'([^\']+)\'', line):
            parsed = requirement(item[0] or item[1])
            if parsed:
                add(found, parsed[0], parsed[1], active[0], active[1], pep503(parsed[0]))
        if "]" in re.sub(r'"[^"]*"|\'[^\']*\'', "", line):
            active = None
    return found


def parse_go_mod(lines: List[str]) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    block = False
    for line in lines:
        text = line.strip()
        if re.match(r"^require\s*\($", text):
            block = True
            continue
        if block and text == ")":
            block = False
            continue
        entry = re.match(r"^(?:require\s+)?(\S+)\s+(v\S+)(\s*//\s*indirect)?", text) if block or text.startswith("require ") else None
        if entry:
            add(found, entry.group(1), entry.group(2), False, "indirect" if entry.group(3) else "require")
    return found


def parse_cargo(lines: List[str]) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    table, named = "", None
    for line in lines:
        head = re.match(r"^\s*\[\s*([^\]]+?)\s*\]\s*$", line)
        if head:
            table = head.group(1)
            named = None
            whole = re.match(r"^(?:target\..+\.)?(dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9_-]+)$", table)
            if whole:
                named = whole.group(2)
                add(found, named, None, whole.group(1) != "dependencies", whole.group(1))
            continue
        if named:
            version = re.match(r'^\s*version\s*=\s*["\']([^"\']*)["\']', line)
            if version:
                found[named.lower()]["version"] = version.group(1)
            continue
        kind = re.match(r"^(?:target\..+\.|workspace\.)?(dependencies|dev-dependencies|build-dependencies)$", table)
        entry = re.match(r"^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$", line)
        if kind and entry:
            add(found, entry.group(1), toml_value_version(entry.group(2)), kind.group(1) != "dependencies", kind.group(1))
    return found


def parse_gemfile(lines: List[str]) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    groups: List[bool] = []
    for line in lines:
        text = line.split("#", 1)[0].strip()
        group = re.match(r"^group\s+(.+?)\s+do$", text)
        if group:
            groups.append(bool(re.search(r":(?:development|test)\b|[\"'](?:development|test)[\"']", group.group(1))))
            continue
        if re.match(r"^(?:\w+\b.*\bdo(?:\s*\|.*\|)?|if\b.*|unless\b.*)$", text) and not text.startswith("gem "):
            groups.append(bool(groups and groups[-1]))
            continue
        if text == "end" and groups:
            groups.pop()
            continue
        gem = re.match(r"^gem\s+[\"']([^\"']+)[\"']\s*((?:,\s*[\"'][^\"']*[\"']\s*)*)(.*)$", text)
        if gem:
            versions = re.findall(r"[\"']([^\"']*)[\"']", gem.group(2))
            dev = bool(groups and groups[-1]) or bool(re.search(r"group:\s*\[?\s*:(?:development|test)", gem.group(3)))
            add(found, gem.group(1), ", ".join(versions) or None, dev, "group" if dev else "default")
    return found


def parse_pom(lines: List[str]) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    block: Optional[Dict[str, str]] = None
    for line in lines:
        if re.search(r"<dependency>", line):
            block = {}
        if block is not None:
            for tag in ("groupId", "artifactId", "version", "scope"):
                value = re.search(rf"<{tag}>\s*([^<]*?)\s*</{tag}>", line)
                if value:
                    block[tag] = value.group(1)
        if block is not None and re.search(r"</dependency>", line):
            if block.get("groupId") and block.get("artifactId"):
                name = f"{block['groupId']}:{block['artifactId']}"
                add(found, name, block.get("version"), block.get("scope") == "test", block.get("scope") or "compile")
            block = None
    return found


GRADLE = re.compile(r"^\s*([A-Za-z]+)\s*\(?\s*[\"']([^\"':\s]+):([^\"':\s]+)(?::([^\"'@\s]+))?(?:@[^\"']*)?[\"']")
GRADLE_MAP = re.compile(r"^\s*([A-Za-z]+)\s*\(?\s*group\s*[:=]\s*[\"']([^\"']+)[\"']\s*,\s*name\s*[:=]\s*[\"']([^\"']+)[\"'](?:\s*,\s*version\s*[:=]\s*[\"']([^\"']+)[\"'])?")
GRADLE_CONFIGS = re.compile(r"^(?:implementation|api|compileOnly|runtimeOnly|compile|runtime|kapt|ksp|annotationProcessor|classpath|"
                            r"testImplementation|testCompileOnly|testRuntimeOnly|testCompile|androidTestImplementation|debugImplementation|releaseImplementation|"
                            r"testFixturesImplementation|integrationTestImplementation|developmentOnly)$")


def parse_gradle(lines: List[str]) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    for line in lines:
        match = GRADLE_MAP.match(line) or GRADLE.match(line)
        if match and GRADLE_CONFIGS.match(match.group(1)):
            config = match.group(1)
            dev = config.lower().startswith(("test", "androidtest", "integrationtest", "debug", "developmentonly"))
            add(found, f"{match.group(2)}:{match.group(3)}", match.group(4), dev, config)
    return found


def parse_csproj(lines: List[str]) -> Dict[str, Dep]:
    found: Dict[str, Dep] = {}
    open_name: Optional[str] = None
    for line in lines:
        ref = re.search(r"<PackageReference\b([^>]*?)(/?)>", line)
        if ref:
            include = re.search(r'\bInclude\s*=\s*"([^"]+)"', ref.group(1))
            version = re.search(r'\bVersion\s*=\s*"([^"]+)"', ref.group(1))
            dev = bool(re.search(r'\bPrivateAssets\s*=\s*"all"', ref.group(1), re.IGNORECASE))
            if include:
                add(found, include.group(1), version.group(1) if version else None, dev, "PackageReference")
                open_name = None if ref.group(2) else include.group(1)
            continue
        if open_name:
            version = re.search(r"<Version>\s*([^<]*?)\s*</Version>", line)
            if version:
                found[open_name.lower()]["version"] = version.group(1)
            if re.search(r"<PrivateAssets>\s*all\s*</PrivateAssets>", line, re.IGNORECASE):
                found[open_name.lower()]["dev"] = True
            if "</PackageReference>" in line:
                open_name = None
    return found


PARSERS = {"package_json": parse_package_json, "composer_json": parse_composer_json, "pyproject": parse_pyproject, "pipfile": parse_pipfile,
           "setup_cfg": parse_setup_cfg, "setup_py": parse_setup_py, "go_mod": parse_go_mod, "cargo": parse_cargo, "gemfile": parse_gemfile,
           "pom": parse_pom, "gradle": parse_gradle, "csproj": parse_csproj}


def parse_manifest(parser: str, lines: List[str], path: str) -> Dict[str, Dep]:
    if parser == "requirements":
        return parse_requirements(lines, path)
    return PARSERS[parser](lines)


def dependencies(diff: str) -> Dict[str, Any]:
    """Every dependency a manifest change adds or whose version it changes. Each side of each manifest (context and
    removed lines; context and added lines) is read as a manifest, and the two are compared. A diff with full context
    (git diff -U<large> -- <manifests>) reads exactly; with less context a dependency's section may not show, and then
    its 'dev' is null (unknown) and it is treated as a runtime dependency."""
    found: List[Dict[str, Any]] = []
    manifests: List[str] = []
    locks: List[str] = []
    for item in parse_diff(diff):
        path = item["path"]
        if is_lock_file(path) and not item["binary"]:
            locks.append(path)
            continue
        kind = manifest_kind(path)
        if kind is None or item["binary"]:
            continue
        manifests.append(path)
        ecosystem, parser = kind
        before = [text for sign, _, _, text in item["lines"] if sign in (" ", "-")]
        after = [text for sign, _, _, text in item["lines"] if sign in (" ", "+")]
        old = parse_manifest(parser, before, path) if item["old_file"] else {}
        new = parse_manifest(parser, after, path) if not item["deleted"] else {}
        for key in sorted(new):
            dep = new[key]
            if key not in old:
                change, previous = "added", None
            elif (old[key].get("version") or "") != (dep.get("version") or ""):
                change, previous = "changed", old[key].get("version")
            else:
                continue
            found.append({"manifest": path, "ecosystem": ecosystem, "name": dep["name"], "version": dep.get("version"), "change": change,
                          "old_version": previous, "dev": dep.get("dev"), "scope": dep.get("scope")})
    folders = {path.rsplit("/", 1)[0] if "/" in path else "" for path in manifests}
    lockfile_only = sorted(path for path in locks if (path.rsplit("/", 1)[0] if "/" in path else "") not in folders)
    found.sort(key=lambda dep: (dep["manifest"], dep["name"].lower(), dep["scope"] or ""))
    return {"version": VERSION, "dependencies": found[:MAX_DEPENDENCIES], "truncated": len(found) > MAX_DEPENDENCIES, "total": len(found),
            "manifests": sorted(set(manifests)), "lockfile_only": lockfile_only}


def flagged_dependencies(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Added or changed dependencies that are not known to be development-only."""
    return [dep for dep in result.get("dependencies") or [] if dep.get("dev") is not True]
