/**
 * The MACH Control Tower frame around the two views (M6.0 Shell): top bar with identity and the
 * permanent simulation stamp, the stage, the contextual inspector, the synchronized timeline, Theater
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
import { Brand, ModeSwitch, RunIdentity, SimulationStamp } from "./chrome";
import { HelpSheet } from "./HelpSheet";
import { Inspector } from "./inspector/Inspector";
import { useShellKeys } from "./keyboard";
import { Stage } from "./Stage";
import { TheaterOverlay } from "./Theater";
import { Timeline } from "./timeline/Timeline";
import { IconButton } from "./timeline/Transport";
import "./shell.css";

const TOP = 48;
const INSPECTOR_W = 392;
const COLLAPSED_TIMELINE = 41;
const WIDE = "(min-width: 1280px)";

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

/** The mode and the selection in the address (#blueprint?sel=cell:LOCAL-031), both ways. */
function useHashSync() {
  const store = useStore();
  useEffect(() => {
    const read = () => {
      const hash = window.location.hash.replace(/^#/, "");
      const [mode, query] = hash.split("?");
      if (mode === "atlas" || mode === "blueprint") store.setView(mode);
      const sel = new URLSearchParams(query ?? "").get("sel");
      if (sel && /^[a-z]+:.+/.test(sel)) store.select(sel as EntityRef);
      if (new URLSearchParams(query ?? "").get("theater") === "1") store.setTheater(true);
    };
    read();
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

function TopBar({ inspectorOpen, onInspector, onHelp }: { inspectorOpen: boolean; onInspector: () => void; onHelp: () => void }) {
  const view = useSceneStore((s) => s.view);
  const store = useStore();
  return (
    <div className="flex h-full items-center gap-4 border-b border-line bg-canvas px-4">
      <Brand />
      <SimulationStamp />
      <span className="h-5 w-px shrink-0 bg-line" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <RunIdentity />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => store.setTheater(true)}
          aria-keyshortcuts="T"
          className="inline-flex h-8 items-center gap-1.5 rounded-sm px-2.5 text-body-sm text-ink-muted hover:bg-surface-sunken hover:text-ink [&_svg]:size-4"
          title="Theater Mode (T)"
        >
          <TvMinimalPlay aria-hidden="true" />
          Theater
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

export function Shell() {
  const store = useStore();
  const theater = useSceneStore((s) => s.theater);
  const view = useSceneStore((s) => s.view);
  const selection = useSceneStore((s) => s.selection);
  const wide = useMedia(WIDE);
  const [inspectorWanted, setInspectorWanted] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [timelineH, setTimelineH] = useState(() => (typeof window !== "undefined" ? Math.round(Math.min(320, Math.max(250, window.innerHeight * 0.3))) : 260));
  const [resizing, setResizing] = useState(false);
  const [help, setHelp] = useState(false);
  const helpRef = useRef(help);
  useEffect(() => {
    helpRef.current = help;
  }, [help]);

  useHashSync();

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
  const toggleInspector = useCallback(() => (wide ? setInspectorWanted((v) => !v) : setOverlayOpen((v) => !v)), [wide]);
  const commands = useMemo(
    () => ({
      toggleInspector,
      toggleTimeline: () => setTimelineCollapsed((v) => !v),
      openHelp: () => setHelp(true),
      modalOpen: () => helpRef.current,
    }),
    [toggleInspector],
  );
  useShellKeys(commands);

  const tl = timelineCollapsed ? COLLAPSED_TIMELINE : timelineH;
  const rows = theater ? `0px minmax(0,1fr) 0px` : `${TOP}px minmax(0,1fr) ${tl}px`;
  const cols = `minmax(0,1fr) ${!theater && wide && inspectorOpen ? INSPECTOR_W : 0}px`;

  // Resizing the timeline: drag its top edge, or arrow keys on the separator.
  const drag = useRef<{ y: number; h: number } | null>(null);
  const onResizeDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: timelineH };
    setResizing(true);
    if (timelineCollapsed) setTimelineCollapsed(false);
  };
  const clampH = (h: number) => Math.round(Math.max(140, Math.min(window.innerHeight * 0.62, h)));
  const onResizeMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    setTimelineH(clampH(drag.current.h + (drag.current.y - e.clientY)));
  };
  const onResizeUp = () => {
    drag.current = null;
    setResizing(false);
  };
  const onResizeKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowUp") setTimelineH((h) => clampH(h + 24));
    else if (e.key === "ArrowDown") setTimelineH((h) => clampH(h - 24));
    else if (e.key === "Enter") setTimelineCollapsed((v) => !v);
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
        <TopBar inspectorOpen={inspectorOpen} onInspector={toggleInspector} onHelp={() => setHelp(true)} />
      </header>

      <main id="stage" tabIndex={-1} aria-label={`${stageLabel} (simulation)`} className="relative min-h-0 min-w-0 overflow-hidden bg-factory-ground outline-none [grid-area:stage]">
        <Stage />
        {theater ? <TheaterOverlay /> : null}
      </main>

      <aside
        aria-label={selectionWord ? `Inspector: ${selectionWord}` : "Inspector: the run now"}
        inert={theater || !inspectorOpen}
        className={cn(
          "min-h-0 min-w-0 overflow-hidden border-line bg-surface [grid-area:inspector]",
          wide
            ? "border-l"
            : cn(
                "fixed bottom-0 right-0 z-30 w-[392px] border-l shadow-3 transition-transform duration-[var(--mach-duration-slow)] ease-enter",
                inspectorOpen && !theater ? "translate-x-0" : "translate-x-full",
              ),
        )}
        style={wide ? undefined : { top: theater ? 0 : TOP }}
      >
        <div className="h-full" style={{ width: INSPECTOR_W }}>
          <Inspector />
        </div>
      </aside>

      <section aria-label="Execution timeline" inert={theater} className="relative min-h-0 min-w-0 overflow-hidden border-t border-line bg-surface [grid-area:timeline]">
        <button
          type="button"
          aria-label="Resize the timeline: drag, or use the up and down arrows; Enter collapses it"
          title="Drag to resize the timeline"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          onKeyDown={onResizeKey}
          className="absolute inset-x-0 -top-px z-20 h-1.5 cursor-row-resize outline-none hover:bg-line-strong focus-visible:bg-focus"
        />
        <Timeline collapsed={timelineCollapsed} onCollapse={() => setTimelineCollapsed((v) => !v)} />
      </section>

      <Announcer />
      <HelpSheet open={help} onOpenChange={setHelp} />
    </div>
  );
}
