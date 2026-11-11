/**
 * Workspace paths in product terms, for refresh summaries and decisions. Presentation only.
 *
 *   describePath("product/epics/EPIC-001.json", status)  → "Epic EPIC-001, Team membership"
 */
import type { Status } from "@mach/ui/api";

export interface DescribedPath {
  /** "The project", "Epic EPIC-001, Team membership", "The spec of SLICE-002". */
  label: string;
  /** The engine ID in it, when there is one. */
  id: string | null;
  kind: "project" | "epic" | "work-order" | "spec" | "why" | "wave" | "other";
}

export function describePath(path: string, status?: Status | null): DescribedPath {
  const title = (id: string) =>
    status?.epics.find((e) => e.epic_id === id)?.title ?? status?.slices.find((s) => s.slice_id === id)?.title ?? null;
  const named = (prefix: string, id: string) => {
    const t = title(id);
    return t ? `${prefix} ${id}, ${t}` : `${prefix} ${id}`;
  };
  if (path === "product/project.json") return { label: "The project", id: null, kind: "project" };
  let m = path.match(/^product\/epics\/(EPIC-\d+)\.json$/);
  if (m?.[1]) return { label: named("Epic", m[1]), id: m[1], kind: "epic" };
  m = path.match(/^product\/slices\/(SLICE-\d+)\.json$/);
  if (m?.[1]) return { label: named("Slice", m[1]), id: m[1], kind: "work-order" };
  m = path.match(/^specs\/slices\/(SLICE-\d+)-[^/]+\.md$/);
  if (m?.[1]) return { label: `The spec of ${named("slice", m[1]).replace(/^slice /, "")}`, id: m[1], kind: "spec" };
  m = path.match(/^product\/intents\/(SLICE-\d+)\.md$/);
  if (m?.[1]) return { label: `The why of ${named("slice", m[1]).replace(/^slice /, "")}`, id: m[1], kind: "why" };
  m = path.match(/^product\/delivery-waves\/(WAVE-\d+)\.json$/);
  if (m?.[1]) return { label: `Delivery wave ${m[1]}`, id: m[1], kind: "wave" };
  return { label: path, id: null, kind: "other" };
}

/** Field names as words: "acceptance_criteria" → "acceptance criteria". */
export function fieldWords(field: string): string {
  return field.replaceAll("_", " ");
}
