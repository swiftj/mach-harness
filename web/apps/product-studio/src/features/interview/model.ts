import type { ActivityKind, InterviewEvent, InterviewHostState, InterviewErrorKind, MessageKind, ParsedQuestion, TurnOutcome, StreamConnection } from "@mach/ui/api";

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
  /** The interview that ended, and why. Only the interview it belongs to is governed by it. */
  ended: { reason: string; interviewId: string | null } | null;
  /** The live interview this window is attached to. */
  attached: string | null;
  /**
   * After history loads, the host's stream first replays events that history already holds (the
   * latest turn and the last question). Each replayed event is recognised by its identity (name and
   * data, within the same interview) and taken off this list instead of being applied twice. The
   * first live event that is not on it closes the window.
   */
  replay: { interviewId: string; expected: string[] } | null;
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
  attached: null,
  replay: null,
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
  /** The saved history, oldest first, each with the interview it came from; replaces the model. */
  | { type: "history"; events: Array<{ event: InterviewEvent; interviewId: string }>; truncated: boolean }
  /** This window subscribed to a live interview. */
  | { type: "attached"; interviewId: string }
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
      // A new or resumed interview is starting: an earlier interview's end no longer applies.
      if (event.data === "starting" && model.ended) model = { ...model, ended: null };
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
    case "reply": {
      // A reply this window sent is already shown (pending): the host's record confirms it.
      const text = event.data.text;
      const mine = [...model.timeline].reverse().find((item) => item.type === "reply" && item.pending && item.text === text);
      if (mine && mine.type === "reply") {
        return { ...model, timeline: model.timeline.map((item) => (item === mine ? { ...mine, pending: false } : item)) };
      }
      return addReply(model, text, answerFromText(text, Boolean(model.awaiting && model.messages[model.awaiting]?.question)), false);
    }
    case "ended":
      return { ...model, ended: { reason: event.data.reason, interviewId: model.attached }, turnRunning: false, hostState: "ended" };
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

/**
 * An event's identity within its interview: its name and its data. Keys are put in order first: the
 * saved history and the live stream serialise the same data with their keys in different orders.
 */
function identity(event: InterviewEvent): string {
  return `${event.type} ${canonical(event.data)}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Events that say nothing about whether the replay is over: streamed text and the busy states are
 * never saved in history, and a message or question already known by its ID changes nothing.
 */
function neutral(model: InterviewModel, event: InterviewEvent): boolean {
  if (event.type === "text") return true;
  if (event.type === "state") return event.data === "thinking" || event.data === "working";
  if (event.type === "message") return model.messages[event.data.message_id]?.final === true;
  if (event.type === "question") return model.messages[event.data.message_id]?.question != null;
  return false;
}

/**
 * What the host may replay on connect, from the last interview in history: its latest turn (from the
 * reply that opened it, or from its start) and its last message and question.
 */
function replayWindow(events: Array<{ event: InterviewEvent; interviewId: string }>): InterviewModel["replay"] {
  const last = events.at(-1)?.interviewId;
  if (!last) return null;
  const own = events.filter((e) => e.interviewId === last).map((e) => e.event);
  const lastReply = own.map((e) => e.type).lastIndexOf("reply");
  // From the question that reply answered (the host replays it as "the last final message").
  const answered = lastReply > 0 ? own.slice(0, lastReply).map((e) => e.type).lastIndexOf("message") : -1;
  const window = own.slice(Math.max(answered >= 0 ? answered : lastReply, 0));
  const finals = own.filter((e) => e.type === "message" || e.type === "question").slice(-2);
  return { interviewId: last, expected: [...finals, ...window].map(identity) };
}

/** While the replayed turn's own `turn` event is still expected, that turn is over: its text and busy states are stale. */
function pastTurnNoise(replay: NonNullable<InterviewModel["replay"]>, event: InterviewEvent): boolean {
  const unsaved = event.type === "text" || (event.type === "state" && (event.data === "thinking" || event.data === "working"));
  return unsaved && replay.expected.some((id) => id.startsWith("turn "));
}

/** A live event: one the history already holds is taken off the replay window, not applied again. */
function applyLive(model: InterviewModel, event: InterviewEvent): InterviewModel {
  if (model.replay && model.replay.interviewId === model.attached && pastTurnNoise(model.replay, event)) {
    // Streamed text and busy states of a turn the history already closed: nothing to show.
    return model;
  }
  if (model.replay && model.replay.interviewId === model.attached && !neutral(model, event)) {
    const index = model.replay.expected.indexOf(identity(event));
    if (index >= 0) {
      const expected = model.replay.expected.filter((_, i) => i !== index);
      return { ...model, replay: expected.length ? { ...model.replay, expected } : null };
    }
    // Something new: the replay is over.
    return applyEvent({ ...model, replay: null }, event);
  }
  return applyEvent(model, event);
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
      return applyLive(model, action.event);
    case "attached": {
      const replay = model.replay && model.replay.interviewId === action.interviewId ? model.replay : null;
      const ended = model.ended && model.ended.interviewId !== action.interviewId ? null : model.ended;
      return { ...model, attached: action.interviewId, replay, ended, hostState: ended ? model.hostState : model.hostState === "ended" ? null : model.hostState };
    }
    case "connection":
      return { ...model, connection: action.state };
    case "replied":
      // The PM acted: whatever the host sends from now on is new, not a replay of history.
      return addReply({ ...model, replay: null }, action.text, action.answer, true);
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
      for (const { event, interviewId } of action.events) {
        next = applyEvent({ ...next, attached: interviewId }, event);
      }
      // History is the past: nothing is running until the live stream says so.
      return {
        ...next,
        attached: null,
        connection: model.connection,
        turnRunning: false,
        lastActivity: null,
        replay: replayWindow(action.events),
      };
    }
    case "local-notice":
      return { ...model, timeline: [...model.timeline, { type: "notice", key: key("l"), tone: action.tone, title: action.title, text: action.text, retry: false }] };
  }
}

/** Busy states are shown as one calm "working" state, so rapid thinking/working flips are invisible. */
export function isBusy(state: InterviewHostState | null): boolean {
  return state === "starting" || state === "thinking" || state === "working";
}
