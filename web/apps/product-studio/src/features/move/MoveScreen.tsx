import { useRef, useState, type ReactNode } from "react";
import { CircleAlert, Download } from "lucide-react";
import {
  ArtifactId,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  ErrorState,
  Heading,
  Skeleton,
  SkeletonText,
  Text,
  describeError,
  toast,
  type Status,
} from "@mach/ui";
import {
  isMachApiError,
  MachApiError,
  projectFileLimit,
  uploadFile,
  type DownloadOffer,
  type ProjectExport,
  type ProjectImportAlready,
  type ProjectImportDone,
  type ProjectImportPlan,
  type ProjectImportSetAside,
  type ProjectImportsList,
} from "@mach/ui/api";
import { client } from "../../api/client";
import { statusSettled, useStatus } from "../../api/store";
import { useOperation } from "../../api/useOperation";
import { ContextRow, OnePane, WorkScreen } from "../../shared/layout/WorkScreen";
import { ImportReport, PlanReport } from "./Reports";
import { List } from "./List";
import { LookUp } from "./LookUp";
import { Working } from "./Working";
import {
  doneView,
  exportView,
  fileProblem,
  importView,
  isFullImport,
  offersOnlyMine,
  READY_MEANS,
  sizeText,
  unfinishedImport,
  type ExportView,
  type Unfinished,
} from "./model";

const about =
  "MACH puts the whole project in one file that names no repository and no account: the project, its epics, the slices with their specs and whys, the principles, technical needs, ideas, PRDs, designs and design mocks. You carry the file to the other repository and bring it in there. Approvals, GitHub issues and their numbers, Jira keys and requests stay here, so every slice arrives as a draft to be checked and marked ready again.";

type Shown = { title: string; message: string };

function shown(error: unknown): Shown {
  if (isMachApiError(error)) return describeError(error);
  return { title: "Something failed", message: String(error) };
}

const askAgain = (error: unknown) => isMachApiError(error) && error.hint?.kind === "choose_file_again";

/** Starts the browser's download of a file the host offers. */
function startDownload(offer: DownloadOffer) {
  const link = document.createElement("a");
  link.href = offer.url;
  link.download = offer.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * Move this project (M21 F). Three things on one page, each a section: take this project to another repository (one
 * download), bring a project in (always looked at first, then confirmed), and look up what an ID was. An import that
 * stopped part way comes first, with the two ways out. Reachable before the project is defined.
 */
export function MoveScreen() {
  const status = useStatus();
  if (!status.data && !status.error) {
    return (
      <MoveFrame>
        <div role="status" aria-busy="true" aria-label="Reading your project" className="flex flex-col gap-5">
          <Skeleton className="h-7 w-64" />
          <SkeletonText lines={3} />
          <Skeleton className="h-24 w-full" />
        </div>
      </MoveFrame>
    );
  }
  if (!status.data) {
    const { title, message } = describeError(status.error!);
    return (
      <MoveFrame>
        <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={() => void status.reload()}>Try again</Button>} />
      </MoveFrame>
    );
  }
  return <Move status={status.data} />;
}

function MoveFrame({ children }: { children: ReactNode }) {
  return (
    <WorkScreen header={<ContextRow title="Move this project" about={about} />}>
      <OnePane label="Move this project" width="reading">
        {children}
      </OnePane>
    </WorkScreen>
  );
}

/** What the "Bring a project in" section shows. */
type Bringing =
  | { step: "choose"; problem?: Shown | null; again?: boolean }
  | { step: "looking"; fileName: string }
  | { step: "plan"; plan: ProjectImportPlan }
  | { step: "already"; result: ProjectImportAlready }
  | { step: "finishing"; fileName: string | null }
  | { step: "done"; result: ProjectImportDone }
  | { step: "set-aside"; result: ProjectImportSetAside };

function Move({ status }: { status: Status }) {
  const imports = useOperation("project.imports", {});
  const list = imports.data && "imports" in imports.data ? (imports.data as ProjectImportsList) : null;
  const unfinished = unfinishedImport(status, list);
  const [bringing, setBringing] = useState<Bringing>({ step: "choose" });
  const after = () => {
    imports.reload();
  };

  return (
    <MoveFrame>
      <div className="flex flex-col gap-12 pb-8">
        {unfinished && bringing.step !== "done" ? (
          <UnfinishedImport unfinished={unfinished} onState={setBringing} onChanged={after} busy={bringing.step === "finishing"} />
        ) : null}
        <TakeElsewhere status={status} blocked={unfinished !== null} />
        <BringIn status={status} state={bringing} setState={setBringing} unfinished={unfinished} onChanged={after} />
        <LookUp list={list} listError={imports.error} onRetry={imports.reload} loading={imports.loading && !list} />
      </div>
    </MoveFrame>
  );
}

