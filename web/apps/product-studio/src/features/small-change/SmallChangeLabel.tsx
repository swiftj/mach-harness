import { Feather } from "lucide-react";
import { Badge } from "@mach/ui";
import { smallLabel } from "./model";

type LabelProps = { slice: Parameters<typeof smallLabel>[0]; className?: string };

/**
 * "Small change", wherever a slice is listed or named (M18): a fact about how the slice started, so a badge (style guide
 * 7.6) with its own glyph and word, never colour alone. Nothing for a full slice, and nothing once a small change became
 * a full slice; its page says that instead (WidenedNote).
 */
export function SmallChangeLabel({ slice, className }: LabelProps) {
  const label = smallLabel(slice);
  if (!label) return null;
  return (
    <Badge tone="neutral" outline title={label.description} className={className}>
      <Feather aria-hidden="true" className="size-3.5" />
      {label.word}
    </Badge>
  );
}
