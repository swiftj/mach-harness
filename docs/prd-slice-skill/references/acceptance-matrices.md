# Decision matrices and acceptance scenarios

Read this file in Phase 4 only. It defines `## Acceptance criteria` and `## Dependencies and permissions`. Rule codes in brackets match the output of `scripts/validate_slice.py`.

Acceptance criteria have two parts:

- `### Decision matrix`: one table that maps every combination of conditions to exactly one outcome and its side effects. Use a table, not prose.
- `### Scenarios`: Given/When/Then journeys for behavior a table cannot express: downstream failures, timing, and the order of steps.

## Decision matrix

### Layout

```markdown
| Rule | Admin active | Email valid | Already member or invited | Seat available | Expected outcome | Side effects | Covers |
|------|--------------|-------------|---------------------------|----------------|------------------|--------------|--------|
| R1   | No           | -           | -                         | -              | Request refused | None | FR-07 |
| R2   | Yes          | No          | -                         | -              | Rejected with "Enter a valid email address." | None | FR-03 |
| R3   | Yes          | Yes         | Yes                       | -              | Rejected with "This person is already a member or has a pending invitation." | None | FR-05, INV-02 |
| R4   | Yes          | Yes         | No                        | No             | Rejected with "All seats are in use. Add seats to invite more people." | None | FR-04, INV-01 |
| R5   | Yes          | Yes         | No                        | Yes            | Invitation sent | One seat reserved; invitation email sent to the invitee | FR-01, FR-02 |
```

- Use exactly one table under `### Decision matrix` [matrix-format].
- Columns, in order: `Rule`, one column per condition, `Expected outcome`, `Side effects`, `Covers` [matrix-format].
- Rule IDs are `R1`, `R2`, and so on, with no repeats [matrix-rule-id] [duplicate-id].
- Condition column names are unique and not empty [matrix-format].
- Every cell has a value. `-` means the condition does not matter for that rule; `None` means nothing changes [matrix-empty-cell].
- Every row has the same number of cells as the header [matrix-format]. Write a literal pipe inside a cell as `\|`.

### What belongs in the matrix

The matrix covers the decision the system makes when the actor acts: the actor's state, the data that already exists, and what the actor submits. Each condition column is one fact a test can set up before the action.

Downstream failures, such as an email service that does not respond, are not matrix conditions. Cover each one with a scenario instead, because what matters is the timing and recovery, not a combination of inputs.

### Condition values

- **Yes/No conditions.** Name the column as a short fact, such as "Seat available", and use `Yes`, `No`, or `-` in its cells.
- **Conditions with more than two values.** Declare every value in the header, separated by ` / `, and use only those values or `-` in the cells:

  ```markdown
  | Rule | Amount (Under $75 / $75 to $5,000 / Over $5,000) | Receipt attached | Expected outcome | Side effects | Covers |
  ```

  A cell value that is not declared is an error, which catches typos such as `At the limit` for `At limit` [matrix-value]. A column with values other than Yes and No but no declaration produces a warning [matrix-partitions].
- Never narrow the declared values to settle an open question. If the PM doesn't know whether $0 amounts are allowed, keep `Under $75` rather than `$0.01 to $74.99`, and leave the open question in place.
- **Several values in one cell.** In a Yes/No column or a column with declared values, a cell may list values joined by `or`, such as `Under $75 or $75 to $5,000`, or exclude values with `not`, such as `not Over $5,000` or `not Invalid or Duplicate`. One rule can then replace several, which keeps long matrices short. A cell that exactly matches a declared value always means that value, so declared values may contain "or" or start with "Not", such as `Suspended or closed` or `Not in the future`. In a column without declared values, every cell is read literally, so `or` and `not` only work once the values are declared [matrix-partitions]. A cell naming a value that is not declared, or a `not` that excludes every value, is an error [matrix-value].
- Values are compared ignoring case.

### Completeness

The validator checks that every combination of condition values matches at least one rule [matrix-incomplete]. It uses Yes and No for Yes/No columns and the declared values for other columns. It cannot know about a value you never declared, so declare all of them.

The error lists the uncovered cases compactly, leaving out conditions that do not matter for them. For example, `No rule covers: Admin active=No.` means every case with an inactive admin is uncovered.

If the conditions allow more than 4,096 combinations, the validator skips this check and warns that the slice is probably too large [matrix-size].

### Conflicts and precedence

Two rules overlap when every condition is equal or `-` in at least one of them.

- Overlapping rules with a different outcome or different side effects are an error [matrix-conflict].
- Overlapping rules with the same outcome and side effects are a warning [matrix-redundant]. Merge them.

When several rejections could apply at once, the PM decides which one the user sees; the interview asks this. Encode the answer with `-` and mutually exclusive values. In the example, R2 applies whenever the email is invalid, and R4 requires a valid email, so an invalid email is always reported before a full workspace.

### Impossible combinations

