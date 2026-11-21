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
      <div className="flex aspect-[3/2] flex-col items-center justify-center gap-1.5 rounded-sm border border-dashed border-line-strong bg-surface-sunken px-2 text-center">
        <FileImage aria-hidden="true" className="size-6 text-ink-subtle" />
        <span className="text-caption text-ink-muted">Picture not shown here</span>
      </div>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="flex aspect-[3/2] items-center justify-center rounded-sm border border-line bg-surface-sunken">
      <img src={url} alt={alt} width={mock.width} height={mock.height} loading="lazy" decoding="async" onError={() => setFailed(true)} className="block max-h-full max-w-full rounded-sm object-contain" />
      <span className="sr-only"> (opens the picture at full size)</span>
    </a>
  );
}

/** What one picture is for, as its heading: a scenario's ID and title, or the whole slice. */
function Purpose({ mock, scenarios }: { mock: ListedMock; scenarios: readonly ScenarioName[] }) {
  const purpose = mockPurpose(mock, scenarios);
  if (!mock.for) return <>For the whole slice</>;
  return (
    <>
      For <span translate="no" className="font-mono">{mock.for}</span>
      {purpose !== mock.for ? purpose.slice(mock.for.length) : ""}
    </>
  );
}

/**
 * One attached picture, as a card in the grid (M16 layout): the picture, what it is for, binding or not, the note, and
 * anything that needs attention, which never folds. Its file's facts are listed in the narrow pane (`MockFiles`).
 */
export function MockRecord({ sliceId, mock, index, scenarios, onRemove }: { sliceId: string; mock: ListedMock; index: number; scenarios: readonly ScenarioName[]; onRemove?: () => void }) {
  const headingId = `mock-${mock.sha256.slice(0, 16)}`;
  return (
    <article aria-labelledby={headingId} className="flex h-full flex-col gap-3 rounded-md border border-line bg-surface p-4">
      <MockPicture sliceId={sliceId} mock={mock} alt={mockAlt(mock, scenarios)} />
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Text size="caption" tone="subtle">
            Picture {index + 1}
          </Text>
          <BindingPill binding={mock.binding} />
        </div>
        <Heading level={3} size="title-3" id={headingId} className="break-words">
          <Purpose mock={mock} scenarios={scenarios} />
        </Heading>
      </header>

      {mock.note ? (
        <p className="text-body-sm text-ink">
          <span className="text-ink-muted">Your note: </span>
          {mock.note}
        </p>
      ) : null}

      {mock.problem ? (
        <Banner tone="warning" title="This picture needs attention">
          {mock.problem}
        </Banner>
      ) : null}

      {onRemove ? (
        <div className="mt-auto pt-1">
          <Button size="sm" variant="secondary" onClick={onRemove}>
            <Trash2 aria-hidden="true" />
            Remove<span className="sr-only"> picture {index + 1}</span>
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** Each picture's file, kind, size and fingerprint, for the narrow pane: what an engineer looks for when committing them. */
export function MockFiles({ mocks, scenarios }: { mocks: ListedMock[]; scenarios: readonly ScenarioName[] }) {
  return (
    <section aria-labelledby="mock-files-title" className="flex flex-col gap-3">
      <Heading level={2} size="title-3" id="mock-files-title">
        The files
      </Heading>
      <ol className="flex flex-col divide-y divide-line">
        {mocks.map((mock, index) => (
          <li key={mock.sha256} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
            <Text size="body-sm" weight="semibold">
              Picture {index + 1}: <Purpose mock={mock} scenarios={scenarios} />
            </Text>
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
          </li>
        ))}
      </ol>
    </section>
  );
}
