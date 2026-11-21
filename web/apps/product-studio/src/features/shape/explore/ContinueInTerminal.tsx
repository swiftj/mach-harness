import { Banner, CommandLine, Heading, Text } from "@mach/ui";
import type { InterviewCapability } from "../../../api/session";
import { exploreCommand } from "./model";

/**
 * Claude Code cannot run the conversation here (`capabilities.interview: false`, or the host answered "unavailable"):
 * it happens in Claude Code instead, with the command for this install, as the slice interview's
 * ContinueInClaudeCode does. This screen never imitates the conversation with a form.
 */
export function ContinueInTerminal({ ideaId, capability }: { ideaId: string; capability: InterviewCapability }) {
  const command = exploreCommand(capability.exploreCommand, ideaId);
  return (
    <div className="flex max-w-reading flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Heading level={3} size="title-3">
          Continue this conversation in Claude Code
        </Heading>
        <Text tone="muted">
          The conversation cannot run inside Product Studio on this computer, so it happens in Claude Code instead. Your brief, your case and what MACH looks up appear here as they are written.
        </Text>
      </div>
      {capability.reason ? (
        <Banner tone="info" title="Why it is not available here">
          {capability.reason}
        </Banner>
      ) : null}
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-body text-ink">
        <li>Open Claude Code in your project's folder.</li>
        <li>
          <span className="mb-2 block">Run this command:</span>
          {command ? (
            <CommandLine command={command} purpose={`to explore ${ideaId} in Claude Code`} />
          ) : (
            <Text tone="muted">The host did not report the command. Ask Claude Code to explore {ideaId} with the product studio skill.</Text>
          )}
        </li>
        <li>Answer the questions there. Come back here to read your brief and what was looked up.</li>
      </ol>
    </div>
  );
}
