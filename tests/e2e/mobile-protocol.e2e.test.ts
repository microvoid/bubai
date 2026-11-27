import { beforeAll, afterAll, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BubaiClient, type ServerWsEvent } from '../../packages/chat-client/src';

const directory = mkdtempSync(join(tmpdir(), 'bubai-mobile-protocol-'));
const baseUrl = 'http://127.0.0.1:4298';
const client = new BubaiClient({ baseUrl });
const userId = 'u-owner';
let proc: ReturnType<typeof Bun.spawn>;
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error('Timed out waiting for mobile protocol event');
}
beforeAll(async () => {
  proc = Bun.spawn(['bun', resolve(import.meta.dir, '../../apps/server/src/main.ts')], {
    cwd: directory,
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      ...process.env,
      PORT: '4298',
      DATABASE_URL: '',
      BUZZ_BOT_TOKEN: '',
      BUBAI_AUTH_REQUIRED: 'false',
      BOTMUX_ENDPOINT: 'http://127.0.0.1:19998',
    },
  });
  await until(() =>
    client.getInstance().then(
      () => true,
      () => false,
    ),
  );
}, 20000);
afterAll(async () => {
  proc.kill();
  await proc.exited;
  rmSync(directory, { recursive: true, force: true });
});

test('mobile SDK receives correlated receipts, heartbeats and thread history after reconnect', async () => {
  const { channel } = await client.createChannel({ name: 'mobile-ws', userId });
  const events: ServerWsEvent[] = [];
  let opens = 0;
  const socket = client.connectWebSocket({
    userId,
    heartbeatMs: 150,
    onEvent: (event) => events.push(event),
    onStateChange: (state) => {
      if (state === 'open') opens++;
    },
  });
  try {
    await until(() => events.some((event) => event.type === 'pong'));
    const payload = {
      messageId: crypto.randomUUID(),
      channelId: channel.id,
      senderId: userId,
      content: 'root',
    };
    await socket.sendMessage(payload);
    await socket.sendMessage(payload);
    expect(
      (await client.getChannelMessages(channel.id)).messages.filter(
        (m) => m.id === payload.messageId,
      ),
    ).toHaveLength(1);
    await socket.sendMessage({
      ...payload,
      messageId: crypto.randomUUID(),
      threadId: payload.messageId,
      content: 'reply',
    });
    socket.reconnectNow();
    await until(() => opens === 2);
    expect((await client.getThread(channel.id, payload.messageId)).replies[0].content).toBe(
      'reply',
    );
    expect(
      (await client.getChannelMessages(channel.id)).messages[0].replyPreviews?.[0].content,
    ).toBe('reply');
    expect(
      (await client.markThreadRead(channel.id, payload.messageId, userId)).lastReadAt,
    ).toBeGreaterThan(0);
    await client.archiveChannel(channel.id, { userId, archived: true });
    await expect(
      socket.sendMessage({ ...payload, messageId: crypto.randomUUID() }),
    ).rejects.toThrow(/archived/i);
  } finally {
    socket.close();
  }
});

test('channel settings and sidebar placement survive mobile bootstrap', async () => {
  const { channel } = await client.createChannel({ name: 'mobile-room', userId });
  const { group } = await client.createSidebarGroup('My channels', userId);
  await client.renameSidebarGroup(group.id, 'Team', userId);
  await client.updateChannelSettings(channel.id, {
    userId,
    name: 'renamed',
    topic: 'mobile',
    replyMode: 'always_thread',
  });
  await client.placeChannel(channel.id, { userId, groupId: group.id, starred: true });
  await client.muteChannel(channel.id, { userId, muted: true });
  await client.markChannelUnread(channel.id, { userId });
  const boot = await client.bootstrap(userId);
  expect(boot.sidebarGroups).toContainEqual({ id: group.id, name: 'Team' });
  expect(boot.channels.find((ch) => ch.id === channel.id)).toMatchObject({
    name: 'renamed',
    topic: 'mobile',
    replyMode: 'always_thread',
    starred: true,
    muted: true,
    markedUnread: true,
    groupId: group.id,
  });
  expect(Array.isArray((await client.getActivity(userId)).items)).toBe(true);
  await client.hideChannel(channel.id, { userId, hidden: true });
  expect((await client.bootstrap(userId)).channels.some((ch) => ch.id === channel.id)).toBe(false);
  await client.deleteSidebarGroup(group.id, userId);
  await client.deleteChannel(channel.id, userId);
});

