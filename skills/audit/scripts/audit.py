#!/usr/bin/env python3
"""MACH readiness audit: is this repository fit for autonomous agents to work in?

    audit.py run   [--strict] [--fix] [--json] [--no-run] [--build-cmd C] [--test-cmd C] [--lint-cmd C]
    audit.py gate  [--max-age-days N]

'run' inspects the repository across five pillars, runs its build, tests and linter, scores it
out of 100 and writes .factory/audit-report.json. 'gate' reads that report and says whether
autonomous work may proceed; other stations call it before they touch code.

    Gold   90-100  full autonomy
    Silver 70-89   autonomous build, a person must review before merge
    Bronze  <70    blocked until the repository is hardened

A build or test suite that fails, is missing, or could not be run makes the tier Bronze whatever
the score, because agents cannot tell their own breakage from breakage that was already there.

Standard library only. It runs the project's own build, test and lint commands, which execute
the project's code: audit only repositories you would build yourself.
"""

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

REPORT = ".factory/audit-report.json"
TIERS = (("Gold", 90), ("Silver", 70))
STATUS = {"Gold": "APPROVED", "Silver": "APPROVED_WITH_HUMAN_REVIEW", "Bronze": "BLOCKED"}
TIMEOUTS = {"build": 600, "test": 300, "lint": 300}
SKIP_DIRS = {".git", ".factory", "node_modules", ".venv", "venv", "env", "__pycache__", "target", "dist", "build", ".tox", ".mypy_cache", ".pytest_cache", "vendor"}
PILLARS = (
    ("environment", "Reproducible environment and build", 25),
    ("test_health", "Baseline test suite health", 25),
    ("linting_security", "Linting, formatting and static analysis", 20),
    ("contracts", "Rules and boundary contracts", 15),
    ("git_hygiene", "Repository hygiene", 15),
)
TEST_FILE_RE = re.compile(
    r"(^|/)(test_[^/]+\.py|[^/]+_test\.(py|go|rb|rs)|[^/]+\.(test|spec)\.[cm]?[jt]sx?|[^/]+Tests?\.(java|kt|cs|swift))$"
    r"|(^|/)(tests?|__tests__|spec)/[^/]+\.[A-Za-z]+$|(^|/)src/test/"
)
CONTRACT_RE = re.compile(r"(\.proto$|(^|/)(openapi|swagger)[^/]*\.(ya?ml|json)$|\.schema\.json$|\.graphql$|\.avsc$|\.thrift$|\.d\.ts$)", re.IGNORECASE)
SECRET_SCANNERS = ("gitleaks", "detect-secrets", "trufflehog", "secretlint", "ggshield", "talisman")
GITIGNORE = {
    "base": [".DS_Store", "*.log", ".env", ".env.*", "!.env.example"],
    "python": ["__pycache__/", "*.py[cod]", ".venv/", "venv/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", "dist/", "build/", "*.egg-info/", ".coverage", "htmlcov/"],
    "node": ["node_modules/", "dist/", "build/", "coverage/", ".next/", "*.tsbuildinfo"],
    "go": ["bin/", "*.test", "*.out"],
    "rust": ["target/"],
    "java": ["target/", "build/", ".gradle/", "*.class"],
}


