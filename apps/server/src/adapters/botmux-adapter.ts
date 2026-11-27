import {
  and,
  botmuxBindings,
  eq,
  isNull,
  messages,
  sql,
  type ChatDb,
} from '@buzz-botmux/db';
import {
  BotmuxClient,
  type BotmuxBot,
  type BotmuxHealthStatus,
  type BotmuxOwnerProfile,
  type BotmuxPendingAsk,
  type BotmuxSession,
  type BuzzTurnContext,
  type DashboardAskAnswerRequest,
  type TriggerResponse,
} from '@buzz-botmux/botmux-client';
import type {
  AgentAdapter,
  AgentRegistrationInput,
  AgentRuntimePresence,
  TurnDispatchRequest,
  TurnDispatchResult,
} from './types';

export const BOTMUX_DEFAULT_CAPABILITIES = [
  'progress_steps',
  'interactive_ask',
  'terminal_attach',
  'session_control',
];

const BUSY_SESSION_STATES = new Set(['running', 'working', 'busy', 'thinking', 'starting']);

export interface BotmuxAdapterOptions {
  db: ChatDb;
  endpoint: string;
  token?: string;
  enabled?: boolean;
}

/**
 * Adapter wrapping local/remote Botmux daemon.
 * Keeps all Botmux-specific session binding, parallel overflow, and client calls isolated
 * behind the common `AgentAdapter` interface.
 */
export class BotmuxAgentAdapter implements AgentAdapter {
  readonly type = 'botmux' as const;
  private readonly db: ChatDb;
  private readonly client: BotmuxClient;
  private readonly enabled: boolean;
  private cachedBots: BotmuxBot[] = [];

  constructor(options: BotmuxAdapterOptions) {
    this.db = options.db;
    this.enabled = options.enabled ?? true;
    this.client = new BotmuxClient(options.endpoint, options.token);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getEndpoint(): string {
    return this.client.getEndpoint();
  }

  getCachedBots(): BotmuxBot[] {
    return this.cachedBots;
  }

  isAgentOnline(agentId: string): boolean {
    if (!this.enabled) return false;
    const bot = this.cachedBots.find((b) => b.larkAppId === agentId);
    return Boolean(bot?.online);
  }

  getAgentPresence(agentId: string): AgentRuntimePresence | null {
    if (!this.enabled) return null;
    const bot = this.cachedBots.find((b) => b.larkAppId === agentId);
    if (!bot) return null;
    return {
      online: Boolean(bot.online),
      adapterType: 'botmux',
      capabilities: BOTMUX_DEFAULT_CAPABILITIES,
      cliId: bot.cliId,
      workingDir: bot.workingDir,
      defaultName: bot.botName,
    };
  }

  async syncBots(): Promise<{ owner: BotmuxOwnerProfile | null; registrations: AgentRegistrationInput[] }> {
    if (!this.enabled) {
      this.cachedBots = [];
      return { owner: null, registrations: [] };
    }
    const [owner, bots] = await Promise.all([
      this.client.getOwnerProfile().catch(() => null),
      this.client.getBots().catch(() => [] as BotmuxBot[]),
    ]);
    this.cachedBots = bots;
    const registrations: AgentRegistrationInput[] = bots.map((b) => ({
      agentId: b.larkAppId,
      adapterType: 'botmux',
      externalId: b.larkAppId,
      defaultName: b.botName,
      cliId: b.cliId,
      workingDir: b.workingDir,
      capabilities: BOTMUX_DEFAULT_CAPABILITIES,
    }));
    return { owner, registrations };
  }

  async refreshBots(): Promise<AgentRegistrationInput[]> {
    const { registrations } = await this.syncBots();
    return registrations;
  }

  async checkHealth(): Promise<BotmuxHealthStatus> {
    if (!this.enabled) {
      return {
        endpoint: this.client.getEndpoint(),
        connected: false,
        authenticated: false,
        checkedAt: Date.now(),
        detail: 'Botmux direct adapter disabled (BOTMUX_DISABLED=true)',
      };
    }
    return this.client.checkHealth();
  }

  async getSessions(): Promise<BotmuxSession[]> {
    if (!this.enabled) return [];
    return this.client.getSessions().catch(() => []);
  }

  async getPendingAsks(): Promise<BotmuxPendingAsk[]> {
    if (!this.enabled) return [];
    return this.client.getPendingAsks().catch(() => []);
  }

  async answerAsk(req: DashboardAskAnswerRequest) {
    if (!this.enabled) {
      return { ok: false, status: 503, body: { ok: false, error: 'Botmux adapter is disabled' } };
    }
    return this.client.answerAsk(req);
  }

  async sessionAction(sessionId: string, op: 'restart' | 'close' | 'resume') {
    if (!this.enabled) {
      return { ok: false, status: 503, body: { ok: false, error: 'Botmux adapter is disabled' } };
    }
    return this.client.sessionAction(sessionId, op);
  }

  async getSessionHistory(sessionId: string) {
    if (!this.enabled) {
      return { ok: false, status: 503, body: { ok: false, error: 'Botmux adapter is disabled' } };
    }
    return this.client.getSessionHistory(sessionId);
  }

  async getSessionWriteLink(sessionId: string): Promise<string | null> {
    if (!this.enabled) return null;
    return this.client.getSessionWriteLink(sessionId);
  }

  async pollTriggerResult(sessionId: string, triggerId: string) {
    if (!this.enabled) return undefined;
    return this.client.pollTriggerResult(sessionId, triggerId);
  }

  subscribeEvents(onEvent: (eventName: string, data: unknown) => void) {
    if (!this.enabled) return () => {};
    return this.client.subscribeEvents(onEvent);
  }

  async dispatchTurn(req: TurnDispatchRequest): Promise<TurnDispatchResult> {
    if (!this.enabled) {
      return {
        ok: false,
        adapterType: 'botmux',
        error: 'Botmux adapter is disabled',
      };
    }

    const botId = req.agent.externalId || req.agent.id;
    const liveSessions = await this.getSessions();
    const liveSessionById = new Map(liveSessions.map((s) => [s.sessionId, s]));

    const [binding] = await this.db
      .select()
      .from(botmuxBindings)
      .where(and(eq(botmuxBindings.channelId, req.channel.id), eq(botmuxBindings.botId, botId)));

    let existingSessionId: string | undefined = binding?.sessionId;
    let isOverflowParallel = false;

    if (existingSessionId) {
      const [runningOnSession] = await this.db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.botmuxSessionId, existingSessionId),
            isNull(messages.deletedAt),
            sql`${messages.card}->>'status' = 'running'`,
          ),
        )
        .limit(1);

