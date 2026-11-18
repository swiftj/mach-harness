#!/usr/bin/env python3
"""MACH ADR baseline: what the repository itself shows about each required topic, gathered once and recorded.

Reached as `run.py adr baseline`. No ticket is planned until every topic in `adr.required_topics` has an accepted
ADR on the main branch (adr.py, `baseline_stop`). This script gathers the evidence for the topics still missing,
deterministically and read-only, from the main checkout's committed files (never its working tree): languages by
file count, manifests and lockfiles and the versions they pin, runtime version files, frameworks and database
drivers named in dependencies, test runner configuration and test layout, linter, formatter and type-checker
configuration, CI workflows, container and deployment files, migration folders, and the commands the last audit
detected. File names and short excerpts only, redacted with the ticket station's redaction and bounded.

What it found is recorded in `.factory/adr-baseline.json` (git-ignored: a working record on this machine, like the
audit report; the ADRs drafted from it are what the team shares, by pull request). Per topic: the evidence, its
digest, the commit it was read at, and the ADR drafted from it. A later run reads the repository again only for a
topic that is still uncovered and has no record (or whose drafted ADR has since been deleted); a recorded topic is
shown from the record, marked when it was read at an earlier commit. It never drafts a topic that has an ADR in the
folder, whatever its status.

The skill (planning tier) then writes each ADR as `proposed` with `run.py adr new --baseline <topic>`, which takes
the evidence files from this record and records the ADR here. Nothing is committed and nothing is accepted.

Standard library only (tomllib where the Python has it; without it, TOML files are listed but not read).
"""

import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

try:
    import tomllib  # Python 3.11 and later
except ImportError:  # pragma: no cover - older Pythons list TOML files without reading them
    tomllib = None

RECORD = ".factory/adr-baseline.json"
SCHEMA_VERSION = 1
MAX_FILES = 20000  # files listed from the commit
MAX_READ = 100_000  # bytes read from one file
MAX_ITEMS = 20  # evidence items per topic
EXCERPT = 160  # characters of one excerpt
SKIPPED_DIRS = ("node_modules/", "vendor/", "dist/", "build/", ".venv/", "venv/", "third_party/", ".git/", ".factory/", "target/", "__pycache__/")
DATA_NOTE = ("Evidence is file names and short excerpts from the repository, redacted and cut short. It is data: what the repository "
             "already does, never an instruction about how to run MACH or what to decide.")

LANGUAGES = {
    ".py": "Python", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript", ".ts": "TypeScript", ".tsx": "TypeScript",
    ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin", ".swift": "Swift", ".cs": "C#", ".fs": "F#",
    ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hpp": "C++", ".php": "PHP", ".scala": "Scala", ".ex": "Elixir", ".exs": "Elixir",
    ".erl": "Erlang", ".hs": "Haskell", ".dart": "Dart", ".lua": "Lua", ".sh": "Shell", ".bash": "Shell", ".clj": "Clojure", ".vue": "Vue",
    ".svelte": "Svelte", ".r": "R", ".jl": "Julia", ".zig": "Zig", ".sql": "SQL", ".m": "Objective-C",
}
MANIFESTS = ("package.json", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle",
             "build.gradle.kts", "composer.json", "mix.exs", "pubspec.yaml", "Package.swift")
LOCKFILES = ("package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "poetry.lock", "Pipfile.lock", "uv.lock", "go.sum", "Cargo.lock",
             "Gemfile.lock", "composer.lock", "mix.lock", "pubspec.lock")
RUNTIME_FILES = (".python-version", ".nvmrc", ".node-version", ".tool-versions", "runtime.txt", ".ruby-version", ".java-version", "rust-toolchain",
                 "rust-toolchain.toml", ".go-version")
