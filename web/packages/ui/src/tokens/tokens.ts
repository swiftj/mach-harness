/**
 * MACH design tokens: the single source of truth.
 *
 * `src/styles/tokens.css` is generated from this file by `node packages/ui/scripts/tokens.ts --write`
 * and checked by `--check` (run by `pnpm --filter @mach/ui typecheck`). Never edit the CSS by hand.
 *
 * Layers:
 *   1. `palette`  raw brand and neutral colours. Components never use these directly.
 *   2. `themes`   semantic roles per theme (light = Product Studio paper, dark = Control Tower night).
 *   3. scales     type, space, radius, elevation, motion, layout.
 *
 * This file has no imports so that Node can run the token scripts with type stripping.
 */

export const palette = {
  /** Brand */
  charcoal: "#141413",
  cream: "#FAF9F5",
  terracotta: "#D97757",
  blue: "#6A9BCC",
  green: "#788C5D",
  ochre: "#C99A3A",
  brick: "#B2343F",

  /** Warm neutral ramp, cream to charcoal. */
  paper0: "#FFFFFF",
  paper50: "#FAF9F5",
  paper100: "#F3F1EA",
  paper150: "#ECE9DF",
  paper200: "#E3E0D5",
  paper300: "#D1CDBF",
  paper400: "#A8A496",
  paper500: "#8C887C",
  paper600: "#6B6962",
  paper700: "#4D4B46",
  paper800: "#2E2D2A",
  paper850: "#242422",
  paper900: "#1C1C1A",
  paper925: "#181817",
  paper950: "#141413",
  paper1000: "#0F0F0E",
} as const;

export type PaletteName = keyof typeof palette;

/** The roles every theme must define. Each becomes a CSS variable `--mach-<role>`. */
export const roleNames = [
  // Surfaces, from the page outward.
  "canvas",
  "surface",
  "surface-raised",
  "surface-sunken",
  "surface-nav",
  "surface-inverse",
  "overlay",
  // Text.
  "ink",
  "ink-muted",
  "ink-subtle",
  "ink-inverse",
  "ink-on-accent",
  // Lines.
  "line",
  "line-strong",
  "line-control",
  // Brand accent: the primary action and the current place.
  "accent",
  "accent-fill",
  "accent-fill-hover",
  "accent-ink",
  "accent-soft",
  // Keyboard focus.
  "focus",
  // Feedback tones.
  "info-ink",
  "info-soft",
  "info-line",
  "info-fill",
  "success-ink",
  "success-soft",
  "success-line",
  "success-fill",
  "warning-ink",
  "warning-soft",
  "warning-line",
  "warning-fill",
  "danger-ink",
  "danger-soft",
  "danger-line",
  "danger-fill",
  "danger-fill-hover",
  "neutral-ink",
  "neutral-soft",
  "neutral-line",
  "neutral-fill",
  // Graph canvas.
  "graph-dot",
  "graph-edge",
  "graph-edge-dependency",
  // Factory (M6, the Living Factory). The drawn plant: ground sheet, plates with lit and shaded faces,
  // drafting ink, conveyor routes, and the state inks used on the plant. See M6_0_VISUAL_SPEC.md.
  "factory-ground",
  "factory-grid",
  "factory-grid-major",
  "factory-plate-top",
  "factory-plate-lit",
  "factory-plate-shade",
  "factory-plate-edge",
  "factory-floor",
  "factory-hatch",
  "factory-shadow",
  "factory-ink",
  "factory-ink-soft",
  "factory-route",
  "factory-live",
  "factory-live-soft",
  "factory-pass",
  "factory-pass-soft",
  "factory-fail",
  "factory-fail-soft",
  "factory-wait",
  "factory-wait-soft",
  "factory-human",
  "factory-human-soft",
  "factory-select",
  "factory-lamp",
] as const;

export type Role = (typeof roleNames)[number];
export type ThemeName = "light" | "dark";
export type Theme = Record<Role, string>;

