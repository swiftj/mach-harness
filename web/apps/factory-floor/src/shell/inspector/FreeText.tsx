/**
 * Prose the observer has not checked for names, in the floor and Timeline inspectors (M6.6, I-05;
 * M6_5_SECURITY.md 6 B, rules C1 to C3). Every field the session's `display_policy.free_text` names
 * (`text/fields.ts`) is printed only through these components, which hand it to the one shared
 * `UncheckedText`: plain text, cut to the field's limit, labelled "free text, not checked for names".
 * `test/free-text-inspectors.test.mjs` fails if an anatomy prints such a field any other way.
 */
import type { LogEntry } from "../../sim";
import { describeEntry } from "../../sim";
import { containField, FREE_TEXT, kindHasFreeText, valuesAt, freeTextFieldsOf, type FreeTextKind } from "../../text/fields";
import { unchecked, type DisplayPolicy } from "../../text/unchecked";
import { UncheckedNote, UncheckedText } from "../../text/UncheckedText";
import { useDisplayPolicy } from "../displayPolicy";

export { FREE_TEXT, type FreeTextKind } from "../../text/fields";

/** The note the policy gives, or null for the shared default. */
const noteOf = (policy: DisplayPolicy) => (policy.declared ? policy.note : null);

/**
 * One prose value. `labelled`: the panel already shows `FreeTextLabel` once. `expandable={false}`
 * inside a link or button (no nested control); the full words are on the entity's own inspector.
 */
export function FreeText({ field, text, labelled = false, expandable = true, className }: { field: FreeTextKind; text: string | null | undefined; labelled?: boolean; expandable?: boolean; className?: string }) {
  const policy = useDisplayPolicy();
  const f = FREE_TEXT[field];
  const contained = containField(policy, f.kind, f.path, text);
  if (!contained) return null;
  return <UncheckedText text={contained} labelled={labelled} expandable={expandable} note={noteOf(policy)} {...(className ? { className } : {})} />;
}

/** The label once for a panel that lists several prose values (C3): "Agent labels: free text, not checked for names". */
export function FreeTextLabel({ what, className }: { what?: string; className?: string }) {
  const policy = useDisplayPolicy();
  return (
    <span className={className ?? "mt-1 block text-caption text-ink-subtle"}>
      {what ? `${what}: ` : null}
      <UncheckedNote note={noteOf(policy)} />
    </span>
  );
}

/** Characters an event's sentence keeps when it quotes prose: its longest field and room for the sentence around it. */
const SENTENCE_ROOM = 120;

/** Whether an entry's sentence (`describeEntry`) quotes a prose field: its kind has one and the event holds a value there. */
export function quotesFreeText(policy: DisplayPolicy, entry: LogEntry, words?: string): boolean {
  const kind = entry.event.type;
  if (!kindHasFreeText(policy, kind)) return false;
  // With the sentence: only when it actually carries one of those values (a sentence that counts them quotes none).
  return freeTextFieldsOf(policy).some((f) => f.kind === kind && valuesAt(entry.event, f.path).some((v) => words === undefined || words.includes(v.trim().slice(0, 24))));
}

/**
 * An event in words. A sentence that quotes prose (a finding's title, a reason, a wait) is contained
 * as a whole, at its fields' limit plus room for the sentence; any other is MACH's own words.
 */
export function EventWords({ entry, labelled = false }: { entry: LogEntry; labelled?: boolean }) {
  const policy = useDisplayPolicy();
  const words = describeEntry(entry);
  if (!quotesFreeText(policy, entry, words)) return <>{words}</>;
  const kind = entry.event.type;
  const max = Math.max(...freeTextFieldsOf(policy).filter((f) => f.kind === kind).map((f) => f.max)) + SENTENCE_ROOM;
  return <UncheckedText text={unchecked(words, `${kind} (described)`, max)} labelled={labelled} note={noteOf(policy)} />;
}

/**
 * A sentence already made from an event of `kind` (a landmark's title, a significant moment): contained
 * when that kind carries a prose field, MACH's own words otherwise. `kind` null: the simulation's own
 * storyboard words.
 */
export function KindWords({ kind, text }: { kind: string | null; text: string }) {
  const policy = useDisplayPolicy();
  if (!kind || !kindHasFreeText(policy, kind)) return <>{text}</>;
  const max = Math.max(...freeTextFieldsOf(policy).filter((f) => f.kind === kind).map((f) => f.max)) + SENTENCE_ROOM;
  return <UncheckedText text={unchecked(text, `${kind} (described)`, max)} note={noteOf(policy)} />;
}