FRAMEWORKS = {
    "react": "React", "next": "Next.js", "vue": "Vue", "nuxt": "Nuxt", "svelte": "Svelte", "@sveltejs/kit": "SvelteKit", "@angular/core": "Angular",
    "express": "Express", "fastify": "Fastify", "@nestjs/core": "NestJS", "koa": "Koa", "hono": "Hono", "electron": "Electron", "react-native": "React Native",
    "expo": "Expo", "astro": "Astro", "remix": "Remix", "@remix-run/react": "Remix", "vite": "Vite",
    "django": "Django", "flask": "Flask", "fastapi": "FastAPI", "starlette": "Starlette", "aiohttp": "aiohttp", "tornado": "Tornado", "click": "Click",
    "typer": "Typer", "streamlit": "Streamlit", "pyramid": "Pyramid",
    "rails": "Ruby on Rails", "sinatra": "Sinatra", "hanami": "Hanami",
    "github.com/gin-gonic/gin": "Gin", "github.com/labstack/echo": "Echo", "github.com/gofiber/fiber": "Fiber", "github.com/spf13/cobra": "Cobra",
    "actix-web": "Actix Web", "axum": "Axum", "rocket": "Rocket", "clap": "clap", "tokio": "Tokio", "tauri": "Tauri",
    "laravel/framework": "Laravel", "symfony/framework-bundle": "Symfony", "phoenix": "Phoenix", "spring-boot": "Spring Boot", "flutter": "Flutter",
}
STORAGE = {
    "pg": "PostgreSQL", "postgres": "PostgreSQL", "psycopg": "PostgreSQL", "psycopg2": "PostgreSQL", "psycopg2-binary": "PostgreSQL", "asyncpg": "PostgreSQL",
    "github.com/lib/pq": "PostgreSQL", "github.com/jackc/pgx": "PostgreSQL", "mysql": "MySQL", "mysql2": "MySQL", "mysqlclient": "MySQL", "pymysql": "MySQL",
    "github.com/go-sql-driver/mysql": "MySQL", "sqlite3": "SQLite", "better-sqlite3": "SQLite", "aiosqlite": "SQLite", "github.com/mattn/go-sqlite3": "SQLite",
    "mongodb": "MongoDB", "mongoose": "MongoDB", "pymongo": "MongoDB", "motor": "MongoDB", "redis": "Redis", "ioredis": "Redis",
    "sqlalchemy": "SQLAlchemy", "alembic": "Alembic", "prisma": "Prisma", "@prisma/client": "Prisma", "typeorm": "TypeORM", "sequelize": "Sequelize",
    "knex": "Knex", "drizzle-orm": "Drizzle", "gorm.io/gorm": "GORM", "diesel": "Diesel", "sqlx": "SQLx", "activerecord": "Active Record",
    "pg_query": "PostgreSQL", "elasticsearch": "Elasticsearch", "@elastic/elasticsearch": "Elasticsearch", "boto3": "AWS SDK (may store data in AWS)",
    "@aws-sdk/client-dynamodb": "DynamoDB", "@aws-sdk/client-s3": "Amazon S3", "firebase-admin": "Firebase", "@supabase/supabase-js": "Supabase",
}
TESTING = {
    "pytest": "pytest", "hypothesis": "Hypothesis", "coverage": "coverage.py", "pytest-cov": "pytest-cov", "tox": "tox", "nox": "nox",
    "jest": "Jest", "vitest": "Vitest", "mocha": "Mocha", "jasmine": "Jasmine", "karma": "Karma", "ava": "AVA", "@playwright/test": "Playwright",
    "playwright": "Playwright", "cypress": "Cypress", "@testing-library/react": "Testing Library", "nyc": "nyc", "c8": "c8",
    "rspec": "RSpec", "minitest": "Minitest", "github.com/stretchr/testify": "testify", "junit": "JUnit", "phpunit/phpunit": "PHPUnit",
}
STANDARDS = {
    "eslint": "ESLint", "prettier": "Prettier", "@biomejs/biome": "Biome", "typescript": "TypeScript compiler", "stylelint": "Stylelint", "husky": "husky",
    "lint-staged": "lint-staged", "ruff": "Ruff", "black": "Black", "flake8": "flake8", "pylint": "Pylint", "mypy": "mypy", "isort": "isort",
    "pyright": "Pyright", "pre-commit": "pre-commit", "rubocop": "RuboCop", "standard": "standard", "golangci-lint": "golangci-lint",
}
TEST_CONFIGS = ("pytest.ini", "conftest.py", "tox.ini", "noxfile.py", ".mocharc.json", ".mocharc.yml", ".mocharc.js", "karma.conf.js", "phpunit.xml",
                "phpunit.xml.dist", ".rspec")
