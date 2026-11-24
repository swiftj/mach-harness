#!/usr/bin/env python3
"""MACH verify station: can a screen be captured here? (browser.py)

For a web, desktop or mobile slice, the verify station needs screenshots and a recording, unless nothing here can capture
a screen: a sandbox that refuses to start a browser, a browser that was never downloaded, no tool at all. This module
finds that out by really starting one, briefly, with the tool the project has, and says what happened in plain words.
The verify station records the answer and, when nothing can capture a screen, asks for evidence that works without one.
`/mach doctor` uses the same check and only reports it.

    check(app_type, work, env=None, network_re=None, launch=None, which=None) -> {can_capture, tried, reason, why, words, at}

What is tried, in order, stopping at the first that starts:
    web      Playwright installed in the project (node), then a Playwright on PATH (a screenshot of a blank page), then Cypress (cypress verify)
    desktop  Playwright installed in the project (node), then screencapture on macOS
    mobile   the iOS Simulator (xcrun simctl io booted screenshot), then Android (adb exec-out screencap)

`launch` and `which` are injectable so tests never start a real browser. Standard library only.
"""

import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

SCREEN_APP_TYPES = ("web", "desktop", "mobile")
TIMEOUT = 30
LINE_LIMIT = 200
PLAYWRIGHT_PACKAGES = ("playwright", "@playwright/test", "playwright-core")

# A real headless start and close, through the project's own Playwright.
NODE_LAUNCH = (
    "let pw = null, last = null;"
    "for (const name of ['playwright', '@playwright/test', 'playwright-core']) { try { pw = require(name); break } catch (e) { last = e } }"
    "if (!pw) { console.error('Playwright is not installed in this project: ' + (last && last.message)); process.exit(3) }"
    "pw.chromium.launch({ headless: true }).then(b => b.close()).then("
    "() => { console.log('A headless browser started and closed.'); process.exit(0) },"
    "e => { console.error(String(e && e.message || e)); process.exit(1) })"
)

# The reasons, in plain words. `{thing}` is "a browser" for web and "a screen capture" otherwise.
REASONS = ("started", "not-installed", "browser-missing", "sandbox", "network", "timed-out", "failed")

