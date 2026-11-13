/**
 * The MACH Control Tower frame around the two views (M6.0 Shell, M6.2 sources): top bar with
 * identity, the permanent source badge (Live Factory, Historical replay or Simulation), the
 * connection and completeness badges, the stage, the contextual inspector, the synchronized timeline, Theater
 * Mode, the keyboard map and its help sheet, and the screen-reader announcer.
 *
 * Owned here: panel sizes, open and closed panels, the help sheet. Everything about the factory and
 * the playback (playhead, selection, focus, mode, Theater Mode) is the store's.
 */
import { CircleHelp, Monitor, Moon, PanelRight, PanelRightClose, Sun, TvMinimalPlay } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn, useTheme, type ThemePreference } from "@mach/ui";
import { refKind, type EntityRef } from "../sim";
import { useSceneStore, useStore } from "../scene";
import { Announcer } from "./Announcer";
import { Brand, ModeSwitch, RunIdentity } from "./chrome";
import { CompletenessBadge, ConnectionBadge, SOURCE_WORDS, SourceBadge, StageNotice } from "./SourceBadge";
import { useSource } from "./source/context";
import { HelpSheet } from "./HelpSheet";
import { Inspector } from "./inspector/Inspector";
import { useShellKeys } from "./keyboard";
import { Stage } from "./Stage";
import { THEATER_BOTTOM, THEATER_TOP, TheaterOverlay } from "./Theater";
import { Timeline } from "./timeline/Timeline";
import { IconButton } from "./timeline/Transport";
import "./shell.css";

const TOP = 48;
/**
 * Default proportions (spec f.8, revised after the review): the stage is the product, so the panels
 * start small. The inspector is a column on wide windows, an overlay drawer below 1280 px; the
 * timeline starts as transport, chapter ruler and one summary row of every track, and opens to all
 * tracks on request or when dragged taller.
 */
const INSPECTOR_W = { regular: 344, large: 368, overlay: 392 } as const;
/** The top border (1) + transport (40) + chapter ruler (38) + time axis (25) + one summary row (38). */
const SUMMARY_TIMELINE = 142;
/** Transport only, plus the top border. */
const COLLAPSED_TIMELINE = 41;
const WIDE = "(min-width: 1280px)";
const LARGE = "(min-width: 1680px)";
/** Below this height (a 1080 p screen at 200% zoom is 540) the timeline starts collapsed to its transport. */
const SHORT = "(max-height: 600px)";

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

