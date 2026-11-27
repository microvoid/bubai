// Serialize requests for each key. Events during a request schedule one trailing refresh.
export function coalescedRefresh<K, V>(
  load: (key: K) => Promise<V>,
  apply: (key: K, value: V) => void,
  delay = 250,
) {
  const active = new Map<K, { dirty: boolean; timer?: ReturnType<typeof setTimeout> }>();
  let closed = false;
  function schedule(key: K) {
    if (closed) return;
    const existing = active.get(key);
    if (existing) {
      existing.dirty = true;
      return;
    }
    const entry = { dirty: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    active.set(key, entry);
    entry.timer = setTimeout(async () => {
      entry.dirty = false;
      try {
        const value = await load(key);
        if (!closed && !entry.dirty) apply(key, value);
      } catch {
        /* A later event or a history reload retries the refresh. */
      } finally {
        active.delete(key);
        if (entry.dirty) schedule(key);
      }
    }, delay);
  }
  return {
    schedule,
    close() {
      closed = true;
      for (const entry of active.values()) clearTimeout(entry.timer);
      active.clear();
    },
  };
}
