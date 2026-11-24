#!/usr/bin/env python3
"""The environment every project command a MACH station runs receives: one rule for the audit, build, verify and merge
stations (and release qualification, which runs commands through the audit station).

    env, argv = command_env.environment(project, work, argv)

Precedence, highest first:

  1. the command's own leading VAR=value words (`PYTHONDONTWRITEBYTECODE= make test`), as in a shell;
  2. commands.env in .factory/config.json: a map of variable names to values, given to every command the stations run.
     A value may use {project} (the project's main folder, where .factory/ is) and {cache} (MACH's cache folder,
     .factory/cache under it). Values are taken as written: no shell runs, so $HOME is not expanded;
  3. the person's own environment;
  4. what MACH chooses: PYTHONDONTWRITEBYTECODE=1 (the project's commands never leave Python byte code in the checkout:
     a cached file can outlive the source it was made from, rewritten at the same size within the same second, and a later
     run would then test the old code), and, only where needed, a package manager's cache pointed into .factory/cache/.

A package manager's cache is pointed elsewhere only when all of these hold: the project uses the tool (a file it reads is in
the project), the person has not set the tool's variable, the setting does not set it, the command does not set it, and the
tool's usual cache folder cannot be written from here. That is tested by really creating and removing a file there (or, when
the folder does not exist yet, by creating it and removing it again), never by permission bits, since a sandbox refuses at
write time. Each folder is tested once per station run. When the usual cache can be written nothing is set and the command's
environment is exactly the person's plus PYTHONDONTWRITEBYTECODE=1. Nobody's settings file is ever written: the variable is
only in the environment of the commands MACH runs.

.factory/cache/ carries its own .gitignore (`*`), so it never shows in `git status` and is never committed, whatever the
project's own ignore rules say. A ticket's cell and each lane's worktree run their commands with this same folder: one
cache per project.

Standard library only, Python 3.8.
"""

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

SETTING = "commands.env"
CACHE_DIR = ".factory/cache"
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
LEADING_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
PLACEHOLDER_RE = re.compile(r"\{(project|cache)\}")
WHY = "as when Claude Code runs in a sandbox"
# Folders never searched for the files that say which tools a project uses.
SKIP_DIRS = {".git", ".factory", ".claude", "node_modules", ".venv", "venv", "env", "__pycache__", "target", "dist", "build", ".tox",
             "vendor", ".gradle", ".yarn", ".next", ".turbo"}
SEARCH_DEPTH = 2  # the project's top folder and two levels below it: enough for a web/ or services/api/ part
# Names a value in the setting is better kept out of: the setting is committed with the project's settings.
CREDENTIAL_NAME_RE = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE", re.IGNORECASE)


# ---------------------------------------------------------------- where tools keep their caches

def home(env: Mapping[str, str]) -> Path:
    return Path(env.get("HOME") or os.path.expanduser("~"))


def user_cache(env: Mapping[str, str]) -> Path:
    """The per-user cache folder most tools use: ~/Library/Caches on macOS, $XDG_CACHE_HOME or ~/.cache elsewhere."""
    if sys.platform == "darwin":
        return home(env) / "Library" / "Caches"
    if os.name == "nt" and env.get("LOCALAPPDATA"):
        return Path(env["LOCALAPPDATA"])
    return Path(env["XDG_CACHE_HOME"]) if env.get("XDG_CACHE_HOME") else home(env) / ".cache"


def xdg_cache(env: Mapping[str, str]) -> Path:
    """$XDG_CACHE_HOME or ~/.cache on every system (uv's rule)."""
    return Path(env["XDG_CACHE_HOME"]) if env.get("XDG_CACHE_HOME") else home(env) / ".cache"


