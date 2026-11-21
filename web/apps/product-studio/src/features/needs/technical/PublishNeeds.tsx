import { forwardRef, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleDashed, FolderOpen, GitBranch, PenLine, RefreshCw, TriangleAlert, Upload } from "lucide-react";
import { Button, ConfirmDialog, Dialog, DialogClose, DialogContent, Heading, HintAction, RelativeTime, StatusPill, Text, toast } from "@mach/ui";
import { describeError, type MachApiError, type NeedList } from "@mach/ui/api";
import { client } from "../../../api/client";
import { useEngineAct } from "../../../api/act";
import { toApiError } from "../../../api/session";
import { reloadStatus } from "../../../api/store";
import { IssueLink, SignInNote } from "../../../shared/IssueLink";
import { Fold } from "../../../shared/layout/Fold";
import { countWords, isNeedsReconcileHint, publishLook, publishOutcome, unansweredNames, unpublishedWords, type PublishOutcome, type PublishState } from "./model";

const glyphs: Record<(typeof publishLook)[PublishState]["glyph"], ReactNode> = {
  dashed: <CircleDashed aria-hidden="true" />,
  check: <CircleCheck aria-hidden="true" />,
  pen: <PenLine aria-hidden="true" />,
  alert: <TriangleAlert aria-hidden="true" />,
  branch: <GitBranch aria-hidden="true" />,
};

/**
 * Where the needs stand with the engineer: the engine's flags as a word, a shape and a tone, what is not published in
 * a sentence, and the facts of the last publish behind a fold. After a publish on this page, where it went and the
 * engine's ways on (the folder to commit) stay here, in its words. The publish act itself is in the context row.
 */
export function PublishedState({
  state,
  list,
  outcome,
  checking,
  onCheckGithub,
}: {
  state: PublishState;
  list: NeedList;
  /** The last publish made on this page, kept so its ways on stay in view after the dialog closes. */
  outcome: PublishOutcome | null;
  checking: boolean;
  onCheckGithub: () => void;
}) {
  const look = publishLook[state];
  const p = list.published;
  return (
    <section aria-labelledby="needs-engineer" className="flex flex-col gap-3 rounded-md border border-line bg-canvas px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Heading level={2} size="title-3" id="needs-engineer">
          With the engineer
        </Heading>
        <StatusPill tone={look.tone} icon={glyphs[look.glyph]} className={state === "never-published" || state === "none" ? "border-dashed" : undefined}>
          {look.word}
        </StatusPill>
      </div>
      <Text size="body-sm" tone="muted" className="max-w-reading">
        {unpublishedWords(state, list)}
      </Text>
      {outcome ? (
        <div className="flex flex-col gap-2">
          <p className="text-label text-ink">You published version {outcome.revision} from this page</p>
          <Outcome outcome={outcome} />
        </div>
      ) : null}
      {p.saved ? (
        <Fold label="Where they are published">
          <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 pt-2 text-body-sm">
            <dt className="text-ink-muted">Published version</dt>
            <dd className="text-ink tabular">{p.revision !== null ? `Version ${p.revision}` : "not recorded"}</dd>
            <dt className="text-ink-muted">Where</dt>
            <dd className="text-ink">
              {p.saved === "github" ? (
                p.issue !== null ? (
                  <>
                    The project&apos;s issue <IssueLink number={p.issue} url={p.url} />
                  </>
                ) : (
                  "The project's issue on GitHub"
                )
              ) : (
                "A folder in your workspace, for you to commit"
              )}
            </dd>
            {p.saved === "github" ? (
              <>
                <dt className="text-ink-muted">Approved by</dt>
                <dd className="text-ink">
                  {p.approved_by ? (
                    <span translate="no" className="font-mono">
                      {p.approved_by}
                    </span>
                  ) : (
                    "not recorded"
                  )}
                </dd>
              </>
            ) : null}
            <dt className="text-ink-muted">Published</dt>
            <dd className="text-ink">{p.published_at ? <RelativeTime iso={p.published_at} /> : "not recorded"}</dd>
            {p.github ? (
              <>
                <dt className="text-ink-muted">GitHub last read</dt>
                <dd className="text-ink">{p.github.read_at ? <RelativeTime iso={p.github.read_at} /> : "not recorded"}</dd>
              </>
            ) : null}
          </dl>
          {p.saved === "github" || p.github ? (
            <div className="pt-2">
              <Button size="sm" variant="ghost" loading={checking} onClick={onCheckGithub}>
                <RefreshCw aria-hidden="true" />
                Check GitHub again
              </Button>
            </div>
          ) : null}
        </Fold>
      ) : null}
    </section>
  );
}

