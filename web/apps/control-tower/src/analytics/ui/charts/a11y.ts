/**
 * Accessibility helpers for Factory Analytics' charts, kept pure so node's test runner can check them
 * (test/analytics-a11y.test.mjs): words a screen reader reads well, and WCAG contrast arithmetic, with
 * which the test validates the token-kind ramp in analytics.css against both themes' grounds.
 */

/** sRGB relative luminance of a #rrggbb colour (WCAG 2.2). */
export function luminance(hex: string): number {
  const v = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** The WCAG contrast ratio of two #rrggbb colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const UNIT_WORDS: Readonly<Record<string, [string, string]>> = {
  ms: ["millisecond", "milliseconds"],
  s: ["second", "seconds"],
  min: ["minute", "minutes"],
  h: ["hour", "hours"],
  d: ["day", "days"],
};

/**
 * Text as a screen reader should say it: "1 h 48 min" becomes "1 hour 48 minutes", "67%" becomes
 * "67 percent", "8.55 M" becomes "8.55 million", "< $0.01" becomes "less than $0.01", and a lone dash
 * (no value) becomes "no value". Everything else is left as written.
 */
export function spoken(text: string): string {
  return text
    .replace(/(^|[\s(:,])–(?=$|[.,;)])/g, "$1no value")
    .replace(/<\s?\$/g, "less than $")
    .replace(/(\d+(?:\.\d+)?)\s?%/g, "$1 percent")
    .replace(/\b(\d+(?:\.\d+)?) (ms|s|min|h|d)\b/g, (_, n: string, u: string) => `${n} ${UNIT_WORDS[u]![n === "1" ? 0 : 1]}`)
    .replace(/\b(\d+(?:\.\d+)?) k\b/g, "$1 thousand")
    .replace(/\b(\d+(?:\.\d+)?) M\b/g, "$1 million")
    .replace(/\b(\d+(?:\.\d+)?) B\b/g, "$1 billion");
}

/** "67 percent, 53 of 79": a share with what it counts, for assistive technology. */
export function spokenShare(k: number, n: number): string {
  if (n <= 0) return "no share: nothing to divide by";
  return `${Math.round((k / n) * 100)} percent, ${k} of ${n}`;
}
