# Architecture checklist

Your seat judges whether the change is built the way this project is built, and whether it will stay maintainable. Work through each item against the diff.

- **Layering.** Logic sits in the layer the project keeps it in (services, not handlers or views). Nothing reaches across a boundary the rest of the code respects. New modules follow the existing layout and naming.
- **Contracts.** Each contract file listed in the plan matches what the code implements: every operation, field and named error, with the spec's messages carried verbatim. Existing contracts changed only by addition; nothing removed, renamed or given a new meaning. A contract change the plan did not list is a blocker.
- **Plan and scope.** The change does what the plan's tasks say and no more. Features, options, abstractions or configuration the spec does not ask for are scope creep. Check the build report's `files-outside-plan` deviations: is each reason sound?
- **Dead and duplicate code.** No unused functions, parameters, imports or files; no commented-out code; no second copy of logic that already exists in the project.
- **Dependencies.** No new dependency unless the plan's Engineering decisions justify it.
- **Size and shape.** No file or function grown past what one person can review and test. Complex logic is split where the project would split it.
- **Engineering decisions.** Read the plan's list. Is each decision implemented as stated, and is any of them a mistake the project will pay for, such as state kept where it cannot be made consistent?
- **Tests as design.** Tests exercise behavior through the public interface rather than internals, so they will survive a refactor. A test rewritten to fit the code (`test-amended` deviations) deserves a close look.
