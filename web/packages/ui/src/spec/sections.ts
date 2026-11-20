/**
 * Where an engine finding belongs in a specification. Pure and without imports, so the app's
 * screen models (and their node tests) can use it through `@mach/ui/sections`.
 */

/** The parts of a specification a diagnostic can be placed next to. */
export type SpecSectionId =
  | "summary"
  | "rules"
  | "requirements"
  | "decision-table"
  | "scenarios"
  | "dependencies"
  | "assumptions"
  | "open-questions"
  | "effects"
  | "principles"
  | "policies"
  | "why"
  | "source";

/** The spec's own section headings (as the engine reports them) to the parts the screens show. */
const sectionByHeading: Record<string, SpecSectionId> = {
  Summary: "summary",
  Scope: "summary",
  Preconditions: "summary",
  Invariants: "rules",
  "Functional requirements": "requirements",
  // The decision matrix and the scenarios share this heading; the table comes first.
  "Acceptance criteria": "decision-table",
  "Dependencies and permissions": "dependencies",
  Assumptions: "assumptions",
  "Accepted defaults": "assumptions",
  "Open questions": "open-questions",
  "Effects on shipped behaviour": "effects",
  Principles: "principles",
  Policies: "policies",
};

/** Rule codes that place a finding when the engine names no section (a missing section is about no line). */
const sectionByRule: Array<[RegExp, SpecSectionId]> = [
  [/^effects-/, "effects"],
  [/^principle-/, "principles"],
  [/^policy-/, "policies"],
];

/**
 * The part of the specification an engine finding is about: by the section heading the engine
 * names, else by its rule code (`effects-missing` names no section). Null for the whole specification.
 */
export function specSectionOf(finding: { section?: string | null; rule?: string | null }): SpecSectionId | null {
  const byHeading = finding.section ? sectionByHeading[finding.section] : undefined;
  if (byHeading) return byHeading;
  const rule = finding.rule ?? "";
  return sectionByRule.find(([pattern]) => pattern.test(rule))?.[1] ?? null;
}
