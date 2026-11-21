import { Link } from "react-router";
import { CircleAlert, CircleCheck, CircleDashed, CircleHelp, MessagesSquare, TriangleAlert } from "lucide-react";
import { ArtifactId, Button, Heading, Quote, StatusPill, Text } from "@mach/ui";
import type { CaseShow, ShapeFinding } from "@mach/ui/api";
import { ideaPath } from "../shell/steps";
import { caseCheckState, questionCounts, questionViews, type QuestionView } from "./model";

/** Where the case is written, and the way back to it. The case is never edited on this page. */
export function WrittenInExplore({ ideaId }: { ideaId: string }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-md bg-surface-sunken px-4 py-3">
      <Text size="body-sm" tone="muted">
        The case is written in the conversation on the Explore step, not edited here. To change a sentence or answer a question, go back to the conversation.
      </Text>
      <Button asChild size="sm">
        <Link to={ideaPath(ideaId, "explore")}>
          <MessagesSquare aria-hidden="true" />
          Go to Explore
        </Link>
      </Button>
    </div>
  );
}

/** No case yet: the engine's own words, and the way to write one. Shown as the body of the case part. */
export function NoCase({ ideaId, message }: { ideaId: string; message: string | null }) {
  return (
    <div className="flex max-w-reading flex-col gap-3 rounded-md border border-dashed border-line-strong bg-surface px-6 py-5">
      <Text tone="muted">
        {message ?? `${ideaId} has no case yet.`} The case is a few sentences as the customer would hear it, and the hardest questions with your answers. You write it in the conversation on the Explore step. You can still record a verdict.
      </Text>
      <div>
        <Button asChild>
          <Link to={ideaPath(ideaId, "explore")}>
            <MessagesSquare aria-hidden="true" />
            Write the case in Explore
          </Link>
        </Button>
      </div>
    </div>
  );
}

/** The case check's result as its pill: its word and a shape, never colour alone. */
export function CaseCheckPill({ shown }: { shown: CaseShow }) {
  const check = caseCheckState(shown);
  return (
    <StatusPill tone={check.tone} icon={check.glyph === "check" ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />} className={check.glyph === "alert" ? "border-2" : undefined}>
      {check.word}
    </StatusPill>
  );
}

