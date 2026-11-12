"""The sanitized execution-stream fixtures (tests/fixtures/execution-streams/) must hold nothing private.

They were derived from real `claude -p --output-format stream-json --verbose` runs (M6.1). The raw streams
are never kept in Git; these checks hold that what is kept has no paths, no home folder, nothing that looks
like a credential, and no prose. They also check that the sanitizer keeps the shape a normalizer needs.
"""

import importlib.util
import json
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent / "fixtures" / "execution-streams"
SPEC = importlib.util.spec_from_file_location("stream_sanitize", HERE / "sanitize.py")
sanitize = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sanitize)

MAX_TEXT = 48  # no string in a fixture is longer than this, keys excepted
ABSOLUTE_PATH = re.compile(r"(^|[\s\"'=(:,])(/|~/|[A-Za-z]:\\)[A-Za-z0-9._-]")
HOME = re.compile(r"/Users/|/home/|/private/|/var/folders/|/tmp/|\\Users\\", re.IGNORECASE)
TOKEN_LIKE = re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|sk-ant-|(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12}|xox[abpr]-|Bearer\s|"
                        r"-----BEGIN|[A-Za-z0-9+/_-]{32,}={0,2}")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
REAL_TOOL_ID = re.compile(r"^(toolu|msg|req)_(?!FAKE\d+$)")
CONTENT_KEYS = {"text", "thinking", "content", "result", "prompt", "promptPreview", "resultPreview", "summary", "message",
                "command", "description", "lastToolSummary", "decision_reason", "input", "tool_input", "signature"}


def fixtures():
    return sorted(HERE.glob("*.jsonl"))


