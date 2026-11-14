/**
 * Per-viewer view ephemera of the Analytics sheet (I-15, journey 5): which charts show their table,
 * how each ranking is sorted, and how far each area's sheet was scrolled. Analytics is unmounted while
 * another workspace is up, and the address restores what it carries (area, period, filters, pick,
 * drawer); this restores the rest when the browser's Back returns.
 *
 * Not a selection or navigation store: it holds no entity, no moment and no view the address carries,
 * only fixed interface codes (a chart id, a column key, a sort direction, a pixel offset), never prose.
 * In memory, per scene store, so a new source starts clean; never written to the address or to browser
 * storage.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useStore } from "../../scene";

/** Remembered keys per store, at most: the oldest is forgotten first. */
export const REMEMBER_MAX = 200;

const memory = new WeakMap<object, Map<string, unknown>>();

function mapOf(owner: object): Map<string, unknown> {
  let m = memory.get(owner);
  if (!m) memory.set(owner, (m = new Map()));
  return m;
}

/** Plain access (tests, and code outside React): the value remembered for `key` under `owner`, or undefined. */
export function recall<T>(owner: object, key: string): T | undefined {
  return mapOf(owner).get(key) as T | undefined;
}

export function remember(owner: object, key: string, value: unknown): void {
  const m = mapOf(owner);
  m.delete(key);
  m.set(key, value);
  while (m.size > REMEMBER_MAX) m.delete(m.keys().next().value as string);
}

/** `useState` whose value outlives the component: read back the next time the same key mounts under the same store. */
export function useRemembered<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const store = useStore();
  const [value, setValue] = useState<T>(() => recall<T>(store, key) ?? initial);
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        remember(store, key, v);
        return v;
      });
    },
    [store, key],
  );
  return [value, set];
}

/**
 * Keeps a scroll container's offset under `key` and puts it back once `ready` (the content it scrolled
 * through is drawn again). A new key (another area) starts at the top unless it was scrolled before.
 */
export function useRememberedScroll(ref: RefObject<HTMLElement | null>, key: string, ready: boolean): void {
  const store = useStore();
  const restored = useRef<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => remember(store, `scroll:${key}`, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ref, store, key]);
  useEffect(() => {
    if (!ready || restored.current === key) return;
    const el = ref.current;
    if (!el) return;
    restored.current = key;
    const top = recall<number>(store, `scroll:${key}`) ?? 0;
    el.scrollTo({ top });
    if (top === 0 || typeof ResizeObserver === "undefined") return;
    // Charts may still be drawing (a placeholder above can change height, and the browser's scroll
    // anchoring would follow it): keep putting the offset back whenever the sheet's content changes
    // size, until the person scrolls or two seconds pass.
    let settled = false;
    const content = el.firstElementChild ?? el;
    const observer = new ResizeObserver(() => {
      if (!settled) el.scrollTo({ top });
    });
    const stop = () => {
      settled = true;
      observer.disconnect();
      el.removeEventListener("wheel", stop);
      el.removeEventListener("keydown", stop);
      el.removeEventListener("pointerdown", stop);
      clearTimeout(timer);
    };
    const timer = setTimeout(stop, 2000);
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("keydown", stop);
    el.addEventListener("pointerdown", stop);
    observer.observe(content);
    return stop;
  }, [ref, store, key, ready]);
}
