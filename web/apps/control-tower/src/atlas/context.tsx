/**
 * What every Atlas part shares: the level of detail, the layout, the highlight set and the
 * interaction wrapper. Selection and hover live in the scene store; the Atlas only reads them.
 */
import { createContext, memo, useContext, useMemo, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { Lod } from "@mach/ui";
import { useSceneActions, useSceneStore, useStore, type SceneStoreState } from "../scene";
import type { EntityRef } from "../sim";
import type { PlantLayout } from "./layout";

export interface AtlasContextValue {
  lod: Lod;
  layout: PlantLayout;
  /** The WebGL light layer is drawing the lamp pools; the SVG pools switch off. */
  lightLayer: boolean;
  /** Tickets whose bays are drawn whole, with their hit targets (bays out of view are plates only). */
  visibleBays: ReadonlySet<string>;
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
  /** What is drawn and pointed at. Omit when `points` gives the target's outline instead. */
  children?: ReactNode;
  /**
   * A transparent proxy outline (SVG `points`) instead of children: the target is then that one
   * polygon, carrying the role, name and handlers itself (one element instead of a group and its
   * polygon; a bay draws a dozen of these).
   */
  points?: string;
  /**
   * A second picture of an entity whose own target is drawn elsewhere (a cell's work parked at a
   * station, an artifact on the review table that also stands on its cell's shelf). Pointing at it
   * selects and highlights the entity as usual, but it is not a second button: no accessible name,
   * no keyboard stop, no `data-ref`, so every entity is reached and announced exactly once.
   */
  alias?: boolean;
}

/**
 * Makes a drawn thing selectable: a focusable SVG group with an accessible name. Click, Enter or
 * Space selects (without moving the camera, spec f.2); double-click focuses; hover highlights.
 * Entities are not tab stops: the view is one, and arrows rove between them (see AtlasView).
 */
export const Hit = memo(function Hit({ entity, label, children, points, alias = false }: HitProps) {
  const selected = useSceneStore((s) => s.selection === entity);
  const { select, hover, focusOn } = useSceneActions();
  const pointer = {
    className: "atlas-hit",
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      select(entity, { focus: false });
    },
    onDoubleClick: (e: MouseEvent) => {
      e.stopPropagation();
      focusOn(entity, "select");
    },
    onPointerEnter: () => hover(entity),
    onPointerLeave: () => hover(null),
  };
  if (alias) {
    // Pointer-only by design: the entity's keyboard stop and name are its primary target's.
    return points !== undefined ? (
      <polygon aria-hidden="true" data-alias-of={entity} points={points} style={PROXY} {...pointer} />
    ) : (
      <g aria-hidden="true" data-alias-of={entity} {...pointer}>
        {children}
      </g>
    );
  }
  const button = {
    role: "button",
    tabIndex: -1,
    "aria-label": label,
    "aria-pressed": selected,
    "data-ref": entity,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        select(entity, { focus: false });
      }
    },
    ...pointer,
  };
  return points !== undefined ? (
    <polygon points={points} style={PROXY} {...button} />
  ) : (
    <g {...button}>{children}</g>
  );
});

const PROXY = { fill: "transparent" } as const;

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
