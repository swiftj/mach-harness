import { useState } from "react";
import { Button, Quote, Skeleton } from "@mach/ui";
import { useOperation } from "../../../api/useOperation";

/** How much of a reason a card shows before "Show all". */
const shownLimit = 220;

/**
 * The verdict's reason, quoted as the product manager's own words. The board's rows carry the verdict but not its
 * reason, so each decided card reads its idea (`idea.show`). Shown as text, never as markup; long reasons are cut with
 * "Show all" on request.
 */
export function VerdictReason({ ideaId }: { ideaId: string }) {
  const shown = useOperation("idea.show", { idea_id: ideaId });
  const [all, setAll] = useState(false);
  if (!shown.data && shown.loading) {
    return (
      <div role="status" aria-label="Reading the reason" aria-busy="true" className="flex flex-col gap-1.5 border-l-2 border-line-strong pl-3">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-3/5" />
      </div>
    );
  }
  if (!shown.data) {
    return (
      <p className="text-caption text-ink-muted">
        The reason could not be read just now.{" "}
        <Button variant="ghost" size="sm" onClick={shown.reload} className="-my-1">
          Read it again
        </Button>
      </p>
    );
  }
  const reason = shown.data.verdict?.reason?.trim() ?? "";
  if (!reason) return <p className="text-caption text-ink-subtle">Reason not recorded.</p>;
  const long = reason.length > shownLimit;
  const text = long && !all ? `${reason.slice(0, shownLimit).trimEnd()}…` : reason;
  return (
    <div className="flex flex-col items-start gap-1">
      <Quote from="Product manager" kind="gave this reason" className="pl-3 [&_blockquote]:whitespace-pre-line [&_blockquote]:text-body-sm [&_figcaption]:text-caption">
        {text}
      </Quote>
      {long ? (
        <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
}
