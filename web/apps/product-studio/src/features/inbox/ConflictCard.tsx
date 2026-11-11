import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArtifactId, Button, ConfirmDialog, Heading, SourceBadge, Text, isFieldConflict, isTextConflict, toast, type ConflictDetail, type Status, type TextChangeSummary, IdText } from "@mach/ui";
import { asApiError, deliveryOp } from "../waves/delivery/ops";
import { rememberWithdrawn } from "../waves/delivery/memory";
import { Affects } from "./Affects";
import { failureText } from "@mach/ui/api";
import { artifactFromPath, fieldLabel, titleFor, valueLines, type ArtifactRef } from "../../api/describe";

type Take = "mine" | "theirs";

interface Choice {
  take: Take;
  /** One field, or null for the whole item. */
  field: string | null;
}

/** "Epic EPIC-001", "Specification for SLICE-001", "The project". */
export function ArtifactName({ artifact, status }: { artifact: ArtifactRef; status: Status | null }) {
  const title = titleFor(status, artifact.id);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{artifact.noun}</span>
      {artifact.id ? <ArtifactId className="text-body text-ink">{artifact.id}</ArtifactId> : null}
      {title && artifact.id ? <span className="font-normal text-ink-muted">{title}</span> : null}
    </span>
  );
}

function isApproved(status: Status, artifact: ArtifactRef): boolean {
  if (!artifact.id) return false;
  if (artifact.id.startsWith("SLICE-")) return status.slices.some((s) => s.slice_id === artifact.id && s.status === "approved_for_engineering");
  if (artifact.id.startsWith("WAVE-")) return status.waves.some((w) => w.wave_id === artifact.id && w.status === "approved_for_engineering");
  return false;
}

function Values({ field, value }: { field: string; value: unknown }) {
  const { lines, empty } = valueLines(field, value);
  if (lines.length === 1) return <p className={empty ? "text-body text-ink-subtle" : "whitespace-pre-line break-words text-body text-ink"}>{lines[0]}</p>;
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-ink">
      {lines.map((line, i) => (
        <li key={i} className="break-words">
          {line}
        </li>
      ))}
    </ul>
  );
}

