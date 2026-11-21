import { useRef, useState, type ChangeEvent } from "react";
import { Link } from "react-router";
import { CircleAlert, FileText, FileUp } from "lucide-react";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, LoadingState, Text, describeError, toast } from "@mach/ui";
import { isMachApiError, uploadFile, uploadLimits, type DesignImport, type DesignSummary } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { ContextRow, OnePane, WorkScreen } from "../../../shared/layout/WorkScreen";
import { limitWords } from "../../prd/model";
import { DESIGNS_LABEL, designPath } from "../shell/paths";
import { useDesignList } from "../shell/useNeeds";
import { designFacts, listLine } from "./model";
import { DesignDataNotice, StagePill, WRITING_NOTE_ID, WritingNotice } from "./parts";
import { useNeedsWriting } from "./useNeedsWriting";

const about =
  "Bring in a design document your team already wrote. MACH reads it in the conversation on Technical needs and says, for each topic the engineers must decide, what the document decides and the lines it cites. You settle only the places where it contradicts what you already said, then publish it so the engineers' decisions can start from it.";

/**
 * A design you already have (M17 part D): the designs brought in, each with where it stands, and bringing one in
 * (`design.list`, `design.import` with the foundation's upload). One pane, as the PRD list is. No act on an engineer's
 * decision is shown or offered.
 */
export function DesignListScreen() {
  const list = useDesignList();
  const writing = useNeedsWriting(list.reload);
  const designs = list.data?.designs ?? null;

  return (
    <WorkScreen header={<ContextRow title={DESIGNS_LABEL} about={about} />}>
      <OnePane label="Your designs and bringing one in" width="reading">
        <div className="flex flex-col gap-8">
          {writing ? <WritingNotice /> : null}
          <ImportPanel onImported={list.reload} first={designs !== null && designs.length === 0} writing={writing} />
          <section aria-labelledby="designs-heading" className="flex max-w-reading flex-col gap-4">
            <Heading level={2} id="designs-heading">
              Your designs
            </Heading>
            {designs === null && list.loading ? <LoadingState label="Reading the designs you brought in" /> : null}
            {designs === null && list.error ? (
              <ErrorState
                icon={<CircleAlert />}
                title={describeError(list.error).title}
                message={describeError(list.error).message}
                action={<Button onClick={list.reload}>Try again</Button>}
              />
            ) : null}
            {designs && designs.length === 0 ? (
              <EmptyState
                icon={<FileText />}
                headingLevel={3}
                title="No design brought in yet"
                description="Bringing in a design copies one document into your workspace, where MACH reads it as information and never follows what it says. It decides nothing by itself: the engineers still make each decision, and you settle only where it contradicts what you already said."
              />
            ) : null}
            {designs && designs.length > 0 ? (
              <ul aria-label="Designs brought in" className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
                {designs.map((design) => (
                  <DesignRow key={design.design_id} design={design} />
                ))}
              </ul>
            ) : null}
          </section>
          <DesignDataNotice />
        </div>
      </OnePane>
    </WorkScreen>
  );
}

function DesignRow({ design }: { design: DesignSummary }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-5 py-4">
      <div className="flex min-w-0 flex-1 basis-72 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link to={designPath(design.design_id)} className="text-body font-semibold text-ink underline-offset-2 hover:underline">
            {design.name ?? design.design_id}
          </Link>
          <ArtifactId>{design.design_id}</ArtifactId>
        </div>
        <p className="text-body-sm text-ink-muted">{designFacts(design)}</p>
        <p className={design.document_matches ? "text-body-sm text-ink" : "text-body-sm text-danger-ink"}>{listLine(design)}</p>
      </div>
      <StagePill design={design} size="sm" />
    </li>
  );
}

/**
 * Bringing a file in: the product manager picks one Markdown or plain-text file. The app checks the kind and size the
 * host would refuse (the foundation's upload, `uploadLimits.design`); the engine judges the content and answers in its
 * own words.
 */
function ImportPanel({ onImported, first, writing }: { onImported: () => void; first: boolean; writing: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const act = useEngineAct();
  const [picking, setPicking] = useState(false);
  const [tooEarly, setTooEarly] = useState<string | null>(null);
  const [result, setResult] = useState<DesignImport | null>(null);
  const limit = uploadLimits.design;

  const choose = () => {
    setTooEarly(null);
    act.reset();
    input.current?.click();
  };

  const picked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPicking(true);
    setResult(null);
    try {
      const upload = await uploadFile(file, limit, "design.import");
      const imported = await act.run("design.import", { file: upload });
      if (imported) {
        setResult(imported);
        toast({ tone: "success", title: imported.imported ? `Brought in ${imported.design.design_id}` : `${imported.design.design_id} was already brought in` });
        onImported();
      }
    } catch (error) {
      setTooEarly(isMachApiError(error) ? error.message : String(error));
    } finally {
      setPicking(false);
    }
  };

  const busy = picking || act.pending;
  return (
    <section aria-labelledby="import-heading" className="flex max-w-reading flex-col gap-4 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex flex-col gap-1">
        <Heading level={2} id="import-heading" size="title-3">
          {first ? "Bring in your design" : "Bring in a design"}
        </Heading>
        <Text size="body-sm" tone="muted">
          {limitWords(limit)} Export Word, PDF or a wiki page to Markdown or text first. A revised document becomes a new design; the same document twice is the same
          design.
        </Text>
      </div>
      <div>
        <input ref={input} type="file" accept={limit.extensions.join(",")} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void picked(e)} />
        <Button variant="primary" onClick={choose} loading={busy} disabled={writing} aria-describedby={writing ? WRITING_NOTE_ID : undefined}>
          <FileUp aria-hidden="true" />
          Choose a file to bring in
        </Button>
      </div>
      {tooEarly ? (
        <div role="alert" className="flex items-start gap-2 text-body-sm text-danger-ink">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>{tooEarly} Nothing was brought in.</p>
        </div>
      ) : null}
      {act.shown ? (
        <ErrorState icon={<CircleAlert />} title={act.error?.kind === "refused" ? "Not brought in" : act.shown.title} message={act.shown.message} hint={act.shown.hint} />
      ) : null}
      {result ? <Imported result={result} /> : null}
    </section>
  );
}

/** What bringing it in made: the design, its sections, and the way on. */
function Imported({ result }: { result: DesignImport }) {
  const design = result.design;
  return (
    <div role="status" className="flex flex-col gap-3 border-t border-line pt-4">
      <Banner tone={result.imported ? "success" : "info"} title={result.imported ? `Brought in as ${design.design_id}` : `Already brought in as ${design.design_id}`}>
        {result.note}
      </Banner>
      <p className="text-body-sm text-ink-muted">{designFacts(design)}.</p>
      <div>
        <Button asChild variant="secondary">
          <Link to={designPath(design.design_id)}>Open {design.design_id}</Link>
        </Button>
      </div>
    </div>
  );
}
