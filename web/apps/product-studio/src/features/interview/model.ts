import { type ActivityKind, type InterviewEvent, type InterviewHostState, type InterviewErrorKind, type MessageKind, type ParsedQuestion, type TurnOutcome, type StreamConnection } from "@mach/ui/api";

/**
 * The interview screen's state, built only from the host's events and the PM's own replies. Pure
 * (a reducer), so a replayed stream lands in the same place: messages and questions are keyed by
 * `message_id`, never by question number, and an event seen twice changes nothing.
 */

export type AnswerKind = "accepted" | "revised" | "deferred" | "delegated" | "explain" | "reply";

export interface InterviewerMessage {
  id: string;
  text: string;
  /** Set by `message`: the reply the PM answers. Streamed text without it is narration or abandoned. */
  final: boolean;
  kind: MessageKind | null;
  question: ParsedQuestion | null;
  /** The turn it was streamed in. */
  turn: number;
}

export type TimelineItem =
  | { type: "message"; key: string; id: string }
  | { type: "reply"; key: string; text: string; answer: AnswerKind; to: string | null }
  | { type: "activity"; key: string; kind: ActivityKind; text: string; turn: number }
  | { type: "notice"; key: string; tone: "info" | "warning" | "danger"; title: string; text: string | null; retry: boolean };

export interface Decision {
  messageId: string;
  number: number;
  title: string;
  recommendation: string;
  answer: AnswerKind;
  text: string;
}

export interface InterviewModel {
  hostState: InterviewHostState | null;
  connection: StreamConnection;
  messages: Record<string, InterviewerMessage>;
  timeline: TimelineItem[];
  /** The final message waiting for the PM's reply. */
  awaiting: string | null;
  decisions: Decision[];
  turn: number;
  /** True from the PM's reply until the turn closes. */
  turnRunning: boolean;
  lastTurn: { outcome: TurnOutcome; seconds: number; cost: number | null; sessionCost: number | null } | null;
  ended: { reason: string } | null;
  /** The last reply the PM sent, so a failed turn can be asked again. */
  lastReply: string | null;
  draftChanges: number;
  lastActivity: string | null;
}

export const initialModel: InterviewModel = {
  hostState: null,
  connection: "connecting",
  messages: {},
  timeline: [],
  awaiting: null,
  decisions: [],
  turn: 0,
  turnRunning: false,
  lastTurn: null,
  ended: null,
  lastReply: null,
  draftChanges: 0,
  lastActivity: null,
};

export type ModelAction =
  | { type: "event"; event: InterviewEvent }
  | { type: "connection"; state: StreamConnection }
  | { type: "replied"; text: string; answer: AnswerKind }
  | { type: "reply-failed" }
  | { type: "reset"; decisions?: Decision[] }
  | { type: "local-notice"; tone: "info" | "warning" | "danger"; title: string; text: string | null };

let noticeCounter = 0;
const key = (prefix: string) => `${prefix}-${++noticeCounter}`;

const errorTitles: Record<string, string> = {
  error_max_budget_usd: "This reply reached its spending limit",
  timed_out: "The interviewer took too long to reply",
  no_result: "The interviewer stopped without replying",
  error_during_execution: "The reply did not finish",
  unavailable: "The interviewer is not available",
};

export function errorTitle(kind: InterviewErrorKind): string {
  return errorTitles[kind] ?? "The interviewer ran into a problem";
}

function upsertMessage(model: InterviewModel, id: string, patch: (m: InterviewerMessage) => InterviewerMessage): InterviewModel {
  const existing = model.messages[id];
  const base: InterviewerMessage = existing ?? { id, text: "", final: false, kind: null, question: null, turn: model.turn };
  const next = patch(base);
  const timeline = existing || model.timeline.some((item) => item.type === "message" && item.id === id)
    ? model.timeline
    : [...model.timeline, { type: "message" as const, key: `m-${id}`, id }];
  return { ...model, messages: { ...model.messages, [id]: next }, timeline };
}

