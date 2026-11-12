import { Handle, Position, type NodeProps } from "@xyflow/react";
import { TriangleAlert } from "lucide-react";
import { memo } from "react";
import { cn } from "../lib/cn";
import { toneClasses } from "../components/tone";
import { StateGlyph } from "../lifecycle/glyph";
import { graphStates, nodeSize, type MachNode as MachNodeType } from "./types";

const kindLabel = { product: "Project", epic: "Epic", slice: "Slice" } as const;

/**
 * One node for every kind. Kind is told by the label and the left edge (a heavier bar for higher
 * levels); state by glyph, words and border style; attention by a warning line. Colour only repeats
 * what shape and words already say.
 */
export const MachNodeView = memo(function MachNodeView({ data, selected, targetPosition = Position.Left, sourcePosition = Position.Right }: NodeProps<MachNodeType>) {
  const s = graphStates[data.state];
  const t = toneClasses[s.tone];
  const size = nodeSize[data.kind];
  return (
    <div
      style={{ width: size.width, height: size.height }}
      className={cn(
        "relative flex flex-col justify-between overflow-hidden rounded-md bg-surface px-3 py-2.5 text-left",
        s.border === "dashed" && "border border-dashed border-line-control",
        s.border === "solid" && "border border-line-strong",
        s.border === "double" && "border-[3px] border-double border-success-line",
        s.border === "heavy" && "border-2 border-danger-ink",
        s.muted && "opacity-60",
        selected && "outline-2 outline-offset-2 outline-accent",
        data.kind === "product" && "bg-surface-raised shadow-1",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0",
          data.kind === "product" ? "w-1.5" : data.kind === "epic" ? "w-1" : "w-0.5",
          t.fill,
        )}
      />
      <Handle type="target" position={targetPosition} className="!size-1 !min-h-0 !min-w-0 !border-0 !opacity-0" isConnectable={false} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-ink-subtle">{kindLabel[data.kind]}</span>
        <span translate="no" className="font-mono text-caption text-ink-muted tabular">
          {data.artifactId}
        </span>
      </div>
      <p
        className={cn(
          "line-clamp-1 text-ink",
          data.kind === "product" ? "font-display text-title-3 font-semibold" : "text-body-sm font-semibold",
        )}
        title={data.title}
      >
        {data.title}
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-caption font-semibold", t.ink)}>
          <StateGlyph shape={s.glyph} size={12} />
          <span className="truncate">{data.stateLabel ?? s.label}</span>
        </span>
        {data.attention ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-caption font-semibold text-warning-ink">
            <TriangleAlert aria-hidden="true" className="size-3.5" />
            {data.attention}
          </span>
        ) : data.meta ? (
          <span className="shrink-0 text-caption text-ink-subtle tabular">{data.meta}</span>
        ) : null}
      </div>
      <Handle type="source" position={sourcePosition} className="!size-1 !min-h-0 !min-w-0 !border-0 !opacity-0" isConnectable={false} />
    </div>
  );
});
