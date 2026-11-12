import { useState } from "react";

/** Returns focus when a dialog or sheet closes; `remember` records the opener when it opens. */
export type FocusReturn = ((event: Event) => void) & {
  /**
   * Record what has focus now as the place to return to. Call when the dialog opens (Radix's
   * `onOpenAutoFocus`), passing the dialog's own content: focus already inside it (an `autoFocus`
   * field, focused as the content mounts) is not an opener and leaves the earlier value in place.
   */
  remember: (within?: Element | null) => void;
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
    const fallback = () => {
      const heading = document.querySelector<HTMLElement>("main h1");
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus();
        return;
      }
      document.querySelector<HTMLElement>("main")?.focus();
    };
    const restore = ((event: Event) => {
      event.preventDefault();
      const target = opener;
      if (target instanceof HTMLElement && target.isConnected && target !== document.body && !target.closest("[inert]")) {
        target.focus();
        // The act the dialog confirmed often replaces its opener a moment later (an Approve button
        // becomes the approved state). Focus would then fall to the page body, so watch briefly.
        const watch = new MutationObserver(() => {
          if (target.isConnected && document.activeElement === target) return;
          watch.disconnect();
          if (document.activeElement === document.body || document.activeElement === null) fallback();
        });
        watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
        window.setTimeout(() => watch.disconnect(), 1500);
        if (document.activeElement !== target) {
          watch.disconnect();
          fallback();
        }
        return;
      }
      fallback();
    }) as FocusReturn;
    restore.remember = (within) => {
      const active = activeElement();
      if (!active || active === document.body || within?.contains(active)) return;
      opener = active;
    };
    return restore;
  });
  return handle;
}
