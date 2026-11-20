import { useState } from "react";
import { Link } from "react-router";
import { ArtifactId, ConfirmDialog, Field, Input, Text, toast } from "@mach/ui";
import type { EpicLink, SliceLink } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { learnEpicKey } from "./data";
import { learnFromSliceLink } from "./model";

/** What a key act is about: an epic or a slice, its title, and its own key when it has one. */
export interface KeyTarget {
  kind: "epic" | "slice";
  id: string;
  title: string;
  ownKey: string | null;
  /** For a slice: the engine's word on whether it may change now. */
  editable?: boolean;
}

const sliceMeaning =
  "The slice is handed over to the builders with this key when you mark it ready, and its pull request names it, which is how Jira's own GitHub integration links the work. Nothing is sent to Jira.";
const epicMeaning =
  "Slices of this epic without a key of their own carry it when they are marked ready. Slices already marked ready keep the key they were approved with until each is reopened and marked ready again. Nothing is sent to Jira.";

/**
 * Set or change a key, on the product manager's word (`epic.link` / `slice.link`). The key is sent
 * as typed; the engine judges its form and whether the item may change, and its refusal is shown
 * as written, in the dialog.
 */
export function SetKeyDialog({
  target,
  open,
  onOpenChange,
  onEpicLinked,
}: {
  target: KeyTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The engine's answer to an epic link, for the page to say which ready slices keep the old key. */
  onEpicLinked: (answer: EpicLink) => void;
}) {
  const act = useEngineAct();
  const [key, setKey] = useState(target.ownKey ?? "");
  const [tried, setTried] = useState(false);
  const empty = key.trim() === "";
  const changing = target.ownKey !== null;
  const verb = changing ? "Change the key" : "Set the key";

  const change = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      act.reset();
      setTried(false);
      setKey(target.ownKey ?? "");
    }
  };

  const confirm = async () => {
    setTried(true);
    if (empty) return false;
    const jira = key.trim();
    if (target.kind === "epic") {
      const answer = await act.run("epic.link", { epic_id: target.id, jira });
      if (!answer) return false;
      learnEpicKey(target.id, answer.epic.tracking?.jira ?? null);
      onEpicLinked(answer);
      toast({ tone: "success", title: `Set the Jira key of ${target.id}`, description: answer.note });
    } else {
      const answer: SliceLink | null = await act.run("slice.link", { slice_id: target.id, jira });
      if (!answer) return false;
      const epic = learnFromSliceLink(answer);
      if (epic) learnEpicKey(epic.epic, epic.key);
      toast({ tone: "success", title: `Set the Jira key of ${target.id}`, description: answer.note });
    }
    setTried(false);
    return true;
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={change}
      title={changing ? `Change the Jira key of ${target.id}?` : `Set a Jira key for ${target.id}?`}
      description={target.kind === "epic" ? epicMeaning : sliceMeaning}
      confirmLabel={verb}
      cancelLabel="Not now"
      onConfirm={confirm}
      error={act.shown}
    >
      <div className="flex flex-col gap-3 pb-1">
        <Text size="body-sm" tone="muted">
          <ArtifactId>{target.id}</ArtifactId> {target.title}
        </Text>
        <Field label="Jira key" hint="As Jira writes it: the project's key, a hyphen and the number, such as TEAM-12." error={tried && empty ? "Write the key, such as TEAM-12." : undefined}>
          <Input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            translate="no"
            className="font-mono"
          />
        </Field>
        {act.error && target.kind === "slice" && target.editable === false ? <ReopenNote id={target.id} /> : null}
      </div>
    </ConfirmDialog>
  );
}

/** Remove a key, on the product manager's word. A danger act, confirmed like any other. */
export function RemoveKeyDialog({ target, open, onOpenChange }: { target: KeyTarget; open: boolean; onOpenChange: (open: boolean) => void }) {
  const act = useEngineAct();
  const change = (next: boolean) => {
    onOpenChange(next);
    if (!next) act.reset();
  };
  const confirm = async () => {
    if (target.kind === "epic") {
      const answer = await act.run("epic.link", { epic_id: target.id, remove: true });
      if (!answer) return false;
      learnEpicKey(target.id, answer.epic.tracking?.jira ?? null);
      toast({ tone: "info", title: `Removed the Jira key of ${target.id}`, description: answer.note });
    } else {
      const answer = await act.run("slice.link", { slice_id: target.id, remove: true });
      if (!answer) return false;
      const epic = learnFromSliceLink(answer);
      if (epic) learnEpicKey(epic.epic, epic.key);
      toast({ tone: "info", title: `Removed the Jira key of ${target.id}`, description: answer.note });
    }
    return true;
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={change}
      title={`Remove the Jira key of ${target.id}?`}
      description={
        target.kind === "epic"
          ? "Its slices without a key of their own are then handed over with no key. Slices already marked ready keep the key they were approved with. Nothing is sent to Jira."
          : "The slice then has no key of its own, and is handed over with its epic's key if the epic has one. Nothing is sent to Jira."
      }
      confirmLabel="Remove the key"
      cancelLabel="Keep it"
      tone="danger"
      onConfirm={confirm}
      error={act.shown}
    >
      <div className="flex flex-col gap-3 pb-1">
        <Text size="body-sm" tone="muted">
          <ArtifactId>{target.id}</ArtifactId> {target.title}
          {target.ownKey ? (
            <>
              {" · now "}
              <ArtifactId>{target.ownKey}</ArtifactId>
            </>
          ) : null}
        </Text>
        {act.error && target.kind === "slice" && target.editable === false ? <ReopenNote id={target.id} /> : null}
      </div>
    </ConfirmDialog>
  );
}

/** Where to go when the engine asks for a slice to be reopened first: its specification, which has the act. */
export function ReopenNote({ id }: { id: string }) {
  return (
    <Text size="body-sm" tone="muted">
      Reopening is done from the slice itself:{" "}
      <Link to={`/slices/${id}`} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
        open {id}
      </Link>
      .
    </Text>
  );
}
