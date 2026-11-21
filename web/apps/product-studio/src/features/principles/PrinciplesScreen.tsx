import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CircleAlert, ScrollText, Plus, Upload } from "lucide-react";
import { ArtifactId, Banner, Button, EmptyState, ErrorState, HintAction, Skeleton, SkeletonText, Text } from "@mach/ui";
import { describeError, type MachApiError, type PrincipleChanged } from "@mach/ui/api";
import { useOperation } from "../../api/useOperation";
import { useRefresh, useStatus } from "../../api/store";
import { Part, Parts } from "../../shared/layout/Parts";
import { ContextRow, OnePane, WorkPane, WorkPanes, WorkScreen } from "../../shared/layout/WorkScreen";
import { countWords, inForceSummary, isPrinciplesReconcileHint, publishLabel, publishOffered, publishState, retiredSummary, slicesToCheck, splitPrinciples, toCheckSummary } from "./model";
import { PrincipleEntry } from "./PrincipleEntry";
import { PrincipleForm, type FormState } from "./PrincipleForm";
import { PublishDialog } from "./PublishDialog";
import { PublishedPanel } from "./PublishedPanel";
import { ReconcileChoice } from "./ReconcileChoice";

const TITLE = "Product principles";
const LEAD = "One sentence each that every slice must keep. Each slice says how it keeps them.";

/** The slim context row (M16 layout): the counts, the page's one h1, its lead behind "About this page", and its acts. */
function Header({ identity, actions }: { identity?: ReactNode; actions?: ReactNode }) {
  return <ContextRow identity={identity} title={TITLE} about={LEAD} aboutLabel="About this page" actions={actions} />;
}

/**
 * Product principles (M13 A). Reads `principle.list`; acts `principle.add`, `principle.set`,
 * `principle.retire`, `principle.publish` and `reconcile.principles`, each a person's act
 * confirmed in a dialog. Fixtures: ?principles=empty|unpublished|newer-elsewhere, and
 * ?refuse=principle.add|principle.set|principle.publish for the engine's real refusals.
 *
 * Laid out as a work screen (docs/mach-next/M16_LAYOUT.md): the principles as parts in the wide pane (in force, slices
 * to check, retired; one open at a time), and where they stand with the builders in the narrow pane, with a newer set
 * from someone else and its choice above it, never folded. The acts (add, publish) sit in the context row.
 */
export function PrinciplesScreen() {
  const list = useOperation("principle.list", {});
  const status = useStatus();
  const refresh = useRefresh();
  const [form, setForm] = useState<FormState>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishFailure, setPublishFailure] = useState<MachApiError | null>(null);
  const [noted, setNoted] = useState<{ id: string; warnings: string[] } | null>(null);
  const [open, setOpen] = useState<string | null>("in-force");
  const choiceRef = useRef<HTMLElement>(null);
  const goToChoice = useRef(false);

  if (!list.data && list.error) {
    const { title, message } = list.error.kind === "refused" ? { title: "Your principles could not be read", message: list.error.message } : describeError(list.error);
    return (
      <WorkScreen header={<Header />}>
        <OnePane label="Your principles" width="reading">
          <ErrorState icon={<CircleAlert />} title={title} message={message} hint={list.error.hint} action={<Button onClick={list.reload}>Try again</Button>} />
        </OnePane>
      </WorkScreen>
    );
  }
  if (!list.data) {
    return (
      <WorkScreen header={<Header />}>
        <OnePane label="Your principles">
          <div role="status" aria-label="Reading your principles" aria-busy="true" className="flex flex-col gap-8">
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
        </OnePane>
      </WorkScreen>
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
      <WorkScreen header={<Header />}>
        <OnePane label="Your principles" width="reading">
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
        </OnePane>
        {dialogs}
      </WorkScreen>
    );
  }

  const actions = (
    <>
      <Button onClick={() => setForm({ mode: "add" })}>
        <Plus aria-hidden="true" />
        Add a principle
      </Button>
      {publishOffered(state) ? (
        <Button variant={state === "newer-elsewhere" ? "secondary" : "primary"} onClick={() => setPublishing(true)}>
          <Upload aria-hidden="true" />
          {publishLabel(state)}
        </Button>
      ) : null}
    </>
  );

  return (
    <WorkScreen header={<Header identity={<span>{countWords(active.length, retired.length)}</span>} actions={actions} />}>
      <WorkPanes>
        <WorkPane label="Your principles">
          <div className="flex flex-col gap-5">
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

            <Parts label="Your principles" open={open} onOpenChange={setOpen}>
              <Part id="in-force" name="In force" summary={inForceSummary(active.length)}>
                {active.length ? (
                  <ul className="flex flex-col">
                    {active.map((principle) => (
                      <PrincipleEntry key={principle.id} principle={principle} onChange={() => setForm({ mode: "change", principle })} onRetired={afterAct} />
                    ))}
                  </ul>
                ) : (
                  <Button className="self-start" onClick={() => setForm({ mode: "add" })}>
                    <Plus aria-hidden="true" />
                    Add a principle
                  </Button>
                )}
              </Part>
              {toCheck.length ? (
                <Part id="to-check" name="Slices to check" summary={toCheckSummary(toCheck)}>
                  <div className="flex flex-col gap-3">
                    <Text size="body-sm" tone="muted" className="max-w-reading">
                      Nothing is reopened for you: check each one&apos;s answers.
                    </Text>
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
                  </div>
                </Part>
              ) : null}
              {retired.length ? (
                <Part id="retired" name="Retired" summary={retiredSummary(retired.map((p) => p.id))}>
                  <div className="flex flex-col gap-4">
                    <Text size="body-sm" tone="muted" className="max-w-reading">
                      They stay listed, and are published, so their numbers are never used again.
                    </Text>
                    <ul className="flex flex-col">
                      {retired.map((principle) => (
                        <PrincipleEntry key={principle.id} principle={principle} />
                      ))}
                    </ul>
                  </div>
                </Part>
              ) : null}
            </Parts>
          </div>
        </WorkPane>
        <WorkPane side label="With the builders">
          <div className="flex flex-col gap-6">
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
            <PublishedPanel state={state} list={data} active={active.length} retired={retired.length} checking={refresh.loading} onCheckGithub={() => void refresh.run().then(afterAct)} />
          </div>
        </WorkPane>
      </WorkPanes>
      {dialogs}
    </WorkScreen>
  );
}
