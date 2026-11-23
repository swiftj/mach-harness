import { ExternalLink } from "lucide-react";
import { cn } from "@mach/ui";
import { issueParts, type IssueUrls } from "./team";

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

/**
 * One quiet line beside the first place a screen offers an issue link: GitHub answers "not found"
 * for a private repository's issue in a browser that is not signed in, which reads as a broken link.
 * The app never checks sign-in and makes no request of its own; it only says how GitHub behaves.
 */
export function SignInNote({ className }: { className?: string }) {
  return <p className={cn("text-caption text-ink-subtle", className)}>An issue in a private repository opens only in a browser signed in to GitHub with access to it.</p>;
}

/**
 * A sentence that names issues ("#3"), each linked in place where the engine gave its address (M20). The words are kept as
 * they are; a number without an address stays plain text.
 */
export function IssueText({ text, urls }: { text: string; urls: IssueUrls }) {
  return (
    <>
      {issueParts(text, urls).map((part, index) => (typeof part === "string" ? part : <IssueLink key={index} number={part.number} url={part.url} />))}
    </>
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
