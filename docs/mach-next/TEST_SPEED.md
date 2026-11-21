# Test speed: what was measured, what changed, and running what a change affects

MACH's Python suite is about 1,830 tests in about 418 classes. Most are integration tests: each
builds real Git repositories in a temporary folder and runs MACH's real scripts against them.
`make test` runs one process per class, eight at a time. This note says where the time went, what
was changed to cut it without changing what any test asserts, what was left alone and why, and how
`make test-changed` picks the classes a change can affect.

## How noisy the measurements were

Badly. The machine was shared with another engineer's work for the whole time, and its load
average swung between about 3 and more than 300. The first measurement ran under very heavy load
and took 1,335 seconds; a later run of the same, unchanged tree took 790 seconds, and a third 630.
So read the absolute seconds below as rough, and trust the ratios between classes, and the
before-and-after pairs taken close together, more. Every figure was taken at least twice.

## Where the time went (before)

Two runs of the unchanged tree (feature/m16 at 6ab7bee), eight at a time:

| Run | Wall time | Test-seconds (sum of class times) | Load average at start, end |
|---|---|---|---|
| Before 1 | 790 s | 6,172 | 3.6, 61 |
| Before 2 | 630 s | 4,967 | 28, 23 |

The time is spread wide. The slowest 10 classes were 20 to 23% of the test-seconds, the slowest 20
were 31 to 35%, and the slowest 40 were 48 to 51%; it takes about 80 classes to reach 70%. The
slowest were the Factory supervisor's classes (`test_mach_factory_supervisor`, the supervisor half
of `test_mach_notify`, `test_mach_monitoring`, `test_mach_provenance`), product intake and pull
(`test_mach_product_intake`, `test_mach_pull`, `test_epic_view`, `test_mach_product_issues`,
`test_mach_product_order`), the review and security exception classes, release qualification, the
merge station's pull request classes, and the Product Studio host's conformance test.

What the time was spent on, found by timing setUp and each test's helper methods and by counting
the subprocesses each class starts (not by guessing):