function readHash(store: ReturnType<typeof useStore>) {
  const hash = window.location.hash.replace(/^#/, "");
  const [mode, query] = hash.split("?");
  if (mode === "atlas" || mode === "blueprint") store.setView(mode);
  const sel = new URLSearchParams(query ?? "").get("sel");
  if (sel && /^[a-z]+:.+/.test(sel)) store.select(sel as EntityRef);
  if (new URLSearchParams(query ?? "").get("theater") === "1") store.setTheater(true);
}

/** The mode and the selection in the address (#blueprint?sel=cell:LOCAL-031), both ways. */
function useHashSync() {
  const store = useStore();
  // Read once before the first render, so the stage mounts the view the address names (no switch,
  // and no transition, at start-up).
  useState(() => {
    if (typeof window !== "undefined") readHash(store);
    return true;
  });
  useEffect(() => {
    const read = () => readHash(store);
    window.addEventListener("hashchange", read);
    let last = "";
    const off = store.subscribe(() => {
      const s = store.getState();
      const next = `#${s.view}${s.selection ? `?sel=${encodeURIComponent(s.selection)}` : ""}`;
      if (next === last) return;
      last = next;
      if (window.location.hash !== next) window.history.replaceState(null, "", next);
    });
    return () => {
      window.removeEventListener("hashchange", read);
      off();
    };
  }, [store]);
}

function ThemeChoice() {
  const { preference, setPreference } = useTheme();
  const name = useId();
  const options: Array<{ value: ThemePreference; label: string; Icon: typeof Sun }> = [
    { value: "light", label: "Light theme", Icon: Sun },
    { value: "dark", label: "Dark theme", Icon: Moon },
    { value: "system", label: "Follow the system", Icon: Monitor },
  ];
  return (
    <fieldset className="flex shrink-0 rounded-sm border border-line p-0.5">
      <legend className="sr-only">Theme</legend>
      {options.map(({ value, label, Icon }) => (
        <label
          key={value}
          title={label}
          className={cn(
            "flex size-7 cursor-pointer items-center justify-center rounded-xs text-ink-subtle has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus",
            preference === value ? "bg-surface-sunken text-ink" : "hover:text-ink",
          )}
        >
          <input type="radio" name={name} value={value} checked={preference === value} onChange={() => setPreference(value)} className="sr-only" aria-label={label} />
          <Icon aria-hidden="true" className="size-3.5" />
        </label>
      ))}
    </fieldset>
  );
}

function TopBar({ inspectorOpen, onInspector, onHelp, sourceOpen, onSource }: { inspectorOpen: boolean; onInspector: () => void; onHelp: () => void; sourceOpen: boolean; onSource: (open: boolean) => void }) {
  const view = useSceneStore((s) => s.view);
  const store = useStore();
  // Reflows down to 960 CSS px (a 1920 px screen at 200% zoom) without cutting anything off: the
  // brand's second word and the Theater word give way first; the run's title truncates; the
  // source badge, the panel buttons and the mode switch never shrink.
  return (
    <div className="flex h-full min-w-0 items-center gap-3 border-b border-line bg-canvas px-3 min-[1100px]:gap-4 min-[1100px]:px-4">
      <Brand />
      <div className="flex shrink-0 items-center gap-1.5">
        <SourceBadge open={sourceOpen} onOpenChange={onSource} />
        <ConnectionBadge />
        <CompletenessBadge />
      </div>
      <span className="h-5 w-px shrink-0 bg-line" aria-hidden="true" />
      <div className="min-w-0 flex-1 overflow-hidden">
        <RunIdentity />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => store.setTheater(true)}
          aria-keyshortcuts="T"
          aria-label="Theater"
          className="inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-body-sm text-ink-muted hover:bg-surface-sunken hover:text-ink min-[1100px]:px-2.5 [&_svg]:size-4"
          title="Theater Mode (T)"
        >
          <TvMinimalPlay aria-hidden="true" />
          <span className="hidden min-[1100px]:inline" aria-hidden="true">
            Theater
          </span>
        </button>
        <IconButton label={inspectorOpen ? "Hide the inspector" : "Show the inspector"} shortcut="I" onClick={onInspector} pressed={inspectorOpen}>
          {inspectorOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRight aria-hidden="true" />}
        </IconButton>
        <IconButton label="Keyboard shortcuts" shortcut="?" onClick={onHelp}>
          <CircleHelp aria-hidden="true" />
        </IconButton>
        <ThemeChoice />
      </div>
      <span className="h-5 w-px shrink-0 bg-line" aria-hidden="true" />
      <ModeSwitch value={view} onChange={store.setView} />
    </div>
  );
}

/** The window's inner height, live. */
function useViewportHeight(): number {
  const [h, setH] = useState(() => (typeof window !== "undefined" ? window.innerHeight : 900));
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return h;
}

/** The open timeline's height with every track showing: as tall as its tracks, at most 40% of the window. */
function defaultOpenHeight(viewportH: number): number {
  return Math.round(Math.max(180, Math.min(300, viewportH * 0.4)));
}

/** The page title names the source, so a window or tab can never pass a simulation off as real. */
function usePageTitle() {
  const source = useSceneStore((s) => s.source);
  const { project } = useSource();
  useEffect(() => {
    const words = SOURCE_WORDS[source].label;
    document.title = source === "simulation" ? "Simulation (not real execution) · MACH Control Tower" : `${words}${project ? `: ${project}` : ""} · MACH Control Tower`;
  }, [source, project]);
}

