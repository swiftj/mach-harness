/**
 * The Floor's Finished list: every ticket cleanup has closed (merged or abandoned), the latest first.
 * A finished ticket leaves the working floor for the Finished shelf in the archive (sim/places.ts);
 * the shelf draws the latest few, and this list holds all of them. Picking one selects it, so its
 * history opens in the inspector, and frames it on the shelf. It is part of the camera toolbar, so it
 * never covers the drawing.
 */
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@mach/ui";
import { useSceneActions, useSceneStore } from "../scene";
import { finishedAt, finishedCells, finishedOutcomeWords, ref } from "../sim";
import { agoWords, exactUtc } from "../shell/freshness";

export function FinishedList() {
  const { select } = useSceneActions();
  const [open, setOpen] = useState(false);
  // The scene at the moment shown: every finish it holds has happened by then.
  const scene = useSceneStore((s) => s.log.sceneAt(s.now));
  const live = useSceneStore((s) => s.source !== "simulation");
  const now = useSceneStore((s) => (open ? Math.floor(s.now / 1000) * 1000 : 0));
  const selection = useSceneStore((s) => s.selection);
  const finished = finishedCells(scene, Infinity);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-finished-list={finished.length} aria-label={`Finished tickets: ${finished.length}. Open the list`} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          Finished {finished.length}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 p-3" aria-label="Finished tickets">
        <p className="text-label text-ink">Finished tickets</p>
        <p className="mt-1 text-caption text-ink-muted">
          A ticket leaves the working floor once cleanup has closed it, merged or abandoned. Pick one to read its history; the shelf in the archive shows the latest {Math.min(finished.length, 5) || 5}.
        </p>
        {finished.length === 0 ? (
          <p className="mt-3 text-body-sm text-ink-muted">No ticket has finished yet.</p>
        ) : (
          <ul className="mt-2 flex max-h-72 flex-col overflow-y-auto">
            {finished.map((c) => {
              const at = finishedAt(c);
              const picked = selection === ref.cell(c.ticketId);
              const ago = at !== null && live ? agoWords(Math.max(0, (now || at) - at)) : null;
              return (
                <li key={c.ticketId}>
                  <button
                    type="button"
                    aria-current={picked ? "true" : undefined}
                    aria-label={`${c.ticketId} ${finishedOutcomeWords(c)}${ago && at !== null ? ` ${ago}, finished ${exactUtc(at)}` : ""}`}
                    onClick={() => {
                      select(ref.cell(c.ticketId));
                      setOpen(false);
                    }}
                    className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-surface-sunken aria-[current=true]:bg-surface-sunken"
                  >
                    <span translate="no" className="font-mono text-body-sm text-ink">
                      {c.ticketId}
                    </span>
                    <span className="min-w-0 flex-1 text-caption text-ink-muted">{finishedOutcomeWords(c)}</span>
                    {ago && at !== null ? (
                      <span className="shrink-0 text-caption text-ink-muted tabular" title={exactUtc(at)}>
                        {ago}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