class AuditError(Exception):
    """A problem the caller can fix; printed without a traceback."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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


def git(project: Path, *args: str) -> Tuple[int, str]:
    if shutil.which("git") is None:
        return 127, ""
    done = subprocess.run(["git", *args], cwd=str(project), capture_output=True, text=True)
    return done.returncode, done.stdout


def read(path: Path, limit: int = 1_000_000) -> str:
    try:
        if path.stat().st_size > limit:
            return ""
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


class Repo:
    """What the audit knows about the repository before running anything."""

    def __init__(self, project: Path) -> None:
        self.project = project
        code, _ = git(project, "rev-parse", "--is-inside-work-tree")
        self.is_git = code == 0
        self.has_commits = self.is_git and git(project, "rev-parse", "--verify", "-q", "HEAD")[0] == 0
        self.head = git(project, "rev-parse", "HEAD")[1].strip() if self.has_commits else None
        # MACH's own installed files are not the project's code.
        self.files = [name for name in self._files() if not name.startswith((".claude/", ".factory/"))]
        self.names = {name.lower() for name in self.files}
        config = read(project / ".factory" / "config.json")
        try:
            loaded = json.loads(config) if config else {}
        except ValueError as exc:
            raise AuditError(f".factory/config.json is not valid JSON: {exc}")
        self.config = loaded if isinstance(loaded, dict) else {}
        self.audit_config = self.config.get("audit") if isinstance(self.config.get("audit"), dict) else {}
        self.pyproject = read(project / "pyproject.toml")
        self.package = self._json("package.json")
        self.make_targets = set(re.findall(r"^([A-Za-z0-9_.-]+)\s*:(?!=)", self._makefiles(), re.MULTILINE))
        self.stacks = self._stacks()

    def _files(self) -> List[str]:
        if self.is_git:
            code, out = git(self.project, "ls-files", "--cached", "--others", "--exclude-standard")
            if code == 0:
                return [line for line in out.splitlines() if line and (self.project / line).is_file()]
        found = []
        for path in self.project.rglob("*"):
            relative = path.relative_to(self.project)
            if path.is_file() and not SKIP_DIRS & set(relative.parts):
                found.append(relative.as_posix())
        return sorted(found)

    def _json(self, name: str) -> Dict[str, Any]:
        try:
            data = json.loads(read(self.project / name) or "{}")
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def _makefiles(self) -> str:
        """The Makefile plus anything it includes, so 'make test' in an included file is found."""
        text = ""
        for name in ("Makefile", "makefile", "GNUmakefile"):
            if (self.project / name).is_file():
                text = read(self.project / name)
                break
        for included in re.findall(r"^-?include\s+(.+)$", text, re.MULTILINE):
            for part in included.split():
                text += "\n" + read(self.project / part)
        return text

    def has(self, *names: str) -> bool:
        return any(name.lower() in self.names for name in names)

    def any_file(self, pattern: "re.Pattern[str]") -> List[str]:
        return [name for name in self.files if pattern.search(name)]

    def _stacks(self) -> List[str]:
        stacks = []
        if self.has("package.json"):
            stacks.append("node")
        if self.has("pyproject.toml", "setup.py", "setup.cfg", "requirements.txt") or (not stacks and any(n.endswith(".py") for n in self.files)):
            stacks.append("python")
        if self.has("go.mod"):
            stacks.append("go")
        if self.has("Cargo.toml"):
            stacks.append("rust")
        if self.has("pom.xml", "build.gradle", "build.gradle.kts"):
            stacks.append("java")
        return stacks

    def tool(self, section: str) -> bool:
        return bool(re.search(rf"^\[tool\.{re.escape(section)}(\.|\])", self.pyproject, re.MULTILINE))

    def node_runner(self) -> str:
        return "pnpm" if self.has("pnpm-lock.yaml") else "yarn" if self.has("yarn.lock") else "npm"

    def script(self, name: str) -> Optional[str]:
        scripts = self.package.get("scripts") if isinstance(self.package.get("scripts"), dict) else {}
        value = scripts.get(name)
        if not isinstance(value, str) or "no test specified" in value:
            return None
        runner = self.node_runner()
        return f"{runner} test" if name == "test" else f"{runner} run {name}"


def detect_commands(repo: Repo, overrides: Dict[str, Optional[str]]) -> Dict[str, Dict[str, Optional[str]]]:
    """Choose the build, test and lint commands: an explicit one wins, then make, then the stack's default."""
    found: Dict[str, Dict[str, Optional[str]]] = {}
    configured = repo.audit_config.get("commands") if isinstance(repo.audit_config.get("commands"), dict) else {}
    for kind in ("build", "test", "lint"):
        command, source = None, None
        if overrides.get(kind):
            command, source = overrides[kind], "argument"
        elif isinstance(configured.get(kind), str) and configured[kind].strip():
            command, source = configured[kind], "config"
        elif kind in repo.make_targets:
            command, source = f"make {kind}", "Makefile"
        else:
            for stack in repo.stacks:
                command = stack_command(repo, stack, kind)
                if command:
                    source = stack
                    break
        found[kind] = {"command": command, "source": source}
    return found


