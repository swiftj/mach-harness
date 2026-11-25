import { useState } from "react";
import { Button, ConfirmDialog, toast } from "@mach/ui";
import { failureText } from "@mach/ui/api";
import { useEngineAct } from "../api/act";

/**
 * M20: the repository has more than one project issue. MACH already carries on with one and said so; this is the fix it
 * offers, as the person's one yes: close an extra issue (`project.close-issue`), confirmed once. Its text stays in its
 * history on GitHub, and nothing in the person's work changes.
 */
export function CloseProjectIssue({ number, size = "sm" }: { number: number; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const act = useEngineAct();
  const close = async () => {
    const result = await act.run("project.close-issue", { number });
    if (!result) return false;
    toast({ tone: "success", title: `Closed #${result.closed} on GitHub`, description: result.note });
    return true;
  };
  return (
    <>
      <Button
        size={size}
        variant="secondary"
        onClick={() => {
          act.reset();
          setOpen(true);
        }}
      >
        Close #{number}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Close project issue #${number} on GitHub?`}
        description={`MACH closes #${number} and takes its MACH labels off, so the repository is left with one project issue. Its text stays in its history on GitHub. Nothing in your work changes.`}
        confirmLabel={`Close #${number}`}
        onConfirm={close}
        error={act.error ? failureText(act.error, `#${number} was not closed`) : null}
      />
    </>
  );
}

/** One button for each extra project issue, side by side. Nothing when there is none. */
export function CloseProjectIssues({ numbers }: { numbers: number[] }) {
  if (!numbers.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {numbers.map((n) => (
        <CloseProjectIssue key={n} number={n} />
      ))}
    </span>
  );
}
