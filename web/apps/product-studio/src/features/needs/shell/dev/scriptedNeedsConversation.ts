/**
 * DEVELOPMENT ONLY. Loaded by `vite --mode fixtures` (useNeedsConversation.ts); never part of a production build.
 *
 * A scripted needs conversation that emits the host's events (contract 8.2) with realistic timing, so the Technical
 * needs screen can be seen and checked without Claude Code, as features/shape/explore/dev/scriptedConversation.ts does
 * for Shape. Its questions are the engine's own questions per kind (needs.QUESTIONS), one open question at a time,
 * with no recommended answer and no technology offered. Each reply moves to the next turn, whatever it says:
 *
 *   0  read the needs, then Q1 (people)                      3  a refused act (publishing), then a plain message
 *   1  a need recorded (draft_changed: needs), then Q2       4  a design's map recorded (draft_changed: design), then a
 *   2  a technology named: asks who decided it (Q3)             message naming the one conflict that waits
 *                                                            5  a turn that ends at its spending limit
 *                                                            6  the last message, and the conversation ends
 *
 * Query parameters (before the hash): ?speed=fast shortens every delay; ?conversation=conflict makes Start answer
 * `conflict`; ?conversation=unavailable makes it answer `unavailable`; ?conversation=refused answers as the host does
 * before a project exists.
 */
import {
  MachApiError,
  type InterviewEvent,
  type InterviewEventMap,
  type InterviewEventName,
  type InterviewSummary,
  type NeedsConversationClient,
  type ParsedQuestion,
  type StreamHandlers,
} from "@mach/ui/api";
import { devParam } from "../../../../dev/devState";

type Step = { wait: number } & { [K in InterviewEventName]: { type: K; data: InterviewEventMap[K] } }[InterviewEventName];

function q(id: string, number: number, title: string, body: string, preface = ""): ParsedQuestion {
  return { message_id: id, number, title, body, recommendation: "", preface };
}

/** An open question and no recommended answer: the need must be the product manager's own words. */
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
  "msg_needs_01",
  1,
  "People",
  "Who uses it, how many, from where, and at what busiest moment?",
  "I read your technical needs. Nothing is answered yet, so I will ask about each kind once; 'nothing to say' is a fine answer.",
);
const Q2 = q(
  "msg_needs_02",
  2,
  "Data",
  "What does it keep, how sensitive is that, and how long must it be kept?",
  "I recorded that as TN-01, in your words.",
);
const Q3 = q(
  "msg_needs_03",
  3,
  "Who decided it",
  "You named a particular database. Did someone already decide that, outside this product? If so, who, and when?",
);

