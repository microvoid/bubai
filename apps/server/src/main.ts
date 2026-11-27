/**
 * Group chat server powered by Bun + Hono + Drizzle/PGlite (agentes-chat architecture)
 * bridged to local Botmux daemon (/api/* + /events SSE + /api/asks/* + /api/sessions/:sid/*).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ServerWebSocket } from 'bun';
import {
  openChatDatabase,
  channels,
  channelReads,
  threadReads,
  channelMembers,
  messages,
  messageReactions,
  messagePins,
  botmuxBindings,
  agentProfiles,
  sidebarGroups,
  uploads,
  eq,
  asc,
  desc,
  and,
  lt,
  gt,
  isNull,
  isNotNull,
  inArray,
  ilike,
  sql,
  type MessageAttachment,
  type MessageCardData,
} from '@buzz-botmux/db';
import {
  finalizeProgressSnapshot,
  normalizeProgressSnapshot,
  progressSnapshotEquals,
  readTurnProgress,
  type AgentProgressSnapshot,
  type BotmuxSession,
  type BuzzTurnContext,
  type DashboardAskAnswerRequest,
} from '@buzz-botmux/botmux-client';
import { readAntigravityResult } from './antigravity-result';
import {
  buildProxiedTerminalUrl,
  proxyTerminalHttpRequest,
  resolveTerminalUpstreamUrl,
} from './terminal-proxy';
import { AUTH_DDL, authSchema, botCredentials } from '@bubai/auth';
import { createUploadStorage } from './storage';
import {
  buildSessionHeaders,
  createServerAuth,
  resolveDisplayName,
  resolveRequestIdentity,
  resolveTrustedOrigins,
  verifyBotRequest,
} from './auth';
import { AgentDispatcher } from './adapters/dispatcher';
import { BotmuxAgentAdapter } from './adapters/botmux-adapter';
import { BotGatewayAdapter, type BotGatewayWsData } from './adapters/gateway-adapter';
import { WebhookAgentAdapter, validateWebhookUrl } from './adapters/webhook-adapter';
import type { AgentRegistrationInput, ResolvedAgent } from './adapters/types';

const PORT = Number(process.env.PORT || 4000);
const AUTH_REQUIRED = process.env.BUBAI_AUTH_REQUIRED !== 'false';
const BOTMUX_DISABLED = process.env.BOTMUX_DISABLED === 'true';
const BOTMUX_ENDPOINT = process.env.BOTMUX_ENDPOINT || 'http://127.0.0.1:7891';
const BOTMUX_TOKEN = process.env.BOTMUX_TOKEN;
const BUZZ_BOT_TOKEN = process.env.BUZZ_BOT_TOKEN;
const BUZZ_SEND_CLI_PATH = path.resolve(import.meta.dir, '../../../scripts/buzz-send.mjs');
const CONTEXT_HISTORY_LIMIT = Math.min(
  Math.max(Number(process.env.BUZZ_CONTEXT_LIMIT || 20), 1),
  50
);
const THREAD_REPLY_PREVIEW_LIMIT = 5;
const BOTMUX_RESULT_POLL_MS = 2000;
const BOTMUX_RESULT_GRACE_MS = 10_000;
const BOTMUX_RESULT_TIMEOUT_MS = 30 * 60_000;
const BOTMUX_TRIGGER_SUMMARY_PREFIX = 'triggerId: ';
const LOCAL_BOTMUX_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_BOTMUX_BACKENDS = new Set(['pty', 'tmux', 'herdr', 'zellij', 'zmx']);
const isLocalBotmux = URL.canParse(BOTMUX_ENDPOINT) &&
  LOCAL_BOTMUX_HOSTS.has(new URL(BOTMUX_ENDPOINT).hostname);
const BOT_TURN_TERMINAL_STATUSES = ['completed', 'failed', 'interrupted', 'timeout', 'dispatch_failed'] as const;
const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BotTurnCompletion = {
  content: string;
  status: (typeof BOT_TURN_TERMINAL_STATUSES)[number];
  adapterMeta?: Record<string, unknown>;
};

const REPLY_MODES = [
  'follow_source',
  'always_thread',
  'always_main',
  'dm_main_channel_thread',
] as const;
type ReplyMode = (typeof REPLY_MODES)[number];

function parseReplyMode(value: unknown, fallback: ReplyMode = 'follow_source'): ReplyMode {
  return typeof value === 'string' && (REPLY_MODES as readonly string[]).includes(value)
    ? (value as ReplyMode)
    : fallback;
}

const DEFAULT_REPLY_MODE: ReplyMode = parseReplyMode(process.env.BUZZ_REPLY_MODE, 'follow_source');

function resolveReplyThreadId(
  replyMode: ReplyMode,
  channelKind: string | undefined,
  incomingThreadId: string | undefined,
  triggerMessageId: string
): string | null {
  switch (replyMode) {
    case 'always_main':
      return null;
    case 'always_thread':
      return incomingThreadId || triggerMessageId;
    case 'dm_main_channel_thread':
      return channelKind === 'dm'
        ? incomingThreadId || null
        : incomingThreadId || triggerMessageId;
    case 'follow_source':
    default:
      return incomingThreadId || null;
  }
}
const uploadStorage = createUploadStorage();
const STATIC_DIR = process.env.STATIC_DIR?.trim()
  ? path.resolve(process.env.STATIC_DIR.trim())
  : '';

const { db, driver: dbDriver } = await openChatDatabase({ beforeDdl: AUTH_DDL });
const auth = createServerAuth({ db, port: PORT });

const botmuxAdapter = new BotmuxAgentAdapter({
  db,
  endpoint: BOTMUX_ENDPOINT,
  token: BOTMUX_TOKEN,
  enabled: !BOTMUX_DISABLED,
});
const webhookAdapter = new WebhookAgentAdapter();
const gatewayAdapter = new BotGatewayAdapter({
  onAgentsRegistered: async (agents) => {
    await dispatcher.upsertAgents(agents);
  },
  onPresenceChanged: async () => {
    await broadcastPresenceUpdated();
  },
  onAsksChanged: async () => {
    await broadcastAsksUpdated();
  },
  onTurnProgress: async (botId, messageId, progress) => {
    const [row] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
      .limit(1);
    if (row && row.senderAgentId === botId) {
      await applyMessageProgress(row, progress);
    }
  },
  onTurnComplete: async ({ botId, messageId, content, status, adapterMeta }) => {
    if (!MESSAGE_ID_PATTERN.test(messageId)) return;
    const row = await findBotTurnMessage(messageId);
    if (!row || row.senderAgentId !== botId) return;
    await settleBotTurn(row, { content, status: status ?? 'completed', adapterMeta });
  },
});
const dispatcher = new AgentDispatcher({
  db,
  botmux: botmuxAdapter,
  gateway: gatewayAdapter,
  webhook: webhookAdapter,
});

interface WsClientData {
  kind?: 'chat' | 'terminal-proxy' | 'bot-gateway';
  userId?: string;
  organizationId?: string;
  authenticated?: boolean;
  upstreamWsUrl?: string;
  upstreamWs?: WebSocket | null;
  pendingFrames?: Array<string | ArrayBuffer | Uint8Array>;
  connectionId?: string;
  botUserId?: string;
  isServerKey?: boolean;
  boundAgentIds?: Set<string>;
}

const clients = new Set<ServerWebSocket<WsClientData>>();

function broadcast(event: { type: string; payload: unknown }, targetOrgId?: string | null) {
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    if (targetOrgId) {
      if (ws.data.organizationId !== targetOrgId) continue;
    } else if (AUTH_REQUIRED && ws.data.organizationId) {
      continue;
    }
    ws.send(payload);
  }
}

async function getChannelOrgId(channelId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: channels.organizationId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  return row?.organizationId ?? null;
}

async function listOrgMemberIds(organizationId: string): Promise<Set<string>> {
  const rows = await db
    .select({ userId: authSchema.member.userId })
    .from(authSchema.member)
    .where(eq(authSchema.member.organizationId, organizationId));
  return new Set(rows.map((r) => r.userId));
}

async function isAgentInOrg(agentId: string, organizationId?: string | null): Promise<boolean> {
  if (!organizationId) return true;
  const rows = await db
    .select({ id: authSchema.member.id })
    .from(authSchema.member)
    .where(
      and(
        eq(authSchema.member.organizationId, organizationId),
        eq(authSchema.member.userId, agentId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function listOrgSessionIds(organizationId: string): Promise<Set<string>> {
  const [bindingRows, msgRows] = await Promise.all([
    db
      .select({ sessionId: botmuxBindings.sessionId, channelId: botmuxBindings.channelId })
      .from(botmuxBindings)
      .innerJoin(channels, eq(botmuxBindings.channelId, channels.id))
      .where(eq(channels.organizationId, organizationId)),
    db
      .select({ sessionId: messages.botmuxSessionId })
      .from(messages)
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .where(and(eq(channels.organizationId, organizationId), isNotNull(messages.botmuxSessionId))),
  ]);
  const ids = new Set<string>();
  for (const r of bindingRows) ids.add(r.sessionId);
  for (const r of msgRows) {
    if (r.sessionId) ids.add(r.sessionId);
  }
  return ids;
}

async function listSessionsForOrg(
  organizationId?: string | null,
  preloaded?: BotmuxSession[],
): Promise<BotmuxSession[]> {
  const all = preloaded ?? (await dispatcher.getSessions());
  if (!organizationId) return all;
  const [memberIds, orgSessionIds] = await Promise.all([
    listOrgMemberIds(organizationId),
    listOrgSessionIds(organizationId),
  ]);
  return all.filter(
    (s) => orgSessionIds.has(s.sessionId) || (s.larkAppId ? memberIds.has(s.larkAppId) : false),
  );
}

async function listAsksForOrg(
  organizationId?: string | null,
  preloaded?: Awaited<ReturnType<typeof dispatcher.getPendingAsks>>,
) {
  const all = preloaded ?? (await dispatcher.getPendingAsks());
  if (!organizationId) return all;
  const [memberIds, orgSessionIds] = await Promise.all([
    listOrgMemberIds(organizationId),
    listOrgSessionIds(organizationId),
  ]);
  return all.filter((a) => {
    const rec = a as unknown as Record<string, unknown>;
    const botId = typeof rec.larkAppId === 'string' ? rec.larkAppId : typeof rec.botId === 'string' ? rec.botId : null;
    const sid = typeof rec.sessionId === 'string' ? rec.sessionId : null;
    return (sid && orgSessionIds.has(sid)) || (botId && memberIds.has(botId));
  });
}

async function sessionBelongsToOrg(sessionId: string, organizationId?: string | null): Promise<boolean> {
  if (!organizationId) return true;
  const [orgSessionIds, memberIds, allSessions] = await Promise.all([
    listOrgSessionIds(organizationId),
    listOrgMemberIds(organizationId),
    dispatcher.getSessions(),
  ]);
  if (orgSessionIds.has(sessionId)) return true;
  const live = allSessions.find((s) => s.sessionId === sessionId);
  return Boolean(live?.larkAppId && memberIds.has(live.larkAppId));
}

function getConnectedOrgScopes(): Set<string | null> {
  const scopes = new Set<string | null>();
  for (const ws of clients) {
    scopes.add(ws.data.organizationId ?? null);
  }
  return scopes;
}

async function broadcastPresenceUpdated(targetOrgId?: string | null) {
  if (targetOrgId !== undefined) {
    const participants = await listParticipants(targetOrgId);
    broadcast({ type: 'presence.updated', payload: { participants } }, targetOrgId);
    return;
  }
  const scopes = getConnectedOrgScopes();
  for (const orgId of scopes) {
    const participants = await listParticipants(orgId);
    const payload = JSON.stringify({ type: 'presence.updated', payload: { participants } });
    for (const ws of clients) {
      if ((ws.data.organizationId ?? null) === orgId) {
        ws.send(payload);
      }
    }
  }
}

async function broadcastSessionsUpdated(preloaded?: BotmuxSession[]) {
  const scopes = getConnectedOrgScopes();
  if (scopes.size === 0) return;
  const all = preloaded ?? (await dispatcher.getSessions());
  for (const orgId of scopes) {
    const sessions = await listSessionsForOrg(orgId, all);
    const payload = JSON.stringify({ type: 'sessions.updated', payload: { sessions } });
    for (const ws of clients) {
      if ((ws.data.organizationId ?? null) === orgId) {
        ws.send(payload);
      }
    }
  }
}

async function broadcastAsksUpdated(preloaded?: Awaited<ReturnType<typeof dispatcher.getPendingAsks>>) {
  const scopes = getConnectedOrgScopes();
  if (scopes.size === 0) return;
  const all = preloaded ?? (await dispatcher.getPendingAsks());
  for (const orgId of scopes) {
    const asks = await listAsksForOrg(orgId, all);
    const payload = JSON.stringify({ type: 'asks.updated', payload: { asks } });
    for (const ws of clients) {
      if ((ws.data.organizationId ?? null) === orgId) {
        ws.send(payload);
      }
    }
  }
}

async function syncBotmuxAndSeedDefaults() {
  const { owner } = await dispatcher.syncBotmuxAgents();
  if (AUTH_REQUIRED) return;

  const ownerName = owner?.ok && owner.name ? owner.name : 'Owner';
  const ownerAvatar = owner?.ok ? owner.avatarUrl ?? null : null;

  await db
    .insert(authSchema.user)
    .values({
      id: 'u-owner',
      name: ownerName,
      email: 'owner@local.bubai',
      emailVerified: true,
      image: ownerAvatar,
      kind: 'HUMAN',
    })
    .onConflictDoUpdate({
      target: authSchema.user.id,
      set: { name: ownerName, image: ownerAvatar, updatedAt: new Date() },
    });

  const existingChannels = await db.select().from(channels);
  if (existingChannels.length === 0) {
    await db
      .insert(channels)
      .values([
        {
          name: 'general',
          topic: '团队与 Agent 实时协作频道',
          kind: 'channel',
          createdByUserId: 'u-owner',
        },
        {
          name: 'dev-tasks',
          topic: '研发任务协作（@Agent 直接触发协作会话）',
          kind: 'channel',
          createdByUserId: 'u-owner',
        },
      ])
      .onConflictDoNothing();
  }
}

async function listParticipants(organizationId?: string | null) {
  const [dbUsers, resolvedAgents, allowedMemberIds] = await Promise.all([
    db
      .select()
      .from(authSchema.user)
      .where(eq(authSchema.user.kind, 'HUMAN'))
      .orderBy(asc(authSchema.user.createdAt)),
    dispatcher.listAgents(),
    organizationId ? listOrgMemberIds(organizationId) : Promise.resolve(null),
  ]);
  const filteredUsers = allowedMemberIds
    ? dbUsers.filter((u) => allowedMemberIds.has(u.id))
    : dbUsers;
  const filteredAgents = allowedMemberIds
    ? resolvedAgents.filter((a) => allowedMemberIds.has(a.id))
    : resolvedAgents;

  const onlineUserIds = new Set<string>();
  for (const ws of clients) {
    if (organizationId && ws.data.organizationId !== organizationId) continue;
    if (ws.data.userId) onlineUserIds.add(ws.data.userId);
  }

  const humans = filteredUsers.map((u) => ({
    id: u.id,
    name: resolveDisplayName(u.name, u.email),
    role: 'human' as const,
    avatarUrl: u.image || undefined,
    status: onlineUserIds.has(u.id) ? ('online' as const) : ('offline' as const),
  }));

  const agents = filteredAgents.map((a) => ({
    id: a.id,
    name: a.name,
    role: 'agent' as const,
    avatarUrl: a.avatarUrl || undefined,
    description: a.description || undefined,
    archived: a.archived,
    workingDir: a.workingDir || undefined,
    status: a.online ? ('online' as const) : ('offline' as const),
    cliId: a.cliId || undefined,
    adapterType: a.adapterType,
    capabilities: a.capabilities,
  }));

  return [...humans, ...agents];
}

async function buildAgentDetail(
  agentId: string,
  viewerUserId?: string,
  organizationId?: string | null,
) {
  if (organizationId && !(await isAgentInOrg(agentId, organizationId))) {
    return null;
  }
  const [resolvedAgent, memberRows, bindingRows, allChannels, allSessions, allAsks] =
    await Promise.all([
      dispatcher.getAgent(agentId),
      db.select().from(channelMembers).where(eq(channelMembers.agentId, agentId)),
      db.select().from(botmuxBindings).where(eq(botmuxBindings.botId, agentId)),
      db.select().from(channels).orderBy(asc(channels.createdAt)),
      listSessionsForOrg(organizationId),
      listAsksForOrg(organizationId),
    ]);

  if (!resolvedAgent) return null;

  const visibleChannels = allChannels.filter(
    (ch) =>
      channelBelongsToOrg(ch, organizationId) &&
      (viewerUserId ? channelVisibleTo(ch, viewerUserId) : ch.kind !== 'dm'),
  );
  const visibleChannelMap = new Map(visibleChannels.map((c) => [c.id, c]));
  const visibleChannelIds = visibleChannels.map((c) => c.id);

  const recentMsgRows =
    visibleChannelIds.length > 0
      ? await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.senderAgentId, agentId),
              inArray(messages.channelId, visibleChannelIds),
              isNull(messages.deletedAt)
            )
          )
          .orderBy(desc(messages.createdAt))
          .limit(8)
      : [];

  const allChannelMap = new Map(allChannels.map((c) => [c.id, c]));
  const visibleBindings = bindingRows.filter((b) => visibleChannelMap.has(b.channelId));
  const bindingByChannel = new Map(visibleBindings.map((b) => [b.channelId, b]));
  const bindingBySession = new Map(bindingRows.map((b) => [b.sessionId, b]));

  const joinedChannels = memberRows
    .map((m) => {
      const ch = visibleChannelMap.get(m.channelId);
      if (!ch || ch.kind === 'dm') return null;
      const binding = bindingByChannel.get(ch.id);
      return {
        channelId: ch.id,
        name: ch.name,
        topic: ch.topic,
        kind: ch.kind as 'channel' | 'dm',
        autoReply: m.autoReply,
        sessionId: binding?.sessionId,
      };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  const boundSessionIds = new Set(visibleBindings.map((b) => b.sessionId));
  const hiddenDmSessionIds = new Set(
    bindingRows
      .filter((b) => {
        const ch = allChannelMap.get(b.channelId);
        return ch && !visibleChannelMap.has(ch.id);
      })
      .map((b) => b.sessionId)
  );
  const agentSessions = allSessions
    .filter(
      (s) =>
        !hiddenDmSessionIds.has(s.sessionId) &&
        (s.larkAppId === agentId || boundSessionIds.has(s.sessionId))
    )
    .map((s) => {
      const binding = bindingBySession.get(s.sessionId);
      const ch = binding ? visibleChannelMap.get(binding.channelId) : undefined;
      return {
        ...s,
        state: s.state || s.status,
        channelId: ch?.id,
        channelName: ch?.name,
        channelKind: ch?.kind,
      };
    });

  // Include bound sessions that might not be in live allSessions yet (e.g. closed/offline)
  const seenSessionIds = new Set(agentSessions.map((s) => s.sessionId));
  for (const b of visibleBindings) {
    if (!seenSessionIds.has(b.sessionId)) {
      const ch = visibleChannelMap.get(b.channelId);
      agentSessions.push({
        sessionId: b.sessionId,
        larkAppId: agentId,
        botName: resolvedAgent.defaultName,
        cliId: resolvedAgent.cliId || undefined,
        state: 'offline',
        title: ch ? `#${ch.name}` : b.sessionId,
        channelId: ch?.id,
        channelName: ch?.name,
        channelKind: ch?.kind,
      });
    }
  }

  const pendingAsks = allAsks.filter((a) => a.larkAppId === agentId);

  const recentMessages = recentMsgRows.map((m) => {
    const ch = visibleChannelMap.get(m.channelId);
    return {
      id: m.id,
      channelId: m.channelId,
      channelName: ch?.name || m.channelId,
      channelKind: ch?.kind || 'channel',
      content: m.content,
      botmuxSessionId: m.botmuxSessionId || undefined,
      createdAt: m.createdAt.getTime(),
    };
  });

  return {
    id: agentId,
    name: resolvedAgent.name,
    botName: resolvedAgent.defaultName,
    cliId: resolvedAgent.cliId || 'agent',
    adapterType: resolvedAgent.adapterType,
    capabilities: resolvedAgent.capabilities,
    webhookUrl: resolvedAgent.webhookUrl,
    status: resolvedAgent.online ? ('online' as const) : ('offline' as const),
    workingDir: resolvedAgent.workingDir,
    description: resolvedAgent.description ?? '',
    systemPrompt: resolvedAgent.systemPrompt ?? '',
    avatarUrl: resolvedAgent.avatarUrl ?? '',
    archived: resolvedAgent.archived,
    updatedAt: resolvedAgent.updatedAt,
    channels: joinedChannels,
    sessions: agentSessions,
    pendingAsks,
    recentMessages,
  };
}

function channelVisibleTo(channel: { kind: string; dmKey: string | null }, userId: string) {
  return channel.kind !== 'dm' || !channel.dmKey || channel.dmKey.split('|').includes(`u:${userId}`);
}

function channelBelongsToOrg(
  channel: { organizationId: string | null },
  organizationId?: string | null,
): boolean {
  if (!organizationId) return true;
  if (AUTH_REQUIRED) {
    return channel.organizationId === organizationId;
  }
  return !channel.organizationId || channel.organizationId === organizationId;
}

async function ensureOrgDefaultChannel(organizationId: string, createdByUserId: string) {
  const existing = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.organizationId, organizationId))
    .limit(1);
  if (existing.length > 0) return;
  await db
    .insert(channels)
    .values({
      name: 'general',
      topic: '团队与 Agent 实时协作频道',
      kind: 'channel',
      organizationId,
      createdByUserId,
    })
    .onConflictDoNothing();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageMentionsUser(content: string, userName?: string): boolean {
  if (!content) return false;
  if (/(?:^|[\s([{"'，。！？、])@(?:all|channel|here)(?=$|[\s)\]}"'，。！？、:：,.;!?])/i.test(content)) {
    return true;
  }
  const cleanName = userName?.trim();
  if (!cleanName) return false;
  const pattern = new RegExp(
    `(?:^|[\\s([{"'，。！？、])@${escapeRegExp(cleanName)}(?=$|[\\s)\\]}"'，。！？、:：,.;!?])`,
    'i'
  );
  return pattern.test(content);
}

async function listChannelsWithUnread(userId: string, organizationId?: string | null) {
  const [channelRows, readRows, threadReadRows, allMemberRows, userRows] = await Promise.all([
    db.select().from(channels).orderBy(asc(channels.createdAt)),
    db.select().from(channelReads).where(eq(channelReads.userId, userId)),
    db.select().from(threadReads).where(eq(threadReads.userId, userId)),
    db.select().from(channelMembers),
    db
      .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
      .from(authSchema.user)
      .where(eq(authSchema.user.id, userId)),
  ]);
  const currentUserName = userRows[0]
    ? resolveDisplayName(userRows[0].name, userRows[0].email)
    : undefined;
  const readMap = new Map(readRows.map((r) => [r.channelId, r]));
  const threadReadMap = new Map(threadReadRows.map((r) => [r.rootMessageId, r.lastReadAt]));
  const memberIdsByChannel = new Map<string, Set<string>>();
  for (const row of allMemberRows) {
    let set = memberIdsByChannel.get(row.channelId);
    if (!set) {
      set = new Set<string>();
      memberIdsByChannel.set(row.channelId, set);
    }
    if (row.userId) set.add(row.userId);
    if (row.agentId) set.add(row.agentId);
  }

  const visibleChannels = channelRows.filter((ch) => {
    if (!channelVisibleTo(ch, userId)) return false;
    if (!channelBelongsToOrg(ch, organizationId)) return false;
    const readRow = readMap.get(ch.id);
    if (readRow?.hidden) return false;
    return true;
  });

  const effectiveActivityAt = sql<Date>`CASE WHEN ${messages.card}->>'status' = 'completed' AND ${messages.updatedAt} IS NOT NULL THEN ${messages.updatedAt} ELSE ${messages.createdAt} END`;
  const notOwnMessage = sql`(${messages.senderUserId} IS NULL OR ${messages.senderUserId} <> ${userId})`;

  return Promise.all(
    visibleChannels.map(async (ch) => {
      const readRow = readMap.get(ch.id);
      const lastRead = readRow?.lastReadAt;
      const countWhere = lastRead
        ? and(
            eq(messages.channelId, ch.id),
            isNull(messages.threadId),
            isNull(messages.deletedAt),
            notOwnMessage,
            sql`${effectiveActivityAt} > ${lastRead}`
          )
        : and(
            eq(messages.channelId, ch.id),
            isNull(messages.threadId),
            isNull(messages.deletedAt),
            notOwnMessage
          );
      const [unreadTopRows, replyActivityRows] = await Promise.all([
        db
          .select({ content: messages.content })
          .from(messages)
          .where(countWhere),
        db
          .select({
            threadId: messages.threadId,
            content: messages.content,
            activityAt: effectiveActivityAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.channelId, ch.id),
              isNotNull(messages.threadId),
              isNull(messages.deletedAt),
              notOwnMessage
            )
          ),
      ]);
      const rawUnread = unreadTopRows.length;
      let mentionCount = 0;
      for (const topRow of unreadTopRows) {
        if (messageMentionsUser(topRow.content, currentUserName)) {
          mentionCount += 1;
        }
      }
      let threadUnreadCount = 0;
      for (const reply of replyActivityRows) {
        if (!reply.threadId) continue;
        const watermark = threadReadMap.get(reply.threadId) ?? lastRead;
        const activityTime = new Date(reply.activityAt).getTime();
        if (!watermark || activityTime > watermark.getTime()) {
          threadUnreadCount += 1;
          if (messageMentionsUser(reply.content, currentUserName)) {
            mentionCount += 1;
          }
        }
      }
      const markedUnread = Boolean(readRow?.markedUnread);
      const memberIds = new Set(memberIdsByChannel.get(ch.id) ?? []);
      if (ch.createdByUserId) memberIds.add(ch.createdByUserId);
      return {
        id: ch.id,
        name: ch.name,
        topic: ch.topic,
        kind: ch.kind as 'channel' | 'dm',
        replyMode: parseReplyMode(ch.replyMode, DEFAULT_REPLY_MODE),
        archived: Boolean(ch.archived),
        createdByUserId: ch.createdByUserId || undefined,
        dmKey: ch.dmKey || undefined,
        organizationId: ch.organizationId || undefined,
        memberIds: Array.from(memberIds),
        unreadCount: markedUnread ? Math.max(1, rawUnread) : rawUnread,
        threadUnreadCount,
        mentionCount,
        lastReadAt: lastRead ? lastRead.getTime() : undefined,
        muted: Boolean(readRow?.muted),
        markedUnread,
        starred: Boolean(readRow?.starred),
        groupId: readRow?.groupId || undefined,
        createdAt: ch.createdAt.getTime(),
      };
    })
  );
}

interface ReactionGroup {
  emoji: string;
  userIds: string[];
}

async function getReactionsForMessages(messageIds: string[]): Promise<Map<string, ReactionGroup[]>> {
  const map = new Map<string, ReactionGroup[]>();
  if (messageIds.length === 0) return map;

  const rows = await db
    .select()
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds))
    .orderBy(asc(messageReactions.createdAt));

  for (const r of rows) {
    let groups = map.get(r.messageId);
    if (!groups) {
      groups = [];
      map.set(r.messageId, groups);
    }
    let g = groups.find((x) => x.emoji === r.emoji);
    if (!g) {
      g = { emoji: r.emoji, userIds: [] };
      groups.push(g);
    }
    g.userIds.push(r.userId);
  }
  return map;
}

async function listPinnedMessages(channelId: string) {
  const pinRows = await db
    .select()
    .from(messagePins)
    .where(eq(messagePins.channelId, channelId))
    .orderBy(desc(messagePins.pinnedAt));
  if (pinRows.length === 0) return [];

  const msgRows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        inArray(
          messages.id,
          pinRows.map((p) => p.messageId)
        ),
        isNull(messages.deletedAt)
      )
    );
  const msgMap = new Map(msgRows.map((m) => [m.id, m]));
  return pinRows
    .map((p) => {
      const m = msgMap.get(p.messageId);
      if (!m) return null;
      return {
        ...formatMessageRow(m, 0, [], true),
        pinnedByUserId: p.pinnedByUserId,
        pinnedAt: p.pinnedAt.getTime(),
      };
    })
    .filter(Boolean);
}

function formatMessageRow(
  m: typeof messages.$inferSelect,
  replyCount = 0,
  reactions: ReactionGroup[] = [],
  pinned = false
) {
  return {
    id: m.id,
    channelId: m.channelId,
    threadId: m.threadId || undefined,
    replyToId: m.replyToId || undefined,
    senderId: m.senderAgentId || m.senderUserId || 'u-owner',
    senderRole: m.senderAgentId ? ('agent' as const) : ('human' as const),
    content: m.content,
    card: m.card || undefined,
    attachments: m.attachments || undefined,
    botmuxSessionId: m.botmuxSessionId || undefined,
    adapterMeta: m.adapterMeta || undefined,
    replyCount,
    reactions,
    pinned,
    createdAt: m.createdAt.getTime(),
    updatedAt: m.updatedAt?.getTime(),
  };
}

async function formatMessagesWithReplyPreviews(
  channelId: string,
  roots: (typeof messages.$inferSelect)[],
  userId?: string
) {
  if (roots.length === 0) return [];

  const rootIds = roots.map((root) => root.id);
  const threadCounts = db
    .select({ threadId: messages.threadId, replyCount: sql<number>`count(*)::int`.as('reply_count') })
    .from(messages)
    .where(
      and(eq(messages.channelId, channelId), inArray(messages.threadId, rootIds), isNull(messages.deletedAt))
    )
    .groupBy(messages.threadId)
    .as('threadCounts');

  const latestReplies = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.threadId, threadCounts.threadId),
        isNull(messages.deletedAt)
      )
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(THREAD_REPLY_PREVIEW_LIMIT)
    .as('latestReplies');

  const replyRows = await db
    .select()
    .from(threadCounts)
    .innerJoinLateral(latestReplies, sql`true`)
    .orderBy(asc(latestReplies.createdAt), asc(latestReplies.id));

  const messageIds = [...rootIds, ...replyRows.map((row) => row.latestReplies.id)];
  const effectiveActivityAt = sql<Date>`CASE WHEN ${messages.card}->>'status' = 'completed' AND ${messages.updatedAt} IS NOT NULL THEN ${messages.updatedAt} ELSE ${messages.createdAt} END`;
  const [reactionMap, pinRows, threadReadRows, channelReadRow, unreadCandidates] = await Promise.all([
    getReactionsForMessages(messageIds),
    db
      .select({ messageId: messagePins.messageId })
      .from(messagePins)
      .where(and(eq(messagePins.channelId, channelId), inArray(messagePins.messageId, messageIds))),
    userId
      ? db
          .select()
          .from(threadReads)
          .where(and(eq(threadReads.userId, userId), inArray(threadReads.rootMessageId, rootIds)))
      : Promise.resolve([]),
    userId
      ? db
          .select({ lastReadAt: channelReads.lastReadAt })
          .from(channelReads)
          .where(and(eq(channelReads.channelId, channelId), eq(channelReads.userId, userId)))
      : Promise.resolve([]),
    userId
      ? db
          .select({
            threadId: messages.threadId,
            activityAt: effectiveActivityAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.channelId, channelId),
              inArray(messages.threadId, rootIds),
              isNull(messages.deletedAt),
              sql`(${messages.senderUserId} IS NULL OR ${messages.senderUserId} <> ${userId})`
            )
          )
      : Promise.resolve([]),
  ]);
  const pinned = new Set(pinRows.map((pin) => pin.messageId));
  const threadReadMap = new Map(threadReadRows.map((r) => [r.rootMessageId, r.lastReadAt]));
  const channelLastRead = channelReadRow[0]?.lastReadAt;
  const unreadReplyCounts = new Map<string, number>();
  for (const item of unreadCandidates) {
    if (!item.threadId) continue;
    const watermark = threadReadMap.get(item.threadId) ?? channelLastRead;
    const activityTime = new Date(item.activityAt).getTime();
    if (!watermark || activityTime > watermark.getTime()) {
      unreadReplyCounts.set(item.threadId, (unreadReplyCounts.get(item.threadId) ?? 0) + 1);
    }
  }

  const summaries = new Map<
    string,
    { replyCount: number; replyPreviews: ReturnType<typeof formatMessageRow>[] }
  >();

  for (const { threadCounts: thread, latestReplies: reply } of replyRows) {
    if (!thread.threadId) continue;
    let summary = summaries.get(thread.threadId);
    if (!summary) {
      summary = { replyCount: thread.replyCount, replyPreviews: [] };
      summaries.set(thread.threadId, summary);
    }
    summary.replyPreviews.push(
      formatMessageRow(reply, 0, reactionMap.get(reply.id), pinned.has(reply.id))
    );
  }

  return roots.map((root) => {
    const summary = summaries.get(root.id);
    const unreadReplyCount = unreadReplyCounts.get(root.id) ?? 0;
    return {
      ...formatMessageRow(root, summary?.replyCount, reactionMap.get(root.id), pinned.has(root.id)),
      replyPreviews: summary?.replyPreviews ?? [],
      ...(unreadReplyCount > 0 ? { unreadReplyCount } : {}),
    };
  });
}

async function applyMessageProgress(
  row: typeof messages.$inferSelect,
  rawProgress: unknown,
): Promise<typeof messages.$inferSelect | null> {
  if (!row.card || row.card.status !== 'running') return null;
  const normalized = normalizeProgressSnapshot(rawProgress);
  if (!normalized) return null;
  if (progressSnapshotEquals(row.card.progress, normalized)) return null;

  const [updated] = await db
    .update(messages)
    .set({
      card: {
        ...row.card,
        progress: normalized,
      },
    })
    .where(and(
      eq(messages.id, row.id),
      isNull(messages.deletedAt),
      sql`${messages.card}->>'status' = 'running'`,
    ))
    .returning();

  if (updated) {
    const reactions = (await getReactionsForMessages([updated.id])).get(updated.id) || [];
    const orgId = await getChannelOrgId(updated.channelId);
    broadcast({ type: 'message.updated', payload: formatMessageRow(updated, 0, reactions) }, orgId);
    return updated;
  }
  return null;
}

async function reconcileBotmuxTurn(
  row: typeof messages.$inferSelect,
  getSessions: () => Promise<BotmuxSession[]>
) {
  const { botmuxSessionId: sessionId, senderAgentId: botId, channelId, card } = row;
  const triggerId = card?.summary?.slice(BOTMUX_TRIGGER_SUMMARY_PREFIX.length);
  if (!sessionId || !botId || !card || !triggerId) return;

  const age = Date.now() - (row.updatedAt ?? row.createdAt).getTime();
  // A transient lookup error must leave the row eligible for the next poll.
  const result = await botmuxAdapter.pollTriggerResult(sessionId, triggerId).catch(() => undefined);
  const bot = botmuxAdapter.getCachedBots().find((item) => item.larkAppId === botId);
  let latestProgress: AgentProgressSnapshot | undefined = card.progress;

  if (isLocalBotmux) {
    const extracted = await readTurnProgress({
      cliId: bot?.cliId,
      triggerId,
      botId,
      channelId,
      sessionId,
      createdAt: row.createdAt,
    }).catch(() => undefined);
    if (extracted) {
      latestProgress = extracted;
    }
  }

  let content: string | undefined;
  let status: MessageCardData['status'] = 'failed';
  let settled = false;

  if (result?.state === 'completed') {
    const trimmedOutput = result.output?.content?.trim() || '';
    const hasTools = Boolean(latestProgress && (latestProgress.toolCount > 0 || latestProgress.steps.length > 0));
    content = trimmedOutput || (hasTools ? '' : '（任务已完成，无文本输出）');
    status = 'completed';
    settled = true;
  } else if (result?.state === 'interrupted') {
    content = result.output?.content?.trim() || '';
    status = 'interrupted';
    settled = true;
  } else if (
    result?.state === 'failed' ||
    (result?.state === 'not_found' && age >= BOTMUX_RESULT_GRACE_MS)
  ) {
    content = result.error || '未能获取本轮回复';
    status = 'failed';
    settled = true;
  } else if (
    result?.state === 'running' && age >= BOTMUX_RESULT_GRACE_MS && isLocalBotmux &&
    (!bot || bot.cliId === 'antigravity')
  ) {
    // In Botmux's default reply mode, Antigravity can go idle without reporting a final.
    const session = (await getSessions()).find((item) => item.sessionId === sessionId);
    if (
      session?.larkAppId === botId && session.cliId === 'antigravity' &&
      session.state === 'idle' && !session.queued && !session.tuiPromptActive &&
      LOCAL_BOTMUX_BACKENDS.has(session.backendType ?? '')
    ) {
      const agyContent = await readAntigravityResult({ triggerId, botId, channelId, createdAt: row.createdAt });
      if (agyContent) {
        content = agyContent;
        status = 'completed';
        settled = true;
      }
    }
  }

  if (!settled && age >= BOTMUX_RESULT_TIMEOUT_MS) {
    content = '等待回复超时';
    status = 'timeout';
    settled = true;
  }
  if (!settled) {
    if (latestProgress) {
      await applyMessageProgress(row, latestProgress);
    }
    return;
  }

  const settledProgress = finalizeProgressSnapshot(
    latestProgress,
    status === 'completed' ? 'completed' : 'failed',
  );
  const finishedAt = Date.now();
  const startedAt = card.startedAt ?? row.createdAt.getTime();

  const [updated] = await db
    .update(messages)
    .set({
      content: content ?? '',
      card: {
        title: card.title,
        status,
        ...(card.parallel ? { parallel: true } : {}),
        startedAt,
        finishedAt,
        summary: status === 'completed' ? `Botmux turn completed (${triggerId})` : content || status,
        ...(settledProgress ? { progress: settledProgress } : {}),
      },
    })
    .where(and(
      eq(messages.id, row.id),
      eq(messages.botmuxSessionId, sessionId),
      isNull(messages.deletedAt),
      sql`${messages.card}->>'status' = 'running'`,
      sql`${messages.card}->>'summary' = ${card.summary}`
    ))
    .returning();
  if (updated) {
    const reactions = (await getReactionsForMessages([updated.id])).get(updated.id) || [];
    const orgId = await getChannelOrgId(updated.channelId);
    broadcast({ type: 'message.updated', payload: formatMessageRow(updated, 0, reactions) }, orgId);
    return true;
  }
}

async function pollBotmuxTurns() {
  if (!botmuxAdapter.isEnabled()) return;
  // The placeholder carries the accepted trigger so polling can resume on restart.
  const pending = await db.select().from(messages).where(and(
    isNull(messages.deletedAt),
    sql`${messages.card}->>'status' = 'running'`,
    sql`${messages.card}->>'summary' LIKE ${`${BOTMUX_TRIGGER_SUMMARY_PREFIX}%`}`
  ));
  let sessions: Promise<BotmuxSession[]> | undefined;
  const results = await Promise.allSettled(pending.map((row) =>
    reconcileBotmuxTurn(row, () => (sessions ??= botmuxAdapter.getSessions()))
  ));
  for (const result of results) {
    if (result.status === 'rejected') console.error('[Server] Botmux reply writeback failed:', result.reason);
  }
  if (results.some((result) => result.status === 'fulfilled' && result.value)) {
    await broadcastSessionsUpdated(await (sessions ?? botmuxAdapter.getSessions()));
  }
}

let botmuxPollRunning = false;
let botmuxPollQueued = false;

async function runBotmuxTurnPoll() {
  if (botmuxPollRunning) {
    botmuxPollQueued = true;
    return;
  }
  botmuxPollRunning = true;
  try {
    do {
      botmuxPollQueued = false;
      await pollBotmuxTurns();
    } while (botmuxPollQueued);
  } catch (err) {
    console.error('[Server] Botmux reply poll failed:', err);
  } finally {
    botmuxPollRunning = false;
  }
}

function scheduleBotmuxResultPoll() {
  setTimeout(() => {
    void runBotmuxTurnPoll().finally(scheduleBotmuxResultPoll);
  }, BOTMUX_RESULT_POLL_MS);
}

type AppEnv = {
  Variables: {
    authUserId: string | null;
    authOrgId: string | null;
  };
};

const trustedOriginSet = new Set(resolveTrustedOrigins({ port: PORT }));

const app = new Hono<AppEnv>();
app.use(
  '*',
  cors({
    origin: (origin) => (origin && trustedOriginSet.has(origin) ? origin : ''),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);

// Mount Better Auth endpoints directly (cookie + bearer + OTP + org + device + apiKey)
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Resolve Better Auth session once per /api/* request (excluding public & bot endpoints)
app.use('/api/*', async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  const isPublic =
    pathname.startsWith('/api/auth/') ||
    pathname === '/api/instance' ||
    pathname.startsWith('/api/bot/');

  if (isPublic) {
    c.set('authUserId', null);
    c.set('authOrgId', null);
    return next();
  }

  const identity = await resolveRequestIdentity({
    auth,
    headers: c.req.raw.headers,
    authRequired: AUTH_REQUIRED,
  });

  if (!identity) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('authUserId', identity.authenticated ? identity.userId : null);
  c.set('authOrgId', identity.organizationId);
  return next();
});

// Enforce Organization (Community) tenant isolation across all /api/channels/:channelId routes
async function enforceChannelOrgAccess(
  c: {
    get: <K extends keyof AppEnv['Variables']>(key: K) => AppEnv['Variables'][K];
    req: { param: (name: string) => string };
    json: (data: unknown, status?: 403) => Response;
  },
  next: () => Promise<void>,
) {
  const orgId = c.get('authOrgId');
  if (!orgId) return next();
  const channelId = c.req.param('channelId');
  if (!channelId || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(channelId)) {
    return next();
  }
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (ch && !channelBelongsToOrg(ch, orgId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return next();
}
app.use('/api/channels/:channelId', enforceChannelOrgAccess);
app.use('/api/channels/:channelId/*', enforceChannelOrgAccess);

function getRequestUserId(
  c: { get: <K extends keyof AppEnv['Variables']>(key: K) => AppEnv['Variables'][K] },
  fallback?: string | null,
): string {
  const authed = c.get('authUserId');
  if (authed) return authed;
  return fallback?.trim() || 'u-owner';
}

app.get('/health', async (c) => {
  const botmuxStatus = await dispatcher.checkBotmuxHealth();
  return c.json({
    status: 'ok',
    botmux: botmuxStatus,
    adapters: {
      botmux: { enabled: botmuxAdapter.isEnabled(), ...botmuxStatus },
      gateway: { connectedAgents: gatewayAdapter.getConnectedAgentIds().length },
    },
  });
});

app.get('/api/instance', async (c) => {
  const botmuxStatus = await dispatcher.checkBotmuxHealth();
  return c.json({
    name: process.env.BUBAI_INSTANCE_NAME || 'Bubai',
    version: '0.1.0',
    authRequired: AUTH_REQUIRED,
    emailAndPasswordEnabled: process.env.NODE_ENV !== 'production',
    publicUrl: process.env.PUBLIC_URL || undefined,
    botmux: {
      connected: botmuxStatus.connected,
      authenticated: botmuxStatus.authenticated,
      detail: botmuxStatus.detail,
    },
    capabilities: {
      terminalProxy: true,
      ws: true,
      botGateway: true,
      webhooks: true,
    },
  });
});

app.get('/api/bootstrap', async (c) => {
  const userId = getRequestUserId(c, c.req.query('userId'));
  const organizationId = c.get('authOrgId');
  await syncBotmuxAndSeedDefaults();
  if (organizationId) {
    await ensureOrgDefaultChannel(organizationId, userId);
  }
  const [channelList, participants, sessions, asks, botmuxStatus, groupRows] = await Promise.all([
    listChannelsWithUnread(userId, organizationId),
    listParticipants(organizationId),
    listSessionsForOrg(organizationId),
    listAsksForOrg(organizationId),
    dispatcher.checkBotmuxHealth(),
    db
      .select()
      .from(sidebarGroups)
      .where(eq(sidebarGroups.userId, userId))
      .orderBy(asc(sidebarGroups.createdAt)),
  ]);
  return c.json({
    channels: channelList,
    participants,
    sessions,
    asks,
    botmuxStatus,
    sidebarGroups: groupRows.map((g) => ({ id: g.id, name: g.name })),
    auth: {
      required: AUTH_REQUIRED,
      authenticated: Boolean(c.get('authUserId')),
      userId,
      organizationId,
    },
  });
});

/** Cursor-paginated root messages with reply previews, reactions, and pin state. */
app.get('/api/channels/:channelId/messages', async (c) => {
  const channelId = c.req.param('channelId');
  const beforeRaw = c.req.query('before');
  const beforeId = c.req.query('beforeId');
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 50), 1), 100);

  const conditions = [
    eq(messages.channelId, channelId),
    isNull(messages.threadId),
    isNull(messages.deletedAt),
  ];
  if (beforeRaw) {
    const beforeMs = Number(beforeRaw);
    const beforeDate = Number.isFinite(beforeMs) ? new Date(beforeMs) : new Date(beforeRaw);
    if (!Number.isNaN(beforeDate.getTime())) {
      conditions.push(
        beforeId && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(beforeId)
          ? sql`(${messages.createdAt}, ${messages.id}) < (
              SELECT anchor.created_at, anchor.id FROM ${messages} AS anchor
              WHERE anchor.id = ${beforeId}::uuid AND anchor.channel_id = ${channelId}::uuid
            )`
          : lt(messages.createdAt, beforeDate)
      );
    }
  }

  const rowsDesc = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);

  const hasMore = rowsDesc.length > limit;
  const pageRows = (hasMore ? rowsDesc.slice(0, limit) : rowsDesc).reverse();

  const userId = getRequestUserId(c, c.req.query('userId'));
  return c.json({
    messages: await formatMessagesWithReplyPreviews(channelId, pageRows, userId),
    hasMore,
    nextCursor: hasMore && pageRows[0] ? pageRows[0].createdAt.getTime() : null,
    nextCursorId: hasMore ? pageRows[0]?.id : undefined,
  });
});

