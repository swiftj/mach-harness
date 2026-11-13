/**
 * The MACH Control Tower frame around its workspaces (M6.0 Shell, M6.2 sources, M6.3 workspaces): top
 * bar with identity, the permanent source badge (Live Factory, Historical replay or Simulation), the
 * connection and completeness badges, the workspace switch, the stage, the contextual inspector, the
 * synchronized timeline, Theater Mode, the keyboard map and its help sheet, and the screen-reader announcer.
 *
 * Two workspaces (the store's `workspace`): the Factory Floor (the stage with its two views, and the
 * docked timeline under it) and the Execution Timeline, which takes the place of both. The header and
 * the inspector stay. The floor's stage stays mounted while the Timeline is up: hidden, inert, and
 * reading a held view of the store (heldStore), so it does no work and returns exactly as it was.
 *
 * Owned here: panel sizes, open and closed panels, the help sheet. Everything about the factory and
 * the playback (playhead, selection, focus, mode, workspace, Theater Mode) is the store's.
 */
import { CircleHelp, Monitor, Moon, PanelRight, PanelRightClose, Sun, TvMinimalPlay, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn, useTheme, type ThemePreference } from "@mach/ui";
import { refKind } from "../sim";
import { heldStore, SceneStoreProvider, showInTimeline, showOnFloor, useSceneStore, useStore, type SceneStore } from "../scene";
import { timelineDataFor } from "../timeline/data";
import { TIMELINE_CHROME_HEIGHT } from "../timeline/controls/frame";
import { TimelineWorkspace } from "../timeline/Workspace";
import { focusTracks } from "../timeline/a11y/skip";
import { Announcer } from "./Announcer";
import { Brand, ModeSwitch, RunIdentity, WorkspaceSwitch } from "./chrome";
import { CompletenessBadge, ConnectionBadge, FactoryStateChip, SOURCE_WORDS, SourceBadge, StageNotice } from "./SourceBadge";
import { useSource } from "./source/context";
import { parseHash, type HashAt } from "./source/hash";
import { applyHash, browserHashHost, createHashSync, type LostReason } from "./source/hashSync";
import { locateEvent } from "./source/locate";
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
/** At or below this width the inspector starts closed in the Timeline (X20). */
const NARROW = "(max-width: 1100px)";
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

/**
 * The workspace, view, selection, playhead and Timeline window in the address
 * (#blueprint?sel=cell:LOCAL-031, #timeline?sel=...&at=...&win=...&group=...), both ways. Grammar and
 * rules: source/hash.ts and source/hashSync.ts.
 */
function useHashSync(): { lost: { at: HashAt; why: LostReason } | null; dismiss: () => void } {
  const store = useStore();
  const { client = null } = useSource();
  const [lost, setLost] = useState<{ at: HashAt; why: LostReason } | null>(null);
  // Read once before the first render, so the stage mounts the view (and the workspace) the address
  // names (no switch, and no transition, at start-up). `at` waits for history: createHashSync below.
  useState(() => {
    if (typeof window !== "undefined") applyHash(store, parseHash(window.location.hash));
    return true;
  });
  useEffect(() => {
    const data = timelineDataFor(store, client);
    const sync = createHashSync(store, browserHashHost(), undefined, {
      // An event the history held does not reach: found through the Timeline's marks and span ends, over the whole history.
      locate: (id) => {
        const s = store.getState();
        const ext = data.extent();
        const whole = { from: Math.min(s.extent.start, ext?.from ?? s.extent.start), to: Math.max(s.liveAt, s.extent.end, ext?.to ?? s.liveAt) };
        return locateEvent(data, whole, id);
      },
      onLost: (at, why) => setLost({ at, why }),
    });
    return () => sync.dispose();
  }, [store, client]);
  return { lost, dismiss: useCallback(() => setLost(null), []) };
}

/** Said when the address named a moment that was not applied: never dropped silently. */
function LostMomentNotice({ at, why, onDismiss }: { at: HashAt; why: LostReason; onDismiss: () => void }) {
  const what = at.kind === "event" ? `the event ${at.id.length > 64 ? `${at.id.slice(0, 61)}…` : at.id}` : "that time";
  const text =
    why === "not-found"
      ? `The address names a moment (${what}) that could not be located in the history held. The playhead was left where it was.`
      : `The moment the address names (${what}) was not applied: you moved first.`;
  return (
    <div role="status" className="absolute bottom-4 left-1/2 z-40 flex w-[min(560px,calc(100%-32px))] -translate-x-1/2 items-start gap-2 rounded-md border border-line bg-surface-raised px-3 py-2 text-body-sm text-ink shadow-2" data-lost-moment={why}>
      <span className="min-w-0 flex-1">{text}</span>
      <IconButton label="Dismiss" onClick={onDismiss} className="-my-1 size-7">
        <X aria-hidden="true" />
      </IconButton>
    </div>
  );
}

