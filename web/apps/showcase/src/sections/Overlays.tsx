import { CircleCheck, Info } from "lucide-react";
import {
  ArtifactId,
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetClose,
  SheetContent,
  SheetTrigger,
  Text,
  Tooltip,
  SliceGithubPills,
  SliceStatusPill,
  toast,
} from "@mach/ui";
import { Section, Specimen } from "../layout";
import { fx } from "../fixtures";

const ready = fx.sliceReady;
const folder = fx.sliceReadyFolder;
const newer = fx.statusRich.slices.find((s) => s.slice_id === fx.reconcileTheirs.reconciled);

export function Overlays() {
  return (
    <Section
      id="overlays"
      title="Dialogs, sheets and popovers"
      intro="A dialog asks for a decision. A sheet shows detail beside the page. A popover explains. A tooltip names an icon. A toast confirms what just happened."
    >
      <div className="grid grid-cols-2 gap-6">
        <Specimen title="Dialog: confirm a person's act" source="slice.ready.json" note="Marking a slice ready is never automatic. The dialog says what it does, in the engine's terms, and the result names where it was saved.">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="primary">
                <CircleCheck aria-hidden="true" />
                Mark {ready.slice.slice_id} ready to build
              </Button>
            </DialogTrigger>
            <DialogContent
              title={`Mark ${ready.slice.slice_id} ready to build?`}
              description="This saves the slice to the project on GitHub under its epic, tells the builders it is ready, and records that you approved exactly this text. It stays frozen until you reopen it."
              footer={
                <>
                  <DialogClose asChild>
                    <Button>Not now</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button
                      variant="primary"
                      onClick={() => toast({ tone: "success", title: `${ready.slice.slice_id} is ready to build`, description: ready.note })}
                    >
                      Mark ready to build
                    </Button>
                  </DialogClose>
                </>
              }
            >
              <dl className="grid grid-cols-4 gap-3 rounded-md bg-surface-sunken p-4">
                {(
                  [
                    ["Invariants", ready.counts.invariants],
                    ["Requirements", ready.counts.functional_requirements],
                    ["Decision rules", ready.counts.matrix_rules],
                    ["Scenarios", ready.counts.scenarios],
                  ] as const
                ).map(([label, n]) => (
                  <div key={label} className="flex flex-col">
                    <dt className="text-caption text-ink-muted">{label}</dt>
                    <dd className="font-display text-title-2 font-[650] text-ink tabular">{n}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 flex items-center gap-2 text-body-sm text-ink-muted">
                Risk <Badge tone={ready.risk === "High" ? "warning" : "neutral"}>{ready.risk}</Badge>
              </p>
            </DialogContent>
          </Dialog>
        </Specimen>

        <Specimen title="Where it was saved" source="slice.ready.json, slice.ready.folder.json" note="On GitHub: the issue the engine returned, as a link. Without GitHub: the folder, and the engine's two ways on, word for word.">
          <div className="flex flex-col gap-4">
            <p className="text-body text-ink">
              Saved as{" "}
              <a className="font-semibold text-accent-ink underline underline-offset-2" href={ready.url}>
                #{ready.issue}
              </a>
              . {ready.note}
            </p>
            <div className="flex flex-col gap-2 rounded-md border border-line p-4">
              <Text size="body-sm" tone="muted">
                {folder.why_folder}
              </Text>
              <p className="break-all font-mono text-caption text-ink">{folder.folder}</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm text-ink">
                {folder.ways_on.map((way) => (
                  <li key={way}>{way}</li>
                ))}
              </ul>
            </div>
          </div>
        </Specimen>

        <Specimen title="Sheet: choose a version" source="status.rich.json, reconcile.theirs.json" note="Someone else saved a newer version. The person chooses; the app never picks a side.">
          <Sheet>
            <SheetTrigger asChild>
              <Button>Choose a version of {fx.reconcileTheirs.reconciled}</Button>
            </SheetTrigger>
            <SheetContent
              width={480}
              title={`${fx.reconcileTheirs.reconciled}: a newer version on GitHub`}
              description="Keep yours, and marking it ready replaces theirs; or take theirs into your draft."
              footer={
                <SheetClose asChild>
                  <Button>Close</Button>
                </SheetClose>
              }
            >
              <div className="flex flex-col gap-4">
                {newer ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <SliceStatusPill status={newer.status} size="sm" />
                    <SliceGithubPills github={newer.github} size="sm" />
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-3">
                  <Button size="sm">Keep mine</Button>
                  <Button size="sm">Take theirs</Button>
                </div>
                <Text size="body-sm" tone="muted">
                  After taking theirs: {fx.reconcileTheirs.note}
                </Text>
              </div>
            </SheetContent>
          </Sheet>
        </Specimen>

        <Specimen title="Popover" source="where.json" note="Non-modal. Escape or a click outside closes it.">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost">
                <Info aria-hidden="true" />
                Where your drafts live
              </Button>
            </PopoverTrigger>
            <PopoverContent>
              <p className="text-label text-ink">Your private workspace</p>
              <p className="mt-1 text-body-sm text-ink-muted">Drafts stay here until you mark a slice ready to build. Nothing in it changes your project folder.</p>
              <p className="mt-2 break-all rounded-xs bg-surface-sunken px-2 py-1 font-mono text-caption text-ink-muted">{fx.where.workspace}</p>
            </PopoverContent>
          </Popover>
        </Specimen>

        <Specimen title="Tooltip and toast" note="Tooltips open on hover and keyboard focus. Toasts confirm, in the past tense of the action's own name.">
          <div className="flex flex-wrap items-center gap-3">
            <Tooltip content="Refresh from the shared project">
              <Button size="icon" aria-label="Refresh from the shared project">
                <Info aria-hidden="true" />
              </Button>
            </Tooltip>
            <Button onClick={() => toast({ tone: "success", title: `Reopened ${fx.sliceReopen.slice.slice_id}`, description: fx.sliceReopen.note })}>Show success toast</Button>
            <Button
              onClick={() =>
                toast({ tone: "info", title: `${fx.sliceRenumber.renumbered.from} is now ${fx.sliceRenumber.renumbered.to}`, description: "Every reference moved with it." })
              }
            >
              Show info toast
            </Button>
            <Text as="span" size="caption" tone="subtle">
              Toasts appear bottom right. <ArtifactId plain>F8</ArtifactId> moves focus to them.
            </Text>
          </div>
        </Specimen>
      </div>
    </Section>
  );
}
