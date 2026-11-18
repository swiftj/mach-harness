import { formatExact, formatRelative } from "../lib/format";
import { Tooltip } from "./tooltip";

/**
 * A moment as relative words ("3 days ago"), with the exact time given to assistive technology (the
 * accessible name) and shown on hover and on keyboard focus. The element is a <time> with the
 * machine-readable moment.
 */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const exact = formatExact(iso);
  const relative = formatRelative(iso);
  return (
    <Tooltip content={exact}>
      {/* Focusable so the exact time also shows on keyboard focus, as it does on hover. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <time dateTime={iso} tabIndex={0} aria-label={`${relative}, ${exact}`} className={`rounded-xs ${className ?? ""}`}>
        {relative}
      </time>
    </Tooltip>
  );
}
