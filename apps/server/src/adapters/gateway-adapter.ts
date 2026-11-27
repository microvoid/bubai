import { randomUUID } from 'node:crypto';
import type { ServerWebSocket } from 'bun';
import type { BotmuxPendingAsk, DashboardAskAnswerRequest } from '@buzz-botmux/botmux-client';
import type {
  AgentAdapter,
  AgentRegistrationInput,
  AgentRuntimePresence,
  TurnDispatchRequest,
  TurnDispatchResult,
} from './types';
import { buildStandardTurnEvent } from './webhook-adapter';

export interface BotGatewayWsData {
  kind: 'bot-gateway';
  connectionId: string;
  botUserId?: string;
  isServerKey: boolean;
  boundAgentIds: Set<string>;
}

export interface GatewayCallbacks {
  onAgentsRegistered: (agents: AgentRegistrationInput[]) => Promise<void>;
  onPresenceChanged: () => Promise<void>;
  onAsksChanged: () => Promise<void>;
  onTurnProgress?: (botId: string, messageId: string, progress: unknown) => Promise<void>;
  onTurnComplete?: (payload: {
    botId: string;
    messageId: string;
    content: string;
    status?: 'completed' | 'failed' | 'interrupted' | 'timeout';
    adapterMeta?: Record<string, unknown>;
  }) => Promise<void>;
}

interface ConnectedAgentState {
  ws: ServerWebSocket<BotGatewayWsData>;
  connectionId: string;
  capabilities: string[];
  cliId?: string | null;
  workingDir?: string | null;
  defaultName?: string | null;
  online: boolean;
  lastHeartbeatAt: number;
}

/**
 * Bidirectional WebSocket Gateway adapter (`/ws/bot`, Socket Mode).
 * External adapters (e.g. Botmux Connector, OpenClaw, custom local/remote bots) connect outbound
 * to BubAI with a `bot_` or `bot-server_` key.
 * Connection liveness automatically drives agent presence (online/offline).
 */
export class BotGatewayAdapter implements AgentAdapter {
  readonly type = 'gateway' as const;
  private readonly connections = new Map<string, ServerWebSocket<BotGatewayWsData>>();
  private readonly agentConnections = new Map<string, ConnectedAgentState>();
  private readonly nativeAsks = new Map<string, BotmuxPendingAsk>();
  private readonly callbacks: GatewayCallbacks;

  constructor(callbacks: GatewayCallbacks) {
    this.callbacks = callbacks;
  }

  isAgentOnline(agentId: string): boolean {
    const state = this.agentConnections.get(agentId);
    return Boolean(state && state.online && state.ws.readyState === WebSocket.OPEN);
  }

  getAgentPresence(agentId: string): AgentRuntimePresence | null {
    const state = this.agentConnections.get(agentId);
    if (!state || state.ws.readyState !== WebSocket.OPEN) return null;
    return {
      online: state.online,
      adapterType: 'gateway',
      capabilities: state.capabilities,
      cliId: state.cliId,
      workingDir: state.workingDir,
      defaultName: state.defaultName,
    };
  }

  getConnectedAgentIds(): string[] {
    const ids: string[] = [];
    for (const [id, state] of this.agentConnections.entries()) {
      if (state.online && state.ws.readyState === WebSocket.OPEN) {
        ids.push(id);
      }
    }
    return ids;
  }

  async getPendingAsks(): Promise<BotmuxPendingAsk[]> {
    return Array.from(this.nativeAsks.values());
  }

  hasNativeAsk(askId: string): boolean {
    return this.nativeAsks.has(askId);
  }

  async createNativeAsk(input: Omit<BotmuxPendingAsk, 'askId'> & { askId?: string }, expiresAt?: number): Promise<BotmuxPendingAsk> {
    const ask: BotmuxPendingAsk = {
      ...input,
      askId: input.askId?.trim() || `ask_${randomUUID()}`,
      createdAt: input.createdAt ?? Date.now(),
    };
    this.nativeAsks.set(ask.askId, ask);
    if (expiresAt !== undefined) {
      setTimeout(() => {
        if (this.nativeAsks.get(ask.askId) !== ask) return;
        this.nativeAsks.delete(ask.askId);
        void this.callbacks.onAsksChanged();
      }, Math.min(2_147_483_647, Math.max(1, expiresAt - Date.now()))).unref();
    }
    await this.callbacks.onAsksChanged();
    return ask;
  }

