/** Engine IDs (SLICE-001, EPIC-001, WAVE-001). Checked before a value is placed in a URL path. */
export const ENGINE_ID = /^[A-Z]+-\d{3,}$/;

/** What kind of artifact an engine ID or workspace path names, for routing. Presentation only. */
export function artifactKind(target: string | null | undefined): "slice" | "epic" | "wave" | "project" | "path" | null {
  if (!target) return null;
  if (/^SLICE-\d{3,}$/.test(target)) return "slice";
  if (/^EPIC-\d{3,}$/.test(target)) return "epic";
  if (/^WAVE-\d{3,}$/.test(target)) return "wave";
  if (target === "product/project.json") return "project";
  return target.includes("/") ? "path" : null;
}

/** The engine ID inside a workspace path ("product/slices/SLICE-001.json" → "SLICE-001"), if any. */
export function idInPath(path: string): string | null {
  return path.match(/\b(?:SLICE|EPIC|WAVE)-\d{3,}\b/)?.[0] ?? null;
}
