import { BotmuxClient, type BotmuxBot, type BuzzTurnContext } from './index.js';

export interface BotmuxConnectorOptions {
  /** BubAI server base URL, e.g. http://127.0.0.1:4000 or https://bubai.example.com */
  bubaiUrl: string;
  /** Bot server API key (`bot-server_...`) or `BUZZ_BOT_TOKEN` */
  botToken?: string;
  /** Local Botmux daemon endpoint, default http://127.0.0.1:7891 */
  botmuxEndpoint?: string;
  /** Optional Botmux daemon auth token */
  botmuxToken?: string;
  /** Reconnect interval in ms (default 3000) */
  reconnectMs?: number;
  /** Poll interval for Botmux turn completion in ms (default 2000) */
  pollMs?: number;
}

interface IncomingTurnRequested {
  eventId: string;
  type: 'turn.requested';
  botId: string;
  externalId?: string | null;
  turnId: string;
  channel: {
    id: string;
    name: string;
    kind: string;
    topic: string;
    replyMode: string;
  };
  threadId?: string;
  triggerMessage: {
    id: string;
    senderId: string;
    senderName: string;
    content: string;
    attachments: Array<{ name: string; mimeType: string; url: string }>;
  };
  replyTarget: {
    channelId: string;
    threadId?: string;
    messageId: string;
  };
  systemPrompt?: string;
  history: BuzzTurnContext['messages'];
  outboundApi: {
    endpoint: string;
    progressEndpoint: string;
    cliScriptPath?: string;
    botId: string;
    channelId: string;
    threadId?: string;
    placeholderMessageId: string;
  };
}

/**
 * Outbound Botmux Connector for BubAI's `/ws/bot` Gateway (Socket Mode).
 * Connects from any local/remote machine running Botmux to BubAI without requiring BubAI
 * to have network access to Botmux. Maintains `channelId:botId -> sessionId` mapping locally.
 */
export class BotmuxBubaiConnector {
  private readonly bubaiHttpUrl: string;
  private readonly bubaiWsUrl: string;
  private readonly botToken?: string;
  private readonly botmux: BotmuxClient;
  private readonly reconnectMs: number;
  private readonly pollMs: number;
  private readonly sessionBindings = new Map<string, string>();
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cachedBots: BotmuxBot[] = [];