const light: Theme = {
  canvas: palette.paper50,
  surface: palette.paper0,
  "surface-raised": palette.paper0,
  "surface-sunken": palette.paper100,
  "surface-nav": palette.paper100,
  "surface-inverse": palette.charcoal,
  overlay: "rgba(20, 20, 19, 0.42)",

  ink: palette.charcoal,
  "ink-muted": "#5C5A54",
  "ink-subtle": palette.paper600,
  "ink-inverse": palette.cream,
  "ink-on-accent": palette.paper0,

  line: palette.paper200,
  "line-strong": palette.paper300,
  "line-control": palette.paper500,

  accent: palette.terracotta,
  "accent-fill": "#B5512F",
  "accent-fill-hover": "#9F4628",
  "accent-ink": "#A9482A",
  "accent-soft": "#F6E7DF",

  focus: "#2F6AA3",

  "info-ink": "#3A6496",
  "info-soft": "#E8EFF7",
  "info-line": "#B7CCE3",
  "info-fill": palette.blue,
  "success-ink": "#4E5E39",
  "success-soft": "#EEF1E6",
  "success-line": "#C5CFB4",
  "success-fill": palette.green,
  "warning-ink": "#7D5A12",
  "warning-soft": "#F8EED7",
  "warning-line": "#E3CD98",
  "warning-fill": palette.ochre,
  "danger-ink": "#A12F3A",
  "danger-soft": "#F9E6E6",
  "danger-line": "#E8B9BC",
  "danger-fill": palette.brick,
  "danger-fill-hover": "#962A34",
  "neutral-ink": "#5C5A54",
  "neutral-soft": palette.paper150,
  "neutral-line": palette.paper300,
  "neutral-fill": palette.paper500,

  "graph-dot": palette.paper300,
  "graph-edge": palette.paper500,
  "graph-edge-dependency": "#A9482A",

  "factory-ground": "#F2EFE7",
  "factory-grid": "#E5E1D5",
  "factory-grid-major": "#D5D0C1",
  "factory-plate-top": "#FDFCF9",
  "factory-plate-lit": "#ECE8DD",
  "factory-plate-shade": "#DAD5C6",
  "factory-plate-edge": "#9F9B8E",
  "factory-floor": "#F7F5EF",
  "factory-hatch": "#BDB8A8",
  "factory-shadow": "rgba(58, 52, 40, 0.13)",
  "factory-ink": "#3A3833",
  "factory-ink-soft": "#7A766B",
  "factory-route": "#858175",
  "factory-live": "#2F6AA3",
  "factory-live-soft": "#DCE7F3",
  "factory-pass": "#56683F",
  "factory-pass-soft": "#E6EBDB",
  "factory-fail": "#A12F3A",
  "factory-fail-soft": "#F5DEDF",
  "factory-wait": "#86621A",
  "factory-wait-soft": "#F3E6C6",
  "factory-human": "#A9482A",
  "factory-human-soft": "#F6E3D9",
  "factory-select": "#B5512F",
  "factory-lamp": "#FFF6E6",
};

const dark: Theme = {
  canvas: palette.charcoal,
  surface: palette.paper900,
  "surface-raised": palette.paper850,
  "surface-sunken": palette.paper1000,
  "surface-nav": palette.paper925,
  "surface-inverse": palette.cream,
  overlay: "rgba(0, 0, 0, 0.6)",

  ink: "#F0EEE6",
  "ink-muted": "#B5B2A7",
  "ink-subtle": "#9A978C",
  "ink-inverse": palette.charcoal,
  "ink-on-accent": palette.charcoal,

  line: palette.paper800,
  "line-strong": "#3D3C38",
  "line-control": "#75736A",

  accent: palette.terracotta,
  "accent-fill": palette.terracotta,
  "accent-fill-hover": "#E48B6C",
  "accent-ink": "#E8957A",
  "accent-soft": "#3A2620",

  focus: "#8DB4DD",

  "info-ink": "#8DB4DD",
  "info-soft": "#1E2A36",
  "info-line": "#34506C",
  "info-fill": palette.blue,
  "success-ink": "#A7B98A",
  "success-soft": "#232A1B",
  "success-line": "#47573A",
  "success-fill": palette.green,
  "warning-ink": "#D9B061",
  "warning-soft": "#2F2716",
  "warning-line": "#5E4C25",
  "warning-fill": palette.ochre,
  "danger-ink": "#EC8F96",
  "danger-soft": "#3A1D20",
  "danger-line": "#6E3036",
  "danger-fill": "#E06C75",
  "danger-fill-hover": "#E8848C",
  "neutral-ink": "#B5B2A7",
  "neutral-soft": palette.paper850,
  "neutral-line": "#3D3C38",
  "neutral-fill": palette.paper500,

  "graph-dot": "#2A2927",
  "graph-edge": "#75736A",
  "graph-edge-dependency": "#E8957A",

  "factory-ground": "#111110",
  "factory-grid": "#1D1D1B",
  "factory-grid-major": "#282725",
  "factory-plate-top": "#242421",
  "factory-plate-lit": "#1B1B19",
  "factory-plate-shade": "#161614",
  "factory-plate-edge": "#55534D",
  "factory-floor": "#1C1C1A",
  "factory-hatch": "#34332F",
  "factory-shadow": "rgba(0, 0, 0, 0.5)",
  "factory-ink": "#DAD6CA",
  "factory-ink-soft": "#8F8C81",
  "factory-route": "#76736A",
  "factory-live": "#8DB4DD",
  "factory-live-soft": "#1C2938",
  "factory-pass": "#A7B98A",
  "factory-pass-soft": "#222A1B",
  "factory-fail": "#EC8F96",
  "factory-fail-soft": "#3A1D20",
  "factory-wait": "#D9B061",
  "factory-wait-soft": "#2F2716",
  "factory-human": "#E8957A",
  "factory-human-soft": "#3A2620",
  "factory-select": "#E48B6C",
  "factory-lamp": "#2A2620",
};

