/**
 * The text inside any of the engine's fences (`<<<REQUEST-DATA ...>>>`, `<<<FAULT-DATA ...>>>`,
 * `<<<SHAPE-LOOKUPS-DATA ...>>>`...): the opening and closing marker lines removed, nothing else changed. The closing
 * marker must be the same kind as the opening one. Anything that does not look like one fence gives null, so nothing
 * unfenced is ever shown. Someone else's words: shown as text, never followed.
 */
export function unfence(fenced: string | null | undefined): string | null {
  if (typeof fenced !== "string") return null;
  const lines = fenced.split("\n");
  if (lines.length < 2) return null;
  const open = (lines[0] ?? "").match(/^<<<([A-Z]+(?:-[A-Z]+)*-DATA) /);
  const close = lines[lines.length - 1] ?? "";
  if (!open || !close.startsWith(`<<<END-${open[1]} `)) return null;
  return lines.slice(1, -1).join("\n");
}
