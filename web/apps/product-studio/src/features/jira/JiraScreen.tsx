import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CircleAlert, Layers } from "lucide-react";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, Skeleton, SkeletonText, Text, describeError, type Status } from "@mach/ui";
import type { JiraExport, JiraKeys } from "@mach/ui/api";
import { useStatus } from "../../api/store";
import { Part, Parts } from "../../shared/layout/Parts";
import { ContextRow, OnePane, WorkPane, WorkPanes, WorkScreen } from "../../shared/layout/WorkScreen";
import { ExportPanel } from "./ExportPanel";
import { KeysBack } from "./KeysBack";
import { KeyTag, KeysLedger } from "./KeysLedger";
import {
  buildLedger,
  exportPartSummary,
  exportSummary,
  jiraOpenPart,
  keysBackSummary,
  keysPartSummary,
  keysSummary,
  ledgerFacts,
  namesFrom,
  type LedgerEpic,
  type LedgerFacts,
} from "./model";

const lead = "MACH never signs in to Jira or calls it. It carries each epic's and slice's Jira key, so Jira's own GitHub integration can link the work.";

/**
 * Jira: the keys each epic and slice carries (`epic.link`, `slice.link`), a file for Jira's own
 * importer (`jira.export`, offered through the host's download links), and the keys brought back
 * from Jira's export (`jira.keys`, tried first). The engine decides everything; this page arranges
 * what it reports and shows its refusals as written. Laid out as a work screen (M16 layout): the
 * three parts, one open at a time, and the keys at a glance beside them.
 */
export function JiraScreen() {
  const status = useStatus();
  if (!status.data && !status.error) {
    return (
      <JiraFrame>
        <OnePane label="Jira" width="reading">
          <div role="status" aria-busy="true" aria-label="Reading your epics and slices" className="flex flex-col gap-5">
            <Skeleton className="h-7 w-64" />
            <SkeletonText lines={3} />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        </OnePane>
      </JiraFrame>
    );
  }
  if (!status.data) {
    const { title, message } = describeError(status.error!);
    return (
      <JiraFrame>
        <OnePane label="Jira" width="reading">
          <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={() => void status.reload()}>Try again</Button>} />
        </OnePane>
      </JiraFrame>
    );
  }
  return <Jira status={status.data} />;
}

function JiraFrame({ children }: { children: ReactNode }) {
  return <WorkScreen header={<ContextRow title="Jira" about={lead} aboutLabel="About this page" />}>{children}</WorkScreen>;
}

interface KeysBackState {
  chosen: boolean;
  trial: JiraKeys | null;
  applied: JiraKeys | null;
}