app.get('/api/activity', async (c) => {
  const userId = getRequestUserId(c, c.req.query('userId'));
  const organizationId = c.get('authOrgId');
  const [channelRows, readRows, threadReadRows, userRows, profileRows] = await Promise.all([
    db.select().from(channels).orderBy(asc(channels.createdAt)),
    db.select().from(channelReads).where(eq(channelReads.userId, userId)),
    db.select().from(threadReads).where(eq(threadReads.userId, userId)),
    db
      .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
      .from(authSchema.user),
    db
      .select({
        id: agentProfiles.agentId,
        displayName: agentProfiles.displayName,
        defaultName: agentProfiles.defaultName,
      })
      .from(agentProfiles),
  ]);

  const userNameMap = new Map(userRows.map((u) => [u.id, resolveDisplayName(u.name, u.email)]));
  const botNameMap = new Map<string, string>();
  for (const p of profileRows) {
    botNameMap.set(p.id, p.displayName?.trim() || p.defaultName?.trim() || p.id);
  }
  const currentUserName = userNameMap.get(userId);
  const readMap = new Map(readRows.map((r) => [r.channelId, r]));
  const threadReadMap = new Map(threadReadRows.map((r) => [r.rootMessageId, r.lastReadAt]));

  const activeChannels = channelRows.filter((ch) => {
    if (ch.archived || !channelVisibleTo(ch, userId) || !channelBelongsToOrg(ch, organizationId)) {
      return false;
    }
    const readRow = readMap.get(ch.id);
    if (readRow?.hidden || readRow?.muted) return false;
    return true;
  });

  if (activeChannels.length === 0) {
    return c.json({ totalUnread: 0, items: [] });
  }

  const channelMap = new Map(activeChannels.map((ch) => [ch.id, ch]));
  const effectiveActivityAt = sql<Date>`CASE WHEN ${messages.card}->>'status' = 'completed' AND ${messages.updatedAt} IS NOT NULL THEN ${messages.updatedAt} ELSE ${messages.createdAt} END`;
  const rows = await db
    .select({
      msg: messages,
      activityAt: effectiveActivityAt,
    })
    .from(messages)
    .where(
      and(
        inArray(messages.channelId, activeChannels.map((ch) => ch.id)),
        isNull(messages.deletedAt),
        sql`(${messages.senderUserId} IS NULL OR ${messages.senderUserId} <> ${userId})`
      )
    )
    .orderBy(desc(effectiveActivityAt))
    .limit(300);

  const senderNameFor = (m: typeof messages.$inferSelect) =>
    m.senderUserId
      ? userNameMap.get(m.senderUserId) || m.senderUserId
      : m.senderAgentId
        ? botNameMap.get(m.senderAgentId) || m.senderAgentId
        : 'Unknown';

  type ActivityDto = {
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
    message: ReturnType<typeof formatMessageRow>;
  };

  const items: ActivityDto[] = [];
  const threadGroups = new Map<
    string,
    { latest: typeof messages.$inferSelect; activityMs: number; count: number; hasMention: boolean }
  >();

  for (const { msg, activityAt } of rows) {
    const ch = channelMap.get(msg.channelId);
    if (!ch) continue;
    const channelLastRead = readMap.get(ch.id)?.lastReadAt;
    const activityMs = new Date(activityAt).getTime();

    if (msg.threadId) {
      const watermark = threadReadMap.get(msg.threadId) ?? channelLastRead;
      if (watermark && activityMs <= watermark.getTime()) continue;
      const isMention = messageMentionsUser(msg.content, currentUserName);
      const existing = threadGroups.get(msg.threadId);
      if (!existing) {
        threadGroups.set(msg.threadId, {
          latest: msg,
          activityMs,
          count: 1,
          hasMention: isMention,
        });
      } else {
        existing.count += 1;
        if (isMention) existing.hasMention = true;
      }
      if (isMention) {
        items.push({
          id: `mention:${msg.id}`,
          kind: 'mention',
          channelId: ch.id,
          channelName: ch.kind === 'dm' ? ch.topic || ch.name : ch.name,
          channelKind: ch.kind as 'channel' | 'dm',
          threadId: msg.threadId,
          messageId: msg.id,
          senderName: senderNameFor(msg),
          excerpt: msg.content.trim().slice(0, 140) || '[Attachment]',
          unreadCount: 1,
          createdAt: activityMs,
          message: formatMessageRow(msg),
        });
      }
    } else {
      if (channelLastRead && activityMs <= channelLastRead.getTime()) continue;
      const isMention = messageMentionsUser(msg.content, currentUserName);
      if (isMention || ch.kind === 'dm') {
        items.push({
          id: `${isMention ? 'mention' : 'dm'}:${msg.id}`,
          kind: isMention ? 'mention' : 'dm',
          channelId: ch.id,
          channelName: ch.kind === 'dm' ? ch.topic || ch.name : ch.name,
          channelKind: ch.kind as 'channel' | 'dm',
          messageId: msg.id,
          senderName: senderNameFor(msg),
          excerpt: msg.content.trim().slice(0, 140) || '[Attachment]',
          unreadCount: 1,
          createdAt: activityMs,
          message: formatMessageRow(msg),
        });
      }
    }
  }

  for (const [rootId, group] of threadGroups) {
    const ch = channelMap.get(group.latest.channelId);
    if (!ch) continue;
    items.push({
      id: `thread:${rootId}`,
      kind: 'thread',
      channelId: ch.id,
      channelName: ch.kind === 'dm' ? ch.topic || ch.name : ch.name,
      channelKind: ch.kind as 'channel' | 'dm',
      threadId: rootId,
      messageId: group.latest.id,
      senderName: senderNameFor(group.latest),
      excerpt: group.latest.content.trim().slice(0, 140) || '[Attachment]',
      unreadCount: group.count,
      createdAt: group.activityMs,
      message: formatMessageRow(group.latest),
    });
  }

  items.sort((a, b) => b.createdAt - a.createdAt);
  return c.json({
    totalUnread: items.length,
    items: items.slice(0, 50),
  });
});

