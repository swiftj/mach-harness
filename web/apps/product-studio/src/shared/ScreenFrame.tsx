import type { ReactNode } from "react";
import { EmptyState, Heading, Page, Text } from "@mach/ui";
import type { WorkOrder } from "@mach/ui/api";
import { SliceSections } from "./SliceSections";

/**
 * The frame every M15 screen sits in, so the screens look like one app: the page width, the one
 * h1 and the sentence under it. A slice page also shows the slice's own pages as tabs. Owned by
 * the shell; the screen engineers fill `children` and never change this file.
 */
export function ScreenFrame({ title, lead, width = "reading", children }: { title: ReactNode; lead?: ReactNode; width?: "reading" | "wide"; children?: ReactNode }) {
  return (
    <Page width={width} className="flex flex-col gap-8">
      <header className="flex max-w-reading flex-col gap-2">
        <Heading level={1}>{title}</Heading>
        {lead ? <Text tone="muted">{lead}</Text> : null}
      </header>
      {children}
    </Page>
  );
}

/**
 * A page of one slice: the slice's title, its pages as tabs, then the page's own content. Pass the
 * work order when the page has read it (`useSliceShow(sliceId).data?.slice`); until then the ID is
 * shown, and "From the PRD" appears once the work order says the slice came from one.
 */
export function SliceScreenFrame({ sliceId, slice, title, lead, children }: { sliceId: string; slice?: WorkOrder | null; title: string; lead?: ReactNode; children?: ReactNode }) {
  return (
    <Page className="flex flex-col gap-6">
      <header className="flex max-w-reading flex-col gap-2">
        <Text size="body-sm" tone="muted">
          {slice ? slice.title : sliceId}
        </Text>
        <Heading level={1}>{title}</Heading>
        {lead ? <Text tone="muted">{lead}</Text> : null}
      </header>
      <SliceSections sliceId={sliceId} fromPrd={slice?.source?.kind === "prd"} />
      {children}
    </Page>
  );
}

/**
 * What an M15 screen shows until its engineer builds it: what will be here, in plain words. Each
 * screen file replaces this with its content.
 */
export function NotBuiltYet({ what }: { what: string }) {
  return <EmptyState title="Not here yet" description={what} />;
}
