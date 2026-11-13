"""The Control Tower (MACH Next M6.1/M6.2) is wired in as a watcher only.

Its observer, mach-observer, is fetched by the installer and started by a step in the run skill when a
person asks for it. Nothing in the line may depend on it: no station script, agent or workflow invokes
it or reads its files, and the observer itself can start nothing and never reaches for the Factory's
switch. The release and installer sides are tested in test_installer.py.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OBSERVER = ROOT / "apps" / "observer"
RUN_SKILL = ROOT / "skills" / "run" / "SKILL.md"
# What would mean a MACH file reaches for the observer: its program, its source, its folder, its API.
OBSERVER_WORDS = ("mach-observer", "apps/observer", "local/observer", "/api/v1/")


class NothingInTheLineDependsOnTheObserverTest(unittest.TestCase):
    def test_no_station_script_agent_or_workflow_mentions_it(self):
        """Only the run skill's own instructions name the observer (the step a person asks for), and
        the scaffold only git-ignores it. No script, agent, workflow or other skill text does."""
        allowed = {RUN_SKILL, ROOT / "templates" / "gitignore-block"}
        found = []
        for top in ("skills", "agents", "workflows", "templates"):
            for path in sorted((ROOT / top).rglob("*")):
                if not path.is_file() or "__pycache__" in path.parts or path in allowed:
                    continue
                text = path.read_text(encoding="utf-8", errors="ignore")
                found += [f"{path.relative_to(ROOT)}: {word}" for word in OBSERVER_WORDS if word in text]
        self.assertEqual(found, [])

    def test_the_run_script_has_no_tower_command(self):
        """Opening the Control Tower is a skill step, not a command: run.py and the argument hint are unchanged."""
        for name in ("run.py", "supervisor.py", "executor.py", "service.py", "activation.py", "policy.py", "intake.py"):
            source = (ROOT / "skills" / "run" / "scripts" / name).read_text(encoding="utf-8")
            for word in ("observer", "tower", "Tower"):
                self.assertNotIn(word, source, f"{name}: {word}")
        head = RUN_SKILL.read_text(encoding="utf-8").split("\n---", 1)[0]
        hint = re.search(r'^argument-hint: "(.*)"$', head, re.MULTILINE).group(1)
        self.assertNotIn("tower", hint.lower())
        self.assertNotIn("observer", hint.lower())


class TheObserverCannotActTest(unittest.TestCase):
    """A source-level guard from outside the observer's own tests: it starts no process and never
    reaches for the Factory's switch. Its Go tests hold the rest (TestSourceBoundary)."""

    SCRIPTS = ("run.py", "policy.py", "supervisor.py", "executor.py", "service.py", "activation.py", "intake.py")

    def sources(self):
        files = sorted(p for p in OBSERVER.rglob("*.go") if not p.name.endswith("_test.go"))
        self.assertTrue(files, "no observer source found")
        return files

    def test_it_can_start_no_process(self):
        found = []
        for path in self.sources():
            text = path.read_text(encoding="utf-8")
            found += [f"{path.relative_to(ROOT)}: {word}" for word in ('"os/exec"', "os.StartProcess", "syscall.Exec", "syscall.ForkExec", '"plugin"')
                      if word in text]
        self.assertEqual(found, [])

    def test_it_never_names_the_factory_switch(self):
        found = []
        for path in self.sources():
            text = path.read_text(encoding="utf-8")
            found += [f"{path.relative_to(ROOT)}: {word}" for word in ("factory enable", '"enable"', "--confirm", "--include-backlog", "runner.json.tmp")
                      if word in text]
        self.assertEqual(found, [])

    def test_mach_scripts_are_named_only_in_comments_notes_and_the_redaction_allowlist(self):
        """run.py and the supervisor's modules may be named to explain or to keep a script's name
        in redacted text, never anywhere a program could be started from."""
        allowlist = OBSERVER / "internal" / "redact" / "allow.go"
        found = []
        for path in self.sources():
            if path == allowlist:
                continue
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                code = line.split("//", 1)[0]
                if any(script in code for script in self.SCRIPTS) and '"note":' not in code:
                    found.append(f"{path.relative_to(ROOT)}:{number}: {line.strip()}")
        self.assertEqual(found, [])


class TheSkillStepTest(unittest.TestCase):
    def setUp(self):
        text = RUN_SKILL.read_text(encoding="utf-8")
        self.assertIn("\n## The Control Tower\n", text)
        start = text.index("\n## The Control Tower\n")
        end = text.find("\n## ", start + 5)
        self.step = text[start:end if end != -1 else len(text)]

    def test_it_starts_the_observer_the_way_m5_starts_the_studio(self):
        self.assertIn("${CLAUDE_SKILL_DIR}/../../apps/observer/bin/mach-observer", self.step)
        self.assertIn(".factory/bin/mach-observer", self.step)
        self.assertIn('--project "<project folder>"', self.step)
        self.assertNotIn("--no-open", self.step)  # the observer never opens a browser, and has no such flag
        self.assertIn(".factory/local/observer/link", self.step)
        self.assertIn("apps/observer/build.sh", self.step)
        self.assertIn("Open: http://127.0.0.1:", self.step)

    def test_it_says_what_the_tower_cannot_do(self):
        for words in ("read-only", "Live Factory", "Simulation", "never affects the Factory", "enable", "approve", "merge"):
            self.assertIn(words, self.step, words)

    def test_the_flags_it_names_exist(self):
        main = (OBSERVER / "cmd" / "mach-observer" / "main.go").read_text(encoding="utf-8")
        flags = set(re.findall(r'flags\.\w+\("([a-z-]+)"', main))
        used = {flag for chunk in re.findall(r"`([^`]+)`", self.step) for flag in re.findall(r"(?<![\w-])--([a-z][a-z-]*)", chunk)}
        self.assertTrue(used, "the step names no flag")
        self.assertLessEqual(used, flags)


if __name__ == "__main__":
    unittest.main()
