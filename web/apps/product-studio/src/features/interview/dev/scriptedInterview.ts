/**
 * DEVELOPMENT ONLY. Loaded by `vite --mode fixtures` (client.ts); never part of a production build.
 *
 * A scripted interviewer that emits the host's events (contract 8.2) with realistic timing, so the
 * interview screen can be built and checked without Claude Code. The wording follows the real runs
 * in docs/mach-next/M5_INTERVIEW_POC.md sections 3 and 8. Each PM reply moves to the next turn,
 * whatever it says:
 *
 *   1  Q1, after lookups                      6  a refused approval, then a plain message
 *   2  Q2 (accept: "yes")                     7  the sanity-check confirmation
 *   3  Q3 with a labelled default             8  the write-up: spec, why, check (draft_changed)
 *   4  Q4 after a correction                  9  a slow reply, for trying Interrupt
 *   5  Q5 after "I don't know"               10  an error: the turn's spending limit
 *
 * Query parameters (before the hash): ?speed=fast shortens every delay; ?interview=lost drops the
 * stream once during turn 3; ?interview=conflict makes Start answer `conflict`.
 */
import { MachApiError, type InterviewClient, type StreamHandlers, type InterviewEvent, type InterviewEventMap, type InterviewEventName, type InterviewSummary, type ParsedQuestion } from "@mach/ui/api";
import { devParam, devState } from "../../../dev/devState";

type Step = { wait: number } & { [K in InterviewEventName]: { type: K; data: InterviewEventMap[K] } }[InterviewEventName];

const SLICE = "SLICE-002";
/** The write-up and the slow reply (8 and 9 above) keep real timing at ?speed=fast, to watch the draft update and to try Interrupt. */
const REAL_TIME_TURNS = new Set([7, 8]);

function q(id: string, number: number, title: string, body: string, recommendation: string, preface = ""): ParsedQuestion {
  return { message_id: id, number, title, body, recommendation, preface };
}

function questionText(question: ParsedQuestion): string {
  const head = question.preface ? `${question.preface}\n\n` : "";
  return `${head}❓ **Q${question.number}** - **${question.title}**: ${question.body}\n\n➡️ ${question.recommendation}`;
}

/** Streams a final message in small chunks, then sends `message` (and `question` when it is one). */
function say(id: string, text: string, kind: "question" | "confirmation" | "other", question?: ParsedQuestion): Step[] {
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
  "msg_dev_01",
  1,
  "Who invites and what happens",
  "Is this slice for a workspace admin who enters one teammate's email address and sends them an invitation, so that the teammate receives an email inviting them to join the workspace?",
  "Yes. The slice is done when the invitation is recorded for that email address and the email has been sent.",
  "Facts from your product notes: workspaces have an owner and admins, and seats are limited by plan (Free has 5, Team has 25). This slice covers sending one invitation. The invited person accepting it, and managing pending invitations, will be handled in later slices.",
);
const Q2 = q(
  "msg_dev_02",
  2,
  "Seat limit",
  'Should an invitation be refused when every purchased seat is already taken by a member or a pending invitation, with the message "All seats are in use. Add seats to invite more people."?',
  "Yes. A pending invitation holds a seat, so the plan's limit can never be passed.",
);
const Q3 = q(
  "msg_dev_03",
  3,
  "Invitation lifetime",
  "Should an invitation link stop working 14 days after it is sent?",
  "Common default: 14 days.",
);
const Q4 = q(
  "msg_dev_04",
  4,
  "Email failure",
  'If the email service does not accept the invitation within 60 seconds, should the admin see "We couldn\'t send the invitation. Try again in a few minutes." and the held seat be released?',
  "Yes. Releasing the seat keeps a failed send from using up the plan.",
  "Noted: invitations stop working 7 days after they are sent.",
);
const Q5 = q(
  "msg_dev_05",
  5,
  "What the admin sees on success",
  "After a successful invitation, should the Members page show the invitee as pending, with the seats in use counted again?",
  "Yes. Your notes say the Members page already shows the seat count.",
  "Noted: what happens when the email service fails goes under open questions, to be answered by whoever owns the email service.",
);

