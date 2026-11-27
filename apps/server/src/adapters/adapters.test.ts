import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerWebSocket } from 'bun';
import { openChatDatabase, type ChatDb } from '@buzz-botmux/db';
import { AgentDispatcher } from './dispatcher';
import { BotmuxAgentAdapter } from './botmux-adapter';
import { BotGatewayAdapter, type BotGatewayWsData } from './gateway-adapter';
import { WebhookAgentAdapter, signWebhookPayload } from './webhook-adapter';
import type { TurnDispatchRequest } from './types';

function makeFakeGatewayWs(
  connectionId: string,
  opts?: { botUserId?: string; isServerKey?: boolean },
) {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: WebSocket.OPEN as number,
    data: {
      kind: 'bot-gateway' as const,
      connectionId,
      botUserId: opts?.botUserId,
      isServerKey: opts?.isServerKey ?? true,
      boundAgentIds: new Set<string>(),
    },
    send(payload: string) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
    },
  };
  return {
    ws: ws as unknown as ServerWebSocket<BotGatewayWsData>,
    sent,
    close() {
      ws.readyState = WebSocket.CLOSED;
    },
  };
}

function makeTurnRequest(agent: Awaited<ReturnType<AgentDispatcher['listAgents']>>[number]): TurnDispatchRequest {
  return {
    agent,
    turnId: '00000000-0000-0000-0000-000000000101',
    channel: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'general',
      kind: 'channel',
      topic: '',
      replyMode: 'follow_source',
    },
    replyThreadId: null,
    triggerMessage: {
      id: '00000000-0000-0000-0000-000000000100',
      senderId: 'u-owner',
      senderName: 'Owner',
      content: `@${agent.name} hello`,
      attachments: [],
    },
    promptWithAttachments: `@${agent.name} hello`,
    history: [],
    outboundApi: {
      endpoint: 'http://127.0.0.1:4000/api/bot/messages',
      progressEndpoint: 'http://127.0.0.1:4000/api/bot/messages/00000000-0000-0000-0000-000000000101/progress',
      botId: agent.id,
      channelId: '00000000-0000-0000-0000-000000000001',
      placeholderMessageId: '00000000-0000-0000-0000-000000000101',
    },
    turnStartedAt: Date.now(),
  };
}

