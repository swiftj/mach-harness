import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { DialogOverlay } from "./dialog";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps extends Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  /** Width in px. 480 for detail, 640 for side-by-side comparison. */
  width?: 400 | 480 | 640;
}

/**
 * A panel from the right edge for detail that keeps the page in view: a slice's check, a reconcile
 * comparison, reviewer remarks. Modal: focus is trapped and Escape closes.
 */
export const SheetContent = forwardRef<HTMLDivElement, SheetContentProps>(function SheetContent(
  { title, description, footer, width = 480, className, children, ...props },
  ref,
) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        style={{ width: `min(${width}px, calc(100vw - 3rem))` }}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex flex-col border-l border-line bg-surface-raised shadow-3",
          "data-[state=open]:animate-sheet-in data-[state=closed]:animate-sheet-out",
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <DialogPrimitive.Title className="font-display text-title-2 text-ink">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-body-sm text-ink-muted">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close" className="-mr-2">
              <X aria-hidden="true" />
            </Button>
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
