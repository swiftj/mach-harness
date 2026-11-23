import { Hash } from "lucide-react";

/**
 * M20, under "Make the drafts" (a PRD's or an idea's): GitHub could not be read before the drafts were numbered, so a
 * number may already be in use there. The engine's sentence, on its own line, calm: marking a slice ready checks again.
 */
export function NumbersNotChecked({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="flex items-start gap-2 text-body-sm text-ink">
      <Hash aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-ink" />
      <span>{text}</span>
    </p>
  );
}
