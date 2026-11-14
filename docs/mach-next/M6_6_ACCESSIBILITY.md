# M6.6 Control Tower: accessibility checks

No WCAG conformance is claimed. No screen-reader session was run. The first part is what a script could
measure; the second is what only a person can check.

## Part 1. Automated results

Environment: `mach-observer` built from commit `d99edb4` (Control Tower embedded), serving a copy of the finished
real-run project (`eng`, history only, no MACH script run), on `127.0.0.1`. Playwright with Chromium 145 (checks
1 to 8) and WebKit 26.0 (checks 1, 2, 8), axe-core 4 with tags wcag2a, wcag2aa, wcag21a, wcag21aa. Views: Atlas,
Blueprint, Timeline, the seven Analytics areas, and the Analytics Rows drawer. Each check was run once on a
1280 x 800 viewport unless stated. The scripts live in scratch, not in the repository (they reuse the e2e
helpers' pattern; a copy of the runner and the JSON results is in the lead's scratch folder under
`agents/a11y/`).

| # | Check | Result | Counts and elements | Severity |
|---|---|---|---|---|
| 1 | axe, light and dark, 11 states each | FAIL, 2 rules | `label-content-name-mismatch` (serious): 1 node in every state, both themes, both engines: the Factory-status button in the header (`button.border-info-line`, `aria-label` "The Factory is not enabled on this machine. Details" while its visible text does not start the same way). `scrollable-region-focusable` (serious): 1 node, `.an-sheet`, Analytics "Improvement opportunities" only (scrolls, has no focusable content, `tabindex=-1`). Every other rule: 0. | should-fix both (the first is on every screen) |
| 2a | Keyboard: Tab reach, order, trap | PASS with notes | Floor 34 stops, Timeline 42, Analytics 42; first stop is the skip link (floor, Timeline and Analytics each have their own); no trap; focus leaves the page at the end. The two "not reached" controls per view are the Light and Dark theme radios: a native radio group is one stop (the checked one), so this is not a defect. | note |
| 2b | Visible focus indicator | FAIL, 2 stops | Computed outline or shadow absent on 8 stops; pixel comparison (screenshot of the element's box plus 8 px, focused against not) found no change for: floor `div[role=slider]` "Playhead over the history..." and floor `div` "Execution tracks. Left and right...". The Atlas div, the timeline resize button, and the Analytics chart marks (`g`) have no computed ring but their pixels change on focus (ring drawn in SVG or canvas). The Timeline workspace's "Tracks" and "Label column width" stops have no computed ring and were not pixel-tested. | must-fix (playhead slider, docked tracks: WCAG 2.4.7); should-verify (Timeline tracks) |
| 2c | Workspace keys, help sheet, openers | PASS | 1, 3 and 4 switch the hash; L and Escape raise no error; the help sheet opens by button and by `?`, focus goes to its Close button, Escape closes it and focus returns to the Keyboard shortcuts button (by `?` it returns to `main#stage`, as nothing was focused). Inspector toggle: focus stays on the toggle button. Rows drawer: focus goes into the drawer and Escape returns it to the "All 2 visits" opener. | none |
| 2d | Where focus lands after a workspace switch | recorded | By key (from no focus): the body, so the next Tab starts at the top. By Enter on the workspace radio: focus stays on that radio. The new workspace announces itself in a polite live region. A person using a screen reader is not moved into the new view. | note |
| 3 | Names and text alternatives | PASS with one gap | Every visible `svg`, `canvas` and `role=img` is named or sits in a named ancestor (0 unnamed, 10 views). Analytics: 16 figures, each with a Table button; 1 figure on Factory Pulse has no name (`figure` without `aria-label` or `figcaption`). Atlas and Blueprint: the structure is a named `div` (an `aria-label` that begins "Factory Atlas, Live Factory: ...") with canvases behind it; the Timeline tracks are a described `role=application` plus a table. Live regions: polite throughout (status badge, announcer, `role=status`); no assertive region and no `role=alert` found on these screens. The source-state change itself (Live to Stale to Disconnected) was not provoked, so its announcement is not confirmed. | should-fix (Pulse figure name); not tested (source-state announcement) |
| 4 | Reduced motion | PASS | `prefers-reduced-motion: reduce` matched; 0 running animations or transitions longer than 10 ms in all 10 views, and after Space and after a step. Space holds playback and the status says "Holding ...; events keep arriving". Only hold and step were checked: the source was a finished history, so playing through was not exercised. | none |
| 5 | Forced colours and state without colour | PASS in DOM, FAIL by code reading on the Timeline canvas | `forced-colors: active` matched. The DOM has no execution state expressed by colour alone (state elements carry text or an svg mark; the "closed" values are disclosure state). Floor: from `packages/ui/src/factory/grammar.ts` every state and condition has its own mark shape (ring-dashed, ring-working, disc-tick, disc-cross, ring-hourglass, ring-dot, octagon-bar, ring-cut, ring-last-seen, ring-query), so none relies on colour alone. Timeline canvas: from `timeline/render/draw.ts`, a span's body and cap depend on its family, and pass, fail, halt and neutral differ only in ink (`toneOf`, `toneInk`); the failed label is also coloured. The outcome is in words in the track table and the inspector. The canvas is not adapted to forced colours (colours are read from CSS variables). | should-fix (pass against fail on the Timeline canvas bar) |
| 6 | Reflow | FAIL at 320 | 1280 px: no horizontal document scroll anywhere; the Workspaces nav is 67 px wider than the viewport on the Atlas and Blueprint (`nav[aria-label=Workspaces]`, right edge 1347) and the header clips it. 320 px (document scroll none, because the frame clips): header controls lie beyond the right edge and cannot be seen or clicked: Theater (right 348), Show the inspector (384), Keyboard shortcuts (420); on the Timeline also Following, Previous/Next failure, Jump, More time controls, Table (up to 535); the inspector sits at x 320 to 608, wholly off screen on every view; Analytics keeps its area nav and sheet in the frame. | must-fix (WCAG 1.4.10: controls lost, not scrollable) for header and inspector at 320; should-fix (nav at 1280) |
| 7 | Text spacing (1.4.12 values) | FAIL, text clipped | After the stylesheet: `mach-frame` root scrolls horizontally on the Atlas (1335 wide in 1280); heading `h1.truncate` (project name, `max-w-[45%]`, 34 px of 19) in the header; single-line `truncate` spans in the Atlas ticket and event list (`LOCAL-001 ...` 508 of 209, `SLICE-002 ...` 282 of 108, `Line supervisor scheduling...` 279 of 117, `2 tracks so far...` 216 of 151); Analytics: `span.an-num.truncate` (441 of 408, the period caption); Timeline: the controls bar `div.flex.h-10.overflow-x-auto` (1001 of 936, scrolls), the label-column rows (`WAVE-0012 rejections +, ...` 154 of 146, similar for `SLICE`, `LOCAL`, `opus` 27 of 22) and `span` "cells in a station, includin..." 359 of 167. Visually hidden (`sr-only`) text excluded. Truncation exists before the spacing is applied; the spacing makes it worse. | should-fix (truncated names with no full-text route on hover or focus were not checked) |
| 8 | Narrow laptops and resize | PASS | 1280 x 800 and 1100 x 700, Chromium and WebKit: 0 overlapping interactive controls among 24 to 65 controls per view, no horizontal document scroll; 1440 to 1100 to 1440 on the Atlas, Timeline and Pulse: 0 overlaps, no scroll, control counts return. At 1100 the Waits button on the Timeline right edge 211 is a label inside a scrolled region, not clipped. | none |
| 9 | WebKit | PARTIAL | Checks 1 and 8: same results as Chromium. Check 2: with plain Tab, WebKit reaches only elements with `tabindex` (5 to 6 stops per view), because Safari's default skips buttons and inputs; with Option+Tab the walk equals Chromium's (34, 42, 42 stops, the same missing ring list). Checks 3 to 7 were not run in WebKit. | note |

Not tested by a script: the Atlas and Blueprint reading order for a screen reader, the live announcements of
source-state changes, high-contrast with a real operating-system setting (only the CSS media query was
emulated), and the colour contrast of canvas drawing (the M6.3 and M6.5 documents hold the contrast results for
the Timeline and Analytics).

One tooling note: the observer process was stopped by something else on the shared machine twice during the
run; the runner now starts and stops its own observer for each run.

## Part 2. Manual checks still required (about 20 minutes)

No screen-reader session, no real zoom, no real Safari and no increased-contrast setting were used above.
Run these with a person at the machine; record pass or fail for each.

1. VoiceOver with Chrome, floor (3 minutes). Start at the top with VO+Right. Listen for: the skip link
   "Skip to the factory view"; the Workspaces group with the current workspace named as selected; "Factory Atlas,
   Live Factory" with a summary that says what is on the floor (not "group" or "canvas"); each station, ticket
   and state spoken as words ("Failed", "Waiting for a person"), never as a colour; the inspector as a complementary
   region named "Inspector: ..."; the transport buttons with their meanings; the status badge announcing a
   change when the source goes stale or disconnects (stop the observer, wait, restart it).
2. VoiceOver with Chrome, Timeline (4 minutes). Press 3. Listen for: the new workspace announced; the tracks
   described as one application region with its keys in the description; the table alternative reachable with
   its row and column headers; spans spoken with kind, name, start, end and outcome (or "outcome not known");
   opening the inspector and closing it with Escape returning to the opener; Table and Filters buttons named.
3. VoiceOver with Chrome, Analytics (4 minutes). Press 4, then take each area. Listen for: one heading per area;
   each chart announced with its name and a one-sentence summary; the Table button pressed state; chart marks
   read by arrow keys with their values; "not recorded" and "sparse" read as states; the Rows drawer opening
   with focus inside and Escape returning to the opener; the Pulse figure with no name (above) spoken as "figure".
4. VoiceOver with Safari, the same three workspaces (4 minutes). Turn on Safari "Press Tab to highlight each
   item", or use Option+Tab. Listen for the same items, and check that the focus ring is visible on every stop,
   especially the floor's playhead slider and docked tracks, and the Timeline tracks (the stops above).
5. Real 400% zoom (3 minutes). Browser window at 1280 wide, zoom to 400% (equivalent of 320 CSS px). On the
   floor, Timeline and Analytics, find the Theater, inspector, keyboard-help and theme controls and the
   Timeline's Table and Jump controls. Can each be reached and seen without a horizontal scroll bar? The
   scripted result says the header controls and the inspector are off screen: confirm and note the usable
   workaround, if any.
6. Increased contrast and forced colours (2 minutes). macOS: System Settings, Accessibility, Display, Increase
   contrast on; and in Chrome, Windows high contrast if a Windows machine is at hand. Check that borders,
   focus rings, state marks (shapes) and the Timeline canvas bars stay distinguishable, and that the Timeline's
   pass and fail bars can be told apart without colour.
