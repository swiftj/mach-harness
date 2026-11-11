import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn";

/** Wrap the app once. Tooltips open after 500ms, and immediately when moving between them. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={500} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  /** A short label: what the control does, or its keyboard shortcut. Never essential information. */
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}

/** Names an icon-only control. Opens on hover and on keyboard focus; Escape closes. */
export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-50 max-w-64 rounded-sm bg-surface-inverse px-2 py-1 text-caption text-ink-inverse shadow-2 data-[state=delayed-open]:animate-fade-in",
            className,
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
