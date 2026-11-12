import { useId, type ReactNode } from "react";
import { FactoryScene, GroundGrid, Heading, Text, cn } from "@mach/ui";

/** A scrub slider: drives the `progress` of every animated specimen in its group, as the playhead would. */
export function Scrub({ label, value, onChange, hint }: { label: string; value: number; onChange: (v: number) => void; hint?: string }) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm border border-line bg-surface-sunken px-3 py-2">
      <label htmlFor={id} className="text-label text-ink">
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="h-6 w-64 accent-accent-fill"
      />
      <output htmlFor={id} className="w-10 font-mono text-mono text-ink tabular">
        {value.toFixed(2)}
      </output>
      {hint ? <span className="text-caption text-ink-muted">{hint}</span> : null}
    </div>
  );
}

/** One specimen drawing with a caption under it. */
export function Tile({
  caption,
  detail,
  viewBox,
  width = 150,
  height = 120,
  label,
  grid = false,
  children,
  className,
}: {
  caption: ReactNode;
  detail?: ReactNode;
  viewBox: string;
  width?: number;
  height?: number;
  /** Accessible description of the drawing. */
  label: string;
  /** A patch of ground grid under the specimen (plan extent around the origin). */
  grid?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn("m-0 flex flex-col gap-1.5", className)}>
      <FactoryScene label={label} viewBox={viewBox} width={width} height={height} className="rounded-xs border border-line">
        {grid ? <GroundGrid x={-72} y={-72} w={144} d={144} lod="mid" fade={0.95} /> : null}
        {children}
      </FactoryScene>
      <figcaption className="flex flex-col">
        <span className="text-body-sm font-semibold text-ink">{caption}</span>
        {detail ? <span className="text-caption text-ink-muted">{detail}</span> : null}
      </figcaption>
    </figure>
  );
}

/** A group heading inside the sheet with its note. */
export function Group({ title, note, children, tools }: { title: string; note?: ReactNode; children: ReactNode; tools?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Heading level={3}>{title}</Heading>
        {note ? (
          <Text size="body-sm" tone="muted" className="max-w-reading">
            {note}
          </Text>
        ) : null}
      </div>
      {tools}
      <div className="rounded-md border border-line bg-surface p-5">{children}</div>
    </div>
  );
}

/** A labelled row inside a group: a row title on the left, tiles on the right. */
export function RowOf({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4 border-b border-line py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="pt-2 text-label text-ink">{title}</div>
      <div className="flex flex-wrap gap-4">{children}</div>
    </div>
  );
}
