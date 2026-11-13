/**
 * The investigation band (M6.3, investigate/): a compact panel between the overview and the tracks for
 * the lens in use. At most 220 px high with its own scroll, collapsible to its 28 px header. Each lens
 * is a drawing in the Living Factory's language whose every figure reveals the record it comes from.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { InvestigationPanelProps } from "../contract";
import { useSceneStore } from "../../scene";
import type { BodyProps } from "./body";
import { ConcurrencyBody } from "./Concurrency";
import { lensOf } from "./lenses";
import { ticketOfRef } from "./model";
import { RecoveryBody } from "./Recovery";
import { RetriesBody } from "./Retries";
import { ReviewBody } from "./Review";
import { useLensData } from "./useLensData";
import { WaitsBody } from "./Waits";
import "./investigate.css";

export const PANEL_MAX_HEIGHT = 220;
export const PANEL_HEADER_HEIGHT = 28;

const BODIES = { retries: RetriesBody, concurrency: ConcurrencyBody, waits: WaitsBody, review: ReviewBody, recovery: RecoveryBody } as const;

export function InvestigationPanel(props: InvestigationPanelProps) {
  const lens = lensOf(props.lens);
  const [collapsed, setCollapsed] = useState(false);
  const selection = useSceneStore((s) => s.selection);
  const lensData = useLensData(props.data, props.viewport.window, props.lens === "concurrency");
  if (!lens) return null;
  const Body = BODIES[lens.id];
  const bodyId = `mach-inv-body-${lens.id}`;
  const body: BodyProps = {
    spans: props.spans,
    marks: lensData.marks,
    series: lensData.series,
    status: lensData.status,
    viewport: props.viewport,
    width: props.width,
    selectedTicket: ticketOfRef(selection),
    onReveal: props.onReveal,
    onWiden: () => props.onView({ window: null }),
  };
  return (
    <section aria-label={`Investigation: ${lens.label}`} className="relative shrink-0 border-b border-line bg-surface" style={{ width: props.width, maxHeight: PANEL_MAX_HEIGHT }}>
      <header className="flex items-center gap-2 border-b border-line pr-1" style={{ height: PANEL_HEADER_HEIGHT }}>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed((c) => !c)}
          className="flex h-full shrink-0 items-center gap-1 rounded-xs px-2 text-body-sm font-semibold text-ink hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--mach-focus)]"
        >
          {collapsed ? <ChevronRight aria-hidden="true" className="size-4 text-ink-muted" /> : <ChevronDown aria-hidden="true" className="size-4 text-ink-muted" />}
          {lens.label}
        </button>
        <p className="min-w-0 flex-1 truncate text-[11px] text-ink-subtle" title={lens.about}>
          {lens.about}
        </p>
        <button
          type="button"
          aria-label={`Close the ${lens.label.toLowerCase()} lens`}
          onClick={() => props.onView({ lens: null })}
          className="flex size-6 shrink-0 items-center justify-center rounded-xs text-ink-muted hover:bg-surface-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--mach-focus)]"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </header>
      {collapsed ? null : (
        <div id={bodyId} className="overflow-x-auto overflow-y-auto" style={{ maxHeight: PANEL_MAX_HEIGHT - PANEL_HEADER_HEIGHT - 1 }}>
          <Body {...body} />
        </div>
      )}
    </section>
  );
}
