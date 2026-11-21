/**
 * Words the project home works out from the engine's answers (M16 layout). Pure, so it is unit-tested
 * (test/home-model.test.mjs).
 */

/** The label of an epic's folded "done when" criteria: "Done when: 2 criteria". */
export function doneWhenLabel(count: number): string {
  return `Done when: ${count} ${count === 1 ? "criterion" : "criteria"}`;
}
