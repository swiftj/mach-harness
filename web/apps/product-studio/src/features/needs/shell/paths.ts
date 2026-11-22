/**
 * Technical needs' paths and breadcrumb (M17, shell-owned). Pure: the unit tests import this file directly.
 *
 *   /needs                     Technical needs
 *   /needs/design              A design you already have: the designs brought in, and bringing one in
 *   /needs/design/:designId    one design: its topics, its conflicts, publishing it
 */
import type { DesignSummary } from "@mach/ui/api";

export const NEEDS_PATH = "/needs";
export const DESIGNS_PATH = "/needs/design";
export const NEEDS_LABEL = "Technical needs";
export const DESIGNS_LABEL = "A design you already have";

/** DES-NN, the engine's own pattern (design.DES_RE). */
export const DESIGN_ID = /^DES-\d{2,}$/;

export const designPath = (designId: string): string => `${DESIGNS_PATH}/${encodeURIComponent(designId)}`;

/** The design a path names, or null. */
export function designOfPath(path: string): string | null {
  const found = path.match(/^\/needs\/design\/([^/]+)$/);
  return found?.[1] ? decodeURIComponent(found[1]) : null;
}

/** The top bar's steps after the project's name, or null when the path is not one of Technical needs' pages. */
export function needsBreadcrumb(path: string, designs: readonly Pick<DesignSummary, "design_id" | "name">[] | null | undefined): string[] | null {
  if (path === NEEDS_PATH) return [NEEDS_LABEL];
  if (path === DESIGNS_PATH) return [NEEDS_LABEL, DESIGNS_LABEL];
  const designId = designOfPath(path);
  if (designId) {
    const name = designs?.find((row) => row.design_id === designId)?.name;
    return [NEEDS_LABEL, DESIGNS_LABEL, name ? `${designId} ${name}` : designId];
  }
  return path.startsWith(`${NEEDS_PATH}/`) ? [NEEDS_LABEL] : null;
}
