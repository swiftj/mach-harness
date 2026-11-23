import type { PrdConversationClient } from "@mach/ui/api";
import { client } from "../../api/client";
import { useConversation, type ConversationClient, type ConversationController, type ConversationSource } from "../../shared/useConversation";

export type { ConversationController };

/**
 * The PRD conversation for one PRD (M19): the one conversation hook (shared/useConversation.ts) over
 * `client.prdConversation`. It may read the PRD and record that PRD's map; settling a section, naming the product and
 * making the drafts are the page's own buttons. Under `vite --mode fixtures` it is the scripted development conversation
 * (dev/scriptedPrdConversation.ts), loaded lazily so the production bundle never contains it.
 */
export function usePrdConversation(prdId: string): ConversationController {
  return useConversation(prdId, prdConversations);
}

const prdConversations: ConversationSource = { load: loadPrdConversationClient, label: "conversation" };

async function loadPrdConversationClient(): Promise<ConversationClient> {
  if (import.meta.env.MODE === "fixtures") {
    return bySubject((await import("./dev/scriptedPrdConversation")).scriptedPrdConversationClient);
  }
  return bySubject(client.prdConversation);
}

function bySubject(prd: PrdConversationClient): ConversationClient {
  return {
    current: (subject, signal) => prd.current(subject, signal),
    history: (subject, signal) => prd.history(subject, signal),
    start: (subject) => prd.start(subject),
    subscribe: prd.subscribe,
    reply: prd.reply,
    interrupt: prd.interrupt,
    stop: prd.stop,
  };
}
