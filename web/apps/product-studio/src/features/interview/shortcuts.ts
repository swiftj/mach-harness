import type { KeyboardEvent } from "react";

/**
 * The letter a one-key answer shortcut was pressed for, lower case, or null when the key press is not
 * one: a modifier is held, or the person is typing in a text box or any other input. The question
 * card and the summary to confirm use this one rule, so their shortcuts behave the same.
 */
export function shortcutKey(event: KeyboardEvent<HTMLElement>): string | null {
  const target = event.target as HTMLElement;
  if (event.metaKey || event.ctrlKey || event.altKey || target.closest("textarea, input")) return null;
  return event.key.toLowerCase();
}
