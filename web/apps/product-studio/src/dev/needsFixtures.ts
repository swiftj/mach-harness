/**
 * DEVELOPMENT ONLY. The M17 fixtures for Technical needs and a design you already have: real engine output generated
 * by web/fixtures/needs_memory.py (python3 web/fixtures/generate.py --only needs). Each file is imported through
 * `run<T>()`, which checks its field names and nesting against the types in @mach/ui/api at compile time, so a renamed
 * or missing field fails the typecheck. needsTransport.ts answers from these in fixture mode; production code never
 * imports this module. This file is written by a script from the fixture list, as shapeFixtures.ts is: add a capture to
 * needs_memory.py, regenerate, and add its row here.
 */
import type {
  DesignImport,
  DesignMapRecorded,
  DesignPublished,
  DesignSettled,
  DesignShow,
  EngineRun,
  LooseJson,
  NeedChanged,
  NeedList,
  NeedNothingToSay,
  NeedsPublishResult,
  Operations,
  ReconcileNeeds,
  Refresh,
  Status,
} from "@mach/ui/api";

import designImport from "../../../../fixtures/design.import.json";
import designImportAgain from "../../../../fixtures/design.import.again.json";
import designImportRefusedBinary from "../../../../fixtures/design.import.refused-binary.json";
import designListChangedCopy from "../../../../fixtures/design.list.changed-copy.json";
import designListChangedSincePublished from "../../../../fixtures/design.list.changed-since-published.json";
import designPublishRefusedChangedCopy from "../../../../fixtures/design.publish.refused-changed-copy.json";
import designPublishRefusedTopicsChanged from "../../../../fixtures/design.publish.refused-topics-changed.json";
import designSettleAskEngineer from "../../../../fixtures/design.settle.ask-engineer.json";
import designSettleStands from "../../../../fixtures/design.settle.stands.json";
import designShowChangedSincePublished from "../../../../fixtures/design.show.changed-since-published.json";
import designShowRefusedChangedCopy from "../../../../fixtures/design.show.refused-changed-copy.json";
import designListEmpty from "../../../../fixtures/design.list.empty.json";
import designListImported from "../../../../fixtures/design.list.imported.json";
import designListMapped from "../../../../fixtures/design.list.mapped.json";
import designListPublished from "../../../../fixtures/design.list.published.json";
import designMap from "../../../../fixtures/design.map.json";
import designPublish from "../../../../fixtures/design.publish.json";
import designPublishAgain from "../../../../fixtures/design.publish.again.json";
import designPublishRefusedNoMap from "../../../../fixtures/design.publish.refused-no-map.json";
import designPublishRefusedUnsettled from "../../../../fixtures/design.publish.refused-unsettled.json";
import designSettle from "../../../../fixtures/design.settle.json";
import designSettleRefusedNoConflict from "../../../../fixtures/design.settle.refused-no-conflict.json";
import designShowLines from "../../../../fixtures/design.show.lines.json";
import designShowMapped from "../../../../fixtures/design.show.mapped.json";
import designShowPublished from "../../../../fixtures/design.show.published.json";
import designShowSettled from "../../../../fixtures/design.show.settled.json";
import designShowUnmapped from "../../../../fixtures/design.show.unmapped.json";
import needAdd from "../../../../fixtures/need.add.json";
import needAddData from "../../../../fixtures/need.add.data.json";
import needAddGiven from "../../../../fixtures/need.add.given.json";
import needAddRefusedGivenWithoutWho from "../../../../fixtures/need.add.refused-given-without-who.json";
import needAddRefusedTechnology from "../../../../fixtures/need.add.refused-technology.json";
import needListAdrBehind from "../../../../fixtures/need.list.adr-behind.json";
import needListAnsweredSome from "../../../../fixtures/need.list.answered-some.json";
import needListEmpty from "../../../../fixtures/need.list.empty.json";
import needListNewerElsewhere from "../../../../fixtures/need.list.newer-elsewhere.json";
import needListPublished from "../../../../fixtures/need.list.published.json";
import needListSeveral from "../../../../fixtures/need.list.several.json";
import needNone from "../../../../fixtures/need.none.json";
import needNoneRefusedHasNeed from "../../../../fixtures/need.none.refused-has-need.json";
import needPublish from "../../../../fixtures/need.publish.json";
import needPublishAgain from "../../../../fixtures/need.publish.again.json";
import needPublishRefusedNewerElsewhere from "../../../../fixtures/need.publish.refused-newer-elsewhere.json";
import needPublishRefusedNone from "../../../../fixtures/need.publish.refused-none.json";
import needRetire from "../../../../fixtures/need.retire.json";
import needSet from "../../../../fixtures/need.set.json";
import needSetRefusedRetired from "../../../../fixtures/need.set.refused-retired.json";
import needSetWhy from "../../../../fixtures/need.set.why.json";
import reconcileNeeds from "../../../../fixtures/reconcile.needs.json";
import reconcileNeedsRefusedNothingNewer from "../../../../fixtures/reconcile.needs.refused-nothing-newer.json";
import refreshNeedsNewerElsewhere from "../../../../fixtures/refresh.needs-newer-elsewhere.json";
import statusDesignsPublished from "../../../../fixtures/status.designs-published.json";
import statusDesignsUnsettled from "../../../../fixtures/status.designs-unsettled.json";
import statusNeedsAdrBehind from "../../../../fixtures/status.needs-adr-behind.json";
import statusNeedsNewerElsewhere from "../../../../fixtures/status.needs-newer-elsewhere.json";
import statusNeedsNone from "../../../../fixtures/status.needs-none.json";
import statusNeedsUnpublished from "../../../../fixtures/status.needs-unpublished.json";

