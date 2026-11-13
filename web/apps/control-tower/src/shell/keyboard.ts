/**
 * The global keyboard map (M6_0_VISUAL_SPEC.md f.10), implemented once. The help sheet renders the
 * same table, so what is listed is what works.
 *
 * Keys the views own (marked `view`: the Atlas's and the Blueprint's arrows, Shift+arrows, + - 0,
 * Enter and Space on an entity, the Blueprint tree's Home, End, Alt+arrows and `*`, and the timeline's
 * playhead, tracks and resize edge) are listed for discovery but never handled here: each is bound in
 * the element that owns it (src/atlas, src/blueprint, src/shell/timeline, the resize edge in Shell.tsx),
 * which prevents the default so this map skips the event.
 */
import { useEffect } from "react";
import { showInTimeline, SPEEDS, useStore, type SceneStore } from "../scene";
import { indexFor, lastAtOrBefore } from "./history";

export interface ShellCommands {
  toggleInspector(): void;
  toggleTimeline(): void;
  openHelp(): void;
  /** Open the source menu. */
  openSource(): void;
  /** True while a dialog (the help sheet) owns the keyboard. */
  modalOpen(): boolean;
}

export interface KeyBinding {
  keys: string[];
  action: string;
  group: "Playback" | "Views" | "Panels" | "In a view" | "Atlas" | "Blueprint" | "Timeline" | "Timeline workspace";
  /** Handled by the views, listed for discovery only. */
  view?: true;
  /** Active only in this workspace (absent: in both). */
  workspace?: "floor" | "timeline";
}

/** What the Timeline workspace's keys ask of it (handled by its toolbar while it is up). */
export type TimelineKeyCommand = "grouping" | "filters" | "next-mark" | "previous-mark" | "zoom-selection" | "show-all";

let timelineKeys: ((command: TimelineKeyCommand) => boolean) | null = null;

/**
 * The Timeline workspace registers the handler for its keys while it is mounted (and the map routes
 * them only while the workspace is "timeline"). Returns the unregister function. Last one wins.
 */
export function registerTimelineKeys(handler: (command: TimelineKeyCommand) => boolean): () => void {
  timelineKeys = handler;
  return () => {
    if (timelineKeys === handler) timelineKeys = null;
  };
}

/** The Timeline workspace's own keys, free in the global map (test/timeline-shell.test.mjs holds that). */
export const TIMELINE_KEYS: Readonly<Record<string, TimelineKeyCommand>> = {
  g: "grouping",
  "/": "filters",
  n: "next-mark",
  p: "previous-mark",
  z: "zoom-selection",
  a: "show-all",
};

