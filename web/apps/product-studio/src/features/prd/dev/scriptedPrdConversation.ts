/**
 * DEVELOPMENT ONLY. Loaded by `vite --mode fixtures` (usePrdConversation.ts); never part of a production build.
 *
 * A scripted PRD conversation that emits the host's events (contract 8.2) with realistic timing, so a PRD's page can be
 * seen and checked without Claude Code, as features/needs/shell/dev/scriptedNeedsConversation.ts does for the needs.
 * It proposes the map of the fixtures' PRD (web/fixtures/start_memory.py, START_MAP) and, as the host's note asks when
 * there is no project yet, a name, vision and outcomes in its own words, as a suggestion only. Each reply moves on:
 *
 *   0  read the PRD, then the proposed map and a proposed name, vision and outcomes; asks whether to record the map
 *   1  the map recorded (draft_changed: prd), then a message naming the sections that wait for the person's word
 *   2  a refused act (making the drafts), then a plain message saying which button does it
 *   3  the last message, and the conversation ends
 *
 * Query parameters (before the hash): ?speed=fast shortens every delay; ?conversation=conflict makes Start answer
 * `conflict`; ?conversation=unavailable makes it answer `unavailable`; ?conversation=refused answers as the host does
 * once the drafts are made from the PRD.
 */
import {
  MachApiError,
  type InterviewEvent,
  type InterviewEventMap,
  type InterviewEventName,
  type InterviewSummary,
  type PrdConversationClient,
} from "@mach/ui/api";
import { devParam } from "../../../dev/devState";
import { startMapRecorded } from "../../../dev/startTransport";

type Step = { wait: number } & { [K in InterviewEventName]: { type: K; data: InterviewEventMap[K] } }[InterviewEventName];

function say(id: string, text: string): Step[] {
  const steps: Step[] = [];
  const words = text.split(/(?<=\s)/);
  for (let i = 0; i < words.length; i += 6) steps.push({ wait: 60, type: "text", data: { message_id: id, delta: words.slice(i, i + 6).join("") } });
  steps.push({ wait: 120, type: "message", data: { message_id: id, text, kind: "other" } });
  return steps;
}

function close(seconds: number, cost: number, session: number): Step[] {
  return [
    { wait: 80, type: "turn", data: { outcome: "replied", seconds, cost_usd: cost, session_cost_usd: session, refused: null } },
    { wait: 0, type: "state", data: "waiting_for_reply" },
  ];
}

const think = (wait = 300): Step[] => [
  { wait, type: "state", data: "thinking" },
  { wait: 150, type: "state", data: "working" },
  { wait: 120, type: "state", data: "thinking" },
];

const PROPOSAL = `I read PRD-01 (22 lines, 5 sections). Here is the map I propose.

**One new epic: Workspace members.** Done when only invited people join.

**Two thin slices, in the order they are built:**

1. **Invite a teammate**: an admin invites one teammate by email. Rests on lines 5-9.
2. **Remove a member**: an admin removes one member. After slice 1. Rests on lines 11-14.

No slice cites section 1 (the opening), section 4 (Billing) or section 5 (Later ideas). You settle those on this page once the map is recorded.

There is no project yet, so here is a suggestion for naming it, in my own words. It is yours to use, change or ignore in the form on this page:

- Name: Team Space
- Vision: Teams bring the right colleagues in, and only them.
- Outcomes: Admins can invite a teammate by email; Admins can remove a member.

Should I record this map?`;

function turns(prdId: string): Step[][] {
  return [
    [
      { wait: 200, type: "state", data: "starting" },
      ...think(600),
      { wait: 600, type: "activity", data: { kind: "lookup", text: "checked where things stand" } },
      { wait: 700, type: "activity", data: { kind: "lookup", text: "read the PRD" } },
      ...think(300),
      ...say("msg_prd_01", PROPOSAL.replace("PRD-01", prdId)),
      ...close(21.4, 0.11, 0.11),
    ],
    [
      ...think(),
      { wait: 900, type: "activity", data: { kind: "write", text: "wrote down the PRD's map" } },
      { wait: 600, type: "activity", data: { kind: "save", text: "recorded the PRD's map" } },
      { wait: 0, type: "draft_changed", data: { prd_id: prdId, what: ["prd"] } },
      ...think(200),
      ...say(
        "msg_prd_02",
        "I recorded the map. Three sections no slice cites wait for your word: settle each one on this page, as part of a slice, out of scope or later.",
      ),
      ...close(8.2, 0.02, 0.13),
    ],
    [
      ...think(),
      { wait: 500, type: "activity", data: { kind: "refused", text: "tried a Product Studio step that is not available here" } },
      ...think(200),
      ...say("msg_prd_03", "I can't make the drafts from here: that is yours, with Make the drafts on this page, after you name the product."),
      ...close(4.0, 0.01, 0.14),
    ],
    [
      ...think(),
      ...say("msg_prd_04", "That is everything this development conversation knows how to say. The map is beside it."),
      { wait: 80, type: "turn", data: { outcome: "replied", seconds: 2.0, cost_usd: 0.004, session_cost_usd: 0.144, refused: null } },
      { wait: 200, type: "state", data: "ended" },
      { wait: 0, type: "ended", data: { reason: "stopped" } },
    ],
  ];
}

