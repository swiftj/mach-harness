import { useRef, useState } from "react";
import { Button, Dialog, DialogClose, DialogContent, DialogTrigger, ErrorState, Field, Input, Quote, Textarea, describeError, plain, toast } from "@mach/ui";
import type { MachApiError } from "@mach/ui/api";
import { client } from "../../api/client";
import { toApiError } from "../../api/session";
import { reloadStatus } from "../../api/store";
import { acceptArgs, acceptFormErrors, checkWords, type AcceptResult, type ConcernRow } from "./model";

/**
 * Record a policy owner's acceptance of one open concern (`policy.accept`). It is the owner's
 * decision, recorded on the product manager's word that the owner gave it; the screen never
 * recommends it. The engine checks the name against the pack's owner where the owner lists GitHub
 * logins, and refuses in its own words, shown here as written.
 */
export function AcceptConcernDialog({ sliceId, concern, onDone }: { sliceId: string; concern: ConcernRow & { pack: string }; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [by, setBy] = useState("");
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const errors = tried ? acceptFormErrors(by, reason) : {};

  const reset = () => {
    setBy("");
    setReason("");
    setTried(false);
    setError(null);
  };

  const record = () => {
    setTried(true);
    const problems = acceptFormErrors(by, reason);
    if (problems.by || problems.reason) return;
    setBusy(true);
    setError(null);
    client.op("policy.accept", acceptArgs(sliceId, concern.statementId, by, reason)).then(
      (answer) => {
        const result = answer as AcceptResult;
        setBusy(false);
        setOpen(false);
        reset();
        toast({
          tone: "success",
          title: `Recorded the owner's acceptance of ${result.accepted}`,
          description: [result.owner_check !== undefined ? checkWords(result.owner_check) : null, result.owner_check_note, result.note].filter(Boolean).join(" "),
        });
        void reloadStatus();
        onDone();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(toApiError(cause, "policy.accept"));
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary">Record the owner&apos;s acceptance</Button>
      </DialogTrigger>
      <DialogContent
        width="lg"
        title={`Record the owner's acceptance of ${concern.statementId}?`}
        description="This writes into the specification that the policy's owner accepts this concern, with their name and their reason in their own words. It is the owner's decision, not yours: record it only when they have given it. It does not change the policy."
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          nameRef.current?.focus();
        }}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={busy}>
                Not now
              </Button>
            </DialogClose>
            <Button variant="primary" loading={busy} onClick={record}>
              Record the acceptance
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 pb-1">
          {error ? (
            <ErrorState
              title={error.kind === "refused" ? "The acceptance was not recorded" : describeError(error).title}
              message={error.kind === "refused" ? error.message : describeError(error).message}
              hint={error.hint}
            />
          ) : null}
          <Quote from={concern.statementId} kind={`in ${concern.pack}, owned by ${concern.owner}`}>
            {plain(concern.statement)}
          </Quote>
          <Field
            label="Who accepted it"
            hint="The owner's GitHub login, or their name or role. Where the pack's owner lists GitHub logins, the name is checked against them; otherwise it is recorded as given."
            error={errors.by}
          >
            <Input ref={nameRef} value={by} onChange={(event) => setBy(event.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Their reason, in their own words" hint="Write it as the owner gave it. It is kept in the specification exactly as written." error={errors.reason}>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={4} />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}
