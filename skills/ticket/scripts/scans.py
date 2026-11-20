"""MACH security scan intake (M15): a scanner's findings export read as data, as pure functions.

The ticket station's `ingest-scan` uses this module to read a findings export, make each finding safe
to store, decide its risk tier and give it a stable fingerprint. Nothing here writes a file, runs a
station or reaches the network; ticket.py files the tickets.

Two formats are read:

- SARIF 2.1.0 (OASIS Static Analysis Results Interchange Format), the fields named in FIELDS below,
  each as the specification defines it (section numbers given beside each use).
- A simple CSV with a header row: rule or title, severity, file, line, description, and optionally
  confidence, finding ID and status. Header names are matched without regard to case, spaces or
  underscores, with the aliases in CSV_COLUMNS.

Everything taken from the file is untrusted data. Each text is cleaned, checked line by line for the
secret shapes the build station refuses (skills/intent/scripts/scan.py, shared, never copied), with
any value found removed from every field, redacted with the shared rules (issue_rules.redact) and
bounded. A secret is reported by its kind and place only. The code snippet a scanner quotes is used
only, scrubbed, inside the fingerprint and is never written anywhere.

Standard library only.
"""

import csv
import hashlib
import importlib.util
import io
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import unquote, urlparse

import issue_rules

SKILL_DIR = Path(__file__).resolve().parent.parent
LABEL = "security-scan"
SEVERITIES = ("info", "low", "medium", "high", "critical")
DEFAULT_MIN_SEVERITY = "medium"
MAX_BYTES = 10 * 1024 * 1024  # a larger file is refused whole
MAX_FINDINGS = 5000  # findings read from one file; the rest are counted as skipped
MAX_NEW_TICKETS = 25  # tickets filed by one run; the rest wait for the next run, which files them first
TITLE_LIMIT = 160
RULE_LIMIT = 200
FILE_LIMIT = 400
DESCRIPTION_LIMIT = 4000
SNIPPET_LIMIT = 4000
SOURCE_RE = re.compile(r"[^a-z0-9-]+")
FINGERPRINT_RE = re.compile(r"^[0-9a-f]{16}$")

# SARIF: level (3.27.10) to a severity when no security-severity score is given.
LEVEL_SEVERITY = {"error": "high", "warning": "medium", "note": "low", "none": "info"}
# Words a CSV export may use for a severity.
SEVERITY_WORDS = {"critical": "critical", "crit": "critical", "high": "high", "error": "high", "medium": "medium", "moderate": "medium",
                  "med": "medium", "warning": "medium", "low": "low", "note": "low", "info": "info", "informational": "info", "none": "info"}
# CSV header aliases: our field, then the header names that mean it.
CSV_COLUMNS = {
    "title": ("rule", "title", "name", "rule id", "ruleid", "check"),
    "severity": ("severity", "level"),
    "file": ("file", "file path", "filepath", "path", "location"),
    "line": ("line", "line number", "start line", "startline"),
    "description": ("description", "message", "details"),
    "confidence": ("confidence", "precision"),
    "finding_id": ("finding id", "findingid", "id"),
    "status": ("status", "state"),
}
CSV_REQUIRED = ("title", "severity", "file", "line", "description")
CLOSED_STATUSES = ("dismissed", "closed", "resolved", "fixed", "false positive", "suppressed")

# What MACH's intent station raises to High (skills/intent/references/contracts-and-plan.md, "Risk tier"):
# sign-in or permissions, billing, a database schema, or a contract file that already exists on the main checkout.
AUTH_RE = re.compile(r"(?i)(?:^|[/_.-])(?:auth[a-z]*|login|logout|sign-?in|sign-?up|sessions?|passwords?|oauth[0-9]?|sso|saml|openid|"
                     r"permissions?|rbac|acls?|roles?|credentials?|access[-_]?control)(?=$|[/_.-])")
