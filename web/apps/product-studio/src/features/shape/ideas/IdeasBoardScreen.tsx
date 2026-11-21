import { Lightbulb } from "lucide-react";
import { EmptyState } from "@mach/ui";
import { NotBuiltYet, ScreenFrame } from "../../../shared/ScreenFrame";
import { useIdeaBoard } from "../shell/useIdea";

/**
 * Shape's ideas board: every idea, wherever it came from, at one of its five places, with its next step; adding one.
 * A project with no ideas sees one quiet invitation and nothing else.
 *
 * Owned by screen engineer 1 (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 6). Data: the shared status's
 * `ideas` (useIdeaBoard), idea.list, idea.add, idea.stage, request.list for the requests an idea can start from.
 * Fixtures: ?fixture=status.ideas (the board), ?ideas=empty|changed, ?add=refused-twice|refused-not-template.
 */
export function IdeasBoardScreen() {
  const { board } = useIdeaBoard();
  return (
    <ScreenFrame
      title="Shape"
      width="wide"
      lead="Where an idea is explored, argued for, sized and turned into epics. You decide at every step; scripts check. Nothing here reaches the builders."
    >
      {board ? (
        <NotBuiltYet what="The ideas board: every idea at its place, New, Exploring, Brief written, Decided or Shaped into work, with the next step for each." />
      ) : (
        <EmptyState
          icon={<Lightbulb />}
          title="No ideas yet"
          description="Shape is optional. Add an idea here when you want to think it through before any epic: write a brief, make the case and decide."
        />
      )}
    </ScreenFrame>
  );
}
