/**
 * Selecting a lens figure follows the tracks' rule (X13, round 6 defect 14): a click or a first Enter
 * selects (and brings the rows into view) without moving the playhead; Enter again on the same figure,
 * or the second click of a double-click, while what it selected is still the selection, is "go to" and
 * seeks. The decision is the workspace's own `activation`; this only remembers the band's last figure.
 */
import { activation, type Activated } from "../controls/frame";
import type { SelectGesture } from "../contract";

export interface LensGesture {
  /** Whether activating figure `key` this way is "go to" (seek); records it otherwise. */
  decide(key: string, how: SelectGesture): boolean;
  /** After a select: the selection it made, which a second activation must still find. */
  settle(): void;
}

export function lensGesture(selection: () => string | null): LensGesture {
  let last: Activated | null = null;
  let pending: string | null = null;
  return {
    decide(key, how) {
      if (activation(last, key, selection(), how) === "seek") {
        last = null;
        pending = null;
        return true;
      }
      pending = key;
      last = { key, selection: selection() };
      return false;
    },
    settle() {
      if (pending !== null) last = { key: pending, selection: selection() };
      pending = null;
    },
  };
}