BILLING_RE = re.compile(r"(?i)(?:^|[/_.-])(?:billing|payments?|invoices?|invoicing|checkout|subscriptions?|stripe|charges?|refunds?|"
                        r"pricing|wallets?|ledger)(?=$|[/_.-])")
SCHEMA_RE = re.compile(r"(?i)(?:^|/)(?:schema\.prisma|schema\.rb|structure\.sql|[^/]*\.sql)$|(?:^|[/_.-])schema(?=$|[/_.-])")


class ScanError(Exception):
    """A problem with the file or the setup; nothing was filed."""


# ---------------------------------------------------------------- shared code from other stations

_LOADED: Dict[str, Any] = {}


def station_script(station: str, script: str) -> Any:
    """Another station's script, loaded once, whichever way MACH is installed."""
    key = f"{station}/{script}"
    if key not in _LOADED:
        names = ("mach", "run") if station == "run" else (f"mach-{station}", station)
        path = next((SKILL_DIR.parent / name / "scripts" / script for name in names if (SKILL_DIR.parent / name / "scripts" / script).is_file()), None)
        if path is None:
            raise ScanError(f"ingest-scan needs the MACH {station} station's {script} next to this skill ({SKILL_DIR.parent}); nothing was filed.")
        spec = importlib.util.spec_from_file_location(f"mach_scan_{station}_{script[:-3]}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _LOADED[key] = module
    return _LOADED[key]


def secret_scan() -> Any:
    return station_script("intent", "scan.py")


# ---------------------------------------------------------------- reading the file

def severity_word(value: Any) -> Optional[str]:
    """A severity from a word, or from a 0-10 score banded as GitHub code scanning bands security-severity."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return score_severity(float(value))
    text = " ".join(str(value or "").split()).lower()
    if not text:
        return None
    if text in SEVERITY_WORDS:
        return SEVERITY_WORDS[text]
    try:
        return score_severity(float(text))
    except ValueError:
        return None


def score_severity(score: float) -> Optional[str]:
    """GitHub's bands for a security-severity score: 9.0 and over critical, 7.0 high, 4.0 medium, 0.1 low.
    0.0 or anything outside 0-10 has no security severity."""
    if not 0.0 < score <= 10.0:
        return None
    return "critical" if score >= 9.0 else "high" if score >= 7.0 else "medium" if score >= 4.0 else "low"


def text_of(value: Any) -> str:
    """The text of a SARIF message or multiformatMessageString (3.11, 3.12): its text, else its markdown."""
    if isinstance(value, dict):
        value = value.get("text") if isinstance(value.get("text"), str) else value.get("markdown")
    return value if isinstance(value, str) else ""


def normal_path(uri: Any) -> str:
    """A file location as a project-relative path where it can be: file:// removed, percent-decoding undone, ./ dropped."""
    text = str(uri or "").strip()
    if text.lower().startswith("file:"):
        text = urlparse(text).path
    text = unquote(text).replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    return text


def sarif_findings(data: Any) -> Tuple[List[Dict[str, Any]], List[str], Optional[str]]:
    """The failing results of a SARIF 2.1.0 log, the reasons any were set aside, and the first tool's name."""
    if not isinstance(data, dict) or data.get("version") != "2.1.0" or not isinstance(data.get("runs"), list):
        raise ScanError("This is not a SARIF 2.1.0 log: its top level must have \"version\": \"2.1.0\" and a \"runs\" array (SARIF 3.13).")
    findings: List[Dict[str, Any]] = []
    skipped: List[str] = []
    tool_name = None
    for run in data["runs"]:
        if not isinstance(run, dict):
            skipped.append("a run that is not an object")
            continue
        driver = ((run.get("tool") or {}).get("driver") or {}) if isinstance(run.get("tool"), dict) else {}
        name = driver.get("name") if isinstance(driver, dict) and isinstance(driver.get("name"), str) else None  # 3.19.8
        tool_name = tool_name or name
        rules = driver.get("rules") if isinstance(driver, dict) and isinstance(driver.get("rules"), list) else []  # 3.19.23
        results = run.get("results")
        if results is None:
            continue
        if not isinstance(results, list):
            skipped.append("a run whose results are not an array")
            continue
        for result in results:
            if not isinstance(result, dict):
                skipped.append("a result that is not an object")
                continue
            kind = result.get("kind", "fail")  # 3.27.9: absent means fail
            if kind != "fail":
                skipped.append(f"not a failing result (kind {str(kind)[:20]})")
                continue
            if any(isinstance(s, dict) and s.get("status") == "accepted" for s in result.get("suppressions") or []):
                skipped.append("suppressed in the scanner (a suppression with status accepted, SARIF 3.35.3)")
                continue
            if result.get("baselineState") == "absent":
                skipped.append("no longer present (baselineState absent)")
                continue
            reference = result.get("rule") if isinstance(result.get("rule"), dict) else {}
            index = result.get("ruleIndex", reference.get("index"))  # 3.27.6, 3.27.7
            descriptor: Dict[str, Any] = {}
            if isinstance(index, int) and not isinstance(index, bool) and 0 <= index < len(rules) and isinstance(rules[index], dict):
                descriptor = rules[index]
            rule_id = result.get("ruleId") or reference.get("id") or descriptor.get("id")  # 3.27.5
            if not descriptor and isinstance(rule_id, str):
                descriptor = next((r for r in rules if isinstance(r, dict) and r.get("id") == rule_id), {})
            if not isinstance(rule_id, str) or not rule_id.strip():
                skipped.append("a result that names no rule")
                continue
            level = result.get("level") or (descriptor.get("defaultConfiguration") or {}).get("level") or "warning"  # 3.27.10
            props = result.get("properties") if isinstance(result.get("properties"), dict) else {}
            rule_props = descriptor.get("properties") if isinstance(descriptor.get("properties"), dict) else {}
            score = props.get("security-severity", rule_props.get("security-severity"))
            severity = severity_word(score) if score is not None else None
            severity = severity or LEVEL_SEVERITY.get(level)
            if severity is None:
                skipped.append("a result whose level is not error, warning, note or none")
                continue
            location = next((loc for loc in result.get("locations") or [] if isinstance(loc, dict)), {})  # 3.27.12
            physical = location.get("physicalLocation") if isinstance(location.get("physicalLocation"), dict) else {}
            artifact = physical.get("artifactLocation") if isinstance(physical.get("artifactLocation"), dict) else {}
            region = physical.get("region") if isinstance(physical.get("region"), dict) else {}
            line = region.get("startLine")  # 3.30.5
            partial = result.get("partialFingerprints") if isinstance(result.get("partialFingerprints"), dict) else {}  # 3.27.17
            findings.append({
                "tool": name, "rule": rule_id, "title": text_of(descriptor.get("shortDescription")) or descriptor.get("name") or rule_id,
                "severity": severity, "confidence": rule_props.get("precision") if isinstance(rule_props.get("precision"), str) else None,
                "file": normal_path(artifact.get("uri")), "line": line if isinstance(line, int) and not isinstance(line, bool) and line > 0 else None,
                "description": text_of(result.get("message")),  # 3.27.11
                "snippet": text_of(region.get("snippet")),  # 3.30.13
                "partial": json.dumps(sorted((str(k), str(v)) for k, v in partial.items())) if partial else None,
                "finding_id": result.get("guid") if isinstance(result.get("guid"), str) else None,  # 3.27.3
            })
    return findings, skipped, tool_name


def header_key(name: str) -> str:
    return " ".join(str(name or "").replace("_", " ").replace("-", " ").lower().split())


def csv_findings(text: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    """The rows of the documented CSV, and the reasons any were set aside."""
    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        raise ScanError("The CSV file is empty: it needs a header row.")
    except csv.Error as exc:
        raise ScanError(f"The CSV file cannot be read: {exc}")
    keys = [header_key(name) for name in header]
    columns: Dict[str, int] = {}
    for field, aliases in CSV_COLUMNS.items():
        for alias in aliases:
            if alias in keys:
                columns[field] = keys.index(alias)
                break
    missing = [field for field in CSV_REQUIRED if field not in columns]
    if missing:
        raise ScanError("The CSV header has no column for: " + ", ".join(missing) + ". It needs rule or title, severity, file, line and description "
                        "(confidence, finding ID and status are optional).")
    findings: List[Dict[str, Any]] = []
    skipped: List[str] = []
    try:
        for row in reader:
            if not any(cell.strip() for cell in row):
                continue
            cell = lambda field: row[columns[field]].strip() if field in columns and columns[field] < len(row) else ""  # noqa: E731
            if cell("status").lower() in CLOSED_STATUSES:
                skipped.append(f"marked {cell('status').lower()[:20]} in the export")
                continue
            severity = severity_word(cell("severity"))
            if severity is None:
                skipped.append("a row whose severity is not understood")
                continue
            if not cell("title") or not cell("file"):
                skipped.append("a row with no rule or title, or no file")
                continue
            line = int(cell("line")) if cell("line").isdigit() and int(cell("line")) > 0 else None
            findings.append({"tool": None, "rule": cell("title"), "title": cell("title"), "severity": severity, "confidence": cell("confidence") or None,
                             "file": normal_path(cell("file")), "line": line, "description": cell("description"), "snippet": "", "partial": None,
                             "finding_id": cell("finding_id") or None})
    except csv.Error as exc:
        raise ScanError(f"The CSV file cannot be read past row {reader.line_num}: {exc}")
    return findings, skipped


def read_findings(raw: bytes, fmt: Optional[str], name: str) -> Tuple[str, List[Dict[str, Any]], List[str], Optional[str]]:
    """(format, findings, skipped reasons, tool name) from the file's bytes."""
    if len(raw) > MAX_BYTES:
        raise ScanError(f"The file is {len(raw)} bytes; the limit is {MAX_BYTES}. Nothing was read. Export fewer findings, or split the file.")
    text = raw.decode("utf-8-sig", errors="replace")
    if fmt is None:
        lower = name.lower()
        fmt = "csv" if lower.endswith(".csv") else "sarif" if lower.endswith((".sarif", ".json")) or text.lstrip().startswith("{") else "csv"
    if fmt == "sarif":
        try:
            data = json.loads(text)
        except ValueError as exc:
            raise ScanError(f"The SARIF file is not valid JSON: {exc}")
        findings, skipped, tool = sarif_findings(data)
    else:
        findings, skipped = csv_findings(text)
        tool = None
    if len(findings) > MAX_FINDINGS:
        skipped += [f"beyond the first {MAX_FINDINGS} findings in one file"] * (len(findings) - MAX_FINDINGS)
        findings = findings[:MAX_FINDINGS]
    return fmt, findings, skipped, tool


# ---------------------------------------------------------------- making a finding safe

def secret_values(texts: Sequence[str], path: str) -> Tuple[List[str], List[str]]:
    """The values and kinds of every secret shape in these texts, line by line, as the build station's scan finds them."""
    scan = secret_scan()
    values: List[str] = []
    kinds: List[str] = []
    for text in texts:
        for line in issue_rules.clean_text(text or "").splitlines():
            found, _ = scan.secrets_in_line(path, line)
            for kind, value in found:
                kinds.append(kind)
                if value and len(value) >= 4:
                    values.append(value)
    return sorted(set(values), key=lambda v: (-len(v), v)), sorted(set(kinds))


def scrub(text: Any, values: Sequence[str], path: str, limit: int, one_line: bool = False) -> str:
    """Text from the file made safe to store: every secret value found anywhere in the finding removed, any line that
    still has a secret's shape replaced by its kind, then cleaned, redacted and bounded with the shared rules."""
    scan = secret_scan()
    text = issue_rules.clean_text(text if isinstance(text, str) else "")[:limit * 4]
    for value in values:
        text = text.replace(value, "<redacted>")
    kept = []
    for line in text.splitlines() or [""]:
        found, _ = scan.secrets_in_line(path, line)
        kept.append(f"[a {found[0][0]} was here; the value is not shown]" if found else line)
    return issue_rules.bound_text("\n".join(kept), limit, one_line=one_line)[0]


def region_basis(finding: Dict[str, Any], values: Sequence[str], path: str) -> str:
    """What locates the finding within its file, most stable first: the scrubbed snippet with its whitespace folded,
    the scanner's partial fingerprints, its finding ID, else the line."""
    snippet = " ".join(scrub(finding.get("snippet"), values, path, SNIPPET_LIMIT).split())
    if snippet:
        return "snippet:" + snippet
    if finding.get("partial"):
        return "partial:" + finding["partial"]
    if finding.get("finding_id"):
        return "id:" + str(finding["finding_id"])
    return "line:" + str(finding.get("line") or "")


def fingerprint(source: str, rule: str, path: str, region: str) -> str:
    return hashlib.sha256(json.dumps([source, rule, path, region], ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def safe_source(value: Any) -> str:
    return SOURCE_RE.sub("-", str(value or "").lower()).strip("-")[:40] or "scanner"


def prepare(finding: Dict[str, Any], source: str) -> Dict[str, Any]:
    """A finding as MACH keeps it: identifiers and redacted, bounded text, its secret kinds, and its fingerprint."""
    raw_path = normal_path(finding.get("file"))
    texts = [finding.get(key) or "" for key in ("title", "description", "snippet", "rule")]
    values, kinds = secret_values(texts, raw_path)
    path = scrub(raw_path, values, raw_path, FILE_LIMIT, one_line=True)
    rule = scrub(finding.get("rule"), values, raw_path, RULE_LIMIT, one_line=True)
    return {
        "source": source, "rule": rule, "title": scrub(finding.get("title"), values, raw_path, TITLE_LIMIT, one_line=True),
        "severity": finding["severity"], "confidence": scrub(finding.get("confidence"), values, raw_path, 40, one_line=True) or None,
        "file": path, "line": finding.get("line"), "description": scrub(finding.get("description"), values, raw_path, DESCRIPTION_LIMIT),
        "secret_kinds": kinds, "fingerprint": fingerprint(source, rule, path, region_basis(finding, values, raw_path)),
    }


# ---------------------------------------------------------------- risk

def git_has(project: Path, path: str) -> Optional[bool]:
    """Whether the main checkout's HEAD has this file; None when that cannot be told."""
    import subprocess
    try:
        done = subprocess.run(["git", "cat-file", "-e", f"HEAD:{path}"], cwd=str(project), capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode == 0:
        return True
    head = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=str(project), capture_output=True, text=True)
    return False if head.returncode == 0 else None


def risk_for(project: Path, path: str) -> Tuple[str, str]:
    """The tier a finding at this file starts from, and why. Security findings are never below Medium; a file under what
    the intent station raises to High (sign-in or permissions, billing, a database schema, an existing contract) is High.
    Grooming may raise the tier further and never lowers it."""
    contract_re = station_script("audit", "audit.py").CONTRACT_RE
    migration_dirs = station_script("run", "baseline.py").MIGRATION_DIRS
    lowered = path.lower()
    if contract_re.search(path):
        present = git_has(project, path)
        if present is None:
            present = (project / path).is_file()
        if present:
            return "High", "The finding is in a contract file that already exists on the main checkout; changing it is High risk."
    if any(lowered.startswith(prefix) or f"/{prefix}" in lowered for prefix in migration_dirs) or SCHEMA_RE.search(path):
        return "High", "The finding is in a database schema or migration file; a schema change is High risk."
    if AUTH_RE.search(path):
        return "High", "The finding is in code for sign-in or permissions, which is High risk."
    if BILLING_RE.search(path):
        return "High", "The finding is in code for billing or payments, which is High risk."
    return "Medium", "A security finding is never handled below Medium risk."
