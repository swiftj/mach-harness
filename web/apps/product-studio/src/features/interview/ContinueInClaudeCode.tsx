import { useState } from "react";
import { Link } from "react-router";
import { Copy, Terminal } from "lucide-react";
import { Banner, Button, Heading, Text, toast } from "@mach/ui";
import { type InterviewCapability } from "../../api/session";

/**
 * Shown when the host reports `capabilities.interview: false`. The interview then happens in Claude
 * Code, with the command the host gives; this screen never imitates an interview with a form.
 */
export function ContinueInClaudeCode({ sliceId, capability }: { sliceId: string; capability: InterviewCapability }) {
  const command = capability.continueCommand ? `${capability.continueCommand} ${sliceId}` : null;
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!command) return;
    navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        toast({ tone: "success", title: "Copied the command" });
      },
      () => toast({ tone: "info", title: "Could not copy", description: "Select the command and copy it yourself." }),
    );
  };

  return (
    <div className="flex max-w-reading flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Heading level={2} size="title-1">
          Continue this interview in Claude Code
        </Heading>
        <Text size="body-lg" editorial tone="muted">
          The interview cannot run inside Product Studio on this computer, so it happens in Claude Code instead. Everything it writes lands in your
          draft and appears here.
        </Text>
      </div>
      <Banner tone="info" title="Why the interview is not available here">
        {capability.reason ?? "Product Studio's host did not say why."}
      </Banner>
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-body text-ink">
        <li>Open Claude Code in your project's folder.</li>
        <li>
          <span className="mb-2 block">Run this command:</span>
          {command ? (
            <div className="flex items-center gap-2 rounded-md border border-line-strong bg-surface-sunken py-1.5 pl-3 pr-1.5">
              <Terminal aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
              <code className="min-w-0 flex-1 select-all break-all font-mono text-mono text-ink" translate="no">
                {command}
              </code>
              <Button size="sm" variant="secondary" onClick={copy} aria-label={`Copy the command ${command}`}>
                <Copy aria-hidden="true" />
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            <Text tone="muted">The host did not report the command. Ask Claude Code to continue {sliceId} with the product studio skill.</Text>
          )}
        </li>
        <li>Answer the interviewer there. Come back here to read the specification and approve it.</li>
      </ol>
      <Button variant="secondary" asChild className="self-start">
        <Link to={`/slices/${sliceId}`}>Open the specification</Link>
      </Button>
    </div>
  );
}
