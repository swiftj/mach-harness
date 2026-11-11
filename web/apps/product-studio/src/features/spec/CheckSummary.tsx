import type { SliceCheck, SliceStatus } from "@mach/ui/api";
import { StateGlyph, StatusPill, cn, type GlyphShape, type Tone } from "@mach/ui";
import { count } from "./text";

export interface CheckVerdict {
  tone: Tone;
  glyph: GlyphShape;
  label: string;
  detail: string;
}

/**
 * Words for the engine's check result. Every fact comes from `slice check`: its error, warning,
 * open-question and why-problem lists and its `ready` flag. A passing check is "ready for your
 * approval", never "approved": only the PM approves.
 */
export function checkVerdict(check: SliceCheck, status?: SliceStatus): CheckVerdict {
  const problems = check.errors.length + check.intent_problems.length;
  if (!check.spec) {
    return { tone: "neutral", glyph: "open", label: "No spec yet", detail: "The interviewer writes the spec once the questions are settled." };
  }
  if (problems > 0) {
    return { tone: "danger", glyph: "blocked", label: `${count(problems, "problem")} to fix`, detail: "The engine's check found problems in the draft." };
  }
  if (check.open_questions.length > 0) {
    return {
      tone: "warning",
      glyph: "half",
      label: `${count(check.open_questions.length, "open question")}`,
      detail: "The spec is well formed, but it cannot be approved while questions are open.",
    };
  }
  if (check.ready && status === "approved_for_engineering") {
    return { tone: "success", glyph: "approved", label: "Passes the check", detail: "The engine's check passed and you approved this slice." };
  }
  if (check.ready) {
    return { tone: "accent", glyph: "ready", label: "Ready for your approval", detail: "The engine's check passes and nothing is open." };
  }
  return { tone: "warning", glyph: "half", label: "Not ready yet", detail: "The engine's check did not mark this spec ready." };
}

export function CheckPill({ check, status, size }: { check: SliceCheck; status?: SliceStatus; size?: "sm" | "md" }) {
  const v = checkVerdict(check, status);
  return (
    <StatusPill tone={v.tone} size={size} icon={<StateGlyph shape={v.glyph} />} title={v.detail}>
      {v.label}
    </StatusPill>
  );
}

/** The four counts the check reports, as a definition list. */
export function CheckCounts({ check, className }: { check: SliceCheck; className?: string }) {
  const items: Array<[string, number]> = [
    ["Rules", check.counts.invariants],
    ["Requirements", check.counts.functional_requirements],
    ["Decisions", check.counts.matrix_rules],
    ["Examples", check.counts.scenarios],
  ];
  return (
    <dl className={cn("grid grid-cols-4 gap-2", className)}>
      {items.map(([label, value]) => (
        <div key={label} className="flex min-w-0 flex-col rounded-sm bg-surface-sunken px-2.5 py-2">
          <dt className="truncate text-caption text-ink-muted">{label}</dt>
          <dd className="text-title-3 font-semibold tabular text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
