import { useState } from "react";
import { Link, useParams } from "react-router";
import { CircleAlert, Scale } from "lucide-react";
import {
  ArtifactId,
  Banner,
  Button,
  Disclosure,
  ErrorState,
  Heading,
  HintAction,
  LoadingState,
  StateGlyph,
  StatusPill,
  Stepper,
  Text,
  cn,
  describeError,
  formatWhen,
  toast,
} from "@mach/ui";
import type { IdeaRow, IdeaShow, IdeaSized, ShapeMapStatus } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { useOperation } from "../../../api/useOperation";
import { IdeaStepFrame } from "../shell/IdeaStepFrame";
import { ideaPath, verdictWords } from "../shell/steps";
import { JOURNEY, ROUTES, countedRows, gateWords, journeyStep, routeState, sizeGate, type Gate, type RouteState } from "./model";
import { TheMap } from "./TheMap";

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
    <IdeaStepFrame key={ideaId} ideaId={ideaId} step="route" lead="MACH counts what the brief touches and names a route by a fixed rule. You decide what is created.">
      {(row) => <RoutePage row={row} />}
    </IdeaStepFrame>
  );
}

function RoutePage({ row }: { row: IdeaRow }) {
  const ideaId = row.idea_id;
  const show = useOperation("idea.show", { idea_id: ideaId });
  const status = useOperation("idea.map-status", { idea_id: ideaId });
  const [sized, setSized] = useState<IdeaSized | null>(null);
  const hasMap = Boolean(status.data?.map);
  const brief = useOperation("brief.show", hasMap ? { idea_id: ideaId } : null);

  // Wait for both reads, so a route is never shown as stale while the engine's view of it is still on its way.
  if ((!show.data && show.loading) || (!status.data && status.loading)) return <LoadingState label={`Reading ${ideaId}`} />;
  if (!show.data) {
    const shown = show.error ? describeError(show.error) : { title: "Not available right now", message: "" };
    return (
      <ErrorState
        className="max-w-reading"
        icon={<CircleAlert />}
        title={show.error?.kind === "refused" ? `Could not read ${ideaId}` : shown.title}
        message={show.error?.kind === "refused" ? show.error.message : shown.message}
        hint={show.error?.hint}
        action={<Button onClick={show.reload}>Try again</Button>}
      />
    );
  }

  const data = show.data;
  const gate = sizeGate(data.verdict ?? row.verdict);
  const route = routeState(data.route, status.data?.route, sized);
  const reload = () => {
    show.reload();
    status.reload();
    brief.reload();
  };

  return (
    <div className="flex flex-col gap-10">
      <div className="overflow-x-auto pb-1">
        <Stepper label="Sizing and the map" steps={JOURNEY} current={journeyStep(route, status.data)} />
      </div>
      {route.kind !== "holds" ? (
        <SizeSection
          ideaId={ideaId}
          gate={gate}
          route={route}
          onSized={(result) => {
            setSized(result);
            reload();
          }}
        />
      ) : null}
      {route.kind !== "not-sized" ? (
        <>
          <CountedSection route={route} sized={sized} />
          <RoutesSection ideaId={ideaId} route={route} />
          <MapArea ideaId={ideaId} status={status} brief={brief.data} made={data.made} onChanged={reload} />
        </>
      ) : null}
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
    <section aria-labelledby="size-heading" className="flex max-w-reading flex-col gap-4">
      <Heading level={2} id="size-heading">
        {stale ? "Size it again" : "Size it"}
      </Heading>
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
    </section>
  );
}

