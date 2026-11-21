import { useState } from "react";
import { Link } from "react-router";
import { KeyRound, Pencil, Plus, X } from "lucide-react";
import { ArtifactId, Banner, Button, SliceGithubPills, SliceStatusPill, Text, cn } from "@mach/ui";
import type { EpicLink } from "@mach/ui/api";
import { RemoveKeyDialog, SetKeyDialog, type KeyTarget } from "./KeyDialogs";
import type { KeyFact, LedgerEpic, LedgerSlice } from "./model";

/**
 * A key as a tag, so its kind reads without colour: an own key on a solid edge, a key taken from the
 * epic on a dashed edge with "from EPIC-001" in words, and no key as a plain word.
 */
export function KeyTag({ fact }: { fact: KeyFact }) {
  if (fact.kind === "own") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-xs border border-line-strong bg-canvas px-2 py-0.5">
        <KeyRound aria-hidden="true" className="size-3.5 text-ink-muted" />
        <ArtifactId plain className="font-semibold text-ink">
          {fact.key}
        </ArtifactId>
      </span>
    );
  }
  if (fact.kind === "inherited") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-xs border border-dashed border-line-strong px-2 py-0.5">
        <ArtifactId plain className="text-ink-muted">
          {fact.key}
        </ArtifactId>
        <span className="text-caption text-ink-muted">
          from <ArtifactId plain>{fact.from}</ArtifactId>
        </span>
      </span>
    );
  }
  return <span className="text-body-sm text-ink-subtle">No key</span>;
}

type Act = { mode: "set" | "remove"; target: KeyTarget };

/**
 * The keys part: every epic and its slices in the product manager's order, each with its key and the acts
 * to set, change or remove it.
 */
export function KeysLedger({ ledger }: { ledger: LedgerEpic[] }) {
  const [act, setAct] = useState<Act | null>(null);
  const [epicNotice, setEpicNotice] = useState<EpicLink | null>(null);
  const close = (open: boolean) => (open ? undefined : setAct(null));

  return (
    <div className="flex flex-col gap-8">
      {ledger.map((epic) => (
        <section key={epic.id} aria-labelledby={`jira-epic-${epic.id}`} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-strong pb-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h3 id={`jira-epic-${epic.id}`} className="flex flex-wrap items-baseline gap-2 text-title-3 font-semibold text-ink">
                <span>{epic.title}</span>
                <ArtifactId>{epic.id}</ArtifactId>
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body-sm text-ink-muted">Epic key</span>
                <KeyTag fact={epic.key} />
              </div>
            </div>
            <KeyActs
              target={{ kind: "epic", id: epic.id, title: epic.title, ownKey: epic.key.kind === "own" ? epic.key.key : null }}
              onAct={setAct}
            />
          </div>

          {epicNotice && epicNotice.epic.epic_id === epic.id && epicNotice.already_ready.length > 0 ? (
            <Banner tone="warning" title="Slices already marked ready keep their old key">
              <p>{epicNotice.note}</p>
              <p className="pt-1">
                Each of these carries {epicNotice.epic.tracking?.jira ?? "the new key"} only once it is reopened and marked ready again:{" "}
                {epicNotice.already_ready.map((id, i) => (
                  <span key={id}>
                    {i > 0 ? ", " : ""}
                    <Link to={`/slices/${id}`} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
                      <span translate="no">{id}</span>
                      {epic.slices.find((s) => s.id === id) ? ` ${epic.slices.find((s) => s.id === id)?.title}` : ""}
                    </Link>
                  </span>
                ))}
                .
              </p>
            </Banner>
          ) : null}

          {epic.slices.length === 0 ? (
            <Text size="body-sm" tone="muted">
              No slices in this epic yet.
            </Text>
          ) : (
            <ol aria-label={`Slices of ${epic.id}, in your order`} className="flex flex-col">
              {epic.slices.map((slice, index) => (
                <SliceRow key={slice.id} slice={slice} place={index + 1} onAct={setAct} />
              ))}
            </ol>
          )}
        </section>
      ))}

      {act?.mode === "set" ? (
        <SetKeyDialog key={`${act.target.kind}-${act.target.id}`} target={act.target} open onOpenChange={close} onEpicLinked={setEpicNotice} />
      ) : null}
      {act?.mode === "remove" ? <RemoveKeyDialog key={`${act.target.kind}-${act.target.id}`} target={act.target} open onOpenChange={close} /> : null}
    </div>
  );
}

function SliceRow({ slice, place, onAct }: { slice: LedgerSlice; place: number; onAct: (act: Act) => void }) {
  return (
    <li className={cn("grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 border-b border-line py-3 last:border-b-0")}>
      <span className="pt-0.5 text-right text-body-sm text-ink-subtle tabular" aria-hidden="true">
        {place}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Link to={`/slices/${slice.id}`} className="font-semibold text-ink underline-offset-2 hover:underline">
            {slice.title}
          </Link>
          <ArtifactId>{slice.id}</ArtifactId>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <KeyTag fact={slice.key} />
          <SliceStatusPill status={slice.status} size="sm" />
          <SliceGithubPills github={slice.github} size="sm" />
        </div>
      </div>
      <KeyActs target={{ kind: "slice", id: slice.id, title: slice.title, ownKey: slice.ownKey, editable: slice.editable }} onAct={onAct} />
    </li>
  );
}

/** Set (or change) and remove, for one item. Remove is offered only for an item's own key. */
function KeyActs({ target, onAct }: { target: KeyTarget; onAct: (act: Act) => void }) {
  const has = target.ownKey !== null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      <Button size="sm" variant="ghost" onClick={() => onAct({ mode: "set", target })} aria-label={`${has ? "Change the key" : "Set a key"} of ${target.id}`}>
        {has ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}
        {has ? "Change the key" : "Set a key"}
      </Button>
      {has ? (
        <Button size="sm" variant="ghost" onClick={() => onAct({ mode: "remove", target })} aria-label={`Remove the key of ${target.id}`}>
          <X aria-hidden="true" />
          Remove
        </Button>
      ) : null}
    </div>
  );
}
