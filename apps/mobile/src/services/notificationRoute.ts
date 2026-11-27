export function notificationRoute(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const { channelId, threadId, messageId } = payload as Record<string, unknown>;
  const valid = (id: unknown): id is string => typeof id === 'string' && /^[\w-]+$/.test(id);
  if (!valid(channelId) || (threadId != null && !valid(threadId))) return null;
  const query = valid(messageId) ? { messageId } : {};
  return valid(threadId)
    ? {
        pathname: '/thread/[channelId]/[rootId]' as const,
        params: { channelId, rootId: threadId, ...query },
      }
    : { pathname: '/channel/[id]' as const, params: { id: channelId, ...query } };
}
