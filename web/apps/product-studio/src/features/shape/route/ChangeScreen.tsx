import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { GitCommitHorizontal, PencilLine } from "lucide-react";
import { ArtifactId, Banner, Button, ConfirmDialog, EmptyState, Field, Heading, Input, LoadingState, StateGlyph, StatusPill, Text, plain, toast } from "@mach/ui";
import type { EpicCurrent } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { useStatus } from "../../../api/store";
import { useOperation } from "../../../api/useOperation";
import { ContextRow, OnePane, WorkPane, WorkPanes, WorkScreen } from "../../../shared/layout/WorkScreen";
import { ideaPath } from "../shell/steps";
import { changeArgs, connections, epicOfRule, findRule, parseRule, standingWords } from "./model";

const TITLE = "Change what exists";
const LEAD = "Start from a rule that has shipped. Its connected rules are carried in, and the change goes the same way as any idea.";

/**
 * Change what exists: the second way in. A shipped rule (`?rule=SLICE-NNN/FR-NN`, picked with "Change this" on How an
 * epic works today, which also passes `&epic=EPIC-NNN`) becomes a new idea with its connected rules recorded as what was
 * looked up and a starter brief (`idea.change`); then the page goes to the new idea. The rule's words and connections
 * are read with `epic.current`; whether it may be changed is the engine's answer, given when the idea is started.
 * Fixtures: idea.change, ?change=refused-replaced, epic.current (SLICE-001/FR-01 has a connection, SLICE-002/FR-01 none).
 */
export function ChangeScreen() {
  const [params] = useSearchParams();
  const parsed = parseRule(params.get("rule"));
  if (!parsed) return <NoRule given={params.get("rule")} />;
  return <ChangeRule key={parsed.rule} rule={parsed.rule} sliceId={parsed.sliceId} epicParam={params.get("epic")} />;
}

function NoRule({ given }: { given: string | null }) {
  return (
    <WorkScreen header={<ContextRow title={TITLE} about={LEAD} />}>
      <OnePane label="Pick a rule">
        <EmptyState
          className="max-w-reading"
          icon={<PencilLine />}
          title={given ? "That is not a shipped rule's name" : "Pick a rule to change"}
          description="Open how an epic works today from the project home, and choose Change this beside a rule in force. A rule is named like SLICE-001/FR-01."
          action={
            <Button asChild>
              <Link to="/">Go to the project home</Link>
            </Button>
          }
        />
      </OnePane>
    </WorkScreen>
  );
}

function ChangeRule({ rule, sliceId, epicParam }: { rule: string; sliceId: string; epicParam: string | null }) {
  const status = useStatus();
  const epicId = epicOfRule(epicParam, sliceId, status.data?.slices);
  const current = useOperation("epic.current", epicId ? { epic_id: epicId } : null);
  const waitingForEpic = !epicId && !status.data && !status.error;

  return (
    <WorkScreen
      header={
        <ContextRow
          identity={
            <>
              <ArtifactId plain>{rule}</ArtifactId>
              {epicId ? (
                <span>
                  in <ArtifactId plain>{epicId}</ArtifactId>
                </span>
              ) : null}
            </>
          }
          title={TITLE}
          about={LEAD}
        />
      }
    >
      {waitingForEpic || (epicId && !current.data && current.loading) ? (
        <OnePane label={TITLE}>
          <LoadingState label={`Reading ${rule}`} />
        </OnePane>
      ) : (
        <ChangeBody rule={rule} epicId={epicId} current={current.data} readProblem={current.error?.message ?? null} />
      )}
    </WorkScreen>
  );
}