function Jira({ status }: { status: Status }) {
  const ledger = buildLedger(status);
  const facts = ledgerFacts(ledger);
  const names = namesFrom(status);
  const [open, setOpen] = useState<string | null>(() => jiraOpenPart(facts));
  const [exported, setExported] = useState<JiraExport | null>(null);
  const [back, setBack] = useState<KeysBackState>({ chosen: false, trial: null, applied: null });

  if (ledger.length === 0) {
    return (
      <JiraFrame>
        <OnePane label="Jira" width="reading">
          <EmptyState
            icon={<Layers />}
            title="No epics yet"
            description="Keys and the file for Jira are about epics and their slices. Add an epic and its first slice, then come back here."
            action={
              <Button asChild variant="primary" size="sm">
                <Link to="/vision">{status.project ? "Add the first epic" : "Start the project"}</Link>
              </Button>
            }
          />
        </OnePane>
      </JiraFrame>
    );
  }

  return (
    <JiraFrame>
      <WorkPanes>
        <WorkPane label="Keys, the file for Jira and the keys back">
          <Parts label="The three steps, in the order a team does them" open={open} onOpenChange={setOpen}>
            <Part id="keys" name="The key each epic and slice carries" summary={keysPartSummary(facts)}>
              <div className="flex flex-col gap-4">
                <Text size="body-sm" tone="muted" className="max-w-reading">
                  A slice is handed over with its own key, or else its epic&apos;s. Set a key by hand here, or bring them all back from Jira under “Bring the keys back”.
                </Text>
                {facts.sliceKeys === 0 && facts.epicKeys === 0 ? (
                  <Banner tone="info" title="No slice has a Jira key of its own yet">
                    Export the file below, import it into Jira, then bring the keys back. Or set a key by hand where you already know it.
                  </Banner>
                ) : null}
                <KeysLedger ledger={ledger} />
              </div>
            </Part>
            <Part id="export" name="Export a file for Jira's importer" summary={exportPartSummary(exported ? exportSummary(exported, names) : null)}>
              <div className="flex flex-col gap-4">
                <Text size="body-sm" tone="muted" className="max-w-reading">
                  One CSV file with each epic and its stories in your order, and a README for the person who imports it. Items that already have a key are left out, so nothing is imported twice.
                </Text>
                <ExportPanel status={status} onExported={setExported} />
              </div>
            </Part>
            <Part
              id="back"
              name="Bring the keys back"
              summary={keysBackSummary({
                chosen: back.chosen,
                trial: back.trial ? keysSummary(back.trial, names) : null,
                applied: back.applied ? keysSummary(back.applied, names) : null,
              })}
            >
              <div className="flex flex-col gap-4">
                <Text size="body-sm" tone="muted" className="max-w-reading">
                  After the import, Jira has given each item a key. Hand back Jira&apos;s own export and each epic and slice here records its key.
                </Text>
                <KeysBack status={status} onState={setBack} />
              </div>
            </Part>
          </Parts>
        </WorkPane>
        <WorkPane side label="The keys at a glance">
          <KeysAtAGlance ledger={ledger} facts={facts} />
        </WorkPane>
      </WorkPanes>
    </JiraFrame>
  );
}

/** The narrow pane: how many items carry a key, and each epic and slice with its key, to refer to while exporting or bringing keys back. */
function KeysAtAGlance({ ledger, facts }: { ledger: LedgerEpic[]; facts: LedgerFacts }) {
  const counts = [
    { label: "Epics", value: facts.epics },
    { label: "Epics with a key", value: facts.epicKeys },
    { label: "Slices", value: facts.slices },
    { label: "Slices with a key of their own", value: facts.sliceKeys },
  ];
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="jira-aside-counts" className="flex flex-col gap-3">
        <Heading level={2} size="title-3" id="jira-aside-counts">
          The keys at a glance
        </Heading>
        <dl className="grid grid-cols-2 gap-2">
          {counts.map((r) => (
            <div key={r.label} className="flex min-w-0 flex-col gap-0.5 rounded-sm bg-surface-sunken px-2.5 py-2">
              <dt className="text-caption text-ink-muted">{r.label}</dt>
              <dd className="text-title-3 font-semibold text-ink tabular">{r.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="jira-aside-items" className="flex flex-col gap-3">
        <Heading level={2} size="title-3" id="jira-aside-items">
          Each epic and slice
        </Heading>
        <ul className="flex flex-col gap-4">
          {ledger.map((epic) => (
            <li key={epic.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <ArtifactId>{epic.id}</ArtifactId>
                <KeyTag fact={epic.key} />
              </div>
              {epic.slices.length ? (
                <ul aria-label={`Slices of ${epic.id}`} className="flex flex-col gap-1.5 border-l border-line pl-3">
                  {epic.slices.map((slice) => (
                    <li key={slice.id} className="flex flex-wrap items-center justify-between gap-2">
                      <ArtifactId plain>{slice.id}</ArtifactId>
                      <KeyTag fact={slice.key} />
                    </li>
                  ))}
                </ul>
              ) : (
                <Text size="body-sm" tone="muted">
                  No slices yet.
                </Text>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