const CONFIRMATION = [
  "Here is what I have before I write up the specification:",
  "",
  "1. **Core action and scope:** a workspace admin invites one teammate by email from the Members page. Accepting an invitation and managing pending ones are later slices.",
  "2. **Hard business invariants:** members plus pending invitations never exceed purchased seats; an email address holds at most one membership or pending invitation; an invitation link stops working 7 days after it is sent.",
  '3. **Error cases:** "All seats are in use. Add seats to invite more people.", "Enter a valid email address.", "This person is already a member or has a pending invitation."',
  "",
  "Still open: what happens when the email service fails (for the email service's owner).",
  "",
  "Does this capture the intent, or did I miss an edge case before I write up the specification?",
].join("\n");

const turns: Step[][] = [
  [
    { wait: 200, type: "state", data: "starting" },
    ...think(600),
    { wait: 900, type: "activity", data: { kind: "lookup", text: "Read the product notes" } },
    { wait: 500, type: "state", data: "working" },
    { wait: 600, type: "activity", data: { kind: "check", text: "Checked where SLICE-002 stands" } },
    ...think(300),
    ...say("msg_dev_00", "Let me look at the product notes before the first question.", "other").filter((s) => s.type === "text"),
    ...say(Q1.message_id, questionText(Q1), "question", Q1),
    ...close(19.2, 0.11, 0.11),
  ],
  [...think(), ...say(Q2.message_id, questionText(Q2), "question", Q2), ...close(3.1, 0.006, 0.116)],
  [...think(), ...say(Q3.message_id, questionText(Q3), "question", Q3), ...close(2.8, 0.005, 0.121)],
  [...think(), ...say(Q4.message_id, questionText(Q4), "question", Q4), ...close(4.0, 0.007, 0.128)],
  [...think(), ...say(Q5.message_id, questionText(Q5), "question", Q5), ...close(3.6, 0.006, 0.134)],
  [
    ...think(),
    { wait: 700, type: "state", data: "working" },
    { wait: 500, type: "activity", data: { kind: "refused", text: "Tried to approve the slice. Only you can approve, with the Approve button." } },
    ...think(200),
    ...say(
      "msg_dev_06",
      "I can't approve the slice from here: approval is yours, with the Approve button on the slice's page. It also isn't ready yet. One question is open and the spec isn't written up. Shall I give you the summary so we can finish?",
      "other",
    ),
    ...close(6.2, 0.012, 0.146),
  ],
  [...think(), ...say("msg_dev_07", CONFIRMATION, "confirmation"), ...close(5.4, 0.009, 0.155)],
  [
    ...think(),
    { wait: 900, type: "state", data: "working" },
    { wait: 2200, type: "activity", data: { kind: "write", text: "Wrote the spec" } },
    { wait: 0, type: "draft_changed", data: { slice_id: SLICE, what: ["spec"] } },
    ...think(400),
    { wait: 1600, type: "activity", data: { kind: "write", text: "Wrote the slice's why" } },
    { wait: 0, type: "draft_changed", data: { slice_id: SLICE, what: ["why"] } },
    { wait: 1200, type: "activity", data: { kind: "check", text: "Checked the spec" } },
    { wait: 0, type: "draft_changed", data: { slice_id: SLICE, what: ["work_order"] } },
    ...think(300),
    ...say(
      "msg_dev_08",
      "The spec and the slice's why are written in your draft. The check found no problems in the spec's structure, but it is not ready for your approval yet: 2 questions are still open, listed beside this conversation. When you have answers, tell me and I'll update the spec.",
      "other",
    ),
    ...close(41.8, 0.14, 0.295),
  ],
  [
    ...think(),
    ...say(
      "msg_dev_09",
      "Let me go through what changes if the seat count drops while an invitation is pending. First, a pending invitation keeps holding its seat until it expires or is accepted, so a workspace that reduces its plan below the number of members and pending invitations would ".repeat(3),
      "other",
    ).map((s) => (s.type === "text" ? { ...s, wait: 260 } : s)),
    ...close(24.0, 0.02, 0.315),
  ],
  [
    ...think(),
    { wait: 1500, type: "state", data: "working" },
    { wait: 900, type: "error", data: { kind: "error_max_budget_usd", message: "This reply stopped at its spending limit of $0.50 per reply. Your draft is unchanged. Send your reply again to continue." } },
    ...close(30.0, 0.5, 0.815, "error_max_budget_usd"),
  ],
];

