/**
 * DEVELOPMENT ONLY. Loaded by `vite --mode fixtures` (useIdeaConversation.ts); never part of a production build.
 *
 * A scripted Shape conversation that emits the host's events (contract 8.2) with realistic timing, so the Explore screen
 * can be seen and checked without Claude Code, as features/interview/dev/scriptedInterview.ts does for the slice
 * interview. Its questions are open questions in the Shape format (`❓ **Qn** - **Topic**: question`), with no
 * recommended answer. Each reply moves to the next turn, whatever it says:
 *
 *   0  lookups (draft_changed: lookups), streamed text, Q1      3  a refused act (a verdict), then a plain message
 *   1  Q2                                                       4  a turn that ends in an error (its spending limit)
 *   2  the brief written (draft_changed: brief), then Q3        5  the last message, and the conversation ends
 *
 * Query parameters (before the hash): ?speed=fast shortens every delay; ?conversation=conflict makes Start answer
 * `conflict`; ?conversation=unavailable makes it answer `unavailable` (Continue in Claude Code is shown).
 */
import { MachApiError, type IdeaConversationClient, type InterviewEvent, type InterviewEventMap, type InterviewEventName, type InterviewSummary, type ParsedQuestion, type StreamHandlers } from "@mach/ui/api";
import { devParam } from "../../../../dev/devState";

type Step = { wait: number } & { [K in InterviewEventName]: { type: K; data: InterviewEventMap[K] } }[InterviewEventName];

function q(id: string, number: number, title: string, body: string, preface = ""): ParsedQuestion {
  return { message_id: id, number, title, body, recommendation: "", preface };
}

/** The Shape format: an open question, and no recommended answer (the answer must be the product manager's). */
function questionText(question: ParsedQuestion): string {
  const head = question.preface ? `${question.preface}\n\n` : "";
  return `${head}❓ **Q${question.number}** - **${question.title}**: ${question.body}`;
}

function say(id: string, text: string, kind: "question" | "other", question?: ParsedQuestion): Step[] {
  const steps: Step[] = [];
  const words = text.split(/(?<=\s)/);
  for (let i = 0; i < words.length; i += 6) steps.push({ wait: 70, type: "text", data: { message_id: id, delta: words.slice(i, i + 6).join("") } });
  steps.push({ wait: 120, type: "message", data: { message_id: id, text, kind } });
  if (question) steps.push({ wait: 0, type: "question", data: question });
  return steps;
}

function close(seconds: number, cost: number, session: number, outcome = "replied"): Step[] {
  return [
    { wait: 80, type: "turn", data: { outcome, seconds, cost_usd: cost, session_cost_usd: session, refused: null } },
    { wait: 0, type: "state", data: "waiting_for_reply" },
  ];
}

const think = (wait = 300): Step[] => [
  { wait, type: "state", data: "thinking" },
  { wait: 150, type: "state", data: "working" },
  { wait: 120, type: "state", data: "thinking" },
];

const Q1 = q(
  "msg_shape_01",
  1,
  "The problem",
  "What happens today that you would like to be different? When did it last happen?",
  "I looked up what has shipped about loans and renewals, the ideas already on the board, and the principles and policies that might apply. They are listed beside this conversation.",
);
const Q2 = q("msg_shape_02", 2, "How we would know", "If this worked, what would you see that you do not see now? What would you count?");
const Q3 = q(
  "msg_shape_03",
  3,
  "Who would not want this",
  "Who would not want members to renew a loan themselves, and why?",
  "I wrote what you have said so far into the brief. Two outcomes are in it; one says how you would know, the other does not yet.",
);

function turns(ideaId: string): Step[][] {
  return [
    [
      { wait: 200, type: "state", data: "starting" },
      ...think(600),
      { wait: 900, type: "activity", data: { kind: "lookup", text: "Looked up the rules that have shipped" } },
      { wait: 500, type: "activity", data: { kind: "lookup", text: "Looked at the other ideas and the requests" } },
      { wait: 700, type: "activity", data: { kind: "save", text: "Recorded what was looked up" } },
      { wait: 0, type: "draft_changed", data: { idea_id: ideaId, what: ["lookups"] } },
      ...think(300),
      ...say("msg_shape_00", "Let me look at what exists before the first question.", "other").filter((s) => s.type === "text"),
      ...say(Q1.message_id, questionText(Q1), "question", Q1),
      ...close(21.4, 0.12, 0.12),
    ],
    [...think(), ...say(Q2.message_id, questionText(Q2), "question", Q2), ...close(3.4, 0.007, 0.127)],
    [
      ...think(),
      { wait: 900, type: "state", data: "working" },
      { wait: 1600, type: "activity", data: { kind: "write", text: "Wrote the brief" } },
      { wait: 0, type: "draft_changed", data: { idea_id: ideaId, what: ["brief"] } },
      { wait: 900, type: "activity", data: { kind: "check", text: "Checked the brief" } },
      { wait: 0, type: "draft_changed", data: { idea_id: ideaId, what: ["idea"] } },
      ...think(300),
      ...say(Q3.message_id, questionText(Q3), "question", Q3),
      ...close(18.7, 0.06, 0.187),
    ],
    [
      ...think(),
      { wait: 700, type: "state", data: "working" },
      { wait: 500, type: "activity", data: { kind: "refused", text: "Tried to record a verdict. Only you can, on the case page." } },
      ...think(200),
      ...say(
        "msg_shape_04",
        "I can't record a verdict from here: the verdict is yours, on the case page, and MACH never recommends one. Shall we go on with the brief?",
        "other",
      ),
      ...close(6.0, 0.011, 0.198),
    ],
    [
      ...think(),
      { wait: 1500, type: "state", data: "working" },
      { wait: 900, type: "error", data: { kind: "error_max_budget_usd", message: "This reply stopped at its spending limit of $0.50 per reply. Your brief is unchanged. Send your reply again to continue." } },
      ...close(30.0, 0.5, 0.698, "error_max_budget_usd"),
    ],
    [
      ...think(),
      ...say("msg_shape_05", "That is everything this development conversation knows how to say. Your brief and what was looked up are beside it.", "other"),
      { wait: 80, type: "turn", data: { outcome: "replied", seconds: 2.1, cost_usd: 0.004, session_cost_usd: 0.702, refused: null } },
      { wait: 200, type: "state", data: "ended" },
      { wait: 0, type: "ended", data: { reason: "stopped" } },
    ],
  ];
}