export function Shell() {
  const store = useStore();
  useHashSync();
  usePageTitle();
  const source = useSceneStore((s) => s.source);
  const theater = useSceneStore((s) => s.theater);
  const view = useSceneStore((s) => s.view);
  const selection = useSceneStore((s) => s.selection);
  const wide = useMedia(WIDE);
  const large = useMedia(LARGE);
  const short = useMedia(SHORT);
  const viewportH = useViewportHeight();
  const [inspectorWanted, setInspectorWanted] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);
  // null: not chosen by the person, so it follows the window (collapsed on a short one).
  const [collapsedChoice, setCollapsedChoice] = useState<boolean | null>(null);
  const timelineCollapsed = collapsedChoice ?? short;
  const [tracksOpen, setTracksOpen] = useState(false);
  const [timelineH, setTimelineH] = useState(() => defaultOpenHeight(typeof window !== "undefined" ? window.innerHeight : 900));
  const [resizing, setResizing] = useState(false);
  const [help, setHelp] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const helpOpener = useRef<Element | null>(null);
  const helpRef = useRef(help);
  useEffect(() => {
    helpRef.current = help || sourceOpen;
  }, [help, sourceOpen]);

  // On a narrow window the inspector is an overlay: it opens when something is selected and closes
  // when the selection is cleared (derived during render, not in an effect).
  const [seenSelection, setSeenSelection] = useState(selection);
  if (seenSelection !== selection) {
    setSeenSelection(selection);
    setOverlayOpen(Boolean(selection));
  }

  // After a mode switch, ask the new view to keep the selection in view.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    const s = store.getState();
    if (s.selection) store.focusOn(s.selection, "api");
  }, [view, store]);

  const inspectorOpen = wide ? inspectorWanted : overlayOpen;
  const inspectorW = wide ? (large ? INSPECTOR_W.large : INSPECTOR_W.regular) : INSPECTOR_W.overlay;
  const toggleInspector = useCallback(() => (wide ? setInspectorWanted((v) => !v) : setOverlayOpen((v) => !v)), [wide]);
  const toggleTimeline = useCallback(() => setCollapsedChoice(!timelineCollapsed), [timelineCollapsed]);
  const commands = useMemo(
    () => ({
      toggleInspector,
      toggleTimeline,
      openHelp: () => {
        helpOpener.current = document.activeElement;
        setHelp(true);
      },
      openSource: () => setSourceOpen(true),
      modalOpen: () => helpRef.current,
    }),
    [toggleInspector, toggleTimeline],
  );
  useShellKeys(commands);

  // The timeline never takes more than 62% of the window, whatever was dragged on a taller one.
  const maxH = Math.round(viewportH * 0.62);
  const clampH = useCallback((h: number) => Math.round(Math.max(SUMMARY_TIMELINE + 40, Math.min(window.innerHeight * 0.62, h))), []);
  const tl = timelineCollapsed ? COLLAPSED_TIMELINE : tracksOpen ? Math.min(timelineH, maxH) : SUMMARY_TIMELINE;
  const rows = theater ? `0px minmax(0,1fr) 0px` : `${TOP}px minmax(0,1fr) ${tl}px`;
  const cols = `minmax(0,1fr) ${!theater && wide && inspectorOpen ? inspectorW : 0}px`;

  const setTracks = useCallback(
    (open: boolean) => {
      setTracksOpen(open);
      if (open) setCollapsedChoice(false);
    },
    [],
  );

  // Resizing the timeline: drag its top edge (or the empty parts of the transport bar), or arrow keys
  // on the handle. Dragging or growing it opens every track; Enter collapses it to the transport.
  const drag = useRef<{ y: number; h: number } | null>(null);
  const onResizeDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: tl };
    setResizing(true);
  };
  const onResizeMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    const want = drag.current.h + (drag.current.y - e.clientY);
    if (Math.abs(want - drag.current.h) < 4) return;
    setCollapsedChoice(false);
    setTracksOpen(true);
    setTimelineH(clampH(want));
  };
  const onResizeUp = () => {
    drag.current = null;
    setResizing(false);
  };
  const onResizeKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowUp") {
      setCollapsedChoice(false);
      setTimelineH(clampH((tracksOpen ? Math.min(timelineH, maxH) : SUMMARY_TIMELINE) + 24));
      setTracksOpen(true);
    } else if (e.key === "ArrowDown") {
      if (tracksOpen && Math.min(timelineH, maxH) - 24 < SUMMARY_TIMELINE + 40) setTracksOpen(false);
      else if (tracksOpen) setTimelineH((h) => clampH(Math.min(h, maxH) - 24));
      else setCollapsedChoice(true);
    } else if (e.key === "Enter") setCollapsedChoice(!timelineCollapsed);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const stageLabel = view === "atlas" ? "Factory Atlas" : "Execution Blueprint";
  const selectionWord = selection ? refKind(selection) : null;

  return (
    <div className="mach-frame text-ink" style={{ gridTemplateRows: rows, gridTemplateColumns: cols }} data-resizing={resizing ? "" : undefined} data-theater={theater ? "" : undefined}>
      <a
        href="#stage"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("stage")?.focus();
        }}
        className="sr-only z-[70] rounded-sm bg-surface-raised px-3 py-2 text-label text-ink shadow-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to the factory view
      </a>

      <header className="min-w-0 overflow-hidden [grid-area:top]" inert={theater}>
        <TopBar sourceOpen={sourceOpen} onSource={setSourceOpen} inspectorOpen={inspectorOpen} onInspector={toggleInspector} onHelp={() => {
          helpOpener.current = document.activeElement;
          setHelp(true);
        }} />
      </header>

      <main id="stage" tabIndex={-1} aria-label={`${stageLabel} (${SOURCE_WORDS[source].label})`} className="relative min-h-0 min-w-0 overflow-clip bg-factory-ground outline-none [grid-area:stage]">
        {/* In Theater Mode the views are inset by two strips that hold the Theater chrome. */}
        <div className="absolute inset-x-0" style={{ top: theater ? THEATER_TOP : 0, bottom: theater ? THEATER_BOTTOM : 0 }}>
          <Stage />
        </div>
        {theater ? null : <StageNotice />}
        {theater ? <TheaterOverlay /> : null}
      </main>

      <aside
        tabIndex={-1}
        aria-label={selectionWord ? `Inspector: ${selectionWord}` : "Inspector: the run now"}
        inert={theater || !inspectorOpen}
        className={cn(
          "min-h-0 min-w-0 overflow-hidden border-line bg-surface outline-none [grid-area:inspector]",
          wide
            ? "border-l"
            : cn(
                // A drawer over the stage and the timeline, never wider than the window less a margin.
                "fixed right-0 z-30 w-[min(392px,calc(100vw-32px))] border-l shadow-3 transition-transform duration-[var(--mach-duration-slow)] ease-enter",
                inspectorOpen && !theater ? "translate-x-0" : "translate-x-full",
              ),
        )}
        // As a drawer it stops at the timeline, so the transport stays in reach while it is open.
        style={wide ? undefined : { top: theater ? 0 : TOP, bottom: theater ? 0 : tl }}
      >
        <div className="h-full" style={{ width: wide ? inspectorW : "100%" }}>
          <Inspector />
        </div>
      </aside>

      <section aria-label="Execution timeline" inert={theater} className="relative min-h-0 min-w-0 overflow-hidden border-t border-line bg-surface [grid-area:timeline]">
        {/* The resize handle: a 24 px target along the top edge (WCAG 2.5.8), drawn as a hairline. It
            lies under the transport's controls, so it takes only the bar's empty space. */}
        <button
          type="button"
          aria-label="Resize the timeline: drag, or use the up and down arrows; Enter collapses it"
          aria-keyshortcuts="ArrowUp ArrowDown Enter"
          title="Drag to resize the timeline"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          onKeyDown={onResizeKey}
          data-timeline-resize=""
          className="group absolute inset-x-0 top-0 z-0 h-6 cursor-row-resize touch-none outline-none"
        >
          <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] group-hover:bg-line-strong group-focus-visible:bg-focus" />
        </button>
        <Timeline collapsed={timelineCollapsed} onCollapse={toggleTimeline} tracksOpen={tracksOpen} onTracks={setTracks} />
      </section>

      <Announcer />
      <HelpSheet open={help} onOpenChange={setHelp} opener={helpOpener} />
    </div>
  );
}
