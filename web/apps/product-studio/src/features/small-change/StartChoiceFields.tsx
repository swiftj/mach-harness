import { Field, RadioGroup, Select, Text, describeError, plain } from "@mach/ui";
import { useOperation } from "../../api/useOperation";
import { MISSING_WORDS, SMALL_CHANGE_GROWS, SMALL_CHANGE_MEANS, changeOptions, rulesToFix, startOptions, type StartChoice } from "./model";

export interface StartChoiceFieldsProps {
  choice: StartChoice;
  onChange: (choice: StartChoice) => void;
  /** The epic chosen in the form: a fix names one of the rules shipped in it. */
  epicId: string;
  /** Offer the choice between a new slice and a small change (both dialogs do). */
  offerStartAs?: boolean;
  /** Say what a small change is here, when the dialog's own description does not. */
  explain?: boolean;
  /** What the person still has to choose, shown once they tried to start. */
  missing?: "change" | "rule" | null;
}

/**
 * The part of a start dialog that makes it a small change (M18): a new slice or a small change; for a small change,
 * a fix or an adjustment; for a fix, the shipped rule that is not holding, from how the epic works today. The engine
 * checks the rule again when the slice is started.
 */
export function StartChoiceFields({ choice, onChange, epicId, offerStartAs = true, explain = false, missing = null }: StartChoiceFieldsProps) {
  const small = choice.as === "small";
  return (
    <div className="flex flex-col gap-4">
      {offerStartAs ? (
        <RadioGroup
          legend="What are you starting?"
          options={startOptions}
          value={choice.as}
          onValueChange={(as) => onChange(as === "slice" ? { as, change: null, rule: null } : { ...choice, as })}
          tone="accent"
        />
      ) : null}
      {small && explain ? (
        <Text size="body-sm" tone="muted" className="max-w-reading">
          {SMALL_CHANGE_MEANS} {SMALL_CHANGE_GROWS}
        </Text>
      ) : null}
      {small ? (
        <RadioGroup
          legend="Is it a fix or an adjustment?"
          options={changeOptions}
          value={choice.change}
          onValueChange={(change) => onChange({ ...choice, change, rule: change === "fix" ? choice.rule : null })}
          error={missing === "change" ? MISSING_WORDS.change : undefined}
        />
      ) : null}
      {small && choice.change === "fix" ? (
        <RuleToFix epicId={epicId} rule={choice.rule} onRule={(rule) => onChange({ ...choice, rule })} missing={missing === "rule"} />
      ) : null}
    </div>
  );
}

function RuleToFix({ epicId, rule, onRule, missing }: { epicId: string; rule: string | null; onRule: (rule: string) => void; missing: boolean }) {
  const current = useOperation("epic.current", epicId ? { epic_id: epicId } : null);
  if (!epicId) return null;
  if (current.loading && !current.data) {
    return (
      <Text size="body-sm" tone="muted" role="status">
        Reading what has shipped in {epicId}…
      </Text>
    );
  }
  if (current.error) {
    return (
      <Text size="body-sm" tone="danger" role="alert">
        What has shipped in {epicId} could not be read: {current.error.kind === "refused" ? current.error.message : describeError(current.error).message}
      </Text>
    );
  }
  const rules = rulesToFix(current.data);
  if (!rules.length) {
    return (
      <Text size="body-sm" className="max-w-reading">
        Nothing in {epicId} has shipped yet, so there is no rule here to fix. Choose another epic, or start an adjustment.
      </Text>
    );
  }
  return (
    <Field
      label="The rule that is not holding"
      hint={`The rules that have shipped in ${epicId} and are in force today.`}
      error={missing ? MISSING_WORDS.rule : undefined}
    >
      <Select
        value={rule ?? undefined}
        onValueChange={onRule}
        placeholder="Choose the rule"
        options={rules.map((r) => ({ value: r.rule, label: r.rule, description: plain(r.text) }))}
      />
    </Field>
  );
}