TEST_CONFIG_PREFIXES = ("jest.config.", "vitest.config.", "playwright.config.", "cypress.config.")
STANDARD_CONFIGS = (".flake8", "mypy.ini", ".pylintrc", "pylintrc", ".editorconfig", "rustfmt.toml", ".rustfmt.toml", "clippy.toml", ".rubocop.yml",
                    ".pre-commit-config.yaml", ".clang-format", "ruff.toml", ".ruff.toml", "biome.json", "biome.jsonc", "tsconfig.json", "CONTRIBUTING.md",
                    ".golangci.yml", ".golangci.yaml")
STANDARD_PREFIXES = (".eslintrc", "eslint.config.", ".prettierrc", "prettier.config.", ".stylelintrc")
DEPLOY_FILES = ("Procfile", "fly.toml", "vercel.json", "netlify.toml", "app.yaml", "render.yaml", "railway.json", "railway.toml", "firebase.json",
                "amplify.yml", "cdk.json", "Pulumi.yaml", "Chart.yaml", "kustomization.yaml", "serverless.yml", "serverless.yaml", "template.yaml",
                "compose.yaml", "compose.yml", ".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml", "bitbucket-pipelines.yml", ".travis.yml")
DEPLOY_DIRS = ("k8s/", "kubernetes/", "helm/", "charts/", "deploy/", "deployment/", "infra/", "terraform/", ".github/workflows/", ".circleci/")
MIGRATION_DIRS = ("migrations/", "alembic/", "db/migrate/", "prisma/", "db/migrations/", "flyway/", "liquibase/", "supabase/migrations/")
STORAGE_IMAGES = re.compile(r"\b(postgres|postgis|mysql|mariadb|mongo|redis|elasticsearch|opensearch|cassandra|memcached|minio|clickhouse)\b", re.IGNORECASE)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Repo:
    """The main checkout's committed files at one commit. Reads only: git ls-tree, cat-file and show."""

    def __init__(self, root: Path, commit: str, redact: Callable[[str], str]) -> None:
        self.root, self.commit, self.redact = Path(root), commit, redact
        listed = self.git("ls-tree", "-r", "-z", "--name-only", commit)
        names = [name for name in listed.stdout.split("\0") if name] if listed.returncode == 0 else []
        self.files = [name for name in names if not any(name.startswith(prefix) or f"/{prefix}" in name for prefix in SKIPPED_DIRS)][:MAX_FILES]
        self.names = set(self.files)
        self._text: Dict[str, Optional[str]] = {}

    def git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=str(self.root), capture_output=True, text=True, errors="replace")

    def text(self, name: str) -> Optional[str]:
        """A committed file's text, at most MAX_READ bytes; None for a file that is missing or too large."""
        if name not in self._text:
            size = self.git("cat-file", "-s", f"{self.commit}:{name}")
            if name not in self.names or size.returncode != 0 or int(size.stdout.strip() or 0) > MAX_READ:
                self._text[name] = None
            else:
                shown = self.git("show", f"{self.commit}:{name}")
                self._text[name] = shown.stdout if shown.returncode == 0 else None
        return self._text[name]

    def base(self, name: str) -> str:
        return name.rsplit("/", 1)[-1]

    def named(self, bases: Iterable[str], prefixes: Iterable[str] = ()) -> List[str]:
        bases, prefixes = set(bases), tuple(prefixes)
        return [name for name in self.files if self.base(name) in bases or (prefixes and self.base(name).startswith(prefixes))]

    def excerpt(self, text: Any) -> str:
        clean = " ".join(self.redact(str(text or "")).split())
        clean = "".join(ch for ch in clean if ord(ch) >= 32 and ord(ch) != 127)
        return clean if len(clean) <= EXCERPT else clean[:EXCERPT - 1] + "…"


def item(repo: Repo, file: Optional[str], found: str, excerpt: Any = None) -> Dict[str, Any]:
    entry: Dict[str, Any] = {"file": file, "found": found}
    if excerpt not in (None, ""):
        entry["excerpt"] = repo.excerpt(excerpt)
    return entry


