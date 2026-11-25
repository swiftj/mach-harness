"""Tests for command_env.py: the environment every project command a station runs receives.

No real package manager runs and nothing reaches the network: stand-ins named npm, go, gradle ... on a temporary PATH print
the variables they were given. The sandbox's refusal is simulated with a read-only folder, as tests/test_cell_workspace.py
does, and skipped as root, where a read-only folder refuses nothing."""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
for _folder in ("intent", "audit", "build", "verify", "merge", "run"):
    sys.path.insert(0, str(ROOT / "skills" / _folder / "scripts"))
import command_env  # noqa: E402
import audit  # noqa: E402
import build  # noqa: E402
import verify  # noqa: E402
import merge  # noqa: E402
import doctor  # noqa: E402

# Variables the person might have in their own shell that would change what these tests see.
TOOL_VARIABLES = sorted({name for tool in command_env.TOOLS for name in tool.set_by} | {"MAVEN_OPTS", "PNPM_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
                                                                                        "XDG_CONFIG_HOME", "GOPATH", "GOENV", "CARGO_HOME", "COMPOSER_HOME",
                                                                                        "BUNDLE_USER_HOME", "NPM_CONFIG_USERCONFIG", "LOCALAPPDATA"})
# The stand-in: prints every variable it was given, as JSON, and fails with the text in $STANDIN_SAYS when that is set.
STANDIN = """#!{python}
import json, os, sys
print(json.dumps(dict(os.environ)))
says = os.environ.get("STANDIN_SAYS")
if says:
    sys.stderr.write(says + "\\n")
    sys.exit(1)
"""


def git(cwd, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.com")
    return subprocess.run(["git", "-c", "commit.gpgsign=false", *args], cwd=str(cwd), capture_output=True, text=True, env=env)


def given(output):
    """The environment a stand-in printed (its first line)."""
    return json.loads(output.strip().splitlines()[0])


class Base(unittest.TestCase):
    def setUp(self):
        command_env.reset()
        self.addCleanup(command_env.reset)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        top = Path(self.tmp.name).resolve()
        self.home = top / "home"
        self.home.mkdir()
        self.project = top / "project"
        self.project.mkdir()
        self.bin = top / "bin"
        self.bin.mkdir()
        for name in ("npm", "go", "gradle", "mvn", "cargo", "pip", "tool"):
            path = self.bin / name
            path.write_text(STANDIN.format(python=sys.executable))
            path.chmod(0o755)
        clean = {name: value for name, value in os.environ.items() if name not in TOOL_VARIABLES and name != "STANDIN_SAYS"}
        clean.update(HOME=str(self.home), PATH=f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}", XDG_CACHE_HOME=str(self.home / ".cache"),
                     XDG_CONFIG_HOME=str(self.home / ".config"), XDG_DATA_HOME=str(self.home / ".local" / "share"))
        patcher = mock.patch.dict(os.environ, clean, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, files, folder=None):
        for name, text in files.items():
            path = (folder or self.project) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def settings(self, env):
        self.write({".factory/config.json": json.dumps({"commands": {"env": env}})})

    def sandbox(self, folder):
        """The sandbox's refusal: the folder can be read but nothing can be written in it."""
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("as root, a read-only folder refuses nothing")
        folder.mkdir(parents=True, exist_ok=True)
        os.chmod(str(folder), 0o555)
        self.addCleanup(lambda: folder.is_dir() and os.chmod(str(folder), 0o755))
        return folder

    def environment(self, command="npm test", work=None):
        import shlex
        return command_env.environment(self.project, work or self.project, shlex.split(command))

    def expected_plain(self):
        return dict(os.environ, PYTHONDONTWRITEBYTECODE="1")


