/**
 * Contributing entities. Each row carries its entity reference in the Control Tower's grammar and
 * opens it only through the caller's `onOpen(ref, where, interval?)`: the Timeline, framed on the
 * entity's own interval where one was recorded, or the floor. The link's address is the deep link
 * for opening in a new tab; a plain click never navigates by itself. A value that was not recorded
 * says so; it is never shown as zero.
 *
 * `Rows` is the drawer: the same rows for any figure, sortable by value or time, paged.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, MapPin, X } from "lucide-react";
import type { Contributor, ContributorPage } from "../../contract";
import { refLabel } from "../../model/charts";
import { BASIS_WORDS, clockText, count, durationText, tokens, usd } from "../../model/format";
import { pageOf, sortRows, type SortDir } from "../../model/series";
import { trapTab } from "../kit";
import type { AreaData, OnOpen, RowsRequest } from "../types";

export const refHref = (ref: string): string => `#timeline?sel=${encodeURIComponent(ref)}`;

/**
 * Whether a row's entity can be opened where the workspace is mounted (the Shell provides it). Under
 * the Simulation the fixture's tickets are not in the simulated run: such rows are listed without
 * links and say so, never as a link that does nothing. Absent: every row opens.
 */
export const CanOpenRef = createContext<((ref: string) => boolean) | null>(null);

export function contributedText(c: Contributor, unit: RowsRequest["unit"]): string {
  if (c.value === null) return BASIS_WORDS[c.basis];
  switch (unit) {
    case "ms":
      return durationText(c.value);
    case "usd":
      return usd(c.value);
    case "tokens":
      return tokens(c.value);
    case "rate":
      return c.value ? "yes" : "no";
    default:
      return count(c.value);
  }
}

const intervalOf = (c: Contributor) => (c.from_ms !== null && c.to_ms !== null && c.to_ms > c.from_ms ? { from: c.from_ms, to: c.to_ms } : undefined);

