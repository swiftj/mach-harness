/**
 * The global keyboard map, implemented once. The help sheet renders the same table, so what is listed
 * is what works.
 *
 * Keys the views own (marked `view`: the Line's rows, the Atlas's arrows, Shift+arrows, + - 0, Enter
 * and Space on an entity) are listed for discovery but never handled here: each is bound in the
 * element that owns it (src/line, src/atlas), which prevents the default so this map skips the event.
 */
import { useEffect } from "react";
import { showDecisions, showInAnalytics, showOnFloor, showOnLine, useStore, type SceneStore, type Workspace } from "../scene";

export interface ShellCommands {
  toggleInspector(): void;
  openHelp(): void;
  /** Open the source menu. */
  openSource(): void;
  /** True while a dialog (the help sheet, the evidence player, a ticket's full record) owns the keyboard. */
  modalOpen(): boolean;
}

export interface KeyBinding {
  keys: string[];
  action: string;
  group: "Workspaces" | "Panels" | "Line" | "Floor";
  /** Handled by the views, listed for discovery only. */
  view?: true;
  /** Active only in this workspace, or these workspaces (absent: in every one). */
  workspace?: Workspace | readonly Workspace[];
}

/** Whether a binding is active while `workspace` is up. */
export function activeIn(binding: Pick<KeyBinding, "workspace">, workspace: Workspace): boolean {
  const w = binding.workspace;
  return w === undefined || (typeof w === "string" ? w === workspace : w.includes(workspace));
}

/** The workspaces with the inspector: the Line has its own side panel. */
const WITH_INSPECTOR: readonly Workspace[] = ["floor", "analytics"];

export const KEYMAP: KeyBinding[] = [
  { keys: ["1"], action: "Line: the stations left to right, a row for each ticket", group: "Workspaces" },
  { keys: ["2"], action: "Floor: the Factory Atlas, keeping the selection", group: "Workspaces" },
  { keys: ["3"], action: "Analytics, keeping the selection", group: "Workspaces" },
  { keys: ["4"], action: "Decisions: the architecture decisions in force", group: "Workspaces" },
  { keys: ["Escape"], action: "Clear the highlight, then the selection, then leave Theater Mode", group: "Workspaces" },
  { keys: ["I"], action: "Show or hide the inspector (Floor and Analytics)", group: "Panels", workspace: WITH_INSPECTOR },
  { keys: ["?"], action: "This list", group: "Panels" },
  { keys: ["S"], action: "Choose the source: Live Factory or Simulation", group: "Panels" },
  // M6.4: the evidence player's own keys, handled inside its panel (which owns the keyboard while open).
  { keys: [",", "."], action: "Evidence player: previous / next file", group: "Panels", view: true },
  { keys: ["[", "]"], action: "Evidence player: previous / next check", group: "Panels", view: true },
  { keys: ["Escape"], action: "Decisions: from one decision back to the list", group: "Panels", view: true, workspace: "decisions" },
  { keys: ["↑", "↓"], action: "Previous / next ticket", group: "Line", view: true },
  { keys: ["Space"], action: "Show the focused ticket or station in the side panel", group: "Line", view: true },
  { keys: ["Enter"], action: "Open the focused ticket's full record (double-click does the same)", group: "Line", view: true },
  { keys: ["T"], action: "Theater Mode", group: "Floor", workspace: "floor" },
  { keys: ["F"], action: "Frame the selection", group: "Floor", workspace: "floor" },
  { keys: ["Shift+F"], action: "Camera follow back on", group: "Floor", workspace: "floor" },
  { keys: ["+", "-", "0"], action: "Zoom in / out / fit", group: "Floor", view: true },
  { keys: ["Shift+Arrows"], action: "Pan", group: "Floor", view: true },
  { keys: ["Enter", "Space"], action: "Select the focused entity", group: "Floor", view: true },
  { keys: ["Arrows"], action: "Move to the nearest entity in that direction on screen", group: "Floor", view: true },
];

const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * The global map's keydown handler (no React, no window: the hook installs it; tests drive it with
 * plain event objects). It reads the store at each key, so one handler serves every workspace.
 */
export function shellKeyHandler(store: SceneStore, commands: ShellCommands): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typeof e.key !== "string") return;
    // M6.6: a keydown dispatched at the document (or any non-element) has no attributes to read.
    const raw = e.target as HTMLElement | null;
    const target = raw && typeof raw.getAttribute === "function" ? raw : null;
    if (target && (TYPING.test(target.tagName) || target.isContentEditable)) return;
    if (commands.modalOpen()) return;
    const s = store.getState();
    const onFloor = s.workspace === "floor";
    let handled = true;
    switch (e.key) {
      case "1":
        showOnLine(store);
        break;
      case "2":
        showOnFloor(store);
        break;
      case "3":
        showInAnalytics(store);
        break;
      case "4":
        showDecisions(store);
        break;
      case "t":
        // Theater Mode is the Floor's; elsewhere the key does nothing (and says so in the help).
        if (!onFloor) handled = false;
        else store.setTheater(!s.theater);
        break;
      case "f":
        if (!onFloor) handled = false;
        else store.focusOn(s.selection ?? "overview", "api");
        break;
      case "F":
        if (!onFloor) handled = false;
        else store.setFollow(true);
        break;
      case "i":
      case "I":
        if (!WITH_INSPECTOR.includes(s.workspace)) handled = false;
        else commands.toggleInspector();
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
}

/** Install the global map. One listener on window, in the bubble phase so the views' own handlers run first. */
export function useShellKeys(commands: ShellCommands): void {
  const store = useStore();
  useEffect(() => {
    const onKey = shellKeyHandler(store, commands);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commands, store]);
  useFocusKeeper();
}

/**
 * The keyboard home of the workspace on screen: the Line's board, the Atlas's canvas,
 * or Analytics' sheet (its `[data-analytics-home]`, else the workspace itself). The hidden workspace
 * is inert, so its canvas is skipped.
 */
export function activeCanvas(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>("[data-analytics-workspace] [data-analytics-home], [data-analytics-workspace]")) {
    if (!el.closest("[inert]")) return el;
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-decisions-home]")) {
    if (!el.closest("[inert]")) return el;
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-line-home], [data-stage-active] [tabindex='0']")) {
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