class WritableCacheTest(Base):
    """With a usual cache that can be written, nothing changes: the environment is the person's plus PYTHONDONTWRITEBYTECODE=1."""

    def test_the_environment_is_exactly_as_before(self):
        self.write({"package.json": "{}", "go.mod": "module x\n", "requirements.txt": "", "build.gradle": "", "pom.xml": "<project/>",
                    "Gemfile": "", "composer.json": "{}", "app.csproj": "<Project/>", "poetry.lock": "", "uv.lock": "", "yarn.lock": ""})
        env, argv = self.environment()
        self.assertEqual(env, self.expected_plain())
        self.assertEqual(argv, ["npm", "test"])
        self.assertEqual(command_env.moved(self.project), [])
        self.assertEqual(command_env.notices(self.project), [])
        self.assertFalse((self.project / ".factory").exists(), "no cache folder is made when nothing is moved")

    def test_the_probe_leaves_nothing_behind(self):
        self.write({"package.json": "{}"})
        (self.home / ".npm").mkdir()
        self.environment()
        self.assertEqual(list((self.home / ".npm").iterdir()), [])
        self.write({"go.mod": "module x\n"})
        command_env.reset()
        self.environment()
        self.assertFalse((self.home / "go").exists(), "a folder made to test it is removed again")
        self.assertFalse((self.home / ".cache" / "go-build").exists())

    def test_a_station_command_receives_exactly_that(self):
        self.write({"package.json": "{}"})
        ran = build.run_command(types.SimpleNamespace(project=self.project, work=self.project), "npm test", 60)
        seen = given(ran["output"])
        for name in ("__CF_USER_TEXT_ENCODING", "LC_CTYPE"):  # added by the system or Python's start-up, not by MACH
            seen.pop(name, None)
        expected = self.expected_plain()
        for name in ("__CF_USER_TEXT_ENCODING", "LC_CTYPE"):
            expected.pop(name, None)
        self.assertEqual(seen, expected)
        self.assertNotIn("caches", json.dumps(command_env.notices(self.project)))


