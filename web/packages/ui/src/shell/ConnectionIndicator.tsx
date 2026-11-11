import { CloudOff, Link2, Link2Off, LockKeyhole, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { ConnectionState } from "../api/connection";
import { cn } from "../lib/cn";
import { Spinner } from "../components/spinner";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";

export interface SharedProjectState {
  /** From the last refresh: true reached it, false could not, null not tried yet. */
  reachable: boolean | null;
  /** `status.last_refreshed` (ISO) or null. */
  lastRefreshed: string | null;
  /** `status.shared_project`, e.g. "the main branch of the shared repository". */
  description?: string;
  /** The refresh's `problem` text, shown as is when unreachable. */
  problem?: string | null;
}

export interface ConnectionIndicatorProps {
  /** The browser's link to the local host. */
  host: ConnectionState;
  /** The workspace's link to the shared project (Product Studio only). */
  shared?: SharedProjectState;
  /** Formats the refresh time. Defaults to a local short time. */
  formatTime?: (iso: string) => string;
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

function defaultFormat(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Two links, shown together in the top bar: the browser to the local host, and the workspace to
 * the shared project. Each has an icon and words, so neither relies on colour. Changes are announced
 * politely. The trigger opens a popover with the full explanation.
 */
export function ConnectionIndicator({ host, shared, formatTime = defaultFormat, className }: ConnectionIndicatorProps) {
  const h = hostView[host];
  const sharedLabel = !shared
    ? null
    : shared.reachable === false
      ? "Shared project unreachable"
      : shared.lastRefreshed
        ? `Refreshed ${formatTime(shared.lastRefreshed)}`
        : "Not refreshed yet";
  const sharedTone = shared?.reachable === false ? "text-warning-ink" : "text-ink-muted";

  return (
    <Popover>
      {/* Announces changes of state; the trigger itself carries the full name. */}
      <span role="status" aria-live="polite" className="sr-only">
        {h.label}
        {shared?.reachable === false ? ". Shared project unreachable." : ""}
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
        {sharedLabel ? (
          <>
            <span aria-hidden="true" className="h-4 w-px bg-line-strong" />
            <span className={cn("inline-flex items-center gap-1.5", sharedTone)}>
              {shared?.reachable === false ? <CloudOff aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              <span>{sharedLabel}</span>
            </span>
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <p className={cn("text-label", h.tone)}>{h.label}</p>
          <p className="text-body-sm text-ink-muted">{h.detail}</p>
        </div>
        {shared ? (
          <div className="flex flex-col gap-0.5 border-t border-line pt-3">
            <p className={cn("text-label", shared.reachable === false ? "text-warning-ink" : "text-ink")}>{sharedLabel}</p>
            <p className="text-body-sm text-ink-muted">
              {shared.reachable === false
                ? `Could not reach ${shared.description ?? "the shared project"}. Your drafts are safe; refresh again when you are connected.`
                : `Compared with ${shared.description ?? "the shared project"}.`}
            </p>
            {shared.reachable === false && shared.problem ? (
              <p className="mt-1 rounded-xs bg-surface-sunken px-2 py-1 font-mono text-caption text-ink-muted">{shared.problem}</p>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
