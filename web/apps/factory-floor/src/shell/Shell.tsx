/**
 * The MACH Factory Floor frame around its workspaces: top bar with identity, the permanent source
 * badge (Live Factory or Simulation), the connection and completeness badges, the workspace switch,
 * the stage, the contextual inspector, Theater Mode, the keyboard map and its help sheet, and the
 * screen-reader announcer.
 *
 * Three workspaces (the store's `workspace`): the Line (the default: stations as columns, a row for
 * each ticket, with its own side panel), the Floor (the isometric Factory Atlas, with the inspector) and Factory Analytics (with the inspector on request). The Floor's stage stays
 * mounted while another workspace is up: hidden, inert, and reading a held view of the store
 * (heldStore), so it does no work and returns exactly as it was. The Line and Analytics are mounted
 * only while shown. Everything shows the present: there is no playhead.
 *
 * Owned here: the inspector's open state, the help sheet. Everything about the factory (selection,
 * focus, workspace, Theater Mode) is the store's.
 */
import { CircleHelp, Monitor, Moon, PanelRight, PanelRightClose, Sun, TvMinimalPlay } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn, useTheme, type ThemePreference } from "@mach/ui";
import { refKind } from "../sim";
import { heldStore, SceneStoreProvider, showInAnalytics, showOnFloor, showOnLine, useSceneStore, useStore, type SceneStore } from "../scene";
import { AnalyticsWorkspace } from "../analytics/Workspace";
import { LineWorkspace } from "../line/Workspace";
import { Announcer } from "./Announcer";
import { Brand, PlacesChip, RunIdentity, WorkspaceSwitch } from "./chrome";
import { CompletenessBadge, ConnectionBadge, FactoryStateChip, SOURCE_WORDS, SourceBadge, StageNotice } from "./SourceBadge";
import { useSource } from "./source/context";
import { parseHash } from "./source/hash";
import { applyHash, browserHashHost, createHashSync } from "./source/hashSync";
import { HelpSheet } from "./HelpSheet";
import { EvidencePlayer } from "../evidence/EvidencePlayer";
import { Inspector } from "./inspector/Inspector";
import { useShellKeys } from "./keyboard";
import { AtlasView } from "../atlas";
import { THEATER_BOTTOM, THEATER_TOP, TheaterOverlay } from "./Theater";
import { FollowState } from "./FollowState";
import { IconButton } from "./IconButton";
import "./shell.css";
import { FreeTextLabel } from "./inspector/FreeText";

const TOP = 48;
/** The inspector is a column on wide windows, an overlay drawer below 1280 px. */
const INSPECTOR_W = { regular: 344, large: 368, overlay: 392 } as const;
const WIDE = "(min-width: 1280px)";
const LARGE = "(min-width: 1680px)";

/** The header's height, live: one row of 48 px, more when its controls wrap (M6.6). */
function useHeaderHeight(ref: { current: HTMLElement | null }): number {
  const [h, setH] = useState(TOP);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const next = Math.max(TOP, Math.round(el.getBoundingClientRect().height));
      setH((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

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

/** The workspace and the selection in the address (#line?sel=cell:131), both ways. Grammar: source/hash.ts. */
function useHashSync(): void {
  const store = useStore();
  // Read once before the first render, so the stage mounts the workspace the address names (no switch, and no transition, at start-up).
  useState(() => {
    if (typeof window !== "undefined") applyHash(store, parseHash(window.location.hash));
    return true;
  });
  useEffect(() => {
    const sync = createHashSync(store, browserHashHost());
    return () => sync.dispose();
  }, [store]);
}

/**
 * The Floor's view of the store: held still while another workspace is up. It holds and releases
 * itself in the store's own change handler (heldStore, A3), so the change that leaves the Floor never
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
  const workspace = useSceneStore((s) => s.workspace);
  const store = useStore();
  const onFloor = workspace === "floor";
  // Reflows down to 320 CSS px (M6.6, WCAG 1.4.10): whatever does not fit wraps onto a further row
  // instead of being cut off. The run's title has no width of its own (basis 0), so it never forces a
  // wrap; below 640 px it takes a row of its own.
  return (
    <div className="flex min-h-12 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-canvas px-3 py-1 min-[1100px]:gap-x-4 min-[1100px]:px-4" data-top-bar="">
      <Brand />
      <nav aria-label="Workspaces" className="flex shrink-0 flex-wrap items-center gap-1.5">
        <WorkspaceSwitch value={workspace} onChange={(w) => (w === "line" ? showOnLine(store) : w === "analytics" ? showInAnalytics(store) : showOnFloor(store))} />
      </nav>
      <span className="h-5 w-px shrink-0 bg-line max-[639px]:hidden" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-0 overflow-hidden max-[639px]:order-last max-[639px]:basis-full">
        <RunIdentity />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <SourceBadge open={sourceOpen} onOpenChange={onSource} />
        <ConnectionBadge />
        <CompletenessBadge />
        <FactoryStateChip />
        <PlacesChip />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onFloor ? <FollowState /> : null}
        {/* Theater Mode is the Floor's: not offered elsewhere. */}
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
        {workspace === "line" ? null : (
          <IconButton label={inspectorOpen ? "Hide the inspector" : "Show the inspector"} shortcut="I" onClick={onInspector} pressed={inspectorOpen}>
            {inspectorOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRight aria-hidden="true" />}
          </IconButton>
        )}
        <IconButton label="Keyboard shortcuts" shortcut="?" onClick={onHelp}>
          <CircleHelp aria-hidden="true" />
        </IconButton>
        <ThemeChoice />
      </div>
    </div>
  );
}

