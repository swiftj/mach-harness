import { useCallback, useEffect, useState } from "react";
import { isMachApiError, MachApiError, type OperationArgs, type OperationName, type OperationResult } from "@mach/ui/api";
import { client } from "../../../api/client";

/**
 * The delivery screens' one way to call the engine. In production it is `client.op` unchanged.
 *
 * Under `vite --mode fixtures` it first asks the dev-only scenario layer (./dev/scenarios), which
 * lets a URL pick the fixture for operations the shared fixture transport cannot select
 * (?refresh=refresh.offline&feedback=feedback.changes-requested ...). Vite replaces
 * import.meta.env.MODE at build time, so the production bundle contains none of it.
 * PROMOTION CANDIDATE: the shared transport could take a per-operation `?op.<name>=` selector instead.
 */
export async function deliveryOp<K extends OperationName>(name: K, args: OperationArgs<K>, signal?: AbortSignal): Promise<OperationResult<K>> {
  if (import.meta.env.MODE === "fixtures") {
    const { scenarioOp } = await import("./dev/scenarios");
    const answered = await scenarioOp(name, args);
    if (answered !== undefined) {
      if (answered instanceof MachApiError) throw answered;
      return answered as OperationResult<K>;
    }
  }
  return client.op(name, args, signal);
}

export interface DeliveryRead<K extends OperationName> {
  data: OperationResult<K> | null;
  error: MachApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * A read operation (status, feedback, send.preview, slice.show), re-run when its arguments change.
 * Pass `null` as args to skip the call. Same contract as the app's useOperation, through deliveryOp.
 * PROMOTION CANDIDATE: identical to src/api/useOperation once the transport can select scenarios.
 */
export function useDeliveryRead<K extends OperationName>(name: K, args: OperationArgs<K> | null): DeliveryRead<K> {
  const [tick, setTick] = useState(0);
  const argsJson = args === null ? null : JSON.stringify(args);
  const request = `${name} ${argsJson} ${tick}`;
  const [settled, setSettled] = useState<{ request: string; data: OperationResult<K> | null; error: MachApiError | null } | null>(null);

  useEffect(() => {
    if (argsJson === null) return;
    const controller = new AbortController();
    deliveryOp(name, JSON.parse(argsJson) as OperationArgs<K>, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setSettled({ request, data, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({ request, data: null, error: isMachApiError(error) ? error : new MachApiError("internal", String(error), name) });
      });
    return () => controller.abort();
  }, [name, argsJson, request]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  if (argsJson === null) return { data: null, error: null, loading: false, reload };
  return {
    data: settled?.data ?? null,
    error: settled?.request === request ? settled.error : null,
    loading: settled?.request !== request,
    reload,
  };
}

export function asApiError(error: unknown, operation: string): MachApiError {
  return isMachApiError(error) ? error : new MachApiError("internal", String(error), operation);
}
