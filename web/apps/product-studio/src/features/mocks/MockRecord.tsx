import { useState, type ReactNode } from "react";
import { Eye, FileImage, Lock, Trash2 } from "lucide-react";
import { Banner, Button, FactList, Heading, StatusPill, Text } from "@mach/ui";
import type { DesignMock } from "@mach/ui/api";
import { mockPictureUrl } from "../../api/mockPicture";
import { byteWords, dimensionWords, fingerprint, kindWords, mockAlt, mockPurpose, type ScenarioName } from "./model";

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
 * The picture itself, as the host serves the draft's own file (checked against its hash). When the
 * host cannot show it (the file changed or is missing, or no host answers), the frame says so in words.
 */
function MockPicture({ sliceId, mock, alt }: { sliceId: string; mock: ListedMock; alt: string }) {
  const url = mock.problem ? null : mockPictureUrl(sliceId, mock.sha256);
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-sm border border-dashed border-line-strong bg-surface-sunken px-2 text-center">
        <FileImage aria-hidden="true" className="size-6 text-ink-subtle" />
        <span className="text-caption text-ink-muted">Picture not shown here</span>
      </div>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block self-start rounded-sm border border-line bg-surface-sunken">
      <img src={url} alt={alt} width={mock.width} height={mock.height} loading="lazy" decoding="async" onError={() => setFailed(true)} className="block h-auto max-h-80 w-full rounded-sm object-contain" />
      <span className="sr-only"> (opens the picture at full size)</span>
    </a>
  );
}

/** One attached picture, shown beside its record. */
export function MockRecord({ sliceId, mock, index, scenarios, onRemove }: { sliceId: string; mock: ListedMock; index: number; scenarios: readonly ScenarioName[]; onRemove?: () => void }) {
  const headingId = `mock-${mock.sha256.slice(0, 16)}`;
  const purpose = mockPurpose(mock, scenarios);
  return (
    <article aria-labelledby={headingId} className="grid grid-cols-1 gap-5 rounded-md border border-line bg-surface p-5 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
      <MockPicture sliceId={sliceId} mock={mock} alt={mockAlt(mock, scenarios)} />
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
