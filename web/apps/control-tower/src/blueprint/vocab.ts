/**
 * How the simulation's words map onto the factory grammar's symbols. The simulation speaks MACH
 * (clerks, intent workers, Bash, `verification#2`); the grammar has one symbol per kind of thing.
 * Every mapping here is presentation only and is listed in the Blueprint report.
 */
import type { AgentRole as GrammarRole, ArtifactKind as GrammarArtifact, FactoryState, MarkState, GateKind as GrammarGate, ModelTier as GrammarTier, ReviewerSeat, StationKind, ToolFamily } from "@mach/ui";
import type { AgentState, ArtifactState, CellStage, GateState, ModelId, ReviewSeat, StationVisit, ToolCallState } from "../sim";

export function tierOf(model: ModelId): GrammarTier {
  return model;
}

/** The grammar now has an emblem for each of the belt's roles (pass 3), so roles map one to one. */
export function grammarRole(agent: Pick<AgentState, "role">): GrammarRole {
  return agent.role;
}

const ROLE_WORDS: Record<AgentState["role"], string> = {
  clerk: "Clerk",
  intent: "Intent worker",
  "contract-engineer": "Contract engineer",
  builder: "Builder",
  verifier: "Verifier",
  reviewer: "Reviewer",
  merge: "Merge worker",
  cleanup: "Cleanup worker",
  audit: "Audit worker",
  observe: "Observer",
};