/**
 * The floor's view of the store: held still while another workspace is up. It holds and releases
 * itself in the store's own change handler (heldStore, A3), so the change that leaves the floor never
 * reaches it and the one that returns catches it up at once, before any render.
 */
function useFloorStore(store: SceneStore) {
  const [held] = useState(() => heldStore(store));
  return held;
}

/** A short fade when a workspace comes up; a cut under reduced motion. */
function useArrival(ref: { current: HTMLElement | null }, shown: boolean, reduced: boolean) {
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!shown || reduced || !el || typeof el.animate !== "function") return;
    const a = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    return () => a.cancel();
  }, [ref, shown, reduced]);
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
  const workspace = useSceneStore((s) => s.workspace);
  const store = useStore();
  const onFloor = workspace === "floor";
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
        <FactoryStateChip />
      </div>
      <span className="h-5 w-px shrink-0 bg-line" aria-hidden="true" />
      <div className="min-w-0 flex-1 overflow-hidden">
        <RunIdentity />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* Theater Mode is the floor's: not offered while the Timeline is up. */}
        <button
          type="button"
          hidden={!onFloor}
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
      <nav aria-label="Workspaces" className="flex shrink-0 items-center gap-1.5">
        <WorkspaceSwitch value={workspace} onChange={(w) => (w === "timeline" ? showInTimeline(store) : showOnFloor(store))} />
        {onFloor ? <ModeSwitch value={view} onChange={store.setView} /> : null}
      </nav>
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
  const lostMoment = useHashSync();
  usePageTitle();
  const source = useSceneStore((s) => s.source);
  const theater = useSceneStore((s) => s.theater);
  const view = useSceneStore((s) => s.view);
  const workspace = useSceneStore((s) => s.workspace);
  const reduced = useSceneStore((s) => s.reducedMotion);
  const onFloor = workspace === "floor";
  const floorStore = useFloorStore(store);
  const floorRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  useArrival(floorRef, onFloor, reduced);
  useArrival(timelineRef, !onFloor, reduced);
  const selection = useSceneStore((s) => s.selection);
  // For browser tests: the scene's first state is applied (the simulation at once; live once history
  // holds something or the connection has left "connecting"), and the shell has mounted with it.
  const sceneApplied = useSceneStore((s) => s.source !== "live" || s.log.size() > 0 || (s.connection !== null && s.connection.state !== "connecting"));
  const [mountedOnce, setMountedOnce] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMountedOnce(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const wide = useMedia(WIDE);
  const large = useMedia(LARGE);
  const short = useMedia(SHORT);
  const narrow = useMedia(NARROW);
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
  // X20: at 1100 px wide or less the drawer would cover half the Timeline, so there it starts closed
  // and a selection does not open it (I, or the inspector button, does).
  const compactTimeline = narrow && !onFloor;
  const [seenSelection, setSeenSelection] = useState(selection);
  if (seenSelection !== selection) {
    setSeenSelection(selection);
    setOverlayOpen(Boolean(selection) && !compactTimeline);
  }
  const [seenCompact, setSeenCompact] = useState(compactTimeline);
  if (seenCompact !== compactTimeline) {
    setSeenCompact(compactTimeline);
    if (compactTimeline) setOverlayOpen(false);
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

  // The hidden floor's Blueprint still listens on the window for its zoom keys when nothing holds
  // focus; while the Timeline is up those keys are not the floor's, so they stop here.
  useEffect(() => {
    if (onFloor) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!(e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0")) return;
      const active = document.activeElement;
      if (!active || active === document.body || active.id === "stage") e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onFloor]);

  // The timeline never takes more than 62% of the window, whatever was dragged on a taller one.
  const maxH = Math.round(viewportH * 0.62);
  const clampH = useCallback((h: number) => Math.round(Math.max(SUMMARY_TIMELINE + 40, Math.min(window.innerHeight * 0.62, h))), []);
  const tl = timelineCollapsed ? COLLAPSED_TIMELINE : tracksOpen ? Math.min(timelineH, maxH) : SUMMARY_TIMELINE;
  // The Timeline workspace takes the stage and the docked timeline's rows; Theater Mode is the floor's.
  const rows = theater && onFloor ? `0px minmax(0,1fr) 0px` : `${TOP}px minmax(0,1fr) ${onFloor ? tl : 0}px`;
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

  const stageLabel = !onFloor ? "Execution Timeline" : view === "atlas" ? "Factory Atlas" : "Execution Blueprint";
  const selectionWord = selection ? refKind(selection) : null;

  return (
    <div className="mach-frame text-ink" style={{ gridTemplateRows: rows, gridTemplateColumns: cols }} data-resizing={resizing ? "" : undefined} data-theater={theater ? "" : undefined} data-scene-ready={mountedOnce && sceneApplied ? "" : undefined}>
      <a
        href="#stage"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("stage")?.focus();
        }}
        className="sr-only z-[70] rounded-sm bg-surface-raised px-3 py-2 text-label text-ink shadow-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        {onFloor ? "Skip to the factory view" : "Skip to the timeline"}
      </a>
      {/* The Timeline's tracks are past its transport and toolbar: the page's second Tab stop goes straight to them. */}
      {onFloor ? null : (
        <a
          href="#stage"
          data-skip-tracks=""
          onClick={(e) => {
            e.preventDefault();
            focusTracks(document, document.getElementById("stage"));
          }}
          className="sr-only z-[70] rounded-sm bg-surface-raised px-3 py-2 text-label text-ink shadow-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
        >
          Skip to the tracks
        </a>
      )}

      <header className="min-w-0 overflow-hidden [grid-area:top]" inert={theater}>
        <TopBar sourceOpen={sourceOpen} onSource={setSourceOpen} inspectorOpen={inspectorOpen} onInspector={toggleInspector} onHelp={() => {
          helpOpener.current = document.activeElement;
          setHelp(true);
        }} />
      </header>

      <main id="stage" tabIndex={-1} aria-label={`${stageLabel} (${SOURCE_WORDS[source].label})`} className="relative min-h-0 min-w-0 overflow-clip bg-factory-ground outline-none [grid-area:stage]">
        {/* In Theater Mode the views are inset by two strips that hold the Theater chrome. */}
        {/* The floor: always mounted; while the Timeline is up, hidden, inert and held still. */}
        <div
          ref={floorRef}
          // isolate: the stage's layers carry their own z-index and `visibility: visible`, which would
          // otherwise paint through the hidden wrapper and over the Timeline.
          className={cn("absolute inset-0 isolate", onFloor ? "" : "opacity-0")}
          data-workspace="floor"
          inert={!onFloor}
          aria-hidden={onFloor ? undefined : true}
          style={{ visibility: onFloor ? "visible" : "hidden" }}
        >
          <SceneStoreProvider store={floorStore}>
            <div className="absolute inset-x-0" style={{ top: theater ? THEATER_TOP : 0, bottom: theater ? THEATER_BOTTOM : 0 }}>
              <Stage />
            </div>
          </SceneStoreProvider>
          {theater || !onFloor ? null : <StageNotice />}
          {theater && onFloor ? <TheaterOverlay /> : null}
        </div>
        {onFloor ? null : (
          <div ref={timelineRef} className="absolute inset-0 isolate z-10 bg-surface" data-workspace="timeline">
            <TimelineWorkspace />
          </div>
        )}
        {lostMoment.lost ? <LostMomentNotice at={lostMoment.lost.at} why={lostMoment.lost.why} onDismiss={lostMoment.dismiss} /> : null}
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
        // As a drawer it stops at the timeline, so the transport stays in reach while it is open; over
        // the Timeline workspace it starts under that workspace's transport and toolbar, for the same reason.
        style={wide ? undefined : { top: theater ? 0 : onFloor ? TOP : TOP + TIMELINE_CHROME_HEIGHT, bottom: theater || !onFloor ? 0 : tl }}
      >
        <div className="h-full" style={{ width: wide ? inspectorW : "100%" }}>
          <Inspector />
        </div>
      </aside>

      <section aria-label="Execution timeline" hidden={!onFloor} inert={theater || !onFloor} className="relative min-h-0 min-w-0 overflow-hidden border-t border-line bg-surface [grid-area:timeline]">
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
        {/* The docked timeline belongs to the floor; the Timeline workspace replaces it. */}
        {onFloor ? <Timeline collapsed={timelineCollapsed} onCollapse={toggleTimeline} tracksOpen={tracksOpen} onTracks={setTracks} /> : null}
      </section>

      <Announcer />
      <HelpSheet open={help} onOpenChange={setHelp} opener={helpOpener} />
    </div>
  );
}
