import { CircleCheck, CloudOff, Link2, Link2Off, LockKeyhole, RefreshCwOff } from "lucide-react";
import type { ReactNode } from "react";
import type { ConnectionState } from "../api/connection";
import type { SavedReport } from "../api/types";
import { cn } from "../lib/cn";
import { Spinner } from "../components/spinner";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";

/** Whether the workspace's work has reached where it is kept: `status.saved`, in the engine's words. */
export interface SavedState {
  everythingSaved: boolean;
  /** "Everything is saved." or "2 things are not saved yet." */
  note: string;
  /** Each thing not saved yet, as the engine words it. */
  items: string[];
  /** The last check of GitHub failed: the engine's words for what happened and how old what is shown is. Null when it worked. */
  check: string | null;
}

/** The indicator's form of the engine's `status.saved`. */
export function savedState(report: SavedReport): SavedState {
  return {
    everythingSaved: report.everything_saved,
    note: report.note,
    items: report.not_saved.map((item) => item.text),
    check: report.github_check?.text ?? null,
  };
}

export interface ConnectionIndicatorProps {
  /** The browser's link to the local host. */
  host: ConnectionState;
  /** Whether everything is saved (Product Studio only). */
  saved?: SavedState;
  /** Checks GitHub again; shown with the notice of a failed check. */
  onCheckAgain?: () => void;
  /** A check is running now. */
  checking?: boolean;
  className?: string;
}

const hostView: Record<ConnectionState, { label: string; detail: string; icon: ReactNode; tone: string }> = {
  connecting: { label: "Connecting", detail: "Waiting for the local host to answer.", icon: <Spinner size="sm" />, tone: "text-ink-muted" },
  online: { label: "Connected", detail: "The local host is answering.", icon: <Link2 aria-hidden="true" />, tone: "text-success-ink" },
  offline: {
    label: "Host not responding",
    detail: "The local host may have stopped. Start Product Studio again from Claude Code, then reload.",
    icon: <Link2Off aria-hidden="true" />,
    tone: "text-danger-ink",
  },
  unauthorized: {
    label: "Session ended",
    detail: "This window is no longer signed in to the host. Start Product Studio again to open a new session.",
    icon: <LockKeyhole aria-hidden="true" />,
    tone: "text-warning-ink",
  },
};

/**
 * Two facts, shown together in the top bar: the browser's link to the local host, and whether
 * everything is saved. Each has an icon and words, so neither relies on colour. Changes are
 * announced politely. The trigger opens a popover with the full explanation.
 */
export function ConnectionIndicator({ host, saved, onCheckAgain, checking, className }: ConnectionIndicatorProps) {
  const h = hostView[host];
  const savedLabel = saved ? saved.note.replace(/\.$/, "") : null;
  const savedTone = saved && !saved.everythingSaved ? "text-warning-ink" : "text-ink-muted";

  return (
    <Popover>
      {/* Announces changes of state; the trigger itself carries the full name. */}
      <span role="status" aria-live="polite" className="sr-only">
        {h.label}
        {saved && !saved.everythingSaved ? `. ${saved.note}` : ""}
        {saved?.check ? ". GitHub not checked." : ""}
      </span>
      <PopoverTrigger
        className={cn(
          "inline-flex h-8 items-center gap-3 rounded-sm px-2 text-body-sm hover:bg-surface-sunken [&_svg]:size-4",
          className,
        )}
      >
        <span className="sr-only">Connection: </span>
        <span className={cn("inline-flex items-center gap-1.5", h.tone)}>
          {h.icon}
          <span className="font-semibold">{h.label}</span>
        </span>
        {savedLabel ? (
          <>
            <span aria-hidden="true" className="h-4 w-px bg-line-strong" />
            <span className={cn("inline-flex items-center gap-1.5", savedTone)}>
              {saved?.everythingSaved ? <CircleCheck aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
              <span>{savedLabel}</span>
            </span>
          </>
        ) : null}
        {saved?.check ? (
          <>
            <span aria-hidden="true" className="h-4 w-px bg-line-strong" />
            <span className="inline-flex items-center gap-1.5 text-warning-ink">
              <RefreshCwOff aria-hidden="true" />
              <span>GitHub not checked</span>
            </span>
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <p className={cn("text-label", h.tone)}>{h.label}</p>
          <p className="text-body-sm text-ink-muted">{h.detail}</p>
        </div>
        {saved ? (
          <div className="flex flex-col gap-1 border-t border-line pt-3">
            <p className={cn("text-label", saved.everythingSaved ? "text-ink" : "text-warning-ink")}>{saved.note}</p>
            {saved.items.length ? (
              <ul className="flex list-disc flex-col gap-1 pl-4 text-body-sm text-ink-muted">
                {saved.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="text-body-sm text-ink-muted">Your drafts are kept on this computer; what you marked ready is on GitHub.</p>
            )}
          </div>
        ) : null}
        {saved?.check ? (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <p className="text-label text-warning-ink">GitHub not checked</p>
            <p className="text-body-sm text-ink-muted">{saved.check}</p>
            {onCheckAgain ? (
              <button
                type="button"
                onClick={checking ? undefined : onCheckAgain}
                aria-disabled={checking || undefined}
                className="self-start rounded-sm border border-line-strong px-2 py-1 text-body-sm font-semibold text-ink hover:bg-surface-sunken aria-disabled:opacity-60"
              >
                {checking ? "Checking GitHub…" : "Check GitHub again"}
              </button>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