const MODEL_WORDS: Record<ModelId, string> = { fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

export function modelWord(model: ModelId): string {
  return MODEL_WORDS[model];
}

export function seatWord(seat: ReviewSeat): string {
  return seat === "architecture" ? "Architecture" : seat === "security" ? "Security" : seat === "product" ? "Product" : "General";
}

export function grammarSeat(seat: ReviewSeat | null): ReviewerSeat | undefined {
  return seat === "architecture" || seat === "security" || seat === "product" ? seat : undefined;
}

/** "Builder", "Security reviewer", "Clerk: what next?" */
export function agentWords(agent: Pick<AgentState, "role" | "seat" | "label">): string {
  if (agent.role === "reviewer" && agent.seat) return `${seatWord(agent.seat)} reviewer`;
  if (agent.role === "clerk") {
    const task = agent.label.includes(": ") ? agent.label.slice(agent.label.indexOf(": ") + 2) : agent.label;
    return `Clerk: ${task}`;
  }
  return ROLE_WORDS[agent.role];
}

/** A tool call's family, from the tool and (for the shell) what it ran. */
export function toolFamily(call: Pick<ToolCallState, "tool" | "target">): ToolFamily {
  switch (call.tool) {
    case "Read":
    case "Glob":
      return "read";
    case "Write":
    case "Edit":
      return "write";
    case "Grep":
    case "Agent":
      return "search";
    case "Bash": {
      const t = call.target;
      if (/^git\b/.test(t)) return "git";
      if (/\b(vitest|jest|playwright test|pnpm test|pytest)\b|build\.py (red|green)/.test(t)) return "test";
      return "run";
    }
    default:
      return "run";
  }
}

export const STATION_WORDS: Record<string, string> = {
  intake: "Intake",
  groom: "Groom",
  plan: "Plan",
  audit: "Audit",
  build: "Build",
  verify: "Verify",
  review: "Review",
  "human-approval": "Human approval",
  merge: "Merge",
  cleanup: "Cleanup",
  observe: "Observe",
};

export function visitWords(visit: Pick<StationVisit, "station" | "action">): string {
  if (visit.action === "revise") return "Build (revise)";
  return STATION_WORDS[visit.station] ?? visit.station;
}

export function stationKind(station: string): StationKind {
  return station as StationKind;
}

/** Simulation gate kinds to the grammar's glyphs (pass 3 added `plan-check`). */
export function grammarGate(gate: GateState["gate"]): GrammarGate {
  switch (gate) {
    case "plan-check":
      return "plan-check";
    case "audit":
      return "audit";
    case "red-before-green":
      return "red-green";
    case "verification":
      return "verification";
    case "review":
      return "consensus";
    case "human-approval":
      return "human";
    case "merge-revalidation":
      return "revalidation";
  }
}

export const GATE_WORDS: Record<GateState["gate"], string> = {
  "plan-check": "Plan check",
  audit: "Audit gate",
  "red-before-green": "Red before green",
  verification: "Verification verdict",
  review: "Review consensus",
  "human-approval": "Human approval",
  "merge-revalidation": "Merge revalidation",
};

/** A gate's grammar state. An override lets the work through (succeeded), and every caller marks it overridden by shape too (`gateOverridden`). */
export function gateState(gate: GateState): FactoryState {
  switch (gate.state) {
    case "open":
      return "active";
    case "passed":
    case "overridden":
      return "succeeded";
    case "failed":
      return "failed";
    case "waiting":
      return "human";
    case "skipped":
      return "idle";
  }
}

export function gateOverridden(gate: Pick<GateState, "state"> | null | undefined): boolean {
  return gate?.state === "overridden";
}

/** A gate's state in words, from its own record: "passed", "overridden, test-passed-first-run", "refused"... */
export function gateWords(gate: GateState): string {
  switch (gate.state) {
    case "open":
      return "deciding";
    case "waiting":
      return "waiting for a person";
    case "passed":
      return "passed";
    case "skipped":
      return "not needed";
    case "overridden":
      return `overridden${gate.reasonCode ? `, ${gate.reasonCode}` : ""}`;
    case "failed":
      return `refused${gate.reasonCode ? `, ${gate.reasonCode}` : ""}`;
  }
}

/**
 * A visit as drawn, from its own record only: working while open (waiting at the human gate),
 * interrupted when it ended without an exit record (the scene closed it: `unclosed`), failed or passed
 * by its outcome, blocked when it stopped, unknown when it ended with no outcome. Never "working" once
 * the scene has closed it.
 */
export function visitMark(visit: StationVisit): MarkState {
  if (visit.unclosed) return "interrupted";
  if (visit.leftAt === null) return visit.station === "human-approval" ? "human" : "active";
  switch (visit.outcome) {
    case "failed":
    case "rejected":
      return "failed";
    case "awaiting-human":
      return "human";
    case "stopped":
      return "blocked";
    case null:
      return "unknown";
    default:
      return "succeeded";
  }
}

/** The visit's state in words for names: the station's own word, or why there is none. */
export function visitStateWords(visit: StationVisit): string {
  if (visit.unclosed) return `ended without an exit record (${visit.unclosed.reason === "superseded" ? "entered again before it exited" : "its execution ended"})`;
  if (visit.leftAt === null) return visit.station === "human-approval" ? "waiting" : "running";
  return visit.outcomeWord ?? visit.outcome ?? "ended, outcome not recorded";
}

export function agentState(agent: Pick<AgentState, "status">): FactoryState {
  return agent.status === "running" ? "active" : agent.status === "error" ? "failed" : "succeeded";
}

/** The grammar's cell stages are a superset of the simulation's, except `spec-open`. */
export function stageState(stage: CellStage): FactoryState {
  switch (stage) {
    case "interview":
    case "building":
    case "pr-open":
      return "active";
    case "verified":
    case "approved":
    case "merged":
      return "succeeded";
    case "awaiting-human":
      return "human";
    case "blocked":
      return "blocked";
    default:
      return "idle";
  }
}

const STAGE_WORDS: Record<CellStage, string> = {
  interview: "Grooming",
  "spec-open": "Spec has open questions",
  "spec-ready": "Spec ready",
  planned: "Planned",
  building: "Building",
  built: "Built",
  verified: "Verified",
  "awaiting-human": "Awaiting a person",
  approved: "Approved",
  "pr-open": "Pull request open",
  merged: "Merged",
  blocked: "Blocked",
};

export function stageWords(stage: CellStage): string {
  return STAGE_WORDS[stage];
}

/** Pass 3 gave the grammar one kind for each of MACH's artifact kinds; the only rename is the review diff. */
export function grammarArtifact(kind: ArtifactState["kind"]): GrammarArtifact {
  return kind;
}

export function artifactFile(a: Pick<ArtifactState, "kind" | "path" | "label" | "sha">): string {
  if (a.kind === "commit" || a.kind === "merge-commit") return a.sha ? a.sha.slice(0, 7) : "commit";
  const slash = a.path.lastIndexOf("/");
  return slash >= 0 && a.kind !== "review-findings" && a.kind !== "review-packet" ? a.path.slice(slash + 1) : a.label;
}
