import { cn } from "../lib/cn";
import { momentWords, type MomentOptions } from "../lib/datetime";

/**
 * A moment that happened, with its date: "Today 14:53", "Yesterday 20:02", "24 Nov 20:02", in the
 * person's locale and time zone. A <time> with the machine-readable moment; the full date, time and
 * time zone in its title and accessible name. A moment from before yesterday says how old it is
 * beside it ("· 3 d ago"), unless `age` is false. `inline` gives the lower-case form for a sentence.
 */
export function Moment({
  at,
  precision,
  now,
  inline = false,
  age = true,
  className,
  ageClassName,
}: {
  at: number | string | Date;
  precision?: MomentOptions["precision"];
  now?: number;
  inline?: boolean;
  age?: boolean;
  className?: string;
  ageClassName?: string;
}) {
  const w = momentWords(at, { precision, now });
  const shownAge = age ? w.age : null;
  return (
    <>
      <time dateTime={w.iso} title={w.exact} aria-label={shownAge ? `${w.exact}, ${shownAge}` : w.exact} className={cn("tabular-nums", className)} data-moment={w.day}>
        {inline ? w.inline : w.text}
      </time>
      {shownAge ? (
        <span aria-hidden="true" className={cn("text-ink-muted", ageClassName)} data-moment-age="">
          {" "}
          · {shownAge}
        </span>
      ) : null}
    </>
  );
}
