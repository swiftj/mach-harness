import type { InterviewClient } from "@mach/ui/api";
import { client } from "../../api/client";
import { forgetIdea, peekIdea } from "../../api/pendingIdea";
import { useConversation, type ConversationClient, type ConversationController, type ConversationPhase, type ConversationSource } from "../../shared/useConversation";

export type InterviewPhase = ConversationPhase;
export type InterviewController = ConversationController;

/**
 * The slice interview: the one conversation hook (shared/useConversation.ts) over the slice interview's client. The idea
 * typed in "Start a slice" goes with the slice's first start, then is forgotten.
 */
export function useInterview(sliceId: string): InterviewController {
  return useConversation(sliceId, sliceInterviews);
}

const sliceInterviews: ConversationSource = { load: loadInterviewClient, label: "interview", started: forgetIdea };

function bySlice(interviews: InterviewClient): ConversationClient {
  return { ...interviews, start: (sliceId, options) => interviews.start(sliceId, peekIdea(sliceId), options) };
}

/**
 * The interview client this screen uses: the shared one from @mach/ui/api. Under `vite --mode fixtures` it is the
 * scripted development interview (dev/scriptedInterview.ts), loaded lazily so the production bundle never contains it.
 */
async function loadInterviewClient(): Promise<ConversationClient> {
  if (import.meta.env.MODE === "fixtures") {
    return bySlice((await import("./dev/scriptedInterview")).scriptedInterviewClient);
  }
  return bySlice(client.interview);
}