function ChangeBody({ rule, epicId, current, readProblem }: { rule: string; epicId: string | null; current: EpicCurrent | null; readProblem: string | null }) {
  const found = findRule(current?.epic, rule);
  const links = found ? connections(found.rule) : [];
  return (
    // One pane (M16 layout, never a second pane just to fill space): the form is short, so the rule and its
    // connections sit under it, side by side, rather than beside a nearly empty wide pane.
    <WorkPanes>
      <WorkPane label="Start an idea from this rule">
        <div className="flex flex-col gap-8">
        <StartSection rule={rule} />
        <div className="grid grid-cols-2 gap-x-10 gap-y-8 border-t border-line pt-6">
          <section aria-labelledby="rule-heading" className="flex flex-col gap-3">
            <Heading level={2} size="title-3" id="rule-heading">
              The rule
            </Heading>
            {found ? (
              <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-4 py-3.5">
                <span className="flex flex-wrap items-center gap-2">
                  <ArtifactId>{rule}</ArtifactId>
                  <StatusPill
                    tone={found.standing === "no-longer" ? "neutral" : "success"}
                    size="sm"
                    icon={<StateGlyph shape={found.standing === "no-longer" ? "superseded" : "approved"} />}
                    className={found.standing === "no-longer" ? "border-dashed" : undefined}
                  >
                    {standingWords[found.standing]}
                  </StatusPill>
                </span>
                <p className="break-words text-body-lg text-ink">{plain(found.rule.text)}</p>
                <p className="text-caption text-ink-subtle">
                  From <ArtifactId plain>{found.rule.slice_id}</ArtifactId>
                  {epicId ? (
                    <>
                      {" "}
                      in <ArtifactId plain>{epicId}</ArtifactId>
                    </>
                  ) : null}
                </p>
                {found.standing === "no-longer" && found.rule.now?.length ? (
                  <div className="mt-1 flex flex-col gap-1 rounded-sm bg-surface-sunken px-3 py-2">
                    <span className="text-caption font-semibold text-ink-muted">What holds now</span>
                    {found.rule.now.map((n) => (
                      <p key={n.rule} className="text-body-sm text-ink">
                        <ArtifactId plain className="mr-1.5">
                          {n.rule}
                        </ArtifactId>
                        {plain(n.text)}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-2 rounded-md border border-dashed border-line-strong bg-canvas px-4 py-3.5">
                <ArtifactId className="self-start">{rule}</ArtifactId>
                <p className="text-body-sm text-ink">
                  {current?.epic
                    ? `${rule} is not among the rules MACH read for ${epicId} on this computer.`
                    : readProblem
                      ? `Its words could not be read here: ${readProblem}`
                      : epicId
                        ? `Nothing in ${epicId} has shipped on this computer, so its words could not be read here.`
                        : "Its epic is not known here, so its words could not be read."}{" "}
                  MACH checks the rule when you start: if it is not shipped and in force, it says so and nothing is started.
                </p>
              </div>
            )}
            {current ? (
              <p className="flex items-start gap-2 text-body-sm text-ink-muted">
                <GitCommitHorizontal aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
                <span>{current.note}</span>
              </p>
            ) : null}
          </section>

          {found ? (
            <section aria-labelledby="connected-heading" className="flex flex-col gap-3">
              <Heading level={2} size="title-3" id="connected-heading">
                Connected rules MACH carries in
              </Heading>
              {links.length ? (
                <>
                  <Text size="body-sm" tone="muted">
                    The new idea records these as what it touches: the rules in force of each slice that declared this rule kept, and the rules it took the place of. MACH
                    reads the full list when you start.
                  </Text>
                  <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-canvas">
                    {links.map((c) => (
                      <li key={`${c.kind}-${c.id}`} className="flex flex-col gap-0.5 px-4 py-3">
                        <span className="flex flex-wrap items-center gap-2 text-body-sm text-ink">
                          <ArtifactId plain>{c.id}</ArtifactId>
                          <span>{c.words}</span>
                        </span>
                        {c.note ? <span className="text-body-sm text-ink-muted">{c.note}</span> : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <Text size="body-sm" tone="muted">
                  No other shipped rule is connected to it: no slice declared it kept, and it took no earlier rule's place. MACH carries in this rule alone.
                </Text>
              )}
            </section>
          ) : null}
        </div>
      </div>
      </WorkPane>
    </WorkPanes>
  );
}

/** Start the idea (`idea.change`), on the product manager's word, confirmed; then go to the new idea. */
function StartSection({ rule }: { rule: string }) {
  const act = useEngineAct();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  const confirm = async () => {
    const started = await act.run("idea.change", changeArgs(rule, title));
    if (!started) return false;
    toast({ tone: "success", title: `Started ${started.idea_id}`, description: started.next });
    navigate(ideaPath(started.idea_id));
    return true;
  };

  return (
    <section aria-labelledby="start-heading" className="flex flex-col gap-4 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex flex-col gap-1">
        <Heading level={2} id="start-heading" size="title-3">
          Start an idea from this rule
        </Heading>
        <Text size="body-sm" tone="muted">
          This starts an idea like any other: the same brief, verdict and sizing, with no shortcut.
        </Text>
      </div>
      <Field label="Title" optional hint={`One line, at most 120 characters. Left empty, it is called “Change ${rule}”.`}>
        <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div>
        <Button
          variant="primary"
          onClick={() => {
            act.reset();
            setOpen(true);
          }}
        >
          Start an idea from {rule}
        </Button>
      </div>
      {act.error && !open ? (
        <Banner tone="danger" title="Not started">
          {act.shown?.message}
        </Banner>
      ) : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Start an idea from ${rule}?`}
        description="MACH adds a new idea at Exploring, records this rule and the rules connected to it as what it looked up, and writes a starter brief for you to fill in: why the rule should change and what changes. Nothing shipped changes, and nothing is sent or started."
        confirmLabel="Start the idea"
        onConfirm={confirm}
        error={act.shown ? { ...act.shown, title: act.error?.kind === "refused" ? "Not started" : act.shown.title } : null}
      />
    </section>
  );
}
