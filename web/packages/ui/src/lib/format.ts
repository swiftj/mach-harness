/** "1 slice", "3 slices". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "11 Nov, 14:55" in the person's own locale and time zone; "never" for no time. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Requirement keywords (MUST NOT, SHALL...) are written in capitals for the validator; read them in lower case. */
export function plain(text: string): string {
  return text.replace(/\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|MAY|REQUIRED|RECOMMENDED|OPTIONAL)\b/g, (word) => word.toLowerCase());
}

/** "3 days ago", "in 2 hours", "just now": how long ago (or until) a moment, in words. Pass `now` for a fixed clock. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((at - now) / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const [unit, size] = units.find(([, s]) => Math.abs(seconds) >= s) ?? ["minute", 60];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(seconds / size), unit);
}

/** The exact moment, in full, in the person's own locale and time zone: "Tuesday 17 November 2026, 14:00". */
export function formatExact(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
