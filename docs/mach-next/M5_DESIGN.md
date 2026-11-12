# MACH Next — M5 design: the visual Product Studio

Status: built on `feature/mach-next-m5-product-studio`, on top of M4 (`b2a98c8`). Experimental, like the rest of MACH Next.

M5 gives the product manager a graphical interface to the Product Studio that M1 and M2 built for the terminal. It adds no product rule. This note records the decisions; three companion files hold the detail:

| File | Holds |
|------|-------|
| `M5_CONTRACT.md` | The working agreement the team built to: the engine's operations, the HTTP API, the host's security requirements, the interview events |
| `apps/studio/README.md` | The host's API as built, flags, how the engine is found, the build |
| `DESIGN_SYSTEM.md` | Tokens, themes, primitives, the lifecycle and graph components |
| `M5_INTERVIEW_POC.md` | How the guided interview runs through Claude Code, and what the proof of concept found |

## 1. Shape

```
 browser (React, served from the host)        Claude Code session (/mach-product-studio)
              │  HTTP on 127.0.0.1                          │
              ▼                                             │
   mach-studio (Go, standard library)                       │
     allowlisted operations, drafts, interview              │
              │  python3 -I -B studio.py <fixed args>       │
              ▼                                             ▼
        skills/product-studio/scripts/studio.py  (collab.py, product.py)
              │
              ▼
        <project>/.factory/studio/   drafts, base copies, ledger, interviews
```

**One engine, two interfaces.** `studio.py` decides every ID, state, validation, approval, reconciliation and the bytes of every artifact. The host turns a typed request into a fixed argument vector and returns what the engine printed. The app shows it. When the app needed a fact the engine did not report, the engine gained a read-only field with a test (`slice show`, `status.next_actions`, slice `dependencies`, `editable`, `in_waves`, epic acceptance criteria); nothing is computed in Go or TypeScript. A conformance suite holds the two interfaces to the same result.

**No second command line.** The host is started by the Product Studio skill ("open the app"), not by a new user-facing MACH command. Its flags exist for the skill and for tests.

## 2. The host (`apps/studio`)

- Go, standard library only, one binary with the built web app embedded. No WebAssembly and no single-file page.
- Binds `127.0.0.1` only, on a free port. There is no flag for another address.
- A one-time token in the start link is exchanged for an `HttpOnly`, `SameSite=Strict` cookie. Every request is checked for `Host`, and every state-changing one for `Origin` and an `X-MACH-CSRF` header.
- `POST /api/ops/<op>` runs one of a fixed list of engine operations. The list has no operation that enables Factory execution, starts a station, or touches `.factory/local/`. The engine's reports still carry `factory_authorized: false`.
- Draft reads and writes are limited to a slice's spec and why inside the draft workspace; paths are built from validated IDs, never taken from the request.
- Content-Security-Policy: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'`. Nothing is loaded from another origin, at build time or run time. Fonts are open-licensed and self-hosted; no Anthropic font, logo or icon is redistributed.
- No credential reaches the browser. `gh` and Git use the person's existing sign-in inside the engine's process; the host's responses and the page hold none of it.

## 3. The guided interview

The interview is the same one the terminal skill runs: the method in `skills/intent/references/interview-method.md`, shared, never copied.

- One Claude Code session per slice, one `claude -p --resume` process per reply. The session survives a reload and a host restart.
- Every turn runs restricted: the person's own settings and MCP servers are not loaded, nothing can prompt, the tool list is explicit, and the environment carries no variable that looks like a key, token or secret. No permission-skipping flag is used anywhere.
- The interviewer may run only the engine's non-approving operations on its own slice, and edit only that slice's spec and why. It cannot approve, send or reconcile. Those are buttons the product manager presses.
- Claude's stream is reduced to nine event kinds (`state`, `text`, `message`, `question`, `activity`, `draft_changed`, `turn`, `ended`, `error`) and served as server-sent events with replay. The raw stream never leaves the host.
- A lock per slice, a spending cap and a time limit per turn, interrupt, stop, and a clean stop on shutdown.
- When Claude Code is missing, too old or signed out, the app says why and offers the exact command to continue the interview in Claude Code instead. The rest of the app works without it.

The app keeps what the interviewer **proposes** (the conversation) apart from what the engine **checked** (the draft specification beside it). Only the second is ever described as valid or ready.

## 4. The app (`web/`)

A pnpm workspace: `@mach/ui` (tokens, themes, primitives, shell, lifecycle, dependency graph, API client), `apps/showcase` (the design system on one page) and `apps/product-studio`.

| Route | Experience |
|-------|------------|
| `/` | Workspace: where things stand and the next step, from the engine's `next_actions` |
| `/vision` | Vision and outcomes |
| `/roadmap` | Epics and slices, and the dependency graph |
| `/slices/:id` | Specification workspace: structured view, the why, source, approve / reopen / pause |
| `/slices/:id/interview` | Guided interview |
| `/inbox` | Decisions waiting for the product manager |
| `/waves`, `/waves/:id/send`, `/waves/:id/review` | Delivery waves, sending to engineering, review feedback |
| `/shared` | The shared project: what arrived, what changed, conflicts and collisions |

Wording follows the skill's first guardrail: no Git, branch, commit, JSON or hash in anything the product manager reads. An engine refusal is shown in the engine's words.

## 5. What M5 does not do

- It does not enable, start, schedule or observe Factory execution. That stays `run.py factory …` on an engineer's machine, off by default (M4).
- It does not install a background service, a login item or a Git hook. The host runs while the session that started it runs.
- It does not add product state. Everything is the M1/M2 workspace under `.factory/studio/`, git-ignored, plus `interviews/` beside it.

## 6. Verification

Recorded in the M5 completion report. In short: Python suites for the engine and the host boundary; Go tests for the operation list, security checks, the interview bridge and the server; lint, type check and build for the web workspace; accessibility scans of every state in both themes; and `web/e2e`, which drives the real app, host and engine through the whole product-manager path, checks the two interfaces agree, and attacks the host's boundary.

## 7. Open decisions

1. **Distribution: decided.** Prebuilt host programs for macOS and Linux (arm64 and amd64) are attached to each GitHub release by the `release` workflow, with `SHA256SUMS` and a build provenance attestation. `bin/mach install` and `scaffold` download the one for the machine from the release matching the installed version, check its SHA-256, and place it at `.factory/bin/mach-studio`; a failed download never fails the install. The checksum comes from the same release, so it proves the file arrived intact, not who built it; the attestation covers that for anyone who wants to check. Windows has no build.
2. **Supervisor hardening.** The restricted-mode execution fix (`bbe5aee`) reached `main` with the MACH Next merge. The separate M4 branch still has the weaker flags and should not be used on its own.
3. **Conversation history.** The specification is the record of an interview. Whether the full conversation should also be kept, and for how long, is a product and privacy choice.

## 8. For M6

Shared with the Factory console to come: the design system, the shell, the API client and envelope, the host's security layer, the event stream plumbing, and the lifecycle and graph components. The Factory console must be a separate surface with its own operation list; nothing in this host can be extended into enabling execution by adding a route.
