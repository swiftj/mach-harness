/**
 * The one component that renders `UncheckedText` (M6_5_SECURITY.md 6 B): React text nodes only (C1),
 * truncated to the field's limit with the full words on explicit expansion only (C2), and labelled
 * (C3) unless the panel already carries the label once (`labelled`). It never builds a `title` or an
 * `aria-label` from the words (C1) and never puts them anywhere else (C4).
 */
import { useState } from "react";
import { UNCHECKED_NOTE, uncheckedView, type UncheckedText as Unchecked } from "./text";

export interface UncheckedTextProps {
  readonly text: Unchecked | null;
  /** Characters to show at most (never more than the field's own limit). */
  readonly max?: number;
  /** The panel shows the label once already (C3): do not repeat it here. */
  readonly labelled?: boolean;
  /** The observer's note (`display_policy.free_text.note`). */
  readonly note?: string | null;
  readonly className?: string;
}

export function UncheckedText({ text, max, labelled = false, note = null, className }: UncheckedTextProps) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const v = uncheckedView(text, { ...(max !== undefined ? { max } : {}), note });
  return (
    <span className={className} data-unchecked-text="">
      <span>{open ? v.full : v.shown}</span>
      {v.truncated ? (
        <button type="button" className="ml-1 underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
      {labelled ? null : <span className="ml-1 opacity-70">({v.note})</span>}
    </span>
  );
}

/** The panel-level label (C3), shown once where several unchecked texts are listed. */
export function UncheckedNote({ note = null, className }: { readonly note?: string | null; readonly className?: string }) {
  return <span className={className}>{note || UNCHECKED_NOTE}</span>;
}
