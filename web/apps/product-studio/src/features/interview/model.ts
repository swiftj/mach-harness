import { type ActivityKind, type InterviewEvent, type InterviewHostState, type InterviewErrorKind, type MessageKind, type ParsedQuestion, type TurnOutcome, type StreamConnection } from "@mach/ui/api";

/**
 * The interview screen's state, built only from the host's events and the PM's own replies. Pure
 * (a reducer), so a replayed stream lands in the same place: messages and questions are keyed by
 * `message_id`, never by question number, and an event seen twice changes nothing.
 */

export type AnswerKind = "accepted" | "revised" | "deferred" | "delegated" | "explain" | "reply";

/** The words each answer button sends. The same words, read back from history, give the answer kind. */
export const answerText = {
  accepted: "yes",
  deferred: "I don't know",
  delegated: "You decide",
  explain: "Why do you recommend that? Explain before I answer.",
} as const;

/** Which answer a reply was, from the app's own fixed words; anything else is the PM's own answer. */
export function answerFromText(text: string, toQuestion: boolean): AnswerKind {
  const found = (Object.keys(answerText) as Array<keyof typeof answerText>).find((kind) => answerText[kind] === text.trim());
  return found ?? (toQuestion ? "revised" : "reply");
}

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
  | {
      type: "reply";
      key: string;
      text: string;
      answer: AnswerKind;
      to: string | null;
      /** The turn the reply starts. */
      turn: number;
      /** Sent from this window and not yet confirmed by the host's `reply` event. */
      pending: boolean;
    }
  | { type: "activity"; key: string; kind: ActivityKind; text: string; turn: number; historic?: boolean }
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
  /** The saved history, oldest first, applied as if it had streamed; replaces the model. */
  | { type: "history"; events: InterviewEvent[]; truncated: boolean }
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
    case "activity": {
      // The live stream replays the current turn after the history already showed it: match each
      // replayed activity once against one loaded from history, so none is shown twice.
      if (event.seq !== null) {
        const seen = model.timeline.find(
          (item) => item.type === "activity" && item.historic && item.turn === model.turn && item.kind === event.data.kind && item.text === event.data.text,
        );
        if (seen && seen.type === "activity") {
          return { ...model, timeline: model.timeline.map((item) => (item === seen ? { ...seen, historic: false } : item)) };
        }
      }
      return {
        ...model,
        lastActivity: event.data.text,
        timeline: [
          ...model.timeline,
          { type: "activity", key: key("a"), kind: event.data.kind, text: event.data.text, turn: model.turn, historic: event.seq === null },
        ],
      };
    }
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
    case "reply": {
      // The PM's reply as the host recorded it, first in its turn. A reply this window sent is already
      // shown (pending): confirm it. A reply replayed for a turn already shown changes nothing.
      const text = event.data.text;
      const same = model.timeline.find((item) => item.type === "reply" && item.turn === model.turn && item.text === text);
      if (same && same.type === "reply") {
        return same.pending ? { ...model, timeline: model.timeline.map((item) => (item === same ? { ...same, pending: false } : item)) } : model;
      }
      return addReply(model, text, answerFromText(text, Boolean(model.awaiting && model.messages[model.awaiting]?.question)), false);
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

/** A reply in the timeline, and the decision it records when it answers a question. */
function addReply(model: InterviewModel, text: string, answer: AnswerKind, pending: boolean): InterviewModel {
  const to = model.awaiting;
  const message = to ? model.messages[to] : undefined;
  const decisions =
    message?.question && answer !== "explain" && answer !== "reply" && !model.decisions.some((d) => d.messageId === message.id)
      ? [
          ...model.decisions,
          {
            messageId: message.id,
            number: message.question.number,
            title: message.question.title,
            recommendation: message.question.recommendation,
            answer,
            text,
          },
        ]
      : model.decisions;
  return {
    ...model,
    awaiting: null,
    turnRunning: true,
    lastReply: text,
    decisions,
    timeline: [...model.timeline, { type: "reply", key: key("r"), text, answer, to, turn: model.turn, pending }],
  };
}

export function interviewReducer(model: InterviewModel, action: ModelAction): InterviewModel {
  switch (action.type) {
    case "event":
      return applyEvent(model, action.event);
    case "connection":
      return { ...model, connection: action.state };
    case "replied":
      return addReply(model, action.text, action.answer, true);
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
    case "history": {
      let next: InterviewModel = { ...initialModel };
      if (action.truncated) {
        next = {
          ...next,
          timeline: [
            {
              type: "notice",
              key: key("h"),
              tone: "info",
              title: "The start of this interview is no longer kept",
              text: "Its oldest part was dropped to keep the history small. Everything settled is in the draft.",
              retry: false,
            },
          ],
        };
      }
      for (const event of action.events) next = applyEvent(next, event);
      // History is the past: nothing is running until the live stream says so.
      return { ...next, connection: model.connection, turnRunning: false, lastActivity: null };
    }
    case "local-notice":
      return { ...model, timeline: [...model.timeline, { type: "notice", key: key("l"), tone: action.tone, title: action.title, text: action.text, retry: false }] };
  }
}

/** Busy states are shown as one calm "working" state, so rapid thinking/working flips are invisible. */
export function isBusy(state: InterviewHostState | null): boolean {
  return state === "starting" || state === "thinking" || state === "working";
}