app.get('/api/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const channelId = c.req.query('channelId');
  const userId = getRequestUserId(c, c.req.query('userId'));
  const organizationId = c.get('authOrgId');
  if (!q) return c.json({ results: [] });

  const searchChannels = await db
    .select({
      id: channels.id,
      kind: channels.kind,
      dmKey: channels.dmKey,
      organizationId: channels.organizationId,
    })
    .from(channels)
    .where(channelId ? eq(channels.id, channelId) : undefined);
  const allowed = searchChannels.filter(
    (channel) => channelVisibleTo(channel, userId) && channelBelongsToOrg(channel, organizationId),
  );
  if (!allowed.length) return c.json({ results: [] });

  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;

  const rows = await db
    .select()
    .from(messages)
    .where(and(
      isNull(messages.deletedAt),
      ilike(messages.content, pattern),
      inArray(messages.channelId, allowed.map((channel) => channel.id))
    ))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(30);

  return c.json({
    results: rows.map((m) => formatMessageRow(m)),
  });
});

/** Pinned Messages (agentes-chat pins) */
app.get('/api/channels/:channelId/pins', async (c) => {
  const channelId = c.req.param('channelId');
  const pins = await listPinnedMessages(channelId);
  return c.json({ pins });
});

app.post('/api/channels/:channelId/pins', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{ messageId?: string; userId?: string }>();
  if (!body.messageId) return c.json({ error: 'messageId required' }, 400);

  await db
    .insert(messagePins)
    .values({
      channelId,
      messageId: body.messageId,
      pinnedByUserId: getRequestUserId(c, body.userId),
    })
    .onConflictDoNothing();

  const pins = await listPinnedMessages(channelId);
  const orgId = await getChannelOrgId(channelId);
  broadcast({ type: 'pins.updated', payload: { channelId, pins } }, orgId);
  return c.json({ pins });
});

