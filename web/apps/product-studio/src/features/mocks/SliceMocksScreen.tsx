import { useState } from "react";
import { useParams } from "react-router";
import { ImagePlus } from "lucide-react";
import { Button, EmptyState, ErrorState, Heading, SkeletonText, Text, describeError } from "@mach/ui";
import { useOperation } from "../../api/useOperation";
import { useSliceShow } from "../../api/useSliceShow";
import { SliceScreenFrame } from "../../shared/ScreenFrame";
import { useReadyAnswer } from "../../shared/mocksDelivery";
import { AddMockDialog, PICTURE_RULE, RemoveMockDialog } from "./MockDialogs";
import { MockRecord, type ListedMock } from "./MockRecord";
import { MocksToCommitPanel } from "../../shared/MocksToCommit";
import { addAvailability, deliveryState, type ScenarioName } from "./model";

/**
 * One slice's design mocks: `slice.mock.list`; acts `slice.mock.add` with
 * `uploadFile(file, uploadLimits.mock)` and `slice.mock.remove`. After "Mark ready to build" on
 * GitHub, `slice.ready`'s `mocks` says the pictures wait to be committed (kept by delivery.ts when
 * this window has it). The pictures themselves are not served by the host, so each is shown as a
 * labelled record. Fixtures: slice.mock.list, ?mocks=empty, ?ready=with-mocks, ?refuse=slice.mock.add.
 */
export function SliceMocksScreen() {
  const sliceId = useParams().sliceId ?? "";
  const show = useSliceShow(sliceId);
  const list = useOperation("slice.mock.list", sliceId ? { slice_id: sliceId } : null);
  const toCommit = useReadyAnswer(sliceId);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);

  const reload = () => {
    list.reload();
    show.reload();
  };

  return (
    <SliceScreenFrame sliceId={sliceId} slice={show.data?.slice} title="Design mocks" lead="Approved pictures of the screen, each for one scenario or for the slice as a whole.">
      <MocksBody
        sliceId={sliceId}
        mocks={list.data?.mocks ?? null}
        limit={list.data?.limit ?? null}
        loading={list.loading && !list.data}
        error={list.data ? null : list.error}
        retry={reload}
        show={show.data}
        toCommit={toCommit}
        onAdd={() => setAdding(true)}
        onRemove={setRemoving}
      />
      <AddMockDialog open={adding} onOpenChange={setAdding} sliceId={sliceId} scenarios={scenariosOf(show.data)} onDone={reload} />
      <RemoveMockDialog
        mock={removing !== null ? (list.data?.mocks[removing] ?? null) : null}
        index={removing ?? 0}
        sliceId={sliceId}
        scenarios={scenariosOf(show.data)}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        onDone={reload}
      />
    </SliceScreenFrame>
  );
}

type Show = ReturnType<typeof useSliceShow>["data"];

function scenariosOf(show: Show): ScenarioName[] {
  return (show?.spec?.model.scenarios ?? []).map((s) => ({ id: s.id, title: s.title }));
}

interface BodyProps {
  sliceId: string;
  mocks: ListedMock[] | null;
  limit: number | null;
  loading: boolean;
  error: ReturnType<typeof useOperation>["error"];
  retry: () => void;
  show: Show;
  toCommit: ReturnType<typeof useReadyAnswer>;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

/** What binding means and what a mock is not: said once, above the pictures. */
function WhatAMockIs() {
  return (
    <div className="flex max-w-reading flex-col gap-1.5">
      <Text>
        A <span className="font-semibold">binding</span> picture must be matched by the builders&apos; screen for its scenario, or verification fails. Any other picture is for reference.
      </Text>
      <Text tone="muted">A picture never adds a requirement: the scenarios stay the authority, and a picture only shows what they describe.</Text>
    </div>
  );
}

function MocksBody({ sliceId, mocks, limit, loading, error, retry, show, toCommit, onAdd, onRemove }: BodyProps) {
  if (loading || (!mocks && !error)) {
    return (
      <div role="status" aria-label="Reading the slice's design mocks">
        <SkeletonText lines={4} />
      </div>
    );
  }
  if (!mocks || limit === null) {
    const described = error ? describeError(error) : { title: "The design mocks could not be read", message: "" };
    return (
      <ErrorState
        title={error?.kind === "refused" ? "The design mocks could not be read" : described.title}
        message={error?.kind === "refused" ? error.message : described.message}
        hint={error?.hint}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  }

  const scenarios = scenariosOf(show);
  const editable = show?.editable ?? false;
  const availability = show ? addAvailability(mocks.length, limit, editable) : null;
  const delivery = show ? deliveryState({ status: show.slice.status, github: show.github, mockCount: mocks.length, toCommit }) : { kind: "none" as const };
  const files = mocks.map((m) => m.file).filter((f): f is string => typeof f === "string");

  if (mocks.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <EmptyState
          title="No design mocks yet"
          icon={<ImagePlus />}
          description={`A design mock is an approved picture of the screen, so the builders see what you have in mind. It is optional: most slices need none. ${PICTURE_RULE} At most ${limit} for a slice.`}
          action={
            availability === "available" ? (
              <Button variant="primary" onClick={onAdd}>
                <ImagePlus aria-hidden="true" />
                Attach a picture
              </Button>
            ) : availability === "locked" ? (
              <LockedNote refusal={show?.edit_refusal ?? null} />
            ) : null
          }
        />
        <WhatAMockIs />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {delivery.kind === "waiting" ? <MocksToCommitPanel sliceId={sliceId} toCommit={delivery.toCommit} files={files} /> : null}
      <WhatAMockIs />

      <section aria-labelledby="mocks-heading" className="flex flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <Heading level={2} size="title-2" id="mocks-heading">
              Pictures
            </Heading>
            <Text size="body-sm" tone="muted">
              <span className="tabular">
                {mocks.length} of {limit}
              </span>{" "}
              pictures a slice can have. Open a picture to see it at full size.
            </Text>
          </div>
          {availability === "available" ? (
            <Button variant="primary" onClick={onAdd}>
              <ImagePlus aria-hidden="true" />
              Attach a picture
            </Button>
          ) : null}
        </header>

        {availability === "full" ? (
          <Text size="body-sm" className="max-w-reading">
            This slice has {limit} pictures, the most a slice can have. Remove one to attach another.
          </Text>
        ) : availability === "locked" ? (
          <LockedNote refusal={show?.edit_refusal ?? null} />
        ) : null}

        <ul className="flex flex-col gap-4">
          {mocks.map((mock, index) => (
            <li key={mock.sha256}>
              <MockRecord sliceId={sliceId} mock={mock} index={index} scenarios={scenarios} onRemove={editable ? () => onRemove(index) : undefined} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Why pictures cannot be attached or removed now: the engine's own reason when it gives one. */
function LockedNote({ refusal }: { refusal: string | null }) {
  return (
    <Text size="body-sm" tone="muted" className="max-w-reading">
      {refusal ?? "The pictures cannot change while the slice is marked ready. To change them, reopen the slice from its specification."}
    </Text>
  );
}
