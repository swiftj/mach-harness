import { Info } from "lucide-react";
import type { SliceReadyWidened } from "@mach/ui/api";
import { madeFullAtReady } from "./model";

/**
 * Inside the mark-ready dialog (M18): marking a small change ready found it is more than a small change, so MACH made it
 * a full slice instead. Not a success (nothing was saved) and not a failure (nothing went wrong): a neutral well with the
 * rule's sentence and the next step, in the dialog's own words. The dialog's title says it was not marked ready.
 */
export function MadeFullAtReady({ answer }: { answer: SliceReadyWidened }) {
  const said = madeFullAtReady(answer);
  return (
    <div className="flex flex-col gap-4 pb-1">
      <div className="flex gap-3 rounded-md border border-line bg-surface-sunken px-4 py-3">
        <Info aria-hidden="true" className="mt-0.5 size-[18px] shrink-0 text-ink-muted" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-label text-ink">It is a full slice now</p>
          {said.sentence ? <p className="text-body-sm text-ink">{said.sentence}</p> : null}
        </div>
      </div>
      <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-md border border-line bg-surface px-4 py-3 text-body">
        <dt className="text-label text-ink-muted">Saved</dt>
        <dd className="min-w-0">Nothing. It is not marked ready, and the builders have not been told.</dd>
        <dt className="text-label text-ink-muted">Your next step</dt>
        <dd className="min-w-0 font-semibold">{said.next}</dd>
      </dl>
    </div>
  );
}