class ScriptedConversation {
  seq = 0;
  log: InterviewEvent[] = [];
  listeners = new Set<StreamHandlers>();
  turn = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  queue: Step[] = [];
  running = false;
  ended = false;
  speed = devParam("speed") === "fast" ? 0.05 : 1;
  readonly script: Step[][];

  constructor(
    readonly id: string,
    readonly ideaId: string,
  ) {
    this.script = turns(ideaId);
  }

  emit<K extends InterviewEventName>(type: K, data: InterviewEventMap[K]) {
    const event = { type, data, seq: ++this.seq } as InterviewEvent;
    this.log.push(event);
    if (type === "ended") this.ended = true;
    this.listeners.forEach((l) => l.onEvent(event));
  }

  play(steps: Step[]) {
    this.queue = [...steps];
    this.running = true;
    this.next();
  }

  next() {
    const step = this.queue.shift();
    if (!step) {
      this.running = false;
      this.timer = null;
      return;
    }
    this.timer = setTimeout(() => {
      this.emit(step.type, step.data as never);
      this.next();
    }, step.wait * this.speed);
  }

  reply(text: string) {
    if (this.running) throw new MachApiError("conflict", "The conversation is still working on a reply.", "interview.reply", 409);
    if (this.ended) throw new MachApiError("conflict", "This conversation has ended.", "interview.reply", 409);
    this.emit("reply", { text });
    this.turn += 1;
    this.play(this.script[this.turn] ?? []);
  }

  interrupt() {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.queue = [];
    this.running = false;
    this.emit("turn", { outcome: "interrupted", seconds: 3, cost_usd: null, session_cost_usd: null, refused: null });
    this.emit("state", "waiting_for_reply");
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.queue = [];
    this.running = false;
    this.emit("state", "ended");
    this.emit("ended", { reason: "stopped" });
  }
}

const conversations = new Map<string, ScriptedConversation>();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const scriptedConversationClient: IdeaConversationClient = {
  async current(ideaId): Promise<InterviewSummary | null> {
    await wait(150);
    const found = conversations.get(ideaId);
    if (!found || found.ended) return null;
    return {
      interview_id: found.id,
      slice_id: ideaId,
      live: true,
      state: found.running ? "thinking" : "waiting_for_reply",
      turn_running: found.running,
      locked_elsewhere: false,
      last_message: null,
      turns: found.turn,
      session_cost_usd: null,
    };
  },
  async start(ideaId) {
    await wait(300);
    if (devParam("conversation") === "conflict") throw new MachApiError("conflict", `${ideaId} already has a conversation running.`, "interview.start", 409);
    if (devParam("conversation") === "unavailable") {
      throw new MachApiError("unavailable", "The Shape conversation cannot run here. Continue it in Claude Code.", "interview.start", 503);
    }
    const running = conversations.get(ideaId);
    if (running && !running.ended) return { interview_id: running.id, slice_id: ideaId, resumed: true };
    const started = new ScriptedConversation(`dev-conversation-${ideaId}`, ideaId);
    conversations.set(ideaId, started);
    setTimeout(() => started.play(started.script[0] ?? []), 50);
    return { interview_id: started.id, slice_id: ideaId, resumed: false };
  },
  subscribe(id, handlers) {
    const found = [...conversations.values()].find((c) => c.id === id);
    if (!found) {
      handlers.onConnection("closed");
      return () => undefined;
    }
    handlers.onConnection("open");
    // Like the host: replay the current turn so far, and the last final message and question.
    const lastTurn = found.log.map((e) => e.type).lastIndexOf("turn");
    const lastFinal = found.log.filter((e, i) => i <= lastTurn && (e.type === "message" || e.type === "question")).slice(-2);
    [...lastFinal, ...found.log.slice(lastTurn + 1)].forEach((event) => handlers.onEvent(event));
    found.listeners.add(handlers);
    return () => found.listeners.delete(handlers);
  },
  async reply(id, text) {
    await wait(120);
    [...conversations.values()].find((c) => c.id === id)?.reply(text);
  },
  async history(ideaId) {
    await wait(100);
    const found = conversations.get(ideaId);
    // Like the host's saved history: everything except streamed text and the busy states.
    const events = (found?.log ?? [])
      .filter((e) => e.type !== "text" && !(e.type === "state" && (e.data === "thinking" || e.data === "working")))
      .map((e) => ({ at: new Date().toISOString(), interview_id: found?.id ?? "", event: e.type, data: e.data as unknown }));
    return { slice_id: ideaId, events, truncated: false };
  },
  async interrupt(id) {
    [...conversations.values()].find((c) => c.id === id)?.interrupt();
  },
  async stop(id) {
    [...conversations.values()].find((c) => c.id === id)?.stop();
  },
};
