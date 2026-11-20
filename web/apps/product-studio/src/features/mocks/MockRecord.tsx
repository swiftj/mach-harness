import type { ReactNode } from "react";
import { Eye, FileImage, Lock, Trash2 } from "lucide-react";
import { Banner, Button, FactList, Heading, StatusPill, Text } from "@mach/ui";
import type { DesignMock } from "@mach/ui/api";
import { byteWords, dimensionWords, fingerprint, kindWords, mockPurpose, type ScenarioName } from "./model";

export type ListedMock = DesignMock & { file?: string; problem?: string | null };

/** Binding or for reference: a word, a shape and a tone, so it reads in greyscale. */
export function BindingPill({ binding }: { binding: boolean }) {
  return binding ? (
    <StatusPill tone="info" size="sm" icon={<Lock aria-hidden="true" />}>
      Binding
    </StatusPill>
  ) : (
    <StatusPill tone="neutral" size="sm" icon={<Eye aria-hidden="true" />}>
      For reference
    </StatusPill>
  );
}

/**
 * One attached picture, as a labelled record. The host does not serve the picture to the browser,
 * so nothing here pretends to show it: the left-hand frame says so in words.
 */
export function MockRecord({ mock, index, scenarios, onRemove }: { mock: ListedMock; index: number; scenarios: readonly ScenarioName[]; onRemove?: () => void }) {
  const headingId = `mock-${mock.sha256.slice(0, 16)}`;
  const purpose = mockPurpose(mock, scenarios);
  return (
    <article aria-labelledby={headingId} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-5 rounded-md border border-line bg-surface p-5">
      <div className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-sm border border-dashed border-line-strong bg-surface-sunken px-2 text-center">
        <FileImage aria-hidden="true" className="size-6 text-ink-subtle" />
        <span className="text-caption text-ink-muted">Picture not shown here</span>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            <Text size="caption" tone="subtle">
              Picture {index + 1}
            </Text>
            <Heading level={3} size="title-3" id={headingId}>
              {mock.for ? (
                <>
                  For <span translate="no" className="font-mono">{mock.for}</span>
                  {purpose !== mock.for ? purpose.slice(mock.for.length) : ""}
                </>
              ) : (
                "For the whole slice"
              )}
            </Heading>
          </div>
          <BindingPill binding={mock.binding} />
        </header>

        {mock.note ? (
          <p className="max-w-reading text-body text-ink">
            <span className="text-ink-muted">Your note: </span>
            {mock.note}
          </p>
        ) : null}

        <div className="text-body-sm">
          <FactList
            facts={[
              ...(mock.file ? [["File", <span key="file" translate="no" className="break-all font-mono">{mock.file}</span>] as [string, ReactNode]] : []),
              ["Kind", kindWords(mock.format)],
              ["Size", `${dimensionWords(mock)} · ${byteWords(mock.bytes)}`],
              [
                "Fingerprint",
                <span key="sha" translate="no" className="font-mono">
                  {fingerprint(mock.sha256)}
                </span>,
              ],
            ]}
          />
        </div>

        {mock.problem ? (
          <Banner tone="warning" title="This picture needs attention">
            {mock.problem}
          </Banner>
        ) : null}

        {onRemove ? (
          <div>
            <Button size="sm" variant="secondary" onClick={onRemove}>
              <Trash2 aria-hidden="true" />
              Remove<span className="sr-only"> picture {index + 1}</span>
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
