import { useState } from "react";

/** Returns focus when a dialog or sheet closes; `remember` records the opener when it opens. */
export type FocusReturn = ((event: Event) => void) & {
  /** Record what has focus now as the place to return to. Call when the dialog opens (Radix's `onOpenAutoFocus`). */
  remember: () => void;
};

function activeElement(): Element | null {
  return typeof document !== "undefined" ? document.activeElement : null;
}

/**
 * Where focus goes when a dialog or sheet closes. Radix returns focus to its own Trigger, but most
 * dialogs here are opened from code (a button elsewhere, a next action, a hint, a keyboard
 * shortcut), so this remembers what had focus when the dialog opened and returns there; if that
 * control is gone (an Approve button replaced by the approved state), focus goes to the page's
 * heading, then to <main>, never to the page body.
 *
 * The opener is taken when the dialog opens: call `remember()` from `onOpenAutoFocus`, which Radix
 * fires as the content mounts, before it moves focus inside. The content component stays mounted
 * while the dialog is closed, so a value taken on its first render would be whatever had focus when
 * the page mounted, and would never change for later openings. The first render's value is kept
 * only as a fallback for a caller that never calls `remember()`.
 */
export function useFocusReturn(): FocusReturn {
  // One stable handle for the component's life; the first render's focus is only the fallback.
  const [handle] = useState(() => {
    let opener: Element | null = activeElement();
    const restore = ((event: Event) => {
      event.preventDefault();
      const target = opener;
      if (target instanceof HTMLElement && target.isConnected && target !== document.body && !target.closest("[inert]")) {
        target.focus();
        return;
      }
      const heading = document.querySelector<HTMLElement>("main h1");
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus();
        return;
      }
      document.querySelector<HTMLElement>("main")?.focus();
    }) as FocusReturn;
    restore.remember = () => {
      opener = activeElement();
    };
    return restore;
  });
  return handle;
}
