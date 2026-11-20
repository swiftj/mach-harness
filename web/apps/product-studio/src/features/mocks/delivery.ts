import { useSyncExternalStore } from "react";
import type { MocksToCommit, SliceReady } from "@mach/ui/api";

/**
 * The engine's answer about a slice's pictures after "Mark ready to build" (`slice.ready` `mocks`),
 * kept in this window's memory only (never in browser storage) so the Design mocks tab can show the
 * engine's own folder and note. No read operation returns it again: Studio does not check whether
 * the pictures were committed (M14_DESIGN_MOCKS.md, "Not built").
 *
 * Named for promotion: whatever runs `slice.ready` (features/spec/SliceActs.tsx today) should call
 * `rememberReadyAnswer(result)`. Until it does, the tab shows the waiting state from the slice's
 * own record, without the folder.
 */
const answers = new Map<string, MocksToCommit>();
const listeners = new Set<() => void>();

export function rememberReadyAnswer(result: SliceReady): void {
  const id = result.slice.slice_id;
  const mocks = result.saved_to === "github" ? result.mocks : null;
  if (mocks) answers.set(id, mocks);
  else answers.delete(id);
  listeners.forEach((listener) => listener());
}

/** Forget the answer, for instance after the slice was reopened. */
export function forgetReadyAnswer(sliceId: string): void {
  if (answers.delete(sliceId)) listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The answer kept for a slice, or null. */
export function readyAnswer(sliceId: string): MocksToCommit | null {
  return answers.get(sliceId) ?? null;
}

export function useReadyAnswer(sliceId: string): MocksToCommit | null {
  return useSyncExternalStore(subscribe, () => readyAnswer(sliceId));
}