      const liveSession = liveSessionById.get(existingSessionId);
      const liveState = (liveSession?.state || liveSession?.status || '').toLowerCase();
      const sessionBusy =
        Boolean(runningOnSession) ||
        Boolean(liveSession?.queued) ||
        BUSY_SESSION_STATES.has(liveState);

      if (sessionBusy) {
        existingSessionId = undefined;
        isOverflowParallel = true;
      }
    }

    const turnContext: BuzzTurnContext = {
      channel: req.channel,
      ...(req.threadId ? { threadId: req.threadId } : {}),
      outboundApi: {
        endpoint: req.outboundApi.endpoint,
        cliScriptPath: req.outboundApi.cliScriptPath,
        botId: req.agent.id,
        channelId: req.channel.id,
        ...(req.replyThreadId ? { threadId: req.replyThreadId } : {}),
        placeholderMessageId: req.turnId,
      },
      messages: req.history,
    };

    const triggerTurn = (sessionId?: string) =>
      this.client
        .triggerTurn({
          botId,
          cliId: req.agent.cliId,
          sessionId,
          prompt: req.promptWithAttachments,
          senderName: req.triggerMessage.senderName,
          systemPrompt: req.agent.systemPrompt || undefined,
          context: turnContext,
        })
        .catch(
          (err: unknown): TriggerResponse => ({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );

    let triggered = await triggerTurn(existingSessionId);
    if (existingSessionId && !triggered.ok && triggered.errorCode === 'session_not_found') {
      existingSessionId = undefined;
      triggered = await triggerTurn();
    }

    const sessionId = triggered.target?.sessionId || existingSessionId;
    if (!triggered.ok || !sessionId || !triggered.triggerId) {
      return {
        ok: false,
        adapterType: 'botmux',
        parallel: isOverflowParallel,
        error: triggered.error || 'Botmux 未返回本轮派发信息',
      };
    }

    if (!isOverflowParallel) {
      await this.db
        .insert(botmuxBindings)
        .values({ channelId: req.channel.id, botId, sessionId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [botmuxBindings.channelId, botmuxBindings.botId],
          set: { sessionId, updatedAt: new Date() },
        });
    }

    return {
      ok: true,
      adapterType: 'botmux',
      sessionId,
      triggerId: triggered.triggerId,
      parallel: isOverflowParallel,
      adapterMeta: {
        adapter: 'botmux',
        sessionId,
        triggerId: triggered.triggerId,
        ...(isOverflowParallel ? { parallel: true } : {}),
      },
    };
  }
}
