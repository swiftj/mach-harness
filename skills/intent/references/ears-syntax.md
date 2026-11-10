# EARS syntax and RFC 2119 keywords

Read this file in Phase 4 only. It defines the sentence forms that `scripts/validate_slice.py` accepts in `## Invariants` and `## Functional requirements`. Rule codes in brackets match the validator's output.

## Line format

- Invariants: `- **INV-01:** <statement>`
- Functional requirements: `- **FR-01:** [<Pattern label>] <statement>`

Write one requirement per line. IDs have two or more digits and never repeat [duplicate-id]. These two sections contain only requirement lines and blank lines: no prose, sub-bullets, or wrapped lines [unparsed-line].

## The five EARS patterns

EARS (Easy Approach to Requirements Syntax) is a small set of sentence templates that make each requirement unambiguous and testable. Every functional requirement starts with a pattern label and then uses exactly that pattern's form.

| Label | Use it for | Form |
|-------|------------|------|
| `[Ubiquitous]` | Behavior that is always true | `The <system> SHALL <response>.` |
| `[Event-driven]` | A response to a trigger | `When <trigger>, the <system> SHALL <response>.` |
| `[State-driven]` | Behavior that holds for as long as a state lasts | `While <state>, the <system> SHALL <response>.` |
| `[Unwanted behavior]` | Rejections, errors, and downstream failures | `If <condition>, then the <system> SHALL <response>.` |
| `[Optional feature]` | Behavior that exists only when a feature or setting is on | `Where <feature is included>, the <system> SHALL <response>.` |

Examples:

- `- **FR-01:** [Ubiquitous] The system SHALL record an audit entry for every role change request.`
- `- **FR-02:** [Event-driven] When an admin submits a valid invitation, the system SHALL send an invitation email within 60 seconds.`
- `- **FR-03:** [State-driven] While the organization is suspended, the system SHALL reject new invitations.`
- `- **FR-04:** [Unwanted behavior] If the email address already belongs to an active member, then the system SHALL reject the invitation and display "This person is already a member."`
- `- **FR-05:** [Optional feature] Where domain-restricted signup is enabled, the system SHALL reject email addresses from unapproved domains.`

### Enforced rules

- Start every functional requirement with one of the five labels above. Labels ignore case [ears-label].
- The sentence must use the form its label names. A `[State-driven]` label on a `When ...` sentence is an error [ears-label].
- Start the sentence with exactly `When`, `While`, `If`, `Where`, or `The` [ears-pattern].
- Separate the opening clause from `the <system>` with a comma. The unwanted-behavior pattern needs `, then the` [ears-pattern].
- The system name between `the` and `SHALL` contains no comma [ears-pattern].
- End with a period. A closing quote after the period is allowed [ears-pattern].
- Use exactly one `SHALL` or `SHALL NOT` per requirement [ears-atomic]. The response after it may join actions with "and" only when they always happen together and a test checks them as one result, such as `reject the invitation and display "..."`. If the parts can succeed or fail separately, such as "resume the subscription and send a reminder email", split them into separate requirements.
- Write `SHALL` in uppercase [rfc2119-case].
- Do not use `MUST`, `SHOULD`, `MAY`, `REQUIRED`, `RECOMMENDED`, or `OPTIONAL` in functional requirements. Hard limits belong in Invariants; optional behavior uses the Optional feature pattern [fr-keyword].
- Include at least one unwanted-behavior requirement. If the interview settled that the slice has no rejection or failure path, the warning may stay; say so in the handoff [ears-coverage].

### Writing guidance

These are not enforced, but they keep specs comparable across agents.

- Call the system "the system" throughout unless the PM names a distinct component.
- Keep one opening clause per requirement. Put standing conditions in `## Preconditions` rather than stacking `While ..., when ...`.
- Put exact user-facing messages in double quotes. Text inside quotes is not checked for keywords, vague terms, implementation detail, or placeholders. Write the variable parts of a message in angle brackets inside the quotes: `"Your next pause is available on <date>."`
- State limits and times as numbers with units: "within 60 seconds", "at most 5 seats".

## RFC 2119 keywords

RFC 2119, as clarified by RFC 8174, gives these words special meaning only when they are uppercase.

| Keywords | Meaning | Use in a slice |
|----------|---------|----------------|
| MUST, MUST NOT, SHALL, SHALL NOT, REQUIRED | Absolute requirement or prohibition | Invariants use the MUST forms; functional requirements use the SHALL forms. |
| SHOULD, SHOULD NOT, RECOMMENDED, NOT RECOMMENDED, MAY, OPTIONAL | Recommendation or permission with legitimate exceptions | Not used. A slice states guarantees that can be tested, and a test cannot pass or fail a recommendation. If the PM described a default with exceptions, write each exception as its own requirement. |

### Invariant rules

An invariant is a business boundary that can never be breached, such as a seat count, monetary cap, character limit, or token lifetime.

- Form: `<Subject> MUST <boundary>.` or `<Subject> MUST NOT <boundary>.`
- Contains at least one of MUST, MUST NOT, SHALL, SHALL NOT, or REQUIRED [inv-keyword].
- Contains none of SHOULD, MAY, RECOMMENDED, or OPTIONAL [inv-keyword].
- Lowercase "must", "should", or "shall" has no RFC 2119 force and produces a warning [rfc2119-case].
- Name the measurable quantity: "MUST expire 24 hours after it is created", not "MUST expire after a while".

Examples:

- `- **INV-01:** An organization MUST NOT exceed its purchased seat count while sending invitations.`
- `- **INV-02:** A verification link MUST expire exactly 24 hours after it is created.`

## Business level only

A slice describes what the actor sees and what changes, in the business's words. It does not set the technical contract: no HTTP status codes, error codes, payload shapes, data schemas, or named technologies. Engineering chooses those when building the slice.

When the PM gives a technical instruction, translate it into the guarantee behind it (Guardrail 3):

| PM says | Write instead |
|---------|---------------|
| "Return a 409 with `MEMBER_EXISTS`" | `If the email address already belongs to an active member, then the system SHALL reject the invitation and display "This person is already a member."` |
| "Store reset tokens in Redis with a 30 minute TTL" | An expiry invariant: "A reset link MUST stop working 30 minutes after it is created." |
| "Cache the seat count" | A freshness guarantee: "The seat count shown MUST NOT be more than 60 seconds out of date." |
| "Run a cron job" | A timing guarantee, such as "Expired invitations MUST release their seats within 1 hour of expiry." |

The validator warns when an invariant, functional requirement, decision matrix row, or scenario step mentions implementation detail [implementation-detail]. It looks for terms such as HTTP, status code, API, endpoint, payload, JSON, database, SQL, schema, cache, TTL, Redis, and cron (full list: `IMPLEMENTATION_TERMS` in `scripts/validate_slice.py`). It also flags status codes after "return" or "respond", such as "return 429", and error-code identifiers such as `MEMBER_EXISTS`.

## Vague terms

The validator warns when an invariant, functional requirement, or matrix row uses wording that cannot be tested [vague-term]. The full list is `VAGUE_TERMS` in `scripts/validate_slice.py`. Common examples: appropriate, as needed, as soon as possible, fast, quickly, easy, intuitive, seamless, robust, efficient, reasonable, sufficient, user-friendly, usually, etc., and/or.

Replace each one with a number, a named state, or an exact message. If only the PM can supply the value, ask them.
