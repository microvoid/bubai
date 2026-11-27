import { BotmuxClient, type BotmuxBot } from '@buzz-botmux/botmux-client';
import {
  BubaiClient,
  type BotGatewayAgentDescriptor,
  type BotGatewayHandle,
  type BotTurnRequestedEvent,
} from '@buzz-botmux/chat-client';

export interface BotmuxBridgeOptions {
  serverUrl: string;
  /** Human session token (used for provisioning/issuing bot_ keys) OR legacy static token */
  token?: string;
  /** Optional explicit Bot API key (`bot_...` or `bot-server_...`) for direct /ws/bot connection */
  botToken?: string;
  botmuxEndpoint: string;
  botmuxToken?: string;
  botIds?: string[];
  channelRef?: string;
  autoReply?: boolean;
  pollMs?: number;
  turnTimeoutMs?: number;
  onReady?: (info: { agentIds: string[]; connectionId: string }) => void;
}

const TURN_TIMEOUT_MS = 30 * 60_000;
const RESULT_NOT_FOUND_GRACE_MS = 10_000;

const BOTMUX_CAPABILITIES = [
  'progress_steps',
  'interactive_ask',
  'terminal_attach',
  'session_control',
];

function isBotCredential(token?: string): boolean {
  return Boolean(token && (token.startsWith('bot_') || token.startsWith('bot-server_')));
}

async function completeTurn(
  sdk: BubaiClient,
  messageId: string,
  result: Parameters<BubaiClient['completeBotTurn']>[1],
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await sdk.completeBotTurn(messageId, result, { signal: AbortSignal.timeout(5_000) });
      return;
    } catch (error) {
      const status = error instanceof Error && 'status' in error && typeof error.status === 'number'
        ? error.status
        : undefined;
      const permanentError = status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanentError || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
}

/**
 * Bridge local Botmux daemon into BubAI via the unified `BubaiClient` SDK:
 * - Supports strict auth (`BUBAI_AUTH_REQUIRED=true`):
 *   - If given a human session token, provisions each local Botmux bot via `/api/agents/provision`
 *     with `issueKey: true, keyScope: 'bot'`, and connects `/ws/bot` using each bot's issued `bot_` key.
 *   - If given an explicit `bot_` / `bot-server_` key (or legacy static token in dev mode), connects
 *     directly to `/ws/bot` with that credential.
 * - Maintains `channelId:botId -> sessionId` locally with `session_not_found` automatic retry.
 */
