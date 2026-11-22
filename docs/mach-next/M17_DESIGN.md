# M17: Technical needs and the architecture baseline

Design, 2026-11-21. Status: agreed, not built. This file is the contract the engineers share, so parts built at the same time fit together.

## The problem

No ticket is planned until six topics each have an accepted ADR (`adr.required_topics`). `/mach adr baseline` drafts them from evidence in the committed code. A new project has no code, so every topic comes back `no_evidence` and the engineer is asked all six questions with nothing to go on. What the product manager knows (who uses the product, how sensitive its data is, what it must connect to, what the organisation already runs on) never reaches that conversation, and a design a team already wrote has no way in.

M17 gives the baseline two new sources of evidence, both from Product Studio, and one new output. It adds no second decision system.

## Decisions (binding, agreed 2026-11-21)

1. **An engineer accepts technology decisions, as now.** The product manager approves technical needs only. One person doing both uses `adr.landing: main`.
2. **Only ADRs bind.** The architecture overview is a map of them. No station checks a plan against it.
3. **Product Studio gets screens** for technical needs and for a brought-in design in this milestone. The engineer's part stays in the terminal.
4. **The product manager's page is called "Technical needs".** The word "architecture" is used only for the overview document and on the engineer's side.

## Rules that hold for every part

- Optional. A project that never opens Technical needs behaves exactly as before, and every existing test passes unchanged. The baseline with no needs and no design is today's baseline.
- A person decides; a script checks. MACH never chooses a technology for a product manager, and no need or brought-in design covers a required topic by itself: only an accepted ADR does.
- Text from outside (a design document) is data: redacted, bounded, fenced, never followed, never sent to GitHub.
- Same engine patterns as the rest of `skills/product-studio/scripts/`: IDs from the engine, drafts in the git-ignored workspace, acts on the product manager's word, every report carries `factory_authorized: false`, app wording through `say()`.
- Nothing here starts a station, creates a ticket or cell, or accepts an ADR. The Factory, the observe station and `factory-tuning` tickets still never accept, change or supersede an ADR.
- Python standard library only. No new user-facing program.

## Part A: technical needs (Product Studio, `needs.py`)

A technical need is what the product requires of whatever is built, said without technology. It is product-level, beside the vision and the principles.

**Record**, `product/needs.json` in the draft workspace: `{schema_version, project_id, needs: [...]}`. Each need: `need_id` (`TN-NN`, never reused), `kind`, `statement` (one or two sentences), `why`, `status` (`active` or `retired`), `revision` (counts changes to the statement).

**Kinds**, a fixed list; the interview asks about each once and "nothing to say" is a valid answer, recorded as such so it is not asked again:

| Kind | The question, in the product manager's terms |
|---|---|
| `people` | Who uses it, how many, from where, and at what busiest moment |
| `data` | What it keeps, how sensitive that is, and how long it must be kept |
| `connections` | What it must work with that already exists |
| `never` | What must never happen, and what it costs if it does |
| `priority` | When two qualities conflict (speed, cost, safety, ease of change), which wins |
| `given` | What is already decided outside this product |

**Technology words.** The statement of every kind except `given` is held to the check principles use (`validate_slice.statement_findings`' technology check, shared, not copied): a technology is an error. A `given` may name a technology, and must carry `said_by` (a person's name or role, or a policy pack ID that exists) and `said_on`. A given is a constraint someone stated. It is evidence for the engineer, never a decision.

**Commands**: `need add --kind --statement --why [--said-by --said-on]`, `need set <TN-NN> ...`, `need retire <TN-NN>`, `need list` (reads only; also which kinds are unanswered and which ADRs were written under an older revision), `need none --kind <kind>` (records "nothing to say"), `need publish`. All but `list` on the product manager's word.

**Publishing** is the principles' mechanism, shared: a fixed section of the project's issue (`issue_rules.needs_section`, a hidden marker with the revision and the SHA-256 of the needs as canonical JSON), one approval comment from a fixed template, record-before-try and look-before-write in `.factory/studio/issues.json`; without gh, `product/ready/NEEDS/needs.json`, which the product manager commits. Every later rewrite of the project's issue keeps the section. `refresh` and `reconcile needs --take mine|theirs` work as they do for principles. Intake skips `product/ready/NEEDS/`.

**The conversation**: a third narrow mode of the guided interview, for the product as a whole. It may read, and edit only `product/needs.json` through `need add|set|none`; publishing and retiring are the product manager's buttons. Its reference file, `skills/product-studio/references/needs.md`, holds the method: one open question at a time in plain words; never offer a technology as an answer; when the person names one, ask who decided it and record a `given`, or record the need behind it; an unknown is left unanswered, never guessed.