app.delete('/api/channels/:channelId/pins/:messageId', async (c) => {
  const channelId = c.req.param('channelId');
  const messageId = c.req.param('messageId');
  await db
    .delete(messagePins)
    .where(and(eq(messagePins.channelId, channelId), eq(messagePins.messageId, messageId)));

  const pins = await listPinnedMessages(channelId);
  const orgId = await getChannelOrgId(channelId);
  broadcast({ type: 'pins.updated', payload: { channelId, pins } }, orgId);
  return c.json({ pins });
});

/** Healthcheck endpoint for Docker / reverse proxy */
app.get('/healthz', (c) =>
  c.json({ ok: true, db: dbDriver, storage: uploadStorage.driver }),
);

/** File / Image Attachment Upload & Serving (S3 when configured, local disk fallback) */
app.post('/api/uploads', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'Missing file field' }, 400);
  }
  const id = randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]+/g, '_').slice(0, 120);
  const storedName = `${id}-${safeName}`;
  const mimeType = file.type || 'application/octet-stream';
  const bytes = await file.arrayBuffer();
  const { url } = await uploadStorage.put(storedName, bytes, mimeType);

  await db
    .insert(uploads)
    .values({
      storedName,
      organizationId: c.get('authOrgId'),
      uploadedByUserId: c.get('authUserId'),
      mimeType,
    })
    .onConflictDoNothing();

  const attachment: MessageAttachment = {
    id,
    name: file.name,
    mimeType,
    size: file.size,
    url,
  };
  return c.json({ attachment }, 201);
});

app.get('/api/uploads/:filename', async (c) => {
  const filename = path.basename(c.req.param('filename'));
  const authOrgId = c.get('authOrgId');
  const authUserId = c.get('authUserId');
  if (authOrgId) {
    const [meta] = await db
      .select()
      .from(uploads)
      .where(eq(uploads.storedName, filename))
      .limit(1);
    if (
      meta?.organizationId &&
      meta.organizationId !== authOrgId &&
      meta.uploadedByUserId !== authUserId
    ) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }
  const res = await uploadStorage.get(filename);
  if (!res) {
    return c.json({ error: 'File not found' }, 404);
  }
  return res;
});

app.get('/api/channels/:channelId/threads/:rootMessageId/preview', async (c) => {
  const channelId = c.req.param('channelId');
  const rootMessageId = c.req.param('rootMessageId');
  const [root] = await db
    .select()
    .from(messages)
    .where(and(
      eq(messages.channelId, channelId),
      eq(messages.id, rootMessageId),
      isNull(messages.threadId),
      isNull(messages.deletedAt)
    ));
  if (!root) return c.json({ error: 'Thread root not found' }, 404);

  const [{ replyCount, replyPreviews }] = await formatMessagesWithReplyPreviews(channelId, [root]);
  return c.json({ replyCount, replyPreviews });
});

/** Thread detail */
app.get('/api/channels/:channelId/threads/:rootMessageId', async (c) => {
  const channelId = c.req.param('channelId');
  const rootMessageId = c.req.param('rootMessageId');
  const [root] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.id, rootMessageId),
        isNull(messages.deletedAt)
      )
    );
  if (!root) return c.json({ error: 'Thread root not found' }, 404);

  const replies = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.threadId, rootMessageId),
        isNull(messages.deletedAt)
      )
    )
    .orderBy(asc(messages.createdAt));

  const [reactionMap, pinRows] = await Promise.all([
    getReactionsForMessages([root.id, ...replies.map((r) => r.id)]),
    db.select({ messageId: messagePins.messageId }).from(messagePins)
      .where(eq(messagePins.channelId, channelId)),
  ]);
  const pinned = new Set(pinRows.map((pin) => pin.messageId));

  return c.json({
    root: formatMessageRow(root, replies.length, reactionMap.get(root.id) || [], pinned.has(root.id)),
    replies: replies.map((r) => formatMessageRow(r, 0, reactionMap.get(r.id) || [], pinned.has(r.id))),
  });
});

app.patch('/api/messages/:messageId', async (c) => {
  const messageId = c.req.param('messageId');
  const userId = getRequestUserId(c);
  const organizationId = c.get('authOrgId');
  const body = await c.req.json<{ content?: string }>();
  const content = body.content?.trim();
  if (!content) return c.json({ error: 'Content required' }, 400);

  const [existing] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)));
  if (!existing) return c.json({ error: 'Message not found' }, 404);
  const [ch] = await db.select().from(channels).where(eq(channels.id, existing.channelId));
  if (!ch || !channelVisibleTo(ch, userId) || !channelBelongsToOrg(ch, organizationId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (existing.senderUserId && existing.senderUserId !== userId) {
    return c.json({ error: 'Only the message author can edit this message' }, 403);
  }

  const [updated] = await db
    .update(messages)
    .set({ content, updatedAt: new Date() })
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .returning();
  if (!updated) return c.json({ error: 'Message not found' }, 404);

  const rx = (await getReactionsForMessages([updated.id])).get(updated.id) || [];
  const dto = formatMessageRow(updated, 0, rx);
  broadcast({ type: 'message.updated', payload: dto }, ch.organizationId);
  return c.json({ message: dto });
});

app.delete('/api/messages/:messageId', async (c) => {
  const messageId = c.req.param('messageId');
  const userId = getRequestUserId(c);
  const organizationId = c.get('authOrgId');
  const [existing] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)));
  if (!existing) return c.json({ error: 'Message not found' }, 404);
  const [ch] = await db.select().from(channels).where(eq(channels.id, existing.channelId));
  if (!ch || !channelVisibleTo(ch, userId) || !channelBelongsToOrg(ch, organizationId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (existing.senderUserId && existing.senderUserId !== userId) {
    return c.json({ error: 'Only the message author can delete this message' }, 403);
  }

  const [deleted] = await db
    .update(messages)
    .set({ deletedAt: new Date() })
    .where(eq(messages.id, messageId))
    .returning();
  if (!deleted) return c.json({ error: 'Message not found' }, 404);

  broadcast(
    {
      type: 'message.deleted',
      payload: {
        id: deleted.id,
        channelId: deleted.channelId,
        threadId: deleted.threadId || undefined,
      },
    },
    ch.organizationId,
  );
  return c.json({ ok: true, id: deleted.id });
});

app.post('/api/messages/:messageId/reactions', async (c) => {
  const messageId = c.req.param('messageId');
  const organizationId = c.get('authOrgId');
  const body = await c.req.json<{ userId?: string; emoji?: string }>();
  const userId = getRequestUserId(c, body.userId);
  const emoji = body.emoji?.trim();
  if (!emoji) return c.json({ error: 'Emoji required' }, 400);

  const [targetMsg] = await db
    .select({ id: messages.id, channelId: messages.channelId })
    .from(messages)
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)));
  if (!targetMsg) return c.json({ error: 'Message not found' }, 404);
  const [ch] = await db.select().from(channels).where(eq(channels.id, targetMsg.channelId));
  if (!ch || !channelVisibleTo(ch, userId) || !channelBelongsToOrg(ch, organizationId)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const existing = await db
    .select()
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, userId),
        eq(messageReactions.emoji, emoji)
      )
    );

  if (existing.length > 0) {
    await db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, userId),
          eq(messageReactions.emoji, emoji)
        )
      );
  } else {
    await db.insert(messageReactions).values({ messageId, userId, emoji });
  }

  const reactions = (await getReactionsForMessages([messageId])).get(messageId) || [];
  broadcast({ type: 'reaction.updated', payload: { messageId, reactions } }, ch.organizationId);
  return c.json({ messageId, reactions });
});

app.post('/api/channels/:channelId/read', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req
    .json<{ userId?: string; includeThreads?: boolean }>()
    .catch(() => ({ userId: undefined, includeThreads: false }));
  const userId = getRequestUserId(c, body.userId);
  const now = new Date();
  const [existingRead] = await db
    .select({ lastReadAt: channelReads.lastReadAt })
    .from(channelReads)
    .where(and(eq(channelReads.channelId, channelId), eq(channelReads.userId, userId)));
  const prevLastRead = existingRead?.lastReadAt;

  if (body.includeThreads) {
    const threadRows = await db
      .selectDistinct({ threadId: messages.threadId })
      .from(messages)
      .where(and(eq(messages.channelId, channelId), isNotNull(messages.threadId), isNull(messages.deletedAt)));
    for (const row of threadRows) {
      if (!row.threadId) continue;
      await db
        .insert(threadReads)
        .values({ channelId, rootMessageId: row.threadId, userId, lastReadAt: now })
        .onConflictDoUpdate({
          target: [threadReads.rootMessageId, threadReads.userId],
          set: { lastReadAt: now },
        });
    }
  } else if (prevLastRead) {
    // Preserve independent thread unread state for threads that already had unread replies
    // before entering this channel so opening the channel only clears top-level unread.
    const effectiveActivityAt = sql<Date>`CASE WHEN ${messages.card}->>'status' = 'completed' AND ${messages.updatedAt} IS NOT NULL THEN ${messages.updatedAt} ELSE ${messages.createdAt} END`;
    const unreadThreadRows = await db
      .selectDistinct({ threadId: messages.threadId })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          isNotNull(messages.threadId),
          isNull(messages.deletedAt),
          sql`(${messages.senderUserId} IS NULL OR ${messages.senderUserId} <> ${userId})`,
          sql`${effectiveActivityAt} > ${prevLastRead}`
        )
      );
    for (const row of unreadThreadRows) {
      if (!row.threadId) continue;
      await db
        .insert(threadReads)
        .values({ channelId, rootMessageId: row.threadId, userId, lastReadAt: prevLastRead })
        .onConflictDoNothing();
    }
  }

  await db
    .insert(channelReads)
    .values({ channelId, userId, lastReadAt: now, markedUnread: false, hidden: false })
    .onConflictDoUpdate({
      target: [channelReads.channelId, channelReads.userId],
      set: { lastReadAt: now, markedUnread: false, hidden: false },
    });
  return c.json({ ok: true, channelId, userId, lastReadAt: now.getTime() });
});

app.post('/api/channels/:channelId/threads/:rootMessageId/read', async (c) => {
  const channelId = c.req.param('channelId');
  const rootMessageId = c.req.param('rootMessageId');
  const body = await c.req.json<{ userId?: string }>().catch(() => ({ userId: undefined }));
  const userId = getRequestUserId(c, body.userId);
  const now = new Date();
  await db
    .insert(threadReads)
    .values({ channelId, rootMessageId, userId, lastReadAt: now })
    .onConflictDoUpdate({
      target: [threadReads.rootMessageId, threadReads.userId],
      set: { lastReadAt: now },
    });
  return c.json({ ok: true, channelId, rootMessageId, userId, lastReadAt: now.getTime() });
});

app.post('/api/channels/:channelId/unread', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{ userId?: string }>().catch(() => ({ userId: undefined }));
  const userId = getRequestUserId(c, body.userId);
  await db
    .insert(channelReads)
    .values({ channelId, userId, markedUnread: true })
    .onConflictDoUpdate({
      target: [channelReads.channelId, channelReads.userId],
      set: { markedUnread: true },
    });
  return c.json({ ok: true, channelId, userId, markedUnread: true });
});

app.post('/api/channels/:channelId/mute', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{ userId?: string; muted?: boolean }>();
  const userId = getRequestUserId(c, body.userId);
  const muted = Boolean(body.muted);
  await db
    .insert(channelReads)
    .values({ channelId, userId, muted })
    .onConflictDoUpdate({
      target: [channelReads.channelId, channelReads.userId],
      set: { muted },
    });
  return c.json({ ok: true, channelId, userId, muted });
});

app.post('/api/channels/:channelId/hide', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{ userId?: string; hidden?: boolean }>();
  const userId = getRequestUserId(c, body.userId);
  const hidden = body.hidden !== undefined ? Boolean(body.hidden) : true;
  await db
    .insert(channelReads)
    .values({ channelId, userId, hidden })
    .onConflictDoUpdate({
      target: [channelReads.channelId, channelReads.userId],
      set: { hidden },
    });
  return c.json({ ok: true, channelId, userId, hidden });
});

app.post('/api/channels/:channelId/placement', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{
    userId?: string;
    starred?: boolean;
    groupId?: string | null;
  }>();
  const userId = getRequestUserId(c, body.userId);
  const [existing] = await db
    .select()
    .from(channelReads)
    .where(and(eq(channelReads.channelId, channelId), eq(channelReads.userId, userId)));

  const nextStarred = body.starred !== undefined ? Boolean(body.starred) : Boolean(existing?.starred);
  const nextGroupId =
    body.groupId !== undefined ? (body.groupId ? body.groupId : null) : (existing?.groupId ?? null);

  await db
    .insert(channelReads)
    .values({ channelId, userId, starred: nextStarred, groupId: nextGroupId })
    .onConflictDoUpdate({
      target: [channelReads.channelId, channelReads.userId],
      set: { starred: nextStarred, groupId: nextGroupId },
    });
  return c.json({ ok: true, channelId, userId, starred: nextStarred, groupId: nextGroupId });
});

app.patch('/api/channels/:channelId/archive', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{ userId?: string; archived?: boolean }>();
  const userId = getRequestUserId(c, body.userId);
  const archived = Boolean(body.archived);

  const [existing] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!existing) return c.json({ error: 'Channel not found' }, 404);
  if (existing.kind === 'dm') {
    return c.json({ error: 'Direct messages cannot be archived; use hide instead' }, 400);
  }
  if (existing.createdByUserId && existing.createdByUserId !== userId) {
    return c.json({ error: 'Only the channel creator can archive or unarchive this channel' }, 403);
  }

  const [updated] = await db
    .update(channels)
    .set({ archived })
    .where(eq(channels.id, channelId))
    .returning();

  const dto = {
    id: updated.id,
    name: updated.name,
    topic: updated.topic,
    kind: updated.kind as 'channel' | 'dm',
    replyMode: parseReplyMode(updated.replyMode, DEFAULT_REPLY_MODE),
    archived: Boolean(updated.archived),
    createdByUserId: updated.createdByUserId || undefined,
    createdAt: updated.createdAt.getTime(),
  };
  broadcast({ type: 'channel.updated', payload: dto }, updated.organizationId);
  return c.json({ channel: dto });
});

