import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Search } from "lucide-react";
import { ArtifactId, Badge, Heading, RelativeTime, Text } from "@mach/ui";
import type { EpicCurrent, IdeaLookups, IdeaRow, LookupShippedRule } from "@mach/ui/api";
import { client } from "../../../api/client";
import { useOperation } from "../../../api/useOperation";
import { ideaPath } from "../shell/steps";
import { Fold } from "../../../shared/layout/Fold";
import { lookupsView, policyFacts, principleStatement, ruleEpics, ruleWords, type LookupEntry, type LookupGroup } from "./model";

/**
 * "What MACH looked up", from `idea show`'s lookups, in three groups, presented as looked up and never asked. A rule's
 * own words come from its epic's current view (`epic.current`), a principle's from the principles, and a policy
 * statement's text and owner from the policy packs; where any of those cannot be read, the ID and MACH's note stand.
 */
export function LookedUp({ lookups, board }: { lookups: IdeaLookups | null; board: IdeaRow[] }) {
  const view = lookupsView(lookups);
  const rules = view.groups[0]?.entries.flatMap((e) => (e.kind === "rule" ? [e.rule] : [])) ?? [];
  const inTheWay = view.groups[2]?.entries ?? [];
  const principles = useOperation("principle.list", inTheWay.some((e) => e.kind === "principle") ? {} : null);
  const policies = useOperation("policy.list", inTheWay.some((e) => e.kind === "policy") ? {} : null);

  return (
    <section aria-labelledby="looked-up-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Heading level={2} size="title-3" id="looked-up-title">
          What MACH looked up
        </Heading>
        <Text size="body-sm" tone="muted">
          Found in the shipped specs, other ideas and requests, your principles and your policy packs. None of this is asked of you.
        </Text>
        {view.recordedAt ? (
          <Text size="caption" tone="subtle">
            Recorded <RelativeTime iso={view.recordedAt} />
          </Text>
        ) : null}
      </div>
      {view.state === "none" ? (
        <div className="flex items-start gap-3 rounded-md border border-dashed border-line-strong px-4 py-4">
          <Search aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
          <div className="flex flex-col gap-1">
            <p className="text-body font-semibold text-ink">Nothing looked up yet</p>
            <Text size="body-sm" tone="muted">
              The conversation looks up the rules already shipped, similar ideas and requests, and the principles and policies in the way, as soon as the idea is clear enough to search for. They appear here.
            </Text>
          </div>
        </div>
      ) : (
        view.groups.map((group) =>
          group.key === "today" ? (
            <Group key={group.key} group={group}>
              <RuleList rules={rules} />
            </Group>
          ) : (
            <Group key={group.key} group={group}>
              <ul className="flex flex-col">
                {group.entries.map((entry) => entry.kind === "rule" ? null : (
                  <Entry key={entry.key} entry={entry} board={board} principles={principles.data} policies={policies.data} />
                ))}
              </ul>
            </Group>
          ),
        )
      )}
      {view.idsOnly ? (
        <Text size="caption" tone="subtle">
          Only the identifiers were reported, so MACH's notes are not shown.
        </Text>
      ) : null}
    </section>
  );
}

/** One group, folded behind its name and how many it holds (M16 layout), as a heading, so its state shows without opening it. */
function Group({ group, children }: { group: LookupGroup; children: ReactNode }) {
  const n = group.entries.length;
  return (
    <div>
      <Fold boxed heading={3} label={`${group.title}: ${n}`}>
        <div className="flex flex-col gap-2">
          <Text size="caption" tone="subtle">
            {group.about}
          </Text>
          {n ? (
            children
          ) : (
            <Text size="body-sm" tone="muted">
              Nothing recorded here. That is not a finding: what is unknown is asked, or left as an open question.
            </Text>
          )}
        </div>
      </Fold>
    </div>
  );
}

/** The shipped rules in the order recorded, each with its own words where its epic's current view holds them. */
function RuleList({ rules }: { rules: LookupShippedRule[] }) {
  const views = useEpicViews(ruleEpics(rules));
  return (
    <ul className="flex flex-col">
      {rules.map((rule) => (
        <RuleEntry key={rule.rule} rule={rule} words={rule.epic_id ? ruleWords(views[rule.epic_id], rule.rule) : null} />
      ))}
    </ul>
  );
}

