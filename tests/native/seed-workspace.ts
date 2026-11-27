import { BubaiClient } from '../../packages/chat-client/src';

export async function seedNativeWorkspace(baseUrl: string) {
  const client = new BubaiClient({ baseUrl });
  const userId = 'u-owner';
  const { agent } = await client.provisionAgent({
    agentId: 'local-e2e',
    name: 'Local Fixture',
    adapterType: 'gateway',
    channelName: 'general',
    autoReply: false,
  });
  await client.sendBotMessage({
    botId: agent.id,
    channelName: 'general',
    content: 'Native timeline E2E fixture',
  });
  await client.createChannel({ name: 'native-mentions', userId });
  const { channel } = await client.createChannel({ name: 'native-discussion', userId });
  const { message: root } = await client.sendBotMessage({
    botId: agent.id,
    channelId: channel.id,
    content: '# Native review\n\n@Owner please review the files.',
  });
  await client.sendBotMessage({
    botId: agent.id,
    channelId: channel.id,
    threadId: root.id,
    content: 'Preview from a colleague',
  });

  const { channel: archived } = await client.createChannel({ name: 'native-archived', userId });
  await client.archiveChannel(archived.id, { userId, archived: true });
  const { channel: cards } = await client.createChannel({ name: 'native-cards', userId });
  await client.upsertChannelMember(cards.id, { agentId: agent.id });
  await client.updateChannelSettings(cards.id, { userId, replyMode: 'always_main' });
  let opened = false;
  const ws = client.connectWebSocket({
    userId,
    onStateChange: (state) => {
      opened = state === 'open';
    },
    onEvent: () => {},
  });
  try {
    for (let n = 0; !opened && n < 100; n++) await Bun.sleep(50);
    for (const status of ['timeout', 'failed', 'dispatch_failed'] as const) {
      const messageId = crypto.randomUUID();
      await ws.sendMessage({
        messageId,
        channelId: cards.id,
        senderId: userId,
        content: '@Local Fixture ' + status,
      });
      let found = false;
      for (let n = 0; n < 100; n++) {
        const { messages } = await client.getChannelMessages(cards.id);
        const card = messages.findLast((m) => m.card);
        if (
          card?.card?.status === 'dispatch_failed' &&
          messages.indexOf(card) > messages.findIndex((m) => m.id === messageId)
        ) {
          await client.updateBotMessage(card.id, { status, summary: status + ' fixture detail' });
          found = true;
          break;
        }
        await Bun.sleep(50);
      }
      if (!found) throw new Error('Missing disconnected gateway fixture for ' + status);
    }
  } finally {
    ws.close();
  }
  return { ARCHIVED_CHANNEL: archived.id, DISCUSSION: channel.id, ROOT_MESSAGE: root.id };
}
