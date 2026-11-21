import { useState } from "react";
import { Button, Quote } from "@mach/ui";

/** How much of a reason a card shows before "Show all". */
const shownLimit = 220;

/**
 * The verdict's reason, quoted as the product manager's own words, from the board's own row (the engine bounds it to one
 * line). Shown as text, never as markup; long reasons are cut with "Show all" on request.
 */
export function VerdictReason({ reason }: { reason: string | null | undefined }) {
  const [all, setAll] = useState(false);
  const text = (reason ?? "").trim();
  if (!text) return <p className="text-caption text-ink-subtle">Reason not recorded.</p>;
  const long = text.length > shownLimit;
  const shown = long && !all ? `${text.slice(0, shownLimit).trimEnd()}…` : text;
  return (
    <div className="flex flex-col items-start gap-1">
      <Quote from="Product manager" kind="gave this reason" className="pl-3 [&_blockquote]:whitespace-pre-line [&_blockquote]:text-body-sm [&_figcaption]:text-caption">
        {shown}
      </Quote>
      {long ? (
        <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
}
