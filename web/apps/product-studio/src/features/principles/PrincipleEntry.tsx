import { useState } from "react";
import { Archive, Pencil, ShieldCheck } from "lucide-react";
import { ArtifactId, Button, ConfirmDialog, Heading, StatusPill, plain, toast } from "@mach/ui";
import { failureText, type Principle } from "@mach/ui/api";
import { client } from "../../api/client";
import { toApiError } from "../../api/session";

/**
 * One principle as a ledger entry: its ID and revision in the margin, its name, then the statement
 * itself, which is the rule every slice quotes, set large. Keywords written in capitals for the
 * check are lowered for reading. Text is shown as text, never as markup.
 */
export function PrincipleEntry({ principle, onChange, onRetired }: { principle: Principle; onChange?: () => void; onRetired?: () => void }) {
  const retired = principle.status !== "active";
  const headingId = `principle-${principle.id}`;
  return (
    <li className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-6 gap-y-2 border-t border-line py-6 first:border-t-0 first:pt-0">
      <div className="flex flex-col items-start gap-1 pt-0.5">
        <ArtifactId>{principle.id}</ArtifactId>
        <span className="text-caption text-ink-subtle tabular">revision {principle.revision}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Heading level={3} size="title-3" id={headingId} className={retired ? "text-ink-muted" : undefined}>
            {principle.title}
          </Heading>
          {retired ? (
            <StatusPill size="sm" tone="neutral" icon={<Archive aria-hidden="true" />} title="Slices no longer answer it. Its number is never used again.">
              Retired
            </StatusPill>
          ) : (
            <StatusPill size="sm" tone="success" icon={<ShieldCheck aria-hidden="true" />} title="Every slice marked ready after it was published must say how it keeps it.">
              In force
            </StatusPill>
          )}
        </div>
        <p className={retired ? "max-w-reading text-body-lg text-ink-muted" : "max-w-reading text-title-3 font-semibold text-ink"}>{plain(principle.statement)}</p>
        <p className="max-w-reading text-body-sm text-ink-muted">
          <span className="font-semibold text-ink">Why: </span>
          {principle.reason}
        </p>
        {!retired && onChange && onRetired ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={onChange}>
              <Pencil aria-hidden="true" />
              Change {principle.id}
            </Button>
            <RetireButton principle={principle} onRetired={onRetired} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** Retire: slices stop answering it, and it never comes back. On the product manager's word. */
function RetireButton({ principle, onRetired }: { principle: Principle; onRetired: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ReturnType<typeof failureText> | null>(null);
  const id = principle.id;

  const retire = async () => {
    setError(null);
    try {
      await client.op("principle.retire", { principle_id: id });
      toast({ tone: "success", title: `Retired ${id}`, description: "Slices no longer answer it. The builders hear of it when you publish the principles." });
      onRetired();
      return true;
    } catch (cause) {
      setError(failureText(toApiError(cause, "principle.retire"), `${id} was not retired`));
      return false;
    }
  };

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Archive aria-hidden="true" />
        Retire {id}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(null);
        }}
        title={`Retire ${id}?`}
        description="Slices stop answering it, and it cannot be brought back: to have the rule again, add a new principle. It stays listed as retired so its number is never used again. The builders hear of it when you publish the principles."
        confirmLabel={`Retire ${id}`}
        cancelLabel="Keep it in force"
        tone="danger"
        onConfirm={retire}
        error={error}
      >
        <p className="rounded-md bg-surface-sunken px-4 py-3 text-body text-ink">{plain(principle.statement)}</p>
      </ConfirmDialog>
    </>
  );
}