app.delete('/api/channels/:channelId', async (c) => {
  const channelId = c.req.param('channelId');
  const userId = getRequestUserId(c, c.req.query('userId'));

  const [existing] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!existing) return c.json({ error: 'Channel not found' }, 404);
  if (existing.kind === 'dm') {
    return c.json({ error: 'Direct messages cannot be deleted; use hide instead' }, 400);
  }
  if (existing.createdByUserId && existing.createdByUserId !== userId) {
    return c.json({ error: 'Only the channel creator can delete this channel' }, 403);
  }

  await db.delete(channels).where(eq(channels.id, channelId));
  broadcast({ type: 'channel.deleted', payload: { id: channelId } }, existing.organizationId);
  return c.json({ ok: true, id: channelId });
});

app.post('/api/sidebar-groups', async (c) => {
  const body = await c.req.json<{ userId?: string; name?: string }>();
  const userId = getRequestUserId(c, body.userId);
  const name = (body.name || '').trim().slice(0, 60);
  if (!name) return c.json({ error: 'Group name required' }, 400);
  const [created] = await db
    .insert(sidebarGroups)
    .values({ userId, name })
    .returning();
  return c.json({ group: { id: created.id, name: created.name } }, 201);
});

app.patch('/api/sidebar-groups/:groupId', async (c) => {
  const groupId = c.req.param('groupId');
  const body = await c.req.json<{ userId?: string; name?: string }>();
  const userId = getRequestUserId(c, body.userId);
  const name = (body.name || '').trim().slice(0, 60);
  if (!name) return c.json({ error: 'Group name required' }, 400);
  const [updated] = await db
    .update(sidebarGroups)
    .set({ name })
    .where(and(eq(sidebarGroups.id, groupId), eq(sidebarGroups.userId, userId)))
    .returning();
  if (!updated) return c.json({ error: 'Group not found' }, 404);
  return c.json({ group: { id: updated.id, name: updated.name } });
});

app.delete('/api/sidebar-groups/:groupId', async (c) => {
  const groupId = c.req.param('groupId');
  const userId = getRequestUserId(c, c.req.query('userId'));
  await db
    .update(channelReads)
    .set({ groupId: null })
    .where(and(eq(channelReads.userId, userId), eq(channelReads.groupId, groupId)));
  await db
    .delete(sidebarGroups)
    .where(and(eq(sidebarGroups.id, groupId), eq(sidebarGroups.userId, userId)));
  return c.json({ ok: true, id: groupId });
});

app.post('/api/channels', async (c) => {
  const body = await c.req.json<{ name?: string; topic?: string; userId?: string }>();
  const cleanName = (body.name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-');
  if (!cleanName) return c.json({ error: 'Channel name required' }, 400);

  let created: typeof channels.$inferSelect;
  try {
    const [row] = await db
      .insert(channels)
      .values({
        name: cleanName,
        topic: body.topic?.trim() || '',
        kind: 'channel',
        organizationId: c.get('authOrgId'),
        createdByUserId: getRequestUserId(c, body.userId),
      })
      .returning();
    created = row;
  } catch (err) {
    const pgCode =
      (err as { code?: string; cause?: { code?: string } })?.code ||
      (err as { cause?: { code?: string } })?.cause?.code;
    if (pgCode === '23505') {
      const [existing] = await db
        .select({ archived: channels.archived })
        .from(channels)
        .where(eq(channels.name, cleanName));
      return c.json(
        {
          error: existing?.archived
            ? `频道「${cleanName}」已存在（位于已归档频道中）`
            : `频道「${cleanName}」已存在`,
        },
        409
      );
    }
    throw err;
  }

  const dto = {
    id: created.id,
    name: created.name,
    topic: created.topic,
    kind: 'channel' as const,
    replyMode: parseReplyMode(created.replyMode, DEFAULT_REPLY_MODE),
    unreadCount: 0,
    createdAt: created.createdAt.getTime(),
  };
  broadcast({ type: 'channel.created', payload: dto }, created.organizationId);
  return c.json({ channel: dto }, 201);
});

app.patch('/api/channels/:channelId/settings', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{
    userId?: string;
    name?: string;
    topic?: string;
    replyMode?: string;
  }>();
  const [existing] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!existing) return c.json({ error: 'Channel not found' }, 404);
  if (
    body.replyMode !== undefined &&
    !(REPLY_MODES as readonly string[]).includes(body.replyMode)
  ) {
    return c.json(
      { error: `replyMode must be one of ${REPLY_MODES.join(', ')}` },
      400
    );
  }

  const updates: Partial<typeof channels.$inferInsert> = {};
  if (body.name !== undefined) {
    const cleanName = body.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-');
    if (!cleanName) return c.json({ error: 'Channel name required' }, 400);
    updates.name = cleanName;
  }
  if (body.topic !== undefined) {
    updates.topic = body.topic.trim().slice(0, 280);
  }
  if (body.replyMode !== undefined) {
    updates.replyMode = body.replyMode;
  }

  let updated = existing;
  if (Object.keys(updates).length > 0) {
    try {
      const [row] = await db
        .update(channels)
        .set(updates)
        .where(eq(channels.id, channelId))
        .returning();
      if (row) updated = row;
    } catch {
      return c.json({ error: 'Channel name already exists' }, 409);
    }
  }

  const dto = {
    id: updated.id,
    name: updated.name,
    topic: updated.topic,
    kind: updated.kind as 'channel' | 'dm',
    replyMode: parseReplyMode(updated.replyMode, DEFAULT_REPLY_MODE),
    archived: Boolean(updated.archived),
    createdByUserId: updated.createdByUserId || undefined,
    dmKey: updated.dmKey || undefined,
    createdAt: updated.createdAt.getTime(),
  };
  broadcast({ type: 'channel.updated', payload: dto }, updated.organizationId);
  return c.json({ channel: dto });
});

async function isBotChannelMember(channelId: string, botId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, botId)))
    .limit(1);
  return Boolean(row);
}

/** Explicit outbound endpoint for Bots / automated tasks to post into main timeline or a Thread */
app.post('/api/bot/messages', async (c) => {
  const botAuth = await verifyBotRequest(auth, c.req.raw.headers, BUZZ_BOT_TOKEN, null, AUTH_REQUIRED);
  if (!botAuth.ok) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json<{
    botId?: string;
    channelId?: string;
    channelName?: string;
    content?: string;
    threadId?: string | null;
    replyToId?: string | null;
    messageId?: string | null;
    attachments?: MessageAttachment[];
    botmuxSessionId?: string;
    adapterMeta?: Record<string, unknown>;
  }>();

  const rawBotRef = body.botId?.trim() || (botAuth.method === 'bot-key' ? botAuth.botUserId : undefined);
  const rawChannelId = body.channelId?.trim();
  const rawChannelName = body.channelName?.trim().replace(/^#/, '');
  const trimmed = (body.content || '').trim();
  const hasFiles = Array.isArray(body.attachments) && body.attachments.length > 0;

  if (!rawBotRef || (!rawChannelId && !rawChannelName)) {
    return c.json({ error: 'botId and channelId (or channelName) are required' }, 400);
  }
  if (!trimmed && !hasFiles) {
    return c.json({ error: 'content or attachments required' }, 400);
  }

  let knownAgents = await dispatcher.listAgents();
  if (knownAgents.length === 0 && botmuxAdapter.isEnabled()) {
    await dispatcher.syncBotmuxAgents();
    knownAgents = await dispatcher.listAgents();
  }
  const matchedAgent = knownAgents.find(
    (a) =>
      a.id === rawBotRef ||
      a.externalId === rawBotRef ||
      a.name.toLowerCase() === rawBotRef.toLowerCase() ||
      a.defaultName.toLowerCase() === rawBotRef.toLowerCase()
  );
  const botId = matchedAgent?.id || rawBotRef;
  if (botAuth.method === 'bot-key' && botAuth.botUserId && botId !== botAuth.botUserId) {
    return c.json({ error: 'Forbidden: bot key does not match botId' }, 403);
  }

  const [channelRow] = rawChannelId
    ? await db.select().from(channels).where(eq(channels.id, rawChannelId))
    : await db.select().from(channels).where(eq(channels.name, rawChannelName!));
  if (!channelRow) {
    return c.json({ error: 'Channel not found' }, 404);
  }
  if (channelRow.archived) {
    return c.json({ error: 'Channel is archived' }, 400);
  }
  if (botAuth.method === 'bot-key' && !(await isBotChannelMember(channelRow.id, botId))) {
    return c.json({ error: 'Forbidden: agent is not a member of this channel' }, 403);
  }

  const resolvedThreadId = body.threadId ? body.threadId.trim() : null;
  const resolvedReplyToId = resolvedThreadId && body.replyToId ? body.replyToId.trim() : null;
  const requestedMessageId = body.messageId ? body.messageId.trim() : null;
  const requestedSessionId = body.botmuxSessionId ? body.botmuxSessionId.trim() : null;

  // If this outbound message corresponds to an active running placeholder for this bot/channel,
  // settle that placeholder in place so we never leave an orphaned "执行中" card or duplicate reply.
  const placeholderConditions = [
    eq(messages.channelId, channelRow.id),
    eq(messages.senderAgentId, botId),
    isNull(messages.deletedAt),
    sql`${messages.card}->>'status' = 'running'`,
  ];
  if (requestedMessageId) {
    placeholderConditions.push(eq(messages.id, requestedMessageId));
  } else {
    if (requestedSessionId) {
      placeholderConditions.push(eq(messages.botmuxSessionId, requestedSessionId));
    }
    if (resolvedThreadId) {
      placeholderConditions.push(eq(messages.threadId, resolvedThreadId));
    } else {
      placeholderConditions.push(isNull(messages.threadId));
    }
  }

  const [pendingPlaceholder] = await db
    .select()
    .from(messages)
    .where(and(...placeholderConditions))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  if (pendingPlaceholder) {
    const settledProgress = finalizeProgressSnapshot(pendingPlaceholder.card?.progress, 'completed');
    const finishedAt = Date.now();
    const startedAt = pendingPlaceholder.card?.startedAt ?? pendingPlaceholder.createdAt.getTime();
    const [settled] = await db
      .update(messages)
      .set({
        content: trimmed,
        attachments: hasFiles ? body.attachments! : pendingPlaceholder.attachments,
        botmuxSessionId: body.botmuxSessionId || pendingPlaceholder.botmuxSessionId,
        adapterMeta: body.adapterMeta ?? pendingPlaceholder.adapterMeta,
        updatedAt: new Date(),
        card: {
          title: pendingPlaceholder.card?.title || matchedAgent?.name || botId,
          status: 'completed',
          ...(pendingPlaceholder.card?.parallel ? { parallel: true } : {}),
          startedAt,
          finishedAt,
          summary: 'Agent turn completed (outbound reply)',
          ...(settledProgress ? { progress: settledProgress } : {}),
        },
      })
      .where(and(eq(messages.id, pendingPlaceholder.id), sql`${messages.card}->>'status' = 'running'`))
      .returning();

    if (settled) {
      const reactions = (await getReactionsForMessages([settled.id])).get(settled.id) || [];
      const dto = { ...formatMessageRow(settled, 0, reactions), justCompleted: true };
      broadcast({ type: 'message.updated', payload: dto }, channelRow.organizationId);
      return c.json({ message: dto, settledPlaceholder: true }, 200);
    }
  }

  const [saved] = await db
    .insert(messages)
    .values({
      channelId: channelRow.id,
      threadId: resolvedThreadId,
      replyToId: resolvedReplyToId,
      senderAgentId: botId,
      content: trimmed,
      attachments: hasFiles ? body.attachments! : null,
      botmuxSessionId: body.botmuxSessionId || null,
      adapterMeta: body.adapterMeta || null,
    })
    .returning();

  const dto = formatMessageRow(saved);
  broadcast({ type: 'message.created', payload: dto }, channelRow.organizationId);
  return c.json({ message: dto }, 201);
});

/** Fixed-contract progress endpoint for external adapters / runners to push live tool steps */
app.post('/api/bot/messages/:messageId/progress', async (c) => {
  const botAuth = await verifyBotRequest(auth, c.req.raw.headers, BUZZ_BOT_TOKEN, null, AUTH_REQUIRED);
  if (!botAuth.ok) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const messageId = c.req.param('messageId')?.trim();
  if (!messageId) return c.json({ error: 'messageId is required' }, 400);

  const body = await c.req.json<{ progress?: unknown } & Record<string, unknown>>().catch(() => null);
  const rawProgress = body && 'progress' in body ? body.progress : body;
  const normalized = normalizeProgressSnapshot(rawProgress);
  if (!normalized) {
    return c.json({ error: 'Invalid progress payload: expected { activeLabel?, toolCount, steps[] }' }, 400);
  }

  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .limit(1);

  if (!row) return c.json({ error: 'Message not found' }, 404);
  if (!row.senderAgentId) {
    return c.json({ error: 'Forbidden: bots cannot update human messages' }, 403);
  }
  if (botAuth.method === 'bot-key' && botAuth.botUserId && row.senderAgentId !== botAuth.botUserId) {
    return c.json({ error: 'Forbidden: message belongs to another agent' }, 403);
  }
  if (!row.card || row.card.status !== 'running') {
    return c.json({ error: 'Message is not in running state' }, 409);
  }

  const updated = await applyMessageProgress(row, normalized);
  const effective = updated ?? row;
  const reactions = (await getReactionsForMessages([effective.id])).get(effective.id) || [];
  return c.json({
    ok: true,
    updated: Boolean(updated),
    message: formatMessageRow(effective, 0, reactions),
  });
});

async function findBotTurnMessage(messageId: string) {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .limit(1);
  return row;
}

async function settleBotTurn(
  row: typeof messages.$inferSelect,
  { content, status, adapterMeta }: BotTurnCompletion,
  options?: { requireChannelMembership: boolean },
) {
  if (!row.senderAgentId || row.card?.status !== 'running') return;
  const progress = finalizeProgressSnapshot(row.card.progress, status === 'completed' ? 'completed' : 'failed');
  const finishedAt = Date.now();
  const [settled] = await db
    .update(messages)
    .set({
      content: content.trim() || (status === 'completed' ? '' : `Agent turn ${status}`),
      adapterMeta: adapterMeta ?? row.adapterMeta,
      updatedAt: new Date(finishedAt),
      card: {
        title: row.card.title || row.senderAgentId,
        status,
        ...(row.card.parallel ? { parallel: true } : {}),
        startedAt: row.card.startedAt ?? row.createdAt.getTime(),
        finishedAt,
        summary: status === 'completed' ? 'Agent turn completed (gateway)' : content || status,
        ...(progress ? { progress } : {}),
      },
    })
    .where(and(
      eq(messages.id, row.id),
      eq(messages.senderAgentId, row.senderAgentId),
      isNull(messages.deletedAt),
      sql`${messages.card}->>'status' = 'running'`,
      options?.requireChannelMembership ? sql`exists (
        select 1 from ${channelMembers}
        where ${channelMembers.channelId} = ${row.channelId}
          and ${channelMembers.agentId} = ${row.senderAgentId}
      )` : undefined,
    ))
    .returning();
  if (!settled) return;

  const reactions = (await getReactionsForMessages([settled.id])).get(settled.id) || [];
  const orgId = await getChannelOrgId(settled.channelId);
  const message = { ...formatMessageRow(settled, 0, reactions), justCompleted: true };
  broadcast({ type: 'message.updated', payload: message }, orgId);
  return message;
}

app.post('/api/bot/messages/:messageId/complete', async (c) => {
  const botAuth = await verifyBotRequest(auth, c.req.raw.headers, BUZZ_BOT_TOKEN, null, AUTH_REQUIRED);
  if (!botAuth.ok) return c.json({ error: 'Unauthorized' }, 401);

  const messageId = c.req.param('messageId');
  if (!MESSAGE_ID_PATTERN.test(messageId)) return c.json({ error: 'Invalid message ID' }, 400);

  const body = await c.req.json<{ content?: unknown; status?: unknown; adapterMeta?: unknown }>().catch(() => null);
  const status = BOT_TURN_TERMINAL_STATUSES.find((value) => value === body?.status);
  if (!status || typeof body?.content !== 'string') {
    return c.json({ error: 'Expected content and a terminal turn status' }, 400);
  }
  const { content, adapterMeta } = body;
  if (adapterMeta !== undefined && (!adapterMeta || typeof adapterMeta !== 'object' || Array.isArray(adapterMeta))) {
    return c.json({ error: 'adapterMeta must be an object' }, 400);
  }

  const row = await findBotTurnMessage(messageId);
  if (!row) return c.json({ error: 'Message not found' }, 404);
  if (!row.senderAgentId) return c.json({ error: 'Forbidden: bots cannot update human messages' }, 403);
  const requireChannelMembership = botAuth.method === 'bot-key';
  if (requireChannelMembership && row.senderAgentId !== botAuth.botUserId) {
    return c.json({ error: 'Forbidden: message belongs to another agent' }, 403);
  }

  const message = await settleBotTurn(row, {
    content,
    status,
    adapterMeta: adapterMeta as Record<string, unknown> | undefined,
  }, { requireChannelMembership });
  if (message) return c.json({ ok: true, settled: true, message });

  // Match the exact placeholder even after an earlier attempt already settled it.
  const effective = row.card?.status === 'running' ? await findBotTurnMessage(messageId) : row;
  if (!effective) return c.json({ error: 'Message not found' }, 404);
  if (requireChannelMembership && !(await isBotChannelMember(row.channelId, row.senderAgentId))) {
    return c.json({ error: 'Forbidden: agent is not a member of this channel' }, 403);
  }
  if (!BOT_TURN_TERMINAL_STATUSES.some((value) => value === effective.card?.status)) {
    return c.json({ error: 'Message is not an active or settled turn' }, 409);
  }
  const reactions = (await getReactionsForMessages([effective.id])).get(effective.id) || [];
  return c.json({ ok: true, settled: false, message: formatMessageRow(effective, 0, reactions) });
});

/** Standard Bot Protocol: update a bot message / turn card status, content, progress, or adapterMeta. */
app.patch('/api/bot/messages/:messageId', async (c) => {
  const botAuth = await verifyBotRequest(auth, c.req.raw.headers, BUZZ_BOT_TOKEN, null, AUTH_REQUIRED);
  if (!botAuth.ok) return c.json({ error: 'Unauthorized' }, 401);

  const messageId = c.req.param('messageId')?.trim();
  if (!messageId) return c.json({ error: 'messageId is required' }, 400);

  const body = await c.req.json<{
    content?: string;
    status?: MessageCardData['status'];
    summary?: string;
    progress?: unknown;
    adapterMeta?: Record<string, unknown>;
    attachments?: MessageAttachment[];
  }>().catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .limit(1);
  if (!row) return c.json({ error: 'Message not found' }, 404);
  if (!row.senderAgentId) {
    return c.json({ error: 'Forbidden: bots cannot update human messages' }, 403);
  }
  if (botAuth.method === 'bot-key' && botAuth.botUserId && row.senderAgentId !== botAuth.botUserId) {
    return c.json({ error: 'Forbidden: message belongs to another agent' }, 403);
  }

  const nextStatus = body.status ?? row.card?.status ?? 'running';
  const normalizedProgress = body.progress ? normalizeProgressSnapshot(body.progress) : undefined;
  const isTerminal =
    nextStatus === 'completed' ||
    nextStatus === 'failed' ||
    nextStatus === 'interrupted' ||
    nextStatus === 'timeout' ||
    nextStatus === 'dispatch_failed';
  const effectiveProgress = isTerminal
    ? finalizeProgressSnapshot(
        normalizedProgress ?? row.card?.progress,
        nextStatus === 'completed' ? 'completed' : 'failed',
      )
    : (normalizedProgress ?? row.card?.progress);

  const nextCard: MessageCardData | null = row.card
    ? {
        ...row.card,
        status: nextStatus,
        ...(body.summary !== undefined ? { summary: body.summary } : {}),
        ...(isTerminal ? { finishedAt: row.card.finishedAt ?? Date.now() } : {}),
        ...(effectiveProgress ? { progress: effectiveProgress } : {}),
      }
    : null;

  const [updated] = await db
    .update(messages)
    .set({
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
      ...(body.adapterMeta !== undefined ? { adapterMeta: body.adapterMeta } : {}),
      ...(nextCard ? { card: nextCard } : {}),
      updatedAt: new Date(),
    })
    .where(eq(messages.id, messageId))
    .returning();

  if (!updated) return c.json({ error: 'Message update failed' }, 500);
  const reactions = (await getReactionsForMessages([updated.id])).get(updated.id) || [];
  const dto = {
    ...formatMessageRow(updated, 0, reactions),
    ...(isTerminal ? { justCompleted: true } : {}),
  };
  const orgId = await getChannelOrgId(updated.channelId);
  broadcast({ type: 'message.updated', payload: dto }, orgId);
  return c.json({ ok: true, message: dto });
});

/** Standard Bot Protocol: register or sync one or more external agents into BubAI's persistent registry. */
app.post('/api/bot/agents/register', async (c) => {
  const botAuth = await verifyBotRequest(auth, c.req.raw.headers, BUZZ_BOT_TOKEN, null, AUTH_REQUIRED);
  if (!botAuth.ok) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{
    agents?: AgentRegistrationInput[];
    agent?: AgentRegistrationInput;
  } & Partial<AgentRegistrationInput>>().catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const list: AgentRegistrationInput[] = Array.isArray(body.agents)
    ? body.agents
    : body.agent
      ? [body.agent]
      : body.agentId
        ? [body as AgentRegistrationInput]
        : [];
  if (list.length === 0) {
    return c.json({ error: 'agents[] or agentId is required' }, 400);
  }

  // Non-server bot keys can only register themselves
  const isServerKey = botAuth.method !== 'bot-key';
  const filtered =
    !isServerKey && botAuth.botUserId
      ? list.filter((a) => a.agentId === botAuth.botUserId)
      : list;

  await dispatcher.upsertAgents(
    filtered.map((a) => ({
      ...a,
      adapterType: a.adapterType ?? (a.webhookUrl ? 'webhook' : 'gateway'),
    })),
  );
  await broadcastPresenceUpdated();
  return c.json({ ok: true, registered: filtered.map((a) => a.agentId) });
});

/** Standard Bot Protocol: HTTP heartbeat / presence update for external bots. */
app.post('/api/bot/heartbeat', async (c) => {
  const botAuth = await verifyBotRequest(auth, c.req.raw.headers, BUZZ_BOT_TOKEN, null, AUTH_REQUIRED);
  if (!botAuth.ok) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{
    agentId?: string;
    status?: 'online' | 'offline';
    capabilities?: string[];
    ttlMs?: number;
  }>().catch(() => null);
  const agentId = body?.agentId?.trim() || botAuth.botUserId;
  if (!agentId) return c.json({ error: 'agentId is required' }, 400);
  if (botAuth.method === 'bot-key' && botAuth.botUserId && agentId !== botAuth.botUserId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await dispatcher.recordHeartbeat(agentId, {
    status: body?.status,
    capabilities: body?.capabilities,
    ttlMs: body?.ttlMs,
  });
  await broadcastPresenceUpdated();
  return c.json({ ok: true, agentId, status: body?.status ?? 'online' });
});

/** Standard Bot Protocol: allow external agents to fetch channel/thread history on demand. */
app.get('/api/bot/channels/:channelId/messages', async (c) => {
  const botAuth = await verifyBotRequest(auth, c.req.raw.headers, BUZZ_BOT_TOKEN, null, AUTH_REQUIRED);
  if (!botAuth.ok) return c.json({ error: 'Unauthorized' }, 401);

  const channelId = c.req.param('channelId');
  const requestedBotId = c.req.query('botId')?.trim() || botAuth.botUserId;
  if (botAuth.method === 'bot-key') {
    if (!botAuth.botUserId || !(await isBotChannelMember(channelId, botAuth.botUserId))) {
      return c.json({ error: 'Forbidden: agent is not a member of this channel' }, 403);
    }
  } else if (AUTH_REQUIRED && requestedBotId) {
    if (!(await isBotChannelMember(channelId, requestedBotId))) {
      return c.json({ error: 'Forbidden: agent is not a member of this channel' }, 403);
    }
  }
  const threadId = c.req.query('threadId')?.trim() || null;
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 30), 1), 100);

  const conditions = [eq(messages.channelId, channelId), isNull(messages.deletedAt)];
  if (threadId) {
    conditions.push(eq(messages.threadId, threadId));
  } else {
    conditions.push(isNull(messages.threadId));
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return c.json({
    channelId,
    threadId,
    messages: rows.reverse().map((r) => formatMessageRow(r)),
  });
});

