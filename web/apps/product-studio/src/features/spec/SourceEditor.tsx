import { useId, useState } from "react";
import { Banner, Button, ErrorState, Field, Tabs, TabsContent, TabsList, TabsTrigger, Text, Textarea, describeError, toast, checkVerdict } from "@mach/ui";
import { type MachApiError, type SliceCheck, type SliceShow, type WhyDocument } from "@mach/ui/api";
import { client as studioClient } from "../../api/client";
import { toApiError } from "../../api/session";

type Kind = "spec" | "intent";

/**
 * The advanced view: the draft's Markdown, editable while the engine says the slice is editable.
 * A save is followed by the engine's check, which is shown as the result.
 */
export function SourceEditor({ show, why, onSaved }: { show: SliceShow; why: WhyDocument | null; onSaved: (check: SliceCheck) => void }) {
  const [kind, setKind] = useState<Kind>("spec");
  const sources: Record<Kind, string | null> = {
    spec: show.spec?.markdown ?? null,
    intent: why?.exists ? (why.markdown ?? "") : null,
  };
  return (
    <div className="flex flex-col gap-4">
      <Text size="body-sm" tone="muted" className="max-w-reading">
        The specification as the engine reads it. Change it here only if you are comfortable with its format; the interviewer can make the same
        change for you. Saving runs the engine's check again.
      </Text>
      {!show.editable ? (
        <Banner tone="info" title="Read-only">
          {show.edit_refusal ?? "This slice cannot be edited."}
        </Banner>
      ) : null}
      <Tabs value={kind} onValueChange={(value) => setKind(value as Kind)}>
        <TabsList aria-label="Which document">
          <TabsTrigger value="spec">Specification</TabsTrigger>
          <TabsTrigger value="intent">Why</TabsTrigger>
        </TabsList>
        {(["spec", "intent"] as const).map((k) => (
          <TabsContent key={k} value={k}>
            <Editor kind={k} sliceId={show.slice.slice_id} original={sources[k]} editable={show.editable} onSaved={onSaved} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function Editor({ kind, sliceId, original, editable, onSaved }: { kind: Kind; sliceId: string; original: string | null; editable: boolean; onSaved: (check: SliceCheck) => void }) {
  const [text, setText] = useState(original ?? "");
  const [base, setBase] = useState(original);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MachApiError | null>(null);
  const [result, setResult] = useState<SliceCheck | null>(null);
  const hintId = useId();

  // A newer version arrived (a save, the interviewer's write): show it.
  if (base !== original) {
    setBase(original);
    setText(original ?? "");
  }

  if (original === null) {
    return (
      <Text tone="muted">
        {kind === "spec" ? "There is no specification yet. The interviewer writes it once the questions are settled." : "The slice's why has not been written yet."}
      </Text>
    );
  }

  const changed = text !== original;
  const save = () => {
    setSaving(true);
    setError(null);
    setResult(null);
    studioClient.writeDraft(kind, sliceId, text).then(
      (written) => {
        setSaving(false);
        setResult(written.check);
        onSaved(written.check);
        toast({ tone: "success", title: kind === "spec" ? `Saved the specification of ${sliceId}` : `Saved the why of ${sliceId}` });
      },
      (cause: unknown) => {
        setSaving(false);
        setError(toApiError(cause, `drafts.${kind}`));
      },
    );
  };

  const verdict = result ? checkVerdict(result) : null;
  return (
    <div className="flex flex-col gap-3">
      <Field label={kind === "spec" ? "Specification (Markdown)" : "Why (Markdown)"} hint={editable ? "Saved to your draft only." : undefined}>
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          readOnly={!editable}
          rows={22}
          spellCheck={kind === "intent"}
          aria-describedby={hintId}
          className="font-mono text-mono leading-6"
        />
      </Field>
      <span id={hintId} className="sr-only">
        {editable ? "Editable. Save to run the engine's check." : "Read-only."}
      </span>
      {error ? (
        <ErrorState
          title={error.kind === "refused" ? "Not saved" : describeError(error).title}
          message={error.kind === "refused" ? error.message : describeError(error).message}
          hint={error.hint}
        />
      ) : null}
      {verdict && result ? (
        <Banner tone={verdict.tone === "danger" ? "danger" : verdict.tone === "warning" ? "warning" : "success"} title={`Saved. ${verdict.label}.`} live="polite">
          {result.errors.length ? (
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5">
              {result.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : (
            verdict.detail
          )}
        </Banner>
      ) : null}
      {editable ? (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={!changed || saving} onClick={() => setText(original)}>
            Discard changes
          </Button>
          <Button variant="primary" disabled={!changed} loading={saving} onClick={save}>
            Save and check
          </Button>
        </div>
      ) : null}
    </div>
  );
}
