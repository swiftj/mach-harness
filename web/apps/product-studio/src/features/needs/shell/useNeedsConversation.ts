import type { NeedsConversationClient } from "@mach/ui/api";
import { client } from "../../../api/client";
import { useConversation, type ConversationClient, type ConversationController, type ConversationSource } from "../../../shared/useConversation";

export type { ConversationController };

/** The needs conversation's subject in the shared hook: one per project (the host's interview.NeedsSubject). */
export const NEEDS_SUBJECT = "needs";

/**
 * The needs conversation for the product (M17): the one conversation hook (shared/useConversation.ts) over
 * `client.needsConversation`. It may record needs and "nothing to say" with the product manager's words and record a
 * design's map; retiring, publishing, choosing a version, bringing in, settling and publishing a design are the
 * page's own buttons. Under `vite --mode fixtures` it is the scripted development conversation
 * (dev/scriptedNeedsConversation.ts), loaded lazily so the production bundle never contains it.
 */
export function useNeedsConversation(): ConversationController {
  return useConversation(NEEDS_SUBJECT, needsConversations);
}

const needsConversations: ConversationSource = { load: loadNeedsConversationClient, label: "conversation" };

async function loadNeedsConversationClient(): Promise<ConversationClient> {
  if (import.meta.env.MODE === "fixtures") {
    return bySubject((await import("./dev/scriptedNeedsConversation")).scriptedNeedsConversationClient);
  }
  return bySubject(client.needsConversation);
}

/** The shared hook names a conversation by its subject; the needs conversation has one subject, so it ignores it. */
export function bySubject(needs: NeedsConversationClient): ConversationClient {
  return {
    current: (_subject, signal) => needs.current(signal),
    history: (_subject, signal) => needs.history(signal),
    start: (_subject, options) => needs.start(options),
    subscribe: needs.subscribe,
    reply: needs.reply,
    interrupt: needs.interrupt,
    stop: needs.stop,
  };
}
