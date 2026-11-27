import type { ResolvedAgent } from './adapters/types';

export const DEFAULT_MAX_AGENT_MENTION_HOPS = 5;

export function parseMaxAgentMentionHops(rawValue: string | undefined): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MAX_AGENT_MENTION_HOPS;
  }
  return Math.floor(parsed);
}

export function getAgentMentionHop(adapterMeta?: Record<string, unknown> | null): number {
  const raw = adapterMeta?.agentMentionHop;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return 0;
}

export function mergeAgentMentionHop(
  nextMeta: Record<string, unknown> | null | undefined,
  existingMeta: Record<string, unknown> | null | undefined,
  explicitHop?: number,
): Record<string, unknown> | null {
  const existingHop = getAgentMentionHop(existingMeta);
  const effectiveHop =
    typeof explicitHop === 'number' && Number.isFinite(explicitHop) && explicitHop > 0
      ? Math.floor(explicitHop)
      : existingHop;

  if (nextMeta && typeof nextMeta === 'object' && !Array.isArray(nextMeta)) {
    if (effectiveHop > 0) {
      return { ...nextMeta, agentMentionHop: effectiveHop };
    }
    return nextMeta;
  }

  if (existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)) {
    if (effectiveHop > 0) {
      return { ...existingMeta, agentMentionHop: effectiveHop };
    }
    return existingMeta;
  }

  return effectiveHop > 0 ? { agentMentionHop: effectiveHop } : null;
}

export interface SelectAgentReplyTargetsInput {
  content: string;
  knownAgents: ResolvedAgent[];
  channelAgentIds: ReadonlySet<string>;
  autoReplyBotIds: ReadonlySet<string>;
  enforceChannelMembership: boolean;
  senderAgentId?: string | null;
  currentHop?: number;
  maxAgentMentionHops?: number;
  findMentionedAgents: (content: string, agents: ResolvedAgent[]) => ResolvedAgent[];
}

export interface SelectAgentReplyTargetsResult {
  targets: ResolvedAgent[];
  nextHop: number;
  hopLimitReached: boolean;
}

/**
 * Resolve which agents should be dispatched in response to a message.
 * - Human messages trigger explicitly @-mentioned agents plus channel auto-reply agents.
 * - Agent messages only trigger explicitly @-mentioned *other* agents (never self, never auto-reply)
 *   and stop once `maxAgentMentionHops` is reached to prevent infinite agent-to-agent loops.
 */
export function selectAgentReplyTargets(
  input: SelectAgentReplyTargetsInput,
): SelectAgentReplyTargetsResult {
  const {
    content,
    knownAgents,
    channelAgentIds,
    autoReplyBotIds,
    enforceChannelMembership,
    senderAgentId,
    currentHop = 0,
    maxAgentMentionHops = DEFAULT_MAX_AGENT_MENTION_HOPS,
    findMentionedAgents,
  } = input;

  const membershipScoped = enforceChannelMembership
    ? knownAgents.filter((agent) => channelAgentIds.has(agent.id))
    : knownAgents;

  if (senderAgentId) {
    if (currentHop >= maxAgentMentionHops) {
      return {
        targets: [],
        nextHop: currentHop + 1,
        hopLimitReached: true,
      };
    }

    const eligibleAgents = membershipScoped.filter((agent) => agent.id !== senderAgentId);
    const mentioned = findMentionedAgents(content, eligibleAgents);
    return {
      targets: mentioned,
      nextHop: currentHop + 1,
      hopLimitReached: false,
    };
  }

  const mentioned = findMentionedAgents(content, membershipScoped);
  const targetMap = new Map<string, ResolvedAgent>();
  for (const agent of mentioned) {
    targetMap.set(agent.id, agent);
  }
  for (const agent of knownAgents) {
    if (!agent.archived && autoReplyBotIds.has(agent.id)) {
      targetMap.set(agent.id, agent);
    }
  }

  return {
    targets: [...targetMap.values()],
    nextHop: 0,
    hopLimitReached: false,
  };
}
