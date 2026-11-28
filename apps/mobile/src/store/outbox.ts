import type { MessageAttachment } from '@buzz-botmux/chat-client';
import { cached, saveSnapshot } from './localTimeline';
import type { StagedAttachment } from './reconcileTimeline';

export type OutgoingMessage = {
  messageId: string;
  channelId: string;
  content: string;
  threadId?: string;
  replyToId?: string;
  attachments?: MessageAttachment[];
  stagedAttachments?: StagedAttachment[];
};

export type OutboxEntry = OutgoingMessage & {
  uploaded?: MessageAttachment[];
  delivery?: 'queued' | 'confirming' | 'failed';
};

export function readOutbox(key: string) {
  return cached<OutboxEntry[]>(key) ?? [];
}

export function enqueue(key: string, message: OutgoingMessage) {
  const entries = readOutbox(key);
  const existing = entries.find(item => item.messageId === message.messageId);
  if (existing) {
    if (existing.delivery === 'failed') updateEntry(key, message.messageId, { delivery: 'queued' });
    return;
  }
  saveSnapshot(key, [...entries, message]);
}

export function updateEntry(key: string, id: string, patch: Partial<OutboxEntry>) {
  const entries = readOutbox(key);
  const index = entries.findIndex(item => item.messageId === id);
  if (index === -1) return;
  entries[index] = { ...entries[index], ...patch };
  saveSnapshot(key, entries);
}

export function removeFromOutbox(key: string, id: string) {
  const entries = readOutbox(key);
  if (entries.some(item => item.messageId === id))
    saveSnapshot(key, entries.filter(item => item.messageId !== id));
}
