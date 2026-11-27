import { BotmuxClient, type BotmuxBot } from '@buzz-botmux/botmux-client';
import {
  BubaiClient,
  type BotGatewayAgentDescriptor,
  type BotGatewayHandle,
  type BotTurnRequestedEvent,
} from '@buzz-botmux/chat-client';

export interface BotmuxBridgeOptions {
  serverUrl: string;
  token?: string;
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

/**
 * Bridge local Botmux daemon into BubAI via the unified `BubaiClient` SDK:
 * 1. Fetches local Botmux bots
 * 2. Idempotently provisions each bot as a persistent BubAI AgentUser (and optionally joins a channel)
 * 3. Connects outbound via `client.connectBotGateway(...)` (/ws/bot) to receive `turn.requested`
 * 4. Maintains `channelId:botId -> sessionId` locally and streams results back via SDK
 */
export async function startBotmuxBridge(options: BotmuxBridgeOptions): Promise<{
  stop: () => void;
  agentIds: string[];
}> {
  const sdk = new BubaiClient({ baseUrl: options.serverUrl, token: options.token });
  const botmux = new BotmuxClient(options.botmuxEndpoint, options.botmuxToken);
  const pollMs = options.pollMs ?? 500;
  const sessionBindings = new Map<string, string>();
  let stopped = false;

  const bots: BotmuxBot[] = await botmux.getBots();
  const provisionedAgents: BotGatewayAgentDescriptor[] = [];

  for (const bot of bots) {
    const isUuid =
      options.channelRef &&
      /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(options.channelRef);
    const provisioned = await sdk.provisionAgent({
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
    });

    provisionedAgents.push({
      id: provisioned.agent.id,
      externalId: bot.larkAppId,
      name: bot.botName,
      cliId: bot.cliId,
      workingDir: bot.workingDir,
      capabilities: BOTMUX_CAPABILITIES,
    });
  }

  let gateway: BotGatewayHandle | null = null;

  const handleTurn = async (event: BotTurnRequestedEvent) => {
    const externalBotId = event.externalId || event.botId;
    const bot = bots.find((b) => b.larkAppId === externalBotId);
    const bindingKey = `${event.channel.id}:${externalBotId}`;
    const existingSessionId = sessionBindings.get(bindingKey);

    const attachmentNote =
      event.triggerMessage.attachments.length > 0
        ? `\n\n[附件]\n${event.triggerMessage.attachments.map((a) => `- ${a.name} (${a.mimeType}, ${a.url})`).join('\n')}`
        : '';

    const triggered = await botmux
      .triggerTurn({
        botId: externalBotId,
        cliId: bot?.cliId,
        sessionId: existingSessionId,
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

    const sessionId =
      'target' in triggered ? triggered.target?.sessionId || existingSessionId : existingSessionId;
    const triggerId = 'triggerId' in triggered ? triggered.triggerId : undefined;

    if (!triggered.ok || !sessionId || !triggerId) {
      const errMsg = triggered.error || 'Botmux dispatch failed';
      if (!gateway?.sendTurnComplete({
        botId: event.botId,
        messageId: event.replyTarget.messageId,
        content: errMsg,
        status: 'failed',
      })) {
        await sdk.updateBotMessage(event.replyTarget.messageId, { content: errMsg, status: 'failed' });
      }
      return;
    }

    sessionBindings.set(bindingKey, sessionId);

    // Poll Botmux trigger result until completed/failed/interrupted
    const deadline = Date.now() + 30 * 60_000;
    while (!stopped && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const result = await botmux.pollTriggerResult(sessionId, triggerId).catch(() => undefined);
      if (!result) continue;

      if (result.state === 'completed') {
        const content = result.output?.content?.trim() || '（任务已完成，无文本输出）';
        const meta = { adapter: 'bubai-cli-botmux', sessionId, triggerId };
        if (
          !gateway?.sendTurnComplete({
            botId: event.botId,
            messageId: event.replyTarget.messageId,
            content,
            status: 'completed',
            adapterMeta: meta,
          })
        ) {
          await sdk.sendBotMessage({
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
          !gateway?.sendTurnComplete({
            botId: event.botId,
            messageId: event.replyTarget.messageId,
            content: errText,
            status: result.state,
            adapterMeta: meta,
          })
        ) {
          await sdk.updateBotMessage(event.replyTarget.messageId, {
            content: errText,
            status: result.state,
            adapterMeta: meta,
          });
        }
        return;
      }
    }
  };

  gateway = sdk.connectBotGateway({
    agents: provisionedAgents,
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
      void handleTurn(event);
    },
    onAskAnswered: (answer) => {
      void botmux.answerAsk(answer);
    },
  });

  return {
    agentIds: provisionedAgents.map((a) => a.id),
    stop: () => {
      stopped = true;
      gateway?.close();
    },
  };
}
