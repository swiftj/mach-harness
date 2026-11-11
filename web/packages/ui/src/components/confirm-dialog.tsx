import { CircleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog, DialogClose, DialogContent } from "./dialog";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A question naming the act and its object: "Approve EPIC-001: Team membership?" */
  title: ReactNode;
  /** What the act means and what it does not do, in one or two sentences. */
  description: ReactNode;
  /** Extra detail: counts, what will be shared. */
  children?: ReactNode;
  /** The act's own verb: "Approve", "Send", "Reopen". */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  /**
   * Performs the act. Resolve true (or nothing) to close; resolve false to stay open, for example
   * after a refusal that `error` now shows.
   */
  onConfirm: () => Promise<boolean | void> | boolean | void;
  /** Shown inside the dialog, above the buttons: a refusal in the engine's own words. */
  error?: { title: string; message: string } | null;
}

/**
 * The confirmation every personal act goes through (approve, send, reconcile, reopen). The
 * confirming button shows progress and blocks a second click; a refusal stays in the dialog.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Not now",
  tone = "primary",
  onConfirm,
  error,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const confirm = async () => {
    setPending(true);
    try {
      const result = await onConfirm();
      if (result !== false) onOpenChange(false);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent
        title={title}
        description={description}
        footer={
          <>
            <DialogClose asChild>
              <Button disabled={pending}>{cancelLabel}</Button>
            </DialogClose>
            <Button variant={tone} loading={pending} onClick={confirm}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        {children}
        {error ? (
          <div role="alert" className="mt-4 flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-label text-danger-ink">{error.title}</p>
              <p className="whitespace-pre-line text-body-sm text-ink">{error.message}</p>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
