import { agentProfiles, asc, eq, type ChatDb } from '@buzz-botmux/db';
import type {
  BotmuxHealthStatus,
  BotmuxPendingAsk,
  BotmuxSession,
  DashboardAskAnswerRequest,
} from '@buzz-botmux/botmux-client';
import type {
  AgentAdapterType,
  AgentRegistrationInput,
  ResolvedAgent,
  TurnDispatchRequest,
  TurnDispatchResult,
} from './types';
import { BotmuxAgentAdapter } from './botmux-adapter';
import { BotGatewayAdapter } from './gateway-adapter';
import { WebhookAgentAdapter } from './webhook-adapter';

export interface AgentDispatcherOptions {
  db: ChatDb;
  botmux: BotmuxAgentAdapter;
  gateway: BotGatewayAdapter;
  webhook: WebhookAgentAdapter;
}

/**
 * Central Agent Registry + Multi-Adapter Dispatcher.
 * - DB (`agent_profiles`) is the Single Source of Truth for known agents.
 * - Live adapters (`gateway`, `webhook`, `botmux`) only contribute real-time presence & dispatch.
 * - When an adapter disconnects, agents remain visible in BubAI with `online: false`.
 */
export class AgentDispatcher {
  readonly db: ChatDb;
  readonly botmux: BotmuxAgentAdapter;
  readonly gateway: BotGatewayAdapter;
  readonly webhook: WebhookAgentAdapter;
  private readonly httpHeartbeats = new Map<string, { expiresAt: number; capabilities?: string[] }>();

  constructor(options: AgentDispatcherOptions) {
    this.db = options.db;
    this.botmux = options.botmux;
    this.gateway = options.gateway;
    this.webhook = options.webhook;
  }

  /** Upsert discovered/registered agents into `agent_profiles`, preserving user overrides. */
  async upsertAgents(inputs: AgentRegistrationInput[]): Promise<void> {
    if (inputs.length === 0) return;
    const now = new Date();
    for (const input of inputs) {
      const agentId = input.agentId?.trim();
      if (!agentId) continue;

      const [existing] = await this.db
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, agentId))
        .limit(1);

      const adapterType = input.adapterType ?? (existing?.adapterType as AgentAdapterType | undefined) ?? 'botmux';
      const organizationId =
        input.organizationId !== undefined ? input.organizationId : (existing?.organizationId ?? null);
      const ownerUserId =
        input.ownerUserId !== undefined ? input.ownerUserId : (existing?.ownerUserId ?? null);
      const externalId = input.externalId !== undefined ? input.externalId : (existing?.externalId ?? agentId);
      const defaultName = input.defaultName?.trim() || existing?.defaultName || agentId;
      const displayName =
        input.displayName !== undefined ? input.displayName?.trim() || null : (existing?.displayName ?? null);
      const description =
        input.description !== undefined
          ? input.description?.trim().slice(0, 280) || null
          : (existing?.description ?? null);
      const systemPrompt =
        input.systemPrompt !== undefined ? input.systemPrompt : (existing?.systemPrompt ?? null);
      const avatarUrl =
        input.avatarUrl !== undefined ? input.avatarUrl?.trim() || null : (existing?.avatarUrl ?? null);
      const cliId = input.cliId !== undefined ? input.cliId : (existing?.cliId ?? null);
      const workingDir = input.workingDir !== undefined ? input.workingDir : (existing?.workingDir ?? null);
      const capabilities =
        input.capabilities !== undefined ? input.capabilities : (existing?.capabilities ?? null);
      const webhookUrl =
        input.webhookUrl !== undefined ? input.webhookUrl?.trim() || null : (existing?.webhookUrl ?? null);
      const webhookSecret =
        input.webhookSecret !== undefined ? input.webhookSecret : (existing?.webhookSecret ?? null);

      await this.db
        .insert(agentProfiles)
        .values({
          agentId,
          organizationId,
          ownerUserId,
          adapterType,
          externalId,
          defaultName,
          displayName,
          description,
          systemPrompt,
          avatarUrl,
          cliId,
          workingDir,
          capabilities,
          webhookUrl,
          webhookSecret,
          archived: existing?.archived ?? false,
          lastSeenAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: agentProfiles.agentId,
          set: {
            organizationId,
            ownerUserId,
            adapterType,
            externalId,
            defaultName,
            displayName,
            description,
            systemPrompt,
            avatarUrl,
            cliId,
            workingDir,
            capabilities,
            webhookUrl,
            webhookSecret,
            lastSeenAt: now,
            updatedAt: now,
          },
        });

