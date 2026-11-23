import { useState } from "react";
import { useNavigate } from "react-router";
import { Banner, Button } from "@mach/ui";
import type { SliceGithub } from "@mach/ui/api";
import { RenumberDialog } from "./RenumberDialog";
import { numberTakenWords } from "./team";

/**
 * On a slice's own pages (M20): another slice on GitHub holds this draft's number, taken at the same moment or before.
 * Who holds it and which issue, from the engine's record, and the one act: a new number. After it, the page moves to the
 * new number, where the slice is marked ready again.
 */
export function NumberTakenNotice({ sliceId, github }: { sliceId: string; github: Pick<SliceGithub, "number_taken" | "same_moment"> }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const words = numberTakenWords(sliceId, github);
  if (!words) return null;
  return (
    <>
      <Banner
        tone="warning"
        title={words.title}
        actions={
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            Give it a new number
          </Button>
        }
      >
        {words.body}
      </Banner>
      <RenumberDialog id={open ? sliceId : null} onOpenChange={setOpen} onRenumbered={({ to }) => void navigate(`/slices/${to}`, { replace: true })} />
    </>
  );
}
