/**
 * What the delivery screens remember for the length of this browser session.
 *
 * `status` does not report approvals withdrawn by a refresh or a reconcile, nor what a renumber left
 * needing approval again; those arrive only in the reply to that act. They are kept here (and in
 * sessionStorage, guarded) so the Decision Inbox can still show them after the page that did the
 * act is left. ENGINE GAP: `status` should report withdrawn approvals and their reason itself.
 */
import { useSyncExternalStore } from "react";
import type { Refresh } from "@mach/ui/api";

export interface Withdrawal {
  id: string;
  /** Why, in plain words: what took the approval away. */
  why: string;
  at: string;
}

export interface DeliveryMemory {
  withdrawn: Withdrawal[];
  needsApprovalAgain: Withdrawal[];
  lastRefresh: { at: string; result: Refresh } | null;
}

const KEY = "mach.delivery.memory.v1";
const empty: DeliveryMemory = { withdrawn: [], needsApprovalAgain: [], lastRefresh: null };

function load(): DeliveryMemory {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as DeliveryMemory) } : empty;
  } catch {
    return empty;
  }
}

let memory: DeliveryMemory = load();
const listeners = new Set<() => void>();

function set(next: DeliveryMemory) {
  memory = next;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: memory still works for this page
  }
  listeners.forEach((listener) => listener());
}

function merge(list: Withdrawal[], ids: string[], why: string): Withdrawal[] {
  const at = new Date().toISOString();
  const kept = list.filter((item) => !ids.includes(item.id));
  return [...kept, ...ids.map((id) => ({ id, why, at }))];
}

export function rememberWithdrawn(ids: string[], why: string) {
  if (ids.length) set({ ...memory, withdrawn: merge(memory.withdrawn, ids, why) });
}

export function rememberNeedsApprovalAgain(ids: string[], why: string) {
  if (ids.length) set({ ...memory, needsApprovalAgain: merge(memory.needsApprovalAgain, ids, why) });
}

export function forget(id: string) {
  set({ ...memory, withdrawn: memory.withdrawn.filter((w) => w.id !== id), needsApprovalAgain: memory.needsApprovalAgain.filter((w) => w.id !== id) });
}

export function rememberRefresh(result: Refresh) {
  set({ ...memory, lastRefresh: { at: new Date().toISOString(), result } });
  if (result.approvals_withdrawn.length) {
    rememberWithdrawn(result.approvals_withdrawn, "A change from the shared project replaced what you had approved.");
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDeliveryMemory(): DeliveryMemory {
  return useSyncExternalStore(subscribe, () => memory, () => memory);
}
