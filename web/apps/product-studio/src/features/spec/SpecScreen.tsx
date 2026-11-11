import { useState } from "react";
import { Link, useParams } from "react-router";
import { CircleAlert, MessagesSquare, SearchX } from "lucide-react";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, Page, Skeleton, SkeletonText, SliceLifecycle, SliceStatusPill, Tabs, TabsContent, TabsList, TabsTrigger, Text, describeError, CheckCounts, CheckPill, checkVerdict, DiagnosticList, diagnostics as listDiagnostics, specModel, whyDocument, type Diagnostic, type SpecSectionId as SectionId, plural as count } from "@mach/ui";
import { type SliceShow, ENGINE_ID as SLICE_ID } from "@mach/ui/api";
import { ApproveDialog, PauseDialog, ReopenDialog } from "./SliceActs";
import { SourceEditor } from "./SourceEditor";
import { AssumptionsSection, DecisionTableSection, DependenciesSection, OpenQuestionsSection, RequirementsSection, RulesSection, ScenariosSection, SummarySection, WhySection } from "./SpecSections";
import { sectionTitles } from "./specModel";
import { useSliceShow } from "../../api/useSliceShow";
import { useStatus } from "../../api/store";
import { WithdrawnNote } from "../../shared/WithdrawnNote";

type View = "spec" | "why" | "source";

export function SpecScreen() {
  const { sliceId = "" } = useParams();
  if (!SLICE_ID.test(sliceId)) {
    return (
      <Page width="reading">
        <EmptyState layout="page" headingLevel={1} icon={<SearchX />} title="That is not a slice" description={`"${sliceId}" is not a slice ID such as SLICE-001.`} action={<Button asChild><Link to="/">Go to the workspace</Link></Button>} />
      </Page>
    );
  }
  return <SpecWorkspace key={sliceId} sliceId={sliceId} />;
}

function SpecWorkspace({ sliceId }: { sliceId: string }) {
  const show = useSliceShow(sliceId);
  const [view, setView] = useState<View>("spec");

  if (!show.data && show.loading) return <SpecSkeleton />;
  if (!show.data) {
    const error = show.error;
    const described = error ? describeError(error) : { title: "Could not read the slice", message: "" };
    return (
      <Page width="reading">
        <h1 className="sr-only">{sliceId}</h1>
        <ErrorState
          icon={<CircleAlert />}
          title={error?.kind === "refused" ? `${sliceId} could not be shown` : described.title}
          message={error?.kind === "refused" ? error.message : described.message}
          hint={error?.hint}
          action={<Button onClick={show.reload}>Try again</Button>}
        />
      </Page>
    );
  }

  const data = show.data;
  const goTo = (section: SectionId) => {
    const target: View = section === "why" ? "why" : section === "source" ? "source" : "spec";
    setView(target);
    requestAnimationFrame(() => {
      const heading = document.getElementById(`section-${section}-title`);
      heading?.scrollIntoView({ block: "start" });
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
    });
  };

  return (
    <Page className="flex flex-col gap-8">
      <SpecHeader show={data} onChanged={show.reload} refreshing={show.loading} refreshError={show.error ? describeError(show.error).message : null} />
      <div className="grid grid-cols-[minmax(0,1fr)_17.5rem] items-start gap-10">
        <Tabs value={view} onValueChange={(value) => setView(value as View)} className="min-w-0">
          <TabsList aria-label="How to read this slice">
            <TabsTrigger value="spec">Specification</TabsTrigger>
            <TabsTrigger value="why">Why</TabsTrigger>
            <TabsTrigger value="source">Source (advanced)</TabsTrigger>
          </TabsList>
          <TabsContent value="spec">
            <SpecBody show={data} />
          </TabsContent>
          <TabsContent value="why">
            <WhySection why={whyDocument(data)} diagnostics={listDiagnostics(data.check).filter((d) => d.section === "why")} />
          </TabsContent>
          <TabsContent value="source">
            <SourceEditor
              show={data}
              why={whyDocument(data)}
              onSaved={(check) => {
                show.replaceCheck(check);
                show.reload();
              }}
            />
          </TabsContent>
        </Tabs>
        <CheckAside show={data} onGoTo={goTo} />
      </div>
    </Page>
  );
}

function SpecHeader({ show, onChanged, refreshing, refreshError }: { show: SliceShow; onChanged: () => void; refreshing: boolean; refreshError: string | null }) {
  const slice = show.slice;
  const model = specModel(show);
  const approved = slice.status === "approved_for_engineering";
  const ready = show.check.ready;
  const openCount = show.check.open_questions.length;
  const withdrawn = useStatus().data?.approvals_withdrawn?.find((w) => w.artifact === slice.slice_id);
  return (
    <header className="flex flex-col gap-5">
      <WithdrawnNote item={withdrawn} />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink-muted">
          <ArtifactId>{slice.slice_id}</ArtifactId>
          <span>
            in <ArtifactId plain>{slice.epic_id}</ArtifactId>
          </span>
          <SliceStatusPill status={slice.status} size="sm" />
          {refreshing ? <span className="text-caption text-ink-subtle">Updating…</span> : null}
        </div>
        <Heading level={1} size="display">
          {slice.title}
        </Heading>
        {model?.summary?.outcome ? (
          <Text size="body-lg" editorial tone="muted" className="max-w-reading">
            {model.summary.outcome}
          </Text>
        ) : null}
      </div>
      <SliceLifecycle status={slice.status} openQuestions={openCount} />
      <div className="flex flex-wrap items-center gap-2">
        {approved ? (
          <ReopenDialog show={show} onDone={onChanged} />
        ) : (
          <>
            {ready ? <ApproveDialog show={show} onDone={onChanged} primary /> : null}
            <Button variant={ready ? "secondary" : "primary"} asChild>
              <Link to={`/slices/${slice.slice_id}/interview`}>
                <MessagesSquare aria-hidden="true" />
                {slice.status === "draft" ? "Start the interview" : "Continue the interview"}
              </Link>
            </Button>
            {!ready ? <ApproveDialog show={show} onDone={onChanged} primary={false} /> : null}
            <PauseDialog show={show} onDone={onChanged} />
          </>
        )}
      </div>
      {approved ? (
        <Banner tone="success" title="Approved by you. This slice is read-only.">
          {show.edit_refusal ?? "To change it, reopen it first."}
        </Banner>
      ) : show.resume_note ? (
        <Banner tone="info" title="Where you stopped last time">
          {show.resume_note}
        </Banner>
      ) : null}
      {refreshError ? (
        <Banner tone="warning" title="Showing the last version read">
          {refreshError}
        </Banner>
      ) : null}
    </header>
  );
}

