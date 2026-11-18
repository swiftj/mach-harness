/**
 * Workspace paths and IDs in product terms, for the engine's structural errors and decisions.
 * Presentation only.
 *
 *   describePath("product/epics/EPIC-001.json", status)  → "Epic EPIC-001, Team membership"
 */
import type { Status } from "@mach/ui/api";

export interface DescribedPath {
  /** "The project", "Epic EPIC-001, Team membership", "The spec of SLICE-002". */
  label: string;
  /** The engine ID in it, when there is one. */
  id: string | null;
}

export function describePath(path: string, status?: Status | null): DescribedPath {
  const named = (prefix: string, id: string) => {
    const t = titleFor(status ?? null, id);
    return t ? `${prefix} ${id}, ${t}` : `${prefix} ${id}`;
  };
  if (path === "product/project.json") return { label: "The project", id: null };
  let m = path.match(/^product\/epics\/(EPIC-\d+)\.json$/);
  if (m?.[1]) return { label: named("Epic", m[1]), id: m[1] };
  m = path.match(/^product\/slices\/(SLICE-\d+)\.json$/);
  if (m?.[1]) return { label: named("Slice", m[1]), id: m[1] };
  m = path.match(/^specs\/slices\/(SLICE-\d+)-[^/]+\.md$/);
  if (m?.[1]) return { label: `The spec of ${named("slice", m[1]).replace(/^slice /, "")}`, id: m[1] };
  m = path.match(/^product\/intents\/(SLICE-\d+)\.md$/);
  if (m?.[1]) return { label: `The why of ${named("slice", m[1]).replace(/^slice /, "")}`, id: m[1] };
  return { label: path, id: null };
}

/** The title the workspace knows for an ID, from status. */
export function titleFor(status: Status | null, id: string | null): string | null {
  if (!status) return null;
  if (!id) return status.project?.name ?? null;
  return status.slices.find((s) => s.slice_id === id)?.title ?? status.epics.find((e) => e.epic_id === id)?.title ?? null;
}
