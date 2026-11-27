/**
 * The one panel for a ticket stopped for a person, opened from its "Stopped" box on the Line, its item in
 * "Needs you" ("Unblock 6"), or its cell in the Floor's inspector. It says what stopped it in one
 * sentence and when (with the date), each failed item with its ID, its text and the verifier's or
 * reviewer's note, the rounds so far with their results and each time a person carried it on, the
 * findings file, and the decision.
 *
 * Where the Factory Floor can record decisions (M23) the decision is MACH's own list for the ticket, its
 * recommended option open: "Carry on with a fix", with an optional box for what the builder should do
 * differently. Elsewhere (the Simulation, or no run.py) the command to run in Claude Code.
 */
import { CommandLine } from "@mach/ui";
import type { ReactNode } from "react";
import { type CellState } from "../sim";
import { FreeText } from "../shell/inspector/FreeText";
import { UncheckedNote, UncheckedText } from "../text/UncheckedText";
import { useDisplayPolicy } from "../shell/displayPolicy";
import { When } from "../shell/When";
import { carriedOnTitle, carriedOnWords } from "../sim";
import { DecidePanel } from "../needs/Decide";
import type { NeedTicket } from "../needs/model";
import { roundResultWords, stoppedView, type StoppedView } from "./model";

function Part({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="mt-5" aria-labelledby={id}>
      <h4 id={id} className="mb-1.5 text-label text-ink-muted">
        {title}
      </h4>
      {children}
    </section>
  );
}

