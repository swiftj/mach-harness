"""Tests for the secrets and dependency scan (scan.py), the build station's secrets gate and the review station's use of it.

Every fake secret here is built by joining strings at run time, so that no file in this repository holds one: neither the
repository's own secret scanners nor this one trip on this file (one test checks that).
"""

import io
import json
import os
import re
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for folder in ("review", "merge", "cleanup", "run", "build"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
sys.path.insert(0, str(ROOT / "skills" / "intent" / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import cleanup  # noqa: E402
import merge  # noqa: E402
import policy  # noqa: E402
import review  # noqa: E402
import run  # noqa: E402
import scan  # noqa: E402
from test_build import IMPL, IMPL2, RED_TEST, SCENARIO_TEST, git  # noqa: E402
from test_review import Base as ReviewBase, DETAIL, PANEL, SUMMARY, TICKET  # noqa: E402

J = "".join
GITHUB = J(["gh", "p_", "Zq7Lm2Xv9Tc4Rb8Nw1Ks6Jd3Hf5Gy0Pa1Qe2"])
GITHUB_PAT = J(["github", "_pat_", "11ABCDEFG0", "abcdefghijklmnopqrstuvwxyz0123456789"])
AWS_ID = J(["AK", "IA", "QZ7RTY2WXCV4BNM8"])
AWS_SECRET = J(["wJalr", "XUtnFEMI/K7MDENG/bPxRfiCYzq9Lm2Xv8T"])
SLACK = J(["xo", "xb-", "123456789012-", "abcdefghijklmnop"])
STRIPE = J(["sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"])
GOOGLE = J(["AI", "za", "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"])
JWT = J(["ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"])
OPENAI = J(["sk", "-proj-", "Qm4Zr8Lx2Vt7Nc1Pw9Bs3Kd6Hf0Gy5Ja"])
PRIVATE = J(["-----BEGIN ", "RSA PRIVATE", " KEY-----"])
URL_PASSWORD = J(["hunter", "2Secret"])
GENERIC = J(["q8Zr4LmN2", "vX9tY7wP3kS"])
ALL_VALUES = [GITHUB, GITHUB_PAT, AWS_ID, AWS_SECRET, SLACK, STRIPE, GOOGLE, JWT, OPENAI, URL_PASSWORD, GENERIC]


def added(path, *lines, new=True):
    """A unified diff that adds these lines to one file."""
    head = f"diff --git a/{path} b/{path}\n" + ("new file mode 100644\n--- /dev/null\n" if new else f"--- a/{path}\n") + f"+++ b/{path}\n"
    return head + f"@@ -0,0 +1,{len(lines)} @@\n" + "".join(f"+{line}\n" for line in lines)


def changed(path, before, after):
    """A full-context diff of a manifest from one text to another."""
    old, new = before.splitlines(), after.splitlines()
    import difflib
    body = list(difflib.unified_diff(old, new, f"a/{path}", f"b/{path}", n=100000, lineterm=""))
    return f"diff --git a/{path} b/{path}\n" + "\n".join(body) + "\n"


def kinds(result):
    return [(item["file"], item["line"], item["kind"]) for item in result["candidates"]]


class SecretShapesTest(unittest.TestCase):
    def test_each_well_known_shape_is_found_with_file_line_and_kind(self):
        cases = [
            (f'token = "{GITHUB}"', "github-token"), (f"key = '{GITHUB_PAT}'", "github-token"), (f"id: {AWS_ID}", "aws-access-key-id"),
            (f"aws_secret_access_key = {AWS_SECRET}", "aws-secret-access-key"), (f"SLACK={SLACK}", "slack-token"),
            (f"stripe.api_key = '{STRIPE}'", "stripe-live-key"), (f"maps({GOOGLE!r})", "google-api-key"), (f"auth: Bearer {JWT}", "jwt"),
            (f"client = OpenAI(api_key='{OPENAI}')", "api-key"), (PRIVATE, "private-key"),
            (f"DATABASE_URL = 'postgres://app:{URL_PASSWORD}@db.internal:5432/app'", "url-password"),
            (f'client_secret = "{GENERIC}"', "assigned-secret"),
        ]
        for line, kind in cases:
            with self.subTest(kind=kind):
                found = scan.secrets(added("src/settings.py", "import os", line))
                self.assertIn(("src/settings.py", 2, kind), kinds(found), line)

    def test_a_preview_never_holds_the_value(self):
        lines = [f'secret_{n} = "{value}"' for n, value in enumerate(ALL_VALUES)]
        lines[ALL_VALUES.index(URL_PASSWORD)] = f"url = 'https://user:{URL_PASSWORD}@example.org/'"
        lines[ALL_VALUES.index(AWS_SECRET)] = f"aws_secret_access_key = {AWS_SECRET}"
        diff = added("src/settings.py", *lines, PRIVATE)
        result = scan.secrets(diff)
        self.assertGreaterEqual(len(result["candidates"]), len(ALL_VALUES))
        text = json.dumps(result)
        for value in ALL_VALUES:
            self.assertNotIn(value, text)
            self.assertNotIn(value[:8], text, "no more than four characters of any value")
        for item in result["candidates"]:
            self.assertTrue(item["preview"].endswith(scan.MASK))
            self.assertLessEqual(len(item["preview"]), 4 + len(scan.MASK))

    def test_only_added_lines_count(self):
        diff = (f"diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n context = '{GITHUB}'\n-old = '{STRIPE}'\n+new = 1\n")
        self.assertEqual(scan.secrets(diff)["candidates"], [])

    def test_placeholders_and_environment_reads_are_skipped_and_say_which_rule(self):
        lines = ['password = "changeme-changeme-123"', 'api_key = "<your-api-key-goes-here>"', 'token = "${GITHUB_TOKEN_FROM_ENVIRONMENT}"',
                 'secret = os.environ["APP_SECRET_VALUE_LONG"]', 'secret_key = "xxxxxxxxxxxxxxxxxxxxxxxx"', J(["AK", "IA", "IOSFODNN7EXAMPLE"]),
                 'password = "short1"', 'auth_token = "aaaaaaaaaaaaaaaaaaaaaaaa"']
        result = scan.secrets(added("src/app.py", *lines))
        self.assertEqual(result["candidates"], [])
        rules = {item["skipped_by"] for item in result["skipped"]}
        self.assertTrue({"placeholder", "short-value", "low-entropy"} <= rules, rules)

    def test_lock_files_and_test_paths_skip_only_the_generic_rule(self):
        integrity = 'integrity_token "sha512-' + "Zq7Lm2Xv9Tc4Rb8Nw1Ks6Jd3Hf5Gy0Pa1Qe2" + '"'
        lock = scan.secrets(added("package-lock.json", f'"secret_token": "{GENERIC}"', integrity))
        self.assertEqual(lock["candidates"], [])
        self.assertIn("lockfile", {item["skipped_by"] for item in lock["skipped"]})
        fixture = scan.secrets(added("tests/fixtures/keys.py", f'secret = "{GENERIC}"', f'token = "{GITHUB}"'))
        self.assertEqual(kinds(fixture), [("tests/fixtures/keys.py", 2, "github-token")], "a specific shape is never skipped for being in a test")
        self.assertEqual([item["skipped_by"] for item in fixture["skipped"]], ["test-path"])

    def test_bare_assignments_count_in_env_and_config_files_only(self):
        self.assertEqual(kinds(scan.secrets(added(".env", f"SESSION_SECRET={GENERIC}"))), [(".env", 1, "assigned-secret")])
        self.assertEqual(kinds(scan.secrets(added("config/app.yaml", f"api_key: {GENERIC}"))), [("config/app.yaml", 1, "assigned-secret")])
        self.assertEqual(scan.secrets(added("src/notes.md", f"session_secret = {GENERIC}"))["candidates"], [])

    def test_the_same_diff_gives_the_same_output(self):
        diff = added("b.py", f"t = '{GITHUB}'") + added("a.py", f"k = '{STRIPE}'", PRIVATE)
        first = scan.secrets(diff)
        self.assertEqual(first, scan.secrets(diff))
        self.assertEqual([item["file"] for item in first["candidates"]], ["a.py", "a.py", "b.py"], "sorted by file and line")

    def test_bounded_and_says_so(self):
        diff = added("many.py", *(f"t{n} = '{GITHUB[:-2]}{n:02d}'" for n in range(scan.MAX_SECRETS + 5)))
        result = scan.secrets(diff)
        self.assertEqual((len(result["candidates"]), result["truncated"], result["total"]), (scan.MAX_SECRETS, True, scan.MAX_SECRETS + 5))

    def test_free_text_is_checked_for_the_build_and_review_refusals(self):
        self.assertEqual(scan.secrets_in_text(f"It is only {GITHUB}, a test key."), ["github-token"])
        self.assertEqual(scan.secrets_in_text("The token at src/a.py:3 (github-token, ghp_****) is real."), [])

    def test_plain_diffs_and_hunks_with_several_files(self):
        diff = (f"--- a/one.py\n+++ b/one.py\n@@ -1,1 +1,2 @@\n x = 1\n+t = '{GITHUB}'\n"
                f"--- a/two.py\n+++ b/two.py\n@@ -5,0 +6 @@\n+k = '{STRIPE}'\n")
        self.assertEqual(kinds(scan.secrets(diff)), [("one.py", 2, "github-token"), ("two.py", 6, "stripe-live-key")])

    def test_this_file_holds_no_secret_of_its_own(self):
        text = Path(__file__).read_text(encoding="utf-8")
        self.assertEqual(scan.secrets(added("tests/test_security_scan.py", *text.splitlines()))["candidates"], [])
        for value in ALL_VALUES:
            self.assertNotIn(value, text)


class DependencyTest(unittest.TestCase):
    def deps(self, path, before, after):
        result = scan.dependencies(changed(path, before, after))
        return [(d["name"], d["version"], d["change"], d["old_version"], d["dev"]) for d in result["dependencies"]], result

    def test_package_json_sections(self):
        before = '{\n  "dependencies": {\n    "left-pad": "1.0.0"\n  },\n  "devDependencies": {\n  }\n}\n'
        after = ('{\n  "dependencies": {\n    "left-pad": "1.3.0",\n    "expresss": "^4.18.0"\n  },\n  "devDependencies": {\n    "jest": "29.7.0"\n  },\n'
                 '  "peerDependencies": {\n    "react": ">=18"\n  },\n  "optionalDependencies": {\n    "fsevents": "2.3.3"\n  }\n}\n')
        found, result = self.deps("web/package.json", before, after)
        self.assertEqual(found, [("expresss", "^4.18.0", "added", None, False), ("fsevents", "2.3.3", "added", None, False),
                                 ("jest", "29.7.0", "added", None, True), ("left-pad", "1.3.0", "changed", "1.0.0", False),
                                 ("react", ">=18", "added", None, False)])
        self.assertEqual((result["dependencies"][0]["ecosystem"], result["dependencies"][0]["manifest"], result["dependencies"][0]["scope"]),
                         ("npm", "web/package.json", "dependencies"))

    def test_requirements_and_constraints(self):
        found, _ = self.deps("requirements.txt", "requests==2.30.0\n", "# pinned\nrequests==2.31.0\nDjango>=4.2,<5\n-r base.txt\nflask\n")
        self.assertEqual(found, [("Django", ">=4.2,<5", "added", None, False), ("flask", None, "added", None, False),
                                 ("requests", "==2.31.0", "changed", "==2.30.0", False)])
        found, _ = self.deps("requirements-dev.txt", "", "pytest==8.0.0\n")
        self.assertEqual(found, [("pytest", "==8.0.0", "added", None, True)])
        found, _ = self.deps("constraints.txt", "", "urllib3<3\n")
        self.assertEqual(found, [("urllib3", "<3", "added", None, False)])

    def test_pyproject_pep621_poetry_and_groups(self):
        after = ('[project]\nname = "x"\ndependencies = [\n  "httpx>=0.27",\n  "pydantic==2.7.0",\n]\n\n[project.optional-dependencies]\ndev = ["ruff==0.4.0"]\n'
                 'cli = ["click"]\n\n[dependency-groups]\ntest = ["pytest>=8"]\n\n[tool.poetry.dependencies]\npython = "^3.11"\nrich = "^13.0"\n'
                 'numpy = {version = "1.26.4", optional = true}\n\n[tool.poetry.group.dev.dependencies]\nmypy = "^1.10"\n')
        found, _ = self.deps("pyproject.toml", '[project]\nname = "x"\n', after)
        self.assertEqual(sorted(found), sorted([("click", None, "added", None, None), ("httpx", ">=0.27", "added", None, False),
                                                ("mypy", "^1.10", "added", None, True), ("numpy", "1.26.4", "added", None, False),
                                                ("pydantic", "==2.7.0", "added", None, False), ("pytest", ">=8", "added", None, True),
                                                ("rich", "^13.0", "added", None, False), ("ruff", "==0.4.0", "added", None, True)]))

    def test_pipfile_setup_cfg_and_setup_py(self):
        found, _ = self.deps("Pipfile", "[packages]\n", '[packages]\nrequests = "*"\n\n[dev-packages]\npytest = {version = "==8.0"}\n')
        self.assertEqual(found, [("pytest", "==8.0", "added", None, True), ("requests", "*", "added", None, False)])
        found, _ = self.deps("setup.cfg", "[options]\ninstall_requires =\n    attrs\n",
                             "[options]\ninstall_requires =\n    attrs>=23\n    cattrs\ntests_require =\n    hypothesis\n")
        self.assertEqual(found, [("attrs", ">=23", "changed", None, False), ("cattrs", None, "added", None, False),
                                 ("hypothesis", None, "added", None, True)])
        found, _ = self.deps("setup.py", "setup(\n)\n", "setup(\n    install_requires=[\n        'six>=1.16',\n    ],\n    tests_require=['nose'],\n)\n")
        self.assertEqual(found, [("nose", None, "added", None, True), ("six", ">=1.16", "added", None, False)])

    def test_go_mod(self):
        found, _ = self.deps("go.mod", "module x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n",
                             "module x\n\nrequire (\n\tgithub.com/a/b v1.1.0\n\tgolang.org/x/text v0.14.0 // indirect\n)\n\nrequire github.com/c/d v2.0.0\n")
        self.assertEqual(found, [("github.com/a/b", "v1.1.0", "changed", "v1.0.0", False), ("github.com/c/d", "v2.0.0", "added", None, False),
                                 ("golang.org/x/text", "v0.14.0", "added", None, False)])

    def test_cargo_toml(self):
        after = ('[package]\nname = "x"\n\n[dependencies]\nserde = { version = "1.0.200", features = ["derive"] }\nrand = "0.8"\n\n'
                 '[dev-dependencies]\nproptest = "1"\n\n[dependencies.tokio]\nversion = "1.37"\n')
        found, _ = self.deps("Cargo.toml", '[package]\nname = "x"\n', after)
        self.assertEqual(sorted(found), [("proptest", "1", "added", None, True), ("rand", "0.8", "added", None, False),
                                         ("serde", "1.0.200", "added", None, False), ("tokio", "1.37", "added", None, False)])

    def test_gemfile(self):
        found, _ = self.deps("Gemfile", "source 'https://rubygems.org'\n",
                             "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngroup :development, :test do\n  gem 'rspec-rails'\nend\ngem 'pg'\n")
        self.assertEqual(found, [("pg", None, "added", None, False), ("rails", "~> 7.1", "added", None, False), ("rspec-rails", None, "added", None, True)])

    def test_pom_and_gradle(self):
        pom = ("<project>\n<dependencies>\n<dependency>\n  <groupId>org.slf4j</groupId>\n  <artifactId>slf4j-api</artifactId>\n  <version>2.0.13</version>\n</dependency>\n"
               "<dependency>\n  <groupId>junit</groupId>\n  <artifactId>junit</artifactId>\n  <version>4.13.2</version>\n  <scope>test</scope>\n</dependency>\n"
               "</dependencies>\n</project>\n")
        found, _ = self.deps("pom.xml", "<project>\n</project>\n", pom)
        self.assertEqual(found, [("junit:junit", "4.13.2", "added", None, True), ("org.slf4j:slf4j-api", "2.0.13", "added", None, False)])
        gradle = ("dependencies {\n    implementation 'com.google.guava:guava:33.2.0-jre'\n    testImplementation(\"org.junit.jupiter:junit-jupiter:5.10.2\")\n"
                  "    api group: 'io.netty', name: 'netty-all', version: '4.1.110.Final'\n}\n")
        found, _ = self.deps("app/build.gradle.kts", "dependencies {\n}\n", gradle)
        self.assertEqual(found, [("com.google.guava:guava", "33.2.0-jre", "added", None, False), ("io.netty:netty-all", "4.1.110.Final", "added", None, False),
                                 ("org.junit.jupiter:junit-jupiter", "5.10.2", "added", None, True)])

    def test_composer_and_csproj(self):
        found, _ = self.deps("composer.json", '{\n  "require": {\n    "php": ">=8.1"\n  }\n}\n',
                             '{\n  "require": {\n    "php": ">=8.2",\n    "guzzlehttp/guzzle": "^7.8"\n  },\n  "require-dev": {\n    "phpunit/phpunit": "^10"\n  }\n}\n')
        self.assertEqual(found, [("guzzlehttp/guzzle", "^7.8", "added", None, False), ("phpunit/phpunit", "^10", "added", None, True)])
        csproj = ('<Project>\n  <ItemGroup>\n    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />\n'
                  '    <PackageReference Include="StyleCop.Analyzers" Version="1.1.118" PrivateAssets="all" />\n'
                  '    <PackageReference Include="Serilog">\n      <Version>3.1.1</Version>\n    </PackageReference>\n  </ItemGroup>\n</Project>\n')
        found, _ = self.deps("src/App/App.csproj", "<Project>\n</Project>\n", csproj)
        self.assertEqual(found, [("Newtonsoft.Json", "13.0.3", "added", None, False), ("Serilog", "3.1.1", "added", None, False),
                                 ("StyleCop.Analyzers", "1.1.118", "added", None, True)])

    def test_a_lock_file_changed_alone_is_named(self):
        diff = added("web/yarn.lock", "left-pad@1.3.0:", new=False) + added("go.sum", "x v1 h1:abc=", new=False) + changed("go.mod", "module x\n", "module x\ngo 1.22\n")
        result = scan.dependencies(diff)
        self.assertEqual((result["lockfile_only"], result["dependencies"]), (["web/yarn.lock"], []), "go.sum moved with go.mod; yarn.lock alone")

    def test_removed_dependencies_and_partial_context(self):
        found, _ = self.deps("requirements.txt", "requests==2.31.0\nsix\n", "requests==2.31.0\n")
        self.assertEqual(found, [], "a removal adds nothing")
        partial = 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -40,2 +40,3 @@\n     "a": "1",\n+    "b": "2",\n     "c": "3"\n'
        self.assertEqual(scan.dependencies(partial)["dependencies"], [], "with no section in sight nothing is guessed")

    def test_deterministic_and_bounded(self):
        after = "\n".join(f"pkg{n}=={n}.0" for n in range(scan.MAX_DEPENDENCIES + 3)) + "\n"
        diff = changed("requirements.txt", "", after)
        first = scan.dependencies(diff)
        self.assertEqual(first, scan.dependencies(diff))
        self.assertEqual((len(first["dependencies"]), first["truncated"], first["total"]), (scan.MAX_DEPENDENCIES, True, scan.MAX_DEPENDENCIES + 3))


class BuildGateTest(ReviewBase):
    def test_a_commit_holding_a_secret_is_refused_with_file_line_and_kind(self):
        self.ready()
        self.ok("start", TICKET)
        self.put(self.work, {"tests/test_invite.py": RED_TEST + f"\nFAKE = '{GITHUB}'\n"})
        out = self.refused("red", TICKET, "T01")
        self.assertIn("tests/test_invite.py:9 (github-token)", out)
        self.assertIn("Never commit a credential", out)
        self.assertNotIn(GITHUB, out)
        self.assertFalse(any("T01" in subject for subject in self.log()), "nothing was committed")

    def test_new_files_and_every_step_are_checked(self):
        self.ready()
        self.ok("start", TICKET)
        self.build_through("T01")
        self.put(self.work, {"app/invite.py": IMPL + f"\nSTRIPE = '{STRIPE}'\n"})
        self.assertIn("app/invite.py:4 (stripe-live-key)", self.refused("green", TICKET, "T02"))
        self.put(self.work, {"app/invite.py": IMPL})
        self.ok("green", TICKET, "T02")
        self.put(self.work, {"tests/test_scenarios.py": SCENARIO_TEST})
        self.ok("red", TICKET, "T03")
        self.put(self.work, {"app/invite.py": IMPL2})
        self.ok("green", TICKET, "T04")
        self.put(self.work, {"README.md": f"# Sample\n\n    curl https://admin:{URL_PASSWORD}@example.org/\n"})
        self.assertIn("README.md:3 (url-password)", self.refused("done", TICKET, "T05"))

    def test_the_override_is_recorded_for_reviewers_without_the_value(self):
        self.ready()
        self.ok("start", TICKET)
        self.put(self.work, {"tests/test_invite.py": RED_TEST + f"\nFAKE = '{GITHUB}'\n"})
        self.assertIn("looks like it holds a secret", self.refused("red", TICKET, "T01", "--not-a-secret", f"it is {GITHUB}"))
        self.ok("red", TICKET, "T01", "--not-a-secret", "A revoked token kept as a parser fixture; it grants nothing.")
        [deviation] = [d for d in self.state()["deviations"] if d["type"] == "not-a-secret"]
        self.assertEqual(deviation["candidates"], [{"file": "tests/test_invite.py", "line": 9, "kind": "github-token"}])
        self.assertIn("revoked token", deviation["detail"])
        self.put(self.work, {"app/invite.py": IMPL})
        self.ok("green", TICKET, "T02")
        self.put(self.work, {"tests/test_scenarios.py": SCENARIO_TEST})
        self.ok("red", TICKET, "T03")
        self.put(self.work, {"app/invite.py": IMPL2})
        self.ok("green", TICKET, "T04")
        self.put(self.work, {"README.md": "# Sample\n\nAdmins can invite teammates.\n"})
        self.ok("done", TICKET, "T05")
        self.ok("finish", TICKET)
        report = json.loads((self.cellroot / "build-report.json").read_text())
        self.assertEqual(report["secret_scan"]["enabled"], True)
        self.assertEqual(report["secret_scan"]["not_a_secret"][0]["candidates"][0]["kind"], "github-token")
        self.assertNotIn(GITHUB, json.dumps(report))
        records = [json.loads(line) for line in (self.cellroot / "lifecycle.jsonl").read_text().splitlines()]
        self.assertIn("secrets", {r["data"].get("gate") for r in records if r["type"] == "gate.evaluated" and r["data"].get("outcome") == "override"})

    def test_switched_off_the_gate_lets_it_through_and_the_report_says_so(self):
        self.ready()
        self.config({"security": {"scan": {"enabled": False}}})
        self.ok("start", TICKET)
        self.put(self.work, {"tests/test_invite.py": RED_TEST + f"\nFAKE = '{GITHUB}'\n"})
        self.ok("red", TICKET, "T01")
        self.build_through_rest()
        self.ok("finish", TICKET)
        self.assertEqual(json.loads((self.cellroot / "build-report.json").read_text())["secret_scan"], {"enabled": False, "not_a_secret": []})

    def build_through_rest(self):
        for task, step, files in (("T02", "green", {"app/invite.py": IMPL}), ("T03", "red", {"tests/test_scenarios.py": SCENARIO_TEST}),
                                  ("T04", "green", {"app/invite.py": IMPL2}), ("T05", "done", {"README.md": "# Sample\n\nAdmins can invite.\n"})):
            self.put(self.work, files)
            self.ok(step, TICKET, task)


class ScanReviewBase(ReviewBase):
    """A Medium-risk ticket whose last task also adds `extra` files (allowed as extras), optionally overriding the secrets gate."""

    extra = {}
    override = None

    def built(self):
        self.ready()
        self.ok("start", TICKET)
        self.build_through("T04")
        self.put(self.work, {"README.md": "# Sample\n\nAdmins can invite teammates.\n", **self.extra})
        flags = ["--allow-extra", "the slice needs these files"] + (["--not-a-secret", self.override] if self.override else [])
        self.ok("done", TICKET, "T05", *flags)
        self.ok("finish", TICKET)

    def packet(self, folder=None):
        return json.loads(((folder or self.round) / "packet.json").read_text())

    def decision(self, folder=None):
        return json.loads(((folder or self.round) / "decision.json").read_text())

    def answering(self, role, *findings, answers=None):
        self.count += 1
        path = Path(self.tmp.name) / f"findings-{self.count}.json"
        data = {"summary": SUMMARY, "findings": list(findings)}
        if answers is not None:
            data["scan_answers"] = answers
        path.write_text(json.dumps(data))
        return self.run_review("submit", TICKET, "--reviewer", role, "--findings", str(path))


REQUIREMENTS = {"requirements.txt": "requests==2.31.0\n"}
DEV_ONLY = {"requirements-dev.txt": "pytest==8.2.0\n"}
SECRET_FILE = {"app/settings.py": f"API_TOKEN = '{GITHUB}'\n"}


class UnflaggedSeatingTest(ScanReviewBase):
    def test_seating_for_an_unflagged_ticket_is_unchanged(self):
        self.verified()
        for risk, seats in (("Medium", [(role, "sonnet") for role in PANEL]), ("High", [(role, "opus") for role in PANEL]), ("Low", [("general", "sonnet")])):
            with self.subTest(risk=risk):
                self.edit_json("cell.json", risk=risk)
                started = self.r_ok("start", TICKET)
                self.assertEqual([(seat["role"], seat["model"]) for seat in started["panel"]], seats)
                found = self.packet()["security_scan"]
                self.assertEqual((found["enabled"], found["flagged"], found["secrets"], found["dependencies"], found["panel_change"]),
                                 (True, False, [], [], []))
                self.assertEqual(found["vulnerability_note"], scan.NO_VULNERABILITY_DATABASE)

    def test_an_unflagged_submission_needs_no_answers_and_the_vote_keeps_its_shape(self):
        self.verified()
        self.r_ok("start", TICKET)
        self.cast()
        vote = json.loads((self.round / "votes" / "security.json").read_text())
        self.assertNotIn("scan_answers", vote)
        code, done = self.tally()
        self.assertEqual(self.decision()["security_scan"]["counts"]["secret_candidates"], 0)
        self.assertNotIn("Security scan", (self.round / "findings.md").read_text(), "nothing flagged, nothing added to the findings")


class DevDependencyTest(ScanReviewBase):
    extra = DEV_ONLY

    def test_a_development_only_dependency_is_listed_and_answered_but_does_not_raise_the_panel(self):
        self.verified()
        self.edit_json("cell.json", risk="Low")
        started = self.r_ok("start", TICKET)
        self.assertEqual([(seat["role"], seat["model"]) for seat in started["panel"]], [("general", "sonnet")])
        found = self.packet()["security_scan"]
        self.assertEqual((found["flagged"], found["answering_seat"]), (False, "general"))
        self.assertEqual([(d["id"], d["name"], d["dev"]) for d in found["dependencies"]], [("D1", "pytest", True)])
        code, out, err = self.answering("general")
        self.assertIn("not answered: D1", err)
        self.assertEqual(json.loads(self.answering("general", answers={"dependencies": [{"id": "D1", "answer": "acceptable",
                                                                                         "reason": "The project's own test runner, pinned."}]})[1])["vote"], "APPROVE")


class FlaggedPanelTest(ScanReviewBase):
    extra = REQUIREMENTS

    def test_a_flagged_low_risk_ticket_gets_the_medium_panel_and_a_strong_security_seat(self):
        self.verified()
        self.edit_json("cell.json", risk="Low")
        started = self.r_ok("start", TICKET)
        self.assertEqual([(seat["role"], seat["model"]) for seat in started["panel"]], [("architecture", "sonnet"), ("security", "opus"), ("product", "sonnet")])
        self.assertEqual((started["approvals_needed"], started["human_approval_required"]), (2, False))
        packet = self.packet()
        self.assertEqual(len(packet["security_scan"]["panel_change"]), 2)
        self.assertIn("three seats with 2 approvals", packet["security_scan"]["panel_change"][0])
        self.assertEqual([(d["name"], d["version"], d["change"], d["dev"]) for d in packet["security_scan"]["dependencies"]],
                         [("requests", "==2.31.0", "added", False)])

    def test_a_flagged_medium_ticket_puts_its_security_seat_on_the_contracts_model_and_high_and_tuning_are_unchanged(self):
        self.verified()
        started = self.r_ok("start", TICKET)
        self.assertEqual([(seat["role"], seat["model"]) for seat in started["panel"]], [("architecture", "sonnet"), ("security", "opus"), ("product", "sonnet")])
        self.assertEqual(started["approvals_needed"], 2)
        self.config({"models": {"contracts": "fable", "build": "sonnet"}})
        self.assertEqual([seat["model"] for seat in self.r_ok("start", TICKET)["panel"]], ["sonnet", "fable", "sonnet"], "the contracts tier's model, as configured")
        self.config({})
        self.edit_json("cell.json", risk="High")
        started = self.r_ok("start", TICKET)
        self.assertEqual(([(s["role"], s["model"]) for s in started["panel"]], started["approvals_needed"], started["human_approval_required"]),
                         ([(role, "opus") for role in PANEL], 3, True))
        self.assertEqual(self.packet()["security_scan"]["panel_change"], [])
        self.edit_json("cell.json", risk="Medium")
        self.put(self.project, {".factory/tickets/LOCAL-001.md": '---\nid: LOCAL-001\ntitle: "Tune"\nstate: open\nlabels: ["factory-tuning"]\n---\n'})
        started = self.r_ok("start", TICKET)
        self.assertEqual(([s["model"] for s in started["panel"]], started["approvals_needed"]), (["opus"] * 3, 3))
        self.assertEqual(self.packet()["security_scan"]["panel_change"], [])

    def test_the_security_seat_must_answer_every_item(self):
        self.verified()
        self.r_ok("start", TICKET)
        code, out, err = self.answering("security")
        self.assertIn("not answered: D1", err)
        self.assertFalse((self.round / "votes" / "security.json").exists())
        code, out, err = self.answering("architecture", answers={"dependencies": []})
        self.assertIn("Only the security seat answers", err)
        bad = [({"dependencies": [{"id": "D9", "answer": "acceptable", "reason": "Pinned and widely used here."}]}, "not one of the scan's"),
               ({"dependencies": [{"id": "D1", "answer": "fine", "reason": "Pinned and widely used here."}]}, "acceptable or concern"),
               ({"dependencies": [{"id": "D1", "answer": "acceptable", "reason": "ok"}]}, "needs a 'reason'"),
               ({"dependencies": [{"id": "D1", "answer": "concern", "reason": "Not needed for this slice."}]}, "must name requests")]
        for answers, message in bad:
            with self.subTest(message=message):
                self.assertIn(message, self.answering("security", answers=answers)[2])
        note = {"severity": "note", "title": "requests is not needed", "detail": "The standard library urllib does this; drop requests from requirements.txt."}
        code, out, err = self.answering("security", note, answers={"dependencies": [{"id": "D1", "answer": "concern", "reason": "Not needed for this slice."}]})
        self.assertEqual(code, 0, err)
        vote = json.loads((self.round / "votes" / "security.json").read_text())
        self.assertEqual(vote["scan_answers"]["dependencies"], [{"id": "D1", "answer": "concern", "reason": "Not needed for this slice."}])
        self.vote("architecture")
        self.vote("product")
        code, done = self.tally()
        decision = self.decision()
        self.assertEqual(decision["security_scan"]["counts"]["concerns"], 1)
        self.assertEqual(decision["security_scan"]["dependencies"][0]["answer"], "concern")
        findings = (self.round / "findings.md").read_text()
        self.assertIn("## Security scan", findings)
        self.assertIn("pypi dependency `requests` added", findings)
        self.assertIn(scan.NO_VULNERABILITY_DATABASE, findings)
        records = [json.loads(line) for line in (self.cellroot / "lifecycle.jsonl").read_text().splitlines()]
        [line] = [r for r in records if r["type"] == "review.scan_recorded"]
        self.assertEqual((line["data"]["flagged"], line["data"]["dependencies"], line["data"]["concerns"]), (True, 1, 1))
        self.assertNotIn("requests", json.dumps(line), "counts only in the lifecycle log")

    def test_a_later_round_answers_only_what_is_new(self):
        self.verified()
        self.r_ok("start", TICKET)
        self.answering("security", answers={"dependencies": [{"id": "D1", "answer": "acceptable", "reason": "Pinned, needed for the HTTP call."}]})
        self.vote("architecture", self.blocker())
        self.vote("product", self.blocker())
        code, done = self.tally()
        self.assertEqual(done["outcome"], "REJECTED")
        self.ok("revise", TICKET, "--findings", done["findings"])
        self.ok("add-task", TICKET, "--kind", "impl", "--text", "Validate the address", "--file", "app/invite.py", "--file", "requirements.txt")
        self.put(self.work, {"app/invite.py": IMPL2 + "\n# validated\n", "requirements.txt": "requests==2.31.0\nidna==3.7\n"})
        self.ok("green", TICKET, "R1-T01")
        self.ok("finish", TICKET)
        self.run_verify("start", TICKET)
        (self.evidence / "consumer-run.log").write_text("AC-01 ok\n")
        for target in ("AC-01", "AC-02", "AC-03", "R1", "R2", "R3", "R4", "R5"):
            self.run_verify("record", TICKET, target, "--result", "pass", "--evidence", "consumer-run.log", "--note",
                            "Called invite() as a consumer and observed the expected outcome and unchanged seat count.")
        self.run_verify("finish", TICKET)
        self.r_ok("start", TICKET)
        second = self.cellroot / "review" / "round-2"
        items = {d["name"]: d for d in self.packet(second)["security_scan"]["dependencies"]}
        self.assertEqual((items["requests"]["needs_answer"], items["requests"]["carried"]["answer"], items["requests"]["carried"]["round"]), (False, "acceptable", 1))
        self.assertTrue(items["idna"]["needs_answer"])
        self.round = second
        refused = self.answering("security", answers={"dependencies": [{"id": items["requests"]["id"], "answer": "acceptable", "reason": "Again, pinned and needed."}]})
        self.assertIn("carried forward", refused[2])
        code, out, err = self.answering("security", answers={"dependencies": [{"id": items["idna"]["id"], "answer": "acceptable", "reason": "Pinned; used by requests."}]})
        self.assertEqual(code, 0, err)


class SecretReviewTest(ScanReviewBase):
    extra = SECRET_FILE
    override = "A sample token from the vendor's documentation; it grants nothing."

    def test_the_override_is_shown_and_a_real_answer_needs_a_vetoing_blocker(self):
        self.verified()
        self.r_ok("start", TICKET)
        [item] = self.packet()["security_scan"]["secrets"]
        self.assertEqual((item["id"], item["file"], item["line"], item["kind"]), ("S1", "app/settings.py", 1, "github-token"))
        self.assertIn("vendor's documentation", item["overridden_by_builder"])
        answers = {"secrets": [{"id": "S1", "answer": "real", "reason": "It has the live token shape and no sign of being revoked."}]}
        self.assertIn("must hold a blocker", self.answering("security", answers=answers)[2])
        self.assertIn("must hold a blocker", self.answering("security", self.blocker(file="app/settings.py", line=1, impact="medium"), answers=answers)[2])
        quoted = self.blocker(file="app/settings.py", line=1, impact="critical", rule="REVIEW.md: no secrets in code", detail=f"The value {GITHUB} is committed in plain text here.")
        self.assertIn("never quote its value", self.answering("security", quoted, answers=answers)[2])
        veto = self.blocker(file="app/settings.py", line=1, impact="critical", rule="REVIEW.md: no secrets in code",
                            title="A live token is committed", detail="Remove it from the file, rotate it, and read it from the environment at run time.")
        code, out, err = self.answering("security", veto, answers=answers)
        self.assertEqual(code, 0, err)
        self.vote("architecture")
        self.vote("product")
        code, done = self.tally()
        self.assertEqual(done["outcome"], "REJECTED", "a real secret vetoes the round")
        summary = self.decision()["security_scan"]
        self.assertEqual((summary["counts"]["real"], summary["counts"]["overridden_by_builder"]), (1, 1))
        self.assert_value_nowhere()

    def assert_value_nowhere(self):
        """The secret's value is in the committed file the builder wrote, and in the review's copies of the branch's diff
        (diff.patch, delta.patch: the change itself, which reviewers must read), and nowhere else the factory wrote."""
        for path in (self.project / ".factory").rglob("*"):
            if path.is_file() and "repo" not in path.relative_to(self.project / ".factory").parts and path.name not in ("diff.patch", "delta.patch"):
                self.assertNotIn(GITHUB.encode(), path.read_bytes(), str(path))
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            run.main(["--project", str(self.project), "explain", TICKET, "--json"])
        facts = json.loads(out.getvalue())
        self.assertEqual(facts["security_scan"]["secrets"][0]["kind"], "github-token")
        self.assertNotIn(GITHUB, out.getvalue())

    def test_not_a_secret_is_recorded_and_carried_to_the_pull_request_explain_and_the_run_record(self):
        self.verified()
        self.r_ok("start", TICKET)
        self.answering("security", answers={"secrets": [{"id": "S1", "answer": "not_a_secret", "reason": "The documented sample token; the vendor revoked it."}]})
        self.vote("architecture")
        self.vote("product")
        code, done = self.tally()
        self.assertEqual(done["outcome"], "APPROVED")
        body = merge.pr_body(merge.Cell(self.project, TICKET))
        self.assertIn("## Security scan", body)
        self.assertIn("Possible secret (github-token) at `app/settings.py:1`, recorded by the builder as not a secret: answered not_a_secret", body)
        self.assertNotIn(GITHUB, body)
        record = cleanup.scan_record([self.decision()])
        self.assertEqual(record, {"secret_candidates": 1, "real": 0, "dependencies_added": 0, "concerns": 0, "enabled": True})
        self.assertIsNone(cleanup.scan_record([{"security_scan": {"enabled": True, "counts": {}}}]), "nothing flagged keeps the record's shape")
        self.assertIsNone(cleanup.scan_record([{}]))
        self.assert_value_nowhere()


class ScanOffTest(ScanReviewBase):
    extra = REQUIREMENTS

    def test_switched_off_review_records_it_and_unattended_work_is_refused(self):
        self.verified()
        self.config({"security": {"scan": {"enabled": False}}})
        started = self.r_ok("start", TICKET)
        self.assertEqual([(seat["role"], seat["model"]) for seat in started["panel"]], [(role, "sonnet") for role in PANEL])
        self.assertEqual((self.packet()["security_scan"]["enabled"], self.packet()["security_scan"]["dependencies"]), (False, []))
        self.cast()
        code, done = self.tally()
        self.assertEqual(self.decision()["security_scan"]["enabled"], False)
        self.assertIn("switched off", (self.round / "findings.md").read_text())
        self.assertIn("switched off", merge.pr_body(merge.Cell(self.project, TICKET)))
        self.assertEqual(cleanup.scan_record([self.decision()]), {"enabled": False})
        problems = policy.security_review_problems({"security": {"scan": {"enabled": False}}})
        self.assertEqual(len(problems), 1)
        self.assertIn("a person can still run that ticket by hand", problems[0])


class ScannerReportsTest(ScanReviewBase):
    def test_reports_are_named_not_parsed(self):
        self.verified()
        self.put(self.project, {".factory/release/scans/trivy-abc.json": "{not even json"})
        self.r_ok("start", TICKET)
        self.assertEqual(self.packet()["security_scan"]["scanner_reports"], ["trivy-abc.json"])


class DocsTest(unittest.TestCase):
    def test_the_template_turns_the_scan_on(self):
        template = json.loads((ROOT / "templates/config.json").read_text())
        self.assertEqual(template["security"]["scan"], {"enabled": True})

    def test_the_builder_and_reviewers_are_told(self):
        builder = (ROOT / "agents/builder.md").read_text() + (ROOT / "skills/build/SKILL.md").read_text()
        self.assertIn("Never commit a credential", builder)
        self.assertIn("--not-a-secret", builder)
        checklist = (ROOT / "skills/review/references/security.md").read_text()
        for phrase in ("typosquat", "standard library", "say so plainly", "scan_answers"):
            self.assertIn(phrase, checklist)


if __name__ == "__main__":
    unittest.main()