/** Each named epic's current view, read once; one that cannot be read is left out (its rules keep their ID and note). */
function useEpicViews(epics: string[]): Record<string, EpicCurrent> {
  const [views, setViews] = useState<Record<string, EpicCurrent>>({});
  const key = epics.join(" ");
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    for (const epicId of key.split(" ")) {
      client.op("epic.current", { epic_id: epicId }, controller.signal).then(
        (view) => setViews((all) => ({ ...all, [epicId]: view })),
        () => undefined,
      );
    }
    return () => controller.abort();
  }, [key]);
  return views;
}

const itemClass = "flex flex-col gap-1 border-t border-line py-2.5 last:pb-0";

function RuleEntry({ rule, words }: { rule: LookupShippedRule; words: string | null }) {
  return (
    <li className={itemClass}>
      <span className="flex flex-wrap items-center gap-2">
        <ArtifactId>{rule.rule}</ArtifactId>
        {rule.in_force ? null : <Badge tone="warning">No longer in force</Badge>}
      </span>
      {words ? <span className="text-body-sm text-ink">{words}</span> : null}
      {rule.note ? <Note text={rule.note} /> : null}
      {rule.epic_id ? (
        <Link to={`/epics/${encodeURIComponent(rule.epic_id)}/today`} className="self-start rounded-xs text-body-sm text-accent-ink underline-offset-2 hover:underline">
          How <span translate="no">{rule.epic_id}</span> works today
        </Link>
      ) : null}
    </li>
  );
}

/** MACH's note for a lookup: bounded and redacted by the engine, shown as plain text. */
function Note({ text }: { text: string }) {
  return <span className="whitespace-pre-wrap break-words text-caption text-ink-muted">MACH noted: {text}</span>;
}

function Entry({
  entry,
  board,
  principles,
  policies,
}: {
  entry: Exclude<LookupEntry, { kind: "rule" }>;
  board: IdeaRow[];
  principles: Parameters<typeof principleStatement>[0];
  policies: Parameters<typeof policyFacts>[0];
}) {
  switch (entry.kind) {
    case "similar": {
      const { similar } = entry;
      const row = similar.idea ? board.find((r) => r.idea_id === similar.idea) : undefined;
      return (
        <li className={itemClass}>
          {similar.idea ? (
            <span className="flex flex-wrap items-baseline gap-2">
              <Badge>Idea</Badge>
              <Link to={ideaPath(similar.idea)} className="rounded-xs text-body-sm text-accent-ink underline-offset-2 hover:underline">
                <span translate="no" className="font-mono">
                  {similar.idea}
                </span>
                {row ? ` ${row.title}` : null}
              </Link>
              {row ? <span className="text-caption text-ink-muted">{row.stage_words}</span> : null}
            </span>
          ) : (
            <span className="flex flex-wrap items-baseline gap-2">
              <Badge>Request</Badge>
              <span className="font-mono text-body-sm text-ink" translate="no">
                #{similar.request}
              </span>
            </span>
          )}
          {similar.note ? <Note text={similar.note} /> : null}
        </li>
      );
    }
    case "principle": {
      const { principle } = entry;
      const statement = principleStatement(principles, principle.id);
      return (
        <li className={itemClass}>
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="warning">Principle</Badge>
            <ArtifactId>{principle.id}</ArtifactId>
          </span>
          {statement ? <span className="text-body-sm text-ink">{statement}</span> : null}
          {principle.note ? <Note text={principle.note} /> : null}
        </li>
      );
    }
    case "policy": {
      const { policy } = entry;
      const facts = policyFacts(policies, policy.id);
      // The owner the lookups recorded (the pack's, by the engine); the policy list's where an older lookup has none.
      const owner = policy.owner ?? facts?.owner ?? null;
      return (
        <li className={itemClass}>
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="warning">Policy</Badge>
            <ArtifactId>{policy.id}</ArtifactId>
          </span>
          {facts?.text ? <span className="text-body-sm text-ink">{facts.text}</span> : null}
          {facts?.title || owner ? (
            <span className="text-caption text-ink-muted">
              {facts ? (facts.title ?? facts.pack) : null}
              {facts && owner ? ", " : ""}
              {owner ? `owned by ${owner}` : ""}
            </span>
          ) : null}
          {policy.note ? <Note text={policy.note} /> : null}
        </li>
      );
    }
  }
}
