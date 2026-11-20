import { useRef, useState } from "react";
import { Link } from "react-router";
import { CircleAlert, ScrollText, Plus } from "lucide-react";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, Heading, HintAction, Skeleton, SkeletonText, Text } from "@mach/ui";
import { describeError, type MachApiError, type PrincipleChanged } from "@mach/ui/api";
import { useOperation } from "../../api/useOperation";
import { useRefresh, useStatus } from "../../api/store";
import { ScreenFrame } from "../../shared/ScreenFrame";
import { isPrinciplesReconcileHint, publishState, slicesToCheck, splitPrinciples } from "./model";
import { PrincipleEntry } from "./PrincipleEntry";
import { PrincipleForm, type FormState } from "./PrincipleForm";
import { PublishDialog } from "./PublishDialog";
import { PublishedPanel } from "./PublishedPanel";
import { ReconcileChoice } from "./ReconcileChoice";

const TITLE = "Product principles";
const LEAD = "One sentence each that every slice must keep. Each slice says how it keeps them.";

/**
 * Product principles (M13 A). Reads `principle.list`; acts `principle.add`, `principle.set`,
 * `principle.retire`, `principle.publish` and `reconcile.principles`, each a person's act
 * confirmed in a dialog. Fixtures: ?principles=empty|unpublished|newer-elsewhere, and
 * ?refuse=principle.add|principle.set|principle.publish for the engine's real refusals.
 */
