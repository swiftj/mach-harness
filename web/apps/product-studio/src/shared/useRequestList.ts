import { useCallback, useEffect, useState } from "react";
import { isMachApiError, MachApiError, type RequestsBlock } from "@mach/ui/api";
import { requestOp } from "../features/inbox/requests/api";

/**
 * The requests MACH knows about (`request.list`, which never calls GitHub), for every page that lists or offers them: the
 * Inbox, the project home and Shape's "Add an idea". Re-read after every write: nothing is assumed.
 */
export interface RequestList {
  data: RequestsBlock | null;
  error: MachApiError | null;
  loading: boolean;
  reload: () => void;
}

export function useRequestList(): RequestList {
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<{ tick: number; data: RequestsBlock | null; error: MachApiError | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    requestOp("request.list", {}, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSettled({ tick, data: result.requests, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({ tick, data: null, error: isMachApiError(error) ? error : new MachApiError("internal", String(error), "request.list") });
      });
    return () => controller.abort();
  }, [tick]);
  return {
    data: settled?.data ?? null,
    error: settled?.tick === tick ? settled.error : null,
    loading: settled?.tick !== tick,
    reload: useCallback(() => setTick((t) => t + 1), []),
  };
}
