# M14 part E: MACH reports its own defects (as built)

The product owner's words: "I want MACH to be able to self report defects as its own GitHub Issue", prompted by a
product manager who hit a bug in MACH and wrote it up by hand (which rule failed, in which files, the symptom, a
suggested fix, what was not checked). Design: `M14_DESIGN.md` part E. This document says what was built, each choice
the design left open, and how far it was tested.

Nothing was filed on real GitHub while building or testing this. Every `gh` call in the tests goes to a stand-in program.

## What was built

| File | What |
|------|------|
| `skills/intent/scripts/faults.py` | New. The shared recording helper every entry point loads, and the readers `run.py` uses. |
| `skills/run/scripts/selfreport.py` | New. `run.py report`: the template, the checks, the preview and code, filing with `gh`. |
| `skills/run/scripts/run.py` | `report` command; the offer line in `next` and `status`; the fault check handed to the doctor. |
| `skills/run/scripts/doctor.py` | `main()` takes `extra_checks` and `notes` from its caller and shows them as given. |
| 15 entry points | Two lines each (below). |
| `skills/run/SKILL.md` | `report` in the description and argument hint; the offer line; the section **Reporting a problem in MACH**. |
| `templates/config.json` | `"report": {"enabled": true, "repository": "swiftj/mach-harness"}`. |
| `CLAUDE.md` | Section 5, **Self-reporting**; the `.factory/local/faults/` line in the project layout. |
| `tests/test_faults.py`, `tests/test_self_report.py` | New. |

## Recording: `faults.py`

### The two lines every entry point carries

Between `if __name__ == "__main__":` and `sys.exit(main())`, for a script in `skills/<skill>/scripts/`:

```python
    import contextlib as _c, os as _o, runpy as _r  # MACH records an internal error for /mach report (skills/intent/scripts/faults.py)
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 3)[0], d, "scripts", "faults.py") for d in ("intent", "mach-intent")) if _o.path.isfile(p)))["install"](__file__)
```

`bin/mach` has the same first line and this second line (it lives at `bin/mach` in a checkout or download and at
`.factory/bin/mach` in a project):

```python
    with _c.suppress(Exception): _r.run_path(next(p for p in (_o.path.join(_o.path.abspath(__file__).rsplit(_o.sep, 2)[0], *d, "scripts", "faults.py") for d in (("skills", "intent"), ("..", ".claude", "skills", "mach-intent"))) if _o.path.isfile(p)))["install"](__file__)
```

The line finds `faults.py` in the intent skill beside the script's own skill folder, whichever way MACH is installed
(`intent` in the plugin, `mach-intent` in a project install). If it is missing or fails to load, `suppress` swallows
that and the script runs exactly as before; `SystemExit` is not an `Exception`, so nothing about exiting changes. The
names are underscored so no script's own names are touched, and nothing is imported into a script's namespace that it
uses. A new script passes `tests/test_faults.py` by adding these two lines; the test names any entry point without them.

