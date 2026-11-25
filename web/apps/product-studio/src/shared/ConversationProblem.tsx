import { Banner, HintAction } from "@mach/ui";
import type { MachApiError } from "@mach/ui/api";
import { conversationProblemWords } from "./useConversation";

/**
 * A conversation's problem above its body. A reply sent while the conversation is still writing is a warning with the
 * one action that stops that reply and sends this one; anything else is shown in the host's words.
 */
export function ConversationProblem({ problem, who = "MACH" }: { problem: MachApiError; who?: "The interviewer" | "MACH" }) {
  const words = conversationProblemWords(problem, who);
  return (
    <Banner tone={words.tone} title={words.title} actions={problem.hint ? <HintAction hint={problem.hint} /> : undefined}>
      {words.message}
    </Banner>
  );
}
