# Interview method

How to interview a Product Manager (PM) about one slice. The intent skill and the product-studio skill both follow this file, so a slice is questioned the same way wherever it starts. The skill that sent you here names the commands and files; "Phase 3" and "Phase 4" are that skill's Sanity Check and Spec Write-up phases.

## Interview guardrails

1. **Question Until Nothing Is Missing:** Interview until every branch of the design tree is settled (see Design tree and frontier), one question at a time. There is no limit on questions; keeping the slice thin keeps the interview short. Most thin slices settle in 10 to 20 questions. If the frontier is still growing after question 25, the slice is too thick: trim it (Guardrail 2) instead of asking more. Never press past the PM's knowledge: "I don't know" ends that line of questioning.
2. **Aggressive Scope Trimming:** If the PM introduces admin consoles, secondary flows, bulk actions, or multi-role workflows, immediately deflect:
   > *"That belongs in a subsequent slice. Let's mark that as out-of-scope and complete the core slice for [Persona] first."*
   Until Phase 1 locks the persona, say "the primary user" in place of [Persona]. You decide the slice boundary; never put scope to the PM as a question. A single slice must represent exactly **one complete verifiable business outcome** that the factory can build and verify in a single cell.
   - Keep system-triggered follow-ups that the outcome depends on, such as automatically resuming a paused subscription.
   - Defer optional follow-ups, meaning anything that happens later rather than as part of the action, such as reminder emails or digests, unless the PM's answers show the outcome fails without them.
   - Immediate confirmations of the action, such as a "Your password was changed" email, are side effects, not follow-ups; ask about them in the Side effects branch.
   - If the PM later asks to bring a deferred item back, apply the same tests. The boundary stays your call.
3. **No Architecture Creep:** If the PM dictates technical implementations, even repeatedly or in a correction to your summary (*"Store in Redis"*, *"Run a cron job"*), translate the statement into a behavioral guarantee (*"Changes are visible within 60 seconds"*, *"Each request is processed exactly once"*). Keep the PM focused on *what* and *why*, not *how*. The same applies to facts found in the code: translate them into behavior before the PM sees them. Stage 2 makes the technical choices; stage 1 never does.

## Method

### Design tree and frontier

Map the slice as a design tree: every decision branches into the decisions that depend on it. The root is the actor, the trigger, the business outcome, and the purpose: the problem this solves and the sign that it worked. Every one of these branches must be visited before the interview ends:

- **Preconditions & state:** What must exist before the action starts, including data the slice only reads, such as an employee's manager? Who is allowed to do this? Can suspended, unverified, or rate-limited users trigger it? Define every condition word the slice depends on in business terms, such as what makes an email address valid.
- **Invariants & limits:** What business boundaries can never be breached? (Seat counts, character limits, monetary minimums and caps, link or code expiry times.) Include the boundary cases each one creates, such as exactly at the limit, month ends, and time zones, and what happens when the same thing is submitted twice, by a repeated click or later with the same details.
- **Failure states & recovery:** What are the exact rejection conditions and messages? Every refusal needs the exact words the user sees, unless the PM decides no message is shown. If several rejections apply at once, which one does the user see? What happens when an outside service fails? If the slice seems to have no rejection or failure path, confirm that with the PM.
- **Side effects:** What does a successful action change or send right away? Anything a scenario will check that the user can see, such as a page showing seat counts, must be stated as a requirement.
- **Dependencies & permissions:** Which outside services does the slice call while the action runs that could fail, such as an email or payment service, and which failure requirement covers each one? Data the slice only reads is a precondition, not a dependency. What role does the actor need?

The **frontier** is every unsettled decision whose prerequisites are settled: the questions you can ask now without guessing at answers you have not heard yet. A question that depends on another question still open is not on the frontier yet.

### One question at a time

Ask exactly one question per message, then stop and wait for the PM's answer. Several questions at once are bewildering. From the frontier, ask the question whose answer unblocks the most other decisions; ask the root first. Number questions continuously across the whole session, so "Q12: no" is never ambiguous. Use this format:

```markdown
❓ **Q1** - **<question title>**: <question body, which may run several paragraphs or list choices>

➡️ <your recommended answer>
```

For example:

```markdown
❓ **Q1** - **Who pauses**: Is this slice for an individual subscriber pausing their own monthly subscription from the Account page?

➡️ Yes. Family plan pauses belong to a later slice.
```