/**
 * Publish the technical needs: the product manager's approval of exactly this set, confirmed as the other publish acts
 * in the app are. The dialog says both places they can go, since the engine decides between GitHub and the folder only
 * when it runs; after it runs, it says where they went and what to commit, in the engine's words.
 */
export function PublishNeedsDialog({
  open,
  onOpenChange,
  list,
  label,
  repository,
  onPublished,
  onFailed,
  onChooseVersion,
  focusOnClose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  list: NeedList;
  /** The act's name in this state ("Publish the needs", "Publish the changes", "Finish publishing"). */
  label: string;
  repository: string | null;
  onPublished: (outcome: PublishOutcome) => void;
  onFailed: (error: MachApiError) => void;
  onChooseVersion: () => void;
  focusOnClose?: () => HTMLElement | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);

  const publish = () => {
    setBusy(true);
    setError(null);
    client.op("need.publish", {}).then(
      async (result) => {
        await reloadStatus();
        const done = publishOutcome(result);
        setBusy(false);
        setOutcome(done);
        onPublished(done);
        toast({ tone: "success", title: `Published version ${result.revision} of the technical needs`, description: result.note });
      },
      (cause: unknown) => {
        const failure = toApiError(cause, "need.publish");
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
    setOutcome(null);
  };

  const returnFocus = (event: Event) => {
    const target = focusOnClose?.();
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  const where = repository ? `the project's issue in ${repository}` : "the project's issue on GitHub";
  const replaces = list.published.revision !== null ? ` It replaces version ${list.published.revision}.` : "";
  const unanswered = unansweredNames(list);

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
          title={label === "Finish publishing" ? "Finish publishing the technical needs?" : "Publish the technical needs?"}
          description={`This saves every need, active and retired, where the engineer reads them: on ${where}, with a record that you approved exactly this version, and in a folder for you to commit.${replaces} No decision is taken and no work starts.`}
          footer={
            <>
              <DialogClose asChild>
                <Button disabled={busy}>Not now</Button>
              </DialogClose>
              <Button variant="primary" loading={busy} onClick={publish}>
                <Upload aria-hidden="true" />
                {label}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4 pb-1">
            {error ? <Refusal error={error} onChooseVersion={onChooseVersion} /> : null}
            <div className="flex flex-col gap-2 rounded-md bg-surface-sunken px-4 py-3">
              <p className="text-label text-ink">What is published</p>
              <Text size="body-sm">
                {countWords(list.active.length, list.retired.length)}
                {list.nothing_to_say.length ? `, and ${list.nothing_to_say.length === 1 ? "1 kind" : `${list.nothing_to_say.length} kinds`} with nothing to say` : ""}. Retired needs go too, so their numbers are never used again.
              </Text>
              {unanswered.length ? (
                <Text size="body-sm" tone="muted">
                  Not answered yet, and published as not answered: {unanswered.join(", ")}.
                </Text>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-label text-ink">If GitHub cannot be used from this computer</p>
              <Text size="body-sm" tone="muted">
                When the GitHub tool is not installed, you are not signed in, or the project has no GitHub repository, the needs are saved only to the folder, for you to commit. If GitHub is only out of reach for now, nothing is saved and you can publish again later.
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
  const title = error.kind === "refused" ? "The technical needs were not published" : described.title;
  const message = error.kind === "refused" ? error.message : described.message;
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-label text-danger-ink">{title}</p>
        <p className="whitespace-pre-line text-body-sm text-ink">{message}</p>
        <div className="pt-1">
          {isNeedsReconcileHint(error.hint) ? (
            // The choice is on this page, so the hint leads there rather than to another page.
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

/** Where the needs went: the project's issue when GitHub was used, and always the folder with the engine's ways on. */
export function Outcome({ outcome }: { outcome: PublishOutcome }) {
  return (
    <div className="flex flex-col gap-3">
      {outcome.github ? (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-surface px-4 py-3">
          <p className="text-label text-ink">Saved on GitHub</p>
          <p className="text-body">
            On the project&apos;s issue <IssueLink number={outcome.github.issue} url={outcome.github.url} />, as version <span className="tabular">{outcome.revision}</span>. Approved as{" "}
            <span translate="no" className="font-mono text-body-sm">
              {outcome.github.approvedBy}
            </span>
            .
          </p>
          <SignInNote />
        </div>
      ) : null}
      <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-4 py-3">
        <p className="flex items-center gap-2 text-label text-ink">
          <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
          {outcome.github ? "Also saved to a folder, to commit" : "Saved to a folder, to commit"}
        </p>
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
    </div>
  );
}

/**
 * Someone else published newer technical needs while this workspace has changes that are not published. Two equal
 * choices, mine or theirs, each confirmed; the app never picks a side. Focusable, so a refused publish can lead here.
 */
export const ReconcileNeedsChoice = forwardRef<HTMLElement, { list: NeedList; busy: boolean; onChosen: () => void }>(function ReconcileNeedsChoice({ list, busy, onChosen }, ref) {
  const [take, setTake] = useState<"mine" | "theirs" | null>(null);
  const act = useEngineAct();
  const theirs = list.published.github;
  const version = theirs?.revision != null ? `version ${theirs.revision}` : "their version";
  const words = {
    theirs: {
      button: "Take their version",
      title: `Take ${version} from GitHub?`,
      description: "Their technical needs replace yours here, and the changes you have not published are dropped. Nothing is published by taking them: the engineer already has their version.",
      done: "Took the technical needs from GitHub",
    },
    mine: {
      button: "Keep mine",
      title: "Keep your technical needs?",
      description: `Your technical needs stay as they are here. When you publish them, they replace ${version} on GitHub.`,
      done: "Kept your technical needs",
    },
  } as const;

  const choose = async () => {
    if (!take) return false;
    const result = await act.run("reconcile.needs", { take });
    if (!result) return false;
    toast({ tone: "success", title: words[take].done, description: result.note });
    onChosen();
    return true;
  };

  return (
    <section ref={ref} tabIndex={-1} aria-labelledby="needs-newer" className="flex flex-col gap-3 rounded-md border border-info-line bg-info-soft px-4 py-4 outline-offset-2">
      <div className="flex items-start gap-2">
        <GitBranch aria-hidden="true" className="mt-1 size-[18px] shrink-0 text-info-ink" />
        <Heading level={2} size="title-3" id="needs-newer">
          Someone else published newer technical needs
        </Heading>
      </div>
      <Text size="body-sm">
        GitHub holds {version} of the technical needs
        {theirs?.approved_by ? (
          <>
            , approved by{" "}
            <span translate="no" className="whitespace-nowrap font-mono">
              {theirs.approved_by}
            </span>
          </>
        ) : null}
        {list.published.revision !== null ? `, newer than version ${list.published.revision}, which you published` : ""}. You also have changes here that are not published. Choose which to go on from.
      </Text>
      {theirs?.read_at ? (
        <Text size="caption" tone="muted">
          GitHub was last read <RelativeTime iso={theirs.read_at} />.
        </Text>
      ) : null}
      {/* Two equal choices: the same look, side by side; neither is recommended. */}
      <div className="grid grid-cols-2 gap-2">
        <Button disabled={busy} onClick={() => setTake("mine")}>
          {words.mine.button}
        </Button>
        <Button disabled={busy} onClick={() => setTake("theirs")}>
          {words.theirs.button}
        </Button>
      </div>
      {busy ? (
        <Text size="caption" tone="muted">
          Waits until the conversation has finished writing.
        </Text>
      ) : null}
      <ConfirmDialog
        open={take !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTake(null);
            act.reset();
          }
        }}
        title={take ? words[take].title : ""}
        description={take ? words[take].description : ""}
        confirmLabel={take ? words[take].button : ""}
        onConfirm={choose}
        error={act.shown ? { ...act.shown, title: act.error?.kind === "refused" ? "Nothing was chosen" : act.shown.title } : null}
      />
    </section>
  );
});
