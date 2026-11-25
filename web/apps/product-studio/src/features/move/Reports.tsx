import { Link } from "react-router";
import { ArtifactId, Banner, Button, Disclosure, Heading, Text } from "@mach/ui";
import { renumberedPreview, type DoneView, type ImportView, type Renumbered } from "./model";
import { List } from "./List";

/**
 * What a project brought in holds and what changes, as the engine reported it: first the plan (nothing brought in yet),
 * then the same parts again as the report once it is in. Every sentence is the engine's.
 */
export function PlanReport({ view, resuming, into }: { view: ImportView; resuming: boolean; into: string | null }) {
  return (
    <section aria-labelledby="move-plan-title" className="flex flex-col gap-5 rounded-md border border-line bg-surface px-6 py-5">
      <div className="flex flex-col gap-1">
        <Text size="caption" tone="subtle">
          What would come in · nothing is brought in yet
        </Text>
        <Heading level={3} size="title-2" id="move-plan-title">
          “{view.name}”
        </Heading>
        <Text size="body-sm" tone="muted">
          From <span translate="no">{view.fileName}</span>
        </Text>
      </div>
      {resuming ? (
        <Banner tone="info" title="This file was being brought in and stopped part way">
          Bringing it in now finishes it. MACH repeats nothing it already brought in.
        </Banner>
      ) : null}
      <Facts view={view} into={into} />
      <Text className="max-w-reading">{view.note}</Text>
      <Changes view={view} />
    </section>
  );
}

export function ImportReport({ view }: { view: DoneView }) {
  return (
    <section
      aria-labelledby="move-done-title"
      tabIndex={-1}
      className="flex flex-col gap-5 rounded-md border border-line bg-surface px-6 py-5 outline-none"
    >
      <div className="flex flex-col gap-1" aria-live="polite">
        <Text size="caption" tone="subtle">
          Brought in
        </Text>
        <Heading level={3} size="title-2" id="move-done-title">
          “{view.name}” is here
        </Heading>
      </div>
      <Text className="max-w-reading">{view.note}</Text>
      {view.structuralErrors.length ? (
        <Banner tone="danger" title="The workspace has problems it did not have before">
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {view.structuralErrors.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <Facts view={view} into={null} done />
      <List title="Marked ready to build" items={view.markedReady} />
      <List title="Kept as you left them" items={view.keptYours} />
      <List title="Numbers that moved since you looked" items={view.numbersMoved} />
      <Changes view={view} done />
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <h4 className="text-label text-ink">What to do next</h4>
        {view.after.length ? (
          <ol className="flex max-w-reading list-decimal flex-col gap-1 pl-5 text-body-sm text-ink">
            {view.after.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        ) : (
          <Text size="body-sm" className="max-w-reading">
            Check each slice and mark it ready when it is right.
          </Text>
        )}
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" asChild>
            <Link to="/">Open the project home</Link>
          </Button>
          {view.after.some((line) => /principles/i.test(line)) ? (
            <Button asChild>
              <Link to="/principles">Publish the principles</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Whether it joins or becomes the project, what it holds, its slices and where each was, and the new numbers. */
function Facts({ view, into, done = false }: { view: ImportView; into: string | null; done?: boolean }) {
  const joins = done ? "It joined this project as more epics." : `It joins ${into ?? "your project"} as more epics.`;
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid max-w-reading gap-x-6 gap-y-2 text-body-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="font-semibold text-ink-muted">Where it goes</dt>
        <dd className="text-ink">{view.mode === "join" ? joins : done ? "It became the project here." : "It becomes the project here."}</dd>
        <dt className="font-semibold text-ink-muted">{done ? "Brought in" : "Comes in"}</dt>
        <dd className="text-ink">{view.holds}</dd>
        <dt className="font-semibold text-ink-muted">Ready there</dt>
        <dd className="text-ink">
          {view.readyThere === 0
            ? "No slice was marked ready in the old repository."
            : `${view.readyThere === 1 ? "1 slice was" : `${view.readyThere} slices were`} marked ready or further in the old repository. Here every slice is a draft unless you chose otherwise.`}
        </dd>
      </dl>
      <NewNumbers view={view} done={done} />
      {view.slices.length ? (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-label text-ink">Slices</h4>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-canvas">
            {view.slices.map((slice) => (
              <li key={slice.from} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-body-sm">
                <ArtifactId>{slice.to}</ArtifactId>
                <span className="min-w-0 flex-1 break-words font-semibold text-ink">{slice.title}</span>
                <span className="text-ink-muted">
                  {slice.status_here === "superseded" ? "Stays replaced; " : ""}
                  {slice.was_words}
                  {slice.from !== slice.to ? (
                    <>
                      {" "}
                      (was <ArtifactId plain>{slice.from}</ArtifactId>)
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Pair({ pair }: { pair: Renumbered }) {
  return (
    <>
      <ArtifactId plain>{pair.from}</ArtifactId> becomes <ArtifactId plain>{pair.to}</ArtifactId>
    </>
  );
}

function NewNumbers({ view, done }: { view: ImportView; done: boolean }) {
  const { first, more } = renumberedPreview(view.renumbered);
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-label text-ink">New numbers</h4>
      {view.renumberedWords ? (
        <>
          <Text size="body-sm" className="max-w-reading">
            {view.renumberedWords} so they do not clash with what is here{done ? "" : ", for example"}:
          </Text>
          <ul className="flex flex-col gap-1 text-body-sm text-ink">
            {first.map((pair) => (
              <li key={pair.from}>
                <Pair pair={pair} />
              </li>
            ))}
          </ul>
          {more ? (
            <Disclosure summary={`Show every new number (${view.renumbered.length})`} className="max-w-reading">
              <ul className="grid gap-1 sm:grid-cols-2">
                {view.renumbered.map((pair) => (
                  <li key={pair.from}>
                    <Pair pair={pair} />
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
        </>
      ) : (
        <Text size="body-sm" className="max-w-reading">
          The numbers stay as they are.
        </Text>
      )}
      {view.whyNumbered.map((line) => (
        <Text key={line} size="body-sm" tone="muted" className="max-w-reading">
          {line}
        </Text>
      ))}
      {view.numbersNote ? (
        <Text size="body-sm" tone="muted" className="max-w-reading">
          {view.numbersNote}
        </Text>
      ) : null}
      {view.notes.map((line) => (
        <Text key={line} size="body-sm" tone="muted" className="max-w-reading">
          {line}
        </Text>
      ))}
    </div>
  );
}

/** What stays behind and what to check by hand. Each list appears only when the engine reported something in it. */
function Changes({ view, done = false }: { view: ImportView; done?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <List title={done ? "Left behind" : "Stays behind"} items={view.leftBehind} />
      <List
        title="Check these by hand"
        note="An ID inside quoted code, or with more letters or digits after it, is left as written."
        items={view.checkByHand}
      />
      <List
        title="Named in the text, but not in the file"
        note={view.mode === "join" ? "Here each of these numbers is, or will be, a different item." : undefined}
        items={view.notInArchive}
      />
      <List title="Links taken out" items={view.linksDropped} />
      <List title="Sections about shipped behaviour to answer again here" items={view.shippedRules} />
      <List title="Principles that say the same thing" items={view.samePrinciples} />
      <List title="Principles recorded as not assessed" items={view.notAssessed} />
      <List title="Answers on technical needs not brought in" items={view.needsNoneLeftBehind} />
      {done ? null : <List title="Afterwards" items={view.after} />}
    </div>
  );
}
