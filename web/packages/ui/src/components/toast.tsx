import * as ToastPrimitive from "@radix-ui/react-toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { toneClasses } from "./tone";
import { modalLayerOpen } from "./modal-escape";

export type ToastTone = "info" | "success" | "danger";

export interface ToastMessage {
  id: number;
  tone: ToastTone;
  /** Past tense of the action's own name: "Approved SLICE-001", "Sent WAVE-001". */
  title: string;
  description?: string;
  /** Milliseconds. Errors stay until dismissed. */
  duration?: number;
}

let nextId = 1;
let queue: ToastMessage[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Confirms a completed action. Not for anything the person must act on: use a Banner for that. */
export function toast(message: Omit<ToastMessage, "id">): number {
  const id = nextId++;
  queue = [...queue, { id, ...message }];
  emit();
  return id;
}

export function dismissToast(id: number): void {
  queue = queue.filter((item) => item.id !== id);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const icons: Record<ToastTone, ReactNode> = {
  info: <Info aria-hidden="true" />,
  success: <CircleCheck aria-hidden="true" />,
  danger: <CircleAlert aria-hidden="true" />,
};

/** Mount once near the root. Toasts stack bottom-right; F8 moves focus to them. */
export function Toaster() {
  const items = useSyncExternalStore(subscribe, () => queue, () => queue);
  return (
    <ToastPrimitive.Provider swipeDirection="right" label="Notifications">
      {items.map((item) => {
        const t = toneClasses[item.tone];
        return (
          <ToastPrimitive.Root
            key={item.id}
            type={item.tone === "danger" ? "foreground" : "background"}
            duration={item.duration ?? (item.tone === "danger" ? Infinity : 5000)}
            onOpenChange={(open) => {
              if (!open) dismissToast(item.id);
            }}
            // While a dialog or sheet is open, Escape is the dialog's: a notification never takes it
            // (it stays until it times out or its own Close is pressed). When the notification itself
            // has focus (reached with F8), Escape still dismisses it.
            onEscapeKeyDown={(event) => {
              const inToasts = Boolean(document.activeElement?.closest("[data-mach-toasts]"));
              if (modalLayerOpen() && !inToasts) event.preventDefault();
            }}
            className={cn(
              "flex w-[360px] items-start gap-3 rounded-md border border-line-strong bg-surface-raised px-4 py-3 shadow-3",
              "data-[state=open]:animate-pop-in data-[state=closed]:animate-fade-out",
              "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
            )}
          >
            <span className={cn("mt-0.5 [&_svg]:size-[18px]", t.ink)}>{icons[item.tone]}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <ToastPrimitive.Title className="text-label text-ink">{item.title}</ToastPrimitive.Title>
              {item.description ? (
                <ToastPrimitive.Description className="text-body-sm text-ink-muted">{item.description}</ToastPrimitive.Description>
              ) : null}
            </div>
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="-mr-1 inline-flex size-6 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
            >
              <X aria-hidden="true" className="size-4" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport data-mach-toasts="" className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}
