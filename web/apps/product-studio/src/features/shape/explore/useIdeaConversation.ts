import type { IdeaConversationClient } from "@mach/ui/api";
import { client } from "../../../api/client";
import { useConversation, type ConversationController, type ConversationPhase, type ConversationSource } from "../../../shared/useConversation";

export type { ConversationController, ConversationPhase };

/**
 * The Shape conversation for one idea: the one conversation hook (shared/useConversation.ts), the slice interview's,
 * over `client.ideaConversation`, named by the idea. Under `vite --mode fixtures` it is the scripted development
 * conversation (dev/scriptedConversation.ts), loaded lazily so the production bundle never contains it.
 */
export function useIdeaConversation(ideaId: string): ConversationController {
  return useConversation(ideaId, ideaConversations);
}

const ideaConversations: ConversationSource = { load: loadIdeaConversationClient, label: "conversation" };

async function loadIdeaConversationClient(): Promise<IdeaConversationClient> {
  if (import.meta.env.MODE === "fixtures") {
    return (await import("./dev/scriptedConversation")).scriptedConversationClient;
  }
  return client.ideaConversation;
}
