/**
 * The observer's evidence catalog as the inspector needs it: whether a scene artifact is served as
 * free text not checked for names (R1, the product owner's decision: served, and labelled wherever
 * it is listed or opened). Read once per ticket and client (`/artifacts?ticket=`), metadata only.
 */
import { useEffect, useState } from "react";
import type { ArtifactEntry, ObserverClient } from "../../live";
import { freeTextLabelOf } from "./free-text";
import type { ArtifactState } from "../../sim";
import { useSource } from "../source/context";

type Entries = readonly ArtifactEntry[];
const cache = new WeakMap<ObserverClient, Map<string, Promise<Entries>>>();

function entriesFor(client: ObserverClient, ticket: string): Promise<Entries> {
  let perClient = cache.get(client);
  if (!perClient) cache.set(client, (perClient = new Map()));
  let hit = perClient.get(ticket);
  if (!hit) {
    hit = (async () => {
      const out: ArtifactEntry[] = [];
      for (let offset = 0; offset < 5_000; ) {
        const page = await client.artifacts({ ticket, limit: 200, offset });
        out.push(...page.items);
        if (!page.more || !page.items.length) break;
        offset += page.items.length;
      }
      return out;
    })();
    // A failed read is asked again next time, never remembered as "no free text".
    hit.catch(() => perClient?.delete(ticket));
    perClient.set(ticket, hit);
  }
  return hit;
}

/** The label for one artifact while the inspector shows it; null for the simulation, before the catalog answers, or when it is not free text. */
export function useFreeTextLabel(artifact: Pick<ArtifactState, "id" | "ticketId" | "path"> & { readonly meta: { readonly authority: string } }): string | null {
  const { client } = useSource();
  const real = artifact.meta.authority !== "simulated";
  const [found, setFound] = useState<{ key: string; label: string | null } | null>(null);
  const key = `${artifact.ticketId}\u0000${artifact.id}`;
  useEffect(() => {
    if (!client || !real) return;
    let alive = true;
    entriesFor(client, artifact.ticketId).then(
      (entries) => alive && setFound({ key, label: freeTextLabelOf(entries, artifact) }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the artifact's identity
  }, [client, real, key]);
  return found && found.key === key ? found.label : null;
}
