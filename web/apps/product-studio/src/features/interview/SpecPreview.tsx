import { Link } from "react-router";
import { ArrowRight, CircleAlert } from "lucide-react";
import { ArtifactId, Badge, Button, ErrorState, Heading, SkeletonText, SliceStatusPill, Spinner, Tabs, TabsContent, TabsList, TabsTrigger, Text, describeError, CheckCounts, CheckPill, DiagnosticList, OpenQuestionList, diagnostics, specModel, plain } from "@mach/ui";
import type { Decision } from "./model";
import { type SliceShowState } from "../../api/useSliceShow";

const decisionLabels: Record<Decision["answer"], { label: string; tone: "success" | "info" | "warning" | "neutral" }> = {
  accepted: { label: "Accepted", tone: "success" },
  revised: { label: "Your answer", tone: "info" },
  deferred: { label: "Left open", tone: "warning" },
  delegated: { label: "Interviewer decides", tone: "neutral" },
  explain: { label: "Asked why", tone: "neutral" },
  reply: { label: "Replied", tone: "neutral" },
};

const PREVIEW_LIMIT = 6;

/**
 * Beside the conversation: the draft as the engine last checked it (validated), and the decisions
 * taken in this browser. Reloaded from `slice.show` whenever the host reports draft_changed.
 */
export function SpecPreview({ sliceId, show, decisions }: { sliceId: string; show: SliceShowState; decisions: Decision[] }) {
  return (
    <Tabs defaultValue="spec" className="flex flex-col">
      <TabsList aria-label="Beside the conversation">
        <TabsTrigger value="spec">Draft specification</TabsTrigger>
        <TabsTrigger value="decisions">
          Decisions
          {decisions.length ? <Badge>{decisions.length}</Badge> : null}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="spec">
        <DraftPanel sliceId={sliceId} show={show} />
      </TabsContent>
      <TabsContent value="decisions">
        <DecisionList decisions={decisions} />
      </TabsContent>
    </Tabs>
  );
}

function DraftPanel({ sliceId, show }: { sliceId: string; show: SliceShowState }) {
  if (!show.data && show.loading) {
    return (
      <div role="status" aria-busy="true" aria-label="Reading the draft">
        <SkeletonText lines={6} />
      </div>
    );
  }
  if (!show.data) {
    const described = show.error ? describeError(show.error) : { title: "Could not read the draft", message: "" };
    return (
      <ErrorState
        icon={<CircleAlert />}
        title={show.error?.kind === "refused" ? "Could not read the draft" : described.title}
        message={show.error?.kind === "refused" ? show.error.message : described.message}
        hint={show.error?.hint}
        action={
          <Button size="sm" onClick={show.reload}>
            Try again
          </Button>
        }
      />
    );
  }

  const data = show.data;
  const check = data.check;
  const model = specModel(data);
  const problems = diagnostics(check);
  const requirements = model?.functional_requirements ?? [];
  const openQuestions = model?.open_questions?.length ? model.open_questions : check.open_questions.map((question) => ({ question, follow_up: null }));
  const assumptions = model?.assumptions ?? [];

  return (
    <div className="flex flex-col gap-6" aria-busy={show.loading || undefined}>
      <section aria-labelledby="preview-check" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Heading level={2} size="title-3" id="preview-check">
            Engine check
          </Heading>
          <span className="flex items-center gap-1.5 text-caption text-ink-subtle" role="status">
            {show.loading ? (
              <>
                <Spinner size="sm" />
                Updating
              </>
            ) : null}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SliceStatusPill status={data.slice.status} size="sm" />
          <CheckPill check={check} status={data.slice.status} size="sm" />
        </div>
        <Text size="caption" tone="subtle">
          The conversation is the interviewer's proposal. This is what the engine checked in your draft.
        </Text>
        {check.spec ? <CheckCounts check={check} className="grid-cols-2" /> : null}
        {problems.length ? (
          <div className="flex flex-col gap-1.5">
            <DiagnosticList items={problems.slice(0, 4)} compact />
            {problems.length > 4 ? (
              <Text size="caption" tone="muted">
                And {problems.length - 4} more on the specification page.
              </Text>
            ) : null}
          </div>
        ) : null}
      </section>

      {model?.summary?.outcome ? (
        <section aria-labelledby="preview-outcome" className="flex flex-col gap-1.5">
          <Heading level={2} size="title-3" id="preview-outcome">
            Outcome
          </Heading>
          <p className="font-serif text-body-lg text-ink">{model.summary.outcome}</p>
        </section>
      ) : null}

      <section aria-labelledby="preview-reqs" className="flex flex-col gap-2">
        <Heading level={2} size="title-3" id="preview-reqs">
          What the product does
        </Heading>
        {requirements.length ? (
          <ul className="flex flex-col gap-2">
            {requirements.slice(0, PREVIEW_LIMIT).map((r) => (
              <li key={r.id} className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-2 text-body-sm">
                <span>
                  <ArtifactId>{r.id}</ArtifactId>
                </span>
                <span className="line-clamp-3 text-ink">{plain(r.text)}</span>
              </li>
            ))}
            {requirements.length > PREVIEW_LIMIT ? (
              <li className="text-caption text-ink-muted">And {requirements.length - PREVIEW_LIMIT} more.</li>
            ) : null}
          </ul>
        ) : (
          <Text size="body-sm" tone="subtle">
            Nothing written yet. The interviewer writes the specification once the questions are settled.
          </Text>
        )}
      </section>

      <section aria-labelledby="preview-open" className="flex flex-col gap-2">
        <Heading level={2} size="title-3" id="preview-open">
          Open questions
        </Heading>
        {openQuestions.length ? (
          <OpenQuestionList items={openQuestions} compact />
        ) : (
          <Text size="body-sm" tone="subtle">
            None so far.
          </Text>
        )}
      </section>

      <section aria-labelledby="preview-assumptions" className="flex flex-col gap-2">
        <Heading level={2} size="title-3" id="preview-assumptions">
          Assumptions
        </Heading>
        {assumptions.length ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink">
            {assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        ) : (
          <Text size="body-sm" tone="subtle">
            None so far.
          </Text>
        )}
      </section>

      <Button variant="link" asChild className="self-start">
        <Link to={`/slices/${sliceId}`}>
          Open the full specification
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </div>
  );
}

function DecisionList({ decisions }: { decisions: Decision[] }) {
  if (!decisions.length) {
    return (
      <Text size="body-sm" tone="subtle">
        Your answers to the interviewer's questions appear here, in the order you gave them.
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2.5">
        {decisions.map((d) => {
          const look = decisionLabels[d.answer];
          return (
            <li key={d.messageId} className="flex flex-col gap-1 rounded-md border border-line bg-surface px-3.5 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-label text-ink">
                  <span className="mr-1.5 font-mono text-mono font-normal text-ink-subtle" translate="no">
                    Q{d.number}
                  </span>
                  {d.title}
                </p>
                <Badge tone={look.tone} className="shrink-0">
                  {look.label}
                </Badge>
              </div>
              <p className="text-body-sm text-ink-muted">{d.answer === "accepted" || d.answer === "delegated" ? d.recommendation : d.text}</p>
            </li>
          );
        })}
      </ol>
      <Text size="caption" tone="subtle">
        Kept in this browser. Question numbers restart in each session. The specification is the record.
      </Text>
    </div>
  );
}