function Changes({ summary }: { summary: TextChangeSummary | undefined }) {
  if (!summary) return <Text size="body-sm" tone="subtle">Not reported.</Text>;
  const groups: Array<[string, string[]]> = [
    ["Added", summary.added],
    ["Removed", summary.removed],
    ["Changed", summary.changed],
  ];
  const any = groups.some(([, items]) => items.length);
  if (!any) return <Text size="body-sm" tone="subtle">No change reported.</Text>;
  return (
    <dl className="flex flex-col gap-2">
      {groups
        .filter(([, items]) => items.length)
        .map(([label, items]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <dt className="text-caption font-semibold text-ink-muted">{label}</dt>
            <dd>
              <ul className="flex flex-col gap-0.5 text-body text-ink">
                {items.map((item) => (
                  <li key={item}>
                    <IdText text={item.replace(/^./, (c) => c.toUpperCase())} />
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
    </dl>
  );
}

function Side({ label, children, footer }: { label: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-canvas px-4 py-3">
      <p className="text-caption font-semibold text-ink-muted">{label}</p>
      <div className="min-w-0 flex-1">{children}</div>
      <div>{footer}</div>
    </div>
  );
}

export interface ConflictCardProps {
  path: string;
  detail: ConflictDetail | undefined;
  status: Status;
  onSettled: () => void;
}

/**
 * One item changed both in the PM's draft and in the shared project. A project, epic, slice or wave
 * is settled field by field; a specification or a why is settled whole, because product text is
 * never blended. Every choice is confirmed and the confirmation states its consequence.
 */
export function ConflictCard({ path, detail, status, onSettled }: ConflictCardProps) {
  const artifact = artifactFromPath(path);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const headingId = `conflict-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;
  const approved = isApproved(status, artifact);
  const textual = artifact.kind === "spec" || artifact.kind === "why";
  const fields = detail && isFieldConflict(detail) ? detail.fields : null;
  const text = detail && isTextConflict(detail) ? detail : null;
  const subject = artifact.id ?? "the project";
  const id = <span translate="no" className="whitespace-nowrap">{subject}</span>;
  const about =
    artifact.kind === "spec" ? <>the specification for {id}</> : artifact.kind === "why" ? <>the why for {id}</> : id;

  const describe = (c: Choice): { title: ReactNode; description: string; consequence: ReactNode; confirm: string; done: string } => {
    const fieldName = c.field ? fieldLabel(c.field).toLowerCase() : null;
    const fieldValues = c.field && fields ? fields[c.field] : null;
    const show = (value: unknown) => {
      const { lines } = valueLines(c.field ?? "", value);
      return lines.join("; ");
    };
    const what = fieldName ? `the ${fieldName}` : textual ? "this text" : "every field";
    const withdraw =
      c.take === "theirs" && approved ? (
        <p className="mt-2 font-semibold text-warning-ink">
          {textual
            ? `This withdraws your approval of ${artifact.id}. You will need to approve it again.`
            : `If this changes what you approved, your approval of ${artifact.id} is withdrawn and you will need to approve it again.`}
        </p>
      ) : null;
    if (c.take === "mine") {
      return {
        title: fieldName ? <>Keep your {fieldName} for {id}?</> : <>Keep your version of {about}?</>,
        description: `Your draft keeps ${what}${fieldValues ? `: “${show(fieldValues.mine)}”` : ""}. The shared project's version is set aside for this item.`,
        consequence: (
          <p>
            Nothing changes in the shared project now. When you next send a wave that includes {subject}, your version goes to engineering for review,
            and other product managers will see it there.
          </p>
        ),
        confirm: fieldName ? `Keep my ${fieldName}` : "Keep my version",
        done: fieldName ? `Kept your ${fieldName} for ${subject}` : `Kept your version of ${subject}`,
      };
    }
    return {
      title: fieldName ? <>Use the shared project's {fieldName} for {id}?</> : <>Use the shared project's version of {about}?</>,
      description: `Your draft takes ${what} from the shared project${fieldValues ? `: “${show(fieldValues.theirs)}”` : ""}. Your own version is replaced.`,
      consequence: (
        <>
          <p>Your version can't be brought back from Product Studio afterwards.{textual ? " If you want parts of both, take one and then revise it." : ""}</p>
          {withdraw}
        </>
      ),
      confirm: fieldName ? `Use the shared ${fieldName}` : "Use the shared version",
      done: fieldName ? `Took the shared ${fieldName} for ${subject}` : `Took the shared version of ${subject}`,
    };
  };

  const words = choice ? describe(choice) : null;

  const settle = async () => {
    if (!choice || !words) return false;
    setError(null);
    try {
      const result = await deliveryOp("reconcile", { artifact: path, take: choice.take, ...(choice.field ? { field: choice.field } : {}) });
      toast({ tone: "success", title: words.done });
      if (result.approvals_withdrawn.length) {
        rememberWithdrawn(result.approvals_withdrawn, `You took the shared project's version of ${subject}, which replaced what you had approved.`);
        toast({ tone: "info", title: `Approval withdrawn: ${result.approvals_withdrawn.join(", ")}`, description: "Approve again when you are ready." });
      }
      onSettled();
      return true;
    } catch (cause) {
      setError(failureText(asApiError(cause, "reconcile"), "Nothing was changed"));
      return false;
    }
  };

  const open = (c: Choice) => {
    setError(null);
    setChoice(c);
  };

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-4 rounded-md border border-line bg-surface px-5 py-4">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Heading level={3} id={headingId} size="title-3">
            <ArtifactName artifact={artifact} status={status} />
          </Heading>
          <SourceBadge source="conflict" />
        </div>
        <Text size="body-sm" tone="muted">
          {textual
            ? "Changed both in your draft and in the shared project. Product text is never blended: choose which version stands."
            : `Changed both in your draft and in the shared project. Decide each ${fields && Object.keys(fields).length > 1 ? "difference" : "one"} on its own.`}
        </Text>
        <Affects status={status} id={artifact.owner} />
      </header>

      {fields ? (
        <div className="flex flex-col gap-4">
          {Object.entries(fields).map(([field, values]) => (
            <fieldset key={field} className="flex flex-col gap-2">
              <legend className="mb-2 text-label text-ink">{fieldLabel(field)}</legend>
              <div className="grid grid-cols-2 gap-3">
                <Side
                  label="Your draft"
                  footer={
                    <Button size="sm" onClick={() => open({ take: "mine", field })}>
                      Keep mine<span className="sr-only">: {fieldLabel(field)}</span>
                    </Button>
                  }
                >
                  <Values field={field} value={values.mine} />
                </Side>
                <Side
                  label="The shared project"
                  footer={
                    <Button size="sm" onClick={() => open({ take: "theirs", field })}>
                      Use the shared one<span className="sr-only">: {fieldLabel(field)}</span>
                    </Button>
                  }
                >
                  <Values field={field} value={values.theirs} />
                </Side>
              </div>
            </fieldset>
          ))}
          {Object.keys(fields).length > 1 ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <Text as="span" size="body-sm" tone="muted" className="mr-1">
                Or settle every difference the same way:
              </Text>
              <Button size="sm" onClick={() => open({ take: "mine", field: null })}>
                Keep all of mine
              </Button>
              <Button size="sm" onClick={() => open({ take: "theirs", field: null })}>
                Use all of the shared version
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {text ? (
            <div className="grid grid-cols-2 gap-3">
              <Side label="What you changed" footer={<Button size="sm" onClick={() => open({ take: "mine", field: null })}>Keep my version</Button>}>
                <Changes summary={text.mine} />
              </Side>
              <Side
                label="What the shared project changed"
                footer={<Button size="sm" onClick={() => open({ take: "theirs", field: null })}>Use the shared version</Button>}
              >
                <Changes summary={text.theirs} />
              </Side>
            </div>
          ) : (
            <>
              <Text size="body-sm">This item could not be compared in detail. You can still choose which version stands.</Text>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => open({ take: "mine", field: null })}>
                  Keep my version
                </Button>
                <Button size="sm" onClick={() => open({ take: "theirs", field: null })}>
                  Use the shared version
                </Button>
              </div>
            </>
          )}
          {artifact.kind === "spec" && artifact.id ? (
            <Link to={`/slices/${artifact.id}`} className="w-fit text-body-sm font-semibold text-accent-ink underline underline-offset-2">
              Read your specification for {artifact.id}
            </Link>
          ) : null}
        </div>
      )}

      {words ? (
        <ConfirmDialog
          open={choice !== null}
          onOpenChange={(next) => (next ? undefined : setChoice(null))}
          title={words.title}
          description={words.description}
          confirmLabel={words.confirm}
          onConfirm={settle}
          error={error}
        >
          <div className="text-body-sm text-ink">{words.consequence}</div>
        </ConfirmDialog>
      ) : null}
    </article>
  );
}
