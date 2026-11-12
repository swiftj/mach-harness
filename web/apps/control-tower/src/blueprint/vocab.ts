/**
 * How the simulation's words map onto the factory grammar's symbols. The simulation speaks MACH
 * (clerks, intent workers, Bash, `verification#2`); the grammar has one symbol per kind of thing.
 * Every mapping here is presentation only and is listed in the Blueprint report.
 */
import type { AgentRole as GrammarRole, ArtifactKind as GrammarArtifact, FactoryState, GateKind as GrammarGate, ModelTier as GrammarTier, ReviewerSeat, StationKind, ToolFamily } from "@mach/ui";
import type { AgentState, ArtifactState, CellStage, GateState, ModelId, ReviewSeat, StationVisit, ToolCallState } from "../sim";

export function tierOf(model: ModelId): GrammarTier {
  return model;
}

/** The grammar has emblems for six roles; the belt's own workers borrow the nearest one. */
export function grammarRole(agent: Pick<AgentState, "role">): GrammarRole {
  switch (agent.role) {
    case "contract-engineer":
      return "contract-engineer";
    case "builder":
      return "builder";
    case "verifier":
      return "verifier";
    case "reviewer":
      return "reviewer";
    default:
      return "supervisor";
  }
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

/** Simulation gate kinds to the grammar's glyphs. `plan-check` has no glyph of its own: it borrows the audit gauge. */
export function grammarGate(gate: GateState["gate"]): GrammarGate {
  switch (gate) {
    case "audit":
    case "plan-check":
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

export function gateState(gate: GateState): FactoryState {
  switch (gate.state) {
    case "open":
      return "active";
    case "passed":
      return "succeeded";
    case "failed":
      return "failed";
    case "waiting":
      return "human";
    case "skipped":
      return "idle";
  }
}

export function visitState(visit: StationVisit): FactoryState {
  if (visit.outcome === null) return visit.station === "human-approval" ? "human" : "active";
  switch (visit.outcome) {
    case "failed":
    case "rejected":
      return "failed";
    case "awaiting-human":
      return "human";
    case "stopped":
      return "idle";
    default:
      return "succeeded";
  }
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

/** The grammar's artifact marks are coarser than MACH's artifact kinds. */
export function grammarArtifact(kind: ArtifactState["kind"]): GrammarArtifact {
  switch (kind) {
    case "intent":
    case "spec":
    case "contract":
    case "plan":
    case "commit":
    case "build-report":
    case "evidence":
    case "vote":
    case "decision":
    case "merge-commit":
      return kind;
    case "build-state":
      return "build-report";
    case "verification-results":
    case "verification-summary":
      return "results";
    case "findings-copy":
    case "verification-findings":
    case "review-findings":
      return "findings";
    case "review-packet":
    case "review-diff":
      return "spec";
    case "archive":
    case "run-record":
      return "decision";
  }
}

export function artifactFile(a: Pick<ArtifactState, "kind" | "path" | "label" | "sha">): string {
  if (a.kind === "commit" || a.kind === "merge-commit") return a.sha ? a.sha.slice(0, 7) : "commit";
  const slash = a.path.lastIndexOf("/");
  return slash >= 0 && a.kind !== "review-findings" && a.kind !== "review-packet" ? a.path.slice(slash + 1) : a.label;
}
