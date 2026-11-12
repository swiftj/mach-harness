/**
 * What every Atlas part shares: the level of detail, the layout, the highlight set and the
 * interaction wrapper. Selection and hover live in the scene store; the Atlas only reads them.
 */
import { createContext, memo, useContext, useMemo, type KeyboardEvent, type ReactNode } from "react";
import type { Lod } from "@mach/ui";
import { useSceneActions, useSceneStore, useStore, type SceneStoreState } from "../scene";
import type { EntityRef } from "../sim";
import type { PlantLayout } from "./layout";

export interface AtlasContextValue {
  lod: Lod;
  layout: PlantLayout;
}

export const AtlasContext = createContext<AtlasContextValue | null>(null);

export function useAtlas(): AtlasContextValue {
  const v = useContext(AtlasContext);
  if (!v) throw new Error("Atlas parts must be drawn inside <AtlasView>.");
  return v;
}

const EMPTY: ReadonlySet<EntityRef> = new Set();
const setCache = new WeakMap<readonly EntityRef[], ReadonlySet<EntityRef>>();

/** The dependency or relation set to keep lit (hover, else selection); empty when nothing is. */
export function useHighlight(): ReadonlySet<EntityRef> {
  const list = useSceneStore((s) => s.highlighted);
  return useMemo(() => {
    if (list.length === 0) return EMPTY;
    let set = setCache.get(list);
    if (!set) {
      set = new Set(list);
      setCache.set(list, set);
    }
    return set;
  }, [list]);
}

/** Dimmed: something is highlighted and this is not part of it. */
export function isDimmed(highlight: ReadonlySet<EntityRef>, ...refs: EntityRef[]): boolean {
  if (highlight.size === 0) return false;
  return !refs.some((r) => highlight.has(r));
}

export interface HitProps {
  entity: EntityRef;
  label: string;
  children: ReactNode;
}

/**
 * Makes a drawn thing selectable: a focusable SVG group with an accessible name. Click, Enter or
 * Space selects (without moving the camera, spec f.2); double-click focuses; hover highlights.
 */
export const Hit = memo(function Hit({ entity, label, children }: HitProps) {
  const selected = useSceneStore((s) => s.selection === entity);
  const { select, hover, focusOn } = useSceneActions();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      select(entity, { focus: false });
    }
  };
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      data-ref={entity}
      className="atlas-hit"
      onClick={(e) => {
        e.stopPropagation();
        select(entity, { focus: false });
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        focusOn(entity, "select");
      }}
      onKeyDown={onKey}
      onPointerEnter={() => hover(entity)}
      onPointerLeave={() => hover(null)}
    >
      {children}
    </g>
  );
});

/**
 * The playhead, for a part that should re-render only when `key` changes. `key` returns the
 * playhead itself while the part animates, or a settled value (a quantised step, a flag) when it
 * does not; the part then reads the current playhead at render, so every render is still a pure
 * function of the playhead.
 */
export function usePlayheadKeyed(key: (s: SceneStoreState) => string | number): number {
  useSceneStore(key);
  return useStore().getState().playhead;
}