function turns(): Step[][] {
  return [
    [
      { wait: 200, type: "state", data: "starting" },
      ...think(600),
      { wait: 700, type: "activity", data: { kind: "lookup", text: "read the technical needs" } },
      { wait: 400, type: "activity", data: { kind: "lookup", text: "read the product principles" } },
      ...think(300),
      ...say(Q1.message_id, questionText(Q1), "question", Q1),
      ...close(14.2, 0.09, 0.09),
    ],
    [
      ...think(),
      { wait: 900, type: "activity", data: { kind: "save", text: "recorded a technical need" } },
      { wait: 0, type: "draft_changed", data: { needs: true, what: ["needs"] } },
      ...think(200),
      ...say(Q2.message_id, questionText(Q2), "question", Q2),
      ...close(6.1, 0.012, 0.102),
    ],
    [...think(), ...say(Q3.message_id, questionText(Q3), "question", Q3), ...close(3.8, 0.008, 0.11)],
    [
      ...think(),
      { wait: 700, type: "state", data: "working" },
      { wait: 500, type: "activity", data: { kind: "refused", text: "tried a Product Studio step that is not available here" } },
      ...think(200),
      ...say(
        "msg_needs_04",
        "I recorded it as a given (TN-02), said by your head of IT. I can't publish the needs from here: publishing is yours, with the Publish button on this page.",
        "other",
      ),
      ...close(7.0, 0.014, 0.124),
    ],
    [
      ...think(),
      { wait: 900, type: "activity", data: { kind: "lookup", text: "read the design" } },
      { wait: 1200, type: "activity", data: { kind: "write", text: "wrote down the design's map" } },
      { wait: 700, type: "activity", data: { kind: "save", text: "recorded the design's map" } },
      { wait: 0, type: "draft_changed", data: { needs: true, what: ["design"] } },
      ...think(200),
      ...say(
        "msg_needs_05",
        "I mapped DES-01 against your project's topics, citing its lines. One conflict waits for your word: line 22 keeps invitations forever, against TN-02. Settling it is yours, on the design's page.",
        "other",
      ),
      ...close(24.5, 0.07, 0.194),
    ],
    [
      ...think(),
      { wait: 1500, type: "state", data: "working" },
      { wait: 900, type: "error", data: { kind: "error_max_budget_usd", message: "This reply stopped at its spending limit of $0.50 per reply. Your needs are unchanged. Send your reply again to continue." } },
      ...close(30.0, 0.5, 0.694, "error_max_budget_usd"),
    ],
    [
      ...think(),
      ...say("msg_needs_06", "That is everything this development conversation knows how to say. Your needs are beside it.", "other"),
      { wait: 80, type: "turn", data: { outcome: "replied", seconds: 2.0, cost_usd: 0.004, session_cost_usd: 0.698, refused: null } },
      { wait: 200, type: "state", data: "ended" },
      { wait: 0, type: "ended", data: { reason: "stopped" } },
    ],
  ];
}

class ScriptedNeedsConversation {
  seq = 0;
  log: InterviewEvent[] = [];
  listeners = new Set<StreamHandlers>();
  turn = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  queue: Step[] = [];
  running = false;
  ended = false;
  speed = devParam("speed") === "fast" ? 0.05 : 1;
  readonly script: Step[][] = turns();

  constructor(readonly id: string) {}

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

let conversation: ScriptedNeedsConversation | null = null;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const find = (id: string) => (conversation?.id === id ? conversation : null);

export const scriptedNeedsConversationClient: NeedsConversationClient = {
  async current(): Promise<InterviewSummary | null> {
    await wait(150);
    if (!conversation || conversation.ended) return null;
    return {
      interview_id: conversation.id,
      needs: true,
      live: true,
      state: conversation.running ? "thinking" : "waiting_for_reply",
      turn_running: conversation.running,
      locked_elsewhere: false,
      last_message: null,
      turns: conversation.turn,
      session_cost_usd: null,
    };
  },
  async start() {
    await wait(300);
    const mode = devParam("conversation");
    if (mode === "conflict") throw new MachApiError("conflict", "The technical needs already have a conversation running.", "interview.start", 409);
    if (mode === "unavailable") throw new MachApiError("unavailable", "The needs conversation cannot run here. Continue it in Claude Code.", "interview.start", 503);
    if (mode === "refused") throw new MachApiError("refused", "Set up the project first: technical needs belong to a project.", "interview.start", 422);
    if (conversation && !conversation.ended) return { interview_id: conversation.id, needs: true, resumed: true };
    const started = new ScriptedNeedsConversation("dev-conversation-needs");
    conversation = started;
    setTimeout(() => started.play(started.script[0] ?? []), 50);
    return { interview_id: started.id, needs: true, resumed: false };
  },
  subscribe(id, handlers) {
    const found = find(id);
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
    find(id)?.reply(text);
  },
  async history() {
    await wait(100);
    const found = conversation;
    // Like the host's saved history: everything except streamed text and the busy states.
    const events = (found?.log ?? [])
      .filter((e) => e.type !== "text" && !(e.type === "state" && (e.data === "thinking" || e.data === "working")))
      .map((e) => ({ at: new Date().toISOString(), interview_id: found?.id ?? "", event: e.type, data: e.data as unknown }));
    return { needs: true, events, truncated: false };
  },
  async interrupt(id) {
    find(id)?.interrupt();
  },
  async stop(id) {
    find(id)?.stop();
  },
};
