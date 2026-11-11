import { ArtifactId, ConfirmDialog, toast } from "@mach/ui";
import type { StatusEpicRow } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";

export interface ApproveEpicDialogProps {
  epic: Pick<StatusEpicRow, "epic_id" | "title"> | null;
  /** Titles of the slices in this epic, to say what approval unlocks. */
  sliceTitles?: string[];
  onOpenChange: (open: boolean) => void;
}

/** Approving an epic is the PM's own act: always confirmed, saying what it means and what it does not. */
export function ApproveEpicDialog({ epic, sliceTitles = [], onOpenChange }: ApproveEpicDialogProps) {
  const act = useEngineAct();
  return (
    <ConfirmDialog
      open={epic !== null}
      onOpenChange={(open) => {
        if (!open) act.reset();
        onOpenChange(open);
      }}
      title={epic ? `Approve ${epic.epic_id}: ${epic.title}?` : ""}
      description="Approving puts this capability in the product's scope, so its slices can be approved one by one. It is product approval only: nothing is sent to engineering and no work starts."
      confirmLabel="Approve epic"
      error={act.shown}
      onConfirm={async () => {
        if (!epic) return;
        const result = await act.run("epic.approve", { epic_id: epic.epic_id });
        if (!result) return false;
        toast({ tone: "success", title: `Approved ${epic.epic_id}`, description: "Its slices can now be approved. Nothing has been sent to engineering." });
      }}
    >
      {sliceTitles.length ? (
        <div className="rounded-md bg-surface-sunken px-4 py-3">
          <p className="text-label text-ink">Slices in this epic</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-body-sm text-ink-muted">
            {sliceTitles.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        </div>
      ) : epic ? (
        <p className="text-body-sm text-ink-muted">
          <ArtifactId>{epic.epic_id}</ArtifactId> has no slices yet. You can start them after approving, or before.
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
