import { useCallback, useState } from "react";
import { describeError, type ApiErrorHint, type MachApiError, type OperationArgs, type OperationName, type OperationResult } from "@mach/ui/api";
import { client } from "./client";
import { asError, statusSettled } from "./store";

export interface EngineAct {
  /** Runs one operation. Resolves with the result, or null after a failure (then `error` is set). */
  run: <K extends OperationName>(name: K, args: OperationArgs<K>) => Promise<OperationResult<K> | null>;
  pending: boolean;
  error: MachApiError | null;
  /** A title and message for the error, ready for ConfirmDialog's `error` or an ErrorState. A refusal keeps the engine's own words. */
  shown: { title: string; message: string; hint?: ApiErrorHint | null } | null;
  reset: () => void;
}

/**
 * For operations that change something. Reloads the shared status after success, so every screen
 * shows the change. Refusals are kept, not thrown, so the dialog that asked can show them.
 */
export function useEngineAct(): EngineAct {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);
  const run = useCallback(async <K extends OperationName>(name: K, args: OperationArgs<K>) => {
    setPending(true);
    setError(null);
    try {
      const result = await client.op(name, args);
      await statusSettled();
      return result;
    } catch (e) {
      setError(asError(e));
      return null;
    } finally {
      setPending(false);
    }
  }, []);
  const shown = error ? (error.kind === "refused" ? { title: "Not done", message: error.message, hint: error.hint } : describeError(error)) : null;
  return { run, pending, error, shown, reset: useCallback(() => setError(null), []) };
}
