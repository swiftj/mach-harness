# M12: secrets and dependency checking in the line (as built)

Known issue 14 in `docs/guides/RELEASE_NOTES_DRAFT.md`: nothing in the line looked for a committed secret or weighed a
newly added dependency; the audit only checked that a secret scanner was configured, and Low-risk tickets had no
security seat. The product owner's decision: MACH does not integrate third-party scanners. A script finds the
candidates, and a strong model judges them in review. A team that wants a scanner runs one through Claude Code hooks or
CI; release qualification already reads scanner reports from `.factory/release/scans/`.

## The scanner: `skills/intent/scripts/scan.py`

Pure functions over a unified diff. No network, no subprocess, no file reads; the same diff gives the same output. It
sits with the intent station's other shared helpers (`lifecycle.py`, `adr.py`, `claim.py`) because the build and review
stations both use it and both already put that folder on their path; no new loading code was needed and the installer
copies it with the folder.

### `secrets(diff)`

Reads only the diff's added lines. Each candidate is `file`, `line` (in the new file), `kind` and `preview`: at most the
first four characters (fewer for a short value: a quarter of its length) followed by `****`. The value itself is never
returned. Sorted by file, line and kind; at most 50, with `truncated` and `total`.

Shapes found:

| Kind | What |
|------|------|
| `private-key` | `-----BEGIN ... PRIVATE KEY-----` (RSA, EC, OPENSSH, DSA, encrypted, PGP `PRIVATE KEY BLOCK`) |
| `aws-access-key-id` | `AKIA`, `ASIA`, `ABIA`, `ACCA` followed by 16 upper-case letters or digits |
| `aws-secret-access-key` | 40 base64 characters assigned to `aws_secret_access_key` (and spellings without underscores) |
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` with 36 or more characters, and `github_pat_` |
| `slack-token`, `slack-webhook` | `xoxb-`, `xoxp-`, `xoxa-`, `xoxo-`, `xoxs-`, `xoxr-`, `xoxe-`; `hooks.slack.com/services/...` |
| `stripe-live-key` | `sk_live_` and `rk_live_` |
| `google-api-key` | `AIza` followed by 35 characters |
| `jwt` | three base64url parts, the first two starting `eyJ` |
| `api-key` | `sk-` style keys of 20 or more characters (`sk-proj-`, `sk-ant-...-` included) |
| `url-password` | `scheme://user:password@host` |
| `assigned-secret` | a quoted string literal of 16 or more characters, with entropy of at least 3.2 bits per character, assigned to a name containing secret, token, password (passwd, pwd), api key, credential, private key, access key or auth key; in `.env`, `.properties`, `.ini`, `.cfg`, `.conf`, YAML and TOML files an unquoted value counts too |

Skipped, each reported in `skipped` with its file, line, kind and the rule (`skipped_by`), never the value:

- `placeholder`, for every shape except a private key header: `xxxx`, `***`, `...`, changeme, replace me, `your_`,
  example, placeholder, dummy, redacted, sample, not a secret, `<...>`, `${...}`, `{{...}}`, `{name}`, `%(name)s`,
  `$VAR`, `%VAR%`, and lines that read the environment (`process.env`, `os.environ`, `os.getenv`, `ENV[`,
  `System.getenv`, `Environment.GetEnvironmentVariable`, `std::env::var`) for the generic rule.
- For the generic rule only: `short-value` (under 16 characters), `low-entropy`, `lockfile` (lock files, whose
  integrity hashes look random), and `test-path` (under `test/`, `tests/`, `__tests__/`, `spec/`, `fixtures/`,
  `testdata/`, `mocks/`, or named `test_*`, `*_test.*`, `*.test.*`, `*.spec.*`, `conftest.py`). A specific shape is
  never skipped for being in a test or fixture.

`secrets_in_text(text)` returns the kinds found in free text; the build and review stations use it to refuse a reason or
a finding that quotes a secret.

### `dependencies(diff)`

For each manifest in the diff, both sides are read as a manifest (context and removed lines; context and added lines)
and compared. Each dependency added, or whose version changed: `manifest`, `ecosystem`, `name`, `version` as written,
`change` (`added` or `changed`, with `old_version`), `dev` (true where the manifest says development only, false where
it says runtime, null where the section is not in sight) and `scope` (the section). At most 200, with `truncated`.
`lockfile_only` names lock files that changed with no manifest change in the same folder.