def ini_value(path: Path, key: str) -> Optional[str]:
    """`key = value` from an .npmrc-style file, or None."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for line in text.splitlines():
        match = re.match(r"^\s*" + re.escape(key) + r"\s*=\s*(.+?)\s*$", line)
        if match and not line.lstrip().startswith((";", "#")):
            return match.group(1).strip("\"'")
    return None


def expand(value: str, env: Mapping[str, str]) -> Path:
    value = re.sub(r"\$\{HOME\}|\$HOME\b", lambda m: str(home(env)), value)
    if value == "~" or value.startswith("~/"):
        return home(env) / value[2:]
    return Path(value)


def npm_cache(env: Mapping[str, str], project: Path) -> Path:
    for rc in (project / ".npmrc", Path(env["NPM_CONFIG_USERCONFIG"]) if env.get("NPM_CONFIG_USERCONFIG") else home(env) / ".npmrc"):
        given = ini_value(rc, "cache")
        if given:
            return expand(given, env)
    if os.name == "nt" and env.get("LOCALAPPDATA"):
        return Path(env["LOCALAPPDATA"]) / "npm-cache"
    return home(env) / ".npm"


def go_setting(env: Mapping[str, str], name: str) -> Optional[str]:
    """A Go setting the person made with `go env -w`, from Go's own settings file."""
    if env.get("GOENV") == "off":
        return None
    if env.get("GOENV"):
        path = Path(env["GOENV"])
    elif sys.platform == "darwin":
        path = home(env) / "Library" / "Application Support" / "go" / "env"
    else:
        path = (Path(env["XDG_CONFIG_HOME"]) if env.get("XDG_CONFIG_HOME") else home(env) / ".config") / "go" / "env"
    return ini_value(path, name)


def go_modcache(env: Mapping[str, str], project: Path) -> Path:
    given = go_setting(env, "GOMODCACHE")
    if given:
        return Path(given)
    gopath = env.get("GOPATH") or go_setting(env, "GOPATH")
    return (Path(gopath.split(os.pathsep)[0]) if gopath else home(env) / "go") / "pkg" / "mod"


def go_buildcache(env: Mapping[str, str], project: Path) -> Path:
    given = go_setting(env, "GOCACHE")
    return Path(given) if given else user_cache(env) / "go-build"


def maven_repository(env: Mapping[str, str], project: Path) -> Path:
    try:
        text = (home(env) / ".m2" / "settings.xml").read_text(encoding="utf-8", errors="replace")
        match = re.search(r"<localRepository>\s*([^<]+?)\s*</localRepository>", text)
        if match:
            return expand(match.group(1).replace("${user.home}", str(home(env))), env)
    except OSError:
        pass
    return home(env) / ".m2" / "repository"


def composer_cache(env: Mapping[str, str], project: Path) -> Path:
    if env.get("COMPOSER_HOME"):
        return Path(env["COMPOSER_HOME"]) / "cache"
    if sys.platform == "darwin":
        return home(env) / "Library" / "Caches" / "composer"
    if os.name == "nt" and env.get("LOCALAPPDATA"):
        return Path(env["LOCALAPPDATA"]) / "Composer"
    return xdg_cache(env) / "composer"


def nuget_http_cache(env: Mapping[str, str], project: Path) -> Path:
    base = home(env) / ".local" / "share" / "NuGet"
    return base / "v3-cache" if (base / "v3-cache").is_dir() and not (base / "http-cache").is_dir() else base / "http-cache"


def browsers(name: str) -> Callable[[Mapping[str, str], Path], Path]:
    return lambda env, project: user_cache(env) / name


# ---------------------------------------------------------------- the tools

class Tool:
    """One cache MACH may point elsewhere: the variable that moves it, the names that show the person set it already, the
    files that show the project uses the tool, and where the tool keeps it when nobody says otherwise."""

    def __init__(self, key: str, label: str, variable: Optional[str], usual: Callable[[Mapping[str, str], Path], Path],
                 files: Sequence[str] = (), package_words: Sequence[str] = (), set_by: Sequence[str] = (), only_if_absent: bool = False,
                 value: Optional[Callable[[Path], str]] = None, suggest: str = "", note: str = "", not_files: Sequence[str] = (),
                 already: Optional[Callable[[Mapping[str, str]], bool]] = None) -> None:
        self.key, self.label, self.variable, self.usual = key, label, variable, usual
        self.files, self.package_words = tuple(files), tuple(package_words)
        self.set_by = tuple(set_by) or ((variable,) if variable else ())
        self.only_if_absent = only_if_absent  # browsers: a folder that already holds them is never left behind
        self.value = value or (lambda folder: str(folder))
        self.suggest = suggest  # for a tool MACH never moves by itself: what a person could put in the setting
        self.note = note
        self.not_files = tuple(not_files)  # a file that shows the project uses another tool of the same name (Yarn 1 or later Yarn)
        self.already = already or (lambda env: False)  # the person's setting found another way than set_by


