import { forwardRef, useId, useState, type ReactNode } from "react";
import { GitBranch } from "lucide-react";
import { Button, ConfirmDialog, Heading, Text, cn, toast } from "@mach/ui";
import type { SharedTextChanged } from "@mach/ui/api";
import { useEngineAct } from "../api/act";
import { IssueLink, IssueNumber } from "./IssueLink";
import { sharedTextWords, versionFields, type Take, type VersionField } from "./team";

/**
 * M20: someone else changed the project's or an epic's own text on GitHub while this person changed theirs too. Both
 * versions side by side, each whole, each with its own act under it: "Keep mine" or "Take theirs", confirmed in a dialog
 * (the same form as a slice's "Someone else saved a newer version"). The app never picks a side and never blends them.
 * When their version is not in the form MACH writes, it cannot be shown or taken: the issue is linked instead.
 * Focusable, so the project home's "Carry on" can lead here.
 */
export const SharedTextChoice = forwardRef<HTMLElement, { changed: SharedTextChanged; mine: SharedTextChanged["theirs"]; id?: string; className?: string; level?: 2 | 3 | 4 }>(function SharedTextChoice(
  { changed, mine, id, className, level = 2 },
  ref,
) {
  const headingId = useId();
  const [take, setTake] = useState<Take | null>(null);
  const act = useEngineAct();
  const words = sharedTextWords(changed);

  const choose = async () => {
    if (!take) return false;
    const result = await act.run("reconcile", { target: changed.target, take });
    if (!result) return false;
    toast({ tone: "success", title: words[take].done, description: result.note });
    return true;
  };

  return (
    <section ref={ref} id={id} tabIndex={-1} aria-labelledby={headingId} className={cn("flex scroll-mt-6 flex-col rounded-md border border-info-line bg-surface outline-offset-2", className)}>
      <div className="flex flex-col gap-1.5 rounded-t-md border-b border-info-line bg-info-soft px-5 py-4">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <GitBranch aria-hidden="true" className="mt-1 size-[18px] shrink-0 text-info-ink" />
          <Heading level={level} size="title-3" id={headingId} className="min-w-0 flex-1">
            {words.heading}
          </Heading>
          {changed.issue ? <IssueNumber number={changed.issue} url={changed.url} /> : null}
        </div>
        <Text size="body-sm" className="max-w-reading">
          {words.lead}
        </Text>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2">
        <Version caption="Yours, in this workspace" fields={versionFields(changed.kind, mine)}>
          <Button disabled={act.pending} onClick={() => setTake("mine")}>
            {words.mine.button}
          </Button>
        </Version>
        {changed.readable ? (
          <Version caption="Theirs, on GitHub" quoted fields={versionFields(changed.kind, changed.theirs)} className="border-t border-line md:border-t-0 md:border-l">
            <Button disabled={act.pending} onClick={() => setTake("theirs")}>
              {words.theirs.button}
            </Button>
          </Version>
        ) : (
          <div className="flex flex-col gap-3 border-t border-line px-5 py-4 md:border-t-0 md:border-l">
            <p className="text-label text-ink-muted">Theirs, on GitHub</p>
            <Text size="body-sm">It cannot be shown here: it is not in the form MACH writes.</Text>
            {changed.issue ? (
              <Text size="body-sm">
                Read it on GitHub, issue <IssueLink number={changed.issue} url={changed.url} />.
              </Text>
            ) : null}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={take !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTake(null);
            act.reset();
          }
        }}
        title={take ? words[take].title : ""}
        description={take ? words[take].description : ""}
        confirmLabel={take ? words[take].button : ""}
        onConfirm={choose}
        error={act.shown ? { ...act.shown, title: act.error?.kind === "refused" ? "Nothing was chosen" : act.shown.title } : null}
      />
    </section>
  );
});

/** One version, whole: each field with its label; someone else's words set as a quotation (a rule at the left). */
function Version({ caption, fields, quoted = false, className, children }: { caption: string; fields: VersionField[]; quoted?: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-4 px-5 py-4", className)}>
      <p className="text-label text-ink-muted">{caption}</p>
      <dl className={cn("flex flex-col gap-3", quoted && "border-l-2 border-line-strong pl-3")}>
        {fields.map((field) => (
          <div key={field.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-caption text-ink-muted">{field.label}</dt>
            <dd className="min-w-0 break-words text-body-sm text-ink">
              {Array.isArray(field.value) ? (
                <ul className="flex list-disc flex-col gap-0.5 pl-5">
                  {field.value.map((item, i) => (
                    <li key={`${i}-${item}`}>{item}</li>
                  ))}
                </ul>
              ) : (
                field.value
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-auto">{children}</div>
    </div>
  );
}