def stack_command(repo: Repo, stack: str, kind: str) -> Optional[str]:
    if stack == "node":
        return repo.script(kind) or (repo.script("check") if kind == "lint" else None) or ("builtin:no-build-step" if kind == "build" else None)
    if stack == "python":
        if kind == "build":
            return "builtin:python-syntax"
        if kind == "test":
            uses_pytest = repo.has("pytest.ini", "conftest.py") or repo.tool("pytest") or "pytest" in read(repo.project / "requirements.txt") or "pytest" in repo.pyproject
            if uses_pytest:
                return f"{sys.executable} -m pytest -q"
            if any(TEST_FILE_RE.search(name) and name.endswith(".py") for name in repo.files):
                folder = "tests" if (repo.project / "tests").is_dir() else "test" if (repo.project / "test").is_dir() else "."
                return f"{sys.executable} -m unittest discover -s {folder}"
            return None
        if repo.has("ruff.toml", ".ruff.toml") or repo.tool("ruff"):
            return "ruff check ."
        if repo.has(".flake8") or "[flake8]" in read(repo.project / "setup.cfg") + read(repo.project / "tox.ini"):
            return "flake8"
        return None
    if stack == "go":
        lint = "golangci-lint run" if repo.has(".golangci.yml", ".golangci.yaml", ".golangci.toml") else "go vet ./..."
        return {"build": "go build ./...", "test": "go test ./...", "lint": lint}[kind]
    if stack == "rust":
        return {"build": "cargo build --quiet", "test": "cargo test --quiet", "lint": "cargo clippy --quiet -- -D warnings"}[kind]
    if stack == "java":
        if repo.has("pom.xml"):
            return {"build": "mvn -q -DskipTests package", "test": "mvn -q test", "lint": None}[kind]
        wrapper = "./gradlew" if repo.has("gradlew") else "gradle"
        return {"build": f"{wrapper} assemble -q", "test": f"{wrapper} test -q", "lint": None}[kind]
    return None


def python_syntax(repo: Repo) -> Tuple[int, str]:
    """A build for a language with no build step: every tracked Python file must at least compile."""
    problems = []
    for name in repo.files:
        if not name.endswith(".py"):
            continue
        try:
            compile(read(repo.project / name, 5_000_000), name, "exec")
        except (SyntaxError, ValueError) as exc:
            problems.append(f"{name}:{getattr(exc, 'lineno', '?')}: {getattr(exc, 'msg', exc)}")
    return (1, "\n".join(problems)) if problems else (0, "")


def execute(repo: Repo, kind: str, command: Optional[str], timeouts: Dict[str, int], skip: bool) -> Dict[str, Any]:
    result: Dict[str, Any] = {"command": command, "status": "missing", "exit_code": None, "seconds": None, "output_tail": ""}
    if not command:
        return result
    if command == "builtin:no-build-step":
        return {**result, "status": "pass", "output_tail": "This project declares no build step."}
    if command == "builtin:python-syntax":
        code, out = python_syntax(repo)
        return {**result, "status": "pass" if code == 0 else "fail", "exit_code": code, "seconds": 0, "output_tail": out[-2000:]}
    if skip:
        return {**result, "status": "skipped"}
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        return {**result, "status": "fail", "output_tail": f"Cannot parse the command: {exc}"}
    env = dict(os.environ)
    while argv and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):  # leading VAR=value, as in a shell
        key, value = argv.pop(0).split("=", 1)
        env[key] = value
    if not argv or shutil.which(argv[0]) is None and not (repo.project / argv[0]).is_file():
        return {**result, "status": "unavailable", "output_tail": f"'{argv[0] if argv else command}' is not installed or not on PATH."}
    started = time.monotonic()
    try:
        done = subprocess.run(argv, cwd=str(repo.project), capture_output=True, text=True, errors="replace", timeout=timeouts[kind], stdin=subprocess.DEVNULL, env=env)
    except subprocess.TimeoutExpired:
        return {**result, "status": "timeout", "seconds": timeouts[kind], "output_tail": f"Still running after {timeouts[kind]} seconds; stopped."}
    except OSError as exc:
        return {**result, "status": "unavailable", "output_tail": str(exc)}
    tail = (done.stdout + ("\n" + done.stderr if done.stderr else "")).strip()[-2000:]
    return {**result, "status": "pass" if done.returncode == 0 else "fail", "exit_code": done.returncode, "seconds": round(time.monotonic() - started, 1), "output_tail": tail}