test('mobile roster, mentions, thread activity and file messages use the same server state', async () => {
  const { channel } = await client.createChannel({ name: 'mobile-collaboration', userId });
  const { agent } = await client.provisionAgent({
    name: 'Local Native Fixture',
    adapterType: 'gateway',
  });
  const events: ServerWsEvent[] = [];
  const socket = client.connectWebSocket({
    userId,
    heartbeatMs: 150,
    onEvent: (event) => events.push(event),
  });
  try {
    await until(() => events.some((event) => event.type === 'pong'));
    await client.upsertChannelMember(channel.id, { agentId: agent.id });
    await until(() =>
      events.some(
        (event) =>
          event.type === 'channel.members.updated' &&
          event.payload.members.some((m) => m.agentId === agent.id),
      ),
    );
    await client.markChannelRead(channel.id, userId);
    const root = await client.sendBotMessage({
      channelId: channel.id,
      botId: agent.id,
      content: '@Owner file review',
    });
    const activity = await client.getActivity(userId);
    expect(
      activity.items.some((item) => item.kind === 'mention' && item.messageId === root.message.id),
    ).toBe(true);
    await client.sendBotMessage({
      channelId: channel.id,
      botId: agent.id,
      threadId: root.message.id,
      content: 'thread update',
    });
    expect(
      (await client.getChannelMessages(channel.id, { userId })).messages[0].unreadReplyCount,
    ).toBeGreaterThan(0);
    expect((await client.getThreadPreview(channel.id, root.message.id, userId)).unreadReplyCount).toBeGreaterThan(0);
    await client.markThreadRead(channel.id, root.message.id, userId);
    expect((await client.getThreadPreview(channel.id, root.message.id, userId)).unreadReplyCount).toBe(0);
    expect(
      (await client.getChannelMessages(channel.id, { userId })).messages[0].unreadReplyCount ?? 0,
    ).toBe(0);

    const uploads = await Promise.all(
      ['one', 'two'].map(async (text) => {
        const form = new FormData();
        form.append('file', new File([text], text + '.txt', { type: 'text/plain' }));
        return client.uploadFile(form);
      }),
    );
    const messageId = crypto.randomUUID();
    await socket.sendMessage({
      messageId,
      channelId: channel.id,
      threadId: root.message.id,
      senderId: userId,
      content: '# Files',
      attachments: uploads,
    });
    const reply = (await client.getThread(channel.id, root.message.id)).replies.find(
      (m) => m.id === messageId,
    );
    expect(reply?.attachments?.map((a) => a.name)).toEqual(['one.txt', 'two.txt']);
    expect(await (await fetch(new URL(uploads[0].url, baseUrl))).text()).toBe('one');
    await client.editMessage(messageId, 'edited');
    expect(
      (await client.getThread(channel.id, root.message.id)).replies.find((m) => m.id === messageId)
        ?.content,
    ).toBe('edited');
    await client.deleteMessage(messageId);
    expect(
      (await client.getThread(channel.id, root.message.id)).replies.some((m) => m.id === messageId),
    ).toBe(false);
    await client.removeChannelMember(channel.id, { agentId: agent.id });
    expect(
      (await client.getChannelMembers(channel.id)).members.some((m) => m.agentId === agent.id),
    ).toBe(false);
  } finally {
    socket.close();
  }
});