/** Standard Bot Protocol: create a native interactive ask/approval prompt from any external agent. */
app.post('/api/bot/asks', async (c) => {
  const botAuth = await verifyBotRequest(auth, c.req.raw.headers, BUZZ_BOT_TOKEN, null, AUTH_REQUIRED);
  if (!botAuth.ok) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{
    askId?: string;
    agentId?: string;
    botName?: string;
    sessionId?: string;
    title?: string;
    prompt?: string;
    questions?: Array<{
      question?: string;
      header?: string;
      multiSelect?: boolean;
      options?: Array<{ key: string; label: string; description?: string }>;
    }>;
  }>().catch(() => null);
  const agentId = body?.agentId?.trim() || botAuth.botUserId;
  if (!agentId) return c.json({ error: 'agentId is required' }, 400);

  const ask = await gatewayAdapter.createNativeAsk({
    askId: body?.askId,
    larkAppId: agentId,
    botName: body?.botName,
    sessionId: body?.sessionId,
    title: body?.title,
    prompt: body?.prompt,
    questions: body?.questions,
  });
  return c.json({ ok: true, ask }, 201);
});

app.post('/api/dms', async (c) => {
  const body = await c.req.json<{
    userId?: string;
    targetId?: string;
    targetRole?: 'human' | 'agent';
    targetName?: string;
  }>();
  const userId = getRequestUserId(c, body.userId);
  const targetId = body.targetId;
  const targetRole = body.targetRole || 'agent';
  if (!targetId) return c.json({ error: 'targetId required' }, 400);

  const selfKey = `u:${userId}`;
  const targetKey = targetRole === 'agent' ? `a:${targetId}` : `u:${targetId}`;
  const dmKey = [selfKey, targetKey].sort().join('|');

  const [existing] = await db.select().from(channels).where(eq(channels.dmKey, dmKey));
  if (existing) {
    // Reopening a closed/hidden DM brings it back into the user's sidebar with full history
    await db
      .insert(channelReads)
      .values({ channelId: existing.id, userId, hidden: false })
      .onConflictDoUpdate({
        target: [channelReads.channelId, channelReads.userId],
        set: { hidden: false },
      });
    return c.json({
      channel: {
        id: existing.id,
        name: existing.name,
        topic: existing.topic,
        kind: 'dm' as const,
        replyMode: parseReplyMode(existing.replyMode, DEFAULT_REPLY_MODE),
        archived: false,
        createdByUserId: existing.createdByUserId || undefined,
        dmKey: existing.dmKey || undefined,
        unreadCount: 0,
        createdAt: existing.createdAt.getTime(),
      },
    });
  }

  const label = body.targetName || targetId;
  const dmName = `dm-${label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')}-${Date.now().toString(36).slice(-4)}`;
  const [created] = await db
    .insert(channels)
    .values({
      name: dmName,
      topic: `与 ${label} 的私聊`,
      kind: 'dm',
      visibility: 'private',
      dmKey,
      organizationId: c.get('authOrgId'),
      createdByUserId: userId,
    })
    .returning();

  await db
    .insert(channelMembers)
    .values({ channelId: created.id, userId, autoReply: false })
    .onConflictDoNothing();

  if (targetRole === 'agent') {
    await db
      .insert(channelMembers)
      .values({ channelId: created.id, agentId: targetId, autoReply: true })
      .onConflictDoNothing();
  } else {
    await db
      .insert(channelMembers)
      .values({ channelId: created.id, userId: targetId, autoReply: false })
      .onConflictDoNothing();
  }

  const dto = {
    id: created.id,
    name: created.name,
    topic: created.topic,
    kind: 'dm' as const,
    dmKey: created.dmKey || undefined,
    unreadCount: 0,
    createdAt: created.createdAt.getTime(),
  };
  broadcast({ type: 'channel.created', payload: dto }, created.organizationId);
  return c.json({ channel: dto }, 201);
});

async function listChannelMembers(channelId: string) {
  const [[channel], rows] = await Promise.all([
    db.select().from(channels).where(eq(channels.id, channelId)),
    db.select().from(channelMembers).where(eq(channelMembers.channelId, channelId))
      .orderBy(asc(channelMembers.createdAt)),
  ]);
  if (!channel) return null;

  // Seeded channels predate explicit roster entries for their creators.
  const ownerId = channel.createdByUserId;
  if (ownerId && !rows.some((row) => row.userId === ownerId)) {
    rows.unshift({
      id: `owner:${channelId}`,
      channelId,
      userId: ownerId,
      agentId: null,
      autoReply: false,
      createdAt: channel.createdAt,
    });
  }
  return { members: rows, ownerId };
}

async function broadcastChannelMembers(channelId: string) {
  const [roster, orgId] = await Promise.all([
    listChannelMembers(channelId),
    getChannelOrgId(channelId),
  ]);
  if (!roster) return;
  broadcast(
    {
      type: 'channel.members.updated',
      payload: { channelId, members: roster.members, ownerId: roster.ownerId },
    },
    orgId,
  );
}

app.get('/api/channels/:channelId/members', async (c) => {
  const channelId = c.req.param('channelId');
  const roster = await listChannelMembers(channelId);
  if (!roster) return c.json({ error: 'Channel not found' }, 404);
  return c.json(roster);
});

app.post('/api/channels/:channelId/members', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{ userId?: string; agentId?: string; autoReply?: boolean }>();
  if (!body.userId && !body.agentId) {
    return c.json({ error: 'userId or agentId required' }, 400);
  }

  if (body.agentId) {
    const existing = await db
      .select()
      .from(channelMembers)
      .where(
        and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, body.agentId)),
      );
    if (existing.length > 0) {
      const [row] = await db
        .update(channelMembers)
        .set({ autoReply: Boolean(body.autoReply) })
        .where(eq(channelMembers.id, existing[0].id))
        .returning();
      await broadcastChannelMembers(channelId);
      return c.json({ member: row });
    }
    const [row] = await db
      .insert(channelMembers)
      .values({ channelId, agentId: body.agentId, autoReply: Boolean(body.autoReply) })
      .returning();
    await broadcastChannelMembers(channelId);
    return c.json({ member: row });
  }

  const existingUser = await db
    .select()
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, body.userId!)));
  const row =
    existingUser[0] ??
    (
      await db
        .insert(channelMembers)
        .values({ channelId, userId: body.userId!, autoReply: false })
        .returning()
    )[0];
  await db
    .insert(channelReads)
    .values({ channelId, userId: body.userId!, hidden: false })
    .onConflictDoUpdate({
      target: [channelReads.channelId, channelReads.userId],
      set: { hidden: false },
    });
  await broadcastChannelMembers(channelId);
  return c.json({ member: row });
});

app.delete('/api/channels/:channelId/members', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{ userId?: string; agentId?: string }>();
  if (body.agentId) {
    await db
      .delete(channelMembers)
      .where(
        and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, body.agentId))
      );
  } else if (body.userId) {
    await db
      .delete(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, body.userId)));
    await db
      .insert(channelReads)
      .values({ channelId, userId: body.userId, hidden: true })
      .onConflictDoUpdate({
        target: [channelReads.channelId, channelReads.userId],
        set: { hidden: true },
      });
  }
  await broadcastChannelMembers(channelId);
  return c.json({ ok: true });
});

app.get('/api/messages/:messageId', async (c) => {
  const messageId = c.req.param('messageId');
  const userId = getRequestUserId(c, c.req.query('userId'));
  const organizationId = c.get('authOrgId');
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)));
  if (!row) return c.json({ error: 'Message not found' }, 404);
  const [ch] = await db.select().from(channels).where(eq(channels.id, row.channelId));
  if (!ch || !channelVisibleTo(ch, userId) || !channelBelongsToOrg(ch, organizationId)) {
    return c.json({ error: 'Message not found' }, 404);
  }
  return c.json({ message: formatMessageRow(row) });
});

app.get('/api/sessions/:sessionId/write-link', async (c) => {
  const sessionId = c.req.param('sessionId');
  const authOrgId = c.get('authOrgId');
  if (authOrgId && !(await sessionBelongsToOrg(sessionId, authOrgId))) {
    return c.json({ error: 'Session not found' }, 404);
  }
  const upstreamUrl = await botmuxAdapter.getSessionWriteLink(sessionId);
  if (!upstreamUrl) {
    return c.json({ sessionId, url: null });
  }
  const shouldProxy = process.env.BOTMUX_PROXY_TERMINAL !== 'false';
  if (!shouldProxy) {
    return c.json({ sessionId, url: upstreamUrl });
  }
  const reqOrigin =
    process.env.PUBLIC_URL?.replace(/\/+$/, '') || new URL(c.req.url).origin;
  const proxiedUrl = buildProxiedTerminalUrl(reqOrigin, sessionId, upstreamUrl);
  return c.json({ sessionId, url: proxiedUrl, directUrl: upstreamUrl });
});

