import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import type { TriggerRequest, TriggerResponse } from './trigger-types.js';

export * from './trigger-types.js';
export * from './progress/index.js';
export * from './connector.js';

const execFileAsync = promisify(execFile);

export interface BotmuxBot {
  larkAppId: string;
  botName: string;
  cliId: string;
  online: boolean;
  workingDir: string | null;
}

export interface BuzzTurnContext {
  channel: { id?: string; name: string; kind: string; topic: string; replyMode?: string };
  threadId?: string;
  outboundApi?: {
    endpoint: string;
    cliScriptPath?: string;
    botId: string;
    channelId: string;
    threadId?: string;
    placeholderMessageId?: string;
  };
  messages: Array<{
    sender: string;
    role: 'human' | 'agent';
    content: string;
  }>;
}

/** CLIs whose Botmux headless trigger relies on explicit outbound delivery rather than auto-final capture. */
const EXPLICIT_OUTBOUND_CLIS = new Set(['antigravity']);

export interface BotmuxSession {
  sessionId: string;
  larkAppId?: string;
  botName?: string;
  cliId?: string;
  state?: string;
  status?: string;
  backendType?: string;
  queued?: boolean;
  tuiPromptActive?: boolean;
  title?: string;
  workingDir?: string;
  createdAt?: string | number;
}

export interface BotmuxOwnerProfile {
  ok: boolean;
  name?: string;
  avatarUrl?: string;
}

export interface BotmuxHealthStatus {
  endpoint: string;
  connected: boolean;
  authenticated: boolean;
  checkedAt: number;
  detail: string;
}

export interface BotmuxPendingAskOption {
  key: string;
  label: string;
  description?: string;
}

export interface BotmuxPendingAskQuestion {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: BotmuxPendingAskOption[];
}

export interface BotmuxPendingAsk {
  askId: string;
  sessionId?: string;
  larkAppId: string;
  botName?: string;
  title?: string;
  prompt?: string;
  questions?: BotmuxPendingAskQuestion[];
  createdAt?: string | number;
}

/** Contract from references/botmux/src/dashboard/desktop-asks.ts */
export interface DashboardAskAnswerRequest {
  askId: string;
  larkAppId: string;
  selections: string[][];
  by?: string;
}

export class BotmuxClient {
  private readonly endpoint: string;
  private readonly cliPath: string;
  private token?: string;
  private cookie?: string;

  constructor(endpoint: string, token?: string, cliPath?: string) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.token = token;
    this.cliPath =
      cliPath ||
      process.env.BOTMUX_CLI_PATH ||
      '/Users/bytedance/Projects/github/botmux/dist/cli.js';
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  private async resolveTokenFromCli(): Promise<string | undefined> {
    try {
      let stdout = '';
      if (fs.existsSync(this.cliPath)) {
        const res = await execFileAsync('node', [this.cliPath, 'dashboard', 'current'], {
          timeout: 5000,
        });
        stdout = res.stdout;
      } else {
        const res = await execFileAsync('botmux', ['dashboard', 'current'], { timeout: 5000 });
        stdout = res.stdout;
      }
      const firstLine = stdout.split(/\r?\n/)[0] || '';
      const match = firstLine.match(/[?&]t=([^&\s]+)/);
      return match?.[1];
    } catch (err) {
      console.warn('[BotmuxClient] CLI token resolution failed:', err);
      return undefined;
    }
  }