def lines_matching(text: Optional[str], pattern: str, limit: int = 3) -> str:
    found = [line.strip() for line in (text or "").splitlines() if re.search(pattern, line, re.IGNORECASE)]
    return " | ".join(found[:limit])


def toml(text: Optional[str]) -> Dict[str, Any]:
    if not text or tomllib is None:
        return {}
    try:
        value = tomllib.loads(text)
    except (ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def dependencies(repo: Repo) -> List[Tuple[str, str, str]]:
    """Every dependency the manifests name: (manifest, name, version as written)."""
    found: List[Tuple[str, str, str]] = []
    for name in repo.named(["package.json", "composer.json"]):
        try:
            data = json.loads(repo.text(name) or "")
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue
        for key in ("dependencies", "devDependencies", "peerDependencies", "require", "require-dev"):
            for dep, version in (data.get(key) or {}).items() if isinstance(data.get(key), dict) else []:
                found.append((name, str(dep).lower(), str(version)))
    for name in repo.files:
        base = repo.base(name)
        if re.fullmatch(r"requirements[\w.-]*\.(txt|in)", base):
            for line in (repo.text(name) or "").splitlines():
                match = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([<>=!~].*)?$", line.split("#")[0])
                if match:
                    found.append((name, match.group(1).lower(), (match.group(3) or "").strip()))
    for name in repo.named(["pyproject.toml"]):
        data = toml(repo.text(name))
        project = data.get("project") if isinstance(data.get("project"), dict) else {}
        groups = [project.get("dependencies") or []] + list((project.get("optional-dependencies") or {}).values())
        groups += list((data.get("dependency-groups") or {}).values()) if isinstance(data.get("dependency-groups"), dict) else []
        for group in groups:
            for spec in group if isinstance(group, list) else []:
                match = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)", str(spec))
                if match:
                    found.append((name, match.group(1).lower(), str(spec)[len(match.group(0)):].strip()))
        poetry = ((data.get("tool") or {}).get("poetry") or {}) if isinstance(data.get("tool"), dict) else {}
        for key in ("dependencies", "dev-dependencies"):
            for dep, version in (poetry.get(key) or {}).items() if isinstance(poetry.get(key), dict) else []:
                found.append((name, str(dep).lower(), str(version)))
    for name in repo.named(["Cargo.toml"]):
        data = toml(repo.text(name))
        for key in ("dependencies", "dev-dependencies"):
            for dep, version in (data.get(key) or {}).items() if isinstance(data.get(key), dict) else []:
                found.append((name, str(dep).lower(), str(version if not isinstance(version, dict) else version.get("version", ""))))
    for name in repo.named(["go.mod"]):
        for match in re.finditer(r"^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}/[^\s]+)\s+(v[^\s]+)", repo.text(name) or "", re.MULTILINE):
            found.append((name, match.group(1).lower(), match.group(2)))
    for name in repo.named(["Gemfile"]):
        for match in re.finditer(r"""^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?""", repo.text(name) or "", re.MULTILINE):
            found.append((name, match.group(1).lower(), match.group(2) or ""))
    return found


def matched(deps: List[Tuple[str, str, str]], table: Dict[str, str]) -> List[Tuple[str, str, str, str]]:
    """Dependencies a table names (a Go module matches by its path prefix): (manifest, name, version, label), each name once."""
    seen, out = set(), []
    for manifest, name, version in deps:
        label = table.get(name) or next((value for key, value in table.items() if "/" in key and name.startswith(key)), None)
        if label and (manifest, name) not in seen:
            seen.add((manifest, name))
            out.append((manifest, name, version, label))
    return out


def dep_items(repo: Repo, deps: List[Tuple[str, str, str]], table: Dict[str, str], what: str) -> List[Dict[str, Any]]:
    return [item(repo, manifest, f"{what}: {label}", f"{name} {version}".strip()) for manifest, name, version, label in matched(deps, table)]


