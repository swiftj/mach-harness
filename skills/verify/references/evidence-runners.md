# Evidence runners by app type

Read only the section for the cell's `app_type`. Each says how to run the slice from outside, what to capture, and what to name the files so `verify.py finish` finds the required kinds. Save everything under the cell's `evidence_dir`. Use the tools `verify.py start` listed as available, and the project's own wrappers and scripts where it has them. Tool options change between versions: check a tool's `--help` rather than trusting remembered flags.

In every type:

- Name files so a reviewer can find a check without opening them: `ac-03-email-failure.png`, `r2-invalid-email.log`.
- Driver scripts you write (a browser script, a terminal tape, a request collection) are evidence too: save them next to what they produced.
- Start the slice from the cell's `workdir`, on a port or data store of its own, so nothing touches the main checkout or real data. Stop anything you started.

## web

- **Run it:** start the app the way the project documents (its dev or preview command) from the `workdir`, against test data. Wait for it to answer before driving it.
- **Drive it:** a real browser, through Playwright if the project or machine has it (prefer the project's own Playwright setup), otherwise Cypress or another browser automation tool that is available. Act through what a user sees: roles, labels and visible text, not internal selectors.
- **Capture:** a screenshot (`.png`) at each Then step, showing the message or state being asserted; a recording of each flow (`.webm`, `.mp4`, or a Playwright trace `.zip`). Take before and after screenshots for anything that changes what is displayed.
- **Work with what is installed; download nothing.**
  - If Playwright is installed globally rather than in the project, its test runner cannot find `@playwright/test` from your script's folder: run it with `NODE_PATH="$(npm root -g)"` set.
  - If Playwright's own browsers are not installed (it says to run `playwright install`), drive an installed browser instead by setting `channel: 'chrome'` (or `'msedge'`) in your config's `use` section.
  - If video recording fails because Playwright's video encoder is not installed, record a trace instead (`trace: 'on'`): the `trace.zip` it writes holds a screenshot and DOM snapshot for every action, and counts as the recording of the flow. Say in your report that it is a trace, not a video.
  - Keep your config, test scripts and output folder inside `evidence_dir`, and let Playwright start and stop the app (`webServer` in the config) so nothing is left running.
- **Also check, and note in the record:** the exact visible text of every message; that controls are reachable by keyboard and labelled; that the page works at a phone width; that a refusal leaves the displayed state unchanged.

## cli

- **Run it:** the built command from the `workdir`, in a clean temporary directory and environment.
- **Capture:** the terminal session. Use `vhs` (a `.tape` script producing a `.gif`) or `asciinema` (`.cast`) when available; otherwise a transcript `.log` holding each command, its standard output and standard error. Always write `exit-codes.json`: a list of `{"command": ..., "exit_code": ..., "check": "<ID>"}` for every command you ran, with the command exactly as it was run. `verify.py finish` checks that every scenario and rule has an entry. If no recording tool is installed, say in your report that the session is a plain transcript; the summary records which tools were available.
- **Also check:** `--help` output for the new command or flag; that errors go to standard error with a non-zero exit code; that a refusal writes nothing.

## api, rest, grpc

- **Run it:** start the service from the `workdir` on a spare port with test data, or call its handler through the project's own test server command.
- **Drive it:** `curl` for HTTP, `grpcurl` for gRPC, against the running service.
- **Capture:** for each check, a dump holding the request and the full response, including status and headers (`ac-01-create.json` or `.log`). Capture the data store's state before and after any check that asserts a side effect, or that asserts none, as `db-state-<ID>.md`.
- **Contracts:** compare each response with the contract file listed in the plan: every field and error the contract names, nothing it does not. `verify.py start` already checked the contract files are well formed and saved `contract-check.log`.
- **Load:** only if the spec states a time limit as an invariant, measure it (with `k6` if available, otherwise timed repeated calls) and save the numbers.

## desktop, mobile

- **Run it:** build and launch the app from the `workdir` in a simulator, emulator or a scratch user profile; never a real user's data.
- **Drive it:** the platform's automation: the iOS Simulator tools (`xcrun simctl`), Android `adb`, or OS-level input tools such as `cliclick` or `xdotool`.
- **Capture:** a screenshot (`.png`) of the window or screen at each Then step, and a recording (`.mp4`, `.mov`) of each flow. `xcrun simctl io` and `adb shell screenrecord` can record; on macOS `screencapture` can capture a window.

## library

- **Run it:** as a consumer would. Write a small driver script in `evidence_dir` that imports the package only through its public interface, the one in the plan's contract, and performs each check. Do not import internals, and do not reuse the builder's fakes: write your own stand-ins for outside services.
- **Capture:** the driver's transcript (`consumer-run.log`): for each check, the call made, the value returned or error raised, and the state before and after. Print each check's ID in the transcript so the record can point at it.
- **Also check:** that the public interface matches the contract file: every name it declares exists with that shape, and nothing extra is exported that the contract does not list. Save what you compared as `api-surface.txt`.
