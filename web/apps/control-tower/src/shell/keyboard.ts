/**
 * The global keyboard map (M6_0_VISUAL_SPEC.md f.10), implemented once. The help sheet renders the
 * same table, so what is listed is what works.
 *
 * Keys the views own (arrows, Shift+arrows, + - 0, Tab, Enter on an entity, Alt+arrows) are listed
 * for discovery but never handled here, so the views receive them untouched.
 */
import { useEffect } from "react";
import { chapterAt, SCENARIO } from "../sim";
import { SPEEDS, useStore, type SceneStore } from "../scene";

export interface ShellCommands {
  toggleInspector(): void;
  toggleTimeline(): void;
  openHelp(): void;
  /** True while a dialog (the help sheet) owns the keyboard. */
  modalOpen(): boolean;
}

export interface KeyBinding {
  keys: string[];
  action: string;
  group: "Playback" | "Views" | "Panels" | "In a view";
  /** Handled by the views, listed for discovery only. */
  view?: true;
}

export const KEYMAP: KeyBinding[] = [
  { keys: ["Space"], action: "Play or pause", group: "Playback" },
  { keys: [",", "."], action: "Previous / next event", group: "Playback" },
  { keys: ["Shift+,", "Shift+."], action: "Back / forward 10 s of factory time", group: "Playback" },
  { keys: ["[", "]"], action: "Previous / next chapter", group: "Playback" },
  { keys: ["{", "}"], action: "Slower / faster (0.5× to 16×)", group: "Playback" },
  { keys: ["Home", "End"], action: "Start of the run / live edge", group: "Playback" },
  { keys: ["L"], action: "Return to live (and follow)", group: "Playback" },
  { keys: ["1", "2"], action: "Factory Atlas / Execution Blueprint", group: "Views" },
  { keys: ["T"], action: "Theater Mode", group: "Views" },
  { keys: ["F"], action: "Focus the selection", group: "Views" },
  { keys: ["Shift+F"], action: "Camera follow back on", group: "Views" },
  { keys: ["Escape"], action: "Clear highlight, then selection, then leave Theater Mode", group: "Views" },
  { keys: ["I"], action: "Show or hide the inspector", group: "Panels" },
  { keys: ["Shift+T"], action: "Expand or collapse the timeline", group: "Panels" },
  { keys: ["?"], action: "This list", group: "Panels" },
  { keys: ["+", "-", "0"], action: "Zoom in / out / fit", group: "In a view", view: true },
  { keys: ["Shift+Arrows"], action: "Pan", group: "In a view", view: true },
  { keys: ["Arrows"], action: "Move to the neighbouring entity", group: "In a view", view: true },
  { keys: ["Enter"], action: "Select the focused entity", group: "In a view", view: true },
  { keys: ["Alt+→", "Alt+←"], action: "Expand / collapse a lane (Blueprint)", group: "In a view", view: true },
  { keys: ["←", "→"], action: "Previous / next event (timeline tracks focused)", group: "In a view", view: true },
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

export function stepChapter(store: SceneStore, direction: 1 | -1): void {
  const { playhead } = store.getState();
  const chapters = SCENARIO.chapters;
  if (direction > 0) {
    const next = chapters.find((c) => c.t > playhead + 1);
    if (next) store.seekToChapter(next.id);
    return;
  }
  // Back: to the start of the current chapter, or the one before when already at its start.
  const current = chapterAt(SCENARIO, playhead);
  const index = current ? chapters.indexOf(current) : 0;
  const target = current && playhead - current.t > 1500 ? current : chapters[Math.max(0, index - 1)];
  if (target) store.seekToChapter(target.id);
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
      // Shift with , and . is < and > on most layouts; some report the unshifted key.
      const key = e.shiftKey && e.key === "," ? "<" : e.shiftKey && e.key === "." ? ">" : e.key;
      let handled = true;
      switch (key) {
        case " ":
          if (ownsActivation(target) || e.altKey) handled = false;
          else store.toggle();
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
          else store.seek(0);
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
          break;
        case "2":
          store.setView("blueprint");
          break;
        case "t":
          store.setTheater(!s.theater);
          break;
        case "T":
          commands.toggleTimeline();
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
}
