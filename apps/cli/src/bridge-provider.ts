import type { BotGatewayAgentDescriptor, BotTurnRequestedEvent, BubaiClient } from '@buzz-botmux/chat-client';
import type { AgentProgressSnapshot } from '@buzz-botmux/botmux-client';
import type { PendingTurn, TurnCompletion } from './bridge-turn-journal';

export type LocalAgentDescriptor = BotGatewayAgentDescriptor;
export type GatewayOptions = {
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
  initial: PendingTurn;
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
