/**
 * FIXTURE ONLY: a seeded, deterministic history of a Factory, as entity-level facts. It stands in
 * for what the observer folds from the intake log, the cells' lifecycle logs, the execution stream
 * and runs.jsonl. `observe.ts` turns it into the rows the observer would serve.
 *
 * Nothing reads the clock or Math.random: the same seed and options give the same history, byte
 * for byte (test/analytics-fixtures.test.mjs).
 *
 * What it includes on purpose: execution retries, failed and interrupted executions, outcomes that
 * are unknown, people's approval waits, capacity holds under a recorded limit, cells without a
 * lifecycle log, executions without a recorded cost or without usage, hand-driven tickets (no
 * execution, so no cost), revise loops back to build and escalations at the third round.
 */
import type { AppType, Model, Risk, Station } from "../contract";

// ------------------------------------------------------------------------------------------- rng

/** mulberry32: small, fast, and the same on every engine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(r: Rand, items: readonly (readonly [T, number])[]): T => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of items) {
    x -= w;
    if (x < 0) return v;
  }
  return items[items.length - 1]![0];
};
/** A log-normal duration around a median, in ms, with spread sigma. */
function logn(r: Rand, medianMs: number, sigma: number): number {
  const u = Math.max(1e-9, r());
  const v = r();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(1000, Math.round(medianMs * Math.exp(sigma * z)));
}

// ----------------------------------------------------------------------------------------- types

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const D = 24 * H;

export type ExecOutcome = "completed" | "failed" | "interrupted" | "unknown";
export type WaitKind = "dependency" | "queue" | "capacity" | "human";

export interface FxVisit {
  readonly ticket: string;
  readonly station: Station;
  /** The visit's number at this station in this cell (1, 2, …). */
  readonly n: number;
  readonly round: number;
  readonly start: number;
  /** null: still open at the history's end. */
  readonly end: number | null;
  /** How the visit ended: through the station's exit, refused at a gate, or cut by an interrupted execution. */
  readonly ended: "exited" | "refused" | "interrupted" | "open";
  readonly execution: string | null;
}

export interface FxUsage {
  readonly model: Model;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
  readonly costUsd: number;
}

export interface FxAgent {
  readonly id: string;
  /** Read from the agent's label; null for clerks ("what next?"). */
  readonly station: Station | null;
  readonly seat: string | null;
  readonly model: Model;
  readonly phase: "build" | "verify" | "review" | "plan" | "relay";
  readonly queuedMs: number;
  readonly start: number;
  readonly durMs: number;
  readonly toolCalls: number | null;
  readonly tokens: number | null;
}

export interface FxExecution {
  readonly id: string;
  readonly ticket: string;
  readonly attempt: number;
  readonly stage: "planned" | "built" | "approved";
  readonly claimedAt: number;
  readonly startedAt: number;
  readonly endedAt: number;
  /** When the supervisor noticed the end (execution.completed / failed); W5 is the difference. */
  readonly observedAt: number;
  readonly outcome: ExecOutcome;
  /** A recovery.started was recorded for this execution (after an interruption or an unknown end). */
  readonly recovery: "interrupted" | "outcome-unknown" | null;
  /** The ticket was parked for a person at the end of this execution (human.required). */
  readonly parkedForPerson: boolean;
  /** Recorded cost, Claude-reported; null when the run had no result. */
  readonly costUsd: number | null;
  /** Per-model usage from the stream; null when the stream did not carry it. */
  readonly usage: readonly FxUsage[] | null;
  readonly agents: readonly FxAgent[];
  readonly refusedTools: readonly string[];
  readonly workflow: "finished" | "killed-budget" | "killed-stopped";
}

export interface FxWait {
  readonly ticket: string;
  readonly kind: WaitKind;
  readonly start: number;
  readonly end: number | null;
  readonly round: number | null;
}

export interface FxGate {
  readonly ticket: string;
  readonly station: Station;
  readonly gate: string;
  readonly at: number;
  readonly verdict: "passed" | "refused" | "overridden";
  readonly reason: string | null;
}

export interface FxRound {
  readonly ticket: string;
  readonly round: number;
  readonly verify: "PASS" | "FAIL_WITH_EVIDENCE" | null;
  readonly review: "APPROVED" | "REJECTED" | "ESCALATE" | "AWAITING_HUMAN" | null;
  readonly securityVeto: boolean;
  readonly failedChecks: readonly string[];
  readonly blockers: readonly { readonly rule: string; readonly seat: string }[];
  readonly at: number;
}

