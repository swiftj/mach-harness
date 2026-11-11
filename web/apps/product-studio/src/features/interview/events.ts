/**
 * The interview's events and routes, as contract section 8.2 and the host's author describe them.
 *
 * PROMOTION CANDIDATE: `@mach/ui/api` still carries the provisional section-6 shapes
 * (`InterviewEvent` with `text: string`). These replace them; move this file there when the shell
 * owner adds the typed interview client.
 */

export type InterviewHostState = "starting" | "thinking" | "working" | "waiting_for_reply" | "ended" | "failed";

export type MessageKind = "question" | "confirmation" | "other";

export interface ParsedQuestion {
  message_id: string;
  /** Restarts at 1 in every session: never a key. */
  number: number;
  title: string;
  body: string;
  recommendation: string;
  /** Up to a few lines the interviewer wrote before the question. */
  preface: string;
}

export type ActivityKind = "lookup" | "check" | "save" | "write" | "refused" | "other";

export type TurnOutcome = "replied" | "interrupted" | "timed_out" | "failed" | "error_max_budget_usd" | (string & {});

export type InterviewErrorKind =
  | "no_result"
  | "timed_out"
  | "error_max_budget_usd"
  | "error_during_execution"
  | "unavailable"
  | (string & {});

export interface InterviewEventMap {
  state: InterviewHostState;
  text: { message_id: string; delta: string };
  message: { message_id: string; text: string; kind: MessageKind };
  question: ParsedQuestion;
  activity: { kind: ActivityKind; text: string };
  draft_changed: { slice_id: string; what: Array<"spec" | "why" | "work_order" | (string & {})> };
  turn: { outcome: TurnOutcome; seconds: number; cost_usd: number | null; session_cost_usd: number | null; refused: number | string[] | null };
  ended: { reason: "stopped" | "failed" | "host_shutdown" | (string & {}) };
  error: { kind: InterviewErrorKind; message: string };
}

export type InterviewEventName = keyof InterviewEventMap;

export type InterviewEvent = { [K in InterviewEventName]: { type: K; data: InterviewEventMap[K]; seq: number | null } }[InterviewEventName];

export const interviewEventNames: InterviewEventName[] = [
  "state",
  "text",
  "message",
  "question",
  "activity",
  "draft_changed",
  "turn",
  "ended",
  "error",
];

/** GET /api/interview?slice_id=: what the host knows about a slice's interview. */
export interface InterviewSummary {
  interview_id: string | null;
  slice_id: string;
  /** A process holds this slice's interview now. False when only a saved session exists. */
  live: boolean;
  state: InterviewHostState | "saved";
  turn_running: boolean;
  /** Another host or window holds the slice's lock. */
  locked_elsewhere: boolean;
  last_message: { message_id: string; text: string; kind: MessageKind; question: ParsedQuestion | null } | null;
  turns: number;
  session_cost_usd: number | null;
}

export interface StartResult {
  interview_id: string;
  slice_id: string;
  resumed: boolean;
}
