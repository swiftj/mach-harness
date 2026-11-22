import { useState } from "react";
import { Link, useParams } from "react-router";
import { CircleAlert, Scale } from "lucide-react";
import {
  ArtifactId,
  Banner,
  Button,
  ErrorState,
  Heading,
  HintAction,
  LoadingState,
  StateGlyph,
  StatusPill,
  Text,
  cn,
  describeError,
  formatWhen,
  toast,
} from "@mach/ui";
import type { IdeaRow, IdeaShow, IdeaSized, ShapeMapStatus } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { useOperation } from "../../../api/useOperation";
import { Fold } from "../../../shared/layout/Fold";
import { Part, Parts } from "../../../shared/layout/Parts";
import { OnePane, WorkPane, WorkPanes } from "../../../shared/layout/WorkScreen";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";
import { ideaPath, verdictWords } from "../shell/steps";
import { JOURNEY, ROUTES, countedRows, gateWords, journeyStep, partForStep, partPlace, routeName, routeState, sizeGate, sizeSummary, type Gate, type RouteState } from "./model";
import { MapBlockers, TheMap } from "./TheMap";

/**
 * Size and route: what MACH counted, the route its fixed rule names, the proposed map with its coverage, settling and
 * making the drafts. Data: idea.show (verdict, the recorded route, made), idea.map-status (whether the route holds, the
 * map, coverage), brief.show (the lines a slice rests on); acts idea.size, idea.settle, idea.apply. The page never
 * works out a route or a count: every one is the engine's. Fixtures: ?size=..., ?map-status=..., ?settle=...,
 * ?apply=..., ?idea=stale-route, ?refuse=idea.size.
 */
export function RouteScreen() {
  const ideaId = useParams().ideaId ?? "";
  return (
    <IdeaStepFrame
      key={ideaId}
      ideaId={ideaId}
      step="route"
      layout="panes"
      lead="MACH counts what the brief touches and names a route by a fixed rule. You decide what is created."
    >
      {(row) => <RoutePage row={row} />}
    </IdeaStepFrame>
  );
}

/**
 * The page in two panes (M16 layout). The wide pane is the journey as four parts, one open at a time: size it (and
 * the route the rule names), the map, settling what no slice carries, and making the drafts. Each part's row says its
 * state; the part the journey is at is open. The narrow pane keeps what MACH counted in view while the person works.
 */
function RoutePage({ row }: { row: IdeaRow }) {
  const ideaId = row.idea_id;
  const show = useOperation("idea.show", { idea_id: ideaId });
  const status = useOperation("idea.map-status", { idea_id: ideaId });
  const [sized, setSized] = useState<IdeaSized | null>(null);
  const hasMap = Boolean(status.data?.map);
  const brief = useOperation("brief.show", hasMap ? { idea_id: ideaId } : null);

  // Wait for both reads, so a route is never shown as stale while the engine's view of it is still on its way.
  if ((!show.data && show.loading) || (!status.data && status.loading))
    return (
      <OnePane label="Size and route">
        <LoadingState label={`Reading ${ideaId}`} />
      </OnePane>
    );
  if (!show.data) {
    const shown = show.error ? describeError(show.error) : { title: "Not available right now", message: "" };
    return (
      <OnePane label="Size and route">
        <ErrorState
          className="max-w-reading"
          icon={<CircleAlert />}
          title={show.error?.kind === "refused" ? `Could not read ${ideaId}` : shown.title}
          message={show.error?.kind === "refused" ? show.error.message : shown.message}
          hint={show.error?.hint}
          action={<Button onClick={show.reload}>Try again</Button>}
        />
      </OnePane>
    );
  }

  const data = show.data;
  const gate = sizeGate(data.verdict ?? row.verdict, data.acts.size);
  const route = routeState(data.route, status.data?.route, sized);
  const reload = () => {
    show.reload();
    status.reload();
    brief.reload();
  };

  return (
    <WorkPanes>
      <WorkPane label="Sizing and the map">
        <RouteParts
          ideaId={ideaId}
          gate={gate}
          route={route}
          step={journeyStep(route, status.data)}
          status={status}
          brief={brief.data}
          made={data.made}
          onSized={(result) => {
            setSized(result);
            reload();
          }}
          onChanged={reload}
        />
      </WorkPane>
      {route.kind !== "not-sized" ? (
        <WorkPane side label="The route and what MACH counted">
          <CountedSection route={route} detail={countedDetail(sized, data.route)} />
        </WorkPane>
      ) : null}
    </WorkPanes>
  );
}