/** Checks the file's shape against the engine type at compile time, then narrows to it. */
function run<T>(json: LooseJson<EngineRun<T>>): EngineRun<T> {
  return json as EngineRun<T>;
}

/** A refusal: the engine's words and its hint, no data. */
const refusal = (json: LooseJson<EngineRun<null>>): EngineRun<null> => json as EngineRun<null>;

type R<K extends keyof Operations> = Operations[K]["result"];

/** Every technical needs and design fixture by its file name. */
export const needsRuns = {
  "design.import": run<DesignImport>(designImport),
  "design.import.again": run<DesignImport>(designImportAgain),
  "design.import.refused-binary": refusal(designImportRefusedBinary),
  "design.list.changed-copy": run<R<"design.list">>(designListChangedCopy),
  "design.list.changed-since-published": run<R<"design.list">>(designListChangedSincePublished),
  "design.publish.refused-changed-copy": refusal(designPublishRefusedChangedCopy),
  "design.publish.refused-topics-changed": refusal(designPublishRefusedTopicsChanged),
  "design.settle.ask-engineer": run<DesignSettled>(designSettleAskEngineer),
  "design.settle.stands": run<DesignSettled>(designSettleStands),
  "design.show.changed-since-published": run<DesignShow>(designShowChangedSincePublished),
  "design.show.refused-changed-copy": refusal(designShowRefusedChangedCopy),
  "design.list.empty": run<R<"design.list">>(designListEmpty),
  "design.list.imported": run<R<"design.list">>(designListImported),
  "design.list.mapped": run<R<"design.list">>(designListMapped),
  "design.list.published": run<R<"design.list">>(designListPublished),
  "design.map": run<DesignMapRecorded>(designMap),
  "design.publish": run<DesignPublished>(designPublish),
  "design.publish.again": run<DesignPublished>(designPublishAgain),
  "design.publish.refused-no-map": refusal(designPublishRefusedNoMap),
  "design.publish.refused-unsettled": refusal(designPublishRefusedUnsettled),
  "design.settle": run<DesignSettled>(designSettle),
  "design.settle.refused-no-conflict": refusal(designSettleRefusedNoConflict),
  "design.show.lines": run<DesignShow>(designShowLines),
  "design.show.mapped": run<DesignShow>(designShowMapped),
  "design.show.published": run<DesignShow>(designShowPublished),
  "design.show.settled": run<DesignShow>(designShowSettled),
  "design.show.unmapped": run<DesignShow>(designShowUnmapped),
  "need.add": run<NeedChanged>(needAdd),
  "need.add.data": run<NeedChanged>(needAddData),
  "need.add.given": run<NeedChanged>(needAddGiven),
  "need.add.refused-given-without-who": refusal(needAddRefusedGivenWithoutWho),
  "need.add.refused-technology": refusal(needAddRefusedTechnology),
  "need.list.adr-behind": run<NeedList>(needListAdrBehind),
  "need.list.answered-some": run<NeedList>(needListAnsweredSome),
  "need.list.empty": run<NeedList>(needListEmpty),
  "need.list.newer-elsewhere": run<NeedList>(needListNewerElsewhere),
  "need.list.published": run<NeedList>(needListPublished),
  "need.list.several": run<NeedList>(needListSeveral),
  "need.none": run<NeedNothingToSay>(needNone),
  "need.none.refused-has-need": refusal(needNoneRefusedHasNeed),
  "need.publish": run<NeedsPublishResult>(needPublish),
  "need.publish.again": run<NeedsPublishResult>(needPublishAgain),
  // Never blocked: publishing over a newer version goes ahead, replacing it and keeping theirs (the file keeps its old name).
  "need.publish.refused-newer-elsewhere": run<NeedsPublishResult>(needPublishRefusedNewerElsewhere),
  "need.publish.refused-none": refusal(needPublishRefusedNone),
  "need.retire": run<NeedChanged>(needRetire),
  "need.set": run<NeedChanged>(needSet),
  "need.set.refused-retired": refusal(needSetRefusedRetired),
  "need.set.why": run<NeedChanged>(needSetWhy),
  "reconcile.needs": run<ReconcileNeeds>(reconcileNeeds),
  "reconcile.needs.refused-nothing-newer": refusal(reconcileNeedsRefusedNothingNewer),
  "refresh.needs-newer-elsewhere": run<Refresh>(refreshNeedsNewerElsewhere),
  "status.designs-published": run<Status>(statusDesignsPublished),
  "status.designs-unsettled": run<Status>(statusDesignsUnsettled),
  "status.needs-adr-behind": run<Status>(statusNeedsAdrBehind),
  "status.needs-newer-elsewhere": run<Status>(statusNeedsNewerElsewhere),
  "status.needs-none": run<Status>(statusNeedsNone),
  "status.needs-unpublished": run<Status>(statusNeedsUnpublished),
} as const;

export type NeedsFixture = keyof typeof needsRuns;