class UnwritableCacheTest(Base):
    def test_npm_is_pointed_into_the_project(self):
        self.write({"package.json": "{}"})
        self.sandbox(self.home / ".npm")
        env, _ = self.environment()
        cache = self.project / ".factory" / "cache" / "npm"
        self.assertEqual(env["npm_config_cache"], str(cache))
        self.assertTrue(cache.is_dir())
        self.assertEqual((self.project / ".factory" / "cache" / ".gitignore").read_text().splitlines()[-1], "*")
        self.assertEqual({k: v for k, v in env.items() if k != "npm_config_cache"}, self.expected_plain(), "nothing else changes")
        [notice] = command_env.notices(self.project)
        self.assertIn("npm: its usual cache at", notice)
        self.assertIn("cannot be written from here, as when Claude Code runs in a sandbox", notice)
        self.assertIn("npm_config_cache at .factory/cache/npm", notice)

    def test_a_cache_folder_that_does_not_exist_in_a_home_that_cannot_be_written(self):
        self.write({"package.json": "{}"})
        self.sandbox(self.home)
        env, _ = self.environment()
        self.assertEqual(env["npm_config_cache"], str(self.project / ".factory" / "cache" / "npm"))

    def test_the_stand_in_is_given_the_cache(self):
        self.write({"package.json": "{}"})
        self.sandbox(self.home / ".npm")
        ran = build.run_command(types.SimpleNamespace(project=self.project, work=self.project), "npm install", 60)
        self.assertEqual(given(ran["output"])["npm_config_cache"], str(self.project / ".factory" / "cache" / "npm"))

    def test_an_npmrc_cache_is_the_one_tested(self):
        self.write({"package.json": "{}", ".npmrc": "cache=~/elsewhere\n"})
        self.sandbox(self.home / ".npm")
        (self.home / "elsewhere").mkdir()
        env, _ = self.environment()
        self.assertNotIn("npm_config_cache", env, "the cache the person chose can be written, so nothing is set")

    def test_only_tools_the_project_uses(self):
        self.write({"go.mod": "module x\n"})
        self.sandbox(self.home)
        env, _ = self.environment("go test ./...")
        self.assertNotIn("npm_config_cache", env)
        self.assertNotIn("PIP_CACHE_DIR", env)
        self.assertEqual(env["GOMODCACHE"], str(self.project / ".factory" / "cache" / "go-mod"))
        self.assertEqual(env["GOCACHE"], str(self.project / ".factory" / "cache" / "go-build"))

    def test_a_tool_found_one_level_down(self):
        self.write({"web/package.json": "{}"})
        self.sandbox(self.home)
        env, _ = self.environment()
        self.assertIn("npm_config_cache", env)

    def test_the_common_tools(self):
        files = {"requirements.txt": "", "uv.lock": "", "poetry.lock": "", "build.gradle": "", "pom.xml": "<project/>", "Gemfile": "",
                 "composer.json": "{}", "app.csproj": "<Project/>", "yarn.lock": "", "package.json": json.dumps({"devDependencies": {"@playwright/test": "1", "cypress": "1"}})}
        self.write(files)
        self.sandbox(self.home)
        env, _ = self.environment()
        cache = self.project / ".factory" / "cache"
        for variable, key in (("PIP_CACHE_DIR", "pip"), ("UV_CACHE_DIR", "uv"), ("POETRY_CACHE_DIR", "poetry"), ("GRADLE_USER_HOME", "gradle"),
                              ("BUNDLE_USER_CACHE", "bundler"), ("COMPOSER_CACHE_DIR", "composer"), ("NUGET_PACKAGES", "nuget"),
                              ("NUGET_HTTP_CACHE_PATH", "nuget-http"), ("YARN_CACHE_FOLDER", "yarn"), ("npm_config_cache", "npm")):
            self.assertEqual(env.get(variable), str(cache / key), variable)
        self.assertEqual(env["MAVEN_ARGS"], f"-Dmaven.repo.local={cache / 'maven'}")
        self.assertEqual(env["PLAYWRIGHT_BROWSERS_PATH"], str(cache / "playwright"))
        self.assertEqual(env["CYPRESS_CACHE_FOLDER"], str(cache / "cypress"))
        self.assertNotIn("YARN_GLOBAL_FOLDER", env, "Yarn 1's project is not a later Yarn's")

    def test_cargo_and_pnpm_are_never_moved(self):
        self.write({"Cargo.toml": "", "pnpm-lock.yaml": ""})
        self.sandbox(self.home)
        env, _ = self.environment("cargo test")
        self.assertEqual(env, self.expected_plain())

    def test_a_later_yarn_moves_its_global_folder_and_not_the_project_cache(self):
        self.write({"yarn.lock": "", ".yarnrc.yml": "nodeLinker: node-modules\n"})
        self.sandbox(self.home)
        env, _ = self.environment("yarn test")
        self.assertEqual(env["YARN_GLOBAL_FOLDER"], str(self.project / ".factory" / "cache" / "yarn-berry"))
        self.assertNotIn("YARN_CACHE_FOLDER", env)

    def test_browsers_already_there_are_left_alone(self):
        self.write({"package.json": json.dumps({"devDependencies": {"@playwright/test": "1"}})})
        browsers = command_env.user_cache(os.environ) / "ms-playwright"
        browsers.mkdir(parents=True)
        self.sandbox(browsers)
        env, _ = self.environment()
        self.assertNotIn("PLAYWRIGHT_BROWSERS_PATH", env)

    def test_checked_once_per_station_run(self):
        self.write({"package.json": "{}"})
        env, _ = self.environment()
        self.assertNotIn("npm_config_cache", env)
        self.sandbox(self.home)
        env, _ = self.environment()
        self.assertNotIn("npm_config_cache", env, "the first answer holds for the rest of the run")
        command_env.reset()  # the next station run
        env, _ = self.environment()
        self.assertIn("npm_config_cache", env)


