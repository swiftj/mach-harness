/**
 * M20: what naming the product leaves to say after the page has moved on. Naming it reloads the shared status, and the
 * form that asked is gone at once (the start screen becomes the project home), so a toast alone could be missed: when
 * MACH took the project already on GitHub instead of the person's words, or could not check GitHub, the note is kept
 * here for this browser session until the person closes it (sessionStorage, guarded; a module copy when storage is
 * blocked).
 */
import { useSyncExternalStore } from "react";
import type { ProjectStartNote } from "../shared/team";

const KEY = "mach.project-start-note";
let memory: ProjectStartNote | null = null;
const listeners = new Set<() => void>();

function read(): ProjectStartNote | null {
  try {
    const stored = window.sessionStorage.getItem(KEY);
    if (stored) return JSON.parse(stored) as ProjectStartNote;
  } catch {
    // fall through to the module copy
  }
  return memory;
}

let snapshot: ProjectStartNote | null = null;
let loaded = false;

function current(): ProjectStartNote | null {
  if (!loaded) {
    snapshot = read();
    loaded = true;
  }
  return snapshot;
}

function set(note: ProjectStartNote | null): void {
  memory = note;
  snapshot = note;
  loaded = true;
  try {
    if (note) window.sessionStorage.setItem(KEY, JSON.stringify(note));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the module copy lasts for this page.
  }
  listeners.forEach((listener) => listener());
}

export function rememberProjectStart(note: ProjectStartNote | null): void {
  if (note) set(note);
}

export function forgetProjectStart(): void {
  set(null);
}

export function useProjectStartNote(): ProjectStartNote | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current,
    () => null,
  );
}