export function RefList({ items, unit, showWhen = false, onOpen }: { items: readonly Contributor[]; unit: RowsRequest["unit"]; showWhen?: boolean; onOpen: OnOpen }) {
  const canOpen = useContext(CanOpenRef);
  if (items.length === 0) return <p className="text-body-sm text-ink-muted">None recorded.</p>;
  return (
    <ul className="divide-y divide-line border-y border-line">
      {items.map((c, i) => {
        const l = refLabel(c);
        const iv = intervalOf(c);
        const openable = !canOpen || canOpen(c.ref);
        return (
          <li key={`${c.ref}-${i}`} className="flex items-center gap-3 py-1.5 text-body-sm" data-openable={openable ? undefined : "no"}>
            {openable ? (
            <a
              className="an-link an-mono min-w-0 shrink-0 truncate text-[12.5px]"
              href={refHref(c.ref)}
              translate="no"
              data-ref={c.ref}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpen(c.ref, "timeline", iv);
              }}
              aria-label={`${l.primary}${l.secondary ? `, ${l.secondary}` : ""}: open in the Timeline`}
            >
              {l.primary}
            </a>
            ) : (
              <span className="an-mono min-w-0 shrink-0 truncate text-[12.5px] text-ink" translate="no" data-ref={c.ref}>
                {l.primary}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-caption text-ink-subtle">{[l.secondary, showWhen && c.at_ms !== null ? clockText(c.at_ms) : null, c.risk ? `${c.risk} risk` : null, openable ? null : "not in the simulated run"].filter(Boolean).join(", ")}</span>
            <span className={`an-num shrink-0 text-[12.5px] ${c.value === null ? "text-ink-subtle" : "font-semibold text-ink"}`}>{unit === "count" && c.value !== null ? "" : contributedText(c, unit)}</span>
            {openable ? (
              <button type="button" className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-sunken hover:text-ink" onClick={() => onOpen(c.ref, "floor")} aria-label={`Show ${l.primary} on the floor`} title="Show on the floor">
                <MapPin size={13} aria-hidden="true" />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const PAGE = 25;

/** The drawer listing who contributed to a figure, with what value, and what was not recorded. */
export function Rows({ req, data, onClose, onOpen }: { req: RowsRequest; data: AreaData<ContributorPage>; onClose(): void; onOpen: OnOpen }) {
  const page = data.state === "ready" ? data.value : undefined;
  const ref = useRef<HTMLElement>(null);
  const [sort, setSort] = useState<{ by: "value" | "time"; dir: SortDir }>({ by: "value", dir: "desc" });
  const [p, setP] = useState(0);
  useEffect(() => {
    ref.current?.focus();
  }, [req.key]);
  useEffect(() => {
    // Escape closes the drawer when focus is in it (or nowhere), never when it belongs to something
    // else: a chart's Escape leaves the chart, a popover's closes the popover.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const at = document.activeElement;
      if (!at || at === document.body || ref.current?.contains(at)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const items = useMemo(() => sortRows(page?.items ?? [], (c) => (sort.by === "value" ? c.value : c.at_ms), sort.dir, (c) => c.ref), [page, sort]);
  const pg = pageOf(items, p, PAGE);
  const missing = page?.items.filter((c) => c.value === null).length ?? 0;
  return (
    // Focus stays in the drawer while it is open (Tab wraps from the last control to the first and
    // back); Escape or Close gives it back to the control that opened it.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <aside ref={ref} tabIndex={-1} data-analytics-rows={req.key} className="an-drill z-10 flex min-h-0 flex-col border-l border-line bg-surface focus:outline-none" aria-label={`Rows: ${req.title}`} onKeyDown={(e) => trapTab(e, ref.current)}>
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-label text-ink">{req.title}</h2>
          <p className="an-num text-caption text-ink">
            {data.state === "loading" ? "Reading the rows." : data.state === "error" ? `The observer answered ${data.status ?? "nothing"}: ${data.reason}` : data.state === "unavailable" ? data.reason : page && page.total ? `${count(page.total)} contributing${page.truncated ? `, the first ${page.items.length} served` : ""}` : "No rows recorded for this figure."}
            {missing ? `; ${missing} without a recorded value, listed last` : ""}
          </p>
        </div>
        <button type="button" onClick={onClose} className="inline-flex size-7 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-sunken hover:text-ink" aria-label="Close the rows">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {page && page.items.length > 1 ? (
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-caption text-ink" role="group" aria-label="Order of the rows">
          <span>Order</span>
          {(
            [
              ["value", "desc", req.unit === "count" ? "Count" : "Largest first"],
              ["value", "asc", "Smallest first"],
              ["time", "desc", "Newest first"],
            ] as const
          ).map(([by, dir, label]) => (
            <button key={label} type="button" aria-pressed={sort.by === by && sort.dir === dir} onClick={() => setSort({ by, dir })} className={`h-6 rounded-sm px-1.5 ${sort.by === by && sort.dir === dir ? "bg-surface-sunken font-semibold text-ink underline decoration-accent decoration-2 underline-offset-4" : "hover:text-ink"}`}>
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {/* The list scrolls: it takes focus and has a name, so it can be scrolled by keyboard even when no row is a link (axe scrollable-region-focusable). */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className="an-table-region min-h-0 flex-1 overflow-y-auto px-4 py-2" role="region" aria-label={`The rows of ${req.title}`} tabIndex={0}>
        <RefList items={pg.items} unit={req.unit} showWhen onOpen={onOpen} />
      </div>
      <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-caption text-ink-muted">
        <span className="flex-1">A row opens its entity in the Timeline, framed on its own interval; the pin shows it on the floor.</span>
        {pg.pages > 1 ? (
          <>
            <span className="an-num shrink-0">
              {pg.from}–{pg.to} of {items.length}
            </span>
            <button type="button" className="inline-flex size-7 items-center justify-center rounded-sm hover:bg-surface-sunken disabled:opacity-40" disabled={pg.page === 0} onClick={() => setP(pg.page - 1)} aria-label="Previous rows">
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <button type="button" className="inline-flex size-7 items-center justify-center rounded-sm hover:bg-surface-sunken disabled:opacity-40" disabled={pg.page >= pg.pages - 1} onClick={() => setP(pg.page + 1)} aria-label="Next rows">
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>
    </aside>
  );
}
