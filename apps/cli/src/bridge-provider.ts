import type { TurnLimiter } from '@bubx/agent/process';
import type { TurnFiles } from './bridge-attachments';
import type { BotGatewayAgentDescriptor, BotTurnRequestedEvent, BubaiClient } from '@buzz-botmux/chat-client';
import type { AgentProgressSnapshot } from '@buzz-botmux/botmux-client';
import type { PendingTurn, TurnCompletion } from './bridge-turn-journal';

export function turnAbortSignal(signal: AbortSignal, deadline?: number): AbortSignal {
  if (deadline === undefined || signal.aborted) return signal;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return AbortSignal.abort(new DOMException('Turn timed out', 'TimeoutError'));
  return AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
}

export type LocalAgentDescriptor = BotGatewayAgentDescriptor;
export type GatewayOptions = {
  limiter?: TurnLimiter;
  serverUrl: string;
  token?: string;
  botToken?: string;
  channelRef?: string;
  community?: string;
  autoReply?: boolean;
  onDisconnect?: (agentIds: string[]) => void;
  onReady?: (info: { agentIds: string[]; connectionId: string }) => void;
};

export interface TurnContext {
  signal?: AbortSignal;
  initial: PendingTurn;
  sdk?: BubaiClient;
  files?: TurnFiles;
  event?: BotTurnRequestedEvent;
  progress(snapshot: AgentProgressSnapshot): Promise<void>;
}

export interface LocalRuntimeProvider {
  discoverAgents(): Promise<LocalAgentDescriptor[]>;
  prepareTurn(event: BotTurnRequestedEvent): PendingTurn;
  executeTurn(ctx: TurnContext): Promise<TurnCompletion>;
  onAskAnswered?: Parameters<BubaiClient['connectBotGateway']>[0]['onAskAnswered'];
  stop(): void;
}
