import type {
  BotmuxHealthStatus,
  BotmuxPendingAsk,
  BotmuxSession,
  BuzzTurnContext,
  DashboardAskAnswerRequest,
} from '@buzz-botmux/botmux-client';
import type { MessageAttachment } from '@buzz-botmux/db';

export type AgentAdapterType = 'botmux' | 'gateway' | 'webhook';

export type AgentCapability =
  | 'progress_steps'
  | 'interactive_ask'
  | 'terminal_attach'
  | 'session_control'
  | 'streaming'
  | (string & {});

export interface AgentRegistrationInput {
  agentId: string;
  adapterType?: AgentAdapterType;
  externalId?: string | null;
  defaultName?: string | null;
  displayName?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  avatarUrl?: string | null;
  cliId?: string | null;
  workingDir?: string | null;
  capabilities?: AgentCapability[] | null;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
}

export interface AgentRuntimePresence {
  online: boolean;
  adapterType: AgentAdapterType;
  capabilities?: string[];
  cliId?: string | null;
  workingDir?: string | null;
  defaultName?: string | null;
}

export interface ResolvedAgent {
  id: string;
  name: string;
  defaultName: string;
  adapterType: AgentAdapterType;
  externalId: string | null;
  cliId: string;
  workingDir: string | null;
  description: string | null;
  systemPrompt: string | null;
  avatarUrl: string | null;
  capabilities: string[];
  webhookUrl: string | null;
  webhookSecret: string | null;
  archived: boolean;
  online: boolean;
  lastSeenAt: number | null;
  updatedAt: number | null;
}

/** Platform-agnostic turn event envelope sent to Gateway WS and Webhook adapters. */
export interface StandardTurnEvent {
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
    attachments: MessageAttachment[];
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

export interface TurnDispatchRequest {
  agent: ResolvedAgent;
  turnId: string;
  channel: StandardTurnEvent['channel'];
  threadId?: string;
  replyThreadId: string | null;
  triggerMessage: StandardTurnEvent['triggerMessage'];
  promptWithAttachments: string;
  history: BuzzTurnContext['messages'];
  outboundApi: StandardTurnEvent['outboundApi'];
  turnStartedAt: number;
}

export interface TurnDispatchResult {
  ok: boolean;
  adapterType: AgentAdapterType;
  sessionId?: string;
  triggerId?: string;
  parallel?: boolean;
  adapterMeta?: Record<string, unknown>;
  error?: string;
}

export interface AgentAdapter {
  readonly type: AgentAdapterType;
  isAgentOnline(agentId: string): boolean;
  getAgentPresence(agentId: string): AgentRuntimePresence | null;
  dispatchTurn(req: TurnDispatchRequest): Promise<TurnDispatchResult>;
  answerAsk?(req: DashboardAskAnswerRequest): Promise<{ ok: boolean; status: number; body: unknown }>;
  getSessions?(): Promise<BotmuxSession[]>;
  getPendingAsks?(): Promise<BotmuxPendingAsk[]>;
  checkHealth?(): Promise<BotmuxHealthStatus>;
}
