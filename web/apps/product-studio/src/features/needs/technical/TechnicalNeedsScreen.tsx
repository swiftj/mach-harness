import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CircleAlert, FileText, ListChecks, Plus, Upload } from "lucide-react";
import { Banner, Button, ErrorState, Heading, HintAction, Skeleton, SkeletonText, Spinner, Text, describeError } from "@mach/ui";
import type { MachApiError, NeedChanged, NeedKind, NeedList } from "@mach/ui/api";
import { useRefresh, useStatus } from "../../../api/store";
import { ContextRow, OnePane, WorkPane, WorkPanes, WorkScreen } from "../../../shared/layout/WorkScreen";
import { DESIGNS_LABEL, DESIGNS_PATH, NEEDS_LABEL } from "../shell/paths";
import { useNeedList } from "../shell/useNeeds";
import { useNeedsConversation, type ConversationController } from "../shell/useNeedsConversation";
import { answeredWords, isEmpty, isNeedsReconcileHint, kindViews, publishLabel, publishOffered, publishState, retiredNeeds, type PublishOutcome } from "./model";
import { NeedForm, type NeedFormState } from "./NeedForm";
import { KindList, RetiredNeeds } from "./NeedsList";
import { NeedsConversation, NeedsConversationHeader, conversationBusy } from "./NeedsConversation";
import { PublishNeedsDialog, PublishedState, ReconcileNeedsChoice } from "./PublishNeeds";

const ABOUT =
  "A technical need says what the product requires of whatever is built, in your own words and without naming a technology: who uses it, what it keeps, what it must work with, what must never happen, what wins in a conflict, and what was already decided elsewhere. The engineer reads the needs you publish. Only a decision an engineer accepts chooses a technology.";

function Header({ actions }: { actions?: ReactNode }) {
  return <ContextRow title={NEEDS_LABEL} about={ABOUT} actions={actions} />;
}

/**
 * Technical needs (M17 part D), the product manager's page. In two panes, as the guided question screen has them
 * (style guide 8.10, M16 layout): the needs conversation on the left, and the needs it records beside it, the six
 * kinds in their fixed order with each one's question, its needs, "nothing to say" or not answered yet. The page's
 * acts (add a need, publish) are in the context row; each need's own acts are under it. Every act waits while the
 * conversation writes. The decisions the engineers recorded are shown read only, where the engine flags one as written
 * for an older revision of a need; no act on a decision is shown or offered.
 *
 * Reads `need.list`; acts `need.add`, `need.set`, `need.retire`, `need.none`, `need.publish`, `reconcile.needs`, each
 * a person's act confirmed in a dialog; `refresh` to check GitHub. Fixtures: ?needs=empty|several|adr-behind|
 * newer-elsewhere|answered-some|published, ?need-add=, ?need-set=, ?need-none=, ?publish-needs=, ?reconcile-needs=,
 * ?refuse=<operation>, and the scripted conversation's ?speed=fast and ?conversation=unavailable|conflict|refused.
 */
export function TechnicalNeedsScreen() {
  const list = useNeedList();
  const conv = useNeedsConversation();

  // The conversation recorded a need or "nothing to say": read the needs again. Several writes arrive close together.
  const reload = list.reload;
  const changes = conv.model.draftChanges;
  useEffect(() => {
    if (!changes) return;
    const timer = setTimeout(reload, 400);
    return () => clearTimeout(timer);
  }, [changes, reload]);

  if (!list.data && list.error) {
    const { title, message } = list.error.kind === "refused" ? { title: "Your technical needs could not be read", message: list.error.message } : describeError(list.error);
    return (
      <WorkScreen header={<Header />}>
        <OnePane label="Your technical needs" width="reading">
          <ErrorState icon={<CircleAlert />} title={title} message={message} hint={list.error.hint} action={<Button onClick={list.reload}>Try again</Button>} />
        </OnePane>
      </WorkScreen>
    );
  }
  if (!list.data) {
    return (
      <WorkScreen header={<Header />}>
        <OnePane label="Your technical needs">
          <div role="status" aria-label="Reading your technical needs" aria-busy="true" className="flex flex-col gap-8">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-3">
                <Skeleton className="h-6 w-56" />
                <SkeletonText lines={2} />
              </div>
            ))}
          </div>
        </OnePane>
      </WorkScreen>
    );
  }
  return <Needs data={list.data} reading={list.loading} reload={list.reload} conv={conv} />;
}

