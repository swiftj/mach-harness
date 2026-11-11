import type { SliceCheck, SliceShow } from "@mach/ui/api";

/**
 * The validator's exported model of a spec (`slice.show` → `spec.model`), as web/fixtures/slice.show.*
 * show it. `@mach/ui/api` types it as `unknown` until the shell owner adopts a shape; this is the
 * shape read here, defensively: a missing field is shown as missing, never invented.
 *
 * PROMOTION CANDIDATE: `SpecModel` and `WhyDocument` for `@mach/ui/api` types.ts.
 */
export interface SpecModel {
  slice_id?: string;
  title?: string;
  summary?: { actor?: string; trigger?: string; outcome?: string };
  in_scope?: string[];
  out_of_scope?: string[];
  preconditions?: string[];
  invariants?: Array<{ id: string; text: string }>;
  functional_requirements?: Array<{ id: string; pattern?: string; text: string }>;
  decision_matrix?: {
    conditions: Array<{ name: string; values: string[] }>;
    rules: Array<{ id: string; conditions: Record<string, string[]>; expected_outcome: string; side_effects: string; covers: string[] }>;
    complete?: boolean;
  } | null;
  scenarios?: Array<{ id: string; title: string; covers: string[]; steps: Array<{ keyword: string; text: string }> }>;
  external_dependencies?: Array<{ name: string; failure_requirements: string[] }>;
  required_permissions?: string | null;
  assumptions?: string[];
  accepted_defaults?: Array<{ default: string; requirements: string[] }>;
  open_questions?: Array<{ question: string; follow_up?: string | null }>;
}

export interface WhyDocument {
  exists: boolean;
  markdown?: string;
  title?: string;
  header?: Record<string, string>;
  sections?: Array<{ heading: string; text: string; fields: Record<string, string> }>;
}

export function specModel(show: SliceShow): SpecModel | null {
  const model = show.spec?.model;
  return model && typeof model === "object" ? (model as SpecModel) : null;
}

export function whyDocument(show: SliceShow): WhyDocument | null {
  const why = show.why;
  return why && typeof why === "object" ? (why as WhyDocument) : null;
}

/** Plain names for the requirement patterns the validator reports. */
export const patternNames: Record<string, string> = {
  "event-driven": "When something happens",
  "unwanted-behavior": "When something goes wrong",
  ubiquitous: "Always",
  "state-driven": "While a condition holds",
  optional: "Where a feature is present",
  complex: "Combined conditions",
};

export type SectionId =
  | "summary"
  | "rules"
  | "requirements"
  | "decision-table"
  | "scenarios"
  | "dependencies"
  | "assumptions"
  | "open-questions"
  | "why"
  | "source";

export const sectionTitles: Record<SectionId, string> = {
  summary: "Summary and scope",
  rules: "Rules that always hold",
  requirements: "What the product does",
  "decision-table": "Decision table",
  scenarios: "Examples to test",
  dependencies: "Services and permissions",
  assumptions: "Assumptions and accepted defaults",
  "open-questions": "Open questions",
  why: "Why this slice",
  source: "Source",
};

export interface Diagnostic {
  severity: "error" | "warning" | "open-question" | "why";
  /** The engine's message, as written, without the file-name prefix. */
  message: string;
  line: number | null;
  rule: string | null;
  section: SectionId;
}

/**
 * Places each of the engine's diagnostics next to the section it is about. Only the location is
 * worked out here (from the IDs and section names in the engine's own message); the words are the
 * engine's.
 */
export function diagnostics(check: SliceCheck): Diagnostic[] {
  const out: Diagnostic[] = [];
  const parse = (raw: string, severity: Diagnostic["severity"]) => {
    const located = raw.match(/^[^\s:]+\.md(?::(\d+))?:\s*(.*)$/s);
    const body = (located ? located[2] : raw) ?? raw;
    const ruleMatch = body.match(/\s*\[([a-z0-9-]+)\]\s*$/);
    const message = ruleMatch ? body.slice(0, ruleMatch.index).trim() : body.trim();
    out.push({ severity, message, line: located?.[1] ? Number(located[1]) : null, rule: ruleMatch?.[1] ?? null, section: sectionFor(message, ruleMatch?.[1] ?? null) });
  };
  check.errors.forEach((e) => parse(e, "error"));
  check.warnings.forEach((w) => parse(w, "warning"));
  check.intent_problems.forEach((p) => out.push({ severity: "why", message: p, line: null, rule: null, section: "why" }));
  return out;
}

function sectionFor(message: string, rule: string | null): SectionId {
  const firstId = message.match(/\b(INV|FR|AC|R)-?\d+\b/)?.[1];
  if (/Invariants/.test(message) || firstId === "INV") return "rules";
  if (/Functional requirements/.test(message) || firstId === "FR") return "requirements";
  if (/matrix|Decision/i.test(message) || rule?.startsWith("matrix") || firstId === "R") return "decision-table";
  if (/Scenario|Acceptance/i.test(message) || firstId === "AC") return "scenarios";
  if (/open question/i.test(message)) return "open-questions";
  if (/Assumption|default/i.test(message) || rule?.startsWith("defaults")) return "assumptions";
  if (/Dependenc|permission/i.test(message)) return "dependencies";
  return "summary";
}