/* ── Taking the project to another repository ─────────────────────────── */

function TakeElsewhere({ status, blocked }: { status: Status; blocked: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<Shown | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [offerOnlyMine, setOfferOnlyMine] = useState(false);
  const [result, setResult] = useState<ExportView | null>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const run = async () => {
    setRunning(true);
    setProblem(null);
    try {
      const answer: ProjectExport = await client.op("project.export", onlyMine ? { only_mine: true } : {});
      const view = exportView(answer);
      setResult(view);
      if (view.download) startDownload(view.download);
      toast({ tone: "success", title: "Downloaded the project", description: view.note });
      return true;
    } catch (error) {
      const words = shown(error);
      setProblem(words);
      if (offersOnlyMine(words.message)) setOfferOnlyMine(true);
      return false;
    } finally {
      setRunning(false);
    }
  };

  return (
    <section aria-labelledby="move-take" className="flex flex-col gap-4">
      <Heading level={2} size="title-2" id="move-take">
        Take this project to another repository
      </Heading>
      <>
          <Text className="max-w-reading">
            Download the whole project as one file, then bring it in from the other repository&apos;s Product Studio. MACH reads GitHub for anything of the project this
            workspace does not have. Nothing is sent anywhere, and nothing here changes.
          </Text>
          {status.project ? null : (
            <Text size="body-sm" tone="muted" className="max-w-reading">
              This workspace has no project yet. If the project is on GitHub, MACH takes it from there.
            </Text>
          )}
          <dl className="grid max-w-reading gap-x-6 gap-y-2 text-body-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="font-semibold text-ink-muted">Goes in the file</dt>
            <dd className="text-ink">The project, its epics, the slices with their specs and whys, principles, technical needs, ideas, PRDs, designs and design mocks.</dd>
            <dt className="font-semibold text-ink-muted">Stays here</dt>
            <dd className="text-ink">Approvals, GitHub issues and their numbers, Jira keys and requests. Every slice arrives there as a draft.</dd>
          </dl>
          <div className="flex flex-col items-start gap-2">
            <Button ref={opener} variant="primary" onClick={() => setConfirming(true)} disabled={blocked}>
              <Download aria-hidden="true" />
              Download this project
            </Button>
            {blocked ? (
              <Text size="body-sm" tone="muted" className="max-w-reading">
                Not yet: bringing in another project stopped part way here. Finish it or set it aside above, then download.
              </Text>
            ) : null}
          </div>
      </>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setProblem(null);
        }}
        title="Download this project?"
        description="MACH reads GitHub for anything of the project this workspace does not have, puts the whole project in one file that names no repository and no account, and your browser downloads it. Nothing is sent anywhere, and nothing here changes."
        confirmLabel={onlyMine ? "Download without them" : "Download"}
        onConfirm={run}
        error={problem}
        focusAfter={() => document.getElementById("move-export-result") ?? opener.current}
      >
        {running ? (
          <Working
            words="Putting the project in one file"
            detail="MACH reads GitHub for what this workspace does not have. With many slices this can take a few minutes. Leave this window open."
          />
        ) : null}
        {offerOnlyMine ? (
          // The refusal names slices that are on GitHub but not in this workspace: the person may leave them out.
          <div className="pt-3">
            <Checkbox
              checked={onlyMine}
              onCheckedChange={(checked) => setOnlyMine(checked === true)}
              label="Leave out the slices that are only on GitHub"
              description="They stay on GitHub. To take them too, open each in this workspace first."
            />
          </div>
        ) : null}
      </ConfirmDialog>

      {result ? <ExportResult view={result} /> : null}
    </section>
  );
}