export interface FxTicket {
  readonly id: string;
  readonly slice: string | null;
  readonly wave: string | null;
  readonly risk: Risk;
  readonly app: AppType;
  readonly writer: "supervisor" | "hand";
  /** The cell kept a lifecycle log (cells before M6.1, or hand-run old ones, may not). */
  readonly lifecycle: boolean;
  readonly eligibleAt: number;
  readonly scheduledAt: number;
  readonly outcome: "merged" | "escalated-merged" | "escalated-abandoned" | "abandoned" | "open" | "blocked";
  readonly mergedAt: number | null;
  readonly integratedAt: number | null;
  readonly closedAt: number | null;
  readonly rounds: number;
  readonly firstPass: boolean;
  readonly humanApproval: boolean;
  readonly deviations: number;
  readonly testsFailFirst: number;
  readonly testsPassFirst: number;
  readonly mergeMethod: "local" | "pr";
}

export interface FxHistory {
  readonly seed: number;
  readonly start: number;
  readonly end: number;
  readonly tickets: readonly FxTicket[];
  readonly visits: readonly FxVisit[];
  readonly executions: readonly FxExecution[];
  readonly waits: readonly FxWait[];
  readonly gates: readonly FxGate[];
  readonly rounds: readonly FxRound[];
  readonly limits: readonly { readonly from: number; readonly to: number; readonly value: number }[];
}

export interface HistoryOptions {
  readonly seed?: number;
  /** "full": six weeks, about seventy tickets. "sparse": a project with two finished runs. */
  readonly size?: "full" | "sparse";
}

/** The history ends here, fixed so captures are reproducible. */
export const FIXTURE_END = Date.UTC(2026, 10, 13, 18, 0, 0);

// ------------------------------------------------------------------------------------- tunables

const STATION_MEDIAN: Readonly<Record<Station, readonly [number, number]>> = {
  groom: [7 * MIN, 0.5],
  plan: [9 * MIN, 0.45],
  audit: [90 * S, 0.4],
  build: [26 * MIN, 0.6],
  verify: [11 * MIN, 0.5],
  review: [13 * MIN, 0.45],
  human: [0, 0],
  merge: [2 * MIN, 0.5],
  cleanup: [45 * S, 0.3],
};
const CHECK_KIND: Readonly<Record<AppType, readonly (readonly [string, number])[]>> = {
  web: [["web-screenshot", 5], ["web-trace", 3], ["scenario-data", 2]],
  cli: [["cli-transcript", 4], ["exit-codes", 3]],
  api: [["api-response", 5], ["contract-diff", 2], ["db-state", 2]],
  library: [["consumer-driver", 3], ["api-surface", 2]],
};
const BLOCKER_RULES: readonly (readonly [{ rule: string; seat: string }, number])[] = [
  [{ rule: "REVIEW.md scope against the plan", seat: "architecture" }, 5],
  [{ rule: "REVIEW.md input handling", seat: "security" }, 3],
  [{ rule: "spec exact message (FR)", seat: "product" }, 4],
  [{ rule: "REVIEW.md dead code", seat: "architecture" }, 2],
  [{ rule: "REVIEW.md secrets", seat: "security" }, 1],
];
const TOOLS = ["curl", "docker", "npx", "brew"] as const;

// ------------------------------------------------------------------------------------- generate

