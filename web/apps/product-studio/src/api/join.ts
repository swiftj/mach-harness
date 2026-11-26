/**
 * Bringing in the project someone else defined: the first thing the app does in a workspace with no project when the
 * repository is on GitHub (`project.join`). Nobody presses anything: the start screen starts it, a few slices at a time so
 * it can say how many have come, and the last batch is a whole refresh. Kept here, outside any screen, because the shared
 * status reloads after every batch (and so has a project after the first): the screen that shows progress stays up until
 * the last batch is in. What each batch said is kept, so nothing an earlier batch said is lost.
 */
import { useSyncExternalStore } from "react";
import { describeError, type ProjectJoin } from "@mach/ui/api";
import { client } from "./client";
import { asError, reloadStatus } from "./store";
import { JOIN_BATCH } from "../features/home/start/model";

export type JoinState =
  | { phase: "idle" }
  /** Reading GitHub, before anything is known. */
  | { phase: "looking" }
  /** Another window on this computer is bringing the project in: this one waits for it. */
  | { phase: "other_window" }
  /** Taking the project in: its name, and how many slices have come of how many. */
  | { phase: "bringing"; name: string; done: number; total: number }
  /** GitHub could not be read: the engine's own words, and what the person can do. Nothing here changed. */
  | { phase: "failed"; text: string; at: number }
  /** GitHub was read: there was nothing to bring in, or everything came. `said`: every batch's sentences, in order. */
  | { phase: "done"; result: ProjectJoin | null; said: string[] };

let state: JoinState = { phase: "idle" };
let anyway = false;
const listeners = new Set<() => void>();

function set(next: JoinState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

const OTHER_WINDOW_WAIT_MS = 3000;
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Bring the project in, batch by batch. Does nothing while a join is already running in this window. */
export async function startJoin(): Promise<void> {
  if (joining(state)) return;
  set({ phase: "looking" });
  let done = 0;
  let total = 0;
  const said: string[] = [];
  try {
    for (;;) {
      let result: ProjectJoin;
      try {
        result = await client.op("project.join", { batch: JOIN_BATCH });
      } catch (error) {
        const failure = asError(error);
        if (failure.kind === "conflict") {
          // Another window holds the project while it brings it in: wait for it, then carry on (it finds what came).
          set({ phase: "other_window" });
          await wait(OTHER_WINDOW_WAIT_MS);
          continue;
        }
        throw error;
      }
      for (const line of [...(result.warned ?? []), ...(result.not_taken ?? []).map((row) => row.reason)]) if (!said.includes(line)) said.push(line);
      if (!result.joined) {
        if (result.github.problem) set({ phase: "failed", text: result.note, at: Date.now() });
        else {
          await reloadStatus();
          set({ phase: "done", result, said });
        }
        return;
      }
      done += result.taken.slices.length + (result.updated?.length ?? 0);
      const remaining = result.remaining ?? 0;
      total = Math.max(total, done + remaining);
      set({ phase: "bringing", name: result.project?.name ?? "the project", done, total });
      if (remaining <= 0) {
        await reloadStatus();
        set({ phase: "done", result, said });
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
export function joining(join: JoinState): join is Extract<JoinState, { phase: "looking" | "bringing" | "other_window" }> {
  return join.phase === "looking" || join.phase === "bringing" || join.phase === "other_window";
}

/** The person said to start a product of their own while GitHub cannot be read (their word; the engine records it). */
export function chooseStartAnyway(): void {
  anyway = true;
  listeners.forEach((listener) => listener());
}

export function useStartAnyway(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => anyway,
    () => anyway,
  );
}
