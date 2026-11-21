import { useState } from "react";
import { useParams } from "react-router";
import { ImagePlus } from "lucide-react";
import { Banner, Button, EmptyState, ErrorState, Heading, SkeletonText, Text, describeError } from "@mach/ui";
import type { SliceShow } from "@mach/ui/api";
import { useOperation } from "../../api/useOperation";
import { useSliceShow } from "../../api/useSliceShow";
import { useReadyAnswer } from "../../shared/mocksDelivery";
import { MocksToCommitPanel } from "../../shared/MocksToCommit";
import { OnePane, WorkPane, WorkPanes, WorkScreen } from "../../shared/layout/WorkScreen";
import { SliceContextRow } from "../../shared/SliceContextRow";
import { AddMockDialog, PICTURE_RULE, RemoveMockDialog } from "./MockDialogs";
import { MockFiles, MockRecord, type ListedMock } from "./MockRecord";
import { addAvailability, deliveryState, type ScenarioName } from "./model";

/**
 * One slice's design mocks: `slice.mock.list`; acts `slice.mock.add` with
 * `uploadFile(file, uploadLimits.mock)` and `slice.mock.remove`. After "Mark ready to build" on
 * GitHub, `slice.ready`'s `mocks` says the pictures wait to be committed (kept by delivery.ts when
 * this window has it). Fixtures: slice.mock.list, ?mocks=empty, ?ready=with-mocks, ?refuse=slice.mock.add.
 *
 * M16 layout: the slice's context row with its pages as tabs and "Attach a picture" as the page's act; the pictures in a
 * grid in the wide pane; in the narrow pane, first, the "waiting for its pictures to be committed" panel, then what
 * binding means and each picture's file. While the pictures wait, a banner at the top of the wide pane also says so,
 * so it cannot be missed in any window (below 1,024 pixels the narrow pane follows the pictures).
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

  const mocks = list.data?.mocks ?? null;
  const limit = list.data?.limit ?? null;
  const availability = show.data && mocks && limit !== null ? addAvailability(mocks.length, limit, show.data.editable) : null;
  // The act sits in the context row once there are pictures; with none, the empty state offers it as its own act.
  const act =
    availability === "available" && mocks?.length ? (
      <Button variant="primary" onClick={() => setAdding(true)}>
        <ImagePlus aria-hidden="true" />
        Attach a picture
      </Button>
    ) : null;

  return (
    <WorkScreen
      header={
        <SliceContextRow
          sliceId={sliceId}
          show={show.data}
          title="Design mocks"
          about="Approved pictures of the screen, each for one scenario or for the slice as a whole."
          actions={act}
          refreshing={show.loading && Boolean(show.data)}
        />
      }
    >
      <MocksBody
        sliceId={sliceId}
        mocks={mocks}
        limit={limit}
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
    </WorkScreen>
  );
}

type Show = SliceShow | null | undefined;

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

/** What binding means and what a mock is not. */
function WhatAMockIs({ asSection = false }: { asSection?: boolean }) {
  const words = (
    <>
      <Text size={asSection ? "body-sm" : "body"}>
        A <span className="font-semibold">binding</span> picture must be matched by the builders&apos; screen for its scenario, or verification fails. Any other picture is for reference.
      </Text>
      <Text size={asSection ? "body-sm" : "body"} tone="muted">
        A picture never adds a requirement: the scenarios stay the authority, and a picture only shows what they describe.
      </Text>
    </>
  );
  if (!asSection) return <div className="flex max-w-reading flex-col gap-1.5">{words}</div>;
  return (
    <section aria-labelledby="mocks-binding-title" className="flex flex-col gap-1.5">
      <Heading level={2} size="title-3" id="mocks-binding-title">
        Binding or for reference
      </Heading>
      {words}
    </section>
  );
}

function MocksBody({ sliceId, mocks, limit, loading, error, retry, show, toCommit, onAdd, onRemove }: BodyProps) {
  if (loading || (!mocks && !error)) {
    return (
      <OnePane label="Design mocks">
        <div role="status" aria-label="Reading the slice's design mocks">
          <SkeletonText lines={4} />
        </div>
      </OnePane>
    );
  }
  if (!mocks || limit === null) {
    const described = error ? describeError(error) : { title: "The design mocks could not be read", message: "" };
    return (
      <OnePane label="Design mocks">
        <ErrorState
          title={error?.kind === "refused" ? "The design mocks could not be read" : described.title}
          message={error?.kind === "refused" ? error.message : described.message}
          hint={error?.hint}
          action={<Button onClick={retry}>Try again</Button>}
        />
      </OnePane>
    );
  }

  const scenarios = scenariosOf(show);
  const editable = show?.editable ?? false;
  const availability = show ? addAvailability(mocks.length, limit, editable) : null;
  const delivery = show ? deliveryState({ status: show.slice.status, github: show.github, mockCount: mocks.length, toCommit }) : { kind: "none" as const };
  const files = mocks.map((m) => m.file).filter((f): f is string => typeof f === "string");

  if (mocks.length === 0) {
    return (
      <OnePane label="Design mocks">
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
      </OnePane>
    );
  }

  return (
    <WorkPanes>
      <WorkPane label="The pictures">
        <section aria-labelledby="mocks-heading" className="flex flex-col gap-4">
          {delivery.kind === "waiting" ? (
            <Banner tone="warning" title="The builders wait for these pictures">
              {sliceId} is marked ready, but the builders will not start it until its pictures are on the project&apos;s main branch. What to commit, and where, is in “Waiting for its pictures to be committed”.
            </Banner>
          ) : null}
          <header className="flex flex-col gap-1">
            <Heading level={2} size="title-3" id="mocks-heading">
              Pictures
            </Heading>
            <Text size="body-sm" tone="muted">
              <span className="tabular">
                {mocks.length} of {limit}
              </span>{" "}
              pictures a slice can have. Open a picture to see it at full size.
            </Text>
          </header>

          {availability === "full" ? (
            <Text size="body-sm" className="max-w-reading">
              This slice has {limit} pictures, the most a slice can have. Remove one to attach another.
            </Text>
          ) : availability === "locked" ? (
            <LockedNote refusal={show?.edit_refusal ?? null} />
          ) : null}

          <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
            {mocks.map((mock, index) => (
              <li key={mock.sha256}>
                <MockRecord sliceId={sliceId} mock={mock} index={index} scenarios={scenarios} onRemove={editable ? () => onRemove(index) : undefined} />
              </li>
            ))}
          </ul>
        </section>
      </WorkPane>
      <WorkPane side label="Committing the pictures, and their files">
        <div className="flex flex-col gap-8">
          {delivery.kind === "waiting" ? <MocksToCommitPanel sliceId={sliceId} toCommit={delivery.toCommit} files={files} narrow /> : null}
          <WhatAMockIs asSection />
          <MockFiles mocks={mocks} scenarios={scenarios} />
        </div>
      </WorkPane>
    </WorkPanes>
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