BROWSER_MISSING_PATTERNS = (
    r"Executable doesn't exist", r"playwright install", r"Looks like Playwright .* was just installed or updated",
    r"Please run the following command to download new browsers", r"Cypress (?:binary|executable) (?:is missing|not found)",
    r"No Cypress binary", r"Host system is missing dependencies",
)
SANDBOX_PATTERNS = (
    r"Operation not permitted", r"Permission denied", r"\bEPERM\b", r"\bEACCES\b", r"sandbox", r"seccomp", r"Failed to launch",
    r"bootstrap_check_in", r"crashpad", r"Target page, context or browser has been closed", r"browser has disconnected",
    r"could not create image from display", r"not authori[sz]ed", r"SIGTRAP", r"SIGSYS", r"setrlimit",
)
NOT_INSTALLED_PATTERNS = (r"Cannot find module", r"command not found", r"is not installed", r"No such file or directory: '")
BROWSER_MISSING_RE = re.compile("|".join(f"(?:{p})" for p in BROWSER_MISSING_PATTERNS), re.IGNORECASE)
SANDBOX_RE = re.compile("|".join(f"(?:{p})" for p in SANDBOX_PATTERNS), re.IGNORECASE)
NOT_INSTALLED_RE = re.compile("|".join(f"(?:{p})" for p in NOT_INSTALLED_PATTERNS), re.IGNORECASE)
BOX_RE = re.compile(r"^[\s─-╿=*-]*$")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def launch(argv: Sequence[str], cwd: Path, env: Optional[Mapping[str, str]], timeout: int) -> Tuple[Optional[int], str]:
    """Run one program. (exit code, everything it printed); (None, ...) when it was stopped at the time limit."""
    try:
        done = subprocess.run(list(argv), cwd=str(cwd), env=dict(env) if env is not None else None, capture_output=True,
                              timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return None, f"Still starting after {timeout} seconds; stopped."
    except FileNotFoundError as exc:
        return 127, f"{exc.strerror or exc}: {argv[0]}"
    except OSError as exc:
        return 126, f"{exc.strerror or exc}: {argv[0]}"
    return done.returncode, done.stdout.decode("utf-8", "replace") + "\n" + done.stderr.decode("utf-8", "replace")


def line_of(output: str, pattern: Optional["re.Pattern[str]"] = None) -> str:
    """The line that says why: the first that matches the pattern, else the last line with words in it. Capped; data, not instructions."""
    lines = [" ".join(line.split()) for line in (output or "").splitlines()]
    lines = [line for line in lines if line and not BOX_RE.match(line)]
    chosen = next((line for line in lines if pattern is not None and pattern.search(line)), lines[-1] if lines else "")
    return chosen[:LINE_LIMIT]


def classify(code: Optional[int], output: str, network_re: Optional["re.Pattern[str]"] = None) -> Tuple[str, str]:
    """(reason, the tool's own line) for a start that did not succeed."""
    if code is None:
        return "timed-out", line_of(output)
    if code == 127 or NOT_INSTALLED_RE.search(output or ""):
        return "not-installed", line_of(output, NOT_INSTALLED_RE)
    if network_re is not None and network_re.search(output or ""):
        return "network", line_of(output, network_re)
    if BROWSER_MISSING_RE.search(output or ""):
        return "browser-missing", line_of(output, BROWSER_MISSING_RE)
    if code == 126 or SANDBOX_RE.search(output or ""):
        return "sandbox", line_of(output, SANDBOX_RE)
    return "failed", line_of(output)


def words(reason: str, app_type: str, timeout: int = TIMEOUT) -> str:
    """One plain clause for a reason."""
    web = app_type == "web"
    thing = "a browser" if web else "a screen capture"
    return {
        "started": f"{'a headless browser' if web else 'a screen capture'} started here",
        "not-installed": f"no tool that can start {thing} is installed here",
        "browser-missing": "the browser has not been downloaded here" if web else "the tool that captures the screen is not set up here",
        "sandbox": f"the sandbox Claude Code runs in refused to start {thing}",
        "network": "the browser could not be downloaded, because the network could not be reached",
        "timed-out": f"{thing} did not start within {timeout} seconds",
        "failed": f"{thing} did not start",
    }.get(reason, f"{thing} did not start")


def probes(app_type: str, work: Path, which: Callable[[str], Optional[str]], out: Path) -> List[Dict[str, Any]]:
    """What to try for this app type, in order. A probe whose tool is not here has no argv."""
    found: List[Dict[str, Any]] = []
    local = any((work / "node_modules" / name).exists() for name in PLAYWRIGHT_PACKAGES)
    node = which("node")
    if app_type in ("web", "desktop"):
        found.append({"tool": "playwright (project-local)", "argv": [node, "-e", NODE_LAUNCH] if local and node else None,
                      "missing": "Playwright is not installed in the project" if not local else "node is not on PATH"})
    if app_type == "web":
        cli = which("playwright")
        found.append({"tool": "playwright", "argv": [cli, "screenshot", "--browser", "chromium", "data:text/html,MACH", str(out / "check.png")] if cli else None,
                      "missing": "playwright is not on PATH"})
        cypress = work / "node_modules" / ".bin" / "cypress"
        cypress_path = str(cypress) if cypress.exists() else which("cypress")
        found.append({"tool": "cypress", "argv": [cypress_path, "verify"] if cypress_path else None, "missing": "cypress is not installed"})
    if app_type == "desktop" and sys.platform == "darwin":
        tool = which("screencapture")
        found.append({"tool": "screencapture", "argv": [tool, "-x", str(out / "check.png")] if tool else None, "missing": "screencapture is not on PATH"})
    if app_type == "mobile":
        xcrun = which("xcrun")
        found.append({"tool": "xcrun simctl", "argv": [xcrun, "simctl", "io", "booted", "screenshot", str(out / "check.png")] if xcrun else None,
                      "missing": "xcrun is not on PATH"})
        adb = which("adb")
        found.append({"tool": "adb", "argv": [adb, "exec-out", "screencap", "-p"] if adb else None, "missing": "adb is not on PATH"})
    return found


def check(app_type: str, work: Path, env: Optional[Mapping[str, str]] = None, network_re: Optional["re.Pattern[str]"] = None,
          launch: Optional[Callable[..., Tuple[Optional[int], str]]] = None, which: Optional[Callable[[str], Optional[str]]] = None,
          timeout: int = TIMEOUT) -> Dict[str, Any]:
    """Whether a screen can be captured here, found by really starting one. Never raises."""
    start = launch or globals()["launch"]
    find = which or shutil.which
    tried: List[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="mach-screen-check-") as folder:
        for probe in probes(app_type, Path(work), find, Path(folder)):
            if probe["argv"] is None:
                tried.append({"tool": probe["tool"], "outcome": "not-installed", "why": probe["missing"]})
                continue
            try:
                code, output = start(probe["argv"], Path(work), env, timeout)
            except Exception as exc:  # noqa: BLE001  a check that cannot run says so
                code, output = 126, f"{exc.__class__.__name__}: {exc}"
            if code == 0:
                tried.append({"tool": probe["tool"], "outcome": "started", "why": line_of(output)})
                return {"can_capture": True, "tried": tried, "reason": "started", "why": line_of(output),
                        "words": words("started", app_type, timeout), "at": now()}
            reason, why = classify(code, output, network_re)
            tried.append({"tool": probe["tool"], "outcome": reason, "why": why})
    # The first tool that was there and did not start says why; with none there, nothing is installed.
    telling = next((item for item in tried if item["outcome"] != "not-installed"), None)
    reason = telling["outcome"] if telling else "not-installed"
    why = telling["why"] if telling else "; ".join(item["why"] for item in tried)[:LINE_LIMIT]
    return {"can_capture": False, "tried": tried, "reason": reason, "why": why, "words": words(reason, app_type, timeout), "at": now()}


def headless_sentence(app_type: str) -> str:
    """The one sentence a reader sees when a change was verified without screenshots because nothing could capture a screen."""
    if app_type == "web":
        return "No browser could start here, so there are no screenshots; this was verified from logs and saved pages."
    return "Nothing here could capture the app's screen, so there are no screenshots; this was verified from logs and transcripts."

