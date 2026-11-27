import type {
  ActivityItem,
  AgentDetail,
  AgentProgressSnapshot,
  AgentProvisionInput,
  AgentProvisionResult,
  AgentUpdateInput,
  BootstrapPayload,
  BotGatewayAgentDescriptor,
  BotGatewayHandle,
  BotmuxPendingAskQuestion,
  BotTurnRequestedEvent,
  Channel,
  ChannelMemberRow,
  ChatMessage,
  InstanceInfo,
  MessageAttachment,
  MessageCardStatus,
  Participant,
  ServerWsEvent,
  ThreadPayload,
  WsConnectionState,
} from './types';

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Server URL is required');
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withScheme);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function toWebSocketUrl(baseUrl: string, token?: string): string {
  const normalized = normalizeServerUrl(baseUrl);
  const base = `${normalized.replace(/^http/i, 'ws')}/ws`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function toBotGatewayWebSocketUrl(baseUrl: string, token?: string): string {
  const normalized = normalizeServerUrl(baseUrl);
  const base = `${normalized.replace(/^http/i, 'ws')}/ws/bot`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export interface BubaiClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface OutgoingChatMessage {
  messageId: string;
  channelId: string;
  senderId: string;
  content: string;
  threadId?: string;
  replyToId?: string;
  attachments?: MessageAttachment[];
}

export interface WsHandle {
  sendMessage(payload: OutgoingChatMessage): Promise<void>;
  send(payload: Record<string, unknown>): boolean;
  reconnectNow(): void;
  close(): void;
}

interface WsLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export class BubaiClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BubaiClientOptions) {
    this.baseUrl = normalizeServerUrl(options.baseUrl);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    };

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const msg =
        typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return parsed as T;
  }

  registerPush(token: string, platform: 'ios' | 'android'): Promise<{ ok: boolean }> {
    return this.requestJson('/api/push/register', { method: 'POST', body: JSON.stringify({ token, platform }) });
  }

  unregisterPush(token: string): Promise<{ ok: boolean }> {
    return this.requestJson('/api/push/register', { method: 'DELETE', body: JSON.stringify({ token }) });
  }

  getInstance(): Promise<InstanceInfo> {
    return this.requestJson<InstanceInfo>('/api/instance');
  }

  bootstrap(userId: string): Promise<BootstrapPayload> {
    return this.requestJson<BootstrapPayload>(
      `/api/bootstrap?userId=${encodeURIComponent(userId)}`,
    );
  }

  getChannelMessages(
    channelId: string,
    opts?: { before?: number; beforeId?: string; userId?: string; limit?: number },
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean; nextCursor: number | null; nextCursorId?: string }> {
    const params = new URLSearchParams();
    if (opts?.userId) params.set('userId', opts.userId);
    if (opts?.beforeId) params.set('beforeId', opts.beforeId);
    if (opts?.before !== undefined) params.set('before', String(opts.before));
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.requestJson(
      `/api/channels/${encodeURIComponent(channelId)}/messages${qs ? `?${qs}` : ''}`,
    );
  }


  getActivity(userId: string): Promise<{ items: ActivityItem[] }> {
    return this.requestJson(`/api/activity?userId=${encodeURIComponent(userId)}`);
  }

  updateChannelSettings(channelId: string, input: { userId: string; name?: string; topic?: string; replyMode?: string }): Promise<{ channel: Channel }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/settings`, {
      method: 'PATCH', body: JSON.stringify(input),
    });
  }

  archiveChannel(channelId: string, input: { userId: string; archived: boolean }): Promise<{ channel: Channel }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/archive`, {
      method: 'PATCH', body: JSON.stringify(input),
    });
  }

  muteChannel(channelId: string, input: { userId: string; muted: boolean }): Promise<{ muted: boolean }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/mute`, {
      method: 'POST', body: JSON.stringify(input),
    });
  }

  hideChannel(channelId: string, input: { userId: string; hidden: boolean }): Promise<{ hidden: boolean }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/hide`, {
      method: 'POST', body: JSON.stringify(input),
    });
  }

  placeChannel(channelId: string, input: { userId: string; starred?: boolean; groupId?: string | null }): Promise<{ starred: boolean; groupId: string | null }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/placement`, {
      method: 'POST', body: JSON.stringify(input),
    });
  }

  markChannelUnread(channelId: string, input: { userId: string }): Promise<{ markedUnread: boolean }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/unread`, {
      method: 'POST', body: JSON.stringify(input),
    });
  }

  deleteChannel(channelId: string, userId: string): Promise<{ ok: boolean }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  markThreadRead(channelId: string, rootId: string, userId: string): Promise<{ lastReadAt: number }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(rootId)}/read`, {
      method: 'POST', body: JSON.stringify({ userId }),
    });
  }

  createSidebarGroup(name: string, userId: string): Promise<{ group: { id: string; name: string } }> {
    return this.requestJson('/api/sidebar-groups', { method: 'POST', body: JSON.stringify({ userId, name }) });
  }

  renameSidebarGroup(id: string, name: string, userId: string): Promise<{ group: { id: string; name: string } }> {
    return this.requestJson(`/api/sidebar-groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ userId, name }) });
  }

  deleteSidebarGroup(id: string, userId: string): Promise<{ ok: boolean }> {
    return this.requestJson(`/api/sidebar-groups/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  createChannel(input: { name: string; topic?: string; userId?: string }): Promise<{ channel: Channel }> {
    return this.requestJson('/api/channels', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  openDm(input: {
    userId: string;
    targetId: string;
    targetRole: 'human' | 'agent';
    targetName?: string;
  }): Promise<{ channel: Channel }> {
    return this.requestJson('/api/dms', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getAgentDetail(agentId: string, userId: string): Promise<{ agent: AgentDetail }> {
    return this.requestJson(
      `/api/agents/${encodeURIComponent(agentId)}?userId=${encodeURIComponent(userId)}`,
    );
  }

  updateAgent(agentId: string, patch: AgentUpdateInput): Promise<{ agent: AgentDetail }> {
    return this.requestJson(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  answerAsk(input: {
    askId: string;
    larkAppId: string;
    selections: string[][];
    by?: string;
  }): Promise<Record<string, unknown>> {
    return this.requestJson('/api/asks/answer', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  sessionAction(
    sessionId: string,
    op: 'restart' | 'close' | 'resume',
  ): Promise<Record<string, unknown>> {
    return this.requestJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/${op}`,
      { method: 'POST' },
    );
  }

  getTerminalWriteLink(sessionId: string): Promise<{ sessionId: string; url: string | null }> {
    return this.requestJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/write-link`,
    );
  }

  getSessionHistory(sessionId: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/history`,
    );
  }

  getThread(channelId: string, rootMessageId: string): Promise<ThreadPayload> {
    return this.requestJson(
      `/api/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(rootMessageId)}`,
    );
  }

  editMessage(messageId: string, content: string): Promise<{ message: ChatMessage }> {
    return this.requestJson(`/api/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    });
  }

  deleteMessage(messageId: string): Promise<{ ok: boolean }> {
    return this.requestJson(`/api/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
  }

  toggleReaction(
    messageId: string,
    emoji: string,
    userId: string,
  ): Promise<{ messageId: string; reactions: ChatMessage['reactions'] }> {
    return this.requestJson(`/api/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji, userId }),
    });
  }

  getPins(channelId: string): Promise<{ pins: ChatMessage[] }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/pins`);
  }

  pinMessage(channelId: string, messageId: string, userId: string): Promise<{ pins: ChatMessage[] }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/pins`, {
      method: 'POST',
      body: JSON.stringify({ messageId, userId }),
    });
  }

  unpinMessage(channelId: string, messageId: string): Promise<{ pins: ChatMessage[] }> {
    return this.requestJson(
      `/api/channels/${encodeURIComponent(channelId)}/pins/${encodeURIComponent(messageId)}`,
      { method: 'DELETE' },
    );
  }

  markChannelRead(channelId: string, userId: string): Promise<{ ok: boolean }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/read`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  getChannelMembers(channelId: string): Promise<{ members: ChannelMemberRow[]; ownerId?: string }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/members`);
  }

  upsertChannelMember(
    channelId: string,
    payload: { userId?: string; agentId?: string; autoReply?: boolean },
  ): Promise<{ ok: boolean }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/members`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  removeChannelMember(
    channelId: string,
    payload: { userId?: string; agentId?: string },
  ): Promise<{ ok: boolean }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/members`, {
      method: 'DELETE',
      body: JSON.stringify(payload),
    });
  }

  searchMessages(
    query: string,
    userId: string,
  ): Promise<{ results: ChatMessage[]; messages?: ChatMessage[] }> {
    const params = new URLSearchParams({ q: query, userId });
    return this.requestJson(`/api/search?${params.toString()}`);
  }

  async uploadFile(formData: FormData): Promise<MessageAttachment> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
    const res = await this.fetchImpl(`${this.baseUrl}/api/uploads`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!res.ok) {
      throw new Error(`Upload failed (HTTP ${res.status})`);
    }
    const data = (await res.json()) as { attachment?: MessageAttachment };
    if (!data.attachment) throw new Error('Upload response missing attachment');
    return data.attachment;
  }

  connectWebSocket(params: {
    userId: string;
    onEvent: (event: ServerWsEvent) => void;
    onStateChange?: (state: WsConnectionState) => void;
    heartbeatMs?: number;
    WebSocketImpl?: new (url: string) => WsLike;
  }): WsHandle {
    const WS =
      params.WebSocketImpl ??
      (globalThis.WebSocket as unknown as new (url: string) => WsLike);
    const wsUrl = toWebSocketUrl(this.baseUrl, this.token);

    let closed = false;
    let socket: WsLike | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Map<string, (error?: string) => void>();
    const cancelPending = () => {
      for (const finish of pending.values()) finish('连接中断，消息尚未确认');
    };
    let attempt = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const clearTimer = () => {
      cancelPending();
      clearInterval(heartbeat);
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const connect = () => {
      if (closed) return;
      clearTimer();
      params.onStateChange?.(attempt === 0 ? 'connecting' : 'reconnecting');

      const ws = new WS(wsUrl);
      socket = ws;

      let waitingForPong = false;
      ws.onopen = () => {
        if (closed || socket !== ws) return;
        attempt = 0;
        heartbeat = setInterval(() => {
          if (socket !== ws || closed) return;
          if (waitingForPong) return ws.close();
          waitingForPong = true;
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch { ws.close(); }
        }, params.heartbeatMs ?? 25_000);
        params.onStateChange?.('open');
        ws.send(
          JSON.stringify({
            type: 'presence.identify',
            payload: { userId: params.userId },
          }),
        );
      };

      ws.onmessage = (evt) => {
        if (closed || socket !== ws) return;
        try {
          const parsed = JSON.parse(String(evt.data)) as ServerWsEvent;
          if (parsed && typeof parsed.type === 'string') {
            if (parsed.type === 'message.created') pending.get(parsed.payload.id)?.();
            if (parsed.type === 'message.send_failed') pending.get(parsed.payload.messageId)?.(parsed.payload.message);
            if (parsed.type === 'pong') waitingForPong = false;
            params.onEvent(parsed);
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (closed || socket !== ws) return;
        clearTimer();
        socket = null;
        attempt += 1;
        params.onStateChange?.('reconnecting');
        const delayMs = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 15_000);
        reconnectTimer = setTimeout(connect, delayMs);
      };

      ws.onerror = () => {
        // onclose handles reconnect
      };
    };

    connect();

    return {
      sendMessage(payload) {
        return new Promise<void>((resolve, reject) => {
          if (!socket || socket.readyState !== 1) return reject(new Error('尚未连接'));
          if (pending.has(payload.messageId)) return reject(new Error('正在等待发送回执'));
          const finish = (error?: string) => {
            clearTimeout(timer);
            pending.delete(payload.messageId);
            if (error) reject(new Error(error));
            else resolve();
          };
          const timer = setTimeout(() => finish('未收到发送回执，请重试'), 15_000);
          pending.set(payload.messageId, finish);
          try {
            socket.send(JSON.stringify({ type: 'message.send', payload }));
          } catch (error) {
            finish(String(error));
          }
        });
      },
      send(payload) {
        if (!socket || socket.readyState !== 1) return false;
        socket.send(JSON.stringify(payload));
        return true;
      },
      reconnectNow() {
        if (closed) return;
        clearTimer();
        attempt = 0;
        if (socket) {
          const prev = socket;
          socket = null;
          try {
            prev.close();
          } catch {
            // ignore
          }
        }
        connect();
      },
      close() {
        closed = true;
        clearTimer();
        params.onStateChange?.('closed');
        if (socket) {
          const prev = socket;
          socket = null;
          try {
            prev.close();
          } catch {
            // ignore
          }
        }
      },
    };
  }

  // ── Unified Agent & Bot Protocol API (shared by CLI, Web, Native, and Bridges) ──

  listAgents(): Promise<{ agents: Participant[] }> {
    return this.requestJson('/api/agents');
  }

  provisionAgent(input: AgentProvisionInput): Promise<AgentProvisionResult> {
    return this.requestJson('/api/agents/provision', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  addChannelMember(
    channelId: string,
    member: { userId?: string; agentId?: string; autoReply?: boolean },
  ): Promise<{ member: ChannelMemberRow }> {
    return this.requestJson(`/api/channels/${encodeURIComponent(channelId)}/members`, {
      method: 'POST',
      body: JSON.stringify(member),
    });
  }

  registerBotAgents(
    agents: Array<{
      agentId: string;
      adapterType?: 'botmux' | 'gateway' | 'webhook';
      externalId?: string;
      defaultName?: string;
      description?: string;
      cliId?: string;
      workingDir?: string | null;
      capabilities?: string[];
      webhookUrl?: string;
      webhookSecret?: string;
    }>,
  ): Promise<{ ok: boolean; registered: string[] }> {
    return this.requestJson('/api/bot/agents/register', {
      method: 'POST',
      body: JSON.stringify({ agents }),
    });
  }

  sendBotHeartbeat(input: {
    agentId?: string;
    status?: 'online' | 'offline';
    capabilities?: string[];
    ttlMs?: number;
  }): Promise<{ ok: boolean; agentId: string; status: string }> {
    return this.requestJson('/api/bot/heartbeat', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  sendBotMessage(input: {
    botId: string;
    channelId?: string;
    channelName?: string;
    content: string;
    threadId?: string | null;
    replyToId?: string | null;
    messageId?: string | null;
    attachments?: MessageAttachment[];
    adapterMeta?: Record<string, unknown>;
  }): Promise<{ message: ChatMessage; settledPlaceholder?: boolean }> {
    return this.requestJson('/api/bot/messages', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  updateBotMessage(
    messageId: string,
    patch: {
      content?: string;
      status?: MessageCardStatus;
      summary?: string;
      progress?: AgentProgressSnapshot;
      adapterMeta?: Record<string, unknown>;
      attachments?: MessageAttachment[];
    },
  ): Promise<{ ok: boolean; message: ChatMessage }> {
    return this.requestJson(`/api/bot/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  completeBotTurn(
    messageId: string,
    input: {
      content: string;
      status: Exclude<MessageCardStatus, 'running' | 'waiting_approval'>;
      adapterMeta?: Record<string, unknown>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<{ ok: true; settled: boolean; message: ChatMessage }> {
    return this.requestJson(`/api/bot/messages/${encodeURIComponent(messageId)}/complete`, {
      method: 'POST',
      body: JSON.stringify(input),
      signal: options?.signal,
    });
  }

  sendBotProgress(
    messageId: string,
    progress: AgentProgressSnapshot,
  ): Promise<{ ok: boolean; updated: boolean; message: ChatMessage }> {
    return this.requestJson(`/api/bot/messages/${encodeURIComponent(messageId)}/progress`, {
      method: 'POST',
      body: JSON.stringify({ progress }),
    });
  }

  createBotAsk(input: {
    askId?: string;
    agentId?: string;
    botName?: string;
    sessionId?: string;
    title?: string;
    prompt?: string;
    questions?: BotmuxPendingAskQuestion[];
  }): Promise<{ ok: boolean; ask: Record<string, unknown> }> {
    return this.requestJson('/api/bot/asks', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getBotChannelMessages(
    channelId: string,
    opts?: { threadId?: string; limit?: number },
  ): Promise<{ channelId: string; threadId: string | null; messages: ChatMessage[] }> {
    const params = new URLSearchParams();
    if (opts?.threadId) params.set('threadId', opts.threadId);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.requestJson(
      `/api/bot/channels/${encodeURIComponent(channelId)}/messages${qs ? `?${qs}` : ''}`,
    );
  }

  connectBotGateway(params: {
    agents: BotGatewayAgentDescriptor[];
    onWelcome?: (payload: { connectionId: string; agentIds: string[] }) => void;
    onTurnRequested?: (event: BotTurnRequestedEvent) => void;
    onAskAnswered?: (payload: {
      askId: string;
      larkAppId: string;
      selections: string[][];
      by?: string;
    }) => void;
    onStateChange?: (state: WsConnectionState) => void;
    heartbeatMs?: number;
    WebSocketImpl?: new (url: string) => WsLike;
  }): BotGatewayHandle {
    const WS =
      params.WebSocketImpl ??
      (globalThis.WebSocket as unknown as new (url: string) => WsLike);
    const wsUrl = toBotGatewayWebSocketUrl(this.baseUrl, this.token);
    const heartbeatMs = params.heartbeatMs ?? 25_000;
    const responseTimeoutMs = heartbeatMs * 2;

    let closed = false;
    let socket: WsLike | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let healthTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const clearHealthTimer = () => {
      if (healthTimer !== null) {
        clearTimeout(healthTimer);
        healthTimer = null;
      }
    };

    const clearTimers = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearHealthTimer();
    };

    const sendRaw = (payload: Record<string, unknown>): boolean => {
      if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify(payload));
      return true;
    };

    const connect = () => {
      if (closed) return;
      clearTimers();
      params.onStateChange?.(attempt === 0 ? 'connecting' : 'reconnecting');

      const ws = new WS(wsUrl);
      socket = ws;
      let waitingForPong = false;

      const reconnect = () => {
        if (closed || socket !== ws) return;
        socket = null;
        clearTimers();
        try {
          ws.close();
        } catch {
          // Reconnect even if the previous socket cannot close cleanly.
        }
        attempt += 1;
        const delayMs = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 15_000);
        reconnectTimer = setTimeout(connect, delayMs);
        params.onStateChange?.('reconnecting');
      };

      const scheduleHeartbeat = () => {
        clearHealthTimer();
        waitingForPong = false;
        healthTimer = setTimeout(() => {
          waitingForPong = true;
          healthTimer = setTimeout(reconnect, responseTimeoutMs);
          try {
            ws.send(JSON.stringify({ type: 'bot.ping' }));
          } catch {
            reconnect();
          }
        }, heartbeatMs);
      };

      // The transport can open without the gateway completing registration.
      healthTimer = setTimeout(reconnect, responseTimeoutMs);

      ws.onopen = () => {
        if (closed || socket !== ws) return;
        params.onStateChange?.('open');
        if (closed || socket !== ws) return;

        try {
          ws.send(
            JSON.stringify({
              type: 'bot.hello',
              payload: {
                adapterType: 'gateway',
                agents: params.agents,
              },
            }),
          );
        } catch {
          reconnect();
        }
      };

      ws.onmessage = (evt) => {
        if (closed || socket !== ws) return;
        try {
          const parsed = JSON.parse(String(evt.data)) as { type?: string; payload?: unknown };
          if (parsed.type === 'bot.welcome' && parsed.payload) {
            attempt = 0;
            scheduleHeartbeat();
            params.onWelcome?.(parsed.payload as { connectionId: string; agentIds: string[] });
          } else if (parsed.type === 'bot.pong' && waitingForPong) {
            scheduleHeartbeat();
          } else if (parsed.type === 'turn.requested') {
            params.onTurnRequested?.(parsed as unknown as BotTurnRequestedEvent);
          } else if (parsed.type === 'ask.answered' && parsed.payload) {
            params.onAskAnswered?.(
              parsed.payload as {
                askId: string;
                larkAppId: string;
                selections: string[][];
                by?: string;
              },
            );
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = reconnect;

      ws.onerror = () => {
        // onclose handles reconnect
      };
    };

    connect();

    return {
      send: sendRaw,
      sendPresence(agentId, status, capabilities) {
        return sendRaw({
          type: 'bot.presence',
          payload: { agentId, status, ...(capabilities ? { capabilities } : {}) },
        });
      },
      sendTurnProgress(messageId, progress) {
        return sendRaw({
          type: 'bot.turn.progress',
          payload: { messageId, progress },
        });
      },
      sendTurnComplete(payload) {
        return sendRaw({
          type: 'bot.turn.complete',
          payload,
        });
      },
      createAsk(payload) {
        return sendRaw({
          type: 'bot.ask.create',
          payload,
        });
      },
      reconnectNow() {
        if (closed) return;
        clearTimers();
        attempt = 0;
        if (socket) {
          const prev = socket;
          socket = null;
          try {
            prev.close();
          } catch {
            // ignore
          }
        }
        connect();
      },
      close() {
        closed = true;
        clearTimers();
        params.onStateChange?.('closed');
        if (socket) {
          const prev = socket;
          socket = null;
          try {
            prev.close();
          } catch {
            // ignore
          }
        }
      },
    };
  }
}
