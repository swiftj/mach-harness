import { useState, type ReactNode } from "react";
import { Archive, CircleCheck, CircleDashed, CircleMinus, History, MessageSquareOff, Pencil, Plus } from "lucide-react";
import { ArtifactId, Button, ConfirmDialog, Heading, StatusPill, Text, Tooltip, cn, toast } from "@mach/ui";
import type { NeedKind, TechnicalNeed } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { Fold } from "../../../shared/layout/Fold";
import { behindWords, kindLook, kindNames, saidWords, type KindView, type NeedView } from "./model";

const kindGlyphs: Record<(typeof kindLook)[keyof typeof kindLook]["glyph"], ReactNode> = {
  check: <CircleCheck aria-hidden="true" />,
  minus: <CircleMinus aria-hidden="true" />,
  dashed: <CircleDashed aria-hidden="true" />,
};

const WAITS = "Waits until the conversation has finished writing.";

export interface ListActs {
  /** True while the conversation is writing: every act waits (the host would answer `conflict`). */
  busy: boolean;
  onAdd: (kind: NeedKind) => void;
  onChange: (need: TechnicalNeed) => void;
  /** After an act the page reads the needs again. */
  onDone: () => void;
}

/**
 * The six kinds in their fixed order, each a block: its name, its state in words and shape, the engine's question for
 * it, and under it its needs, or "nothing to say", or the invitation to answer. Each need shows its statement, why,
 * who said it and when for a given, and, read only, the decisions the engineers recorded for an older revision of it.
 */
export function KindList({ kinds, acts }: { kinds: KindView[]; acts: ListActs }) {
  return (
    <ol aria-label="The six kinds of technical need" className="flex flex-col">
      {kinds.map((view) => (
        <li key={view.kind} className="border-t border-line py-6 first:border-t-0 first:pt-0">
          <KindBlock view={view} acts={acts} />
        </li>
      ))}
    </ol>
  );
}