class PrecedenceTest(Base):
    """The command's own VAR=value, then commands.env, then the person's environment, then MACH's choice."""

    def test_the_person_s_own_variable_is_never_overridden(self):
        self.write({"package.json": "{}"})
        self.sandbox(self.home)
        os.environ["npm_config_cache"] = "/the/person/s/own"
        env, _ = self.environment()
        self.assertEqual(env["npm_config_cache"], "/the/person/s/own")
        self.assertEqual(command_env.notices(self.project), [])
        os.environ.pop("npm_config_cache")
        os.environ["NPM_CONFIG_CACHE"] = "/upper"
        command_env.reset()
        env, _ = self.environment()
        self.assertNotIn("npm_config_cache", env)

    def test_the_setting_with_its_placeholders(self):
        self.settings({"CARGO_HOME": "{cache}/cargo", "WHERE": "{project}/x", "PLAIN": "$HOME/y"})
        env, _ = self.environment("cargo test")
        self.assertEqual(env["CARGO_HOME"], f"{self.project}/.factory/cache/cargo")
        self.assertEqual(env["WHERE"], f"{self.project}/x")
        self.assertEqual(env["PLAIN"], "$HOME/y", "no shell runs: values are taken as written")
        self.assertTrue((self.project / ".factory" / "cache" / ".gitignore").is_file(), "{cache} makes the folder, with its .gitignore")

    def test_the_order(self):
        self.write({"package.json": "{}"})
        self.sandbox(self.home)
        os.environ["SHARED"] = "person"
        os.environ["ONLY_PERSON"] = "person"
        self.settings({"SHARED": "setting", "npm_config_cache": "{cache}/chosen", "BOTH": "setting"})
        env, argv = self.environment("BOTH=command npm test")
        self.assertEqual(argv, ["npm", "test"])
        self.assertEqual(env["BOTH"], "command", "the command's own VAR=value wins")
        self.assertEqual(env["SHARED"], "setting", "the setting wins over the person's environment")
        self.assertEqual(env["ONLY_PERSON"], "person")
        self.assertEqual(env["npm_config_cache"], f"{self.project}/.factory/cache/chosen", "the setting wins over MACH's choice")
        self.assertEqual(command_env.notices(self.project), [], "MACH moved nothing, so it says nothing")

    def test_a_leading_variable_wins_and_moves_nothing(self):
        self.write({"package.json": "{}"})
        self.sandbox(self.home)
        env, argv = self.environment("npm_config_cache=/mine PYTHONDONTWRITEBYTECODE= npm test")
        self.assertEqual(env["npm_config_cache"], "/mine")
        self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "")
        self.assertEqual(command_env.notices(self.project), [])

    def test_the_setting_may_replace_pythondontwritebytecode(self):
        self.settings({"PYTHONDONTWRITEBYTECODE": ""})
        env, _ = self.environment()
        self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "")

    def test_names_and_values_that_are_left_out(self):
        self.settings({"1BAD": "x", "has space": "x", "NUMBER": 3, "GOOD": "yes"})
        env, _ = self.environment()
        self.assertEqual(env["GOOD"], "yes")
        for name in ("1BAD", "has space", "NUMBER"):
            self.assertNotIn(name, env)
        _, problems = command_env.read_setting(self.project)
        self.assertEqual(len(problems), 3)
        command_env.reset()
        self.settings(["not", "a", "map"])
        self.assertEqual(self.environment()[0], self.expected_plain())

    def test_names_that_change_more_are_allowed_with_a_note(self):
        self.settings({"PATH": "/usr/bin:/bin", "HOME": "{cache}/home", "GIT_DIR": "x", "API_TOKEN": "x"})
        env, _ = self.environment()
        self.assertEqual(env["PATH"], "/usr/bin:/bin")
        notes = " ".join(command_env.setting_notes(command_env.read_setting(self.project)[0]))
        for words in ("replaces the whole search path", "under that folder instead of yours", "never to the Git commands MACH runs itself",
                      "never put a secret in it"):
            self.assertIn(words, notes)