NODE = ("package.json",)
TOOLS: Tuple[Tool, ...] = (
    Tool("npm", "npm", "npm_config_cache", npm_cache, NODE, set_by=("npm_config_cache", "NPM_CONFIG_CACHE")),
    Tool("yarn", "Yarn 1", "YARN_CACHE_FOLDER", lambda env, project: user_cache(env) / ("Yarn" if sys.platform == "darwin" else "yarn"),
         ("yarn.lock",), not_files=(".yarnrc.yml",)),
    Tool("yarn-berry", "Yarn (2 and later)", "YARN_GLOBAL_FOLDER", lambda env, project: home(env) / ".yarn" / "berry", (".yarnrc.yml",)),
    Tool("pnpm", "pnpm", None, lambda env, project: (Path(env["PNPM_HOME"]) / "store" if env.get("PNPM_HOME") else
                                                     Path(env["XDG_DATA_HOME"]) / "pnpm" / "store" if env.get("XDG_DATA_HOME") else
                                                     home(env) / "Library" / "pnpm" / "store" if sys.platform == "darwin" else
                                                     home(env) / ".local" / "share" / "pnpm" / "store"),
         ("pnpm-lock.yaml", "pnpm-workspace.yaml"),
         suggest="pnpm's store folder is a pnpm setting (storeDir); the variable that sets it depends on pnpm's version, so MACH does "
                 "not set it. Set storeDir in the project's pnpm-workspace.yaml, or give the variable your pnpm reads in commands.env."),
    Tool("pip", "pip", "PIP_CACHE_DIR", lambda env, project: user_cache(env) / "pip",
         ("requirements.txt", "requirements-dev.txt", "setup.py", "setup.cfg", "pyproject.toml", "Pipfile"),
         set_by=("PIP_CACHE_DIR", "PIP_NO_CACHE_DIR")),
    Tool("uv", "uv", "UV_CACHE_DIR", lambda env, project: xdg_cache(env) / "uv", ("uv.lock",), set_by=("UV_CACHE_DIR", "UV_NO_CACHE")),
    Tool("poetry", "Poetry", "POETRY_CACHE_DIR", lambda env, project: user_cache(env) / "pypoetry", ("poetry.lock",)),
    Tool("gradle", "Gradle", "GRADLE_USER_HOME", lambda env, project: home(env) / ".gradle",
         ("build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradlew"),
         note="Gradle then reads no gradle.properties or init scripts from ~/.gradle for MACH's commands."),
    Tool("maven", "Maven", "MAVEN_ARGS", maven_repository, ("pom.xml", "mvnw"), set_by=("MAVEN_ARGS",),
         already=lambda env: "maven.repo.local" in env.get("MAVEN_OPTS", ""),
         value=lambda folder: f"-Dmaven.repo.local={folder}",
         note="Maven 3.9 and later read MAVEN_ARGS; ~/.m2/settings.xml is still read."),
    Tool("cargo", "Cargo", None, lambda env, project: Path(env["CARGO_HOME"]) / "registry" if env.get("CARGO_HOME") else home(env) / ".cargo" / "registry",
         ("Cargo.toml", "Cargo.lock"),
         suggest="Cargo keeps its downloads in CARGO_HOME, with its settings, credentials and installed programs, and has no narrower "
                 "variable, so MACH does not move it. To move all of it for MACH's commands: \"CARGO_HOME\": \"{cache}/cargo\"."),
    Tool("go-mod", "Go modules", "GOMODCACHE", go_modcache, ("go.mod",)),
    Tool("go-build", "Go's build cache", "GOCACHE", go_buildcache, ("go.mod",)),
    Tool("bundler", "Bundler", "BUNDLE_USER_CACHE", lambda env, project: (Path(env["BUNDLE_USER_HOME"]) if env.get("BUNDLE_USER_HOME") else home(env) / ".bundle") / "cache",
         ("Gemfile", "Gemfile.lock")),
    Tool("composer", "Composer", "COMPOSER_CACHE_DIR", composer_cache, ("composer.json", "composer.lock")),
    Tool("nuget", "NuGet packages", "NUGET_PACKAGES", lambda env, project: home(env) / ".nuget" / "packages",
         ("*.csproj", "*.fsproj", "*.vbproj", "*.sln", "packages.config", "nuget.config", "NuGet.Config", "global.json")),
    Tool("nuget-http", "NuGet's download cache", "NUGET_HTTP_CACHE_PATH", nuget_http_cache,
         ("*.csproj", "*.fsproj", "*.vbproj", "*.sln", "packages.config", "nuget.config", "NuGet.Config", "global.json")),
    Tool("playwright", "Playwright's browsers", "PLAYWRIGHT_BROWSERS_PATH", browsers("ms-playwright"), package_words=("playwright",),
         only_if_absent=True),
    Tool("cypress", "Cypress's app", "CYPRESS_CACHE_FOLDER", browsers("Cypress"), package_words=("cypress",), only_if_absent=True),
)


