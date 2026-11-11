import * as TabsPrimitive from "@radix-ui/react-tabs";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/cn";

export const Tabs = TabsPrimitive.Root;

/** Arrow keys move between tabs; the active tab is the only one in the tab order. */
export const TabsList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(function TabsList(
  { className, ...props },
  ref,
) {
  return <TabsPrimitive.List ref={ref} className={cn("flex gap-5 border-b border-line", className)} {...props} />;
});

export const TabsTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(
  function TabsTrigger({ className, ...props }, ref) {
    return (
      <TabsPrimitive.Trigger
        ref={ref}
        className={cn(
          "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 border-transparent text-label text-ink-muted",
          "transition-colors duration-[var(--mach-duration-fast)] hover:text-ink",
          "data-[state=active]:border-accent data-[state=active]:text-ink",
          "focus-visible:outline-offset-[-2px]",
          className,
        )}
        {...props}
      />
    );
  },
);

export const TabsContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(
  function TabsContent({ className, ...props }, ref) {
    return <TabsPrimitive.Content ref={ref} className={cn("pt-5 focus-visible:outline-offset-4", className)} {...props} />;
  },
);