/** Before a Go holds: what is needed, in the engine's words, and where it is done. No way to size is offered. */
function NeedsGo({ ideaId, gate }: { ideaId: string; gate: Gate }) {
  const said = gateWords(ideaId, gate);
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

/** What MACH counted: the engine's numbers, with "Not determined" said as such and never as zero. */
function CountedSection({ route, sized }: { route: Exclude<RouteState, { kind: "not-sized" }>; sized: IdeaSized | null }) {
  const counted = route.counted;
  return (
    <section aria-labelledby="counted-heading" className="flex max-w-reading flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Heading level={2} id="counted-heading">
          What MACH counted
        </Heading>
        <Text size="body-sm" tone="muted">
          {route.kind === "stale" ? "As counted for an earlier version of the brief." : "From the brief as it is now, and what was looked up while exploring."}
          {route.at ? ` Sized ${formatWhen(route.at)}.` : null}
        </Text>
      </div>
      {counted ? (
        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line">
          {countedRows(counted).map((r) => (
            <div key={r.label} className="flex flex-col gap-1 bg-surface px-4 py-3">
              <dt className="text-body-sm text-ink-muted">{r.label}</dt>
              <dd className={cn("tabular", r.value === "Not determined" ? "text-body font-semibold text-ink" : "text-title-3 font-semibold text-ink")}>{r.value}</dd>
              {r.note ? <dd className="text-caption text-ink-muted">{r.note}</dd> : null}
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-body-sm text-ink-muted">The counts were not recorded with this route.</p>
      )}
      <Text size="body-sm" tone="muted">
        High risk means sign-in or permissions, billing, a database schema or migration, or an existing contract. High-risk areas and concerns are counted and shown; they are
        not part of the rule that names the route.
      </Text>
      {sized ? <CountedDetail sized={sized} /> : null}
    </section>
  );
}

/** What each count is made of, as the engine reported it when this page sized the idea. */
function CountedDetail({ sized }: { sized: IdeaSized }) {
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
    <Disclosure summary="What each count is made of">
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
            {sized.high_risk.areas.length ? (
              <ul className="flex flex-col gap-1">
                {sized.high_risk.areas.map((a) => (
                  <li key={a.area}>
                    {a.area} Reached by {a.rules.join(", ")}, in {a.file_count === 1 ? "1 file" : `${a.file_count} files`}.
                  </li>
                ))}
              </ul>
            ) : sized.high_risk.count === null ? null : (
              <span>None found.</span>
            )}
            {sized.high_risk.not_determined_note ? <span>{sized.high_risk.not_determined_note}</span> : null}
            <span className="text-ink-muted">{sized.high_risk.basis}</span>
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="font-semibold text-ink">Principle and policy concerns</dt>
          <dd>{ids([...sized.concerns.principles, ...sized.concerns.policies])}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="font-semibold text-ink">The rule</dt>
          <dd className="text-ink">{sized.rule}</dd>
        </div>
      </dl>
    </Disclosure>
  );
}

/**
 * The three routes, each fully readable, the one the rule chose marked with the engine's sentence of why. There is no
 * way to choose one here: the brief is what changes.
 */
function RoutesSection({ ideaId, route }: { ideaId: string; route: Exclude<RouteState, { kind: "not-sized" }> }) {
  const stale = route.kind === "stale";
  return (
    <section aria-labelledby="routes-heading" className="flex flex-col gap-4">
      <div className="flex max-w-reading flex-col gap-1">
        <Heading level={2} id="routes-heading">
          The route
        </Heading>
        <Text size="body-sm" tone="muted">
          Three routes, one rule. MACH applies the rule to the counts above; the route is never chosen by hand.
        </Text>
      </div>
      <ol aria-label="Routes" className="grid grid-cols-3 gap-3">
        {ROUTES.map((r) => {
          const chosen = r.route === route.route;
          return (
            <li
              key={r.route}
              aria-current={chosen ? "true" : undefined}
              className={cn(
                "flex flex-col gap-2 rounded-md px-4 py-4",
                chosen ? (stale ? "border-2 border-dashed border-line-strong bg-surface" : "border-2 border-accent bg-surface") : "border border-dashed border-line-strong",
              )}
            >
              {chosen ? (
                <StatusPill tone={stale ? "neutral" : "accent"} size="sm" icon={<StateGlyph shape={stale ? "superseded" : "ready"} />} className={cn("self-start", stale && "border-dashed")}>
                  {stale ? "Where the rule put it; no longer holds" : "This is where the rule puts it"}
                </StatusPill>
              ) : null}
              <Heading level={3} size="title-3" className={chosen ? "text-ink" : "text-ink-muted"}>
                {r.name}
              </Heading>
              <p className="text-body-sm text-ink">{r.when}</p>
              <p className="text-body-sm text-ink-muted">{r.next}</p>
              {chosen ? <p className="border-t border-line pt-2 text-body-sm text-ink">{route.why}</p> : null}
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
  onChanged,
}: {
  ideaId: string;
  status: ReturnType<typeof useOperation<"idea.map-status">>;
  brief: Parameters<typeof TheMap>[0]["brief"];
  made: IdeaShow["made"];
  onChanged: () => void;
}) {
  if (!status.data && status.loading) return <LoadingState label={`Reading the map of ${ideaId}`} />;
  if (!status.data) {
    const shown = status.error ? describeError(status.error) : { title: "Not available right now", message: "" };
    return (
      <ErrorState
        className="max-w-reading"
        icon={<CircleAlert />}
        title={status.error?.kind === "refused" ? `Could not read the map of ${ideaId}` : shown.title}
        message={status.error?.kind === "refused" ? status.error.message : shown.message}
        hint={status.error?.hint}
        action={<Button onClick={status.reload}>Try again</Button>}
      />
    );
  }
  const data: ShapeMapStatus = status.data;
  return <TheMap ideaId={ideaId} status={data} brief={brief} made={made} onChanged={onChanged} />;
}
