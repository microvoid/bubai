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
  attachments?: UploadedAttachment[];
  botmuxSessionId?: string;
  replyCount?: number;
  replyPreviews?: ChatMessage[];
  reactions?: ReactionGroup[];
  pinned?: boolean;
  createdAt: number;
  updatedAt?: number;
}

export interface MessageFocus {
  id: string;
  sequence: number;
}