- Word each question as a yes-or-no proposal that contains your recommendation, such as "Should...?" or "Is...?", so "yes" accepts it. Do not ask open "Who", "What", or "How" questions. When you propose any rule that turns the user away, including who may act and which inputs are accepted, put the exact words the user sees in the same question, so the rule and its message settle together: *Should a past-due customer be refused with "Update your payment method before pausing."?*
- Put one decision in each question, so each answer settles one thing.
- After each answer, record it and recompute the frontier: settled decisions unblock the questions that depended on them. An answer that also settles other frontier questions removes them; do not ask them. A correction settles the point; do not ask again to confirm it.
- Before the question, write at most two lines, and only when something needs saying: a deferral you just made, a fact you found, or a technical instruction you turned into behavior. Do not recite what the PM just told you.
- Never ask about something already settled. When the PM's own words and a looked-up fact decide it, such as "same as today" and the limit found in the code, state it in those lines instead of asking.
- Never mention a deferred feature in a question. State deferrals in the lines before it, so scope is never put to the PM.
- Base each recommendation on what the PM has said or on facts you found. When you have neither, recommend a common default and label it, for example: "Common default: reset links expire after 30 minutes." When the PM accepts a labeled default, record it under `## Accepted defaults` with the requirement IDs it produces.
- Keep questions, recommendations, and everything else you say to the PM in plain business language. Say "write up the spec", never "compile".
- As soon as you notice two of the PM's rules conflict, such as a privacy rule and an error message that reveals an account exists, make which one wins your next question, with your recommendation.

### When the PM can't answer

Never badger the PM for answers they do not have.

- **"I don't know" or "I'm not sure":** End that line of questioning. Do not repeat the question or ask the questions that depend on it. Record it under `## Open questions` with a follow-up note naming who or what could answer it. If other open questions depend on it, say so in them, such as "Answer after the 12-month counting question."
- **"You decide" or "No preference":** Use your recommendation and record it, with the reason, under `## Assumptions`.
- **"Use your recommendations for the rest":** Stop asking. Treat every decision still on or behind the frontier as "you decide" and record each one under `## Assumptions`. The exception is a decision where you have no grounded recommendation and a wrong guess would cost money, expose data, or lock someone out: record that one under `## Open questions` instead. Then go to Phase 3.

### Facts are your job

Never ask the PM for a fact you can look up. Facts include existing specs in `specs/slices/` (reserved IDs and related slices), the ticket and what it links to, product documents in the project, and current behavior in the code, such as existing limits and messages. Decisions stay with the PM.

- Lookups are read-only, stay inside the project, and use product files only: never credentials, interview notes or transcripts, or the spec being written.
- If you can start sub-agents, give each lookup to its own sub-agent with a fresh context. Give it one bounded question and expect back a short plain-language answer that quotes the lines it relied on and names their file. Sub-agents never write files or talk to the PM. Before using an answer, read the quoted lines in the named file to confirm them; do not reread whole files.
- Start every lookup the next question needs at the same time and wait for their answers before you ask it. Lookups usually take under a minute. If a sub-agent's answer is not in its result, because the host runs it in the background, do that lookup yourself at once. Never end your turn to wait for a lookup, check on it, or schedule a wake-up: the PM would get a message that only says you are waiting.
- If you cannot start sub-agents, do the lookups yourself before asking.
- If a lookup fails, times out, or finds nothing, put the question to the PM. Do not record the absence of a fact under Assumptions.
- If a fact is ambiguous, such as a limit with no unit, ask the PM to confirm your reading, with that reading as the recommendation.
- If a fact shows that another team owns a rule nobody has decided yet, do not ask the PM to decide it. Record an open question with that team as the follow-up, and mention it before your next question in case the PM already knows the answer.
- Translate every finding into business terms before it reaches the PM (Guardrail 3). Record each fact the spec relies on under `## Assumptions` with its source file.

## Sanity check

The frontier is not empty while any refusal lacks its exact message, any condition word lacks a definition, or any limit lacks its number. Check for these gaps and ask them, one at a time, before the summary. Once the PM confirms the summary, ask nothing new; anything you notice later goes under `## Open questions`.

When the frontier is empty, output a concise 3-bullet confirmation:
1. Core Action & Scope Boundary
2. Hard Business Invariants
3. Error Cases & Rejection Paths: every refusal with its exact message in quotes

After the bullets, list the common defaults the PM accepted, so they can recheck them, and your assumptions. If any rule conflict is still unresolved, ask it as a question with your recommendation.
Ask the user: *"Does this capture the intent, or did I miss an edge case before I write up the specification?"*
Continue to Phase 4 only on an explicit yes. If the PM corrects or adds anything, update the design tree and ask what it opens up.
