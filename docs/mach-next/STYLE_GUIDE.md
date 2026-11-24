# MACH family style guide

A self-contained description of the design system shared by MACH's two browser applications, **Product Studio** and **Factory Floor**, written so that someone who cannot see their code can build a sister application that looks, reads and behaves like part of the same family.

Every value in this guide was taken from the system's source: the design tokens, the shared component library, the two applications, their stylesheets, the lint configuration and the approved mockups. Where two sources disagree, the token file wins and the guide says so (section 13 lists every such place). Where the system defines nothing, the guide says **not defined** rather than inventing a value.

---

## Contents

1. [How to use this guide, character and principles](#1-how-to-use-this-guide-character-and-principles)
2. [Colour](#2-colour)
3. [Typography](#3-typography)
4. [Space, layout and shape](#4-space-layout-and-shape)
5. [Motion](#5-motion)
6. [Iconography, the brand mark and state shapes](#6-iconography-the-brand-mark-and-state-shapes)
7. [Components](#7-components)
8. [Patterns](#8-patterns)
9. [Voice and wording](#9-voice-and-wording)
10. [Accessibility requirements](#10-accessibility-requirements)
11. [Implementation starter](#11-implementation-starter)
12. [Sample screens](#12-sample-screens)
13. [Gaps and disagreements in the sources](#13-gaps-and-disagreements-in-the-sources)

---

## 1. How to use this guide, character and principles

### 1.1 How to use it

- **Start with section 11.** Paste the custom-properties block, the Tailwind theme mapping and the base stylesheet into your app before you build any screen. Every component in section 7 is described in terms of those tokens.
- **Use roles, never raw colours.** Every colour in a component is a semantic role (`canvas`, `ink-muted`, `danger-soft` and so on). The hex values in section 2 exist so you can build the token file and check contrast; they never appear in component code.
- **Pick the product flavour.** The family has two flavours that share every role and component: the *Product Studio* flavour (warm paper, comfortable, editorial; default theme follows the system) and the *Factory Floor* flavour (charcoal night, compact, technical; default theme dark). A sister app chooses one and sets it on the root element (`data-product`). Section 2.7 and section 4.9 give the differences.
- **Optional modules.** Three parts of the system exist for MACH's own subject matter and a sister app may not need them: the **product graph** (a node-and-edge diagram of a project, its epics and its slices, section 7.9), the **specification pieces** (how MACH shows a written product specification and its automated check, section 7.10), and the **factory drawing** (an isometric technical drawing of MACH's build pipeline, section 7.11, with its own colour roles in section 2.5). Read them if your app draws diagrams, shows checked documents or draws a process; skip them otherwise.
- **Words matter as much as pixels.** Section 9 is binding. A screen with the right tokens and the wrong words does not belong to the family.
- **Before you call a screen done**, run the checklist in section 11.7.

Terms used throughout:

| Term | Meaning here |
|------|--------------|
| Role | A named colour with a light and a dark value, exposed as a CSS variable `--mach-<role>` and a Tailwind colour of the same name |
| Tone | One of the feedback families (info, success, warning, danger, neutral, plus accent), each with `-ink`, `-soft`, `-line` and `-fill` roles |
| Engine | MACH's back-end program, which decides every state and writes every refusal. In a sister app read it as "your back end": the interface shows what the back end reported and never derives a state of its own |
| A person's act | An action that records a human decision (approve, send, mark ready, reopen, choose a version). It is always a primary or danger button and always confirmed in a dialog |
| Identifier | A machine-owned ID such as `SLICE-001`, `EPIC-001`, `FR-01`, `LOCAL-014`, `#41`. Set in the monospace face and never reformatted or translated |

### 1.2 The family's character

Two products, one family. **Product Studio** is for product managers and founders: warm, calm, editorial and legible, on cream paper, with generous reading type. **Factory Floor** is for engineers watching an automated software factory: dark, precise and technical, denser, with identifiers, durations and logs in a monospace face. Both are quiet: warm neutrals carry the page, a single terracotta accent marks the primary act and the current place, state is always a word plus a shape plus a tone, and nothing moves unless something happened. Factory Floor's drawing style is "an engineer's drawing of a plant on a warm sheet", explicitly the opposite of a sci-fi console.

| | Product Studio | Factory Floor |
|---|---|---|
| Who | Product managers, founders | Engineers running the factory |
| Character | Warm, calm, editorial, legible | Dark, cinematic, technical, precise |
| Default theme | System (light paper) | Dark |
| Heading face | Source Sans 3, bold | Source Sans 3, bold |
| Density | Comfortable (`--mach-density: 1`) | Compact (`--mach-density: 0.875`) |
| Monospace | Identifiers only | Identifiers, logs, durations, event streams |
| Accent | Terracotta for the act and the place | The same; live activity uses blue (`info` / `factory-live`), never the accent |
| Navigation | No rail: top bar with breadcrumb and a "More" menu | Top bar with a three-way workspace switch |

### 1.3 Binding principles

These are stated in the sources and are not negotiable for a family member.

1. **The back end decides; the interface shows.** No product rule lives in interface code. State words, refusals and suggestions come from the back end and are shown as written. The interface maps reported states to looks; it never derives a state the back end did not report. A figure no record carries is shown as "not recorded", never as zero and never estimated.
2. **A person's acts look like acts.** Approving, sending and choosing between versions are primary buttons, always confirmed in a dialog that says what the act means. Nothing is approved because a check passed.
3. **State is never colour alone.** Every state has a word, a glyph shape and a tone. A status pill must read in greyscale.
4. **Other people's words are quotations.** Reviewer remarks and text written by someone else are set as attributed quotations, never as instructions or buttons. Free text that has not been checked for personal names is shown plain, bounded, and labelled "free text, not checked for names".
5. **Quiet structure, one accent.** Warm neutrals carry the page; terracotta marks the primary action and the current place, nothing else.
6. **Calm motion.** Motion answers an action or shows what changed. Nothing moves on its own. Work in flight is shown as "working, for this long", never as a bar filling toward an unknown end.
7. **Show what is known; never predict.** Fills are reserved for fractions with a real denominator ("7 of 8 checks", "2 of 3 rounds").

### 1.4 Forbidden

| Forbidden | Source of the rule |
|-----------|--------------------|
| Gradients as decoration | Principle 5; the factory spec also bans glass, bloom, neon, particles, scan lines, holograms, random flicker, camera shake and game HUD chrome |
| Decorative illustration, and illustration with faces or props that stand for nothing | Principle 5; factory spec "What it is not" |
| Emoji | Principle 5 |
| Any serif face | Typography: "there is no serif face" |
| A second display typeface | Titles are the interface sans set bold |
| All-caps labels, eyebrow text above a heading | Typography rules |
| Title Case | Sentence case everywhere |
| Colour as the only carrier of state | Principle 3 |
| Motion that idles, breathes, shimmers or pulses on its own; autoplaying video | Principle 6; video uses the browser's own controls and never autoplays (see 13 for the one built exception) |
| Progress bars for work whose end is unknown | Principle 7 |
| Hex colour literals in component code | Enforced by lint (section 11.6) |
| Tailwind's default palette (`bg-blue-500` etc.) | Removed from the theme, so it does not compile |
| Fonts or scripts loaded from a CDN | Fonts are bundled from npm; nothing loads from a font service |
| Tooltips holding essential information | Tooltip rules |
| KPI tiles, card grids and charts inside the factory drawing | Factory spec: "Not a dashboard" |
| Text rendered as HTML from data | Rich text is rendered as text, never as markup |
| "Submit", "OK" and other labels that do not name the act | Button wording rules |

---

## 2. Colour

### 2.1 Brand palette

| Name | Hex | Role in the family |
|------|-----|--------------------|
| charcoal | `#141413` | Ink in light theme; the dark canvas |
| cream | `#FAF9F5` | The light canvas |
| terracotta | `#D97757` | The brand accent: primary action, current place. Never body text on cream (2.96:1) |
| blue | `#6A9BCC` | Information, in progress, the focus family |
| green | `#788C5D` | Approved, accepted, passed |
| ochre | `#C99A3A` | Warnings: something to settle |
| brick | `#B2343F` | Errors, blocked, destructive |

The palette starts from Anthropic's publicly documented colours and moves away from them where MACH needs more (a warm neutral ramp, and ochre and brick so the accent never doubles as an error colour). No Anthropic font, logo or icon is used.

**Warm neutral ramp** (fifteen steps plus white; every surface, line and ink in both themes is drawn from it):

| Step | Hex | | Step | Hex |
|------|-----|-|------|-----|
| paper0 | `#FFFFFF` | | paper600 | `#6B6962` |
| paper50 | `#FAF9F5` | | paper700 | `#4D4B46` |
| paper100 | `#F3F1EA` | | paper800 | `#2E2D2A` |
| paper150 | `#ECE9DF` | | paper850 | `#242422` |
| paper200 | `#E3E0D5` | | paper900 | `#1C1C1A` |
| paper300 | `#D1CDBF` | | paper925 | `#181817` |
| paper400 | `#A8A496` | | paper950 | `#141413` |
| paper500 | `#8C887C` | | paper1000 | `#0F0F0E` |

Components never use the palette directly; they use the roles below.

### 2.2 Semantic roles

Each role is a CSS variable `--mach-<role>` and a Tailwind colour `<utility>-<role>` (for example `bg-surface`, `text-ink-muted`, `border-line-control`).

**Surfaces**, from the page outward:

| Role | Light | Dark | Use |
|------|-------|------|-----|
| `canvas` | `#FAF9F5` | `#141413` | The page; also the top bar's background |
| `surface` | `#FFFFFF` | `#1C1C1A` | Panels, inputs, graph nodes, side panels |
| `surface-raised` | `#FFFFFF` | `#242422` | Things that float: dialogs, sheets, popovers, menus, toasts |
| `surface-sunken` | `#F3F1EA` | `#0F0F0E` | Wells, inline code, hover rows, disabled and read-only inputs |
| `surface-nav` | `#F3F1EA` | `#181817` | The navigation rail |
| `surface-inverse` | `#141413` | `#FAF9F5` | Tooltips and chart cards |
| `overlay` | `rgba(20, 20, 19, 0.42)` | `rgba(0, 0, 0, 0.6)` | The scrim behind dialogs and sheets |

**Text:**

| Role | Light | Dark | Use |
|------|-------|------|-----|
| `ink` | `#141413` | `#F0EEE6` | Body text, headings |
| `ink-muted` | `#5C5A54` | `#B5B2A7` | Secondary text, descriptions, field hints, ghost buttons |
| `ink-subtle` | `#6B6962` | `#9A978C` | Captions, timestamps, placeholders, "optional" (still AA) |
| `ink-inverse` | `#FAF9F5` | `#141413` | Text on `surface-inverse` (tooltips) |
| `ink-on-accent` | `#FFFFFF` | `#141413` | Labels on `accent-fill` and `danger-fill` buttons, check marks in filled checkboxes |

**Lines:**

| Role | Light | Dark | Use |
|------|-------|------|-----|
| `line` | `#E3E0D5` | `#2E2D2A` | Dividers and panel borders (decorative; no contrast requirement) |
| `line-strong` | `#D1CDBF` | `#3D3C38` | Popover, menu and toast borders, table header rules, dashed empty states, quotation rule |
| `line-control` | `#8C887C` | `#75736A` | Input, select, checkbox and secondary-button borders (must meet 3:1) |

**Accent** (the primary act and the current place):

| Role | Light | Dark | Use |
|------|-------|------|-----|
| `accent` | `#D97757` | `#D97757` | Current-place bar, active tab underline, accent bars, selection outlines |
| `accent-fill` | `#B5512F` | `#D97757` | Primary button, checked checkbox |
| `accent-fill-hover` | `#9F4628` | `#E48B6C` | Primary button hover |
| `accent-ink` | `#A9482A` | `#E8957A` | Links, the current navigation label, "Recommended" label |
| `accent-soft` | `#F6E7DF` | `#3A2620` | Current navigation item, selected row, highlighted select option, text selection |

**Focus:**

| Role | Light | Dark | Use |
|------|-------|------|-----|
| `focus` | `#2F6AA3` | `#8DB4DD` | The keyboard focus ring, everywhere; also the resting outline colour |

### 2.3 Feedback tones

Each tone has four roles: **ink** (text and icons), **soft** (tinted background), **line** (border) and **fill** (solid bars, dots and marks). `danger` also has a fill hover for the destructive button.

| Tone | Role | Light | Dark |
|------|------|-------|------|
| info | `info-ink` | `#3A6496` | `#8DB4DD` |
| | `info-soft` | `#E8EFF7` | `#1E2A36` |
| | `info-line` | `#B7CCE3` | `#34506C` |
| | `info-fill` | `#6A9BCC` | `#6A9BCC` |
| success | `success-ink` | `#4E5E39` | `#A7B98A` |
| | `success-soft` | `#EEF1E6` | `#232A1B` |
| | `success-line` | `#C5CFB4` | `#47573A` |
| | `success-fill` | `#788C5D` | `#788C5D` |
| warning | `warning-ink` | `#7D5A12` | `#D9B061` |
| | `warning-soft` | `#F8EED7` | `#2F2716` |
| | `warning-line` | `#E3CD98` | `#5E4C25` |
| | `warning-fill` | `#C99A3A` | `#C99A3A` |
| danger | `danger-ink` | `#A12F3A` | `#EC8F96` |
| | `danger-soft` | `#F9E6E6` | `#3A1D20` |
| | `danger-line` | `#E8B9BC` | `#6E3036` |
| | `danger-fill` | `#B2343F` | `#E06C75` |
| | `danger-fill-hover` | `#962A34` | `#E8848C` |
| neutral | `neutral-ink` | `#5C5A54` | `#B5B2A7` |
| | `neutral-soft` | `#ECE9DF` | `#242422` |
| | `neutral-line` | `#D1CDBF` | `#3D3C38` |
| | `neutral-fill` | `#8C887C` | `#8C887C` |

The component library also treats **accent** as a sixth tone for pills and badges: soft `accent-soft`, ink `accent-ink`, line `accent`, fill `accent-fill`. It is used for exactly one state: "Ready for your approval" (settled, waiting for a person's act).

What each tone means:

| Tone | Means | Examples from the apps |
|------|-------|------------------------|
| neutral | Nothing settled, or kept for history | Draft, Proposed, Superseded, "Saved to a folder" |
| info | Being worked out, in progress, handed over | Interviewing, Ready to build, Being built, "Connecting", the factory's live work |
| accent | Settled and waiting for a person's act | Ready for approval |
| success | A person approved it, or it passed and shipped | Approved, Completed, Shipped, "Connected" |
| warning | Something to settle; a question; held | Deferred, Question from the builders, open questions, "Session ended", Simulation stamp, stale connection |
| danger | Failed, blocked, refused, destructive | Problems to fix, "Changed on GitHub after you approved it", "Host not responding", errors |

### 2.4 Graph colours

Used by the optional product graph (section 7.9).

| Role | Light | Dark | Use |
|------|-------|------|-----|
| `graph-dot` | `#D1CDBF` | `#2A2927` | The dotted background grid |
| `graph-edge` | `#8C887C` | `#75736A` | Containment edges (project to epic to slice), thin and receding |
| `graph-edge-dependency` | `#A9482A` | `#E8957A` | Dependency edges, dashed, with an arrowhead |

### 2.5 Factory and diagram palette (optional module)

Used by Factory Floor's drawn views (the isometric plant, the Line board, analytics charts) and by any diagram that should read as part of the same drawing. A sister app that draws a process, a pipeline or a schematic should use these; an app with only forms and tables can skip them.

**Structure of the drawing:**

| Role | Light | Dark | Use |
|------|-------|------|-----|
| `factory-ground` | `#EFEBE2` | `#0B0B0A` | The stage the drawing sits on; the Line board's background |
| `factory-grid` | `#E3DFD3` | `#181816` | Minor drafting grid (24 units) |
| `factory-grid-major` | `#D3CEBF` | `#24231F` | Major drafting grid (96 units) |
| `factory-plate-top` | `#FDFCF9` | `#211F1D` | Top faces of solids; station plates on the Line board |
| `factory-plate-lit` | `#ECE8DD` | `#1A1917` | Lit side faces; hover on drawing controls |
| `factory-plate-shade` | `#D5CFC0` | `#121110` | Shaded side faces; station plate borders on the Line board |
| `factory-plate-edge` | `#8A8679` | `#78756C` | Drafted outlines (3:1 against ground and plate top) |
| `factory-plate-rim` | `#FFFFFF` | `#57534C` | The lit front edge of every solid |
| `factory-machine-top` | `#FFFFFF` | `#3D3C37` | The brightest neutral: idle machine tops, task boards |
| `factory-floor` | `#F6F3EC` | `#2A2925` | Where work happens (a bay's floor) |
| `factory-done` | `#EEF0E7` | `#272924` | A finished bay's floor: calm, barely green |
| `factory-hatch` | `#B5AF9E` | `#3E3C37` | Section hatching on cut or shaded faces; the Line's dotted belt |
| `factory-shadow` | `rgba(58, 52, 40, 0.13)` | `rgba(0, 0, 0, 0.62)` | Flat contact shadows (warm in light, black in dark) |
| `factory-ink` | `#3A3833` | `#DAD6CA` | Symbols, structure lines, labels on plates |
| `factory-ink-soft` | `#7A766B` | `#A19E93` | Secondary strokes, idle symbols. Never text: 4.42:1 on a plate top in light; small secondary words use `ink-muted` |
| `factory-route` | `#858175` | `#8C897F` | An idle route or track; ordinary time bars |
| `factory-lamp` | `#FFF0D6` | `#4A3A27` | The work lamp's pool of light (the only variable light) |
| `factory-select` | `#B5512F` | `#E48B6C` | Selection brackets |

**State inks and tints of the drawing:**

| State | Ink role | Light | Dark | Tint role | Light | Dark |
|-------|----------|-------|------|-----------|-------|------|
| Working (live) | `factory-live` | `#2F6AA3` | `#8DB4DD` | `factory-live-soft` | `#DCE7F3` | `#1E3046` |
| Passed | `factory-pass` | `#56683F` | `#A7B98A` | `factory-pass-soft` | `#E6EBDB` | `#26301E` |
| Failed, blocked | `factory-fail` | `#A12F3A` | `#EC8F96` | `factory-fail-soft` | `#F5DEDF` | `#3E2024` |
| Waiting | `factory-wait` | `#86621A` | `#D9B061` | `factory-wait-soft` | `#F3E6C6` | `#362C17` |
| Waiting for a person | `factory-human` | `#A9482A` | `#E8957A` | `factory-human-soft` | `#F6E3D9` | `#42291F` |
| Interrupted (process killed or timed out) | `factory-halt` | `#74488A` | `#C6A6DA` | none (uses `factory-plate-top`) | | |
| As last seen (connection stale) | `factory-stale` | `#56636F` | `#97A4B0` | none (uses `factory-plate-top`) | | |

The human ink is the terracotta family on purpose: a person's act is the family's primary act.

**Tonal ladder** (at a glance, the eye must find work first, then structure, then ground): ground `#0B0B0A`/`#EFEBE2` → region plate top `#211F1D`/`#FDFCF9` → bay floor `#2A2925`/`#F6F3EC` → machine top `#3D3C37`/`#FFFFFF` → work (live, lamp, state tints), which are the only warm or saturated areas. Values given dark/light.

**Analytics chart roles.** The analytics workspace defines chart variables on its root, all mapped to tokens; its bars and its one ramp are tokens of their own (`analytics-*`, light and dark in `tokens.ts`):

| Variable | Maps to | Dark |
|----------|-----------------|---------------|
| `--an-ink` / `--an-muted` / `--an-subtle` | `ink` / `ink-muted` / `ink-subtle` | |
| `--an-grid` / `--an-axis` | `line` / `line-strong` | |
| `--an-bar` | `analytics-bar` (light `#7A766B`, as `factory-ink-soft`) | `#8F8B80` |
| `--an-bar-quiet` | `analytics-bar-quiet` (light `#D5CFC0`, as `factory-plate-shade`) | `#3A3934` |
| `--an-bar-alt` | `color-mix(in srgb, var(--an-bar) 72%, var(--mach-canvas))` | |
| `--an-select` | `accent` | |
| `--an-live`, `--an-pass`, `--an-fail`, `--an-wait`, `--an-human`, `--an-halt`, `--an-stale`, `--an-hatch` (and `-soft` where they exist) | the matching `factory-*` roles | |
| `--an-hatch-ink` | `color-mix(in srgb, var(--mach-ink-subtle) 50%, transparent)` | |
| `--an-sheet` | `surface` | |
| `--an-outline` | `color-mix(in srgb, var(--mach-ink-subtle) 80%, var(--mach-canvas))` (3.5:1 or more on canvas and surface) | |
| `--an-seq-1` … `--an-seq-4` | `analytics-seq-1` … `analytics-seq-4`: `#5A86B6`, `#3F6C9E`, `#2B5A8C`, `#1D4370` (one hue, light to dark) | `#3F6C9E`, `#5A86B6`, `#8FB7DF`, `#B8D3EE` |

The sequential ramp is used for ordered categories (token kinds); each step is 3:1 or more on canvas and surface, registered with the token script. No stylesheet in an app holds a hex colour (`test/no-hex-css.test.mjs` in the Factory Floor).

### 2.6 Elevation colours

Shadows are tinted charcoal, never grey-blue. In dark, elevation shows mainly as a lighter surface.

| Level | Light | Dark | For |
|-------|-------|------|-----|
| `shadow-1` | `0 1px 2px rgba(20, 20, 19, 0.06)` | `0 1px 2px rgba(0, 0, 0, 0.4)` | Primary and danger buttons, the project node, the selected segment of a segmented control, stage notices |
| `shadow-2` | `0 2px 8px rgba(20, 20, 19, 0.08), 0 1px 2px rgba(20, 20, 19, 0.06)` | `0 4px 12px rgba(0, 0, 0, 0.45)` | Popovers, select menus, tooltips, the skip link, graph controls |
| `shadow-3` | `0 12px 32px rgba(20, 20, 19, 0.14), 0 2px 6px rgba(20, 20, 19, 0.08)` | `0 16px 40px rgba(0, 0, 0, 0.6)` | Dialogs, sheets, toasts, drawers over a stage |

### 2.7 Contrast requirements and measured pairs

Text pairs need **4.5:1**; large text and non-text UI that carries meaning (control borders, the focus ring, icons that carry meaning, graph edges, state marks) need **3:1** (WCAG 2.1 AA, 1.4.3 and 1.4.11). Decorative lines (`line`, `line-strong`, grid, hatch) have no requirement and must carry no meaning on their own. The token build fails if any registered pair drops below its threshold. Every measured pair:

**Interface pairs, light theme**

| Foreground | Background | Ratio | Needs | Used for |
|------------|------------|-------|-------|----------|
| `ink` #141413 | `canvas` #FAF9F5 | 17.50 | 4.5 | Body text |
| `ink` #141413 | `surface` #FFFFFF | 18.43 | 4.5 | Body text on panels |
| `ink-muted` #5C5A54 | `canvas` #FAF9F5 | 6.55 | 4.5 | Secondary text |
| `ink-muted` #5C5A54 | `surface-nav` #F3F1EA | 6.10 | 4.5 | Secondary text in the navigation |
| `ink-subtle` #6B6962 | `canvas` #FAF9F5 | 5.22 | 4.5 | Captions, timestamps |
| `ink-subtle` #6B6962 | `surface-sunken` #F3F1EA | 4.86 | 4.5 | Captions on sunken wells |
| `ink-subtle` #6B6962 | `surface-raised` #FFFFFF | 5.49 | 4.5 | Captions in popovers |
| `ink-inverse` #FAF9F5 | `surface-inverse` #141413 | 17.50 | 4.5 | Tooltips |
| `ink-on-accent` #FFFFFF | `accent-fill` #B5512F | 5.02 | 4.5 | Primary button label |
| `ink-on-accent` #FFFFFF | `accent-fill-hover` #9F4628 | 6.21 | 4.5 | Primary button label, hover |
| `accent-ink` #A9482A | `canvas` #FAF9F5 | 5.47 | 4.5 | Links, current navigation item |
| `accent-ink` #A9482A | `accent-soft` #F6E7DF | 4.77 | 4.5 | Selected item label |
| `line-control` #8C887C | `canvas` #FAF9F5 | 3.36 | 3 | Input and checkbox borders |
| `line-control` #8C887C | `surface` #FFFFFF | 3.54 | 3 | Input borders on panels |
| `focus` #2F6AA3 | `canvas` #FAF9F5 | 5.37 | 3 | Focus ring |
| `focus` #2F6AA3 | `surface` #FFFFFF | 5.66 | 3 | Focus ring on panels |
| `info-ink` #3A6496 | `info-soft` #E8EFF7 | 5.26 | 4.5 | Info pill and banner |
| `info-ink` #3A6496 | `canvas` #FAF9F5 | 5.79 | 4.5 | Info text |
| `success-ink` #4E5E39 | `success-soft` #EEF1E6 | 6.15 | 4.5 | Success pill and banner |
| `success-ink` #4E5E39 | `canvas` #FAF9F5 | 6.68 | 4.5 | Success text |
| `warning-ink` #7D5A12 | `warning-soft` #F8EED7 | 5.44 | 4.5 | Warning pill and banner |
| `warning-ink` #7D5A12 | `canvas` #FAF9F5 | 5.96 | 4.5 | Warning text |
| `danger-ink` #A12F3A | `danger-soft` #F9E6E6 | 5.86 | 4.5 | Danger pill and banner |
| `danger-ink` #A12F3A | `canvas` #FAF9F5 | 6.68 | 4.5 | Error text |
| `ink-on-accent` #FFFFFF | `danger-fill` #B2343F | 6.08 | 4.5 | Destructive button label |
| `neutral-ink` #5C5A54 | `neutral-soft` #ECE9DF | 5.68 | 4.5 | Neutral pill |
| `graph-edge` #8C887C | `canvas` #FAF9F5 | 3.36 | 3 | Graph hierarchy edge |
| `graph-edge-dependency` #A9482A | `canvas` #FAF9F5 | 5.47 | 3 | Graph dependency edge |

**Interface pairs, dark theme**

| Foreground | Background | Ratio | Needs | Used for |
|------------|------------|-------|-------|----------|
| `ink` #F0EEE6 | `canvas` #141413 | 15.87 | 4.5 | Body text |
| `ink` #F0EEE6 | `surface` #1C1C1A | 14.69 | 4.5 | Body text on panels |
| `ink-muted` #B5B2A7 | `canvas` #141413 | 8.68 | 4.5 | Secondary text |
| `ink-muted` #B5B2A7 | `surface-nav` #181817 | 8.37 | 4.5 | Secondary text in the navigation |
| `ink-subtle` #9A978C | `canvas` #141413 | 6.30 | 4.5 | Captions, timestamps |
| `ink-subtle` #9A978C | `surface-sunken` #0F0F0E | 6.56 | 4.5 | Captions on sunken wells |
| `ink-subtle` #9A978C | `surface-raised` #242422 | 5.32 | 4.5 | Captions in popovers |
| `ink-inverse` #141413 | `surface-inverse` #FAF9F5 | 17.50 | 4.5 | Tooltips |
| `ink-on-accent` #141413 | `accent-fill` #D97757 | 5.90 | 4.5 | Primary button label |
| `ink-on-accent` #141413 | `accent-fill-hover` #E48B6C | 7.21 | 4.5 | Primary button label, hover |
| `accent-ink` #E8957A | `canvas` #141413 | 7.91 | 4.5 | Links, current navigation item |
| `accent-ink` #E8957A | `accent-soft` #3A2620 | 6.10 | 4.5 | Selected item label |
| `line-control` #75736A | `canvas` #141413 | 3.88 | 3 | Input and checkbox borders |
| `line-control` #75736A | `surface` #1C1C1A | 3.59 | 3 | Input borders on panels |
| `focus` #8DB4DD | `canvas` #141413 | 8.52 | 3 | Focus ring |
| `focus` #8DB4DD | `surface` #1C1C1A | 7.89 | 3 | Focus ring on panels |
| `info-ink` #8DB4DD | `info-soft` #1E2A36 | 6.74 | 4.5 | Info pill and banner |
| `info-ink` #8DB4DD | `canvas` #141413 | 8.52 | 4.5 | Info text |
| `success-ink` #A7B98A | `success-soft` #232A1B | 7.01 | 4.5 | Success pill and banner |
| `success-ink` #A7B98A | `canvas` #141413 | 8.73 | 4.5 | Success text |
| `warning-ink` #D9B061 | `warning-soft` #2F2716 | 7.26 | 4.5 | Warning pill and banner |
| `warning-ink` #D9B061 | `canvas` #141413 | 9.07 | 4.5 | Warning text |
| `danger-ink` #EC8F96 | `danger-soft` #3A1D20 | 6.49 | 4.5 | Danger pill and banner |
| `danger-ink` #EC8F96 | `canvas` #141413 | 7.84 | 4.5 | Error text |
| `ink-on-accent` #141413 | `danger-fill` #E06C75 | 5.77 | 4.5 | Destructive button label |
| `neutral-ink` #B5B2A7 | `neutral-soft` #242422 | 7.32 | 4.5 | Neutral pill |
| `graph-edge` #75736A | `canvas` #141413 | 3.88 | 3 | Graph hierarchy edge |
| `graph-edge-dependency` #E8957A | `canvas` #141413 | 7.91 | 3 | Graph dependency edge |

**Factory and diagram pairs** (light / dark ratio)

| Foreground | Background | Light | Dark | Needs | Used for |
|------------|------------|-------|------|-------|----------|
| `ink` | `factory-ground` | 15.49 | 16.95 | 4.5 | Label on the ground |
| `ink-muted` | `factory-ground` | 5.80 | 9.27 | 4.5 | Secondary label on the ground |
| `ink-muted` | `factory-plate-top` | 6.72 | 7.74 | 4.5 | Label on a plate |
| `ink-muted` | `factory-floor` | 6.22 | 6.86 | 4.5 | Label on a bay floor |
| `factory-ink` | `factory-plate-top` | 11.41 | 11.31 | 4.5 | Symbol and glyph ink on a plate |
| `factory-ink` | `factory-floor` | 10.57 | 10.02 | 4.5 | Symbol and glyph ink on a bay floor |
| `factory-ink-soft` | `factory-plate-top` | 4.42 | 6.12 | 3 | Secondary glyph strokes |
| `factory-route` | `factory-ground` | 3.27 | 5.63 | 3 | Route on the ground |
| `factory-route` | `factory-floor` | 3.51 | 4.16 | 3 | Route on a bay floor |
| `factory-live` | `factory-ground` | 4.76 | 9.10 | 3 | Live work on the ground |
| `factory-live` | `factory-floor` | 5.11 | 6.73 | 3 | Live work on a bay floor |
| `factory-live` | `factory-live-soft` | 4.52 | 6.20 | 3 | Live mark on its tint |
| `factory-pass` | `factory-floor` | 5.50 | 6.90 | 3 | Passed mark |
| `factory-pass` | `factory-pass-soft` | 5.01 | 6.53 | 3 | Passed mark on its tint |
| `factory-fail` | `factory-floor` | 6.35 | 6.20 | 3 | Failed mark |
| `factory-fail` | `factory-fail-soft` | 5.50 | 6.22 | 3 | Failed mark on its tint |
| `factory-wait` | `factory-floor` | 5.02 | 7.16 | 3 | Waiting mark |
| `factory-wait` | `factory-wait-soft` | 4.49 | 6.76 | 3 | Waiting mark on its tint |
| `factory-human` | `factory-floor` | 5.20 | 6.25 | 3 | Human gate mark |
| `factory-human` | `factory-human-soft` | 4.64 | 5.74 | 3 | Human gate mark on its tint |
| `factory-select` | `factory-ground` | 4.22 | 7.70 | 3 | Selection bracket on the ground |
| `factory-select` | `factory-plate-top` | 4.89 | 6.42 | 3 | Selection bracket on a plate |
| `factory-plate-edge` | `factory-ground` | 3.06 | 4.28 | 3 | Plate outline against the ground |
| `factory-plate-edge` | `factory-plate-top` | 3.55 | 3.57 | 3 | Plate outline on its own top |
| `factory-ink` | `factory-machine-top` | 11.71 | 7.61 | 4.5 | Symbol on a machine top |
| `factory-ink-soft` | `factory-machine-top` | 4.53 | 4.12 | 3 | Idle symbol on a machine top |
| `ink-muted` | `factory-lamp` | 6.14 | 5.14 | 4.5 | Lettering under the work lamp |
| `factory-ink` | `factory-lamp` | 10.42 | 7.51 | 4.5 | Glyph ink under the work lamp |
| `factory-live` | `factory-lamp` | 5.04 | 5.04 | 3 | Live work under the work lamp |
| `factory-live` | `factory-machine-top` | 5.66 | 5.11 | 3 | Working dial on a machine top |
| `ink-muted` | `factory-plate-lit` | 5.63 | 8.27 | 4.5 | Name plate on a lit face |
| `ink-muted` | `factory-done` | 5.99 | 6.92 | 4.5 | Lettering in a finished bay |
| `factory-ink` | `factory-done` | 10.18 | 10.11 | 4.5 | Glyph ink in a finished bay |
| `factory-pass` | `factory-done` | 5.29 | 6.96 | 3 | Passed mark in a finished bay |
| `factory-halt` | `factory-floor` | 6.24 | 6.84 | 3 | Interrupted mark |
| `factory-halt` | `factory-plate-top` | 6.74 | 7.72 | 3 | Interrupted mark on a plate |
| `factory-stale` | `factory-floor` | 5.56 | 5.72 | 3 | Stale mark |
| `factory-stale` | `factory-plate-top` | 6.00 | 6.46 | 3 | Stale mark on a plate |
| `factory-stale` | `factory-ground` | 5.18 | 7.74 | 3 | Stale stamp on the ground |

### 2.8 Rules for choosing a role

1. **Surfaces step outward.** `canvas` is the page; panels are `surface` with a 1px `line` border and no shadow; anything that floats over the page is `surface-raised` with a shadow; wells, hover rows and inline code are `surface-sunken`.
2. **Text by importance.** `ink` for what must be read; `ink-muted` for supporting sentences; `ink-subtle` for captions, timestamps and metadata. Never go lighter than `ink-subtle` for text.
3. **Borders by meaning.** A border that tells a person "this is a control" uses `line-control` (3:1). A border that only divides uses `line` or `line-strong`.
4. **Terracotta only twice.** The primary action (`accent-fill`) and the current place (`accent`, `accent-soft`, `accent-ink`). Links use `accent-ink`. Do not use the accent for decoration, for state other than "ready for approval", or for live activity.
5. **One primary button per region.**
6. **State tones are a set.** Pick the tone from the meaning table in 2.3 and use its `-soft` background, `-line` border and `-ink` text together. Use `-fill` only for solid marks: bars, dots, the left edge of a graph node, a collapsed-rail badge dot.
7. **Live means blue.** In-progress work is `info` (interface) or `factory-live` (drawing), never the accent.
8. **Text on a tint uses that tone's ink.** Never put body `ink-muted` on a `-soft` tint without checking the pair.
9. **Check a new pair before using it.** If you put text or a meaningful mark on a combination not in 2.7, measure it against 4.5:1 or 3:1 first.

---

## 3. Typography

### 3.1 Families

There are exactly two faces. There is no serif and no second display face.

| Face | Package (npm, exact version) | Files imported | CSS family name | Weights available | Role |
|------|------------------------------|----------------|-----------------|-------------------|------|
| **Source Sans 3** (Adobe), variable, roman and italic | `@fontsource-variable/source-sans-3` **5.3.1** | `wght.css`, `wght-italic.css` | `'Source Sans 3 Variable'` | 200 to 900 | Every word: headings (bold), interface and reading text |
| **JetBrains Mono** (JetBrains), variable | `@fontsource-variable/jetbrains-mono` **5.3.0** | `wght.css` | `'JetBrains Mono Variable'` | 100 to 800 | Identifiers (`SLICE-001`, `FR-01`), paths, digests, code, commands, and in the Factory flavour logs, durations and time codes |

Stacks (with fallbacks):

```
--mach-font-sans:    'Source Sans 3 Variable', 'Segoe UI', system-ui, sans-serif;
--mach-font-mono:    'JetBrains Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace;
--mach-font-display: var(--mach-font-sans);
```

Both faces are under the SIL Open Font License 1.1 and are bundled from npm, so the built app serves them itself; the licence file travels with any redistribution. Nothing is loaded from a font service.

### 3.2 Where the monospace face may be used

Mono is used **only where the content is an identifier or code**; it is never a decorative label face.

- Allowed: engine IDs and ticket IDs, issue numbers in ID context, file paths, digests, commit hashes (shown as the first 10 characters), commands to copy, keyboard keys (`Kbd`), the factory's time codes and durations in feeds, tabular log values.
- Not allowed: headings, labels, buttons, status words, numbers that are figures (analytics figures are the sans, tabular, semibold; mono stays for identifiers).
- Identifiers carry `translate="no"` so browser translation leaves them alone, and are never reformatted.

### 3.3 Type scale

Sizes in rem, 1rem = 16px. "Face" is the default face for the step.

| Step | Size | Line height | Weight | Tracking | Face | Use |
|------|------|-------------|--------|----------|------|-----|
| `display` | 2.5rem (40px) | 2.875rem (46px) | 700 | -0.02em | sans (display) | One per page: the project's name, a page's subject |
| `title-1` | 1.875rem (30px) | 2.375rem (38px) | 700 | -0.015em | sans (display) | Page titles, a document's title |
| `title-2` | 1.4375rem (23px) | 1.875rem (30px) | 650 | -0.01em | sans (display) | Dialog and sheet titles, empty-state titles, epic headings, the "Carry on" heading |
| `title-3` | 1.125rem (18px) | 1.625rem (26px) | 600 | 0 | sans | Panel and group headings, side-panel headings, error titles |
| `body-lg` | 1.0625rem (17px) | 1.75rem (28px) | 400 | 0 | sans | Product writing; the reading size keeps the extra leading; quotations; recommendations |
| `body` | 1rem (16px) | 1.5rem (24px) | 400 | 0 | sans | Default interface text; the body element |
| `body-sm` | 0.875rem (14px) | 1.25rem (20px) | 400 | 0 | sans | Dense rows, buttons, hints, side-panel text |
| `label` | 0.875rem (14px) | 1.25rem (20px) | 600 | 0 | sans | Field labels, banner and toast titles, tab labels |
| `caption` | 0.8125rem (13px) | 1.125rem (18px) | 400 | 0.005em | sans | Metadata, timestamps, legends, pills and badges (set semibold there) |
| `mono` | 0.8125rem (13px) | 1.25rem (20px) | 450 | 0 | mono | Identifiers |

Notes on applying weights:

- The Tailwind text utilities for `display`, `title-1`, `title-2`, `body-lg`, `body`, `body-sm`, `caption` and `mono` set size, line height and (where defined) tracking, **not weight**. The heading component adds the weight: `font-bold` (700) on display and title-1, `font-[650]` on title-2, `font-semibold` (600) on title-3. `title-3` and `label` utilities also carry their weight.
- Weights in use across the apps: 400, 450 (mono), 600 (semibold), 650 (title-2, region lettering), 700 (bold).
- Factory Floor sometimes sets small sizes outside the scale in dense drawings: 11px, 11.5px, 12px, 12.5px (mono IDs in feeds and boards), 13px mono for ticket IDs. Treat these as part of the optional drawing module, not as new interface steps.

### 3.4 Measure and text rules

- **Sentence case everywhere.** No all-caps labels, no Title Case, no eyebrow above a heading.
- **Reading measure:** reading text is kept to **68ch** (`max-w-reading`) at any width. The analytics lead paragraph is limited to 46rem.
- **Headings** choose the document level and the visual step separately (`<Heading level size>`), so the outline stays correct. One `h1` per page. Headings use `text-wrap: balance`.
- **Numbers that line up** (counts, revisions, dates, durations, money) use tabular figures (`.tabular` = `font-variant-numeric: tabular-nums`). Analytics figures use `tabular-nums lining-nums`, weight 600, tracking -0.01em.
- **Requirement keywords** written in capitals for a validator (MUST, MUST NOT, SHALL, SHOULD, MAY, REQUIRED, RECOMMENDED, OPTIONAL) are lowered for reading ("must").
- **Italic** is used for quotations of other people's words, and in documents for placeholder text that has not been decided yet.
- **Body defaults:** `html` has `font-size: 100%`, antialiased smoothing, `text-rendering: optimizeLegibility` and `font-feature-settings: "kern", "liga"`. The body is 16px / 24px.
- **Text selection** uses `accent-soft` behind `ink`.
- **Long IDs and paths wrap** rather than overflow: grids use `minmax(0, 1fr)` columns and text uses `break-words` where an identifier may be long.

---

## 4. Space, layout and shape

### 4.1 Spacing scale

Spacing follows a **4px step** (Tailwind's default: `1` = 4px). Named rhythm values:

| Token | Value | Typical use |
|-------|-------|-------------|
| hairline | 1px | Borders, dividers |
| 1 | 4px | Icon to text in tight places, popover offsets, select viewport padding |
| 2 | 8px | Gap between buttons, between a pill and its neighbour; inside small controls |
| 3 | 12px | Gap inside a banner, panel padding top/bottom for rows, input horizontal padding |
| 4 | 16px | Panel padding, toast and banner horizontal padding, gap between groups in a header |
| 5 | 20px | Tab gap, rail section gap, sheet body vertical padding |
| 6 | 24px | Dialog and sheet horizontal padding, between groups, top bar horizontal padding |
| 8 | 32px | Between sections, analytics grid gaps |
| 10 | 40px | Page horizontal padding, between home sections |
| 12 | 48px | Large separations in documents |
| 16 | 64px | Page-centred empty states (vertical margin) |

Half steps that also occur: 2px (`0.5`), 6px (`1.5`), 10px (`2.5`), 14px (`3.5`).

Rhythm rules: inside a panel 8, 12 or 16; between groups 24; between sections 32 to 40; **page padding 40px horizontal, 32px top and bottom**.

### 4.2 Page widths and grid

| Name | Value | Use |
|------|-------|-----|
| Reading measure | 68ch | Reading text; `Page width="reading"` is capped at 68ch + 5rem (80px) including its padding |
| Content maximum | 1200px | `Page width="wide"` (the default) |
| Full | 100% height, no padding | Graphs and drawings |
| Product Studio home | 68ch + 12rem | The project home, slightly wider than reading |
| Analytics sheet | max 1360px, padding 24px 28px 56px (18px 20px 44px below 1280px) | Dense data sheets |

Grids use fractional columns with `minmax(0, 1fr)` so long IDs and paths wrap instead of overflowing. Common two-pane splits:

- Interview: `minmax(0, 1.15fr)` question column and `minmax(22rem, 1fr)` document column.
- Line board: `minmax(0, 1fr)` board and a 360px side panel.
- Analytics: a 212px area rail, `minmax(0, 1fr)` sheet, and a 400px drill drawer when open (184px rail below 1280px; the drawer then floats over the sheet at `min(400px, 92%)` with `shadow-3`).
- Analytics card grids: one column, then two at a sheet width of 800px, the lead layout `1.75fr 1fr` at 960px, three columns at 1040px, four at 1160px (container queries on the sheet). Gaps 32px (28px between four columns). Readouts: `repeat(auto-fit, minmax(180px, 1fr))`, gaps 20px by 28px.

### 4.3 The app shell

**Product Studio flavour** (`AppShell` without a rail):

```
┌─────────────────────────────────────────────────────────────────────┐
│ ■□ Product Studio | Project / Epic / Page     ● Connected | Saved  More ▾ │  top bar 56px
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   <Page>  padding 32px 40px, width reading | wide | full            │  <main>: the only scroller
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

- Frame: full viewport height (`100dvh`), `overflow: hidden`, `canvas` background, minimum width 1024px. Only `<main>` scrolls (`overflow-y: auto`); the page never scrolls sideways.
- **Skip link** "Skip to content" is the first tab stop: visually hidden until focused, then fixed at 12px from top and left, `surface-raised`, padding 8px 12px, `label` text, radius 5px, `shadow-2`, above everything (z 70). It moves focus to `<main>` (which has `tabindex="-1"` and no focus outline of its own).
- **Top bar**: height 56px, `canvas` background, bottom border 1px `line`, padding 0 24px, gap 16px. Left: where you are (mark, product name, breadcrumb), taking the remaining width. Right: status (connection and saved state), then at most one primary action, then the "More" menu.
- **Breadcrumb**: a `nav` named "Where you are", an ordered list in `body-sm` `ink-muted`, a vertical bar in `line-strong` after the product name, steps separated by "/" with 8px gaps; the first step (the project's name) is an `accent-ink` link back home (underline on hover); the last step is `ink`, semibold, `aria-current="page"`, truncated.

**With a rail** (available in the library; the rail variant):

- Rail width 248px expanded, 64px collapsed, `surface-nav` background, right border 1px `line`, width animates over 180ms standard easing.
- Rail header: 56px tall (matches the top bar), bottom border, brand at padding 16px, a 32px square collapse toggle (`ink-muted`, hover `surface-sunken`), named "Collapse navigation" / "Expand navigation" with `aria-expanded`.
- Rail body: sections 20px apart, padding 16px top and bottom, 12px sides (8px collapsed); footer with top border holds the theme switch.
- Below 1180px the rail collapses itself; the person can toggle it.

**Factory Floor flavour** (its own frame, same tokens):

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ■□ MACH Factory Floor [Line|Floor|Analytics|Decisions] │ Run title  WAVE-001  [Live Factory▾] (●Live) … ⓘ ? ☀☾▣ │ ≥48px, wraps
├──────────────────────────────────────────────────────────────┬───────────────────┤
│ stage (factory-ground)                                       │ inspector 344px   │
│                                                              │ (368px ≥1680px)   │
└──────────────────────────────────────────────────────────────┴───────────────────┘
```

- A CSS grid with areas `top top / stage inspector`, height `100dvh`, no minimum width (it reflows down to 320 CSS px). Row and column sizes animate over 400ms standard easing.
- Top bar: minimum 48px, wraps onto further rows rather than clipping; gap 12px (16px from 1100px), padding 4px 12px (16px from 1100px), bottom border `line`, `canvas` background. Order: brand, workspace switch, a 1×20px `line` divider, run identity (shrinks first), source and connection badges, then icon buttons and the theme choice.
- Inspector: a column at the right, 344px wide, 368px on windows 1680px and wider, left border `line`, `surface`. Below 1280px it is a drawer over the stage: `min(392px, 100vw - 32px)` wide, full width below 640px, `shadow-3`, sliding in from the right over 260ms with the enter curve. It opens when something is selected. The Line and Decisions have none (the Line has its side panel, Decisions its own pages).
- Skip link words name the destination: "Skip to the line", "Skip to the factory view", "Skip to the analytics", "Skip to the decisions".

### 4.4 Side panels, sheets and the full record

| Surface | Width | Behaviour |
|---------|-------|-----------|
| Inline side panel (Line view) | 360px | Part of the layout, left border `line`, `surface`, padding 16px 20px, scrolls on its own; below 900px it moves under the board (45% of the height) with a top border |
| Inspector column (Factory Floor) | 344px / 368px | As above |
| Drawer | 392px max | Over the stage below 1280px |
| Sheet | 400, 480 (default) or 640px, never wider than `100vw - 3rem` | Modal panel from the right edge, full height |
| Full-record dialog | `lg` dialog widened to `min(920px, 100vw - 2rem)` | A modal table of a record |

### 4.5 Control sizes

| Size | Height | Use |
|------|--------|-----|
| `sm` | 28px | Toolbars, dense rows, buttons inside banners and lists |
| `md` | 36px | The default |
| `lg` | 44px | The main act of a page (the "Carry on" button, the interview's answer buttons) |

Other fixed sizes in use: 32px square icon buttons in top bars and the rail; 24px status pills (20px small); 20px badges and keyboard keys; 28px workspace-switch segments and theme choices; 18px checkboxes; 24px toast close button. **Every target is at least 24×24px** (WCAG 2.5.8).

### 4.6 Radii

Radius by hierarchy: smaller things are tighter. Nothing else is used.

| Token | Value | For |
|-------|-------|-----|
| `xs` | 3px | Tags, badges, IDs, keyboard keys, checkboxes, segmented-control segments, copy buttons, the source stamp, the "stopped" marker |
| `sm` | 5px | Controls: buttons, inputs, selects, nav items, tooltips, command lines |
| `md` | 8px | Panels, banners, graph nodes, select menus, toasts, empty and error states, the Line's "Needs you" cards |
| `lg` | 12px | Dialogs, sheets, popovers |
| `full` | 999px | Status pills, connection badges, belt markers, filter chips |

The Factory Floor drawing's own small controls use 6px (zoom buttons, the meter) and 4px (the stale stamp); 2px for tiny squares and rows. These belong to the drawing module.

### 4.7 Borders and dividers

- Panels: 1px `line`, no shadow.
- Popovers, select menus, toasts: 1px `line-strong`.
- Controls: 1px `line-control`.
- Dashed borders mean "not settled" or "empty": empty states (`line-strong`, dashed), proposed graph nodes, held tickets, the Simulation stamp, the completeness badge, the analytics "not recorded" box (`line-control`, dashed).
- Selected row in a list: a 4px left border in `accent` with `surface` behind (Line board); selected item in a menu or rail: a 2px `accent` bar inset from the top and bottom.
- Dividers inside lists: `divide-y` in `line`.
- Section separators in documents and on the home page: a top border (`line` or `line-strong`) with 24px above the content.

### 4.8 Elevation

Three levels only (values in 2.6). Panels have none; floating things have them; in dark, elevation shows mainly as a lighter surface (`surface-raised` `#242422` over `surface` `#1C1C1A`).

Stacking order in use (**not defined as tokens**; these are the values the code uses): overlays, dialogs, sheets, popovers, tooltips and select menus at z 50; toasts at z 60; the skip link at z 70; within a stage, notices at z 20 and the inspector drawer at z 30.

### 4.9 Density

`--mach-density` is 1 for Product Studio and 0.875 for Factory Floor (set when `data-product="factory-floor"` is on the root). It is intended to scale row height and padding of dense tables and logs. **No component reads it yet**; a sister app may apply it to its own dense rows (multiply row height and vertical padding by it) or leave it.

### 4.10 Responsive behaviour and breakpoints

MACH targets laptops 1280 to 1728px wide, and a narrower 1100px layout.

| Width | Product Studio flavour | Factory Floor flavour |
|-------|------------------------|-----------------------|
| ≥ 1680px | | Inspector 368px |
| ≥ 1280px | | Inspector is a column (344px) |
| ≥ 1180px | Rail (when used) expanded, 248px | |
| 1100 to 1179px | Rail collapses to 64px icons; content keeps 40px padding | |
| < 1280px | | Inspector becomes a drawer; analytics rail 184px, drill drawer floats; long badge labels fold to their glyph |
| < 1100px | | Workspace switch shows icons only; top-bar gaps tighten |
| < 1024px | The shell keeps a 1024px minimum width rather than reflowing into a phone layout | Reflows; no minimum width |
| < 900px | | Line board and side panel stack; brand hides "Factory Floor" (kept for screen readers) |
| < 640px | | Run title takes its own row; drawer becomes full width |
| 320px | | Still usable (WCAG 1.4.10 reflow); 960px at 200% zoom with nothing cut off |

Tailwind's default breakpoints (`sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px, `2xl` 1536px) remain available but are rarely used; the apps use explicit `min-[…]` and `max-[…]` values at 639, 700, 799, 899, 1099, 1279, 1360, 1439 and 1680px. The breakpoint that matters to the shell is **1180px** (compact). The supported minimum is **1100px** in the token file; the Product Studio shell enforces **1024px** as its hard minimum.

---

## 5. Motion

### 5.1 Durations and easings

| Token | Value | For |
|-------|-------|-----|
| `instant` | 0ms | State that must not lag: checkbox ticks, selection |
| `fast` | 120ms | Hover, press and focus feedback; fade-outs; chevrons rotating |
| `base` | 180ms | Popovers, tooltips, tab changes, rail width, sheet exit |
| `slow` | 260ms | Dialogs, sheets and toasts entering; drawers |
| `layout` | 400ms | Graph re-layout, list reordering, frame column changes |

| Easing | Curve | For |
|--------|-------|-----|
| `standard` | `cubic-bezier(0.2, 0, 0, 1)` | Most transitions |
| `enter` | `cubic-bezier(0, 0, 0, 1)` | Things arriving (fade-in, pop-in, sheet-in) |
| `exit` | `cubic-bezier(0.4, 0, 1, 1)` | Things leaving (fade-out, sheet-out) |

### 5.2 Keyframes and where they are used

| Animation | Keyframes | Duration and easing | Used by |
|-----------|-----------|---------------------|---------|
| fade-in | opacity 0 → 1 | base (180ms), enter | Dialog overlay, tooltip |
| fade-out | opacity 1 → 0 | fast (120ms), exit | Dialog, popover and toast closing |
| pop-in | opacity 0, translateY(4px) scale(0.98) → none | base (180ms), enter | Dialogs, popovers, select menus, toasts opening |
| sheet-in | translateX(100%) → none | slow (260ms), enter | Sheets opening |
| sheet-out | none → translateX(100%) | base (180ms), exit | Sheets closing |
| shimmer | background-position 100% → 0 | 1.6s linear, infinite | Skeleton placeholders only |
| spin | rotate | Tailwind default | Spinner |

Other motion in the apps:

- Buttons, inputs, nav items and tabs transition background, border, colour and shadow over 120ms standard.
- The disclosure chevron rotates 90° and the "More" menu chevron 180° over 120ms.
- Graph nodes move to new positions over 400ms standard; the graph fits its view over 400ms.
- A Factory Floor workspace fades in over 160ms with the standard curve when switched to.
- The analytics drawer slides 16px from the right over 180ms enter, without fading, so its text has full contrast from the first frame.
- Theater chrome (the drawing's full-screen mode) fades in on pointer movement over 180ms.

Motion presets for scripted animation (the `motion` library): fast = 120ms standard; base = 180ms standard; slow = 260ms enter; layout = 400ms standard. Under reduced motion each returns an instant transition.

### 5.3 What may move, and when

- Motion **answers a person's action** (open, close, hover, select, switch) or **shows what changed** (a list reorders, a node moves to its new place, a figure settles once when a filter changes).
- **Nothing moves on its own.** Nothing idles, breathes, shimmers or pulses; nothing loops; no camera shake. Exceptions as built: the skeleton shimmer while loading, the spinner, and the Line view's working marker (section 13).
- A live update never animates a figure; figures settle once on a window or filter change only.
- Video uses the browser's own controls and never autoplays.
- Work in flight is never animated as progress; it shows a static "working" mark and the elapsed time in words.
- In the factory drawing every animation is a pure function of time since its event (section 7.11), so scrubbing backwards shows the earlier frame.

### 5.4 Reduced motion

Under `prefers-reduced-motion: reduce`:

- Every duration token collapses to 0ms.
- CSS transitions and keyframe animations are removed outright (`animation: none !important; transition: none !important; scroll-behavior: auto !important` on every element). A near-zero duration is not used, because it still starts a transition for every changed property.
- Every keyframe ends on the element's own resting style, so removing it shows the same end state; nothing waits for `transitionend` or `animationend`.
- The spinner stops rotating and stays visible; the skeleton is a still block.
- Scripted animations check the media query themselves and become instant; camera moves jump; a mode switch is a cut, announced by a polite live region instead.
- In the factory drawing, travel snaps to its end state at the event time and appearance is at most a 160ms linear opacity fade.

---

## 6. Iconography, the brand mark and state shapes

### 6.1 Icon set

- **Lucide** (`lucide-react` **1.72.0**, ISC licence), at its default 2px stroke unless noted. No other icon set, and no Anthropic icon.
- Icons are always `aria-hidden="true"`; the accessible name comes from visible text or `aria-label`.
- An icon in an empty state "names the kind of thing, not decoration".

Sizes in use:

| Size | Where |
|------|-------|
| 12–13px | Analytics small actions (Rows, Table/Chart toggle, remove filter) |
| 14px | Inside pills and badges, copy button, checkbox check and minus (stroke 3), theme options, small chevrons, the "Back" arrow |
| 16px | Inside buttons (all sizes), selects, rail toggle, top-bar icon buttons, toast close, field error icon, disclosure chevron |
| 18px | Navigation items, banner and toast icons |
| 20px | Empty-state and error-state icons |

Icons used and what they mean: `Info` (info), `CircleCheck` (success; everything saved), `TriangleAlert` (warning; attention on a graph node), `CircleAlert` (danger; field errors; refusals), `Check` (checked, selected option, copied, accept), `Minus` (indeterminate), `Copy`, `X` (close, dismiss, remove filter), `ChevronRight` (disclosure), `ChevronDown` (select, menu), `PanelLeftClose`/`PanelLeftOpen` (rail), `PanelRight`/`PanelRightClose` (inspector), `Link2` (connected), `Link2Off` (host not responding), `LockKeyhole` (session ended), `CloudOff` (not saved yet), `RefreshCwOff` (GitHub not checked), `WifiOff` (stream lost), `Sun`/`Moon`/`Monitor` (theme), `ArrowLeft` (back), `ArrowRight` (go on to a page), `Plus` (add), `Send` (send an answer), `HelpCircle`/`CircleHelp` (explain, keyboard help), `TvMinimalPlay` (theater mode), `Rows3`, `ChartColumn`, `Table2`.

### 6.2 Stroke rules for drawn glyphs

- Custom state glyphs are drawn on a 16×16 view box at a default size of 14px, strokes 1.4 to 1.8 with round caps and joins, filled shapes in `currentColor`, inner marks (tick, arrow, question mark, bar) in `var(--mach-surface)` so they read on the filled disc in both themes.
- The Line view's small shapes use a 12×12 view box.
- The factory drawing uses three structure weights only (0.75, 1 and 1.5px) plus 2 to 2.6px for things that act (gate arms, live routes, posts). Its station symbols are on a 24 grid at 1.5 stroke with round caps.

### 6.3 The MACH mark

"Four cells, one lit": each piece of work is built in its own isolated cell; the mark is that idea drawn plainly. It is MACH's own and borrows no third-party logo.

Construction, on a 20×20 view box:

| Cell | Position (x, y) | Size | Corner radius | Paint |
|------|-----------------|------|---------------|-------|
| Top left | 1, 1 | 8×8 | 1.5 | Filled `ink` |
| Top right | 11, 1 | 8×8 | 1.5 | Outline `ink`, stroke 1.5, no fill |
| Bottom left | 1, 11 | 8×8 | 1.5 | Outline `ink`, stroke 1.5, no fill |
| Bottom right | 11, 11 | 8×8 | 1.5 | Filled `accent` (terracotta) |

```html
<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
  <rect x="1" y="1" width="8" height="8" rx="1.5" fill="var(--mach-ink)"/>
  <rect x="11" y="1" width="8" height="8" rx="1.5" fill="none" stroke="var(--mach-ink)" stroke-width="1.5"/>
  <rect x="1" y="11" width="8" height="8" rx="1.5" fill="none" stroke="var(--mach-ink)" stroke-width="1.5"/>
  <rect x="11" y="11" width="8" height="8" rx="1.5" fill="var(--mach-accent)"/>
</svg>
```

Sizes: 20px in Product Studio, 18px in Factory Floor. It is always decorative (`aria-hidden`), next to words.

Wordmark lock-up: mark, 10px gap, then "MACH" in `label` (14px/600) `ink` followed by the product name in regular weight `ink-muted` ("MACH Factory Floor"); an optional second line with the project's name in `caption` `ink-subtle`. Product Studio's top bar uses the mark followed by "Product Studio" in `label`.

A sister app uses the same mark and lock-up with its own product name. (The approved mockups draw the lit cell top right; the code, which wins, lights the bottom right and fills the top left. See section 13.)

### 6.4 State glyph shapes (interface)

Every lifecycle and graph state has a glyph that differs in **shape**, so state reads in greyscale, for colour-blind people and in print. Geometry on a 16×16 view box:

| Glyph | Shape | Construction | Means |
|-------|-------|--------------|-------|
| `open` | Dashed ring | circle r 6, stroke 1.6, dash 2.6 2.1 | Nothing settled yet (draft, proposed) |
| `half` | Half-filled ring | ring r 6 stroke 1.6, left half filled | Being worked out (interviewing); an open question |
| `ready` | Ring with dot | ring r 6 stroke 1.6, dot r 2.4 | Settled, waiting for a person |
| `approved` | Solid disc with tick | disc r 7, tick in surface colour, stroke 1.8 | A person approved it |
| `submitted` | Solid disc with arrow | disc r 7, right arrow in surface colour, stroke 1.7 | Handed over: ready to build; saved to a folder |
| `building` | Three-quarter-filled ring | ring r 6, three quarters filled | Being built |
| `question` | Solid disc with question mark | disc r 7, question mark in surface colour | The builders asked a question |
| `accepted` | Double ring | ring r 6.6 stroke 1.4 around a disc r 4.2 | Shipped; completed |
| `blocked` | Octagon with bar | filled octagon, horizontal bar in surface colour, stroke 1.8 | Cannot move until someone acts; an error |
| `superseded` | Ring with slash | ring r 6 stroke 1.6 with a diagonal slash | Replaced or deferred, kept for history |

### 6.5 State shapes of the Line view (Factory Floor)

The Line view, which shows each piece of work moving through stations, uses a smaller set of five ticket states, each with its own shape on a 12×12 view box, and an outline treatment:

| State | Word | Shape | Marker outline | Tone (ink / tint) |
|-------|------|-------|----------------|-------------------|
| working | Working | Filled dot (r 4) | Solid, round | `factory-live` / `factory-live-soft` |
| held | Held | Two upright bars | **Dashed**, round | `factory-wait` / `factory-wait-soft` |
| person | Waiting for you | Diamond | Solid, round | `factory-human` / `factory-human-soft` |
| stopped | Stopped | Square | Solid, **square-cornered** (3px) | `factory-fail` / `factory-fail-soft` |
| landed | Landed | Disc with tick | Solid, round | `factory-pass` / `factory-pass-soft` |

### 6.6 State shapes of the factory drawing (optional module)

| State | Word | Mark | Outline |
|-------|------|------|---------|
| idle | Idle | Dashed ring | Dashed 3/2.5 |
| active | Working | Ring with four spokes (static) plus elapsed ticks | Solid ×1.25 |
| succeeded | Passed | Disc with tick | Solid |
| failed | Failed | Disc with cross | Solid ×1.5 |
| waiting | Waiting | Ring with hourglass | Dashed 5/2.5 ×1.25 |
| human | Waiting for a person | Ring with dot | Solid ×1.5 |
| blocked | Blocked | Octagon with bar | Solid ×2 |
| interrupted | Interrupted | Ring cut open with a bar across the cut | Dashed 4/2 ×1.5 |
| stale | As last seen | Ring of dots with a clock hand | Dotted 1.2/2 ×1.25 |
| unknown | Not known | Open ring with a question mark | Dotted 0.1/2.4 |

A finished cell shows a double ring. "Unknown" is never shown as zero or idle; "stale" is never "paused".

### 6.7 Source and connection glyphs (Factory Floor)

On a 10×10 view box: **Live source** is a dot (r 2.4) inside a ring (r 4.3); **Simulation** is a dashed ring (r 4, dash 2/1.6). **Connection**: live is a filled dot; connecting and reconnecting a ring with one quarter filled; stale a ring with a clock hand; disconnected a cross. **Completeness** (history not complete) is a broken line with a slash.

---

## 7. Components

Each entry gives purpose, anatomy, variants and sizes, states, tokens and measurements, keyboard and ARIA, and do and do not. "Global focus" means the one focus treatment: `outline: 2px solid var(--mach-focus); outline-offset: 2px` on `:focus-visible`. Pixel values come from the classes in the library.

The library is built on Radix primitives (dialog, popover, select, tabs, toast, tooltip, checkbox, slot), so the keyboard and ARIA behaviour of those components is Radix's: a sister app not using React should reproduce that behaviour exactly (the WAI-ARIA Authoring Practices patterns of the same names).

### 7.1 Typography components

**Heading.** `level` (1 to 4) sets the element; `size` (`display`, `title-1`, `title-2`, `title-3`) sets the look; defaults: h1 → title-1, h2 → title-2, h3 and h4 → title-3. Always `ink`, `text-wrap: balance`. Weights as in 3.3.

**Text.** `as` p/span/div/dd/dt/li; `size` body-lg/body/body-sm/caption (default body); `tone` default (ink), muted, subtle, accent (accent-ink), danger, success, warning, info (their `-ink`); `weight` regular or semibold.

**Prose.** Long-form reading: max 68ch, `body-lg`, `ink`; paragraphs after the first 16px apart; strong is semibold; bulleted lists with 20px indent, items 4px apart.

**ArtifactId** (an identifier). Inline, no wrapping, mono 13px/20px weight 450, `ink-muted`, tabular, `translate="no"`; default with a `surface-sunken` background, padding 1px 6px, radius 3px; `plain` drops the background (inside dense rows). Within running text, any `XX-00` pattern (two or more capitals, a hyphen, two or more digits) is set this way in `ink` (`IdText`).

**Kbd** (a keyboard key). Height 20px, minimum width 20px, radius 3px, 1px `line-strong` border, `surface`, padding 0 4px, mono `caption`, `ink-muted`.

**Quote** (someone else's words). A `figure` with a 2px `line-strong` left border and 16px left padding; the quotation in `body-lg` italic `ink`; the caption 4px below in `body-sm` `ink-muted` with the author's name semibold `ink` followed by what kind of remark it was ("asked for changes", "commented"). Never a button, never an instruction.

**RichText.** Light Markdown from a back end or an interviewer: paragraphs (12px apart), numbered and bulleted lists (20px indent, items 6px apart), `**bold**` (semibold) and `` `code` `` (mono, `surface-sunken`, radius 3px, padding 0 4px). Rendered as text, never as HTML. `editorial` uses `body-lg`.

### 7.2 Button

Purpose: everything that performs an action. Labels say what happens.

Anatomy: optional leading icon (16px), label, optional trailing icon; 8px gap; centred; never wraps.

| Variant | Rest | Hover | Use |
|---------|------|-------|-----|
| `primary` | `accent-fill` background, `ink-on-accent` label, `shadow-1` | `accent-fill-hover` | The one main action in a region: approve, mark ready, save, continue |
| `secondary` (default) | 1px `line-control` border, `surface` background, `ink` label | `surface-sunken` background | Everything else that is a button |
| `ghost` | No border or background, `ink-muted` label | `surface-sunken` background, `ink` label | Low-emphasis actions in toolbars and lists |
| `danger` | `danger-fill` background, `ink-on-accent` label, `shadow-1` | `danger-fill-hover` | Withdraws or removes something; always confirmed in a dialog |
| `link` | No height or padding, `accent-ink`, underline 1px with 3px offset | Underline 2px | Inline text action |

| Size | Height | Horizontal padding | Text |
|------|--------|--------------------|------|
| `sm` | 28px | 10px | `body-sm` (14px), 600 |
| `md` (default) | 36px | 14px | `body-sm` (14px), 600 |
| `lg` | 44px | 20px | `body` (16px), 600 |
| `icon` | 36×36px | 0 | icon only |
| `icon-sm` | 28×28px | 0 | icon only |

Shared: radius 5px, sans, weight 600, transition of background, border, colour and shadow over 120ms standard.

States:
- **Focus:** global focus ring.
- **Active (pressed):** not defined separately; hover styling holds.
- **Disabled:** opacity 50%, `cursor: not-allowed` (also for `aria-disabled`).
- **Loading:** keeps its width; the content becomes invisible and a 14px spinner (accessible name "Working") is centred over it; `aria-busy="true"`; clicks are swallowed.
- **Error:** not a button state; a refused act is shown where the act was confirmed (7.7).

Keyboard and ARIA: a native `button` with `type="button"` unless it submits. An icon-only button needs `aria-label` and a tooltip with the same words (and the shortcut, if any: "Hide the inspector (I)"). A button that toggles uses `aria-pressed`. A button can render as a link (`asChild`) for navigation that looks like a button.

Factory Floor's top-bar **icon button**: 32×32px, radius 5px, `ink-muted`, hover `surface-sunken` and `ink`, icon 16px, disabled opacity 40%, tooltip "label (shortcut)", `aria-keyshortcuts` when it has one.

Do: name the act and its object ("Approve EPIC-001", "Mark ready to build", "Open the full record"). Keep one primary per region. Put the confirming button last.
Do not: write "Submit" or "OK"; use primary for navigation; use danger without a confirming dialog; use the accent colour for a secondary act.

### 7.3 Inputs: text field, text area, field wrapper

**Field** wraps label, hint, control and error and wires them together for assistive technology. Column, 6px gap:

1. Label: `label` (14px/600) `ink`, linked to the control. Optional fields add a space and "optional" in regular weight `ink-subtle`, with a visually hidden comma before it so the name reads "The idea, optional".
2. Hint (optional): `body-sm` `ink-muted`, 2px tighter to the label; says what belongs here.
3. The control.
4. Error (optional): `body-sm` `danger-ink`, a 16px `CircleAlert` and the message, 6px gap; says what is wrong and how to fix it.

The control receives the field's `id`, `aria-describedby` (hint and error ids) and `aria-invalid="true"` when there is an error.

**Input** (single line):

| Size | Height | Padding | Text |
|------|--------|---------|------|
| `sm` | 28px | 0 8px | `body-sm` |
| `md` (default) | 36px | 0 12px | `body` |
| `lg` | 44px | 0 14px | `body` |

**Textarea:** padding 8px 12px, minimum height 80px, 4 rows by default, resizes vertically only, `body` (or `body-lg` when `editorial`, for product writing such as a vision or a why).

Shared control look: full width, radius 5px, 1px `line-control` border, `surface` background, `ink` text, placeholder `ink-subtle`, border and shadow transition 120ms.

| State | Look |
|-------|------|
| Rest | As above |
| Hover | Border `ink-subtle` |
| Focus | 2px `focus` outline at 0 offset, border `focus` |
| Invalid | Border `danger-ink` (plus the field's error text) |
| Disabled | Background `surface-sunken`, text `ink-subtle`, `cursor: not-allowed` |
| Read-only | Background `surface-sunken` |
| Loading | Not defined |

Do: put the label above, the hint under the label, the error under the control. Use the editorial text area for prose people will read back.
Do not: use placeholder text as the label; show an error without saying how to fix it.

### 7.4 Select

Purpose: one choice from a short list (up to about 12 options). For more, a searchable combobox is called for; **the system defines no combobox**.

Anatomy: a trigger that looks exactly like an input (sizes `sm` 28px / `md` 36px), showing the chosen label or the placeholder ("Choose…" by default, in `ink-subtle`), and a 16px `ChevronDown` in `ink-muted` at the right; a menu below.

Menu: 4px below the trigger, at least the trigger's width, at most the available height, radius 8px, 1px `line-strong` border, `surface-raised`, `shadow-2`, pop-in. Inside, 4px padding. Each option: radius 5px, padding 6px 12px 6px 32px, `body`; a 16px `accent-ink` check at 8px from the left for the chosen one; an optional second line in `caption` `ink-subtle` (for example an epic's status). Highlighted option: `accent-soft` background, `ink` text. Disabled option: 50% opacity, and its description says why it is disabled.

Keyboard and ARIA (listbox pattern): Space, Enter or the arrow keys open it; arrows move; typing jumps to a match; Enter or Space chooses; Escape closes and returns focus to the trigger. Needs a label from a Field or `aria-label`.

### 7.5 Checkbox

Anatomy: an 18×18px box, radius 3px, 1px `line-control` border, `surface` background, 2px from the top of its label; to its right (10px gap) a label in `body` `ink` and an optional description in `body-sm` `ink-muted` (linked with `aria-describedby`).

States: checked and indeterminate fill the box and border with `accent-fill` and show a 14px `Check` or `Minus` (stroke 3) in `ink-on-accent`; disabled 50% opacity, `cursor: not-allowed`, and the label fades with it; focus is the global ring. The tick appears instantly (no transition).

Keyboard: Space toggles. Without a visible label, pass `aria-label`.

Do: say why a disabled option is disabled.

**Radio group.** No general radio component is defined. The pattern in use (theme switch, workspace switch) is a `fieldset` with a visually hidden `legend` and real radio inputs, visually hidden, inside styled labels; arrow keys move and the choice is announced (7.13).

### 7.6 Badges and status pills

**Badge**: a small rectangular tag for a fact (a count, a risk tier, where something came from). Height 20px, padding 0 6px, 4px gap, radius 3px, 1px border, `caption` semibold, tabular. Filled (default): the tone's `-soft` background, transparent border, `-ink` text. Outline: transparent background, `-line` border, `-ink` text, for secondary facts such as "draft" or a risk tier. Tone defaults to neutral.

**Status pill**: the state of something, in words, with a shape. Radius full, 1px border in the tone's `-line`, `-soft` background, `-ink` text, `caption` semibold, never wraps, 6px gap; the icon (a state glyph or a 14px Lucide icon) first.

| Size | Height | Padding |
|------|--------|---------|
| `md` (default) | 24px | 0 10px 0 8px |
| `sm` | 20px | 0 8px 0 6px |

The pill carries a `title` with the state's one-sentence description. A pill must read in greyscale: never a pill without its glyph or without its word.

Factory Floor variants:
- **Line state pill**: 24px, radius full (3px for "stopped"), border, padding 0 10px, `caption` semibold, the 10px state shape, tones from 6.5.
- **Source stamp / source badge**: 24px (28px large), padding 0 8px (0 10px), radius 3px, `caption` (`label` large) **bold**. Live Factory: `factory-live` border on `factory-live-soft`, `factory-live` text. Simulation: **dashed** `warning-line` border on `warning-soft`, `warning-ink` text. As a menu trigger it adds a 14px chevron at 80% opacity.
- **Connection badge**: 24px, radius full, 1px border, padding 0 8px, `caption` semibold tabular: Connecting (`line-strong` border, `ink-muted`); Live (`factory-live` border and text); Reconnecting (dashed `warning-line`, `warning-ink`); Stale since hh:mm:ss (`warning-line`, `warning-soft`, `warning-ink`); Disconnected (`danger-line`, `danger-soft`, `danger-ink`).
- **Completeness badge**: 24px, radius 3px, dashed `line-strong` border, `caption` semibold `ink-muted` ("Partial since 10:42", "Reconstructed since …", "Not all interpreted").
- **Places chip**: one 9×9px square (radius 2px, 1.5px `factory-ink-soft` border, filled when in use) per available place, then "3 of 4 places working" in `caption` `ink-muted`.
- **Filter chip** (analytics): 28px, radius full, 1px `accent` border, padding 0 8px 0 12px, `body-sm` `accent-ink`, the dimension in `ink-muted` then the value semibold, a 13px `X`; hover `accent-soft`. Its name says "…, remove this filter".

### 7.7 Banner

Purpose: a persistent message about the page or workspace (something to settle, something offline, an approval withdrawn). It stays until the situation changes; it is not a toast.

Anatomy: a row with 12px gap, radius 8px, 1px border, padding 12px 16px, the tone's `-soft` background and `-line` border. An 18px icon in the tone's ink (2px down): `Info`, `CircleCheck`, `TriangleAlert` or `CircleAlert`. Then a column (4px gap) of a title in `label` and the tone's ink, and an optional body in `body-sm` `ink`. Then optional actions at the right, vertically centred, 8px apart (usually `sm` secondary buttons).

Tones: info, success, warning, danger.

Live behaviour: `live="polite"` (role `status`) announces a change that arrived while the person worked (refresh results); `live="assertive"` (role `alert`) only for a failure that blocks what they are doing; static banners have no role.

Do: group everything that is waiting for the person into one banner with a list and one action ("3 things need your answer" → "Answer them").
Do not: use a banner to confirm that something succeeded (use a toast); stack more than a few.

### 7.8 Overlays

**Dialog** (a modal decision, or a short form).

- Overlay: fixed, full screen, `overlay` colour, fades in (180ms) and out (120ms).
- Panel: fixed, horizontally centred, top at 12vh, maximum height 76vh, width `100vw - 2rem` capped at **448px (`sm`), 512px (`md`, default) or 672px (`lg`)**; radius 12px; 1px `line` border; `surface-raised`; `shadow-3`; pops in (180ms) and fades out (120ms).
- Header: padding 20px 24px 0, the title (`title-2`, weight 650, `ink`) above the description (`body`, `ink-muted`), 6px apart; a ghost `icon-sm` close button (`X`, named "Close") at the right, pulled 8px into the padding.
- Body: padding 16px 24px 0, scrolls when tall.
- Footer: padding 20px 24px, buttons right-aligned, 8px apart, **the confirming button last**.
- Title and description are both required (the description becomes the accessible description).
- Keyboard: focus is trapped; Escape closes; focus returns to what opened it (if that control is gone, for example an Approve button replaced by the approved state, focus goes to the page's `h1`, then to `<main>`, never to the page body). While a dialog is open, Escape belongs to it, not to a toast.

**Confirm dialog** (every personal act goes through it).

- Title: a question naming the act and its object: "Approve EPIC-001: Team membership?"
- Description: what the act means and what it does not do, in one or two sentences.
- Optional body: counts, what will be shared (often a `surface-sunken` well, radius 8px, padding 12px 16px).
- Buttons: a secondary cancel (default "Not now") and the act's own verb as confirm ("Approve epic", "Mark as met"), `primary` or `danger`.
- Confirming shows the spinner in the confirm button, disables cancel and blocks a second click; the dialog cannot be dismissed while the act runs.
- A refusal stays inside the dialog, above the buttons, in the back end's own words: role `alert`, 16px top margin, radius 8px, 1px `danger-line`, `danger-soft`, padding 10px 12px, a 16px `CircleAlert` in `danger-ink`, the title in `label` `danger-ink`, the message in `body-sm` `ink` (line breaks kept), and an optional action that would resolve it.

**Sheet** (detail beside the page, from the right edge).

- Fixed to the right edge, full height, width `min(W, 100vw - 3rem)` with W = 400, **480 (default, detail)** or 640px (side-by-side comparison); 1px `line` left border; `surface-raised`; `shadow-3`; slides in over 260ms (enter) and out over 180ms (exit); same overlay as the dialog.
- Header: bottom border, padding 16px 24px, title `title-2` (650) and optional description in `body-sm` `ink-muted` (when absent, the title is repeated as a hidden description), close button as in the dialog.
- Body: padding 20px 24px, scrolls.
- Footer (optional): top border, padding 16px 24px, buttons right-aligned, 8px apart.
- Modal: focus trapped, Escape closes, focus returns.

**Popover** (non-modal, anchored: a legend, a filter, a short explanation with a link onward).

- 6px from its trigger, aligned to the start by default, width 288px by default (320px or 384px in the connection and source popovers), radius 12px, 1px `line-strong` border, `surface-raised`, padding 16px (8px when it holds a menu), `body-sm` `ink`, `shadow-2`, pop-in and fade-out.
- Escape or a click outside closes it; focus returns to the trigger.

**Tooltip** (names an icon-only control).

- Opens after 500ms on hover, at once when moving between tooltips (300ms skip window), and on keyboard focus; Escape closes.
- 6px from the trigger, above by default; maximum width 256px, radius 5px, `surface-inverse` background, `ink-inverse` text in `caption`, padding 4px 8px, `shadow-2`, fades in.
- Holds a short label: what the control does, or its keyboard shortcut. Never essential information.

**Menus.** No general dropdown-menu component is defined. Two menus exist: the navigation menu (7.13) and Factory Floor's source menu (a popover holding a `role="menu"` list of `menuitemradio` buttons: a 16px check column, then a semibold `body-sm` name with its glyph and a `caption` `ink-muted` line; rows have radius 5px, padding 8px, hover `surface-sunken`; an unavailable choice is disabled at 60% opacity and says what it needs).

### 7.9 Graph (optional module)

A read-only diagram of a hierarchy with dependencies (in MACH: project → epics → slices), laid out left to right so the left-to-right order is delivery order. Built on React Flow 12 (`@xyflow/react` 12.12.1) with ELK's layered layout (`elkjs` 0.12.1, loaded on first use, about 1.4MB).

- **Container**: radius 8px, 1px `line` border, `canvas`, minimum height 192px; a dotted background (dot gap 20px, size 1.2px, `graph-dot`); zoom controls bottom right (28×28px buttons, radius 5px, 1px `line` border, `surface-raised`, `ink-muted`, hover `surface-sunken` and `ink`, `shadow-2`); zoom 0.3 to 1.5; fit with 15% padding and at most zoom 1, refitted when the box resizes. While laying out, three skeleton blocks show and the box is `aria-busy`.
- **Layout**: layered, orthogonal edges, 28px between nodes in a layer, 72px between layers.
- **Node** (one component for every kind): sizes project 264×84, epic 232×84, slice 256×92px; radius 8px; `surface` (the project node `surface-raised` with `shadow-1`); padding 10px 12px; a left bar in the state's tone fill, 6px wide for a project, 4px for an epic, 2px for a slice. Three lines: kind word in `caption` `ink-subtle` with the ID in mono `caption` `ink-muted` at the right; the title on one line (`body-sm` semibold; the project in `title-3`); the state (12px glyph and word, `caption` semibold in the tone's ink) with either a short fact in `caption` `ink-subtle` ("2 open questions", "#41") or, in `warning-ink` with a 14px `TriangleAlert`, what must be settled ("Changed on GitHub", "Number taken").
- **Node border by state**, so state reads without colour: proposed dashed `line-control`; interviewing, ready, approved, ready to build, being built solid `line-strong`; question from the builders heavy (2px `danger-ink`); shipped double (3px double `success-line`); superseded dashed and faded to 60%.
- **Selected node**: 2px `accent` outline, 2px offset. **Focused node**: 2px `focus` outline, 3px offset.
- **Edges**: containment is a smooth-step path, radius 10, 1.25px `graph-edge`, receding; dependency is a smooth-step path, 1.5px `graph-edge-dependency`, dashed 5/4, with a filled arrowhead (7px marker) pointing at the item that needs the other.
- **Re-layout** animates node positions over 400ms standard (instant under reduced motion).
- **Interaction**: no dragging or connecting. Tab moves between nodes; Enter or Space selects.
- **Outline alternative** (required beside every graph): the same graph as a nested list. Each row a button: glyph in the tone's ink, ID in mono `caption` `ink-muted`, title (semibold at the top level), state in `caption` `ink-subtle`, attention in `caption` semibold `warning-ink`, "needs SLICE-002" in `caption` `ink-subtle`; rows radius 5px, padding 4px 8px, hover `surface-sunken`, the selected one `accent-soft` with `aria-current`. Children are indented 16px with a 1px `line` rule and 8px padding.

Graph state vocabulary:

| State | Word | Tone | Glyph | Border |
|-------|------|------|-------|--------|
| proposed | Proposed | neutral | open | dashed |
| interviewing | Interviewing | info | half | solid |
| ready | Ready for approval | accent | ready | solid |
| approved | Approved | success | approved | solid |
| ready_to_build | Ready to build | info | submitted | solid |
| building | Being built | info | building | solid |
| question | Question from the builders | warning | question | heavy |
| shipped | Shipped | success | accepted | double |
| superseded | Superseded | neutral | superseded | dashed, faded |

### 7.10 Lifecycle and specification pieces (optional module)

These show where an item is on its path and what an automated check said about a written specification. Include them if your app has items that move through approval states or documents that are checked.

**Status pills by kind** (word, tone, glyph; each with a one-sentence description used as its tooltip):

| Item | State | Word | Tone | Glyph |
|------|-------|------|------|-------|
| Slice | draft | Draft | neutral | open |
| | interviewing | Interviewing | info | half |
| | ready for approval | Ready for approval | accent | ready |
| | approved | Approved | success | approved |
| | superseded | Superseded | neutral | superseded |
| Epic | proposed | Proposed | neutral | open |
| | approved | Approved | success | approved |
| | deferred | Deferred | warning | superseded |
| | completed | Completed | success | accepted |
| | superseded | Superseded | neutral | superseded |
| With the builders | ready | Ready to build | info | submitted |
| | building | Being built | info | building |
| | question | Question from the builders | warning | question |
| | shipped | Shipped | success | accepted |
| Marks needing a person | changed after approval | Changed on GitHub after you approved it | danger | blocked |
| | newer elsewhere | Newer version saved by someone else | warning | superseded |
| | number taken | Number already taken | warning | blocked |
| | unfinished | Saving did not finish | warning | blocked |
| | folder | Saved to a folder | neutral | submitted |

Marks are shown beside the item's own pill, never instead of it, in a fixed order, and nothing is shown when nothing was reported.

**Lifecycle path** (`SliceLifecycle`): an ordered list named "Slice progress". Steps in a row joined by 1px connectors (at least 24px, 8px margins), `ink-subtle` up to the current step and `line-strong` after it. Each step: a 20px circle with the step's 12px glyph (a 14px tick, stroke 2.5, for past steps), then the word in `body-sm`. Past steps `ink-muted`; the current step in the tone's soft and ink with a 1px ring in the current colour, its word semibold `ink`, `aria-current="step"`; later steps `ink-subtle`. A visually hidden ", done", ", current step" or ", not reached" follows each word. While interviewing, the current step adds "(2 open questions)". A superseded item shows the path at 60% opacity with the superseded glyph and its description below.

**Stepper** (a short guided flow): the same idea with numbered 24px circles (`caption` semibold tabular): current `accent` border, `accent-soft`, `accent-ink`; done `line-strong` border, `surface-sunken`, `ink-muted`; later `line-strong` border, `ink-subtle`. Connectors 1px, 32px wide (48px from 640px). Labels `body-sm`, the current semibold.

**Check verdict** (the words for an automated check of a document; a passing check is never "approved"):

| Condition | Word | Tone | Glyph |
|-----------|------|------|-------|
| No document yet | No spec yet | neutral | open |
| Problems found | "2 problems to fix" | danger | blocked |
| Open questions | "3 open questions" | warning | half |
| Passes and a person approved | Passes the check | success | approved |
| Passes | Ready for your approval | accent | ready |
| Otherwise | Not ready yet | warning | half |

**Check counts**: four cells in a 4-column grid, 8px gaps; each a `surface-sunken` cell, radius 5px, padding 8px 10px, the label in `caption` `ink-muted` above the number in `title-3` semibold tabular `ink` ("Rules", "Requirements", "Decisions", "Examples"). Shown only when something was counted (never four zeros).

**Diagnostic list**: a list (6px gaps) inside a `danger-soft` box with a `danger-line` border, radius 8px, padding 10px 12px (or bare when compact); each item a glyph (blocked in `danger-ink` for errors, half in `warning-ink` for warnings) and the message in `body-sm` `ink`, with "line 12" in `caption` `ink-subtle`. Each finding is placed next to the section it concerns.

**Open-question list**: each question in a `surface` box with a 1px `warning-line` border, radius 8px, padding 12px 16px, a `warning-ink` half glyph, the question in `body` `ink`, and "Who can answer: …" in `caption` `ink-muted`.

**Disclosure** (engineering detail behind a closed summary): a `details` element, radius 8px, 1px `line` border, `surface`; the summary row padding 10px 16px, `body-sm` semibold `ink-muted` (hover `ink`) with a 16px chevron that turns 90° when open; the body below a top border, padding 12px 16px, `body-sm` `ink`. Closed by default; the only place engineering words (paths, a tool's own messages) appear.

**Fact list** (term and value rows): a two-column grid (`max-content` and `minmax(0, 1fr)`), 16px column gap, 6px row gap, terms `ink-muted`, values `ink`, values wrap.

**Panel**: a `section` with radius 8px, 1px `line` border, `surface`.

### 7.11 Factory drawing primitives (optional module)

An isometric technical drawing of a process, "drawn the way an engineer draws a plant", that comes alive as events arrive. A sister app that visualises a pipeline can borrow its rules; most apps will not need it. Key values:

- **Projection**: 2:1 dimetric, 26.565°. `screen.x = (x − y) × 0.894427`, `screen.y = (x + y) × 0.447214 − z × 0.82`. Flat things are drawn in plan coordinates under the matrix `(0.894427 0.447214 −0.894427 0.447214 0 −0.82z)`, with plan strokes multiplied by 1.25. No CSS 3D; the camera is a CSS `translate + scale` with origin 0 0.
- **Grid**: minor 24 units (`factory-grid`), major 96 (`factory-grid-major`), registration crosses at major intersections, fading toward the edges. 1 unit = 1 CSS px at zoom 1.
- **Elevations** (units): ground 0, region plate 8, cell rim 14, low station 12, high station 22, gate 34, gatehouse 46, agent 26, dais 12, trench −6.
- **Sizes** (units): cell 216 × 148, gap between cells 32, aisle 56, gap between regions 56, station pad 40, agent footprint 14, artifact card 14 × 18, packet 12 × 8 × 6, gate span 44.
- **Strokes** (px): hairline 0.75, fine 1, regular 1.5, strong 2, route 1.5, live route 2.25, selection 1.75. Section hatching at 45°, 5px pitch, only on faces in shade or cut.
- **Shadows**: flat contact shadows offset (7, 4), no blur, in `factory-shadow`. No specular highlights, no glow.
- **Light**: one fixed light from the upper left; the only variable light is a working cell's lamp pool (radial stops 0 → 1, 0.45 → 0.82, 0.75 → 0.38, 1 → 0 of `factory-lamp`), which never flickers.
- **Zoom**: 0.35 to 3; far below 0.6, near above 1.4, hysteresis 0.05; buttons and keys step × or ÷ 1.2; labels cross-fade over 120ms at a level change. Far shows structure and state; mid shows everything at base size; near adds upright labels and identifiers.
- **Modifiers**: selected = four 10px corner brackets, 1.75px `factory-select`, 4 to 6px outside the thing; dimmed = opacity 0.28 (labels kept at 0.55); hovered = outline +0.5px and its label shown.
- **Text** is either lettering on the floor (sans at weight 650 for region names, mono for IDs) or upright labels (sans), never both for one thing. Labels never overlap a machine or another label; a halo of the ground colour (stroke 3.2px) or a chip of the ground at 86% opacity sits under near-zoom labels.
- **Unbuilt** (not reached yet): the outline dashed 3/2.5 at full contrast, filled with the ground, no state mark; never shown by lowering opacity.
- **Motion** (all a pure function of time since the event; durations in ms): packet travel 1400, path draw 600, agent arrive 480, agent leave 360, tool tick 240, artifact appears 520, artifact hand-off 900, gate close 420, gate open 520, gate refuse 640, test result 160 (staggered 60), verification return 1600, fan-out 700 (staggered 90), vote converges 600, human release 700, merge integrates 1100, dependency unlocks 800, cell completes 900, any other state change 260, camera focus 650, mode switch 700. Extra curves: travel `cubic-bezier(0.45, 0, 0.25, 1)`, draw `(0.3, 0, 0.2, 1)`, settle `(0.16, 0.84, 0.3, 1)`, refuse (drops to 1.12 in the first 35%, one damped return, exactly 1 at the end). Budget at any moment: 12 packets travelling, 6 paths drawing, 8 things appearing, 4 gates moving, 4 lamps lit; over a cap the lowest-priority animations snap to their end.
- **Accessibility**: each drawn entity is one group with `role="button"`, `tabIndex`, `aria-pressed` and an accessible name stating its state in words; the drawing is one tab stop with arrow keys moving to the nearest entity in that direction; its focus ring is a 2px `focus` box drawn inside the viewport edge (not an outline), and on entities an extra rounded rectangle; the reference sheet must read in greyscale.

### 7.12 Charts (Factory Floor analytics)

Charts are hand-drawn SVG, read-only, built on these rules:

- **Honesty**: zero baselines wherever a length encodes a value; one scale per chart (never two y-axes); log time axes are labelled as such; a missing value draws no mark (a small open mark on the baseline, or words), never a zero; nothing estimated; recorded cost is never divided among parts; no band colours a range as good or bad (words say whether a target is met).
- **Look**: hairline grids (`--an-grid`), axis `--an-axis`, bars in `--an-bar` (one tone; colour does not name a category unless it is the state palette), the selected mark ringed in `--an-select` (2px), columns rounded at the data end and square at the baseline, parts of a whole separated by 2px surface gaps.
- **Readout** (a headline figure): the metric's name in `body-sm` `ink-muted` with a definition button; the value in the sans, tabular, semibold, tracking −0.01em, at 32px (large), 24px (medium) or 19px (small), `ink`, line height 1; optional lead word ("median") in `caption` `ink-subtle`; a verdict in `caption` (`success-ink` if met, `warning-ink` if missed); below in `caption` `ink-subtle`: "n 42", mean, 90th, coverage, basis, "history incomplete here", and a "Rows" link.
- **Chart frame**: a `figure` with its title (`label` `ink`, or `caption` `ink-muted` small), the question it answers in `caption` `ink-muted`, a hidden spoken summary, a Table/Chart toggle (28px, radius 5px, `caption` `ink-muted`, hover `surface-sunken`, `aria-pressed`) that replaces the chart with a data table, and an optional `caption` `ink-subtle` footnote.
- **Data table**: 13px, full width, collapsed borders; headers left-aligned, 600, `ink-muted`, 1px `line-strong` under; cells 4px 8px 4px 0, 1px `line` under, top-aligned; numeric columns right-aligned and tabular; a row's first cell is a header for screen readers only. Scrolling tables take focus and show the focus ring. Sortable ranking tables: header buttons inherit the font; selected row `accent-soft`; hover `surface-sunken`; rows activatable with one Tab stop and the arrows.
- **Not recorded**: a box with a dashed `line-control` border, radius 8px, padding 12px 16px (8px 12px compact), hatched at 135° (5px gaps, a 1px line in `ink-subtle` at 22%); title in `label` `ink`, what is missing in `body-sm` `ink-muted`, why in `caption` `ink-subtle` ("Nothing is drawn in its place: a missing figure is not a zero.").
- **Too few records**: a `surface-sunken` box, 1px `line`, radius 8px, padding 12px 16px: "Too few records for a trend" and the counts; no direction is drawn or claimed.
- **Chart card** (exact values on hover or focus): absolutely placed, padding 7px 10px, radius 5px, `surface-inverse`, `ink-inverse`, 12.5px/17px, `shadow-2`, no pointer events.
- **Keyboard**: one Tab stop per chart; arrows move between marks; the mark's hit area is larger than the mark; the focus or hover ring is a 2px `focus` stroke.
- **Key** (legend item): a 16×10 swatch in the mark's shape (bar, line, dash, dot, tick, hatch) and its words in `caption` `ink-muted`.
- **Hatching for simulated data**: the same 135° hatch in `warning-ink` at 18%.

### 7.13 Navigation

**Navigation item** (in a rail): a list item holding a link or button, height 36px, radius 5px, gap 10px, padding 0 8px, `body-sm` `ink-muted`, an 18px icon; hover `surface-sunken` and `ink` (120ms). **Current page**: `accent-soft` background, semibold `accent-ink` label, a 2px `accent` bar at the left inset 6px top and bottom (radius full), `aria-current="page"`. A badge sits at the right with a hidden text version ("3 to settle"). Collapsed: icon only, centred, named by `aria-label` and a tooltip on the right; a badge becomes a 6px `warning-fill` dot at the top right.

**Navigation section**: an optional title in `caption` semibold `ink-subtle` (padding 0 8px 4px, hidden when collapsed); items 2px apart.

**Navigation menu** ("More"; for a product whose home screen leads everywhere): a ghost `sm` button with the label and a 16px chevron that turns 180° when open (`accent-ink` when the current page is in the menu). The popover is 288px wide, padding 8px, aligned to the end, and contains a `nav` landmark named by the label. Items 2px apart: radius 5px, padding 8px 12px, hover `surface-sunken`; a `body-sm` `ink` label and an optional one-line description in `caption` `ink-muted`; the current page `accent-soft` with a semibold `accent-ink` label and a 2px `accent` bar inset 8px. A footer below a top border (8px margin, 8px padding, 4px sides) holds the theme switch. Tab and Shift+Tab move through the links; Escape closes and returns focus to the button; following a link closes it.

**Breadcrumb**: see 4.3.

**Workspace switch** (segmented control; Factory Floor's primary navigation): a `fieldset` with a hidden legend "Workspace", radius 5px, 1px `line` border, `surface-sunken`, padding 2px. Segments: 28px tall, radius 3px, padding 0 10px, 6px gap, `body-sm` `ink-muted` (hover `ink`), a 16×14 icon and the word (hidden below 1100px); the chosen segment `surface`, semibold `ink`, `shadow-1`; focus shows a 2px `focus` outline at 1px offset on the segment. Real radio inputs: arrow keys move, the choice is announced. Number keys switch (1, 2, 3, 4: Line, Floor, Analytics, Decisions), declared with `aria-keyshortcuts`; each segment's title gives its description and key.

**Tabs**: a row with 20px gaps and a 1px `line` bottom border. Each tab 40px tall, overlapping the border by 1px, a 2px transparent bottom border, `label` `ink-muted` (hover `ink`, 120ms). The active tab: `accent` bottom border and `ink` text. Focus ring offset −2px (inside). Panels 20px below, focus offset 4px. Arrow keys move between tabs; only the active tab is in the tab order; Tab moves into the panel.

**Theme switch**: a `fieldset` (legend "Theme"), radius 5px, 1px `line` border, `surface`, padding 2px, with three options Light, Dark, System (Sun, Moon, Monitor icons, 14px). Each option fills its share, radius 3px, padding 4px 0, 6px gap, `caption` `ink-muted`; the chosen one `surface-sunken`, semibold `ink`; focus via a 2px `focus` outline on the option. Vertical and icon-only when the rail is collapsed. Factory Floor uses an icon-only version with 28×28px options and fuller names ("Light theme", "Dark theme", "Follow the system"). The choice is remembered in local storage under `mach.theme` (guarded: if storage is unavailable it lasts for the visit).

**Back link** (in a side panel or a sub-screen header): `body-sm` semibold `accent-ink`, underlined 1px with 3px offset (2px on hover), a 14–16px `ArrowLeft`, words that name the destination ("Back to what just happened", "Specification").

### 7.14 Connection and saved indicators

**Product Studio** (`ConnectionIndicator`): one popover trigger in the top bar, 32px tall, radius 5px, padding 0 8px, 12px gap, `body-sm`, hover `surface-sunken`, 16px icons. It shows two facts, and a third while a check of GitHub has failed, each an icon and words:

| Fact | State | Icon | Words | Tone |
|------|-------|------|-------|------|
| Host link | connecting | 14px spinner | Connecting | `ink-muted` |
| | online | `Link2` | Connected | `success-ink` |
| | offline | `Link2Off` | Host not responding | `danger-ink` |
| | unauthorized | `LockKeyhole` | Session ended | `warning-ink` |
| Saved | everything saved | `CircleCheck` | Everything is saved | `ink-muted` |
| | not saved | `CloudOff` | "2 things are not saved yet" | `warning-ink` |
| GitHub check | failed (`saved.github_check` set) | `RefreshCwOff` | GitHub not checked | `warning-ink` |

The host word is semibold; a 1×16px `line-strong` divider separates each fact from the next. The GitHub check shows only while the last check failed, after the saved fact; it is never counted in "not saved yet". A hidden prefix "Connection: " names the trigger. The popover (320px, aligned to the end, 12px gaps) explains each fact in a `label` line and a `body-sm` `ink-muted` sentence ("The local host may have stopped. Start Product Studio again from Claude Code, then reload.") and lists what is not saved. While a check failed it ends with a section below a 1px `line` top border (12px padding, 8px gaps): the `label` "GitHub not checked" in `warning-ink`, the engine's `text` in `body-sm` `ink-muted` (when the check failed, why, and how old what is shown is), and a button "Check GitHub again" (radius 5px, 1px `line-strong` border, padding 4px 8px, `body-sm` semibold `ink`, hover `surface-sunken`, at the start) that refreshes; while the check runs it reads "Checking GitHub…" and is `aria-disabled`, so it keeps keyboard focus. While a failed check is shown the app also checks again by itself (a few seconds after showing it, then on a timer, on focus, on becoming visible and on coming back online, with the wait doubling from one minute up to fifteen after each check that fails), and stops when a check works. Changes are announced through a polite, visually hidden live region, which adds "GitHub not checked." while a check failed.

**Factory Floor**: the source badge, connection badge, completeness badge and state chip (7.6); the connection popover (384px) holds a definition list of facts ("Connection", "Last confirmed", "Delivery lag", "Received") with terms in `ink-subtle`, and ends with "The Factory Floor only reads. It cannot start, pause, schedule or approve anything."

### 7.15 Command line with copy

Purpose: one command for a person to copy and run themselves; the page never runs it.

Anatomy: a row, 8px gap, radius 5px, 1px `line` border, `surface-sunken`, padding 4px 4px 4px 10px. The command in mono 13px `ink`, selectable as a whole (`user-select: all`), truncated with an ellipsis, `translate="no"`. A copy button at the right: 28px tall, radius 3px, 1px `line-control` border, `surface` (hover `surface-raised`), padding 0 10px, `caption` semibold `ink`, 6px gap, a 14px icon.

States of the button: "Copy" (`Copy` icon); "Copied" (`Check` icon) for 2 seconds; "Select it to copy" when the browser refuses the clipboard (the command stays selectable). The words are in a polite live region so the result is never colour or icon alone. The button's name says what the command is for: "Copy the command for LOCAL-014".

### 7.16 Relative time

A moment in relative words ("3 days ago", "in 2 hours", "just now") as a `<time>` element with the machine-readable moment, focusable (tab stop) so the exact time also shows on keyboard focus, with the exact time in a tooltip and in its accessible name ("3 days ago, Tuesday 17 November 2026, 14:00"). Radius 3px for its focus ring. Formats in 9.5.

### 7.17 Empty, loading and error states

**Empty state**: an invitation to act.
- Inline (inside a panel): a column, items at the start, 12px gap, radius 8px, 1px **dashed** `line-strong` border, padding 24px.
- Page (the whole content area): centred, 64px vertical margin, maximum width 448px, no border, centred text.
- Optional 20px icon in `ink-subtle` (naming the kind of thing), the title in `title-2` (650) `ink` (heading level 2 by default, 1 when it is the whole page), an optional one-sentence description in `body` `ink-muted` within 68ch, and the one action that fills the space (4px above).
- Title: what would be here ("No slices yet"). Description: what to do about it.

**Loading state** (a short wait with words): role `status`, polite; a row, 10px gap, padding 24px 0, `body` `ink-muted`, an 18px spinner and the words ("Reading your workspace").

**Skeleton** (a wait shaped like the content): blocks with radius 5px, `surface-sunken` with a gentle shimmer (a `line` highlight across, 1.6s linear, repeating; a still block under reduced motion). Text skeletons: 14px lines, 8px apart, the last at 60% width. Mark the loading region `aria-busy` (and a `role="status"` with an `aria-label` such as "Reading your project"), not each block.

**Spinner**: 14px (small) or 18px; a ring at 25% opacity and a quarter arc, 2px stroke, round cap, in the current colour; `role="status"` with a hidden label when nothing visible says what is happening.

**Error state** (a region that could not load, or an operation that failed outright): role `alert`; a column, 12px gap, radius 8px, 1px `danger-line`, `danger-soft`, padding 20px 24px. An optional 20px icon in `danger-ink`, the title in `title-3` semibold `danger-ink` (what went wrong, specifically), the back end's message in `body` `ink` as is (line breaks kept), and actions (indented 32px when there is an icon): the action that would resolve it, then "Try again" or "Reload".

### 7.18 Toasts and announcers

**Toast**: confirms a completed action; never for anything the person must act on (use a banner).
- Stack at the bottom right, 16px from the edges, 8px apart, above everything but the skip link (z 60), in a region named "Notifications"; F8 moves focus to them.
- Each: 360px wide, a row with 12px gap, radius 8px, 1px `line-strong` border, `surface-raised`, padding 12px 16px, `shadow-3`, pop-in and fade-out, swipe right to dismiss. An 18px icon in the tone's ink (`Info`, `CircleCheck`, `CircleAlert`), the title in `label` `ink`, an optional description in `body-sm` `ink-muted`, and a 24×24px close button ("Dismiss", radius 5px, `ink-muted`, hover `surface-sunken` and `ink`, 16px `X`).
- Tones: info, success, danger. Info and success stay 5 seconds and are announced politely; danger stays until dismissed and is announced assertively.
- Title: the past tense of the action's own name ("Approved EPIC-001", "Sent WAVE-001"). Description: what it means and what it did not do ("Its slices can now be marked ready. Nothing has gone to the builders.").
- While a dialog or sheet is open, Escape belongs to the dialog, not the toast (unless focus is in the toast).

**Announcer**: a polite, visually hidden live region for changes the screen cannot show by focus: connection changes, a view switch under reduced motion ("Factory Atlas"), refresh results.

### 7.19 Data tables (general)

There is **no general table component**; tables in the apps share these conventions, which a sister app should follow:

- `border-collapse: collapse`, full width, `body-sm` (13px in dense analytics).
- Header cells: left-aligned, `label` or 600 weight, `ink-muted`, a 1px `line-strong` rule below, padding 6px 8px; `scope="col"`.
- Body cells: padding 8px, top-aligned, a 1px `line` rule below (none on the last row in a bordered box).
- A table in a box: radius 8px, 1px `line` border; header row on `surface-sunken`.
- Numbers right-aligned and tabular.
- Placeholder or undecided cells in `ink-subtle` (italic in documents).
- Newly added rows tinted `accent-soft`.
- A table that can scroll sideways is a focusable region with a name ("Every case, scrolls sideways when narrow").
- Tags inside cells ("again") use a 3px-radius outline badge in the relevant ink.

### 7.20 The Line board (Factory Floor; a reusable pattern for "things moving through stages")

See 8.9 for the pattern and 12.2 for exact measurements.

---

## 8. Patterns

### 8.1 Confirming a person's act in a dialog

1. The act's button on the page is `primary` (or `danger` for withdrawing or removing) and names the act and its object: "Approve EPIC-001", "Mark ready to build", "Reopen SLICE-003".
2. Pressing it opens a confirm dialog. The title is a question naming the act and its object ("Mark "Renew a loan" ready to build?"). The description says what the act does and what it does not do, in the back end's terms ("Approving puts this capability in the product's scope, so its slices can be marked ready to build one by one. Nothing goes to the builders until you mark a slice ready."). An optional body lists what is affected.
3. Buttons: a secondary cancel that keeps things as they are, worded for the situation ("Not now", "Keep it ready"), then the confirming button with the act's verb, last.
4. While the act runs the confirming button shows a spinner and the dialog cannot be dismissed.
5. A refusal stays in the dialog, in the back end's own words, with the action that would resolve it.
6. Success closes the dialog, focus returns to the opener (or the page heading), and a toast confirms in the past tense ("Approved EPIC-001").
7. Nothing is ever approved automatically because a check passed.

### 8.2 Showing state: word, shape and tone

- Every state is shown as its **word** (always visible), its **glyph** (a shape unique to the state) and its **tone** (soft background, line border, ink text).
- Borders reinforce: dashed for unsettled or held, heavy for a question or failure, double for shipped, square corners for stopped.
- The state's one-sentence description is available as a tooltip or hidden text.
- Accessible names say the state in words ("LOCAL-014: Waiting for you, before Merge").
- Test: the screen must read correctly in greyscale.

### 8.3 Quoting other people's words

- Words written by another person (a reviewer's remark, another product manager's text, an issue's body) are a quotation: italic `body-lg` with a 2px `line-strong` left rule, and the author and the kind of remark below.
- They are never a heading, a button label, a link label or an instruction to the reader.
- Free text that has not been checked for personal names is shown plain (text only, never markup), cut to a limit (120 characters when none is given) with "Show all" / "Show less" on request, and labelled "(free text, not checked for names)" at 70% opacity, or once per panel ("Titles: free text, not checked for names"). Such text never goes into a tooltip, an accessible name, the address bar or storage.
- A refusal from the back end is shown as is, in its own words.

### 8.4 Empty, loading, error, stale and disconnected states

| Situation | What to show |
|-----------|--------------|
| Nothing yet, the person can act | Empty state with the one action ("No epics yet. An epic is a larger capability, such as "Team membership", that several slices deliver." → "Add the first epic") |
| Nothing yet, nothing to do | A plain sentence in `ink-muted` saying what will appear and when ("Nothing has happened yet. Each step the Factory records appears here as it happens.") |
| Short wait | Loading state with words |
| Layout-shaped wait | Skeletons shaped like the content, region `aria-busy` |
| Failed to load | Error state (`role="alert"`) with the specific title, the back end's words, and "Try again" |
| A change arrived while working | Banner, `live="polite"` |
| Couldn't reach a service but work is safe | Warning banner saying what still works ("Your drafts are safe and you can keep working; what is shown is from the last time GitHub was read.") with "Try again" |
| Stale (nothing heard for a while) | Keep what was last confirmed, frozen; say "As last seen" and since when ("Stale since 18:50:00"); in a drawing, desaturate (saturation 0.12, contrast 0.9, opacity 0.86, crossfading over 260ms when motion is welcome) and stamp it with a dashed `factory-stale` border; never call it "paused" or "working" |
| Disconnected | Danger tone; "Observer unreachable: as last seen"; say it will reconnect by itself; keep the last state |
| Session ended | Warning tone; say how to get a new session in words the person can act on |
| A value no record carries | "not recorded" (or "Not recorded", "Not available with these filters", "Not computed yet"), never zero, never blank |
| Files not kept after cleanup (Factory Floor: a finished ticket's evidence and lanes, when the observer says `not_kept`) | A statement, not an error and not an empty panel: a box with a dashed `line-strong` border (radius 5px, padding 8px 12px) holding "The evidence files were not kept after cleanup (cleanup.archive)." in `body-sm` `ink`, then the run record's reason in `body-sm` `ink-muted` when it says more (never the same sentence twice). The checks stay listed; each file they name reads "This file was not kept after cleanup (cleanup.archive). The change record merged with the ticket names it with its SHA-256." in place of "not there", and "No verification check has been recorded" is not shown beside it. The lanes panel's summary: "Built in lanes, but the cell's files were not kept after cleanup (cleanup.archive), so its lanes are not shown." and the reason; no problem is listed and the Line's row has no lanes moment |
| Too few records | Show the counts and say no direction is claimed |
| Sample or demonstration data | A permanent, visible stamp ("Simulation", dashed warning) and a page title that says so; it can never be mistaken for real data |

### 8.5 Forms and validation

- Label above, hint under the label, control, error under the control (7.3).
- Errors say what to do: "Write the vision: one sentence about what the product is for."
- An invalid control has `aria-invalid="true"` and its error linked by `aria-describedby`; the error has an icon as well as colour.
- Optional fields are marked "optional"; required fields are not marked.
- Product writing (a vision, a why) uses the editorial text area at the reading size.
- Disabled options say why they are disabled.
- When validation runs (on blur, on submit or live) is **not defined** by the system.
- Submission refusals from the back end are shown in the back end's words, in the dialog or region where the act happened.

### 8.6 Data tables

Follow 7.19. Additionally: give every chart a table alternative; show missing values as words; sort missing values last whatever the direction; page long rankings (8 rows per page in analytics) and compare pages on one scale.

### 8.7 Side inspector and full-record sheet

- **Side panel / inspector** shows the selected thing without leaving the page. Its anatomy: a back link to the default contents ("Back to what just happened"); the identifier in mono 13px `ink-muted`; the name as a `title-3` bold heading (focusable with `tabindex="-1"`, focus moved there on selection); the state pill and where it is ("at Review, before Merge"); then parts, each a `label` `ink-muted` heading 20px below the previous part with 6px under it: "Why it is here", "What it needs from you" (a sentence and a command to copy), "Where the time went", "Facts" (a two-column definition list, 120px terms). Ends with a secondary button that opens the full record ("Open the full record", with "or double-click the ticket (Enter on it)" in `caption` `ink-muted`) and a link to show it elsewhere.
- With nothing selected the panel shows a feed: "What just happened", "Newest first. Pick a ticket or a station to look closer.", a list divided by `line` rules, each row a 64px time column (mono 12px `ink-subtle` tabular) and a sentence that starts with the item's ID as an `accent-ink` underlined link.
- The inspector's general anatomy (Factory Floor): header (glyph at 24px, what it is ("Gate"), name, ID in mono 12px `ink-muted`, state mark and word, when it started or finished); "Why it looks like this" (the event that set the state, its type, time and authority); the parts for what it is, facts as a definition list; "Record"; "Evidence" (the events behind it, newest first, each with its time).
  - **The link back to the owner.** The ID wraps and is never cut off. When it starts with the ticket that owns the entity (a gate `LOCAL-001/groom.finalize`, a station visit, a visit, a review seat, a finding, an artifact `LOCAL-001:evidence/run.log`), that ticket is an `accent-ink` underlined link back to it, its cell (its slice before it has a cell), and the rest of the ID stays text. It is a real link whose address selects the ticket, named "Back to LOCAL-001"; followed, it selects the ticket and moves focus to the new panel's heading, so a person can return and pick another gate. A ticket the history does not hold is not a link.
  - **No "Related" list.** A related entity is a link where the panel names it: an entity whose ID does not name its ticket (an execution, an agent, a tool call, a workflow) links it as its "Ticket" fact; a slice links its cell and its dependencies under its scheduler facts; a dependency links its two slices; a finding its review and reviewer; a seat its review and reviewer; a visit its station; a merged gate's "Merged" its merge; an agent "Started by", "Agents it started" and "What it wrote".
  - **Times.** A time a record carried is shown as it is, never with a note on how finely it was measured (no "Measured to the millisecond", "Measured", "(measured)"). Only a time that is not what it looks like says so: "Arrival time (when the observer read it)", "Bounded between other records", "Placed by the observer, not measured".
  - **Record.** Authority, the source record, the runtime, fields from elsewhere, what is not recorded and what the observer inferred. It repeats no start or end time (the header, the parts and the evidence show them); one "Times" line appears only when a start or end was not recorded or was placed: "Start not recorded", "End not recorded, or still open", "End placed by the observer, not measured".
  - **A gate.** The header's word is the verdict alone ("Refused", "Overridden", "Passed"). "Decision" says what the header does not: "Reason", the recorded reason code in plain words from the inspector's table of the codes the stations record ("The plan did not pass its check", "A new test passed before any code was written"), a code the table does not know as recorded in mono, and "No reason was recorded" when a refusal or an override recorded none (a code that only repeats the verdict, such as `refused`, counts as none); never "Refused: refused". Then "For" (the task or check the record names), the round, "Reached" only when it is earlier than the decision, every evaluation oldest first for a gate evaluated more than once ("Refused for T3: the task changes tests that are already committed"), and the gate's own sentence only where it adds to these. A list of gates shows the verdict with the reason ("Refused: the plan did not pass its check"; "Refused" when none was recorded).
- **Full record** opens in a large dialog (`min(920px, 100vw − 2rem)`): title "LOCAL-014: the full record", a description saying what it holds and "Read only."; the item's name in `body-lg` semibold; a state pill and a sentence of facts; a table (7.19) of every step in order with columns such as Station, Worker, Time, Result, What to look at; and "What it needs from you" with its command.
- A **sheet** (480px) is used for detail that keeps the page in view, such as an item's detail or a check; 640px for comparing two versions side by side ("Keep yours, and marking it ready replaces theirs; or take theirs into your draft." The app never picks a side).

### 8.8 Status strips such as "Needs you"

A strip at the top of a workspace that lists what is waiting for a person, longest waiting first.

- A `section` named by its heading, a wrapping row with 12px gaps, padding 12px 16px, `canvas`, a 1px `line` rule below.
- The heading "Needs you" in `label` `ink`, vertically centred, at least 88px wide from 700px.
- Each item is a button (flexible, basis 300px), radius 8px (3px for a stopped item), 1px border, padding 10px 14px, 12px gap, in its state's tone (border, soft background): the 14px state shape; a first line in `body-sm` semibold `ink` that starts with the verb the person must perform and the ID in mono 13px ("Approve or send back LOCAL-014", "Unblock LOCAL-009", "Decide on …"); a second line in `body-sm` `ink-muted` saying why; and at the right in `caption` `ink-muted` how long it has waited ("waiting 42 min").
- Pressing an item selects it and shows it in the side panel.
- With nothing waiting: "Nothing is waiting for a person." in `body-sm` `ink-muted`.

Product Studio's equivalent is one warning banner listing everything waiting for the product manager with one action ("Answer them"), plus a "Carry on" panel with the single most useful next step.

### 8.9 The left-to-right line board

For showing many items moving through a fixed sequence of stages (MACH: tickets through Groom, Plan, Build, Verify, Review, Merge, Clean up).

- Stages are columns, left to right, fixed; items are rows. A first column (220px) names the item (ID in mono 13px semibold `factory-ink`, the title below in `body-sm`, two lines at most); then one column per stage, at least 108px each, 6px apart; the whole board at least 1010px wide and scrolling sideways inside its own region, on `factory-ground`, padding 8px 12px 12px.
- Behind the stage columns, plates: radius 8px, 1px `factory-plate-shade` border, `factory-plate-top`.
- Each column heading is a button: radius 8px at the top, padding 10px 12px 8px, the stage's name in `label` `factory-ink`, then in `caption` `factory-ink-soft` who works there and "typical 6 min" (or "time not recorded yet"); hover `surface-sunken` at 70%; selected shows a 3px `accent` bar along its top (inset shadow), `aria-pressed`.
- Each row is 76px: a dotted belt (2px dotted `factory-hatch`) across every stage at 34px; a solid 3px `factory-pass` bar from the first stage passed to the marker; a 16px passed node (filled `factory-pass` disc with a tick in the surface colour) at each stage passed; the marker (7.6 / 6.5) at the centre of the current stage (or on the boundary between two stages when it waits for a person's approval there); under the marker, in 12px `factory-ink-soft`, how long ("working 6 min", "waiting 42 min", "3 rounds used", "12 min ago").
- Marker: 28px tall, maximum 150px wide, 1.5px border, padding 0 10px, `caption` semibold, round (square for stopped, dashed for held), the 11px state shape, the words the stage recorded ("9 of 14 checks", "Your approval").
- Work sent back: a dashed arc (1.6px, 5/4, `factory-fail`) from the stage that sent it back to the stage it went back to, with "sent back once" / "sent back twice" in 11.5px semibold `factory-fail` on a `factory-plate-top` chip at its crest.
- Selected row: a 4px `accent` left border and `surface` behind the name cell, `surface` at 60% behind the lane; hover `surface` at 60% / 40%.
- An item whose stage splits its work into parallel parts (MACH: a build in lanes, 12.4) keeps its one row and marker; under its belt, from that stage's column on, a wrapping row of small pills, one per part, says where each part is, and one line says the moment the parts are at when it is one of its own. An item that does not split shows exactly what it shows without this.
- Finished items beyond the latest few are summarised: "And 4 more landed earlier; Analytics lists every finished ticket."
- Keyboard: each row has one button whose name is the ID and the state (never the free-text title); Space shows it in the side panel; Enter opens the full record; up and down arrows move between rows. Mouse: click selects; double-click opens the full record.
- Below the board, a footer line in `caption` `ink-subtle` on `canvas` with a top rule: "This page only reads. To change anything, copy the command it shows and run it in Claude Code."

### 8.10 A guided question screen with a document beside it

For an interview that asks one question at a time while the document it produces grows beside it (Product Studio's slice interview).

- **Header**: a row with a bottom rule, padding 12px 40px, a back link ("Specification", `body-sm` `accent-ink`, 16px arrow) and the page heading in `title-3` ("Interview: Renew a loan"), with the interview's actions and a polite status at the right.
- **Two columns**: question `minmax(0, 1.15fr)`, document `minmax(22rem, 1fr)`; each scrolls on its own. The question column has padding 40px and a centred inner column at most 44rem wide, 40px between blocks. The document column is `surface`, a 1px `line` left rule, padding 40px.
- **Question card** (receives focus when it appears; Y and N are shortcuts while it has focus):
  1. A line in `body-sm` `ink-muted`: "Question 7 · " and the topic in semibold `ink`.
  2. Optional preface in `ink-muted`.
  3. The question itself, large: `title-2` in the sans.
  4. **Recommended**: a block with a 2px `accent` left border, `accent-soft` background, radius 5px, padding 12px 16px; "Recommended" in `label` `accent-ink`, then the recommendation in `body-lg` `ink`, its first sentence semibold and the reasoning after it.
  5. Answers: `lg` primary "Yes, accept" (with a check icon) and `lg` secondary "No, I will say what instead", 12px apart, with a `caption` `ink-subtle` hint using keys: "Y accepts, N moves to your own words".
  6. A field "Or answer in your own words" (hint "The interviewer records it and moves on.") with a two-row text area; Ctrl/Cmd+Enter sends.
  7. Ghost `sm` buttons "I don't know", "You decide", "Explain", and a secondary "Send answer" at the right; a `caption` `ink-subtle` line explains the two odd ones ("I don't know" records it as an open question. "You decide" records the recommendation as an assumption you can check later.).
- **Settled so far**: below a top rule, 24px above, the decisions so far, each a row of the question (`body-sm` `ink`) and the short answer (`caption` `ink-muted`, right-aligned), with "Show all 6" behind a disclosure.
- **The document beside it** ("The slice so far"): an `article` with 28px between sections; a `caption` `ink-subtle` line with the ID and its group; the title in `title-1`; the outcome in `body-lg` `ink-muted`; a check box (radius 8px, 1px `line`, `canvas`, padding 12px 16px) with the check pill and counts; sections with `title-3` headings; requirement rows as a grid of a 4.25rem ID column and the text, with a 2px left border that is `accent` for items just added (and an `accent` badge "new"); decision tables as in 7.19 with undecided cells in `ink-subtle`; examples with Given/When/Then keywords in semibold `ink` ("And" indented 16px).
- When nothing is left open the card is replaced by the act: "What marking it ready does" in the same accent block, then the primary act, confirmed in a dialog.

### 8.11 Copyable commands

When the interface can describe an action but must not perform it (because it only reads, or the act belongs elsewhere), it shows the exact command in a command line (7.15) beside a sentence saying what it does ("What it needs from you: Approve it, or send it back with your reason."). The button's name states the command's purpose. A secondary command may follow 6px below (for example an "explain" command when something stopped). The page states once, in a footer, that it only reads.

### 8.12 Relative and exact times

- In lists and metadata, show relative words ("3 days ago", "just now") and give the exact moment on hover, on focus and in the accessible name (7.16).
- Where moments are compared or logged (feeds, records, the factory), show clock times in mono and tabular. Real history in Factory Floor is in UTC and says so ("History held from 12 Nov 2026, 14:00:00 UTC").
- Durations are words, two units at most (9.5).
- Something that is ongoing says "so far"; a length whose end was never recorded says "at most"; an interrupted span says "not continuous".
- Nothing predicts an end: no "about 4 minutes left" for automated work. (The Product Studio mockup's "about 4 are left" refers to questions the interviewer has planned; it is not built in the current code.)

---

## 9. Voice and wording

### 9.1 Tone

Plain, specific, calm and honest. Say what happened, what it means and what the person can do, in that order, in the person's terms rather than the system's. Never overstate: a passing check is "ready for your approval", not "approved"; a quiet connection is "as last seen", not "paused"; a missing figure is "not recorded", not zero. Never predict what is not known. Product Studio speaks to a product manager about their product (slices, epics, builders, "your approval"); engineering words (paths, branch names, a tool's own messages) appear only behind a closed disclosure.

### 9.2 Case and punctuation

- **Sentence case everywhere**: headings, buttons, labels, menu items, tabs, tooltips.
- No all-caps (except identifiers and requirement keywords in the source, which are lowered for reading).
- Full sentences in descriptions, hints and errors end with a full stop; button labels, pill words and headings do not.
- Lists of facts use the middle dot with spaces (" · ") as a separator in one line ("You were last working on this slice · 2 open questions"; "Building · 6 min 40 s").
- Curly quotes in prose (“Team membership”), straight quotes never shown to the person.

### 9.3 Buttons and dialogs

- A button says what happens, with its object when there is one: "Approve EPIC-001", "Mark ready to build", "Add the first epic", "Continue the interview", "Open the full record", "Show it on the Floor", "Try again", "Answer them", "Send answer".
- Never "Submit", "OK", "Yes"/"No" alone (the interview's "Yes, accept" and "No, I will say what instead" carry their meaning).
- Dialog titles are questions naming the act and its object: "Approve EPIC-001: Team membership?", "Reopen SLICE-003?", "Mark request #41 as met?", "Link a draft slice to request #41?".
- Dialog descriptions say what the act means and what it does not do: "Reopening withdraws your approval so the specification can change. It first takes the slice off the builders' list of ready work; if the builders have already started, they are told it changed when you mark it ready again."
- Cancel is worded for the case: "Not now" (default), "Keep it ready", "Not yet".
- The result uses the same words as the act: act "Mark ready to build" → result "SLICE-001 is ready to build"; act "Approve epic" → toast "Approved EPIC-001".
- Toasts are in the past tense of the action's own name: "Approved EPIC-001", "Added EPIC-002", "Saved the project", "Reopened SLICE-003", "Kept your version of SLICE-002", "Took the newer version of SLICE-002", "Copied the command", "Could not copy".

### 9.4 Errors and refusals

- Say specifically what went wrong and what to do: "Write the vision: one sentence about what the product is for."
- A refusal from the back end is shown in its own words, unedited, with the action that would resolve it.
- Error titles in the interface's voice, by kind:

| Kind | Title |
|------|-------|
| Refused | "Not done" (or what did not happen) |
| Invalid | "That request was not accepted" |
| Unauthorized | "This window is no longer signed in" |
| Conflict | "Already in progress" |
| Unavailable | "Not available right now" |
| Network | "Product Studio is not responding" (the product's name) |
| Protocol | "Unexpected reply from the host" |
| Aborted | "Cancelled" |
| Internal | "Something failed inside the host" |

- Say what still works: "Your drafts are safe and you can keep working; what is shown is from the last time GitHub was read."
- Say how to recover in steps the person can take: "The local host may have stopped. Start Product Studio again from Claude Code, then reload."

### 9.5 Formats

| What | Format | Examples |
|------|--------|----------|
| Count with noun | Number, space, singular or plural | "1 slice", "3 slices", "2 open questions", "4 tasks" |
| Fraction with a real denominator | "n of m" | "2 of 4 slices ready or further", "Rounds used: 2 of 3", "9 of 14 checks", "3 of 4 places working" |
| Times, repeated | words | "sent back once", "sent back twice" |
| Duration | Two units at most, smaller left out when zero; units s, min, h, d with a space | "48 s", "4 min 12 s", "1 h 3 min", "1 h", "1 d 15 h", "2 d" |
| Duration qualifiers | after the value | "6 min so far", "at most 9 min", "12 min ago", "waiting 42 min", "working 6 min" |
| Date and time (short) | Day, short month, 24-hour time, in the person's locale and time zone | "11 Nov, 14:55"; "never" when there is none |
| Exact moment | Weekday, day, month, year, time | "Tuesday 17 November 2026, 14:00" |
| Relative | Intl relative words; under 45 seconds "just now" | "3 days ago", "in 2 hours", "just now" |
| Clock in logs (UTC) | HH:MM:SS, with "UTC" when it stands alone | "10:42", "18:50:00 UTC" |
| Date in Factory Floor | Day, short month, year | "12 Nov 2026" |
| Timeline code (simulation) | mm:ss.s | "04:12.5" |
| Money | Dollars with two decimals and what it is | "$4.18 recorded", "at least $4.18 recorded", "not recorded" |
| Identifiers | As issued, mono, never translated or reformatted | `SLICE-001`, `EPIC-001`, `WAVE-001`, `FR-01`, `INV-02`, `AC-01`, `LOCAL-014`, `#41` |
| Commit | First 10 characters, mono | `3f9a1c2b7d` |
| Risk | Word, then "risk" | "High risk", "Medium risk" |
| Missing value | words | "not recorded", "Not recorded", "not recorded yet", "Title not recorded", "time not recorded yet" |
| Model names | plain | "Sonnet 5.5", "Opus 5.5"; at most three, then "and more" |

### 9.6 Words to use and words to avoid

| Avoid | Use instead | Why |
|-------|-------------|-----|
| Submit, OK | The act's verb and object | Labels say what happens |
| Approved (for a passing check) | Ready for your approval; Passes the check | Only a person approves |
| Paused (for a stale view) | As last seen; Stale since … | It is not known to be paused |
| 0, —, blank (for a missing value) | not recorded | A missing figure is not a zero |
| Estimated, about, ETA (for automated work) | working for … | Never predict |
| Progress (for work in flight) | Working, with the elapsed time | Nobody knows the end |
| Error codes, file paths, tool output in the main text | Plain words; the detail behind a disclosure ("What the check reported") | Engineering words stay hidden until asked |
| MUST, SHALL in reading text | must, shall | Lowered for reading |
| Click here, learn more | A link whose words name the destination ("Edit the vision and outcomes") | Links name where they go |
| Emoji, exclamation marks | Plain sentences | Calm voice |

### 9.7 Real examples from the apps

- Empty states: "No slices yet." · "No epics yet. An epic is a larger capability, such as "Team membership", that several slices deliver." · "No ticket has started yet" / "The simulated run is starting: its tickets appear here in a moment." · "No tickets on the line yet" / "Connected and waiting: each ticket appears here as the Factory records it."
- Banners: "Could not check GitHub" · "GitHub could not be read" · "3 things need your answer" · "Some of your drafts no longer fit together" · "Updates to GitHub".
- Waiting items: "Someone else saved a newer version of Renew a loan: choose theirs or keep yours." · "The builders have a question about Show overdue fines at checkout."
- Notices: the chip "Unattended runs: off", opening "Unattended runs: off on this machine" / "MACH is installed and working: an engineer runs its work by hand, and the Factory Floor shows what is recorded. Only the Factory Supervisor, which runs work unattended, is off, as it is on every machine until an engineer turns it on. That is an engineer's decision, made outside the Factory Floor, which only reads: it cannot start, pause, schedule or approve anything."
- Files not kept: "The evidence files were not kept after cleanup (cleanup.archive)." · "This file was not kept after cleanup (cleanup.archive). The change record merged with the ticket names it with its SHA-256."
- Reading-only notes: "This page only reads. To change anything, copy the command it shows and run it in Claude Code." · "The Factory Floor only reads. It cannot start, pause, schedule or approve anything."
- Source: "Live Factory" (Real execution, as the observer reads it from this project's Factory files, arriving as it happens.) · "Simulation" (A recorded scenario of invented work, running on its own. It reads no Factory state and is never real execution.). The page title says "Simulation (not real execution) · MACH Factory Floor".

---

## 10. Accessibility requirements

Target: **WCAG 2.1 AA, plus WCAG 2.2 target size**. The apps are checked with axe-core (rules wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa) in light and dark with a dialog and a sheet open: zero violations is the bar.

1. **Contrast.** Text 4.5:1; large text, control borders, the focus ring and meaningful marks 3:1; in both themes. Every pair you introduce must be measured (2.7).
2. **Focus ring.** One treatment everywhere: a 2px solid `focus` outline with a 2px offset on `:focus-visible`, on every interactive element. The resting outline colour of every element is the focus colour too, so a colour transition never flashes another colour on focus. Exceptions with reasons: inputs use a 0 offset and also turn their border `focus`; tabs use −2px (inside); graph nodes 3px; segmented controls draw the ring on the option via `:has(:focus-visible)`; a large canvas draws the ring as a 2px box inside its edge.
3. **Target size.** Every target at least 24×24px (WCAG 2.5.8); the resize edge of a panel at least 24px tall.
4. **Keyboard.** Full operation without a mouse: the skip link is the first tab stop; tab order follows reading order; arrow keys in tabs, selects, radio groups, menus, tables with one tab stop, charts and drawings; focus trapped in dialogs and sheets; Escape closes the topmost layer (a dialog before a toast); focus returns to the opener (or the page heading, then `<main>`); F8 reaches toasts. Single-key shortcuts act only when focus is not in a text field, are declared with `aria-keyshortcuts`, and are listed in a help sheet opened with "?".
5. **Screen-reader names.** Icon-only buttons have `aria-label` and a tooltip with the same words; visible text is always part of the accessible name (axe `label-content-name-mismatch`); accessible names of states say the state in words; free text is never put in an accessible name; a collapsed item keeps its name and badge text; graphs have a name and a text outline alternative; charts have a spoken summary and a table alternative.
6. **Live regions.** Connection and saved changes (polite); refresh results (polite banner); blocking failures (`role="alert"`); loading (`role="status"`); copy results (polite); danger toasts assertive, others polite; view switches under reduced motion announced.
7. **Structure.** One `h1` per page; headings choose their level independently of their size; lists are lists; state tables are definition lists; the current page `aria-current="page"`, the current step `aria-current="step"`; landmarks (`nav` with names, one `main`, `aside` with names).
8. **Reduced motion.** Section 5.4, in full.
9. **Colour independence.** Every state has a unique shape and a word; outlines reinforce (dashed, heavy, double, square); the interface and any drawing must read in greyscale.
10. **Zoom and reflow.** Text is in rem and scales with the browser's font size. Product Studio's flavour holds a 1024px minimum width and does not reflow to phone sizes; the Factory Floor flavour reflows down to 320 CSS px with nothing cut off and no horizontal page scroll (WCAG 1.4.10), wrapping its top bar and folding long labels to their glyphs. Neither the page nor `<main>` may scroll horizontally at 1440px or 1100px; wide content (boards, tables) scrolls inside its own focusable region.
11. **Language.** Identifiers carry `translate="no"`.
12. **Content Security Policy friendliness** (if served under a strict policy like MACH's `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'`, plus `media-src 'self'` for evidence video): no inline `<script>` or `<style>`, no `style="…"` in served HTML (styles set from script through the DOM are fine), no assets inlined as `data:` URIs except images, nothing loaded from another origin.

---

## 11. Implementation starter

### 11.1 Packages and versions

| Purpose | Package | Version |
|---------|---------|---------|
| Sans face | `@fontsource-variable/source-sans-3` | 5.3.1 |
| Mono face | `@fontsource-variable/jetbrains-mono` | 5.3.0 |
| Styling | `tailwindcss`, `@tailwindcss/vite` | 4.3.5 |
| UI runtime | `react`, `react-dom` | 19.3.1 |
| Primitives | `@radix-ui/react-checkbox` 1.4.1, `react-dialog` 1.3.1, `react-popover` 1.3.1, `react-select` 2.4.1, `react-slot` 1.5.0, `react-tabs` 1.2.1, `react-toast` 1.3.1, `react-tooltip` 1.4.1 | as listed |
| Icons | `lucide-react` | 1.72.0 |
| Class helpers | `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.7.0 | as listed |
| Scripted motion | `motion` | 14.12.0 |
| Graph (optional) | `@xyflow/react` 12.12.1, `elkjs` 0.12.1 | as listed |
| Routing (Product Studio) | `react-router` | 8.5.1 |
| Build | `vite` 8.3.8, `@vitejs/plugin-react` 6.3.0, `typescript` 6.0.3 | as listed |
| Lint | `eslint` 9.39.5, `@eslint/js` 9.39.5, `typescript-eslint` 8.72.2, `eslint-plugin-jsx-a11y` 6.10.2, `eslint-plugin-react-hooks` 7.1.1, `globals` 17.14.0 | as listed |
| Accessibility tests | `@axe-core/playwright` 4.14.0, `playwright` 1.58.2 | as listed |

Package manager pnpm 10.28.1, Node 22 or later. Only the fonts and the custom properties are required to look like the family; the rest is how MACH builds it. A sister app on another stack must reproduce the same values and behaviour.

### 11.2 Custom properties (complete)

Paste as one stylesheet. Light is the default; dark applies when the system asks for it and nothing chose light, or when `data-theme="dark"` is set on `<html>`. Set `data-theme` from script once the person's choice is known (stored under `mach.theme`: `light`, `dark` or `system`). Set `data-product="factory-floor"` for the Factory flavour (and default the theme to dark).

```css
/* MACH family tokens. Generated in MACH from one token source; never hand-edit values in components. */

:root {
  color-scheme: light;
  /* Surfaces */
  --mach-canvas: #FAF9F5;
  --mach-surface: #FFFFFF;
  --mach-surface-raised: #FFFFFF;
  --mach-surface-sunken: #F3F1EA;
  --mach-surface-nav: #F3F1EA;
  --mach-surface-inverse: #141413;
  --mach-overlay: rgba(20, 20, 19, 0.42);
  /* Text */
  --mach-ink: #141413;
  --mach-ink-muted: #5C5A54;
  --mach-ink-subtle: #6B6962;
  --mach-ink-inverse: #FAF9F5;
  --mach-ink-on-accent: #FFFFFF;
  /* Lines */
  --mach-line: #E3E0D5;
  --mach-line-strong: #D1CDBF;
  --mach-line-control: #8C887C;
  /* Accent */
  --mach-accent: #D97757;
  --mach-accent-fill: #B5512F;
  --mach-accent-fill-hover: #9F4628;
  --mach-accent-ink: #A9482A;
  --mach-accent-soft: #F6E7DF;
  /* Focus */
  --mach-focus: #2F6AA3;
  /* Tones */
  --mach-info-ink: #3A6496;
  --mach-info-soft: #E8EFF7;
  --mach-info-line: #B7CCE3;
  --mach-info-fill: #6A9BCC;
  --mach-success-ink: #4E5E39;
  --mach-success-soft: #EEF1E6;
  --mach-success-line: #C5CFB4;
  --mach-success-fill: #788C5D;
  --mach-warning-ink: #7D5A12;
  --mach-warning-soft: #F8EED7;
  --mach-warning-line: #E3CD98;
  --mach-warning-fill: #C99A3A;
  --mach-danger-ink: #A12F3A;
  --mach-danger-soft: #F9E6E6;
  --mach-danger-line: #E8B9BC;
  --mach-danger-fill: #B2343F;
  --mach-danger-fill-hover: #962A34;
  --mach-neutral-ink: #5C5A54;
  --mach-neutral-soft: #ECE9DF;
  --mach-neutral-line: #D1CDBF;
  --mach-neutral-fill: #8C887C;
  /* Graph (optional module) */
  --mach-graph-dot: #D1CDBF;
  --mach-graph-edge: #8C887C;
  --mach-graph-edge-dependency: #A9482A;
  /* Factory drawing (optional module) */
  --mach-factory-ground: #EFEBE2;
  --mach-factory-grid: #E3DFD3;
  --mach-factory-grid-major: #D3CEBF;
  --mach-factory-plate-top: #FDFCF9;
  --mach-factory-plate-lit: #ECE8DD;
  --mach-factory-plate-shade: #D5CFC0;
  --mach-factory-plate-edge: #8A8679;
  --mach-factory-plate-rim: #FFFFFF;
  --mach-factory-machine-top: #FFFFFF;
  --mach-factory-floor: #F6F3EC;
  --mach-factory-done: #EEF0E7;
  --mach-factory-hatch: #B5AF9E;
  --mach-factory-shadow: rgba(58, 52, 40, 0.13);
  --mach-factory-ink: #3A3833;
  --mach-factory-ink-soft: #7A766B;
  --mach-factory-route: #858175;
  --mach-factory-live: #2F6AA3;
  --mach-factory-live-soft: #DCE7F3;
  --mach-factory-pass: #56683F;
  --mach-factory-pass-soft: #E6EBDB;
  --mach-factory-fail: #A12F3A;
  --mach-factory-fail-soft: #F5DEDF;
  --mach-factory-wait: #86621A;
  --mach-factory-wait-soft: #F3E6C6;
  --mach-factory-human: #A9482A;
  --mach-factory-human-soft: #F6E3D9;
  --mach-factory-select: #B5512F;
  --mach-factory-lamp: #FFF0D6;
  --mach-factory-halt: #74488A;
  --mach-factory-stale: #56636F;
  /* Elevation */
  --mach-shadow-1: 0 1px 2px rgba(20, 20, 19, 0.06);
  --mach-shadow-2: 0 2px 8px rgba(20, 20, 19, 0.08), 0 1px 2px rgba(20, 20, 19, 0.06);
  --mach-shadow-3: 0 12px 32px rgba(20, 20, 19, 0.14), 0 2px 6px rgba(20, 20, 19, 0.08);

  /* Faces */
  --mach-font-sans: 'Source Sans 3 Variable', 'Segoe UI', system-ui, sans-serif;
  --mach-font-mono: 'JetBrains Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace;
  --mach-font-display: var(--mach-font-sans);
  --mach-density: 1;

  /* Type scale */
  --mach-text-display: 2.5rem;       --mach-text-display--line: 2.875rem;  --mach-text-display--weight: 700;  --mach-text-display--tracking: -0.02em;
  --mach-text-title-1: 1.875rem;     --mach-text-title-1--line: 2.375rem;  --mach-text-title-1--weight: 700;  --mach-text-title-1--tracking: -0.015em;
  --mach-text-title-2: 1.4375rem;    --mach-text-title-2--line: 1.875rem;  --mach-text-title-2--weight: 650;  --mach-text-title-2--tracking: -0.01em;
  --mach-text-title-3: 1.125rem;     --mach-text-title-3--line: 1.625rem;  --mach-text-title-3--weight: 600;  --mach-text-title-3--tracking: 0;
  --mach-text-body-lg: 1.0625rem;    --mach-text-body-lg--line: 1.75rem;   --mach-text-body-lg--weight: 400;  --mach-text-body-lg--tracking: 0;
  --mach-text-body: 1rem;            --mach-text-body--line: 1.5rem;       --mach-text-body--weight: 400;     --mach-text-body--tracking: 0;
  --mach-text-body-sm: 0.875rem;     --mach-text-body-sm--line: 1.25rem;   --mach-text-body-sm--weight: 400;  --mach-text-body-sm--tracking: 0;
  --mach-text-label: 0.875rem;       --mach-text-label--line: 1.25rem;     --mach-text-label--weight: 600;    --mach-text-label--tracking: 0;
  --mach-text-caption: 0.8125rem;    --mach-text-caption--line: 1.125rem;  --mach-text-caption--weight: 400;  --mach-text-caption--tracking: 0.005em;
  --mach-text-mono: 0.8125rem;       --mach-text-mono--line: 1.25rem;      --mach-text-mono--weight: 450;     --mach-text-mono--tracking: 0;

  /* Radii */
  --mach-radius-xs: 3px;
  --mach-radius-sm: 5px;
  --mach-radius-md: 8px;
  --mach-radius-lg: 12px;
  --mach-radius-full: 999px;

  /* Motion */
  --mach-duration-instant: 0ms;
  --mach-duration-fast: 120ms;
  --mach-duration-base: 180ms;
  --mach-duration-slow: 260ms;
  --mach-duration-layout: 400ms;
  --mach-ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --mach-ease-enter: cubic-bezier(0, 0, 0, 1);
  --mach-ease-exit: cubic-bezier(0.4, 0, 1, 1);

  /* Layout */
  --mach-rail-expanded: 248px;
  --mach-rail-collapsed: 64px;
  --mach-top-bar: 56px;
  --mach-reading-measure: 68ch;
  --mach-content-max: 1200px;
  --mach-control-sm: 28px;
  --mach-control-md: 36px;
  --mach-control-lg: 44px;
}

/* Dark before script has run, when the system asks for it and nothing chose light. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --mach-canvas: #141413;
    --mach-surface: #1C1C1A;
    --mach-surface-raised: #242422;
    --mach-surface-sunken: #0F0F0E;
    --mach-surface-nav: #181817;
    --mach-surface-inverse: #FAF9F5;
    --mach-overlay: rgba(0, 0, 0, 0.6);
    --mach-ink: #F0EEE6;
    --mach-ink-muted: #B5B2A7;
    --mach-ink-subtle: #9A978C;
    --mach-ink-inverse: #141413;
    --mach-ink-on-accent: #141413;
    --mach-line: #2E2D2A;
    --mach-line-strong: #3D3C38;
    --mach-line-control: #75736A;
    --mach-accent: #D97757;
    --mach-accent-fill: #D97757;
    --mach-accent-fill-hover: #E48B6C;
    --mach-accent-ink: #E8957A;
    --mach-accent-soft: #3A2620;
    --mach-focus: #8DB4DD;
    --mach-info-ink: #8DB4DD;
    --mach-info-soft: #1E2A36;
    --mach-info-line: #34506C;
    --mach-info-fill: #6A9BCC;
    --mach-success-ink: #A7B98A;
    --mach-success-soft: #232A1B;
    --mach-success-line: #47573A;
    --mach-success-fill: #788C5D;
    --mach-warning-ink: #D9B061;
    --mach-warning-soft: #2F2716;
    --mach-warning-line: #5E4C25;
    --mach-warning-fill: #C99A3A;
    --mach-danger-ink: #EC8F96;
    --mach-danger-soft: #3A1D20;
    --mach-danger-line: #6E3036;
    --mach-danger-fill: #E06C75;
    --mach-danger-fill-hover: #E8848C;
    --mach-neutral-ink: #B5B2A7;
    --mach-neutral-soft: #242422;
    --mach-neutral-line: #3D3C38;
    --mach-neutral-fill: #8C887C;
    --mach-graph-dot: #2A2927;
    --mach-graph-edge: #75736A;
    --mach-graph-edge-dependency: #E8957A;
    --mach-factory-ground: #0B0B0A;
    --mach-factory-grid: #181816;
    --mach-factory-grid-major: #24231F;
    --mach-factory-plate-top: #211F1D;
    --mach-factory-plate-lit: #1A1917;
    --mach-factory-plate-shade: #121110;
    --mach-factory-plate-edge: #78756C;
    --mach-factory-plate-rim: #57534C;
    --mach-factory-machine-top: #3D3C37;
    --mach-factory-floor: #2A2925;
    --mach-factory-done: #272924;
    --mach-factory-hatch: #3E3C37;
    --mach-factory-shadow: rgba(0, 0, 0, 0.62);
    --mach-factory-ink: #DAD6CA;
    --mach-factory-ink-soft: #A19E93;
    --mach-factory-route: #8C897F;
    --mach-factory-live: #8DB4DD;
    --mach-factory-live-soft: #1E3046;
    --mach-factory-pass: #A7B98A;
    --mach-factory-pass-soft: #26301E;
    --mach-factory-fail: #EC8F96;
    --mach-factory-fail-soft: #3E2024;
    --mach-factory-wait: #D9B061;
    --mach-factory-wait-soft: #362C17;
    --mach-factory-human: #E8957A;
    --mach-factory-human-soft: #42291F;
    --mach-factory-select: #E48B6C;
    --mach-factory-lamp: #4A3A27;
    --mach-factory-halt: #C6A6DA;
    --mach-factory-stale: #97A4B0;
    --mach-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
    --mach-shadow-2: 0 4px 12px rgba(0, 0, 0, 0.45);
    --mach-shadow-3: 0 16px 40px rgba(0, 0, 0, 0.6);
  }
}

/* Dark chosen explicitly. Same values as above. */
:root[data-theme="dark"] {
  color-scheme: dark;
  --mach-canvas: #141413;
  --mach-surface: #1C1C1A;
  --mach-surface-raised: #242422;
  --mach-surface-sunken: #0F0F0E;
  --mach-surface-nav: #181817;
  --mach-surface-inverse: #FAF9F5;
  --mach-overlay: rgba(0, 0, 0, 0.6);
  --mach-ink: #F0EEE6;
  --mach-ink-muted: #B5B2A7;
  --mach-ink-subtle: #9A978C;
  --mach-ink-inverse: #141413;
  --mach-ink-on-accent: #141413;
  --mach-line: #2E2D2A;
  --mach-line-strong: #3D3C38;
  --mach-line-control: #75736A;
  --mach-accent: #D97757;
  --mach-accent-fill: #D97757;
  --mach-accent-fill-hover: #E48B6C;
  --mach-accent-ink: #E8957A;
  --mach-accent-soft: #3A2620;
  --mach-focus: #8DB4DD;
  --mach-info-ink: #8DB4DD;
  --mach-info-soft: #1E2A36;
  --mach-info-line: #34506C;
  --mach-info-fill: #6A9BCC;
  --mach-success-ink: #A7B98A;
  --mach-success-soft: #232A1B;
  --mach-success-line: #47573A;
  --mach-success-fill: #788C5D;
  --mach-warning-ink: #D9B061;
  --mach-warning-soft: #2F2716;
  --mach-warning-line: #5E4C25;
  --mach-warning-fill: #C99A3A;
  --mach-danger-ink: #EC8F96;
  --mach-danger-soft: #3A1D20;
  --mach-danger-line: #6E3036;
  --mach-danger-fill: #E06C75;
  --mach-danger-fill-hover: #E8848C;
  --mach-neutral-ink: #B5B2A7;
  --mach-neutral-soft: #242422;
  --mach-neutral-line: #3D3C38;
  --mach-neutral-fill: #8C887C;
  --mach-graph-dot: #2A2927;
  --mach-graph-edge: #75736A;
  --mach-graph-edge-dependency: #E8957A;
  --mach-factory-ground: #0B0B0A;
  --mach-factory-grid: #181816;
  --mach-factory-grid-major: #24231F;
  --mach-factory-plate-top: #211F1D;
  --mach-factory-plate-lit: #1A1917;
  --mach-factory-plate-shade: #121110;
  --mach-factory-plate-edge: #78756C;
  --mach-factory-plate-rim: #57534C;
  --mach-factory-machine-top: #3D3C37;
  --mach-factory-floor: #2A2925;
  --mach-factory-done: #272924;
  --mach-factory-hatch: #3E3C37;
  --mach-factory-shadow: rgba(0, 0, 0, 0.62);
  --mach-factory-ink: #DAD6CA;
  --mach-factory-ink-soft: #A19E93;
  --mach-factory-route: #8C897F;
  --mach-factory-live: #8DB4DD;
  --mach-factory-live-soft: #1E3046;
  --mach-factory-pass: #A7B98A;
  --mach-factory-pass-soft: #26301E;
  --mach-factory-fail: #EC8F96;
  --mach-factory-fail-soft: #3E2024;
  --mach-factory-wait: #D9B061;
  --mach-factory-wait-soft: #362C17;
  --mach-factory-human: #E8957A;
  --mach-factory-human-soft: #42291F;
  --mach-factory-select: #E48B6C;
  --mach-factory-lamp: #4A3A27;
  --mach-factory-halt: #C6A6DA;
  --mach-factory-stale: #97A4B0;
  --mach-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
  --mach-shadow-2: 0 4px 12px rgba(0, 0, 0, 0.45);
  --mach-shadow-3: 0 16px 40px rgba(0, 0, 0, 0.6);
}

/* Factory Floor flavour: same roles and faces, denser controls. */
:root[data-product="factory-floor"] {
  --mach-density: 0.875;
}

/* Reduced motion: every duration collapses. Scripted animation must also check the media query. */
@media (prefers-reduced-motion: reduce) {
  :root {
    --mach-duration-instant: 0ms;
    --mach-duration-fast: 0ms;
    --mach-duration-base: 0ms;
    --mach-duration-slow: 0ms;
    --mach-duration-layout: 0ms;
  }
}
```

### 11.3 Tailwind theme mapping (Tailwind v4, CSS-first)

The app's entry stylesheet imports the fonts, Tailwind, the tokens above, then maps utilities onto the tokens. Tailwind's default palette is removed, so only token colours exist (`bg-blue-500` does not compile). Spacing keeps Tailwind's default 4px step.

```css
@import "./fonts.css";      /* 11.4 */
@import "tailwindcss";
@import "./tokens.css";     /* 11.2 */

/* The dark: variant follows the data-theme attribute. */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

@theme inline {
  --color-*: initial;
  --color-transparent: transparent;
  --color-current: currentColor;

  --color-canvas: var(--mach-canvas);
  --color-surface: var(--mach-surface);
  --color-surface-raised: var(--mach-surface-raised);
  --color-surface-sunken: var(--mach-surface-sunken);
  --color-surface-nav: var(--mach-surface-nav);
  --color-surface-inverse: var(--mach-surface-inverse);
  --color-overlay: var(--mach-overlay);

  --color-ink: var(--mach-ink);
  --color-ink-muted: var(--mach-ink-muted);
  --color-ink-subtle: var(--mach-ink-subtle);
  --color-ink-inverse: var(--mach-ink-inverse);
  --color-ink-on-accent: var(--mach-ink-on-accent);

  --color-line: var(--mach-line);
  --color-line-strong: var(--mach-line-strong);
  --color-line-control: var(--mach-line-control);

  --color-accent: var(--mach-accent);
  --color-accent-fill: var(--mach-accent-fill);
  --color-accent-fill-hover: var(--mach-accent-fill-hover);
  --color-accent-ink: var(--mach-accent-ink);
  --color-accent-soft: var(--mach-accent-soft);

  --color-focus: var(--mach-focus);

  --color-info-ink: var(--mach-info-ink);
  --color-info-soft: var(--mach-info-soft);
  --color-info-line: var(--mach-info-line);
  --color-info-fill: var(--mach-info-fill);
  --color-success-ink: var(--mach-success-ink);
  --color-success-soft: var(--mach-success-soft);
  --color-success-line: var(--mach-success-line);
  --color-success-fill: var(--mach-success-fill);
  --color-warning-ink: var(--mach-warning-ink);
  --color-warning-soft: var(--mach-warning-soft);
  --color-warning-line: var(--mach-warning-line);
  --color-warning-fill: var(--mach-warning-fill);
  --color-danger-ink: var(--mach-danger-ink);
  --color-danger-soft: var(--mach-danger-soft);
  --color-danger-line: var(--mach-danger-line);
  --color-danger-fill: var(--mach-danger-fill);
  --color-danger-fill-hover: var(--mach-danger-fill-hover);
  --color-neutral-ink: var(--mach-neutral-ink);
  --color-neutral-soft: var(--mach-neutral-soft);
  --color-neutral-line: var(--mach-neutral-line);
  --color-neutral-fill: var(--mach-neutral-fill);

  --color-graph-dot: var(--mach-graph-dot);
  --color-graph-edge: var(--mach-graph-edge);
  --color-graph-edge-dependency: var(--mach-graph-edge-dependency);

  --color-factory-ground: var(--mach-factory-ground);
  --color-factory-grid: var(--mach-factory-grid);
  --color-factory-grid-major: var(--mach-factory-grid-major);
  --color-factory-plate-top: var(--mach-factory-plate-top);
  --color-factory-plate-lit: var(--mach-factory-plate-lit);
  --color-factory-plate-shade: var(--mach-factory-plate-shade);
  --color-factory-plate-edge: var(--mach-factory-plate-edge);
  --color-factory-plate-rim: var(--mach-factory-plate-rim);
  --color-factory-machine-top: var(--mach-factory-machine-top);
  --color-factory-floor: var(--mach-factory-floor);
  --color-factory-done: var(--mach-factory-done);
  --color-factory-hatch: var(--mach-factory-hatch);
  --color-factory-shadow: var(--mach-factory-shadow);
  --color-factory-ink: var(--mach-factory-ink);
  --color-factory-ink-soft: var(--mach-factory-ink-soft);
  --color-factory-route: var(--mach-factory-route);
  --color-factory-live: var(--mach-factory-live);
  --color-factory-live-soft: var(--mach-factory-live-soft);
  --color-factory-pass: var(--mach-factory-pass);
  --color-factory-pass-soft: var(--mach-factory-pass-soft);
  --color-factory-fail: var(--mach-factory-fail);
  --color-factory-fail-soft: var(--mach-factory-fail-soft);
  --color-factory-wait: var(--mach-factory-wait);
  --color-factory-wait-soft: var(--mach-factory-wait-soft);
  --color-factory-human: var(--mach-factory-human);
  --color-factory-human-soft: var(--mach-factory-human-soft);
  --color-factory-select: var(--mach-factory-select);
  --color-factory-lamp: var(--mach-factory-lamp);
  /* Not mapped in MACH's own theme (see section 13); add them if you need utilities: */
  --color-factory-halt: var(--mach-factory-halt);
  --color-factory-stale: var(--mach-factory-stale);

  --font-sans: var(--mach-font-sans);
  --font-mono: var(--mach-font-mono);
  --font-display: var(--mach-font-display);

  --text-display: var(--mach-text-display);
  --text-display--line-height: var(--mach-text-display--line);
  --text-display--letter-spacing: var(--mach-text-display--tracking);
  --text-title-1: var(--mach-text-title-1);
  --text-title-1--line-height: var(--mach-text-title-1--line);
  --text-title-1--letter-spacing: var(--mach-text-title-1--tracking);
  --text-title-2: var(--mach-text-title-2);
  --text-title-2--line-height: var(--mach-text-title-2--line);
  --text-title-2--letter-spacing: var(--mach-text-title-2--tracking);
  --text-title-3: var(--mach-text-title-3);
  --text-title-3--line-height: var(--mach-text-title-3--line);
  --text-title-3--font-weight: var(--mach-text-title-3--weight);
  --text-body-lg: var(--mach-text-body-lg);
  --text-body-lg--line-height: var(--mach-text-body-lg--line);
  --text-body: var(--mach-text-body);
  --text-body--line-height: var(--mach-text-body--line);
  --text-body-sm: var(--mach-text-body-sm);
  --text-body-sm--line-height: var(--mach-text-body-sm--line);
  --text-label: var(--mach-text-label);
  --text-label--line-height: var(--mach-text-label--line);
  --text-label--font-weight: var(--mach-text-label--weight);
  --text-caption: var(--mach-text-caption);
  --text-caption--line-height: var(--mach-text-caption--line);
  --text-mono: var(--mach-text-mono);
  --text-mono--line-height: var(--mach-text-mono--line);

  --radius-xs: var(--mach-radius-xs);
  --radius-sm: var(--mach-radius-sm);
  --radius-md: var(--mach-radius-md);
  --radius-lg: var(--mach-radius-lg);
  --radius-full: var(--mach-radius-full);

  --shadow-1: var(--mach-shadow-1);
  --shadow-2: var(--mach-shadow-2);
  --shadow-3: var(--mach-shadow-3);

  --ease-standard: var(--mach-ease-standard);
  --ease-enter: var(--mach-ease-enter);
  --ease-exit: var(--mach-ease-exit);

  --spacing-control-sm: var(--mach-control-sm);     /* h-control-sm, size-control-sm */
  --spacing-control-md: var(--mach-control-md);
  --spacing-control-lg: var(--mach-control-lg);
  --spacing-rail: var(--mach-rail-expanded);
  --spacing-rail-collapsed: var(--mach-rail-collapsed);
  --spacing-top-bar: var(--mach-top-bar);           /* h-top-bar */
  --container-reading: var(--mach-reading-measure); /* max-w-reading */
  --container-content: var(--mach-content-max);     /* max-w-content */
}
```

Resulting utilities, for orientation: `bg-canvas`, `bg-surface-raised`, `text-ink-muted`, `border-line-control`, `bg-accent-fill hover:bg-accent-fill-hover`, `text-danger-ink`, `bg-factory-ground`, `font-mono`, `font-display`, `text-title-2`, `text-caption`, `rounded-xs` … `rounded-full`, `shadow-1` … `shadow-3`, `ease-standard`, `h-control-md`, `h-top-bar`, `max-w-reading`, `max-w-content`. Durations are written as `duration-[var(--mach-duration-fast)]`.

If you merge class names with `tailwind-merge`, teach it the token names (colours = every role name; text = the ten type steps; radius = xs, sm, md, lg, full; shadow = 1, 2, 3; font = sans, mono, display) so `text-body` and `text-caption`, or `text-ink` and `text-ink-muted`, resolve to the last one.

### 11.4 Font loading

Install the two packages (11.1) and import them from the stylesheet so the build serves the files itself:

```css
/* fonts.css: bundled typefaces, SIL Open Font License 1.1. Nothing is fetched from a font CDN. */
@import "@fontsource-variable/source-sans-3/wght.css";
@import "@fontsource-variable/source-sans-3/wght-italic.css";
@import "@fontsource-variable/jetbrains-mono/wght.css";
```

Without a bundler, copy the variable font files from those packages into your app and declare them with `@font-face` under the family names `'Source Sans 3 Variable'` (weights 200 to 900, roman and italic) and `'JetBrains Mono Variable'` (weights 100 to 800), served from your own origin. Keep the licence files with the fonts.

### 11.5 Base stylesheet

```css
@layer base {
  html {
    background: var(--mach-canvas);
    color: var(--mach-ink);
    font-family: var(--mach-font-sans);
    font-size: 100%;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    font-feature-settings: "kern", "liga";
  }

  body {
    margin: 0;
    min-height: 100vh;
    background: var(--mach-canvas);
    color: var(--mach-ink);
    font-size: var(--mach-text-body);
    line-height: var(--mach-text-body--line);
  }

  /* One focus treatment everywhere: a 2px ring in the focus colour with a 2px gap. The resting outline
     colour is the focus colour too, so colour transitions never flash another colour on focus. */
  *, ::before, ::after { outline-color: var(--mach-focus); }
  :focus-visible { outline: 2px solid var(--mach-focus); outline-offset: 2px; }

  ::selection { background: var(--mach-accent-soft); color: var(--mach-ink); }

  /* Tabular figures wherever numbers line up. */
  .tabular { font-variant-numeric: tabular-nums; }

  /* Reduced motion removes transitions and animations outright (not a near-zero duration). */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }
  }
}

@keyframes mach-fade-in   { from { opacity: 0; } to { opacity: 1; } }
@keyframes mach-fade-out  { from { opacity: 1; } to { opacity: 0; } }
@keyframes mach-pop-in    { from { opacity: 0; transform: translateY(4px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes mach-sheet-in  { from { transform: translateX(100%); } to { transform: none; } }
@keyframes mach-sheet-out { from { transform: none; } to { transform: translateX(100%); } }
@keyframes mach-shimmer   { from { background-position: 100% 0; } to { background-position: 0 0; } }

@utility animate-fade-in   { animation: mach-fade-in   var(--mach-duration-base) var(--mach-ease-enter) both; }
@utility animate-fade-out  { animation: mach-fade-out  var(--mach-duration-fast) var(--mach-ease-exit) both; }
@utility animate-pop-in    { animation: mach-pop-in    var(--mach-duration-base) var(--mach-ease-enter) both; }
@utility animate-sheet-in  { animation: mach-sheet-in  var(--mach-duration-slow) var(--mach-ease-enter) both; }
@utility animate-sheet-out { animation: mach-sheet-out var(--mach-duration-base) var(--mach-ease-exit) both; }
```

Apply the open and close animations from the component's state (`data-state="open"` → pop-in or sheet-in; `"closed"` → fade-out or sheet-out). Use `.sr-only` (Tailwind's) for visually hidden text.

Two shell rules that utilities cannot express, if you build the Factory flavour's frame:

```css
.mach-frame {
  position: relative;
  display: grid;
  grid-template-areas: "top top" "stage inspector";
  height: 100dvh;
  overflow: hidden;
  background: var(--mach-canvas);
  transition:
    grid-template-rows var(--mach-duration-layout) var(--mach-ease-standard),
    grid-template-columns var(--mach-duration-layout) var(--mach-ease-standard);
}
```

### 11.6 Lint rules that keep the system honest

From the shared ESLint flat configuration:

- `@eslint/js` recommended and `typescript-eslint` recommended.
- **`eslint-plugin-jsx-a11y` strict** rules, all of them.
- `eslint-plugin-react-hooks` recommended rules.
- `@typescript-eslint/consistent-type-imports`: error.
- `@typescript-eslint/no-unused-vars`: error, ignoring names that start with `_`.
- **No hex colours in components**:

```js
"no-restricted-syntax": ["error", {
  selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
  message: "Use a design token (var(--…) or a Tailwind token class), not a hex colour."
}]
```

  switched off only for the token source, config files and scripts.
- Ignored: build output, `node_modules`, fixtures, screenshots, test results.

Further checks MACH runs, worth copying: the token build fails when the generated CSS is stale or any registered contrast pair drops below its threshold; axe-core in light and dark with a dialog and a sheet open; a capture script that fails if the page or `<main>` scrolls horizontally at 1440px or 1100px; a host check that fails on any console error, CSP violation or request leaving the local origin; and a test that free text is rendered only through the one bounded component.

### 11.7 Checklist before calling a screen done

1. Every colour is a role; there is no hex, `rgb()` or Tailwind palette colour in the component.
2. Light, dark (by system and by choice) and, if relevant, the Factory flavour all look right; every new text or mark pair is measured at 4.5:1 or 3:1.
3. Terracotta appears only on the one primary action of each region and on the current place.
4. Every state shows its word, its shape and its tone; the screen reads in greyscale.
5. Headings: one `h1`; levels in order; sizes from the scale; sentence case; no all-caps, no eyebrows.
6. Mono is used only for identifiers, paths, commands and (Factory) logs and durations; identifiers carry `translate="no"`.
7. Reading text stays within 68ch; numbers that line up are tabular.
8. Spacing is on the 4px step; radii are xs, sm, md, lg or full by hierarchy; panels have a border and no shadow; only floating things have shadows.
9. Buttons name the act; at most one primary per region; danger and personal acts go through a confirm dialog whose title is a question and whose description says what the act does; the confirming button is last.
10. Every icon-only control has a name and a tooltip; every target is at least 24×24px.
11. Keyboard: the skip link works; tab order follows reading order; Escape closes the top layer; focus returns to the opener; arrows work in composite widgets.
12. Focus is visible everywhere with the one ring.
13. Empty, loading, error, stale and disconnected states exist and use the right words; missing values say "not recorded".
14. Nothing moves on its own; reduced motion removes all transitions and animations; nothing predicts an end.
15. Other people's words are quoted and attributed; unchecked free text is plain, bounded, labelled and never in a tooltip or accessible name.
16. Times: relative with exact on hover and focus; durations in the family's words; dates in the person's locale (UTC said when used).
17. The page and `<main>` never scroll sideways at 1440px and 1100px (or reflow to 320px in the Factory flavour).
18. axe-core reports zero violations in both themes, with any dialog or sheet open.
19. Fonts and assets come from your own origin; nothing loads from a CDN; no inline styles or scripts in served HTML if you run under a strict CSP.
20. Wording follows section 9: sentence case, the act's own verb, toasts in the past tense of the act, errors that say what to do.

---

## 12. Sample screens

### 12.1 Product Studio flavour: the project home

The default screen; it leads everywhere, so there is no rail.

**Frame.** `AppShell` without a rail: full height, `canvas`, minimum width 1024px. Skip link first.

**Top bar** (56px, `canvas`, bottom 1px `line`, padding 0 24px, gap 16px):
- Left: the 20px MACH mark and "Product Studio" in `label` `ink`, 8px apart. On other screens a breadcrumb follows (a `line-strong` bar, the project's name as an `accent-ink` link, "/" separators, the current page semibold `ink`).
- Right: a warning badge "Fixture data" only when sample data is in use; the connection indicator ("Connected" with `Link2` in `success-ink`, a divider, "Everything is saved" with `CircleCheck` in `ink-muted`); then the "More" navigation menu (ghost `sm` button) whose items are "Project home: Epics, slices and what to do next" and the secondary screens, with the theme switch in its footer.

**Content.** `<Page width="reading">` widened to 68ch + 12rem; padding 32px 40px. A column with **40px** between blocks:

1. **Header** (column, 16px gaps):
   - The project's name as `h1` at `display` (40/46, 700, −0.02em), with the issue number beside it when there is one.
   - The vision in `body-lg` `ink-muted`, within 68ch.
   - A `nav` named "Project": a wrapping row of links, 20px apart horizontally and 8px vertically, `body-sm` semibold `accent-ink` (underline on hover): "Add an epic", "Edit the vision and outcomes", "2 requests from other people" (only when there are any), then the secondary screens.
2. **Notices** (column, 12px gaps), only when there is something: a danger banner "Could not check GitHub" with "Try again"; or a warning banner "GitHub could not be read" saying the drafts are safe; a warning banner "3 things need your answer" with a bulleted list and "Answer them"; an info banner "Updates to GitHub"; a danger banner "Some of your drafts no longer fit together" with the check's words behind a disclosure "What the check reported".
3. **Carry on** (only when the back end reports a next step): a `section` row, wrapping, 32px by 16px gaps, radius 8px, 1px `line`, `surface`, padding 20px 24px. Left (within 68ch, 4px gaps): "Carry on" in `caption` `ink-subtle`; the step's title as `h2` in `title-2`; its reason in `ink-muted`. Right: one **`lg` primary** button with the step's verb ("Continue the interview", with a trailing arrow when it navigates).
4. **Epics** (32px apart). Each epic is a `section` with a 1px `line` top border and 24px above:
   - A wrapping row (12px by 8px gaps): the epic's title as `h3` at `title-2`; its ID as an identifier chip; its status pill (`sm`); "2 of 4 slices ready or further" in `body-sm` `ink-muted`; and, for a proposed epic, a secondary `sm` "Approve EPIC-001" pushed to the right (opening the confirm dialog of 8.1).
   - "Done when:" in `body-sm` `ink-muted` and a bulleted list of criteria in `body-sm` `ink-muted` (within 68ch).
   - "Ready or further means …" in `caption` `ink-subtle`.
   - The slice list: a `ul`, radius 8px, 1px `line`, `surface`, rows divided by `line`. Each row wraps, 16px by 6px gaps, padding 12px 16px (`accent-soft` when it is the slice the person last worked on): the title as a link in `body` semibold `ink` (underline on hover) with its ID chip; a `caption` `ink-muted` line ("You were last working on this slice · 2 open questions"); its times; then its status pill and any builder pills (`sm`), the issue link, and a `sm` button "Start the interview" or "Continue the interview" (secondary for the current slice, ghost otherwise; its name includes the slice's title).
   - A ghost `sm` "Add a slice to Loans" with a `Plus` icon.
   - With no epics: an inline dashed empty box (radius 8px, dashed `line-strong`, padding 20px) with "No epics yet. An epic is a larger capability, such as "Team membership", that several slices deliver." and a primary `sm` "Add the first epic".

**Loading**: a `role="status"` region named "Reading your project", `aria-busy`, with skeletons: a 44×320px title block, two text lines, a 16×384px line, a 96px-tall block, a 28×224px heading and two 56px rows, 40px and 16px apart.

**Error**: an error state with `CircleAlert`, the error's title and message and "Try again", under a visually hidden `h1` "Project home".

### 12.2 Factory Floor flavour: the Line view

The Factory flavour's default workspace: stations as columns, a row for each ticket, a side panel. Dark by default.

**Frame.** The Factory grid frame (`100dvh`, `canvas`). The page title names the source: "Branch Library · MACH Factory Floor" for live history, "Simulation (not real execution) · MACH Factory Floor" otherwise.

**Top bar** (minimum 48px, wraps; padding 4px 16px; 16px gaps from 1100px; bottom `line`; `canvas`):
- The 18px mark and "MACH" `label` `ink` with "Factory Floor" regular `ink-muted`.
- The workspace switch (`nav` "Workspaces"): Line (chosen: `surface`, semibold, `shadow-1`), Floor, Analytics, Decisions; keys 1, 2, 3, 4.
- A 1×20px `line` divider.
- The run's identity: the project's name as `h1` in `body-lg` bold, leading none, truncated (at most 45% of the space), then wave IDs in mono `caption` `ink-subtle`, then "History held from 12 Nov 2026, 14:00:00 UTC" in `caption` `ink-subtle` from 1360px.
- Badges: the source badge "Live Factory" (live ink and tint, bold, with its glyph and a chevron, opening the source menu); the connection badge "Live" (round, live ink border); the completeness badge only when history is incomplete; the Factory state chip ("Unattended runs: off", info) only when relevant; the places chip ("3 of 4 places working").
- Icon buttons: keyboard shortcuts (`CircleHelp`, "?"), then the icon-only theme choice.

**Stage** (`main` named "Line (Live Factory)", `factory-ground`). The Line workspace is a column on `surface`:

1. **Needs you** strip (8.8): "Needs you", then for example a person-tone card "Approve or send back LOCAL-014" / "All three reviewers approved; it changes sign-in, so a person decides." / "waiting 42 min", and a fail-tone square-cornered card "Unblock LOCAL-009" / "Rejected in its third and last round; the line has stopped work on it." / "waiting 2 h 10 min".
2. **Body**: a grid of `minmax(0, 1fr)` and 360px (stacked below 900px).
   - **Board** (8.9) on `factory-ground`, scrolling inside its own region, at least 1010px wide: a "Tickets" heading in `label` `factory-ink` above "Titles: free text, not checked for names" in 12px `factory-ink-soft`; seven station headings (Groom, Plan, Build, Verify, Review, Merge, Clean up), each with who works there (the models recorded, or the worker's name) and "typical 6 min"; then one 76px row per ticket. Examples: LOCAL-012 with passed nodes at Groom, Plan and Build, a solid pass bar, and a live marker at Verify "9 of 14 checks" with "working 6 min" under it; LOCAL-015 back at Build with a dashed fail arc from Review labelled "sent back once"; LOCAL-017 with a dashed wait marker "Held" and "same files as LOCAL-015"; LOCAL-014 with a person marker "Your approval" on the boundary between Review and Merge; LOCAL-011 with a pass marker "Landed" and "12 min ago".
   - **Side panel** (`aside` "Details", `surface`, left `line`, padding 16px 20px). With nothing selected: "What just happened" (`title-3` bold), "Newest first. Pick a ticket or a station to look closer." (`body-sm` `ink-muted`), and the feed (64px time column in mono 12px `ink-subtle`; each sentence starting with an `accent-ink` ID link: "LOCAL-012 proved 9 of its 14 checks."). With a ticket selected: the ticket panel of 8.7 ("Back to what just happened"; `LOCAL-014`; the title; the pill "Waiting for you" and "at Review, before Merge"; "Why it is here"; "What it needs from you" with the command `/mach decide LOCAL-014` to copy; "Where the time went" as bars (a 76px station column, an 8px bar in `factory-route`, `factory-live` while still open, `factory-fail` for rework, and the time in `caption` `ink-muted` tabular: "8 min", "6 min so far", "12 min, again"); "Facts" (Risk High, Rounds used 1 of 3, Cost "$4.18 recorded"); "Open the full record"; "Show it on the Floor"). With a station selected: its name, what it does, "Who works here", "In the history held" ("typical 7 min, the middle of 20 finished visits"), and where its model is set, with the setting's path in mono.
3. **Footer** (top `line`, `canvas`, padding 8px 16px, `caption` `ink-subtle`): "This page only reads. To change anything, copy the command it shows and run it in Claude Code."

**Full record** (Enter on a row or double-click): the large dialog of 8.7, titled "LOCAL-014: the full record".

**States.** Empty live history: the board's single row says "No tickets on the line yet" / "Connected and waiting: each ticket appears here as the Factory records it." Stale: the connection badge reads "Stale since 18:50:00" (warning) and the stage notice says "As last seen" with what that means; nothing moves until the observer answers again.

### 12.3 Factory Floor flavour: Decisions in force

The fourth workspace (`#decisions`, key `4`; code `web/apps/factory-floor/src/decisions`): the project's architecture decisions (ADRs) for an engineer. "Architecture decision" and "ADR" are used as they are; the page is for engineers. It has no inspector.

**Page.** One column on `surface` that scrolls on its own (its keyboard home, `tabindex="-1"`), at most 1120px wide and centred, padding 24px 16px (24px 32px from 900px), 24px between parts. Header: "Decisions in force" in `title-1` (650), the Simulation stamp when the source is the Simulation, and a secondary "Read again" button (32px, 16px `RefreshCw`) at the right; a one-sentence description in `body` `ink-muted`; then, in a `surface-sunken` box with a `line` border, the sentence that it only reads: "This page only reads. A decision is accepted, changed or superseded by a pull request for its ADR file, and a ticket's exception or a proposal's acceptance is recorded with /mach adr in Claude Code." Below each read, the reply's basis in `caption` `ink-subtle` (what was read, and that it is the working tree as on disk, live tickets only).

**Parts of the list**, each a `section` named by its `title-3` heading with a `caption` `ink-subtle` note:

1. **The required baseline.** When a topic is missing, a warning-soft box (`warning-line` border, radius 8px, padding 12px 16px): "Missing: framework, deployment." in `label` `warning-ink`, the sentence "No ticket is planned or built until every required topic is covered by an accepted decision on the main branch. Tickets already planned carry on.", and the command `/mach adr baseline` to copy. When all are covered, one `success-ink` sentence. Then a table (7.19) of Topic (mono 13px), What it decides (MACH's one line per topic, `ink-muted`) and Covered by (each ADR ID a button, or a square-cornered dashed warning pill "Missing").
2. **Waiting on a person.** A list: each ticket stopped on a decision is a card with a 2px `warning-line` border (heavy: a question for a person), the ticket ID in mono 13px, the stop's title ("The plan cannot follow a decision", "A proposal waits to be accepted", "A decision file cannot be read"), the ADR IDs as buttons, one sentence saying what it means, the recorded reason (contained), and the commands to copy (`/mach decide <ticket>`, `/mach adr except <ticket> <ADR> "<why>"`, `/mach adr accept <ticket> <ADR>`). A ticket's proposal and the proposals in the ADR folder are cards with a 1px dashed `info-line` border (unsettled). With nothing waiting: "Nothing waits on a person about a decision. A ticket that stops on one appears here." in `body-sm` `ink-muted`.
3. **Every decision.** A table in a bordered box, scrolling sideways in its own focusable region ("Every decision, scrolls sideways when narrow"): ADR (the ID, a button in mono 13px `accent-ink`, underlined), Decision (the title, contained, with the file in mono `caption` `ink-subtle` and "2 problems" in `caption` `danger-ink`), Status (a small pill: accepted `success`, proposed `info` with a dashed border, deprecated, rejected and superseded `neutral` with "Superseded by ADR-0009"; accepted with problems `warning` "Accepted, but binds nothing until its problems are fixed"; a file that cannot be read `danger`, square-cornered, "Cannot be read"; "supersedes ADR-0002" under it in `caption`), Topics. Under it, the folder's problems as a list headed "Problems MACH found in the ADR folder" (`label` `danger-ink`), and `/mach adr list` to copy. No decisions: the inline empty state "No architecture decisions yet" with what an engineer runs.

**One decision** (`#decisions?adr=ADR-0007`; Escape or the back link returns to the list, and focus moves to the heading of what is shown): the back link "Back to every decision" (8.7) with "(Escape)" in `caption`; the ID in mono 13px `ink-muted`; the title as the `title-2` heading (contained); the status pill; facts as a definition list with 140px terms (File, Status, Superseded by, Supersedes, Topics, Applies to, Binds the Factory); "Why it binds nothing" in a danger-soft box when it has problems; "Where it is changed" (the read-only sentence, and `/mach adr accept <ADR>` for a proposal or `/mach adr new "<decision>"` to write the one that supersedes an accepted decision); "The decision as written": the file's text as plain monospaced text (13px, `pre-wrap`) on `surface-sunken` in a bordered box at most 60% of the window tall, scrolling in its own focusable region named "The text of ADR-0007" (never its words), never Markdown, never markup, nothing in it a link; "Tickets planned under it" ("Live tickets only"), each with its stage, when it was planned and an outline badge "under this text" or "under an earlier text" (warning); "Exceptions recorded against it", each a bordered card: the ticket, "decided by a person on 2026-11-18 08:00:00 UTC; recorded by an agent, on the person's instruction in conversation", and "Why:" with the person's words, contained; "Plans that cannot follow it" and "Proposed by a ticket" when there are any.

**Free text.** Titles, the ADR's text, problems that quote a file's header and recorded reasons are people's words: printed only through the shared `UncheckedText`, cut to their limit, labelled once per part ("Titles and problems: free text, not checked for names"), never in a name, a hover, the address or storage. A person is shown by role, never by name.

**States.** Loading: "Reading the decisions" (7.17). The observer cannot be read: the error state with its words and "Try again". An observer from before this page: "This observer does not serve decisions" with what to start instead. No observer at all, outside the Simulation: the page empty state "Nothing real to show here". A record that could not be read is named ("The records of T-11 could not be read, so what they wait on is not shown.").

**Simulation.** The same page over a labelled sample: the Simulation stamp in the header and, in `warning-ink`, "Simulation: these are sample decisions to show the page. No project was read." The sample's tickets are named `SAMPLE-*`.

### 12.4 Factory Floor flavour: a build in lanes

On the Line and in its side panel (code `web/apps/factory-floor/src/line/Lanes.tsx`, words from `lanesModel.ts`): a ticket whose build station builds the independent parts of its plan at the same time, in lanes (`M22_PARALLEL_BUILD.md`). "Lane" is the product's word and is used as it is, for engineers; so are "the join" (bringing the lanes together on the ticket's branch), "set aside" (a lane not landed, whose tasks are built again one at a time) and "handed back" (a lane that gave its remaining tasks to the cell, which builds them one at a time after the join). Never "engine", "light path" or "kind". A builder's own words (a hand-back's reason, a test or lint command, why it changed) are never shown: the observer does not serve them.

**On the Line.** Only while the ticket is at Build and its build is in lanes; a build that is not in lanes, one whose lanes are planned but not opened yet, and one built one task at a time after all, show exactly the row of 12.2.
- The marker's words say how many lanes: "3 lanes"; "lanes done" once every lane is done. The line under it is unchanged ("working 6 min").
- Under the belt, starting at the Build column, a wrapping row (4px gaps) of lane pills: 20px tall, radius full (3px for a lane set aside), 1px border, padding 0 6px, `caption` semibold, the 9px state shape of 6.5 first, in the Line's state tones: a lane at work in `working` ("L2: T06, 2 of 6 done": the lane, the task it is on, how many of its tasks are done); a lane waiting for a builder's place in `held` ("L3: waiting for a free place"); a lane done in `landed` ("L1: done, 2 of 2"; after the join "L1: landed, 2 of 2 done"); a lane handed back in `held`, because it is a way on, not a failure ("L2: handed back, its 2 remaining tasks are built one at a time"; once the cell has built every one, "L2: handed back, its 2 remaining tasks were built one at a time" in `landed`); a lane set aside in `stopped` ("L2: set aside"). A lane whose own record could not be read has no shape, a dashed `line-strong` border on `surface` and `ink-muted` text: "L2: its record could not be read". The list is named "Lanes of T-3"; the pills are text, read in order.
- The join is its own moment: one line under the pills in `caption` semibold, in the moment's tone: "Every lane is done: next, the lanes are joined." (`factory-live`; a lane handed back counts as ready for the join); from the moment the build station recorded that a join started until its result, "The lanes are being joined, since 10:26:10 UTC." (`factory-live`), or, when the process doing it is gone and it never finished, "The join started at 10:26:10 UTC and did not finish; every lane's work is kept, and it can be run again." (`ink-muted`); "Lanes joined: 4 tasks landed, the whole suite passed." (`factory-pass`), followed, when the ticket's branch moved while the lanes were open, by "The ticket's branch moved while the lanes were open: they landed on top of the 2 commits made there.", and for a lane handed back by "L2 handed back: its 2 remaining tasks are built one at a time." (neither changes the tone); "L2 set aside: its 2 tasks are built again one at a time." (`factory-fail`); "Failed only when joined: 2 tests fail together; J-T01 makes them pass together." (`factory-fail`; once `J-T01` is done, "made them pass together" in `factory-pass`); "The join stopped and landed nothing (branch-moved); every lane's work is kept." (`factory-fail`, landing's own code in brackets). A build record that could not be read: "Built in lanes, but its build record could not be read." in `ink-muted`.
- The row grows to hold them; nothing else on the board moves.

**In the side panel.** A part "Lanes" after "Where the time went":
- One sentence that says what happened, in order: "Built in 3 lanes at the same time, each by its own builder in its own worktree; 1 lane waits for a free place." Or "Built in 2 lanes, then joined: 4 tasks landed on the ticket's branch, one per task in plan order. The whole suite passed on the joined result." A lane set aside says why, with which lane when there is one, from the lane's side: "it changed a file also changed by L1", "it changed a test file of L1", "one of its file names and one of L1's differ only by letter case", "one of its files and a folder of L1 have the same path, or the other way round", "a commit made on the ticket's branch while the lanes were open changed its file" ("2 commits … changed its files"), "its commit 3333333333 did not apply on the landed work", "its branch held commits no task recorded", "its commits were not one chain from the fork point"; then that its tasks are built again in the cell, one at a time, and, when the station kept them, "Its lane commits are kept under refs/mach/lanes-set-aside/T-3/L2/1, so nothing is lost." A failure only when joined says how many tests, in which lanes' files, and the task added to fix it. A join that landed on a branch that moved says so: "The ticket's branch moved while the lanes were open: they landed on top of the 2 commits made there." A lane handed back: "Lane L2 was handed back to the cell at 10:15:00 UTC: its 2 remaining tasks (T05 and T06) are built in the cell, one at a time, once the lanes are joined; its 1 finished task lands at the join." (after the join: "… after the join; its 1 finished task landed at the join."). A plan built one task at a time after all says why: "Planned in 3 lanes, but too few builders' places were free when they were to open, so the plan is built one task at a time, as without lanes.", or "Planned in 3 lanes, but the cell's suite was failing (not known to pass) where they would open, so the plan is built one task at a time, as without lanes, and the builder makes the suite pass on the way."
- A record that could not be read is named, in `warning-ink`, with the observer's own words for why: "Lane L2's own record could not be read: not the JSON the build station writes. Its progress is not shown."
- What happened on the way, each in `body-sm` `ink`, saying that nothing was lost and where the earlier work is: "In lane L1, the step of T02 was interrupted; the station found its commit (1111111111) and recorded it, so nothing was lost." (in a build without lanes, "The step of T02 was interrupted; …"); "Lane L2 was made fresh at 10:05:10 UTC, because its folder, branch or record belonged to another build. Nothing was lost: what was there before is kept under refs/mach/lanes-set-aside/T-3/L2/1, and its earlier record beside it in the cell." (with nothing to keep: "Nothing of its own was there to keep."); "Lane L2's worktree was made again on a new branch, because its branch was checked out somewhere else."; "Lane L1 had uncommitted files no task held; the station kept them under refs/mach/lane-files/T-3/L1/1, and the join went on without them." A ref is shown as the station named it, and only when it is one of the ticket's own.
- The speed-up as a recorded fact, a definition list with 120px terms: "Lanes, wall time" (from opening the lanes to the last lane done), "Lanes, added up" (each lane's own time, with "(1.8 times the wall time)" in `ink-muted`), "Whole build" ("40 min elapsed", or "not recorded yet" until the build report is written), "Its tasks, added up" (with ", 2 not recorded" in `ink-muted` when some are). Under it, in `caption` `ink-muted`, where the figures come from (the build report, or the moments the lanes recorded) and that the added-up time is not what a build one task at a time would have taken, which was not run. While a lane has not finished, its times are not added up and the figures say "not recorded".
- The tasks grouped, each group a `body-sm` semibold heading with its state after a middle dot in `ink-muted`: "Before the lanes · Built in the cell, one at a time.", "Lane L1 · 1 of 2 done", "Lane L3 · waiting for a free place", "Lane L2 · set aside: not landed; its tasks are built again in the cell, one at a time", "Lane L2 · handed back: its finished tasks land at the join; T05 and T06 are built in the cell, one at a time, after the join" (after the join: "… landed at the join; T05 and T06 are built in the cell, one at a time, now that the lanes are joined"), "After the join" (`J-T01`), "After the lanes", "After a command changed · Added when a new test or lint command left the suite or the linter failing; built in the cell." (`C-T01`). A task handed back and not built yet reads "not done yet, built in the cell after the join"; a task whose step was recovered reads "done, recovered after an interrupted step". Each task a row divided by `line` rules: its ID in mono 13px, the plan's tag for it and its state in `ink-muted` ("test · done"), and at the right, for a task done, the time it took in `caption` tabular, or "not recorded". Under it, for a task built in a lane, in mono 12px `ink-subtle`: "lane commit 1111111111, landed as 5555555555", "lane commit 3333333333, not landed: its lane was set aside", or "lane commit 1111111111, on its lane's branch until the join".

**A changed command, on any ticket's side panel.** For a build whose test or lint command was changed while it was building, in lanes or not, a part "Its commands" after "Lanes" (or after "Where the time went"): one `body-sm` line per change, "The test command changed at 10:40:00 UTC.", "The test and lint commands changed at 10:50:00 UTC, in revision round 1.", "The lint command changed, at a time not recorded."; under them, in `caption` `ink-muted`, "Nothing done was undone: the build carried on from where it was. The old and the new command, and why it changed, are in the build's record for the reviewers." The commands and the reason are a builder's own words and are never shown.

**A lane's commit in the inspector.** A commit artifact a lane made has a fact "Lane": "made in a lane; the join landed it on the ticket's branch as `5555555555`", "made in a lane that was set aside: not landed; its task is built again in the cell", or "made in a lane; on the lane's branch until the lanes are joined". A lane commit is never shown as missing.

**Live.** The lanes are read from the observer and read again whenever the ticket's events change; a task an event says is done moves its lane on at once.

**Simulation.** No lanes: the Simulation's run has none and none are invented for it.

---

## 13. Gaps and disagreements in the sources

### 13.1 Where the sources disagree, and what this guide follows

| Topic | Sources | Followed |
|-------|---------|----------|
| Heading weights | The design-system document lists display 450, title-1 450, title-2 500; the token file sets 700, 700 and 650, and the heading component applies bold, bold and 650 | **Token file** (700 / 700 / 650) |
| The MACH mark | The two approved mockups draw the top-left, bottom-left and bottom-right cells as outlines and light the **top-right** cell; the library draws the **top-left filled in ink** and lights the **bottom-right** | **Library code** |
| Font loading | The mockups load Source Sans 3 and JetBrains Mono from Google Fonts; the system bundles both from npm and forbids font CDNs | **System** (bundled) |
| Mockup details | The mockups use 8px button radius, simple square/diamond/dot state marks for slices, a tab-style view switch with an accent underline, 30px/650 question type, and state words such as "In interview", "Needs your answer" | **Library code** (5px controls, the glyph set in 6.4, the segmented workspace switch, the words in 7.10). The mockups are treated as the intended feel, not as values |
| Minimum width | The token file's supported minimum is 1100px and its compact breakpoint 1180px; the design-system document and the Product Studio shell hold 1024px as the hard minimum; Factory Floor's frame has no minimum and reflows to 320px | All three are reported as built (4.10) |
| Top bar height | Token `--mach-top-bar` is 56px (Product Studio shell); Factory Floor's own frame uses a 48px minimum that grows when it wraps | Both reported; 56px is the token |
| "Nothing pulses" | The factory visual spec says nothing idles, breathes or pulses; the Line view's working marker has a ring that pulses (opacity 0.7 → 0, scale 1 → 1.12, 2.4s, standard curve, infinite) when reduced motion is not requested, and the approved mockup shows the same | Reported as built, and flagged: a sister app should treat it as the one sanctioned exception, or omit it |
| Skeleton shimmer | Principle "nothing moves on its own" vs. the skeleton's infinite 1.6s shimmer (a functional gradient) | Reported as built; it is a loading indicator and stops under reduced motion |
| Factory Floor glyphs | The design-system document says Factory Floor "keeps the glyphs"; the Line view uses its own five shapes (dot, two bars, diamond, square, tick) | Both reported (6.4 and 6.5) |
| Connection indicator | The design-system document describes a shared-project half ("Refreshed 14:32", "Not refreshed yet"); the current component shows the host link and the saved state ("Everything is saved") | **Code** |
| Prose component | Its code comment says "Serif"; it sets the sans | **Code** (sans; there is no serif) |
| Theme labels | Product Studio's switch says "Light", "Dark", "System"; Factory Floor's says "Light theme", "Dark theme", "Follow the system" | Both reported |
| Licences | The design-system document says "All three faces" | Two faces exist |
| Workspaces | The project overview names Atlas, Timeline and Analytics; the current code has Line (default), Floor and Analytics | **Current code** |

### 13.2 What the system does not define

- A z-index scale (the values in use are listed in 4.8).
- An opacity scale (disabled 50%, icon-button disabled 40%, dimmed drawing 0.28 with labels at 0.55, faded graph node 60%, unavailable menu item 60%).
- A pressed (active) state for buttons distinct from hover.
- A loading state for inputs.
- A combobox or searchable select (the select says to use one beyond about 12 options).
- A general dropdown menu, radio group, switch or toggle, slider, date picker, file upload, avatar, pagination control, progress bar (fills exist only for measured fractions), breadcrumb component in the library (it lives in the app) and data-table component.
- When form validation runs.
- Use of the density token by any component.
- Tailwind utilities for `factory-halt` and `factory-stale`: the roles exist as CSS variables but MACH's theme mapping omits them, so `text-factory-halt` does not compile there (added in 11.3).
- A phone or tablet layout for the Product Studio flavour.
- Print styles.

### 13.3 Contrast gaps noticed in the built screens

- The Line board's column subtitles and under-marker words set `factory-ink-soft` text (12–13px) on `factory-plate-top` and `factory-ground`. The registered pair is for strokes at 3:1; as text it measures 4.42:1 in light, below 4.5:1. A sister app should use `ink-muted` (6.72:1) for such text.
- The analytics sequential ramp and its dark bar overrides are hex values in CSS, outside the token file; the lint rule only checks script literals, so they are not enforced the same way.
