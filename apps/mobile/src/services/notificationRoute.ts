const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w-]+$/.test(value);

export function notificationDestination(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null;
  const { channelId, threadId, messageId, organizationId } = payload as Record<string, unknown>;
  if (!validId(channelId) || (threadId != null && !validId(threadId)) ||
      (organizationId != null && !validId(organizationId))) return null;

  const query = validId(messageId) ? { messageId } : {};
  const route = validId(threadId)
    ? { pathname: '/thread/[channelId]/[rootId]' as const, params: { channelId, rootId: threadId, ...query } }
    : { pathname: '/channel/[id]' as const, params: { id: channelId, ...query } };
  return { route, organizationId: organizationId ?? null };
}
