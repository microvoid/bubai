/**
 * Group chat server powered by Bun + Hono + Drizzle/PGlite (agentes-chat architecture)
 * bridged to local Botmux daemon (/api/* + /events SSE + /api/asks/* + /api/sessions/:sid/*).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ServerWebSocket } from 'bun';
import {
  openChatDatabase,
  users,
  channels,
  channelReads,
  channelMembers,
  messages,
  messageReactions,
  messagePins,
  botmuxBindings,
  agentProfiles,
  sidebarGroups,
  eq,
  asc,
  desc,
  and,
  lt,
  gt,
  isNull,
  inArray,
  ilike,
  sql,
  type MessageAttachment,
  type MessageCardData,
} from '@buzz-botmux/db';
import {
  BotmuxClient,
  type BotmuxBot,
  type BotmuxSession,
  type BuzzTurnContext,
  type DashboardAskAnswerRequest,
  type TriggerResponse,
} from '@buzz-botmux/botmux-client';
import { readAntigravityResult } from './antigravity-result';

const PORT = Number(process.env.PORT || 4000);
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
const UPLOADS_DIR = path.resolve(process.cwd(), '.data/uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const { db } = await openChatDatabase();
const botmux = new BotmuxClient(BOTMUX_ENDPOINT, BOTMUX_TOKEN);

interface WsClientData {
  userId?: string;
}

const clients = new Set<ServerWebSocket<WsClientData>>();
let cachedBots: BotmuxBot[] = [];

function broadcast(event: { type: string; payload: unknown }) {
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    ws.send(payload);
  }
}

async function syncBotmuxAndSeedDefaults() {
  const [owner, bots] = await Promise.all([botmux.getOwnerProfile(), botmux.getBots()]);
  cachedBots = bots;

  const ownerName = owner?.ok && owner.name ? owner.name : 'Owner';
  const ownerAvatar = owner?.ok ? owner.avatarUrl ?? null : null;

  await db
    .insert(users)
    .values({ id: 'u-owner', name: ownerName, avatarUrl: ownerAvatar })
    .onConflictDoUpdate({
      target: users.id,
      set: { name: ownerName, avatarUrl: ownerAvatar },
    });

  const existingChannels = await db.select().from(channels);
  if (existingChannels.length === 0) {
    await db
      .insert(channels)
      .values([
        {
          name: 'general',
          topic: '团队与本地 Botmux Agent 实时协作频道',
          kind: 'channel',
          createdByUserId: 'u-owner',
        },
        {
          name: 'dev-tasks',
          topic: '研发任务协作（@Bot 直接触发本地 Botmux 会话）',
          kind: 'channel',
          createdByUserId: 'u-owner',
        },
      ])
      .onConflictDoNothing();
  }
}

async function listParticipants() {
  const [dbUsers, dbAgentProfiles] = await Promise.all([
    db.select().from(users).orderBy(asc(users.createdAt)),
    db.select().from(agentProfiles),
  ]);
  const profileMap = new Map(dbAgentProfiles.map((p) => [p.agentId, p]));
  const onlineUserIds = new Set<string>();
  for (const ws of clients) {
    if (ws.data.userId) onlineUserIds.add(ws.data.userId);
  }

  const humans = dbUsers.map((u) => ({
    id: u.id,
    name: u.name,
    role: 'human' as const,
    avatarUrl: u.avatarUrl || undefined,
    status: onlineUserIds.has(u.id) ? ('online' as const) : ('offline' as const),
  }));

  const agents = cachedBots.map((b) => {
    const profile = profileMap.get(b.larkAppId);
    return {
      id: b.larkAppId,
      name: profile?.displayName?.trim() || b.botName,
      role: 'agent' as const,
      avatarUrl: profile?.avatarUrl || undefined,
      description: profile?.description || undefined,
      archived: profile?.archived ?? false,
      workingDir: b.workingDir || undefined,
      status: b.online ? ('online' as const) : ('offline' as const),
      cliId: b.cliId,
    };
  });

  return [...humans, ...agents];
}

async function buildAgentDetail(agentId: string, viewerUserId?: string) {
  const [profileRows, memberRows, bindingRows, allChannels, allSessions, allAsks] =
    await Promise.all([
      db.select().from(agentProfiles).where(eq(agentProfiles.agentId, agentId)),
      db.select().from(channelMembers).where(eq(channelMembers.agentId, agentId)),
      db.select().from(botmuxBindings).where(eq(botmuxBindings.botId, agentId)),
      db.select().from(channels).orderBy(asc(channels.createdAt)),
      botmux.getSessions(),
      botmux.getPendingAsks(),
    ]);

  const bot = cachedBots.find((b) => b.larkAppId === agentId);
  const profile = profileRows[0];
  if (!bot && !profile) return null;

  const visibleChannels = allChannels.filter((ch) =>
    viewerUserId ? channelVisibleTo(ch, viewerUserId) : ch.kind !== 'dm'
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
        botName: bot?.botName,
        cliId: bot?.cliId,
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
    name: profile?.displayName?.trim() || bot?.botName || agentId,
    botName: bot?.botName || agentId,
    cliId: bot?.cliId || 'cli',
    status: bot?.online ? ('online' as const) : ('offline' as const),
    workingDir: bot?.workingDir || null,
    description: profile?.description ?? '',
    systemPrompt: profile?.systemPrompt ?? '',
    avatarUrl: profile?.avatarUrl ?? '',
    archived: profile?.archived ?? false,
    updatedAt: profile?.updatedAt?.getTime() ?? null,
    channels: joinedChannels,
    sessions: agentSessions,
    pendingAsks,
    recentMessages,
  };
}

function channelVisibleTo(channel: { kind: string; dmKey: string | null }, userId: string) {
  return channel.kind !== 'dm' || !channel.dmKey || channel.dmKey.split('|').includes(`u:${userId}`);
}

async function listChannelsWithUnread(userId: string) {
  const [channelRows, readRows] = await Promise.all([
    db.select().from(channels).orderBy(asc(channels.createdAt)),
    db.select().from(channelReads).where(eq(channelReads.userId, userId)),
  ]);
  const readMap = new Map(readRows.map((r) => [r.channelId, r]));

  const visibleChannels = channelRows.filter((ch) => {
    if (!channelVisibleTo(ch, userId)) return false;
    const readRow = readMap.get(ch.id);
    if (ch.kind === 'dm' && readRow?.hidden) return false;
    return true;
  });

  return Promise.all(
    visibleChannels.map(async (ch) => {
      const readRow = readMap.get(ch.id);
      const lastRead = readRow?.lastReadAt;
      const countWhere = lastRead
        ? and(
            eq(messages.channelId, ch.id),
            isNull(messages.threadId),
            isNull(messages.deletedAt),
            gt(messages.createdAt, lastRead)
          )
        : and(
            eq(messages.channelId, ch.id),
            isNull(messages.threadId),
            isNull(messages.deletedAt)
          );
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(countWhere);
      const rawUnread = Number(row?.count ?? 0);
      const markedUnread = Boolean(readRow?.markedUnread);
      return {
        id: ch.id,
        name: ch.name,
        topic: ch.topic,
        kind: ch.kind as 'channel' | 'dm',
        replyMode: parseReplyMode(ch.replyMode, DEFAULT_REPLY_MODE),
        archived: Boolean(ch.archived),
        createdByUserId: ch.createdByUserId || undefined,
        dmKey: ch.dmKey || undefined,
        unreadCount: markedUnread ? Math.max(1, rawUnread) : rawUnread,
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
    replyCount,
    reactions,
    pinned,
    createdAt: m.createdAt.getTime(),
    updatedAt: m.updatedAt?.getTime(),
  };
}

async function formatMessagesWithReplyPreviews(
  channelId: string,
  roots: (typeof messages.$inferSelect)[]
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
  const [reactionMap, pinRows] = await Promise.all([
    getReactionsForMessages(messageIds),
    db
      .select({ messageId: messagePins.messageId })
      .from(messagePins)
      .where(and(eq(messagePins.channelId, channelId), inArray(messagePins.messageId, messageIds))),
  ]);
  const pinned = new Set(pinRows.map((pin) => pin.messageId));
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
    return {
      ...formatMessageRow(root, summary?.replyCount, reactionMap.get(root.id), pinned.has(root.id)),
      replyPreviews: summary?.replyPreviews ?? [],
    };
  });
}

function findMentionedBots(
  content: string,
  displayNames?: Map<string, string>
): BotmuxBot[] {
  const lower = content.toLowerCase();
  return cachedBots.filter((b) => {
    const customName = displayNames?.get(b.larkAppId)?.trim().toLowerCase();
    return (
      lower.includes(`@${b.botName.toLowerCase()}`) ||
      lower.includes(`@${b.larkAppId.toLowerCase()}`) ||
      (Boolean(customName) && lower.includes(`@${customName}`))
    );
  });
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
  const result = await botmux.pollTriggerResult(sessionId, triggerId).catch(() => undefined);
  const bot = cachedBots.find((item) => item.larkAppId === botId);
  let content: string | undefined;
  let status: MessageCardData['status'] = 'failed';

  if (result?.state === 'completed') {
    content = result.output?.content?.trim() || '（任务已完成，无文本输出）';
    status = 'completed';
  } else if (result?.state === 'interrupted') {
    content = 'Botmux 执行已中断。';
  } else if (
    result?.state === 'failed' ||
    (result?.state === 'not_found' && age >= BOTMUX_RESULT_GRACE_MS)
  ) {
    content = result.error || 'Botmux 未能返回本轮回复。';
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
      content = await readAntigravityResult({ triggerId, botId, channelId, createdAt: row.createdAt });
      if (content) status = 'completed';
    }
  }

  if (!content && age >= BOTMUX_RESULT_TIMEOUT_MS) {
    content = '等待 Botmux 回复超时。可打开终端查看执行情况。';
  }
  if (!content) return;

  const [updated] = await db
    .update(messages)
    .set({
      content,
      card: {
        title: card.title,
        status,
        summary: status === 'completed' ? `Botmux turn completed (${triggerId})` : content,
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
    broadcast({ type: 'message.updated', payload: formatMessageRow(updated, 0, reactions) });
    return true;
  }
}

async function pollBotmuxTurns() {
  // The placeholder carries the accepted trigger so polling can resume on restart.
  const pending = await db.select().from(messages).where(and(
    isNull(messages.deletedAt),
    sql`${messages.card}->>'status' = 'running'`,
    sql`${messages.card}->>'summary' LIKE ${`${BOTMUX_TRIGGER_SUMMARY_PREFIX}%`}`
  ));
  let sessions: Promise<BotmuxSession[]> | undefined;
  const results = await Promise.allSettled(pending.map((row) =>
    reconcileBotmuxTurn(row, () => (sessions ??= botmux.getSessions()))
  ));
  for (const result of results) {
    if (result.status === 'rejected') console.error('[Server] Botmux reply writeback failed:', result.reason);
  }
  if (results.some((result) => result.status === 'fulfilled' && result.value)) {
    broadcast({ type: 'sessions.updated', payload: { sessions: await (sessions ?? botmux.getSessions()) } });
  }
}

function scheduleBotmuxResultPoll() {
  setTimeout(() => {
    void pollBotmuxTurns()
      .catch((err) => console.error('[Server] Botmux reply poll failed:', err))
      .finally(scheduleBotmuxResultPoll);
  }, BOTMUX_RESULT_POLL_MS);
}

const app = new Hono();
app.use('*', cors());

app.get('/health', async (c) => {
  const botmuxStatus = await botmux.checkHealth();
  return c.json({ status: 'ok', botmux: botmuxStatus });
});

app.get('/api/bootstrap', async (c) => {
  const userId = c.req.query('userId') || 'u-owner';
  await syncBotmuxAndSeedDefaults();
  const [channelList, participants, sessions, asks, botmuxStatus, groupRows] = await Promise.all([
    listChannelsWithUnread(userId),
    listParticipants(),
    botmux.getSessions(),
    botmux.getPendingAsks(),
    botmux.checkHealth(),
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

  return c.json({
    messages: await formatMessagesWithReplyPreviews(channelId, pageRows),
    hasMore,
    nextCursor: hasMore && pageRows[0] ? pageRows[0].createdAt.getTime() : null,
    nextCursorId: hasMore ? pageRows[0]?.id : undefined,
  });
});

app.get('/api/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const channelId = c.req.query('channelId');
  const userId = c.req.query('userId') || 'u-owner';
  if (!q) return c.json({ results: [] });

  const searchChannels = await db
    .select({ id: channels.id, kind: channels.kind, dmKey: channels.dmKey })
    .from(channels)
    .where(channelId ? eq(channels.id, channelId) : undefined);
  const allowed = searchChannels.filter((channel) => channelVisibleTo(channel, userId));
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
      pinnedByUserId: body.userId || 'u-owner',
    })
    .onConflictDoNothing();

  const pins = await listPinnedMessages(channelId);
  broadcast({ type: 'pins.updated', payload: { channelId, pins } });
  return c.json({ pins });
});

app.delete('/api/channels/:channelId/pins/:messageId', async (c) => {
  const channelId = c.req.param('channelId');
  const messageId = c.req.param('messageId');
  await db
    .delete(messagePins)
    .where(and(eq(messagePins.channelId, channelId), eq(messagePins.messageId, messageId)));

  const pins = await listPinnedMessages(channelId);
  broadcast({ type: 'pins.updated', payload: { channelId, pins } });
  return c.json({ pins });
});

/** Local File / Image Attachment Upload & Static Serving */
app.post('/api/uploads', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'Missing file field' }, 400);
  }
  const id = randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]+/g, '_').slice(0, 120);
  const storedName = `${id}-${safeName}`;
  const fullPath = path.join(UPLOADS_DIR, storedName);
  const bytes = await file.arrayBuffer();
  await Bun.write(fullPath, bytes);

  const attachment: MessageAttachment = {
    id,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    url: `/api/uploads/${encodeURIComponent(storedName)}`,
  };
  return c.json({ attachment }, 201);
});