function KindBlock({ view, acts }: { view: KindView; acts: ListActs }) {
  const look = kindLook[view.state];
  const headingId = `need-kind-${view.kind}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Heading level={3} size="title-3" id={headingId}>
          {view.name}
        </Heading>
        <StatusPill size="sm" tone={look.tone} icon={kindGlyphs[look.glyph]} className={view.state === "unanswered" ? "border-dashed" : undefined}>
          {look.word}
        </StatusPill>
      </div>
      <p className={cn("max-w-reading", view.state === "unanswered" ? "text-body-lg text-ink" : "text-body-sm text-ink-muted")}>{view.question}</p>

      {view.needs.length ? (
        <ul className="flex flex-col gap-3" aria-label={`${view.name}: ${view.needs.length === 1 ? "1 need" : `${view.needs.length} needs`}`}>
          {view.needs.map((need) => (
            <NeedEntry key={need.need_id} need={need} acts={acts} />
          ))}
        </ul>
      ) : view.state === "nothing-to-say" ? (
        <Text size="body-sm" tone="muted">
          You said there is nothing to say about this. It is not asked again; adding a need of this kind answers it instead.
        </Text>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={view.state === "unanswered" ? "secondary" : "ghost"} disabled={acts.busy} onClick={() => acts.onAdd(view.kind)}>
          <Plus aria-hidden="true" />
          {view.needs.length ? "Add another" : "Add a need"}
        </Button>
        {view.state === "unanswered" ? <NothingToSay kind={view.kind} busy={acts.busy} onDone={acts.onDone} /> : null}
      </div>
    </section>
  );
}

/** One active need: its ID and revision, the statement, why, who said a given and when, its acts, and any flag. */
function NeedEntry({ need, acts }: { need: NeedView; acts: ListActs }) {
  const said = saidWords(need);
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line bg-canvas px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-subtle">
        <ArtifactId>{need.need_id}</ArtifactId>
        <span className="tabular">revision {need.revision}</span>
      </div>
      <p className="max-w-reading text-body-lg text-ink">{need.statement}</p>
      <p className="max-w-reading text-body-sm text-ink-muted">
        <span className="font-semibold text-ink">Why: </span>
        {need.why}
      </p>
      {said ? <p className="max-w-reading text-body-sm text-ink-muted">{said}</p> : null}
      {need.behind.length ? <DecisionsBehind need={need} /> : null}
      <div className="flex flex-wrap gap-1">
        <Tooltip content={acts.busy ? WAITS : `Change the statement or why of ${need.need_id}.`}>
          <Button size="sm" variant="ghost" disabled={acts.busy} onClick={() => acts.onChange(need)}>
            <Pencil aria-hidden="true" />
            Change {need.need_id}
          </Button>
        </Tooltip>
        <RetireNeed need={need} busy={acts.busy} onDone={acts.onDone} />
      </div>
    </li>
  );
}

/**
 * The decisions the engineers recorded for an older revision of this need, as the engine reports them. Read only:
 * nothing here acts on a decision; an engineer decides whether the change matters.
 */
function DecisionsBehind({ need }: { need: NeedView }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-warning-line bg-warning-soft px-3 py-2.5">
      <p className="flex items-center gap-2 text-label text-ink">
        <History aria-hidden="true" className="size-4 shrink-0 text-warning-ink" />
        Decisions the engineers recorded for an older revision
      </p>
      <ul className="flex flex-col gap-1.5">
        {need.behind.map((row) => (
          <li key={`${row.file}-${row.served_revision}`} className="flex flex-col gap-0.5 text-body-sm">
            <span className="flex flex-wrap items-center gap-2">
              <ArtifactId>{row.adr ?? row.file}</ArtifactId>
              <StatusPill size="sm" tone="warning" icon={<History aria-hidden="true" />}>
                Written for revision {row.served_revision}
              </StatusPill>
            </span>
            <span className="text-ink-muted">{behindWords(row)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Retire: the need stops counting and never comes back; its number is never used again. On the product manager's word. */
function RetireNeed({ need, busy, onDone }: { need: TechnicalNeed; busy: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const act = useEngineAct();
  const id = need.need_id;
  const retire = async () => {
    const result = await act.run("need.retire", { need_id: id });
    if (!result) return false;
    toast({ tone: "success", title: `Retired ${id}`, description: result.note });
    onDone();
    return true;
  };
  return (
    <>
      <Tooltip content={busy ? WAITS : `Retire ${id}: it no longer holds.`}>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(true)}>
          <Archive aria-hidden="true" />
          Retire {id}
        </Button>
      </Tooltip>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) act.reset();
        }}
        title={`Retire ${id}?`}
        description="It no longer holds, and it cannot be brought back: to have it again, add a new need. It stays listed as retired so its number is never used again. The engineer hears of it when you publish the technical needs."
        confirmLabel={`Retire ${id}`}
        cancelLabel="Keep it"
        tone="danger"
        onConfirm={retire}
        error={act.shown ? { ...act.shown, title: act.error?.kind === "refused" ? `${id} was not retired` : act.shown.title } : null}
      >
        <p className="rounded-md bg-surface-sunken px-4 py-3 text-body text-ink">{need.statement}</p>
      </ConfirmDialog>
    </>
  );
}

/** "Nothing to say" about a kind: a valid answer, recorded so it is not asked again. On the product manager's word. */
function NothingToSay({ kind, busy, onDone }: { kind: NeedKind; busy: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const act = useEngineAct();
  const name = kindNames[kind];
  const record = async () => {
    const result = await act.run("need.none", { kind });
    if (!result) return false;
    toast({ tone: "success", title: `Recorded nothing to say about ${name.toLowerCase()}`, description: result.note });
    onDone();
    return true;
  };
  return (
    <>
      <Tooltip content={busy ? WAITS : "Record that there is nothing to say about this, so it is not asked again."}>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(true)}>
          <MessageSquareOff aria-hidden="true" />
          Nothing to say
        </Button>
      </Tooltip>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) act.reset();
        }}
        title={`Record nothing to say about ${name.toLowerCase()}?`}
        description="It is a valid answer: the conversation does not ask about it again, and the engineer reads that you had nothing to say. Adding a need of this kind later answers it instead."
        confirmLabel="Record nothing to say"
        cancelLabel="Not now"
        onConfirm={record}
        error={act.shown ? { ...act.shown, title: act.error?.kind === "refused" ? "Nothing was recorded" : act.shown.title } : null}
      />
    </>
  );
}

/** Retired needs, out of the way behind a fold, but listed so their numbers stay accounted for. */
export function RetiredNeeds({ needs }: { needs: TechnicalNeed[] }) {
  if (!needs.length) return null;
  return (
    <Fold heading={3} label={`Retired: ${needs.length === 1 ? "1 need" : `${needs.length} needs`}`}>
      <div className="flex flex-col gap-3 pt-3">
        <Text size="body-sm" tone="muted" className="max-w-reading">
          They no longer hold. They stay listed, and are published, so their numbers are never used again.
        </Text>
        <ul className="flex flex-col gap-3">
          {needs.map((need) => (
            <li key={need.need_id} className="flex flex-col gap-1.5 rounded-md border border-line px-4 py-3">
              <span className="flex flex-wrap items-center gap-2">
                <ArtifactId>{need.need_id}</ArtifactId>
                <StatusPill size="sm" tone="neutral" icon={<Archive aria-hidden="true" />}>
                  Retired
                </StatusPill>
                <span className="text-caption text-ink-subtle">{kindNames[need.kind]}</span>
              </span>
              <p className="max-w-reading text-body text-ink-muted">{need.statement}</p>
              <p className="max-w-reading text-body-sm text-ink-muted">
                <span className="font-semibold">Why: </span>
                {need.why}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </Fold>
  );
}
