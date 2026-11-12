import { Check, Info } from "lucide-react";
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
  isFieldConflict,
  toast,
} from "@mach/ui";
import { Section, Specimen } from "../layout";
import { fx } from "../fixtures";

const approve = fx.sliceApprove;
const conflicts = fx.statusConflicts.needs_reconciling;
const epicPath = "product/epics/EPIC-001.json";

function show(value: unknown): string {
  if (value === null || value === undefined) return "nothing";
  if (Array.isArray(value)) return value.join("; ");
  return String(value);
}

export function Overlays() {
  const epicDetail = conflicts.details[epicPath];
  return (
    <Section
      id="overlays"
      title="Dialogs, sheets and popovers"
      intro="A dialog asks for a decision. A sheet shows detail beside the page. A popover explains. A tooltip names an icon. A toast confirms what just happened."
    >
      <div className="grid grid-cols-2 gap-6">
        <Specimen title="Dialog: confirm a person's act" source="slice.approve.json" note="Approval is never automatic. The dialog says what approval means, in the engine's own words.">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="primary">
                <Check aria-hidden="true" />
                Approve {approve.slice.slice_id}
              </Button>
            </DialogTrigger>
            <DialogContent
              title={`Approve ${approve.slice.slice_id}: ${approve.slice.title}?`}
              description="Approving freezes the slice. Reopening it later withdraws the approval."
              footer={
                <>
                  <DialogClose asChild>
                    <Button>Not now</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button
                      variant="primary"
                      onClick={() =>
                        toast({ tone: "success", title: `Approved ${approve.slice.slice_id}`, description: approve.note })
                      }
                    >
                      Approve
                    </Button>
                  </DialogClose>
                </>
              }
            >
              <dl className="grid grid-cols-4 gap-3 rounded-md bg-surface-sunken p-4">
                {(
                  [
                    ["Invariants", approve.counts.invariants],
                    ["Requirements", approve.counts.functional_requirements],
                    ["Decision rules", approve.counts.matrix_rules],
                    ["Scenarios", approve.counts.scenarios],
                  ] as const
                ).map(([label, n]) => (
                  <div key={label} className="flex flex-col">
                    <dt className="text-caption text-ink-muted">{label}</dt>
                    <dd className="font-display text-title-2 font-[650] text-ink tabular">{n}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 flex items-center gap-2 text-body-sm text-ink-muted">
                Risk <Badge tone={approve.risk === "High" ? "warning" : "neutral"}>{approve.risk}</Badge>
              </p>
            </DialogContent>
          </Dialog>
        </Specimen>

        <Specimen title="Sheet: compare before choosing" source="status.conflicts.json" note="A conflict shows both versions side by side. The person chooses; the app never picks a side.">
          <Sheet>
            <SheetTrigger asChild>
              <Button>Settle {conflicts.conflicts.length} differences</Button>
            </SheetTrigger>
            <SheetContent
              width={640}
              title="EPIC-001 changed in both places"
              description={`Your draft and ${fx.statusConflicts.shared_project} disagree. Choose which version stands for each field.`}
              footer={
                <SheetClose asChild>
                  <Button>Close</Button>
                </SheetClose>
              }
            >
              {epicDetail && isFieldConflict(epicDetail) ? (
                <div className="flex flex-col gap-5">
                  {Object.entries(epicDetail.fields).map(([field, values]) => (
                    <div key={field} className="flex flex-col gap-2">
                      <Text weight="semibold" size="body-sm">
                        {field.charAt(0).toUpperCase() + field.slice(1).replaceAll("_", " ")}
                      </Text>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-2 rounded-md border border-line p-3">
                          <span className="text-caption font-semibold text-ink-muted">Your draft</span>
                          <span className="text-body-lg text-ink">{show(values.mine)}</span>
                          <Button size="sm">Keep mine</Button>
                        </div>
                        <div className="flex flex-col gap-2 rounded-md border border-line p-3">
                          <span className="text-caption font-semibold text-ink-muted">Shared project</span>
                          <span className="text-body-lg text-ink">{show(values.theirs)}</span>
                          <Button size="sm">Take theirs</Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
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
              <p className="mt-1 text-body-sm text-ink-muted">Drafts stay here until you send a wave. Nothing in it changes your project folder.</p>
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
            <Button onClick={() => toast({ tone: "success", title: `Sent ${fx.send.wave_id}`, description: fx.send.note })}>Show success toast</Button>
            <Button
              onClick={() =>
                toast({ tone: "info", title: `${fx.refreshSecondPm.arrived.length} items arrived`, description: `From ${fx.refreshSecondPm.shared_project}.` })
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