class SharedAndNeverCommittedTest(Base):
    """One cache for the project, its cell and every lane; never in Git's status, a commit, or a ticket's uncommitted work."""

    def setUp(self):
        super().setUp()
        # As an install made before .factory/cache/ was in the installer's block: only the cache folder's own .gitignore keeps it out.
        self.write({"package.json": "{}", "README.md": "x\n", ".gitignore": "node_modules/\n.factory/worktrees/\n"})
        git(self.project, "init", "-q", "-b", "main")
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "start")
        self.cell = self.project / ".factory" / "worktrees" / "T-1" / "repo"
        self.lane = self.project / ".factory" / "worktrees" / "T-1" / "lanes" / "A" / "repo"
        for folder, branch in ((self.cell, "t-1"), (self.lane, "lane-a")):
            folder.parent.mkdir(parents=True, exist_ok=True)
            self.assertEqual(git(self.project, "worktree", "add", "-q", "-b", branch, str(folder)).returncode, 0)
        self.sandbox(self.home)

    def test_the_cell_and_a_lane_share_the_project_s_cache(self):
        shared = str(self.project / ".factory" / "cache" / "npm")
        for work in (self.cell, self.lane):
            ran = build.run_command(types.SimpleNamespace(project=self.project, work=work), "npm ci", 60)
            self.assertEqual(given(ran["output"])["npm_config_cache"], shared)
        ran = verify.run_logged(types.SimpleNamespace(project=self.project, work=self.cell), "npm test", self.project.parent / "suite.log")
        self.assertTrue(ran["passed"])
        self.assertIn(shared, (self.project.parent / "suite.log").read_text())
        self.assertFalse((self.cell / ".factory" / "cache").exists(), "no copy in the cell")

    def test_never_in_git_status_or_a_commit(self):
        build.run_command(types.SimpleNamespace(project=self.project, work=self.project), "npm ci", 60)
        (self.project / ".factory" / "cache" / "npm" / "_cacache").mkdir()
        (self.project / ".factory" / "cache" / "npm" / "_cacache" / "blob").write_text("x")
        self.assertEqual(git(self.project, "status", "--porcelain", "--untracked-files=all").stdout, "")
        git(self.project, "add", "-A")
        self.assertEqual(git(self.project, "diff", "--cached", "--name-only").stdout, "")
        here = types.SimpleNamespace(project=self.project, work=self.project)
        self.assertEqual(build.changed_files(here), [])
        self.assertEqual(verify.changed_files(here), [])
        self.assertEqual(merge.dirty(self.project), [])

    def test_never_in_the_cell_s_uncommitted_work(self):
        build.run_command(types.SimpleNamespace(project=self.project, work=self.cell), "npm ci", 60)
        cell = types.SimpleNamespace(project=self.project, work=self.cell)
        self.assertEqual(build.changed_files(cell), [])
        self.assertEqual(verify.changed_files(cell), [])
        self.assertEqual(merge.dirty(self.cell), [])


