import { useState } from "react";
import { CircleAlert, Upload } from "lucide-react";
import { Button, Dialog, DialogClose, DialogContent, HintAction, Text, toast } from "@mach/ui";
import { describeError, type MachApiError } from "@mach/ui/api";
import { client } from "../../api/client";
import { toApiError } from "../../api/session";
import { reloadStatus } from "../../api/store";
import { IssueLink, SignInNote } from "../../shared/IssueLink";
import { countWords, isPrinciplesReconcileHint, publishOutcome, type PublishOutcome } from "./model";

export interface PublishFacts {
  active: number;
  retired: number;
  /** The version the builders have now, if any. */
  publishedRevision: number | null;
  /** The repository the project's issues live in, as status reports it. */
  repository: string | null;
}

/**
 * Publish the principles: the product manager's approval of exactly this set, confirmed here as
 * "Mark ready to build" is. The dialog says both places they can go, since the engine decides
 * between GitHub and the folder only when it runs; after it runs, it says where they went.
 */
export function PublishDialog({
  open,
  onOpenChange,
  facts,
  onPublished,
  onFailed,
  onChooseVersion,
  again,
  focusOnClose,
}: {
  /** Where focus goes when the dialog closes, when not back to the button that opened it. */
  focusOnClose?: () => HTMLElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facts: PublishFacts;
  onPublished: () => void;
  /** A failure is also kept on the page after the dialog closes, so "not published" stays plain. */
  onFailed: (error: MachApiError) => void;
  /** The engine refused because someone else published a newer version: go to the choice. */
  onChooseVersion: () => void;
  /** Publishing to finish a run that stopped part way. */
  again: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);

  const publish = () => {
    setBusy(true);
    setError(null);
    client.op("principle.publish", {}).then(
      async (result) => {
        await reloadStatus();
        setBusy(false);
        setOutcome(publishOutcome(result));
        toast({ tone: "success", title: `Published version ${result.revision} of the principles`, description: result.note });
      },
      (cause: unknown) => {
        const failure = toApiError(cause, "principle.publish");
        setBusy(false);
        setError(failure);
        onFailed(failure);
      },
    );
  };

  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (next) return;
    setError(null);
    if (outcome) {
      setOutcome(null);
      onPublished();
    }
  };

  const returnFocus = (event: Event) => {
    const target = focusOnClose?.();
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  const where = facts.repository ? `the project's issue in ${facts.repository}` : "the project's issue on GitHub";
  const replaces = facts.publishedRevision !== null ? ` It replaces version ${facts.publishedRevision}.` : "";

  return (
    <Dialog open={open} onOpenChange={close}>
      {outcome ? (
        <DialogContent
          width="lg"
          title={`Version ${outcome.revision} is published`}
          description={outcome.note}
          footer={
            <DialogClose asChild>
              {/* The confirming button is gone; focus moves to the one way out. */}
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <Button variant="primary" autoFocus>
                Done
              </Button>
            </DialogClose>
          }
        >
          <div className="pb-1">
            <Outcome outcome={outcome} />
          </div>
        </DialogContent>
      ) : (
        <DialogContent
          width="lg"
          onCloseAutoFocus={returnFocus}
          title={again ? "Finish publishing the principles?" : "Publish the principles?"}
          description={`This saves every principle, in force and retired, where the builders read them: on ${where}, with a record that you approved exactly this version.${replaces} Slices marked ready from then on must say how they keep them.`}
          footer={
            <>
              <DialogClose asChild>
                <Button disabled={busy}>Not now</Button>
              </DialogClose>
              <Button variant="primary" loading={busy} onClick={publish}>
                <Upload aria-hidden="true" />
                {again ? "Finish publishing" : "Publish the principles"}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4 pb-1">
            {error ? <Refusal error={error} onChooseVersion={onChooseVersion} /> : null}
            <div className="flex flex-col gap-2 rounded-md bg-surface-sunken px-4 py-3">
              <p className="text-label text-ink">What is published</p>
              <Text size="body-sm">{countWords(facts.active, facts.retired)}. Retired principles go too, so their numbers are never used again.</Text>
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-label text-ink">If GitHub cannot be used from this computer</p>
              <Text size="body-sm" tone="muted">
                When the GitHub tool is not installed, you are not signed in, or the project has no GitHub repository, the principles are saved to a folder in your workspace instead, for you to commit. If GitHub is only out of reach for now, nothing is saved and you can publish again later.
              </Text>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function Refusal({ error, onChooseVersion }: { error: MachApiError; onChooseVersion: () => void }) {
  const described = describeError(error);
  const title = error.kind === "refused" ? "The principles were not published" : described.title;
  const message = error.kind === "refused" ? error.message : described.message;
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-label text-danger-ink">{title}</p>
        <p className="whitespace-pre-line text-body-sm text-ink">{message}</p>
        <div className="pt-1">
          {isPrinciplesReconcileHint(error.hint) ? (
            // The choice is on this screen, so the hint leads there rather than to another page.
            <Button size="sm" onClick={onChooseVersion}>
              Choose a version
            </Button>
          ) : (
            <HintAction hint={error.hint} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Where the principles went: the project's issue, or the folder and the engine's ways on. */
export function Outcome({ outcome }: { outcome: PublishOutcome }) {
  if (outcome.where === "github") {
    return (
      <div className="flex flex-col gap-1 rounded-md border border-line bg-surface px-4 py-3">
        <p className="text-label text-ink">Saved on GitHub</p>
        <p className="text-body">
          On the project&apos;s issue <IssueLink number={outcome.issue} url={outcome.url} />, as version <span className="tabular">{outcome.revision}</span>. Approved as{" "}
          <span translate="no" className="font-mono text-body-sm">
            {outcome.approvedBy}
          </span>
          .
        </p>
        <SignInNote />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-4 py-3">
      <p className="text-label text-ink">Saved to a folder</p>
      {outcome.whyFolder ? (
        <Text size="body-sm" tone="muted">
          {outcome.whyFolder}
        </Text>
      ) : null}
      <p translate="no" className="break-all font-mono text-body-sm text-ink">
        {outcome.folder}
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-body">
        {outcome.waysOn.map((way) => (
          <li key={way}>{way}</li>
        ))}
      </ul>
    </div>
  );
}