app.all('/api/terminal-proxy/:sessionId/*', async (c) => {
  const url = new URL(c.req.url);
  const upstreamUrl = resolveTerminalUpstreamUrl(url.pathname, url.search, BOTMUX_ENDPOINT);
  if (!upstreamUrl) {
    return c.json({ error: 'Invalid terminal proxy path' }, 400);
  }
  try {
    return await proxyTerminalHttpRequest(c.req.raw, upstreamUrl);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Terminal proxy failed' },
      502,
    );
  }
});

app.post('/api/sessions/:sessionId/:op', async (c) => {
  const sessionId = c.req.param('sessionId');
  const op = c.req.param('op');
  const authOrgId = c.get('authOrgId');
  if (authOrgId && !(await sessionBelongsToOrg(sessionId, authOrgId))) {
    return c.json({ error: 'Session not found' }, 404);
  }
  if (op !== 'restart' && op !== 'close' && op !== 'resume') {
    return c.json({ error: 'Unsupported session op' }, 400);
  }
  const result = await botmuxAdapter.sessionAction(sessionId, op);
  const sessions = await dispatcher.getSessions();
  await broadcastSessionsUpdated(sessions);
  return c.json(result.body as Record<string, unknown>, result.status as 200);
});

app.get('/api/sessions/:sessionId/history', async (c) => {
  const sessionId = c.req.param('sessionId');
  const authOrgId = c.get('authOrgId');
  if (authOrgId && !(await sessionBelongsToOrg(sessionId, authOrgId))) {
    return c.json({ error: 'Session not found' }, 404);
  }
  const [result, localRows] = await Promise.all([
    botmuxAdapter.getSessionHistory(sessionId),
    authOrgId
      ? db
          .select({ message: messages })
          .from(messages)
          .innerJoin(channels, eq(messages.channelId, channels.id))
          .where(
            and(
              eq(messages.botmuxSessionId, sessionId),
              eq(channels.organizationId, authOrgId),
              isNull(messages.deletedAt),
            ),
          )
          .orderBy(asc(messages.createdAt))
          .limit(100)
          .then((rows) => rows.map((r) => r.message))
      : db
          .select()
          .from(messages)
          .where(and(eq(messages.botmuxSessionId, sessionId), isNull(messages.deletedAt)))
          .orderBy(asc(messages.createdAt))
          .limit(100),
  ]);

  const localMessages = localRows.map((m) => ({
    id: m.id,
    channelId: m.channelId,
    threadId: m.threadId || undefined,
    senderId: m.senderAgentId || m.senderUserId || 'u-owner',
    senderRole: m.senderAgentId ? 'agent' : 'human',
    content: m.content,
    card: m.card || undefined,
    createdAt: m.createdAt.getTime(),
  }));

  const body = result.body;
  const botmuxRecords =
    body && typeof body === 'object'
      ? ((body as Record<string, unknown>).messages ??
          (body as Record<string, unknown>).history ??
          (body as Record<string, unknown>).items)
      : undefined;
  const hasBotmuxRecords = Array.isArray(botmuxRecords) && botmuxRecords.length > 0;

  if (result.ok && hasBotmuxRecords) {
    return c.json(
      {
        ...(body as Record<string, unknown>),
        localMessages,
      },
      200
    );
  }

  if (localMessages.length > 0) {
    return c.json(
      {
        ok: true,
        source: 'buzz-local',
        sessionId,
        messages: localMessages,
        botmuxHistory: body,
      },
      200
    );
  }

  return c.json(result.body as Record<string, unknown>, result.status as 200);
});

app.get('/api/asks/pending', async (c) => {
  const asks = await listAsksForOrg(c.get('authOrgId'));
  return c.json({ asks });
});

app.post('/api/asks/answer', async (c) => {
  const authOrgId = c.get('authOrgId');
  const body = await c.req.json<DashboardAskAnswerRequest>();
  if (authOrgId) {
    const allowedAsks = await listAsksForOrg(authOrgId);
    const askId = (body as unknown as Record<string, unknown>)?.askId;
    const matched = allowedAsks.some((a) => {
      const rec = a as unknown as Record<string, unknown>;
      return rec.id === askId || rec.askId === askId;
    });
    if (!matched) {
      return c.json({ error: 'Ask not found' }, 404);
    }
  }
  const result = await dispatcher.answerAsk(body);
  const asks = await dispatcher.getPendingAsks();
  await broadcastAsksUpdated(asks);
  return c.json(result.body as Record<string, unknown>, result.status as 200);
});

app.get('/api/agents', async (c) => {
  const authOrgId = c.get('authOrgId');
  const [allAgents, allowedMemberIds] = await Promise.all([
    dispatcher.listAgents(),
    authOrgId ? listOrgMemberIds(authOrgId) : Promise.resolve(null),
  ]);
  const visible = allowedMemberIds
    ? allAgents.filter((a) => allowedMemberIds.has(a.id))
    : allAgents;
  const agents = visible.map((a) => ({
    id: a.id,
    name: a.name,
    role: 'agent' as const,
    avatarUrl: a.avatarUrl || undefined,
    description: a.description || undefined,
    archived: a.archived,
    workingDir: a.workingDir || undefined,
    status: a.online ? ('online' as const) : ('offline' as const),
    cliId: a.cliId || undefined,
    adapterType: a.adapterType,
    capabilities: a.capabilities,
  }));
  return c.json({ agents });
});

app.post('/api/agents/provision', async (c) => {
  const userId = getRequestUserId(c);
  const body = await c.req.json<{
    agentId?: string;
    adapterType?: 'botmux' | 'gateway' | 'webhook';
    externalId?: string;
    name?: string;
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
    autoReply?: boolean;
    issueKey?: boolean;
    keyScope?: 'bot' | 'bot-server';
  }>().catch(() => null);

  const name = body?.name?.trim();
  if (!name) return c.json({ error: 'name is required' }, 400);

  const authUserId = c.get('authUserId');
  const authOrgId = c.get('authOrgId');

  // P0-1: Only system admins may issue multi-bot `bot-server_` keys
  let isAdmin = false;
  if (authUserId) {
    const [caller] = await db
      .select({ role: authSchema.user.role })
      .from(authSchema.user)
      .where(eq(authSchema.user.id, authUserId))
      .limit(1);
    isAdmin = caller?.role === 'admin';
  }
  if (body?.issueKey && body?.keyScope === 'bot-server' && !isAdmin) {
    return c.json({ error: 'Forbidden: only admins can issue bot-server keys' }, 403);
  }

  // Validate webhookUrl against SSRF / blocked hosts
  let validatedWebhookUrl: string | undefined;
  if (body?.webhookUrl !== undefined && body.webhookUrl.trim()) {
    const check = validateWebhookUrl(body.webhookUrl);
    if (!check.ok) {
      return c.json({ error: check.error }, 400);
    }
    validatedWebhookUrl = check.url;
  }

  // Validate requested channel BEFORE mutating DB so missing channel returns 404
  const rawChannelId = body?.channelId?.trim();
  const rawChannelName = body?.channelName?.trim().replace(/^#/, '');
  let targetChannel: typeof channels.$inferSelect | undefined;
  if (rawChannelId || rawChannelName) {
    const [ch] = rawChannelId
      ? await db.select().from(channels).where(eq(channels.id, rawChannelId))
      : await db.select().from(channels).where(
          authOrgId
            ? and(eq(channels.name, rawChannelName!), eq(channels.organizationId, authOrgId))
            : eq(channels.name, rawChannelName!),
        );
    if (!ch || !channelBelongsToOrg(ch, authOrgId)) {
      return c.json({ error: 'Channel not found' }, 404);
    }
    targetChannel = ch;
  }

  const adapterType = body?.adapterType ?? (validatedWebhookUrl ? 'webhook' : 'gateway');
  const externalId = body?.externalId?.trim() || body?.agentId?.trim() || undefined;

  // Idempotent lookup scoped to current organization by agentId or (adapterType, externalId)
  const findExistingAgent = async () => {
    const rows = await db.select().from(agentProfiles);
    return rows.find(
      (row) =>
        (body?.agentId?.trim() && row.agentId === body.agentId.trim()) ||
        (externalId &&
          (row.organizationId ?? null) === (authOrgId ?? null) &&
          row.adapterType === adapterType &&
          row.externalId === externalId),
    );
  };

  let existing = await findExistingAgent();
  if (
    existing &&
    authUserId &&
    existing.ownerUserId &&
    existing.ownerUserId !== authUserId &&
    !isAdmin &&
    body?.issueKey
  ) {
    return c.json({ error: 'Forbidden: cannot issue key for an agent owned by another user' }, 403);
  }

  let agentId =
    existing?.agentId ||
    body?.agentId?.trim() ||
    `agent_${name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'bot'}_${randomUUID().slice(0, 6)}`;

  try {
    await dispatcher.upsertAgents([
      {
        agentId,
        organizationId: authOrgId ?? null,
        ownerUserId: existing?.ownerUserId ?? authUserId ?? null,
        adapterType,
        externalId: externalId ?? agentId,
        defaultName: name,
        description: body?.description,
        systemPrompt: body?.systemPrompt,
        avatarUrl: body?.avatarUrl,
        cliId: body?.cliId,
        workingDir: body?.workingDir,
        capabilities: body?.capabilities,
        webhookUrl: validatedWebhookUrl,
        webhookSecret: body?.webhookSecret,
      },
    ]);
  } catch (err) {
    // Handle concurrent provision unique-index race gracefully
    const raced = await findExistingAgent();
    if (!raced) throw err;
    existing = raced;
    agentId = raced.agentId;
  }

  let apiKey: string | undefined;
  if (authUserId) {
    const botEmail = `${agentId.replace(/[^a-zA-Z0-9._-]+/g, '_').toLowerCase()}@bot.bubai.local`;
    try {
      await auth.api.createBotUser({
        body: { id: agentId, name, email: botEmail, createdByUserId: authUserId },
      });
    } catch {
      // Already exists — idempotent
    }

    if (authOrgId) {
      const existingOrgMember = await db
        .select({ id: authSchema.member.id })
        .from(authSchema.member)
        .where(
          and(
            eq(authSchema.member.organizationId, authOrgId),
            eq(authSchema.member.userId, agentId),
          ),
        )
        .limit(1);
      if (existingOrgMember.length === 0) {
        try {
          await db.insert(authSchema.member).values({
            id: randomUUID(),
            organizationId: authOrgId,
            userId: agentId,
            role: 'member',
            createdAt: new Date(),
          });
        } catch {
          // Ignore duplicate membership race
        }
      }
    }

    if (body?.issueKey) {
      const scope = body.keyScope === 'bot-server' ? 'bot-server' : 'bot';
      const issued = await botCredentials(auth.api, scope).issueBotKey(agentId, {
        name: `cli-${adapterType}`,
      });
      apiKey = issued.key;
    }
  }

  let joinedChannelId: string | undefined;
  if (targetChannel) {
    joinedChannelId = targetChannel.id;
    const existingMember = await db
      .select()
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, targetChannel.id), eq(channelMembers.agentId, agentId)));
    if (existingMember.length > 0) {
      if (body?.autoReply !== undefined) {
        await db
          .update(channelMembers)
          .set({ autoReply: Boolean(body.autoReply) })
          .where(eq(channelMembers.id, existingMember[0].id));
      }
    } else {
      await db.insert(channelMembers).values({
        channelId: targetChannel.id,
        agentId,
        autoReply: Boolean(body?.autoReply),
      });
    }
    await broadcastChannelMembers(targetChannel.id);
  }

  const participants = await listParticipants(authOrgId);
  await broadcastPresenceUpdated(authOrgId);
  const agent = participants.find((p) => p.id === agentId && p.role === 'agent');
  return c.json(
    {
      ok: true,
      created: !existing,
      agent: agent ?? {
        id: agentId,
        name,
        role: 'agent' as const,
        status: 'offline' as const,
        adapterType,
        capabilities: body?.capabilities ?? [],
      },
      ...(joinedChannelId ? { channelId: joinedChannelId } : {}),
      ...(apiKey ? { apiKey } : {}),
      provisionedBy: userId,
    },
    existing ? 200 : 201,
  );
});

app.get('/api/agents/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const userId = getRequestUserId(c, c.req.query('userId'));
  const authOrgId = c.get('authOrgId');
  const detail = await buildAgentDetail(agentId, userId, authOrgId);
  if (!detail) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ agent: detail });
});

app.patch('/api/agents/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const userId = getRequestUserId(c, c.req.query('userId'));
  const authOrgId = c.get('authOrgId');
  if (authOrgId && !(await isAgentInOrg(agentId, authOrgId))) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  const body = await c.req.json<{
    displayName?: string | null;
    description?: string | null;
    systemPrompt?: string | null;
    avatarUrl?: string | null;
    archived?: boolean;
  }>();

  const existing = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId));
  const current = existing[0];

  const nextDisplayName =
    body.displayName !== undefined ? body.displayName?.trim() || null : (current?.displayName ?? null);
  const nextDescription =
    body.description !== undefined
      ? body.description?.trim().slice(0, 280) || null
      : (current?.description ?? null);
  const nextSystemPrompt =
    body.systemPrompt !== undefined ? body.systemPrompt ?? null : (current?.systemPrompt ?? null);
  const nextAvatarUrl =
    body.avatarUrl !== undefined ? body.avatarUrl?.trim() || null : (current?.avatarUrl ?? null);
  const nextArchived = body.archived !== undefined ? Boolean(body.archived) : (current?.archived ?? false);

  await db
    .insert(agentProfiles)
    .values({
      agentId,
      displayName: nextDisplayName,
      description: nextDescription,
      systemPrompt: nextSystemPrompt,
      avatarUrl: nextAvatarUrl,
      archived: nextArchived,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: agentProfiles.agentId,
      set: {
        displayName: nextDisplayName,
        description: nextDescription,
        systemPrompt: nextSystemPrompt,
        avatarUrl: nextAvatarUrl,
        archived: nextArchived,
        updatedAt: new Date(),
      },
    });

  // Keep Better Auth bot user display name / avatar aligned if a bot user row exists
  if (body.displayName !== undefined || body.avatarUrl !== undefined) {
    await db
      .update(authSchema.user)
      .set({
        ...(nextDisplayName ? { name: nextDisplayName } : {}),
        ...(body.avatarUrl !== undefined ? { image: nextAvatarUrl } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(authSchema.user.id, agentId), eq(authSchema.user.kind, 'BOT')));
  }

  await broadcastPresenceUpdated(authOrgId);
  const detail = await buildAgentDetail(agentId, userId, authOrgId);
  return c.json({ agent: detail });
});

await syncBotmuxAndSeedDefaults();

botmuxAdapter.subscribeEvents((eventName, data) => {
  if (eventName === 'sessions' || eventName === 'session' || eventName === 'message') {
    void dispatcher.getSessions().then((sessions) => broadcastSessionsUpdated(sessions));
    void dispatcher.getPendingAsks().then((asks) => broadcastAsksUpdated(asks));
    void runBotmuxTurnPoll();
  }
  broadcast({ type: 'botmux.event', payload: { eventName, data } });
});

