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
  channelRef?: string;
  autoReply?: boolean;
  pollMs?: number;
  onReady?: (info: { agentIds: string[]; connectionId: string }) => void;
}

const BOTMUX_CAPABILITIES = [
  'progress_steps',
  'interactive_ask',
  'terminal_attach',
  'session_control',
];

function isBotCredential(token?: string): boolean {
  return Boolean(token && (token.startsWith('bot_') || token.startsWith('bot-server_')));
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
  const sessionBindings = new Map<string, string>();
  let stopped = false;

  const bots: BotmuxBot[] = await botmux.getBots();
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
    gateway: BotGatewayHandle,
    fallbackSdk: BubaiClient,
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
              endpoint: event.outboundApi.endpoint,
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

    if (!triggered.ok || !sessionId || !triggerId) {
      const errMsg = triggered.error || 'Botmux dispatch failed';
      if (
        !gateway.sendTurnComplete({
          botId: event.botId,
          messageId: event.replyTarget.messageId,
          content: errMsg,
          status: 'failed',
        })
      ) {
        await fallbackSdk.updateBotMessage(event.replyTarget.messageId, {
          content: errMsg,
          status: 'failed',
        });
      }
      return;
    }

    sessionBindings.set(bindingKey, sessionId);

    const deadline = Date.now() + 30 * 60_000;
    while (!stopped && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const result = await botmux.pollTriggerResult(sessionId, triggerId).catch(() => undefined);
      if (!result) continue;

      if (result.state === 'completed') {
        const content = result.output?.content?.trim() || '（任务已完成，无文本输出）';
        const meta = { adapter: 'bubai-cli-botmux', sessionId, triggerId };
        if (
          !gateway.sendTurnComplete({
            botId: event.botId,
            messageId: event.replyTarget.messageId,
            content,
            status: 'completed',
            adapterMeta: meta,
          })
        ) {
          await fallbackSdk.sendBotMessage({
            botId: event.botId,
            channelId: event.replyTarget.channelId,
            threadId: event.replyTarget.threadId,
            messageId: event.replyTarget.messageId,
            content,
            adapterMeta: meta,
          });
        }
        return;
      }

      if (result.state === 'failed' || result.state === 'interrupted') {
        const errText = result.error || `Botmux turn ${result.state}`;
        const meta = { adapter: 'bubai-cli-botmux', sessionId, triggerId };
        if (
          !gateway.sendTurnComplete({
            botId: event.botId,
            messageId: event.replyTarget.messageId,
            content: errText,
            status: result.state,
            adapterMeta: meta,
          })
        ) {
          await fallbackSdk.updateBotMessage(event.replyTarget.messageId, {
            content: errText,
            status: result.state,
            adapterMeta: meta,
          });
        }
        return;
      }
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
        void handleTurn(event, gw, groupSdk);
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
