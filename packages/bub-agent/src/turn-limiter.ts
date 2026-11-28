// FIFO among runnable turns. A busy conversation does not block other conversations.
export class TurnLimiter {
  private readonly active = new Set<string>();
  private readonly waiting = new Set<{ key: string; start: () => void }>();

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Expected positive concurrency');
  }

  async run<T>(key: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const entry = {
        key,
        start: () => {
          signal.removeEventListener('abort', abort);
          this.active.add(key);
          resolve();
        },
      };
      const abort = () => {
        this.waiting.delete(entry);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.add(entry);
      this.drain();
    });
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      this.active.delete(key);
      this.drain();
    }
  }

  private drain() {
    for (const entry of this.waiting) {
      if (this.active.size >= this.capacity) break;
      if (this.active.has(entry.key)) continue;
      this.waiting.delete(entry);
      entry.start();
    }
  }
}