export function PrinciplesScreen() {
  const list = useOperation("principle.list", {});
  const status = useStatus();
  const refresh = useRefresh();
  const [form, setForm] = useState<FormState>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishFailure, setPublishFailure] = useState<MachApiError | null>(null);
  const [noted, setNoted] = useState<{ id: string; warnings: string[] } | null>(null);
  const choiceRef = useRef<HTMLElement>(null);
  const goToChoice = useRef(false);

  if (!list.data && list.error) {
    const { title, message } = list.error.kind === "refused" ? { title: "Your principles could not be read", message: list.error.message } : describeError(list.error);
    return (
      <ScreenFrame title={TITLE} lead={LEAD}>
        <ErrorState icon={<CircleAlert />} title={title} message={message} hint={list.error.hint} action={<Button onClick={list.reload}>Try again</Button>} />
      </ScreenFrame>
    );
  }
  if (!list.data) {
    return (
      <ScreenFrame title={TITLE} lead={LEAD}>
        <div role="status" aria-label="Reading your principles" aria-busy="true" className="flex flex-col gap-8">
          <Skeleton className="h-28 w-full" />
          {[0, 1].map((i) => (
            <div key={i} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-6">
              <Skeleton className="h-5 w-16" />
              <div className="flex flex-col gap-3">
                <Skeleton className="h-6 w-56" />
                <SkeletonText lines={2} />
              </div>
            </div>
          ))}
        </div>
      </ScreenFrame>
    );
  }

  const data = list.data;
  const state = publishState(data);
  const { active, retired } = splitPrinciples(data.principles);
  const toCheck = slicesToCheck(data, status.data?.slices);
  const showChoice = state === "newer-elsewhere" || isPrinciplesReconcileHint(publishFailure?.hint);

  const afterAct = () => list.reload();
  const saved = (result: PrincipleChanged) => {
    setNoted(result.warnings?.length ? { id: result.principle.id, warnings: result.warnings } : null);
    afterAct();
  };
  const changeById = (id: string) => {
    const principle = data.principles.find((p) => p.id === id);
    if (principle && principle.status === "active") setForm({ mode: "change", principle });
  };

  const dialogs = (
    <>
      <PrincipleForm state={form} onClose={() => setForm(null)} onSaved={saved} />
      <PublishDialog
        open={publishing}
        onOpenChange={setPublishing}
        again={state === "unfinished"}
        facts={{ active: active.length, retired: retired.length, publishedRevision: data.published.revision, repository: status.data?.github.repository ?? null }}
        onPublished={() => {
          setPublishFailure(null);
          afterAct();
        }}
        onFailed={(error) => {
          setPublishFailure(error);
          afterAct();
        }}
        onChooseVersion={() => {
          goToChoice.current = true;
          setPublishing(false);
        }}
        focusOnClose={() => {
          if (!goToChoice.current) return null;
          goToChoice.current = false;
          return choiceRef.current;
        }}
      />
    </>
  );

  if (data.principles.length === 0 && !showChoice && state !== "unfinished") {
    return (
      <ScreenFrame title={TITLE} lead={LEAD}>
        <EmptyState
          icon={<ScrollText />}
          title="No principles yet"
          description="A principle is one sentence that must hold in every slice you write, such as “A published version must not be changed in place.” Each slice then says how it keeps it."
          action={
            <Button variant="primary" onClick={() => setForm({ mode: "add" })}>
              <Plus aria-hidden="true" />
              Add the first principle
            </Button>
          }
        />
        {dialogs}
      </ScreenFrame>
    );
  }

  return (
    <ScreenFrame title={TITLE} lead={LEAD}>
      {showChoice || publishFailure || refresh.error || noted ? (
        <div className="flex flex-col gap-3">
          {showChoice ? (
            <ReconcileChoice
              ref={choiceRef}
              published={data.published}
              onChosen={() => {
                setPublishFailure(null);
                afterAct();
              }}
            />
          ) : null}
          {publishFailure && !isPrinciplesReconcileHint(publishFailure.hint) ? (
            <Banner
              tone="danger"
              title="The principles were not published"
              actions={
                <>
                  <HintAction hint={publishFailure.hint} />
                  <Button size="sm" onClick={() => setPublishing(true)}>
                    Try again
                  </Button>
                </>
              }
            >
              <span className="whitespace-pre-line">{publishFailure.kind === "refused" ? publishFailure.message : describeError(publishFailure).message}</span>
              <span className="mt-1 block text-ink-muted">Your principles are safe here and you can keep working. The builders still have what was published before.</span>
            </Banner>
          ) : null}
          {refresh.error ? (
            <Banner
              tone="warning"
              title="GitHub could not be read"
              actions={
                <Button size="sm" loading={refresh.loading} onClick={() => void refresh.run().then(afterAct)}>
                  Try again
                </Button>
              }
            >
              <span className="whitespace-pre-line">{refresh.error.kind === "refused" ? refresh.error.message : describeError(refresh.error).message}</span>
              <span className="mt-1 block text-ink-muted">Your principles are safe and you can keep working; what is shown about GitHub is from the last time it was read.</span>
            </Banner>
          ) : null}
          {noted ? (
            <Banner
              tone="warning"
              title={`${noted.id} is saved. The check noted:`}
              actions={
                <>
                  <Button size="sm" onClick={() => changeById(noted.id)}>
                    Change {noted.id}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setNoted(null)}>
                    Dismiss
                  </Button>
                </>
              }
            >
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {noted.warnings.map((warning) => (
                  <li key={warning} className="whitespace-pre-line">
                    {warning}
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
        </div>
      ) : null}

      <PublishedPanel
        state={state}
        list={data}
        active={active.length}
        retired={retired.length}
        onPublish={() => setPublishing(true)}
        checking={refresh.loading}
        onCheckGithub={() => void refresh.run().then(afterAct)}
      />

      {toCheck.length ? (
        <section aria-labelledby="principles-to-check" className="flex flex-col gap-3">
          <div className="flex max-w-reading flex-col gap-1">
            <Heading level={2} size="title-3" id="principles-to-check">
              Slices to check
            </Heading>
            <Text size="body-sm" tone="muted">
              These slices answer an older version of a principle, or leave one in force unanswered. Nothing is reopened for you: check each one&apos;s answers.
            </Text>
          </div>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {toCheck.map((slice) => (
              <li key={slice.id} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/slices/${slice.id}/policies`} className="rounded-xs text-body font-semibold text-ink underline-offset-2 hover:underline">
                    {slice.title ?? slice.id}
                  </Link>
                  {slice.title ? <ArtifactId>{slice.id}</ArtifactId> : null}
                </div>
                <Text size="body-sm" tone="muted">
                  {slice.note ?? "Answered under older principles."}
                </Text>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="principles-in-force" className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line-strong pb-3">
          <div className="flex flex-col gap-1">
            <Heading level={2} id="principles-in-force">
              In force
            </Heading>
            <Text size="body-sm" tone="muted">
              {active.length ? `${active.length === 1 ? "1 principle" : `${active.length} principles`} every slice must keep.` : "None in force. Add one to give every slice a rule to keep."}
            </Text>
          </div>
          <Button onClick={() => setForm({ mode: "add" })}>
            <Plus aria-hidden="true" />
            Add a principle
          </Button>
        </div>
        {active.length ? (
          <ul className="flex flex-col">
            {active.map((principle) => (
              <PrincipleEntry key={principle.id} principle={principle} onChange={() => setForm({ mode: "change", principle })} onRetired={afterAct} />
            ))}
          </ul>
        ) : null}
      </section>

      {retired.length ? (
        <section aria-labelledby="principles-retired" className="flex flex-col gap-5">
          <div className="flex flex-col gap-1 border-b border-line pb-3">
            <Heading level={2} size="title-3" id="principles-retired">
              Retired
            </Heading>
            <Text size="body-sm" tone="muted">
              Slices no longer answer these. They stay listed, and are published, so their numbers are never used again.
            </Text>
          </div>
          <ul className="flex flex-col">
            {retired.map((principle) => (
              <PrincipleEntry key={principle.id} principle={principle} />
            ))}
          </ul>
        </section>
      ) : null}

      {dialogs}
    </ScreenFrame>
  );
}
