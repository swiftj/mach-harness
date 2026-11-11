import * as PopoverPrimitive from "@radix-ui/react-popover";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/cn";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

/** Non-modal, anchored detail: a legend, a filter, a short explanation with a link onward. */
export const PopoverContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>>(
  function PopoverContent({ className, sideOffset = 6, align = "start", ...props }, ref) {
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={ref}
          sideOffset={sideOffset}
          align={align}
          className={cn(
            "z-50 w-72 rounded-lg border border-line-strong bg-surface-raised p-4 text-body-sm text-ink shadow-2",
            "data-[state=open]:animate-pop-in data-[state=closed]:animate-fade-out",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  },
);