/** The body of the case part: the case as the customer would hear it, then every hard question with its answer. */
export function CaseSection({ shown }: { shown: CaseShow }) {
  const model = shown.model;
  const questions = questionViews(model);
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="case-customer" className="flex flex-col gap-3">
        <Heading level={3} size="title-3" id="case-customer">
          As the customer would hear it
        </Heading>
        {model.customer ? (
          <Quote from="The product manager" kind="wrote this in the case" className="max-w-reading">
            {model.customer}
          </Quote>
        ) : (
          <Text tone="muted">Not written yet.</Text>
        )}
      </section>

      <section aria-labelledby="case-questions" className="flex flex-col gap-2">
        <Heading level={3} size="title-3" id="case-questions">
          The hard questions
        </Heading>
        <Text size="body-sm" tone="muted">
          {questions.length === 0 ? "No questions are written in the case." : questionCounts(model)}
        </Text>
        {questions.length > 0 ? (
          <ol className="flex max-w-reading flex-col border-t border-line">
            {questions.map((q) => (
              <Question key={q.id} q={q} />
            ))}
          </ol>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Beside the parts: the case's check, its findings in the engine's words, and the questions still without an answer,
 * so they stay in view while the person records the verdict. Then the way back to Explore, where the case is written.
 */
export function CaseCheck({ ideaId, shown }: { ideaId: string; shown: CaseShow }) {
  const model = shown.model;
  const errors = shown.findings.filter((f) => f.severity === "error");
  const warnings = shown.findings.filter((f) => f.severity === "warning");
  const unanswered = questionViews(model).filter((q) => q.state !== "answered");
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="case-check-h" className="flex flex-col gap-3">
        <Heading level={2} size="title-3" id="case-check-h">
          The case&apos;s check
        </Heading>
        <div>
          <CaseCheckPill shown={shown} />
        </div>
        {errors.length > 0 || warnings.length > 0 ? <Findings errors={errors} warnings={warnings} /> : null}
      </section>

      <section aria-labelledby="case-unanswered-h" className="flex flex-col gap-2">
        <Heading level={2} size="title-3" id="case-unanswered-h">
          Without an answer
        </Heading>
        {unanswered.length === 0 ? (
          <Text size="body-sm" tone="muted">
            {model.questions.length === 0 ? "No questions are written in the case." : "Every question in the case has an answer."}
          </Text>
        ) : (
          <ul className="flex flex-col border-t border-line">
            {unanswered.map((q) => (
              <li key={q.id} className="flex flex-col gap-1.5 border-b border-line py-3">
                <p className="flex items-baseline gap-2 text-body-sm">
                  <ArtifactId plain className="shrink-0 text-ink-muted">
                    {q.id}
                  </ArtifactId>
                  <span className="whitespace-pre-wrap font-semibold text-ink">{q.question}</span>
                </p>
                <AnswerState q={q} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <WrittenInExplore ideaId={ideaId} />
    </div>
  );
}

function Question({ q }: { q: QuestionView }) {
  return (
    <li className="flex flex-col gap-2 border-b border-line py-4">
      <p className="flex items-baseline gap-3">
        <ArtifactId plain className="shrink-0 text-ink-muted">
          {q.id}
        </ArtifactId>
        <span className="whitespace-pre-wrap text-body font-semibold text-ink">{q.question}</span>
      </p>
      <div className="flex flex-col gap-1.5 pl-12">
        {q.state === "answered" ? (
          <>
            <span className="text-caption text-ink-muted">Your answer</span>
            <p className="whitespace-pre-wrap text-body text-ink">{q.answer}</p>
          </>
        ) : (
          <AnswerState q={q} />
        )}
      </div>
    </li>
  );
}

/** A question without an answer: left on purpose (with the reason when one was written), or not answered yet. */
function AnswerState({ q }: { q: QuestionView }) {
  if (q.state === "left")
    return (
      <>
        <StatusPill size="sm" icon={<CircleDashed aria-hidden="true" />} className="self-start border-dashed">
          Not answered
        </StatusPill>
        <p className="text-body-sm text-ink-muted">
          {q.leftBecause ? (
            <>
              Left on purpose: <span className="whitespace-pre-wrap text-ink">{q.leftBecause}</span>
            </>
          ) : (
            "Left on purpose, with no reason written."
          )}
        </p>
      </>
    );
  return (
    <StatusPill size="sm" tone="warning" icon={<CircleHelp aria-hidden="true" />} className="self-start">
      No answer yet
    </StatusPill>
  );
}

/** The case check's findings, each in the engine's own words with its line. Errors stop it passing; warnings never do. */
function Findings({ errors, warnings }: { errors: ShapeFinding[]; warnings: ShapeFinding[] }) {
  return (
    <div className="flex flex-col gap-3">
      {errors.length > 0 ? <FindingList title="What stops the case passing its check" findings={errors} tone="error" /> : null}
      {warnings.length > 0 ? <FindingList title="Worth a look (these do not stop it passing)" findings={warnings} tone="warning" /> : null}
    </div>
  );
}

function FindingList({ title, findings, tone }: { title: string; findings: ShapeFinding[]; tone: "error" | "warning" }) {
  const Icon = tone === "error" ? CircleAlert : TriangleAlert;
  return (
    <div className={tone === "error" ? "rounded-md border-2 border-danger-line bg-danger-soft px-4 py-3" : "rounded-md border border-warning-line bg-warning-soft px-4 py-3"}>
      <p className={tone === "error" ? "text-label text-danger-ink" : "text-label text-warning-ink"}>{title}</p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {findings.map((f, index) => (
          <li key={`${f.rule}-${f.line}-${index}`} className="flex items-start gap-2 text-body-sm text-ink">
            <Icon aria-hidden="true" className={tone === "error" ? "mt-0.5 size-4 shrink-0 text-danger-ink" : "mt-0.5 size-4 shrink-0 text-warning-ink"} />
            <span>
              {f.line > 0 ? <span className="text-ink-muted tabular">Line {f.line}: </span> : null}
              {f.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
