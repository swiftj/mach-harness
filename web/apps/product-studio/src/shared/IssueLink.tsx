import { ExternalLink } from "lucide-react";

/**
 * A slice's issue number, linked to the address the engine reported for it. Without an address it
 * is the number alone: the app never builds a GitHub address itself.
 */
export function IssueLink({ number, url }: { number: number; url: string | null }) {
  if (!url) return <span className="font-mono tabular">#{number}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 rounded-xs font-mono font-semibold text-accent-ink tabular underline-offset-2 hover:underline">
      #{number}
      <ExternalLink aria-hidden="true" className="size-3" />
      <span className="sr-only"> (opens GitHub in a new tab)</span>
    </a>
  );
}

/** "Issue #2": an epic's, the project's or a slice's issue, linked to the address the engine reported. */
export function IssueNumber({ number, url }: { number: number; url: string | null }) {
  return (
    <span className="text-body-sm text-ink-muted">
      Issue <IssueLink number={number} url={url} />
    </span>
  );
}