  async ensureAuthenticated(forceRefresh = false): Promise<boolean> {
    if (this.cookie && !forceRefresh) return true;
    if (!this.token || forceRefresh) {
      const cliToken = await this.resolveTokenFromCli();
      if (cliToken) this.token = cliToken;
    }
    if (!this.token) return false;

    try {
      const res = await fetch(`${this.endpoint}/?t=${encodeURIComponent(this.token)}`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        this.cookie = setCookie.split(';')[0];
        return true;
      }
      return res.ok;
    } catch {
      return false;
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    await this.ensureAuthenticated(false);

    const headers = (): Record<string, string> => ({
      Origin: this.endpoint,
      ...(init.headers as Record<string, string> | undefined),
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    });

    const targetUrl =
      !this.cookie && this.token
        ? `${this.endpoint}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(this.token)}`
        : `${this.endpoint}${path}`;

    let res = await fetch(targetUrl, {
      ...init,
      headers: headers(),
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });

    if (res.status === 401) {
      const ok = await this.ensureAuthenticated(true);
      if (ok) {
        res = await fetch(`${this.endpoint}${path}`, {
          ...init,
          headers: headers(),
          signal: init.signal ?? AbortSignal.timeout(10_000),
        });
      }
    }
    return res;
  }

  async checkHealth(): Promise<BotmuxHealthStatus> {
    const checkedAt = Date.now();
    try {
      const res = await this.request('/api/bots');
      if (res.ok) {
        const data = (await res.json()) as { bots?: BotmuxBot[] };
        return {
          endpoint: this.endpoint,
          connected: true,
          authenticated: true,
          checkedAt,
          detail: `Authenticated (${data.bots?.length ?? 0} bots)`,
        };
      }
      return {
        endpoint: this.endpoint,
        connected: true,
        authenticated: false,
        checkedAt,
        detail: `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        endpoint: this.endpoint,
        connected: false,
        authenticated: false,
        checkedAt,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getOwnerProfile(): Promise<BotmuxOwnerProfile | null> {
    try {
      const res = await this.request('/api/owner-profile');
      if (!res.ok) return null;
      return (await res.json()) as BotmuxOwnerProfile;
    } catch {
      return null;
    }
  }

  async getBots(): Promise<BotmuxBot[]> {
    try {
      const res = await this.request('/api/bots');
      if (!res.ok) return [];
      const data = (await res.json()) as { bots?: Partial<BotmuxBot>[] };
      return (data.bots || [])
        .filter((b): b is Partial<BotmuxBot> & { larkAppId: string } => Boolean(b.larkAppId))
        .map((b) => ({
          larkAppId: b.larkAppId,
          botName: b.botName || b.larkAppId,
          cliId: b.cliId || 'cli',
          online: Boolean(b.online),
          workingDir: b.workingDir ?? null,
        }));
    } catch {
      return [];
    }
  }

  async getSessions(): Promise<BotmuxSession[]> {
    try {
      const res = await this.request('/api/sessions');
      if (!res.ok) return [];
      const data = (await res.json()) as { sessions?: BotmuxSession[] };
      return (data.sessions || []).map((s) => ({
        ...s,
        state: s.state || s.status,
      }));
    } catch {
      return [];
    }
  }

  async getSessionWriteLink(sessionId: string): Promise<string | null> {
    try {
      const res = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/write-link`);
      if (!res.ok) return null;
      const data = (await res.json()) as { url?: string; writeUrl?: string; link?: string };
      return data.url || data.writeUrl || data.link || null;
    } catch {
      return null;
    }
  }

  /** POST /api/sessions/:sid/(restart|close|resume) — matches references/botmux/src/dashboard.ts:6510 */
  async sessionAction(
    sessionId: string,
    op: 'restart' | 'close' | 'resume'
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    try {
      const res = await this.request(
        `/api/sessions/${encodeURIComponent(sessionId)}/${op}`,
        { method: 'POST' }
      );
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // raw text
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      return {
        ok: false,
        status: 503,
        body: { ok: false, error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /** GET /api/sessions/:sid/history — matches references/botmux/src/dashboard.ts:6599 */
  async getSessionHistory(sessionId: string): Promise<{ ok: boolean; status: number; body: unknown }> {
    try {
      const res = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/history`);
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // raw text
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      return {
        ok: false,
        status: 503,
        body: { ok: false, error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /** GET /api/asks/pending — real CLI approval/ask hooks from Botmux daemons */
  async getPendingAsks(): Promise<BotmuxPendingAsk[]> {
    try {
      const res = await this.request('/api/asks/pending');
      if (!res.ok) return [];
      const data = (await res.json()) as { asks?: BotmuxPendingAsk[] };
      return data.asks || [];
    } catch {
      return [];
    }
  }

  /** POST /api/asks/answer — submit real approval/ask selection back to Botmux daemon */
  async answerAsk(req: DashboardAskAnswerRequest): Promise<{ ok: boolean; status: number; body: unknown }> {
    try {
      const res = await this.request('/api/asks/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // raw text
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      return {
        ok: false,
        status: 503,
        body: { ok: false, error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /** GET /events — subscribe to Botmux real-time SSE stream with auto-reconnect */
  subscribeEvents(onEvent: (eventName: string, data: unknown) => void): () => void {
    let stopped = false;
    let controller: AbortController | null = null;

    const loop = async () => {
      while (!stopped) {
        try {
          await this.ensureAuthenticated(false);
          controller = new AbortController();
          const headers: Record<string, string> = {
            Accept: 'text/event-stream',
            Origin: this.endpoint,
            ...(this.cookie ? { Cookie: this.cookie } : {}),
          };
          const url =
            !this.cookie && this.token
              ? `${this.endpoint}/events?t=${encodeURIComponent(this.token)}`
              : `${this.endpoint}/events`;
          const res = await fetch(url, { headers, signal: controller.signal });
          if (res.status === 401) {
            await this.ensureAuthenticated(true);
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          if (!res.ok || !res.body) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let eventName = 'message';
          let dataLines: string[] = [];

          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (line === '') {
                if (dataLines.length > 0) {
                  const rawData = dataLines.join('\n');
                  let parsed: unknown = rawData;
                  try {
                    parsed = JSON.parse(rawData);
                  } catch {
                    // keep string
                  }
                  onEvent(eventName, parsed);
                }
                eventName = 'message';
                dataLines = [];
              } else if (line.startsWith('event:')) {
                eventName = line.slice(6).trim() || 'message';
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trim());
              }
            }
          }
        } catch {
          if (stopped) break;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };

    void loop();
    return () => {
      stopped = true;
      controller?.abort();
    };
  }

  async triggerTurn(params: {
    botId: string;
    cliId?: string;
    sessionId?: string;
    prompt: string;
    senderName: string;
    systemPrompt?: string;
    context?: BuzzTurnContext;
  }): Promise<TriggerResponse> {
    const trimmedSystemPrompt = params.systemPrompt?.trim();
    const outbound = params.context?.outboundApi;
    const requiresExplicitOutbound = Boolean(
      outbound && params.cliId && EXPLICIT_OUTBOUND_CLIS.has(params.cliId.toLowerCase()),
    );
    const threadArg = outbound?.threadId ? ` --thread "${outbound.threadId}"` : '';
    const msgIdArg = outbound?.placeholderMessageId
      ? ` --message-id "${outbound.placeholderMessageId}"`
      : '';

    const deliveryLines = requiresExplicitOutbound && outbound
      ? [
          outbound.cliScriptPath
            ? `完成本轮回复后，请务必执行以下命令将最终答复发回 Buzz 对话（执行后会自动结束本轮「执行中」状态）：\nnode ${outbound.cliScriptPath} --bot "${outbound.botId}" --channel "${outbound.channelId}"${threadArg}${msgIdArg} --text "<最终答复>"\n也可直接 POST ${outbound.endpoint}（JSON 字段：botId、channelId、content、threadId、messageId）。`
            : `完成本轮回复后，请务必调用 POST ${outbound.endpoint} 将最终答复发回 Buzz 对话，JSON 参数为 { "botId": "${outbound.botId}", "channelId": "${outbound.channelId}", "content": "<最终答复>", "threadId": ${outbound.threadId ? JSON.stringify(outbound.threadId) : 'null'}, "messageId": ${outbound.placeholderMessageId ? JSON.stringify(outbound.placeholderMessageId) : 'null'} }。`,
        ]
      : [
          'Buzz 会把你的最终回复写回当前对话。',
          ...(outbound
            ? [
                outbound.cliScriptPath
                  ? `如需显式向频道主对话流或指定 Thread 发送消息，可执行：node ${outbound.cliScriptPath} --bot "${outbound.botId}" --channel "${outbound.channelId}"${threadArg}${msgIdArg} --text "<内容>"（不传 --thread 即发往主对话流；传 --thread "<rootMessageId>" 发往指定 Thread）；也可直接 POST ${outbound.endpoint}。`
                  : `如需显式向频道主对话流或指定 Thread 发送消息，可调用 POST ${outbound.endpoint}，JSON 参数为 { "botId": "${outbound.botId}", "channelId": "${outbound.channelId}", "content": "...", "threadId": null }。`,
              ]
            : []),
        ];

    const body: TriggerRequest = {
      source: {
        type: 'headless',
        connectorId: 'buzz-botmux',
        requestId: `buzz_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      },
      target: {
        kind: 'turn',
        botId: params.botId,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      },
      envelope: {
        format: params.context ? 'json' : 'text',
        sourceName: `buzz:${params.senderName}`,
        trusted: false,
        ...(params.context
          ? { payload: { message: params.prompt, conversation: params.context } }
          : { rawText: params.prompt }),
      },
      instruction: [
        ...(trimmedSystemPrompt
          ? [`[Agent System Prompt]\n${trimmedSystemPrompt}`]
          : []),
        ...deliveryLines,
        ...(params.context
          ? [
              '会话历史仅供理解上下文，请根据下面的最新消息回复。',
              '如果最新消息只是在呼叫你，同一人紧接在前面有尚未得到回复的提问，请接着回答。',
            ]
          : []),
        `用户 ${params.senderName} 发送了消息：\n${params.prompt}`,
      ].join('\n'),
      options: {
        asyncReturnSessionId: true,
      },
    };

    const res = await this.request('/api/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return (await res.json()) as TriggerResponse;
  }

  async pollTriggerResult(sessionId: string, triggerId?: string): Promise<TriggerResponse> {
    const query = triggerId ? `?triggerId=${encodeURIComponent(triggerId)}` : '';
    const res = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/trigger-result${query}`
    );
    if (!res.ok && res.status !== 400 && res.status !== 404) {
      throw new Error(`Botmux result lookup returned HTTP ${res.status}`);
    }

    const result = (await res.json()) as TriggerResponse;
    if (res.status === 404 && result.error === 'unknown_session') {
      return { ...result, state: 'not_found' };
    }
    if (res.status === 400 && result.errorCode === 'bad_request') {
      return { ...result, state: 'failed' };
    }
    if (!res.ok || !result.state || (result.triggerId && result.triggerId !== triggerId)) {
      throw new Error('Unexpected Botmux result lookup response');
    }
    return result;
  }
}