describe('Agent persistence, Adapter boundary & Bot Gateway protocol', () => {
  let tmpDir: string;
  let db: ChatDb;
  let closeDb: () => Promise<void>;
  let dispatcher: AgentDispatcher;
  let gateway: BotGatewayAdapter;
  let webhook: WebhookAgentAdapter;
  let presenceChanges = 0;
  let askChanges = 0;
  const completedTurns: Array<{ botId: string; messageId: string; content: string }> = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-adapters-test-'));
    const opened = await openChatDatabase({ dataDir: tmpDir });
    db = opened.db;
    closeDb = opened.close;

    const botmux = new BotmuxAgentAdapter({
      db,
      endpoint: 'http://127.0.0.1:7891',
      enabled: false,
    });
    webhook = new WebhookAgentAdapter();
    gateway = new BotGatewayAdapter({
      onAgentsRegistered: async (agents) => {
        await dispatcher.upsertAgents(agents);
      },
      onPresenceChanged: async () => {
        presenceChanges += 1;
      },
      onAsksChanged: async () => {
        askChanges += 1;
      },
      onTurnComplete: async ({ botId, messageId, content }) => {
        completedTurns.push({ botId, messageId, content });
      },
    });
    dispatcher = new AgentDispatcher({ db, botmux, gateway, webhook });
  }, 15_000);

  afterAll(async () => {
    if (closeDb) await closeDb();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Step 1: persists agents in DB, preserves custom displayName, and marks offline on disconnect instead of vanishing', async () => {
    const conn = makeFakeGatewayWs('gw_1');
    gateway.handleOpen(conn.ws);
    await gateway.handleMessage(
      conn.ws,
      JSON.stringify({
        type: 'bot.hello',
        payload: {
          agents: [
            {
              id: 'agent-alpha',
              name: 'Alpha Bot',
              cliId: 'claude',
              workingDir: '/tmp/alpha',
              capabilities: ['progress_steps', 'terminal_attach'],
            },
          ],
        },
      }),
    );

    expect(conn.sent.at(-1)?.type).toBe('bot.welcome');

    // User sets a custom displayName override
    await dispatcher.upsertAgents([{ agentId: 'agent-alpha', displayName: 'My Custom Alpha' }]);

    let agents = await dispatcher.listAgents();
    const onlineAlpha = agents.find((a) => a.id === 'agent-alpha');
    expect(onlineAlpha).toBeDefined();
    expect(onlineAlpha?.name).toBe('My Custom Alpha');
    expect(onlineAlpha?.defaultName).toBe('Alpha Bot');
    expect(onlineAlpha?.online).toBe(true);
    expect(onlineAlpha?.capabilities).toEqual(['progress_steps', 'terminal_attach']);

    // Mentions match both custom displayName and defaultName
    expect(dispatcher.findMentionedAgents('hi @My Custom Alpha', agents).map((a) => a.id)).toEqual([
      'agent-alpha',
    ]);
    expect(dispatcher.findMentionedAgents('hi @Alpha Bot', agents).map((a) => a.id)).toEqual([
      'agent-alpha',
    ]);

    // Disconnect gateway -> agent must STAY in DB list with online: false
    conn.close();
    await gateway.handleClose(conn.ws);

    agents = await dispatcher.listAgents();
    const offlineAlpha = agents.find((a) => a.id === 'agent-alpha');
    expect(offlineAlpha).toBeDefined();
    expect(offlineAlpha?.online).toBe(false);
    expect(presenceChanges).toBeGreaterThan(0);

    // Dispatching to an offline agent returns a clean error instead of throwing
    const offlineDispatch = await dispatcher.dispatchTurn(makeTurnRequest(offlineAlpha!));
    expect(offlineDispatch.ok).toBe(false);
    expect(offlineDispatch.error).toContain('离线');
  });

  test('Step 2 & 3: Gateway WS dispatches standard turn.requested, settles via bot.turn.complete, and handles native asks', async () => {
    const conn = makeFakeGatewayWs('gw_2');
    gateway.handleOpen(conn.ws);
    await gateway.handleMessage(
      conn.ws,
      JSON.stringify({
        type: 'bot.hello',
        payload: {
          agents: [{ id: 'agent-beta', name: 'Beta Bot', capabilities: ['interactive_ask'] }],
        },
      }),
    );

    const beta = await dispatcher.getAgent('agent-beta');
    expect(beta?.online).toBe(true);

    const dispatched = await dispatcher.dispatchTurn(makeTurnRequest(beta!));
    expect(dispatched.ok).toBe(true);
    expect(dispatched.adapterType).toBe('gateway');

    const turnEvent = conn.sent.find((m) => m.type === 'turn.requested');
    expect(turnEvent).toBeDefined();
    expect(turnEvent?.botId).toBe('agent-beta');

    // Gateway sends completion back
    await gateway.handleMessage(
      conn.ws,
      JSON.stringify({
        type: 'bot.turn.complete',
        payload: {
          botId: 'agent-beta',
          messageId: '00000000-0000-0000-0000-000000000101',
          content: 'Done via Gateway!',
        },
      }),
    );
    expect(completedTurns).toEqual([
      {
        botId: 'agent-beta',
        messageId: '00000000-0000-0000-0000-000000000101',
        content: 'Done via Gateway!',
      },
    ]);

    // Native Ask create & answer round-trip
    await gateway.handleMessage(
      conn.ws,
      JSON.stringify({
        type: 'bot.ask.create',
        payload: {
          askId: 'ask_native_1',
          agentId: 'agent-beta',
          title: 'Deploy?',
          prompt: 'Proceed with release?',
        },
      }),
    );
    const pending = await dispatcher.getPendingAsks();
    expect(pending.some((a) => a.askId === 'ask_native_1')).toBe(true);

    const answerRes = await dispatcher.answerAsk({
      askId: 'ask_native_1',
      larkAppId: 'agent-beta',
      selections: [['yes']],
      by: 'u-owner',
    });
    expect(answerRes.ok).toBe(true);
    expect(conn.sent.some((m) => m.type === 'ask.answered')).toBe(true);
    expect(askChanges).toBeGreaterThanOrEqual(2);
  });

  test('Step 3: WebhookAgentAdapter signs and delivers standard turn.requested over HTTP POST', async () => {
    let receivedBody = '';
    let receivedSig = '';
    let receivedEvent = '';

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        receivedBody = await req.text();
        receivedSig = req.headers.get('x-bubai-signature') || '';
        receivedEvent = req.headers.get('x-bubai-event') || '';
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    const prevAllowLocal = process.env.BUBAI_ALLOW_LOCAL_WEBHOOKS;
    process.env.BUBAI_ALLOW_LOCAL_WEBHOOKS = 'true';
    try {
      const secret = 'whsec_test_123';
      await dispatcher.upsertAgents([
        {
          agentId: 'agent-webhook',
          adapterType: 'webhook',
          defaultName: 'Cloud Webhook Agent',
          webhookUrl: `http://127.0.0.1:${server.port}/hook`,
          webhookSecret: secret,
          capabilities: ['progress_steps'],
        },
      ]);

      const hookAgent = await dispatcher.getAgent('agent-webhook');
      expect(hookAgent?.online).toBe(true);
      expect(hookAgent?.adapterType).toBe('webhook');

      const res = await dispatcher.dispatchTurn(makeTurnRequest(hookAgent!));
      expect(res.ok).toBe(true);
      expect(res.adapterType).toBe('webhook');
      expect(receivedEvent).toBe('turn.requested');
      expect(receivedSig).toBe(signWebhookPayload(secret, receivedBody));
    } finally {
      if (prevAllowLocal === undefined) delete process.env.BUBAI_ALLOW_LOCAL_WEBHOOKS;
      else process.env.BUBAI_ALLOW_LOCAL_WEBHOOKS = prevAllowLocal;
      server.stop(true);
    }
  });
});
