import { useReducedMotion, type Transition } from "motion/react";
import { motion as tokens } from "../tokens/tokens";

/**
 * Motion presets for `motion/react`. Every preset answers a person's action or shows what changed;
 * nothing moves on its own. Under reduced motion, presets return an instant transition.
 */
const seconds = (ms: number) => ms / 1000;

export const transitions = {
  fast: { duration: seconds(tokens.duration.fast), ease: tokens.easing.standard },
  base: { duration: seconds(tokens.duration.base), ease: tokens.easing.standard },
  slow: { duration: seconds(tokens.duration.slow), ease: tokens.easing.enter },
  layout: { duration: seconds(tokens.duration.layout), ease: tokens.easing.standard },
} satisfies Record<string, Transition>;

export type TransitionName = keyof typeof transitions;

/** The named transition, or an instant one when the person prefers reduced motion. */
export function useMachTransition(name: TransitionName): Transition {
  const reduce = useReducedMotion();
  return reduce ? { duration: 0 } : transitions[name];
}

export { useReducedMotion };