function Needs({ data, reading, reload, conv }: { data: NeedList; reading: boolean; reload: () => void; conv: ConversationController }) {
  const status = useStatus();
  const refresh = useRefresh();
  const [form, setForm] = useState<NeedFormState>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishFailure, setPublishFailure] = useState<MachApiError | null>(null);
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);
  const [noted, setNoted] = useState<{ id: string; warnings: string[] } | null>(null);
  const choiceRef = useRef<HTMLElement>(null);
  const goToChoice = useRef(false);

  const busy = conversationBusy(conv);
  const state = publishState(data);
  const kinds = kindViews(data);
  const retired = retiredNeeds(data);
  const empty = isEmpty(data);
  const showChoice = state === "newer-elsewhere" || isNeedsReconcileHint(publishFailure?.hint);
  const taken = refresh.data?.needs_taken ?? null;

  const saved = (result: NeedChanged) => {
    setNoted(result.warnings?.length ? { id: result.need.need_id, warnings: result.warnings } : null);
    reload();
  };
  const addKind = (kind?: NeedKind) => setForm({ mode: "add", kind: kind ?? data.unanswered[0] ?? "people" });
  const checkGithub = () => void refresh.run().then(reload);

  const actions = (
    <>
      <Button disabled={busy} onClick={() => addKind()}>
        <Plus aria-hidden="true" />
        Add a need
      </Button>
      {publishOffered(state) ? (
        <Button variant={state === "newer-elsewhere" ? "secondary" : "primary"} disabled={busy} onClick={() => setPublishing(true)}>
          <Upload aria-hidden="true" />
          {publishLabel(state)}
        </Button>
      ) : null}
    </>
  );

  return (
    <WorkScreen header={<Header actions={actions} />}>
      <WorkPanes split="conversation">
        <WorkPane label="The conversation" width="column" header={<NeedsConversationHeader conv={conv} />}>
          <NeedsConversation conv={conv} />
        </WorkPane>
        <WorkPane side label="Your technical needs" header={<NeedsHeader data={data} reading={reading} />}>
          <div className="flex min-w-0 flex-col gap-6">
            {busy ? (
              <p role="status" className="flex items-center gap-2 rounded-md border border-dashed border-line-strong px-3 py-2 text-body-sm text-ink-muted">
                <Spinner size="sm" />
                The conversation is writing. Adding, changing, retiring and publishing wait until it has finished.
              </p>
            ) : null}
            {publishFailure && !isNeedsReconcileHint(publishFailure.hint) ? (
              <Banner
                tone="danger"
                title="The technical needs were not published"
                actions={
                  <>
                    <HintAction hint={publishFailure.hint} />
                    <Button size="sm" disabled={busy} onClick={() => setPublishing(true)}>
                      Try again
                    </Button>
                  </>
                }
              >
                <span className="whitespace-pre-line">{publishFailure.kind === "refused" ? publishFailure.message : describeError(publishFailure).message}</span>
                <span className="mt-1 block text-ink-muted">Your needs are safe here and you can keep working. The engineer still has what was published before.</span>
              </Banner>
            ) : null}
            {refresh.error ? (
              <Banner
                tone="warning"
                title="GitHub could not be read"
                actions={
                  <Button size="sm" loading={refresh.loading} onClick={checkGithub}>
                    Try again
                  </Button>
                }
              >
                <span className="whitespace-pre-line">{refresh.error.kind === "refused" ? refresh.error.message : describeError(refresh.error).message}</span>
                <span className="mt-1 block text-ink-muted">Your needs are safe and you can keep working; what is shown about GitHub is from the last time it was read.</span>
              </Banner>
            ) : null}
            {taken ? (
              <Banner tone="info" live="polite" title={`Took version ${taken.revision} of the technical needs from GitHub`}>
                {taken.note}
              </Banner>
            ) : null}
            {noted ? (
              <Banner
                tone="warning"
                title={`${noted.id} is saved. The check noted:`}
                actions={
                  <Button size="sm" variant="ghost" onClick={() => setNoted(null)}>
                    Dismiss
                  </Button>
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
            {showChoice ? (
              <ReconcileNeedsChoice
                ref={choiceRef}
                list={data}
                busy={busy}
                onChosen={() => {
                  setPublishFailure(null);
                  reload();
                }}
              />
            ) : null}

            {empty ? (
              <div className="flex flex-col gap-2">
                <Heading level={2} size="title-3">
                  No technical needs yet
                </Heading>
                <Text className="max-w-reading">
                  Start with the six questions below. Answer them in the conversation, one at a time, or write an answer here yourself. “Nothing to say” is a fine answer, and a question you cannot answer yet can wait.
                </Text>
              </div>
            ) : (
              <PublishedState state={state} list={data} outcome={outcome} checking={refresh.loading} onCheckGithub={checkGithub} />
            )}
            {/* The engine's next step, unless the card above already says it: its own sentence on what is not published. */}
            {!empty && data.next && !publishOffered(state) ? (
              <Text size="body-sm" className="max-w-reading">
                {data.next}
              </Text>
            ) : null}

            <section aria-labelledby="needs-kinds" className="flex flex-col gap-4">
              <Heading level={2} size="title-3" id="needs-kinds" className="sr-only">
                The six kinds
              </Heading>
              <KindList kinds={kinds} acts={{ busy, onAdd: addKind, onChange: (need) => setForm({ mode: "change", need }), onDone: reload }} />
            </section>
            <RetiredNeeds needs={retired} />

            <div className="flex flex-col items-start gap-2 border-t border-line pt-5">
              <Text size="body-sm" tone="muted" className="max-w-reading">
                Your team already wrote down a design? Bring it in, and the conversation can propose the needs it states.
              </Text>
              <Button size="sm" variant="secondary" asChild>
                <Link to={DESIGNS_PATH}>
                  <FileText aria-hidden="true" />
                  {DESIGNS_LABEL}
                </Link>
              </Button>
            </div>
          </div>
        </WorkPane>
      </WorkPanes>
      <NeedForm state={form} onClose={() => setForm(null)} onSaved={saved} />
      <PublishNeedsDialog
        open={publishing}
        onOpenChange={setPublishing}
        list={data}
        label={publishLabel(state)}
        repository={status.data?.github.repository ?? null}
        onPublished={(done) => {
          setPublishFailure(null);
          setOutcome(done);
          reload();
        }}
        onFailed={(error) => {
          setPublishFailure(error);
          reload();
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
    </WorkScreen>
  );
}

/** The needs pane's heading, kept at its top: what it holds and how far the six kinds are answered. */
function NeedsHeader({ data, reading }: { data: NeedList; reading: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <Heading level={2} size="title-3" className="flex items-center gap-2">
        <ListChecks aria-hidden="true" className="size-[18px] text-ink-subtle" />
        Your technical needs
      </Heading>
      <span className="flex items-center gap-2 text-body-sm text-ink-muted" role="status">
        {reading ? <Spinner size="sm" /> : null}
        {reading ? "Reading them again" : answeredWords(data)}
      </span>
    </div>
  );
}
