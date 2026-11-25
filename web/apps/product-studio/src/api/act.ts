import { useCallback, useRef, useState } from "react";
import { MachApiError, describeError, type ApiErrorHint, type OperationArgs, type OperationName, type OperationResult } from "@mach/ui/api";
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

/** A conversation is writing what the act changes: the host warned, and the same act with interrupt goes ahead. */
const isWriterWarning = (error: MachApiError) => error.kind === "conflict" && error.hint?.kind === "interrupt_turn";

/**
 * For operations that change something. Reloads the shared status after success, so every screen
 * shows the change. Refusals are kept, not thrown, so the dialog that asked can show them.
 *
 * While a conversation is writing what the act changes, the host warns first. The warning is shown as the error, with
 * one action (its hint's `proceed`): the act stays open until the person takes it, then runs again with interrupt and
 * resolves as if it had gone through the first time. Running another act, or reset, drops it (resolves null).
 */
export function useEngineAct(): EngineAct {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);
  const waiting = useRef<((go: boolean) => void) | null>(null);
  const drop = useCallback(() => {
    waiting.current?.(false);
    waiting.current = null;
  }, []);
  const run = useCallback(
    async <K extends OperationName>(name: K, args: OperationArgs<K>) => {
      drop();
      let interrupt = false;
      for (;;) {
        setPending(true);
        setError(null);
        try {
          const result = await client.op(name, args, undefined, interrupt ? { interrupt: true } : undefined);
          await statusSettled();
          return result;
        } catch (e) {
          const failure = asError(e);
          if (interrupt || !isWriterWarning(failure)) {
            setError(failure);
            return null;
          }
          const go = await new Promise<boolean>((resolve) => {
            waiting.current = resolve;
            setError(new MachApiError(failure.kind, failure.message, failure.operation, failure.status, { ...failure.hint!, proceed: () => resolve(true) }));
            setPending(false);
          });
          waiting.current = null;
          if (!go) return null;
          interrupt = true;
        } finally {
          setPending(false);
        }
      }
    },
    [drop],
  );
  const shown = error
    ? error.kind === "refused"
      ? { title: "Not done", message: error.message, hint: error.hint }
      : isWriterWarning(error)
        ? { title: "MACH is writing this right now", message: error.message, hint: error.hint }
        : describeError(error)
    : null;
  const reset = useCallback(() => {
    drop();
    setError(null);
  }, [drop]);
  return { run, pending, error, shown, reset };
}