Bun.serve<WsClientData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/ws/bot') {
      const botAuth = await verifyBotRequest(
        auth,
        req.headers,
        BUZZ_BOT_TOKEN,
        url.searchParams.get('token'),
        AUTH_REQUIRED,
      );
      if (!botAuth.ok) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (
        server.upgrade(req, {
          data: {
            kind: 'bot-gateway',
            connectionId: `gw_${randomUUID()}`,
            botUserId: botAuth.botUserId,
            isServerKey: botAuth.method !== 'bot-key',
            boundAgentIds: new Set<string>(),
          },
        })
      ) {
        return undefined;
      }
      return new Response('Bot Gateway WebSocket upgrade failed', { status: 400 });
    }
    if (url.pathname === '/ws') {
      const wsHeaders = buildSessionHeaders(req.headers, url.searchParams.get('token'));
      const identity = await resolveRequestIdentity({
        auth,
        headers: wsHeaders,
        authRequired: AUTH_REQUIRED,
      });
      if (!identity) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (
        server.upgrade(req, {
          data: {
            kind: 'chat',
            userId: identity.authenticated ? identity.userId : undefined,
            organizationId: identity.organizationId ?? undefined,
            authenticated: identity.authenticated,
          },
        })
      ) {
        return undefined;
      }
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    if (
      url.pathname.startsWith('/api/terminal-proxy/') &&
      req.headers.get('upgrade')?.toLowerCase() === 'websocket'
    ) {
      const wsHeaders = buildSessionHeaders(req.headers, url.searchParams.get('token'));
      const identity = await resolveRequestIdentity({
        auth,
        headers: wsHeaders,
        authRequired: AUTH_REQUIRED,
      });
      if (!identity) {
        return new Response('Unauthorized', { status: 401 });
      }
      const proxySid = url.pathname.split('/')[3];
      if (
        identity.organizationId &&
        proxySid &&
        !(await sessionBelongsToOrg(decodeURIComponent(proxySid), identity.organizationId))
      ) {
        return new Response('Forbidden', { status: 403 });
      }
      const upstreamHttp = resolveTerminalUpstreamUrl(url.pathname, url.search, BOTMUX_ENDPOINT);
      if (upstreamHttp) {
        const upstreamWsUrl = upstreamHttp.replace(/^http/i, 'ws');
        if (
          server.upgrade(req, {
            data: { kind: 'terminal-proxy', upstreamWsUrl, upstreamWs: null, pendingFrames: [] },
          })
        ) {
          return undefined;
        }
      }
      return new Response('Terminal WebSocket upgrade failed', { status: 400 });
    }
    if (
      STATIC_DIR &&
      !url.pathname.startsWith('/api/') &&
      url.pathname !== '/healthz' &&
      url.pathname !== '/ws'
    ) {
      const reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
      const candidate = path.resolve(STATIC_DIR, `.${reqPath}`);
      if (candidate.startsWith(STATIC_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const file = Bun.file(candidate);
        return new Response(file, {
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            ...(reqPath.startsWith('/assets/')
              ? { 'Cache-Control': 'public, max-age=31536000, immutable' }
              : {}),
          },
        });
      }
      const indexFile = path.join(STATIC_DIR, 'index.html');
      if (fs.existsSync(indexFile)) {
        return new Response(Bun.file(indexFile), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    }
    return app.fetch(req);
  },
  websocket: {
    idleTimeout: 960,
    sendPings: true,
    open(ws) {
      if (ws.data.kind === 'bot-gateway') {
        gatewayAdapter.handleOpen(ws as unknown as ServerWebSocket<BotGatewayWsData>);
        return;
      }
      if (ws.data.kind === 'terminal-proxy' && ws.data.upstreamWsUrl) {
        const upstream = new WebSocket(ws.data.upstreamWsUrl);
        upstream.binaryType = 'arraybuffer';
        ws.data.upstreamWs = upstream;
        upstream.addEventListener('open', () => {
          const queued = ws.data.pendingFrames ?? [];
          ws.data.pendingFrames = [];
          for (const frame of queued) {
            upstream.send(frame);
          }
        });
        upstream.addEventListener('message', (evt) => {
          try {
            if (typeof evt.data === 'string' || evt.data instanceof ArrayBuffer) {
              ws.send(evt.data);
            }
          } catch {
            // client closed
          }
        });
        upstream.addEventListener('close', () => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        });
        upstream.addEventListener('error', () => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        });
        return;
      }
      clients.add(ws);
    },
    async message(ws, raw) {
      if (ws.data.kind === 'bot-gateway') {
        await gatewayAdapter.handleMessage(ws as unknown as ServerWebSocket<BotGatewayWsData>, raw);
        return;
      }
      if (ws.data.kind === 'terminal-proxy') {
        const upstream = ws.data.upstreamWs;
        const payload = typeof raw === 'string' ? raw : new Uint8Array(raw);
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(payload);
        } else {
          ws.data.pendingFrames = ws.data.pendingFrames ?? [];
          ws.data.pendingFrames.push(payload);
        }
        return;
      }
      let failSend: ((message: string) => void) | undefined;
      try {
        const event = JSON.parse(String(raw)) as
          | { type: 'ping' }
          | { type: 'presence.identify'; payload: { userId: string } }
          | { type: 'typing.start'; payload: { channelId: string; userId: string } }
          | {
              type: 'message.send';
              payload: {
                messageId?: string;
                channelId: string;
                senderId: string;
                content: string;
                threadId?: string;
                replyToId?: string;
                attachments?: MessageAttachment[];
              };
            };

        if (event.type === 'ping') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', payload: { ts: Date.now() } }));
          }
          return;
        }

        if (event.type === 'presence.identify') {
          if (!ws.data.authenticated) {
            ws.data.userId = event.payload.userId;
          }
          broadcast(
            {
              type: 'presence.updated',
              payload: { participants: await listParticipants(ws.data.organizationId) },
            },
            ws.data.organizationId,
          );
          return;
        }

        if (event.type === 'typing.start') {
          const { channelId, userId: payloadUserId } = event.payload || {};
          const userId = ws.data.authenticated ? ws.data.userId : payloadUserId;
          if (channelId && userId) {
            const orgId = await getChannelOrgId(channelId);
            if (!ws.data.organizationId || orgId === ws.data.organizationId) {
              broadcast(
                {
                  type: 'typing.updated',
                  payload: { channelId, userId, typing: true },
                },
                orgId,
              );
            }
          }
          return;
        }

        if (event.type === 'message.send') {
          const {
            messageId,
            channelId,
            senderId: payloadSenderId,
            content,
            threadId,
            replyToId,
            attachments,
          } = event.payload;
          const senderId = (ws.data.authenticated && ws.data.userId) || payloadSenderId;
          if (messageId !== undefined) {
            failSend = (message) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'message.send_failed',
                  payload: { messageId, message },
                }));
              }
            };
          }
          if (
            messageId !== undefined &&
            (typeof messageId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(messageId))
          ) {
            failSend?.('The message ID is invalid.');
            return;
          }
          const trimmed = content.trim();
          const hasFiles = Array.isArray(attachments) && attachments.length > 0;
          if (!trimmed && !hasFiles) {
            failSend?.('Enter a message or add an attachment.');
            return;
          }

          const storedThreadId = threadId?.toLowerCase() || null;
          const storedReplyToId = storedThreadId ? replyToId?.toLowerCase() || null : null;
          const storedAttachments = hasFiles ? attachments : null;
          const [channelRow] = await db
            .select()
            .from(channels)
            .where(eq(channels.id, channelId));
          if (!channelRow) {
            failSend?.('This channel no longer exists.');
            return;
          }
          if (!channelBelongsToOrg(channelRow, ws.data.organizationId)) {
            failSend?.('Forbidden: channel belongs to another organization.');
            return;
          }

          const [saved] = channelRow.archived
            ? []
            : await db
                .insert(messages)
                .values({
                  id: messageId,
                  channelId,
                  threadId: storedThreadId,
                  replyToId: storedReplyToId,
                  senderUserId: senderId,
                  content: trimmed,
                  attachments: storedAttachments,
                })
                .onConflictDoNothing({ target: messages.id })
                .returning();

          if (!saved) {
            if (messageId === undefined) return;
            const [existing] = await db.select().from(messages).where(eq(messages.id, messageId));
            if (!existing) {
              failSend?.(
                channelRow.archived ? 'This channel is archived.' : 'Could not send the message. Try again.'
              );
              return;
            }
            if (
              existing.channelId !== channelRow.id ||
              existing.senderUserId !== senderId ||
              existing.threadId !== storedThreadId ||
              existing.replyToId !== storedReplyToId ||
              (!existing.updatedAt && (
                existing.content !== trimmed || !isDeepStrictEqual(existing.attachments, storedAttachments)
              ))
            ) {
              failSend?.('This message ID is already in use.');
              return;
            }
            if (existing.deletedAt) {
              failSend?.('This message was already sent and has since been deleted.');
              return;
            }
            failSend = undefined;
            ws.send(JSON.stringify({ type: 'message.created', payload: formatMessageRow(existing) }));
            return;
          }

          failSend = undefined;
          broadcast(
            { type: 'message.created', payload: formatMessageRow(saved) },
            channelRow.organizationId,
          );

          // Auto-unhide DM for all participants when a new message arrives
          if (channelRow.kind === 'dm') {
            await db
              .update(channelReads)
              .set({ hidden: false })
              .where(eq(channelReads.channelId, channelId));
            broadcast(
              {
                type: 'channel.updated',
                payload: {
                  id: channelRow.id,
                  name: channelRow.name,
                  topic: channelRow.topic,
                  kind: 'dm' as const,
                  replyMode: parseReplyMode(channelRow.replyMode, DEFAULT_REPLY_MODE),
                  archived: false,
                  createdByUserId: channelRow.createdByUserId || undefined,
                  dmKey: channelRow.dmKey || undefined,
                  unreadCount: 1,
                  createdAt: channelRow.createdAt.getTime(),
                },
              },
              channelRow.organizationId,
            );
          }

          if (!threadId) {
            await db
              .insert(channelReads)
              .values({ channelId, userId: senderId, lastReadAt: new Date() })
              .onConflictDoUpdate({
                target: [channelReads.channelId, channelReads.userId],
                set: { lastReadAt: new Date() },
              });
          }

          let knownAgents = await dispatcher.listAgents();
          if (knownAgents.length === 0 && botmuxAdapter.isEnabled()) {
            await dispatcher.syncBotmuxAgents();
            knownAgents = await dispatcher.listAgents();
          }

          const channelMemberRows = await db
            .select()
            .from(channelMembers)
            .where(eq(channelMembers.channelId, channelId));
          const channelAgentIds = new Set(
            channelMemberRows.map((m) => m.agentId).filter((id): id is string => Boolean(id)),
          );
          const autoReplyBotIds = new Set(
            channelMemberRows
              .filter((m) => m.autoReply)
              .map((m) => m.agentId)
              .filter((id): id is string => Boolean(id)),
          );

          // Enforce channel membership for @mention under strict auth (or private DMs)
          const mentionEligibleAgents =
            AUTH_REQUIRED || channelRow.kind === 'dm'
              ? knownAgents.filter((a) => channelAgentIds.has(a.id))
              : knownAgents;

          const mentioned = dispatcher.findMentionedAgents(trimmed, mentionEligibleAgents);

          const targetAgentMap = new Map<string, ResolvedAgent>();
          for (const a of mentioned) targetAgentMap.set(a.id, a);
          for (const a of knownAgents) {
            if (!a.archived && autoReplyBotIds.has(a.id)) targetAgentMap.set(a.id, a);
          }

          if (targetAgentMap.size === 0) return;

          const [senderUser] = await db
            .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
            .from(authSchema.user)
            .where(eq(authSchema.user.id, senderId));

          const attachmentNote = hasFiles
            ? `\n\n[附件]\n${attachments!.map((a) => `- ${a.name} (${a.mimeType}, http://localhost:${PORT}${a.url})`).join('\n')}`
            : '';

          // Build recent conversation history context for agent turns
          const historyWhere = threadId
            ? and(
                eq(messages.channelId, channelId),
                eq(messages.threadId, threadId),
                isNull(messages.deletedAt)
              )
            : and(
                eq(messages.channelId, channelId),
                isNull(messages.threadId),
                isNull(messages.deletedAt)
              );

          const [historyRowsDesc, threadRootRows, allUsers] = await Promise.all([
            db
              .select()
              .from(messages)
              .where(historyWhere)
              .orderBy(desc(messages.createdAt))
              .limit(CONTEXT_HISTORY_LIMIT + 1),
            threadId
              ? db
                  .select()
                  .from(messages)
                  .where(and(eq(messages.id, threadId), isNull(messages.deletedAt)))
              : Promise.resolve([]),
            db
              .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
              .from(authSchema.user),
          ]);

          const userNameMap = new Map(
            allUsers.map((u) => [u.id, resolveDisplayName(u.name, u.email)]),
          );
          const botNameMap = new Map(knownAgents.map((a) => [a.id, a.name]));

          const rawHistoryRows = [
            ...threadRootRows,
            ...historyRowsDesc
              .filter((row) => row.id !== saved.id && row.id !== threadId)
              .slice(0, CONTEXT_HISTORY_LIMIT)
              .reverse(),
          ];

          const historyMessages: BuzzTurnContext['messages'] = rawHistoryRows
            .filter(
              (row) =>
                row.card?.status !== 'running' &&
                row.content.trim().length > 0 &&
                !row.content.startsWith('正在向本地 Botmux') &&
                !row.content.startsWith('已在本地 Botmux 启动会话') &&
                !row.content.startsWith('主会话正忙，正在并行启动')
            )
            .map((row) => ({
              sender: row.senderAgentId
                ? botNameMap.get(row.senderAgentId) || row.senderAgentId
                : userNameMap.get(row.senderUserId || '') || row.senderUserId || 'User',
              role: row.senderAgentId ? ('agent' as const) : ('human' as const),
              content: row.content,
            }));

          const channelReplyMode = parseReplyMode(channelRow?.replyMode, DEFAULT_REPLY_MODE);

          for (const agent of targetAgentMap.values()) {
            const replyThreadId = resolveReplyThreadId(
              channelReplyMode,
              channelRow?.kind,
              threadId,
              saved.id
            );

            const turnStartedAt = Date.now();
            const [placeholder] = await db
              .insert(messages)
              .values({
                channelId,
                threadId: replyThreadId,
                senderAgentId: agent.id,
                content: '',
                card: {
                  title: agent.name,
                  status: 'running',
                  phase: 'connecting',
                  startedAt: turnStartedAt,
                },
              })
              .returning();
            broadcast(
              { type: 'message.created', payload: formatMessageRow(placeholder) },
              channelRow.organizationId,
            );

            const dispatched = await dispatcher.dispatchTurn({
              agent,
              turnId: placeholder.id,
              channel: {
                id: channelId,
                name: channelRow?.name || channelId,
                kind: channelRow?.kind || 'channel',
                topic: channelRow?.topic || '',
                replyMode: channelReplyMode,
              },
              ...(threadId ? { threadId } : {}),
              replyThreadId,
              triggerMessage: {
                id: saved.id,
                senderId,
                senderName: senderUser ? resolveDisplayName(senderUser.name, senderUser.email) : senderId,
                content: trimmed,
                attachments: attachments ?? [],
              },
              promptWithAttachments: `${trimmed}${attachmentNote}`,
              history: historyMessages,
              outboundApi: {
                endpoint: `${(process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')}/api/bot/messages`,
                progressEndpoint: `${(process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '')}/api/bot/messages/${placeholder.id}/progress`,
                cliScriptPath: BUZZ_SEND_CLI_PATH,
                botId: agent.id,
                channelId,
                ...(replyThreadId ? { threadId: replyThreadId } : {}),
                placeholderMessageId: placeholder.id,
              },
              turnStartedAt,
            });

            if (!dispatched.ok) {
              const errMsg = dispatched.error || 'Agent 派发失败';
              const [failed] = await db
                .update(messages)
                .set({
                  content: errMsg,
                  card: {
                    title: agent.name,
                    status: 'dispatch_failed',
                    ...(dispatched.parallel ? { parallel: true } : {}),
                    startedAt: turnStartedAt,
                    finishedAt: Date.now(),
                    summary: errMsg,
                  },
                })
                .where(eq(messages.id, placeholder.id))
                .returning();
              if (failed) {
                broadcast(
                  { type: 'message.updated', payload: formatMessageRow(failed) },
                  channelRow.organizationId,
                );
              }
              continue;
            }

            const summary = dispatched.triggerId
              ? `${BOTMUX_TRIGGER_SUMMARY_PREFIX}${dispatched.triggerId}`
              : `adapter: ${dispatched.adapterType}`;

            const [running] = await db
              .update(messages)
              .set({
                botmuxSessionId: dispatched.sessionId || null,
                adapterMeta: dispatched.adapterMeta || null,
                content: '',
                updatedAt: new Date(),
                card: {
                  title: agent.name,
                  status: 'running',
                  phase: 'thinking',
                  ...(dispatched.parallel ? { parallel: true } : {}),
                  startedAt: turnStartedAt,
                  summary,
                },
              })
              .where(and(eq(messages.id, placeholder.id), sql`${messages.card}->>'status' = 'running'`))
              .returning();
            if (running) {
              broadcast(
                { type: 'message.updated', payload: formatMessageRow(running) },
                channelRow.organizationId,
              );
            }

            if (dispatched.adapterType === 'botmux') {
              void dispatcher.getSessions().then((sessions) => broadcastSessionsUpdated(sessions));
            }
          }
        }
      } catch (err) {
        console.error('[Server] WS message error:', err);
        failSend?.('Could not send the message. Try again.');
      }
    },
    async close(ws) {
      if (ws.data.kind === 'bot-gateway') {
        await gatewayAdapter.handleClose(ws as unknown as ServerWebSocket<BotGatewayWsData>);
        return;
      }
      if (ws.data.kind === 'terminal-proxy') {
        try {
          ws.data.upstreamWs?.close();
        } catch {
          // ignore
        }
        ws.data.upstreamWs = null;
        return;
      }
      clients.delete(ws);
      await broadcastPresenceUpdated(ws.data.organizationId ?? null);
    },
  },
});

scheduleBotmuxResultPoll();

console.log(`[Server] Bun + Hono server listening on http://0.0.0.0:${PORT} (db=${dbDriver}, storage=${uploadStorage.driver}: ${uploadStorage.detail})`);
if (STATIC_DIR) console.log(`[Server] Serving static frontend from ${STATIC_DIR}`);
console.log(
  `[Server] Bot Gateway WS enabled at /ws/bot; Botmux direct adapter ${botmuxAdapter.isEnabled() ? `connected to ${BOTMUX_ENDPOINT} (${botmuxAdapter.getCachedBots().length} bots)` : 'disabled'}`,
);