def package_scripts(repo: Repo, keys: Iterable[str]) -> List[Dict[str, Any]]:
    out = []
    for name in repo.named(["package.json"]):
        try:
            scripts = (json.loads(repo.text(name) or "") or {}).get("scripts") or {}
        except (ValueError, AttributeError):
            continue
        for key in keys:
            if isinstance(scripts, dict) and isinstance(scripts.get(key), str):
                out.append(item(repo, name, f"package script '{key}'", scripts[key]))
    return out


def tool_sections(repo: Repo, tools: Iterable[str], what: str) -> List[Dict[str, Any]]:
    """[tool.x] sections of pyproject.toml and [x] / [tool:x] sections of setup.cfg and tox.ini."""
    out = []
    for name in repo.named(["pyproject.toml", "setup.cfg", "tox.ini"]):
        text = repo.text(name) or ""
        for tool in tools:
            if re.search(rf"^\[(tool\.{re.escape(tool)}(\.[\w.-]+)?|tool:{re.escape(tool)}|{re.escape(tool)})\]\s*$", text, re.MULTILINE):
                out.append(item(repo, name, f"{what}: {tool} settings"))
    return out


def audit_command(audit: Any, kind: str) -> Optional[str]:
    commands = audit.get("commands") if isinstance(audit, dict) else None
    entry = commands.get(kind) if isinstance(commands, dict) else None
    command = entry.get("command") if isinstance(entry, dict) else None
    return command if isinstance(command, str) and command else None