# ---------------------------------------------------------------- what the project uses

_FOUND: Dict[str, List[str]] = {}


def project_files(folder: Path) -> List[str]:
    """Names of files in the folder and two levels below it (relative paths), leaving out dependency and build folders."""
    key = str(folder)
    if key not in _FOUND:
        found: List[str] = []
        root_depth = len(folder.parts)
        try:
            for top, dirs, names in os.walk(str(folder)):
                depth = len(Path(top).parts) - root_depth
                dirs[:] = [] if depth >= SEARCH_DEPTH else sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
                found += [str((Path(top) / name).relative_to(folder)) for name in names]
        except OSError:
            pass
        _FOUND[key] = found
    return _FOUND[key]


def uses(tool: Tool, folders: Iterable[Path]) -> bool:
    folders = list(folders)
    if tool.not_files and any(Path(name).name in tool.not_files for folder in folders for name in project_files(folder)):
        return False
    for folder in folders:
        names = project_files(folder)
        base = [Path(name).name for name in names]
        for pattern in tool.files:
            if pattern.startswith("*"):
                if any(name.endswith(pattern[1:]) for name in base):
                    return True
            elif pattern in base:
                return True
        if tool.package_words:
            for name in names:
                if Path(name).name == "package.json":
                    try:
                        data = json.loads((folder / name).read_text(encoding="utf-8", errors="replace"))
                    except (OSError, ValueError):
                        continue
                    listed = set()
                    for section in ("dependencies", "devDependencies", "optionalDependencies"):
                        if isinstance(data, dict) and isinstance(data.get(section), dict):
                            listed |= set(data[section])
                    if any(word in package or package == word for word in tool.package_words for package in listed):
                        return True
    return False


# ---------------------------------------------------------------- can it be written

_WRITABLE: Dict[str, bool] = {}


def writable(folder: Path) -> bool:
    """Really write there: a small file in the folder, or, when it does not exist, the folder itself (and any missing parents),
    each removed again. Tested once per folder per station run."""
    key = str(folder)
    if key in _WRITABLE:
        return _WRITABLE[key]
    ok = False
    try:
        if folder.is_dir():
            probe = folder / f".mach-write-check-{os.getpid()}-{os.urandom(3).hex()}"
            with open(str(probe), "x"):
                pass
            probe.unlink()
            ok = True
        elif not folder.exists() and not folder.is_symlink():
            made: List[Path] = []
            here = folder
            while not here.exists() and here != here.parent:
                made.append(here)
                here = here.parent
            if here.is_dir():
                try:
                    for path in reversed(made):
                        path.mkdir()
                    ok = True
                finally:
                    for path in made:
                        try:
                            path.rmdir()
                        except OSError:
                            pass
    except OSError:
        ok = False
    _WRITABLE[key] = ok
    return ok


# ---------------------------------------------------------------- the setting

_SETTINGS: Dict[str, Tuple[Dict[str, str], List[str]]] = {}


