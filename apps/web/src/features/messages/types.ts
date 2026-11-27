import type { ReactionGroup } from './MessageReactions';
import type { UploadedAttachment } from './ProseMirrorComposer';

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
  attachments?: UploadedAttachment[];
  botmuxSessionId?: string;
  replyCount?: number;
  unreadReplyCount?: number;
  replyPreviews?: ChatMessage[];
  reactions?: ReactionGroup[];
  pinned?: boolean;
  justCompleted?: boolean;
  createdAt: number;
  updatedAt?: number;
}

export interface MessageFocus {
  id: string;
  sequence: number;
}
