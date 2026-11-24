/**
 * Deciding on one ticket in the Factory Floor (design M23 4.2): what happened (MACH's own sentence, and
 * the words behind it as free text), the files to read first, then MACH's options as buttons, the
 * recommended one first and marked. Choosing an option shows what it does and asks for what it needs: a
 * reason in the person's own words (never prefilled or suggested), the test command, or an answer to each
 * open question. A decision that cannot be undone (approve, merge, abandon) is confirmed in a dialog first.
 * An option that needs a conversation shows the command to run in Claude Code. The person's name is asked
 * once, kept in this browser and shown beside the decision; left empty, MACH records the name Git has.
 *
 * Every decision is recorded by MACH (run.py decide do, through the observer); this page records nothing.
 */
import { useId, useMemo, useRef, useState } from "react";
import { Badge, Banner, Button, Checkbox, CommandLine, ConfirmDialog, Field, Input, Textarea, cn } from "@mach/ui";
import { UncheckedText, UncheckedNote } from "../text/UncheckedText";
import { useDisplayPolicy } from "../shell/displayPolicy";
import { useNeeds, type Outcome } from "./context";
import { answersPayload, confirmWords, decisionBody, missingInput, type AnswerDraft, type NeedOption, type NeedTicket } from "./model";

/** What a decision made here answered, as MACH said it: the `now` sentence, a refusal, or the command a conversation needs. */
export function OutcomeLine({ outcome, ticket }: { outcome: Outcome | null | undefined; ticket: string }) {
  if (!outcome) return null;
  if (outcome.refusal) {
    return (
      <Banner tone="danger" title="Nothing was recorded" live="assertive" className="mt-3">
        <p className="whitespace-pre-line text-body-sm text-ink" data-decide-refusal="">
          {outcome.refusal}
        </p>
      </Banner>
    );
  }
  const d = outcome.decided;
  if (!d) return null;
  if (d.inConversation) {
    return (
      <div role="status" className="mt-3 rounded-md border border-line bg-surface-sunken px-3 py-2.5" data-decide-conversation="">
        {d.why ? <p className="text-body-sm text-ink">{d.why}</p> : null}
        <CommandLine className="mt-2" command={d.command ?? `/mach decide ${ticket}`} purpose={`to decide on ${ticket} in Claude Code`} />
      </div>
    );
  }
  return (
    <div role="status" className="mt-3 rounded-md border border-success-line bg-success-soft px-3 py-2.5" data-decide-now="">
      {d.now ? <p className="text-body-sm text-ink">{d.now}</p> : <p className="text-body-sm text-ink">Recorded.</p>}
      {d.note ? <p className="mt-1 text-body-sm text-ink-muted">{d.note}</p> : null}
    </div>
  );
}

function NameField() {
  const { name, setName } = useNeeds();
  return (
    <Field label="Your name" optional hint="Recorded with your decision and kept in this browser. Left empty, MACH records the name Git has for you.">
      <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" data-decide-name="" />
    </Field>
  );
}

function Answers({ ticket, drafts, onChange }: { ticket: NeedTicket; drafts: Record<number, AnswerDraft>; onChange: (n: number, d: AnswerDraft) => void }) {
  const policy = useDisplayPolicy();
  return (
    <div className="mt-3 flex flex-col gap-4" data-decide-answers="">
      <p className="text-caption text-ink-subtle">
        Questions: <UncheckedNote note={policy.declared ? policy.note : null} />
      </p>
      {ticket.questions.map((q) => {
        const d = drafts[q.n] ?? { mode: null, text: "" };
        const open = d.mode === "open";
        return (
          <fieldset key={q.n} className="flex flex-col gap-2 rounded-md border border-line px-3 py-2.5">
            <legend className="px-1 text-label text-ink">Question {q.n}</legend>
            <p className="text-body-sm text-ink">
              <UncheckedText text={q.text} labelled />
            </p>
            {q.followUp ? (
              <p className="text-body-sm text-ink-muted">
                <UncheckedText text={q.followUp} labelled />
              </p>
            ) : null}
            <Field label={`Your answer to question ${q.n}`}>
              <Textarea rows={3} value={open ? "" : d.text} disabled={open} onChange={(e) => onChange(q.n, { mode: e.target.value.trim() ? "answer" : null, text: e.target.value })} />
            </Field>
            <Checkbox label={`Leave question ${q.n} open`} checked={open} onCheckedChange={(v) => onChange(q.n, { mode: v === true ? "open" : d.text.trim() ? "answer" : null, text: d.text })} />
          </fieldset>
        );
      })}
    </div>
  );
}