function ExportResult({ view }: { view: ExportView }) {
  return (
    <section
      id="move-export-result"
      tabIndex={-1}
      aria-labelledby="move-export-title"
      className="flex flex-col gap-4 rounded-md border border-line bg-surface px-6 py-5 outline-none"
    >
      <div className="flex flex-col gap-1" aria-live="polite">
        <Heading level={3} size="title-3" id="move-export-title">
          The file holds {view.holds}
        </Heading>
        <Text size="body-sm" tone="muted" className="max-w-reading">
          {view.note}
        </Text>
      </div>
      {view.download ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a
            href={view.download.url}
            download={view.download.name}
            className="inline-flex h-control-md items-center gap-2 rounded-sm border border-line-control bg-canvas px-3.5 text-body-sm font-semibold text-ink hover:bg-surface-sunken"
          >
            <Download aria-hidden="true" className="size-4" />
            Download it again
          </a>
          <Text size="body-sm" tone="muted">
            <span translate="no">{view.download.name}</span> · {sizeText(view.download.bytes)}
          </Text>
        </div>
      ) : (
        <Banner tone="warning" title="The file cannot be downloaded from here">
          {view.downloadProblem ?? "Product Studio did not offer the file. Download the project again."}
        </Banner>
      )}
      {view.githubNotRead ? (
        <Banner tone="warning" title="GitHub could not be read for this file">
          {view.githubNotRead}
        </Banner>
      ) : null}
      {view.lead ? <Text className="max-w-reading">{view.lead}</Text> : null}
      <List title="Where this workspace and GitHub differed" items={view.chosen} />
      <List title="Not in the file" items={view.notIncluded} />
      <List title="Also" items={view.rest} />
      <List title="Stays in this repository" items={view.staysBehind} />
      {view.more.map((group) => (
        <List key={group.title} title={group.title} items={group.items} />
      ))}
      <Text size="body-sm" tone="muted" className="max-w-reading">
        Carry the file to the other repository yourself. There, open Product Studio, choose “Move this project”, and bring it in.
      </Text>
    </section>
  );
}

/* ── Bringing a project in ─────────────────────────────────────────────── */

/** The hidden file input and the button that opens the chooser. */
function useFileChooser(onPicked: (file: File) => void) {
  const input = useRef<HTMLInputElement>(null);
  const element = (
    <input
      ref={input}
      type="file"
      accept={projectFileLimit.extensions.join(",")}
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) onPicked(file);
      }}
    />
  );
  return { element, open: () => input.current?.click() };
}

async function send(file: File, plan: boolean) {
  const problem = fileProblem(file);
  if (problem) throw new MachApiError("invalid", problem, "project.import");
  const upload = await uploadFile(file, projectFileLimit, "project.import");
  return client.op("project.import", plan ? { file: upload, plan: true } : { file: upload });
}

function BringIn({
  status,
  state,
  setState,
  unfinished,
  onChanged,
}: {
  status: Status;
  state: Bringing;
  setState: (next: Bringing) => void;
  unfinished: Unfinished | null;
  onChanged: () => void;
}) {
  const look = async (file: File) => {
    const problem = fileProblem(file);
    if (problem) {
      setState({ step: "choose", problem: { title: "Choose another file", message: problem } });
      return;
    }
    setState({ step: "looking", fileName: file.name });
    try {
      const answer = await send(file, true);
      if ("already" in answer && answer.already) setState({ step: "already", result: answer });
      else if (isFullImport(answer) && "plan" in answer) setState({ step: "plan", plan: answer as ProjectImportPlan });
      else setState({ step: "choose", problem: { title: "Unexpected reply", message: "MACH answered in a form this page does not know. Try again." } });
    } catch (error) {
      setState({ step: "choose", problem: shown(error) });
    }
  };
  const chooser = useFileChooser((file) => void look(file));
  const heading = (
    <Heading level={2} size="title-2" id="move-bring">
      Bring a project in
    </Heading>
  );

  let body: ReactNode;
  switch (state.step) {
    case "choose":
      body = (
        <>
          <Text className="max-w-reading">
            Choose the file MACH made when the project was downloaded in the other repository. MACH looks at it first and tells you what would come in and what changes. Nothing is brought in until you say so.
          </Text>
          {status.project ? (
            <Text size="body-sm" tone="muted" className="max-w-reading">
              This repository already has a project, “{status.project.name}”: the one you bring in joins it as more epics, with new numbers where they would clash.
            </Text>
          ) : null}
          {state.problem ? (
            <div role="alert" className="flex max-w-reading items-start gap-2 text-body-sm text-danger-ink">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <div className="flex flex-col gap-0.5">
                <p className="font-semibold">{state.problem.title}</p>
                <p className="whitespace-pre-line text-ink">{state.problem.message}</p>
              </div>
            </div>
          ) : null}
          <div>
            <Button onClick={chooser.open} disabled={unfinished !== null}>
              {state.problem ? "Choose a file again" : "Choose the file"}
            </Button>
            {unfinished ? (
              <Text size="body-sm" tone="muted" className="mt-2 max-w-reading">
                Not yet: finish bringing in the project that stopped part way, or set it aside, first.
              </Text>
            ) : null}
          </div>
        </>
      );
      break;
    case "looking":
      body = <Working words={`Looking at ${state.fileName}`} detail="MACH checks the file and counts the numbers in use here. Nothing is brought in yet." />;
      break;
    case "finishing":
      body = <Working words={`Finishing bringing in ${state.fileName ?? "the project"}`} detail="MACH repeats nothing it already brought in." />;
      break;
    case "already":
      body = (
        <Banner tone="info" title="Already brought in" actions={<Button size="sm" onClick={chooser.open}>Choose another file</Button>}>
          {state.result.note}
        </Banner>
      );
      break;
    case "plan":
      body = (
        <Plan
          status={status}
          plan={state.plan}
          onDone={(result) => {
            setState({ step: "done", result });
            onChanged();
          }}
          onAskAgain={() => setState({ step: "choose", again: true, problem: { title: "Choose the file again", message: "Product Studio no longer has that file. Choose the same file again." } })}
          onCancel={() => setState({ step: "choose" })}
        />
      );
      break;
    case "done":
      body = (
        <>
          <ImportReport view={doneView(state.result)} />
          <div>
            <Button onClick={() => setState({ step: "choose" })}>Bring in another file</Button>
          </div>
        </>
      );
      break;
    case "set-aside":
      body = (
        <>
          <SetAsideReport result={state.result} />
          <div>
            <Button onClick={() => setState({ step: "choose" })}>Choose a file to bring in</Button>
          </div>
        </>
      );
      break;
  }

  return (
    <section aria-labelledby="move-bring" className="flex flex-col gap-4">
      {heading}
      {chooser.element}
      {body}
    </section>
  );
}

