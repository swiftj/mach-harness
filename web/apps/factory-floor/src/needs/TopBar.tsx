/**
 * The top bar's two M23 controls, on every workspace: "Needs you: N", which opens the list on the Line,
 * and, when a Factory runs here, how it was started with a Stop control confirmed in a dialog.
 *
 * The count is MACH's own list when the observer can read it, else the Line's own reading of the records
 * (the Simulation, or no run.py). The Stop control is there only where the observer can stop the Factory.
 */
import { useMemo, useState } from "react";
import { Button, ConfirmDialog, cn } from "@mach/ui";
import { showOnLine, useScene, useSceneStore, useStore } from "../scene";
import { lineModel } from "../line/model";
import { useNeeds } from "./context";
import { startedWords, STOP_WORDS } from "./model";

/** Moves to the Line and puts focus on its "Needs you" list. */
export function openNeeds(store: ReturnType<typeof useStore>): void {
  showOnLine(store);
  const focus = (tries: number) => {
    const el = document.getElementById("needs-you");
    if (el) el.focus();
    else if (tries > 0) requestAnimationFrame(() => focus(tries - 1));
  };
  requestAnimationFrame(() => focus(10));
}

export function NeedsCount() {
  const store = useStore();
  const needs = useNeeds();
  const scene = useScene();
  const minute = useSceneStore((s) => Math.floor(s.now / 60_000) * 60_000);
  const fallback = useMemo(() => (needs.list ? null : lineModel(scene, minute).needs.length), [needs.list, scene, minute]);
  const n = needs.list ? needs.list.tickets.length : (fallback ?? 0);
  return (
    <button
      type="button"
      onClick={() => openNeeds(store)}
      data-needs-count={n}
      aria-label={`Needs you: ${n}. Open the list`}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-xs border px-2 text-caption font-semibold",
        n > 0 ? "border-warning-line bg-warning-soft text-warning-ink" : "border-line bg-surface text-ink-muted hover:text-ink",
      )}
    >
      Needs you: <span className="tabular">{n}</span>
    </button>
  );
}

export function FactoryRunning() {
  const needs = useNeeds();
  const running = useSceneStore((s) => (s.source === "live" ? (s.factoryStatus?.running ?? null) : null));
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [seenStopped, setSeenStopped] = useState(false);
  const isRunning = running?.running === true;
  // After a stop, MACH's sentence stays until the status says the Factory is not running and then running again
  // (state derived during render, guarded, as the Shell does for its selection).
  if (done && !isRunning && !seenStopped) setSeenStopped(true);
  if (done && isRunning && seenStopped) {
    setDone(null);
    setSeenStopped(false);
  }
  if (!running || !isRunning || done) {
    return done ? (
      <span role="status" className="text-caption text-ink-muted" data-factory-stopped="">
        {done}
      </span>
    ) : null;
  }
  const how = startedWords(running.lifetime);
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" data-factory-running={running.lifetime ?? ""}>
      <span className="inline-flex h-6 items-center gap-1.5 rounded-xs border border-success-line bg-success-soft px-2 text-caption font-semibold text-success-ink" title={how ? `Factory running, started ${how}` : "Factory running"}>
        <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8" className="shrink-0">
          <circle cx="4" cy="4" r="3.5" style={{ fill: "currentColor" }} />
        </svg>
        Factory running
        {how ? <span className="font-normal max-[1439px]:sr-only">, {how}</span> : null}
      </span>
      {needs.canStop ? (
        <>
          <Button size="sm" variant="secondary" className="h-6 px-2 text-caption" onClick={() => (setError(null), setOpen(true))} data-factory-stop="">
            Stop
          </Button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title={STOP_WORDS.title}
            description={STOP_WORDS.description}
            confirmLabel={STOP_WORDS.verb}
            cancelLabel="Keep it running"
            tone="danger"
            onConfirm={async () => {
              const r = await needs.stop();
              if (!r.ok) {
                setError(r.message);
                return false;
              }
              setDone(r.note ?? "The Factory is stopped.");
              return true;
            }}
            error={error ? { title: "The Factory was not stopped", message: error } : null}
          />
        </>
      ) : null}
    </span>
  );
}
