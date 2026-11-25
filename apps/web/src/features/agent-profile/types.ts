export interface AgentChannelItem {
  channelId: string;
  name: string;
  topic: string;
  kind: 'channel' | 'dm';
  autoReply: boolean;
  sessionId?: string;
}

export interface AgentSessionItem {
  sessionId: string;
  larkAppId?: string;
  botName?: string;
  cliId?: string;
  state?: string;
  status?: string;
  title?: string;
  workingDir?: string;
  createdAt?: string | number;
  spawnedAt?: number;
  lastMessageAt?: number;
  lastActivityAt?: number;
  channelId?: string;
  channelName?: string;
  channelKind?: string;
}

export interface AgentRecentMessage {
  id: string;
  channelId: string;
  channelName: string;
  channelKind: string;
  content: string;
  botmuxSessionId?: string;
  createdAt: number;
}

export interface AgentPendingAsk {
  askId: string;
  sessionId?: string;
  larkAppId: string;
  botName?: string;
  title?: string;
  prompt?: string;
}

export interface AgentDetail {
  id: string;
  name: string;
  botName: string;
  cliId: string;
  status: 'online' | 'offline';
  workingDir: string | null;
  description: string;
  systemPrompt: string;
  avatarUrl: string;
  archived: boolean;
  updatedAt: number | null;
  channels: AgentChannelItem[];
  sessions: AgentSessionItem[];
  pendingAsks: AgentPendingAsk[];
  recentMessages: AgentRecentMessage[];
}

export interface AgentUpdateInput {
  displayName?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  avatarUrl?: string | null;
  archived?: boolean;
}

export type AgentProfileTab = 'info' | 'channels' | 'runtime';
export type AgentProfileView = 'summary' | 'instructions' | 'session-history';
