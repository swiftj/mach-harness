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
  /** The engine's message, as written, without the file-name prefix. */
  message: string;
  line: number | null;
  rule: string | null;
  section: SpecSectionId;
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

function sectionFor(message: string, rule: string | null): SpecSectionId {
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
