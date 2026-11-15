/**
 * Free text in the evidence catalog (R1, the product owner's decision): which catalog entries stand
 * for a scene artifact, and the label they carry. Pure (no React), so tested in plain node.
 */
import { freeTextLabel, type ArtifactEntry } from "../../live/observer";
import type { ArtifactState } from "../../sim";

type Entries = readonly ArtifactEntry[];

/** The catalog entries that stand for a scene artifact: by its ref, else by ticket and path (any version). */
export function catalogEntriesOf(entries: Entries, artifact: Pick<ArtifactState, "id" | "ticketId" | "path">): Entries {
  const ref = `artifact:${artifact.id}`;
  return entries.filter((e) => e.ref === ref || (e.ref !== null && e.ref.startsWith(`${ref}@`)) || (e.ticketId === artifact.ticketId && e.path === artifact.path));
}

/** The free-text label for an artifact, from its catalog entries: labelled when any served version is free text. */
export function freeTextLabelOf(entries: Entries, artifact: Pick<ArtifactState, "id" | "ticketId" | "path">): string | null {
  for (const e of catalogEntriesOf(entries, artifact)) {
    const label = freeTextLabel(e);
    if (label) return label;
  }
  return null;
}