function Plan({
  status,
  plan,
  onDone,
  onAskAgain,
  onCancel,
}: {
  status: Status;
  plan: ProjectImportPlan;
  onDone: (result: ProjectImportDone) => void;
  onAskAgain: () => void;
  onCancel: () => void;
}) {
  const view = importView(plan);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<Shown | null>(null);
  const [markReady, setMarkReady] = useState(false);
  // The plan says how many slices `ready` would mark ready (`ready_in_source.count`); the choice is offered only when it does.
  const offer = view.canMarkReady && view.readyThere > 0 ? view.readyThere : 0;
  const into = view.mode === "join" ? (status.project?.name ? `“${status.project.name}”` : "this project") : null;

  const run = async () => {
    setRunning(true);
    setProblem(null);
    try {
      const answer = await client.op("project.import", markReady && offer ? { kept: plan.kept.sha256, ready: true } : { kept: plan.kept.sha256 });
      await statusSettled();
      if ("imported" in answer && answer.imported) {
        toast({ tone: "success", title: `Brought in “${view.name}”` });
        onDone(answer as ProjectImportDone);
        return true;
      }
      setProblem({ title: "Not done", message: answer.note });
      return false;
    } catch (error) {
      if (askAgain(error)) {
        setConfirming(false);
        onAskAgain();
        return true;
      }
      setProblem(shown(error));
      return false;
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PlanReport view={view} resuming={plan.resuming === true} into={into} />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => setConfirming(true)}>
          Bring it in
        </Button>
        <Button onClick={onCancel}>Choose another file</Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setProblem(null);
        }}
        title={`Bring “${view.name}” into this repository?`}
        description={
          view.mode === "join"
            ? `Its epics and slices join ${into ?? "this project"}${view.renumbered.length ? ", with the new numbers listed" : ""}. Every slice arrives as a draft. Nothing is sent to GitHub${offer ? " unless you choose it below" : ""}.`
            : `It becomes the project here. Every slice arrives as a draft. Nothing is sent to GitHub${offer ? " unless you choose it below" : ""}.`
        }
        confirmLabel="Bring it in"
        onConfirm={run}
        error={problem}
        width="lg"
      >
        <div className="flex flex-col gap-3">
          {offer ? (
            <div className="rounded-md border border-line px-3 py-2.5">
              <Checkbox
                checked={markReady}
                onCheckedChange={(checked) => setMarkReady(checked === true)}
                label={`Also mark ready the ${offer === 1 ? "slice that was" : `${offer} slices that were`} ready there`}
                description={`Off unless you choose it. ${READY_MEANS} Leave it off to check each slice yourself first.`}
              />
            </div>
          ) : null}
          {running ? <Working words={`Bringing in “${view.name}”`} detail="MACH writes every file of the project into your workspace. Leave this window open." /> : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}