class StationWordsTest(Base):
    def test_the_audit_report_says_it_once(self):
        self.write({"package.json": "{}", "README.md": "x\n"})
        git(self.project, "init", "-q", "-b", "main")
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "start")
        self.sandbox(self.home)
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            audit.main(["--project", str(self.project), "run", "--build-cmd", "npm run build", "--test-cmd", "npm test", "--lint-cmd", "npm run lint"])
        report = json.loads((self.project / ".factory" / "audit-report.json").read_text())
        self.assertEqual([item["variable"] for item in report["caches"]], ["npm_config_cache"])
        said = [note for note in report["notes"] if note.startswith("npm: its usual cache")]
        self.assertEqual(len(said), 1, "said once, though three commands ran")
        self.assertIn("Note: npm: its usual cache", out.getvalue())

    def test_the_audit_says_nothing_when_nothing_changed(self):
        self.write({"package.json": "{}", "README.md": "x\n"})
        git(self.project, "init", "-q", "-b", "main")
        git(self.project, "add", "-A")
        git(self.project, "commit", "-q", "-m", "start")
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            audit.main(["--project", str(self.project), "run", "--test-cmd", "npm test"])
        report = json.loads((self.project / ".factory" / "audit-report.json").read_text())
        self.assertNotIn("caches", report)
        self.assertFalse([note for note in report["notes"] if "cache" in note])

    def test_merge_and_verify_say_it_in_their_output(self):
        source = (ROOT / "skills" / "merge" / "scripts" / "merge.py").read_text()
        self.assertIn('result["caches"] = command_env.notices(cell.project)', source)
        self.assertIn('{"caches": command_env.notices(cell.project)}', (ROOT / "skills" / "verify" / "scripts" / "verify.py").read_text())
        self.assertIn('answer["caches"] = command_env.notices(cell.project)', (ROOT / "skills" / "build" / "scripts" / "build.py").read_text())


# Each tool's own words for a refused download or an unreachable network (one line each, as the tools print them).
NETWORK_LINES = {
    "npm": "npm ERR! request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
    "npm (sandbox)": "npm error network connect EPERM 104.16.1.35:443",
    "npm (proxy)": "npm ERR! network tunneling socket could not be established, statusCode=403",
    "pnpm": " ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/left-pad: request to https://registry.npmjs.org/left-pad failed",
    "yarn": "info There appears to be trouble with your network connection. Retrying...",
    "pip": "WARNING: Retrying ... after connection broken by 'NewConnectionError('<pip._vendor.urllib3.connection.HTTPSConnection object>: Failed to establish a new connection: [Errno 8] nodename nor servname provided, or not known')'",
    "pip (proxy)": "ProxyError('Cannot connect to proxy.', OSError('Tunnel connection failed: 403 Forbidden'))",
    "uv": "error: Request failed after 3 retries\n  Caused by: error sending request for url (https://pypi.org/simple/requests/)",
    "poetry": "HTTPSConnectionPool(host='pypi.org', port=443): Max retries exceeded with url: /pypi/requests/json",
    "gradle": "> Could not GET 'https://repo.maven.apache.org/maven2/junit/junit/4.13/junit-4.13.pom'.",
    "gradle (dns)": "Caused by: java.net.UnknownHostException: repo.maven.apache.org",
    "maven": "[ERROR] Failed to execute goal: Could not transfer artifact junit:junit:pom:4.13 from/to central",
    "cargo": "warning: spurious network error (2 tries remaining): [6] Couldn't resolve host name",
    "go": "go: github.com/x/y@v1.0.0: Get \"https://proxy.golang.org/...\": dial tcp: lookup proxy.golang.org: no such host",
    "bundler": "Could not fetch specs from https://rubygems.org/ due to underlying error",
    "composer": "curl error 6 while downloading https://repo.packagist.org/packages.json: Could not resolve host: repo.packagist.org",
    "nuget": "error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.",
    "playwright": "Error: getaddrinfo EAI_AGAIN playwright.azureedge.net",
    "cypress": "The Cypress App could not be downloaded.",
    "the system": "curl: (6) Could not resolve host: example.org",
}