app.get('/api/uploads/:filename', async (c) => {
  const filename = path.basename(c.req.param('filename'));
  const fullPath = path.join(UPLOADS_DIR, filename);
  const bunFile = Bun.file(fullPath);
  if (!(await bunFile.exists())) {
    return c.json({ error: 'File not found' }, 404);
  }
  return new Response(bunFile, {
    headers: {
      'Content-Type': bunFile.type || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
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
  const body = await c.req.json<{ content?: string }>();
  const content = body.content?.trim();
  if (!content) return c.json({ error: 'Content required' }, 400);

  const [updated] = await db
    .update(messages)
    .set({ content, updatedAt: new Date() })
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
    .returning();
  if (!updated) return c.json({ error: 'Message not found' }, 404);

  const rx = (await getReactionsForMessages([updated.id])).get(updated.id) || [];
  const dto = formatMessageRow(updated, 0, rx);
  broadcast({ type: 'message.updated', payload: dto });
  return c.json({ message: dto });
});

app.delete('/api/messages/:messageId', async (c) => {
  const messageId = c.req.param('messageId');
  const [deleted] = await db
    .update(messages)
    .set({ deletedAt: new Date() })
    .where(eq(messages.id, messageId))
    .returning();
  if (!deleted) return c.json({ error: 'Message not found' }, 404);

  broadcast({
    type: 'message.deleted',
    payload: {
      id: deleted.id,
      channelId: deleted.channelId,
      threadId: deleted.threadId || undefined,
    },
  });
  return c.json({ ok: true, id: deleted.id });
});

app.post('/api/messages/:messageId/reactions', async (c) => {
  const messageId = c.req.param('messageId');
  const body = await c.req.json<{ userId?: string; emoji?: string }>();
  const userId = body.userId || 'u-owner';
  const emoji = body.emoji?.trim();
  if (!emoji) return c.json({ error: 'Emoji required' }, 400);

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
  broadcast({ type: 'reaction.updated', payload: { messageId, reactions } });
  return c.json({ messageId, reactions });
});

app.post('/api/channels/:channelId/read', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{ userId?: string }>().catch(() => ({ userId: undefined }));
  const userId = body.userId || 'u-owner';
  const now = new Date();
  await db
    .insert(channelReads)
    .values({ channelId, userId, lastReadAt: now })
    .onConflictDoUpdate({
      target: [channelReads.channelId, channelReads.userId],
      set: { lastReadAt: now },
    });
  return c.json({ ok: true, channelId, userId, lastReadAt: now.getTime() });
});

app.post('/api/channels', async (c) => {
  const body = await c.req.json<{ name?: string; topic?: string; userId?: string }>();
  const cleanName = (body.name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-');
  if (!cleanName) return c.json({ error: 'Channel name required' }, 400);

  const [created] = await db
    .insert(channels)
    .values({
      name: cleanName,
      topic: body.topic?.trim() || '',
      kind: 'channel',
      createdByUserId: body.userId || 'u-owner',
    })
    .returning();

  const dto = {
    id: created.id,
    name: created.name,
    topic: created.topic,
    kind: 'channel' as const,
    replyMode: parseReplyMode(created.replyMode, DEFAULT_REPLY_MODE),
    unreadCount: 0,
    createdAt: created.createdAt.getTime(),
  };
  broadcast({ type: 'channel.created', payload: dto });
  return c.json({ channel: dto }, 201);
});

app.patch('/api/channels/:channelId/settings', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{ replyMode?: string }>();
  if (
    body.replyMode !== undefined &&
    !(REPLY_MODES as readonly string[]).includes(body.replyMode)
  ) {
    return c.json(
      { error: `replyMode must be one of ${REPLY_MODES.join(', ')}` },
      400
    );
  }
  const [updated] = await db
    .update(channels)
    .set({
      ...(body.replyMode !== undefined ? { replyMode: body.replyMode } : {}),
    })
    .where(eq(channels.id, channelId))
    .returning();
  if (!updated) return c.json({ error: 'Channel not found' }, 404);
  return c.json({
    channel: {
      id: updated.id,
      name: updated.name,
      topic: updated.topic,
      kind: updated.kind as 'channel' | 'dm',
      replyMode: parseReplyMode(updated.replyMode, DEFAULT_REPLY_MODE),
      dmKey: updated.dmKey || undefined,
      createdAt: updated.createdAt.getTime(),
    },
  });
});

/** Explicit outbound endpoint for Bots / automated tasks to post into main timeline or a Thread */
app.post('/api/bot/messages', async (c) => {
  if (BUZZ_BOT_TOKEN) {
    const auth = c.req.header('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (token !== BUZZ_BOT_TOKEN) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }

  const body = await c.req.json<{
    botId?: string;
    channelId?: string;
    channelName?: string;
    content?: string;
    threadId?: string | null;
    replyToId?: string | null;
    attachments?: MessageAttachment[];
    botmuxSessionId?: string;
  }>();

  const rawBotRef = body.botId?.trim();
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

  if (cachedBots.length === 0) {
    cachedBots = await botmux.getBots();
  }
  const matchedBot = cachedBots.find(
    (b) =>
      b.larkAppId === rawBotRef ||
      b.botName.toLowerCase() === rawBotRef.toLowerCase()
  );
  const botId = matchedBot?.larkAppId || rawBotRef;

  const [channelRow] = rawChannelId
    ? await db.select().from(channels).where(eq(channels.id, rawChannelId))
    : await db.select().from(channels).where(eq(channels.name, rawChannelName!));
  if (!channelRow) {
    return c.json({ error: 'Channel not found' }, 404);
  }

  const resolvedThreadId = body.threadId ? body.threadId.trim() : null;
  const resolvedReplyToId = resolvedThreadId && body.replyToId ? body.replyToId.trim() : null;

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
    })
    .returning();

  const dto = formatMessageRow(saved);
  broadcast({ type: 'message.created', payload: dto });
  return c.json({ message: dto }, 201);
});

app.post('/api/dms', async (c) => {
  const body = await c.req.json<{
    userId?: string;
    targetId?: string;
    targetRole?: 'human' | 'agent';
    targetName?: string;
  }>();
  const userId = body.userId || 'u-owner';
  const targetId = body.targetId;
  const targetRole = body.targetRole || 'agent';
  if (!targetId) return c.json({ error: 'targetId required' }, 400);

  const selfKey = `u:${userId}`;
  const targetKey = targetRole === 'agent' ? `a:${targetId}` : `u:${targetId}`;
  const dmKey = [selfKey, targetKey].sort().join('|');

  const [existing] = await db.select().from(channels).where(eq(channels.dmKey, dmKey));
  if (existing) {
    return c.json({
      channel: {
        id: existing.id,
        name: existing.name,
        topic: existing.topic,
        kind: 'dm' as const,
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
  broadcast({ type: 'channel.created', payload: dto });
  return c.json({ channel: dto }, 201);
});

app.get('/api/channels/:channelId/members', async (c) => {
  const channelId = c.req.param('channelId');
  const [[channel], rows] = await Promise.all([
    db.select().from(channels).where(eq(channels.id, channelId)),
    db.select().from(channelMembers).where(eq(channelMembers.channelId, channelId))
      .orderBy(asc(channelMembers.createdAt)),
  ]);
  if (!channel) return c.json({ error: 'Channel not found' }, 404);

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
  return c.json({ members: rows, ownerId });
});

app.post('/api/channels/:channelId/members', async (c) => {
  const channelId = c.req.param('channelId');
  const body = await c.req.json<{ userId?: string; agentId?: string; autoReply?: boolean }>();
  if (!body.userId && !body.agentId) {
    return c.json({ error: 'userId or agentId required' }, 400);
  }

  if (body.agentId) {
    const [row] = await db
      .insert(channelMembers)
      .values({ channelId, agentId: body.agentId, autoReply: Boolean(body.autoReply) })
      .onConflictDoUpdate({
        target: [channelMembers.channelId, channelMembers.agentId],
        set: { autoReply: Boolean(body.autoReply) },
      })
      .returning();
    return c.json({ member: row });
  }

  const [row] = await db
    .insert(channelMembers)
    .values({ channelId, userId: body.userId!, autoReply: false })
    .onConflictDoNothing()
    .returning();
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
  }
  return c.json({ ok: true });
});

app.post('/api/humans', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim();
  if (!name) return c.json({ error: 'Name required' }, 400);

  const id = `u-${Date.now().toString(36)}`;
  const [created] = await db.insert(users).values({ id, name }).returning();
  broadcast({ type: 'presence.updated', payload: { participants: await listParticipants() } });
  return c.json(
    { human: { id: created.id, name: created.name, role: 'human', status: 'online' } },
    201
  );
});

app.get('/api/sessions/:sessionId/write-link', async (c) => {
  const sessionId = c.req.param('sessionId');
  const url = await botmux.getSessionWriteLink(sessionId);
  return c.json({ sessionId, url });
});

app.post('/api/sessions/:sessionId/:op', async (c) => {
  const sessionId = c.req.param('sessionId');
  const op = c.req.param('op');
  if (op !== 'restart' && op !== 'close' && op !== 'resume') {
    return c.json({ error: 'Unsupported session op' }, 400);
  }
  const result = await botmux.sessionAction(sessionId, op);
  const sessions = await botmux.getSessions();
  broadcast({ type: 'sessions.updated', payload: { sessions } });
  return c.json(result.body as Record<string, unknown>, result.status as 200);
});

app.get('/api/sessions/:sessionId/history', async (c) => {
  const sessionId = c.req.param('sessionId');
  const [result, localRows] = await Promise.all([
    botmux.getSessionHistory(sessionId),
    db
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
  const asks = await botmux.getPendingAsks();
  return c.json({ asks });
});

app.post('/api/asks/answer', async (c) => {
  const body = await c.req.json<DashboardAskAnswerRequest>();
  const result = await botmux.answerAsk(body);
  const asks = await botmux.getPendingAsks();
  broadcast({ type: 'asks.updated', payload: { asks } });
  return c.json(result.body as Record<string, unknown>, result.status as 200);
});

app.get('/api/agents/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const userId = c.req.query('userId');
  const detail = await buildAgentDetail(agentId, userId);
  if (!detail) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ agent: detail });
});

app.patch('/api/agents/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const userId = c.req.query('userId');
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

  broadcast({ type: 'presence.updated', payload: { participants: await listParticipants() } });
  const detail = await buildAgentDetail(agentId, userId);
  return c.json({ agent: detail });
});

await syncBotmuxAndSeedDefaults();

botmux.subscribeEvents((eventName, data) => {
  if (eventName === 'sessions' || eventName === 'session' || eventName === 'message') {
    void botmux.getSessions().then((sessions) => {
      broadcast({ type: 'sessions.updated', payload: { sessions } });
    });
    void botmux.getPendingAsks().then((asks) => {
      broadcast({ type: 'asks.updated', payload: { asks } });
    });
  }
  broadcast({ type: 'botmux.event', payload: { eventName, data } });
});

Bun.serve<WsClientData>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (server.upgrade(req, { data: {} })) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      clients.add(ws);
    },
    async message(ws, raw) {
      try {
        const event = JSON.parse(String(raw)) as
          | { type: 'presence.identify'; payload: { userId: string } }
          | {
              type: 'message.send';
              payload: {
                channelId: string;
                senderId: string;
                content: string;
                threadId?: string;
                replyToId?: string;
                attachments?: MessageAttachment[];
              };
            };

        if (event.type === 'presence.identify') {
          ws.data.userId = event.payload.userId;
          broadcast({
            type: 'presence.updated',
            payload: { participants: await listParticipants() },
          });
          return;
        }

        if (event.type === 'message.send') {
          const { channelId, senderId, content, threadId, replyToId, attachments } = event.payload;
          const trimmed = content.trim();
          const hasFiles = Array.isArray(attachments) && attachments.length > 0;
          if (!trimmed && !hasFiles) return;

          const [saved] = await db
            .insert(messages)
            .values({
              channelId,
              threadId: threadId || null,
              replyToId: threadId && replyToId ? replyToId : null,
              senderUserId: senderId,
              content: trimmed,
              attachments: hasFiles ? attachments : null,
            })
            .returning();
          broadcast({ type: 'message.created', payload: formatMessageRow(saved) });

          if (!threadId) {
            await db
              .insert(channelReads)
              .values({ channelId, userId: senderId, lastReadAt: new Date() })
              .onConflictDoUpdate({
                target: [channelReads.channelId, channelReads.userId],
                set: { lastReadAt: new Date() },
              });
          }

          if (cachedBots.length === 0) {
            cachedBots = await botmux.getBots();
          }

          const allProfiles = await db.select().from(agentProfiles);
          const profileByAgentId = new Map(allProfiles.map((p) => [p.agentId, p]));
          const profileNameMap = new Map(
            allProfiles
              .filter((p) => Boolean(p.displayName?.trim()))
              .map((p) => [p.agentId, p.displayName!.trim()])
          );

          const mentioned = findMentionedBots(trimmed, profileNameMap);
          const autoReplyMembers = await db
            .select()
            .from(channelMembers)
            .where(
              and(eq(channelMembers.channelId, channelId), eq(channelMembers.autoReply, true))
            );
          const autoReplyBotIds = new Set(
            autoReplyMembers.map((m) => m.agentId).filter((id): id is string => Boolean(id))
          );

          const targetBotMap = new Map<string, BotmuxBot>();
          for (const b of mentioned) targetBotMap.set(b.larkAppId, b);
          for (const b of cachedBots) {
            if (autoReplyBotIds.has(b.larkAppId)) targetBotMap.set(b.larkAppId, b);
          }

          if (targetBotMap.size === 0) return;

          const [channelRow] = await db
            .select()
            .from(channels)
            .where(eq(channels.id, channelId));
          const [senderUser] = await db.select().from(users).where(eq(users.id, senderId));

          const attachmentNote = hasFiles
            ? `\n\n[附件]\n${attachments!.map((a) => `- ${a.name} (${a.mimeType}, http://localhost:${PORT}${a.url})`).join('\n')}`
            : '';

          // Build recent conversation history context for Botmux turns
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
            db.select().from(users),
          ]);

          const userNameMap = new Map(allUsers.map((u) => [u.id, u.name]));
          const botNameMap = new Map(
            cachedBots.map((b) => [b.larkAppId, profileNameMap.get(b.larkAppId) || b.botName])
          );

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
                !row.content.startsWith('正在向本地 Botmux') &&
                !row.content.startsWith('已在本地 Botmux 启动会话')
            )
            .map((row) => ({
              sender: row.senderAgentId
                ? botNameMap.get(row.senderAgentId) || row.senderAgentId
                : userNameMap.get(row.senderUserId || '') || row.senderUserId || 'User',
              role: row.senderAgentId ? ('agent' as const) : ('human' as const),
              content: row.content,
            }));

          const channelReplyMode = parseReplyMode(channelRow?.replyMode, DEFAULT_REPLY_MODE);

          for (const bot of targetBotMap.values()) {
            const [binding] = await db
              .select()
              .from(botmuxBindings)
              .where(
                and(eq(botmuxBindings.channelId, channelId), eq(botmuxBindings.botId, bot.larkAppId))
              );

            const existingSessionId = binding?.sessionId;
            const replyThreadId = resolveReplyThreadId(
              channelReplyMode,
              channelRow?.kind,
              threadId,
              saved.id
            );

            const [placeholder] = await db
              .insert(messages)
              .values({
                channelId,
                threadId: replyThreadId,
                senderAgentId: bot.larkAppId,
                content: `正在向本地 Botmux (${bot.botName}) 派发指令...`,
                botmuxSessionId: existingSessionId,
                card: {
                  title: `${bot.botName} · ${bot.cliId}`,
                  status: 'running',
                  summary: existingSessionId
                    ? `复用会话 ${existingSessionId}`
                    : '正在创建新的 Botmux 会话...',
                },
              })
              .returning();
            broadcast({ type: 'message.created', payload: formatMessageRow(placeholder) });

            const turnContext: BuzzTurnContext = {
              channel: {
                id: channelId,
                name: channelRow?.name || channelId,
                kind: channelRow?.kind || 'channel',
                topic: channelRow?.topic || '',
                replyMode: channelReplyMode,
              },
              ...(threadId ? { threadId } : {}),
              outboundApi: {
                endpoint: `http://127.0.0.1:${PORT}/api/bot/messages`,
                cliScriptPath: BUZZ_SEND_CLI_PATH,
                botId: bot.larkAppId,
                channelId,
              },
              messages: historyMessages,
            };

            const botSystemPrompt = profileByAgentId.get(bot.larkAppId)?.systemPrompt?.trim();
            const triggered = await botmux.triggerTurn({
              botId: bot.larkAppId,
              sessionId: existingSessionId,
              prompt: `${trimmed}${attachmentNote}`,
              senderName: senderUser?.name || senderId,
              systemPrompt: botSystemPrompt || undefined,
              context: turnContext,
            }).catch((err: unknown): TriggerResponse => ({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }));

            const sessionId = triggered.target?.sessionId || existingSessionId;
            if (!triggered.ok || !sessionId || !triggered.triggerId) {
              const errMsg = triggered.error || 'Botmux 未返回本轮派发信息。';
              const [failed] = await db
                .update(messages)
                .set({
                  content: `派发失败：${errMsg}`,
                  card: {
                    title: `${bot.botName} · Error`,
                    status: 'failed',
                    summary: errMsg,
                  },
                })
                .where(eq(messages.id, placeholder.id))
                .returning();
              if (failed) broadcast({ type: 'message.updated', payload: formatMessageRow(failed) });
              continue;
            }

            await db
              .insert(botmuxBindings)
              .values({ channelId, botId: bot.larkAppId, sessionId, updatedAt: new Date() })
              .onConflictDoUpdate({
                target: [botmuxBindings.channelId, botmuxBindings.botId],
                set: { sessionId, updatedAt: new Date() },
              });

            const [running] = await db
              .update(messages)
              .set({
                botmuxSessionId: sessionId,
                content: `已在本地 Botmux 启动会话 \`${sessionId}\`，执行中...`,
                updatedAt: new Date(),
                card: {
                  title: `${bot.botName} · ${sessionId}`,
                  status: 'running',
                  summary: `${BOTMUX_TRIGGER_SUMMARY_PREFIX}${triggered.triggerId}`,
                },
              })
              .where(eq(messages.id, placeholder.id))
              .returning();
            if (running) broadcast({ type: 'message.updated', payload: formatMessageRow(running) });

            void botmux.getSessions().then((sessions) => {
              broadcast({ type: 'sessions.updated', payload: { sessions } });
            });
          }
        }
      } catch (err) {
        console.error('[Server] WS message error:', err);
      }
    },
    async close(ws) {
      clients.delete(ws);
      broadcast({
        type: 'presence.updated',
        payload: { participants: await listParticipants() },
      });
    },
  },
});

scheduleBotmuxResultPoll();

console.log(`[Server] Bun + Hono + PGlite server listening on http://localhost:${PORT}`);
console.log(`[Server] Connected to Botmux at ${BOTMUX_ENDPOINT} (${cachedBots.length} real bots)`);