Add a rule for a combination that cannot occur only when the validator reports it as uncovered. If a rule with `-` already covers it, do nothing; adding a second rule would overlap and conflict.

For an uncovered case, ask the PM in a round whether it can happen (Phase 4, step 6). If it cannot, add a rule whose Expected outcome starts with `Not possible:` followed by the reason. Set Side effects to `None`, and cover the invariant or requirement that rules it out.

### Slices with more than one step

Some outcomes need the actor to act more than once, such as requesting a reset link and then setting a new password. Keep one table and add a `Step` condition column that declares the steps, such as `Step (Request link / Set password)`. Use `-` in the other columns for conditions that do not apply to a step.

### Expected outcome, side effects, and Covers

- **Expected outcome** is what the actor observes: the result, or the rejection with its exact message in quotes. A rule whose Side effects are `None` turns the action away, so its outcome must quote the message the user sees, or say `No message shown` if the PM decided that [message-missing].
- **Side effects** are the lasting changes the action causes, in business terms: records created or changed, seats reserved or released, emails or notifications sent. Rejections usually have `None`, and that is worth asserting: a rejected request changes nothing.
- Neither column names status codes, error codes, payloads, or tables [implementation-detail], and neither uses vague wording [vague-term].
- **Covers** lists the `FR-NN` and `INV-NN` IDs that the rule verifies, separated by commas [trace-format].

### Message variables

When part of a message changes, such as a date, write the variable in angle brackets inside the quotes: `"Your next pause is available on <date>."` Text inside quotes is never treated as a template placeholder.

### Parameterized tests

Each row is one case of a parameterized (table-driven) test, such as `test.each()` in Vitest or Jest or `@pytest.mark.parametrize` in pytest. The condition columns are the setup, Expected outcome and Side effects are the assertions, and Covers links the case back to its requirements. Engineers and agents should be able to turn the matrix into a test without reinterpreting it, so every condition must be something a test can set up and every outcome and side effect something a test can observe.

`validate_slice.py --export` prints the spec as JSON with every rule already expanded into concrete cases, one per combination of values, each with an ID such as `R1-3`. Downstream workflows should read that JSON rather than parse the table themselves.

## Scenarios

Write a scenario for:

- the main success path, with one scenario per step when the outcome takes more than one step;
- each downstream failure or degradation, such as a timeout or an unavailable service;
- time-based behavior, such as expiry or an automatic follow-up;
- any matrix outcome that needs concrete data to verify.

### Format

```markdown
#### AC-03: Email service failure releases the reserved seat

- **Covers:** FR-06
- **Given** the workspace "Acme Design" has 5 purchased seats and 4 members
- **And** the email service is not responding
- **When** the admin invites "sam@example.com"
- **Then** after 60 seconds the system displays "We couldn't send the invitation. Try again in a few minutes."
- **And** the Members page shows 4 of 5 seats in use
```

- Put each scenario under its own `#### AC-NN: Title` heading. IDs have two or more digits and never repeat [scenario-format] [duplicate-id].
- Include exactly one `- **Covers:** ...` line [trace-format].
- Start every other line with `**Given**`, `**When**`, `**Then**`, `**And**`, or `**But**`. `And` and `But` continue the previous step type [scenario-format].
- Order the steps Given, When, Then. Use exactly one When, because a scenario tests one action, and at least one Then [scenario-steps].
- **Given** sets up the starting state and existing records. **When** is the single action. **Then** asserts the end state: what the actor sees, what changed, and what was sent.
- Use concrete synthetic data: `example.com` addresses, fictional names, and round numbers. Never use real customer data.
- Describe observable results, not internal calls or technology [implementation-detail].

## Traceability

- Every `INV-NN` and `FR-NN` appears in at least one Covers cell or Covers line [trace-uncovered].
- Every ID in a Covers cell or line is defined in Invariants or Functional requirements [trace-undefined].

If a requirement cannot be covered, it is not testable. Rewrite it, or ask the PM what observable result proves it.

## Dependencies and permissions

This section tells engineering what the slice relies on and who may use it. Both lines are required; write `None.` when nothing applies [dependencies-format].

```markdown
- **External dependencies:** Email delivery service, which sends the invitation email (failure: FR-06)
- **Required permissions:** Workspace admin role in the invited workspace
```

- **External dependencies** are services outside the slice that it calls while the action runs and that can fail, such as an email provider, a payment processor, or a file storage service. Tests will simulate them. Name each one as the business knows it and say what the slice uses it for. Separate several dependencies with `;`.
- Each dependency ends with `(failure: FR-NN)`, naming the requirement that says what happens when it fails. That requirement must be an `[Unwanted behavior]` requirement and must be covered by a scenario [dependency-failure].
- Data the slice reads and assumes is already there, such as an employee's manager or leave status, is a precondition, not a dependency. List it under `## Preconditions`.
- **Required permissions** name the role or permission the actor needs, in business terms. If anyone can act, including signed-out users, write `None.` and add a short reason, such as `None. Any visitor on the sign-in page can request a reset.`