const fallback: Step[] = [...think(), ...say("msg_dev_x", "Noted. That is everything this development script knows how to say.", "other"), ...close(2, 0.004, 0.82)];

class ScriptedInterview {
  id = "dev-interview-1";
  seq = 0;
  log: InterviewEvent[] = [];
  listeners = new Set<StreamHandlers>();
  turn = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  queue: Step[] = [];
  running = false;
  ended = false;
  dropped = false;
  speed = devParam("speed") === "fast" ? 0.05 : 1;

  emit<K extends InterviewEventName>(type: K, data: InterviewEventMap[K]) {
    const event = { type, data, seq: ++this.seq } as InterviewEvent;
    this.log.push(event);
    if (type === "draft_changed") devState.writtenUp = true;
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
      if (devParam("interview") === "lost" && this.turn === 3 && !this.dropped && step.type === "state") {
        this.dropped = true;
        this.listeners.forEach((l) => l.onConnection("reconnecting"));
        setTimeout(() => this.listeners.forEach((l) => l.onConnection("open")), 2500 * this.speed + 2000);
      }
      this.emit(step.type, step.data as never);
      this.next();
    }, step.wait * (REAL_TIME_TURNS.has(this.turn) ? 1 : this.speed));
  }

  reply() {
    if (this.running) throw new MachApiError("conflict", "The interviewer is still working on a reply.", "interview.reply", 409);
    this.turn += 1;
    this.play(turns[this.turn] ?? fallback);
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
    this.ended = true;
    this.emit("state", "ended");
    this.emit("ended", { reason: "stopped" });
  }
}

let current: ScriptedInterview | null = null;

export const scriptedInterviewClient: InterviewClient = {
  async current(sliceId): Promise<InterviewSummary | null> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (!current || current.ended) return null;
    return {
      interview_id: current.id,
      slice_id: sliceId,
      live: true,
      state: current.running ? "thinking" : "waiting_for_reply",
      turn_running: current.running,
      locked_elsewhere: false,
      last_message: null,
      turns: current.turn,
      session_cost_usd: null,
    };
  },
  async start() {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (devParam("interview") === "conflict") throw new MachApiError("conflict", "That slice already has an interview running.", "interview.start", 409);
    if (current && !current.ended) return { interview_id: current.id, slice_id: SLICE, resumed: true };
    current = new ScriptedInterview();
    const started = current;
    setTimeout(() => started.play(turns[0] ?? fallback), 50);
    return { interview_id: started.id, slice_id: SLICE, resumed: false };
  },
  subscribe(id, handlers) {
    const interview = current;
    if (!interview || interview.id !== id) {
      handlers.onConnection("closed");
      return () => undefined;
    }
    handlers.onConnection("open");
    // Like the host without Last-Event-ID: replay what has happened so far.
    interview.log.forEach((event) => handlers.onEvent(event));
    interview.listeners.add(handlers);
    return () => interview.listeners.delete(handlers);
  },
  async reply() {
    await new Promise((resolve) => setTimeout(resolve, 120));
    current?.reply();
  },
  async interrupt() {
    current?.interrupt();
  },
  async stop() {
    current?.stop();
  },
};