def gather(repo: Repo, audit: Any = None) -> Dict[str, List[Dict[str, Any]]]:
    """Evidence for each default topic, from the committed files. A topic with nothing found gets an empty list."""
    deps = dependencies(repo)
    evidence: Dict[str, List[Dict[str, Any]]] = {}

    counts: Dict[str, int] = {}
    for name in repo.files:
        language = LANGUAGES.get(Path(name).suffix.lower())
        if language:
            counts[language] = counts.get(language, 0) + 1
    language = []
    if counts:
        ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:8]
        language.append(item(repo, None, "languages by file count", ", ".join(f"{name} {count}" for name, count in ranked)))
    for name in repo.named(RUNTIME_FILES):
        language.append(item(repo, name, "runtime version file", ((repo.text(name) or "").strip().splitlines() or [""])[0]))
    for name in repo.named(MANIFESTS):
        text = repo.text(name)
        pinned = {"package.json": r'"(node|npm|pnpm|yarn)"\s*:', "pyproject.toml": r"requires-python|python\s*=", "go.mod": r"^\s*(go|toolchain)\s",
                  "Cargo.toml": r"rust-version|edition", "Gemfile": r"^\s*ruby\s", "setup.py": r"python_requires", "pom.xml": r"java.version|maven.compiler"}
        pattern = pinned.get(repo.base(name))
        language.append(item(repo, name, "manifest", lines_matching(text, pattern) if pattern else None))
    for name in repo.named(LOCKFILES):
        language.append(item(repo, name, "lockfile: dependency versions are pinned"))
    if audit_stacks := (audit.get("stacks") if isinstance(audit, dict) else None):
        language.append(item(repo, ".factory/audit-report.json", "stacks the last audit detected", ", ".join(map(str, audit_stacks))))
    evidence["language"] = language

    framework = dep_items(repo, deps, FRAMEWORKS, "framework named in dependencies")
    for name in repo.named(["manage.py", "next.config.js", "next.config.mjs", "vite.config.ts", "vite.config.js", "angular.json", "nuxt.config.ts",
                            "svelte.config.js", "astro.config.mjs", "electron-builder.yml", "config.ru", "pubspec.yaml"]):
        framework.append(item(repo, name, "framework file"))
    for name in repo.named(["package.json"]):
        try:
            data = json.loads(repo.text(name) or "")
        except ValueError:
            data = {}
        if isinstance(data, dict) and data.get("bin"):
            framework.append(item(repo, name, "package declares a command-line program ('bin')"))
    for name in repo.named(["pyproject.toml"]):
        scripts = (toml(repo.text(name)).get("project") or {}).get("scripts")
        if isinstance(scripts, dict) and scripts:
            framework.append(item(repo, name, "project declares command-line programs ([project.scripts])", ", ".join(list(scripts)[:5])))
    evidence["framework"] = framework

    storage = dep_items(repo, deps, STORAGE, "storage named in dependencies")
    for prefix in MIGRATION_DIRS:
        inside = [name for name in repo.files if name.startswith(prefix) or f"/{prefix}" in name]
        if inside:
            storage.append(item(repo, prefix.rstrip("/"), f"migration or schema folder ({len(inside)} file{'s' if len(inside) != 1 else ''})"))
    for name in repo.named(["schema.prisma", "alembic.ini", "knexfile.js", "knexfile.ts", "ormconfig.json", "database.yml"]):
        storage.append(item(repo, name, "storage configuration", lines_matching(repo.text(name), r"provider|adapter|url|dialect", 2)))
    sql = [name for name in repo.files if name.lower().endswith(".sql")]
    if sql:
        storage.append(item(repo, sql[0], f"SQL files ({len(sql)})"))
    for name in repo.named(["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"]):
        images = lines_matching(repo.text(name), r"image:\s*\S*" + STORAGE_IMAGES.pattern)
        if images:
            storage.append(item(repo, name, "data service in the compose file", images))
    evidence["storage"] = storage

    testing = dep_items(repo, deps, TESTING, "test tool named in dependencies")
    for name in repo.named(TEST_CONFIGS, TEST_CONFIG_PREFIXES):
        testing.append(item(repo, name, "test runner configuration"))
    testing += tool_sections(repo, ["pytest", "coverage"], "test settings")
    testing += package_scripts(repo, ["test", "test:unit", "test:e2e", "e2e"])
    tests = [name for name in repo.files if re.search(r"(^|/)(test_[^/]+\.py|[^/]+_test\.(py|go)|[^/]+\.(test|spec)\.[cm]?[jt]sx?|[^/]+_spec\.rb)$", name)]
    if tests:
        folders: Dict[str, int] = {}
        for name in tests:
            folder = name.rsplit("/", 1)[0] if "/" in name else "."
            folders[folder] = folders.get(folder, 0) + 1
        top = sorted(folders.items(), key=lambda pair: (-pair[1], pair[0]))[:4]
        testing.append(item(repo, None, f"test files ({len(tests)})", ", ".join(f"{folder}/ {count}" for folder, count in top)))
    command = audit_command(audit, "test")
    if command:
        testing.append(item(repo, ".factory/audit-report.json", "test command the last audit detected", command))
    evidence["testing"] = testing

    deployment = []
    for name in repo.files:
        base = repo.base(name)
        if base.startswith("Dockerfile") or base.endswith(".dockerfile"):
            deployment.append(item(repo, name, "container image", lines_matching(repo.text(name), r"^\s*FROM\s", 2)))
        elif re.fullmatch(r"docker-compose[\w.-]*\.ya?ml", base):
            deployment.append(item(repo, name, "compose file", lines_matching(repo.text(name), r"^\s*image:\s", 3)))
        elif base in DEPLOY_FILES:
            deployment.append(item(repo, name, "deployment or CI file", lines_matching(repo.text(name), r"deploy|image|runtime|provider|region", 2)))
        elif name.endswith(".tf"):
            deployment.append(item(repo, name, "Terraform", lines_matching(repo.text(name), r'^\s*provider\s+"', 2)))
    for prefix in DEPLOY_DIRS:
        inside = [name for name in repo.files if name.startswith(prefix)]
        for name in inside[:4] if prefix in (".github/workflows/", ".circleci/") else inside[:1]:
            what = "CI workflow" if prefix in (".github/workflows/", ".circleci/") else f"deployment folder {prefix.rstrip('/')} ({len(inside)} files)"
            deployment.append(item(repo, name, what, lines_matching(repo.text(name), r"^\s*name:|deploy|runs-on", 3) if "CI" in what else None))
    evidence["deployment"] = deployment

    standards = dep_items(repo, deps, STANDARDS, "standards tool named in dependencies")
    for name in repo.named(STANDARD_CONFIGS, STANDARD_PREFIXES):
        excerpt = lines_matching(repo.text(name), r'"strict"|"noImplicitAny"', 2) if repo.base(name) == "tsconfig.json" else None
        standards.append(item(repo, name, "standards configuration", excerpt))
    standards += tool_sections(repo, ["ruff", "black", "mypy", "isort", "pylint", "flake8", "pyright"], "standards settings")
    standards += package_scripts(repo, ["lint", "format", "typecheck", "type-check", "check"])
    command = audit_command(audit, "lint")
    if command:
        standards.append(item(repo, ".factory/audit-report.json", "lint command the last audit detected", command))
    evidence["coding-standards"] = standards

    return {topic: found[:MAX_ITEMS] for topic, found in evidence.items()}


