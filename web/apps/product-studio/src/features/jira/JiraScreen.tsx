import type { ReactNode } from "react";
import { Link } from "react-router";
import { CircleAlert, Layers } from "lucide-react";
import { Banner, Button, EmptyState, ErrorState, Skeleton, SkeletonText, Text, describeError, plural, type Status } from "@mach/ui";
import { ScreenFrame } from "../../shared/ScreenFrame";
import { useStatus } from "../../api/store";
import { ExportPanel } from "./ExportPanel";
import { KeysBack } from "./KeysBack";
import { KeysLedger } from "./KeysLedger";
import { buildLedger, ledgerFacts } from "./model";

const lead = "MACH never signs in to Jira or calls it. It carries each epic's and slice's Jira key, so Jira's own GitHub integration can link the work.";

/**
 * Jira: the keys each epic and slice carries (`epic.link`, `slice.link`), a file for Jira's own
 * importer (`jira.export`, offered through the host's download links), and the keys brought back
 * from Jira's export (`jira.keys`, tried first). The engine decides everything; this page arranges
 * what it reports and shows its refusals as written.
 */
export function JiraScreen() {
  const status = useStatus();
  if (!status.data && !status.error) {
    return (
      <ScreenFrame title="Jira" lead={lead}>
        <div role="status" aria-busy="true" aria-label="Reading your epics and slices" className="flex max-w-reading flex-col gap-5">
          <Skeleton className="h-7 w-64" />
          <SkeletonText lines={3} />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </ScreenFrame>
    );
  }
  if (!status.data) {
    const { title, message } = describeError(status.error!);
    return (
      <ScreenFrame title="Jira" lead={lead}>
        <ErrorState icon={<CircleAlert />} title={title} message={message} action={<Button onClick={() => void status.reload()}>Try again</Button>} />
      </ScreenFrame>
    );
  }
  return <Jira status={status.data} />;
}

function Jira({ status }: { status: Status }) {
  const ledger = buildLedger(status);
  const facts = ledgerFacts(ledger);

  if (ledger.length === 0) {
    return (
      <ScreenFrame title="Jira" lead={lead}>
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
      </ScreenFrame>
    );
  }

  return (
    <ScreenFrame title="Jira" lead={lead} width="wide">
      <ol aria-label="The three steps, in the order a team does them" className="flex flex-col">
        <Step n={1} id="jira-keys" title="The key each epic and slice carries" last={false}>
          <Text tone="muted" className="max-w-reading">
            A slice is handed over with its own key, or else its epic&apos;s. Set a key by hand here, or bring them all back from Jira in step 3.
          </Text>
          <Text size="body-sm" tone="muted" className="max-w-reading">
            {plural(facts.epics, "epic")} · {plural(facts.slices, "slice")} · {plural(facts.sliceKeys, "slice")} with a key of its own
          </Text>
          {facts.sliceKeys === 0 && facts.epicKeys === 0 ? (
            <Banner tone="info" title="No slice has a Jira key of its own yet">
              Export the file below, import it into Jira, then bring the keys back. Or set a key by hand where you already know it.
            </Banner>
          ) : null}
          <KeysLedger ledger={ledger} />
        </Step>

        <Step n={2} id="jira-export" title="Export a file for Jira's importer" last={false}>
          <Text tone="muted" className="max-w-reading">
            One CSV file with each epic and its stories in your order, and a README for the person who imports it. Items that already have a key are left out, so nothing is imported twice.
          </Text>
          <ExportPanel status={status} />
        </Step>

        <Step n={3} id="jira-keys-back" title="Bring the keys back" last>
          <Text tone="muted" className="max-w-reading">
            After the import, Jira has given each item a key. Hand back Jira&apos;s own export and each epic and slice here records its key.
          </Text>
          <KeysBack status={status} />
        </Step>
      </ol>
    </ScreenFrame>
  );
}

/** One of the three steps: a numbered marker on a rule that runs down to the next, then the step's content. */
function Step({ n, id, title, last, children }: { n: number; id: string; title: string; last: boolean; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-5">
      <div className="flex flex-col items-center">
        <span aria-hidden="true" className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface text-label text-ink tabular">
          {n}
        </span>
        {last ? null : <span aria-hidden="true" className="mt-2 w-px flex-1 bg-line-strong" />}
      </div>
      <section aria-labelledby={id} className={last ? "flex min-w-0 flex-col gap-4" : "flex min-w-0 flex-col gap-4 pb-14"}>
        <h2 id={id} className="pt-1 text-title-2 font-bold text-ink">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h2>
        {children}
      </section>
    </li>
  );
}
