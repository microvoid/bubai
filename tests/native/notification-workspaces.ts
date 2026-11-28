import { BubaiClient } from '../../packages/chat-client/src';
import { mobileCreateOrganization, mobileSetActiveOrganization, mobileSignInWithPassword } from '../../apps/mobile/src/services/auth';

export async function seedNotificationWorkspaces(server: string, email: string, password: string) {
  if (new URL(server).hostname !== '127.0.0.1') throw new Error('Expected the local native test server');
  const { token, user } = await mobileSignInWithPassword(server, email, password);
  const source = await mobileCreateOrganization(server, token, 'Home Community');
  const target = await mobileCreateOrganization(server, token, 'Design Community');
  await mobileSetActiveOrganization(server, token, target.id);
  const client = new BubaiClient({ baseUrl: server, token });
  const { channel } = await client.createChannel({ userId: user.id, name: 'design-updates' });
  const root = crypto.randomUUID();
  const reply = crypto.randomUUID();
  let connected = false;
  const socket = client.connectWebSocket({
    userId: user.id,
    onStateChange: state => { connected = state === 'open'; },
    onEvent: () => {},
  });
  try {
    for (let attempt = 0; !connected && attempt < 100; attempt++) await Bun.sleep(50);
    if (!connected) throw new Error('Notification fixture WebSocket did not connect');
    await socket.sendMessage({ channelId: channel.id, senderId: user.id, messageId: root, content: 'Design handoff for review' });
    await socket.sendMessage({ channelId: channel.id, senderId: user.id, threadId: root, messageId: reply, content: 'Cross-community reply landed here' });
  } finally {
    socket.close();
  }
  await mobileSetActiveOrganization(server, token, source.id);
  return { source: source.id, target: target.id, channel: channel.id, root, reply };
}
