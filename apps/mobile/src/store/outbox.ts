import type { MessageAttachment } from '@buzz-botmux/chat-client';
import { cached, saveSnapshot } from './localTimeline';

export type OutgoingMessage = {
  messageId: string;
  channelId: string;
  content: string;
  threadId?: string;
  replyToId?: string;
  attachments?: MessageAttachment[];
};

export function addToOutbox(key: string, message: OutgoingMessage) {
  const pending = cached<OutgoingMessage[]>(key) ?? [];
  if (!pending.some((item) => item.messageId === message.messageId)) {
    saveSnapshot(key, [...pending, message]);
  }
}

export function removeFromOutbox(key: string, id: string) {
  saveSnapshot(
    key,
    (cached<OutgoingMessage[]>(key) ?? []).filter(
      (item) => item.messageId !== id,
    ),
  );
}