export const KEYMAP: KeyBinding[] = [
  { keys: ["Space"], action: "Play or pause", group: "Playback" },
  { keys: [",", "."], action: "Previous / next event", group: "Playback" },
  { keys: ["Shift+,", "Shift+."], action: "Back / forward 10 s of factory time", group: "Playback" },
  { keys: ["[", "]"], action: "Previous / next chapter (real history: previous / next landmark, such as a wave arriving or an execution ending)", group: "Playback" },
  { keys: ["{", "}"], action: "Slower / faster (real history: 5× to 160× real time; simulation: 0.5× to 16×)", group: "Playback" },
  { keys: ["Home", "End"], action: "Start of what is held / live edge (replay: its last event)", group: "Playback" },
  { keys: ["L"], action: "Return to live (and follow); live keeps arriving while you look back", group: "Playback" },
  { keys: ["1", "2"], action: "Factory floor: Atlas / Blueprint (from the Timeline too)", group: "Views" },
  { keys: ["3"], action: "Timeline, keeping the selection and the playhead (Show in Timeline)", group: "Views" },
  { keys: ["T"], action: "Theater Mode (Factory floor only; does nothing in the Timeline)", group: "Views" },
  { keys: ["F"], action: "Focus the selection (in the Timeline: reveal its tracks and span)", group: "Views" },
  { keys: ["Shift+F"], action: "Camera follow back on", group: "Views" },
  { keys: ["Escape"], action: "Clear highlight, then selection, then leave Theater Mode", group: "Views" },
  { keys: ["I"], action: "Show or hide the inspector", group: "Panels" },
  { keys: ["Shift+T"], action: "Expand or collapse the docked timeline (Factory floor)", group: "Panels", workspace: "floor" },
  { keys: ["?"], action: "This list", group: "Panels" },
  { keys: ["S"], action: "Choose the source: Live Factory, Historical replay or Simulation", group: "Panels" },
  { keys: ["+", "-", "0"], action: "Zoom in / out / fit", group: "In a view", view: true },
  { keys: ["Shift+Arrows"], action: "Pan", group: "In a view", view: true },
  { keys: ["Enter", "Space"], action: "Select the focused entity", group: "In a view", view: true },
  { keys: ["Arrows"], action: "Move to the nearest entity in that direction on screen", group: "Atlas", view: true },
  { keys: ["↑", "↓"], action: "Previous / next visible item", group: "Blueprint", view: true },
  { keys: ["→"], action: "Open the item, or move into it", group: "Blueprint", view: true },
  { keys: ["←"], action: "Close the item, or move out to its parent", group: "Blueprint", view: true },
  { keys: ["Alt+→", "Alt+←"], action: "Open / close without moving", group: "Blueprint", view: true },
  { keys: ["Home", "End"], action: "First / last item", group: "Blueprint", view: true },
  { keys: ["*"], action: "Open every sibling of the focused item (on a lane: every lane of the wave)", group: "Blueprint", view: true },
  { keys: ["←", "→"], action: "Previous / next event (playhead or tracks focused)", group: "Timeline", view: true },
  { keys: ["PageUp", "PageDown"], action: "Previous / next chapter or landmark (playhead focused)", group: "Timeline", view: true },
  { keys: ["↑", "↓"], action: "Previous / next track (tracks focused)", group: "Timeline", view: true },
  { keys: ["Enter"], action: "Select the focused track's entity", group: "Timeline", view: true },
  { keys: ["Alt+→", "Alt+←"], action: "Expand / collapse the focused track (* also expands)", group: "Timeline", view: true },
  { keys: ["+", "-", "0"], action: "Narrow / widen the time window, or show the whole run (tracks focused)", group: "Timeline", view: true },
  { keys: ["↑", "↓"], action: "Taller / shorter timeline (its top edge focused; Enter collapses or restores it)", group: "Timeline", view: true },
  { keys: ["G"], action: "Group by product or by execution", group: "Timeline workspace", workspace: "timeline" },
  { keys: ["/"], action: "Filters", group: "Timeline workspace", workspace: "timeline" },
  { keys: ["N", "P"], action: "Next / previous mark of the kind last jumped to (failure at first)", group: "Timeline workspace", workspace: "timeline" },
  { keys: ["Z"], action: "Zoom to the selection", group: "Timeline workspace", workspace: "timeline" },
  { keys: ["A"], action: "Show all of the history held", group: "Timeline workspace", workspace: "timeline" },
];

const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;

/** Elements where Space and Enter belong to the element itself. */
function ownsActivation(target: HTMLElement | null): boolean {
  if (!target) return false;
  if (TYPING.test(target.tagName) || target.isContentEditable) return true;
  if (target.tagName === "BUTTON" || target.tagName === "A") return true;
  const role = target.getAttribute("role");
  return role === "button" || role === "radio" || role === "slider" || role === "checkbox" || role === "menuitem" || role === "tab";
}

/**
 * Step by chapter (the simulation's storyboard) or, for real history, by landmark: a real moment
 * such as a wave arriving, the Factory enabled or paused, an execution starting or ending, a verdict,
 * a person needed or approving. Never past the live edge.
 */
export function stepChapter(store: SceneStore, direction: 1 | -1): void {
  const state = store.getState();
  const { playhead } = state;
  const index = indexFor(state);
  const marks = index.landmarks;
  const go = (mark: { id: string; t: number } | undefined) => {
    if (!mark) return;
    if (index.storyboard) store.seekToChapter(mark.id);
    else store.seek(mark.t);
  };
  if (direction > 0) {
    go(marks.find((c) => c.t > playhead + 1 && c.t <= state.liveAt + (state.source === "simulation" ? Infinity : 0)));
    return;
  }
  // Back: to the start of the current one, or the one before when already at its start.
  const current = lastAtOrBefore(marks, playhead);
  const at = current ? marks.indexOf(current) : 0;
  go(current && playhead - current.t > 1500 ? current : marks[Math.max(0, at - 1)]);
}

/**
 * Space and the play button. Live at the edge, "pause" holds the view on the moment shown (a replay
 * of what was received; ingest goes on, and nothing in the Control Tower can pause the Factory);
 * playing from there runs towards the edge and re-attaches when it gets there. Otherwise play or pause.
 */
export function togglePlayback(store: SceneStore): void {
  const s = store.getState();
  if (s.source === "live" && s.following) {
    store.seek(s.playhead - 1);
    store.pause();
    return;
  }
  store.toggle();
}

export function stepSpeed(store: SceneStore, direction: 1 | -1): void {
  const i = SPEEDS.indexOf(store.getState().speed);
  const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + direction))];
  if (next !== undefined) store.setSpeed(next);
}

