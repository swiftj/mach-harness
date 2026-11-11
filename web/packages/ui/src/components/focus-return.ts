import { useRef } from "react";

/**
 * Where focus goes when a dialog or sheet closes. Radix returns focus to its own Trigger, but most
 * dialogs here are opened from code (a button elsewhere, a next action, a hint), so this remembers
 * what had focus when the dialog opened and returns there; if that control is gone (an Approve
 * button replaced by the approved state), focus goes to the page's heading, then to <main>, never
 * to the page body.
 *
 * Call during the content's first render (before Radix moves focus into the dialog).
 */
export function useFocusReturn(): (event: Event) => void {
  const opener = useRef<Element | null>(typeof document !== "undefined" ? document.activeElement : null);
  return (event: Event) => {
    event.preventDefault();
    const target = opener.current;
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
  };
}
