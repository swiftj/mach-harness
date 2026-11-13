"""Every command the stations' instructions prescribe must run inside the Factory's restricted boundary.

An unattended execution (M4) may use only the tools a person consented to (policy.default_tools()): a few
read-only `git` commands and Python. Anything else is refused and never asked about. The skills were written
for interactive use, so in the first real runs (M6.2 acceptance, D22; M4 known issue 9) the verifier and the
builder improvised heredocs, `cd … && git …`, output redirects and shell variables, every one was refused, and
the belt stopped with the ticket "stuck at built".

The fix is in the stations, not in the allow list: each script has argument forms that need no shell
composition (verify.py capture and record --from, review.py submit without --findings), and each instruction
file prescribes only single, plain invocations and says so. This test holds that:

- every command an instruction file prescribes (each line of a ```bash block, and each inline code span that
  starts with a station's command name or `python3`) is one plain command, with no chaining, redirect, heredoc,
  change of directory, variable or substitution, and is allowed by the consented tool list, matched the way
  Claude Code matches a `Bash(prefix *)` rule;
- the verify and review commands parse with their scripts' own argument parsers;
- each file the belt runs unattended carries the "one plain command per call" rule.

Inline mentions of other programs (`git merge`, `gh pr merge`) are not prescriptions: the skills name them only
to forbid them. A future instruction that prescribes a heredoc, `&&` or a redirect fails here.
"""

import re
import shlex
import sys
import unittest
from pathlib import Path
from typing import Iterator, List, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
for folder in ("run", "verify", "review"):
    sys.path.insert(0, str(ROOT / "skills" / folder / "scripts"))
import policy  # noqa: E402
import review  # noqa: E402
import verify  # noqa: E402

# Each station's command name, as its skill defines it ("`VERIFY` below means `python3 ...`").
ALIASES = {
    "AUDIT": "skills/audit/scripts/audit.py",
    "BUILD": "skills/build/scripts/build.py",
    "CELL": "skills/intent/scripts/cell.py",
    "CLEANUP": "skills/cleanup/scripts/cleanup.py",
    "MERGE": "skills/merge/scripts/merge.py",
    "REVIEW": "skills/review/scripts/review.py",
    "TICKET": "skills/ticket/scripts/ticket.py",
    "VERIFY": "skills/verify/scripts/verify.py",
}
# The instruction files of every station the belt runs unattended, and the command name each uses.
UNATTENDED = {
    "skills/verify/SKILL.md": "VERIFY",
    "skills/verify/references/evidence-runners.md": None,
    "agents/verifier.md": None,
    "skills/review/SKILL.md": "REVIEW",
    "skills/review/references/reviewer-brief.md": "REVIEW",
    "skills/review/references/architecture.md": None,
    "skills/review/references/security.md": None,
    "skills/review/references/product.md": None,
    "agents/reviewer.md": None,
    "skills/build/SKILL.md": "BUILD",
    "agents/builder.md": None,
    "skills/intent/SKILL.md": "CELL",
    "skills/intent/references/contracts-and-plan.md": "CELL",
    "skills/intent/references/headless.md": "CELL",
    "agents/contract-engineer.md": None,
    "skills/merge/SKILL.md": "MERGE",
    "skills/cleanup/SKILL.md": "CLEANUP",
    "skills/audit/SKILL.md": "AUDIT",
    "skills/ticket/SKILL.md": "TICKET",
}
# The files that must say so: the ones a worker follows as its whole instructions.
CARRIES_THE_RULE = ("skills/verify/SKILL.md", "skills/verify/references/evidence-runners.md", "skills/review/SKILL.md", "skills/review/references/reviewer-brief.md",
                    "skills/build/SKILL.md", "skills/intent/SKILL.md", "skills/intent/references/contracts-and-plan.md", "skills/merge/SKILL.md",
                    "skills/cleanup/SKILL.md", "skills/audit/SKILL.md", "skills/ticket/SKILL.md")
# Sample values for placeholders the scripts' parsers check against a list of choices.
SAMPLES = {"your seat": "security"}


