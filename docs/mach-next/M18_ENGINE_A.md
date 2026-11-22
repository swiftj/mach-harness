# M18 parts A, B and C (Product Studio), as built: what counts as small, the short interview, starting one in Studio

Built 2026-11-22 against `M18_DESIGN.md` parts A, B and the Product Studio half of part C. The intent station's own use (`cell.py`), Shape's fourth route, telemetry, the change record and the app are not built here.

## What was built

| File | What |
|---|---|
| `skills/intent/scripts/small.py` | New. The one module that decides size: `settings`, `judge` (the first seven rules), `judge_plan` (the eighth), the fixed sentences, and the `widened` records. Loaded by Product Studio; to be loaded by `cell.py`. |
| `skills/intent/references/small-change.md` | New. The short interview, written for the model that runs it. |
| `skills/product-studio/scripts/small_change.py` | New. Studio's half: the start flags, the check and ready hooks, `slice widen`, the status, check and resume fields. |
| `skills/product-studio/scripts/studio.py` | Wiring only: `slice new` and `request pick` take `--small --change fix|adjustment [--rule]`; `check_slice` adds `small_change`; `slice check` and `approval_problems` call `widen_if_needed`; `status` rows, `slice resume` and `slice ready` carry the field; `slice widen` added. |
| `skills/product-studio/scripts/product.py` | The structural validator allows `kind`, `small` and `widened` on a slice work order and checks their form. |
| `skills/product-studio/SKILL.md` | How to start a small change, when to read `small-change.md`, what to do when it widens; `slice widen --why` joins the PM's acts. |
| `templates/config.json` | `intent.small_change` with the defaults. |
| `tests/test_small_change.py` | New, 35 tests. |

`cell.py` is not touched.

## The rules and how each is read

A change is small only when every rule holds. The rules are checked in this order and the first that fails decides; `failed` lists every one that failed. Missing data is never evidence: a spec with no Summary yet, a why with no tier, an empty permissions line, are not "not small".

