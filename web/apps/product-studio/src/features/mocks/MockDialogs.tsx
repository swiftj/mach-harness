import { useState, type FormEvent } from "react";
import { Button, Checkbox, ConfirmDialog, Dialog, DialogClose, DialogContent, Field, HintAction, Input, Select, toast } from "@mach/ui";
import { isMachApiError, sizeWords, uploadFile, uploadLimits, type UploadFile } from "@mach/ui/api";
import { useEngineAct } from "../../api/act";
import { BindingPill, type ListedMock } from "./MockRecord";
import { addArguments, byteWords, dimensionWords, fingerprint, kindWords, mockPurpose, purposeOptions, WHOLE_SLICE, type ScenarioName } from "./model";

/** What the person may choose, said before they choose it: from the host's own limits. */
export const PICTURE_RULE = `A PNG or JPEG picture of at most ${sizeWords(uploadLimits.mock.maxBytes)}.`;

/** A fresh body for every opening, kept mounted while it closes so focus returns to the button. */
function useGeneration(open: boolean): number {
  const [generation, setGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setGeneration((g) => g + 1);
  }
  return generation;
}

interface AddProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sliceId: string;
  scenarios: readonly ScenarioName[];
  onDone: () => void;
}

/**
 * Attach a picture (`slice.mock.add`), on the product manager's word. The app checks only what the
 * host checks (the extension and size); the engine judges the picture and answers in its words.
 */
export function AddMockDialog(props: AddProps) {
  const generation = useGeneration(props.open);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <AddMockBody key={generation} {...props} />
    </Dialog>
  );
}

function AddMockBody({ onOpenChange, sliceId, scenarios, onDone }: AddProps) {
  const act = useEngineAct();
  const [chosen, setChosen] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [purpose, setPurpose] = useState(WHOLE_SLICE);
  const [binding, setBinding] = useState(false);
  const [note, setNote] = useState("");
  const formId = `add-mock-${sliceId}`;
  const forScenario = purpose !== WHOLE_SLICE;
  const busy = act.pending || reading;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) {
      setFileError(`Choose a picture first. ${PICTURE_RULE}`);
      return;
    }
    let file: UploadFile;
    setReading(true);
    try {
      file = await uploadFile(chosen, uploadLimits.mock, "slice.mock.add");
    } catch (error) {
      setFileError(isMachApiError(error) ? error.message : "The picture could not be read.");
      return;
    } finally {
      setReading(false);
    }
    const result = await act.run("slice.mock.add", { slice_id: sliceId, file, ...addArguments({ purpose, binding, note }) });
    if (!result) return;
    toast({ tone: "success", title: `Attached a design mock to ${sliceId}`, description: result.note });
    onOpenChange(false);
    onDone();
  };

  return (
    <DialogContent
      width="lg"
      onEscapeKeyDown={(e) => busy && e.preventDefault()}
      onPointerDownOutside={(e) => busy && e.preventDefault()}
      title={`Attach a design mock to ${sliceId}?`}
      description="The picture is kept with the draft slice and goes to the builders with it when you mark it ready. Nothing is sent now."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={busy}>Not now</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form={formId} loading={busy}>
            Attach the picture
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Field label="Picture" hint={PICTURE_RULE} error={fileError}>
          <Input
            type="file"
            accept={uploadLimits.mock.extensions.join(",")}
            className="py-1.5 file:mr-3 file:rounded-xs file:border-0 file:bg-surface-sunken file:px-2 file:py-1 file:text-body-sm file:text-ink"
            onChange={(e) => {
              setChosen(e.target.files?.[0] ?? null);
              setFileError(null);
              act.reset();
            }}
          />
        </Field>
        <Field label="What it shows" hint="One of the slice's scenarios, or the slice as a whole.">
          <Select
            value={purpose}
            onValueChange={(value) => {
              setPurpose(value);
              if (value === WHOLE_SLICE) setBinding(false);
            }}
            options={purposeOptions(scenarios)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <Checkbox
            checked={forScenario && binding}
            disabled={!forScenario}
            onCheckedChange={(value) => setBinding(value === true)}
            label="Binding: the built screen must match it"
            description={
              forScenario
                ? `If the builders' screen for ${purpose} differs from this picture, verification fails.`
                : "Only a picture of one scenario can be binding. Choose a scenario above to make it binding."
            }
          />
        </div>
        <Field label="Note" optional hint="One line in your own words, at most 200 characters: what to look at in the picture.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example, The invite form, empty" />
        </Field>
      </form>
      {act.shown ? (
        <div role="alert" className="mt-4 flex flex-col items-start gap-2 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5">
          <p className="text-label text-danger-ink">The picture was not attached</p>
          <p className="whitespace-pre-line text-body-sm text-ink">{act.shown.message}</p>
          <HintAction hint={act.shown.hint} />
        </div>
      ) : null}
    </DialogContent>
  );
}

/** Remove a picture (`slice.mock.remove`), on the product manager's word. */
export function RemoveMockDialog({
  mock,
  index,
  sliceId,
  scenarios,
  onOpenChange,
  onDone,
}: {
  mock: ListedMock | null;
  index: number;
  sliceId: string;
  scenarios: readonly ScenarioName[];
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const act = useEngineAct();
  return (
    <ConfirmDialog
      open={mock !== null}
      onOpenChange={(next) => {
        if (!next) act.reset();
        onOpenChange(next);
      }}
      tone="danger"
      title={`Remove picture ${index + 1} from ${sliceId}?`}
      description="The picture is taken off the draft slice and out of Product Studio's workspace. Nothing is sent anywhere. You can attach it again later."
      confirmLabel="Remove the picture"
      cancelLabel="Keep it"
      error={act.shown}
      onConfirm={async () => {
        if (!mock) return false;
        const result = await act.run("slice.mock.remove", { slice_id: sliceId, mock: mock.sha256 });
        if (!result) return false;
        toast({ tone: "success", title: `Removed picture ${index + 1} from ${sliceId}`, description: result.note });
        onDone();
        return true;
      }}
    >
      {mock ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface px-4 py-3 text-body-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label text-ink">{mock.for ? mockPurpose(mock, scenarios) : "For the whole slice"}</span>
            <BindingPill binding={mock.binding} />
          </div>
          <span className="text-ink-muted">
            {kindWords(mock.format)} · {dimensionWords(mock)} · {byteWords(mock.bytes)} · fingerprint{" "}
            <span translate="no" className="font-mono">
              {fingerprint(mock.sha256)}
            </span>
          </span>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