function SpecBody({ show }: { show: SliceShow }) {
  const model = specModel(show);
  const diags = listDiagnostics(show.check);
  const at = (section: SectionId) => diags.filter((d) => d.section === section);
  const whole = diags.filter((d) => d.section === null);
  const aboutWhole = whole.length ? (
    <section aria-label="About the whole specification" className="flex flex-col gap-2">
      <Text size="body-sm" weight="semibold">
        About the whole specification
      </Text>
      <DiagnosticList items={whole} />
    </section>
  ) : null;
  if (!model) {
    return (
      <div className="flex flex-col gap-8">
        {aboutWhole}
        <EmptyState
          icon={<MessagesSquare />}
          title="No specification yet"
          description="The interviewer writes the specification once your answers settle the slice. Continue the interview to get there."
        />
        <OpenQuestionsSection model={null} fallback={show.check.open_questions} diagnostics={at("open-questions")} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-10">
      {aboutWhole}
      <SummarySection model={model} diagnostics={at("summary")} />
      <OpenQuestionsSection model={model} fallback={show.check.open_questions} diagnostics={at("open-questions")} />
      <RulesSection model={model} diagnostics={at("rules")} />
      <RequirementsSection model={model} diagnostics={at("requirements")} />
      <DecisionTableSection model={model} diagnostics={at("decision-table")} />
      <ScenariosSection model={model} diagnostics={at("scenarios")} />
      <DependenciesSection model={model} diagnostics={at("dependencies")} dependsOn={show.slice.dependencies} />
      <AssumptionsSection model={model} diagnostics={at("assumptions")} />
    </div>
  );
}

const asideSections: SectionId[] = ["summary", "open-questions", "rules", "requirements", "decision-table", "scenarios", "dependencies", "assumptions", "why"];

function CheckAside({ show, onGoTo }: { show: SliceShow; onGoTo: (section: SectionId) => void }) {
  const check = show.check;
  const verdict = checkVerdict(check, show.slice.status);
  const diags = listDiagnostics(check);
  const bySection = new Map<SectionId, Diagnostic[]>();
  diags.forEach((d) => {
    if (d.section) bySection.set(d.section, [...(bySection.get(d.section) ?? []), d]);
  });
  return (
    <aside aria-labelledby="check-title" className="sticky top-6 flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-md border border-line bg-surface px-4 py-4">
        <Heading level={2} size="title-3" id="check-title">
          Engine check
        </Heading>
        <span className="self-start">
          <CheckPill check={check} status={show.slice.status} />
        </span>
        <Text size="body-sm" tone="muted">
          {verdict.detail}
        </Text>
        <CheckCounts check={check} className="grid-cols-2" />
        {check.risk ? (
          <Text size="caption" tone="subtle">
            Risk: <span className="font-semibold text-ink-muted">{check.risk}</span>
          </Text>
        ) : null}
      </section>
      <nav aria-label="Sections of this slice" className="flex flex-col gap-1">
        <p className="px-2 pb-1 text-label text-ink-muted">On this page</p>
        <ul className="flex flex-col">
          {asideSections.map((section) => {
            const found = bySection.get(section) ?? [];
            const open = section === "open-questions" ? check.open_questions.length : 0;
            const issue = found.length || open;
            return (
              <li key={section}>
                <button
                  type="button"
                  onClick={() => onGoTo(section)}
                  className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-body-sm text-ink hover:bg-surface-sunken"
                >
                  <span className="min-w-0 truncate">{sectionTitles[section]}</span>
                  {issue ? (
                    <span className={found.some((d) => d.severity === "error" || d.severity === "why") ? "text-caption font-semibold text-danger-ink" : "text-caption font-semibold text-warning-ink"}>
                      {found.length ? count(found.length, "problem") : count(open, "open", "open")}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

function SpecSkeleton() {
  return (
    <Page>
      <div role="status" aria-busy="true" aria-label="Reading the slice" className="flex flex-col gap-6">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-11 w-2/3" />
        <Skeleton className="h-6 w-full max-w-xl" />
        <div className="grid grid-cols-[minmax(0,1fr)_17.5rem] gap-10">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-10 w-80" />
            <SkeletonText lines={6} />
          </div>
          <Skeleton className="h-64" />
        </div>
      </div>
    </Page>
  );
}