function SetAsideReport({ result }: { result: ProjectImportSetAside }) {
  return (
    <section aria-labelledby="move-set-aside" className="flex flex-col gap-3 rounded-md border border-line bg-surface px-6 py-5">
      <Heading level={3} size="title-3" id="move-set-aside">
        Set aside
      </Heading>
      <Text size="body-sm" className="max-w-reading">
        {result.note}
      </Text>
      {result.brought_in.length ? (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-label text-ink">Already brought in, and still here</h4>
          <ul className="flex flex-col gap-1 text-body-sm text-ink">
            {result.brought_in.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-x-2">
                {/^[A-Z]+-[0-9]+$/.test(row.id) ? <ArtifactId>{row.id}</ArtifactId> : <span>{row.id.charAt(0).toUpperCase() + row.id.slice(1)}</span>}
                {row.was && row.was !== row.id ? (
                  <span className="text-ink-muted">
                    was <ArtifactId plain>{row.was}</ArtifactId> there
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <Text size="body-sm" tone="muted" className="max-w-reading">
            Keep them, or remove the ones you do not want from the project home.
          </Text>
        </div>
      ) : null}
    </section>
  );
}

/* ── An import that stopped part way ──────────────────────────────────── */

function UnfinishedImport({
  unfinished,
  onState,
  onChanged,
  busy,
}: {
  unfinished: Unfinished;
  onState: (next: Bringing) => void;
  onChanged: () => void;
  busy: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [settingAside, setSettingAside] = useState(false);
  const [problem, setProblem] = useState<Shown | null>(null);
  const [asideProblem, setAsideProblem] = useState<Shown | null>(null);
  const name = unfinished.fileName ?? "the file";

  const finished = async (run: () => Promise<unknown>) => {
    setProblem(null);
    onState({ step: "finishing", fileName: unfinished.fileName });
    try {
      const answer = (await run()) as ProjectImportDone | ProjectImportAlready;
      await statusSettled();
      onChanged();
      if ("imported" in answer && answer.imported) {
        toast({ tone: "success", title: "Finished bringing in the project" });
        onState({ step: "done", result: answer as ProjectImportDone });
      } else {
        onState({ step: "already", result: answer as ProjectImportAlready });
      }
      setAsking(false);
    } catch (error) {
      onState({ step: "choose" });
      if (askAgain(error)) setAsking(true);
      else setProblem(shown(error));
    }
  };
  const chooser = useFileChooser((file) => void finished(() => send(file, false)));
  const finish = () => {
    if (unfinished.sha256) void finished(() => client.op("project.import", { kept: unfinished.sha256! }));
    else setAsking(true);
  };

  const setAside = async () => {
    setAsideProblem(null);
    try {
      const answer = await client.op("project.import.abandon", {});
      await statusSettled();
      onChanged();
      toast({ tone: "success", title: "Set it aside" });
      onState({ step: "set-aside", result: answer });
      return true;
    } catch (error) {
      setAsideProblem(shown(error));
      return false;
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {chooser.element}
      <Banner
        tone="warning"
        title="Bringing in a project stopped part way"
        actions={
          busy ? null : (
            <>
              <Button size="sm" variant="primary" onClick={asking ? chooser.open : finish}>
                {asking ? `Choose ${name} again` : problem ? "Bring the same file in again" : "Finish it"}
              </Button>
              <Button size="sm" onClick={() => setSettingAside(true)}>
                Set it aside
              </Button>
            </>
          )
        }
      >
        <p>{unfinished.text}</p>
        {asking ? (
          <p className="mt-1 text-ink-muted">Product Studio no longer has that file. Choose the same file again to finish: MACH repeats nothing it already brought in.</p>
        ) : null}
        {problem ? (
          <p role="alert" className="mt-1 whitespace-pre-line text-danger-ink">
            {problem.title}: {problem.message}
          </p>
        ) : null}
      </Banner>
      <ConfirmDialog
        open={settingAside}
        onOpenChange={(open) => {
          setSettingAside(open);
          if (!open) setAsideProblem(null);
        }}
        tone="danger"
        title={`Set aside bringing in ${name}?`}
        description="MACH stops bringing it in and does not finish it. What it already brought in stays where it is, and you can keep it or remove it afterwards. The numbers it was holding are freed, so you can download this project or bring in another file again. Nothing else changes."
        confirmLabel="Set it aside"
        cancelLabel="Keep it waiting"
        onConfirm={setAside}
        error={asideProblem}
      />
    </div>
  );
}
