import { useState } from "react";
import { ConfirmDialog, toast } from "@mach/ui";
import { failureText } from "@mach/ui/api";
import { client } from "../api/client";
import { toApiError } from "../api/session";

/**
 * Give a draft slice or epic the next free number, because another one on GitHub already uses its
 * number. The engine chooses the number and moves every reference; this only confirms the act.
 */
export function RenumberDialog({
  id,
  onOpenChange,
  onRenumbered,
}: {
  id: string | null;
  onOpenChange: (open: boolean) => void;
  /** After the engine gave the new number: a slice's page moves to it (M20), so marking it ready again is one step. */
  onRenumbered?: (renumbered: { from: string; to: string }) => void;
}) {
  const [error, setError] = useState<ReturnType<typeof failureText> | null>(null);
  const epic = id?.startsWith("EPIC-") ?? false;

  const renumber = async () => {
    if (!id) return false;
    setError(null);
    try {
      const result = await client.op(epic ? "epic.renumber" : "slice.renumber", { identifier: id });
      const next = epic ? "You can mark its slices ready now." : `You can mark it ready as ${result.renumbered.to}.`;
      toast({ tone: "success", title: `${result.renumbered.from} is now ${result.renumbered.to}`, description: `Everything that refers to it moved with it. ${next}` });
      onRenumbered?.(result.renumbered);
      return true;
    } catch (cause) {
      setError(failureText(toApiError(cause, "renumber"), `${id} was not given a new number`));
      return false;
    }
  };

  return (
    <ConfirmDialog
      open={id !== null}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setError(null);
      }}
      title={`Give ${id ?? ""} a new number?`}
      description={`Another ${epic ? "epic" : "slice"} on GitHub already uses this number. Your draft keeps everything it says and gets the next free number; everything that refers to it moves with it.`}
      confirmLabel="Give it a new number"
      onConfirm={renumber}
      error={error}
    />
  );
}
