import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BubaiClient } from '../../packages/chat-client/src/index.ts';

const SERVER_ENTRY = path.resolve(import.meta.dir, '../../apps/server/src/main.ts');
const CLI_ENTRY = path.resolve(import.meta.dir, '../../apps/cli/src/index.ts');

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // starting
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForCondition<T>(
  fn: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function runCli(args: string[], env: Record<string, string>) {
  const outFile = path.join(os.tmpdir(), `bubai-sec-out-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const errFile = path.join(os.tmpdir(), `bubai-sec-err-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  try {
    const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdout: Bun.file(outFile),
      stderr: Bun.file(errFile),
    });
    const code = await proc.exited;
    const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
    return { code, stdout, stderr };
  } finally {
    if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true });
    if (fs.existsSync(errFile)) fs.rmSync(errFile, { force: true });
  }
}

async function signUpAndGetToken(serverUrl: string, email: string, name: string): Promise<{
  token: string;
  userId: string;
}> {
  const res = await fetch(`${serverUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', name }),
  });
  const body = (await res.json()) as {
    token?: string;
    user?: { id: string };
  };
  const headerToken = res.headers.get('set-auth-token') || body.token || '';
  if (!res.ok || !headerToken || !body.user?.id) {
    throw new Error(`Sign up failed: status=${res.status} body=${JSON.stringify(body)}`);
  }
  return { token: headerToken, userId: body.user.id };
}

describe('E2E: Security boundaries, strict auth bridge & idempotency regressions', () => {
  const serverPort = 4720 + Math.floor(Math.random() * 200);
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  let tmpDataDir: string;
  let tmpConfigDir: string;
  let serverProc: ChildProcess | null = null;
  let fakeBotmux: ReturnType<typeof Bun.serve> | null = null;
  let fakeBotmuxUrl = '';
  let bridgeProc: ReturnType<typeof Bun.spawn> | null = null;

  const triggerRecords: Array<{ triggerId: string; sessionId: string; botId: string; prompt: string }> = [];

  beforeAll(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-sec-e2e-db-'));
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-sec-e2e-cfg-'));

    fakeBotmux = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/bots') {
          return Response.json({
            bots: [
              {
                larkAppId: 'sec_botmux_agent_1',
                botName: 'Secure Botmux Agent',
                cliId: 'claude',
                online: true,
                workingDir: '/tmp/sec-repo',
              },
            ],
          });
        }
        if (url.pathname === '/api/sessions') {
          return Response.json({ sessions: [] });
        }
        if (url.pathname === '/api/trigger' && req.method === 'POST') {
          const body = (await req.json()) as {
            target?: { larkAppId?: string; sessionId?: string };
            envelope?: { payload?: { message?: string } };
          };
          const botId = body.target?.larkAppId || 'sec_botmux_agent_1';
          const sessionId = body.target?.sessionId || `sess_sec_${triggerRecords.length + 1}`;
          const triggerId = `trg_sec_${triggerRecords.length + 1}`;
          const prompt = body.envelope?.payload?.message || '';
          triggerRecords.push({ triggerId, sessionId, botId, prompt });
          return Response.json({
            ok: true,
            accepted: true,
            triggerId,
            target: { sessionId, larkAppId: botId },
          });
        }
        const pollMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/trigger-result$/);
        if (pollMatch && req.method === 'GET') {
          const [, sessionId] = pollMatch;
          const triggerId = url.searchParams.get('triggerId') || '';
          const rec = triggerRecords.find(
            (r) => r.sessionId === sessionId && (!triggerId || r.triggerId === triggerId),
          );
          if (!rec) return Response.json({ ok: false, error: 'unknown_session' }, { status: 404 });
          return Response.json({
            ok: true,
            state: 'completed',
            triggerId: rec.triggerId,
            output: { content: `Secure reply: ${rec.prompt}` },
          });
        }
        return Response.json({ ok: true });
      },
    });
    fakeBotmuxUrl = `http://127.0.0.1:${fakeBotmux.port}`;

    // Real BubAI server with STRICT AUTH enabled and BOTMUX_DISABLED=true
    serverProc = spawn('bun', ['run', SERVER_ENTRY], {
      cwd: tmpDataDir,
      env: {
        ...process.env,
        DATABASE_URL: '',
        PORT: String(serverPort),
        BOTMUX_DISABLED: 'true',
        BUBAI_AUTH_REQUIRED: 'true',
        BUZZ_BOT_TOKEN: '',
        NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitForHttp(`${serverUrl}/health`, 20_000);
  }, 25_000);

  afterAll(async () => {
    if (bridgeProc) {
      bridgeProc.kill('SIGTERM');
      bridgeProc = null;
    }
    if (serverProc) {
      serverProc.kill('SIGTERM');
      serverProc = null;
    }
    if (fakeBotmux) {
      fakeBotmux.stop(true);
      fakeBotmux = null;
    }
    if (tmpDataDir) fs.rmSync(tmpDataDir, { recursive: true, force: true });
    if (tmpConfigDir) fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  test('P0-1: regular user cannot issue bot-server_ key via /api/agents/provision', async () => {
    const user = await signUpAndGetToken(serverUrl, 'regular@example.com', 'Regular User');
    const res = await fetch(`${serverUrl}/api/agents/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user.token}`,
      },
      body: JSON.stringify({
        name: 'Sneaky Server Bot',
        issueKey: true,
        keyScope: 'bot-server',
      }),
    });
    expect(res.status).toBe(403);
  });

  test('P0-2: Bot Key cannot read/post in unjoined channel, cannot patch human messages, and @mention does not leak unjoined channel', async () => {
    const alice = await signUpAndGetToken(serverUrl, 'alice-sec@example.com', 'Alice Sec');
    const aliceSdk = new BubaiClient({ baseUrl: serverUrl, token: alice.token });

    const { channel: chanA } = await aliceSdk.createChannel({ name: 'sec-chan-a' });
    const { channel: chanB } = await aliceSdk.createChannel({ name: 'sec-chan-b' });

    // Provision Bot A into chanA ONLY, issuing a single-bot `bot_` key
    const prov = await aliceSdk.provisionAgent({
      name: 'Scoped Bot A',
      externalId: 'scoped-bot-a',
      channelId: chanA.id,
      autoReply: false,
      issueKey: true,
      keyScope: 'bot',
    });
    expect(prov.ok).toBe(true);
    expect(prov.apiKey?.startsWith('bot_')).toBe(true);
    const botKey = prov.apiKey!;
    const botId = prov.agent.id;

    // 1. Bot A trying to read unjoined chanB history -> 403
    const readB = await fetch(`${serverUrl}/api/bot/channels/${chanB.id}/messages`, {
      headers: { Authorization: `Bearer ${botKey}` },
    });
    expect(readB.status).toBe(403);

    // 2. Bot A trying to post into unjoined chanB -> 403
    const postB = await fetch(`${serverUrl}/api/bot/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${botKey}`,
      },
      body: JSON.stringify({
        botId,
        channelId: chanB.id,
        content: 'Unauthorized post into chanB',
      }),
    });
    expect(postB.status).toBe(403);

    // 3. Human posts a message in chanA, Bot A tries to PATCH that human message -> 403
    let humanMsgId = '';
    let wsOpen = false;
    const ws = aliceSdk.connectWebSocket({
      userId: alice.userId,
      onStateChange: (s) => {
        if (s === 'open') wsOpen = true;
      },
      onEvent: (evt) => {
        if (evt.type === 'message.created' && evt.payload.channelId === chanA.id && evt.payload.senderRole === 'human') {
          humanMsgId = evt.payload.id;
        }
      },
    });
    try {
      await waitForCondition(async () => wsOpen, 'Alice WS open');
      ws.send({
        type: 'message.send',
        payload: { channelId: chanA.id, senderId: alice.userId, content: 'Human message in A' },
      });
      await waitForCondition(async () => humanMsgId, 'Human message saved');

      const patchHuman = await fetch(`${serverUrl}/api/bot/messages/${humanMsgId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${botKey}`,
        },
        body: JSON.stringify({ content: 'Hacked by bot!' }),
      });
      expect(patchHuman.status).toBe(403);

      // 4. Human mentions @Scoped Bot A in unjoined chanB -> MUST NOT create a bot placeholder/dispatch
      ws.send({
        type: 'message.send',
        payload: { channelId: chanB.id, senderId: alice.userId, content: '@Scoped Bot A secret in B' },
      });
      await new Promise((r) => setTimeout(r, 400));
      const { messages: chanBMessages } = await aliceSdk.getChannelMessages(chanB.id);
      expect(chanBMessages.some((m) => m.senderId === botId)).toBe(false);
    } finally {
      ws.close();
    }
  });

  test('P1-3: strict auth BUBAI_AUTH_REQUIRED=true full bridge flow with pure @mention (autoReply=false)', async () => {
    const bob = await signUpAndGetToken(serverUrl, 'bob-bridge@example.com', 'Bob Bridge');
    const bobSdk = new BubaiClient({ baseUrl: serverUrl, token: bob.token });
    const { channel } = await bobSdk.createChannel({ name: 'strict-auth-room' });

    // Start `bubai bridge botmux` using ONLY Bob's Human Session token!
    // Bridge must provision + issue bot_ key under the hood, then connect /ws/bot with the bot_ key.
    const bridgeOut = path.join(tmpConfigDir, 'sec-bridge-out.log');
    const bridgeErr = path.join(tmpConfigDir, 'sec-bridge-err.log');
    bridgeProc = Bun.spawn(
      [
        process.execPath,
        CLI_ENTRY,
        'bridge',
        'botmux',
        '--server',
        serverUrl,
        '--token',
        bob.token,
        '--botmux',
        fakeBotmuxUrl,
        '--botmux-token',
        'fake-sec-botmux-token',
        '--channel',
        channel.id,
        '--poll-ms',
        '100',
      ],
      {
        env: { ...process.env, BUBAI_CONFIG_DIR: tmpConfigDir },
        stdout: Bun.file(bridgeOut),
        stderr: Bun.file(bridgeErr),
      },
    );

    const onlineAgent = await waitForCondition(async () => {
      const boot = await bobSdk.bootstrap(bob.userId);
      return (
        boot.participants.find(
          (p) => p.role === 'agent' && p.id === 'sec_botmux_agent_1' && p.status === 'online',
        ) ?? null
      );
    }, 'Secure Botmux Agent online under BUBAI_AUTH_REQUIRED=true');
    expect(onlineAgent.name).toBe('Secure Botmux Agent');

    let wsOpen = false;
    const ws = bobSdk.connectWebSocket({
      userId: bob.userId,
      onStateChange: (s) => {
        if (s === 'open') wsOpen = true;
      },
      onEvent: () => {},
    });

    try {
      await waitForCondition(async () => wsOpen, 'Bob WS open');

      // Pure @mention test (autoReply was NOT enabled!)
      ws.send({
        type: 'message.send',
        payload: {
          channelId: channel.id,
          senderId: bob.userId,
          content: '@Secure Botmux Agent hello under strict auth',
        },
      });

      const reply = await waitForCondition(async () => {
        const { messages } = await bobSdk.getChannelMessages(channel.id);
        return messages.find(
          (m) =>
            m.senderRole === 'agent' &&
            m.senderId === 'sec_botmux_agent_1' &&
            m.card?.status === 'completed' &&
            m.content.includes('Secure reply: @Secure Botmux Agent hello under strict auth'),
        );
      }, 'Completed Botmux reply under strict auth');
      expect(reply.card?.status).toBe('completed');
    } finally {
      ws.close();
      bridgeProc.kill('SIGTERM');
      bridgeProc = null;
    }
  });

  test('P1-5: missing channel returns 404, SSRF webhookUrl rejected, concurrent provision idempotent, and CLI config redacts/resets token', async () => {
    const carol = await signUpAndGetToken(serverUrl, 'carol-sec@example.com', 'Carol Sec');

    // 1. Non-existent channelName must return 404
    const missingCh = await fetch(`${serverUrl}/api/agents/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${carol.token}`,
      },
      body: JSON.stringify({
        name: 'Ghost Channel Bot',
        channelName: 'does-not-exist-channel-xyz',
      }),
    });
    expect(missingCh.status).toBe(404);

    // 2. Cloud metadata / private IP webhookUrl must be rejected (400)
    const ssrfRes = await fetch(`${serverUrl}/api/agents/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${carol.token}`,
      },
      body: JSON.stringify({
        name: 'SSRF Bot',
        webhookUrl: 'http://169.254.169.254/latest/meta-data/',
      }),
    });
    expect(ssrfRes.status).toBe(400);

    // 3. Concurrent provision for the same externalId must be idempotent
    const [p1, p2] = await Promise.all([
      fetch(`${serverUrl}/api/agents/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${carol.token}` },
        body: JSON.stringify({ name: 'Race Bot', externalId: 'race-ext-1' }),
      }).then((r) => r.json() as Promise<{ ok: boolean; agent: { id: string } }>),
      fetch(`${serverUrl}/api/agents/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${carol.token}` },
        body: JSON.stringify({ name: 'Race Bot', externalId: 'race-ext-1' }),
      }).then((r) => r.json() as Promise<{ ok: boolean; agent: { id: string } }>),
    ]);
    expect(p1.agent.id).toBe(p2.agent.id);

    // 4. CLI `config set --server` must NOT leak saved token to stdout and must clear token when server changes
    const cliCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-cli-cfg-redaction-'));
    try {
      const set1 = await runCli(
        ['config', 'set', '--server', 'http://old.example.com', '--token', 'super-secret-token-999'],
        { BUBAI_CONFIG_DIR: cliCfgDir },
      );
      expect(set1.code).toBe(0);
      expect(set1.stdout).not.toContain('super-secret-token-999');

      const set2 = await runCli(
        ['config', 'set', '--server', 'http://new.example.com'],
        { BUBAI_CONFIG_DIR: cliCfgDir },
      );
      expect(set2.code).toBe(0);
      expect(set2.stdout).not.toContain('super-secret-token-999');
      const savedOnDisk = JSON.parse(fs.readFileSync(path.join(cliCfgDir, 'config.json'), 'utf8')) as {
        serverUrl?: string;
        token?: string;
      };
      expect(savedOnDisk.serverUrl).toBe('http://new.example.com');
      expect(savedOnDisk.token).toBeUndefined();
    } finally {
      fs.rmSync(cliCfgDir, { recursive: true, force: true });
    }
  });
});