def shell_problem(command: str) -> str:
    """Why Claude Code could not match this command against a `Bash(prefix *)` rule as one plain command, or ''.

    Conservative: anything that makes it more than one plain invocation is refused, as the restricted runs refused it.
    Text in single quotes is literal; in double quotes only `$` and backticks keep a meaning."""
    if "\n" in command or command.rstrip().endswith("\\"):
        return "more than one line"
    quote = ""
    for index, char in enumerate(command):
        if quote == "'":
            quote = "" if char == "'" else quote
            continue
        if char == "'" and not quote:
            quote = "'"
            continue
        if char == '"':
            quote = "" if quote == '"' else '"'
            continue
        if char in "$`":
            return f"a shell expansion ({char})"
        if quote:
            continue
        if char in ";&|":
            return f"a chained command ({char})"
        if char in "<>":
            return "a redirect or heredoc"
        if char in "()":
            return "a subshell or function"
    if quote:
        return "an unclosed quote"
    words = shlex.split(command)
    if not words:
        return "nothing to run"
    if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
        return "a variable assignment"
    if words[0] in ("cd", "pushd", "export", "source", ".", "eval", "exec"):
        return f"'{words[0]}' changes the shell, not a command"
    return ""


def allowed_by(command: str, rules: Sequence[str]) -> bool:
    """Whether a plain command matches a `Bash(prefix *)` rule: the prefix, alone or followed by a space."""
    if shell_problem(command):
        return False
    for rule in rules:
        found = re.fullmatch(r"Bash\((.+) \*\)", rule.strip())
        if found and (command == found.group(1) or command.startswith(found.group(1) + " ")):
            return True
    return False


def prescribed(path: Path) -> Iterator[Tuple[str, str]]:
    """(where, command) for every command an instruction file tells a worker to run."""
    text = path.read_text(encoding="utf-8")
    for block in re.finditer(r"```(\w*)\n(.*?)```", text, re.S):
        if block.group(1) in ("bash", "sh", "shell", "console"):
            for number, line in enumerate(block.group(2).splitlines(), start=1):
                if line.strip() and not line.lstrip().startswith("#"):
                    yield f"code block line {number}", line.strip()
    names = "|".join(ALIASES)
    for span in re.finditer(r"`([^`\n]+)`", text):
        if re.match(rf"({names})( |$)|python3 ", span.group(1)):
            yield "inline", span.group(1)


def expand(command: str, alias: str = "") -> str:
    """The command as a worker runs it: placeholders filled, the station's name replaced by its script, as loaded."""
    command = command.replace("\\|", "|")  # a Markdown table's escaped bar
    command = re.sub(r"<([^<>\n]*)>", lambda m: SAMPLES.get(m.group(1), "X"), command)
    command = command.replace('"${CLAUDE_SKILL_DIR}', '"' + str(ROOT / "skills" / "SKILL"))  # substituted when the skill loads
    for name, script in ALIASES.items():
        if re.match(rf"{name}( |$)", command):
            return f"python3 {ROOT / script}" + command[len(name):]
    return command


def script_args(command: str) -> List[str]:
    words = shlex.split(command)
    return words[2:]


