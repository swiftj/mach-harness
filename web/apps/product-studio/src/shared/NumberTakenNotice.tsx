import { useState } from "react";
import { Banner, Button } from "@mach/ui";
import type { SameMoment, SliceGithub } from "@mach/ui/api";
import { IssueText } from "./IssueLink";
import { RenumberDialog } from "./RenumberDialog";
import { epicNumberTakenWords, momentUrls, numberTakenWords } from "./team";

/**
 * On a slice's own pages (M20): another slice on GitHub holds this draft's number, taken at the same moment or before.
 * Who holds it and which issue, from the engine's record, each issue linked. No step of its own: marking the slice ready
 * (on the same page) gives it the next free number in the same act.
 */
export function NumberTakenNotice({ sliceId, github }: { sliceId: string; github: Pick<SliceGithub, "number_taken" | "same_moment"> }) {
  const words = numberTakenWords(sliceId, github);
  if (!words) return null;
  return (
    <Banner tone="info" title={words.title}>
      <IssueText text={words.body} urls={momentUrls(github.same_moment)} />
    </Banner>
  );
}

/**
 * On an epic's row and its own page (M20): someone else's issue for a different epic took this draft's number at the same
 * moment, and this person's was closed. The same notice and the same one act as a slice's: a new number.
 */
export function EpicNumberTakenNotice({
  epicId,
  moment,
  className,
  onRenumbered,
}: {
  epicId: string;
  moment: SameMoment | null | undefined;
  className?: string;
  /** The epic's own page moves to the new number. */
  onRenumbered?: (renumbered: { from: string; to: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const words = epicNumberTakenWords(epicId, moment);
  if (!words) return null;
  return (
    <>
      <Banner
        tone="warning"
        title={words.title}
        className={className}
        actions={
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            Give it a new number
          </Button>
        }
      >
        <IssueText text={words.body} urls={momentUrls(moment)} />
      </Banner>
      <RenumberDialog id={open ? epicId : null} onOpenChange={setOpen} onRenumbered={onRenumbered} />
    </>
  );
}
