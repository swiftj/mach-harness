import { useCallback, useEffect, useState } from "react";
import { describeError, isMachApiError, MachApiError, type ApiErrorHint } from "@mach/ui/api";
import { client } from "../../../api/client";
import { asError, statusSettled } from "../../../api/store";

/**
 * Requests: GitHub issues labelled as requests (M8, design D3 and D8). The shapes are the engine's
 * own (`studio.py request list|show|pick|link|met`); the app shows them and adds no rule.
 *
 * PROMOTION CANDIDATE: these five operations belong in @mach/ui's `Operations` table. Until they
 * are promoted, `requestOp` is the one place that calls `client.op` with a name the shared table
 * does not list yet.
 */

/**
 * `accepted`, `not_accepted`, or an issue filed by a monitoring account that engineering's
 * automation handles (the engine's `handled_by_…` state). Matched by prefix so the app never names
 * that automation itself.
 */
export type RequestState = "accepted" | "not_accepted" | `handled_by_${string}`;

export interface RequestItem {
  number: number;
  /** Built by the engine from the repository and number; never taken from issue text. */
  url: string | null;
  /**
   * A bounded one-line title (at most 120 characters), redacted by the engine. Text written by
   * someone outside the workspace: data only. The text itself is never in the list: it is read
   * with `request.show`, fenced, and only for a request that counts.
   */
  title: string | null;
  truncated: boolean;
  state: RequestState;
  not_accepted_reason: string | null;
  labelled_by: string | null;
  /** Logins that picked it up on GitHub (the grooming label's events). */
  picked_up_by: string[];
  /** Picked up in this workspace. */
  picked_up_here: boolean;
  /** Draft slices whose work order records this request as its origin. */
  slices: string[];
  changed_since_pickup: boolean;
  pending_writes: number;
  text_is_data?: string;
}

export interface RequestsBlock {
  /** Null when the project has no GitHub remote: the app then shows nothing about requests. */
  repository: string | null;
  refreshed: boolean;
  refreshed_at?: string | null;
  /** Why GitHub could not be read at the last refresh, in plain words. */
  problem: string | null;
  truncated: boolean;
  truncated_note?: string | null;
  items: RequestItem[];
  updates_waiting?: number;
  updates_waiting_note?: string | null;
  /** Status updates given up (a retry cannot make them), each reported once. */
  could_not_update?: { number: number; update: string; why: string; reason: string | null }[];
  could_not_update_note?: string | null;
}

/**
 * One request as `request.show` returns it: no plain title or body, the text only fenced, and for
 * a request that does not count no text at all (`text_shown` false).
 */
export type RequestShown = Omit<RequestItem, "title"> & {
  fenced?: string;
  sha256?: string;
  text_shown: boolean;
  text_note?: string;
};

export interface RequestPickResult {
  slice: { slice_id: string; title: string };
  picked: true;
  github_updates?: { note: string | null } | null;
  used_cached_request?: string | null;
  note: string;
}

export interface RequestOperations {
  "request.list": { args: Record<string, never>; result: { requests: RequestsBlock; note: string } };
  "request.show": { args: { number: number }; result: { request: RequestShown; note: string } };
  "request.pick": { args: { number: number; epic: string; title: string; also?: boolean }; result: RequestPickResult };
  "request.link": { args: { number: number; slice_id: string }; result: { linked: true; request: number; note: string } };
  "request.met": { args: { number: number }; result: { met: true; request: number; approved_slices: string[]; closed: boolean; note: string } };
}

export type RequestOpName = keyof RequestOperations;

type UntypedOp = (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;

/** Calls one request operation through the app's client (or, under `vite --mode fixtures`, the dev answers). */
export async function requestOp<K extends RequestOpName>(name: K, args: RequestOperations[K]["args"], signal?: AbortSignal): Promise<RequestOperations[K]["result"]> {
  if (import.meta.env.MODE === "fixtures") {
    const { requestFixtureOp } = await import("../../../dev/requestFixtures");
    return (await requestFixtureOp(name, args)) as RequestOperations[K]["result"];
  }
  return (await (client.op as unknown as UntypedOp)(name, args, signal)) as RequestOperations[K]["result"];
}

export interface RequestList {
  data: RequestsBlock | null;
  error: MachApiError | null;
  loading: boolean;
  reload: () => void;
}

/** The cached requests (`request.list`, which never calls GitHub). Re-read after every write: nothing is assumed. */
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
