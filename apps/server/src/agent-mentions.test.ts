import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  getAgentMentionHop,
  mergeAgentMentionHop,
  parseMaxAgentMentionHops,
  selectAgentReplyTargets,
} from './agent-mentions';
import { AgentDispatcher } from './adapters/dispatcher';
import type { ResolvedAgent } from './adapters/types';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Failed to allocate port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Server did not become ready at ${baseUrl}`);
}

function makeAgent(id: string, name: string, overrides?: Partial<ResolvedAgent>): ResolvedAgent {
  return {
    id,
    organizationId: null,
    ownerUserId: null,
    name,
    defaultName: name,
    adapterType: 'botmux',
    externalId: id,
    cliId: 'codex',
    workingDir: null,
    description: null,
    systemPrompt: null,
    avatarUrl: null,
    capabilities: [],
    webhookUrl: null,
    webhookSecret: null,
    archived: false,
    online: true,
    lastSeenAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function findMentionedAgents(content: string, agents: ResolvedAgent[]): ResolvedAgent[] {
  const lower = content.toLowerCase();
  return agents.filter((agent) => {
    if (agent.archived) return false;
    return [agent.name, agent.defaultName, agent.id].some(
      (candidate) => candidate && lower.includes(`@${candidate.toLowerCase()}`),
    );
  });
}

describe('agent-mentions', () => {
  const alpha = makeAgent('bot_alpha', 'Alpha Bot');
  const beta = makeAgent('bot_beta', 'Beta Bot');
  const gamma = makeAgent('bot_gamma', 'Gamma Bot', { archived: true });
  const knownAgents = [alpha, beta, gamma];

  it('dispatches another agent when an agent @-mentions it', () => {
    const result = selectAgentReplyTargets({
      content: '请 @Beta Bot 看下这个 PR',
      knownAgents,
      channelAgentIds: new Set(['bot_alpha', 'bot_beta']),
      autoReplyBotIds: new Set(),
      enforceChannelMembership: false,
      senderAgentId: 'bot_alpha',
      currentHop: 0,
      findMentionedAgents,
    });

    expect(result.hopLimitReached).toBe(false);
    expect(result.nextHop).toBe(1);
    expect(result.targets.map((a) => a.id)).toEqual(['bot_beta']);
  });

  it('excludes self-mentions and auto-reply bots for agent-sent messages', () => {
    const result = selectAgentReplyTargets({
      content: '@Alpha Bot 自己提到的内容，没有提别人',
      knownAgents,
      channelAgentIds: new Set(['bot_alpha', 'bot_beta']),
      autoReplyBotIds: new Set(['bot_beta']),
      enforceChannelMembership: false,
      senderAgentId: 'bot_alpha',
      currentHop: 0,
      findMentionedAgents,
    });

    expect(result.targets).toEqual([]);
    expect(result.hopLimitReached).toBe(false);
  });

  it('still includes auto-reply bots for human-sent messages with nextHop=0', () => {
    const result = selectAgentReplyTargets({
      content: '大家好',
      knownAgents,
      channelAgentIds: new Set(['bot_alpha', 'bot_beta']),
      autoReplyBotIds: new Set(['bot_beta']),
      enforceChannelMembership: false,
      senderAgentId: null,
      findMentionedAgents,
    });

    expect(result.targets.map((a) => a.id)).toEqual(['bot_beta']);
    expect(result.nextHop).toBe(0);
    expect(result.hopLimitReached).toBe(false);
  });

  it('enforces channel membership when required', () => {
    const result = selectAgentReplyTargets({
      content: '@Beta Bot 请协助',
      knownAgents,
      channelAgentIds: new Set(['bot_alpha']),
      autoReplyBotIds: new Set(),
      enforceChannelMembership: true,
      senderAgentId: 'bot_alpha',
      currentHop: 0,
      findMentionedAgents,
    });

    expect(result.targets).toEqual([]);
  });

  it('stops dispatching once maxAgentMentionHops is reached', () => {
    const result = selectAgentReplyTargets({
      content: '@Beta Bot 继续处理',
      knownAgents,
      channelAgentIds: new Set(['bot_alpha', 'bot_beta']),
      autoReplyBotIds: new Set(),
      enforceChannelMembership: false,
      senderAgentId: 'bot_alpha',
      currentHop: 5,
      maxAgentMentionHops: 5,
      findMentionedAgents,
    });

    expect(result.targets).toEqual([]);
    expect(result.hopLimitReached).toBe(true);
    expect(result.nextHop).toBe(6);
  });

  it('preserves agentMentionHop across adapterMeta merges', () => {
    expect(getAgentMentionHop(null)).toBe(0);
    expect(getAgentMentionHop({ agentMentionHop: 2 })).toBe(2);
    expect(mergeAgentMentionHop({ session: 's1' }, { agentMentionHop: 2 })).toEqual({
      session: 's1',
      agentMentionHop: 2,
    });
    expect(mergeAgentMentionHop(null, null, 3)).toEqual({ agentMentionHop: 3 });
    expect(mergeAgentMentionHop(null, null, 0)).toBeNull();
    expect(parseMaxAgentMentionHops(undefined)).toBe(5);
    expect(parseMaxAgentMentionHops('3')).toBe(3);
    expect(parseMaxAgentMentionHops('0')).toBe(0);
    expect(parseMaxAgentMentionHops('-1')).toBe(5);
  });

  it('ignores email addresses, word-suffixes, and shorter prefix collisions in findMentionedAgents', () => {
    const alphaPro = makeAgent('bot_alpha_pro', 'Alpha Bot Pro');
    const agents = [alpha, alphaPro, beta];
    const match = (text: string) =>
      AgentDispatcher.prototype.findMentionedAgents(text, agents).map((a) => a.id);

    expect(match('email ops@bot_alpha.com and user@alpha bot')).toEqual([]);
    expect(match('mention @bot_alpha2 should not match')).toEqual([]);
    expect(match('请 @Alpha Bot Pro 处理')).toEqual(['bot_alpha_pro']);
    expect(match('请 @Alpha Bot 和 @Alpha Bot Pro 一起看')).toEqual(['bot_alpha', 'bot_alpha_pro']);
    expect(match('@Alpha Bot，请复核')).toEqual(['bot_alpha']);
  });

  it('dispatches agent-to-agent @mentions end-to-end and stops at hop limit', async () => {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubai-agent-mentions-'));
    const botToken = 'test-agent-mentions-token';
    const serverEntry = path.resolve(import.meta.dir, './main.ts');
    const child = spawn('bun', [serverEntry], {
      cwd: dataDir,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: '',
        DATA_DIR: dataDir,
        BUBAI_AUTH_REQUIRED: 'false',
        BOTMUX_DISABLED: 'true',
        BUZZ_BOT_TOKEN: botToken,
        BUBAI_MAX_AGENT_MENTION_HOPS: '2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const receivedTurns: Array<{
      botId: string;
      turnId: string;
      triggerSenderId: string;
      triggerContent: string;
    }> = [];
    let gatewayWs: WebSocket | null = null;

    try {
      await waitForServer(baseUrl);

      const bootstrapRes = await fetch(`${baseUrl}/api/bootstrap`);
      expect(bootstrapRes.ok).toBe(true);
      const bootstrap = (await bootstrapRes.json()) as { channels: Array<{ id: string }> };
      const channelId = bootstrap.channels[0]?.id;
      expect(channelId).toBeTruthy();

      gatewayWs = new WebSocket(`ws://127.0.0.1:${port}/ws/bot?token=${encodeURIComponent(botToken)}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS hello timeout')), 5000);
        gatewayWs!.onopen = () => {
          gatewayWs!.send(
            JSON.stringify({
              type: 'bot.hello',
              payload: {
                agents: [
                  { id: 'agent_alpha', name: 'Agent Alpha' },
                  { id: 'agent_beta', name: 'Agent Beta' },
                ],
              },
            }),
          );
        };
        gatewayWs!.onmessage = (ev) => {
          const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (frame.type === 'bot.welcome') {
            clearTimeout(timer);
            resolve();
            return;
          }
          if (frame.type === 'turn.requested') {
            const trigger = frame.triggerMessage as { senderId?: string; content?: string } | undefined;
            receivedTurns.push({
              botId: String(frame.botId || ''),
              turnId: String(frame.turnId || ''),
              triggerSenderId: String(trigger?.senderId || ''),
              triggerContent: String(trigger?.content || ''),
            });
          }
        };
        gatewayWs!.onerror = () => {
          clearTimeout(timer);
          reject(new Error('WS error'));
        };
      });

      const waitForTurnCount = async (expectedCount: number) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (receivedTurns.length >= expectedCount) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`Expected ${expectedCount} turns, got ${receivedTurns.length}`);
      };

      // Hop 1: Agent Alpha posts via /api/bot/messages mentioning @Agent Beta (and self @Agent Alpha)
      const postRes = await fetch(`${baseUrl}/api/bot/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({
          botId: 'agent_alpha',
          channelId,
          content: '@Agent Alpha 转交任务给 @Agent Beta 请处理',
        }),
      });
      expect(postRes.status).toBe(201);

      await waitForTurnCount(1);
      expect(receivedTurns[0]?.botId).toBe('agent_beta');
      expect(receivedTurns[0]?.triggerSenderId).toBe('agent_alpha');

      // Hop 2: Agent Beta completes turn via gateway mentioning @Agent Alpha
      gatewayWs.send(
        JSON.stringify({
          type: 'bot.turn.complete',
          payload: {
            botId: 'agent_beta',
            messageId: receivedTurns[0]!.turnId,
            status: 'completed',
            content: '已处理，请 @Agent Alpha 复核',
          },
        }),
      );

      await waitForTurnCount(2);
      expect(receivedTurns[1]?.botId).toBe('agent_alpha');
      expect(receivedTurns[1]?.triggerSenderId).toBe('agent_beta');

      // Hop 3 (exceeds BUBAI_MAX_AGENT_MENTION_HOPS=2): Agent Alpha mentions @Agent Beta again -> must NOT dispatch
      gatewayWs.send(
        JSON.stringify({
          type: 'bot.turn.complete',
          payload: {
            botId: 'agent_alpha',
            messageId: receivedTurns[1]!.turnId,
            status: 'completed',
            content: '再次 @Agent Beta 测试循环保护',
          },
        }),
      );

      await new Promise((r) => setTimeout(r, 500));
      expect(receivedTurns.length).toBe(2);

      // Standalone follow-up POST /api/bot/messages after hop-2 turn must also inherit hop limit and NOT bypass it
      const bypassRes = await fetch(`${baseUrl}/api/bot/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({
          botId: 'agent_alpha',
          channelId,
          content: '通过独立接口再次 @Agent Beta 尝试绕过跳数限制',
        }),
      });
      expect(bypassRes.status).toBe(201);
      const bypassData = (await bypassRes.json()) as { message: { id: string } };

      // PATCHing a standalone message (card === null) with status='completed' must not re-trigger
      const patchRes = await fetch(`${baseUrl}/api/bot/messages/${bypassData.message.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ status: 'completed' }),
      });
      expect(patchRes.status).toBe(200);

      await new Promise((r) => setTimeout(r, 400));
      expect(receivedTurns.length).toBe(2);
    } finally {
      gatewayWs?.close();
      child.kill('SIGTERM');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
