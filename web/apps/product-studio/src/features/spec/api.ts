import { useCallback, useEffect, useState } from "react";
import { createClient, isMachApiError, MachApiError, type MachClient, type Session, type SliceShow, type Transport } from "@mach/ui/api";
import { client as appClient } from "../../api/client";

/**
 * The client the interview and specification screens use.
 *
 * In production this IS the app's shared client (same origin, same CSRF token, same connection
 * state). Under `vite --mode fixtures` it wraps the shell's fixture transport with this folder's
 * dev-only transport, which also answers `slice.show`, `slice.reopen`, `slice.pause`, draft writes
 * and the session's interview capability. Vite replaces import.meta.env.MODE at build time, so the
 * production bundle contains none of it.
 *
 * PROMOTION CANDIDATE: once the shell's fixture transport answers slice.show and friends, delete
 * this wrapper and import `client` from "../../api/client" directly.
 */
const devTransport: Transport | undefined =
  import.meta.env.MODE === "fixtures"
    ? async (request) => (await import("./dev/sliceFixtures")).sliceFixtureTransport(request)
    : undefined;

export const studioClient: MachClient = devTransport ? createClient({ transport: devTransport, connection: appClient.connection }) : appClient;

export const usingDevData = import.meta.env.MODE === "fixtures";

/** The session fields these screens read. `interview_reason` is the host's name (contract 8.1). */
export interface InterviewCapability {
  available: boolean;
  reason: string | null;
  /**
   * The command prefix the host reports (`capabilities.continue_command`): "/mach:product-studio
   * continue" for a plugin install, "/mach-product-studio continue" for a project install. The app
   * appends the slice ID. Null when the host does not say.
   */
  continueCommand: string | null;
}

export function interviewCapability(session: Session): InterviewCapability {
  const caps = session.capabilities as unknown as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
  return {
    available: caps.interview === true,
    // The host's name; the shell's early fixture used interview_unavailable_reason.
    reason: text(caps.interview_reason) ?? text(caps.interview_unavailable_reason),
    continueCommand: text(caps.continue_command),
  };
}

let sessionPromise: Promise<Session> | null = null;

/** GET /api/session once per page (it also stores the CSRF token the interview routes need). */
export function loadSession(force = false): Promise<Session> {
  if (!sessionPromise || force) {
    sessionPromise = studioClient.session().catch((error: unknown) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

export function toApiError(error: unknown, operation: string): MachApiError {
  return isMachApiError(error) ? error : new MachApiError("internal", String(error), operation);
}

export interface SliceShowState {
  data: SliceShow | null;
  error: MachApiError | null;
  /** True while a read is in flight. Earlier data stays visible meanwhile. */
  loading: boolean;
  reload: () => void;
  /** Replace the data with a newer result (after an approval, a reopen). */
  replaceCheck: (check: SliceShow["check"]) => void;
}

/**
 * Reads `slice.show` for one slice; `reload()` reads it again (after draft_changed, a write, an act).
 * Earlier data stays visible while a newer read is in flight. Mount one per slice (key by slice ID).
 */
export function useSliceShow(sliceId: string): SliceShowState {
  const [tick, setTick] = useState(0);
  const request = `${sliceId} ${tick}`;
  const [settled, setSettled] = useState<{ request: string; data: SliceShow | null; error: MachApiError | null } | null>(null);
  const [override, setOverride] = useState<{ request: string; check: SliceShow["check"] } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    studioClient
      .op("slice.show", { slice_id: sliceId }, controller.signal)
      .then((data) => setSettled({ request, data, error: null }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setSettled((previous) => ({ request, data: previous?.data ?? null, error: toApiError(cause, "slice.show") }));
      });
    return () => controller.abort();
  }, [sliceId, request]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = settled?.data ?? null;
  const replaceCheck = useCallback((check: SliceShow["check"]) => setOverride({ request, check }), [request]);
  const data = current && override && override.request === settled?.request ? { ...current, check: override.check } : current;
  return {
    data,
    error: settled?.request === request ? settled.error : null,
    loading: settled?.request !== request,
    reload,
    replaceCheck,
  };
}

/** Engine IDs, checked before an ID from the address bar is used. Mirrors the client's own check. */
export const SLICE_ID = /^[A-Z]+-\d{3,}$/;
