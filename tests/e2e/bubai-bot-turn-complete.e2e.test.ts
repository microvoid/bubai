import { registerTestUser } from './account-mailbox';
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BubaiClient, type BotTurnRequestedEvent } from '../../packages/chat-client/src/index';

const serverEntry = path.resolve(import.meta.dir, '../../apps/server/src/main.ts');

async function until<T>(read: () => T | undefined | Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('a scoped Bot settles its turn in place and retries cannot overwrite the terminal card', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-turn-complete-'));
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([process.execPath, serverEntry], {
    cwd: dataDir,
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_EMAIL_API_TOKEN: '', EMAIL_FROM: '',
      DATABASE_URL: '',
      PORT: String(port),
      BETTER_AUTH_URL: baseUrl,
      BUBAI_AUTH_REQUIRED: 'true',
      BOTMUX_DISABLED: 'true',
      BUZZ_BOT_TOKEN: '',
      NODE_ENV: 'development',
    },
    stdout: Bun.file(path.join(dataDir, 'server.out')),
    stderr: Bun.file(path.join(dataDir, 'server.err')),
  });
  let gateway: ReturnType<BubaiClient['connectBotGateway']> | undefined;
  let chat: ReturnType<BubaiClient['connectWebSocket']> | undefined;

  try {
    await until(async () => {
      if (server.exitCode !== null) {
        throw new Error(fs.readFileSync(path.join(dataDir, 'server.err'), 'utf8'));
      }
      const healthy = await fetch(`${baseUrl}/healthz`).then((res) => res.ok).catch(() => false);
      return healthy || undefined;
    }, 'test server');

    const signup = await registerTestUser(baseUrl, 'turn-complete@example.com', 'Owner', 'Password123!', () => fs.readFileSync(path.join(dataDir, 'server.out'), 'utf8'));
    const identity = await signup.json() as { token?: string; user: { id: string } };
    const token = signup.headers.get('set-auth-token') ?? identity.token;
    if (!signup.ok || !token) throw new Error(`Sign-up failed (${signup.status})`);
    const owner = new BubaiClient({ baseUrl, token });
    const { channel } = await owner.createChannel({ name: 'turn-complete' });
    const main = await owner.provisionAgent({ name: 'Primary Bot', channelId: channel.id, issueKey: true });
    const other = await owner.provisionAgent({ name: 'Other Bot', channelId: channel.id, issueKey: true });
    if (!main.apiKey || !other.apiKey) throw new Error('Bot keys not issued');
    const bot = new BubaiClient({ baseUrl, token: main.apiKey });
    const otherBot = new BubaiClient({ baseUrl, token: other.apiKey });

    let registered = false;
    let requestedTurn: BotTurnRequestedEvent | undefined;
    gateway = bot.connectBotGateway({
      agents: [{ id: main.agent.id, name: main.agent.name }],
      onWelcome: () => { registered = true; },
      onTurnRequested: (event) => { requestedTurn = event; },
    });
    await until(() => registered || undefined, 'bot gateway registration');

    let chatOpen = false;
    chat = owner.connectWebSocket({
      userId: identity.user.id,
      onStateChange: (state) => { chatOpen = state === 'open'; },
      onEvent: () => {},
    });
    await until(() => chatOpen || undefined, 'chat websocket');
    chat.send({
      type: 'message.send',
      payload: { channelId: channel.id, senderId: identity.user.id, content: '@Primary Bot test' },
    });
    const turn = await until(() => requestedTurn, 'turn.requested');
    const messageId = turn.replyTarget.messageId;
    const completion = { content: 'Turn timed out', status: 'timeout' as const };

    await expect(otherBot.completeBotTurn(messageId, completion)).rejects.toMatchObject({ status: 403 });
    const responses = await Promise.all([
      bot.completeBotTurn(messageId, completion),
      bot.completeBotTurn(messageId, completion),
    ]);
    expect(responses.map((response) => response.settled).sort()).toEqual([false, true]);
    const replay = await bot.completeBotTurn(messageId, { content: 'Late reply', status: 'completed' });
    expect(replay.settled).toBe(false);
    expect(replay.message.card?.status).toBe('timeout');
    expect(replay.message.content).toBe(completion.content);
    const { messages } = await owner.getChannelMessages(channel.id);
    const replies = messages.filter((message) => message.senderId === main.agent.id);
    expect(replies.map((reply) => reply.id)).toEqual([messageId]);

    requestedTurn = undefined;
    chat.send({
      type: 'message.send',
      payload: { channelId: channel.id, senderId: identity.user.id, content: '@Primary Bot test after timeout' },
    });
    const revokedTurn = await until(() => requestedTurn, 'second turn.requested');
    await owner.removeChannelMember(channel.id, { agentId: main.agent.id });
    const revokedMessageId = revokedTurn.replyTarget.messageId;
    await expect(bot.completeBotTurn(revokedMessageId, completion)).rejects.toMatchObject({ status: 403 });
    const { messages: afterRemoval } = await owner.getChannelMessages(channel.id);
    expect(afterRemoval.find((message) => message.id === revokedMessageId)?.card?.status).toBe('running');
  } finally {
    chat?.close();
    gateway?.close();
    server.kill('SIGTERM');
    await server.exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 30_000);
