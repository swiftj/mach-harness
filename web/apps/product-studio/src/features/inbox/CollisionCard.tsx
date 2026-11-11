import { useState } from "react";
import { ArtifactId, Button, ConfirmDialog, Heading, SourceBadge, Text, toast, type Renumber, type Status } from "@mach/ui";
import { asApiError, deliveryOp } from "../waves/delivery/ops";
import { rememberNeedsApprovalAgain } from "../waves/delivery/memory";
import { failureText } from "../waves/delivery/ui";
import { titleFor } from "../waves/delivery/words";
import { Affects } from "./Affects";

const nouns: Record<string, string> = { SLICE: "slice", EPIC: "epic", WAVE: "delivery wave" };

/**
 * A different item in the shared project now holds this draft's number. Nothing is wrong with the
 * PM's work; it needs a new number, which the engine chooses. Every reference moves with it.
 */
export function CollisionCard({ id, status, onRenumbered }: { id: string; status: Status; onRenumbered: (result: Renumber) => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const prefix = id.split("-")[0] ?? "";
  const noun = nouns[prefix] ?? "item";
  const title = titleFor(status, id);
  const headingId = `collision-${id}`;

  const renumber = async () => {
    setError(null);
    try {
      const op = prefix === "EPIC" ? "epic.renumber" : prefix === "WAVE" ? "wave.renumber" : "slice.renumber";
      const result = await deliveryOp(op, { identifier: id });
      toast({ tone: "success", title: `${result.renumbered.from} is now ${result.renumbered.to}` });
      rememberNeedsApprovalAgain(result.needs_approval_again, `It was approved as ${result.renumbered.from} and was given a new number.`);
      onRenumbered(result);
      return true;
    } catch (cause) {
      setError(failureText(asApiError(cause, "renumber"), `${id} was not renumbered`));
      return false;
    }
  };

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border border-line bg-surface px-5 py-4">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Heading level={3} id={headingId} size="title-3">
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>Your {noun}</span>
              <ArtifactId className="text-body text-ink">{id}</ArtifactId>
              {title ? <span className="font-normal text-ink-muted">{title}</span> : null}
            </span>
          </Heading>
          <SourceBadge source="collision" />
        </div>
        <Affects status={status} id={id} />
      </header>
      <Text>
        Another product manager's work now uses the number <ArtifactId plain className="text-ink">{id}</ArtifactId> in the shared project.{" "}
        <span className="font-semibold">Nothing is wrong with your draft</span>; it only needs a different number before it can be shared.
      </Text>
      <div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Give my draft a new number
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(null);
        }}
        title={`Give ${id} a new number?`}
        description={`Your ${noun} keeps everything it says and gets the next free number. Everything that refers to it follows: its why, its specification, other drafts that depend on it, and draft waves that include it.`}
        confirmLabel="Give it a new number"
        onConfirm={renumber}
        error={error}
      >
        <Text size="body-sm">If it was approved, you will be asked to approve it again, because its text now carries the new number.</Text>
      </ConfirmDialog>
    </article>
  );
}
