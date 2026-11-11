import { isMachApiError, MachApiError, type Session } from "@mach/ui/api";
import { client } from "./client";

/** What the interview screens read from the session (contract 8.1). */
export interface InterviewCapability {
  available: boolean;
  /** Why the interview cannot run here, in plain words. */
  reason: string | null;
  /**
   * The command prefix the host reports (`capabilities.continue_command`): "/mach:product-studio
   * continue" for a plugin install, "/mach-product-studio continue" for a project install. The app
   * appends the slice ID. Null when the host does not say.
   */
  continueCommand: string | null;
}

export function interviewCapability(session: Session): InterviewCapability {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
  return {
    available: session.capabilities.interview === true,
    reason: text(session.capabilities.interview_reason),
    continueCommand: text(session.capabilities.continue_command),
  };
}

let sessionPromise: Promise<Session> | null = null;

/** GET /api/session once per page; `force` reads it again. */
export function loadSession(force = false): Promise<Session> {
  if (!sessionPromise || force) {
    sessionPromise = client.session().catch((error: unknown) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

export function toApiError(error: unknown, operation: string): MachApiError {
  return isMachApiError(error) ? error : new MachApiError("internal", String(error), operation);
}