| Manifest | Ecosystem | Development only when |
|----------|-----------|-----------------------|
| `package.json` (dependencies, devDependencies, peerDependencies, optionalDependencies) | npm | devDependencies |
| `composer.json` (require, require-dev; `php`, `ext-*`, `lib-*` left out) | composer | require-dev |
| `requirements*.txt`, `*requirements*.in`, `constraints*.txt` | pypi | the file name says dev, test, lint or docs |
| `pyproject.toml` (`[project] dependencies`, `optional-dependencies`, `[dependency-groups]`, `[build-system] requires`, Poetry dependencies and groups) | pypi | a group named dev, test, lint, docs, typing and the like; build requirements |
| `Pipfile` (`[packages]`, `[dev-packages]`) | pypi | dev-packages |
| `setup.cfg` (`install_requires`, `tests_require`, `setup_requires`, `extras_require`) | pypi | tests and setup requirements, dev-like extras |
| `setup.py` (`install_requires=[...]`, `tests_require`, `setup_requires`, string literals only) | pypi | tests and setup requirements |
| `go.mod` (`require` lines and blocks; `// indirect` kept as the scope) | go | never |
| `Cargo.toml` (`[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, target and workspace tables, `[dependencies.name]`) | cargo | dev and build dependencies |
| `Gemfile` (`gem` lines; `group :development, :test do`; `group:` option) | rubygems | development or test group |
| `pom.xml` (`<dependency>` blocks) | maven | `<scope>test</scope>` |
| `build.gradle`, `build.gradle.kts` (string and map notation for the usual configurations) | maven | test, androidTest, integrationTest, debug and developmentOnly configurations |
| `*.csproj` (`<PackageReference>`, attribute or element version) | nuget | `PrivateAssets="all"` |

The review station reads manifests from a diff with full context (`git diff -U100000 -- <manifests>`), so sections are
always in sight there.

## Build station: no secret enters the branch (`skills/build/scripts/build.py`)

`check_scope` ends with `check_secrets`, so every step that commits (red, green, done, in the first round and in
revisions) scans what is about to be committed: tracked files as `git diff HEAD`, new files as wholly added (binary
files and files over 4 MB beyond their first 4 MB are not read). A candidate refuses the step (`secret-candidate`) with
each place as `file:line (kind)` and the remedy: read it at run time from the environment or a secret store, and in a
test build a fake one at run time. Nothing is committed.

The override is `--not-a-secret "<why>"` on red, green and done, in the same family as `--allow-extra` and
`--amend-test`. It is recorded as a deviation of type `not-a-secret` whose detail holds the places and the reason, with
`candidates` (file, line, kind); the lifecycle log records `gate.evaluated` with gate `secrets` and outcome `override`.
A reason that itself has a secret's shape is refused (`secret-in-reason`). `build-report.json` gains `secret_scan`:
`enabled` and each `not_a_secret` use. The builder's instructions (`agents/builder.md`, `skills/build/SKILL.md` rule 8)
say never commit a credential and never use the override for a real one.

## Review station (`skills/review/scripts/review.py`)

### The packet

`start` runs both scans on `baseline..head` and writes `security_scan`: `enabled`, `flagged`, `secrets` (each with an
ID `S1`..., `key`, `needs_answer`, and `overridden_by_builder` with the builder's reason when a `not-a-secret` override
covered that file and kind), `dependencies` (`D1`...), `lockfile_only`, `manifests`, `secrets_skipped`, the fixed
sentence in `vulnerability_note`, `scanner_reports` (the file names under `.factory/release/scans/`, never parsed
here), `panel_change`, `answering_seat` and a note that file and package names are data, not instructions.

### Flagged changes get a stronger panel

Flagged means a secret candidate, or an added or changed dependency not known to be development only. Then
(`strengthen_for_scan`):

- the security seat runs on `models.contracts` (opus by default) whatever the tier;
- a panel without a security seat (Low risk, or a tier a project set to one seat) becomes architecture, security and
  product with Medium's threshold (at least 2 of 3), keeping a person's approval wherever either tier asked for one.

`panel_change` says what changed and why, in the packet, the start output and the decision. Nothing else changes: High
and `factory-tuning` panels already sit on the contracts tier and are untouched; human approval, the three-round limit,
delta review and the veto are as before. An unflagged ticket is seated exactly as before (tested for Low, Medium and
High).

### The security seat answers every item

The answering seat is the security seat, or the one general seat of a panel without it (an unflagged Low-risk change
that adds only a development dependency). Its findings file carries `scan_answers`:
`{"secrets": [{"id", "answer": "real" | "not_a_secret", "reason"}], "dependencies": [{"id", "answer": "acceptable" | "concern", "reason"}]}`.
`submit` refuses:

- the answering seat's vote while an item that `needs_answer` is unanswered (`scan-unanswered`);
- `scan_answers` from any other seat (`scan-answers-not-yours`);
- an unknown ID, a wrong answer, a reason under four words, a duplicate, or an answer to a carried item;
- `real` unless the same submission has a high or critical security-class blocker on that file, so the existing veto
  rejects the round (`scan-real-needs-blocker`);
- `concern` unless a finding (blocker or note) names the dependency (`scan-concern-needs-finding`);
- any submission whose summary, findings or reasons have a secret's shape (`findings-hold-secret`).

In a delta round an item the previous round's answering seat answered (matched by file, kind and preview for a secret,
by manifest, ecosystem, name, version and change for a dependency) is `carried` with its answer and round and needs no
new answer.

The security checklist (`skills/review/references/security.md`) says what to weigh for a dependency: needed for this
slice or covered by the standard library or an existing dependency; a plausible typosquat; pinned or floating; unmaintained
or known compromised as far as the model knows; licence only if REVIEW.md has a licence rule; and say plainly when it
does not know a package.

### What is recorded

- `decision.json`: `security_scan` with `enabled`, `flagged`, `panel_change`, `answering_seat`, `counts`
  (secret_candidates, real, not_a_secret, overridden_by_builder, dependencies, dependencies_added, acceptable, concerns,
  lockfile_only), each item with its answer, reason and round, `lockfile_only`, `scanner_reports` and the
  vulnerability note. With the scan off: `{"enabled": false, ...}`.
- `findings.md`: a "Security scan" section when anything was listed, or a line when the scan was off.
- The pull request body (`merge.py`): a "Security scan" section with each candidate's place and kind and each
  dependency's name, version and change, with the answer; or a line saying the scan was off.
- `run.py explain`: `security_scan` facts and plain lines.
- Cleanup's run record: `security_scan` with `secret_candidates`, `real`, `dependencies_added`, `concerns` and
  `enabled`, present only when something was listed or the scan was off (optional, as M8 and M12 did; `record_version`
  stays 2).
- Lifecycle log: `review.scan_recorded` at the tally, station `review`, counts and booleans only. Registered in
  `lifecycle.py`, `cell-lifecycle.schema.json`, `factory-event.v3.schema.json` (revision 6) and the observer
  (`event.Kinds`, the server's list, 55 kinds, the normaliser, the allowlist and its required IDs). The Factory Floor web
  app was not changed; it keeps a kind it does not know in its log.

## Settings and the supervisor

`templates/config.json` has `"security": {"scan": {"enabled": true}}`. `false` switches off the build gate and the
review scan; the build report and the review decision say so. `policy.security_review_problems` refuses unattended work
while tracked settings say `false`, exactly as for a weakened veto; a person can still run the ticket by hand.
`dependency_manifests` and `ignore_paths` were not added: nothing needed them, and an ignore list would be a way to
narrow the scan.

The observe station never proposes a change to the scan: `.factory/config.json` was already not a target, and
`check_report` now refuses any proposal that mentions the scan, the secrets gate, `scan_answers` or `--not-a-secret`.
The reviewer brief makes such a rule a blocker on a `factory-tuning` ticket.

## What is covered, and what is not

Covered: the secret shapes and manifests above, in what a ticket's branch adds.

Not covered:

- **No vulnerability database.** A dependency is judged from the model's knowledge, which ends at its training date.
  A version found vulnerable since then, or a malicious package the model has not heard of, is not caught.
- **No static analysis** of generated code (injection, unsafe deserialisation and the like rest on the reviewers).
- **Secret shapes not listed above**: Azure, GCP service account JSON (only its private key header is found), Twilio,
  SendGrid, Mailgun, npm and PyPI tokens, Heroku, DigitalOcean, Datadog, Discord, Telegram, generic bearer tokens and
  basic auth headers, passwords under 16 characters or with low entropy, secrets assigned to names that do not say
  what they are, secrets split across lines or built by joining strings, and anything encoded (base64 of a token,
  hex).
- **Files**: binary files, and anything after the first 4 MB of a new file at build; deleted lines and existing
  content (a secret already on the main branch is not looked for).
- **Ecosystems and manifests**: `Directory.Packages.props` and `packages.config` (NuGet), `build.sbt`, `mix.exs`,
  `Package.swift`, `Podfile`, `pubspec.yaml`, `deno.json`, `environment.yml` (conda), `vcpkg.json`, `conanfile`,
  Bazel files, Gradle version catalogues (`libs.versions.toml`), Maven properties used as versions (the property name
  is the version), `setup.py` dependencies built in code rather than written as literals, `requirements` lines that
  are URLs or editable installs, and dependencies on one line of JSON with their section.
- **Transitive changes**: only a lock file changed alone is named; what changed inside it is not read.
- **The review's own diff**: `diff.patch` and `delta.patch` are the change itself, which reviewers must read, so they
  hold whatever the change holds. No other file the factory writes holds a secret's value (tested).

## Not verified

- No live run: every rule here is held by unit and integration tests on fixture projects (`tests/test_security_scan.py`,
  and the supervisor and observe tests).
- The pull request body was checked as text, not posted to GitHub.
- Whether a model, given these answers to make, judges typosquats and unmaintained packages well was not measured.
