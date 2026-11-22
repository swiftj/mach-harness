import { useEffect, type RefObject } from "react";

/** What a start form shows when it cannot go on: the engine's refusal, a field in error, a choice not made. */
const PROBLEM = '[role="alert"], [aria-invalid="true"], fieldset[aria-describedby]';

/**
 * The start forms are taller than their dialog once a small change is chosen, so what stopped the person can
 * be outside the part in view. After each try, and when the engine refuses, the first problem is brought into view.
 * `tries` counts presses of the form's button; `refusal` is the engine's words, or null.
 */
export function useProblemInView(form: RefObject<HTMLFormElement | null>, tries: number, refusal: string | null): void {
  useEffect(() => {
    if (!tries && !refusal) return;
    const dialog = form.current?.closest('[role="dialog"]') ?? form.current;
    const problem = dialog?.querySelector(PROBLEM);
    if (!problem) return;
    problem.scrollIntoView({ block: "nearest" });
    // Then the words that say what is wrong with it, which sit under the control.
    for (const id of (problem.getAttribute("aria-describedby") ?? "").split(" ")) {
      if (id) document.getElementById(id)?.scrollIntoView({ block: "nearest" });
    }
  }, [form, tries, refusal]);
}
