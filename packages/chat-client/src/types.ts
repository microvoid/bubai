export interface InstanceInfo {
  name: string;
  version: string;
  authRequired: boolean;
  publicUrl?: string;
  botmux: {
    connected: boolean;
    authenticated: boolean;
    detail: string;
  };
  capabilities: {
    terminalProxy: boolean;
    ws: boolean;
  };
}

export interface Channel {
  id: string;
  name: string;
  topic: string;
  kind?: 'channel' | 'dm';
  dmKey?: string;
  replyMode?: string;
  archived?: boolean;
  unreadCount: number;
  createdAt: number;
}

export interface Participant {
  id: string;
  name: string;
  role: 'human' | 'agent';
  avatarUrl?: string;
  description?: string;
  archived?: boolean;
  workingDir?: string;
  status: 'online' | 'offline';
  cliId?: string;
}

export interface ReactionGroup {
  emoji: string;
  userIds: string[];
}

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export type AgentProgressStepKind =
  | 'read'
  | 'shell'
  | 'task'
  | 'search'
  | 'edit'
  | 'web'
  | 'tool';

export type AgentProgressStepStatus = 'running' | 'done' | 'failed';

export interface AgentProgressStep {
  id: string;
  kind: AgentProgressStepKind;
  label: string;
  status: AgentProgressStepStatus;
  detail?: string;
}

export interface AgentProgressSnapshot {
  activeLabel?: string;
  toolCount: number;
  steps: AgentProgressStep[];
  updatedAt?: number;
}

export interface MessageCard {
  title: string;
  status: 'running' | 'waiting_approval' | 'completed' | 'failed';
  summary?: string;
  progress?: AgentProgressSnapshot;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  threadId?: string;
  replyToId?: string;
  senderId: string;
  senderRole: 'human' | 'agent';
  content: string;
  card?: MessageCard;
  attachments?: MessageAttachment[];
  botmuxSessionId?: string;
  replyCount?: number;
  reactions?: ReactionGroup[];
  pinned?: boolean;
  createdAt: number;
  updatedAt?: number;
}

export interface BotmuxSession {
  sessionId: string;
  larkAppId?: string;
  botName?: string;
  cliId?: string;
  state?: string;
  status?: string;
  title?: string;
  workingDir?: string;
  spawnedAt?: number;
  lastMessageAt?: number;
  lastActivityAt?: number;
  channelId?: string;
  channelName?: string;
  channelKind?: string;
}

export interface BotmuxPendingAskOption {
  key: string;
  label: string;
  description?: string;
}

export interface BotmuxPendingAskQuestion {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: BotmuxPendingAskOption[];
}

export interface BotmuxPendingAsk {
  askId: string;
  sessionId?: string;
  larkAppId: string;
  botName?: string;
  title?: string;
  prompt?: string;
  questions?: BotmuxPendingAskQuestion[];
  createdAt?: string | number;
}

export interface BotmuxStatus {
  endpoint: string;
  connected: boolean;
  authenticated: boolean;
  detail: string;
}

export interface BootstrapPayload {
  channels: Channel[];
  participants: Participant[];
  sessions: BotmuxSession[];
  asks: BotmuxPendingAsk[];
  botmuxStatus: BotmuxStatus;
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
  channels: Array<{
    channelId: string;
    name: string;
    topic: string;
    kind: 'channel' | 'dm';
    autoReply: boolean;
    sessionId?: string;
  }>;
  sessions: BotmuxSession[];
  pendingAsks: BotmuxPendingAsk[];
  recentMessages: Array<{
    id: string;
    channelId: string;
    channelName: string;
    channelKind: string;
    content: string;
    botmuxSessionId?: string;
    createdAt: number;
  }>;
}

export interface AgentUpdateInput {
  displayName?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  avatarUrl?: string | null;
  archived?: boolean;
}

export interface ChannelMemberRow {
  id: string;
  channelId: string;
  userId: string | null;
  agentId: string | null;
  autoReply: boolean;
}

export interface ThreadPayload {
  root: ChatMessage;
  replies: ChatMessage[];
}

export type ServerWsEvent =
  | { type: 'message.created'; payload: ChatMessage }
  | { type: 'message.updated'; payload: ChatMessage }
  | { type: 'message.deleted'; payload: { id: string; channelId: string; threadId?: string } }
  | { type: 'reaction.updated'; payload: { messageId: string; reactions: NonNullable<ChatMessage['reactions']> } }
  | { type: 'channel.created'; payload: Channel }
  | { type: 'channel.updated'; payload: Channel }
  | { type: 'pins.updated'; payload: { channelId: string; pins: ChatMessage[] } }
  | { type: 'presence.updated'; payload: { participants: Participant[] } }
  | { type: 'sessions.updated'; payload: { sessions: BotmuxSession[] } }
  | { type: 'asks.updated'; payload: { asks: BotmuxPendingAsk[] } }
  | { type: 'typing.start'; payload: { channelId: string; userId: string } }
  | { type: 'botmux.event'; payload: { eventName: string; data: unknown } };

export type WsConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';
