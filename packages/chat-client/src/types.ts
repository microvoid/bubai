export interface InstanceInfo {
  name: string;
  version: string;
  authRequired: boolean;
  emailAndPasswordEnabled?: boolean;
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
  threadUnreadCount?: number;
  mentionCount?: number;
  muted?: boolean;
  starred?: boolean;
  groupId?: string | null;
  markedUnread?: boolean;
  memberIds?: string[];
  organizationId?: string | null;
  lastReadAt?: number | null;
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
  adapterType?: string;
  capabilities?: string[];
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

export type MessageCardStatus =
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'timeout'
  | 'dispatch_failed';

export interface MessageCard {
  title: string;
  status: MessageCardStatus;
  phase?: 'connecting' | 'thinking';
  parallel?: boolean;
  startedAt?: number;
  finishedAt?: number;
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
  adapterMeta?: Record<string, unknown>;
  replyCount?: number;
  replyPreviews?: ChatMessage[];
  unreadReplyCount?: number;
  justCompleted?: boolean;
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

export interface ActivityItem {
  id: string;
  kind: 'mention' | 'thread' | 'dm';
  channelId: string;
  channelName: string;
  channelKind: 'channel' | 'dm';
  threadId?: string;
  messageId: string;
  senderName: string;
  excerpt: string;
  unreadCount: number;
  createdAt: number;
  message: ChatMessage;
}

export interface BootstrapPayload {
  sidebarGroups?: { id: string; name: string }[];
  auth?: { required: boolean; authenticated: boolean; userId: string; organizationId?: string | null };
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
  adapterType?: string;
  capabilities?: string[];
  webhookUrl?: string | null;
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
  | { type: 'typing.updated'; payload: { channelId: string; userId: string; typing: boolean } }
  | { type: 'channel.deleted'; payload: { id: string } }
  | { type: 'message.send_failed'; payload: { messageId: string; message: string } }
  | { type: 'channel.members.updated'; payload: { channelId: string; members: ChannelMemberRow[]; ownerId?: string } }
  | { type: 'pong'; payload: { ts: number } }
  | { type: 'botmux.event'; payload: { eventName: string; data: unknown } };

export type WsConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface AgentProvisionInput {
  agentId?: string;
  adapterType?: 'botmux' | 'gateway' | 'webhook';
  externalId?: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  avatarUrl?: string;
  cliId?: string;
  workingDir?: string;
  capabilities?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
  channelId?: string;
  channelName?: string;
  organizationId?: string;
  community?: string;
  autoReply?: boolean;
  issueKey?: boolean;
  keyScope?: 'bot' | 'bot-server';
}

export interface AgentProvisionResult {
  ok: boolean;
  created: boolean;
  agent: Participant;
  organizationId?: string;
  channelId?: string;
  apiKey?: string;
}

export interface BotGatewayAgentDescriptor {
  id: string;
  externalId?: string;
  name: string;
  description?: string;
  cliId?: string;
  workingDir?: string | null;
  capabilities?: string[];
}

export interface BotTurnRequestedEvent {
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
  history: Array<{
    sender: string;
    role: 'human' | 'agent';
    content: string;
  }>;
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

export interface BotGatewayHandle {
  send(payload: Record<string, unknown>): boolean;
  sendPresence(agentId: string, status: 'online' | 'offline', capabilities?: string[]): boolean;
  sendTurnProgress(messageId: string, progress: AgentProgressSnapshot): boolean;
  sendTurnComplete(payload: {
    botId: string;
    messageId: string;
    content: string;
    status?: 'completed' | 'failed' | 'interrupted' | 'timeout';
    adapterMeta?: Record<string, unknown>;
  }): boolean;
  createAsk(payload: {
    askId?: string;
    agentId: string;
    botName?: string;
    sessionId?: string;
    title?: string;
    prompt?: string;
    questions?: BotmuxPendingAskQuestion[];
  }): boolean;
  reconnectNow(): void;
  close(): void;
}