  constructor(options: BotmuxConnectorOptions) {
    this.bubaiHttpUrl = options.bubaiUrl.replace(/\/+$/, '');
    const wsBase = this.bubaiHttpUrl.replace(/^http/i, 'ws');
    const tokenParam = options.botToken ? `?token=${encodeURIComponent(options.botToken)}` : '';
    this.bubaiWsUrl = `${wsBase}/ws/bot${tokenParam}`;
    this.botToken = options.botToken;
    this.botmux = new BotmuxClient(
      options.botmuxEndpoint || process.env.BOTMUX_ENDPOINT || 'http://127.0.0.1:7891',
      options.botmuxToken || process.env.BOTMUX_TOKEN,
    );
    this.reconnectMs = options.reconnectMs ?? 3000;
    this.pollMs = options.pollMs ?? 2000;
  }

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async connect() {
    if (this.stopped) return;
    this.cachedBots = await this.botmux.getBots().catch(() => []);

    const ws = new WebSocket(this.bubaiWsUrl);
    this.ws = ws;

    ws.addEventListener('open', () => {
      console.log(`[BotmuxConnector] Connected to BubAI Gateway (${this.bubaiHttpUrl}), registering ${this.cachedBots.length} bots`);
      ws.send(
        JSON.stringify({
          type: 'bot.hello',
          payload: {
            adapterType: 'gateway',
            agents: this.cachedBots.map((b) => ({
              id: b.larkAppId,
              externalId: b.larkAppId,
              name: b.botName,
              cliId: b.cliId,
              workingDir: b.workingDir,
              capabilities: ['progress_steps', 'interactive_ask', 'terminal_attach', 'session_control'],
            })),
          },
        }),
      );

      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'bot.ping' }));
        }
      }, 25_000);
    });

    ws.addEventListener('message', (evt) => {
      try {
        const msg = JSON.parse(String(evt.data)) as { type?: string; payload?: unknown };
        if (msg.type === 'turn.requested') {
          void this.handleTurnRequested(msg as unknown as IncomingTurnRequested);
        } else if (msg.type === 'ask.answered' && msg.payload) {
          void this.botmux.answerAsk(msg.payload as Parameters<BotmuxClient['answerAsk']>[0]);
        }
      } catch (err) {
        console.error('[BotmuxConnector] Failed to handle gateway frame:', err);
      }
    });

    ws.addEventListener('close', () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (!this.stopped) {
        console.warn(`[BotmuxConnector] Disconnected from BubAI Gateway, reconnecting in ${this.reconnectMs}ms...`);
        this.reconnectTimer = setTimeout(() => void this.connect(), this.reconnectMs);
      }
    });

    ws.addEventListener('error', (err) => {
      console.error('[BotmuxConnector] WebSocket error:', err);
    });
  }

  private async handleTurnRequested(event: IncomingTurnRequested) {
    const botId = event.externalId || event.botId;
    const bot = this.cachedBots.find((b) => b.larkAppId === botId);
    const bindingKey = `${event.channel.id}:${botId}`;
    const existingSessionId = this.sessionBindings.get(bindingKey);

    const attachmentNote =
      event.triggerMessage.attachments.length > 0
        ? `\n\n[附件]\n${event.triggerMessage.attachments.map((a) => `- ${a.name} (${a.mimeType}, ${a.url})`).join('\n')}`
        : '';

    const triggered = await this.botmux
      .triggerTurn({
        botId,
        cliId: bot?.cliId,
        sessionId: existingSessionId,
        prompt: `${event.triggerMessage.content}${attachmentNote}`,
        senderName: event.triggerMessage.senderName,
        systemPrompt: event.systemPrompt,
        context: {
          channel: event.channel,
          ...(event.threadId ? { threadId: event.threadId } : {}),
          outboundApi: {
            endpoint: `${this.bubaiHttpUrl}/api/bot/messages`,
            botId: event.botId,
            channelId: event.replyTarget.channelId,
            ...(event.replyTarget.threadId ? { threadId: event.replyTarget.threadId } : {}),
            placeholderMessageId: event.replyTarget.messageId,
          },
          messages: event.history,
        },
      })
      .catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));

    const sessionId = 'target' in triggered ? triggered.target?.sessionId || existingSessionId : existingSessionId;
    const triggerId = 'triggerId' in triggered ? triggered.triggerId : undefined;

    if (!triggered.ok || !sessionId || !triggerId) {
      this.sendComplete(event.botId, event.replyTarget.messageId, triggered.error || 'Botmux dispatch failed', 'failed');
      return;
    }

    this.sessionBindings.set(bindingKey, sessionId);
    void this.pollUntilSettled(event.botId, event.replyTarget.messageId, sessionId, triggerId);
  }

  private async pollUntilSettled(botId: string, messageId: string, sessionId: string, triggerId: string) {
    const deadline = Date.now() + 30 * 60_000;
    while (!this.stopped && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      const res = await this.botmux.pollTriggerResult(sessionId, triggerId).catch(() => undefined);
      if (!res) continue;
      if (res.state === 'completed') {
        const content = res.output?.content?.trim() || '（任务已完成，无文本输出）';
        this.sendComplete(botId, messageId, content, 'completed', { adapter: 'botmux-connector', sessionId, triggerId });
        return;
      }
      if (res.state === 'failed' || res.state === 'interrupted') {
        this.sendComplete(botId, messageId, res.error || `Botmux turn ${res.state}`, res.state, {
          adapter: 'botmux-connector',
          sessionId,
          triggerId,
        });
        return;
      }
    }
  }

  private sendComplete(
    botId: string,
    messageId: string,
    content: string,
    status: 'completed' | 'failed' | 'interrupted' | 'timeout',
    adapterMeta?: Record<string, unknown>,
  ) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'bot.turn.complete',
          payload: { botId, messageId, content, status, adapterMeta },
        }),
      );
      return;
    }
    // Fallback to HTTP PATCH if WS momentarily dropped
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.botToken) headers.Authorization = `Bearer ${this.botToken}`;
    void fetch(`${this.bubaiHttpUrl}/api/bot/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ content, status, adapterMeta }),
    }).catch(() => {});
  }
}