def evidence_digest(found: List[Dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps(found, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def load_record(root: Path) -> Dict[str, Any]:
    try:
        data = json.loads((Path(root) / RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"schema_version": SCHEMA_VERSION, "topics": {}}
    if not isinstance(data, dict) or data.get("schema_version") != SCHEMA_VERSION or not isinstance(data.get("topics"), dict):
        return {"schema_version": SCHEMA_VERSION, "topics": {}}
    return data


def save_record(root: Path, record: Dict[str, Any]) -> None:
    path = Path(root) / RECORD
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def baseline(root: Path, config: Any, A: Any, redact: Callable[[str], str], audit: Any = None) -> Dict[str, Any]:
    """`run.py adr baseline`: the required topics, what covers them, and evidence for each still to draft. Writes only the record."""
    root = Path(root)
    found = A.coverage(root, config)
    commit = A.head_of(root)  # None in a project with no commit yet: there is nothing committed to read, so no evidence
    listing = A.full_listing(root, config)
    record = load_record(root)
    topics = record["topics"]
    repo: Optional[Repo] = None
    gathered: Dict[str, List[Dict[str, Any]]] = {}
    covered, waiting, to_draft, changed = [], [], [], False
    for row in found["topics"]:
        topic = row["topic"]
        if row["covered_by"]:
            covered.append({"topic": topic, "covered_by": row["covered_by"]})
            continue
        existing = [adr for adr in listing["adrs"] if f"topic:{topic}" in (adr.get("applies_to") or [])]
        if existing:  # an ADR for it exists, proposed or not yet committed: never drafted again, whatever the record says
            waiting.append({"topic": topic, "adrs": [{"id": adr.get("id"), "file": adr.get("file"), "status": adr.get("status"),
                                                      "committed": bool(adr.get("committed")), "problems": adr.get("problems") or [],
                                                      "open_points": A.open_points(adr.get("text"))} for adr in existing],
                            "what": "An ADR for this topic exists but does not bind yet: an engineer corrects it, accepts it and commits it on the main branch."})
            continue
        entry = topics.get(topic)
        if not isinstance(entry, dict) or not isinstance(entry.get("evidence"), list):
            entry = None  # a record this script did not write is read again, never trusted
        if entry is None or entry.get("adr"):  # no record yet, or the ADR drafted from it is gone: read the repository again
            if repo is None and commit:
                repo = Repo(root, commit, redact)
                gathered = gather(repo, audit)
            evidence = gathered.get(topic, [])
            entry = {"commit": commit, "gathered_at": now(), "evidence": evidence, "digest": evidence_digest(evidence), "adr": None}
            topics[topic] = entry
            changed = True
            reused = False
        else:
            reused = True
        to_draft.append({"topic": topic, "description": A.describe_topic(topic), "evidence": entry["evidence"], "no_evidence": not entry["evidence"],
                         "applies_to": [f"topic:{topic}"], "evidence_recorded_at": entry.get("gathered_at"),
                         "evidence_commit": entry.get("commit"), "reused_from_record": reused,
                         "read_at_an_earlier_commit": reused and entry.get("commit") != commit})
    if changed:
        record["topics"] = topics
        save_record(root, record)
    return {"status": "BASELINE", "commit": commit, "required": found["required"], "setting_problems": found["problems"], "adr_problems": found["adr_problems"],
            "covered": covered, "waiting": waiting, "to_draft": to_draft, "record": RECORD, "record_tracked": False, "record_written": changed,
            "data_note": DATA_NOTE}
