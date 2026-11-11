/** Error kinds the host returns in `{ ok: false, error: { kind, message } }` (contract section 4). */
export type HostErrorKind = "refused" | "invalid" | "unauthorized" | "conflict" | "unavailable" | "internal";

/** Kinds the client adds when there is no envelope to read. */
export type ClientErrorKind =
  /** The host could not be reached at all (stopped, network error). */
  | "network"
  /** The host answered with something that is not the envelope. */
  | "protocol"
  /** The request was cancelled by the caller (AbortSignal). */
  | "aborted";

export type ApiErrorKind = HostErrorKind | ClientErrorKind;

/**
 * Every failed call rejects with this. `message` is written for a person when kind is "refused"
 * (the engine's own words) and should be shown as is; for other kinds, show `describeError(error)`.
 */
export class MachApiError extends Error {
  override readonly name = "MachApiError";
  readonly kind: ApiErrorKind;
  /** HTTP status, when there was a response. */
  readonly status: number | null;
  /** The operation or path that failed, for logs. Never contains tokens or bodies. */
  readonly operation: string;

  constructor(kind: ApiErrorKind, message: string, operation: string, status: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.operation = operation;
  }
}

export function isMachApiError(value: unknown): value is MachApiError {
  return value instanceof MachApiError;
}

/** A heading for an error, in the interface's voice. The message itself is shown underneath. */
export function describeError(error: MachApiError): { title: string; message: string } {
  switch (error.kind) {
    case "refused":
      return { title: "Not done", message: error.message };
    case "invalid":
      return { title: "That request was not accepted", message: error.message };
    case "unauthorized":
      return {
        title: "This window is no longer signed in",
        message: "Start Product Studio again from Claude Code to open a new session.",
      };
    case "conflict":
      return { title: "Already in progress", message: error.message };
    case "unavailable":
      return { title: "Not available right now", message: error.message };
    case "network":
      return {
        title: "Product Studio is not responding",
        message: "The local host may have stopped. Start it again from Claude Code, then reload this page.",
      };
    case "protocol":
      return { title: "Unexpected reply from the host", message: error.message };
    case "aborted":
      return { title: "Cancelled", message: error.message };
    case "internal":
    default:
      return { title: "Something failed inside the host", message: error.message };
  }
}

/**
 * The words for a failed act, for an ErrorState or a ConfirmDialog's `error`. A refusal is the
 * engine's own message, under a title that names what did not happen ("WAVE-001 was not sent").
 */
export function failureText(error: MachApiError, whatDidNotHappen: string): { title: string; message: string } {
  if (error.kind === "refused") return { title: whatDidNotHappen, message: error.message };
  return describeError(error);
}
