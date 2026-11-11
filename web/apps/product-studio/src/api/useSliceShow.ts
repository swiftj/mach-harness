import { useCallback, useEffect, useState } from "react";
import type { MachApiError, SliceShow } from "@mach/ui/api";
import { client } from "./client";
import { toApiError } from "./session";

export interface SliceShowState {
  data: SliceShow | null;
  error: MachApiError | null;
  /** True while a read is in flight. Earlier data stays visible meanwhile. */
  loading: boolean;
  reload: () => void;
  /** Replace the data's check with a newer result (after an approval, a reopen). */
  replaceCheck: (check: SliceShow["check"]) => void;
}

/**
 * Reads `slice.show` for one slice; `reload()` reads it again (after draft_changed, a write, an act).
 * Earlier data stays visible while a newer read is in flight. Mount one per slice (key by slice ID).
 */
export function useSliceShow(sliceId: string): SliceShowState {
  const [tick, setTick] = useState(0);
  const request = `${sliceId} ${tick}`;
  const [settled, setSettled] = useState<{ request: string; data: SliceShow | null; error: MachApiError | null } | null>(null);
  const [override, setOverride] = useState<{ request: string; check: SliceShow["check"] } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client
      .op("slice.show", { slice_id: sliceId }, controller.signal)
      .then((data) => setSettled({ request, data, error: null }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setSettled((previous) => ({ request, data: previous?.data ?? null, error: toApiError(cause, "slice.show") }));
      });
    return () => controller.abort();
  }, [sliceId, request]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = settled?.data ?? null;
  const replaceCheck = useCallback((check: SliceShow["check"]) => setOverride({ request, check }), [request]);
  const data = current && override && override.request === settled?.request ? { ...current, check: override.check } : current;
  return {
    data,
    error: settled?.request === request ? settled.error : null,
    loading: settled?.request !== request,
    reload,
    replaceCheck,
  };
}
