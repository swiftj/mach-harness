import { useState } from "react";
import { useNavigate } from "react-router";
import { CircleCheck, CircleDashed, FolderOpen, Hash, TriangleAlert, Upload } from "lucide-react";
import { ConfirmDialog, Banner, Button, Heading, StatusPill, Text, toast } from "@mach/ui";
import { failureText, type IdeaRow, type IdeaShow } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { useStatus } from "../../../api/store";
import { IssueLink, SignInNote } from "../../../shared/IssueLink";
import { ideaPath } from "../shell/steps";
import { publishAct, publishOutcome, publishState, renumberOffered, whatIsSaved, type PublishOutcome, type PublishState } from "./model";

const publishHeading = () => document.getElementById("publish-h");

/**
 * Saving the idea for others to read: the brief as an issue's body and the verdict as a signed comment, or the folder
 * form where GitHub cannot be used. Its own explicit act, confirmed in a dialog that says exactly what goes where. The
 * case is never published.
 */
export function PublishSection({ row, show, onChanged }: { row: IdeaRow; show: IdeaShow; onChanged: () => void }) {
  const state = publishState(show.idea.github);
  const offered = publishAct(state, row.next.kind);
  const status = useStatus();
  const repository = status.data?.github.repository ?? null;
  const navigate = useNavigate();
  const publish = useEngineAct();
  const renumber = useEngineAct();
  const [asking, setAsking] = useState(false);
  const [renumbering, setRenumbering] = useState(false);
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);
  const saved = whatIsSaved(show);

  const doPublish = async () => {
    const result = await publish.run("idea.publish", { idea_id: row.idea_id });
    if (!result) return false;
    const done = publishOutcome(result);
    setOutcome(done);
    toast({ tone: "success", title: done.where === "github" ? `Saved ${row.idea_id} as issue #${done.issue}` : `Saved ${row.idea_id} to the folder`, description: result.note });
    onChanged();
    return true;
  };

  const doRenumber = async () => {
    const result = await renumber.run("idea.renumber", { idea_id: row.idea_id });
    if (!result) return false;
    toast({ tone: "success", title: `${result.renumbered.from} is now ${result.renumbered.to}`, description: "Its brief, case and lookups moved with it." });
    navigate(ideaPath(result.renumbered.to, "case"));
    return true;
  };

  return (
    <section aria-labelledby="publish-h" className="flex flex-col gap-4 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="flex max-w-reading min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Heading level={2} size="title-3" id="publish-h" tabIndex={-1} className="focus-visible:outline-none">
              Saved for others to read
            </Heading>
            <StatePill state={state} />
          </div>
          <Text size="body-sm" tone="muted">
            {explanation(state)}
          </Text>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {renumberOffered(state, row.next.kind) ? (
            <Button onClick={() => setRenumbering(true)}>
              <Hash aria-hidden="true" />
              Give it the next free number
            </Button>
          ) : null}
          {offered ? (
            <Button
              onClick={() => {
                publish.reset();
                setAsking(true);
              }}
            >
              <Upload aria-hidden="true" />
              {offered.label}
            </Button>
          ) : null}
        </div>
      </div>

      <Where state={state} />

      {outcome ? <Outcome outcome={outcome} /> : null}

      {publish.error && !asking ? (
        // The refusal stays on the page after the dialog closes, so "not saved" (or "stopped part way") stays plain.
        <Banner tone="danger" title={`${row.idea_id} was not saved`}>
          <span className="whitespace-pre-line">{failureText(publish.error, "Not saved").message}</span>
        </Banner>
      ) : null}

      <ConfirmDialog
        width="lg"
        open={asking}
        onOpenChange={setAsking}
        title={offered?.again ? `Save ${row.idea_id} again?` : `Save ${row.idea_id} to GitHub?`}
        description={`This saves the idea where others can read it: on GitHub as an issue${repository ? ` in ${repository}` : ""}, or in a folder in your workspace when GitHub cannot be used from this computer. It reaches no builder and starts nothing.`}
        confirmLabel={offered?.label ?? "Save to GitHub"}
        onConfirm={doPublish}
        error={publish.error ? failureText(publish.error, `${row.idea_id} was not saved`) : null}
        focusAfter={publishHeading}
      >
        <div className="flex flex-col gap-4 pb-1">
          <div className="flex flex-col gap-2 rounded-md bg-surface-sunken px-4 py-3">
            <p className="text-label text-ink">What is saved</p>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink">
              <li>{saved.brief}</li>
              <li>{saved.verdict}</li>
            </ul>
            <Text size="body-sm" tone="muted">
              {saved.caseNote}
            </Text>
          </div>
          <Banner tone="warning" title="An issue is as visible as its repository">
            Anyone who can see the repository can read the brief and the verdict. If the brief holds commercially sensitive detail and the repository is public, save it only to a private repository or keep it in the folder form.
          </Banner>
          <div className="flex flex-col gap-1.5">
            <p className="text-label text-ink">If GitHub cannot be used from this computer</p>
            <Text size="body-sm" tone="muted">
              When the GitHub tool is not installed, you are not signed in, or the project has no GitHub repository, MACH saves the brief and the verdict to a folder in your workspace instead, for you to commit. If GitHub is only out of reach for now, nothing is saved and you can save again later. An idea already on GitHub is never moved to the folder.
            </Text>
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        width="lg"
        open={renumbering}
        onOpenChange={setRenumbering}
        title={`Give ${row.idea_id} a new number?`}
        description="Another idea on GitHub already uses this number. Yours keeps everything it says and gets the next free number; its brief, case and lookups move with it."
        confirmLabel="Give it a new number"
        onConfirm={doRenumber}
        error={renumber.error ? failureText(renumber.error, `${row.idea_id} was not given a new number`) : null}
      />
    </section>
  );
}