export async function startBotmuxBridge(options: BotmuxBridgeOptions): Promise<{
  stop: () => void;
  agentIds: string[];
}> {
  const botmux = new BotmuxClient(options.botmuxEndpoint, options.botmuxToken);
  const pollMs = options.pollMs ?? 500;
  const turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS;
  const sessionBindings = new Map<string, string>();
  let stopped = false;

  const requestedIds = new Set(options.botIds);
  if (options.botIds && requestedIds.size === 0) {
    throw new Error('Specify at least one Botmux bot ID');
  }
  const discoveredBots: BotmuxBot[] = await botmux.getBots();
  const missingIds = [...requestedIds].filter((id) => !discoveredBots.some((bot) => bot.larkAppId === id));
  if (missingIds.length > 0) {
    throw new Error('Botmux bot IDs not found: ' + missingIds.join(', '));
  }
  const bots = requestedIds.size > 0
    ? discoveredBots.filter((bot) => requestedIds.has(bot.larkAppId))
    : discoveredBots;
  const explicitBotToken = options.botToken || (isBotCredential(options.token) ? options.token : undefined);
  const humanToken = !isBotCredential(options.token) ? options.token : undefined;

  const provisionedEntries: Array<{
    descriptor: BotGatewayAgentDescriptor;
    gatewayToken?: string;
  }> = [];

  if (explicitBotToken) {
    // Pure bot-key runtime mode: connect directly without calling human /api/agents/provision
    for (const bot of bots) {
      provisionedEntries.push({
        descriptor: {
          id: bot.larkAppId,
          externalId: bot.larkAppId,
          name: bot.botName,
          cliId: bot.cliId,
          workingDir: bot.workingDir,
          capabilities: BOTMUX_CAPABILITIES,
        },
        gatewayToken: explicitBotToken,
      });
    }
  } else {
    const provisionSdk = new BubaiClient({ baseUrl: options.serverUrl, token: humanToken });
    for (const bot of bots) {
      const isUuid =
        options.channelRef &&
        /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(options.channelRef);
      const provisioned = await provisionSdk.provisionAgent({
        agentId: bot.larkAppId,
        adapterType: 'gateway',
        externalId: bot.larkAppId,
        name: bot.botName,
        cliId: bot.cliId,
        workingDir: bot.workingDir || undefined,
        capabilities: BOTMUX_CAPABILITIES,
        ...(isUuid
          ? { channelId: options.channelRef }
          : options.channelRef
            ? { channelName: options.channelRef }
            : {}),
        ...(options.autoReply !== undefined ? { autoReply: options.autoReply } : {}),
        issueKey: Boolean(humanToken),
        keyScope: 'bot',
      });

      provisionedEntries.push({
        descriptor: {
          id: provisioned.agent.id,
          externalId: bot.larkAppId,
          name: bot.botName,
          cliId: bot.cliId,
          workingDir: bot.workingDir,
          capabilities: BOTMUX_CAPABILITIES,
        },
        gatewayToken: provisioned.apiKey || humanToken,
      });
    }
  }

  const gateways: BotGatewayHandle[] = [];

  const handleTurn = async (
    event: BotTurnRequestedEvent,
    sdk: BubaiClient,
  ) => {
    const externalBotId = event.externalId || event.botId;
    const bot = bots.find((b) => b.larkAppId === externalBotId);
    const bindingKey = `${event.channel.id}:${externalBotId}`;
    let existingSessionId = sessionBindings.get(bindingKey);

    const attachmentNote =
      event.triggerMessage.attachments.length > 0
        ? `\n\n[附件]\n${event.triggerMessage.attachments.map((a) => `- ${a.name} (${a.mimeType}, ${a.url})`).join('\n')}`
        : '';

    const runTrigger = (sessionId?: string) =>
      botmux
        .triggerTurn({
          botId: externalBotId,
          cliId: bot?.cliId,
          sessionId,
          prompt: `${event.triggerMessage.content}${attachmentNote}`,
          senderName: event.triggerMessage.senderName,
          systemPrompt: event.systemPrompt,
          context: {
            channel: event.channel,
            ...(event.threadId ? { threadId: event.threadId } : {}),
            outboundApi: {
              botId: event.botId,
              channelId: event.replyTarget.channelId,
              ...(event.replyTarget.threadId ? { threadId: event.replyTarget.threadId } : {}),
              placeholderMessageId: event.replyTarget.messageId,
            },
            messages: event.history,
          },
        })
        .catch((err) => ({
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        }));

    let triggered = await runTrigger(existingSessionId);
    if (
      existingSessionId &&
      !triggered.ok &&
      'errorCode' in triggered &&
      triggered.errorCode === 'session_not_found'
    ) {
      sessionBindings.delete(bindingKey);
      existingSessionId = undefined;
      triggered = await runTrigger(undefined);
    }

    const sessionId =
      'target' in triggered ? triggered.target?.sessionId || existingSessionId : existingSessionId;
    const triggerId = 'triggerId' in triggered ? triggered.triggerId : undefined;

    const messageId = event.replyTarget.messageId;
    if (!triggered.ok || !sessionId || !triggerId) {
      await completeTurn(sdk, messageId, {
        content: triggered.error || 'Botmux dispatch failed',
        status: 'failed',
      });
      return;
    }

    sessionBindings.set(bindingKey, sessionId);

    const adapterMeta = { adapter: 'bubai-cli-botmux', sessionId, triggerId };
    const startedAt = Date.now();
    const deadline = startedAt + turnTimeoutMs;
    while (!stopped && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
      if (stopped || Date.now() >= deadline) break;
      const result = await botmux.pollTriggerResult(sessionId, triggerId).catch(() => undefined);
      if (!result) continue;

      if (result.state === 'completed') {
        await completeTurn(sdk, messageId, {
          content: result.output?.content?.trim() || '（任务已完成，无文本输出）',
          status: 'completed',
          adapterMeta,
        });
        return;
      }

      if (result.state === 'failed' || result.state === 'interrupted') {
        await completeTurn(sdk, messageId, {
          content: result.error || 'Botmux turn ' + result.state,
          status: result.state,
          adapterMeta,
        });
        return;
      }

      if (result.state === 'not_found' && Date.now() - startedAt >= RESULT_NOT_FOUND_GRACE_MS) {
        await completeTurn(sdk, messageId, {
          content: 'Botmux 未找到本轮执行记录',
          status: 'failed',
          adapterMeta,
        });
        return;
      }
    }

    if (!stopped) {
      await completeTurn(sdk, messageId, {
        content: '等待 Botmux 回复超时',
        status: 'timeout',
        adapterMeta,
      });
    }
  };

  // Group entries by gatewayToken so a shared bot-server_ / static token uses 1 WS connection,
  // while individual per-bot `bot_` keys each get their own scoped WS connection.
  const groups = new Map<string, { token?: string; agents: BotGatewayAgentDescriptor[] }>();
  for (const entry of provisionedEntries) {
    const key = entry.gatewayToken || '__no_token__';
    const existing = groups.get(key);
    if (existing) {
      existing.agents.push(entry.descriptor);
    } else {
      groups.set(key, { token: entry.gatewayToken, agents: [entry.descriptor] });
    }
  }

  for (const group of groups.values()) {
    const groupSdk = new BubaiClient({ baseUrl: options.serverUrl, token: group.token });
    const gw = groupSdk.connectBotGateway({
      agents: group.agents,
      onWelcome: (info) => {
        console.log(
          JSON.stringify({
            event: 'bridge.ready',
            connectionId: info.connectionId,
            agentIds: info.agentIds,
          }),
        );
        options.onReady?.(info);
      },
      onTurnRequested: (event) => {
        void handleTurn(event, groupSdk).catch((error) => {
          console.error('Botmux bridge could not settle message ' + event.replyTarget.messageId + ':', error);
        });
      },
      onAskAnswered: (answer) => {
        void botmux.answerAsk(answer);
      },
    });
    gateways.push(gw);
  }

  return {
    agentIds: provisionedEntries.map((e) => e.descriptor.id),
    stop: () => {
      stopped = true;
      for (const gw of gateways) gw.close();
    },
  };
}
