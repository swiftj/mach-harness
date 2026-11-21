import { useState } from "react";
import { FolderUp } from "lucide-react";
import { Banner, Button, ConfirmDialog, RelativeTime, Text, toast } from "@mach/ui";
import { failureText, type DesignPublished, type DesignShow } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { Fold } from "../../../shared/layout/Fold";
import { publishBlocked, publishLabel, publishState } from "./model";
import { WRITING_NOTE_ID } from "./parts";

/**
 * Publishing a design (`design.publish`): the document and what MACH read in it go to a folder in the workspace, for
 * the product manager to commit, so the engineers' decisions can start from it. Refused by the engine while a
 * conflict waits; the act is disabled with that reason in view. A refusal (the copy changed, the topics changed
 * since it was read) is shown in the engine's own words. Nothing goes to GitHub.
 */
export function PublishSection({ show, writing, onPublished }: { show: DesignShow; writing: boolean; onPublished: () => void }) {
  const designId = show.design.design_id;
  const state = publishState(show);
  const blocked = publishBlocked(designId, show);
  const act = useEngineAct();
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<DesignPublished | null>(null);
  const label = publishLabel(designId, state);
  const published = show.map?.published ?? null;

  const publish = async () => {
    const done = await act.run("design.publish", { design_id: designId });
    if (!done) return false;
    setResult(done);
    toast({ tone: "success", title: done.changed ? `Published ${designId}` : `${designId} is already published as it is`, description: done.note });
    onPublished();
    return true;
  };

  const blockedId = "design-publish-blocked";
  const describedBy = [blocked ? blockedId : null, writing ? WRITING_NOTE_ID : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex max-w-reading flex-col gap-4">
      <Text size="body-sm" tone="muted">
        Publishing writes the document and what MACH read in it, with your word on each conflict, to a folder in your workspace for you to commit. The engineers'
        decisions can start from it once it is committed. Nothing goes to GitHub, nothing is decided and no work starts.
      </Text>
      {state === "changed" ? (
        <Banner tone="warning" title="Changed since it was published">
          What MACH read in it, or your word on a conflict, changed after it was published. Publish it again so the folder holds it as it is now.
        </Banner>
      ) : null}
      {published && state === "published" ? (
        <p className="text-body-sm text-ink">
          Published <RelativeTime iso={published.at} />. Publishing again changes nothing while nothing has changed, and shows the folder again.
        </p>
      ) : null}
      {blocked ? (
        <p id={blockedId} className="text-body-sm text-ink">
          {blocked}
        </p>
      ) : null}
      <div>
        <Button
          variant={state === "published" ? "secondary" : "primary"}
          data-part-act=""
          disabled={blocked !== null || writing}
          aria-describedby={describedBy}
          onClick={() => {
            act.reset();
            setAsking(true);
          }}
        >
          <FolderUp aria-hidden="true" />
          {label}
        </Button>
      </div>
      {act.error && !asking ? (
        // The refusal stays on the page after the dialog closes, in the engine's own words.
        <Banner tone="danger" title={`${designId} was not published`}>
          <span className="whitespace-pre-line">{failureText(act.error, "Not published").message}</span>
        </Banner>
      ) : null}
      {result ? <Outcome result={result} /> : null}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`${label}?`}
        description="The document and what MACH read in it, with your word on each conflict, are written to a folder in your workspace for you to commit. Nothing goes to GitHub, nothing is decided and no work starts."
        confirmLabel={label}
        cancelLabel="Not now"
        onConfirm={publish}
        error={act.error ? failureText(act.error, `${designId} was not published`) : null}
      />
    </div>
  );
}

/** What this publish did, and the folder to commit, in the engine's own words. */
function Outcome({ result }: { result: DesignPublished }) {
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-line bg-surface-sunken px-4 py-3">
      <p className="text-label text-ink">{result.changed ? "Published to a folder" : "Already published as it is"}</p>
      <Text size="body-sm">{result.note}</Text>
      {result.ways_on.map((way) => (
        <Text key={way} size="body-sm">
          {way}
        </Text>
      ))}
      <p translate="no" className="break-all font-mono text-body-sm text-ink">
        {result.folder}
      </p>
      <Fold small label={`Files in it: ${result.files.length}`}>
        <ul className="flex flex-col gap-1">
          {result.files.map((file) => (
            <li key={file} translate="no" className="break-all font-mono text-caption text-ink-muted">
              {file}
            </li>
          ))}
        </ul>
      </Fold>
    </div>
  );
}
