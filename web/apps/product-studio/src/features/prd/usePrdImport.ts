import { useRef, useState, type ChangeEvent, type RefObject } from "react";
import { toast } from "@mach/ui";
import { isMachApiError, uploadFile, uploadLimits, type PrdImport } from "@mach/ui/api";
import { useEngineAct, type EngineAct } from "../../api/act";

export interface PrdImporter {
  /** The hidden file input's ref and change handler: render `<input type="file" ...>` with these. */
  inputRef: RefObject<HTMLInputElement | null>;
  onPicked: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  accept: string;
  /** Opens the browser's file chooser. */
  choose: () => void;
  busy: boolean;
  /** The kind or size the host would refuse, said before anything is sent. */
  tooEarly: string | null;
  act: EngineAct;
  result: PrdImport | null;
}

/**
 * Importing a PRD (`prd.import`): the person picks one Markdown or plain-text file; the app checks the kind and size the
 * host would refuse, then the engine judges the content and answers in its own words. Shared by "Start from a PRD" and
 * the start screen, which opens the file chooser straight away.
 */
export function usePrdImport(onImported?: (result: PrdImport) => void): PrdImporter {
  const input = useRef<HTMLInputElement>(null);
  const act = useEngineAct();
  const [picking, setPicking] = useState(false);
  const [tooEarly, setTooEarly] = useState<string | null>(null);
  const [result, setResult] = useState<PrdImport | null>(null);
  const limit = uploadLimits.prd;

  const choose = () => {
    setTooEarly(null);
    act.reset();
    input.current?.click();
  };

  const onPicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPicking(true);
    setResult(null);
    try {
      const upload = await uploadFile(file, limit, "prd.import");
      const imported = await act.run("prd.import", { file: upload });
      if (imported) {
        setResult(imported);
        toast({ tone: "success", title: imported.imported ? `Imported ${imported.prd.prd_id}` : `${imported.prd.prd_id} was already imported` });
        onImported?.(imported);
      }
    } catch (error) {
      setTooEarly(isMachApiError(error) ? error.message : String(error));
    } finally {
      setPicking(false);
    }
  };

  return { inputRef: input, onPicked, accept: limit.extensions.join(","), choose, busy: picking || act.pending, tooEarly, act, result };
}