**Not a gate.** `slice ready` does not wait for needs. `status` reports them (`needs`: published revision, unpublished changes, unanswered kinds).

## Part B: bringing in a design (Product Studio, `design.py`)

For a team that already has an architecture or high-level design document. It shares the PRD import's code (`prd.py`: copy, bounds, sections, numbered fenced display), generalised or called, never copied.

- `design import <file>`: one Markdown or plain-text file into the workspace as `DES-NN` with its SHA-256, line count and sections. Binaries, links and folders refused.
- `design show <DES-NN>`: numbered, redacted, fenced (`<<<DESIGN-DATA ...>>>`).
- `design map <DES-NN> --from <json>`: records what the model found, only if every citation exists. Per required topic one of: `decided` (the cited lines and a one-line summary), `partly` (cited lines and what is missing), `silent`. Also: decisions outside the required topics (cited lines, a suggested `applies-to`), and `conflicts` (a cited line against a principle, a policy pack statement or a technical need, each of which must exist).
- `design settle <DES-NN> --conflict <n> --as stands|design-is-wrong|ask-engineer --reason`: on the product manager's word. A conflict is never settled by a model.
- `design publish <DES-NN>`: writes `product/ready/DESIGN/DES-NN/` (the file, `design.json` with the hash and the map) for the product manager to commit. The document is never put in an issue. Refused while a conflict is unsettled.

A design fills no technical need by itself. After a map, the conversation may propose needs the document states (citing lines) and the product manager accepts or changes each.

## Part C: the baseline reads them (`baseline.py`, `adr.py`, the run skill)

- **Evidence.** `gather` adds, per topic, items from two committed sources on the main branch: the published needs (`product/ready/NEEDS/needs.json`, else the project issue's section as intake last read it) and each published design's map. An item names its source (`need:TN-03 revision 2`, `design:DES-01 lines 40-52`), bounded and redacted as code evidence is. A topic with only these is no longer `no_evidence`; the report says `from_product: true` so the skill words the question differently.
- **Which need informs which topic** is a fixed table in `baseline.py` (for example `data` informs `storage` and `deployment`; `given` informs every topic), not a model's judgement. Every need is shown for the overview.
- **Drafting.** For a topic with product evidence and no code, the skill drafts a proposed ADR as it does today, with three additions held by `run.py adr new`: `--serves TN-NN` (repeatable; each must exist at that revision), at least two `--option` entries, and each `--consequence` in product terms where a need is served. A `decided` topic in a design is drafted from the cited lines; `partly` and `silent` become open points. A given is quoted with who said it and becomes an open point ("confirm this still holds"), never a decision taken as settled.
- **ADR header.** One new optional field MACH reads: `serves: TN-01@2, TN-04@1`. Malformed is a problem with its reason, as for `applies-to`.
- **The settle interview** is unchanged: one yes-or-no question at a time with a recommended answer, the engineer's word, `run.py adr settle`. Acceptance and landing are unchanged.
- **The overview.** `run.py adr overview` writes `docs/architecture/overview.md` (`adr.overview` moves it) as a proposed change in the main checkout's working tree: context (the needs, by ID), the parts and how they connect (one `flowchart`), how data moves (one `sequenceDiagram` or `flowchart`), and a table of ADRs by topic. Diagrams pass `diagrams.py`. It is written by the skill from accepted and proposed ADRs only, lands with them, and is offered again when an ADR is accepted or superseded. It carries one fixed line saying the ADRs are the authority.
- **Later change.** A need whose statement changes is a new revision. `adr list`, `need list` and `status` flag every ADR that `serves` an older revision. Nothing is reopened, blocked or restarted; an engineer supersedes the ADR in the ordinary way if the change matters.

## Part D: the app

After the engine. Host operations for every command in parts A and B, each one engine command; typed client; fixtures from the real engine. Two screens, built with the frontend-design skill and the style guide:

- **Technical needs** (in the product's own navigation, beside Vision): the six kinds as a list, each with its needs or "nothing to say", the conversation beside it, the publish act with what is unpublished, and, read only, the ADRs that serve each need with a flag where one is behind.
- **A design you already have** (reached from Technical needs): bring in a file, the six topics with what the document decides and the lines it cites, conflicts with three equal choices, and the publish act with what to commit.

Neither screen shows or offers an ADR act.

## Order of work

1. Part A engine and Part C's evidence and `serves` (they share the needs file's shape). 2. Part B engine. 3. Drafting, the overview and the skill text. 4. Host operations and fixtures. 5. The two screens. `docs/BLUEPRINT.md` (Product Studio and "Architecture decisions") is updated with each part as built.

## Out of scope

Reading an architecture out of existing code beyond what the baseline already gathers; a model accepting or recommending acceptance of an ADR; checking a plan against the overview; diagrams in specs; the light path for small changes (next milestone).
