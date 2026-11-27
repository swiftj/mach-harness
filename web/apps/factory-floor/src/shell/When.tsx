/**
 * A moment on the Factory Floor. Real history: the shared <Moment> ("Today 14:53", "24 Nov 20:02 · 3 d
 * ago"), with the full date, time and zone in its title and a <time datetime>. The Simulation has no
 * dates: its scenario time code (mm:ss.s), as before.
 */
import { Moment, cn, type Precision } from "@mach/ui";
import { getTimeBase, timecode } from "./time";

export function When({ t, precision = "minute", inline = false, age = true, className }: { t: number; precision?: Precision; inline?: boolean; age?: boolean; className?: string }) {
  if (getTimeBase() !== "wall") return <span className={cn("tabular-nums", className)}>{timecode(t, precision !== "minute")}</span>;
  return <Moment at={t} precision={precision} inline={inline} age={age} className={className} />;
}
