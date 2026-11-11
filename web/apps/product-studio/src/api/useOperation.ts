import { useCallback, useEffect, useState } from "react";
import { isMachApiError, MachApiError, type OperationArgs, type OperationName, type OperationResult } from "@mach/ui/api";
import { client } from "./client";

export interface OperationState<K extends OperationName> {
  data: OperationResult<K> | null;
  error: MachApiError | null;
  /** True until the reply for the current arguments has arrived. Earlier data stays visible meanwhile. */
  loading: boolean;
  /** Run it again (after a change, or from a "Try again" button). */
  reload: () => void;
}

interface Settled<K extends OperationName> {
  request: string;
  data: OperationResult<K> | null;
  error: MachApiError | null;
}

/**
 * Runs a read operation (status, slice.show, feedback...) and re-runs it when its arguments change.
 * For operations that change state, call `client.op(...)` from the event handler, then `reload()`.
 */
export function useOperation<K extends OperationName>(name: K, args: OperationArgs<K>): OperationState<K> {
  const [tick, setTick] = useState(0);
  const argsJson = JSON.stringify(args);
  const request = `${name} ${argsJson} ${tick}`;
  const [settled, setSettled] = useState<Settled<K> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client
      .op(name, JSON.parse(argsJson) as OperationArgs<K>, controller.signal)
      .then((data) => setSettled({ request, data, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({ request, data: null, error: isMachApiError(error) ? error : new MachApiError("internal", String(error), name) });
      });
    return () => controller.abort();
  }, [name, argsJson, request]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return {
    data: settled?.data ?? null,
    error: settled?.request === request ? settled.error : null,
    loading: settled?.request !== request,
    reload,
  };
}
