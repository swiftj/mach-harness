import { Lock, Minus, Plus, Send, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { ArtifactId, Button, ConfirmDialog, Heading, ReviewStatusPill, SliceStatusPill, SourceBadge, StateGlyph, Text, Tooltip, WaveStatusPill, reviewDescriptor, toast, type FeedbackWave, type Status, type StatusWaveRow, IdText, formatWhen, plural, Field, Input } from "@mach/ui";
import { asApiError, deliveryOp } from "./delivery/ops";
import { WithdrawnNote } from "../../shared/WithdrawnNote";
import { failureText } from "@mach/ui/api";

export interface WaveCardProps {
  wave: StatusWaveRow;
  status: Status;
  /** This wave's review state from `feedback`, when it has been sent and feedback could be read. */
  review: FeedbackWave | null;
  dependencies: Map<string, string[]>;
  dependenciesLoading: boolean;
  onChanged: () => void;
  onAddSlices: (waveId: string) => void;
  onStartNew: (sliceIds: string[]) => void;
}

/** One delivery wave: what is in it, where it stands, and the acts that fit its state. */
export function WaveCard({ wave, status, review, dependencies, dependenciesLoading, onChanged, onAddSlices, onStartNew }: WaveCardProps) {
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<ReturnType<typeof failureText> | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const draft = wave.status === "draft";
  const approved = wave.status === "approved_for_engineering";
  const headingId = `wave-${wave.wave_id}`;
  const slices = wave.slices.map((id) => ({ id, row: status.slices.find((s) => s.slice_id === id) ?? null }));
  const epics = [...new Set(slices.map((s) => s.row?.epic_id).filter((x): x is string => Boolean(x)))];
  const epicTitle = (id: string) => status.epics.find((e) => e.epic_id === id)?.title ?? id;
  const engineSays = status.structural_errors.filter((line) => line.includes(wave.wave_id));
  const unsettled = [...status.needs_reconciling.conflicts, ...status.needs_reconciling.collisions].filter((path) =>
    [wave.wave_id, ...wave.slices].some((id) => path.includes(id)),
  );
  const unsettledIds = [...new Set(unsettled.map((p) => p.match(/[A-Z]+-\d{3,}/)?.[0]).filter((x): x is string => Boolean(x)))];

  const whereIs = (dep: string): string => {
    if (wave.slices.includes(dep)) return "in this wave";
    const other = status.waves.filter((w) => w.wave_id !== wave.wave_id && w.slices.includes(dep));
    if (other.length) return `in ${other.map((w) => w.wave_id).join(", ")}`;
    return "not in any wave yet";
  };

  const remove = async (sliceId: string) => {
    setRemoving(sliceId);
    try {
      await deliveryOp("wave.remove", { wave_id: wave.wave_id, slice_ids: [sliceId] });
      toast({ tone: "success", title: `Removed ${sliceId} from ${wave.wave_id}` });
      onChanged();
    } catch (cause) {
      const { title, message } = failureText(asApiError(cause, "wave.remove"), `${sliceId} was not removed`);
      toast({ tone: "danger", title, description: message });
    } finally {
      setRemoving(null);
    }
  };

  // The engine's hint `name_approver`: no name is known on this computer, so the PM gives one here.
  const [approverName, setApproverName] = useState("");
  const needsName = approveError?.hint?.kind === "name_approver";

  const approve = async () => {
    setApproveError(null);
    try {
      const result = await deliveryOp("wave.approve", approverName.trim() ? { wave_id: wave.wave_id, actor: approverName.trim() } : { wave_id: wave.wave_id });
      toast({ tone: "success", title: `Approved ${wave.wave_id}`, description: result.note });
      onChanged();
      return true;
    } catch (cause) {
      setApproveError(failureText(asApiError(cause, "wave.approve"), `${wave.wave_id} was not approved`));
      return false;
    }
  };

  const reviewState = review && wave.sent ? reviewDescriptor(review.status) : null;

  return (
    <article aria-labelledby={headingId} className="flex flex-col rounded-md border border-line bg-surface">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-line px-5 py-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Heading level={3} id={headingId} size="title-3">
              <span className="sr-only">Delivery wave </span>
              <ArtifactId className="text-body text-ink">{wave.wave_id}</ArtifactId>
            </Heading>
            <WaveStatusPill status={wave.status} />
            {wave.sent && review ? <ReviewStatusPill status={review.status} /> : null}
            <SourceBadge source={wave.source} />
          </div>
          <Text size="body-sm" tone="muted">
            {plural(wave.slices.length, "slice")}
            {epics.length ? ` from ${epics.map(epicTitle).join(", ")}` : ""}
            {wave.approval ? ` · approved by ${wave.approval.actor}, ${formatWhen(wave.approval.approved_at)}` : ""}
          </Text>
          <WithdrawnNote item={status.approvals_withdrawn?.find((w) => w.artifact === wave.wave_id)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {draft ? (
            <>
              <Button onClick={() => onAddSlices(wave.wave_id)}>
                <Plus aria-hidden="true" />
                Add slices
              </Button>
              <Button variant="primary" disabled={wave.slices.length === 0} onClick={() => setApproving(true)}>
                Approve {wave.wave_id}
              </Button>
            </>
          ) : null}
          {approved && !wave.sent ? (
            <Button variant="primary" asChild>
              <Link to={`/waves/${wave.wave_id}/send`}>
                <Send aria-hidden="true" />
                Review and send {wave.wave_id}
              </Link>
            </Button>
          ) : null}
          {wave.sent ? (
            <Button variant={reviewState?.attention ? "primary" : "secondary"} asChild>
              <Link to={`/waves/${wave.wave_id}/review`}>{reviewState?.attention ? "See what review needs" : "See review progress"}</Link>
            </Button>
          ) : null}
        </div>
      </header>

      <ul className="flex flex-col divide-y divide-line" aria-label={`Slices in ${wave.wave_id}`}>
        {slices.length === 0 ? (
          <li className="px-5 py-4 text-body-sm text-ink-muted">No slices yet. Add approved slices to this wave.</li>
        ) : null}
        {slices.map(({ id, row }) => {
          const deps = dependencies.get(id);
          return (
            <li key={id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-5 py-3">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Link to={`/slices/${id}`} className="inline-flex min-w-0 items-center gap-2 rounded-xs text-ink hover:text-accent-ink">
                    <ArtifactId>{id}</ArtifactId>
                    <span className="truncate text-body font-semibold">{row?.title ?? "Not in your workspace"}</span>
                  </Link>
                  {row ? <SliceStatusPill status={row.status} size="sm" /> : null}
                  {row ? <SourceBadge source={row.source} /> : null}
                </div>
                <p className="text-body-sm text-ink-muted">
                  {dependenciesLoading && !deps ? (
                    "Reading what it depends on…"
                  ) : deps === undefined ? (
                    "Could not read what it depends on."
                  ) : deps.length === 0 ? (
                    "Depends on nothing else."
                  ) : (
                    <>
                      Depends on{" "}
                      {deps.map((dep, index) => (
                        <span key={dep}>
                          {index > 0 ? ", " : ""}
                          <ArtifactId plain className="text-ink">
                            {dep}
                          </ArtifactId>{" "}
                          <span className={whereIs(dep) === "not in any wave yet" ? "font-semibold text-warning-ink" : undefined}>({whereIs(dep)})</span>
                        </span>
                      ))}
                    </>
                  )}
                </p>
              </div>
              {draft ? (
                <Tooltip content={`Remove ${id} from ${wave.wave_id}`}>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${id} from ${wave.wave_id}`} loading={removing === id} onClick={() => remove(id)}>
                    <Minus aria-hidden="true" />
                  </Button>
                </Tooltip>
              ) : null}
            </li>
          );
        })}
      </ul>

      {engineSays.length || unsettledIds.length ? (
        <div className="flex flex-col gap-2 border-t border-line bg-warning-soft px-5 py-3">
          {unsettledIds.length ? (
            <p className="flex items-start gap-2 text-body-sm text-ink">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-ink" />
              <span>
                <IdText text={unsettledIds.join(", ")} /> {unsettledIds.length === 1 ? "differs" : "differ"} from the shared project and{" "}
                {unsettledIds.length === 1 ? "needs" : "need"} your decision before this wave can be sent.{" "}
                <Link to="/inbox" className="font-semibold text-accent-ink underline underline-offset-2">
                  Open Decisions
                </Link>
              </span>
            </p>
          ) : null}
          {engineSays.map((line) => (
            <p key={line} className="flex items-start gap-2 text-body-sm text-ink">
              <StateGlyph shape="blocked" className="mt-0.5 shrink-0 text-warning-ink" />
              <span>
                <span className="font-semibold">The workspace check reports: </span>
                <IdText text={line.replace(/^[^:]*:\s*/, "")} />
              </span>
            </p>
          ))}
        </div>
      ) : null}

      {approved && !wave.sent ? (
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="flex items-center gap-2 text-body-sm text-ink-muted">
            <Lock aria-hidden="true" className="size-4 shrink-0" />
            An approved wave can't be changed. To deliver a different set of slices, start a new wave.
          </p>
          <Button size="sm" onClick={() => onStartNew(wave.slices)}>
            Start a new wave from these
          </Button>
        </footer>
      ) : null}

      {wave.sent && review?.meaning ? (
        <footer className="border-t border-line px-5 py-3 text-body-sm text-ink-muted">{review.meaning}</footer>
      ) : null}

      <ConfirmDialog
        open={approving}
        onOpenChange={(open) => {
          setApproving(open);
          if (!open) setApproveError(null);
        }}
        title={`Approve ${wave.wave_id} for engineering?`}
        description="Approving is your personal decision that these slices should be delivered together. Every slice is checked again, and your name and the time are recorded."
        confirmLabel={`Approve ${wave.wave_id}`}
        onConfirm={approve}
        error={approveError && needsName ? { title: approveError.title, message: approveError.message } : approveError}
      >
        <div className="flex flex-col gap-3 text-body-sm">
          {needsName ? (
            <Field label="Your name" hint="Recorded with the approval and read by everyone who sees the wave. A name, not an email address.">
              <Input value={approverName} onChange={(e) => setApproverName(e.target.value)} autoComplete="name" />
            </Field>
          ) : null}
          <ul className="flex flex-col gap-1.5 rounded-md bg-surface-sunken px-3 py-2.5">
            {slices.map(({ id, row }) => (
              <li key={id} className="flex flex-wrap items-center gap-2">
                <ArtifactId>{id}</ArtifactId>
                <span className="text-ink">{row?.title}</span>
              </li>
            ))}
          </ul>
          <p className="text-ink">
            <span className="font-semibold">Nothing is sent.</span> The wave stays in your workspace until you choose to send it, and once approved it
            can't be changed.
          </p>
        </div>
      </ConfirmDialog>
    </article>
  );
}