def read_setting(project: Path) -> Tuple[Dict[str, str], List[str]]:
    """commands.env from .factory/config.json, as written (placeholders not yet filled), and the entries left out, each with why."""
    key = str(project)
    if key not in _SETTINGS:
        given: Dict[str, str] = {}
        problems: List[str] = []
        try:
            config = json.loads((project / ".factory" / "config.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            config = {}
        section = config.get("commands") if isinstance(config, dict) else None
        values = section.get("env") if isinstance(section, dict) else None
        if values is not None and not isinstance(values, dict):
            problems.append(f"{SETTING} is not a map of names to values, so none of it is used.")
            values = {}
        for name, value in (values or {}).items():
            if not NAME_RE.match(str(name)):
                problems.append(f"'{name}' is not an environment variable name (letters, digits and _, not starting with a digit), so it is left out.")
            elif not isinstance(value, str):
                problems.append(f"{name}'s value is not text (write it in quotes), so it is left out.")
            else:
                given[str(name)] = value
        _SETTINGS[key] = (given, problems)
    return _SETTINGS[key]


def cache_root(project: Path) -> Path:
    return project / CACHE_DIR


def ensure_cache_root(project: Path) -> bool:
    """Make .factory/cache/ with its own .gitignore, so nothing under it is ever shown by Git or committed."""
    root = cache_root(project)
    try:
        root.mkdir(parents=True, exist_ok=True)
        ignore = root / ".gitignore"
        if not ignore.is_file():
            ignore.write_text("# MACH's package caches for the commands it runs: never committed.\n*\n", encoding="utf-8")
        return True
    except OSError:
        return False


def fill(value: str, project: Path) -> str:
    if "{cache}" in value:
        ensure_cache_root(project)
    return PLACEHOLDER_RE.sub(lambda m: str(project if m.group(1) == "project" else cache_root(project)), value)


def setting_notes(given: Mapping[str, str]) -> List[str]:
    """Plain words about names in the setting that change more than a cache. Nothing is refused for them."""
    notes = []
    for name in given:
        if name == "PATH":
            notes.append("PATH replaces the whole search path for the project's commands (it is not added to); MACH still checks that a "
                         "command's program exists with your own PATH.")
        elif name == "HOME":
            notes.append("HOME makes the project's commands find their settings, sign-ins and caches under that folder instead of yours.")
        elif name.startswith("GIT_"):
            notes.append(f"{name} applies to the project's own commands only, never to the Git commands MACH runs itself.")
        elif name == "PYTHONDONTWRITEBYTECODE":
            notes.append("PYTHONDONTWRITEBYTECODE replaces MACH's own value (1), so the project's commands may leave Python byte code in a checkout.")
        if CREDENTIAL_NAME_RE.search(name):
            notes.append(f"{name} looks like a credential. .factory/config.json is committed with the project: never put a secret in it.")
    return notes


# ---------------------------------------------------------------- the environment

_MOVED: Dict[str, Dict[str, Dict[str, str]]] = {}


def shown(path: Path, project: Path) -> str:
    """A path as a person reads it: relative to the project, or with ~ for the home folder."""
    try:
        return path.relative_to(project).as_posix()
    except ValueError:
        pass
    try:
        return "~/" + path.relative_to(Path(os.path.expanduser("~"))).as_posix()
    except ValueError:
        return str(path)


def plan(project: Path, work: Optional[Path] = None, base: Optional[Mapping[str, str]] = None,
         leading: Sequence[str] = ()) -> List[Dict[str, Any]]:
    """For each tool the project uses: its usual cache, whether it can be written, and what MACH does about it. Reads the
    setting and the person's environment; writes only the throwaway probe (writable())."""
    env = dict(os.environ if base is None else base)
    given, _ = read_setting(project)
    folders = [project] + ([work] if work is not None and Path(work) != Path(project) else [])
    rows = []
    for tool in TOOLS:
        if not uses(tool, folders):
            continue
        row: Dict[str, Any] = {"tool": tool.label, "key": tool.key, "variable": tool.variable, "usual": None, "writable": None,
                               "action": "none", "to": None, "note": tool.note, "suggest": tool.suggest}
        named = [name for name in tool.set_by if name in leading]
        if named:
            row["action"] = "command"
        elif any(name in given for name in tool.set_by):
            row["action"] = "setting"
        elif any(env.get(name) for name in tool.set_by) or tool.already(env):
            row["action"] = "yours"
        if row["action"] != "none":
            rows.append(row)
            continue
        usual = tool.usual(env, project)
        row["usual"] = usual
        if tool.only_if_absent and usual.exists():
            row["writable"] = None  # what is there is used as it is, written to or not
            rows.append(row)
            continue
        row["writable"] = writable(usual)
        if not row["writable"]:
            if tool.variable is None:
                row["action"] = "cannot"
            else:
                row["action"] = "moved"
                row["to"] = cache_root(project) / tool.key
        rows.append(row)
    return rows


def environment(project: Path, work: Optional[Path], argv: Sequence[str],
                base: Optional[Mapping[str, str]] = None) -> Tuple[Dict[str, str], List[str]]:
    """The environment for one project command, and the command with its leading VAR=value words taken off. See the module's
    docstring for the order of precedence. `project` is the project's main folder; `work` is where the command runs."""
    project = Path(project)
    argv = list(argv)
    leading: List[Tuple[str, str]] = []
    while argv and LEADING_RE.match(argv[0]):  # leading VAR=value, as in a shell
        key, value = argv.pop(0).split("=", 1)
        leading.append((key, value))
    person = dict(os.environ if base is None else base)
    env = dict(person)
    for row in plan(project, work, person, [key for key, _ in leading]):
        if row["action"] == "moved" and ensure_cache_root(project):
            folder = row["to"]
            try:
                folder.mkdir(exist_ok=True)
            except OSError:
                continue
            tool = next(t for t in TOOLS if t.key == row["key"])
            env[tool.variable] = tool.value(folder)
            _MOVED.setdefault(str(project), {})[tool.key] = {
                "tool": tool.label, "variable": tool.variable, "to": shown(folder, project), "usual": shown(row["usual"], project),
                "note": tool.note}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    given, _ = read_setting(project)
    for name, value in given.items():
        env[name] = fill(value, project)
    for key, value in leading:
        env[key] = value
    return env, argv


def moved(project: Path) -> List[Dict[str, str]]:
    """The caches MACH pointed elsewhere during this station run, for the station's own output."""
    return list(_MOVED.get(str(Path(project)), {}).values())


def notices(project: Path) -> List[str]:
    """One sentence for each cache MACH pointed elsewhere during this station run; empty when nothing was changed."""
    return [f"{item['tool']}: its usual cache at {item['usual']} cannot be written from here, {WHY}, so MACH pointed {item['variable']} at "
            f"{item['to']} for the commands it runs. Nobody's settings were changed." + (f" {item['note']}" if item.get("note") else "")
            for item in moved(project)]


# ---------------------------------------------------------------- a refused network, in each tool's own words

NETWORK_PATTERNS = (
    # npm, pnpm, Yarn, Playwright, Cypress (Node.js)
    r"getaddrinfo (?:ENOTFOUND|EAI_AGAIN)", r"\bE(?:NOTFOUND|AI_AGAIN)\b", r"connect EPERM", r"network request to \S+ failed",
    r"problem related to network connectivity", r"ERR_PNPM_META_FETCH_FAIL", r"trouble with your network connection",
    r"tunneling socket could not be established", r"Failed to download .*(?:browser|chromium|firefox|webkit)",
    r"Cypress (?:App|binary) could not be downloaded",
    # pip, Poetry, uv
    r"NewConnectionError", r"Failed to establish a new connection", r"Max retries exceeded with url", r"ProxyError",
    r"Tunnel connection failed", r"Could not fetch URL", r"error sending request for url", r"dns error", r"failed to lookup address information",
    # Gradle, Maven, Cargo, Go, Bundler, Composer, NuGet
    r"UnknownHostException", r"Could not transfer artifact", r"Could not GET '", r"Couldn't resolve host name", r"spurious network error",
    r"dial tcp", r"Could not fetch specs from", r"Could not reach host", r"curl error 6", r"Unable to load the service index for source",
    r"\bNU1301\b",
    # the operating system's words
    r"Could not resolve host", r"Temporary failure in name resolution", r"Name or service not known", r"nodename nor servname provided",
    r"Network is unreachable", r"No such host is known", r"no such host",
)
NETWORK_RE = re.compile("|".join(f"(?:{pattern})" for pattern in NETWORK_PATTERNS), re.IGNORECASE)


def network_hint(output: str) -> Optional[str]:
    """A plain hint when a failed command's output shows a refused download or an unreachable network; None otherwise."""
    for line in (output or "").splitlines():
        if NETWORK_RE.search(line):
            quoted = " ".join(line.split())[:160]
            return ("MACH: a package download was refused or the network could not be reached (the output says: \"" + quoted + "\"). "
                    "The cache was not the cause. When Claude Code runs in a sandbox, its network rules are set in Claude Code's own "
                    "settings, which MACH does not and will not change: allow the package registry there, then run this step again.")
    return None


def reset() -> None:
    """Forget what this run has found (for tests)."""
    _FOUND.clear()
    _WRITABLE.clear()
    _SETTINGS.clear()
    _MOVED.clear()