/** Move the playhead by factory time; playback keeps its state. */
export function nudge(store: SceneStore, ms: number): void {
  store.seek(store.getState().playhead + ms);
}

/** Install the global map. One listener on window, in the bubble phase so the views' own handlers run first. */
export function useShellKeys(commands: ShellCommands): void {
  const store = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (TYPING.test(target.tagName) || target.isContentEditable)) return;
      if (commands.modalOpen()) return;
      const s = store.getState();
      const inTimeline = s.workspace === "timeline";
      if (inTimeline && !e.altKey && Object.hasOwn(TIMELINE_KEYS, e.key)) {
        const command = TIMELINE_KEYS[e.key] as TimelineKeyCommand;
        if (timelineKeys?.(command)) e.preventDefault();
        return;
      }
      // Shift with , and . is < and > on most layouts; some report the unshifted key.
      const key = e.shiftKey && e.key === "," ? "<" : e.shiftKey && e.key === "." ? ">" : e.key;
      let handled = true;
      switch (key) {
        case " ":
          if (ownsActivation(target) || e.altKey) handled = false;
          else togglePlayback(store);
          break;
        case ",":
          store.stepPrevious();
          break;
        case ".":
          store.stepNext();
          break;
        case "<":
          nudge(store, -10_000);
          break;
        case ">":
          nudge(store, 10_000);
          break;
        case "[":
          stepChapter(store, -1);
          break;
        case "]":
          stepChapter(store, 1);
          break;
        case "{":
          stepSpeed(store, -1);
          break;
        case "}":
          stepSpeed(store, 1);
          break;
        case "Home":
          if (ownsActivation(target) && target?.getAttribute("role") === "slider") handled = false;
          else store.seek(s.extent.start);
          break;
        case "End":
          if (ownsActivation(target) && target?.getAttribute("role") === "slider") handled = false;
          else store.followLive();
          break;
        case "l":
        case "L":
          store.followLive();
          break;
        case "1":
          store.setView("atlas");
          store.setWorkspace("floor");
          break;
        case "2":
          store.setView("blueprint");
          store.setWorkspace("floor");
          break;
        case "3":
          showInTimeline(store);
          break;
        case "t":
          // Theater Mode is the floor's; in the Timeline the key does nothing (and says so in the help).
          if (inTimeline) handled = false;
          else store.setTheater(!s.theater);
          break;
        case "T":
          if (inTimeline) handled = false;
          else commands.toggleTimeline();
          break;
        case "f":
          if (s.selection) store.focusOn(s.selection, "api");
          else store.focusOn("overview", "api");
          break;
        case "F":
          store.setFollow(true);
          break;
        case "i":
        case "I":
          commands.toggleInspector();
          break;
        case "?":
          commands.openHelp();
          break;
        case "s":
        case "S":
          commands.openSource();
          break;
        case "Escape":
          if (s.hovered) store.hover(null);
          else if (s.selection) store.select(null);
          else if (s.theater) store.setTheater(false);
          else handled = false;
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commands, store]);
  useFocusKeeper();
}

/**
 * The keyboard home of the workspace on screen: the active Factory Floor view's canvas, or the
 * Timeline's tracks. The hidden workspace is inert, so its canvas is skipped.
 */
export function activeCanvas(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>("[data-stage-active] [tabindex='0'], [data-timeline-workspace] [tabindex='0']")) {
    if (!el.closest("[inert]")) return el;
  }
  return null;
}

/**
 * Keep focus in its region when a key removes what had it (Escape clears the selection the inspector
 * showed; a view re-renders an entity) or makes its region inert (Theater Mode): instead of falling to
 * the page, focus goes to the inspector's heading, the view's canvas, or the stage. Browsers fire no
 * blur when a focused node is removed, so this looks after every key, in the capture phase.
 */
function useFocusKeeper(): void {
  useEffect(() => {
    const onKey = () => {
      const had = document.activeElement as HTMLElement | null;
      if (!had || had === document.body) return;
      const home = had.closest<HTMLElement>("aside, main, section, header");
      requestAnimationFrame(() => {
        const now = document.activeElement;
        const stranded = !now || now === document.body || Boolean((now as HTMLElement).closest?.("[inert]"));
        if (!stranded || (had.isConnected && !had.closest("[inert]"))) return;
        const live = home && home.isConnected && !home.closest("[inert]") ? home : null;
        const canvas = activeCanvas();
        const next = live?.querySelector<HTMLElement>("[data-inspector-heading]") ?? (live?.tagName === "MAIN" ? canvas : null) ?? live ?? canvas ?? document.getElementById("stage");
        next?.focus({ preventScroll: true });
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
