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

function findFreePort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop();
  return port;
}

function startServer(dataDir: string, port: number, turnTimeoutMs?: number) {
  return Bun.spawn([process.execPath, serverEntry], {
    cwd: dataDir,
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_EMAIL_API_TOKEN: '', EMAIL_FROM: '',
      DATABASE_URL: '',
      PORT: String(port),
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      BUBAI_AUTH_REQUIRED: 'true',
      BUBAI_BOT_TURN_TIMEOUT_MS: turnTimeoutMs === undefined ? '' : String(turnTimeoutMs),
      BOTMUX_DISABLED: 'true',
      BUZZ_BOT_TOKEN: '',
      NODE_ENV: 'development',
    },
    stdout: Bun.file(path.join(dataDir, 'server.out')),
    stderr: Bun.file(path.join(dataDir, 'server.err')),
  });
}

async function waitForServer(server: ReturnType<typeof startServer>, baseUrl: string, dataDir: string) {
  await until(async () => {
    if (server.exitCode !== null) {
      throw new Error(fs.readFileSync(path.join(dataDir, 'server.err'), 'utf8'));
    }
    const healthy = await fetch(`${baseUrl}/healthz`).then((res) => res.ok).catch(() => false);
    return healthy || undefined;
  }, 'test server');
}

async function signUpOwner(baseUrl: string, dataDir: string) {
  const signup = await registerTestUser(baseUrl, 'turn-complete@example.com', 'Owner', 'Password123!', () => fs.readFileSync(path.join(dataDir, 'server.out'), 'utf8'));
  const identity = await signup.json() as { token?: string; user: { id: string } };
  const token = signup.headers.get('set-auth-token') ?? identity.token;
  if (!signup.ok || !token) throw new Error(`Sign-up failed (${signup.status})`);
  return { owner: new BubaiClient({ baseUrl, token }), userId: identity.user.id };
}

test('a scoped Bot settles its turn in place and retries cannot overwrite the terminal card', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-turn-complete-'));
  const port = findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(dataDir, port);
  let gateway: ReturnType<BubaiClient['connectBotGateway']> | undefined;
  let chat: ReturnType<BubaiClient['connectWebSocket']> | undefined;

  try {
    await waitForServer(server, baseUrl, dataDir);
    const { owner, userId } = await signUpOwner(baseUrl, dataDir);
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
      userId,
      onStateChange: (state) => { chatOpen = state === 'open'; },
      onEvent: () => {},
    });
    await until(() => chatOpen || undefined, 'chat websocket');
    chat.send({
      type: 'message.send',
      payload: { channelId: channel.id, senderId: userId, content: '@Primary Bot test' },
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
      payload: { channelId: channel.id, senderId: userId, content: '@Primary Bot test after timeout' },
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

test('the server times out an orphaned gateway turn after restart and preserves completed turns', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-turn-restart-'));
  const port = findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server = startServer(dataDir, port);
  let gateway: ReturnType<BubaiClient['connectBotGateway']> | undefined;
  let chat: ReturnType<BubaiClient['connectWebSocket']> | undefined;

  try {
    await waitForServer(server, baseUrl, dataDir);
    const { owner, userId } = await signUpOwner(baseUrl, dataDir);
    const { channel } = await owner.createChannel({ name: 'turn-restart' });
    const { agent, apiKey } = await owner.provisionAgent({ name: 'Gateway Bot', channelId: channel.id, issueKey: true });
    if (!apiKey) throw new Error('Bot key not issued');
    const bot = new BubaiClient({ baseUrl, token: apiKey });

    let registered = false;
    const requests: BotTurnRequestedEvent[] = [];
    gateway = bot.connectBotGateway({
      agents: [{ id: agent.id, name: agent.name }],
      onWelcome: () => { registered = true; },
      onTurnRequested: (event) => { requests.push(event); },
    });
    await until(() => registered || undefined, 'bot gateway registration');

    let chatOpen = false;
    chat = owner.connectWebSocket({
      userId,
      onStateChange: (state) => { chatOpen = state === 'open'; },
      onEvent: () => {},
    });
    await until(() => chatOpen || undefined, 'chat websocket');

    chat.send({
      type: 'message.send',
      payload: { channelId: channel.id, senderId: userId, content: '@Gateway Bot finish' },
    });
    const completedTurn = await until(() => requests[0], 'first gateway turn');
    const completedId = completedTurn.replyTarget.messageId;
    const completed = await bot.completeBotTurn(completedId, { status: 'completed', content: 'Finished reply' });
    expect(completed.settled).toBe(true);

    chat.send({
      type: 'message.send',
      payload: { channelId: channel.id, senderId: userId, content: '@Gateway Bot never reply' },
    });
    const orphanedTurn = await until(() => requests[1], 'orphaned gateway turn');
    const orphanedId = orphanedTurn.replyTarget.messageId;
    await until(async () => {
      const { messages } = await owner.getChannelMessages(channel.id);
      return messages.find((message) => message.id === orphanedId && message.card?.phase === 'thinking');
    }, 'running placeholder persisted before restart');

    gateway.close();
    chat.close();
    server.kill('SIGTERM');
    await server.exited;
    server = startServer(dataDir, port, 1000);
    await waitForServer(server, baseUrl, dataDir);

    const timedOut = await until(async () => {
      const { messages } = await owner.getChannelMessages(channel.id);
      return messages.find((message) => message.id === orphanedId && message.card?.status === 'timeout');
    }, 'orphaned turn timeout after restart');
    expect(timedOut.card?.finishedAt).toBeGreaterThanOrEqual(timedOut.card?.startedAt ?? 0);
    expect(timedOut.content).not.toBe('');

    const { messages } = await owner.getChannelMessages(channel.id);
    expect(messages.find((message) => message.id === completedId)).toMatchObject({
      content: 'Finished reply', card: { status: 'completed' },
    });
  } finally {
    chat?.close();
    gateway?.close();
    server.kill('SIGTERM');
    await server.exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 30_000);
