/**
 * What the Design mocks tab shows, from the engine's answers alone. Pure, so it is unit-tested
 * (test/mocks-model.test.mjs). The engine still decides: every act can be refused, in its words.
 */
import type { DesignMock, MocksToCommit, SliceGithub, SliceStatus } from "@mach/ui/api";

export interface ScenarioName {
  id: string;
  title: string;
}

/** The choice "the whole slice" in the scenario list (a Select value cannot be empty). */
export const WHOLE_SLICE = "whole";

/** What one picture is for, in words: "AC-01: Admin invites a colleague", or the whole slice. */
export function mockPurpose(mock: Pick<DesignMock, "for">, scenarios: readonly ScenarioName[]): string {
  if (!mock.for) return "The whole slice";
  const found = scenarios.find((s) => s.id === mock.for);
  return found ? `${found.id}: ${found.title}` : mock.for;
}

/**
 * The picture's alternative text: what it is for, from the slice's own record (its scenario's
 * title, whether it is binding, the product manager's note), never from the picture itself.
 */
export function mockAlt(mock: Pick<DesignMock, "for" | "binding" | "note">, scenarios: readonly ScenarioName[]): string {
  const purpose = mockPurpose(mock, scenarios);
  const what = `${mock.binding ? "Binding design mock" : "Design mock"} for ${mock.for ? `scenario ${purpose}` : "the whole slice"}`;
  return mock.note ? `${what}. ${mock.note}` : what;
}

/** The first characters of a SHA-256, enough to tell pictures apart: 12, as the facts line shows it. */
export function fingerprint(sha256: string): string {
  return sha256.slice(0, 12);
}

/** "PNG picture", "JPEG picture". */
export function kindWords(format: DesignMock["format"]): string {
  return format === "jpeg" ? "JPEG picture" : format === "png" ? "PNG picture" : `${String(format).toUpperCase()} picture`;
}

/** "4 × 3 pixels". */
export function dimensionWords(mock: Pick<DesignMock, "width" | "height">): string {
  return `${mock.width} × ${mock.height} pixels`;
}

/** A picture's size in words: "69 bytes", "12 KB", "1.4 MB". */
export function byteWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${trim(bytes / 1024)} KB`;
  return `${trim(bytes / (1024 * 1024))} MB`;
}

const trim = (n: number) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

/** The choices for "What it shows": the whole slice first, then the slice's own scenarios. */
export function purposeOptions(scenarios: readonly ScenarioName[]): Array<{ value: string; label: string }> {
  return [{ value: WHOLE_SLICE, label: "The whole slice" }, ...scenarios.map((s) => ({ value: s.id, label: `${s.id}: ${s.title}` }))];
}

export interface AddChoice {
  /** WHOLE_SLICE or a scenario ID. */
  purpose: string;
  binding: boolean;
  note: string;
}

/**
 * The operation's arguments from the form. Binding goes only with a scenario (the host and the
 * engine refuse it otherwise); an empty note is left out.
 */
export function addArguments(choice: AddChoice): { for?: string; binding?: true; note?: string } {
  const args: { for?: string; binding?: true; note?: string } = {};
  const scenario = choice.purpose && choice.purpose !== WHOLE_SLICE ? choice.purpose : null;
  if (scenario) args.for = scenario;
  if (scenario && choice.binding) args.binding = true;
  const note = choice.note.trim();
  if (note) args.note = note;
  return args;
}

/** Whether another picture can be attached: below the engine's own limit, and the slice editable. */
export function addAvailability(count: number, limit: number, editable: boolean): "available" | "full" | "locked" {
  if (!editable) return "locked";
  return count >= limit ? "full" : "available";
}

export type Delivery =
  /** Nothing to deliver: a draft, no pictures, or the builders already have the slice. */
  | { kind: "none" }
  /** Saved to GitHub and ready, with pictures: they wait to be committed. `toCommit` is the engine's answer when this window has it. */
  | { kind: "waiting"; toCommit: MocksToCommit | null };

/**
 * Whether the slice waits for its pictures to be committed. Only from what the engine reported:
 * approved, saved on GitHub, still "ready to build" (the builders have not taken it), with
 * pictures. The engine's own answer (folder, place, note) is shown when this window has it.
 */
export function deliveryState(input: {
  status: SliceStatus;
  github: Pick<SliceGithub, "saved" | "progress"> | null | undefined;
  mockCount: number;
  toCommit: MocksToCommit | null | undefined;
}): Delivery {
  if (input.status !== "approved_for_engineering") return { kind: "none" };
  const taken = input.github?.progress === "being_built" || input.github?.progress === "question" || input.github?.progress === "shipped";
  if (input.toCommit?.factory_waits && !taken) return { kind: "waiting", toCommit: input.toCommit };
  if (input.mockCount > 0 && input.github?.saved === "github" && input.github.progress === "ready_to_build") {
    return { kind: "waiting", toCommit: null };
  }
  return { kind: "none" };
}
