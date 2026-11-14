/**
 * The session's free-text display policy (`/session` `display_policy`) for the floor and Timeline
 * (M6.6, I-05): read once per observer client, shared by every inspector. Analytics reads the same
 * reply through its provider (`analytics/data/observer.ts`). Until it answers, without an observer
 * (the simulation), or when it declares nothing, the policy is UNDECLARED_POLICY: every field the
 * observer is known to keep as prose is still contained (`text/fields.ts`), so containment never
 * waits for the reply.
 */
import { useEffect, useState } from "react";
import type { ObserverClient } from "../live";
import { readDisplayPolicy, UNDECLARED_POLICY, type DisplayPolicy } from "../text/unchecked";
import { setSessionPolicy } from "../text/fields";
import { useSource } from "./source/context";

const cache = new WeakMap<ObserverClient, Promise<DisplayPolicy>>();

/** The policy for one client: asked once; a failed read is asked again next time, never remembered. */
export function displayPolicyOf(client: ObserverClient): Promise<DisplayPolicy> {
  let hit = cache.get(client);
  if (!hit) {
    hit = (client.displayPolicy ? client.displayPolicy().then(readDisplayPolicy) : Promise.resolve(UNDECLARED_POLICY)).then((p) => {
      // Drawing code (Blueprint, Atlas, the Timeline's canvas) reads the same policy outside React.
      setSessionPolicy(p);
      return p;
    });
    hit.catch(() => cache.delete(client));
    cache.set(client, hit);
  }
  return hit;
}

export function useDisplayPolicy(): DisplayPolicy {
  const { client } = useSource();
  const [found, setFound] = useState<{ client: ObserverClient; policy: DisplayPolicy } | null>(null);
  useEffect(() => {
    if (!client) return;
    let alive = true;
    displayPolicyOf(client).then(
      (policy) => alive && setFound({ client, policy }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [client]);
  return found && found.client === client ? found.policy : UNDECLARED_POLICY;
}
