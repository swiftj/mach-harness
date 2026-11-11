import { createContext, useContext, type ReactNode } from "react";
import type { ApiErrorHint } from "../api/errors";

/**
 * How an app turns a refusal's hint ({kind, target}: the action that would resolve it) into a real
 * button or link. The design system cannot know an app's routes, so the app provides the renderer
 * once (HintProvider); ConfirmDialog, ErrorState and anything else showing a refusal render
 * <HintAction hint={error.hint} /> next to the engine's words.
 */
const HintContext = createContext<((hint: ApiErrorHint) => ReactNode) | null>(null);

export function HintProvider({ render, children }: { render: (hint: ApiErrorHint) => ReactNode; children: ReactNode }) {
  return <HintContext.Provider value={render}>{children}</HintContext.Provider>;
}

/** The hinted action, or nothing when there is no hint or no renderer. */
export function HintAction({ hint }: { hint: ApiErrorHint | null | undefined }) {
  const render = useContext(HintContext);
  if (!hint || !render) return null;
  return <>{render(hint)}</>;
}