      if (webhookUrl) {
        this.webhook.registerWebhookAgent(agentId, webhookUrl, capabilities ?? undefined);
      }
    }
  }

  /** Record an HTTP heartbeat from an external bot/adapter (valid for ttlMs, default 90s). */
  async recordHeartbeat(
    agentId: string,
    opts?: { status?: 'online' | 'offline'; capabilities?: string[]; ttlMs?: number },
  ): Promise<void> {
    if (opts?.status === 'offline') {
      this.httpHeartbeats.delete(agentId);
      return;
    }
    const ttlMs = Math.min(Math.max(opts?.ttlMs ?? 90_000, 10_000), 600_000);
    this.httpHeartbeats.set(agentId, {
      expiresAt: Date.now() + ttlMs,
      capabilities: opts?.capabilities,
    });
    const now = new Date();
    await this.db
      .update(agentProfiles)
      .set({
        lastSeenAt: now,
        ...(opts?.capabilities ? { capabilities: opts.capabilities } : {}),
        updatedAt: now,
      })
      .where(eq(agentProfiles.agentId, agentId));
  }

  /** Sync bots from Botmux adapter (when enabled) and persist them into `agent_profiles`. */
  async syncBotmuxAgents() {
    const { owner, registrations } = await this.botmux.syncBots();
    if (registrations.length > 0) {
      await this.upsertAgents(registrations);
    }
    return { owner, count: registrations.length };
  }

  /**
   * List all known agents from DB merged with live adapter presence.
   * Offline agents are preserved with `online: false` instead of vanishing.
   */
  async listAgents(): Promise<ResolvedAgent[]> {
    const rows = await this.db
      .select()
      .from(agentProfiles)
      .orderBy(asc(agentProfiles.createdAt));

    const now = Date.now();
    const resolved: ResolvedAgent[] = [];

    for (const row of rows) {
      // Keep webhook adapter registry hydrated after server restarts
      if (row.webhookUrl && !this.webhook.isAgentOnline(row.agentId)) {
        this.webhook.registerWebhookAgent(row.agentId, row.webhookUrl, row.capabilities ?? undefined);
      }

      const gatewayPresence = this.gateway.getAgentPresence(row.agentId);
      const botmuxPresence = this.botmux.getAgentPresence(row.agentId);
      const webhookPresence = row.webhookUrl ? this.webhook.getAgentPresence(row.agentId) : null;
      const heartbeat = this.httpHeartbeats.get(row.agentId);
      const heartbeatOnline = Boolean(heartbeat && heartbeat.expiresAt > now);
      if (heartbeat && !heartbeatOnline) {
        this.httpHeartbeats.delete(row.agentId);
      }

      const activePresence =
        (gatewayPresence?.online ? gatewayPresence : null) ??
        (webhookPresence?.online ? webhookPresence : null) ??
        (botmuxPresence?.online ? botmuxPresence : null) ??
        gatewayPresence ??
        botmuxPresence ??
        webhookPresence;

      const online = Boolean(
        gatewayPresence?.online ||
          webhookPresence?.online ||
          botmuxPresence?.online ||
          heartbeatOnline,
      );

      const defaultName =
        activePresence?.defaultName?.trim() || row.defaultName?.trim() || row.agentId;
      const name = row.displayName?.trim() || defaultName;
      const adapterType = (
        activePresence?.adapterType ||
        row.adapterType ||
        'botmux'
      ) as AgentAdapterType;

      const capabilities =
        gatewayPresence?.capabilities ??
        heartbeat?.capabilities ??
        (Array.isArray(row.capabilities) && row.capabilities.length > 0
          ? row.capabilities
          : activePresence?.capabilities ?? []);

      resolved.push({
        id: row.agentId,
        organizationId: row.organizationId ?? null,
        ownerUserId: row.ownerUserId ?? null,
        name,
        defaultName,
        adapterType,
        externalId: row.externalId ?? row.agentId,
        cliId: activePresence?.cliId ?? row.cliId ?? '',
        workingDir: activePresence?.workingDir ?? row.workingDir ?? null,
        description: row.description ?? null,
        systemPrompt: row.systemPrompt ?? null,
        avatarUrl: row.avatarUrl ?? null,
        capabilities,
        webhookUrl: row.webhookUrl ?? null,
        webhookSecret: row.webhookSecret ?? null,
        archived: row.archived,
        online,
        lastSeenAt: row.lastSeenAt ? row.lastSeenAt.getTime() : null,
        updatedAt: row.updatedAt ? row.updatedAt.getTime() : null,
      });
    }

    return resolved;
  }

  async getAgent(agentId: string): Promise<ResolvedAgent | null> {
    const all = await this.listAgents();
    return all.find((a) => a.id === agentId) ?? null;
  }

  /** Match `@mention` against all DB-known agents (name, defaultName, or id) with boundary checks. */
  findMentionedAgents(content: string, agents: ResolvedAgent[]): ResolvedAgent[] {
    if (!content || !content.includes('@')) return [];
    const lower = content.toLowerCase();
    const EMAIL_LOCAL_CHAR = /[a-z0-9._+-]/;
    const ASCII_WORD_CHAR = /[a-z0-9_]/;

    const atPositions: number[] = [];
    let idx = lower.indexOf('@');
    while (idx !== -1) {
      if (idx === 0 || !EMAIL_LOCAL_CHAR.test(lower[idx - 1]!)) {
        atPositions.push(idx);
      }
      idx = lower.indexOf('@', idx + 1);
    }
    if (atPositions.length === 0) return [];

    const candidatesByAgent = agents
      .filter((agent) => !agent.archived)
      .map((agent) => {
        const tokens = [
          ...new Set(
            [agent.name, agent.defaultName, agent.id]
              .map((c) => c?.trim().toLowerCase())
              .filter((c): c is string => Boolean(c)),
          ),
        ];
        return { agent, tokens };
      });

    const matchedIds = new Set<string>();
    for (const atPos of atPositions) {
      const start = atPos + 1;
      let bestLen = 0;
      const bestAgents: ResolvedAgent[] = [];

      for (const { agent, tokens } of candidatesByAgent) {
        let agentBestLen = 0;
        for (const token of tokens) {
          if (token.length < bestLen || token.length <= agentBestLen) continue;
          if (!lower.startsWith(token, start)) continue;
          const end = start + token.length;
          const lastChar = token[token.length - 1]!;
          if (
            end < lower.length &&
            ASCII_WORD_CHAR.test(lastChar) &&
            ASCII_WORD_CHAR.test(lower[end]!)
          ) {
            continue;
          }
          agentBestLen = token.length;
        }
        if (agentBestLen > bestLen) {
          bestLen = agentBestLen;
          bestAgents.length = 0;
          bestAgents.push(agent);
        } else if (agentBestLen > 0 && agentBestLen === bestLen) {
          bestAgents.push(agent);
        }
      }

      for (const agent of bestAgents) {
        matchedIds.add(agent.id);
      }
    }

    return agents.filter((agent) => matchedIds.has(agent.id));
  }

  /** Route a turn to the active adapter for this agent (Gateway WS → Webhook → Botmux). */
  async dispatchTurn(req: TurnDispatchRequest): Promise<TurnDispatchResult> {
    if (this.gateway.isAgentOnline(req.agent.id)) {
      return this.gateway.dispatchTurn(req);
    }
    if (req.agent.webhookUrl) {
      return this.webhook.dispatchTurn(req);
    }
    if (this.botmux.isAgentOnline(req.agent.id)) {
      return this.botmux.dispatchTurn(req);
    }
    // If Botmux is enabled and knows this agent (even if cached status was stale), allow Botmux to attempt/report error
    if (this.botmux.isEnabled() && req.agent.adapterType === 'botmux') {
      const bots = await this.botmux.refreshBots();
      if (bots.length > 0) {
        await this.upsertAgents(bots);
      }
      if (this.botmux.isAgentOnline(req.agent.id)) {
        return this.botmux.dispatchTurn(req);
      }
    }
    return {
      ok: false,
      adapterType: req.agent.adapterType,
      error: `Agent "${req.agent.name}" 当前离线，请先启动对应适配器或重连网关`,
    };
  }

  async getSessions(): Promise<BotmuxSession[]> {
    return this.botmux.getSessions();
  }

  async getPendingAsks(): Promise<BotmuxPendingAsk[]> {
    const [gatewayAsks, botmuxAsks] = await Promise.all([
      this.gateway.getPendingAsks(),
      this.botmux.getPendingAsks(),
    ]);
    return [...gatewayAsks, ...botmuxAsks];
  }

  async answerAsk(req: DashboardAskAnswerRequest) {
    if (this.gateway.hasNativeAsk(req.askId)) {
      return this.gateway.answerAsk(req);
    }
    return this.botmux.answerAsk(req);
  }

  async checkBotmuxHealth(): Promise<BotmuxHealthStatus> {
    return this.botmux.checkHealth();
  }
}
