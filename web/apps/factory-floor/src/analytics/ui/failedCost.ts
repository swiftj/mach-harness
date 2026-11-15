/**
 * The cost failed executions recorded in their own results, for Economics (real-run defect D8): read by
 * the workspace from the view's executions list, at the view's cursor, and handed down here. Never part
 * of K1, K4 or the per-ticket figure; Economics says it on its own line.
 */
import { createContext, useContext } from "react";
import type { FailedCost } from "../model/costCoverage";

export const FailedCostContext = createContext<FailedCost>(null);

export function useFailedCost(): FailedCost {
  return useContext(FailedCostContext);
}
