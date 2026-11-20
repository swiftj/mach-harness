import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CircleCheck, FileSearch, Upload } from "lucide-react";
import { ArtifactId, Banner, Button, ConfirmDialog, ErrorState, Text, describeError, plural, toast } from "@mach/ui";
import { sizeWords, uploadFile, uploadLimits, type JiraKeys, type MachApiError, type Status, type UploadFile } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { client } from "../../api/client";
import { toApiError } from "../../api/session";
import { keysSummary, namesFrom, wouldRecord, type KeysSummary, type Named } from "./model";

/**
 * Step 3: the CSV exported from Jira after the import. Tried first without changing anything (the
 * dry run), then applied on an explicit confirmation (`jira.keys`). The page shows only what the
 * engine reported: rows by number, IDs, valid keys and the engine's reasons; never a refused key.
 */
export function KeysBack({ status }: { status: Status }) {
  const inputId = useId();
  const hintId = useId();
  const [file, setFile] = useState<UploadFile | null>(null);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const [trial, setTrial] = useState<JiraKeys | null>(null);
  const [applied, setApplied] = useState<JiraKeys | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [trying, setTrying] = useState(false);
  const [trialError, setTrialError] = useState<MachApiError | null>(null);
  const apply = useEngineAct();
  const names = namesFrom(status);
  const limit = uploadLimits.jiraKeys;

  const choose = async (chosen: File | undefined) => {
    setFile(null);
    setTrial(null);
    setApplied(null);
    setTrialError(null);
    setChooseError(null);
    if (!chosen) return;
    try {
      setFile(await uploadFile(chosen, limit, "jira.keys"));
    } catch (cause) {
      setChooseError(toApiError(cause, "jira.keys").message);
    }
  };

  const tryIt = async () => {
    if (!file) return;
    setTrying(true);
    setTrialError(null);
    try {
      // A dry run changes nothing, so it needs no confirmation; the real run does.
      setTrial(await client.op("jira.keys", { file, dry_run: true }));
    } catch (cause) {
      setTrialError(toApiError(cause, "jira.keys"));
    } finally {
      setTrying(false);
    }
  };

  const record = async () => {
    if (!file) return false;
    const answer = await apply.run("jira.keys", { file });
    if (!answer) return false;
    setApplied(answer);
    setTrial(null);
    toast({ tone: "success", title: "Recorded the Jira keys", description: answer.note });
    return true;
  };

  const trialSummary = trial ? keysSummary(trial, names) : null;
  const appliedSummary = applied ? keysSummary(applied, names) : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-label text-ink">
          The CSV file exported from Jira
        </label>
        <p id={hintId} className="max-w-reading text-body-sm text-ink-muted">
          A {limit.extensions.join(", ")} file of at most {sizeWords(limit.maxBytes)}. In Jira, search for labels = mach and export the results as CSV, with at least the key and the labels.
        </p>
        <input
          id={inputId}
          type="file"
          accept={limit.extensions.join(",")}
          aria-describedby={hintId}
          aria-invalid={chooseError ? true : undefined}
          onChange={(event) => void choose(event.target.files?.[0])}
          className="max-w-md rounded-sm border border-line-control bg-surface text-body-sm text-ink file:mr-3 file:h-control-md file:border-0 file:border-r file:border-line-control file:bg-surface-sunken file:px-3 file:font-semibold file:text-ink"
        />
        {chooseError ? (
          <p role="alert" className="text-body-sm text-danger-ink">
            {chooseError}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant={trial ? "secondary" : "primary"} disabled={!file} loading={trying} onClick={() => void tryIt()}>
          <FileSearch aria-hidden="true" />
          Try it without changing anything
        </Button>
        {trialSummary ? (
          <Button variant="primary" disabled={!wouldRecord(trialSummary)} onClick={() => setConfirming(true)}>
            <Upload aria-hidden="true" />
            Record these keys
          </Button>
        ) : null}
        {!file ? (
          <Text size="body-sm" tone="muted">
            Choose a file first.
          </Text>
        ) : trialSummary && !wouldRecord(trialSummary) ? (
          <Text size="body-sm" tone="muted">
            Nothing in this file would be recorded.
          </Text>
        ) : null}
      </div>

      {trialError ? (
        <ErrorState title={trialError.kind === "refused" ? "The file was not read" : describeError(trialError).title} message={trialError.kind === "refused" ? trialError.message : describeError(trialError).message} hint={trialError.hint} />
      ) : null}

      {trialSummary ? <KeysReport summary={trialSummary} /> : null}
      {appliedSummary ? <KeysReport summary={appliedSummary} /> : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) apply.reset();
        }}
        title={trialSummary ? `Record ${plural(trialSummary.link.length, "Jira key")}?` : "Record the Jira keys?"}
        description="This records each key on its epic or slice, as the try showed. Slices already marked ready are not changed; they are listed to reopen first. Nothing is sent to Jira or GitHub."
        confirmLabel="Record the keys"
        onConfirm={record}
        error={apply.shown}
      >
        {trialSummary ? (
          <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto pb-1 text-body-sm text-ink">
            {trialSummary.link.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline gap-x-2">
                <ArtifactId>{item.id}</ArtifactId>
                {item.name ? <span>{item.name}</span> : null}
                <span className="text-ink-muted">
                  to <ArtifactId plain className="text-ink">{item.jira}</ArtifactId>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** What the engine found in the file: to link, already linked, to reopen first, not matched, refused. */
export function KeysReport({ summary }: { summary: KeysSummary }) {
  const would = summary.dryRun;
  return (
    <section aria-labelledby={would ? "jira-keys-trial" : "jira-keys-applied"} className="flex flex-col gap-5 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex flex-col gap-1" aria-live="polite">
        <h3 id={would ? "jira-keys-trial" : "jira-keys-applied"} className="flex items-center gap-2 text-title-3 font-semibold text-ink">
          {would ? null : <CircleCheck aria-hidden="true" className="size-5 text-success-ink" />}
          {would ? "What the file would do" : "What was recorded"}
        </h3>
        <Text size="body-sm" tone="muted" className="max-w-reading">
          {plural(summary.rowsRead, "row")} read. {summary.note}
        </Text>
        {would ? (
          <Text size="body-sm" tone="muted">
            Nothing has changed yet.
          </Text>
        ) : null}
      </div>

      <Group title={would ? "Would be linked" : "Linked"} count={summary.link.length} empty={would ? "No key in the file would be recorded." : "No key was recorded."}>
        {summary.link.map((item) => (
          <ItemRow key={item.id} item={item}>
            <KeyWord jira={item.jira} />
          </ItemRow>
        ))}
      </Group>

      {summary.already.length > 0 ? (
        <Group title="Already had that key" count={summary.already.length}>
          {summary.already.map((item) => (
            <ItemRow key={item.id} item={item}>
              <KeyWord jira={item.jira} />
            </ItemRow>
          ))}
        </Group>
      ) : null}

      {summary.reopen.length > 0 ? (
        <Group title="Reopen these slices first" count={summary.reopen.length} note="They are marked ready, so their key cannot change until each is reopened. Bring the file back afterwards.">
          {summary.reopen.map((item) => (
            <ItemRow key={item.id} item={item} link>
              <KeyWord jira={item.jira} />
              <span className="text-ink-muted">: {item.reason}</span>
            </ItemRow>
          ))}
        </Group>
      ) : null}

      {summary.epicsWithReady.length > 0 ? (
        <Banner tone="warning" title="Some epics have slices already marked ready">
          <ul className="flex flex-col gap-1">
            {summary.epicsWithReady.map((epic) => (
              <li key={epic.id}>
                <ArtifactId>{epic.id}</ArtifactId> {epic.name}: these keep their old key until each is reopened and marked ready again:{" "}
                {epic.slices.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 ? ", " : ""}
                    <ArtifactId plain className="text-ink">
                      {s.id}
                    </ArtifactId>
                  </span>
                ))}
                .
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      {summary.unmatched.length > 0 ? (
        <Group title="Not matched" count={summary.unmatched.length} note="These rows name no epic or slice in this workspace.">
          {summary.unmatched.map((row, i) => (
            <RowLine key={i} row={row} />
          ))}
        </Group>
      ) : null}

      {summary.refused.length > 0 ? (
        <Group title="Refused" count={summary.refused.length} note="These were not recorded, for the reason given. A refused key is not shown.">
          {summary.refused.map((row, i) => (
            <RowLine key={i} row={row} />
          ))}
        </Group>
      ) : null}
    </section>
  );
}

function Group({ title, count, note, empty, children }: { title: string; count: number; note?: string; empty?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-label text-ink">
        {title} <span className="font-normal text-ink-muted tabular">({count})</span>
      </h4>
      {note ? (
        <Text size="body-sm" tone="muted" className="max-w-reading">
          {note}
        </Text>
      ) : null}
      {count === 0 && empty ? (
        <Text size="body-sm" tone="muted">
          {empty}
        </Text>
      ) : (
        <ul className="flex flex-col gap-1 text-body-sm text-ink">{children}</ul>
      )}
    </div>
  );
}

function ItemRow({ item, link = false, children }: { item: Named; link?: boolean; children?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      {link ? (
        <Link to={`/slices/${item.id}`} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
          <span translate="no" className="font-mono">
            {item.id}
          </span>
          {item.name ? ` ${item.name}` : ""}
        </Link>
      ) : (
        <>
          <ArtifactId>{item.id}</ArtifactId>
          {item.name ? <span>{item.name}</span> : null}
        </>
      )}
      {children}
    </li>
  );
}

function KeyWord({ jira }: { jira: string }) {
  return (
    <span className="text-ink-muted">
      as{" "}
      <ArtifactId plain className="font-semibold text-ink">
        {jira}
      </ArtifactId>
    </span>
  );
}

function RowLine({ row }: { row: { where: string | null; item: Named | null; reason: string } }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      {row.where ? <span className="font-semibold tabular">{row.where}</span> : null}
      {row.item ? (
        <span>
          <ArtifactId>{row.item.id}</ArtifactId>
          {row.item.name ? ` ${row.item.name}` : ""}
        </span>
      ) : null}
      <span className="text-ink-muted">: {row.reason}</span>
    </li>
  );
}
