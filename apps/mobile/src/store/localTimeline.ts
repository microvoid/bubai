import Storage from 'expo-sqlite/kv-store';
import { useMemo, useSyncExternalStore } from 'react';
import type { ChatMessage } from '@buzz-botmux/chat-client';

export function cached<T>(key: string): T | undefined {
  const value = Storage.getItemSync(key);
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function saveSnapshot(key: string, value: unknown) {
  Storage.setItemSync(key, JSON.stringify(value));
}

export type LocalMessage = ChatMessage & {
  delivery?: 'sending' | 'queued' | 'failed';
};
type Settlement = (id: string, failed: boolean) => void;
const mounted = new Map<string, Set<Settlement>>();
export function settleQueued(key: string, id: string, failed: boolean) {
  const listeners = mounted.get(key);
  if (listeners?.size) {
    for (const settle of listeners) settle(id, failed);
    return;
  }
  const rows = cached<LocalMessage[]>(key);
  if (rows)
    saveSnapshot(
      key,
      rows.map((row) =>
        row.id === id && row.delivery
          ? { ...row, delivery: failed ? 'failed' : undefined }
          : row,
      ),
    );
}
export function useTimeline(
  server: string | null,
  user: string,
  org: string | null,
  channel: string,
  root: string | null,
) {
  const key = JSON.stringify(['timeline', server, user, org, channel, root]);
  const store = useMemo(() => {
    let rows = (cached<LocalMessage[]>(key) ?? []).map((row) =>
      row.delivery === 'sending'
        ? { ...row, delivery: 'failed' as const }
        : row,
    );
    const listeners = new Set<() => void>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    function persist() {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      const pending = rows.filter((row) => row.delivery);
      const latest = rows.filter((row) => !row.delivery).slice(-150);
      if (root && rows[0]?.id === root && !latest.some((x) => x.id === root))
        latest.unshift(rows[0]);
      saveSnapshot(key, [...latest, ...pending]);
    }
    function update(
      next: LocalMessage[] | ((prev: LocalMessage[]) => LocalMessage[]),
    ) {
      const prior = rows;
      rows = typeof next === 'function' ? next(rows) : next;
      if (rows === prior) return;
      // Persist the outbox immediately. Batch streaming edits to ordinary messages.
      if (
        !prior.length ||
        rows.some((row) => row.delivery) ||
        prior.some((row) => row.delivery)
      )
        persist();
      else if (!flushTimer) flushTimer = setTimeout(persist, 100);
      listeners.forEach((fn) => fn());
    }
    return {
      snapshot: () => rows,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        const settle: Settlement = (id, failed) =>
          update((previous) =>
            previous.map((row) =>
              row.id === id && row.delivery
                ? { ...row, delivery: failed ? 'failed' : undefined }
                : row,
            ),
          );
        const callbacks = mounted.get(key) ?? new Set<Settlement>();
        callbacks.add(settle);
        mounted.set(key, callbacks);
        return () => {
          listeners.delete(fn);
          callbacks.delete(settle);
          if (!callbacks.size) mounted.delete(key);
          if (!listeners.size && flushTimer) persist();
        };
      },
      update,
      reconcile: (canonical: ChatMessage[]) =>
        update((prev) => [
          ...canonical,
          ...prev.filter(
            (row) => row.delivery && !canonical.some((x) => x.id === row.id),
          ),
        ]),
    };
  }, [key, root]);
  const rows = useSyncExternalStore(store.subscribe, store.snapshot);
  return { rows, ...store };
}
