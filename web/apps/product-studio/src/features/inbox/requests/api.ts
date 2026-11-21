import { useCallback, useState } from "react";
import { describeError, type ApiErrorHint, type MachApiError, type Operations } from "@mach/ui/api";
import { client } from "../../../api/client";
import { asError, statusSettled } from "../../../api/store";

/**
 * Requests: GitHub issues labelled as requests (M8, design D3 and D8). The shapes are the engine's
 * own (`studio.py request list|show|pick|link|met`); the app shows them and adds no rule.
 *
 * The five operations and their types live in @mach/ui's `Operations` table since M15 (with the
 * idea template's `idea` parts and `questions_to_ask_first`); they are re-exported here so the
 * Inbox's files keep their imports.
 */
export type { IdeaPart, IdeaParts, QuestionsToAskFirst, RequestForSlice, RequestItem, RequestPickResult, RequestShown, RequestState, RequestsBlock } from "@mach/ui/api";

export type RequestOpName = "request.list" | "request.show" | "request.pick" | "request.link" | "request.met";
export type RequestOperations = Pick<Operations, RequestOpName>;

/** Calls one request operation through the app's client (or, under `vite --mode fixtures`, the dev answers). */
export async function requestOp<K extends RequestOpName>(name: K, args: RequestOperations[K]["args"], signal?: AbortSignal): Promise<RequestOperations[K]["result"]> {
  if (import.meta.env.MODE === "fixtures") {
    const { requestFixtureOp } = await import("../../../dev/requestFixtures");
    return (await requestFixtureOp(name, args)) as RequestOperations[K]["result"];
  }
  return client.op(name, args, signal);
}

export interface RequestAct {
  run: <K extends RequestOpName>(name: K, args: RequestOperations[K]["args"]) => Promise<RequestOperations[K]["result"] | null>;
  pending: boolean;
  /** A refusal keeps the engine's own words. */
  shown: { title: string; message: string; hint?: ApiErrorHint | null } | null;
  reset: () => void;
}

/** A write the person asked for with a click. Resolves null after a failure, which `shown` then describes. */
export function useRequestAct(): RequestAct {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);
  const run = useCallback(async <K extends RequestOpName>(name: K, args: RequestOperations[K]["args"]) => {
    setPending(true);
    setError(null);
    try {
      const result = await requestOp(name, args);
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
  return { run, pending, shown, reset: useCallback(() => setError(null), []) };
}