class NetworkHintTest(Base):
    def test_each_tool_s_words(self):
        for tool, line in NETWORK_LINES.items():
            hint = command_env.network_hint("some output\n" + line + "\nmore")
            self.assertIsNotNone(hint, tool)
            self.assertIn("a package download was refused or the network could not be reached", hint)
            self.assertIn("The cache was not the cause", hint)
            self.assertIn("Claude Code's own settings, which MACH does not and will not change", hint)
            self.assertIn("run this step again", hint)
            self.assertNotIn("abandon", hint)

    def test_ordinary_failures_get_no_hint(self):
        for text in ("FAILED tests/test_x.py::test_y - AssertionError", "Error: connect ECONNREFUSED 127.0.0.1:5432",
                     "ERROR: No matching distribution found for nothing-such", "make: *** [test] Error 1", ""):
            self.assertIsNone(command_env.network_hint(text), text)

    def test_each_station_adds_it_to_the_failure_and_changes_no_outcome(self):
        self.write({"package.json": "{}"})
        os.environ["STANDIN_SAYS"] = NETWORK_LINES["npm"]
        here = types.SimpleNamespace(project=self.project, work=self.project, build={"tests": {"command": "npm test"}})
        ran = build.run_command(here, "npm ci", 60)
        self.assertFalse(ran["passed"])
        self.assertTrue(ran["output_tail"].endswith("run this step again."))
        self.assertNotIn("MACH:", ran["output"], "the command's own output is left as it printed it")
        suite = merge.run_suite(here)
        self.assertFalse(suite["passed"])
        self.assertIn("MACH: a package download was refused", suite["output_tail"])
        log = self.project.parent / "suite.log"
        logged = verify.run_logged(here, "npm test", log)
        self.assertFalse(logged["passed"])
        self.assertIn("MACH: a package download was refused", log.read_text())
        result = audit.execute(audit.Repo(self.project), "test", "npm test", {"test": 60}, False)
        self.assertEqual(result["status"], "fail")
        self.assertIn("The cache was not the cause", result["hint"])
        os.environ.pop("STANDIN_SAYS")
        command_env.reset()
        self.assertNotIn("hint", audit.execute(audit.Repo(self.project), "test", "npm test", {"test": 60}, False))


class DoctorTest(Base):
    def checks(self):
        return {c["id"]: c for c in doctor.check_caches(self.project)}

    def test_a_cache_mach_moves(self):
        self.write({"package.json": "{}"})
        self.sandbox(self.home)
        found = self.checks()
        self.assertEqual(found["caches.npm"]["status"], "ok")
        self.assertIn("cannot be written from here", found["caches.npm"]["detail"])
        self.assertIn("MACH sets npm_config_cache to .factory/cache/npm", found["caches.npm"]["detail"])
        self.assertFalse((self.project / ".factory").exists(), "the doctor only looks")

    def test_a_cache_that_can_be_written(self):
        self.write({"package.json": "{}"})
        self.assertIn("can be written from here; MACH sets nothing", self.checks()["caches.npm"]["detail"])

    def test_a_cache_mach_does_not_move(self):
        self.write({"Cargo.toml": ""})
        self.sandbox(self.home)
        found = self.checks()["caches.cargo"]
        self.assertEqual(found["status"], "warn")
        self.assertIn('"CARGO_HOME": "{cache}/cargo"', found["fix"])

    def test_the_person_s_own_and_the_setting(self):
        self.write({"package.json": "{}", "go.mod": "module x\n"})
        os.environ["GOMODCACHE"] = "/mine"
        self.settings({"npm_config_cache": "{cache}/npm", "API_TOKEN": "s3cr3t", "1BAD": "x"})
        found = self.checks()
        self.assertIn("You set GOMODCACHE yourself", found["caches.go-mod"]["detail"])
        self.assertIn("commands.env", found["caches.npm"]["detail"])
        self.assertIn("npm_config_cache={cache}/npm", found["caches.setting"]["detail"])
        self.assertNotIn("s3cr3t", found["caches.setting"]["detail"])
        self.assertIn("never put a secret in it", found["caches.setting"]["detail"])
        self.assertEqual(found["caches.setting.problems"]["status"], "warn")

    def test_nothing_for_a_project_with_no_package_manager(self):
        self.write({"README.md": "x"})
        self.assertEqual(self.checks(), {})


class InstallerIgnoresTheCacheTest(unittest.TestCase):
    def test_the_installer_s_ignore_block(self):
        self.assertIn(".factory/cache/", (ROOT / "templates" / "gitignore-block").read_text().splitlines())


if __name__ == "__main__":
    unittest.main()
