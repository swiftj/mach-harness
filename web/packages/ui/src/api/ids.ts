/** Engine IDs (SLICE-001, EPIC-001). Checked before a value is placed in a URL path. */
export const ENGINE_ID = /^[A-Z]+-\d{3,}$/;

/** What kind of artifact an engine ID names, for routing. Presentation only. */
export function artifactKind(target: string | null | undefined): "slice" | "epic" | null {
  if (!target) return null;
  if (/^SLICE-\d{3,}$/.test(target)) return "slice";
  if (/^EPIC-\d{3,}$/.test(target)) return "epic";
  return null;
}
