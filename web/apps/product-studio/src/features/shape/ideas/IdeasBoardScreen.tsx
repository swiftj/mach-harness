import { useState, type ReactNode } from "react";
import { CircleAlert, Lightbulb, Plus } from "lucide-react";
import { Badge, Banner, Button, EmptyState, ErrorState, Heading, Skeleton, Text, describeError } from "@mach/ui";
import type { IdeaRow } from "@mach/ui/api";
import { Fold } from "../../../shared/layout/Fold";
import { ContextRow, OnePane, WorkBoard, WorkScreen } from "../../../shared/layout/WorkScreen";
import { useIdeaBoard } from "../shell/useIdea";
import { AddIdeaDialog } from "./AddIdeaDialog";
import { IdeaCard } from "./IdeaCard";
import { boardColumns, ideaCount, stages, type BoardColumn } from "./model";

const TITLE = "Shape";
const LEAD = "Where an idea is explored, argued for, sized and turned into epics. You decide at every step; MACH checks. Nothing here reaches the builders.";
const ABOUT = (
  <>
    <span className="block">{LEAD}</span>
    <span className="mt-2 block">Everything that might become work, wherever it came from. Saying no loses nothing: the verdict is kept with its reason and the idea stays on the board.</span>
  </>
);

/**
 * Shape's ideas board: every idea, wherever it came from, at one of its five places, with the engine's next step for
 * each; and adding one, on the product manager's word. A project with no ideas sees one quiet invitation.
 *
 * Data: the shared status's `ideas` (useIdeaBoard), `idea.show` for a decided idea's reason, `request.list` for what
 * an idea can start from, `idea.add`. The engine names every place, verdict and next step and keeps the order; the
 * board shows them as reported and never ranks an idea. Fixtures: ?fixture=status.ideas (the board; any
 * status.ideas-* works), no parameter for the empty board, ?add=refused-twice|refused-not-template, ?refuse=idea.add.
 */
export function IdeasBoardScreen() {
  const { board, loading, error, reload } = useIdeaBoard();
  const [adding, setAdding] = useState(false);

  const addButton = (first: boolean) => (
    <Button variant="primary" onClick={() => setAdding(true)}>
      <Plus aria-hidden="true" />
      {first ? "Add the first idea" : "Add an idea"}
    </Button>
  );
  const dialog = <AddIdeaDialog open={adding} onOpenChange={setAdding} onAdded={reload} />;
  const header = (actions?: ReactNode, identity?: ReactNode) => <ContextRow identity={identity} title={TITLE} about={ABOUT} actions={actions} />;

  if (loading) {
    return (
      <WorkScreen header={header()}>
        <BoardArea>
          <div role="status" aria-label="Reading your ideas" aria-busy="true" className="grid min-w-[58rem] grid-cols-5 gap-3">
            {stages.map((stage) => (
              <div key={stage} className="flex flex-col gap-3 rounded-md bg-surface-sunken p-3">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-28 w-full" />
              </div>
            ))}
          </div>
        </BoardArea>
      </WorkScreen>
    );
  }

  if (!board && error) {
    const shown = error.kind === "refused" ? { title: "Your ideas could not be read", message: error.message } : describeError(error);
    return (
      <WorkScreen header={header()}>
        <OnePane label="Ideas">
          <ErrorState icon={<CircleAlert />} title={shown.title} message={shown.message} hint={error.hint} action={<Button onClick={reload}>Try again</Button>} />
        </OnePane>
      </WorkScreen>
    );
  }

  if (!board || board.ideas.length === 0) {
    return (
      <WorkScreen header={header()}>
        <OnePane label="Ideas">
          <EmptyState
            icon={<Lightbulb />}
            title="No ideas yet"
            description="Shape is optional. It is a place to think an idea through before any epic exists: explore it, write a short brief, make the case and record your verdict. Add one whenever you have something worth that thought."
            action={addButton(true)}
          />
        </OnePane>
        {dialog}
      </WorkScreen>
    );
  }

  const { columns, elsewhere } = boardColumns(board);
  return (
    <WorkScreen header={header(addButton(false), <span>{ideaCount(board.ideas.length)}. Ideas appear here only when you add them.</span>)}>
      <BoardArea
        above={
          board.unreadable?.length ? (
            <Banner tone="warning" title={board.unreadable.length === 1 ? "1 idea could not be read" : `${board.unreadable.length} ideas could not be read`}>
              <span className="block">The rest of the board is shown as recorded. The files that could not be read are left as they are.</span>
              <Fold label={`Files that could not be read: ${board.unreadable.length}`} className="mt-2">
                <ul className="flex flex-col gap-0.5 font-mono text-mono">
                  {board.unreadable.map((file) => (
                    <li key={file} translate="no">
                      {file}
                    </li>
                  ))}
                </ul>
              </Fold>
            </Banner>
          ) : null
        }
      >
        <h2 id="ideas-heading" className="sr-only">
          Ideas
        </h2>
        <div className="grid min-w-[58rem] grid-cols-5 gap-3">
          {columns.map((column) => (
            <StageColumn key={column.stage} column={column} />
          ))}
        </div>
        {elsewhere.length ? <OtherPlaces rows={elsewhere} /> : null}
      </BoardArea>
      {dialog}
    </WorkScreen>
  );
}

/** The board's area (style guide 8.9): the columns in one region that scrolls on its own, under the "more below" rule. */
function BoardArea({ above, children }: { above?: ReactNode; children: ReactNode }) {
  return (
    <WorkBoard label="Ideas board" above={above}>
      {children}
    </WorkBoard>
  );
}

function StageColumn({ column }: { column: BoardColumn }) {
  const headingId = `stage-${column.stage}`;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 rounded-md bg-surface-sunken px-3 pb-3">
      {/* The column's heading stays in view while the board scrolls down, so every column's count is always seen. */}
      <div className="sticky top-0 z-10 -mx-3 flex flex-col gap-0.5 rounded-t-md bg-surface-sunken px-3.5 pb-1 pt-3">
        <h3 id={headingId} className="flex items-center gap-2 text-label text-ink">
          {column.words}
          <Badge>
            {column.rows.length}
            <span className="sr-only">{column.rows.length === 1 ? " idea" : " ideas"}</span>
          </Badge>
        </h3>
        <p className="text-caption text-ink-muted">{column.meaning}</p>
      </div>
      {column.rows.length ? (
        <ul className="flex flex-col gap-2.5">
          {column.rows.map((row) => (
            <li key={row.idea_id}>
              <IdeaCard row={row} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed border-line-strong px-3 py-4 text-caption text-ink-subtle">No idea here now.</p>
      )}
    </section>
  );
}

/** Ideas at a place this app does not know: shown, never dropped. */
function OtherPlaces({ rows }: { rows: IdeaRow[] }) {
  return (
    <section aria-labelledby="ideas-elsewhere" className="flex flex-col gap-3">
      <Heading level={3} size="title-3" id="ideas-elsewhere">
        At another place
      </Heading>
      <ul className="grid grid-cols-3 gap-3">
        {rows.map((row) => (
          <li key={row.idea_id} className="flex flex-col gap-1">
            <Text size="caption" tone="muted">
              {row.stage_words}
            </Text>
            <IdeaCard row={row} />
          </li>
        ))}
      </ul>
    </section>
  );
}