export function generateHistory(opts: HistoryOptions = {}): FxHistory {
  const seed = opts.seed ?? 6502;
  const r = rng(seed);
  const end = FIXTURE_END;
  const days = opts.size === "sparse" ? 3 : 42;
  const start = end - days * D;
  const tickets: FxTicket[] = [];
  const visits: FxVisit[] = [];
  const executions: FxExecution[] = [];
  const waits: FxWait[] = [];
  const gates: FxGate[] = [];
  const rounds: FxRound[] = [];
  const limitChange = start + 20 * D;
  const limits = opts.size === "sparse" ? [{ from: start, to: end, value: 2 }] : [{ from: start, to: limitChange, value: 3 }, { from: limitChange, to: end, value: 4 }];
  const limitAt = (t: number) => limits.find((l) => t >= l.from && t < l.to)?.value ?? limits[limits.length - 1]!.value;
  /** Running supervised executions, for capacity holds. */
  const running: { from: number; to: number }[] = [];
  /** Executions already recorded that overlap [t, t + ahead): the limit holds over a span, not an instant. */
  const busy = (t: number, ahead: number) => running.filter((x) => x.from < t + ahead && x.to > t);
  const AHEAD = 3 * H;
  /** The first moment from t at which an execution can start without exceeding the recorded limit. */
  const freeFrom = (t: number) => {
    let at = t;
    for (let guard = 0; guard < 80; guard++) {
      const b = busy(at, AHEAD);
      if (b.length < limitAt(at)) return at;
      at = Math.min(...b.map((x) => x.to)) + S;
    }
    return at;
  };

  // Arrivals: waves of product slices dispatched together, and hand-driven or telemetry tickets between.
  type Arrival = { at: number; wave: string | null; slice: string | null; writer: "supervisor" | "hand"; id: string };
  const arrivals: Arrival[] = [];
  let sliceN = 1;
  let waveN = 1;
  let localN = 1;
  if (opts.size === "sparse") {
    arrivals.push({ at: start + 4 * H, wave: "WAVE-001", slice: "SLICE-001", writer: "supervisor", id: "SYN-001" });
    arrivals.push({ at: start + 30 * H, wave: "WAVE-001", slice: "SLICE-002", writer: "supervisor", id: "SYN-002" });
  } else {
    for (let t = start + 6 * H; t < end - 6 * H; ) {
      const wave = `WAVE-${String(waveN++).padStart(3, "0")}`;
      const size = 4 + Math.floor(r() * 6);
      for (let i = 0; i < size; i++) {
        const slice = `SLICE-${String(sliceN).padStart(3, "0")}`;
        arrivals.push({ at: t + Math.floor(r() * 15 * MIN), wave, slice, writer: r() < 0.88 ? "supervisor" : "hand", id: `SYN-${String(sliceN).padStart(3, "0")}` });
        sliceN++;
      }
      // Between waves: a non-product ticket or two (hand-driven, telemetry).
      const extra = Math.floor(r() * 2.2);
      for (let i = 0; i < extra; i++) {
        const auto = r() < 0.4;
        arrivals.push({ at: t + Math.floor(r() * 3 * D), wave: null, slice: null, writer: auto ? "supervisor" : "hand", id: auto ? `AUTO-${String(localN++).padStart(3, "0")}` : `LOCAL-${String(localN++).padStart(3, "0")}` });
      }
      t += Math.floor(2.4 * D + r() * 2.4 * D);
    }
  }
  arrivals.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));

  for (const a of arrivals) {
    const risk: Risk = opts.size === "sparse" ? (a.id === "SYN-001" ? "medium" : "low") : pick(r, [["low", 2], ["medium", 6], ["high", 2]]);
    const app: AppType = opts.size === "sparse" ? "web" : pick(r, [["web", 4], ["api", 3], ["cli", 2], ["library", 1]]);
    const supervised = a.writer === "supervisor";
    const lifecycle = opts.size === "sparse" ? true : !(a.writer === "hand" && r() < 0.35) && r() > 0.03;
    const id = a.id;
    const difficulty = 0.6 + r() * r() * 2.4;

    // Waits before work: a dependency (product slices only), then eligible → scheduled (queue), part of
    // which may be a hold for execution capacity (supervised only).
    let t = a.at;
    if (a.slice && r() < 0.28) {
      const ms = logn(r, 3 * H, 0.8);
      waits.push({ ticket: id, kind: "dependency", start: t, end: t + ms, round: null });
      t += ms;
    }
    const eligibleAt = t;
    let scheduledAt = t;
    if (a.slice) {
      let q = logn(r, 9 * MIN, 0.9);
      if (supervised) {
        // Hold for capacity while the limit is reached.
        const hold = freeFrom(t + q);
        if (hold > t + q) {
          waits.push({ ticket: id, kind: "capacity", start: t + q, end: hold, round: null });
          q = hold - t;
        }
      }
      waits.push({ ticket: id, kind: "queue", start: t, end: t + q, round: null });
      scheduledAt = t + q;
    }
    t = scheduledAt;

    // Executions: supervised tickets run inside executions; a failure or interruption makes a retry.
    let exec: { id: string; attempt: number; startedAt: number; agents: FxAgent[]; claimedAt: number; stage: FxExecution["stage"] } | null = null;
    let attempt = 0;
    const openExec = (stage: FxExecution["stage"]) => {
      attempt++;
      // Never past the recorded limit: a later stage also waits for a free slot.
      t = freeFrom(t);
      const claimedAt = t;
      const startedAt = claimedAt + 2 * S + Math.floor(r() * 18 * S);
      exec = { id: `x${id.toLowerCase().replace(/[^a-z0-9]/g, "")}${attempt}`, attempt, startedAt, claimedAt, agents: [], stage };
      t = startedAt;
    };
    const closeExec = (outcome: ExecOutcome, parked: boolean) => {
      if (!exec) return;
      const e = exec as { id: string; attempt: number; startedAt: number; agents: FxAgent[]; claimedAt: number; stage: FxExecution["stage"] };
      const endedAt = t;
      const observedAt = endedAt + 1 * S + Math.floor(r() * 25 * S);
      const sonnetShare = 0.55 + r() * 0.2;
      const base = (endedAt - e.startedAt) / H;
      const total = outcome === "completed" ? Math.max(0.4, base * (2.6 + r() * 2.4)) : base * (1.5 + r() * 2);
      const hasResult = outcome === "completed" ? r() > 0.04 : outcome === "failed" ? r() > 0.6 : false;
      const hasUsage = r() > 0.12;
      const models = new Set(e.agents.map((g) => g.model));
      const usage: FxUsage[] | null = hasUsage
        ? [...models].sort().map((m) => {
            const share = m === "sonnet" ? sonnetShare : m === "opus" ? 1 - sonnetShare - 0.04 : m === "fable" ? 0.08 : 0.04;
            const cost = Math.max(0.01, total * Math.max(0.02, share));
            const per = m === "opus" ? 15 : m === "fable" ? 20 : m === "sonnet" ? 3 : 1;
            const input = Math.round((cost * 1e6) / per / 4.2);
            return { model: m, input, output: Math.round(input * (0.18 + r() * 0.1)), cacheRead: Math.round(input * (6 + r() * 5)), cacheCreate: Math.round(input * (0.5 + r() * 0.6)), costUsd: Math.round(cost * 1000) / 1000 };
          })
        : null;
      const costUsd = hasResult ? Math.round((usage ? usage.reduce((s, u) => s + u.costUsd, 0) : total) * 100) / 100 : null;
      const recovery = outcome === "interrupted" ? "interrupted" : outcome === "unknown" ? "outcome-unknown" : null;
      const workflow = outcome === "interrupted" && r() < 0.5 ? "killed-budget" : outcome === "interrupted" ? "killed-stopped" : "finished";
      const refusedTools = r() < 0.08 ? [TOOLS[Math.floor(r() * TOOLS.length)]!] : [];
      executions.push({ id: e.id, ticket: id, attempt: e.attempt, stage: e.stage, claimedAt: e.claimedAt, startedAt: e.startedAt, endedAt, observedAt, outcome, recovery, parkedForPerson: parked, costUsd, usage, agents: e.agents, refusedTools, workflow });
      running.push({ from: e.claimedAt, to: endedAt });
      exec = null;
      t = observedAt;
    };
    const agent = (station: Station | null, seat: string | null, model: Model, phase: FxAgent["phase"], at: number, dur: number) => {
      if (!exec) return;
      const e = exec as { agents: FxAgent[]; id: string };
      const n = e.agents.length + 1;
      e.agents.push({ id: `agent:${e.id}/a${n}`, station, seat, model, phase, queuedMs: Math.floor(r() * (phase === "review" ? 40 : 8) * S), start: at, durMs: dur, toolCalls: r() < 0.9 ? Math.round(dur / MIN * (1.5 + r() * 2.5)) : null, tokens: r() < 0.92 ? Math.round(dur / S * (300 + r() * 500)) : null });
      // A relay clerk before each worker: no station.
      if (r() < 0.6) e.agents.push({ id: `agent:${e.id}/c${n}`, station: null, seat: null, model: "haiku", phase: "relay", queuedMs: Math.floor(r() * 3 * S), start: at, durMs: 8 * S + Math.floor(r() * 20 * S), toolCalls: 1 + Math.floor(r() * 3), tokens: 2000 + Math.floor(r() * 4000) });
    };
    const visitN: Partial<Record<Station, number>> = {};
    const visit = (station: Station, round: number, endedHow: FxVisit["ended"] = "exited", ms?: number): number => {
      const [med, sig] = STATION_MEDIAN[station];
      const dur = ms ?? logn(r, med * (station === "build" && round > 1 ? 0.55 : 1) * (a.writer === "hand" ? 1.6 : 1), sig);
      const n = (visitN[station] ?? 0) + 1;
      visitN[station] = n;
      const e = exec as { id: string } | null;
      if (lifecycle) visits.push({ ticket: id, station, n, round, start: t, end: t + dur, ended: endedHow, execution: e ? e.id : null });
      if (e) {
        if (station === "build") agent("build", null, "sonnet", "build", t, Math.round(dur * 0.9));
        if (station === "verify") agent("verify", null, "sonnet", "verify", t, Math.round(dur * 0.85));
        if (station === "plan") agent("plan", null, a.slice ? "opus" : "fable", "plan", t, Math.round(dur * 0.8));
        if (station === "review") {
          const seats = risk === "low" ? ["general"] : ["architecture", "security", "product"];
          for (const seat of seats) agent("review", seat, risk === "high" ? "opus" : "sonnet", "review", t, Math.round(dur * (0.6 + r() * 0.35)));
        }
      }
      t += dur;
      return dur;
    };
    const gate = (station: Station, name: string, refuseP: number) => {
      const refused = r() < refuseP;
      if (lifecycle) gates.push({ ticket: id, station, gate: name, at: t, verdict: refused ? "refused" : "passed", reason: refused ? pick(r, [["stale-audit", 2], ["dirty-cell", 1], ["spec-changed", 1]]) : null });
      if (refused) t += logn(r, 6 * MIN, 0.6);
      return refused;
    };

    if (supervised) openExec("planned");
    if (!a.slice) visit("groom", 1);
    visit("plan", 1);
    gate("audit", "audit gate", 0.05);
    visit("audit", 1);
    gate("build", "build start", 0.04);

    let round = 1;
    let outcome: FxTicket["outcome"] = "open";
    let firstPass = true;
    let humanApproval = false;
    let mergedAt: number | null = null;
    let closedAt: number | null = null;
    let interrupted = false;
    for (;;) {
      // Build, with a chance the execution fails or is interrupted mid-build (a retry, not a new slice).
      const buildDur = visit("build", round);
      if (lifecycle && r() < 0.06) gates.push({ ticket: id, station: "build", gate: "red before green", at: t - buildDur / 2, verdict: "overridden", reason: "flaky-baseline" });
      if (supervised && opts.size !== "sparse") {
        const fate = r();
        const o: ExecOutcome | null = fate < 0.06 ? "failed" : fate < 0.095 ? "interrupted" : fate < 0.11 ? "unknown" : null;
        if (o) {
          // The visit that was running is cut: mark the last build visit as interrupted when the process died.
          if (o !== "failed" && lifecycle) {
            const last = visits.pop()!;
            visits.push({ ...last, ended: "interrupted", end: o === "unknown" ? null : last.end });
          }
          closeExec(o, false);
          interrupted = true;
          t += logn(r, 12 * MIN, 0.7);
          openExec("planned");
          visit("build", round);
        }
      }
      if (r() < 0.04 && round === 1 && opts.size !== "sparse") {
        outcome = "abandoned";
        closedAt = t + logn(r, 2 * H, 0.5);
        break;
      }
      // Verify.
      const vFail = r() < (app === "web" ? 0.27 : 0.14) * difficulty * (round > 1 ? 0.85 : 1) && !(opts.size === "sparse" && id === "SYN-002");
      visit("verify", round);
      if (vFail) {
        const kinds = Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(r, CHECK_KIND[app]));
        rounds.push({ ticket: id, round, verify: "FAIL_WITH_EVIDENCE", review: null, securityVeto: false, failedChecks: kinds, blockers: [], at: t });
        firstPass = false;
        if (round === 3) break;
        round++;
        continue;
      }
      // Review.
      visit("review", round);
      const rej = r() < (risk === "high" ? 0.26 : risk === "medium" ? 0.17 : 0.06) * difficulty * (round > 1 ? 0.85 : 1) || (opts.size === "sparse" && id === "SYN-001" && round === 1);
      if (rej) {
        const blockers = Array.from({ length: 1 + Math.floor(r() * 2) }, () => pick(r, BLOCKER_RULES));
        const veto = blockers.some((b) => b.seat === "security") && risk !== "low";
        rounds.push({ ticket: id, round, verify: "PASS", review: round === 3 ? "ESCALATE" : "REJECTED", securityVeto: veto, failedChecks: [], blockers, at: t });
        firstPass = false;
        if (round === 3) break;
        round++;
        continue;
      }
      const awaiting = risk === "high";
      rounds.push({ ticket: id, round, verify: "PASS", review: awaiting ? "AWAITING_HUMAN" : "APPROVED", securityVeto: false, failedChecks: [], blockers: [], at: t });
      if (supervised) closeExec("completed", awaiting);
      if (awaiting) {
        const w = logn(r, 5 * H, 0.9);
        waits.push({ ticket: id, kind: "human", start: t, end: t + w, round });
        if (lifecycle) visits.push({ ticket: id, station: "human", n: 1, round, start: t, end: t + w, ended: "exited", execution: null });
        t += w;
        humanApproval = true;
      }
      // Merge (a person merges high risk; otherwise a short second execution when supervised).
      if (supervised && !awaiting) openExec("approved");
      gate("merge", "approval bound to commit", 0.04);
      visit("merge", round);
      mergedAt = t;
      if (supervised && !awaiting) closeExec("completed", false);
      visit("cleanup", round);
      closedAt = t;
      outcome = "merged";
      break;
    }
    if (outcome === "open" && round === 3) {
      // Escalated at the third judging round: blocked for a person, who later merges it or abandons it.
      if (exec) closeExec("completed", true);
      const settle = r();
      const w = logn(r, 18 * H, 0.6);
      waits.push({ ticket: id, kind: "human", start: t, end: settle < 0.75 ? t + w : null, round: 3 });
      if (settle < 0.4) {
        t += w;
        visit("merge", 3);
        mergedAt = t;
        visit("cleanup", 3);
        closedAt = t;
        outcome = "escalated-merged";
        humanApproval = true;
      } else if (settle < 0.75) {
        t += w;
        closedAt = t;
        outcome = "escalated-abandoned";
      } else outcome = "blocked";
    }
    if (exec) closeExec(outcome === "abandoned" ? "completed" : "completed", false);
    void interrupted;
    const integratedAt = mergedAt !== null && a.slice ? mergedAt + logn(r, 40 * MIN, 0.8) : null;
    const tests = 6 + Math.floor(r() * 16);
    const failFirst = Math.min(tests, Math.round(tests * (0.8 + r() * 0.22)));
    tickets.push({
      id, slice: a.slice, wave: a.wave, risk, app, writer: a.writer, lifecycle, eligibleAt, scheduledAt, outcome, mergedAt, integratedAt, closedAt,
      rounds: round, firstPass, humanApproval, deviations: pick(r, [[0, 6], [1, 3], [2, 1]]), testsFailFirst: failFirst, testsPassFirst: tests - failFirst,
      mergeMethod: r() < 0.7 ? "local" : "pr",
    });
  }

  return clipTo(end, { seed, start, end, tickets, visits, executions, waits, gates, rounds, limits });
}

/** Cuts the history at its end: anything after it did not happen yet; anything spanning it is open. */
function clipTo(end: number, h: FxHistory): FxHistory {
  const before = <T extends { start: number }>(xs: readonly T[]) => xs.filter((x) => x.start < end);
  return {
    ...h,
    tickets: h.tickets
      .filter((t) => t.eligibleAt < end)
      .map((t) => (t.closedAt !== null && t.closedAt > end ? { ...t, outcome: "open" as const, closedAt: null, mergedAt: t.mergedAt !== null && t.mergedAt <= end ? t.mergedAt : null, integratedAt: t.integratedAt !== null && t.integratedAt <= end ? t.integratedAt : null } : t))
      .map((t) => (t.integratedAt !== null && t.integratedAt > end ? { ...t, integratedAt: null } : t)),
    visits: before(h.visits).map((v) => (v.end !== null && v.end > end ? { ...v, end: null, ended: "open" as const } : v)),
    executions: h.executions.filter((e) => e.claimedAt < end && e.observedAt <= end),
    waits: before(h.waits).map((w) => (w.end !== null && w.end > end ? { ...w, end: null } : w)),
    gates: h.gates.filter((g) => g.at < end),
    rounds: h.rounds.filter((x) => x.at < end),
  };
}
