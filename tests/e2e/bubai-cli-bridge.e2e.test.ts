import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TriggerRequest, validateTriggerRequest } from '../../packages/botmux-client/src/index.ts';
import { BubaiClient, type ChatMessage } from '../../packages/chat-client/src/index.ts';

const SERVER_ENTRY = path.resolve(import.meta.dir, '../../apps/server/src/main.ts');
const CLI_ENTRY = path.resolve(import.meta.dir, '../../apps/cli/src/index.ts');
const BOT_ID = 'e2e_botmux_agent_1';
const ANTIGRAVITY_BOT_ID = 'e2e_antigravity_agent';

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
    prompt: string;
    request: TriggerRequest;
    key?: string;
  }> = [];
  const triggerRequests: Array<{ prompt: string; request: TriggerRequest }> = [];
  const polledTriggerIds = new Set<string>();
  const runningPrompts = new Set<string>();
  const heldTriggerAcks = new Map<string, Promise<void>>();
  let legacyBotmux = false;

  function launchBridge(channelId: string, configDir = tmpConfigDir, botId = BOT_ID) {
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
        '--bots',
        botId,
        '--channel',
        channelId,
        '--auto-reply',
        '--poll-ms',
        '100',
      ],
      {
        env: { ...process.env, HOME: configDir, BUBAI_CONFIG_DIR: configDir },
        stdout: Bun.file(path.join(configDir, 'bridge-out.log')),
        stderr: Bun.file(path.join(configDir, 'bridge-err.log')),
      },
    );
  }

  async function stopBridge(signal: NodeJS.Signals = 'SIGTERM') {
    if (!bridgeProc) return;
    const proc = bridgeProc;
    bridgeProc = null;
    proc.kill(signal);
    await proc.exited;
  }

  function waitForBridge(sdk: BubaiClient, status: 'online' | 'offline', botId = BOT_ID) {
    return waitForCondition(async () => {
      const boot = await sdk.bootstrap('u-owner');
      return boot.participants.find((p) => p.role === 'agent' && p.id === botId && p.status === status);
    }, `Botmux AgentUser ${status}`);
  }

  function waitForReply(
    sdk: BubaiClient,
    channelId: string,
    status: 'running' | 'completed' | 'failed',
    messageId?: string,
  ) {
    return waitForCondition(async () => {
      const { messages } = await sdk.getChannelMessages(channelId);
      return messages.find(
        (m) => m.senderRole === 'agent' && m.card?.status === status &&
          (messageId === undefined || m.id === messageId),
      );
    }, `Botmux reply ${status}`);
  }

  async function withRecoveryBridge(
    name: string,
    run: (fixture: {
      sdk: BubaiClient;
      channelId: string;
      homeDir: string;
      send: (content: string) => void;
      relaunch: () => void;
    }) => Promise<void>,
    botId = BOT_ID,
  ) {
    const sdk = new BubaiClient({ baseUrl: serverUrl });
    const { channel } = await sdk.createChannel({ name, userId: 'u-owner' });
    const configDir = fs.mkdtempSync(path.join(tmpConfigDir, 'bridge-recovery-'));
    const relaunch = () => launchBridge(channel.id, configDir, botId);
    let humanWsOpen = false;
    const humanWs = sdk.connectWebSocket({
      userId: 'u-owner',
      onStateChange: (state) => { humanWsOpen = state === 'open'; },
    });
    const send = (content: string) => {
      expect(humanWs.send({
        type: 'message.send',
        payload: { channelId: channel.id, senderId: 'u-owner', content },
      })).toBe(true);
    };

    try {
      relaunch();
      await waitForBridge(sdk, 'online', botId);
      await waitForCondition(async () => humanWsOpen, 'Human WebSocket open');
      await run({ sdk, channelId: channel.id, homeDir: configDir, send, relaunch });
    } finally {
      humanWs.close();
      await stopBridge();
      await waitForBridge(sdk, 'offline', botId);
    }
  }

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
                larkAppId: BOT_ID,
                botName: 'E2E Botmux Agent',
                cliId: 'claude',
                online: true,
                workingDir: '/tmp/e2e-botmux-repo',
              },
              {
                larkAppId: ANTIGRAVITY_BOT_ID,
                botName: 'E2E Antigravity Agent',
                cliId: 'antigravity',
                online: true,
                workingDir: '/tmp/e2e-botmux-repo',
              },
            ],
          });
        }
        if (url.pathname === '/api/sessions' && req.method === 'GET') {
          const sessions = triggerRecords
            .filter((record) => record.request.target.botId === ANTIGRAVITY_BOT_ID)
            .map((record) => ({
              sessionId: record.sessionId,
              larkAppId: ANTIGRAVITY_BOT_ID,
              cliId: 'antigravity',
              status: 'idle',
              backendType: 'tmux',
              queued: false,
              tuiPromptActive: false,
            }));
          return Response.json({ sessions });
        }
        if (url.pathname === '/api/trigger' && req.method === 'POST') {
          const request = (await req.json()) as TriggerRequest;
          const { idempotencyKey, turnIdempotencyKey, dryRun } = request.options ?? {};
          if (dryRun) {
            if (!legacyBotmux) {
              const validation = validateTriggerRequest(request);
              if (!validation.ok) return Response.json(validation.body, { status: validation.status });
            }
            return Response.json({ ok: true, action: 'dry_run' });
          }

          const botId = request.target.botId || BOT_ID;
          const prompt = (request.envelope.payload as { message?: string } | undefined)?.message || '';
          triggerRequests.push({ prompt, request });
          const key = turnIdempotencyKey
            ? JSON.stringify([botId, request.target.sessionId, turnIdempotencyKey])
            : idempotencyKey ? JSON.stringify([botId, idempotencyKey]) : undefined;
          let record = !legacyBotmux && key ? triggerRecords.find((turn) => turn.key === key) : undefined;
          if (record && !Bun.deepEquals(record.request, request)) {
            return Response.json({ ok: false, errorCode: 'idempotency_conflict' }, { status: 409 });
          }
          if (!record) {
            record = {
              triggerId: `trg_e2e_${triggerRecords.length + 1}`,
              sessionId: request.target.sessionId || `sess_e2e_${triggerRecords.length + 1}`,
              prompt,
              request,
              key,
            };
            triggerRecords.push(record);
            await heldTriggerAcks.get(prompt);
          }
          return Response.json({
            ok: true,
            accepted: true,
            triggerId: record.triggerId,
            target: { sessionId: record.sessionId, larkAppId: botId },
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
          polledTriggerIds.add(rec.triggerId);
          if (runningPrompts.has(rec.prompt)) {
            return Response.json({ ok: true, state: 'running', triggerId: rec.triggerId });
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
    await stopBridge();
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

  test('start keeps the bridge online after CLI exit and stop releases it', async () => {
    const env = {
      BUBAI_CONFIG_DIR: tmpConfigDir,
      BUBAI_URL: serverUrl,
      BUBAI_TOKEN: 'e2e-cli-secret-token',
      BOTMUX_ENDPOINT: fakeBotmuxUrl,
      BOTMUX_TOKEN: 'fake-e2e-botmux-token',
    };
    const start = ['start', '--bots', BOT_ID];
    try {
      const invalid = await runCli(['start', '--bots', 'missing-bot'], env);
      expect(invalid.code).toBe(1);
      expect(invalid.stderr).toContain('Botmux bot IDs not found');
      const results = await Promise.all([runCli(start, env), runCli(start, env)]);
      for (const result of results) expect(result.code).toBe(0);
      const status = JSON.parse((await runCli(['status', '--json'], env)).stdout);
      expect(status.bridge.state).toBe('online');
      expect(status.bridge.online).toBe(1);
      const repeat = await runCli(start, env);
      expect(repeat.stdout).toContain(String(status.bridge.pid));
    } finally {
      expect((await runCli(['stop'], env)).code).toBe(0);
    }
    expect(JSON.parse((await runCli(['status', '--json'], env)).stdout).bridge).toBeNull();
  }, 30_000);

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
    launchBridge(channel.id);

    // Wait for AgentUser to appear online in BubAI
    const onlineAgent = await waitForBridge(sdk, 'online');
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
      await stopBridge();
      const offlineAgent = await waitForBridge(sdk, 'offline');
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

  test('restarts the bridge and fills the original reply without reposting an accepted turn', async () => {
    await withRecoveryBridge('cli-bridge-recover-accepted', async ({ sdk, channelId, send, relaunch }) => {
      const prompt = 'finish this running turn while the bridge is offline';
      runningPrompts.add(prompt);
      try {
        send(prompt);
        const placeholder = await waitForReply(sdk, channelId, 'running');
        const turn = await waitForCondition(
          async () => triggerRecords.find((record) => record.prompt === prompt),
          'Botmux accepted the turn',
        );
        await waitForCondition(async () => polledTriggerIds.has(turn.triggerId), 'Botmux replied running');

        await stopBridge('SIGINT');
        await waitForBridge(sdk, 'offline');
        runningPrompts.delete(prompt);
        relaunch();

        const completed = await waitForReply(sdk, channelId, 'completed', placeholder.id);
        expect(completed.content).toBe(`Botmux reply to: ${prompt}`);
        expect(completed.adapterMeta?.triggerId).toBe(turn.triggerId);
        expect(triggerRequests.filter((attempt) => attempt.prompt === prompt)).toHaveLength(1);
      } finally {
        runningPrompts.delete(prompt);
      }
    });
  });

  test('fills the original Antigravity reply from its local transcript while Botmux still reports running', async () => {
    await withRecoveryBridge('cli-bridge-antigravity-result', async ({ sdk, channelId, homeDir, send }) => {
      const prompt = 'return an answer through the local Antigravity transcript';
      const answer = 'Verified local Antigravity answer';
      runningPrompts.add(prompt);
      try {
        send(prompt);
        const placeholder = await waitForReply(sdk, channelId, 'running');
        expect(placeholder.senderId).toBe(ANTIGRAVITY_BOT_ID);
        const turn = await waitForCondition(
          async () => triggerRecords.find((record) => record.prompt === prompt),
          'Botmux accepted the Antigravity turn',
        );
        await waitForCondition(async () => polledTriggerIds.has(turn.triggerId), 'Botmux still reports running');

        const createdAt = new Date().toISOString();
        function transcriptTurn(messageId: string, content: string) {
          const event = {
            triggerId: turn.triggerId,
            source: turn.request.source,
            envelope: {
              format: 'json',
              trusted: false,
              payload: {
                conversation: {
                  channel: { id: channelId },
                  outboundApi: {
                    botId: ANTIGRAVITY_BOT_ID,
                    channelId,
                    placeholderMessageId: messageId,
                  },
                },
              },
            },
            options: { asyncReturnSessionId: true },
          };
          return [{
            type: 'USER_INPUT',
            source: 'USER_EXPLICIT',
            status: 'DONE',
            created_at: createdAt,
            content: [
              '<USER_REQUEST>',
              '<user_message>',
              '<botmux_headless_request>',
              '```json',
              JSON.stringify(event),
              '```',
              '</botmux_headless_request>',
              '</user_message>',
              '</USER_REQUEST>',
            ].join('\n'),
          }, {
            type: 'PLANNER_RESPONSE',
            source: 'MODEL',
            status: 'DONE',
            created_at: createdAt,
            content,
          }];
        }

        const logDir = path.join(
          homeDir, '.gemini', 'antigravity-cli', 'brain',
          '706093e6-0317-4b9f-9905-7dccf5b73141', '.system_generated', 'logs',
        );
        fs.mkdirSync(logDir, { recursive: true });
        const steps = [
          ...transcriptTurn('46bc1534-83aa-48be-a4ca-81cd3f1cc8ca', 'Different reply card'),
          ...transcriptTurn(placeholder.id, answer),
        ];
        fs.writeFileSync(
          path.join(logDir, 'transcript_full.jsonl'),
          `${steps.map((step) => JSON.stringify(step)).join('\n')}\n`,
        );

        const completed = await waitForReply(sdk, channelId, 'completed', placeholder.id);
        expect(completed.content).toBe(answer);
        expect(completed.adapterMeta?.sessionId).toBe(turn.sessionId);
        expect(completed.adapterMeta?.triggerId).toBe(turn.triggerId);
        expect(triggerRequests.filter((attempt) => attempt.prompt === prompt)).toHaveLength(1);
      } finally {
        runningPrompts.delete(prompt);
      }
    }, ANTIGRAVITY_BOT_ID);
  }, 30_000);

  test('streams live local tool progress through CLI bridge and preserves finalized steps on completion', async () => {
    await withRecoveryBridge('cli-bridge-live-progress', async ({ sdk, channelId, homeDir, send }) => {
      const prompt = 'stream tool progress while running through CLI bridge';
      runningPrompts.add(prompt);
      try {
        send(prompt);
        const placeholder = await waitForReply(sdk, channelId, 'running');
        expect(placeholder.senderId).toBe(ANTIGRAVITY_BOT_ID);
        const turn = await waitForCondition(
          async () => triggerRecords.find((record) => record.prompt === prompt),
          'Botmux accepted the progress turn',
        );
        await waitForCondition(async () => polledTriggerIds.has(turn.triggerId), 'Botmux replied running');

        const createdAt = new Date().toISOString();
        const event = {
          triggerId: turn.triggerId,
          source: turn.request.source,
          envelope: {
            format: 'json',
            trusted: false,
            payload: {
              conversation: {
                channel: { id: channelId },
                outboundApi: {
                  botId: ANTIGRAVITY_BOT_ID,
                  channelId,
                  placeholderMessageId: placeholder.id,
                },
              },
            },
          },
          options: { asyncReturnSessionId: true },
        };
        const userInputStep = {
          type: 'USER_INPUT',
          source: 'USER_EXPLICIT',
          status: 'DONE',
          created_at: createdAt,
          content: [
            '<USER_REQUEST>',
            '<user_message>',
            '<botmux_headless_request>',
            '```json',
            JSON.stringify(event),
            '```',
            '</botmux_headless_request>',
            '</user_message>',
            '</USER_REQUEST>',
          ].join('\n'),
        };
        const firstToolStep = {
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          status: 'RUNNING',
          created_at: createdAt,
          tool_calls: [
            {
              id: 'call-1',
              name: 'default_api:run_command',
              arguments: JSON.stringify({ toolSummary: 'Check bridge status', CommandLine: 'git status' }),
            },
          ],
        };

        const logDir = path.join(
          homeDir, '.gemini', 'antigravity-cli', 'brain',
          '817194f7-1428-4c0a-aa16-8eddf6c84252', '.system_generated', 'logs',
        );
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, 'transcript_full.jsonl');
        fs.writeFileSync(
          logPath,
          `${[userInputStep, firstToolStep].map((step) => JSON.stringify(step)).join('\n')}\n`,
        );

        const liveCard = await waitForCondition(async () => {
          const { messages } = await sdk.getChannelMessages(channelId);
          const msg = messages.find((m) => m.id === placeholder.id);
          return msg?.card?.status === 'running' && (msg.card.progress?.toolCount ?? 0) >= 1 ? msg : undefined;
        }, 'Live tool progress pushed to running placeholder');
        expect(liveCard.card?.progress?.activeLabel).toBe('Check bridge status');
        expect(liveCard.card?.progress?.steps).toHaveLength(1);
        expect(liveCard.card?.progress?.steps[0]?.kind).toBe('shell');
        expect(liveCard.card?.progress?.steps[0]?.status).toBe('running');

        const secondToolStep = {
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          status: 'DONE',
          created_at: createdAt,
          tool_calls: [
            {
              id: 'call-2',
              name: 'default_api:read_file',
              arguments: JSON.stringify({ Path: '/repo/apps/cli/src/bridge-botmux.ts' }),
            },
          ],
        };
        fs.writeFileSync(
          logPath,
          `${[userInputStep, { ...firstToolStep, status: 'DONE' }, secondToolStep].map((step) => JSON.stringify(step)).join('\n')}\n`,
        );

        runningPrompts.delete(prompt);
        const completed = await waitForReply(sdk, channelId, 'completed', placeholder.id);
        expect(completed.content).toBe(`Botmux reply to: ${prompt}`);
        expect(completed.card?.progress?.toolCount).toBe(2);
        expect(completed.card?.progress?.activeLabel).toBeUndefined();
        expect(completed.card?.progress?.steps.map((s) => [s.kind, s.label, s.status])).toEqual([
          ['shell', 'Check bridge status', 'done'],
          ['read', '读取 bridge-botmux.ts', 'done'],
        ]);
      } finally {
        runningPrompts.delete(prompt);
      }
    }, ANTIGRAVITY_BOT_ID);
  }, 30_000);

  for (const mode of ['fresh', 'follow-up', 'legacy'] as const) {
    const testName = mode === 'legacy'
      ? 'does not repeat a turn accepted by legacy Botmux after losing the response'
      : `recovers a ${mode} turn whose Botmux acceptance response was lost`;
    test(testName, async () => {
      await withRecoveryBridge(`cli-bridge-lost-ack-${mode}`, async ({ sdk, channelId, send, relaunch }) => {
        let existingSessionId: unknown;
        if (mode === 'follow-up') {
          send('open a session for the follow-up test');
          const first = await waitForReply(sdk, channelId, 'completed');
          existingSessionId = first.adapterMeta?.sessionId;
          expect(existingSessionId).toBeString();
        }

        const prompt = `keep the original ${mode} turn across a lost response`;
        const ack = Promise.withResolvers<void>();
        heldTriggerAcks.set(prompt, ack.promise);
        legacyBotmux = mode === 'legacy';
        try {
          send(prompt);
          const placeholder = await waitForReply(sdk, channelId, 'running');
          const turn = await waitForCondition(
            async () => triggerRecords.find((record) => record.prompt === prompt),
            'Botmux accepted the turn before sending its HTTP response',
          );
          expect(polledTriggerIds.has(turn.triggerId)).toBe(false);
          expect(turn.request.target.sessionId).toBe(existingSessionId);
          if (mode === 'follow-up') {
            expect(turn.request.options?.turnIdempotencyKey).toBeString();
          } else if (mode === 'fresh') {
            expect(turn.request.options?.idempotencyKey).toBeString();
          }

          await stopBridge('SIGKILL');
          await waitForBridge(sdk, 'offline');
          ack.resolve();
          relaunch();

          if (mode === 'legacy') {
            const failed = await waitForReply(sdk, channelId, 'failed', placeholder.id);
            expect(failed.content).toContain('无法确认');
            expect(triggerRequests.filter((attempt) => attempt.prompt === prompt)).toHaveLength(1);
            expect(triggerRecords.filter((record) => record.prompt === prompt)).toHaveLength(1);
            return;
          }

          const completed = await waitForReply(sdk, channelId, 'completed', placeholder.id);
          expect(completed.content).toBe(`Botmux reply to: ${prompt}`);
          expect(completed.adapterMeta?.triggerId).toBe(turn.triggerId);
          expect(triggerRecords.filter((record) => record.prompt === prompt)).toHaveLength(1);
          const retries = triggerRequests.filter((attempt) => attempt.prompt === prompt);
          expect(retries.map((retry) => retry.request)).toEqual([turn.request, turn.request]);
        } finally {
          ack.resolve();
          heldTriggerAcks.delete(prompt);
          legacyBotmux = false;
        }
      });
    });
  }
});
