import type { Channel } from '@buzz-botmux/chat-client';

export function unreadCount(channel: Channel) {
  return Math.max(
    (channel.unreadCount || 0) + (channel.threadUnreadCount || 0),
    channel.mentionCount || 0,
    Number(Boolean(channel.markedUnread)),
  );
}

export function visibleUnread(channel: Channel) {
  return !channel.muted && unreadCount(channel) > 0;
}
