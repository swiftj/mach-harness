import { useState, type FormEvent } from "react";
import { Banner, Button, Dialog, DialogClose, DialogContent, Field, HintAction, Input, Select, toast } from "@mach/ui";
import type { IdeaAdded, RequestItem } from "@mach/ui/api";
import { useEngineAct } from "../../../api/act";
import { useOperation } from "../../../api/useOperation";
import { useRequestList } from "../../../shared/useRequestList";
import { addIdeaArgs, faultOption, faultOptions, issueOption, oneLine, startOptions, titleLimit, titleProblem, type StartFrom } from "./model";

type Kind = StartFrom["kind"];

/**
 * Adding an idea, on the product manager's word: a title, and optionally the request, idea issue or fault from production
 * it starts from, chosen only from what the engine lists (`request.list`, `idea.faults`). The engine checks it; its refusal is shown as written.
 * Adding sends nothing anywhere and starts nothing.
 */
export function AddIdeaDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: (result: IdeaAdded) => void }) {
  // A fresh body for every opening, so nothing typed last time is left in it.
  const [generation, setGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setGeneration((g) => g + 1);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <AddIdeaBody key={generation} onClose={() => onOpenChange(false)} onAdded={onAdded} /> : null}
    </Dialog>
  );
}

function AddIdeaBody({ onClose, onAdded }: { onClose: () => void; onAdded: (result: IdeaAdded) => void }) {
  const act = useEngineAct();
  const requests = useRequestList();
  const faultList = useOperation("idea.faults", {});
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<Kind>("nothing");
  // The chosen issue's number, or the chosen fault's ticket.
  const [number, setNumber] = useState<string>("");
  const [asked, setAsked] = useState<{ title: string | null; issue: string | null }>({ title: null, issue: null });

  const { requests: requestItems, ideaIssues } = startOptions(requests.data?.items);
  const choices: RequestItem[] = kind === "request" ? requestItems : kind === "idea" ? ideaIssues : [];
  const faults = faultOptions(faultList.data?.faults);
  const textIsData = kind === "fault" ? (faultList.data?.note ?? null) : (choices.find((item) => item.text_is_data)?.text_is_data ?? null);
  const faultWhy = faultList.loading && !faultList.data ? "Reading the faults on this computer." : faultList.error ? "The faults on this computer could not be read just now." : null;

  const listWhy = requests.loading && !requests.data ? "Reading the requests MACH knows about." : requests.error ? "The requests could not be read just now." : null;
  const kindOptions = [
    { value: "nothing", label: "Nothing: just the title" },
    {
      value: "request",
      label: "A request",
      description: listWhy ?? (requestItems.length ? `${requestItems.length === 1 ? "1 request" : `${requestItems.length} requests`} known here` : "No request is known here yet."),
      disabled: requestItems.length === 0,
    },
    {
      value: "idea",
      label: "An idea filed in the idea template",
      description: listWhy ?? (ideaIssues.length ? `${ideaIssues.length === 1 ? "1 issue" : `${ideaIssues.length} issues`} known here` : "No issue in the idea template is known here yet."),
      disabled: ideaIssues.length === 0,
    },
    {
      value: "fault",
      label: "A fault from production",
      description: faultWhy ?? (faults.length ? `${faults.length === 1 ? "1 open fault" : `${faults.length} open faults`} on this computer` : "No open fault on this computer that an idea has not started from."),
      disabled: faults.length === 0,
    },
  ];

  const choose = (value: string) => {
    setNumber(value);
    setAsked((a) => ({ ...a, issue: null }));
    // Start the title from the issue's own title when nothing is typed yet; it stays editable.
    const named = kind === "fault" ? faults.find((f) => f.ticket === value)?.summary : choices.find((c) => String(c.number) === value)?.title;
    if (named && title.trim() === "") setTitle(oneLine(named).slice(0, titleLimit));
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const titleAsk = titleProblem(title);
    const issueAsk =
      kind !== "nothing" && !number ? (kind === "request" ? "Choose the request it starts from." : kind === "fault" ? "Choose the fault it starts from." : "Choose the issue it starts from.") : null;
    setAsked({ title: titleAsk, issue: issueAsk });
    if (titleAsk || issueAsk) return;
    const from: StartFrom = kind === "nothing" ? { kind } : kind === "fault" ? { kind, ticket: number } : { kind, number: Number(number) };
    const result = await act.run("idea.add", addIdeaArgs(title, from));
    if (!result) return;
    toast({ tone: "success", title: `Added ${result.idea.idea_id}`, description: result.note });
    onAdded(result);
    onClose();
  };

  const refusal = act.shown;
  return (
    <DialogContent
      width="lg"
      onEscapeKeyDown={(e) => act.pending && e.preventDefault()}
      onPointerDownOutside={(e) => act.pending && e.preventDefault()}
      title="Add an idea?"
      description="It goes on the board as New, in this workspace only. Nothing is sent anywhere and no epic or slice is made; you explore it when you are ready."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={act.pending}>Not now</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="add-idea-form" loading={act.pending}>
            Add the idea
          </Button>
        </>
      }
    >
      <form id="add-idea-form" onSubmit={add} noValidate className="flex flex-col gap-5 pb-1">
        {refusal ? (
          <Banner tone="danger" live="assertive" title="The idea was not added" actions={refusal.hint ? <HintAction hint={refusal.hint} /> : undefined}>
            <span className="whitespace-pre-line">{refusal.message}</span>
          </Banner>
        ) : null}
        <Field label="Title" hint={`What the idea is, in a few words. One line, at most ${titleLimit} characters.`} error={asked.title ?? undefined}>
          <Input
            value={title}
            maxLength={titleLimit}
            onChange={(e) => {
              setTitle(oneLine(e.target.value));
              setAsked((a) => ({ ...a, title: null }));
            }}
            autoComplete="off"
          />
        </Field>
        <Field label="Start from" optional hint="An idea can start from an issue or a fault MACH already knows about. Only those are offered here.">
          <Select
            value={kind}
            onValueChange={(value) => {
              setKind(value as Kind);
              setNumber("");
              setAsked((a) => ({ ...a, issue: null }));
            }}
            options={kindOptions}
          />
        </Field>
        {kind !== "nothing" ? (
          <Field label={kind === "request" ? "The request" : kind === "fault" ? "The fault" : "The issue"} hint={textIsData ?? undefined} error={asked.issue ?? undefined}>
            <Select
              value={number}
              onValueChange={choose}
              placeholder={kind === "request" ? "Choose a request…" : kind === "fault" ? "Choose a fault…" : "Choose an issue…"}
              options={
                kind === "fault"
                  ? faults.map((fault) => ({ value: fault.ticket, label: faultOption(fault) }))
                  : choices.map((item) => ({ value: String(item.number), label: issueOption(item) }))
              }
            />
          </Field>
        ) : null}
      </form>
    </DialogContent>
  );
}
