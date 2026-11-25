/**
 * Bringing in the project someone else defined: the first thing the app does in a workspace with no project when the
 * repository is on GitHub (`project.join`). Nobody presses anything: the start screen starts it, a few slices at a time so
 * it can say how many have come, and the last batch is a whole refresh. Kept here, outside any screen, because the shared
 * status reloads after every batch (and so has a project after the first): the screen that shows progress stays up until
 * the last batch is in.
 */
import { useSyncExternalStore } from "react";
import { describeError, type ProjectJoin } from "@mach/ui/api";
import { client } from "./client";
import { asError, reloadStatus } from "./store";
import { rememberProjectStart } from "./projectStart";
import { JOIN_BATCH } from "../features/home/start/model";

export type JoinState =
  | { phase: "idle" }
  /** Reading GitHub, before anything is known. */
  | { phase: "looking" }
  /** Taking the project in: its name, and how many slices have come of how many. */
  | { phase: "bringing"; name: string; done: number; total: number }
  /** GitHub could not be read: the engine's own words. Nothing here changed. */
  | { phase: "failed"; text: string; at: number }
  /** GitHub was read: there was nothing to bring in, or everything came. */
  | { phase: "done"; result: ProjectJoin | null };

let state: JoinState = { phase: "idle" };
const listeners = new Set<() => void>();

function set(next: JoinState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

/** Bring the project in, batch by batch. Does nothing while a join is already running. */
export async function startJoin(): Promise<void> {
  if (joining(state)) return;
  set({ phase: "looking" });
  let done = 0;
  try {
    for (;;) {
      const result = await client.op("project.join", { batch: JOIN_BATCH });
      if (!result.joined) {
        if (result.github.problem) {
          set({ phase: "failed", text: result.note, at: Date.now() });
        } else {
          await reloadStatus();
          set({ phase: "done", result });
        }
        return;
      }
      if (result.taken.project) {
        // Said once on the project home, until closed: what came, and what exists only on the author's computer.
        rememberProjectStart({ kind: "joined", note: (result.in_words ?? [result.note]).join(" "), issue: result.project?.issue ?? null, url: result.project?.url ?? null });
      }
      done += result.taken.slices.length + (result.updated?.length ?? 0);
      const remaining = result.remaining ?? 0;
      set({ phase: "bringing", name: result.project?.name ?? "the project", done, total: done + remaining });
      if (remaining <= 0) {
        await reloadStatus();
        set({ phase: "done", result });
        return;
      }
    }
  } catch (error) {
    set({ phase: "failed", text: describeError(asError(error)).message, at: Date.now() });
  }
}

export function useJoin(): JoinState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

/** Whether the screen that shows progress stays up, whatever the shared status says meanwhile. */
export function joining(join: JoinState): join is Extract<JoinState, { phase: "looking" | "bringing" }> {
  return join.phase === "looking" || join.phase === "bringing";
}
