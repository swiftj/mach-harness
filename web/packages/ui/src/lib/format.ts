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
