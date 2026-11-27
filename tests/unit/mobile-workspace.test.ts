import { expect, test } from 'bun:test';
import type { Channel } from '../../packages/chat-client/src';
import { notificationRoute } from '../../apps/mobile/src/services/notificationRoute';
import {
  checkSessionResponse,
  onSessionExpired,
} from '../../apps/mobile/src/services/sessionExpiry';
import { coalescedRefresh } from '../../apps/mobile/src/store/coalescedRefresh';
import { unreadCount, visibleUnread } from '../../apps/mobile/src/store/unread';

test('notification taps target the supplied channel, reply and message only', () => {
  expect(notificationRoute({ channelId: 'c', threadId: 'r', messageId: 'm' })).toEqual({
    pathname: '/thread/[channelId]/[rootId]',
    params: { channelId: 'c', rootId: 'r', messageId: 'm' },
  });
  expect(notificationRoute({ channelId: 'c', threadId: null })).toEqual({
    pathname: '/channel/[id]',
    params: { id: 'c' },
  });
  expect(notificationRoute({ url: 'https://example.com' })).toBeNull();
  expect(notificationRoute({ channelId: 'c', threadId: '../other' })).toBeNull();
});

test('DMs and channels count unread replies and manual unread, and mute removes them from Unread', () => {
  for (const kind of ['dm', 'channel']) {
    const base = { kind, unreadCount: 2, threadUnreadCount: 3, markedUnread: true } as Channel;
    expect(unreadCount(base)).toBe(5);
    expect(unreadCount({ ...base, unreadCount: 0, threadUnreadCount: 0 })).toBe(1);
    expect(visibleUnread({ ...base, muted: true })).toBe(false);
  }
});

test('only authenticated 401 responses notify the active session handler', () => {
  const calls: string[][] = [];
  const unsubscribe = onSessionExpired((url, token) => calls.push([url, token]));
  try {
    checkSessionResponse(503, 'a', 't');
    checkSessionResponse(401, 'a');
    checkSessionResponse(401, 'a', 't');
  } finally {
    unsubscribe();
  }
  checkSessionResponse(401, 'b', 't');
  expect(calls).toEqual([['a', 't']]);
});

test('stream bursts coalesce per root, discard stale replies, and stop on unmount', async () => {
  const pending: ((value: number) => void)[] = [];
  const results: number[] = [];
  const refresh = coalescedRefresh<string, number>(
    () => new Promise((done) => pending.push(done)),
    (_, n) => results.push(n),
    2,
  );
  for (let n = 0; n < 30; n++) refresh.schedule('root');
  await Bun.sleep(15);
  expect(pending).toHaveLength(1);
  refresh.schedule('root');
  pending[0](1);
  await Bun.sleep(15);
  expect(pending).toHaveLength(2);
  expect(results).toEqual([]);
  pending[1](2);
  await Bun.sleep(5);
  refresh.schedule('root');
  refresh.close();
  await Bun.sleep(10);
  expect(results).toEqual([2]);
  expect(pending).toHaveLength(2);
});
