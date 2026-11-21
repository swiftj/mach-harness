import { useState } from "react";
import { Download, FileText } from "lucide-react";
import { ArtifactId, Banner, Button, Checkbox, ConfirmDialog, Field, RadioGroup, Select, Text, toast } from "@mach/ui";
import { sizeWords, type JiraExport, type Status } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { defaultExportChoice, exportArgs, exportSummary, fileContents, flavours, flavourWhy, namesFrom, readmeEssentials, type ExportChoice, type Named, type ExportSummary, type Flavour } from "./model";

/**
 * Step 2: a file for Jira's own importer (`jira.export`, on the product manager's word). The host
 * offers the two files the engine wrote through its own download links; nothing is sent to Jira.
 */
export function ExportPanel({ status }: { status: Status }) {
  const [choice, setChoice] = useState<ExportChoice>(defaultExportChoice);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<JiraExport | null>(null);
  const act = useEngineAct();

  const scopeOptions = [{ value: "all", label: "Everything" }, ...status.epics.map((e) => ({ value: e.epic_id, label: `${e.epic_id} ${e.title}` }))];
  const flavourName = flavours.find((f) => f.value === choice.flavour)?.label ?? "Jira";
  const scopeWords = choice.scope === "all" ? "every epic" : `${choice.scope} only`;

  const run = async () => {
    const answer = await act.run("jira.export", exportArgs(choice));
    if (!answer) return false;
    setResult(answer);
    toast({ tone: "success", title: `Exported for ${flavourName}`, description: answer.note });
    return true;
  };

  const set = (next: Partial<ExportChoice>) => setChoice((c) => ({ ...c, ...next }));

  return (
    <div className="flex flex-col gap-6">
      <RadioGroup
        legend="Which Jira the file is for"
        hint={flavourWhy}
        tone="accent"
        options={flavours.map((f) => ({ value: f.value as Flavour, label: f.label, description: f.detail }))}
        value={choice.flavour}
        onValueChange={(flavour) => set({ flavour })}
      />

      <div className="grid items-start gap-6 sm:grid-cols-2">
        <Field label="What goes in" hint="Everything, or one epic and its slices.">
          <Select value={choice.scope} onValueChange={(value) => set({ scope: value })} options={scopeOptions} />
        </Field>
        <div className="flex flex-col gap-1.5 pt-6">
          <Checkbox
            checked={choice.drafts}
            onCheckedChange={(checked) => set({ drafts: checked === true })}
            label="Include drafts"
            description="Off by default: a draft is not agreed work. Only slices marked ready go in otherwise."
          />
        </div>
      </div>

      <div>
        <Button variant="primary" onClick={() => setConfirming(true)}>
          <FileText aria-hidden="true" />
          Export for {flavourName}
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) act.reset();
        }}
        title={`Export a file for ${flavourName}?`}
        description={`This writes a CSV file and a short README with ${scopeWords}${choice.drafts ? ", drafts included" : ", slices marked ready only"}. Items that already have a Jira key are left out. Nothing is sent to Jira or GitHub; you download the files next.`}
        confirmLabel="Export"
        onConfirm={run}
        error={act.shown}
      />

      {result ? <ExportResult summary={exportSummary(result, namesFrom(status))} /> : null}
    </div>
  );
}

function ExportResult({ summary }: { summary: ExportSummary }) {
  const essentials = readmeEssentials(summary.flavour);
  const flavourName = flavours.find((f) => f.value === summary.flavour)?.label ?? "Jira";
  return (
    <section aria-labelledby="jira-export-result" className="flex flex-col gap-5 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex flex-col gap-1" aria-live="polite">
        <h3 id="jira-export-result" className="text-title-3 font-semibold text-ink">
          {summary.empty ? "Nothing to export" : `The file holds ${fileContents(summary.epics, summary.stories)}`}
        </h3>
        <Text size="body-sm" tone="muted" className="max-w-reading">
          {summary.note}
        </Text>
      </div>

      {!summary.empty && summary.downloads.length > 0 ? (
        <ul aria-label="Files to download" className="flex flex-wrap gap-3">
          {summary.downloads.map((d) => (
            <li key={d.name}>
              <a
                href={d.url}
                download={d.name}
                className="inline-flex h-control-md items-center gap-2 rounded-sm border border-line-control bg-canvas px-3.5 text-body-sm font-semibold text-ink hover:bg-surface-sunken"
              >
                <Download aria-hidden="true" className="size-4" />
                Download <span translate="no" className="font-mono">{d.name}</span>
                {d.bytes > 0 ? <span className="font-normal text-ink-muted">({sizeWords(d.bytes)})</span> : null}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {!summary.empty && summary.downloads.length === 0 ? (
        <Banner tone="warning" title="The files cannot be downloaded from here">
          The host did not offer them. Export again, or ask an engineer for the folder the export was written to.
        </Banner>
      ) : null}

      {summary.inJira.length > 0 ? (
        <ItemList title="Left out: already in Jira" items={summary.inJira.map((i) => ({ ...i, tail: i.jira }))} />
      ) : null}
      {summary.leftOut.length > 0 ? <ItemList title="Left out for another reason" items={summary.leftOut} /> : null}
      {summary.cut.length > 0 ? (
        <ItemList title="Descriptions cut to fit" note="These descriptions were too long for Jira, so the file holds the start of each and says it was cut." items={summary.cut} />
      ) : null}

      {!summary.empty ? (
        <div className="flex flex-col gap-4 border-t border-line pt-5">
          <h4 className="text-label text-ink">From the README: importing into {flavourName}</h4>
          <dl className="grid gap-x-6 gap-y-4 md:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-body-sm font-semibold text-ink-muted">Where to import</dt>
            <dd className="flex max-w-reading flex-col gap-1 text-body-sm text-ink">
              {essentials.screen.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </dd>
            <dt className="text-body-sm font-semibold text-ink-muted">One field first</dt>
            <dd className="max-w-reading text-body-sm text-ink">{essentials.field}</dd>
            <dt className="text-body-sm font-semibold text-ink-muted">After the import</dt>
            <dd className="max-w-reading text-body-sm text-ink">
              <ol className="flex list-decimal flex-col gap-1 pl-5">
                {essentials.after.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
            </dd>
          </dl>
        </div>
      ) : null}
    </section>
  );
}

function ItemList({ title, note, items }: { title: string; note?: string; items: Array<Named & { tail?: string | null; reason?: string }> }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-label text-ink">{title}</h4>
      {note ? (
        <Text size="body-sm" tone="muted">
          {note}
        </Text>
      ) : null}
      <ul className="flex flex-col gap-1 text-body-sm text-ink">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-baseline gap-x-2">
            <ArtifactId>{item.id}</ArtifactId>
            {item.name ? <span>{item.name}</span> : null}
            {item.tail ? (
              <span className="text-ink-muted">
                as <ArtifactId plain>{item.tail}</ArtifactId>
              </span>
            ) : null}
            {item.reason ? <span className="text-ink-muted">: {item.reason}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
