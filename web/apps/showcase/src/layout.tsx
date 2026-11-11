import { Heading, Text, cn } from "@mach/ui";
import type { ReactNode } from "react";

export function Section({ id, title, intro, children }: { id: string; title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 border-t border-line pt-10 first:border-t-0 first:pt-0">
      <div className="mb-8 flex max-w-reading flex-col gap-2">
        <Heading level={2} size="title-1" id={`${id}-title`}>
          {title}
        </Heading>
        <Text tone="muted" size="body-lg" editorial>
          {intro}
        </Text>
      </div>
      <div className="flex flex-col gap-10">{children}</div>
    </section>
  );
}

export interface SpecimenProps {
  title: string;
  /** Which fixture the data comes from, or what the specimen shows. */
  source?: string;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Lay the specimen on the sunken well instead of the canvas. */
  well?: boolean;
}

export function Specimen({ title, source, note, children, className, well }: SpecimenProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <Heading level={3}>{title}</Heading>
        {source ? (
          <Text as="span" size="caption" tone="subtle">
            Data: <span className="font-mono">{source}</span>
          </Text>
        ) : null}
      </div>
      {note ? (
        <Text size="body-sm" tone="muted" className="-mt-1 max-w-reading">
          {note}
        </Text>
      ) : null}
      <div className={cn("rounded-md border border-line p-6", well ? "bg-surface-sunken" : "bg-surface", className)}>{children}</div>
    </div>
  );
}

/** A two-column definition row for token tables. */
export function Row({ term, children }: { term: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-baseline gap-4 border-b border-line py-2 last:border-b-0">
      <dt className="font-mono text-mono text-ink-muted">{term}</dt>
      <dd className="text-body-sm text-ink">{children}</dd>
    </div>
  );
}
