/**
 * The idea typed in "Start a slice", kept until that slice's first interview starts. It must survive
 * the PM looking at the specification first, or reloading, so it is kept per slice for this browser
 * session (sessionStorage, guarded; a module copy when storage is blocked), and taken once.
 */
const KEY = (sliceId: string) => `mach.pending-idea.${sliceId}`;
const memory = new Map<string, string>();

export function rememberIdea(sliceId: string, idea: string): void {
  const text = idea.trim();
  if (!text) return;
  memory.set(sliceId, text);
  try {
    window.sessionStorage.setItem(KEY(sliceId), text);
  } catch {
    // Storage blocked: the module copy lasts for this page.
  }
}

/** The pending idea for the slice, if any, without removing it. */
export function peekIdea(sliceId: string): string | undefined {
  try {
    const stored = window.sessionStorage.getItem(KEY(sliceId));
    if (stored) return stored;
  } catch {
    // fall through to the module copy
  }
  return memory.get(sliceId);
}

/** Removes the pending idea once the interview has started with it. */
export function forgetIdea(sliceId: string): void {
  memory.delete(sliceId);
  try {
    window.sessionStorage.removeItem(KEY(sliceId));
  } catch {
    // nothing to remove
  }
}