/** The page title names the source, so a window or tab can never pass a simulation off as real. */
function usePageTitle() {
  const source = useSceneStore((s) => s.source);
  const { project } = useSource();
  useEffect(() => {
    const words = SOURCE_WORDS[source].label;
    document.title = source === "simulation" ? "Simulation (not real execution) · MACH Factory Floor" : `${words}${project ? `: ${project}` : ""} · MACH Factory Floor`;
  }, [source, project]);
}

const STAGE_LABEL = { line: "Line", floor: "Floor: Factory Atlas", analytics: "Factory Analytics" } as const;

export function Shell() {
  const store = useStore();
  useHashSync();
  usePageTitle();
  const source = useSceneStore((s) => s.source);
  const theater = useSceneStore((s) => s.theater);
  const workspace = useSceneStore((s) => s.workspace);
  const reduced = useSceneStore((s) => s.reducedMotion);
  const onFloor = workspace === "floor";
  const onLine = workspace === "line";
  const inAnalytics = workspace === "analytics";
  const floorStore = useFloorStore(store);
  const floorRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const analyticsRef = useRef<HTMLDivElement>(null);
  useArrival(floorRef, onFloor, reduced);
  useArrival(lineRef, onLine, reduced);
  useArrival(analyticsRef, inAnalytics, reduced);
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
  const headerRef = useRef<HTMLElement>(null);
  const topH = useHeaderHeight(headerRef);
  const [inspectorWanted, setInspectorWanted] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);
  // Analytics takes the whole width: the inspector there starts closed and opens only when asked
  // (I, the inspector button) or when a selection is made while Analytics is on screen.
  const [analyticsInspector, setAnalyticsInspector] = useState(false);
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
    if (inAnalytics && selection) setAnalyticsInspector(true);
  }

  // The Line has its own side panel; the inspector belongs to the Floor and Analytics.
  const inspectorOpen = onLine ? false : inAnalytics ? analyticsInspector : wide ? inspectorWanted : overlayOpen;
  const inspectorW = wide ? (large ? INSPECTOR_W.large : INSPECTOR_W.regular) : INSPECTOR_W.overlay;
  const toggleInspector = useCallback(() => (inAnalytics ? setAnalyticsInspector((v) => !v) : wide ? setInspectorWanted((v) => !v) : setOverlayOpen((v) => !v)), [wide, inAnalytics]);
  const commands = useMemo(
    () => ({
      toggleInspector,
      openHelp: () => {
        helpOpener.current = document.activeElement;
        setHelp(true);
      },
      openSource: () => setSourceOpen(true),
      // The help sheet, the evidence player (M6.4) or a ticket's full record: a panel over the workspace that owns the keyboard while open.
      modalOpen: () => helpRef.current || store.getState().evidence !== null || document.querySelector("[data-line-record]") !== null,
    }),
    [toggleInspector, store],
  );
  useShellKeys(commands);

  // Theater Mode is the Floor's.
  const rows = theater && onFloor ? `0px minmax(0,1fr)` : `minmax(${TOP}px,auto) minmax(0,1fr)`;
  const cols = `minmax(0,1fr) ${!theater && wide && inspectorOpen ? inspectorW : 0}px`;
  const stageLabel = STAGE_LABEL[workspace];
  const selectionWord = selection ? refKind(selection) : null;

  return (
    <div className="mach-frame text-ink" style={{ gridTemplateRows: rows, gridTemplateColumns: cols }} data-theater={theater ? "" : undefined} data-scene-ready={mountedOnce && sceneApplied ? "" : undefined} data-workspace-shown={workspace}>
      <a
        href="#stage"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("stage")?.focus();
        }}
        className="sr-only z-[70] rounded-sm bg-surface-raised px-3 py-2 text-label text-ink shadow-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        {onFloor ? "Skip to the factory view" : inAnalytics ? "Skip to the analytics" : "Skip to the line"}
      </a>

      <header ref={headerRef} className="min-w-0 overflow-hidden [grid-area:top]" inert={theater}>
        <TopBar
          sourceOpen={sourceOpen}
          onSource={setSourceOpen}
          inspectorOpen={inspectorOpen}
          onInspector={toggleInspector}
          onHelp={() => {
            helpOpener.current = document.activeElement;
            setHelp(true);
          }}
        />
      </header>

      <main id="stage" tabIndex={-1} aria-label={`${stageLabel} (${SOURCE_WORDS[source].label})`} className="relative min-h-0 min-w-0 overflow-clip bg-factory-ground outline-none [grid-area:stage]">
        {/* The Floor: always mounted; while another workspace is up, hidden, inert and held still. In Theater Mode it is inset by two strips that hold the Theater chrome. */}
        <div
          ref={floorRef}
          // isolate: the Atlas's layers carry their own z-index and `visibility: visible`, which would
          // otherwise paint through the hidden wrapper and over another workspace.
          className={cn("absolute inset-0 isolate", onFloor ? "" : "opacity-0")}
          data-workspace="floor"
          inert={!onFloor}
          aria-hidden={onFloor ? undefined : true}
          style={{ visibility: onFloor ? "visible" : "hidden" }}
        >
          <SceneStoreProvider store={floorStore}>
            <div className="absolute inset-x-0" style={{ top: theater ? THEATER_TOP : 0, bottom: theater ? THEATER_BOTTOM : 0 }} data-stage-active="">
              <AtlasView />
            </div>
          </SceneStoreProvider>
          {theater || !onFloor ? null : <StageNotice />}
          {/* One label for the panel (I-05, C3): the Floor draws agent labels, finding titles and recorded reasons bounded, never labelled one by one. */}
          {theater || !onFloor || source === "simulation" ? null : (
            <p className="pointer-events-none absolute left-3 top-2 z-20 whitespace-nowrap rounded-xs bg-surface/90 px-2 py-0.5 text-caption text-ink-muted" data-free-text-panel-note="">
              <FreeTextLabel what="Titles, labels and reasons" className="inline" />
            </p>
          )}
          {theater && onFloor ? <TheaterOverlay /> : null}
        </div>
        {onLine ? (
          <div ref={lineRef} className="absolute inset-0 isolate z-10 bg-surface" data-workspace="line">
            <LineWorkspace />
          </div>
        ) : null}
        {inAnalytics ? (
          <div ref={analyticsRef} className="absolute inset-0 isolate z-10 overflow-hidden bg-surface" data-workspace="analytics" data-analytics-workspace="" data-analytics-source={source}>
            <AnalyticsWorkspace />
          </div>
        ) : null}
      </main>

      <aside
        tabIndex={-1}
        aria-label={selectionWord ? `Inspector: ${selectionWord}` : "Inspector: the run now"}
        inert={theater || !inspectorOpen}
        hidden={onLine}
        className={cn(
          "min-h-0 min-w-0 overflow-hidden border-line bg-surface outline-none [grid-area:inspector]",
          wide
            ? "border-l"
            : cn(
                // A drawer over the stage, never wider than the window less a margin; below 640 px a full-width sheet (M6.6, WCAG 1.4.10).
                "fixed bottom-0 right-0 z-30 w-[min(392px,calc(100vw-32px))] border-l shadow-3 max-[639px]:w-full max-[639px]:border-l-0 transition-transform duration-[var(--mach-duration-slow)] ease-enter",
                inspectorOpen && !theater ? "translate-x-0" : "translate-x-full",
              ),
        )}
        style={wide ? undefined : { top: theater ? 0 : topH }}
      >
        <div className="h-full" style={{ width: wide ? inspectorW : "100%" }}>
          <Inspector />
        </div>
      </aside>

      <Announcer />
      <HelpSheet open={help} onOpenChange={setHelp} opener={helpOpener} />
      <EvidencePlayer />
    </div>
  );
}