function StatePill({ state }: { state: PublishState }) {
  switch (state.kind) {
    case "not-published":
      return (
        <StatusPill icon={<CircleDashed aria-hidden="true" />} className="border-dashed">
          Not saved yet
        </StatusPill>
      );
    case "stopped":
      return (
        <StatusPill tone="warning" icon={<TriangleAlert aria-hidden="true" />} className="border-2">
          Stopped part way
        </StatusPill>
      );
    case "number-taken":
      return (
        <StatusPill tone="warning" icon={<Hash aria-hidden="true" />} className="border-2">
          Number taken on GitHub
        </StatusPill>
      );
    case "folder":
      return <StatusPill icon={<FolderOpen aria-hidden="true" />}>Saved to the folder</StatusPill>;
    case "github":
      return state.changedOnGithub ? (
        <StatusPill tone="warning" icon={<TriangleAlert aria-hidden="true" />} className="border-2">
          Changed on GitHub
        </StatusPill>
      ) : (
        <StatusPill tone="success" icon={<CircleCheck aria-hidden="true" />}>
          Saved on GitHub
        </StatusPill>
      );
  }
}

function explanation(state: PublishState): string {
  switch (state.kind) {
    case "not-published":
      return "Only you can read this idea's brief and verdict until you save them. Saving puts the brief in an issue and the verdict in a signed comment on it; the case stays here.";
    case "stopped":
      return "Saving to GitHub stopped part way. Save again to finish; nothing is made twice.";
    case "number-taken":
      return `Another idea on GitHub already uses this number${state.others.length ? ` (${state.others.map((n) => `#${n}`).join(", ")})` : ""}. Give yours the next free number, then save it.`;
    case "folder":
      return "Saved to a folder in your workspace, for you to commit. Nothing was sent to GitHub.";
    case "github":
      if (state.changedOnGithub)
        return state.changedAfterVerdict
          ? "The issue was edited on GitHub after its verdict was saved, so it no longer shows the brief the verdict was given on. Save again to put the saved brief back."
          : "The issue was edited on GitHub after it was saved. Save again to put the saved brief back.";
      return state.upToDate ? "The issue shows the brief and the verdict as they are here." : "The brief or the verdict changed here since it was saved. Save the changes so the issue shows them.";
  }
}

function Where({ state }: { state: PublishState }) {
  if (state.kind !== "github") return null;
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-4">
      <dl className="grid max-w-reading grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-body-sm">
        <dt className="text-ink-muted">Issue</dt>
        <dd className="text-ink">
          {state.issue !== null ? <IssueLink number={state.issue} url={state.url} /> : "not recorded"}
          {state.closed ? " (closed on GitHub)" : ""}
        </dd>
        <dt className="text-ink-muted">Verdict on GitHub</dt>
        <dd className="text-ink">{state.verdictOnGithub === null ? "not recorded" : state.verdictOnGithub ? "A signed comment on the issue" : "Not on the issue"}</dd>
      </dl>
      {state.issue !== null ? <SignInNote /> : null}
    </div>
  );
}

/** Where this publish went, from the engine's answer. */
function Outcome({ outcome }: { outcome: PublishOutcome }) {
  if (outcome.where === "github") {
    return (
      <div role="status" className="flex flex-col gap-1 rounded-md border border-line bg-surface-sunken px-4 py-3">
        <p className="text-label text-ink">Saved on GitHub</p>
        <p className="text-body-sm text-ink">
          As issue <IssueLink number={outcome.issue} url={outcome.url} />, brief revision <span className="tabular">{outcome.revision}</span>, by{" "}
          <span translate="no" className="font-mono">
            {outcome.by}
          </span>
          .{outcome.verdictPosted ? " The verdict is a signed comment on it." : ""}
        </p>
        <Text size="body-sm" tone="muted">
          {outcome.note}
        </Text>
      </div>
    );
  }
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-line bg-surface-sunken px-4 py-3">
      <p className="text-label text-ink">Saved to a folder</p>
      {outcome.whyFolder ? (
        <Text size="body-sm" tone="muted">
          {outcome.whyFolder}
        </Text>
      ) : null}
      <p translate="no" className="break-all font-mono text-body-sm text-ink">
        {outcome.folder}
      </p>
      <Text size="body-sm">{outcome.note} Commit the folder so others can read it.</Text>
    </div>
  );
}