export const themes: Record<ThemeName, Theme> = { light, dark };

/**
 * Pairs that must meet WCAG AA. `min` is 4.5 for text, 3 for large text and non-text UI
 * (control borders, focus rings, icons that carry meaning). Checked by the token script.
 */
export const contrastPairs: ReadonlyArray<{ fg: Role; bg: Role; min: 3 | 4.5; use: string }> = [
  { fg: "ink", bg: "canvas", min: 4.5, use: "Body text" },
  { fg: "ink", bg: "surface", min: 4.5, use: "Body text on panels" },
  { fg: "ink-muted", bg: "canvas", min: 4.5, use: "Secondary text" },
  { fg: "ink-muted", bg: "surface-nav", min: 4.5, use: "Secondary text in the navigation" },
  { fg: "ink-subtle", bg: "canvas", min: 4.5, use: "Captions, timestamps" },
  { fg: "ink-subtle", bg: "surface-sunken", min: 4.5, use: "Captions on sunken wells" },
  { fg: "ink-subtle", bg: "surface-raised", min: 4.5, use: "Captions in popovers" },
  { fg: "ink-inverse", bg: "surface-inverse", min: 4.5, use: "Tooltips" },
  { fg: "ink-on-accent", bg: "accent-fill", min: 4.5, use: "Primary button label" },
  { fg: "ink-on-accent", bg: "accent-fill-hover", min: 4.5, use: "Primary button label, hover" },
  { fg: "accent-ink", bg: "canvas", min: 4.5, use: "Links, current navigation item" },
  { fg: "accent-ink", bg: "accent-soft", min: 4.5, use: "Selected item label" },
  { fg: "line-control", bg: "canvas", min: 3, use: "Input and checkbox borders" },
  { fg: "line-control", bg: "surface", min: 3, use: "Input borders on panels" },
  { fg: "focus", bg: "canvas", min: 3, use: "Focus ring" },
  { fg: "focus", bg: "surface", min: 3, use: "Focus ring on panels" },
  { fg: "info-ink", bg: "info-soft", min: 4.5, use: "Info pill and banner" },
  { fg: "info-ink", bg: "canvas", min: 4.5, use: "Info text" },
  { fg: "success-ink", bg: "success-soft", min: 4.5, use: "Success pill and banner" },
  { fg: "success-ink", bg: "canvas", min: 4.5, use: "Success text" },
  { fg: "warning-ink", bg: "warning-soft", min: 4.5, use: "Warning pill and banner" },
  { fg: "warning-ink", bg: "canvas", min: 4.5, use: "Warning text" },
  { fg: "danger-ink", bg: "danger-soft", min: 4.5, use: "Danger pill and banner" },
  { fg: "danger-ink", bg: "canvas", min: 4.5, use: "Error text" },
  { fg: "ink-on-accent", bg: "danger-fill", min: 4.5, use: "Destructive button label" },
  { fg: "neutral-ink", bg: "neutral-soft", min: 4.5, use: "Neutral pill" },
  { fg: "graph-edge", bg: "canvas", min: 3, use: "Graph hierarchy edge" },
  { fg: "graph-edge-dependency", bg: "canvas", min: 3, use: "Graph dependency edge" },
  // Factory (M6). Labels on the ground and on plates; marks that carry meaning at 3:1.
  { fg: "ink", bg: "factory-ground", min: 4.5, use: "Factory label on the ground" },
  { fg: "ink-muted", bg: "factory-ground", min: 4.5, use: "Factory secondary label on the ground" },
  { fg: "ink-muted", bg: "factory-plate-top", min: 4.5, use: "Factory label on a plate" },
  { fg: "ink-muted", bg: "factory-floor", min: 4.5, use: "Factory label on a cell floor" },
  { fg: "factory-ink", bg: "factory-plate-top", min: 4.5, use: "Station and glyph ink on a plate" },
  { fg: "factory-ink", bg: "factory-floor", min: 4.5, use: "Station and glyph ink on a cell floor" },
  { fg: "factory-ink-soft", bg: "factory-plate-top", min: 3, use: "Secondary glyph strokes" },
  { fg: "factory-route", bg: "factory-ground", min: 3, use: "Workflow route on the ground" },
  { fg: "factory-route", bg: "factory-floor", min: 3, use: "Workflow route on a cell floor" },
  { fg: "factory-live", bg: "factory-ground", min: 3, use: "Live work on the ground" },
  { fg: "factory-live", bg: "factory-floor", min: 3, use: "Live work on a cell floor" },
  { fg: "factory-live", bg: "factory-live-soft", min: 3, use: "Live mark on its tint" },
  { fg: "factory-pass", bg: "factory-floor", min: 3, use: "Passed mark" },
  { fg: "factory-pass", bg: "factory-pass-soft", min: 3, use: "Passed mark on its tint" },
  { fg: "factory-fail", bg: "factory-floor", min: 3, use: "Failed mark" },
  { fg: "factory-fail", bg: "factory-fail-soft", min: 3, use: "Failed mark on its tint" },
  { fg: "factory-wait", bg: "factory-floor", min: 3, use: "Waiting mark" },
  { fg: "factory-wait", bg: "factory-wait-soft", min: 3, use: "Waiting mark on its tint" },
  { fg: "factory-human", bg: "factory-floor", min: 3, use: "Human gate mark" },
  { fg: "factory-human", bg: "factory-human-soft", min: 3, use: "Human gate mark on its tint" },
  { fg: "factory-select", bg: "factory-ground", min: 3, use: "Selection bracket on the ground" },
  { fg: "factory-select", bg: "factory-plate-top", min: 3, use: "Selection bracket on a plate" },
];