/**
 * The four parts. The part the journey is at opens on arrival; when an act moves the journey on (a size, the last
 * outcome settled, the drafts made), the part that now needs the person opens, as the result of what they did.
 */
function RouteParts({
  ideaId,
  gate,
  route,
  step,
  status,
  brief,
  made,
  onSized,
  onChanged,
}: {
  ideaId: string;
  gate: Gate;
  route: RouteState;
  step: number;
  status: ReturnType<typeof useOperation<"idea.map-status">>;
  brief: Parameters<typeof TheMap>[0]["brief"];
  made: IdeaShow["made"];
  onSized: (result: IdeaSized) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(partForStep(step));
  const [seenStep, setSeenStep] = useState(step);
  if (seenStep !== step) {
    setSeenStep(step);
    setOpen(partForStep(step));
  }
  return (
    <div className="flex flex-col gap-6">
      <MapBlockers status={status.data} />
      <Parts label="Sizing and the map" open={open} onOpenChange={setOpen}>
        <Part id="size" number={1} place={partPlace("size", step)} name={JOURNEY[0]?.label ?? "Size it"} summary={sizeSummary(route, gate)}>
          <div className="flex flex-col gap-6">
            {route.kind !== "holds" ? <SizeSection ideaId={ideaId} gate={gate} route={route} onSized={onSized} /> : null}
            {route.kind !== "not-sized" ? <RoutesSection ideaId={ideaId} route={route} /> : null}
          </div>
        </Part>
        {route.kind === "not-sized" ? (
          <>
            <Part id="map" number={2} place="later" name={JOURNEY[1]?.label ?? "Map"} summary="After sizing" />
            <Part id="settle" number={3} place="later" name={JOURNEY[2]?.label ?? "Settle"} summary="After the map" />
            <Part id="apply" number={4} place="later" name={JOURNEY[3]?.label ?? "Make the drafts"} summary="After the map" />
          </>
        ) : (
          <MapArea ideaId={ideaId} status={status} brief={brief} made={made} step={step} onChanged={onChanged} />
        )}
      </Parts>
    </div>
  );
}

/**
 * "Size it": an explicit act, offered once a Go holds for the brief as it is now. Before that, what is needed, in the
 * engine's words. A route that no longer holds is said to be stale in the engine's words, and sized again the same way.
 */
function SizeSection({ ideaId, gate, route, onSized }: { ideaId: string; gate: Gate; route: RouteState; onSized: (result: IdeaSized) => void }) {
  const act = useEngineAct();
  const size = async () => {
    const result = await act.run("idea.size", { idea_id: ideaId });
    if (!result) return;
    toast({ tone: "success", title: `Sized ${ideaId}`, description: result.why });
    onSized(result);
  };
  const stale = route.kind === "stale";
  return (
    <div className="flex max-w-reading flex-col gap-4">
      {stale ? (
        <Banner tone="warning" title="The route no longer holds">
          {route.note ?? "The brief or the verdict changed after this route was found, so it no longer holds. Record the verdict on the brief as it is now, then size it again."}
        </Banner>
      ) : null}
      {gate.kind === "go" ? (
        <div className="flex flex-col gap-4 rounded-md border border-line bg-surface px-6 py-5">
          <Text>
            MACH counts the outcomes, capabilities and shipped rules the brief names, the high-risk areas those rules reach, and the principle and policy concerns already
            flagged, then names the route its rule gives. It reads this computer's copy of the main branch and creates nothing.
          </Text>
          <div>
            <Button variant="primary" loading={act.pending} onClick={() => void size()}>
              {stale ? `Size ${ideaId} again` : `Size ${ideaId}`}
            </Button>
          </div>
          {act.shown ? (
            <div role="alert" className="flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" />
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-label text-danger-ink">{act.error?.kind === "refused" ? "Not sized" : act.shown.title}</p>
                <p className="whitespace-pre-line text-body-sm text-ink">{act.shown.message}</p>
                <HintAction hint={act.shown.hint} />
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <NeedsGo ideaId={ideaId} gate={gate} />
      )}
    </div>
  );
}

/** Before a Go holds: what is needed, in the engine's words, and where it is done. No way to size is offered. */
function NeedsGo({ ideaId, gate }: { ideaId: string; gate: Gate }) {
  const said = gateWords(gate);
  const now =
    gate.kind === "stale"
      ? `The verdict recorded was ${verdictWords(gate.decision)}, on an earlier version of the brief.`
      : gate.kind === "no-go" && gate.decision
        ? `The verdict recorded is ${verdictWords(gate.decision)}.`
        : "No verdict is recorded yet.";
  return (
    <div className="flex items-start gap-3 rounded-md border border-dashed border-line-strong bg-surface px-5 py-4">
      <Scale aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-ink-subtle" />
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-body font-semibold text-ink">Not ready to size</p>
        {said.map((s) => (
          <p key={s} className="text-body-sm text-ink">
            {s}
          </p>
        ))}
        <p className="text-body-sm text-ink-muted">{now} The verdict is yours; MACH never recommends one.</p>
        <Link to={ideaPath(ideaId, "case")} className="self-start text-body-sm font-semibold text-accent-ink underline-offset-2 hover:underline">
          Go to the case and the verdict
        </Link>
      </div>
    </div>
  );
}

/** The narrow pane: the route the rule names and why, then what MACH counted, with "Not determined" said as such and never as zero. */
function CountedSection({ route, detail }: { route: Exclude<RouteState, { kind: "not-sized" }>; detail: CountedDetailData | null }) {
  const counted = route.counted;
  const stale = route.kind === "stale";
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="aside-route-heading" className="flex flex-col gap-2">
        <Heading level={2} size="title-3" id="aside-route-heading">
          The route
        </Heading>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-title-3 text-ink">{routeName(route.route)}</span>
          <StatusPill tone={stale ? "neutral" : "accent"} size="sm" icon={<StateGlyph shape={stale ? "superseded" : "ready"} />} className={cn(stale && "border-dashed")}>
            {stale ? "No longer holds" : "Where the rule puts it"}
          </StatusPill>
        </div>
        <Text size="body-sm">{route.why}</Text>
      </section>
      <section aria-labelledby="counted-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Heading level={2} size="title-3" id="counted-heading">
            What MACH counted
          </Heading>
          <Text size="body-sm" tone="muted">
            {route.kind === "stale" ? "As counted for an earlier version of the brief." : "From the brief as it is now, and what was looked up while exploring."}
            {route.at ? ` Sized ${formatWhen(route.at)}.` : null}
          </Text>
        </div>
        {counted ? (
          <dl className="grid grid-cols-2 gap-2">
            {countedRows(counted).map((r) => (
              <div key={r.label} className="flex min-w-0 flex-col gap-0.5 rounded-sm bg-surface-sunken px-2.5 py-2">
                <dt className="text-caption text-ink-muted">{r.label}</dt>
                <dd className={cn("tabular", r.value === "Not determined" ? "text-body font-semibold text-ink" : "text-title-3 font-semibold text-ink")}>{r.value}</dd>
                {r.note ? <dd className="text-caption text-ink-muted">{r.note}</dd> : null}
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-body-sm text-ink-muted">The counts were not recorded with this route.</p>
        )}
        <div className="flex flex-col gap-2">
          <Fold boxed label="What high risk means">
            High risk means sign-in or permissions, billing, a database schema or migration, or an existing contract. High-risk areas and concerns are counted and shown.
            Concerns are not part of the rule that names the route; a high-risk area only rules out a small change.
          </Fold>
          {detail ? <CountedDetail detail={detail} /> : null}
        </div>
      </section>
    </div>
  );
}

/** What each count is made of: the engine's answer to a size made on this page, or the details it kept with the route. */
interface CountedDetailData {
  touches: IdeaSized["touches"];
  areas: IdeaSized["high_risk"]["areas"];
  count: number | null;
  notDetermined: string | null;
  basis: string | null;
  concerns: IdeaSized["concerns"];
  rule: string | null;
}

function countedDetail(sized: IdeaSized | null, recorded: IdeaShow["route"]): CountedDetailData | null {
  if (sized) {
    const risk = sized.high_risk;
    return { touches: sized.touches, areas: risk.areas, count: risk.count, notDetermined: risk.not_determined_note ?? null, basis: risk.basis, concerns: sized.concerns, rule: sized.rule };
  }
  const kept = recorded?.details;
  if (!kept) return null;
  const missing = kept.high_risk.not_determined;
  return {
    touches: kept.touches,
    areas: kept.high_risk.areas,
    count: kept.high_risk.count,
    notDetermined: missing.length ? `Not determined for ${missing.join(", ")}: nothing on this computer says which files ${missing.length === 1 ? "that" : "their"} slice changed.` : null,
    basis: null,
    concerns: kept.concerns,
    rule: null,
  };
}

function CountedDetail({ detail: sized }: { detail: CountedDetailData }) {
  const ids = (list: readonly string[]) =>
    list.length ? (
      <span className="flex flex-wrap gap-1.5">
        {list.map((id) => (
          <ArtifactId key={id} plain>
            {id}
          </ArtifactId>
        ))}
      </span>
    ) : (
      <span className="text-ink-muted">None</span>
    );
  return (
    <Fold boxed label="What each count is made of">
      <dl className="flex flex-col gap-3 text-body-sm">
        <div className="flex flex-col gap-1">
          <dt className="font-semibold text-ink">Outcomes</dt>
          <dd>{ids(sized.touches.outcomes)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="font-semibold text-ink">Capabilities</dt>
          <dd className="break-words text-ink">{sized.touches.capabilities.length ? sized.touches.capabilities.join(", ") : "None"}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="font-semibold text-ink">Shipped rules</dt>
          <dd>{ids(sized.touches.shipped_rules)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="font-semibold text-ink">High-risk areas</dt>
          <dd className="flex flex-col gap-1 text-ink">
            {sized.areas.length ? (
              <ul className="flex flex-col gap-1">
                {sized.areas.map((a) => (
                  <li key={a.area}>
                    {a.area} Reached by {a.rules.join(", ")}, in {a.file_count === 1 ? "1 file" : `${a.file_count} files`}.
                  </li>
                ))}
              </ul>
            ) : sized.count === null ? null : (
              <span>None found.</span>
            )}
            {sized.notDetermined ? <span>{sized.notDetermined}</span> : null}
            {sized.basis ? <span className="text-ink-muted">{sized.basis}</span> : null}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="font-semibold text-ink">Principle and policy concerns</dt>
          <dd>{ids([...sized.concerns.principles, ...sized.concerns.policies])}</dd>
        </div>
        {sized.rule ? (
          <div className="flex flex-col gap-1">
            <dt className="font-semibold text-ink">The rule</dt>
            <dd className="text-ink">{sized.rule}</dd>
          </div>
        ) : null}
      </dl>
    </Fold>
  );
}

/**
 * The four routes, in the order of their size: the one the rule chose in full, marked with the engine's sentence of
 * why; the other three one line each, with when the rule would choose them. There is no way to choose one here: the
 * brief is what changes.
 */
function RoutesSection({ ideaId, route }: { ideaId: string; route: Exclude<RouteState, { kind: "not-sized" }> }) {
  const stale = route.kind === "stale";
  return (
    <section aria-labelledby="routes-heading" className="flex max-w-[48rem] flex-col gap-3">
      <div className="flex max-w-reading flex-col gap-1">
        <Heading level={3} id="routes-heading">
          The route
        </Heading>
        <Text size="body-sm" tone="muted">
          Four routes, one rule. MACH applies the rule to what it counted; the route is never chosen by hand.
        </Text>
      </div>
      <ol aria-label="Routes" className="flex flex-col gap-2">
        {ROUTES.map((r) => {
          const chosen = r.route === route.route;
          if (!chosen) {
            return (
              <li key={r.route} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md border border-dashed border-line-strong px-4 py-2">
                <span className="text-body-sm font-semibold text-ink-muted">{r.name}</span>
                <span className="text-body-sm text-ink-muted">{r.when}</span>
              </li>
            );
          }
          return (
            <li
              key={r.route}
              aria-current="true"
              className={cn("flex flex-col gap-2 rounded-md px-4 py-4", stale ? "border-2 border-dashed border-line-strong bg-surface" : "border-2 border-accent bg-surface")}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Heading level={4} size="title-3" className="text-ink">
                  {r.name}
                </Heading>
                <StatusPill tone={stale ? "neutral" : "accent"} size="sm" icon={<StateGlyph shape={stale ? "superseded" : "ready"} />} className={cn(stale && "border-dashed")}>
                  {stale ? "Where the rule put it; no longer holds" : "This is where the rule puts it"}
                </StatusPill>
              </div>
              <p className="text-body-sm text-ink">
                {r.when} <span className="text-ink-muted">{r.next}</span>
              </p>
            </li>
          );
        })}
      </ol>
      <p className="max-w-reading text-body-sm text-ink-muted">
        If the route looks wrong, the brief is what changes: change what it names, and the verdict is asked again before MACH sizes it again.{" "}
        <Link to={ideaPath(ideaId, "brief")} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
          Open the brief
        </Link>
      </p>
    </section>
  );
}

/** The map, once there is a route: read from `idea.map-status`, with its own loading and error. */
function MapArea({
  ideaId,
  status,
  brief,
  made,
  step,
  onChanged,
}: {
  ideaId: string;
  status: ReturnType<typeof useOperation<"idea.map-status">>;
  brief: Parameters<typeof TheMap>[0]["brief"];
  made: IdeaShow["made"];
  step: number;
  onChanged: () => void;
}) {
  if (!status.data) {
    const shown = status.error ? describeError(status.error) : { title: "Not available right now", message: "" };
    return (
      <Part id="map" number={2} place={partPlace("map", step)} name={JOURNEY[1]?.label ?? "Map"} summary={status.loading ? "Reading the map" : "The map could not be read"}>
        {status.loading ? (
          <LoadingState label={`Reading the map of ${ideaId}`} />
        ) : (
          <ErrorState
            className="max-w-reading"
            icon={<CircleAlert />}
            title={status.error?.kind === "refused" ? `Could not read the map of ${ideaId}` : shown.title}
            message={status.error?.kind === "refused" ? status.error.message : shown.message}
            hint={status.error?.hint}
            action={<Button onClick={status.reload}>Try again</Button>}
          />
        )}
      </Part>
    );
  }
  const data: ShapeMapStatus = status.data;
  return <TheMap ideaId={ideaId} status={data} brief={brief} made={made} step={step} onChanged={onChanged} />;
}