class Card:
    def __init__(self) -> None:
        self.checks: List[Dict[str, Any]] = []
        self.blockers: List[str] = []

    def add(self, pillar: str, check: str, maximum: int, ok: Any, note: str, fix: str = "", status: Optional[str] = None) -> bool:
        """Record one check. `ok` may be True, False, or a number of points for partial credit."""
        points = maximum if ok is True else 0 if ok is False or ok is None else max(0, min(maximum, int(ok)))
        status = status or ("pass" if points == maximum else "fail" if points == 0 else "warning")
        self.checks.append({"pillar": pillar, "check": check, "score": points, "max": maximum, "status": status, "note": note, "fix": "" if status == "pass" else fix})
        return points == maximum


RUN_NOTES = {
    "missing": "No command found.", "skipped": "Not run (--no-run).", "unavailable": "The tool is not installed here.",
    "timeout": "Did not finish in time.", "fail": "Exited with an error.", "pass": "Passed.",
}


def audit(repo: Repo, runs: Dict[str, Dict[str, Any]], dirty_before: Optional[List[str]]) -> Card:
    card = Card()
    project = repo.project
    lower_files = [name.lower() for name in repo.files]

    # 1. Environment and build
    pillar = "environment"
    markers = ("Makefile", "Dockerfile", "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "setup.py", "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts")
    present = [m for m in markers if repo.has(m)] + ([".devcontainer/"] if any(n.startswith(".devcontainer/") for n in lower_files) else [])
    card.add(pillar, "Build definition present", 5, bool(present), ", ".join(present) or "No Makefile, Dockerfile or package manifest found.",
             "Add the manifest for your language, or a Makefile with build and test targets.")
    card.add(pillar, "Dependencies are locked", 5, *lock_state(repo))
    build = runs["build"]
    card.add(pillar, "One-command build exists", 5, bool(build["command"]), build["command"] or "No build command could be found.",
             "Add a 'build' target to the Makefile, or set audit.commands.build in .factory/config.json.")
    card.add(pillar, "Build runs cleanly", 10, build["status"] == "pass", run_note(build),
                     "Fix the build so it passes from a clean checkout with one command.", status=run_status(build))
    if build["status"] != "pass":
        card.blockers.append({"fail": "The build fails.", "timeout": "The build fails.", "missing": "There is no build command."}.get(
            build["status"], "The build could not be verified here."))

    # 2. Tests
    pillar = "test_health"
    tests = runs["test"]
    test_files = repo.any_file(TEST_FILE_RE)
    card.add(pillar, "Tests exist", 5, bool(test_files), f"{len(test_files)} test file(s)." if test_files else "No test files found.",
             "Add a test suite; agents cannot work test-first without one.")
    card.add(pillar, "One-command test run exists", 5, bool(tests["command"]), tests["command"] or "No test command could be found.",
             "Add a 'test' target to the Makefile, or set audit.commands.test in .factory/config.json.")
    card.add(pillar, "Every test passes", 10, tests["status"] == "pass", run_note(tests), "Make the suite 100% green before any agent changes code.",
             status=run_status(tests))
    limit = TIMEOUTS["test"]
    fast = tests["status"] == "pass" and (tests["seconds"] or 0) < limit
    card.add(pillar, "Suite finishes in under 5 minutes", 5, fast, f"{tests['seconds']} seconds." if fast else "Not counted: the suite did not pass." if tests["status"] == "fail" else RUN_NOTES.get(tests["status"], "Not measured."),
             "Split or speed up the suite; agents rerun it after every change.", status=run_status(tests))
    if not test_files or not tests["command"]:
        card.blockers.append("There is no runnable test suite.")
    elif tests["status"] != "pass":
        card.blockers.append("The baseline tests do not pass." if tests["status"] in ("fail", "timeout") else "The tests could not be verified here.")

    # 3. Linting, formatting, static analysis
    pillar = "linting_security"
    lint = runs["lint"]
    typed = [s for s in repo.stacks if s in ("go", "rust", "java")]
    card.add(pillar, "Linter configured", 6, bool(lint["command"]), lint["command"] or "No linter configuration found.",
             "Configure a linter (ruff, eslint, golangci-lint, clippy) and add a 'lint' target.")
    card.add(pillar, "Linter passes", 6, lint["status"] == "pass", run_note(lint), "Fix or explicitly suppress every lint finding.",
             status=run_status(lint))
    formatter = (typed and "built into the language tooling") or next((n for n in (".prettierrc", ".prettierrc.json", ".prettierrc.js", ".prettierrc.yaml", "prettier.config.js", "biome.json", ".editorconfig", "rustfmt.toml", ".clang-format") if repo.has(n)), None) \
        or ("pyproject.toml" if repo.tool("black") or repo.tool("ruff") else None) or ("package.json" if "prettier" in repo.package else None) or ("ruff.toml" if repo.has("ruff.toml", ".ruff.toml") else None)
    card.add(pillar, "Formatter configured", 3, bool(formatter), str(formatter or "No formatter configuration found."), "Configure a formatter (prettier, ruff format, black, gofmt).")
    types = (typed and "statically typed language") or next((n for n in ("tsconfig.json", "mypy.ini", "pyrightconfig.json", ".mypy.ini") if repo.has(n)), None) or ("pyproject.toml" if repo.tool("mypy") or repo.tool("pyright") else None)
    card.add(pillar, "Type checking in place", 3, bool(types), str(types or "No type checker configured."), "Configure a type checker (mypy, pyright, TypeScript strict mode).")
    hooks = "".join(read(project / name) for name in repo.files if name == ".pre-commit-config.yaml" or name.startswith(".github/workflows/") or name == ".gitlab-ci.yml").lower()
    scanner = next((s for s in SECRET_SCANNERS if s in hooks), None) or (".gitleaks.toml" if repo.has(".gitleaks.toml") else None)
    card.add(pillar, "Secret scanning configured", 2, bool(scanner), str(scanner or "No secret scanner in pre-commit hooks or CI."), "Add a secret scanner such as gitleaks to pre-commit or CI.")

    # 4. Rules and contracts
    pillar = "contracts"
    for name, points in (("CLAUDE.md", 3), ("AGENTS.md", 2), ("REVIEW.md", 2)):
        card.add(pillar, f"{name} present", points, repo.has(name), "Found." if repo.has(name) else "Missing.", "Run the MACH scaffold to create it, then edit it for this project.")
    readme = next((n for n in repo.files if n.lower() in ("readme.md", "readme.rst", "readme.txt", "readme")), None)
    thin = bool(readme) and len(read(project / str(readme)).strip()) <= 200
    card.add(pillar, "README present", 3, bool(readme) and not thin, f"{readme} is nearly empty." if thin else str(readme or "Missing."),
             "Write a README that says what the project is and how to build and test it.")
    contracts = repo.any_file(CONTRACT_RE)
    card.add(pillar, "Typed boundary contracts present", 5, bool(contracts), f"{len(contracts)} contract file(s), such as {contracts[0]}." if contracts else "No Protocol Buffers, OpenAPI, JSON Schema or type declaration files found.",
             "Describe each boundary other code depends on in proto/ (Protocol Buffers, OpenAPI or JSON Schema). The intent station writes these for new slices.")

    # 5. Git hygiene
    pillar = "git_hygiene"
    card.add(pillar, "Git repository with history", 3, repo.has_commits, "Has commits." if repo.has_commits else "Not a git repository." if not repo.is_git else "No commits yet.",
             "Run 'git init' and make a first commit; cells are git worktrees and need history.")
    if dirty_before is None:
        card.add(pillar, "Clean working tree", 4, False, "Not a git repository.", "Commit the project to git.")
    else:
        card.add(pillar, "Clean working tree", 4, not dirty_before, "Nothing uncommitted." if not dirty_before else f"{len(dirty_before)} uncommitted or untracked path(s), such as {dirty_before[0]}.",
                 "Commit, ignore or remove the uncommitted files before autonomous work starts.")
    card.add(pillar, "A .gitignore is present", 3, repo.has(".gitignore"), "Found." if repo.has(".gitignore") else "Missing.", "Add a .gitignore (run the audit with --fix to create one).")
    conflicted = [name for name in repo.files if re.search(r"^<<<<<<< .*\n(?:.*\n)*?^>>>>>>> ", read(project / name, 500_000), re.MULTILINE)]
    card.add(pillar, "No merge conflict markers", 3, not conflicted, "None found." if not conflicted else f"Conflict markers in {', '.join(conflicted[:3])}.", "Resolve the conflicts.")
    protected, note = branch_protection(repo)
    card.add(pillar, "Main branch protected", 2, protected is True, note, "Protect the default branch so nothing merges without review.", status=None if protected is not None else "unknown")
    return card


def run_status(result: Dict[str, Any]) -> Optional[str]:
    """Checks that could not be run are 'unknown', not failures of the repository."""
    return "unknown" if result["status"] in ("skipped", "unavailable") else None


def run_note(result: Dict[str, Any]) -> str:
    note = RUN_NOTES.get(result["status"], result["status"])
    if result["status"] in ("fail", "timeout", "unavailable") and result["output_tail"]:
        note += " " + result["output_tail"].strip().splitlines()[-1][:160]
    elif result["status"] == "pass" and result["seconds"] is not None:
        note = f"Passed in {result['seconds']} seconds."
    return note


def lock_state(repo: Repo) -> Tuple[bool, str, str]:
    fix = "Commit a lockfile so every agent builds against the same dependency versions."
    checks = []
    if "node" in repo.stacks:
        has_deps = any(repo.package.get(key) for key in ("dependencies", "devDependencies"))
        checks.append(("node", not has_deps or repo.has("package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb")))
    if "python" in repo.stacks:
        requirements = [line.strip() for line in read(repo.project / "requirements.txt").splitlines() if line.strip() and not line.strip().startswith(("#", "-"))]
        declared = bool(requirements) or bool(re.search(r"^\s*dependencies\s*=\s*\[\s*[\"']", repo.pyproject, re.MULTILINE)) or "[tool.poetry.dependencies]" in repo.pyproject
        pinned = bool(requirements) and all("==" in line or " @ " in line for line in requirements)
        checks.append(("python", not declared or pinned or repo.has("uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock", "requirements.lock")))
    if "go" in repo.stacks:
        checks.append(("go", repo.has("go.sum") or "require" not in read(repo.project / "go.mod")))
    if "rust" in repo.stacks:
        checks.append(("rust", repo.has("Cargo.lock")))
    if "java" in repo.stacks:
        checks.append(("java", True))
    if not checks:
        return False, "No recognized package manifest.", fix
    unlocked = [stack for stack, ok in checks if not ok]
    return (not unlocked, "Locked, or no dependencies declared." if not unlocked else f"No lockfile or pinned versions for: {', '.join(unlocked)}.", fix)


def branch_protection(repo: Repo) -> Tuple[Optional[bool], str]:
    if not repo.has_commits:
        return None, "Not checked: no git history."
    remote = git(repo.project, "remote", "get-url", "origin")[1].strip()
    match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", remote)
    if not match or shutil.which("gh") is None:
        return None, "Not verifiable from here: needs a GitHub remote and the gh tool." if not match else "Not verifiable from here: the gh tool is not installed."
    branch = git(repo.project, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")[1].strip().split("/", 1)[-1] or "main"
    try:
        done = subprocess.run(["gh", "api", f"repos/{match.group(1)}/branches/{branch}", "--jq", ".protected"], cwd=str(repo.project), capture_output=True, text=True, timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        return None, "Not verifiable from here: GitHub did not answer."
    if done.returncode != 0:
        return None, "Not verifiable from here: GitHub refused the request."
    protected = done.stdout.strip() == "true"
    return protected, f"'{branch}' is protected on GitHub." if protected else f"'{branch}' is not protected on GitHub."


def tier_for(score: int, blockers: Sequence[str], config: Dict[str, Any]) -> str:
    if blockers:
        return "Bronze"
    for name, default in TIERS:
        threshold = config.get(name.lower(), default)
        if score >= (threshold if isinstance(threshold, (int, float)) else default):
            return name
    return "Bronze"


def fix_gitignore(repo: Repo) -> Optional[str]:
    if repo.has(".gitignore"):
        return None
    lines = list(GITIGNORE["base"])
    for stack in repo.stacks:
        lines += [entry for entry in GITIGNORE.get(stack, []) if entry not in lines]
    (repo.project / ".gitignore").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return "Created .gitignore for: " + (", ".join(repo.stacks) or "general use") + "."


def cmd_run(project: Path, args: argparse.Namespace) -> int:
    repo = Repo(project)
    fixed = []
    if args.fix:
        made = fix_gitignore(repo)
        if made:
            fixed.append(made)
            repo = Repo(project)
    dirty = None
    if repo.is_git:
        # The factory's own working files (tickets, reports, installed skills) change as stations run; they are not project work.
        dirty = [line[3:].strip().strip('"') for line in git(project, "status", "--porcelain")[1].splitlines() if line.strip()]
        dirty = [name for name in dirty if not name.startswith((".factory/", ".claude/"))]
    timeouts = dict(TIMEOUTS)
    timeouts.update({k: v for k, v in (repo.audit_config.get("timeouts") or {}).items() if k in TIMEOUTS and isinstance(v, int) and v > 0})
    commands = detect_commands(repo, {"build": args.build_cmd, "test": args.test_cmd, "lint": args.lint_cmd})
    runs = {kind: execute(repo, kind, commands[kind]["command"], timeouts, args.no_run) for kind in ("build", "test", "lint")}
    card = audit(repo, runs, dirty)

    pillars = {}
    for key, _, maximum in PILLARS:
        own = [check for check in card.checks if check["pillar"] == key]
        score = sum(check["score"] for check in own)
        failing = [check["check"] for check in own if check["status"] != "pass"]
        pillars[key] = {"score": score, "max": maximum, "status": "pass" if score == maximum else "warning" if score >= maximum * 0.6 else "fail"}
        if failing:
            pillars[key]["note"] = "; ".join(failing)
    score = sum(p["score"] for p in pillars.values())
    tier = tier_for(score, card.blockers, repo.audit_config)
    unverified = [check["check"] for check in card.checks if check["status"] == "unknown"]
    recommendations = [f"{check['fix']} (+{check['max'] - check['score']})" for check in sorted(card.checks, key=lambda c: c["score"] - c["max"]) if check["fix"]]
    report = {
        "timestamp": now(),
        "repository": project.name,
        "head": repo.head,
        "stacks": repo.stacks,
        "readiness_score": score,
        "readiness_tier": tier,
        "pipeline_status": STATUS[tier],
        "human_review_required": tier == "Silver",
        "blockers": card.blockers,
        "pillars": pillars,
        "checks": card.checks,
        "commands": {kind: {**commands[kind], **{k: v for k, v in runs[kind].items() if k != "command"}} for kind in runs},
        "unverified": unverified,
        "recommendations": recommendations,
        "fixed": fixed,
    }
    path = project / REPORT
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"MACH readiness: {score}/100  {tier}  ({STATUS[tier]})   {project.name}")
        for key, title, maximum in PILLARS:
            print(f"\n  {title}: {pillars[key]['score']}/{maximum}")
            for check in (c for c in card.checks if c["pillar"] == key):
                mark = {"pass": "ok  ", "warning": "part", "fail": "FAIL", "unknown": "??  "}[check["status"]]
                print(f"    {mark} {check['score']:>2}/{check['max']:<2} {check['check']}: {check['note']}")
        for blocker in card.blockers:
            print(f"\n  BLOCKER: {blocker} The tier is Bronze until this is fixed, whatever the score.")
        if recommendations:
            print("\n  To improve, most valuable first:")
            for line in recommendations[:8]:
                print(f"    - {line}")
        for line in fixed:
            print(f"\n  Fixed: {line}")
        print(f"\n  Report: {path}")
    if tier == "Bronze" or (args.strict and tier != "Gold"):
        return 1
    return 0


def cmd_gate(project: Path, args: argparse.Namespace) -> int:
    path = project / REPORT
    result: Dict[str, Any] = {"allowed": False, "tier": None, "human_review_required": False, "reason": ""}
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        result["reason"] = "No readable audit report. Run the audit first."
        print(json.dumps(result, indent=2))
        return 1
    repo = Repo(project)
    maximum = args.max_age_days if args.max_age_days is not None else repo.audit_config.get("max_age_days", 7)
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(report["timestamp"])).total_seconds() / 86400
    except (KeyError, ValueError):
        age = float("inf")
    tier = report.get("readiness_tier")
    result.update({"tier": tier, "score": report.get("readiness_score"), "human_review_required": tier == "Silver"})
    if report.get("head") != repo.head:
        result["reason"] = "The audit report is for a different commit than the one checked out. Run the audit again."
    elif age > maximum:
        result["reason"] = f"The audit report is {int(age)} days old (limit {maximum}). Run the audit again."
    elif tier not in ("Gold", "Silver"):
        result["reason"] = "The repository is Bronze: autonomous work is blocked until it is hardened. " + " ".join(report.get("blockers") or [])
    else:
        result["allowed"] = True
        result["reason"] = "Full autonomy." if tier == "Gold" else "Autonomous build is allowed, but a person must review before merge."
    print(json.dumps(result, indent=2))
    return 0 if result["allowed"] else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MACH repository readiness audit.")
    parser.add_argument("--project", type=Path, help="project root (default: nearest folder with .factory/ or .git)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run", help="audit the repository and write .factory/audit-report.json")
    p.add_argument("--strict", action="store_true", help="exit 1 unless the tier is Gold")
    p.add_argument("--fix", action="store_true", help="create a missing .gitignore before auditing")
    p.add_argument("--json", action="store_true", help="print the report as JSON instead of the scorecard")
    p.add_argument("--no-run", action="store_true", help="inspect only; do not run the build, tests or linter (their checks score 0)")
    for kind in ("build", "test", "lint"):
        p.add_argument(f"--{kind}-cmd", help=f"the {kind} command to use instead of the detected one")
    p.set_defaults(func=cmd_run)
    p = sub.add_parser("gate", help="say whether autonomous work may proceed, from the last report")
    p.add_argument("--max-age-days", type=int, help="oldest acceptable report (default: audit.max_age_days in config, else 7)")
    p.set_defaults(func=cmd_gate)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        project = args.project.resolve() if args.project else find_project(Path.cwd())
        if not project.is_dir():
            raise AuditError(f"{project} is not a folder.")
        return args.func(project, args)
    except AuditError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