function Failed({ view }: { view: StoppedView }) {
  const policy = useDisplayPolicy();
  if (view.failed.length === 0) return <p className="text-body-sm text-ink-muted">No failed item is recorded for its last round.</p>;
  const quoted = view.failed.some((f) => f.from !== "verifier");
  return (
    <>
      <ul className="flex flex-col divide-y divide-line rounded-sm border border-line" data-stopped-failed={view.failed.length}>
        {view.failed.map((f, i) => (
          <li key={`${f.id}/${i}`} className="grid grid-cols-[minmax(4rem,auto)_minmax(0,1fr)] gap-x-3 px-3 py-2">
            <span className="pt-px font-mono text-[13px] font-semibold text-factory-fail" translate="no" data-stopped-item={f.id}>
              {f.id}
            </span>
            <span className="min-w-0 text-body-sm">
              {f.from === "mach" ? (
                <>
                  {f.text ? (
                    <span className="block text-ink">
                      <UncheckedText text={f.text} labelled />
                    </span>
                  ) : null}
                  {f.note ? (
                    <span className="mt-0.5 block border-l-2 border-line-strong pl-2 text-ink-muted">
                      <UncheckedText text={f.note} labelled />
                    </span>
                  ) : null}
                  {!f.text && !f.note ? <span className="text-ink-muted">No words recorded.</span> : null}
                </>
              ) : f.from === "reviewer" ? (
                <>
                  <span className="block text-ink">
                    <FreeText field="findingTitle" text={f.title} labelled />
                  </span>
                  <span className="block text-caption text-ink-muted">The {f.seat} reviewer, round {f.round}: a blocking finding</span>
                </>
              ) : (
                <span className="text-ink-muted">Not proven in round {f.round}. The verifier&apos;s words are in the findings file.</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {quoted ? (
        <p className="mt-1 text-caption text-ink-subtle">
          Recorded words: <UncheckedNote note={policy.declared ? policy.note : null} />
        </p>
      ) : null}
    </>
  );
}

function Rounds({ view }: { view: StoppedView }) {
  if (view.rounds.length === 0) return <p className="text-body-sm text-ink-muted">No round is recorded yet.</p>;
  return (
    <ol className="flex flex-col gap-1.5" data-stopped-rounds={view.rounds.length}>
      {view.rounds.map((g) =>
        g.kind === "carried-on" ? (
          <li key={g.key} className="rounded-sm border border-dashed border-factory-human bg-factory-human-soft px-3 py-1.5 text-body-sm" data-stopped-carried-on={g.carry.by ?? ""}>
            <span className="font-semibold text-ink">{carriedOnTitle(g.carry)}</span>
            <span className="text-ink-muted">
              {" "}
              · <When t={g.carry.at} />
            </span>
            <span className="block text-caption text-ink-muted">{carriedOnWords(g.carry)}</span>
          </li>
        ) : (
          <li key={g.key} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 text-body-sm">
            <span className="font-semibold text-ink">
              Round {g.round}
              {g.reads ? <span className="block text-caption font-normal text-ink-muted">reads {g.reads}</span> : null}
            </span>
            <span className="text-ink">
              {roundResultWords(g)}
              {g.verification?.decidedAt ?? g.review?.decidedAt ? (
                <span className="text-ink-muted">
                  {" "}
                  · <When t={(g.review?.decidedAt ?? g.verification?.decidedAt) as number} />
                </span>
              ) : null}
            </span>
          </li>
        ),
      )}
    </ol>
  );
}

export function StoppedPanel({ ticketId, cell, sentence, at, need, live }: { ticketId: string; cell: CellState | null; sentence: string; at: number | null; need: NeedTicket | null; live: boolean }) {
  const view = stoppedView({ ticketId, cell, sentence, at, need });
  const showFirst = (need?.showFirst ?? []).filter((p) => p !== view.findingsFile);
  return (
    <div data-stopped-panel={ticketId}>
      <section aria-labelledby={`stopped-${ticketId}`}>
        <h4 id={`stopped-${ticketId}`} tabIndex={-1} data-stopped-heading="" className="mb-1.5 text-label text-ink-muted outline-none">
          What stopped it
        </h4>
        <p className="text-body-sm text-ink" data-stopped-sentence="">
          {view.sentence}
        </p>
        <p className="mt-1 text-caption text-ink-muted" data-stopped-when="">
          {view.at !== null ? (
            <>
              Stopped <When t={view.at} inline />
            </>
          ) : (
            "When it stopped is not recorded"
          )}
          {view.station ? ` · at ${view.station}` : ""}
          {view.round.used !== null && view.round.max !== null ? ` · round ${Math.min(view.round.used, view.round.max)} of ${view.round.max}` : ""}
        </p>
      </section>
      <Part title="What failed" id={`stopped-failed-${ticketId}`}>
        <Failed view={view} />
      </Part>
      <Part title="Rounds so far" id={`stopped-rounds-${ticketId}`}>
        <Rounds view={view} />
      </Part>
      <Part title="Findings file" id={`stopped-findings-${ticketId}`}>
        {view.findingsFile ? (
          <>
            <p className="break-all font-mono text-[13px] text-ink" translate="no" data-stopped-findings-file="">
              {view.findingsFile}
            </p>
            <p className="mt-0.5 text-caption text-ink-muted">Open it in your editor: it holds every failed item in full.</p>
          </>
        ) : (
          <p className="text-body-sm text-ink-muted">No findings file is recorded.</p>
        )}
        {showFirst.length ? (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {showFirst.map((p) => (
              <li key={p} className="break-all font-mono text-[13px] text-ink" translate="no">
                {p}
              </li>
            ))}
          </ul>
        ) : null}
      </Part>
      <div className="mt-5">
        {need ? (
          <DecidePanel key={need.ticketId} ticket={need} compact preselect />
        ) : (
          <section aria-label={`The decision on ${ticketId}`}>
            <h4 className="mb-1.5 text-label text-ink-muted">The decision</h4>
            <p className="text-body-sm text-ink">
              {live
                ? "Carry it on with a fix in Claude Code: MACH asks what the builder should do differently, and the builder takes it up again at the build step."
                : "In a real project, a person carries it on with a fix in Claude Code, and the builder takes it up again at the build step."}
            </p>
            <CommandLine className="mt-2" command={`/mach decide ${ticketId}`} purpose={`to decide on ${ticketId}`} />
          </section>
        )}
      </div>
    </div>
  );
}
