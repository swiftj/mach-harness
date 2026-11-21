/**
 * Technical needs' shared reads (M17, shell-owned). Each is one engine read through the typed client; an act is
 * `client.op(...)` (or the act helper) from the screen's own event handler, then `reload()`. Every act on the needs
 * or a design is a person's button, confirmed in a dialog (personalActs), and answers `conflict` while the needs
 * conversation is writing.
 *
 *   useNeedList()          need.list: the needs, each kind with its question, unanswered kinds, where they are
 *                          published, unpublished changes, and (read only) the ADRs behind a need
 *   useNeedsStatus()       status.needs and status.designs: the same facts the project home sees, reloaded together
 *   useDesignList()        design.list: the designs brought in, one summary each
 *   useDesignShow(id)      design.show: the text (fenced as data), the topics to map, the map and its conflicts
 */
import type { DesignSummary, NeedsBlock } from "@mach/ui/api";
import { useStatus } from "../../../api/store";
import { useOperation } from "../../../api/useOperation";
import { DESIGN_ID } from "./paths";

export const useNeedList = () => useOperation("need.list", {});

export const useDesignList = () => useOperation("design.list", {});

/** design.show for one design; skipped (no call) for an ID that is not DES-NN, which `valid` then says. */
export function useDesignShow(designId: string | null | undefined, lines?: string) {
  const valid = Boolean(designId && DESIGN_ID.test(designId));
  const state = useOperation("design.show", valid ? { design_id: designId as string, ...(lines ? { lines } : {}) } : null);
  return { ...state, valid };
}

export interface NeedsStatus {
  /** Null for a project that never opened Technical needs. */
  needs: NeedsBlock | null;
  /** Empty when no design was brought in. */
  designs: DesignSummary[];
  loading: boolean;
  error: ReturnType<typeof useStatus>["error"];
  reload: () => void;
}

export function useNeedsStatus(): NeedsStatus {
  const status = useStatus();
  return {
    needs: status.data?.needs ?? null,
    designs: status.data?.designs ?? [],
    loading: !status.data && !status.error,
    error: status.error,
    reload: () => void status.reload(),
  };
}