Wrapped (every file with a `__main__` block): `bin/mach`, `skills/audit/scripts/audit.py`, `skills/build/scripts/build.py`,
`skills/cleanup/scripts/cleanup.py`, `skills/intent/scripts/cell.py`, `skills/intent/scripts/validate_slice.py`,
`skills/merge/scripts/merge.py`, `skills/observe/scripts/observe.py`, `skills/product-studio/scripts/product.py`,
`skills/product-studio/scripts/studio.py`, `skills/review/scripts/review.py`, `skills/run/scripts/doctor.py`,
`skills/run/scripts/run.py`, `skills/ticket/scripts/ticket.py`, `skills/verify/scripts/verify.py`. The modules other
scripts load (`lifecycle.py`, `claim.py`, `scan.py`, `notify.py`, `selfreport.py` and the rest) have no entry point of
their own; a crash in them is recorded by the script that loaded them. Scripts outside `skills/` and `bin/` (the
documentation's proof of concept, `video/`, `web/` fixtures and stand-ins) are not MACH's shipped scripts and are not
wrapped. The scripts other engineers add in M14 (the idea skill, factory evals) are added at merge: the test finds them.

### Choice: a hook on `sys.excepthook`, not a wrapper around `main()`

Wrapping `main()` and re-raising puts the wrapper's own frame in the traceback, so stderr would change. Instead
`install()` puts a hook in front of Python's handler for an uncaught exception. The hook records, then calls the handler
that was there before with the same exception, so the traceback and the exit code are byte for byte what they were
(the test compares a run with the helper against the same script with no helper beside it). The hook only ever sees
exceptions nothing caught.

### What counts as an internal error

An uncaught `Exception` that is not:

- one of MACH's own classes: any class defined in the running script (`__main__`), in a module loaded under a `mach_`
  name, or in a module whose file is one of MACH's scripts. Every exception class MACH defines is a refusal, a gate or a
  deliberate stop (`RunError`, `BuildError`, `Fail`, `Busy`, `TooLarge`, `GhFailed` and the rest), so the rule needs no
  list; a refusal that escaped its `main()` uncaught is still a refusal, not a fault;
- `BrokenPipeError`, or an `argparse` class.

`SystemExit` (every exit code, and argparse's usage errors) and `KeyboardInterrupt` are not `Exception`s and never reach
the record.

### The record

`.factory/local/faults/<id>.json`, where `<id>` is the first 12 hex characters of the fingerprint. The folder is created
with mode 700 and given its own `.gitignore` (`*`), so it stays out of Git even in a project whose ignore file lacks
`.factory/local/`; the file is written with mode 600 through a temporary file and a rename. A link where the folder or
the file belongs is refused. Nothing is written where no `.factory` folder is found (from `--project` when it names a
MACH project, else upward from the working folder, with the same worktree rule as `run.py`).

```json
{"schema": 1, "id": "3be8822c1c75", "fingerprint": "<64 hex>", "first_seen": "...Z", "last_seen": "...Z", "count": 1,
 "mach": {"version": "0.15.0", "install": "plugin"}, "script": "run/scripts/run.py", "command": ["status"],
 "exception": "IsADirectoryError", "message": "[Errno 21] Is a directory: '<path>'", "message_left_out": false,
 "traceback": [{"file": "run/scripts/run.py", "line": 1660, "function": "<module>"}, ...], "frames_outside_mach": 3,
 "platform": {"system": "Darwin", "release": "27.2.0", "machine": "arm64"}, "python": "3.12.1",
 "supervised": false, "reported": null}
```

- **Fingerprint**: SHA-256 of the script's path inside MACH, the exception type, and the innermost MACH frame's file and
  function (no line number, so a fault survives unrelated edits above it). The same fingerprint again adds to `count`
  and `last_seen` and refreshes the version, platform and message; it never makes a second file.
- **Cap**: at most 50 records. Beyond that, reported ones are removed first, then the least recently seen.
- **Version**: the plugin's `.claude-plugin/plugin.json` beside the skills folder, else the project's
  `.factory/.mach-manifest.json` (a script install), validated as a version string; otherwise null.
- **Paths**: a frame is kept only when its file is one of MACH's scripts, as `<skill>/scripts/<file>` with the skill named
  as the plugin names it (`mach-intent` becomes `intent`, `mach` becomes `run`), so the same fault has the same
  fingerprint in either install. `bin/mach` is `bin/mach`. Other frames are counted, not kept. No source line and no
  local variable is read.
- **Command**: the sub-command names typed, and only names that appear as `add_parser("...")` in the script or its own
  scripts folder; the first argument that is not one ends the list. A value can never be recorded, because only MACH's
  own literals can.
- **Message** (`scrub()`), in order: printable one line; every address (`scheme://...`) replaced; every absolute path
  replaced, a path inside MACH kept as its path inside MACH; every known value replaced (each argument and option value,
  every environment value of four characters or more, the user's name, home folder and host name, the project's folder
  and its parts below the home folder, each remote's owner and repository name read from `.git/config` without running
  Git, and the IDs and titles of the project's cells, local tickets and inbox); the ticket station's `redact()` and the
  intent station's secret shapes (`scan.secrets_in_line`), each found value masked; anything shaped like a ticket ID
  (`WORD-123`) or an issue number replaced; then every word that appears neither in the source of MACH's frames' files nor
  in a short list of Python's error vocabulary replaced with `…`. Bounded to 300 characters. If the two redaction helpers
  cannot be loaded, the message is left out (`message_left_out: true`).

  The last step is the one that keeps file contents and spec text out: such text reaches a message only through a value
  MACH read at run time, and its words are not MACH's. A word that MACH's own source happens to contain survives, so a
  message is not proof against a sentence made only of common words; every such sentence in a test is replaced.

## The offer

`run.py next` (its digest), `run.py status` (its digest, so `/mach` with no ticket) and `run.py doctor` add one line,
`faults`, while any record is unreported:

> MACH hit N internal errors on this machine. /mach report shows what would be sent.

The command is written the way the install names it (`/mach report`, or `/mach:run report` as a plugin). It is absent
inside a supervised execution, with `report.enabled: false`, and when the helper cannot be loaded. The skill says it once.

**The doctor's rule is kept whole.** The doctor still never opens `.factory/local/`; its test that spies on every file
read is unchanged and passes. `run.py doctor`, which is how `/mach doctor` runs it, reads the records through
`faults.py` and hands `doctor.main()` a ready check (`faults`, "Internal errors": warn with each unreported fault by id,
exception, script, command and count, or ok) and the offer line, which the doctor prints as given. Run on its own,
`doctor.py` shows neither. Narrowing the rule to name one folder was the alternative; it was not needed.

A reported fault is not offered again. If the same fault recurs after it was reported, its count grows and
`/mach report <id>` offers the comment on the issue it was filed as (if that issue is still open).

## Reporting: `run.py report`

```
run.py report [<fault-id>] ["<what went wrong>"] [--print] [--new]
run.py report --confirm <code>
```

With no argument it takes the most recently seen unreported fault; with neither a fault nor words it refuses with a
plain sentence. A 12-hex first argument is a fault ID; anything else is the person's words.

**The text** is one fixed template (`selfreport.compose`): a hidden marker `<!-- mach:self-report v1 fingerprint=<16 hex> -->`,
"What happened", "Details" (fingerprint, MACH version and install kind, script, command, exception, redacted message,
count and first and last day, whether the last occurrence was in a supervised execution, platform and Python),
"Traceback" (MACH's frames as `file, line N, in function`), "Doctor" (each check's ID and state, nothing else), "In the
reporter's words" when given, and a fixed footer. A report from words alone has no marker, no traceback and a fixed
title. Every value that is not fixed text goes through `inert()` (printable, bounded, backticks replaced, mentions and
issue references broken). The person's words go through the ticket station's `quiet()` (cleaned, redacted, bounded to
2,000 characters, mentions and references broken), then `scrub()` with the project's and machine's known values (not
the vocabulary step: they are the person's words, and they read them before anything is sent), at most 20 lines, quoted.

**Checked**: the finished title and body are masked once more with `redact()` and the secret shapes, then scanned with
`scan.secrets_in_text`; if any shape remains the report is refused.

**Preview** (the default): asks `gh auth status --hostname github.com`; for a fault, searches the repository's open
issues for the 16-hex fingerprint and keeps only an issue whose body carries the exact marker (the body GitHub returns
is only compared, never shown or followed); checks whether `mach:self-report` exists. It writes the pending report
(kind, repository, title, body, label, issue, fault ID, SHA-256 of all of them, a six-hex code, expiry ten minutes
ahead) to `.factory/local/faults/pending-report.json`, private, and prints the title, body, label and code with an
instruction for the skill. Nothing is sent.

**Confirm**: `--confirm <code>` takes the pending report (wrong code: refused, kept; expired: refused, removed; used:
removed), recomputes its SHA-256 and refuses if the text is not what was shown, checks the sign-in again, and runs
exactly one of:

```
gh issue create --repo github.com/<owner>/<name> --title <title> --body-file - [--label mach:self-report]
gh issue comment <n> --repo github.com/<owner>/<name> --body-file -
```

with the body on stdin. The answer must be that repository's issue address, or it is reported as not known to be filed.
The fault is then marked `reported` with the address, the time, `issue` or `comment` and the count at that moment.

**Choices**

- **`--confirm`, not `--yes-after-preview`.** The two-step is the Factory's `enable`: the same flag name, a six-hex code,
  ten minutes. `--confirm` takes nothing else, so the text filed is exactly the stored text.
- **The repository is given with its host** (`--repo github.com/owner/name`), so neither `GH_HOST` nor `GH_REPO` nor the
  project's own remote can send it elsewhere. `report.repository` must match owner/name (the ticket station's rule) and
  may not end in `.git`.
- **The label is never created.** It is added only when `gh label list` shows it exists there. MACH creates labels only
  on the project's own repository, never on someone else's.
- **Duplicates**: an open issue with the marker gets the comment "Seen again on another machine: N times, last <day>.
  MACH <version>, <install>; <platform>, Python <x>." behind its own marker; `--new` previews a new issue instead. A
  report from words alone is never searched for.
- **Without `gh`, signed out, offline, or without access** (the search fails): no code is issued; the answer is
  `can_file: false`, a plain sentence (`why`), and the same title and body `--print` gives, with the address for filing
  by hand. `--print` asks GitHub nothing.
- **The doctor's findings** come from `doctor.diagnose()` at preview time, as IDs and states. It may run the doctor's own
  read-only `gh` calls on the project's repository when its origin is on GitHub; their output is never used here.
- **Refused** inside a supervised execution (any `MACH_EXECUTION_ID`), and with `report.enabled: false`. Never named by a
  station, agent, the belt workflow or the supervisor (held by a test over those files).

## The skill

`skills/run/SKILL.md`, **Reporting a problem in MACH**: run the preview; show the title and body in full; say it goes to a
public repository on GitHub; ask; only on a clear yes run `--confirm` with the code; never add to, edit or re-file the
text; for changes, `--print` and file by hand. The offer line is said once, as printed, and never acted on unasked.

## How far it is tested

`tests/test_faults.py` (14 tests): every entry point carries the two lines; the documented line is the one the scripts
carry; the wrapper finds the helper from every script in this layout and in a project install's; a crash is recorded
and the exit code, stdout and stderr are identical to the same script with no helper; a success, a caught refusal, an
uncaught MACH refusal, `SystemExit(3)`, a usage error, `KeyboardInterrupt` and a broken pipe are not recorded and are
unchanged; a recurrence counts and refreshes; the cap and its order; nothing without `.factory`; a failure to record is
silent; and a crash holding a ticket ID and title, spec text read from a file, a token in the environment and one in a
file, a webhook address, the project's folder, its remote's owner and name, the user's name, home folder and host name
leaves none of them in the record (while Python's own traceback on stderr still shows them, unchanged). A real
internal error in `run.py status` is recorded, offered once by `status` and `doctor`, and not offered when switched off
or inside a supervised execution.

`tests/test_self_report.py` (13 tests), with a stand-in `gh` that logs every call and its stdin: the exact commands of a
preview; `--confirm` files exactly the previewed text once and marks the fault reported, and the code works once; the
label only where it exists, never created; the duplicate path and its comment, and `--new`; `--print`, no `gh`, signed
out, offline and no access each give the text and a sentence and file nothing; a wrong code, a changed pending text and
an expired code file nothing; the supervised refusal, `report.enabled: false`, bad repositories and another repository;
the person's words bounded, redacted and inert with the project's names gone; a text that still carries a secret shape is
refused; only `run.py` loads the report and nothing unattended names it; the skill's section says what it must.

Not tested: real GitHub. Nothing was filed, searched or labelled on a real repository; that `gh` accepts a host-qualified
`--repo` for `issue list`, `label list`, `issue create` and `issue comment` is from `gh`'s documentation, not from a run;
and whether GitHub's search indexes the fingerprint inside the body as the search here assumes is unverified (the
fingerprint is also visible in the body for that reason). If search misses it, the result is a new issue, never a lost
report.

## Not built

- Marking a fault reported after a person filed the `--print` text by hand. It stays offered until reported through MACH.
- Exceptions in threads (`threading.excepthook`) and the exception's cause chain: only the uncaught exception itself.
- Two simultaneous crashes of the same fault can lose one count (no lock on the record).
