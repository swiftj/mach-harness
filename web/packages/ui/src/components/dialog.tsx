import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Button } from "./button";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>>(
  function DialogOverlay({ className, ...props }, ref) {
    return (
      <DialogPrimitive.Overlay
        ref={ref}
        className={cn(
          "fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
          className,
        )}
        {...props}
      />
    );
  },
);

export interface DialogContentProps extends Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "title"> {
  title: ReactNode;
  /** One or two sentences: what this decision does. Required, because it becomes the accessible description. */
  description: ReactNode;
  /** Buttons, right-aligned. Put the confirming action last. */
  footer?: ReactNode;
  width?: "sm" | "md" | "lg";
}

/**
 * A modal decision. Use for confirming a person's act (approve, send, reconcile, reopen) and for short forms.
 * Focus is trapped, Escape closes, focus returns to the trigger.
 */
export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(function DialogContent(
  { title, description, footer, width = "md", className, children, ...props },
  ref,
) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-1/2 top-[12vh] z-50 flex max-h-[76vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-lg border border-line bg-surface-raised shadow-3",
          "data-[state=open]:animate-pop-in data-[state=closed]:animate-fade-out",
          width === "sm" && "max-w-md",
          width === "md" && "max-w-lg",
          width === "lg" && "max-w-2xl",
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div className="flex flex-col gap-1.5">
            <DialogPrimitive.Title className="font-display text-title-2 text-ink">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-body text-ink-muted">{description}</DialogPrimitive.Description>
          </div>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close" className="-mr-2">
              <X aria-hidden="true" />
            </Button>
          </DialogPrimitive.Close>
        </div>
        {children ? <div className="min-h-0 overflow-y-auto px-6 pt-4">{children}</div> : null}
        <div className="flex justify-end gap-2 px-6 pb-5 pt-5">{footer}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