/**
 * Factory geometry and motion (M6, the Living Factory). Plain numbers, so the factory primitives,
 * the Atlas, the Blueprint and the WebGL layer read one set. Units: plan units (pu) on the ground
 * plane; 1pu is 1 CSS pixel at camera zoom 1. Durations in ms. See docs/mach-next/M6_0_VISUAL_SPEC.md.
 */
export const factoryTokens = {
  projection: {
    /** 2:1 dimetric. Plan x runs down-right, plan y runs down-left, z runs up. */
    angleDeg: 26.565,
    /** cos and sin of the angle: a plan unit along either axis keeps its length on screen. */
    cos: 0.894427,
    sin: 0.447214,
    /** Vertical scale: a unit of elevation is drawn this many screen pixels tall. */
    zScale: 0.82,
  },
  grid: { minor: 24, major: 96 },
  elevation: {
    ground: 0,
    regionPlate: 8,
    cellRim: 14,
    stationLow: 12,
    stationHigh: 22,
    gate: 34,
    gatehouse: 46,
    agent: 26,
    dais: 12,
    trunkCut: -6,
  },
  size: {
    cell: { x: 216, y: 148 },
    cellGap: 32,
    /** Gap between columns of cells: the aisle their doors open onto. */
    aisle: 56,
    /** Gap between regions, bridged by every track. */
    regionGap: 56,
    stationPad: 40,
    agentFootprint: 14,
    artifact: { w: 14, h: 18 },
    packet: { x: 12, y: 8, z: 6 },
    gateSpan: 44,
  },
  stroke: {
    hairline: 0.75,
    fine: 1,
    regular: 1.5,
    strong: 2,
    route: 1.5,
    routeLive: 2.25,
    select: 1.75,
  },
  shadow: { dx: 7, dy: 4, blur: 0 },
  zoom: { min: 0.35, max: 3, far: 0.6, near: 1.4, hysteresis: 0.05, step: 1.2 },
  motion: {
    packetTravel: 1400,
    pathDraw: 600,
    agentArrive: 480,
    agentLeave: 360,
    toolTick: 240,
    artifactMaterialise: 520,
    artifactHandoff: 900,
    gateClose: 420,
    gateOpen: 520,
    gateRefuse: 640,
    testResult: 160,
    testStagger: 60,
    verifyReturn: 1600,
    fanOut: 700,
    fanOutStagger: 90,
    voteConverge: 600,
    humanRelease: 700,
    mergeIntegrate: 1100,
    dependencyUnlock: 800,
    cellComplete: 900,
    stateChange: 260,
    cameraFocus: 650,
    modeSwitch: 700,
  },
  budget: { travelling: 12, drawing: 6, materialising: 8, gates: 4, lit: 4 },
} as const;

export type FactoryTokens = typeof factoryTokens;

