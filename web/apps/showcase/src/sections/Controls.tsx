import { useState } from "react";
import { ArrowUpRight, Check, Plus, RefreshCw, Send } from "lucide-react";
import {
  ArtifactId,
  Button,
  Checkbox,
  Field,
  Input,
  Kbd,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Text,
  Textarea,
  SliceStatusPill,
  EpicStatusPill,
} from "@mach/ui";
import { Section, Specimen } from "../layout";
import { fx } from "../fixtures";

const project = fx.projectInit.project;
const epic = fx.epicAdd.epic;
const renumbered = fx.statusAfterRenumber;

export function Controls() {
  const [chosen, setChosen] = useState<string[]>(["SLICE-002"]);
  const [epicId, setEpicId] = useState(renumbered.epics[0]?.epic_id ?? "");
  const approved = renumbered.slices.filter((s) => s.status === "approved_for_engineering");
  return (
    <Section
      id="controls"
      title="Controls"
      intro="Buttons say exactly what happens. Every control has a visible label, a 2px focus ring and a 36px height, or 44px where it is the main act on a page."
    >
      <Specimen title="Buttons" note="One primary button per region. Approving and sending are a person's acts: primary, and always confirmed in a dialog.">
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary">
              <Check aria-hidden="true" />
              Approve SLICE-001
            </Button>
            <Button>
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
            <Button variant="ghost">
              <Plus aria-hidden="true" />
              New slice
            </Button>
            <Button variant="danger">Reopen SLICE-001</Button>
            <Button variant="link" asChild>
              <a href={fx.send.pull_request ?? "#"}>
                Open the review request
                <ArrowUpRight aria-hidden="true" />
              </a>
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg">
              <Send aria-hidden="true" />
              Send WAVE-001 to engineering
            </Button>
            <Button variant="primary" loading>
              Sending
            </Button>
            <Button size="sm">Small</Button>
            <Button disabled>Disabled</Button>
            <Button size="icon" aria-label="Refresh">
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
        </div>
      </Specimen>

      <div className="grid grid-cols-2 gap-6">
        <Specimen title="Fields" source="project.init.json" note="Label above, hint under the label, error under the control. Product writing uses the serif.">
          <div className="flex flex-col gap-5">
            <Field label="Project name" hint="What people call the product.">
              <Input defaultValue={project.name} />
            </Field>
            <Field label="Vision" hint="One sentence: what the product is for.">
              <Textarea editorial rows={2} defaultValue={project.vision} />
            </Field>
            <Field label="Project ID" error="Use lowercase words joined by hyphens, such as team-space.">
              <Input defaultValue="Team Space" className="font-mono" />
            </Field>
            <Field label="Resume note" optional>
              <Input placeholder="What is settled, and the next question to ask" />
            </Field>
          </div>
        </Specimen>

        <div className="flex flex-col gap-6">
          <Specimen title="Select" source="status.after-renumber.json">
            <Field label="Epic" hint="The slice belongs to one epic.">
              <Select
                value={epicId}
                onValueChange={setEpicId}
                options={renumbered.epics.map((e) => ({ value: e.epic_id, label: `${e.epic_id} ${e.title}`, description: e.status }))}
              />
            </Field>
          </Specimen>

          <Specimen title="Checkbox" source="status.after-renumber.json" note="Choosing approved slices for a new wave.">
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-label text-ink">Slices in this wave</legend>
              {approved.map((slice) => (
                <Checkbox
                  key={slice.slice_id}
                  checked={chosen.includes(slice.slice_id)}
                  onCheckedChange={(on) => setChosen((prev) => (on ? [...prev, slice.slice_id] : prev.filter((x) => x !== slice.slice_id)))}
                  label={
                    <span className="inline-flex items-center gap-2">
                      <ArtifactId>{slice.slice_id}</ArtifactId> {slice.title}
                    </span>
                  }
                  description="Approved"
                />
              ))}
              {renumbered.slices
                .filter((s) => s.status !== "approved_for_engineering")
                .map((slice) => (
                  <Checkbox
                    key={slice.slice_id}
                    disabled
                    label={
                      <span className="inline-flex items-center gap-2">
                        <ArtifactId>{slice.slice_id}</ArtifactId> {slice.title}
                      </span>
                    }
                    description="Only approved slices can go in a wave."
                  />
                ))}
            </fieldset>
          </Specimen>
        </div>
      </div>

      <Specimen title="Tabs" source="status.conflicts.json" note="Arrow keys move between tabs; Tab moves into the panel.">
        <Tabs defaultValue="slices">
          <TabsList aria-label="Workspace">
            <TabsTrigger value="slices">Slices</TabsTrigger>
            <TabsTrigger value="epics">Epics</TabsTrigger>
            <TabsTrigger value="waves">Waves</TabsTrigger>
          </TabsList>
          <TabsContent value="slices">
            <ul className="flex flex-col divide-y divide-line">
              {fx.statusConflicts.slices.map((s) => (
                <li key={s.slice_id} className="flex items-center gap-3 py-2">
                  <ArtifactId>{s.slice_id}</ArtifactId>
                  <span className="flex-1 text-body text-ink">{s.title}</span>
                  <SliceStatusPill status={s.status} size="sm" />
                </li>
              ))}
            </ul>
          </TabsContent>
          <TabsContent value="epics">
            <ul className="flex flex-col divide-y divide-line">
              {fx.statusConflicts.epics.map((e) => (
                <li key={e.epic_id} className="flex items-center gap-3 py-2">
                  <ArtifactId>{e.epic_id}</ArtifactId>
                  <span className="flex-1 text-body text-ink">{e.title}</span>
                  <EpicStatusPill status={e.status} size="sm" />
                </li>
              ))}
            </ul>
          </TabsContent>
          <TabsContent value="waves">
            <Text tone="muted">
              {fx.statusConflicts.waves.length} waves: {fx.statusConflicts.waves.map((w) => w.wave_id).join(", ")}.
            </Text>
          </TabsContent>
        </Tabs>
      </Specimen>

      <Specimen title="Identifiers and keys" note="Engine IDs are mono and never reformatted. Keyboard keys are drawn as keys.">
        <div className="flex flex-wrap items-center gap-3">
          <ArtifactId>{epic.epic_id}</ArtifactId>
          <ArtifactId>SLICE-001</ArtifactId>
          <ArtifactId>WAVE-002</ArtifactId>
          <ArtifactId>FR-01</ArtifactId>
          <Text as="span" size="body-sm" tone="muted" className="ml-4">
            Open the command menu with <Kbd>⌘</Kbd> <Kbd>K</Kbd>, close anything with <Kbd>Esc</Kbd>.
          </Text>
        </div>
      </Specimen>
    </Section>
  );
}
