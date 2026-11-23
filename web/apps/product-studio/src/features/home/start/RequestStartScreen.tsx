import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CircleAlert } from "lucide-react";
import { Button, ErrorState, LoadingState, Text, describeError } from "@mach/ui";
import type { Status } from "@mach/ui/api";
import { useStatus } from "../../../api/store";
import { useRequestList } from "../../../shared/useRequestList";
import { IssueLink } from "../../../shared/IssueLink";
import { Part, Parts } from "../../../shared/layout/Parts";
import { ContextRow, OnePane, WorkScreen } from "../../../shared/layout/WorkScreen";
import { PickUpDialog } from "../../inbox/requests/RequestDialogs";
import type { RequestItem } from "../../inbox/requests/api";
import { EpicSheet } from "../../vision/EpicSheet";
import { NameTheProduct } from "./NameTheProduct";
import { requestStep, type RequestStep } from "./model";

const STEPS: readonly RequestStep[] = ["name", "epic", "pick"];
const place = (part: RequestStep, at: RequestStep) => {
  const a = STEPS.indexOf(part);
  const b = STEPS.indexOf(at);
  return a < b ? "done" : a === b ? "current" : "later";
};

/**
 * Starting a project from a request someone filed on GitHub (M19). A request becomes a draft slice in an epic, and an
 * epic belongs to a project, so the way has three steps on this one page: name the product, add the epic the request
 * belongs to, then pick the request up. Each step is the engine's own act (`project.init`, `epic.add`, `request.pick`);
 * the step the page is at is what `status` reports.
 */
export function RequestStartScreen() {
  const number = Number(useParams().number);
  const status = useStatus();
  const requests = useRequestList();
  const item = requests.data?.items.find((r) => r.number === number) ?? null;
  const title = `Start from request #${number}`;

  if ((!status.data && !status.error) || (!requests.data && !requests.error)) {
    return (
      <WorkScreen header={<ContextRow title={title} />}>
        <OnePane label={title} width="reading">
          <LoadingState label="Reading the request" />
        </OnePane>
      </WorkScreen>
    );
  }
  const failed = status.error ?? requests.error;
  if (failed || !status.data) {
    const shown = failed ? describeError(failed) : { title: "Not available right now", message: "" };
    return (
      <WorkScreen header={<ContextRow title={title} />}>
        <OnePane label={title} width="reading">
          <ErrorState icon={<CircleAlert />} title={shown.title} message={shown.message} action={<Button onClick={() => void status.reload()}>Try again</Button>} />
        </OnePane>
      </WorkScreen>
    );
  }
  if (!item || item.state !== "accepted") {
    return (
      <WorkScreen header={<ContextRow title={title} />}>
        <OnePane label={title} width="reading">
          <ErrorState
            icon={<CircleAlert />}
            title={`Request #${number} cannot be started from here`}
            message={item?.not_accepted_reason ?? "MACH does not know this request, or it is not one that counts. The requests waiting are listed on the start screen."}
            action={
              <Button asChild>
                <Link to="/">Back to the start</Link>
              </Button>
            }
          />
        </OnePane>
      </WorkScreen>
    );
  }
  return <Steps status={status.data} item={item} title={title} reloadRequests={requests.reload} />;
}

function Steps({ status, item, title, reloadRequests }: { status: Status; item: RequestItem; title: string; reloadRequests: () => void }) {
  const navigate = useNavigate();
  const at = requestStep(status);
  const [open, setOpen] = useState<string | null>(at);
  const [seen, setSeen] = useState(at);
  // When an act moves the way on, the step that now needs the person opens.
  if (seen !== at) {
    setSeen(at);
    setOpen(at);
  }
  const [addEpic, setAddEpic] = useState(false);
  const [picking, setPicking] = useState(false);
  const epics = status.epics.filter((e) => e.status !== "deferred");

  return (
    <WorkScreen
      header={
        <ContextRow
          identity={
            <span className="text-body-sm text-ink-muted">
              Request <IssueLink number={item.number} url={item.url} />
            </span>
          }
          title={title}
        />
      }
    >
      <OnePane label={title} width="reading">
        <div className="flex flex-col gap-8 pb-6">
          <figure className="flex max-w-reading flex-col gap-1 border-l-2 border-line-strong pl-4">
            <blockquote className="break-words text-body-lg text-ink">{item.title ?? "Title not recorded"}</blockquote>
            <figcaption className="text-body-sm text-ink-muted">
              Filed on GitHub{item.labelled_by ? `, labelled as a request by ${item.labelled_by}` : ""}. Its words are data: they never answer a question for you.
            </figcaption>
          </figure>
          <Text tone="muted" className="max-w-reading">
            A request becomes a draft slice in one of your epics, and the epic belongs to the product. So the product is named first, then the epic it belongs to,
            then the request is picked up. Nothing is marked ready, sent or started.
          </Text>
          <Parts label={title} open={open} onOpenChange={setOpen}>
            <Part id="name" number={1} place={place("name", at)} name="Name the product" summary={status.project ? status.project.name : "Its name, vision and outcomes"}>
              {status.project ? (
                <Text>
                  Named {status.project.name}. Change it under{" "}
                  <Link to="/vision" className="font-semibold text-accent-ink underline-offset-2 hover:underline">
                    Vision and outcomes
                  </Link>
                  .
                </Text>
              ) : (
                <NameTheProduct level={null} why="Its name, a one-sentence vision and the outcomes people should get from it." />
              )}
            </Part>
            <Part
              id="epic"
              number={2}
              place={place("epic", at)}
              name="Add the epic it belongs to"
              summary={epics.length ? epics.map((e) => e.title).join(", ") : status.project ? "No epic yet" : "After the product is named"}
            >
              {status.project ? (
                <div className="flex max-w-reading flex-col items-start gap-3">
                  <Text>
                    {epics.length
                      ? "The request goes into one of these epics when you pick it up. Add another if none fits."
                      : "An epic is a larger capability, such as “Team membership”, that several slices deliver. Add the one this request belongs to."}
                  </Text>
                  <Button variant={epics.length ? "secondary" : "primary"} onClick={() => setAddEpic(true)}>
                    {epics.length ? "Add another epic" : "Add the epic"}
                  </Button>
                </div>
              ) : undefined}
            </Part>
            <Part id="pick" number={3} place={place("pick", at)} name="Pick it up" summary={at === "pick" ? `Ready to pick up request #${item.number}` : "After the epic"}>
              {at === "pick" ? (
                <div className="flex max-w-reading flex-col items-start gap-3">
                  <Text>Picking it up starts a draft slice with your own title, and notes on the request that it was taken in. The interview then asks you every question.</Text>
                  <Button variant="primary" onClick={() => setPicking(true)}>
                    Pick up request #{item.number}
                  </Button>
                </div>
              ) : undefined}
            </Part>
          </Parts>
        </div>
      </OnePane>
      <EpicSheet state={addEpic ? { mode: "add" } : null} onClose={() => setAddEpic(false)} />
      <PickUpDialog
        open={picking}
        onOpenChange={setPicking}
        item={item}
        also={false}
        epics={epics}
        onDone={reloadRequests}
        onPicked={(sliceId) => void navigate(`/slices/${sliceId}/interview`)}
      />
    </WorkScreen>
  );
}
