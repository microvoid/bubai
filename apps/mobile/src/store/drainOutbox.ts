import { MessageUnconfirmedError, MessageDisconnectedError, UploadHttpError, type MessageAttachment } from '@buzz-botmux/chat-client';
import type { OutboxEntry, OutgoingMessage } from './outbox';
import type { StagedAttachment } from './reconcileTimeline';

export type SendResult = 'sent' | 'queued' | 'confirming';
type Status = 'queued' | 'confirming' | 'failed';

interface OutboxDriver {
  entries(): OutboxEntry[];
  checkpoint(id: string, patch: Partial<OutboxEntry>): void;
  upload(file: StagedAttachment): Promise<MessageAttachment>;
  transmit(payload: OutgoingMessage): Promise<void>;
  settle(item: OutboxEntry, status: Status): void;
}

export function deliveryAfterError(error: unknown) {
  if (error instanceof MessageUnconfirmedError) return 'confirming';
  if (error instanceof MessageDisconnectedError || error instanceof TypeError) return 'queued';
  if (error instanceof UploadHttpError && (error.status >= 500 || [408, 425, 429].includes(error.status)))
    return 'queued';
  return 'failed';
}

// One uploader/sender per workspace. An unavailable file or a delayed receipt
// backs off independently, allowing the remaining conversations to make progress.
export function drainOutbox(driver: OutboxDriver) {
  let active = true;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const retries = new Map<string, { at: number; delay: number }>();

  function ready(entries: OutboxEntry[]) {
    return entries.find(item => (retries.get(item.messageId)?.at ?? 0) <= Date.now());
  }

  function schedule() {
    clearTimeout(timer);
    if (!active || busy) return;
    const entries = driver.entries().filter(item => item.delivery !== 'failed');
    if (!entries.length) return;
    const due = Math.min(...entries.map(item => retries.get(item.messageId)?.at ?? 0));
    timer = setTimeout(() => void attempt(), Math.max(0, due - Date.now()));
  }

  async function attempt(requestedId?: string): Promise<SendResult> {
    if (!active || busy) return 'queued';
    const item = ready(driver.entries().filter(entry => entry.delivery !== 'failed'));
    if (!item) return 'queued';
    busy = true;
    clearTimeout(timer);
    const id = item.messageId;
    const staged = item.stagedAttachments ?? [];
    const uploaded = [...(item.uploaded ?? [])];
    try {
      for (const file of staged.slice(uploaded.length)) {
        const result = await driver.upload(file);
        if (!active) return 'queued';
        uploaded.push(result);
        driver.checkpoint(id, { uploaded });
      }
      if (!active) return 'queued';
      // Journal the exact wire payload before writing. A restart can replay
      // this ID and the same upload IDs even if its receipt was lost.
      driver.checkpoint(id, { delivery: 'confirming' });
      await driver.transmit({
        messageId: id,
        channelId: item.channelId,
        threadId: item.threadId,
        replyToId: item.replyToId,
        content: item.content,
        attachments: staged.length ? uploaded : item.attachments,
      });
      retries.delete(id);
      // message.created removes the entry, including for late receipts that
      // arrive when no attempt is awaiting this particular ID.
      return requestedId === id ? 'sent' : 'queued';
    } catch (error) {
      const stored = driver.entries().find(entry => entry.messageId === id);
      if (!stored) return requestedId === id ? 'sent' : 'queued';
      if (!active) return stored.delivery === 'confirming' ? 'confirming' : 'queued';
      const status = deliveryAfterError(error);
      driver.checkpoint(id, { delivery: status });
      driver.settle(item, status);
      if (status === 'failed') {
        retries.delete(id);
        if (id === requestedId) throw error;
      } else {
        const delay = Math.min(60_000, (retries.get(id)?.delay ?? 1000) * 2);
        retries.set(id, { at: Date.now() + delay, delay });
      }
      return requestedId === id && status === 'confirming' ? 'confirming' : 'queued';
    } finally {
      busy = false;
      schedule();
    }
  }

  schedule();
  return {
    attempt,
    received(id: string) { retries.delete(id); },
    close() { active = false; clearTimeout(timer); },
  };
}
