import { useEffect, useState } from "react";
import { deliveryOp } from "./delivery/ops";

/**
 * Each slice's dependencies, read from its work order through `slice.show`.
 * ENGINE GAP: status rows do not carry `dependencies`, so this costs one call per slice. A
 * `dependencies` field on status's slice rows would make it one call.
 */
export function useDependencies(sliceIds: string[]): { dependencies: Map<string, string[]>; loading: boolean; failed: boolean } {
  const key = [...new Set(sliceIds)].sort().join(",");
  const [state, setState] = useState<{ key: string; dependencies: Map<string, string[]>; failed: boolean } | null>(null);

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const ids = key.split(",");
    Promise.allSettled(ids.map((id) => deliveryOp("slice.show", { slice_id: id }, controller.signal))).then((results) => {
      if (controller.signal.aborted) return;
      const map = new Map<string, string[]>();
      let failed = false;
      results.forEach((result, index) => {
        const id = ids[index] ?? "";
        if (result.status === "fulfilled") map.set(id, result.value.slice.dependencies ?? []);
        else failed = true;
      });
      setState({ key, dependencies: map, failed });
    });
    return () => controller.abort();
  }, [key]);

  if (!key) return { dependencies: new Map(), loading: false, failed: false };
  return { dependencies: state?.dependencies ?? new Map(), loading: state?.key !== key, failed: state?.key === key && state.failed };
}
