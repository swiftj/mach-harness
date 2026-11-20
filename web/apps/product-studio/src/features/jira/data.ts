import { useEffect, useState, useSyncExternalStore } from "react";
import type { MachApiError, WorkOrder } from "@mach/ui/api";
import { client } from "../../api/client";
import { toApiError } from "../../api/session";

/**
 * Epic keys this page has learned from the engine's answers (`epic.link`, `slice.link`), kept for
 * the app's life. `status` does not report an epic's key, so this is the only way the page knows
 * one; an epic not in here is shown as not read yet.
 */
let learned: Record<string, string | null> = {};
const listeners = new Set<() => void>();

export function learnEpicKey(epic: string, key: string | null) {
  learned = { ...learned, [epic]: key };
  listeners.forEach((l) => l());
}

export function useLearnedEpicKeys(): Readonly<Record<string, string | null>> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => learned,
    () => learned,
  );
}

export interface WorkOrders {
  /** Each slice's work order, by ID, once read; null when it could not be read. */
  orders: Record<string, WorkOrder | null>;
  /** The first failure, if any, for the page to say once. */
  error: MachApiError | null;
}

/**
 * Reads each slice's work order (`slice.show`, which changes nothing), since only the work order
 * holds the slice's own key. Read again when a slice's revision changes, as linking a key does.
 * `slices` pairs each ID with its revision from status.
 */
export function useWorkOrders(slices: ReadonlyArray<{ id: string; revision: number }>): WorkOrders {
  const request = JSON.stringify(slices.map((s) => [s.id, s.revision]));
  const [state, setState] = useState<{ request: string } & WorkOrders>({ request: "", orders: {}, error: null });

  useEffect(() => {
    const wanted = JSON.parse(request) as Array<[string, number]>;
    const controller = new AbortController();
    void Promise.all(
      wanted.map(([id]) =>
        client.op("slice.show", { slice_id: id }, controller.signal).then(
          (show) => ({ id, order: show.slice, error: null }),
          (cause: unknown) => ({ id, order: null, error: toApiError(cause, "slice.show") }),
        ),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const orders: Record<string, WorkOrder | null> = {};
      for (const r of results) orders[r.id] = r.order;
      setState({ request, orders, error: results.find((r) => r.error)?.error ?? null });
    });
    return () => controller.abort();
  }, [request]);

  // Until the new reads arrive, the previous ones stay (a changed revision keeps showing its last key).
  return { orders: state.orders, error: state.request === request ? state.error : null };
}