class MatcherTest(unittest.TestCase):
    """The matcher refuses every shape the restricted runs refused, and allows the plain forms."""

    def setUp(self):
        self.rules = policy.default_tools()

    def test_the_refused_shapes_are_refused(self):
        verify_py = ROOT / "skills/verify/scripts/verify.py"
        refused = [
            # D22, run A and B (paths shortened): a heredoc driver, cd then git, an output redirect, shell variables.
            f"cat > /p/.factory/worktrees/T/evidence/driver.py <<'EOF'\nimport sys\nEOF",
            f"python3 - <<'E'\nprint(1)\nE",
            "cd /p/.factory/worktrees/T/repo && git log --oneline -5",
            "cd /p/.factory/worktrees/T; ls -la",
            f"python3 -I /p/evidence/driver.py /p/repo > /p/evidence/consumer-run.log 2>&1",
            f'V="python3 {verify_py}"; $V record T AC-01 --result pass --evidence a.log --note "x"',
            f"B={verify_py}; python3 $B finish T",
            f'r(){{ python3 {verify_py} record T "$1"; }}',
            f"python3 {verify_py} record T AC-01 --result pass --evidence a.log --note one\npython3 {verify_py} record T AC-02",
            f"python3 {verify_py} finish T && python3 {verify_py} status T",
            "git -C /p/.factory/worktrees/T/repo log --oneline",  # does not start with 'git log'
            "git ls-files",
            "cat /p/spec.json",
            "mkdir -p /p/evidence",
            f"python3 {verify_py} status T | head",
            f'python3 {verify_py} record T AC-01 --note "seats $(echo 3)"',
            # M4 known issue 9: the audit worker added an exit-status echo.
            f"python3 {ROOT / 'skills/audit/scripts/audit.py'} run; echo exit=$?",
        ]
        for command in refused:
            self.assertFalse(allowed_by(command, self.rules), command)

    def test_the_plain_forms_are_allowed(self):
        verify_py, review_py = ROOT / "skills/verify/scripts/verify.py", ROOT / "skills/review/scripts/review.py"
        for command in (f"python3 {verify_py} capture T driver.py --out consumer-run.log -- --seats 5",
                        f"python3 {verify_py} record T --from /p/.factory/worktrees/T/verify-records.json",
                        f"python3 {verify_py} record T AC-01 --result pass --evidence a.log --note 'Seats 3 of 5 -> 4 of 5; done & checked (twice).'",
                        f"python3 {review_py} submit T --reviewer security",
                        f"{sys.executable} {verify_py} finish T",
                        "git log --oneline -5", "git status --short"):
            self.assertTrue(allowed_by(command, self.rules), command)
        # Nothing here depends on a broad rule: the consented list has none.
        self.assertFalse([rule for rule in self.rules if rule.strip() in ("Bash", "Bash(*)", "*")])


class InstructionsTest(unittest.TestCase):
    def commands(self) -> List[Tuple[str, str, str, str]]:
        found = []
        for name, alias in UNATTENDED.items():
            path = ROOT / name
            self.assertTrue(path.is_file(), name)
            for where, command in prescribed(path):
                found.append((name, where, command, expand(command, alias or "")))
        return found

    def test_every_prescribed_command_is_one_plain_allowed_command(self):
        rules = policy.default_tools()
        found = self.commands()
        self.assertGreater(len(found), 60)  # the extraction really reads the files
        failures = [f"{name} ({where}): {command!r}: {shell_problem(expanded) or 'not in the allowed tool list'}"
                    for name, where, command, expanded in found if not allowed_by(expanded, rules)]
        self.assertEqual(failures, [])

    def test_verify_and_review_commands_parse_with_their_scripts(self):
        parsers = {"skills/verify/scripts/verify.py": verify.build_parser(), "skills/review/scripts/review.py": review.build_parser()}
        checked = 0
        for name, where, command, expanded in self.commands():
            if where == "inline" and "<ticket" not in command:
                continue  # a reference in prose to a command named in full elsewhere, such as `VERIFY finish`
            for script, parser in parsers.items():
                if expanded.startswith(f"python3 {ROOT / script} "):
                    try:
                        parser.parse_args(script_args(expanded))
                    except SystemExit:
                        self.fail(f"{name} ({where}): {command!r} is not a valid {Path(script).name} command")
                    checked += 1
        self.assertGreaterEqual(checked, 9)

    def test_the_new_forms_are_what_verify_and_review_prescribe(self):
        commands = [command for _, _, command, _ in self.commands()]
        self.assertIn("VERIFY capture <ticket> driver.py --out consumer-run.log", commands)
        self.assertIn("VERIFY record <ticket> --from <records_file>", commands)
        self.assertIn("REVIEW submit <ticket> --reviewer <your seat>", commands)

    def test_each_unattended_instruction_file_says_one_plain_command_per_call(self):
        for name in CARRIES_THE_RULE:
            text = (ROOT / name).read_text(encoding="utf-8")
            self.assertIn("One plain command per call", text, name)
            self.assertIn("never `cd`", text, name)


if __name__ == "__main__":
    unittest.main()
