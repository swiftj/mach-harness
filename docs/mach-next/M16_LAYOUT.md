# M16 layout: the window is the desk

Product Studio scrolled vertically for ever. Measured at a 1440 by 900 window, 26 of the app's 97 screens were taller than 2,000 pixels and the worst was 3,794. This note says why, the layout rules as built for three pilot screens, the shared pieces that carry them, where the build departs from the lead engineer's direction, and what every remaining screen needs. The style guide (`docs/mach-next/STYLE_GUIDE.md`) is unchanged and binding: no token, type step, component look, state shape or word was changed. This is a layout and information-hierarchy change only.

## 1. The problem and its causes

1. **Width was wasted.** Work screens stacked everything in one column 540 to 810 pixels wide while the right half of a 1440 window was empty.
2. **The top of every Shape page cost about 390 pixels** before any content: an ID line, a 30 pixel title, a two-line lead paragraph, then a six-step stepper with labels, status lines and a "Next" marker, and on Size and route a second stepper under it. A slice's specification spent about 400 pixels the same way (an ID line, a 40 pixel title, the outcome, the lifecycle path, the times, the acts, the banners, then two rows of tabs).
3. **Everything was open at once.** A screen with four parts showed all four in full, whichever one the person was on. On Size and route the act for the state (Settle O-2, Make the drafts) sat 1,600 to 2,700 pixels down.
4. **Reference detail had the same room as the thing to act on**: quoted brief lines under every mapped slice, explanatory paragraphs under every heading, all three route cards at full height.
5. **Dialogs grew to their limit without saying so.** The "ready to build" dialog spent its height on a long description and cut its body off with no sign that more was below.
6. **Documents are long by nature** (a slice's specification, a brief). That is fine when a person can see where they are and jump; the brief had no section list.

## 2. The rules, as built

These hold for every screen that adopts the layout. Apply them in this order.

### 2.1 The window is the desk

- At 1,024 pixels wide and up, and 620 pixels tall and up, a work screen fills the window's height and does not scroll as a page: the top bar (unchanged, with its breadcrumb and its saved state), one slim context row, then a work area whose panes scroll on their own.
- Narrower than 1,024 (the shell's own minimum width) or shorter than 620, the screen falls back to ordinary page scroll in one column: the narrow pane follows the wide one with a rule above it. Nothing is lost; the classes say so with `max-[1023px]:` and `[@media(max-height:619px)]:`.
- The page itself never scrolls sideways.

### 2.2 One slim context row

Two short lines, and a third only when the item has page tabs:

```
IDEA-006 Members pay fines online                                      [the page's acts]
Size and route  > About this step            ✓ Ideas — ✓ Explore — … — (5) Size and route  Several epics — 6 Look back
[Specification | Effects on shipped behaviour | Principles and policies | Design mocks]     (a slice only)
```

- Line one: what the item is (its ID as an identifier and its name, `body-sm` `ink-muted`), and at the right the page's acts, at most one primary.
- Line two: the page's one `h1`, set at `title-2` (the guide lets level and size differ; 8.10's interview header sets its `h1` at `title-3`), then "About this step", a closed disclosure holding the page's lead paragraph. At the right, where the item is on its path: the Shape stepper drawn as one line, or the slice's lifecycle path.
- Each line wraps when the window is too narrow, so at 1,024 the stepper moves under the title rather than being cut off. The row is 77 pixels tall at 1440 and 117 at 1024 on a Shape page, against about 390 before.
- A second stepper inside a step is never a second row: it becomes the structure of the parts (2.4).

**The one-line Shape stepper** (`features/shape/shell/ShapeStepper.tsx`, all six Shape steps): six 20 pixel numbered nodes joined by 16 pixel connectors, each a link with its name in `body-sm`. The current step is the accent (border, soft fill, `aria-current="step"`) and shows its status line beside its name in `caption` `ink-subtle`. Other steps show their status line in a tooltip on hover or focus, and always to assistive technology (it is in the link's name), so the tooltip holds nothing essential. The step that holds the engine's next step says "Next" in words, semibold `accent-ink`, and its node has a dashed accent ring (a shape, not only a colour). Done steps show a tick.

### 2.3 Two panes, used on purpose

- The **wide pane** holds the one thing the person is doing now: the parts of a work screen, or the document. Its content is capped at 60rem (`max-w-[60rem]`) and reading text inside it keeps the 68ch measure.
- The **narrow pane** holds what the person refers to while doing it: the check and its counts, what MACH counted and the route it names, the section list, the times. It is 22rem wide (19rem below 1,280), on `surface` with a 1px `line` rule at its left, the guide's document column (8.10) on the other side. It stays in view because it scrolls on its own.
- Never a second pane just to fill space. With nothing to refer to (Size and route before it is sized), the screen is one pane.
- Each pane is a `section` named by `aria-label`. While it has more than fits, it joins the tab order (`tabIndex=0`) so a keyboard can reach it and scroll it with the arrow, Page and Home/End keys; when it fits, it is not a tab stop. Focus is never held in a pane.

### 2.4 One part open at a time

- A screen with several parts shows each as a row: a numbered node when the parts are the steps of a path (done, current in the accent, or not reached, each also in words for assistive technology), the part's name in `title-3`, and one line in `body-sm` `ink-muted` that says the part's state in plain words: "Route: several epics", "1 new epic and 2 thin slices in build order", "1 outcome still to settle: O-2", "Settle O-2 first. Nothing is made while any outcome is unsettled."
- The part that needs the person is open on arrival; the others are closed; any can be opened, which closes the one that was open. When an act moves the journey on (a size, the last outcome settled, the drafts made), the part that now needs the person opens, as the visible result of the act.
- Nothing the person needs in order to decide is hidden: a closed part's summary carries its state, and anything blocking the next act is in a summary or above the parts (a map's blockers are a banner above them, never folded).
- Opening a part does not move the row that was pressed: the pane scrolls by however much the part above it closed.
- A closed part stays in the page (`hidden`), so what it holds keeps its state (a result shown after an act, a dialog's selection).
- The part summaries are worked out by pure functions next to the screen's model (`sizeSummary`, `mapSummary`, `settleSummary`, `applySummary` in `features/shape/route/model.ts`), from the engine's answers only, and unit-tested.

### 2.5 Reference detail folds

- Quoted source lines, long explanations and secondary lists go behind a disclosure whose label says what and how much: "Rests on 2 lines of the brief", "What each count is made of", "What high risk means", "The text as written, with its line numbers".
- What a person needs in order to act never folds: the act itself, its blocker, a check's findings, the builders' question.
- The two routes the rule did not choose are one line each with when the rule would choose them; the chosen route is the card.
- Explanatory sentences under a heading move into the part they explain, in `body-sm` `ink-muted`, or into "About this step".

### 2.6 Dialogs never exceed the window

- In `@mach/ui`'s `DialogContent` (so every dialog in both apps): the title and the close button stay at the top and the buttons at the bottom; the description and the body scroll between them. The panel keeps the guide's limits (top at 12vh, at most 76vh).
- When the body has more than fits, it becomes a named region (`"<title>, details"`) that joins the tab order so it can be scrolled from the keyboard, and a hairline appears at its top or bottom edge to say there is more that way. When it fits, it is plain text and nothing changes.
- The description moved from the fixed header into the scrolling part. Its distance from the title is the same 6 pixels as before, so short dialogs look exactly as they did.

### 2.7 Documents keep their length, with a section list beside them

- A document (a slice's specification, a brief) keeps its natural length in the wide pane.
- The narrow pane carries the list of its sections ("On this page", "In this brief"): each a button that moves to the section and gives its heading focus; the section at the top of the pane is marked (`aria-current="location"`, a 2px `ink-muted` bar, a sunken fill and semibold: never colour alone), and a section the person jumped to stays marked until they scroll on. Each item may carry a short count of findings in `danger-ink` or `warning-ink` with its words ("1 problem", "2 warnings").

### 2.8 What the pilot measured

At 1440 by 900 the page does not scroll on any of the three pilot screens, and the act for every state is in view on arrival. At 1024 by 768 the same holds. Full figures are in the review page (`video/out/layout-pilot/before-after.html`, git-ignored) and in section 6.

## 3. The shared pieces

All in `web/apps/product-studio/src/shared/layout/`, except the dialog rule, which is in `web/packages/ui/src/components/dialog-body.tsx` and used by `DialogContent` itself (nothing to call).

### 3.1 `WorkScreen`, `ContextRow`, `WorkPanes`, `WorkPane`, `OnePane` (`WorkScreen.tsx`)

```tsx
<WorkScreen
  header={
    <ContextRow
      identity={<><ArtifactId plain>{row.idea_id}</ArtifactId><span>{row.title}</span></>}
      title="Size and route"
      about="MACH counts what the brief touches and names a route by a fixed rule. You decide what is created."
      trail={<ShapeStepper row={row} here="route" ideasOnBoard={n} />}
      actions={<Button variant="primary">…</Button>}          // optional, at most one primary
      below={<SliceSections sliceId={id} />}                   // optional page tabs
    />
  }
>
  <WorkPanes>
    <WorkPane label="Sizing and the map">…the thing being done…</WorkPane>
    <WorkPane side label="The route and what MACH counted">…what to refer to…</WorkPane>
  </WorkPanes>
</WorkScreen>
```

- `WorkScreen` must be the screen's root inside `<main>` (it takes the full height). Loading, error and empty states that come before the data may keep using `Page`; inside a work screen, put them in `<OnePane label="…">`.
- `WorkPane width`: `"wide"` (60rem, the default, beside a narrow pane), `"content"` (the old `Page width="wide"` maximum, for a body moved in whole), `"reading"`.
- `OnePane` is `WorkPanes` with one `WorkPane`.
- A Shape page gets all of this from `IdeaStepFrame`: pass `layout="panes"` and return `<WorkPanes>` from the render function; without it, the page's body is put in one scrolling pane, as it was laid out before (that is how Explore, The case and Look back run today).

### 3.2 `Parts` and `Part` (`Parts.tsx`)

```tsx
const [open, setOpen] = useState<string | null>(partForStep(step));
<Parts label="Sizing and the map" open={open} onOpenChange={setOpen}>
  <Part id="size" number={1} place="done" name="Size it" summary={sizeSummary(route, gate)}>…body…</Part>
  <Part id="settle" number={3} place="current" name="Settle what no slice carries" summary="1 outcome still to settle: O-2">…</Part>
  <Part id="apply" number={4} place="later" name="Make the drafts" summary="After the map" />   // no body: a row that cannot open
</Parts>
```

- `Parts` is controlled: the screen decides which part opens, from the engine's state. Each `Part` renders an `h2` (or `h3` with `headingLevel={3}`) holding a button with `aria-expanded` and `aria-controls`, and a `region` named by that button.
- `number` and `place` are optional: leave them out when the parts are not steps of a path.
- `status` takes a pill (word, shape and tone) shown beside the summary.
- A part's body does not repeat the part's name as a heading; sub-headings inside it start one level down.

### 3.3 `Fold` (`Fold.tsx`)

```tsx
<Fold label={`Rests on ${n} lines of the brief`}>…the quotation…</Fold>          // quiet: a line with a chevron
<Fold boxed label="What each count is made of">…</Fold>                            // the guide's disclosure look (7.10)
```

A real button with `aria-expanded`; the detail follows it in reading order and stays in the page while closed. Use it in place of `@mach/ui`'s `Disclosure` (a `details` element) on screens that adopt the layout, so every disclosure behaves the same way.

### 3.4 `SectionNav` (`SectionNav.tsx`)

```tsx
<SectionNav
  label="Sections of the brief"
  title="In this brief"
  items={sections.map((s) => ({ id: `brief-section-${s.id}`, label: s.heading, note: <span className="text-caption font-semibold text-danger-ink">1 problem</span> }))}
  onGo={(id) => …}          // optional: when a section sits behind a tab that must be chosen first
/>
```

Each `id` is the id of the section element; its first heading takes focus on a jump. `useCurrentSection` and `goToSection` are exported for a screen that needs the behaviour without the list.

### 3.5 The dialog rule (`@mach/ui`, `dialog-body.tsx`)

Nothing to do: every `DialogContent` and `ConfirmDialog` has it. Do not set a height on a dialog's body, and do not put a second scrolling box inside one; a long list or quotation inside a dialog scrolls with the body.

## 4. Where the build departs from the direction, and why

1. **The narrow pane on Size and route also holds the route itself**, not only the counts. After sizing, the next part to open is the map, so the route the rule named (and the engine's sentence of why) would otherwise sit inside a closed part. The route follows from the counts, so it reads as reference: the narrow pane shows the route, its pill and why; the "Size it" part shows the three routes (the chosen one as the card, the other two one line each) and the way back to the brief.
2. **The second stepper did not become a list in the narrow pane; it became the parts.** The four parts are the four steps of the journey (Size it, Map, Settle what no slice carries, Make the drafts), each with its number and its place, so one structure says both where the person is and what each part holds. The page order changed with it: the map now comes before coverage, as the journey runs.
3. **The context row has two lines, not one.** One line could not hold an ID, a title, a six-step stepper and acts at 1,024 without cutting words. Two short lines (identity and acts; title and path) are 77 pixels on a Shape page at 1440, and wrap cleanly at 1,024.
4. **The `h1` is set at `title-2`**, not the page-title step, following the guide's own interview header (8.10), which sets its `h1` at `title-3`. It is still the one `h1`.
5. **A slice's specification moved its outcome sentence and its times.** The outcome under the title repeated the Summary section's "Outcome" row word for word, so the header no longer shows it; the times moved to the narrow pane under the section list. The acts moved up into the context row so the act for the state is always at the top.
6. **Panes join the tab order only while they scroll.** A pane that fits adds no tab stop, so the keyboard path through a short screen is unchanged.
7. **The dialog rule moved the description into the scrolling part.** In the "ready to build" dialog the engine's note is long; keeping it fixed left about 220 pixels for the body at 768. It now scrolls with the body, and the title and Done stay in view.
8. **A section jumped to stays marked.** The last sections of a document can never reach the top of the pane, so marking by scroll position alone marked the last section after a jump to the one before it.

## 5. What is still not good enough

- **Two rows of tabs on a slice.** The slice's pages (Specification, Effects, Principles and policies, Design mocks) and the specification's own views (Specification, Why, Source) are both tab rows, one above the other. It was so before; it is more visible now that both sit near the top. The specification's views would read better as part of the narrow pane's section list, which already jumps to "Why this slice".
- **The breadcrumb truncates at 1,024** ("Sh…", "Members pay fines…"). It did before. The context row now carries the item's name, so the breadcrumb could drop its last two steps on narrow windows.
- **The wide pane leaves 80 to 130 pixels empty at its right at 1440**, because its content is capped at 60rem for the reading measure. Acceptable; a wider cap would make rows of text too long.
- **The "ready to build" dialog is still mostly words**: its description is the engine's note and long. The dialog now scrolls clearly, but the note itself is the next thing to shorten, and that is the engine's text.
- **Fixture disagreement, not layout:** on Size and route the stepper says "Not sized yet" while the page shows a route, because the board fixture and the map-status fixture are different engine runs. It was the same before.

## 6. Pilot measurements

The page's scroll height before (the existing full-page capture's height at 1440, our own capture of the unchanged code at 1024 and for the draft specification) and after (the page no longer scrolls: it is the window), with how much each pane holds and where the act for the state is.

| Screen and state | Window | Page before | Page after | Panes after (content in view) | Act before | Act after |
|---|---|---|---|---|---|---|
| Size and route: sized, several epics, no map yet | 1440x900 | 1,618 | 900 | 763 in 763; 763 in 763 | none on the page | none on the page |
| Size and route: an outcome no slice carries | 1440x900 | 2,757 | 900 | 763 in 763; 763 in 763 | at 1,596, below the window | at 638, in view |
| Size and route: everything settled | 1440x900 | 2,729 | 900 | 763 in 763; 763 in 763 | at 2,640, below | at 513, in view |
| Size and route: the drafts made | 1440x900 | 2,928 | 900 | 763 in 763; 763 in 763 | at 2,704, below | at 513, in view |
| The brief: passes its check | 1440x900 | 2,025 | 900 | 1,649 in 763; 763 in 763 | at 673 | at 425 |
| The brief: a finding | 1440x900 | 2,187 | 900 | 1,811 in 763; 1,176 in 763 | at 411 | at 180 |
| Specification: a draft slice | 1440x900 | 3,794 | 900 | 3,158 in 709; 709 in 709 | at 260 | at 68 |
| Specification: the ready dialog | 1440x900 | 3,794 | 900 | as above; the dialog body scrolls | Done at 735 | Done at 735 |
| Size and route: sized, several epics | 1024x768 | 1,618 | 768 | 665 in 593; 630 in 593 | none | none |
| Size and route: an outcome no slice carries | 1024x768 | 2,757 | 768 | 736 in 593; 650 in 593 | at 1,596, below | at 728, in view |
| Size and route: everything settled | 1024x768 | 2,729 | 768 | 593 in 593; 650 in 593 | at 2,640, below | at 551, in view |
| Size and route: the drafts made | 1024x768 | 2,928 | 768 | 596 in 593; 650 in 593 | at 2,704, below | at 551, in view |
| The brief: passes its check | 1024x768 | 2,061 | 768 | 1,685 in 593; 760 in 593 | at 673 | at 463 |
| The brief: a finding | 1024x768 | 2,267 | 768 | 1,847 in 593; 1,216 in 593 | at 453 | at 260 |
| Specification: a draft slice | 1024x768 | 4,278 | 768 | 3,874 in 577; 682 in 577 | at 260 | at 68 |
| Specification: the ready dialog | 1024x768 | 4,278 | 768 | as above; the dialog body scrolls | Done at 619 | Done at 619 |

## 7. Every remaining screen

Kinds: **work screen** (several parts, panes, one open), **document** (long by nature, section list beside it), **board** (many items side by side, scrolls inside its own region), **list** (a column of rows; may stay a page that scrolls, but takes the context row and folds its reference detail). Shape's three other steps already sit inside the new frame (one pane, their old bodies); they are listed with what they still need.

| Screen | Route | Kind | What it needs |
|---|---|---|---|
| Project home | `/` | list | Keep page scroll (it leads everywhere). Fold each epic's "Done when" criteria behind a count; the "Carry on" block is the one act and stays first. |
| First run | `/` (no project yet) | list | Nothing beyond the context row; it is short. |
| Shape: ideas board | `/shape` | board | Columns by stage in one region that scrolls sideways inside itself (as 8.9); the add act in the context row. |
| Shape: Explore | `/shape/ideas/:id/explore` | work screen | Already in the frame. Conversation in the wide pane; "Where this idea came from" and "What MACH looked up" in the narrow pane, each group folded with its count; the request's own words folded. |
| Shape: The case | `/shape/ideas/:id/case` | work screen | Already in the frame. Parts: the case, the verdict, publishing; the case's check and its unanswered questions in the narrow pane. |
| Shape: Size and route | `/shape/ideas/:id/route` | work screen | Done (pilot). |
| Shape: The brief | `/shape/ideas/:id/brief` | document | Done (pilot). |
| Shape: Look back | `/shape/ideas/:id/look-back` | work screen | Already in the frame; 3,246 pixels in its pane. Parts per item to look back on, with the chain line as the summary; the record of what was decided in the narrow pane. |
| Shape: Change what exists | `/shape/change` | work screen | The rule and its connections in the narrow pane; the change form as the one part. |
| Slice specification | `/slices/:id` | document | Done (pilot). Next: fold the Specification / Why / Source views into the section list (section 5). |
| Slice interview | `/slices/:id/interview` | work screen | Already two panes (8.10); take `WorkScreen` and `ContextRow` for its header, and `SectionNav` for "The slice so far". |
| Effects on shipped behaviour | `/slices/:id/effects` | list | Slice context row with page tabs (as the specification); each effect a row with its rule and moved-since note, detail folded. |
| Principles and policies (slice) | `/slices/:id/policies` | work screen | Parts per concern (open, accepted, followed) with the open one first; the accept dialog is unchanged. |
| Design mocks (slice) | `/slices/:id/mocks` | board | Pictures in a grid inside the wide pane; the "waiting for its pictures" panel and file names in the narrow pane. |
| From the PRD (slice) | `/slices/:id/prd` | document | Section list of the drafted answers; the PRD's quoted lines folded with their count, as the map's are. |
| PRD list | `/prds` | list | Context row only. |
| A PRD | `/prds/:id` | work screen | Same shape as Size and route (it was its model): coverage, the map, settling and making the drafts as parts; counts in the narrow pane; quoted PRD lines folded. |
| How an epic works today | `/epics/:id/today` | document | Section list of its rules by slice in the narrow pane; each rule's connections folded; change links stay in view. 1,933 pixels before. |
| Product principles | `/principles` | work screen | Parts: the principles, the unpublished changes, publishing; the publish state and any newer set in the narrow pane. |
| Policy packs | `/policies` | list | Each pack a row with its state; a malformed pack's problems never folded. |
| Vision and outcomes | `/vision` | document | Section list (vision, outcomes, epics); the epic sheet is unchanged. |
| Roadmap | `/roadmap` | board | The graph is already full height (`Page width="full"`); take the context row only. |
| Decisions (inbox) | `/inbox` | list | Group rows (questions, newer versions, requests) as parts with counts in their summaries; the one needing an answer open. |
| GitHub activity | `/github` | list | Context row; long histories fold by day. |
| Jira export | `/jira` | work screen | Parts: export, keys back, the ledger; the ledger's rows in the narrow pane or folded with a count. |
| Not found | `*` | list | Nothing. |

Unusual cases to watch: the interview and Explore hold live conversations whose newest turn must stay in view (scroll the conversation pane to its end on a new turn, never the page); the roadmap graph and the mocks grid need their own focusable scrolling regions; every dialog already follows 2.6.
