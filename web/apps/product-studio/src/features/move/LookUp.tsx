import { useState, type FormEvent } from "react";
import { Button, Field, Heading, Input, Skeleton, Text, describeError, formatWhen } from "@mach/ui";
import { isMachApiError, type MachApiError, type ProjectImportsList, type ProjectImportsLookup } from "@mach/ui/api";
import { client } from "../../api/client";
import { importRows, lookupId, lookupWords } from "./model";

const STATE_WORDS = { finished: "Brought in", "set-aside": "Set aside before it was finished", unfinished: "Being brought in, not finished" } as const;

/**
 * "What was SLICE-007 before?" (`project imports <ID>`), and every project brought in here (`project imports`). Both read
 * only; the answers are the engine's words.
 */
export function LookUp({
  list,
  listError,
  onRetry,
  loading,
}: {
  list: ProjectImportsList | null;
  listError: MachApiError | null;
  onRetry: () => void;
  loading: boolean;
}) {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string[] | null>(null);
  const [asking, setAsking] = useState(false);
  const rows = importRows(list);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const checked = lookupId(typed);
    if ("problem" in checked) {
      setProblem(checked.problem);
      setAnswer(null);
      return;
    }
    setProblem(null);
    setAsking(true);
    try {
      const result = (await client.op("project.imports", { identifier: checked.id })) as ProjectImportsLookup;
      setAnswer(lookupWords(result));
    } catch (error) {
      setAnswer(null);
      setProblem(isMachApiError(error) ? describeError(error).message : String(error));
    } finally {
      setAsking(false);
    }
  };

  return (
    <section aria-labelledby="move-lookup" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Heading level={2} size="title-2" id="move-lookup">
          What was it called before?
        </Heading>
        <Text className="max-w-reading">An item brought in from another repository may have a new number here. Type either number to see the other.</Text>
        <form onSubmit={(event) => void ask(event)} className="flex max-w-reading flex-wrap items-end gap-3">
          <Field label="An ID, such as SLICE-007" error={problem} className="min-w-0 flex-1">
            <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} translate="no" className="font-mono" />
          </Field>
          <Button type="submit" loading={asking}>
            Look it up
          </Button>
        </form>
        <div aria-live="polite">
          {answer ? (
            <ul className="flex max-w-reading flex-col gap-1 text-body text-ink">
              {answer.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Heading level={3} size="title-3" id="move-imports">
          Projects brought in here
        </Heading>
        {loading ? (
          <div role="status" aria-busy="true" aria-label="Reading the projects brought in here">
            <Skeleton className="h-12 w-full max-w-reading" />
          </div>
        ) : listError ? (
          <div className="flex max-w-reading flex-wrap items-center gap-3">
            <Text size="body-sm" tone="danger">
              {describeError(listError).message}
            </Text>
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : rows.length ? (
          <ul aria-labelledby="move-imports" className="flex max-w-reading flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {rows.map((row) => (
              <li key={row.key} className="flex flex-col gap-0.5 px-4 py-3">
                <span className="text-body font-semibold text-ink">“{row.name}”</span>
                <span className="text-body-sm text-ink-muted">
                  {STATE_WORDS[row.state]} {row.at ? formatWhen(row.at) : "(time not recorded)"} · {row.holds}
                  {row.joined ? " · joined this project" : ""}
                </span>
                {row.fileName ? (
                  <span translate="no" className="break-all text-caption text-ink-subtle">
                    {row.fileName}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Text size="body-sm" tone="muted">
            {list?.note ?? "No project has been brought in here."}
          </Text>
        )}
      </div>
    </section>
  );
}
