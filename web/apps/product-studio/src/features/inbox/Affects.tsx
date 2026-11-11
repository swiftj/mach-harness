import { ArtifactId, type Status } from "@mach/ui";

/** Which delivery waves an item touches: the reason a decision matters to current work. */
export function affectedWaves(status: Status, id: string | null) {
  if (!id) return [];
  return status.waves.filter((w) => w.status !== "superseded" && (w.wave_id === id || w.slices.includes(id)));
}

export function Affects({ status, id }: { status: Status; id: string | null }) {
  const waves = affectedWaves(status, id).filter((w) => w.wave_id !== id);
  if (!waves.length) return null;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-body-sm text-ink-muted">
      <span>Part of</span>
      {waves.map((w, i) => (
        <span key={w.wave_id} className="inline-flex items-center gap-1">
          <ArtifactId plain className="text-ink">
            {w.wave_id}
          </ArtifactId>
          <span>
            ({w.sent ? "sent" : w.status === "approved_for_engineering" ? "approved" : "draft"}){i < waves.length - 1 ? "," : ""}
          </span>
        </span>
      ))}
    </p>
  );
}