/** The decision part of a ticket's panel: everything a person needs to decide here. */
export function DecidePanel({ ticket }: { ticket: NeedTicket }) {
  const needs = useNeeds();
  const policy = useDisplayPolicy();
  const [chosen, setChosen] = useState<NeedOption | null>(null);
  const [reason, setReason] = useState("");
  const [testCmd, setTestCmd] = useState("");
  const [drafts, setDrafts] = useState<Record<number, AnswerDraft>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const headingId = useId();
  const sendRef = useRef<HTMLButtonElement>(null);
  const outcome = needs.outcomes[ticket.ticketId];
  const hasData = ticket.title || ticket.reason || ticket.details.length > 0;

  const choose = (o: NeedOption) => {
    setChosen(o);
    setProblem(null);
    setDialogError(null);
  };
  const payload = useMemo(() => (chosen?.needsAnswers ? answersPayload(ticket.questions, drafts) : null), [chosen, ticket.questions, drafts]);

  const send = async (): Promise<boolean> => {
    if (!chosen) return false;
    setSending(true);
    try {
      const result = await needs.decide(ticket.ticketId, chosen.key, decisionBody(chosen, { name: needs.name, reason, testCmd, answers: payload?.answers ?? null }));
      if (result.ok) {
        setChosen(null);
        setReason("");
        setTestCmd("");
        setDrafts({});
        return true;
      }
      setDialogError(result.message);
      return false;
    } finally {
      setSending(false);
    }
  };

  const submit = () => {
    if (!chosen) return;
    const missing = missingInput(chosen, { reason, testCmd }) ?? (chosen.needsAnswers ? (payload?.problem ?? null) : null);
    setProblem(missing);
    if (missing) return;
    if (chosen.confirm) {
      setDialogError(null);
      setConfirming(true);
      return;
    }
    void send();
  };

  const confirm = chosen ? confirmWords(ticket.ticketId, chosen) : null;

  return (
    <section aria-labelledby={headingId} data-decide={ticket.ticketId}>
      <h4 id={headingId} className="mb-1.5 text-label text-ink-muted">
        What it needs from you
      </h4>
      <p className="text-body-sm text-ink" data-decide-summary="">
        {ticket.summary}
      </p>
      {hasData ? (
        <div className="mt-2 flex flex-col gap-1 border-l-2 border-line-strong pl-3">
          {ticket.title ? (
            <p className="text-body-sm text-ink">
              <UncheckedText text={ticket.title} labelled />
            </p>
          ) : null}
          {ticket.reason ? (
            <p className="text-body-sm text-ink">
              <UncheckedText text={ticket.reason} labelled />
            </p>
          ) : null}
          {ticket.details.map((t, i) => (
            <p key={i} className="text-body-sm text-ink-muted">
              <UncheckedText text={t} labelled />
            </p>
          ))}
          <p className="text-caption text-ink-subtle">
            Recorded words: <UncheckedNote note={policy.declared ? policy.note : null} />
          </p>
        </div>
      ) : null}
      {ticket.showFirst.length > 0 ? (
        <div className="mt-3">
          <p className="text-body-sm text-ink">Read these first. Open them in your editor:</p>
          <ul className="mt-1 flex flex-col gap-0.5" data-decide-read-first="">
            {ticket.showFirst.map((p) => (
              <li key={p} className="break-all font-mono text-[13px] text-ink" translate="no">
                {p}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <OutcomeLine outcome={outcome} ticket={ticket.ticketId} />

      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`What to do with ${ticket.ticketId}`}>
        {ticket.options.map((o) => (
          <Button
            key={o.key}
            size="sm"
            variant="secondary"
            className={cn(chosen?.key === o.key && "border-accent bg-accent-soft text-accent-ink ring-1 ring-accent")}
            aria-pressed={chosen?.key === o.key}
            onClick={() => choose(o)}
            data-decide-option={o.key}
            data-recommended={o.recommended ? "" : undefined}
          >
            {o.label}
            {o.recommended ? (
              <Badge tone="accent" outline className="ml-1">
                Recommended
              </Badge>
            ) : null}
          </Button>
        ))}
      </div>

      {chosen ? (
        <div className="mt-3 flex flex-col gap-3 rounded-md border border-line bg-surface-sunken px-3 py-3" data-decide-chosen={chosen.key}>
          <p className="text-body-sm text-ink">{chosen.does}</p>
          {!chosen.canDo ? (
            <>
              <p className="text-body-sm text-ink">This needs a conversation in Claude Code. Run this there:</p>
              <CommandLine command={ticket.decideCommand} purpose={`to decide on ${ticket.ticketId} in Claude Code`} />
            </>
          ) : (
            <>
              {chosen.needsReason ? (
                <Field label="Your reason, in your own words">
                  <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} data-decide-reason="" />
                </Field>
              ) : null}
              {chosen.needsTestCommand ? (
                <Field label="The command that runs the tests">
                  <Input value={testCmd} onChange={(e) => setTestCmd(e.target.value)} maxLength={1000} className="font-mono" spellCheck={false} />
                </Field>
              ) : null}
              {chosen.needsAnswers ? <Answers ticket={ticket} drafts={drafts} onChange={(n, d) => setDrafts((prev) => ({ ...prev, [n]: d }))} /> : null}
              <NameField />
              {problem ? (
                <p role="alert" className="text-body-sm text-danger-ink">
                  {problem}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button ref={sendRef} variant={chosen.key === "abandon" ? "danger" : "primary"} size="sm" loading={sending && !confirming} onClick={submit} data-decide-send="">
                  {chosen.label}: {ticket.ticketId}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setChosen(null)} disabled={sending}>
                  Not now
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {chosen && confirm ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={(open) => setConfirming(open)}
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.verb}
          cancelLabel="Not now"
          tone={confirm.tone}
          onConfirm={send}
          error={dialogError ? { title: "Nothing was recorded", message: dialogError } : null}
          focusAfter={() => document.querySelector<HTMLElement>(`[data-decide="${CSS.escape(ticket.ticketId)}"] [data-decide-option]`)}
        >
          {chosen.needsReason && reason.trim() ? (
            <p className={cn("border-l-2 border-line-strong pl-3 text-body-sm italic text-ink")}>{reason}</p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
