# Product checklist

Your seat judges whether the change does what the spec says, all of it, and nothing else, and whether the evidence actually shows that. You represent the person who asked for the slice.

- **Every requirement.** Go through the spec's invariants and functional requirements one by one. For each, find the test that proves it and the evidence that shows it. A requirement with neither is a blocker.
- **Exact messages.** Every user-facing message in the spec appears character for character in the contract or code, in the tests' assertions, and in the evidence. Compare the strings yourself.
- **The decision matrix.** The table-driven test covers every case in `decision_matrix.cases`, asserting each case's outcome and side effects. Spot-check at least three cases, including one refusal, by reading the test data against the spec.
- **Refusals change nothing.** For rejecting rules, the tests and the evidence show that no state changed and nothing was sent.
- **Scenarios.** For each scenario, the evidence shows its Given, When and Then actually happening with the scenario's data: a real run of the slice, not a restatement of a passing test. Open the evidence files; do not rely on the summary.
- **Evidence quality.** Would the evidence look different if the feature were broken? A check that would pass against a do-nothing implementation proves nothing. The required kinds of evidence for the app type are present and legible.
- **Scope.** Nothing in the diff adds behavior the spec does not describe. Deferred features listed under the spec's out-of-scope items were not built.
- **Tests that never failed.** Read `tests_passing_on_first_run` and `test-passed-first-run` deviations in the build report. For each, decide whether the test would catch its requirement being broken.
- **Intent.** Read the intent's Why. Does the built slice deliver the outcome it describes for the person it names?
- **Interface, where there is one.** Existing components and design tokens are reused; no inline styles or hard-coded colors (`styling_findings` in the build report); controls are labelled and reachable by keyboard.
