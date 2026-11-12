import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { roleNames, typeScale, radius } from "../tokens/tokens";

/**
 * tailwind-merge taught the MACH token names, so `cn("text-body", "text-caption")` keeps only the last
 * size and `cn("text-ink", "text-ink-muted")` keeps only the last colour.
 */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      color: [...roleNames],
      text: Object.keys(typeScale),
      radius: Object.keys(radius),
      shadow: ["1", "2", "3"],
      font: ["sans", "mono", "display"],
    },
  },
});

/** Join class names, resolving Tailwind conflicts in favour of the later class. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
