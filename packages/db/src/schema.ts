/**
 * Group chat PostgreSQL schema copied/adapted from references/agentes-chat/packages/db/src/schema/chat.ts
 */
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

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

export interface MessageCardData {
  title: string;
  status: MessageCardStatus;
  phase?: 'connecting' | 'thinking';
  parallel?: boolean;
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  progress?: AgentProgressSnapshot;
}

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    topic: text('topic').notNull().default(''),
    visibility: text('visibility').notNull().default('public'),
    kind: text('kind').notNull().default('channel'),
    replyMode: text('reply_mode').notNull().default('follow_source'),
    archived: boolean('archived').notNull().default(false),
    dmKey: text('dm_key'),
    organizationId: text('organization_id'),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const channelReads = pgTable(
  'channel_reads',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
    muted: boolean('muted').notNull().default(false),
    hidden: boolean('hidden').notNull().default(false),
    markedUnread: boolean('marked_unread').notNull().default(false),
    starred: boolean('starred').notNull().default(false),
    groupId: text('group_id'),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] })]
);

export const sidebarGroups = pgTable(
  'sidebar_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)]
);

export const threadReads = pgTable(
  'thread_reads',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    rootMessageId: uuid('root_message_id').notNull(),
    userId: text('user_id').notNull(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.rootMessageId, t.userId] })]
);

export const channelMembers = pgTable(
  'channel_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: text('user_id'),
    agentId: text('agent_id'),
    autoReply: boolean('auto_reply').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.channelId),
    index().on(t.userId),
    index().on(t.agentId),
    unique().on(t.channelId, t.userId),
    unique().on(t.channelId, t.agentId),
  ]
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id'),
    replyToId: uuid('reply_to_id'),
    senderUserId: text('sender_user_id'),
    senderAgentId: text('sender_agent_id'),
    content: text('content').notNull(),
    card: jsonb('card').$type<MessageCardData | null>(),
    attachments: jsonb('attachments').$type<MessageAttachment[] | null>(),
    botmuxSessionId: text('botmux_session_id'),
    adapterMeta: jsonb('adapter_meta').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index().on(t.channelId, t.createdAt), index().on(t.threadId, t.createdAt)]
);

export const messageReactions = pgTable(
  'message_reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })]
);

export const messagePins = pgTable(
  'message_pins',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    pinnedByUserId: text('pinned_by_user_id').notNull(),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.messageId] })]
);

export const botmuxBindings = pgTable(
  'botmux_bindings',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    botId: text('bot_id').notNull(),
    sessionId: text('session_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.botId] })]
);

export const agentProfiles = pgTable('agent_profiles', {
  agentId: text('agent_id').primaryKey(),
  adapterType: text('adapter_type').notNull().default('botmux'),
  externalId: text('external_id'),
  defaultName: text('default_name'),
  displayName: text('display_name'),
  description: text('description'),
  systemPrompt: text('system_prompt'),
  avatarUrl: text('avatar_url'),
  cliId: text('cli_id'),
  workingDir: text('working_dir'),
  capabilities: jsonb('capabilities').$type<string[] | null>(),
  webhookUrl: text('webhook_url'),
  webhookSecret: text('webhook_secret'),
  archived: boolean('archived').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const uploads = pgTable(
  'uploads',
  {
    storedName: text('stored_name').primaryKey(),
    organizationId: text('organization_id'),
    uploadedByUserId: text('uploaded_by_user_id'),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.organizationId)]
);
