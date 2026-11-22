import { useState } from "react";
import { Expand } from "lucide-react";
import { Banner, Button, ConfirmDialog, Field, RelativeTime, Textarea, describeError, formatExact, toast } from "@mach/ui";
import type { MachApiError, SliceShow } from "@mach/ui/api";
import { client } from "../../api/client";
import { toApiError } from "../../api/session";
import { MAX_WIDEN_REASON, SMALL_CHANGE_GROWS, SMALL_CHANGE_MEANS, canWiden, smallState, widenProblem, widenedLine } from "./model";

/**
 * On a slice's own page (M18): while it is a small change, what that means, which shipped rule a fix names, and the
 * product manager's act to make it a full slice; once it became a full slice, the line that says so, why and when.
 * Nothing for a slice started any other way.
 */
export function SmallChangeNotice({ show, onChanged }: { show: SliceShow; onChanged: () => void }) {
  const slice = show.slice;
  const state = smallState(slice);
  if (state === "full" && slice.widened) return <WidenedNote widened={slice.widened} />;
  if (state !== "small") return null;
  const rule = slice.small?.change === "fix" ? slice.small.shipped_rule : null;
  return (
    <Banner tone="info" title={rule ? `A small change: it fixes ${rule}` : "A small change: an adjustment"} actions={canWiden(slice, show.editable) ? <WidenDialog show={show} onDone={onChanged} /> : undefined}>
      {rule ? `${rule} has shipped and is not working as it should. ` : ""}
      {SMALL_CHANGE_MEANS} {SMALL_CHANGE_GROWS}
    </Banner>
  );
}

/** The line on a slice that began as a small change and is now a full slice: the reason, and when. */
export function WidenedNote({ widened }: { widened: NonNullable<SliceShow["slice"]["widened"]> }) {
  const line = widenedLine(widened);
  return (
    <Banner tone="info" title={line.lead}>
      <span className="flex flex-col gap-1">
        {line.byRule ? (
          <span>MACH checked it. {line.reason}</span>
        ) : (
          <span>
            You said why: <q className="italic">{line.reason}</q>
          </span>
        )}
        <span className="text-ink-muted">
          <span title={formatExact(line.at)}>
            Changed <RelativeTime iso={line.at} />.
          </span>{" "}
          The interview carries on in full, with every answer kept.
        </span>
      </span>
    </Banner>
  );
}

/** Make it a full slice, on the product manager's word, with their reason: confirmed in a dialog like every act. */
export function WidenDialog({ show, onDone }: { show: SliceShow; onDone: () => void }) {
  const id = show.slice.slice_id;
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);
  const problem = widenProblem(why);

  const widen = async (): Promise<boolean> => {
    setTried(true);
    if (problem) return false;
    setError(null);
    try {
      await client.op("slice.widen", { slice_id: id, why: why.trim() });
    } catch (cause) {
      setError(toApiError(cause, "slice.widen"));
      return false;
    }
    toast({ tone: "success", title: `Made ${id} a full slice`, description: "The interview carries on in full, with every answer kept." });
    setWhy("");
    setTried(false);
    onDone();
    return true;
  };

  const shown = error ? (error.kind === "refused" ? { title: `${id} was not changed`, message: error.message, hint: error.hint } : describeError(error)) : null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Expand aria-hidden="true" />
        Make it a full slice
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setError(null);
            setTried(false);
          }
        }}
        title={`Make ${id} a full slice?`}
        description="A full slice gets the whole interview, carrying on from every answer so far. Nothing in its spec or its why changes, and it does not become a small change again."
        confirmLabel="Make it a full slice"
        cancelLabel="Keep it a small change"
        onConfirm={widen}
        error={shown}
      >
        <Field
          label="Why it is more than a small change"
          hint={`In your own words, at most ${MAX_WIDEN_REASON} characters. It is kept with the slice.`}
          error={tried && problem ? problem : undefined}
        >
          <Textarea value={why} onChange={(event) => setWhy(event.target.value)} rows={3} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
