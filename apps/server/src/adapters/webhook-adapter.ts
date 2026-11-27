import { createHmac, randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentRuntimePresence,
  StandardTurnEvent,
  TurnDispatchRequest,
  TurnDispatchResult,
} from './types';

export function buildStandardTurnEvent(req: TurnDispatchRequest): StandardTurnEvent {
  return {
    eventId: `evt_${randomUUID()}`,
    type: 'turn.requested',
    botId: req.agent.id,
    externalId: req.agent.externalId,
    turnId: req.turnId,
    channel: req.channel,
    ...(req.threadId ? { threadId: req.threadId } : {}),
    triggerMessage: req.triggerMessage,
    replyTarget: {
      channelId: req.channel.id,
      ...(req.replyThreadId ? { threadId: req.replyThreadId } : {}),
      messageId: req.turnId,
    },
    ...(req.agent.systemPrompt ? { systemPrompt: req.agent.systemPrompt } : {}),
    history: req.history,
    outboundApi: req.outboundApi,
  };
}

export function signWebhookPayload(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Stateless HTTP Webhook adapter for cloud/serverless/third-party agents.
 * Dispatches standard `turn.requested` JSON events signed with optional HMAC-SHA256.
 */
export class WebhookAgentAdapter implements AgentAdapter {
  readonly type = 'webhook' as const;
  private readonly webhookAgents = new Map<string, { url: string; capabilities?: string[] }>();

  registerWebhookAgent(agentId: string, url: string, capabilities?: string[]) {
    this.webhookAgents.set(agentId, { url, capabilities });
  }

  unregisterWebhookAgent(agentId: string) {
    this.webhookAgents.delete(agentId);
  }

  isAgentOnline(agentId: string): boolean {
    return this.webhookAgents.has(agentId);
  }

  getAgentPresence(agentId: string): AgentRuntimePresence | null {
    const entry = this.webhookAgents.get(agentId);
    if (!entry) return null;
    return {
      online: true,
      adapterType: 'webhook',
      capabilities: entry.capabilities ?? ['progress_steps'],
    };
  }

  async dispatchTurn(req: TurnDispatchRequest): Promise<TurnDispatchResult> {
    const webhookUrl = req.agent.webhookUrl?.trim();
    if (!webhookUrl) {
      return {
        ok: false,
        adapterType: 'webhook',
        error: `Agent ${req.agent.name} has no webhookUrl configured`,
      };
    }

    const event = buildStandardTurnEvent(req);
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-BubAI-Event': event.type,
      'X-BubAI-Event-Id': event.eventId,
    };
    if (req.agent.webhookSecret) {
      headers['X-BubAI-Signature'] = signWebhookPayload(req.agent.webhookSecret, body);
    }

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          ok: false,
          adapterType: 'webhook',
          error: `Webhook HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
        };
      }
      return {
        ok: true,
        adapterType: 'webhook',
        adapterMeta: {
          adapter: 'webhook',
          eventId: event.eventId,
          webhookUrl,
        },
      };
    } catch (err) {
      return {
        ok: false,
        adapterType: 'webhook',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