function applyEvent(model: InterviewModel, event: InterviewEvent): InterviewModel {
  switch (event.type) {
    case "state": {
      const busy = event.data === "starting" || event.data === "thinking" || event.data === "working";
      return {
        ...model,
        hostState: event.data,
        turnRunning: busy ? true : event.data === "waiting_for_reply" ? false : model.turnRunning,
      };
    }
    case "text": {
      const { message_id, delta } = event.data;
      if (model.messages[message_id]?.final) return model;
      return upsertMessage(model, message_id, (m) => ({ ...m, text: m.text + delta }));
    }
    case "message": {
      const { message_id, text, kind } = event.data;
      if (model.messages[message_id]?.final) return model;
      const next = upsertMessage(model, message_id, (m) => ({ ...m, text, kind, final: true }));
      return { ...next, awaiting: message_id };
    }
    case "question": {
      const q = event.data;
      if (model.messages[q.message_id]?.question) return model;
      return upsertMessage(model, q.message_id, (m) => ({ ...m, question: q }));
    }
    case "activity":
      return {
        ...model,
        lastActivity: event.data.text,
        timeline: [...model.timeline, { type: "activity", key: key("a"), kind: event.data.kind, text: event.data.text, turn: model.turn }],
      };
    case "draft_changed":
      return { ...model, draftChanges: model.draftChanges + 1 };
    case "turn": {
      // Streamed text that never became a final message is narration or an abandoned reply: drop it.
      const dropped = new Set(
        Object.values(model.messages)
          .filter((m) => !m.final && m.turn === model.turn)
          .map((m) => m.id),
      );
      const messages = { ...model.messages };
      dropped.forEach((id) => delete messages[id]);
      let timeline = model.timeline.filter((item) => !(item.type === "message" && dropped.has(item.id)));
      if (event.data.outcome === "interrupted") {
        timeline = [
          ...timeline,
          { type: "notice", key: key("n"), tone: "info", title: "You interrupted that reply", text: "Nothing from it was kept. Reply when you are ready.", retry: false },
        ];
      }
      return {
        ...model,
        messages,
        timeline,
        turn: model.turn + 1,
        turnRunning: false,
        lastActivity: null,
        lastTurn: { outcome: event.data.outcome, seconds: event.data.seconds, cost: event.data.cost_usd, sessionCost: event.data.session_cost_usd },
      };
    }
    case "ended":
      return { ...model, ended: { reason: event.data.reason }, turnRunning: false, hostState: "ended" };
    case "error":
      return {
        ...model,
        timeline: [
          ...model.timeline,
          { type: "notice", key: key("e"), tone: "warning", title: errorTitle(event.data.kind), text: event.data.message, retry: Boolean(model.lastReply) },
        ],
      };
  }
}

export function interviewReducer(model: InterviewModel, action: ModelAction): InterviewModel {
  switch (action.type) {
    case "event":
      return applyEvent(model, action.event);
    case "connection":
      return { ...model, connection: action.state };
    case "replied": {
      const to = model.awaiting;
      const message = to ? model.messages[to] : undefined;
      const decisions =
        message?.question && action.answer !== "explain" && !model.decisions.some((d) => d.messageId === message.id)
          ? [
              ...model.decisions,
              {
                messageId: message.id,
                number: message.question.number,
                title: message.question.title,
                recommendation: message.question.recommendation,
                answer: action.answer,
                text: action.text,
              },
            ]
          : model.decisions;
      return {
        ...model,
        awaiting: null,
        turnRunning: true,
        lastReply: action.text,
        decisions,
        timeline: [...model.timeline, { type: "reply", key: key("r"), text: action.text, answer: action.answer, to }],
      };
    }
    case "reply-failed": {
      // The host did not take the reply: put the question back and drop the optimistic entry.
      const lastReply = [...model.timeline].reverse().find((item) => item.type === "reply");
      if (!lastReply || lastReply.type !== "reply") return { ...model, turnRunning: false };
      return {
        ...model,
        awaiting: lastReply.to,
        turnRunning: false,
        decisions: model.decisions.filter((d) => d.messageId !== lastReply.to),
        timeline: model.timeline.filter((item) => item !== lastReply),
      };
    }
    case "reset":
      return { ...initialModel, decisions: action.decisions ?? [] };
    case "local-notice":
      return { ...model, timeline: [...model.timeline, { type: "notice", key: key("l"), tone: action.tone, title: action.title, text: action.text, retry: false }] };
  }
}

/** Busy states are shown as one calm "working" state, so rapid thinking/working flips are invisible. */
export function isBusy(state: InterviewHostState | null): boolean {
  return state === "starting" || state === "thinking" || state === "working";
}
