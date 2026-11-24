"""The Factory Floor watches, and a person can decide and stop there (M23), through MACH's own run.py.

Its observer, mach-observer, is fetched by the installer and started by a step in the run skill when a
person asks for it. Nothing in the line may depend on it: no station script, agent or workflow invokes
it or reads its files. The observer runs nothing but MACH's run.py, from one package (internal/act),
with fixed commands (decide --json, decide do ... --via=floor, factory status, factory stop), and never
reaches for the Factory's switch: it never enables, starts or dispatches work. The release and installer
sides are tested in test_installer.py.
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

    def test_the_run_script_has_no_floor_command(self):
        """Opening the Factory Floor is a skill step, not a script command: run.py has none. The skill recognises the
        word `floor` (and `studio` for Product Studio) from a person; that is routing in the skill, and no script,
        station, agent or workflow can call it. Plain "floor" is not checked in the scripts: they use it for other
        things (math.floor, RISK_FLOOR)."""
        for name in ("run.py", "supervisor.py", "executor.py", "service.py", "activation.py", "policy.py", "intake.py"):
            source = (ROOT / "skills" / "run" / "scripts" / name).read_text(encoding="utf-8")
            for word in ("observer", "Factory Floor", "factory floor", "factory-floor", "factory_floor", "FactoryFloor"):
                self.assertNotIn(word, source, f"{name}: {word}")
        head = RUN_SKILL.read_text(encoding="utf-8").split("\n---", 1)[0]
        hint = re.search(r'^argument-hint: "(.*)"$', head, re.MULTILINE).group(1)
        self.assertIn("| studio | floor |", hint)
        self.assertNotIn("observer", hint.lower())
        self.assertNotIn("factory-floor", hint.lower())
        text = RUN_SKILL.read_text(encoding="utf-8")
        self.assertIn("neither is a command of `RUN`", text)
        self.assertIn("Never open either on your own initiative, in headless mode, or inside a supervised Factory execution.", text)
        parser = (ROOT / "skills" / "run" / "scripts" / "run.py").read_text(encoding="utf-8")
        for word in ('add_parser("floor"', 'add_parser("studio"'):
            self.assertNotIn(word, parser)


class TheObserverActsOnlyThroughRunPyTest(unittest.TestCase):
    """A source-level guard from outside the observer's own tests: only internal/act starts a process, it starts
    only MACH's run.py, and nothing reaches for the Factory's switch. Its Go tests hold the rest (TestSourceBoundary,
    act.TestFixedVectors, server.TestWritesNeedTheSessionOriginAndCSRF)."""

    SCRIPTS = ("run.py", "policy.py", "supervisor.py", "executor.py", "service.py", "activation.py", "intake.py")
    ACT = OBSERVER / "internal" / "act"

    def sources(self):
        files = sorted(p for p in OBSERVER.rglob("*.go") if not p.name.endswith("_test.go"))
        self.assertTrue(files, "no observer source found")
        return files

    def test_only_internal_act_can_start_a_process(self):
        found, act = [], []
        for path in self.sources():
            text = path.read_text(encoding="utf-8")
            if '"os/exec"' in text:
                (act if path.parent == self.ACT else found).append(str(path.relative_to(ROOT)))
            found += [f"{path.relative_to(ROOT)}: {word}" for word in ("os.StartProcess", "syscall.Exec", "syscall.ForkExec", '"plugin"') if word in text]
        self.assertEqual(found, [])
        self.assertIn("apps/observer/internal/act/act.go", act)

    def test_it_runs_four_fixed_commands_of_run_py(self):
        """Each argument vector is a fixed list of words; a person's values are only ever appended as --name=value."""
        code = "\n".join(line.split("//", 1)[0] for path in sorted(self.ACT.glob("*.go")) if not path.name.endswith("_test.go")
                         for line in path.read_text(encoding="utf-8").splitlines())
        for vector in ('[]string{"decide", "--json"}', '[]string{"factory", "status"}', '[]string{"factory", "stop"}',
                       '[]string{"decide", "do", d.Ticket, d.Option}', '"--via=floor", "--json"', '"-I", "-B", r.cfg.Script, "--project=" + r.cfg.Project'):
            self.assertIn(vector, code)
        self.assertEqual(sorted(set(re.findall(r'\bflag\("([a-z-]+)"', code))), ["adr", "answers-file", "by", "reason", "test-cmd"])

    def test_it_never_names_the_factory_switch(self):
        found = []
        for path in self.sources():
            text = path.read_text(encoding="utf-8")
            found += [f"{path.relative_to(ROOT)}: {word}" for word in ("factory enable", "factory start", "--persistent", '"enable"', "--confirm", "--include-backlog", "runner.json.tmp")
                      if word in text]
            if path.parent == self.ACT:  # the one package that runs anything names no other command of run.py
                found += [f"{path.relative_to(ROOT)}: {word}" for word in ('"start"', '"dispatch"', '"pull"', '"resume"', '"pause"', '"serve"', '"tick"') if word in text]
        self.assertEqual(found, [])

    def test_mach_scripts_are_named_only_in_comments_notes_the_redaction_allowlist_and_internal_act(self):
        """run.py and the supervisor's modules may be named to explain or to keep a script's name in redacted text;
        only internal/act names run.py where a program is started from, and no other script anywhere."""
        allowlist = OBSERVER / "internal" / "redact" / "allow.go"
        found = []
        for path in self.sources():
            if path == allowlist:
                continue
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                code = line.split("//", 1)[0]
                named = [script for script in self.SCRIPTS if script in code]
                if path.parent == self.ACT:
                    named = [script for script in named if script != "run.py"]
                if named and '"note":' not in code:
                    found.append(f"{path.relative_to(ROOT)}:{number}: {line.strip()}")
        self.assertEqual(found, [])


class TheSkillStepTest(unittest.TestCase):
    def setUp(self):
        text = RUN_SKILL.read_text(encoding="utf-8")
        self.assertIn("\n## The Factory Floor\n", text)
        start = text.index("\n## The Factory Floor\n")
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

    def test_it_says_what_the_floor_does_and_cannot_do(self):
        """M23: a person decides and stops in the Floor, through MACH; it never enables, starts or dispatches work."""
        for words in ("Live Factory", "Simulation", "never affects the Factory", "Needs you", "Stop", "decide do", "never enables, starts or dispatches"):
            self.assertIn(words, self.step, words)
        self.assertNotIn("read-only", self.step)

    def test_the_flags_it_names_exist(self):
        main = (OBSERVER / "cmd" / "mach-observer" / "main.go").read_text(encoding="utf-8")
        flags = set(re.findall(r'flags\.\w+\("([a-z-]+)"', main))
        used = {flag for chunk in re.findall(r"`([^`]+)`", self.step) for flag in re.findall(r"(?<![\w-])--([a-z][a-z-]*)", chunk)}
        self.assertTrue(used, "the step names no flag")
        self.assertLessEqual(used, flags)


if __name__ == "__main__":
    unittest.main()
