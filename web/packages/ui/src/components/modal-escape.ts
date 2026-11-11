import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Escape belongs to the open dialog or sheet. Radix gives Escape to the most recently mounted
 * "layer", and a notification (toast) that appears after a dialog opened is such a layer, so it
 * would take the key and leave the dialog open. The toaster now refuses Escape while a dialog is
 * open (see toast.tsx); this hook makes sure the dialog then still closes:
 *
 * - Radix's own Escape handling runs first (a document listener). When it handled this key, or was
 *   told not to close (`onEscapeKeyDown` prevented, e.g. while saving), nothing more happens.
 * - Otherwise, if the key was pressed inside this dialog (not in a nested popover or select, whose
 *   own Escape comes first), the caller's `onEscapeKeyDown` is asked, then the dialog's own Close
 *   control is pressed, so it closes exactly as a click on Close would.
 */
export function useModalEscape(onEscapeKeyDown?: (event: KeyboardEvent) => void) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const handledByRadix = useRef<KeyboardEvent | null>(null);
  return {
    closeRef,
    onEscapeKeyDown(event: KeyboardEvent) {
      handledByRadix.current = event;
      onEscapeKeyDown?.(event);
    },
    onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
      if (event.key !== "Escape") return;
      if (handledByRadix.current === event.nativeEvent) return;
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      const asked = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      onEscapeKeyDown?.(asked);
      if (asked.defaultPrevented) return;
      closeRef.current?.click();
    },
  };
}

/** True while a dialog, sheet or popover is open: then Escape is theirs, not a notification's. */
export function modalLayerOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}
