/**
 * What the shell knows about where its scenes come from, beyond the store: why this source was
 * chosen, whether an observer answered, and how to switch to
 * another source (a new store; the URL keeps the choice). Provided by App.tsx. The store's own
 * `source` and every scene's `provenance` remain the authority for labelling what is drawn.
 */
import { createContext, useContext, useMemo } from "react";
import { indexFor, type HistoryIndex } from "../history";
import { useSceneStore } from "../../scene";
import type { SourceChoice } from "./boot";

export type ObserverPresence = "answered" | "none" | "no-session";

export interface SourceInfo {
  /** What the person asked for (URL or menu), before the observer answered. */
  readonly requested: SourceChoice | null;
  /** Whether an observer answered at start-up (and, live, whether it still knows this browser). */
  readonly observer: ObserverPresence;
  /** A sentence the shell shows when the source is not what the page would normally show. */
  readonly notice: string | null;
  /** The observer's project folder name, when it said. */
  readonly project: string | null;
  /** Switch to another source: a new store; selection and view carry over through the address. */
  readonly switchTo: (choice: SourceChoice) => void;
}

const FALLBACK: SourceInfo = {
  requested: null,
  observer: "none",
  notice: null,
  project: null,
  switchTo: () => undefined,
};

export const SourceContext = createContext<SourceInfo>(FALLBACK);

export function useSource(): SourceInfo {
  return useContext(SourceContext);
}

/** The history's moments, landmarks and Factory marks, kept up to date as events arrive. */
export function useHistoryIndex(): HistoryIndex {
  return useSceneStore(indexFor);
}

/** The value for the provider, stable while its parts are. */
export function useSourceInfo(info: SourceInfo): SourceInfo {
  const { requested, observer, notice, project, switchTo } = info;
  return useMemo(() => ({ requested, observer, notice, project, switchTo }), [requested, observer, notice, project, switchTo]);
}
