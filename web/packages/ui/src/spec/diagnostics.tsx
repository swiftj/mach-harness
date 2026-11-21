import type { SliceCheck, SliceShow, SpecModel, WhyDocument } from "../api/types";
import { cn } from "../lib/cn";
import { StateGlyph } from "../lifecycle/glyph";
import { specSectionOf, type SpecSectionId } from "./sections";

export { specSectionOf, type SpecSectionId };

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
    section: specSectionOf(d),
  }));
  check.intent_problems.forEach((p) => out.push({ severity: "why", message: p, line: null, rule: null, section: "why" }));
  return out;
}

/** A finding to list: the engine's words, its severity and, where it has one, its line. */
export type DiagnosticItem = Pick<Diagnostic, "message" | "line"> & { severity: Diagnostic["severity"] | (string & {}) };

const blocking = (severity: string) => severity === "error" || severity === "why";

/**
 * The engine's findings, each with its glyph, its words and its line. The list colours itself by its strongest finding:
 * danger when any of them blocks, warning when every one is only worth a look. Each says which it is in words, too.
 */
export function DiagnosticList({ items, compact = false }: { items: DiagnosticItem[]; compact?: boolean }) {
  const anyBlocking = items.some((d) => blocking(d.severity));
  return (
    <ul
      className={cn(
        "flex flex-col gap-1.5",
        !compact && "rounded-md border px-3 py-2.5",
        !compact && (anyBlocking ? "border-danger-line bg-danger-soft" : "border-warning-line bg-warning-soft"),
      )}
    >
      {items.map((d, index) => (
        <li key={index} className="flex items-start gap-2 text-body-sm text-ink">
          <span className={cn("mt-0.5 shrink-0", blocking(d.severity) ? "text-danger-ink" : "text-warning-ink")}>
            <StateGlyph shape={blocking(d.severity) ? "blocked" : "half"} />
          </span>
          <span className="min-w-0">
            <span className="sr-only">{blocking(d.severity) ? "Problem: " : "Warning: "}</span>
            {d.message}
            {d.line ? <span className="ml-1.5 text-caption tabular text-ink-subtle">line {d.line}</span> : null}
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