- **The build-to-review chain** (`test_review`, `test_security_exception`, `test_security_scan`,
  `test_merge`, `test_merge_overlap`, `test_run`, `test_verify`, `test_lifecycle`, `test_explain`,
  `test_change_record`, `test_review_noise`, `test_adr`'s review classes and more): nearly every test
  began by calling `built()` or `verified()`, which grooms a ticket, builds five tasks (each running a
  test suite in a subprocess), and verifies it. In `test_review.TallyTest` that preparation was most
  of every test. It is the same preparation, from the same starting project, every time.
- **The product classes** (everything built on `test_mach_product_issues.Base`: issues, intake, pull,
  supervisor, release qualification, epic view, Shape): setUp makes a bare remote and three clones,
  a stand-in for gh, then the Factory's settings, a few commits and pushes: about 8 to 16% of each
  class. The rest is the test body: `slice ready` against the stand-in for gh, `product intake`,
  `pull`, the supervisor's `tick`. In the supervisor classes `tick` alone was 56% of the time, and
  each tick starts executions and runs MACH's intake, which calls Git hundreds of times
  (`git rev-parse` was called 1,147 times by one class of nine tests).
- **Release qualification**: `built()` (a slice taken in, dispatched, merged and archived) was 64%
  of `OutcomeTest`.

## What was changed, and why it is safe

One small shared helper, `tests/class_template.py`, does two things:

1. **`folder(test)`** in place of `tempfile.TemporaryDirectory()` in the two bases every one of these
   classes builds on (`test_build.Base` and `test_mach_product_issues.Base`). It gives the first
   temporary folder of every test of a class the same path: fresh and empty each time, removed by the
   test's cleanup. A test that makes a second folder (one calls setUp again inside a test) gets the
   next numbered path.
2. **`step(test, key, root, run)`** around a preparatory step that changes only files under the test's
   folder. Before the step runs, everything under the folder is fingerprinted: every folder, file
   name, permission bits, symbolic link and byte. The first time a class runs a step from a given
   folder, what it changed (files written, files and folders removed) and the value it returned are
   kept. A later test of the same class that reaches the same step, with the same key (the key
   carries the step's arguments and any in-memory state it reads, such as the slices in hand), from a
   folder with exactly the same fingerprint at exactly the same path, has those changes applied and
   gets the same value, instead of running the step again. Anything else runs the step for real.

Because the path is the same, every absolute path a step wrote (Git's remotes and worktree links,
JSON records, stand-in scripts, test logs whose SHA-256 is recorded in a verification summary) is as
true for the next test as for the first; nothing is rewritten. The fingerprint leaves out only what
differs between two identical folders made a moment apart: compiled Python caches, the stat fields
of a Git index (times, device, inode, size; the staged object ids stay in), and the clock time on
each reflog line. After the changes are applied, the index of each Git checkout they touched is
refreshed with `git update-index -q --refresh`, because a written file has a new inode and change
time and plumbing such as `git diff-index` would otherwise report it changed. A step reached from
more than three different folders in one class is not kept (it just runs), so a step that rarely
repeats costs little.

Why this keeps every test what it was:

- No assertion, test method or test name changed (`git diff` shows no added or removed line containing
  an assertion). The bodies of the preparatory helpers moved, unchanged, into a function the step
  runs; assertions inside them run whenever the step runs, which is at least once per class.
- Each test still starts from an identical, isolated folder of its own and may change it freely: the
  state a later test gets is byte for byte what the step left when it really ran from the same state.
- A step's value is plain data, checked to survive JSON unchanged; one that does not is refused.
- What is kept belongs to the test's own class (a subclass that builds differently keeps its own) and
  is removed when the class finishes. Nothing is shared between processes or classes, and nothing is
  read or written outside the class's own temporary folders.
- A class run alone, in reverse order, or in parallel with others behaves the same: the first test
  that reaches a step in a process runs it for real.

The steps, by base and helper:

| Where | Step | What it covers |
|---|---|---|
| `test_build.Base.setUp` | `project` | the sample project, committed |
| `test_review.Base.built`, `.verified` | `built`, `verified` | groom, build five tasks, finish; verify |
| `test_verify.Base.built`, `test_run.Base.verified` | `built`, `verified` | the same for the verify and run classes |
| `test_security_scan.ScanReviewBase.built` | `built` | its own build with extra files |
| `test_merge.PullRequestBase.setUp` | `origin` | the shared remote and the stand-in for gh |
| `test_mach_product_issues.Base.setUp` | `repositories` | the bare remote and three clones |
| `test_mach_product_issues.IssuesBase.setUp` | `issues` | the stand-in for gh and the GitHub remote |
| `test_mach_product_intake.Base.setUp`, `.first` | `factory`, `first` | the Factory's settings; SLICE-001 published |
| `test_mach_factory_supervisor.Base.setUp`, `.enable` | `supervisor`, `enable` | the stand-ins for Claude Code and launchctl; enabling |
| `test_release_qualify.Base.setUp`, `.built` | `suite`, `built` | a test suite on main; a slice built and merged |

How each changed class was proven sound: the 214 classes whose bases changed were run with their tests
in reverse order (one process per class), and every one of their tests was run alone in its own
process; the whole suite was run three times. Results: reversed order, 214 classes, none failed; each test
alone, 863 processes, none failed; every whole-suite run passed, with the same count of tests as
before plus the selector's own eleven (1,821 before, 1,832 after).

## Before and after

Whole suite, eight at a time. "After" includes the selector's own new test class (45 to 63
test-seconds).

| Run | Wall time | Test-seconds | Load average at start, end |
|---|---|---|---|
| Before 1 | 790 s | 6,172 | 3.6, 61 |
| Before 2 | 630 s | 4,967 | 28, 23 |
| After 1 | 540 s | 4,289 | 7.4, 34 |
| After 2 (final) | 564 s | 4,488 | 160, 208 |

The final run carried a load average of 160 to 208 against 23 to 61 for the before runs, and still
took less time. Overall that is roughly 10 to 30% less, depending on which runs are set against each
other; the load was never steady enough to say more exactly. The gain is concentrated where the preparation was
the same every time. Classes, before (the two runs) and after:

| Class | Before | After |
|---|---|---|
| `test_review.TallyTest` | 96, 45 s | 13 s |
| `test_review.SubmitTest` | 87, 40 s | 12 s |
| `test_security_exception.WhatMayBeExceptedTest` | 66, 38 s | 12 s |
| `test_merge.FindingsTest` | 96, 58 s | 28 s |
| `test_release_qualify.OutcomeTest` | 111, 61 s | 29 s |
| `test_release_qualify.ContractTest` | 86, 46 s | 36 s |
| `test_verify.FinishTest` | 33, 20 s | 8 s |

By module, the test-seconds after against the mean of the two before runs: `test_review` 0.31,
`test_security_exception` 0.31, `test_merge` 0.39, `test_verify` 0.44, `test_release_qualify` 0.54,
`test_change_record` 0.57, `test_security_scan` 0.64, `test_mach_monitoring` 0.70, `test_jira` 0.73,
`test_mach_product_intake` 0.78; the supervisor, pull, issues, order and epic view modules 0.9 to
1.0 (their time is in the calls under test, below). Small classes moved by a second either way
with the load. A pairwise measurement (each class run before, after, after, before in turn, so that
drifting load hits both alike) was taken of an earlier version of the helper, which copied the whole
folder at every step: the review chain came out at about a quarter of its time and release
qualification at about two thirds, but the supervisor classes came out 8 to 21% slower, because five
whole-folder copies per setUp cost as much as the setUp they replaced. That is why the helper now
applies only what each step changed.

## What was left alone, and why

- **The supervisor's `tick`, intake's `product intake` and `reconcile`, `pull`, Product Studio's `slice
  ready`, and epic view's `ship`.** They are most of the remaining time, but each is what at least one
  test of its class checks. Caching the call that is under test, even from an identical folder, means
  most tests stop exercising it; I kept them running for real. Where they are only preparation (the
  first `ship` or `pull` of a test whose checks are about a later one), a `step` around them would cut
  those classes by roughly a half; that is a choice for the team, not one to make quietly.
- **The Git calls inside MACH's own scripts.** A supervisor pass runs `git rev-parse`, `merge-base`
  and `symbolic-ref` hundreds of times with the same answers. Caching them within one pass would make
  both the Factory and its tests faster, but it is a change to the product, not to the tests.
- **`test_mach_product_host`, `test_mach_shape*`, `test_mach_product_studio` and
  `test_mach_product_isolation`** were not edited (another engineer's area). The Shape classes build on
  `IssuesBase` and `IntakeBase`, so they get the faster setUp without any change to their files.
- **Classes that cost a second or two.** Not worth touching.

## What would speed things up further

- Cache the first `pull`, `ship` or `slice ready` where it is only preparation (above).
- Cache Git answers within one MACH command or supervisor pass (product change).
- Start the slowest classes first: the runner starts classes in discovery order, so the last few long
  ones can leave cores idle at the end. With timings from a previous run kept in a git-ignored file,
  the runner could order by them. The gain is the tail only (the runs above were close to
  test-seconds divided by eight).
- Give the supervisor tests' stand-in executions a shorter poll: `wait()` checks every 0.1 s, and the
  supervisor's own loop has its own waits. Each would need its condition proven first.

## Running what a change affects: `make test-changed`

`tests/affected.py` (standard library only) works out which classes a change can affect, prints them
with `--list` (and one line of why each with `--why`), and otherwise runs them through the same runner
as `make test`. With no arguments it takes this branch's changes against its merge base with `main`,
plus uncommitted and untracked files; or the paths given.

The map is read from the code, not kept by hand. Every Python file in the repository is parsed:

- what it imports, by name, from the folders it puts on `sys.path`, its own folder or tests/;
- every repository path it names: a path expression rooted at its own `__file__`
  (`ROOT / "skills" / "run" / "scripts" / "run.py"`, `.parent`, `.parents[n]`, `os.path.join`,
  `joinpath`), with names bound only to text and loop variables over lists of text followed through;
  a folder named that way, or walked, counts as every file under it, and a path with a part that
  cannot be worked out counts as everything under the part that can;
- a file name in a string: a script's name (`"cell.py"`, loaded by path from a folder worked out at
  run time), or a file name only one repository file has; and a string that is a repository path.

That is followed through the scripts' own imports and by-path loads. A name found inside a test class
counts for that class and its subclasses (bases are followed through imports from other test
modules); a name found elsewhere in a test module counts for every class in it; importing another test
module by name reads its module-level code and the classes named, and importing it whole reads all of
it. The table for what code cannot show is empty: nothing the check below found needed it.

It fails safe, and says so in one line:

- a change to `tests/in_parallel.py`, `tests/affected.py`, the Makefile, a shared test helper (any
  `tests/*.py` that is not a test module) or `skills/ticket/scripts/issue_rules.py` runs everything;
- so does a Python file that more than 60% of classes reach;
- so does a changed file nothing names, unless it sits in docs/, video/, web/, apps/ or .github/,
  where a file no Python test names is read by no Python test: those select nothing, and it says
  "No test reads ...".

What it shows about this repository, plainly: MACH's scripts are tightly connected. run.py loads most
stations, and most test classes drive run.py, so a change to nearly any station script still runs
everything (cell.py, build.py, run.py, review.py and the like reach 300 to 390 of 418 classes). The
selector narrows well for changes to tests, fixtures, documents, the installer and a few scripts that
little loads (idea.py: 43 classes; studio.py: 212).

### The ten-commit check

For ten real commits touching different areas, the files each changed (those that still exist) were
broken in a scratch copy of the current tree: a syntax error appended to Python files, invalid JSON
for JSON files, the text replaced for anything else. Then every class the selector did not choose was
run there, each in its own process; any of them failing would be a miss (classes it did choose may
fail or not; that does not bear on the check). A commit whose selection is every class cannot miss and
was not run.

| Commit | What it changed (files that still exist) | Selected (of 418) | Run outside the selection | Failed outside it |
|---|---|---|---|---|
| af980c8 | a design note (`docs/mach-next/M16_DESIGN.md`) | 0: "No test reads" it | 418 | none |
| 123ad56 | `tests/test_mach_monitoring.py` | 5 | 413 | none from the change (see below) |
| 3813948 | `tests/test_mach_loose_ends.py` | 6 | 412 | none |
| 0399d50 | `install.sh`, `tests/test_installer.py` | 14 | 404 | none from the change (see below) |
| cab5c41 | Product Studio's `SKILL.md` and `references/shape.md` | 41, then 47 | 377, then 371 | one, then none: fixed (see below) |
| bdd3131 | `skills/idea/scripts/idea.py` | 43 | 375 | none |
| 4c515fe | `skills/product-studio/scripts/studio.py` and a web file | 212 | 206 | none |
| 24a6280 | the intent and run skills' `SKILL.md` | 383 | 35 | none |
| 29eab2b | `CLAUDE.md`, two design notes, the event schema, 20 web files | 411 | 7 | none |
| fdcbc9e | `skills/run/scripts/doctor.py`, `tests/test_doctor.py` | every class (doctor.py is reached by 335) | 0 | cannot miss |

What the check found, and what was done:

- **A miss, fixed.** With Product Studio's `SKILL.md` broken, `test_mach_policy_packs.InstructionsTest`
  failed outside the selection. It reads through a helper, `read = lambda *parts:
  (ROOT.joinpath(*parts)).read_text()`, called as `read("skills", "product-studio", "SKILL.md")` and,
  in a loop, as `read(*path)`. The selector now follows such a helper to its calls, both forms, and
  counts the helper as reading everything when it is used any other way. Rerun after the fix:
  47 selected, 371 run outside, none failed. A test of the selector now holds this case.
- **Not misses.** `test_mach_product_host.HostConformanceTest` failed in three of the runs, never in the
  same way as a break would: two commit ids, made a moment apart through the Studio host and through
  the terminal, differ (`draft/product/ideas/IDEA-001.lookups.json differs between the host and the
  terminal`). It reads none of the broken files, it failed the same way in an unbroken "before" tree
  during the pairwise measurement, and it passed in the other runs: it is timing-dependent under heavy
  load. It belongs to the area another engineer is changing, so it was reported, not edited.

## Commands

- `make test`: the whole suite; run it before a merge.
- `make test-changed`: what this branch's changes can affect.
- `python3 tests/affected.py --list --why [PATH...]`: which classes, and why, without running them.
