import { useState } from "react";
import { Link } from "react-router";
import {
  ArtifactId,
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  SliceStatusPill,
  Text,
  toast,
  type Status,
} from "@mach/ui";
import { asApiError, deliveryOp } from "./delivery/ops";
import { failureText } from "./delivery/ui";
import { plural } from "./delivery/words";

export interface ChooseSlicesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: Status;
  /** null: a new wave. Otherwise the draft wave to add to. */
  waveId: string | null;
  /** Ticked when the dialog opens. */
  preselected?: string[];
  onDone: () => void;
}

/**
 * Pick approved slices for a new wave, or to add to a draft wave. Only approved slices can be
 * picked; the others are listed with their state so the PM sees why they are not offered.
 * The engine decides whether the grouping is acceptable when the wave is approved.
 */
export function ChooseSlicesDialog({ open, onOpenChange, status, waveId, preselected = [], onDone }: ChooseSlicesDialogProps) {
  const [chosen, setChosen] = useState<string[]>(preselected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [lastOpen, setLastOpen] = useState(open);

  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setChosen(preselected);
      setError(null);
    }
  }

  const target = waveId ? status.waves.find((w) => w.wave_id === waveId) : null;
  const inTarget = new Set(target?.slices ?? []);
  const candidates = status.slices.filter((s) => !inTarget.has(s.slice_id));
  const approved = candidates.filter((s) => s.status === "approved_for_engineering");
  const notYet = candidates.filter((s) => s.status !== "approved_for_engineering" && s.status !== "superseded");
  const epicTitle = (id: string) => status.epics.find((e) => e.epic_id === id)?.title ?? id;
  const otherWaves = (sliceId: string) => status.waves.filter((w) => w.wave_id !== waveId && w.slices.includes(sliceId)).map((w) => w.wave_id);

  const toggle = (id: string, on: boolean) => setChosen((list) => (on ? [...list, id] : list.filter((x) => x !== id)));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (waveId) {
        await deliveryOp("wave.add", { wave_id: waveId, slice_ids: chosen });
        toast({ tone: "success", title: `Added ${plural(chosen.length, "slice")} to ${waveId}` });
      } else {
        const result = await deliveryOp("wave.new", { slice: chosen });
        toast({ tone: "success", title: `Created ${result.wave.wave_id}`, description: "A draft wave. Approve it when the grouping is right." });
      }
      onOpenChange(false);
      onDone();
    } catch (cause) {
      setError(failureText(asApiError(cause, waveId ? "wave.add" : "wave.new"), waveId ? `Nothing was added to ${waveId}` : "The wave was not created"));
    } finally {
      setBusy(false);
    }
  };

  const verb = waveId ? `Add ${plural(chosen.length, "slice")} to ${waveId}` : chosen.length ? `Create a wave with ${plural(chosen.length, "slice")}` : "Create the wave";

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent
        width="lg"
        title={waveId ? `Add slices to ${waveId}` : "Start a new delivery wave"}
        description={
          waveId
            ? "Choose approved slices to deliver together with the ones already in this wave."
            : "Choose the approved slices you want engineering to receive together. The wave starts as a draft: you can still change it until you approve it."
        }
        footer={
          <>
            <DialogClose asChild>
              <Button disabled={busy}>Cancel</Button>
            </DialogClose>
            <Button variant="primary" loading={busy} disabled={chosen.length === 0} onClick={submit}>
              {verb}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-label text-ink">Approved slices</legend>
            {approved.length === 0 ? (
              <Text size="body-sm" tone="muted">
                {waveId ? "Every approved slice is already in this wave." : "No slice is approved yet. Approve a slice from its specification, then come back here."}
              </Text>
            ) : (
              approved.map((s) => {
                const others = otherWaves(s.slice_id);
                return (
                  <Checkbox
                    key={s.slice_id}
                    checked={chosen.includes(s.slice_id)}
                    onCheckedChange={(value) => toggle(s.slice_id, value === true)}
                    label={
                      <span className="inline-flex flex-wrap items-center gap-x-2">
                        <ArtifactId>{s.slice_id}</ArtifactId>
                        <span>{s.title}</span>
                      </span>
                    }
                    description={`${epicTitle(s.epic_id)}${others.length ? ` · already in ${others.join(", ")}` : ""}`}
                  />
                );
              })
            )}
          </fieldset>

          {notYet.length ? (
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <p className="text-label text-ink">Not approved yet</p>
              <Text size="body-sm" tone="muted">
                A slice joins a wave once you have approved it.
              </Text>
              <ul className="flex flex-col gap-2">
                {notYet.map((s) => (
                  <li key={s.slice_id} className="flex flex-wrap items-center gap-2 text-body-sm">
                    <ArtifactId>{s.slice_id}</ArtifactId>
                    <span className="text-ink-muted">{s.title}</span>
                    <SliceStatusPill status={s.status} size="sm" />
                    <Link to={`/slices/${s.slice_id}`} className="text-accent-ink underline underline-offset-2">
                      Open<span className="sr-only"> {s.slice_id}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {error ? (
            <div role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2.5">
              <p className="text-label text-danger-ink">{error.title}</p>
              <p className="whitespace-pre-line text-body-sm text-ink">{error.message}</p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
