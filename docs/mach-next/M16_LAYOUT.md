# M16 layout: the window is the desk

Product Studio scrolled vertically for ever. Measured at a 1440 by 900 window before this work, 26 of the app's 97 screens were taller than 2,000 pixels and the worst was 3,794. This note describes the layout as finished: why it was needed, the rules every screen follows, the shared pieces that carry them, the "more below" rule, and every screen with its kind and its measured heights. The style guide (`docs/mach-next/STYLE_GUIDE.md`) is unchanged and binding: no token, type step, component look, state shape or word was changed for the layout. It is a layout and information-hierarchy change only.

It was built in three passes: a pilot on three screens (Size and route, The brief, a slice's specification), a rollout by area (seven areas, one engineer each), and a finishing pass that closed the shared-piece gaps the rollout reported, added the "more below" rule, made the seven areas one product and measured every screen again.

## 1. The problem and its causes

1. **Width was wasted.** Work screens stacked everything in one column 540 to 810 pixels wide while the right half of a 1440 window was empty.
2. **The top of every Shape page cost about 390 pixels** before any content: an ID line, a 30 pixel title, a two-line lead paragraph, then a six-step stepper, and on Size and route a second stepper under it. A slice's specification spent about 400 pixels the same way.
3. **Everything was open at once.** A screen with four parts showed all four in full, whichever one the person was on. On Size and route the act for the state sat 1,600 to 2,700 pixels down.
4. **Reference detail had the same room as the thing to act on**: quoted lines under every mapped slice, explanatory paragraphs under every heading, every route at full height.
5. **Dialogs grew to their limit without saying so.**
6. **Documents are long by nature** (a slice's specification, a brief). That is fine when a person can see where they are and jump.

## 2. The rules

These hold for every screen. Apply them in this order.

### 2.1 The window is the desk

- At 1,024 pixels wide and up, and 620 pixels tall and up, a screen fills the window's height and does not scroll as a page: the top bar (unchanged), one slim context row, then a work area whose panes scroll on their own.
- Narrower than 1,024 (the shell's own minimum width) or shorter than 620, the screen falls back to ordinary page scroll in one column: the narrow pane follows the wide one with a rule above it, and a pane's header is an ordinary first block. Nothing is lost and there is no half-way state: either every pane scrolls on its own, or the page scrolls and no pane does. The classes say so with `max-[1023px]:` and `[@media(max-height:619px)]:`.
- The page itself never scrolls sideways. Wide content (a board, a table) scrolls sideways inside its own region.

### 2.2 One slim context row

```
IDEA-006 Members pay fines online                                      [the page's acts]
Size and route  > About this step            ✓ Ideas — ✓ Explore — … — (5) Size and route — 6 Look back
[Specification | Effects on shipped behaviour | Principles and policies | Design mocks]     (a slice only)
```

- Line one: what the item is (its ID as an identifier and its name, `body-sm` `ink-muted`), and at the right the page's acts, at most one primary.
- Line two: the page's one `h1`, set at `title-2`, then a closed disclosure holding the page's lead paragraph: "About this step" on a Shape step, "About this page" everywhere else. At the right, where the item is on its path: the Shape stepper drawn as one line, or the slice's lifecycle path.
- A page with nothing to name above its title (Product principles, Policy packs, Jira, the roadmap) has no line one: its acts sit at the right of the title line, so the row is one line.
- Each line wraps when the window is too narrow, so at 1,024 the stepper moves under the title rather than being cut off.
- A second stepper inside a step is never a second row: it becomes the structure of the parts (2.4).

**The one-line Shape stepper** (`features/shape/shell/ShapeStepper.tsx`): six 20 pixel numbered nodes joined by 16 pixel connectors, each a link with its name in `body-sm`. The current step is the accent (border, soft fill, `aria-current="step"`) and shows its status line beside its name in `caption` `ink-subtle`. Other steps show their status line in a tooltip and always to assistive technology. The step that holds MACH's next step says "Next" in words, and its node has a dashed accent ring. Done steps show a tick.

### 2.3 Where a screen's acts sit

- **The page's acts are in the context row**: acts that belong to the page as a whole and not to one part's form (Add an idea, Make the case, Back to the conversation, Publish the changes, Mark ready to build, Attach a picture, Accept the drafted answers, Start a slice, Refresh). A screen whose acts are only known inside its body (a Shape step drawn by `IdeaStepFrame`) writes them where it knows them with `ContextActs`; they appear in the row.
- **A part's act stays at the foot of that part**, next to what it submits (Record the verdict, Record the look back on O-1, Settle O-2, Size IDEA-006, Make the drafts). When that part opens on arrival, its pane is brought to it so the act is in view (2.5).
- The project home is the one list whose act is in the pane: its "Carry on" block is the first thing in it.

### 2.4 Two panes, used on purpose

- The **wide pane** holds the one thing the person is doing now. Its content is capped at 60rem and reading text inside it keeps the 68ch measure.
- The **narrow pane** holds what the person refers to while doing it: the check and its counts, the route, the section list, the publishing state, the keys at a glance. It is 22rem wide (19rem below 1,280), on `surface` with a 1px `line` rule at its left. Its headings are `title-3`, like every pane's.
- **Never a second pane just to fill space.** With nothing to refer to, the screen is one pane; with little to refer to, it goes under the main content in the same pane (Effects on shipped behaviour puts what the check read under its rows).
- The guided question screen (the slice interview, guide 8.10) uses the guide's own columns: the question `1.15fr` and the document beside it `minmax(22rem, 1fr)`, the document column with 40px padding.
- Each pane is a named region. While it has more than fits, it joins the tab order so a keyboard can reach it and scroll it; when it fits, it adds no tab stop. Focus is never held in a pane.

### 2.5 One part open at a time

- A screen with several parts shows each as a row: a numbered node when the parts are the steps of a path (done, current in the accent, or not reached, each also in words for assistive technology), the part's name in `title-3`, and one line in `body-sm` `ink-muted` saying the part's state.
- **The summary's pattern is the same everywhere**: what is there and how many, then what is left to do, joined by commas, in a sentence: "Route: several epics", "1 outcome still to settle: O-2", "1 epic, 2 slices, 1 slice with a key of its own", "Told as the customer would hear it, with 3 hard questions: 2 answered, 1 left unanswered on purpose". No middle dots, no counts in brackets. Summaries are worked out by pure functions next to each screen's model, from MACH's answers only, and unit-tested.
- The part that needs the person is open on arrival; the others are closed; opening one closes the one that was open. When an act moves the journey on, the part that now needs the person opens.
- **The open part is brought into view.** On arrival, and when an act opens the next part, the pane scrolls just enough to show the whole part, or its row at the top when it is taller than the pane; a part that marks its own act (`data-part-act`) is scrolled on until that act is in view. Opening a part by hand never moves the row that was pressed.
- Nothing the person needs in order to decide is hidden: a closed part's summary carries its state, and anything blocking the next act is above the parts or in the part's `attention` slot, which stays in view whether the part is open or closed.
- A closed part stays in the page (`hidden`), so what it holds keeps its state.

### 2.6 Reference detail folds

- Quoted source lines, long explanations and secondary lists go behind a fold whose label says what and how much: "<What>: <count>" ("Done when: 2 criteria", "Files that could not be read: 1", "File names: 4", "What is already wanted: 2") or a sentence with the count in it ("Rests on 5 lines of the PRD", "The whole conversation: 6 messages"). A fold that holds a single explanation says what it explains ("What high risk means", "Why it went to a folder").
- A folded group that is a section of the page keeps its heading (`Fold heading={3}`).
- **Never folded**, on any screen: the act itself, its blocker, a check's findings, the builders' question, an open policy concern, a malformed pack's reasons, a refused Jira row, the "waiting for its pictures to be committed" notice, a stale verdict's warning, a map's blockers. `web/apps/product-studio/test/layout-equal-and-unfolded.test.mjs` holds the last six, with the equal weight of the verdict choices, the look-back results and accepting a policy concern.

### 2.7 More below

Every box that scrolls on its own says when it has more than it shows, the same quiet way. It follows the pilot's dialog body:

- **A dialog's body and any box inside a pane** (a board, a wide table, the chain of a look back): a 1px hairline in `line` at each edge where more is hidden (top, bottom, left or right), drawn on a border that is otherwise transparent, so nothing moves when it appears. A framed box (a table) takes the stronger `line-strong` on that side.
- **A pane**, whose bottom edge is the window's own, where a hairline alone is lost: the hairline carries two quiet words at its right, "More below" and a down chevron, in `caption` `ink-subtle` on the pane's own ground. It hangs from a zero-height strip held at the pane's foot, so it takes no room and covers nothing for long; it is gone when the pane reaches its end.
- It is never colour alone: the line is a shape and the pane's mark is in words. Nothing animates (reduced motion has nothing to remove). The mark is hidden from assistive technology, which reads the whole pane; the region's name and its tab stop are what a keyboard user meets.
- A box has the mark only while it has more to show; a box whose content fits has no mark, no region role and no tab stop.
- One helper decides it for both apps: `useScrollEdges` in `@mach/ui` (`web/packages/ui/src/lib/scroll-edges.ts`).

### 2.8 Dialogs never exceed the window

- In `@mach/ui`'s `DialogContent` (every dialog in both apps): the title and the close button stay at the top and the buttons at the bottom; the description and the body scroll between them under the "more below" rule. The panel keeps the guide's limits (top at 12vh, at most 76vh).
- Do not set a height on a dialog's body, and do not put a second scrolling box inside one.

### 2.9 Documents keep their length, with a section list beside them

- A document (a slice's specification, a brief, how an epic works today, vision and outcomes, a slice's drafted answers from a PRD) keeps its natural length in the wide pane, and the narrow pane carries the list of its sections ("On this page", "In this brief"): each a button that moves to the section and gives its heading focus. The section at the top of the pane is marked (`aria-current="location"`, a 2px bar, a sunken fill and semibold: never colour alone).
- On a slice, the specification's own views (Why this slice, Source) are items in that list, so a slice has one row of tabs.

### 2.10 Boards

A board (the ideas board) puts its columns side by side in one region that fills the rest of the window and scrolls on its own, down and sideways, with each column's name and count kept in view. Its columns are narrow enough that all five fit at 1,024; a wider column set scrolls sideways inside the region, under the "more below" rule.

## 3. The shared pieces

All in `web/apps/product-studio/src/shared/layout/`, except where said.

### 3.1 `WorkScreen`, `ContextRow`, `ContextActs` (`WorkScreen.tsx`)

```tsx
<WorkScreen
  header={
    <ContextRow
      identity={<><ArtifactId plain>{row.idea_id}</ArtifactId><span>{row.title}</span></>}   // optional
      title="Size and route"
      about="MACH counts what the brief touches and names a route by a fixed rule."           // "About this page" by default
      aboutLabel="About this step"                                                            // Shape steps only
      trail={<ShapeStepper row={row} here="route" ideasOnBoard={n} />}
      actions={<Button variant="primary">…</Button>}
      below={<SliceSections sliceId={id} />}
    />
  }
>
  …
  <ContextActs><Button variant="primary">Make the case</Button></ContextActs>    // from anywhere inside the screen
</WorkScreen>
```

- `WorkScreen` must be the screen's root inside `<main>`. Loading, error and empty states that come before the data may keep using `Page`; inside a work screen, put them in `<OnePane label="…">`.
- With no `identity`, the acts sit at the right of the title line.
- `ContextActs` puts its children in the row's acts, after any `actions`, through a portal. It is how a Shape step (whose row `IdeaStepFrame` draws) puts its acts at the top.
- `SliceContextRow` (`src/shared/SliceContextRow.tsx`) is the row of every slice page: the slice's ID, name, epic, state, place on GitHub and issue; the page's name as the h1 (the specification's h1 is the slice's own title); the lifecycle path; the slice's pages as tabs.

### 3.2 `WorkPanes`, `WorkPane`, `OnePane` (`WorkScreen.tsx`)

```tsx
<WorkPanes>                                   // split="conversation" for the guided question screen (8.10)
  <WorkPane label="Sizing and the map">…</WorkPane>
  <WorkPane side label="The route and what MACH counted">…</WorkPane>   // leave it out (null) when there is nothing to refer to
</WorkPanes>
<WorkPane label="The conversation" header={<ConversationHeader conv={conv} />}>…</WorkPane>
<WorkPane side as="aside" label="The slice so far" header={check}>…</WorkPane>
```

- Two panes when two are given; one when the second is left out.
- `width`: `"wide"` (60rem, the default), `"content"`, `"reading"`, `"column"` (a centred 44rem column) or `"full"`.
- `header` stays at the top of the pane while the rest scrolls under it, with a rule under it, full width of the pane; it does not rely on the pane's padding. In the page-scroll fallback it is an ordinary first block.
- `as="aside"` when the narrow pane is complementary to the page.
- The pane carries `data-pane` and, while it scrolls, `data-more` ("below", "above below", "above" or "end"), and draws the "More below" mark.

### 3.3 `ScrollRegion` and `WorkBoard` (`WorkScreen.tsx`)

```tsx
<ScrollRegion framed label="Decision table, scrolls sideways when narrow" className="rounded-md">…table…</ScrollRegion>
<WorkBoard label="Ideas board" above={<Banner …/>}>…columns…</WorkBoard>
```

- `ScrollRegion` is any box that scrolls on its own inside a pane: a named region in the tab order only while it has more to show, with the hairlines of 2.7. It is positioned, so visually hidden text inside it never stretches the page.
- `WorkBoard` is a board's area: it fills the rest of the window under the context row, with `above` for what must be read first, and its columns in one `ScrollRegion`.

### 3.4 `Parts` and `Part` (`Parts.tsx`)

```tsx
const [open, setOpen] = useState<string | null>(partForStep(step));
<Parts label="Sizing and the map" open={open} onOpenChange={setOpen}>
  <Part id="size" number={1} place="done" name="Size it" summary={sizeSummary(route, gate)}>…</Part>
  <Part id={item.id} name={<><ArtifactId plain>{item.id}</ArtifactId> {item.text}</>} summary={chainSummary(line)} status={<ResultPill item={item} />}>…</Part>
  <Part id={row.id} name={row.title} summary={packSummary(row)} attention={row.problems.length ? <PackProblems row={row} /> : undefined}>…</Part>
</Parts>
```

- Controlled: the screen decides which part opens, from MACH's state. Each `Part` renders an `h2` (or `h3` with `headingLevel={3}`) holding a button with `aria-expanded`, and a `region` named by that button.
- `name` may hold an identifier set as one. `number` and `place` together make the part a step of a path. `status` takes a pill. `attention` is shown under the row whether the part is open or closed.
- A part's body does not repeat the part's name; sub-headings inside it start one level down.
- Mark the part's own act with `data-part-act` so it is brought into view when the part opens on arrival.

### 3.5 `Fold` (`Fold.tsx`)

```tsx
<Fold label={`Rests on ${n} lines of the brief`}>…</Fold>          // quiet: a line with a chevron
<Fold small label="Connections: 1 earlier rule">…</Fold>           // quiet and caption-sized, for dense lists
<Fold boxed heading={3} label={`${group.title}: ${n}`}>…</Fold>    // the guide's disclosure look, its label a heading
```

A real button with `aria-expanded`; the detail follows it and stays in the page while closed. Use it for every disclosure on these screens.

### 3.6 `SectionNav` (`SectionNav.tsx`)

```tsx
<SectionNav label="Sections of the brief" title="In this brief" items={…} onGo={…} />
<SectionNav label="Sections of the slice so far" title="In the slice so far" items={…} columns={2} />
```

`columns={2}` where the list sits above a document in the same pane, so the document keeps most of the height. `useCurrentSection` and `goToSection` are exported for a screen that needs the behaviour without the list.

### 3.7 Elsewhere

- `useScrollEdges`, `measureScrollEdges` and `scrollEdgeClasses` (`@mach/ui`, `lib/scroll-edges.ts`): the one measure of "more below", used by the dialog body, the panes and every `ScrollRegion`.
- `DialogBody` (`@mach/ui`, `components/dialog-body.tsx`): the dialog rule, inside `DialogContent`; nothing to call.
- `MocksToCommitPanel` (`src/shared/MocksToCommit.tsx`) takes `narrow` for the 22rem pane: its icon beside the heading, no hanging indent, smaller text. Only its file names fold.

## 4. Decisions made on the way, and why

1. **The narrow pane on Size and route also holds the route itself**, not only the counts: after sizing, the next part to open is the map, so the route would otherwise sit in a closed part.
2. **The second stepper became the parts.** The four parts of Size and route (and of a PRD) are the four steps of the journey, each with its number and its place.
3. **The context row has two lines**, one when there is no identity line.
4. **The `h1` is set at `title-2`**, following the guide's own interview header.
5. **A slice's specification moved its outcome sentence and its times**: the outcome repeated the Summary section, and the times went to the narrow pane.
6. **Panes join the tab order only while they scroll**, and so does every `ScrollRegion` (the look back's chain table was a tab stop even when it fitted).
7. **The dialog's description scrolls with its body.**
8. **A section jumped to stays marked** until the person scrolls on.
9. **A pane's "more below" is a hairline with two words**, not a hairline alone: a pane's bottom edge is the window's, where a hairline is easy to miss. Boxes inside a pane, whose edges are in the middle of the window, keep the hairline alone.
10. **The open part is brought into view, the act with it.** Without it, 9 of the 14 states of The case and Look back had their act below the window at 1024 by 768.
11. **The ideas board's columns are narrower** (the five fit in 58rem), so the fifth column is in view at 1,024.
12. **Effects on shipped behaviour is one pane.** Its narrow pane held two short notes beside an often nearly empty wide pane; they now sit under the rows.
13. **"About this page" is the one label** for the lead paragraph's disclosure, "About this step" on a Shape step (the rollout also had "About Shape" and "About decisions").
14. **The check is "MACH's check"** in `@mach/ui`'s own words (`checkVerdict`), so no screen rewrites it.

## 5. Every screen, measured

Kinds: **work screen** (parts, panes, one open), **document** (long by nature, section list beside it), **board** (columns side by side in their own region), **list** (a column of rows in one pane). Measured in headless Chromium in fixture mode. "Before" is the earlier review's full-page screenshot at 1440 by 900 (`video/out/review-m16/`), or, for a screen that review did not capture, the rollout's own measurement of the unchanged code. "After" is the page's scroll height at 1440 by 900, then at 1024 by 768: a value equal to the window means the page does not scroll. "Act" is whether the main act for the state is in view on arrival at 1440 by 900 and at 1024 by 768 ("none" when the state offers no act). The galleries are `video/out/review-layout/shape.html` and `studio.html` (git-ignored), with `summary.json`.

Totals: of the 103 screens and states, 54 were taller than twice the window (1,800 pixels) before and none is now; at both window sizes the page itself does not scroll on any of them, nothing scrolls sideways and no screen logs a console error. Each of the 71 states that offer an act has it in view on arrival, at 1440 by 900 and at 1024 by 768. A `*` marks a "before" height that is the rollout's measurement of the unchanged code rather than the review's screenshot (the review did not capture the screen, or, for Look back, captured an idea the fixture does not hold).

| Screen | Kind | State | Before | After 1440x900 | After 1024x768 | Act 1440 | Act 1024 |
|---|---|---|---|---|---|---|---|
| Shape: ideas board | board | Ideas board, no ideas yet | 900 | 900 | 768 | yes | yes |
| Shape: ideas board | board | Ideas board, every stage and source | 1,862 | 900 | 768 | yes | yes |
| Shape: ideas board | board | Add an idea dialog, opened | 1,862 | 900 | 768 | yes | yes |
| Shape: ideas board | board | Add an idea dialog, start from a fault | 1,862 | 900 | 768 | yes | yes |
| Project home | list | Project home with the Next in Shape line | 957 | 900 | 768 | yes | yes |
| Shape: Explore | work screen | a New idea | 900 | 900 | 768 | yes | yes |
| Shape: Explore | work screen | lookups in three groups, conversation not started | 1,864 | 900 | 768 | yes | yes |
| Shape: Explore | work screen | the first question | 1,864 | 900 | 768 | yes | yes |
| Shape: Explore | work screen | after two answers, brief written, third question | 1,864 | 900 | 768 | yes | yes |
| Shape: Explore | work screen | a verdict the conversation was refused | 1,864 | 900 | 768 | yes | yes |
| Shape: Explore | work screen | a turn that ended in an error | 1,864 | 900 | 768 | yes | yes |
| Shape: Explore | work screen | the conversation cannot start | 1,864 | 900 | 768 | yes | yes |
| Shape: Explore | work screen | Start answered conflict | 1,864 | 900 | 768 | yes | yes |
| Shape: Explore | work screen | New idea after Start exploring | 900 | 900 | 768 | none | none |
| Shape: The brief | document | passes its check | 2,025 | 900 | 768 | yes | yes |
| Shape: The brief | document | a finding | 2,187 | 900 | 768 | yes | yes |
| Shape: The brief | document | warnings only | 2,181 | 900 | 768 | yes | yes |
| Shape: The brief | document | stale verdict banner | 2,116 | 900 | 768 | yes | yes |
| Shape: The brief | document | a change's starter brief | 2,067 | 900 | 768 | yes | yes |
| Shape: The brief | document | none written yet | 900 | 900 | 768 | yes | yes |
| Shape: The case | work screen | no verdict, the three equal choices | 1,881 | 900 | 768 | yes | yes |
| Shape: The case | work screen | a recorded Go | 1,819 | 900 | 768 | yes | yes |
| Shape: The case | work screen | a recorded No | 1,771 | 900 | 768 | none | none |
| Shape: The case | work screen | a recorded Not now | 1,771 | 900 | 768 | none | none |
| Shape: The case | work screen | a stale verdict | 2,188 | 900 | 768 | yes | yes |
| Shape: The case | work screen | record-verdict confirmation dialog | 1,881 | 900 | 768 | yes | yes |
| Shape: The case | work screen | publish dialog | 1,819 | 900 | 768 | yes | yes |
| Shape: The case | work screen | no case written yet | 1,373 | 900 | 768 | none | none |
| Shape: The case | work screen | every question answered | 1,883 | 900 | 768 | yes | yes |
| Shape: Size and route | work screen | no Go yet | 900 | 900 | 768 | none | none |
| Shape: Size and route | work screen | Go, not sized | 900 | 900 | 768 | yes | yes |
| Shape: Size and route | work screen | one slice | 1,618 | 900 | 768 | none | none |
| Shape: Size and route | work screen | one epic | 1,710 | 900 | 768 | none | none |
| Shape: Size and route | work screen | several epics | 1,618 | 900 | 768 | none | none |
| Shape: Size and route | work screen | sized, no map yet | 1,618 | 900 | 768 | none | none |
| Shape: Size and route | work screen | an outcome not carried | 2,757 | 900 | 768 | yes | yes |
| Shape: Size and route | work screen | route blockers | 3,109 | 900 | 768 | none | none |
| Shape: Size and route | work screen | the settle dialog | 2,757 | 900 | 768 | yes | yes |
| Shape: Size and route | work screen | everything settled | 2,729 | 900 | 768 | yes | yes |
| Shape: Size and route | work screen | the Make the drafts dialog | 2,729 | 900 | 768 | yes | yes |
| Shape: Size and route | work screen | the drafts made | 2,928 | 900 | 768 | none | none |
| Shape: Size and route | work screen | a stale route | 2,012 | 900 | 768 | none | none |
| How an epic works today | document | How an epic works today, with Change this | 1,933 | 900 | 768 | yes | yes |
| Shape: Change what exists | work screen | Change what exists, from a rule | 900 | 900 | 768 | yes | yes |
| Shape: Change what exists | work screen | Change what exists, from Change this | 932 | 900 | 768 | yes | yes |
| Shape: Look back | work screen | not yet allowed | 2,120 | 900 | 768 | none | none |
| Shape: Look back | work screen | allowed | 3,206* | 900 | 768 | yes | yes |
| Shape: Look back | work screen | partly recorded | 3,206* | 900 | 768 | yes | yes |
| Shape: Look back | work screen | the chain with missing values | 3,206* | 900 | 768 | yes | yes |
| Shape: Look back | work screen | the chain after looking back | 3,206* | 900 | 768 | yes | yes |
| First run | list | First run, no project yet | 900* | 900 | 768 | yes | yes |
| Project home | list | Project home | 1,743* | 900 | 768 | yes | yes |
| Vision and outcomes | document | Vision and outcomes | 1,208* | 900 | 768 | yes | yes |
| Roadmap | board | Roadmap, the map | 900* | 900 | 768 | yes | yes |
| Slice specification | document | Slice specification, a draft with open questions | 3,794* | 900 | 768 | none | none |
| Slice specification | document | Slice specification, ready for approval | 3,794* | 900 | 768 | yes | yes |
| Slice specification | document | Slice specification, the source view | 3,794* | 900 | 768 | none | none |
| Slice specification | document | the confirm step | 3,794* | 900 | 768 | yes | yes |
| Slice interview | work screen | Slice interview, not started | 2,406* | 900 | 768 | none | none |
| Effects on shipped behaviour | list | rows | 900 | 900 | 768 | none | none |
| Effects on shipped behaviour | list | not answered yet | 900 | 900 | 768 | yes | yes |
| Effects on shipped behaviour | list | problems | 900 | 900 | 768 | none | none |
| Effects on shipped behaviour | list | moved since checked | 900 | 900 | 768 | none | none |
| Principles and policies (slice) | work screen | an open concern | 1,464 | 900 | 768 | yes | yes |
| Principles and policies (slice) | work screen | an accepted concern | 1,315 | 900 | 768 | none | none |
| Principles and policies (slice) | work screen | the accept dialog | 1,464 | 900 | 768 | yes | yes |
| Principles and policies (slice) | work screen | a pack followed | 900 | 900 | 768 | none | none |
| Design mocks (slice) | board | none | 900 | 900 | 768 | none | none |
| Design mocks (slice) | board | some | 1,114 | 900 | 768 | yes | yes |
| Design mocks (slice) | board | four | 1,114 | 900 | 768 | yes | yes |
| Design mocks (slice) | board | a problem | 2,084 | 900 | 768 | none | none |
| Slice specification | document | saved, waiting for the pictures | 3,794 | 900 | 768 | yes | yes |
| From the PRD (slice) | document | drafted answers | 2,398 | 900 | 768 | yes | yes |
| From the PRD (slice) | document | not from a PRD | 900 | 900 | 768 | none | none |
| Product principles | work screen | empty | 900 | 900 | 768 | yes | yes |
| Product principles | work screen | unpublished changes | 1,335 | 900 | 768 | yes | yes |
| Product principles | work screen | the publish dialog | 1,335 | 900 | 768 | yes | yes |
| Product principles | work screen | a newer set from someone else | 1,562 | 900 | 768 | yes | yes |
| Product principles | work screen | published | 900 | 900 | 768 | yes | yes |
| Product principles | work screen | a publish that stopped part way | 900 | 900 | 768 | yes | yes |
| Policy packs | list | populated | 900 | 900 | 768 | none | none |
| Policy packs | list | a malformed pack | 924 | 900 | 768 | none | none |
| Policy packs | list | none | 900 | 900 | 768 | none | none |
| How an epic works today | document | How an epic works today | 1,933 | 900 | 768 | yes | yes |
| How an epic works today | document | nothing shipped | 900 | 900 | 768 | none | none |
| How an epic works today | document | problems | 2,892 | 900 | 768 | yes | yes |
| How an epic works today | document | after a retire | 2,092 | 900 | 768 | yes | yes |
| PRD list | list | none yet | 900 | 900 | 768 | yes | yes |
| PRD list | list | one imported | 900 | 900 | 768 | yes | yes |
| A PRD | work screen | A PRD with no map yet | 1,036 | 900 | 768 | none | none |
| A PRD | work screen | A PRD with sections not covered | 2,340 | 900 | 768 | yes | yes |
| A PRD | work screen | the settle dialog | 2,340 | 900 | 768 | yes | yes |
| A PRD | work screen | one section left | 2,316 | 900 | 768 | yes | yes |
| A PRD | work screen | the drafts made | 2,302 | 900 | 768 | none | none |
| A PRD | work screen | the Make the drafts dialog | 2,302 | 900 | 768 | yes | yes |
| Jira | work screen | keys | 1,488 | 900 | 768 | none | none |
| Jira | work screen | exported, with the two downloads | 1,488 | 900 | 768 | yes | yes |
| Jira | work screen | a keys file tried, with unmatched rows | 1,924 | 900 | 768 | yes | yes |
| Jira | work screen | keys that would reopen slices | 1,924 | 900 | 768 | yes | yes |
| Decisions | list | Decisions | 3,102* | 900 | 768 | yes | yes |
| Decisions | list | a request in the idea template, its text shown | 3,534 | 900 | 768 | yes | yes |
| On GitHub | list | On GitHub | 925* | 900 | 768 | yes | yes |
| Not found | list | Not found | 900* | 900 | 768 | none | none |

## 6. What is still not good enough

- **One-column lists leave the right of a 1440 window empty.** The project home, Decisions and the policy packs keep their content to 60rem, so about 340 pixels to the right are empty. By the rule (never a second pane just to fill space) that is right; a person may still read it as unfinished.
- **The interview of an approved slice** shows only its "cannot be interviewed now" notice in the wide column; the 8.10 columns are kept for every state of the interview.
- **A request's own text** (Decisions) and a PRD's quoted lines are still bounded boxes that scroll inside the pane. The guide bounds outside free text, and the request suite checks the box, so they keep their own frame; they do not carry the "more below" mark (their frame and the cut text say it).
- **The "More below" mark covers the last line of a pane** until the pane is within 24 pixels of its end.
- **On a slice's "From the PRD" page** the act (Accept the drafted answers) is in the context row, away from the checkboxes it depends on, and its hint still says "with the button at the top of the page".
- **Vision and outcomes keeps "Save changes" in its form**, under the outcomes; with many outcomes it falls below the window (it is disabled until something changes, and in view in every fixture).
- **The breadcrumb truncates at 1,024** ("Sh…", "Reserve a study room …"), as it did before; the context row carries the item's name.
- **Each recorded time is a tab stop** (`RelativeTime`), so narrow panes with several times have long keyboard paths. It was so before.
- **Fixture disagreement, not layout:** the Shape stepper says "No verdict yet" or "Not sized yet" on pages that show a verdict or a route, because the board fixture and the page fixtures are different MACH runs.
- **The "ready to build" dialog's description** is still MACH's long note.