  async answerAsk(req: DashboardAskAnswerRequest): Promise<{ ok: boolean; status: number; body: unknown }> {
    const ask = this.nativeAsks.get(req.askId);
    if (!ask) {
      return { ok: false, status: 404, body: { ok: false, error: 'Ask not found' } };
    }
    this.nativeAsks.delete(req.askId);
    const state = this.agentConnections.get(ask.larkAppId);
    if (state && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'ask.answered', payload: req }));
    }
    await this.callbacks.onAsksChanged();
    return { ok: true, status: 200, body: { ok: true, askId: req.askId } };
  }

  handleOpen(ws: ServerWebSocket<BotGatewayWsData>) {
    this.connections.set(ws.data.connectionId, ws);
    // If authenticated with a single-bot key, auto-bind that bot user immediately
    if (ws.data.botUserId && !ws.data.isServerKey) {
      ws.data.boundAgentIds.add(ws.data.botUserId);
      this.agentConnections.set(ws.data.botUserId, {
        ws,
        connectionId: ws.data.connectionId,
        capabilities: ['progress_steps', 'interactive_ask'],
        online: true,
        lastHeartbeatAt: Date.now(),
      });
      void this.callbacks.onPresenceChanged();
    }
  }

  async handleMessage(ws: ServerWebSocket<BotGatewayWsData>, raw: string | Buffer | Uint8Array) {
    let msg: { type?: string; payload?: Record<string, unknown> };
    try {
      msg = JSON.parse(String(raw)) as { type?: string; payload?: Record<string, unknown> };
    } catch {
      ws.send(JSON.stringify({ type: 'bot.error', payload: { error: 'Invalid JSON frame' } }));
      return;
    }

    const type = msg.type;
    const payload = msg.payload || {};

    if (type === 'bot.ping' || type === 'ping') {
      const now = Date.now();
      for (const agentId of ws.data.boundAgentIds) {
        const state = this.agentConnections.get(agentId);
        if (state && state.connectionId === ws.data.connectionId) {
          state.lastHeartbeatAt = now;
        }
      }
      ws.send(JSON.stringify({ type: 'bot.pong', payload: { ts: now } }));
      return;
    }

    if (type === 'bot.hello') {
      const rawAgents = Array.isArray(payload.agents) ? payload.agents : [];
      const registrations: AgentRegistrationInput[] = [];
      const boundIds: string[] = [];

      if (rawAgents.length === 0 && ws.data.botUserId) {
        registrations.push({
          agentId: ws.data.botUserId,
          adapterType: 'gateway',
          defaultName: typeof payload.name === 'string' ? payload.name : undefined,
          capabilities: Array.isArray(payload.capabilities)
            ? payload.capabilities.filter((c): c is string => typeof c === 'string')
            : ['progress_steps', 'interactive_ask'],
        });
      } else {
        for (const item of rawAgents) {
          if (!item || typeof item !== 'object') continue;
          const rec = item as Record<string, unknown>;
          const id = typeof rec.id === 'string' && rec.id.trim()
            ? rec.id.trim()
            : typeof rec.agentId === 'string' && rec.agentId.trim()
              ? rec.agentId.trim()
              : '';
          if (!id) continue;
          // Non-server keys may only bind their own botUserId
          if (!ws.data.isServerKey && ws.data.botUserId && id !== ws.data.botUserId) {
            continue;
          }
          const capabilities = Array.isArray(rec.capabilities)
            ? rec.capabilities.filter((c): c is string => typeof c === 'string')
            : ['progress_steps', 'interactive_ask'];
          registrations.push({
            agentId: id,
            adapterType: 'gateway',
            externalId: typeof rec.externalId === 'string' ? rec.externalId : id,
            defaultName: typeof rec.name === 'string' ? rec.name : id,
            description: typeof rec.description === 'string' ? rec.description : undefined,
            cliId: typeof rec.cliId === 'string' ? rec.cliId : undefined,
            workingDir: typeof rec.workingDir === 'string' ? rec.workingDir : undefined,
            capabilities,
          });
        }
      }

      if (registrations.length > 0) {
        await this.callbacks.onAgentsRegistered(registrations);
        const now = Date.now();
        for (const reg of registrations) {
          ws.data.boundAgentIds.add(reg.agentId);
          boundIds.push(reg.agentId);
          this.agentConnections.set(reg.agentId, {
            ws,
            connectionId: ws.data.connectionId,
            capabilities: reg.capabilities ?? ['progress_steps', 'interactive_ask'],
            cliId: reg.cliId,
            workingDir: reg.workingDir,
            defaultName: reg.defaultName,
            online: true,
            lastHeartbeatAt: now,
          });
        }
        await this.callbacks.onPresenceChanged();
      }

      ws.send(
        JSON.stringify({
          type: 'bot.welcome',
          payload: {
            connectionId: ws.data.connectionId,
            agentIds: boundIds,
          },
        }),
      );
      return;
    }

    if (type === 'bot.presence') {
      const agentId = typeof payload.agentId === 'string' ? payload.agentId.trim() : ws.data.botUserId || '';
      if (!agentId || !ws.data.boundAgentIds.has(agentId)) return;
      const state = this.agentConnections.get(agentId);
      if (state && state.connectionId === ws.data.connectionId) {
        state.online = payload.status !== 'offline';
        if (Array.isArray(payload.capabilities)) {
          state.capabilities = payload.capabilities.filter((c): c is string => typeof c === 'string');
        }
        state.lastHeartbeatAt = Date.now();
        await this.callbacks.onPresenceChanged();
      }
      return;
    }

    if (type === 'bot.turn.progress' && this.callbacks.onTurnProgress) {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId.trim() : '';
      const botId = typeof payload.botId === 'string' ? payload.botId.trim() : ws.data.botUserId || '';
      if (messageId && botId && ws.data.boundAgentIds.has(botId) && payload.progress) {
        await this.callbacks.onTurnProgress(botId, messageId, payload.progress);
      }
      return;
    }

    if (type === 'bot.turn.complete' && this.callbacks.onTurnComplete) {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId.trim() : '';
      const botId = typeof payload.botId === 'string' ? payload.botId.trim() : ws.data.botUserId || '';
      const content = typeof payload.content === 'string' ? payload.content : '';
      const status =
        payload.status === 'failed' ||
        payload.status === 'interrupted' ||
        payload.status === 'timeout' ||
        payload.status === 'completed'
          ? payload.status
          : 'completed';
      const adapterMeta =
        payload.adapterMeta && typeof payload.adapterMeta === 'object'
          ? (payload.adapterMeta as Record<string, unknown>)
          : undefined;
      if (messageId && botId && ws.data.boundAgentIds.has(botId)) {
        await this.callbacks.onTurnComplete({ botId, messageId, content, status, adapterMeta });
      }
      return;
    }

    if (type === 'bot.ask.create') {
      const agentId = typeof payload.agentId === 'string' ? payload.agentId.trim() : ws.data.botUserId || '';
      if (!agentId) return;
      await this.createNativeAsk({
        askId: typeof payload.askId === 'string' ? payload.askId : undefined,
        larkAppId: agentId,
        sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
        botName: typeof payload.botName === 'string' ? payload.botName : undefined,
        title: typeof payload.title === 'string' ? payload.title : undefined,
        prompt: typeof payload.prompt === 'string' ? payload.prompt : undefined,
        questions: Array.isArray(payload.questions)
          ? (payload.questions as BotmuxPendingAsk['questions'])
          : undefined,
      });
    }
  }

  async handleClose(ws: ServerWebSocket<BotGatewayWsData>) {
    this.connections.delete(ws.data.connectionId);
    let changed = false;
    for (const agentId of ws.data.boundAgentIds) {
      const state = this.agentConnections.get(agentId);
      if (state && state.connectionId === ws.data.connectionId) {
        this.agentConnections.delete(agentId);
        changed = true;
      }
    }
    if (changed) {
      await this.callbacks.onPresenceChanged();
    }
  }

  async dispatchTurn(req: TurnDispatchRequest): Promise<TurnDispatchResult> {
    const state = this.agentConnections.get(req.agent.id);
    if (!state || !state.online || state.ws.readyState !== WebSocket.OPEN) {
      return {
        ok: false,
        adapterType: 'gateway',
        error: `Agent ${req.agent.name} is offline (not connected to /ws/bot)`,
      };
    }

    const event = buildStandardTurnEvent(req);
    try {
      state.ws.send(JSON.stringify(event));
      return {
        ok: true,
        adapterType: 'gateway',
        adapterMeta: {
          adapter: 'gateway',
          eventId: event.eventId,
          connectionId: state.connectionId,
        },
      };
    } catch (err) {
      return {
        ok: false,
        adapterType: 'gateway',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
