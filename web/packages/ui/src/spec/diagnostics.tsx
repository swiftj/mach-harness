import type { SliceCheck, SliceShow, SpecModel, WhyDocument } from "../api/types";
import { cn } from "../lib/cn";
import { StateGlyph } from "../lifecycle/glyph";

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
  | "why"
  | "source";

export interface Diagnostic {
  severity: "error" | "warning" | "open-question" | "why";
  /** The engine's message, as written. */
  message: string;
  line: number | null;
  rule: string | null;
  /** Where it belongs; null when it is about the whole specification. */
  section: SpecSectionId | null;
}

/** The spec's model from `slice show`, or null when there is no spec. Partial when the spec has errors. */
export function specModel(show: SliceShow): Partial<SpecModel> | null {
  const model = show.spec?.model;
  return model && typeof model === "object" ? model : null;
}

/** The slice's why from `slice show`. */
export function whyDocument(show: SliceShow): WhyDocument | null {
  const why = show.why;
  return why && typeof why === "object" ? why : null;
}

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
};

/**
 * The engine's check findings, each placed by the section the engine names (`diagnostics[].section`).
 * A finding with no section is about the whole specification. Problems with the why are placed
 * with the why. Nothing is read from the message text.
 */
export function diagnostics(check: SliceCheck): Diagnostic[] {
  // An engine without `diagnostics` (before M5 wave 3): its errors and warnings are shown as they are,
  // about the whole specification.
  const reported = check.diagnostics ?? [
    ...check.errors.map((message) => ({ severity: "error", rule: null, line: null, section: null, message })),
    ...check.warnings.map((message) => ({ severity: "warning", rule: null, line: null, section: null, message })),
  ];
  const out: Diagnostic[] = reported.map((d) => ({
    severity: d.severity === "warning" ? "warning" : "error",
    message: d.message,
    line: d.line,
    rule: d.rule,
    section: d.section ? (sectionByHeading[d.section] ?? null) : null,
  }));
  check.intent_problems.forEach((p) => out.push({ severity: "why", message: p, line: null, rule: null, section: "why" }));
  return out;
}

export function DiagnosticList({ items, compact = false }: { items: Diagnostic[]; compact?: boolean }) {
  return (
    <ul className={cn("flex flex-col gap-1.5", !compact && "rounded-md border border-danger-line bg-danger-soft px-3 py-2.5")}>
      {items.map((d, index) => (
        <li key={index} className="flex items-start gap-2 text-body-sm text-ink">
          <span className={cn("mt-0.5 shrink-0", d.severity === "error" || d.severity === "why" ? "text-danger-ink" : "text-warning-ink")}>
            <StateGlyph shape={d.severity === "error" || d.severity === "why" ? "blocked" : "half"} />
          </span>
          <span className="min-w-0">
            {d.message}
            {d.line ? <span className="ml-1.5 text-caption text-ink-subtle">line {d.line}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function OpenQuestionList({ items, compact = false }: { items: Array<{ question: string; follow_up?: string | null }>; compact?: boolean }) {
  return (
    <ul className={cn("flex flex-col", compact ? "gap-2" : "gap-2.5")}>
      {items.map((item, index) => (
        <li key={index} className={cn("flex items-start gap-2.5", !compact && "rounded-md border border-warning-line bg-surface px-4 py-3")}>
          <span className="mt-1 shrink-0 text-warning-ink">
            <StateGlyph shape="half" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className={cn("text-ink", compact ? "text-body-sm" : "text-body")}>{item.question}</p>
            {item.follow_up ? <p className="text-caption text-ink-muted">Who can answer: {item.follow_up}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
