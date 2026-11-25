import { Banner, Button } from "@mach/ui";
import type { ConversationController } from "./useConversation";

/**
 * Another window on this computer is writing this conversation. The host's warning says what continuing here means;
 * the one button continues here all the same. Never a dead end.
 */
export function TakeOverBanner({ conv, subject }: { conv: Pick<ConversationController, "takeOverWarning" | "takeOver" | "problem">; subject: string }) {
  const message =
    conv.takeOverWarning ??
    (conv.problem?.kind === "conflict"
      ? conv.problem.message
      : `Another window on this computer is writing ${subject} right now. Continuing here means two writers: the draft keeps whichever saves last.`);
  return (
    <Banner tone="warning" title="Another window is writing this" live="polite" actions={<Button onClick={conv.takeOver}>Take it over here</Button>}>
      {message}
    </Banner>
  );
}
