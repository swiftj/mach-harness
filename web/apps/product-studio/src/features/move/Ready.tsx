import { useState } from "react";
import { Link } from "react-router";
import { Banner, Button, ConfirmDialog, Text, describeError, toast } from "@mach/ui";
import { isMachApiError } from "@mach/ui/api";
import { client } from "../../api/client";
import { statusSettled } from "../../api/store";
import { Working } from "./Working";
import { READY_MEANS, readyView, type ReadyView } from "./model";

/**
 * Marks ready, dependencies first, the slices of one import that were ready in the old repository (`project.imports.ready`),
 * on the product manager's word: a button, the confirm that says it publishes to GitHub, then what MACH did.
 */
export function MarkReady({ which, count, label, initial }: { which: string; count?: number; label?: string; initial?: ReadyView | null }) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<{ title: string; message: string } | null>(null);
  const [view, setView] = useState<ReadyView | null>(initial ?? null);
  const slices = count === 1 ? "the slice that was" : count ? `the ${count} slices that were` : "the slices that were";

  const run = async () => {
    setRunning(true);
    setProblem(null);
    try {
      const answer = readyView(await client.op("project.imports.ready", { which }));
      await statusSettled();
      setView(answer);
      toast({ tone: answer.complete ? "success" : "info", title: answer.complete ? "Marked ready" : "Marking ready stopped part way" });
      return true;
    } catch (error) {
      setProblem(isMachApiError(error) ? describeError(error) : { title: "Something failed", message: String(error) });
      return false;
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {view ? <ReadyResult view={view} onCarryOn={() => setConfirming(true)} /> : null}
      {view ? null : (
        <div>
          <Button size="sm" onClick={() => setConfirming(true)}>
            {label ?? `Mark ready ${slices} ready there`}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setProblem(null);
        }}
        title={view ? "Carry on marking ready?" : `Mark ready ${slices} ready there?`}
        description={READY_MEANS}
        confirmLabel={view ? "Carry on" : "Mark them ready"}
        onConfirm={run}
        error={problem}
      >
        {running ? <Working words="Marking slices ready" detail="Each is checked and published to GitHub in turn. Leave this window open." /> : null}
      </ConfirmDialog>
    </div>
  );
}

/** What marking ready did, in MACH's words, and the way on when it stopped. */
export function ReadyResult({ view, onCarryOn }: { view: ReadyView; onCarryOn: () => void }) {
  if (view.complete) {
    return (
      <Banner tone="success" title={view.marked.length ? "Marked ready" : "Nothing more to mark ready"}>
        {view.note}
      </Banner>
    );
  }
  return (
    <Banner
      tone="warning"
      title={view.stoppedAt ? `Marking ready stopped at ${view.stoppedAt}` : "Marking ready stopped part way"}
      actions={
        <>
          {view.needsPrinciples ? (
            <Button size="sm" variant="primary" asChild>
              <Link to="/principles">Publish the principles</Link>
            </Button>
          ) : null}
          <Button size="sm" onClick={onCarryOn}>
            Carry on
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-line">{view.note}</p>
      {view.needsPrinciples ? (
        <Text size="body-sm" tone="muted" className="mt-1">
          Publish the principles first, then carry on: MACH starts again where it stopped.
        </Text>
      ) : null}
    </Banner>
  );
}