def strings(value, key=""):
    """Every (key, string) pair in a record, keys included as strings of their own."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield ("<key>", k)
            yield from strings(v, k)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item, key)
    elif isinstance(value, str):
        yield (key, value)


class FixturesArePrivateTest(unittest.TestCase):
    def setUp(self):
        self.files = fixtures()
        self.assertTrue(self.files, "no fixtures found")

    def records(self, path):
        lines = path.read_text(encoding="utf-8").splitlines()
        self.assertTrue(lines, f"{path.name} is empty")
        return [json.loads(line) for line in lines]

    def test_no_absolute_paths_or_home_folder(self):
        for path in self.files:
            raw = path.read_text(encoding="utf-8")
            self.assertIsNone(HOME.search(raw), f"{path.name} names a home or temporary folder")
            for record in self.records(path):
                for key, text in strings(record):
                    self.assertIsNone(ABSOLUTE_PATH.search(text), f"{path.name}: absolute path in {key!r}: {text[:40]!r}")

    def test_nothing_looks_like_a_credential_or_an_address(self):
        for path in self.files:
            for record in self.records(path):
                for key, text in strings(record):
                    if sanitize.UUID_RE.match(text):
                        continue  # UUIDs are re-mapped fakes (checked below)
                    if key == "<key>" and re.match(r"^[A-Za-z][A-Za-z0-9_]*$", text):
                        continue  # a schema key such as cacheCreationEphemeral5mInputTokens
                    self.assertIsNone(TOKEN_LIKE.search(text), f"{path.name}: token-like text in {key!r}")
                    self.assertIsNone(EMAIL.search(text), f"{path.name}: e-mail address in {key!r}")

    def test_no_long_text_anywhere_and_content_fields_are_placeholders(self):
        for path in self.files:
            for record in self.records(path):
                for key, text in strings(record):
                    if key == "<key>":
                        continue
                    self.assertLessEqual(len(text), MAX_TEXT, f"{path.name}: {key!r} holds {len(text)} characters")
                    if key in CONTENT_KEYS and text and not sanitize.LABEL_RE.match(text):
                        self.assertRegex(text, r"^<(text|path|redacted)>$", f"{path.name}: {key!r} is not a placeholder")

    def test_identifiers_are_fakes(self):
        for path in self.files:
            for record in self.records(path):
                for key, text in strings(record):
                    self.assertIsNone(REAL_TOOL_ID.match(text), f"{path.name}: a real {text.split('_')[0]} id survived")
                    if sanitize.UUID_RE.match(text):
                        self.assertTrue(text.startswith("00000000-0000-4000-8000-"), f"{path.name}: a real UUID survived")


class FixturesKeepTheShapeTest(unittest.TestCase):
    def test_every_fixture_starts_with_init_and_has_a_session(self):
        for path in fixtures():
            records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual((records[0].get("type"), records[0].get("subtype")), ("system", "init"), path.name)
            self.assertTrue(all("session_id" in r for r in records if "_unparsable_line" not in r and "_omitted_records" not in r), path.name)

    def test_tool_results_point_at_tool_uses_in_the_same_fixture(self):
        for path in fixtures():
            uses, results = set(), set()
            for line in path.read_text(encoding="utf-8").splitlines():
                record = json.loads(line)
                for block in ((record.get("message") or {}).get("content") or []) if isinstance(record.get("message"), dict) else []:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        uses.add(block["id"])
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        results.add(block["tool_use_id"])
            self.assertLessEqual(results, uses, path.name)


class SanitizerTest(unittest.TestCase):
    def test_paths_secrets_and_prose_are_replaced_and_ids_kept_consistent(self):
        raw = [
            json.dumps({"type": "system", "subtype": "init", "session_id": "416d53c3-b3dc-4e7b-931f-1c953ffbc683",
                        "cwd": "/Users/someone/project", "tools": ["Bash", "Read"], "claude_code_version": "2.1.322"}),
            json.dumps({"type": "assistant", "session_id": "416d53c3-b3dc-4e7b-931f-1c953ffbc683", "timestamp": "2026-11-12T20:29:39.576Z",
                        "message": {"role": "assistant", "model": "claude-haiku-5-5", "content": [
                            {"type": "tool_use", "id": "toolu_01ABCdef", "name": "Bash",
                             "input": {"command": "curl -H 'Authorization: Bearer sk-ant-abcdefghijklmnop' https://x", "description": "Fetch"}}]}}),
            json.dumps({"type": "user", "session_id": "416d53c3-b3dc-4e7b-931f-1c953ffbc683", "timestamp": "2026-11-12T20:29:40.076Z",
                        "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_01ABCdef", "content": "secret file body"}]}}),
            json.dumps({"type": "system", "subtype": "task_progress", "session_id": "416d53c3-b3dc-4e7b-931f-1c953ffbc683",
                        "description": "Build: LOCAL-007: build", "workflow_progress": [
                            {"type": "workflow_agent", "label": "LOCAL-007: security reviewer", "agentId": "a17a5dd5d915e0678",
                             "startedAt": 1794515379628, "promptPreview": "Review /Users/someone/project", "lastToolSummary": "git -C /x status"}]}),
        ]
        out = sanitize.sanitize(raw)
        text = json.dumps(out)
        for leaked in ("/Users", "sk-ant", "secret file", "someone", "toolu_01ABCdef", "416d53c3", "a17a5dd5d915e0678", "LOCAL-007", "curl"):
            self.assertNotIn(leaked, text)
        use = out[1]["message"]["content"][0]
        self.assertEqual((use["name"], use["input"]["command"], use["input"]["description"]), ("Bash", "<text>", "<text>"))
        self.assertEqual(out[2]["message"]["content"][0]["tool_use_id"], use["id"])  # the relationship survives
        self.assertEqual(out[0]["session_id"], out[3]["session_id"])
        agent = out[3]["workflow_progress"][0]
        self.assertEqual((agent["label"], out[3]["description"]), ("TICKET-1: security reviewer", "Build: TICKET-1: build"))
        self.assertEqual(out[0]["tools"], ["Bash", "Read"])
        self.assertEqual(out[0]["claude_code_version"], "2.1.322")
        # 500 ms between the two message timestamps is kept
        self.assertEqual((out[1]["timestamp"], out[2]["timestamp"]), ("2023-11-14T22:13:20.000Z", "2023-11-14T22:13:20.500Z"))

    def test_deterministic(self):
        raw = [json.dumps({"type": "system", "subtype": "init", "session_id": "416d53c3-b3dc-4e7b-931f-1c953ffbc683"})]
        self.assertEqual(sanitize.sanitize(raw), sanitize.sanitize(raw))


if __name__ == "__main__":
    unittest.main()