/** Font stacks. Every face is bundled from npm (`@fontsource-variable/*`); nothing loads from a CDN. */
export const fonts = {
  serif: "'Newsreader Variable', 'Iowan Old Style', Georgia, serif",
  sans: "'Source Sans 3 Variable', 'Segoe UI', system-ui, sans-serif",
  mono: "'JetBrains Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

/**
 * Type scale. Sizes in rem (1rem = 16px). `family` is the default face for that step;
 * Control Tower swaps the display steps to the sans face (see `productOverrides`).
 */
export const typeScale = {
  display: { size: "2.5rem", line: "2.875rem", weight: 450, tracking: "-0.015em", family: "serif" },
  "title-1": { size: "1.875rem", line: "2.375rem", weight: 450, tracking: "-0.01em", family: "serif" },
  "title-2": { size: "1.4375rem", line: "1.875rem", weight: 500, tracking: "-0.005em", family: "serif" },
  "title-3": { size: "1.125rem", line: "1.625rem", weight: 600, tracking: "0", family: "sans" },
  "body-lg": { size: "1.0625rem", line: "1.75rem", weight: 400, tracking: "0", family: "serif" },
  body: { size: "1rem", line: "1.5rem", weight: 400, tracking: "0", family: "sans" },
  "body-sm": { size: "0.875rem", line: "1.25rem", weight: 400, tracking: "0", family: "sans" },
  label: { size: "0.875rem", line: "1.25rem", weight: 600, tracking: "0", family: "sans" },
  caption: { size: "0.8125rem", line: "1.125rem", weight: 400, tracking: "0.005em", family: "sans" },
  mono: { size: "0.8125rem", line: "1.25rem", weight: 450, tracking: "0", family: "mono" },
} as const;

export type TypeStep = keyof typeof typeScale;

/** Spacing follows Tailwind's 4px step (`p-1` = 4px). These are the named rhythm values. */
export const space = {
  hairline: "1px",
  "1": "4px",
  "2": "8px",
  "3": "12px",
  "4": "16px",
  "5": "20px",
  "6": "24px",
  "8": "32px",
  "10": "40px",
  "12": "48px",
  "16": "64px",
} as const;

/** Radii by hierarchy: smaller things are tighter. Pills are full. */
export const radius = {
  xs: "3px", // tags, IDs, keyboard keys
  sm: "5px", // controls: buttons, inputs, checkboxes
  md: "8px", // panels, graph nodes, banners
  lg: "12px", // dialogs, sheets, popovers
  full: "999px", // status pills
} as const;

/** Elevation. Light theme uses warm, low shadows; dark relies on lighter surfaces and lines. */
export const elevation = {
  light: {
    "1": "0 1px 2px rgba(20, 20, 19, 0.06)",
    "2": "0 2px 8px rgba(20, 20, 19, 0.08), 0 1px 2px rgba(20, 20, 19, 0.06)",
    "3": "0 12px 32px rgba(20, 20, 19, 0.14), 0 2px 6px rgba(20, 20, 19, 0.08)",
  },
  dark: {
    "1": "0 1px 2px rgba(0, 0, 0, 0.4)",
    "2": "0 4px 12px rgba(0, 0, 0, 0.45)",
    "3": "0 16px 40px rgba(0, 0, 0, 0.6)",
  },
} as const;

/** Motion. Durations in ms; every one collapses to 0 under `prefers-reduced-motion: reduce`. */
export const motion = {
  duration: {
    instant: 0,
    fast: 120, // hover, press, focus
    base: 180, // popovers, tooltips, tabs
    slow: 260, // dialogs, sheets, toasts
    layout: 400, // graph re-layout, list reordering
  },
  easing: {
    standard: [0.2, 0, 0, 1],
    enter: [0, 0, 0, 1],
    exit: [0.4, 0, 1, 1],
  },
} as const;

/** Layout constants, in px. */
export const layout = {
  railExpanded: 248,
  railCollapsed: 64,
  topBar: 56,
  readingMeasure: "68ch",
  contentMax: 1200,
  /** Below this the rail collapses to icons. */
  compactBreakpoint: 1180,
  minSupportedWidth: 1100,
  control: { sm: 28, md: 36, lg: 44 },
} as const;

/**
 * The two products share every role above. Control Tower (dark, cinematic, technical)
 * changes only these, via `data-product="control-tower"` on the root element.
 */
export const productOverrides = {
  "product-studio": {},
  "control-tower": {
    "--mach-font-display": "var(--mach-font-sans)",
    "--mach-density": "0.875",
  },
} as const;

export type ProductName = keyof typeof productOverrides;
