import { useSearchParams } from "react-router";
import { NotBuiltYet, ScreenFrame } from "../../../shared/ScreenFrame";

/**
 * Change what exists: the second way in. A shipped rule, picked on "How this epic works today", becomes a new idea
 * with its lookups and a starter brief (`idea.change`), then goes the same way as any idea.
 *
 * Owned by screen engineer 5 (docs/mach-next/M16_SHAPE_APP_FOUNDATION.md section 6), with the one "Change this"
 * entry on features/epic-today/EpicTodayScreen.tsx that leads here as /shape/change?rule=SLICE-NNN/RULE.
 * Data: idea.change, epic.current. Fixtures: idea.change, ?change=refused-replaced, ?idea=change.
 */
export function ChangeScreen() {
  const rule = useSearchParams()[0].get("rule");
  return (
    <ScreenFrame title="Change what exists" lead="Start from a rule that has shipped. Its connected rules are filled in, and the change is sized the same way as any idea.">
      <NotBuiltYet what={rule ? `A change to ${rule}: why, and what changes.` : "Pick a rule on How an epic works today, then choose Change this."} />
    </ScreenFrame>
  );
}