| Code | Part A row | Read from | The exact mapping |
|---|---|---|---|
| `actor` | One actor | model `summary.actor` | `validate_slice.MULTI_ACTOR_RE` on the actor with parentheses removed (`PARENTHETICAL_RE`): "and", "or", "/", "&" or a comma names more than one. The validator only warns on this (`single-actor`); here it decides. |
| `capability` | One capability (one epic) | the caller's `epics` | More than one distinct epic. Studio passes the slice's one `epic_id`; a ticket with no epic is judged on the rest. "Capability" is read as the epic, as the design's table says. |
| `requirements` | At most three FRs | model `functional_requirements` | Count above `requirements`. Invariants are not counted. |
| `scenarios` | At most four scenarios | model `scenarios` | Count above `scenarios`. |
| `matrix` | One decision matrix | the spec text | More than one table under `### Decision matrix`, counted as the validator counts blocks (the model keeps only the first). |
| `changed-rules` | At most one changed or replaced | model `effects` | Rows with effect `changed` or `replaced` above `changed_shipped_rules`. `kept` rows are not counted. |
| `retired-rule` | None retired | model `effects` | Any row `retired`. |
| `principle-exception` | No principle `Exception` | model `principles` | Any row with answer `exception`. |
| `policy-concern` | No policy concern, open or accepted | model `policies` | Any pack answered `Concerns`, or any concern listed, whatever its resolution (`open`, `accepted`, `spec changed`). Strictest: a pack line that still says Concerns records a concern. |
| `permission` | No new permission | model `required_permissions` | The value does not begin with the word "None" (case-insensitive). A script cannot tell an existing role from a new one, so any named permission counts. "None." followed by a reason is still none. |
| `unshipped-dependency` | No dependency on a slice not shipped | the work order's `dependencies`, and model `external_dependencies` | Any slice the work order depends on, or any `SLICE-NNN` named in an external dependency's name, that is not among the shipped slices (the slice IDs of the shipped rules on the PM's copy of main). Unknown reads as not shipped. An external service that is not a slice is not counted, as the design's row says. |
| `risk` | Risk Low or Medium | the caller's `risks` | Any tier given is `High`. Studio passes the why's tier; the cell will pass intent.md's and its risk floor. |
| `questions` | (Part B) at most five questions | the interview | No script can count the interview's questions. The sentence exists so `slice widen --by-rule questions` and the interview use the same words. |
| `contract` | Plan: no existing contract changed | `judge_plan(changed_contracts=...)` | Any. The caller passes the plan's contracts that already exist on the main checkout (check-plan already works this out). |
| `high-risk-file` | Plan: no file in a high-risk area | `judge_plan(files=...)` | Any file (and any changed contract) that `scans.py` `risk_for` rates High, loaded by path from the ticket station as Shape does. |
| `adr` | Plan: no ADR proposed | `judge_plan(proposed_adrs=...)` | Any. |

### The sentences

Every rule has one sentence, `"This is not a small change: a small change ..., and this one ..."`, with the limit filled in from the settings, for example "This is not a small change: a small change has at most 3 functional requirements, and this one has more." A small change reads "This is a small change: every rule for a small change holds." `small.SENTENCES` holds them; `small.sentence(rule, limits)` gives one.

## Settings

`intent.small_change` in `.factory/config.json`, read the way `verify.neighbours` is (`skills/verify/scripts/neighbours.py` `setting`): a missing key is its default; a value that is not a whole number in range reads as its default with a note, so a typo never loosens a rule.

| Key | Default | Range |
|---|---|---|
| `requirements` | 3 | 1 to 10 |
| `scenarios` | 4 | 1 to 10 |
| `questions` | 5 | 1 to 10 |
| `changed_shipped_rules` | 1 | 0 to 1 (decision 3: at most one; it can be lowered, never raised) |

Studio reads them through `cell.load_config`, as it reads every other setting; `slice resume` reports any note under `small_change.settings_notes`.

## Public functions (`skills/intent/scripts/small.py`)

```python
settings(config) -> (limits: dict, notes: list[str])
judge(model, text=None, *, epics=(), risks=(), depends_on=(), shipped_slices=None, limits=None) -> verdict    # pure
judge_plan(project, files, changed_contracts=(), proposed_adrs=(), risk_for=None, limits=None) -> verdict   # adds "high_risk": [{"file", "why"}]
sentence(rule_or_None, limits=None) -> str
verdict(failed_codes, limits=None) -> verdict
widening(verdict, at) -> {"at", "reason": the sentence, "rule": the code}
asked(why, at) -> {"at", "reason": the person's words, "rule": None}
is_shipped_rule(value) -> bool          # SLICE-NNN/ and INV-NN, FR-NN or RN
matrix_tables(text) -> int
KIND = "small"; CHANGES = ("fix", "adjustment"); DEFAULTS; BOUNDS; SPEC_RULES; PLAN_RULES; RULES; SENTENCES
```

A verdict is `{"verdict": "small" | "not small", "small": bool, "rule": code | None, "sentence": str, "failed": [codes]}`.

`model` is `validate_slice.analyze`'s model, the `--export` form. For check-plan, the next engineer calls `judge_plan(project, plan_files(text), changed_contracts=<the plan's contracts already on main>, proposed_adrs=[item["file"] for item in decisions["record"]["proposed"]], limits=small.settings(load_config(project))[0])`.

## How kind and widened are stored and read

On a Product Studio work order (`product/slices/SLICE-NNN.json`), only for a slice started with `--small`:

```json
"kind": "small",
"small": {"change": "fix", "shipped_rule": "SLICE-003/FR-02"},
"widened": {"at": "2026-11-22T10:00:00Z", "reason": "This is not a small change: ...", "rule": "requirements"}
```

- `small.shipped_rule` is null for an adjustment. A fix's rule must be in force on the PM's copy of main when the slice starts (`shipped.read`'s `in_force`).
- `widened` is absent while the slice is on the light path. `rule` is the code when a check or `--by-rule` widened it, null on the PM's word (`--why`). `kind` stays `small` after widening: it records how the change started; `widened` says it left. "On the light path" is `kind == "small"` and no `widened`. This is the form Part D gives `spec.json` and `cell.json` (`kind: small`, `widened` when it left).
- A slice started any other way has none of the three fields, so its work order is byte for byte as before. `product.py` refuses `kind` other than `small`, `kind` without `small` or the other way round, `widened` without them, and a malformed record.
- Reports: `status` rows add `kind` and `small: {change, shipped_rule, light_path, widened}`; `slice check`, `slice show` (its `check`) and `slice ready` add `small_change: {kind, change, shipped_rule, light_path, widened, verdict | note}` (`widened_now: true` on the check that widened it); `slice resume` adds `small_change` with `method` (the path of `small-change.md` while on the light path, of `interview-method.md` once widened), `limits`, `rules` (each spec rule's sentence and `questions`), `questions_sentence` and `note`. Every other slice gets none of these fields.

## Widening

- **By the check**: `slice check` and `slice ready` judge a slice still on the light path and, when a rule fails, write `widened` with the rule's sentence (saved as bookkeeping, no new revision, as the check's other bookkeeping). The command's outcome is otherwise what it would have been: never refused for size; the spec and why are not touched. `slice ready` then goes on through its gates and, when they pass, approves the slice as a full slice; a refused `slice ready` still keeps the widening. `slice show` reports the verdict and writes nothing.
- **By command**: `slice widen <SLICE-ID> --why "<the PM's words>"` (a PM act, listed with the others in the skill's guardrail) or `--by-rule <code>` (the interview saw an answer break a rule). It refuses a full slice, one already widened, and one marked ready (reopen it first). It is a change to the work order, so the revision goes up.
- After widening the slice is judged no more: a later smaller spec does not bring it back.

## Choices and departures

- **`slice widen --by-rule`** is an addition to the design's `--why`. Without it, a slice the interview saw break a rule (a second actor, a sixth question) would be recorded as the PM's own reason, and its record could not name the rule. Widening only ever goes towards the full interview, so allowing the interview to do it on the rule's word gives no way round a rule.
- **`--change` and `--rule` on `slice new` and `request pick`**: the design gave `--small` and asked for a way to name the kind and a fix's rule. `--change` is required with `--small`; `--rule` is required for a fix and refused for an adjustment.
- **The `questions` rule** has a sentence but no script check: the interview's questions are not recorded anywhere a script can count them.
- **`slice ready` approves a slice it has just widened** when every gate passes. "Never refused" was read as applying to `slice ready` too; the gates are the same for a full slice.
- **Kind and handoff**: the kind does not yet travel with the slice when it is marked ready (the issue marker, the approval comment, the ready folder's `slice.json`). That is the issue_rules marker format, shared with the ticket and intent stations, and belongs with Part D.
- **`spec.json`**: the export is written by `cell.py finalize`, not by the validator, so `kind` and `widened` in `spec.json` are left to the intent station's engineer.
- **`skills/intent/SKILL.md`** is unchanged: nothing in it is needed for Product Studio's small change, and the station's own flow is the next engineer's.

## Left for the intent-station engineer

- Load `small.py` in `cell.py`; record `kind` (and `widened`) in `cell.json`; take the short interview on the engineer's word or the ticket's `small-change` label; apply `judge` at `validate` and `finalize` (with intent.md's risk and the cell's risk floor in `risks`, the cell's epic if any in `epics`, and the shipped slices) and `judge_plan` at `check-plan`; write `kind`/`widened` into `spec.json` at `finalize`.
- At `check-plan`, a Product Studio slice that is no longer small stops with a question on its issue (as any spec defect does); an engineer's own ticket goes back to the interview in full.
- Carry the kind through the handoff (marker, approval comment, folder `slice.json`) and into intake, with Part D.
- `references/small-change.md` names Studio's commands; add the station's own where its commands differ.
- The app (Part C's last bullet) and its conversation allow-list: `slice new --small`, `slice widen` are not host operations yet.

## How far it is tested

`tests/test_small_change.py`, 35 tests:

- Every rule small and not small, with its sentence, through the validator's own model of a real spec (each changed spec checked valid first): actor (four forms, and a parenthesis that is not a second actor), capability, requirements and scenarios at and over the limit, the matrix count, changed, replaced, kept and retired effects against shipped rules, principle answers, policy concerns under each resolution, permissions, dependencies on the work order and named in External dependencies, risk tiers. The first failing rule decides and every failure is listed; missing data is not evidence; every rule has one distinct sentence.
- Settings: defaults (and the template holds the same), set values, unusable values with notes, the limit applied by `judge` and named in the sentence.
- The plan's rule with a stand-in `risk_for` for each case, and once with the ticket station's own `scans.py`.
- Studio: starting a fix (against a spec committed on main) and an adjustment; every refusal before anything is written, and the app wording of one; the check keeping a small slice small and marking it ready; the check widening one with four requirements, changing neither the spec nor the why and keeping every field, then never judging it again; `slice show` writing nothing; `slice ready` widening on a High tier and still approving; a refused `slice ready` keeping the widening; the settings used by the check; `slice widen --why` and `--by-rule` and their refusals; the structural validator's ten malformed forms; `request pick --small` against the stand-in for GitHub, refused before anything is written when the flags are wrong.
- A project that never starts a small change: no field in the work order, status, check, show, resume or ready.

`make check` on 2026-11-22: 1939 tests in 449 classes passed (one skipped, as before), and the manifests validated (passed, with the existing missing-icon warning). Every existing test passes unchanged; the one existing file changed for a test is the slice JSON Schema (`docs/mach-next/schemas/slice.schema.json`), which must describe every field the structural validator allows. Not tested: a real interview run by a model against `small-change.md`, and the handoff of a small slice to GitHub (the kind does not travel yet).