class ScriptedPrdConversation {
  seq = 0;
  log: InterviewEvent[] = [];
  listeners = new Set<Parameters<PrdConversationClient["subscribe"]>[1]>();
  turn = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  queue: Step[] = [];
  running = false;
  ended = false;
  speed = devParam("speed") === "fast" ? 0.05 : 1;
  readonly script: Step[][];

  constructor(
    readonly id: string,
    readonly prdId: string,
  ) {
    this.script = turns(prdId);
  }

  emit<K extends InterviewEventName>(type: K, data: InterviewEventMap[K]) {
    const event = { type, data, seq: ++this.seq } as InterviewEvent;
    this.log.push(event);
    if (type === "ended") this.ended = true;
    if (type === "draft_changed") startMapRecorded();
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

const conversations = new Map<string, ScriptedPrdConversation>();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const byId = (id: string) => [...conversations.values()].find((c) => c.id === id) ?? null;

export const scriptedPrdConversationClient: PrdConversationClient = {
  async current(prdId): Promise<InterviewSummary | null> {
    await wait(150);
    const found = conversations.get(prdId);
    if (!found || found.ended) return null;
    return {
      interview_id: found.id,
      prd_id: prdId,
      live: true,
      state: found.running ? "thinking" : "waiting_for_reply",
      turn_running: found.running,
      locked_elsewhere: false,
      last_message: null,
      turns: found.turn,
      session_cost_usd: null,
    };
  },
  async start(prdId) {
    await wait(300);
    const mode = devParam("conversation");
    if (mode === "conflict") throw new MachApiError("conflict", `${prdId} already has a conversation running.`, "interview.start", 409);
    if (mode === "unavailable") throw new MachApiError("unavailable", "The conversation cannot run here. Continue it in Claude Code.", "interview.start", 503);
    if (mode === "refused") throw new MachApiError("refused", `The drafts were made from ${prdId}, so its map stays as it was when they were made.`, "interview.start", 422);
    const existing = conversations.get(prdId);
    if (existing && !existing.ended) return { interview_id: existing.id, prd_id: prdId, resumed: true };
    const started = new ScriptedPrdConversation(`dev-conversation-${prdId}`, prdId);
    conversations.set(prdId, started);
    setTimeout(() => started.play(started.script[0] ?? []), 50);
    return { interview_id: started.id, prd_id: prdId, resumed: false };
  },
  subscribe(id, handlers) {
    const found = byId(id);
    if (!found) {
      handlers.onConnection("closed");
      return () => undefined;
    }
    handlers.onConnection("open");
    // Like the host: replay the current turn so far, and the last final message.
    const lastTurn = found.log.map((e) => e.type).lastIndexOf("turn");
    const lastFinal = found.log.filter((e, i) => i <= lastTurn && e.type === "message").slice(-1);
    [...lastFinal, ...found.log.slice(lastTurn + 1)].forEach((event) => handlers.onEvent(event));
    found.listeners.add(handlers);
    return () => found.listeners.delete(handlers);
  },
  async reply(id, text) {
    await wait(120);
    byId(id)?.reply(text);
  },
  async history(prdId) {
    await wait(100);
    const found = conversations.get(prdId);
    // Like the host's saved history: everything except streamed text and the busy states.
    const events = (found?.log ?? [])
      .filter((e) => e.type !== "text" && !(e.type === "state" && (e.data === "thinking" || e.data === "working")))
      .map((e) => ({ at: new Date().toISOString(), interview_id: found?.id ?? "", event: e.type, data: e.data as unknown }));
    return { prd_id: prdId, events, truncated: false };
  },
  async interrupt(id) {
    byId(id)?.interrupt();
  },
  async stop(id) {
    byId(id)?.stop();
  },
};
