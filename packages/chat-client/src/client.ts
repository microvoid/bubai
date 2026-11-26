import type {
  AgentDetail,
  AgentUpdateInput,
  BootstrapPayload,
  Channel,
  ChannelMemberRow,
  ChatMessage,
  InstanceInfo,
  MessageAttachment,
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

export function toWebSocketUrl(baseUrl: string): string {
  const normalized = normalizeServerUrl(baseUrl);
  return `${normalized.replace(/^http/i, 'ws')}/ws`;
}

export interface BubaiClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface WsHandle {
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
      throw new Error(msg);
    }
    return parsed as T;
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
    opts?: { before?: number; limit?: number },
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean; nextCursor: number | null }> {
    const params = new URLSearchParams();
    if (opts?.before !== undefined) params.set('before', String(opts.before));
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.requestJson(
      `/api/channels/${encodeURIComponent(channelId)}/messages${qs ? `?${qs}` : ''}`,
    );
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
    WebSocketImpl?: new (url: string) => WsLike;
  }): WsHandle {
    const WS =
      params.WebSocketImpl ??
      (globalThis.WebSocket as unknown as new (url: string) => WsLike);
    const wsUrl = toWebSocketUrl(this.baseUrl);

    let closed = false;
    let socket: WsLike | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const clearTimer = () => {
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

      ws.onopen = () => {
        if (closed || socket !== ws) return;
        attempt = 0;
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
            params.onEvent(parsed);
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (closed || socket !== ws) return;
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
}
