import type { SpecSectionId } from "@mach/ui";

/**
 * Words used only by the specification screen. The spec model, diagnostics and section IDs are
 * shared from @mach/ui and @mach/ui/api.
 */
export type SectionId = SpecSectionId;

/** Plain names for the requirement patterns the validator reports. */
export const patternNames: Record<string, string> = {
  "event-driven": "When something happens",
  "unwanted-behavior": "When something goes wrong",
  ubiquitous: "Always",
  "state-driven": "While a condition holds",
  optional: "Where a feature is present",
  complex: "Combined conditions",
};

export const sectionTitles: Record<SpecSectionId, string> = {
  summary: "Summary and scope",
  rules: "Rules that always hold",
  requirements: "What the product does",
  "decision-table": "Decision table",
  scenarios: "Examples to test",
  dependencies: "Services and permissions",
  assumptions: "Assumptions and accepted defaults",
  "open-questions": "Open questions",
  effects: "Effects on shipped behaviour",
  principles: "Principles",
  policies: "Policies",
  why: "Why this slice",
  source: "Source",
};

/**
 * What the wide pane shows. The specification, its why and its source are one page: the section list beside it chooses
 * between them (M16 layout), so a slice has one row of page tabs.
 */
export type View = "spec" | "why" | "source";

export function viewOf(section: SpecSectionId): View {
  return section === "why" ? "why" : section === "source" ? "source" : "spec";
}

