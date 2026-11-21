import { useRef, useState, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { Button, Dialog, DialogClose, DialogContent, HintAction } from "@mach/ui";
import type { ApiErrorHint } from "@mach/ui/api";

/**
 * The confirmation of one of the product manager's acts on this screen (record the verdict, save to GitHub, give a new
 * number). As the shared ConfirmDialog, with one addition: where the control that opened it is gone after the act (the
 * form closes once a verdict is recorded), focus goes to the named place instead of the page body.
 *
 * Candidate for promotion: ConfirmDialog could take `focusAfter` itself (named in the report, M5_CONTRACT 8.3).
 */
export function ActDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Not now",
  onConfirm,
  error,
  focusAfter,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Resolves true when done (the dialog closes), false to stay open with `error` shown. */
  onConfirm: () => Promise<boolean>;
  error: { title: string; message: string; hint?: ApiErrorHint | null } | null;
  /** Where focus goes after the act is done, when the opener may be gone. */
  focusAfter?: () => HTMLElement | null;
}) {
  const [pending, setPending] = useState(false);
  const done = useRef(false);
  const confirm = async () => {
    setPending(true);
    try {
      done.current = await onConfirm();
      if (done.current) onOpenChange(false);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent
        width="lg"
        title={title}
        description={description}
        onCloseAutoFocus={(event) => {
          // Cancelled: focus returns to the opener as usual. Done: the opener may be gone, so the named place.
          const target = done.current ? focusAfter?.() : null;
          done.current = false;
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
        footer={
          <>
            <DialogClose asChild>
              <Button disabled={pending}>{cancelLabel}</Button>
            </DialogClose>
            <Button variant="primary" loading={pending} onClick={confirm}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 pb-1">
          {children}
          {error ? (
            <div role="alert" className="flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" />
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="text-label text-danger-ink">{error.title}</p>
                <p className="whitespace-pre-line text-body-sm text-ink">{error.message}</p>
                {error.hint ? (
                  <div className="pt-1.5">
                    <HintAction hint={error.hint} />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
