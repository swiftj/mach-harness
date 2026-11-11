import { TriangleAlert } from "lucide-react";
import { formatWhen } from "@mach/ui";
import type { ApprovalWithdrawn } from "@mach/ui/api";

/** On a slice or a wave whose approval the engine withdrew: what happened and when, in its words. */
export function WithdrawnNote({ item, className }: { item: ApprovalWithdrawn | undefined; className?: string }) {
  if (!item) return null;
  return (
    <p className={`flex items-start gap-2 text-body-sm text-warning-ink ${className ?? ""}`}>
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        <span className="font-semibold">Your approval was withdrawn.</span> {item.reason ?? ""}
        {item.at ? <span className="text-ink-muted"> ({formatWhen(item.at)})</span> : null}
      </span>
    </p>
  );
}
