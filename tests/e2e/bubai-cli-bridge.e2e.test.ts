import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BubaiClient, type ChatMessage } from '../../packages/chat-client/src/index.ts';

const SERVER_ENTRY = path.resolve(import.meta.dir, '../../apps/server/src/main.ts');
const CLI_ENTRY = path.resolve(import.meta.dir, '../../apps/cli/src/index.ts');

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server starting
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

async function runCli(args: string[], env: Record<string, string>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const outFile = path.join(os.tmpdir(), `bubai-cli-out-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const errFile = path.join(os.tmpdir(), `bubai-cli-err-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
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

describe('E2E: BubaiCLI + Unified SDK + AgentUser + Botmux Bridge', () => {
  const serverPort = 4310 + Math.floor(Math.random() * 400);
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  let tmpDataDir: string;
  let tmpConfigDir: string;
  let serverProc: ChildProcess | null = null;
  let fakeBotmux: ReturnType<typeof Bun.serve> | null = null;
  let fakeBotmuxUrl = '';
  let bridgeProc: ReturnType<typeof Bun.spawn> | null = null;

  const triggerRecords: Array<{
    triggerId: string;
    sessionId: string;
    botId: string;
    prompt: string;
  }> = [];

  beforeAll(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-cli-e2e-db-'));
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-cli-e2e-cfg-'));

    // 1. Start lightweight Fake Botmux Daemon (simulates local Botmux)
    fakeBotmux = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/bots') {
          return Response.json({
            bots: [
              {
                larkAppId: 'e2e_botmux_agent_1',
                botName: 'E2E Botmux Agent',
                cliId: 'claude',
                online: true,
                workingDir: '/tmp/e2e-botmux-repo',
              },
            ],
          });
        }
        if (url.pathname === '/api/sessions' && req.method === 'GET') {
          return Response.json({ sessions: [] });
        }
        if (url.pathname === '/api/trigger' && req.method === 'POST') {
          const body = (await req.json()) as {
            target?: { larkAppId?: string; sessionId?: string };
            envelope?: { payload?: { message?: string } };
          };
          const botId = body.target?.larkAppId || 'e2e_botmux_agent_1';
          const sessionId = body.target?.sessionId || `sess_e2e_${triggerRecords.length + 1}`;
          const triggerId = `trg_e2e_${triggerRecords.length + 1}`;
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
          if (!rec) {
            return Response.json({ ok: false, error: 'unknown_session' }, { status: 404 });
          }
          return Response.json({
            ok: true,
            state: 'completed',
            triggerId: rec.triggerId,
            output: {
              content: `Botmux reply to: ${rec.prompt}`,
            },
          });
        }
        return Response.json({ ok: true });
      },
    });
    fakeBotmuxUrl = `http://127.0.0.1:${fakeBotmux.port}`;

    // 2. Start real BubAI Server with BOTMUX_DISABLED=true (zero direct Botmux coupling!)
    serverProc = spawn('bun', ['run', SERVER_ENTRY], {
      cwd: tmpDataDir,
      env: {
        ...process.env,
        DATABASE_URL: '',
        PORT: String(serverPort),
        BOTMUX_DISABLED: 'true',
        BUBAI_AUTH_REQUIRED: 'false',
        BUZZ_BOT_TOKEN: 'e2e-cli-secret-token',
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

  test('1. CLI provisions AgentUser idempotently and joins a Channel', async () => {
    const sdk = new BubaiClient({ baseUrl: serverUrl });
    const { channel } = await sdk.createChannel({
      name: 'cli-e2e-room',
      topic: 'BubaiCLI E2E verification channel',
      userId: 'u-owner',
    });

    const cliEnv = {
      BUBAI_CONFIG_DIR: tmpConfigDir,
      BUBAI_URL: serverUrl,
      BUBAI_TOKEN: 'e2e-cli-secret-token',
    };

    // First create via CLI
    const first = await runCli(
      [
        'agent',
        'create',
        '--name',
        'CLI Standalone Bot',
        '--external-id',
        'ext-standalone-1',
        '--channel',
        channel.id,
      ],
      cliEnv,
    );
    if (first.code !== 0 || !first.stdout.trim()) {
      throw new Error(`CLI create failed: code=${first.code} stdout=${JSON.stringify(first.stdout)} stderr=${JSON.stringify(first.stderr)}`);
    }
    expect(first.code).toBe(0);
    const firstJson = JSON.parse(first.stdout) as {
      ok: boolean;
      created: boolean;
      agent: { id: string; name: string; status: string };
      channelId: string;
    };
    expect(firstJson.ok).toBe(true);
    expect(firstJson.created).toBe(true);
    expect(firstJson.channelId).toBe(channel.id);

    // Second create with same externalId must be idempotent (created: false, same id)
    const second = await runCli(
      [
        'agent',
        'create',
        '--name',
        'CLI Standalone Bot',
        '--external-id',
        'ext-standalone-1',
        '--channel',
        channel.id,
      ],
      cliEnv,
    );
    expect(second.code).toBe(0);
    const secondJson = JSON.parse(second.stdout) as {
      ok: boolean;
      created: boolean;
      agent: { id: string };
    };
    expect(secondJson.created).toBe(false);
    expect(secondJson.agent.id).toBe(firstJson.agent.id);

    // Verify CLI can send a message as this AgentUser into the joined channel
    const sent = await runCli(
      [
        'chat',
        'send',
        '--channel',
        channel.id,
        '--bot',
        firstJson.agent.id,
        '--text',
        'Hello from BubaiCLI SDK!',
      ],
      cliEnv,
    );
    expect(sent.code).toBe(0);
    const { messages } = await sdk.getChannelMessages(channel.id);
    expect(messages.some((m) => m.content === 'Hello from BubaiCLI SDK!' && m.senderId === firstJson.agent.id)).toBe(true);
  });

  test('2 & 3. bubai bridge botmux connects via /ws/bot, handles @mention and autoReply end-to-end', async () => {
    const sdk = new BubaiClient({ baseUrl: serverUrl });
    const { channel } = await sdk.createChannel({
      name: 'cli-bridge-room',
      topic: 'Live Botmux bridge test',
      userId: 'u-owner',
    });

    // Launch real `bubai bridge botmux` subprocess joining `cli-bridge-room` with autoReply
    const bridgeOutFile = path.join(tmpConfigDir, 'bridge-out.log');
    const bridgeErrFile = path.join(tmpConfigDir, 'bridge-err.log');
    bridgeProc = Bun.spawn(
      [
        process.execPath,
        CLI_ENTRY,
        'bridge',
        'botmux',
        '--server',
        serverUrl,
        '--token',
        'e2e-cli-secret-token',
        '--botmux',
        fakeBotmuxUrl,
        '--botmux-token',
        'fake-e2e-botmux-token',
        '--channel',
        channel.id,
        '--auto-reply',
        '--poll-ms',
        '100',
      ],
      {
        env: { ...process.env, BUBAI_CONFIG_DIR: tmpConfigDir },
        stdout: Bun.file(bridgeOutFile),
        stderr: Bun.file(bridgeErrFile),
      },
    );

    // Wait for AgentUser to appear online in BubAI
    const onlineAgent = await waitForCondition(async () => {
      const boot = await sdk.bootstrap('u-owner');
      const found = boot.participants.find(
        (p) => p.role === 'agent' && p.id === 'e2e_botmux_agent_1' && p.status === 'online',
      );
      return found ?? null;
    }, `Botmux AgentUser online via BubaiCLI bridge`);
    expect(onlineAgent.name).toBe('E2E Botmux Agent');

    // Connect as Human via the SAME unified BubaiClient SDK (`/ws`)
    const receivedUpdates: ChatMessage[] = [];
    let humanWsOpen = false;
    const humanWs = sdk.connectWebSocket({
      userId: 'u-owner',
      onStateChange: (state) => {
        if (state === 'open') humanWsOpen = true;
      },
      onEvent: (evt) => {
        if (evt.type === 'message.created' || evt.type === 'message.updated') {
          receivedUpdates.push(evt.payload);
        }
      },
    });

    try {
      await waitForCondition(async () => humanWsOpen, 'Human WebSocket open');

      // Case 2: Human sends @mention message
      humanWs.send({
        type: 'message.send',
        payload: {
          channelId: channel.id,
          senderId: 'u-owner',
          content: '@E2E Botmux Agent ping via mention',
        },
      });

      const mentionReply = await waitForCondition(async () => {
        const { messages } = await sdk.getChannelMessages(channel.id);
        return messages.find(
          (m) =>
            m.senderRole === 'agent' &&
            m.senderId === 'e2e_botmux_agent_1' &&
            m.card?.status === 'completed' &&
            m.content.includes('Botmux reply to: @E2E Botmux Agent ping via mention'),
        );
      }, 'Completed Botmux reply to @mention');
      expect(mentionReply.adapterMeta?.adapter).toBe('bubai-cli-botmux');

      // Case 3: Human sends plain message (no @mention) -> autoReply triggers without loop
      const triggerCountBefore = triggerRecords.length;
      humanWs.send({
        type: 'message.send',
        payload: {
          channelId: channel.id,
          senderId: 'u-owner',
          content: 'plain auto-reply message',
        },
      });

      const autoReplyMsg = await waitForCondition(async () => {
        const { messages } = await sdk.getChannelMessages(channel.id);
        return messages.find(
          (m) =>
            m.senderRole === 'agent' &&
            m.senderId === 'e2e_botmux_agent_1' &&
            m.card?.status === 'completed' &&
            m.content.includes('Botmux reply to: plain auto-reply message'),
        );
      }, 'Completed Botmux autoReply');
      expect(autoReplyMsg.content).toBe('Botmux reply to: plain auto-reply message');

      // Wait briefly and verify no bot-to-bot self-loop occurred
      await new Promise((r) => setTimeout(r, 300));
      expect(triggerRecords.length).toBe(triggerCountBefore + 1);
      expect(receivedUpdates.length).toBeGreaterThan(0);

      // Case 4: Kill BubaiCLI bridge -> AgentUser stays in BubAI as offline (does NOT vanish)
      bridgeProc.kill('SIGTERM');
      bridgeProc = null;

      const offlineAgent = await waitForCondition(async () => {
        const boot = await sdk.bootstrap('u-owner');
        return (
          boot.participants.find(
            (p) => p.role === 'agent' && p.id === 'e2e_botmux_agent_1' && p.status === 'offline',
          ) ?? null
        );
      }, 'AgentUser persists as offline after CLI disconnect');
      expect(offlineAgent.name).toBe('E2E Botmux Agent');

      // Sending @mention while offline produces a clean dispatch_failed card instead of hanging
      humanWs.send({
        type: 'message.send',
        payload: {
          channelId: channel.id,
          senderId: 'u-owner',
          content: '@E2E Botmux Agent are you there?',
        },
      });

      const failedCard = await waitForCondition(async () => {
        const { messages } = await sdk.getChannelMessages(channel.id);
        return messages.find(
          (m) =>
            m.senderRole === 'agent' &&
            m.senderId === 'e2e_botmux_agent_1' &&
            m.card?.status === 'dispatch_failed',
        );
      }, 'Clean dispatch_failed card when offline');
      expect(failedCard.content).toContain('离线');
    } finally {
      humanWs.close();
    }
  });
});
