import { useMemo, useState } from "react";
import { Link } from "react-router";
import { FileText, Layers, Map as MapIcon } from "lucide-react";
import { ArtifactId, Banner, Button, ConfirmDialog, EmptyState, Heading, SliceStatusPill, Text, plural, toast } from "@mach/ui";
import type { BriefShow, IdeaMade, ShapeApplied, SliceStatus, ShapeCoverageRow, ShapeMapSlice, ShapeMapStatus } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { useStatus } from "../../../api/store";
import { applyBlocked, applyOutcome, applyPlan, applyWhat, briefLines, coverageProgress, coverageWords, outcomeText, quote } from "./model";
import { BriefQuote, CoveragePill } from "./parts";
import { SettleOutcomeDialog } from "./SettleOutcomeDialog";

type MapData = NonNullable<ShapeMapStatus["map"]>;

/**
 * The map and everything after it: coverage of the brief's outcomes (the centre), the proposed epics and thin slices in
 * build order, and making the drafts. Follows the PRD on-ramp's page (features/prd/PrdScreen.tsx) with outcomes in
 * place of sections. Reads `idea.map-status` and `brief.show`; acts `idea.settle` and `idea.apply`, each confirmed.
 */
export function TheMap({ ideaId, status, brief, made, onChanged }: { ideaId: string; status: ShapeMapStatus; brief: BriefShow | null; made: IdeaMade | null; onChanged: () => void }) {
  const [settling, setSettling] = useState<ShapeCoverageRow | null>(null);
  const lines = useMemo(() => briefLines(brief?.text), [brief?.text]);
  const map = status.map;
  if (!map) return <NoMap ideaId={ideaId} note={status.note} />;
  return (
    <>
      {(status.blockers ?? []).length && !map.applied ? (
        <Banner tone="warning" title="This map cannot be used as it is">
          <ul className="flex flex-col gap-1">
            {status.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <CoverageSection status={status} brief={brief} onSettle={setSettling} />
      <MapSection ideaId={ideaId} map={map} lines={lines} />
      <ApplySection ideaId={ideaId} status={status} map={map} made={made} onDone={onChanged} />
      <SettleOutcomeDialog
        ideaId={ideaId}
        outcome={settling}
        outcomeText={settling ? outcomeText(brief, settling.outcome) : null}
        slices={map.slices}
        onOpenChange={(open) => (open ? undefined : setSettling(null))}
        onDone={onChanged}
      />
    </>
  );
}

/** Before a map: what it is and how to get one. Nothing in the app proposes a map; it is never faked here. */
function NoMap({ ideaId, note }: { ideaId: string; note: string }) {
  return (
    <section aria-labelledby="map-heading" className="flex max-w-reading flex-col gap-4">
      <Heading level={2} id="map-heading">
        The map
      </Heading>
      <EmptyState
        icon={<MapIcon />}
        headingLevel={3}
        title="No map yet"
        description={
          <>
            The map of epics and thin slices is proposed in a conversation in Claude Code, not on this page. Ask the product studio skill there to propose a map for {ideaId}
            ; it reads the brief, proposes slices in build order with the outcomes each carries and the brief lines each rests on, and records the map once you agree. This
            page then shows it, with every outcome no slice carries.
          </>
        }
      />
      <Text size="body-sm" tone="muted">
        {note}
      </Text>
    </section>
  );
}

/**
 * Coverage, the centre of the map: every outcome of the brief and what carries it. An outcome no slice carries is
 * settled one by one; settled of total is a real fraction, and nothing is made while any is open.
 */
function CoverageSection({ status, brief, onSettle }: { status: ShapeMapStatus; brief: BriefShow | null; onSettle: (row: ShapeCoverageRow) => void }) {
  const rows = status.coverage ?? [];
  const progress = coverageProgress(rows);
  const applied = status.map?.applied ?? false;
  const slices = status.map?.slices ?? [];

  return (
    <section aria-labelledby="coverage-heading" className="flex max-w-reading flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Heading level={2} id="coverage-heading">
          Coverage
        </Heading>
        <Text tone="muted">Each outcome of the brief, and what carries it. An outcome no slice carries needs your word: part of a slice, out of scope, or later.</Text>
      </div>
      {progress.total > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-4 py-3">
          <p className="text-body font-semibold text-ink tabular">
            {progress.settled} of {plural(progress.total, "outcome")} settled
          </p>
          <div className="flex gap-1" aria-hidden="true">
            {Array.from({ length: progress.total }, (_, i) => (
              <span key={i} className={i < progress.settled ? "h-1.5 flex-1 rounded-full bg-ink-subtle" : "h-1.5 flex-1 rounded-full border border-dashed border-line-strong"} />
            ))}
          </div>
          <p className="text-body-sm text-ink-muted">
            {progress.left.length
              ? `${plural(progress.left.length, "outcome")} still to settle. Nothing is created until every outcome is carried or settled, and you say so.`
              : "Every outcome no slice carries is settled. Nothing is created until you say so."}
          </p>
        </div>
      ) : (
        <p className="text-body-sm text-ink-muted">Every outcome is carried by a slice on the map, so there is nothing to settle. Nothing is created until you say so.</p>
      )}
      <ol aria-label="Outcomes of the brief" className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
        {rows.map((row) => {
          const text = outcomeText(brief, row.outcome);
          return (
            <li key={row.outcome} className={row.state === "not_covered" ? "flex flex-col gap-2 bg-warning-soft px-4 py-3" : "flex flex-col gap-2 px-4 py-3"}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <ArtifactId className="shrink-0">{row.outcome}</ArtifactId>
                <div className="flex min-w-0 flex-1 flex-col">
                  {text ? <span className="break-words text-body text-ink">{text}</span> : null}
                  <span className="text-body-sm text-ink-muted">{coverageWords(row, slices)}</span>
                </div>
                <CoveragePill state={row.state} />
                {row.state === "not_covered" && !applied ? (
                  <Button size="sm" onClick={() => onSettle(row)}>
                    Settle {row.outcome}
                  </Button>
                ) : null}
              </div>
              {row.settled?.reason ? (
                <p className="pl-14 text-body-sm text-ink-muted">
                  Your reason: <span className="break-words text-ink">{row.settled.reason}</span>
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      {!brief ? <p className="text-body-sm text-ink-muted">The brief could not be read here, so each outcome is shown by its ID only.</p> : null}
    </section>
  );
}

/** The proposed epics and thin slices, in the order the builders take them, each with the brief lines it rests on. */
function MapSection({ ideaId, map, lines }: { ideaId: string; map: MapData; lines: Map<number, string> | null }) {
  const status = useStatus();
  const epicTitle = (id: string) => status.data?.epics.find((e) => e.epic_id === id)?.title ?? null;
  const newEpics = new Map(map.epics.map((e) => [e.key, e.title]));
  const keyTitle = new Map(map.slices.map((s) => [s.key, s.title]));
  const epicName = (epic: string) => newEpics.get(epic) ?? epicTitle(epic) ?? epic;

  return (
    <section aria-labelledby="map-heading" className="flex max-w-reading flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Heading level={2} id="map-heading">
          The map
        </Heading>
        <Text tone="muted">
          {map.applied
            ? "What was proposed and made from this idea. The map is kept as it was when the drafts were made."
            : "Proposed in Claude Code and recorded there. To change it, ask for a new map there; until the drafts are made, a new map replaces this one."}
        </Text>
      </div>
      {map.epics.length ? (
        <div className="flex flex-col gap-2">
          <Heading level={3}>{map.applied ? "Epics it proposed" : "New epics"}</Heading>
          <ul className="flex flex-col gap-3">
            {map.epics.map((e) => (
              <li key={e.key} className="flex flex-col gap-1 rounded-md border border-line bg-surface px-4 py-3">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-body font-semibold text-ink">{e.title}</span>
                  <ArtifactId plain>{e.key}</ArtifactId>
                </span>
                {e.criteria.length ? (
                  <>
                    <span className="text-body-sm text-ink-muted">Done when:</span>
                    <ul className="list-disc pl-5 text-body-sm text-ink-muted">
                      {e.criteria.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <Heading level={3}>Thin slices, in the order they are built</Heading>
        <ol className="flex flex-col gap-4">
          {map.slices.map((s, index) => (
            <MapSliceItem key={s.key} ideaId={ideaId} slice={s} index={index} epicName={epicName(s.epic)} keyTitle={keyTitle} lines={lines} />
          ))}
        </ol>
      </div>
    </section>
  );
}

function MapSliceItem({
  ideaId,
  slice,
  index,
  epicName,
  keyTitle,
  lines,
}: {
  ideaId: string;
  slice: ShapeMapSlice;
  index: number;
  epicName: string;
  keyTitle: Map<string, string>;
  lines: Map<number, string> | null;
}) {
  const depends = slice.depends_on.map((d) => (keyTitle.has(d) ? `${d}, “${keyTitle.get(d)}”` : d));
  const quotations = quote(lines, slice.cites);
  return (
    <li className="flex flex-col gap-3 rounded-md border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-caption font-semibold text-ink-muted tabular" aria-hidden="true">
          {index + 1}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <Heading level={4} className="text-body font-semibold">
              {slice.title}
            </Heading>
            <ArtifactId plain>{slice.key}</ArtifactId>
            {slice.slice_id ? <ArtifactId>{slice.slice_id}</ArtifactId> : null}
            {slice.status ? <SliceStatusPill status={slice.status as SliceStatus} size="sm" /> : null}
          </span>
          <Text size="body-sm">{slice.scope}</Text>
          <p className="text-body-sm text-ink-muted">
            In {epicName} · {depends.length ? `after ${depends.join(" and ")}` : "depends on no other slice"}
          </p>
          <p className="flex flex-wrap items-center gap-x-1.5 text-body-sm text-ink-muted">
            <span>Carries</span>
            {slice.outcomes.map((o, i) => (
              <span key={o} className="inline-flex items-center">
                <ArtifactId plain>{o}</ArtifactId>
                {i < slice.outcomes.length - 1 ? <span aria-hidden="true">,</span> : null}
              </span>
            ))}
          </p>
        </div>
      </div>
      {quotations.some((q) => q.lines.length) ? (
        <div className="flex flex-col gap-1 pl-9">
          <span className="text-body-sm text-ink-muted">Rests on:</span>
          <BriefQuote ideaId={ideaId} quotations={quotations} />
        </div>
      ) : (
        <p className="pl-9 text-body-sm text-ink-muted">Rests on the brief, {slice.cites}.</p>
      )}
      {slice.slice_id ? (
        <nav aria-label={`Pages of ${slice.slice_id}`} className="flex flex-wrap gap-x-5 gap-y-1 pl-9 text-body-sm font-semibold">
          <Link to={`/slices/${slice.slice_id}`} className="text-accent-ink underline-offset-2 hover:underline">
            Open the specification of {slice.slice_id}
          </Link>
        </nav>
      ) : null}
    </li>
  );
}

/**
 * Make the drafts (`idea.apply`): an explicit act, confirmed in a dialog naming exactly what it makes, in order.
 * Repeating it makes nothing twice, and the page says what already exists.
 */
function ApplySection({ ideaId, status, map, made, onDone }: { ideaId: string; status: ShapeMapStatus; map: MapData; made: IdeaMade | null; onDone: () => void }) {
  const shared = useStatus();
  const act = useEngineAct();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ShapeApplied | null>(null);
  const plan = useMemo(() => applyPlan(map, (id) => shared.data?.epics.find((e) => e.epic_id === id)?.title ?? null), [map, shared.data]);
  const again = map.applied;
  const blocked = applyBlocked(status);
  const what = applyWhat(plan);

  const confirm = async () => {
    const applied = await act.run("idea.apply", { idea_id: ideaId });
    if (!applied) return false;
    setResult(applied);
    toast({ tone: "success", title: applied.made.slices.length || applied.made.epics.length ? `Made the drafts from ${ideaId}` : "Nothing new to make", description: applied.note });
    onDone();
    return true;
  };

  return (
    <section aria-labelledby="apply-heading" className="flex max-w-reading flex-col gap-4 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex flex-col gap-1">
        <Heading level={2} id="apply-heading" size="title-3">
          Make the drafts
        </Heading>
        <Text size="body-sm" tone="muted">
          {again
            ? "The drafts were made. Running it again makes nothing twice; it only makes what is missing and says what already exists."
            : `Adds ${what} to your workspace as drafts, in the map's order, each recording the outcomes it serves. Nothing is marked ready, sent or started.`}
        </Text>
      </div>
      {blocked.length ? (
        <ul id="apply-blocked" className="flex flex-col gap-1 text-body-sm text-ink">
          {blocked.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}
      <div>
        <Button
          variant={again ? "secondary" : "primary"}
          disabled={blocked.length > 0}
          aria-describedby={blocked.length ? "apply-blocked" : undefined}
          onClick={() => {
            act.reset();
            setOpen(true);
          }}
        >
          {again ? "Make the drafts again" : `Make ${what}`}
        </Button>
      </div>
      {result ? <ApplyResult result={result} /> : again ? <MadeBefore map={map} made={made} /> : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={again ? `Make the drafts from ${ideaId} again?` : `Make ${what} from ${ideaId}?`}
        description={
          again
            ? "Anything already made is kept as it is and not made twice. Nothing is marked ready, sent or started."
            : "Each becomes a draft in your workspace, recording the idea and the outcomes it serves, and the idea is then shaped into work. Each slice then goes through its own interview. Nothing is marked ready, sent or started."
        }
        confirmLabel={again ? "Make the drafts again" : "Make the drafts"}
        onConfirm={confirm}
        error={act.shown ? { ...act.shown, title: act.error?.kind === "refused" ? "Nothing was made" : act.shown.title } : null}
      >
        <div className="flex flex-col gap-3 text-body-sm">
          {plan.epics.length ? (
            <div className="flex flex-col gap-1">
              <p className="font-semibold text-ink">{again ? "Epics on the map" : plural(plan.epics.length, "new epic")}</p>
              <ul className="list-disc pl-5 text-ink">
                {plan.epics.map((e) => (
                  <li key={e.key}>{e.title}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <p className="font-semibold text-ink">{again ? "Slices on the map, in order" : `${plural(plan.slices.length, "draft slice")}, in this order`}</p>
            <ol className="list-decimal pl-5 text-ink">
              {plan.slices.map((s) => (
                <li key={s.key}>
                  {s.title} <span className="text-ink-muted">in {s.epic}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </ConfirmDialog>
    </section>
  );
}

/** Links to an epic made from the idea. Epics have no page of their own; they are listed on Vision and outcomes. */
function EpicLink({ id }: { id: string }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <Layers aria-hidden="true" className="size-4 text-ink-subtle" />
      <ArtifactId>{id}</ArtifactId>
      <Link to="/vision#epics" className="font-semibold text-accent-ink underline-offset-2 hover:underline">
        Open {id} in the project's epics
      </Link>
    </li>
  );
}

function SliceLink({ id }: { id: string }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <FileText aria-hidden="true" className="size-4 text-ink-subtle" />
      <ArtifactId>{id}</ArtifactId>
      <Link to={`/slices/${id}`} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
        Open {id}
      </Link>
    </li>
  );
}

const isEpic = (id: string) => id.startsWith("EPIC-");

/** What the last apply made, what already existed, and what was removed since and not made again. */
function ApplyResult({ result }: { result: ShapeApplied }) {
  const outcome = applyOutcome(result);
  const linked = [...result.made.epics, ...result.made.slices, ...result.kept.epics, ...result.kept.slices];
  return (
    <div role="status" className="flex flex-col gap-3 border-t border-line pt-4">
      <Banner tone={outcome.nothingNew ? "info" : "success"} title={outcome.nothingNew ? "Nothing new was made" : `Made ${outcome.made.join(", ")}`}>
        {result.note}
      </Banner>
      {outcome.kept.length ? (
        <p className="text-body-sm text-ink">
          Already there, so not made again: <span className="font-semibold">{outcome.kept.join(", ")}</span>.
        </p>
      ) : null}
      {outcome.missing.length ? (
        <p className="text-body-sm text-ink">
          Made before and since removed, so not made again: <span className="font-semibold">{outcome.missing.join(", ")}</span>.
        </p>
      ) : null}
      <ul className="flex flex-col gap-1 text-body-sm">{linked.map((id) => (isEpic(id) ? <EpicLink key={id} id={id} /> : <SliceLink key={id} id={id} />))}</ul>
    </div>
  );
}

/** For an idea already shaped when the page opens: what was made (the idea's record), each linked to its page. */
function MadeBefore({ map, made }: { map: MapData; made: IdeaMade | null }) {
  const slices = made?.slices.length ? made.slices : map.slices.map((s) => s.slice_id).filter((id): id is string => Boolean(id));
  const epics = made?.epics ?? [];
  if (!slices.length && !epics.length) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <p className="text-body-sm font-semibold text-ink">Made from this idea</p>
      <ul className="flex flex-col gap-1 text-body-sm">
        {epics.map((id) => (
          <EpicLink key={id} id={id} />
        ))}
        {slices.map((id) => (
          <SliceLink key={id} id={id} />
        ))}
      </ul>
    </div>
  );
}
