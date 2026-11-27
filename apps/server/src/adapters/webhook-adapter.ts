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

function isBlockedWebhookHost(hostname: string, allowLocal: boolean): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Always block cloud metadata endpoints
  if (host === '169.254.169.254' || host === 'metadata.google.internal' || host === 'metadata.goog') {
    return true;
  }
  if (host.startsWith('169.254.') || host.startsWith('fe80:')) {
    return true;
  }
  if (allowLocal) return false;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) {
    return true;
  }
  if (
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }
  return false;
}

export function validateWebhookUrl(
  rawUrl: string,
  allowLocal = process.env.BUBAI_ALLOW_LOCAL_WEBHOOKS === 'true',
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: false, error: 'webhookUrl is empty' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid webhookUrl format' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'webhookUrl must use http or https' };
  }
  if (isBlockedWebhookHost(parsed.hostname, allowLocal)) {
    return { ok: false, error: `webhookUrl host "${parsed.hostname}" is not allowed` };
  }
  return { ok: true, url: parsed.toString() };
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

    const validated = validateWebhookUrl(webhookUrl);
    if (!validated.ok) {
      return {
        ok: false,
        adapterType: 'webhook',
        error: validated.error,
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
