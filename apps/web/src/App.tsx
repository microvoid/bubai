import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentProfilePanel } from './features/agent-profile/AgentProfilePanel';
import { AppearanceControls } from './features/appearance/AppearanceControls';
import { ResizableSidebar } from './features/channel-navigation/ResizableSidebar';
import { SidebarFrame } from './features/channel-navigation/SidebarFrame';
import {
  ChannelHeaderIdentity,
  ChannelMembersDialog,
  type ChannelMember,
} from './features/channel-navigation/ChannelMembers';
import { ChannelPinsButton, ChannelPinsPanel } from './features/channel-navigation/ChannelPins';
import { BuzzChannelTimeline } from './features/messages/BuzzChannelTimeline';
import { BuzzInlineThreadSheet } from './features/messages/BuzzInlineThreadSheet';
import {
  BuzzMediaViewer,
  type MediaViewerSelection,
} from './features/messages/BuzzMediaViewer';
import {
  ComposerScopeProvider,
  useComposerDockRef,
} from './features/messages/composer-overlay';
import type { ReactionGroup } from './features/messages/MessageReactions';
import {
  ProseMirrorComposer,
  type UploadedAttachment,
} from './features/messages/ProseMirrorComposer';
import type { ChatMessage as Message, MessageFocus, Participant } from './features/messages/types';
import { BuzzPageSearch } from './features/search/BuzzPageSearch';
import workspaceStyles from './Workspace.module.css';
import messageStyles from './features/messages/Messages.module.css';
import { useAppearance } from './shared/theme/service';
import { NavigationSection } from './design-system/ui/NavigationSection';
import { NavigationItem } from './design-system/ui/NavigationItem';
import { Panel } from './design-system/ui/Panel';
import { PanelHeader } from './design-system/ui/PanelHeader';
import { Avatar } from './design-system/ui/Avatar';
import { Badge } from './design-system/ui/Badge';
import { CountBadge } from './design-system/ui/CountBadge';
import { Button } from './design-system/ui/Button';
import { IconButton } from './design-system/ui/IconButton';
import { EmptyState } from './design-system/ui/EmptyState';
import { Input } from './design-system/ui/Input';
import {
  ClockIcon,
  HashIcon,
  PaletteIcon,
  PlusIcon,
  SparklesIcon,
  TerminalWindowIcon,
  XIcon,
} from './design-system/icons/index';

interface Channel {
  id: string;
  name: string;
  topic: string;
  kind?: 'channel' | 'dm';
  dmKey?: string;
  unreadCount: number;
  createdAt: number;
}

interface BotmuxSession {
  sessionId: string;
  larkAppId?: string;
  botName?: string;
  cliId?: string;
  state?: string;
  title?: string;
}

interface BotmuxPendingAsk {
  askId: string;
  sessionId?: string;
  larkAppId: string;
  botName?: string;
  title?: string;
  prompt?: string;
  questions?: {
    question?: string;
    header?: string;
    options?: { key: string; label: string; description?: string }[];
  }[];
}

interface BotmuxStatus {
  endpoint: string;
  connected: boolean;
  authenticated: boolean;
  detail: string;
}

const SERVER_HTTP = import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';
const SERVER_WS = SERVER_HTTP.replace(/^http/, 'ws') + '/ws';
const THREAD_REPLY_PREVIEW_LIMIT = 5;

interface HistoryPage {
  messages: Message[];
  hasMore: boolean;
  nextCursor: number | null;
  nextCursorId?: string;
}

async function fetchMessagePage(
  channelId: string,
  signal: AbortSignal,
  cursor?: Pick<HistoryPage, 'nextCursor' | 'nextCursorId'>,
  limit = 50,
): Promise<HistoryPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor?.nextCursor != null) {
    query.set('before', String(cursor.nextCursor));
    if (cursor.nextCursorId) query.set('beforeId', cursor.nextCursorId);
  }
  const response = await fetch(
    `${SERVER_HTTP}/api/channels/${encodeURIComponent(channelId)}/messages?${query}`,
    { signal },
  );
  if (!response.ok) throw new Error('Could not load channel messages');
  return (await response.json()) as HistoryPage;
}

function ConversationSurface({
  activeChannel,
  messages,
  participants,
  currentUserId,
  hasMore,
  loadingMore,
  onLoadOlder,
  activeThreadRootId,
  threadRoot,
  threadReplies,
  timelineFocus,
  replyFocus,
  editingMessageId,
  editingDraft,
  onEditingDraftChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onTogglePin,
  onToggleReaction,
  onOpenThread,
  onOpenReply,
  onCloseThread,
  onOpenTerminal,
  onOpenMedia,
  onOpenAgentProfile,
  onUploadFile,
  onSendMessage,
  onSendThreadReply,
}: {
  activeChannel: Channel | undefined;
  messages: readonly Message[];
  participants: readonly Participant[];
  currentUserId: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadOlder: () => void;
  activeThreadRootId: string | null;
  threadRoot: Message | null;
  threadReplies: readonly Message[];
  timelineFocus?: MessageFocus;
  replyFocus?: MessageFocus;
  editingMessageId: string | null;
  editingDraft: string;
  onEditingDraftChange: (v: string) => void;
  onStartEdit: (msg: Message) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onDelete: (id: string) => void;
  onTogglePin: (msg: Message) => void;
  onToggleReaction: (id: string, emoji: string) => void;
  onOpenThread: (id: string) => void;
  onOpenReply: (message: Message) => void;
  onCloseThread: () => void;
  onOpenTerminal: (sessionId: string) => void;
  onOpenMedia: (attachments: readonly UploadedAttachment[], selectedId: string) => void;
  onOpenAgentProfile: (agentId: string) => void;
  onUploadFile: (file: File) => Promise<UploadedAttachment | null>;
  onSendMessage: (content: string, attachments: UploadedAttachment[]) => void;
  onSendThreadReply: (
    content: string,
    attachments: UploadedAttachment[],
    replyToId?: string,
  ) => void;
}) {
  const dockRef = useComposerDockRef();

  return (
    <div className={messageStyles.thread} style={{ flex: 1 }}>
      <BuzzChannelTimeline
        channelId={activeChannel?.id || ''}
        messages={messages}
        participants={participants}
        currentUserId={currentUserId}
        serverHttp={SERVER_HTTP}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadOlder={onLoadOlder}
        activeThreadRootId={activeThreadRootId}
        messageFocus={timelineFocus}
        editingMessageId={editingMessageId}
        editingDraft={editingDraft}
        onEditingDraftChange={onEditingDraftChange}
        onStartEdit={onStartEdit}
        onSaveEdit={onSaveEdit}
        onCancelEdit={onCancelEdit}
        onDelete={onDelete}
        onTogglePin={onTogglePin}
        onToggleReaction={onToggleReaction}
        onOpenThread={onOpenThread}
        onOpenReply={onOpenReply}
        onOpenTerminal={onOpenTerminal}
        onOpenMedia={onOpenMedia}
        onOpenAgentProfile={onOpenAgentProfile}
        emptyState={
          <EmptyState
            icon={<SparklesIcon size={24} />}
            title={
              activeChannel?.kind === 'dm'
                ? activeChannel.topic || activeChannel.name
                : `#${activeChannel?.name || 'channel'}`
            }
            description={
              activeChannel?.kind === 'dm'
                ? '私聊模式：直接发送消息即可与该 Bot 对话（无需 @）。'
                : activeChannel?.topic ||
                  '在下方输入框输入 @ 召唤本地 Botmux Agent 开始协作对话，支持上传或粘贴图片。'
            }
          />
        }
      />

      <ProseMirrorComposer
        dockRef={dockRef}
        candidates={participants}
        disabled={!activeChannel}
        serverHttp={SERVER_HTTP}
        onUploadFile={onUploadFile}
        onSend={onSendMessage}
        placeholder={
          activeChannel?.kind === 'dm'
            ? 'Message directly...'
            : activeChannel
              ? `Message #${activeChannel.name}`
              : 'Select a channel'
        }
      />

      {/* Buzz inline in-conversation thread sheet docked over .composerDock */}
      <BuzzInlineThreadSheet
        open={Boolean(activeThreadRootId)}
        root={threadRoot}
        replies={threadReplies}
        messageFocus={replyFocus}
        participants={participants}
        currentUserId={currentUserId}
        serverHttp={SERVER_HTTP}
        editingMessageId={editingMessageId}
        editingDraft={editingDraft}
        onEditingDraftChange={onEditingDraftChange}
        onStartEdit={onStartEdit}
        onSaveEdit={onSaveEdit}
        onCancelEdit={onCancelEdit}
        onDelete={onDelete}
        onTogglePin={onTogglePin}
        onToggleReaction={onToggleReaction}
        onOpenTerminal={onOpenTerminal}
        onOpenMedia={onOpenMedia}
        onOpenAgentProfile={onOpenAgentProfile}
        onUploadFile={onUploadFile}
        onSendReply={onSendThreadReply}
        onClose={onCloseThread}
      />
    </div>
  );
}

export default function App() {
  // Initialize Buzz appearance service (theme mode, accent color, bubble contrast / vibe level)
  useAppearance();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [sessions, setSessions] = useState<BotmuxSession[]>([]);
  const [asks, setAsks] = useState<BotmuxPendingAsk[]>([]);
  const [botmuxStatus, setBotmuxStatus] = useState<BotmuxStatus | null>(null);

  const [activeChannelId, setActiveChannelId] = useState<string>('');
  const [currentUserId, setCurrentUserId] = useState<string>('u-owner');

  // Appearance popover
  const [showAppearance, setShowAppearance] = useState(false);

  // Paginated root messages
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [nextCursorId, setNextCursorId] = useState<string>();
  const [loadedChannelId, setLoadedChannelId] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const history = useRef<HistoryPage>({ messages, hasMore, nextCursor, nextCursorId });
  history.current = { messages, hasMore, nextCursor, nextCursorId };
  const channelRef = useRef(activeChannelId);
  channelRef.current = activeChannelId;
  const olderRequest = useRef<AbortController | null>(null);

  const [pins, setPins] = useState<Message[]>([]);
  const [showPinsPanel, setShowPinsPanel] = useState(false);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [pinsError, setPinsError] = useState<string | null>(null);
  const [pinsRevision, setPinsRevision] = useState(0);
  const pinsButton = useRef<HTMLButtonElement>(null);

  const jumpSequence = useRef(0);
  const [jumpTarget, setJumpTarget] = useState<{ message: Message; sequence: number } | null>(null);
  const [messageFocus, setMessageFocus] = useState<{
    channelId: string;
    timeline: MessageFocus;
    reply?: MessageFocus;
  } | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);

  // Inline editing
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');

  // Channel members & autoReply
  const [showMembersPanel, setShowMembersPanel] = useState(false);
  const [channelMembersList, setChannelMembersList] = useState<ChannelMember[]>([]);
  const [channelOwnerId, setChannelOwnerId] = useState<string>();
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [membersRevision, setMembersRevision] = useState(0);
  const membersButton = useRef<HTMLButtonElement>(null);

  // Inline Thread sheet
  const [activeThreadRootId, setActiveThreadRootId] = useState<string | null>(null);
  const activeThreadRootRef = useRef(activeThreadRootId);
  activeThreadRootRef.current = activeThreadRootId;
  const [threadRoot, setThreadRoot] = useState<Message | null>(null);
  const [threadReplies, setThreadReplies] = useState<Message[]>([]);

  const applyPins = useCallback((nextPins: Message[]) => {
    const pinnedIds = new Set(nextPins.map((pin) => pin.id));
    const updatePin = (message: Message) => {
      const pinned = pinnedIds.has(message.id);
      return Boolean(message.pinned) === pinned ? message : { ...message, pinned };
    };
    setPins(nextPins);
    setMessages((current) => current.map(updatePin));
    setThreadRoot((current) => current && updatePin(current));
    setThreadReplies((current) => current.map(updatePin));
  }, []);

  // In-app Media Viewer
  const [mediaViewer, setMediaViewer] = useState<MediaViewerSelection | null>(null);

  // Agent Profile Panel
  const [selectedAgentProfileId, setSelectedAgentProfileId] = useState<string | null>(null);
  const [showArchivedAgents, setShowArchivedAgents] = useState(false);

  const [creatingChannel, setCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [addingHuman, setAddingHuman] = useState(false);
  const [newHumanName, setNewHumanName] = useState('');

  // Botmux Web Terminal & History
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const [terminalUrl, setTerminalUrl] = useState<string | null>(null);
  const [showSessionHistory, setShowSessionHistory] = useState(false);
  const [sessionHistoryData, setSessionHistoryData] = useState<string | null>(null);
  const [sessionActionBusy, setSessionActionBusy] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  const markChannelRead = (channelId: string, userId: string) => {
    setChannels((prev) =>
      prev.map((c) => (c.id === channelId ? { ...c, unreadCount: 0 } : c)),
    );
    void fetch(`${SERVER_HTTP}/api/channels/${encodeURIComponent(channelId)}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    }).catch(() => undefined);
  };

  useEffect(() => {
    fetch(`${SERVER_HTTP}/api/bootstrap?userId=${encodeURIComponent(currentUserId)}`)
      .then((r) => r.json())
      .then(
        (data: {
          channels: Channel[];
          participants: Participant[];
          sessions: BotmuxSession[];
          asks: BotmuxPendingAsk[];
          botmuxStatus: BotmuxStatus;
        }) => {
          setChannels(data.channels || []);
          setParticipants(data.participants || []);
          setSessions(data.sessions || []);
          setAsks(data.asks || []);
          setBotmuxStatus(data.botmuxStatus || null);
          if (data.channels?.length > 0) {
            setActiveChannelId((prev) => prev || data.channels[0].id);
          }
        },
      )
      .catch(console.error);
  }, [currentUserId]);

  useEffect(() => {
    if (!activeChannelId) return;
    const controller = new AbortController();
    setActiveThreadRootId(null);
    setEditingMessageId(null);
    setShowPinsPanel(false);
    setShowMembersPanel(false);
    setLoadedChannelId('');
    setMessages([]);
    setHasMore(false);
    setNextCursor(null);
    setNextCursorId(undefined);
    setLoadingMore(false);

    fetchMessagePage(activeChannelId, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setMessages((current) => {
          const loaded = new Set(page.messages.map((message) => message.id));
          return [...page.messages, ...current.filter((message) => !loaded.has(message.id))];
        });
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
        setNextCursorId(page.nextCursorId);
        setLoadedChannelId(activeChannelId);
        markChannelRead(activeChannelId, currentUserId);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadedChannelId(activeChannelId);
      });

    return () => {
      controller.abort();
      olderRequest.current?.abort();
    };
  }, [activeChannelId]);

  useEffect(() => {
    if (!activeChannelId) return;
    const controller = new AbortController();
    setPins([]);
    setPinsLoading(true);
    setPinsError(null);
    fetch(`${SERVER_HTTP}/api/channels/${encodeURIComponent(activeChannelId)}/pins`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load pinned messages');
        const data = (await response.json()) as { pins: Message[] };
        if (!controller.signal.aborted) setPins(data.pins);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPinsError('Could not load pinned messages');
      })
      .finally(() => {
        if (!controller.signal.aborted) setPinsLoading(false);
      });
    return () => controller.abort();
  }, [activeChannelId, pinsRevision]);

  useEffect(() => {
    if (!activeChannelId) return;
    const controller = new AbortController();
    setChannelMembersList([]);
    setChannelOwnerId(undefined);
    setMembersLoading(true);
    setMembersError(null);
    fetch(`${SERVER_HTTP}/api/channels/${encodeURIComponent(activeChannelId)}/members`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load channel members');
        const data = (await response.json()) as { members: ChannelMember[]; ownerId?: string };
        if (controller.signal.aborted) return;
        setChannelMembersList(data.members);
        setChannelOwnerId(data.ownerId ?? undefined);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMembersError('Could not load channel members');
      })
      .finally(() => {
        if (!controller.signal.aborted) setMembersLoading(false);
      });
    return () => controller.abort();
  }, [activeChannelId, membersRevision]);

  useEffect(() => {
    if (!jumpTarget || loadedChannelId !== activeChannelId ||
        jumpTarget.message.channelId !== activeChannelId) return;
    const controller = new AbortController();
    const { message, sequence } = jumpTarget;
    const rootId = message.threadId || message.id;

    async function navigate() {
      let page = history.current;
      let found = page.messages.some((row) => row.id === rootId);
      let older: Message[] = [];
      while (!found && page.hasMore && page.nextCursor !== null) {
        const cursor = page;
        page = await fetchMessagePage(activeChannelId, controller.signal, cursor, 100);
        older = [...page.messages, ...older];
        found = page.messages.some((row) => row.id === rootId);
        if (page.nextCursor === cursor.nextCursor && page.nextCursorId === cursor.nextCursorId) break;
      }
      if (controller.signal.aborted) return;
      if (!found) throw new Error('This message is no longer available');

      if (older.length) {
        setMessages((current) => {
          const known = new Set(current.map((row) => row.id));
          return [...older.filter((row) => !known.has(row.id)), ...current];
        });
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
        setNextCursorId(page.nextCursorId);
      }
      setMessageFocus({
        channelId: activeChannelId,
        timeline: { id: rootId, sequence },
        reply: message.threadId ? { id: message.id, sequence } : undefined,
      });
      setActiveThreadRootId(message.threadId || null);
    }

    void navigate()
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setNavigationError(error instanceof Error ? error.message : 'Could not open the message');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setJumpTarget(null);
      });
    return () => controller.abort();
  }, [activeChannelId, jumpTarget, loadedChannelId]);

  useEffect(() => {
    if (!activeChannelId || !activeThreadRootId) {
      setThreadRoot(null);
      setThreadReplies([]);
      return;
    }
    let cancelled = false;
    fetch(
      `${SERVER_HTTP}/api/channels/${encodeURIComponent(activeChannelId)}/threads/${encodeURIComponent(activeThreadRootId)}`,
    )
      .then((r) => r.json())
      .then((data: { root?: Message; replies?: Message[] }) => {
        if (cancelled) return;
        setThreadRoot(data.root || null);
        setThreadReplies(data.replies || []);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [activeChannelId, activeThreadRootId]);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const previewRequests = new Map<string, AbortController>();

    const refreshThreadPreview = async (rootId: string) => {
      previewRequests.get(rootId)?.abort();
      const controller = new AbortController();
      previewRequests.set(rootId, controller);
      try {
        const response = await fetch(
          `${SERVER_HTTP}/api/channels/${encodeURIComponent(activeChannelId)}/threads/${encodeURIComponent(rootId)}/preview`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const preview = (await response.json()) as Pick<Message, 'replyCount' | 'replyPreviews'>;
        if (controller.signal.aborted) return;
        setMessages((current) =>
          current.map((root) => root.id === rootId ? { ...root, ...preview } : root),
        );
      } catch (error) {
        if (!controller.signal.aborted) console.error('[Web] Could not refresh thread preview:', error);
      } finally {
        if (previewRequests.get(rootId) === controller) previewRequests.delete(rootId);
      }
    };

    const connect = () => {
      const ws = new WebSocket(SERVER_WS);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({ type: 'presence.identify', payload: { userId: currentUserId } }),
        );
      };

      ws.onmessage = (evt) => {
        try {
          const event = JSON.parse(evt.data) as { type: string; payload: unknown };
          if (event.type === 'message.created') {
            const msg = event.payload as Message;
            if (msg.threadId) {
              if (msg.channelId !== activeChannelId) return;
              setMessages((prev) => prev.map((root) => {
                const previews = root.replyPreviews ?? [];
                if (root.id !== msg.threadId || previews.some((reply) => reply.id === msg.id)) {
                  return root;
                }
                return {
                  ...root,
                  replyCount: (root.replyCount ?? 0) + 1,
                  replyPreviews: [...previews, msg]
                    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
                    .slice(-THREAD_REPLY_PREVIEW_LIMIT),
                };
              }));
              if (previewRequests.has(msg.threadId)) void refreshThreadPreview(msg.threadId);
              if (msg.threadId === activeThreadRootRef.current) {
                setThreadReplies((prev) =>
                  prev.some((r) => r.id === msg.id) ? prev : [...prev, msg],
                );
              }
            } else {
              setMessages((prev) => {
                if (msg.channelId !== activeChannelId) return prev;
                if (prev.some((m) => m.id === msg.id)) return prev;
                return [...prev, msg];
              });
              setChannels((prev) =>
                prev.map((c) =>
                  c.id === msg.channelId && msg.channelId !== activeChannelId
                    ? { ...c, unreadCount: (c.unreadCount || 0) + 1 }
                    : c,
                ),
              );
            }
          } else if (event.type === 'message.updated') {
            const msg = event.payload as Message;
            const updateMessage = (row: Message) => row.id === msg.id
              ? { ...row, ...msg, pinned: row.pinned, replyCount: row.replyCount }
              : row;
            setMessages((prev) =>
              prev.map((root) =>
                root.id === msg.threadId && root.replyPreviews
                  ? { ...root, replyPreviews: root.replyPreviews.map(updateMessage) }
                  : updateMessage(root),
              ),
            );
            if (msg.threadId && previewRequests.has(msg.threadId)) {
              void refreshThreadPreview(msg.threadId);
            }
            setThreadReplies((prev) => prev.map(updateMessage));
            setThreadRoot((prev) => prev && updateMessage(prev));
            setPins((prev) => prev.map(updateMessage));
          } else if (event.type === 'message.deleted') {
            const { id, channelId, threadId } = event.payload as {
              id: string;
              channelId: string;
              threadId?: string;
            };
            if (channelId !== activeChannelId) return;
            if (threadId) {
              setMessages((prev) => prev.map((root) =>
                root.id === threadId
                  ? {
                    ...root,
                    replyCount: Math.max(0, (root.replyCount ?? 0) - 1),
                    replyPreviews: root.replyPreviews?.filter((reply) => reply.id !== id),
                  }
                  : root,
              ));
              if (history.current.messages.some((root) => root.id === threadId)) {
                void refreshThreadPreview(threadId);
              }
            } else {
              previewRequests.get(id)?.abort();
              setMessages((prev) => prev.filter((m) => m.id !== id));
            }
            setThreadReplies((prev) => prev.filter((r) => r.id !== id));
            setPins((prev) => prev.filter((pin) => pin.id !== id));
            if (activeThreadRootRef.current === id) setActiveThreadRootId(null);
          } else if (event.type === 'reaction.updated') {
            const { messageId, reactions } = event.payload as {
              messageId: string;
              reactions: ReactionGroup[];
            };
            setMessages((prev) =>
              prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
            );
            setThreadReplies((prev) =>
              prev.map((r) => (r.id === messageId ? { ...r, reactions } : r)),
            );
            setThreadRoot((prev) =>
              prev && prev.id === messageId ? { ...prev, reactions } : prev,
            );
          } else if (event.type === 'pins.updated') {
            const { channelId, pins: nextPins } = event.payload as {
              channelId: string;
              pins: Message[];
            };
            if (channelId === activeChannelId) applyPins(nextPins);
          } else if (event.type === 'channel.created') {
            const ch = event.payload as Channel;
            setChannels((prev) => (prev.some((c) => c.id === ch.id) ? prev : [...prev, ch]));
          } else if (event.type === 'presence.updated') {
            const { participants: next } = event.payload as {
              participants: Participant[];
            };
            setParticipants(next);
          } else if (event.type === 'sessions.updated') {
            const { sessions: next } = event.payload as { sessions: BotmuxSession[] };
            setSessions(next);
          } else if (event.type === 'asks.updated') {
            const { asks: next } = event.payload as { asks: BotmuxPendingAsk[] };
            setAsks(next);
          }
        } catch (err) {
          console.error('[Web] WS parse error:', err);
        }
      };

      ws.onclose = () => {
        if (!closed) timer = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const request of previewRequests.values()) request.abort();
      wsRef.current?.close();
    };
  }, [activeChannelId, applyPins]);

  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: 'presence.identify', payload: { userId: currentUserId } }),
      );
    }
  }, [currentUserId]);

  useEffect(() => {
    if (!terminalSessionId) {
      setTerminalUrl(null);
      setShowSessionHistory(false);
      setSessionHistoryData(null);
      return;
    }
    fetch(`${SERVER_HTTP}/api/sessions/${encodeURIComponent(terminalSessionId)}/write-link`)
      .then((r) => r.json())
      .then((d: { url?: string | null }) => setTerminalUrl(d.url || null))
      .catch(() => setTerminalUrl(null));
  }, [terminalSessionId]);

  const humans = participants.filter((p) => p.role === 'human');
  const agents = participants.filter((p) => p.role === 'agent');
  const activeAgents = agents.filter((a) => !a.archived);
  const archivedAgents = agents.filter((a) => a.archived);
  const regularChannels = channels.filter((c) => c.kind !== 'dm');
  const dmChannels = channels.filter((c) => c.kind === 'dm');
  const activeChannel = channels.find((c) => c.id === activeChannelId);

  const openChannel = (channelId: string) => {
    setJumpTarget(null);
    setMessageFocus(null);
    setNavigationError(null);
    setActiveChannelId(channelId);
  };

  const openMessage = (message: Message) => {
    olderRequest.current?.abort();
    setNavigationError(null);
    setShowPinsPanel(false);
    setJumpTarget({ message, sequence: ++jumpSequence.current });
    setActiveChannelId(message.channelId);
  };

  const closePins = () => {
    setShowPinsPanel(false);
    pinsButton.current?.focus({ preventScroll: true });
  };

  const openAgentProfile = (agentId: string) => {
    setTerminalSessionId(null);
    setShowPinsPanel(false);
    setSelectedAgentProfileId(agentId);
  };

  const openTerminalSession = (sessionId: string) => {
    setSelectedAgentProfileId(null);
    setShowPinsPanel(false);
    setTerminalSessionId(sessionId);
  };

  const handleUploadFile = async (file: File): Promise<UploadedAttachment | null> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${SERVER_HTTP}/api/uploads`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { attachment?: UploadedAttachment };
    return data.attachment || null;
  };

  const handleLoadOlder = async () => {
    if (!activeChannelId || nextCursor === null || loadingMore || jumpTarget) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setLoadingMore(true);
    try {
      const data = await fetchMessagePage(activeChannelId, controller.signal, { nextCursor, nextCursorId });
      if (controller.signal.aborted) return;
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const older = data.messages.filter((m) => !existingIds.has(m.id));
        return [...older, ...prev];
      });
      setHasMore(data.hasMore);
      setNextCursor(data.nextCursor);
      setNextCursorId(data.nextCursorId);
    } catch {
      if (!controller.signal.aborted) setNavigationError('Could not load older messages');
    } finally {
      if (olderRequest.current === controller) {
        olderRequest.current = null;
        setLoadingMore(false);
      }
    }
  };

  const handleSendMessage = (content: string, attachments: UploadedAttachment[]) => {
    if (!activeChannelId || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          channelId: activeChannelId,
          senderId: currentUserId,
          content,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
      }),
    );
  };

  const handleSendThreadReply = (
    content: string,
    attachments: UploadedAttachment[],
    replyToId?: string,
  ) => {
    if (
      !activeChannelId ||
      !activeThreadRootId ||
      wsRef.current?.readyState !== WebSocket.OPEN
    )
      return;
    wsRef.current.send(
      JSON.stringify({
        type: 'message.send',
        payload: {
          channelId: activeChannelId,
          senderId: currentUserId,
          content,
          threadId: activeThreadRootId,
          replyToId: replyToId || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
      }),
    );
  };

  const handleTogglePin = async (msg: Message) => {
    const endpoint = `${SERVER_HTTP}/api/channels/${encodeURIComponent(msg.channelId)}/pins`;
    const response = msg.pinned
      ? await fetch(`${endpoint}/${encodeURIComponent(msg.id)}`, { method: 'DELETE' })
      : await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: msg.id, userId: currentUserId }),
      });
    if (!response.ok) throw new Error(msg.pinned ? 'Could not unpin message' : 'Could not pin message');
    const data = (await response.json()) as { pins: Message[] };
    if (channelRef.current === msg.channelId) applyPins(data.pins);
  };

  const handleSaveEdit = async (messageId: string) => {
    const content = editingDraft.trim();
    if (!content) return;
    await fetch(`${SERVER_HTTP}/api/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    setEditingMessageId(null);
    setEditingDraft('');
  };

  const handleDeleteMessage = async (messageId: string) => {
    await fetch(`${SERVER_HTTP}/api/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
  };

  const handleToggleReaction = async (messageId: string, emoji: string) => {
    await fetch(`${SERVER_HTTP}/api/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId, emoji }),
    });
  };

  const handleOpenDm = async (target: Participant) => {
    const res = await fetch(`${SERVER_HTTP}/api/dms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUserId,
        targetId: target.id,
        targetRole: target.role,
        targetName: target.name,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { channel: Channel };
      setChannels((prev) =>
        prev.some((c) => c.id === data.channel.id) ? prev : [...prev, data.channel],
      );
      openChannel(data.channel.id);
    }
  };

  const changeChannelMember = async (
    method: 'POST' | 'DELETE',
    member: { userId?: string; agentId?: string; autoReply?: boolean },
  ) => {
    const channelId = activeChannelId;
    if (!channelId) return;
    const response = await fetch(`${SERVER_HTTP}/api/channels/${encodeURIComponent(channelId)}/members`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(member),
    });
    if (!response.ok) throw new Error('Could not update channel members');
    if (channelRef.current === channelId) setMembersRevision((revision) => revision + 1);
  };

  const handleSessionAction = async (op: 'restart' | 'resume' | 'close') => {
    if (!terminalSessionId) return;
    setSessionActionBusy(op);
    try {
      await fetch(
        `${SERVER_HTTP}/api/sessions/${encodeURIComponent(terminalSessionId)}/${op}`,
        { method: 'POST' },
      );
      if (op === 'close') {
        setTerminalSessionId(null);
      }
    } finally {
      setSessionActionBusy(null);
    }
  };

  const handleLoadSessionHistory = async () => {
    if (!terminalSessionId) return;
    const next = !showSessionHistory;
    setShowSessionHistory(next);
    if (next) {
      const res = await fetch(
        `${SERVER_HTTP}/api/sessions/${encodeURIComponent(terminalSessionId)}/history`,
      );
      const data = await res.json();
      setSessionHistoryData(JSON.stringify(data, null, 2));
    }
  };

  const handleAnswerAsk = async (ask: BotmuxPendingAsk, optionKey: string) => {
    const currentHuman = humans.find((h) => h.id === currentUserId);
    await fetch(`${SERVER_HTTP}/api/asks/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        askId: ask.askId,
        larkAppId: ask.larkAppId,
        selections: [[optionKey]],
        by: currentHuman?.name || currentUserId,
      }),
    });
  };

  const handleCreateChannel = async () => {
    const name = newChannelName.trim();
    if (!name) return;
    const res = await fetch(`${SERVER_HTTP}/api/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, userId: currentUserId }),
    });
    if (res.ok) {
      const data = (await res.json()) as { channel: Channel };
      openChannel(data.channel.id);
      setNewChannelName('');
      setCreatingChannel(false);
    }
  };

  const handleAddHuman = async () => {
    const name = newHumanName.trim();
    if (!name) return;
    const res = await fetch(`${SERVER_HTTP}/api/humans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const data = (await res.json()) as { human: Participant };
      setCurrentUserId(data.human.id);
      setNewHumanName('');
      setAddingHuman(false);
    }
  };

  const detailPane = showPinsPanel && activeChannel
    ? 'pins'
    : selectedAgentProfileId
      ? 'agent'
      : terminalSessionId
        ? 'terminal'
        : undefined;

  return (
    <div className={workspaceStyles.shell}>
      <header className={workspaceStyles.titleBar}>
        <BuzzPageSearch
          serverHttp={SERVER_HTTP}
          activeChannelId={activeChannelId}
          currentUserId={currentUserId}
          channels={channels}
          participants={participants}
          onOpenMessage={openMessage}
          onOpenChannel={openChannel}
          onOpenParticipant={(participant) => {
            if (participant.role === 'agent') openAgentProfile(participant.id);
            else void handleOpenDm(participant);
          }}
        />
      </header>
      <div className={workspaceStyles.workspace}>
        <Panel as="div" joined>
          <div className={workspaceStyles.columns}>
            <ResizableSidebar scope="buzz-botmux-workspace">
              <SidebarFrame
                label="Workspace navigation"
                header={
                  <div>
                    <PanelHeader
                      title="Buzz"
                      actions={
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Badge tone={botmuxStatus?.authenticated ? 'success' : 'neutral'}>
                            {botmuxStatus?.authenticated ? 'Live' : 'Offline'}
                          </Badge>
                          <IconButton
                            hint="familiar"
                            size="sm"
                            aria-label="Appearance"
                            aria-expanded={showAppearance}
                            title="Appearance (Theme, Accent & Vibe level)"
                            icon={<PaletteIcon size={16} />}
                            onClick={() => setShowAppearance((v) => !v)}
                          />
                        </div>
                      }
                    />
                    {showAppearance && <AppearanceControls />}
                  </div>
                }
              >
                <NavigationSection
                  label="Channels"
                  action={
                    <IconButton
                      hint="familiar"
                      size="sm"
                      aria-label="New channel"
                      icon={<PlusIcon size={16} />}
                      onClick={() => setCreatingChannel((v) => !v)}
                    />
                  }
                >
                  {creatingChannel && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleCreateChannel();
                      }}
                      style={{ padding: '4px 6px' }}
                    >
                      <Input
                        value={newChannelName}
                        onChange={(e) => setNewChannelName(e.target.value)}
                        placeholder="channel-name"
                        autoFocus
                      />
                    </form>
                  )}
                  {regularChannels.map((ch) => (
                    <NavigationItem
                      key={ch.id}
                      label={ch.name}
                      icon={<HashIcon size={16} />}
                      selected={ch.id === activeChannelId}
                      trailing={
                        ch.unreadCount > 0 && ch.id !== activeChannelId ? (
                          <CountBadge
                            count={ch.unreadCount}
                            label={`${ch.unreadCount} unread messages`}
                          />
                        ) : undefined
                      }
                      onClick={() => openChannel(ch.id)}
                    />
                  ))}
                </NavigationSection>

                {dmChannels.length > 0 && (
                  <NavigationSection label="Direct Messages">
                    {dmChannels.map((dm) => (
                      <NavigationItem
                        key={dm.id}
                        label={dm.topic || dm.name}
                        selected={dm.id === activeChannelId}
                        trailing={
                          dm.unreadCount > 0 && dm.id !== activeChannelId ? (
                            <CountBadge
                              count={dm.unreadCount}
                              label={`${dm.unreadCount} unread messages`}
                            />
                          ) : undefined
                        }
                        onClick={() => openChannel(dm.id)}
                      />
                    ))}
                  </NavigationSection>
                )}

                <NavigationSection label="Agents">
                  {activeAgents.map((agent) => {
                    const activeSession = sessions.find((s) => s.larkAppId === agent.id);
                    return (
                      <NavigationItem
                        key={agent.id}
                        label={agent.name}
                        selected={selectedAgentProfileId === agent.id}
                        icon={
                          <Avatar
                            src={agent.avatarUrl}
                            alt={agent.name}
                            fallback={agent.name}
                            size="tiny"
                            shape="squircle"
                            statusBadge={agent.status === 'online' ? 'online' : 'offline'}
                          />
                        }
                        trailing={
                          activeSession ? (
                            <TerminalWindowIcon size={14} />
                          ) : (
                            <Badge>{agent.cliId || 'cli'}</Badge>
                          )
                        }
                        onClick={() => openAgentProfile(agent.id)}
                      />
                    );
                  })}
                  {archivedAgents.length > 0 && (
                    <div style={{ padding: '4px 6px' }}>
                      <Button
                        variant="quiet"
                        size="xs"
                        onClick={() => setShowArchivedAgents((v) => !v)}
                      >
                        {showArchivedAgents
                          ? `隐藏已归档 (${archivedAgents.length})`
                          : `已归档 (${archivedAgents.length})`}
                      </Button>
                      {showArchivedAgents &&
                        archivedAgents.map((agent) => (
                          <NavigationItem
                            key={agent.id}
                            label={agent.name}
                            selected={selectedAgentProfileId === agent.id}
                            icon={
                              <Avatar
                                src={agent.avatarUrl}
                                alt={agent.name}
                                fallback={agent.name}
                                size="tiny"
                                shape="squircle"
                                statusBadge={agent.status === 'online' ? 'online' : 'offline'}
                              />
                            }
                            trailing={<Badge tone="neutral">Archived</Badge>}
                            onClick={() => openAgentProfile(agent.id)}
                          />
                        ))}
                    </div>
                  )}
                </NavigationSection>

                <NavigationSection
                  label="Members (切换身份)"
                  action={
                    <IconButton
                      hint="familiar"
                      size="sm"
                      aria-label="Add member"
                      icon={<PlusIcon size={16} />}
                      onClick={() => setAddingHuman((v) => !v)}
                    />
                  }
                >
                  {addingHuman && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleAddHuman();
                      }}
                      style={{ padding: '4px 6px' }}
                    >
                      <Input
                        value={newHumanName}
                        onChange={(e) => setNewHumanName(e.target.value)}
                        placeholder="成员昵称"
                        autoFocus
                      />
                    </form>
                  )}
                  {humans.map((h) => (
                    <NavigationItem
                      key={h.id}
                      label={h.name}
                      selected={h.id === currentUserId}
                      icon={
                        <Avatar
                          src={h.avatarUrl}
                          alt={h.name}
                          fallback={h.name}
                          size="tiny"
                          statusBadge={h.status === 'online' ? 'online' : 'offline'}
                        />
                      }
                      onClick={() => setCurrentUserId(h.id)}
                    />
                  ))}
                </NavigationSection>
              </SidebarFrame>
            </ResizableSidebar>

            <div className={workspaceStyles.conversationLayout}>
              <main
                className={workspaceStyles.conversation}
                data-buzz-surface=""
                data-overlay-boundary=""
              >
                <PanelHeader
                  title={activeChannel ? (
                    <ChannelHeaderIdentity
                      ref={membersButton}
                      name={activeChannel.kind === 'dm' ? activeChannel.topic || activeChannel.name : activeChannel.name}
                      members={channelMembersList}
                      participants={participants}
                      open={showMembersPanel}
                      canManage={activeChannel.kind !== 'dm'}
                      onOpen={() => setShowMembersPanel(true)}
                    />
                  ) : 'Select a channel'}
                  actions={activeChannel && (
                    <ChannelPinsButton
                      ref={pinsButton}
                      open={showPinsPanel}
                      onToggle={() => {
                        if (showPinsPanel) closePins();
                        else {
                          setSelectedAgentProfileId(null);
                          setTerminalSessionId(null);
                          setShowPinsPanel(true);
                        }
                      }}
                    />
                  )}
                />
                {navigationError && (
                  <div className={workspaceStyles.navigationError} role="alert">
                    <span>{navigationError}</span>
                    <IconButton
                      size="toolbar"
                      aria-label="Dismiss error"
                      title="Dismiss error"
                      icon={<XIcon size={16} aria-hidden="true" />}
                      onClick={() => setNavigationError(null)}
                    />
                  </div>
                )}

                {/* Real Botmux Pending Asks */}
                {asks.length > 0 && (
                  <div
                    style={{
                      padding: '10px 24px',
                      borderBottom: '1px solid var(--border-subtle)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    {asks.map((ask) => {
                      const firstQ = ask.questions?.[0];
                      return (
                        <div
                          key={ask.askId}
                          style={{
                            padding: '10px 12px',
                            borderRadius: 'var(--radius-md, 8px)',
                            border: '1px solid var(--border-subtle)',
                            background: 'var(--bg-subtle, rgba(255,255,255,0.04))',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div className="text-label text-primary">
                              {ask.botName || ask.larkAppId} · 等待确认
                            </div>
                            <div className="text-caption text-secondary">
                              {firstQ?.question || ask.prompt || ask.title || ask.askId}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                            {(
                              firstQ?.options || [
                                { key: 'approve', label: '批准' },
                                { key: 'reject', label: '拒绝' },
                              ]
                            ).map((opt) => (
                              <Button
                                key={opt.key}
                                variant="outline"
                                size="sm"
                                onClick={() => void handleAnswerAsk(ask, opt.key)}
                              >
                                {opt.label}
                              </Button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Buzz Channel Timeline + Composer + Inline Thread Sheet */}
                <ComposerScopeProvider>
                  <ConversationSurface
                    activeChannel={activeChannel}
                    messages={messages}
                    participants={participants}
                    currentUserId={currentUserId}
                    hasMore={hasMore}
                    loadingMore={loadingMore}
                    onLoadOlder={() => void handleLoadOlder()}
                    activeThreadRootId={activeThreadRootId}
                    threadRoot={threadRoot}
                    threadReplies={threadReplies}
                    timelineFocus={messageFocus?.channelId === activeChannelId ? messageFocus.timeline : undefined}
                    replyFocus={messageFocus?.channelId === activeChannelId ? messageFocus.reply : undefined}
                    editingMessageId={editingMessageId}
                    editingDraft={editingDraft}
                    onEditingDraftChange={setEditingDraft}
                    onStartEdit={(msg) => {
                      setEditingMessageId(msg.id);
                      setEditingDraft(msg.content);
                    }}
                    onSaveEdit={(id) => void handleSaveEdit(id)}
                    onCancelEdit={() => setEditingMessageId(null)}
                    onDelete={(id) => void handleDeleteMessage(id)}
                    onTogglePin={(msg) => void handleTogglePin(msg).catch((error: Error) => {
                      if (channelRef.current === msg.channelId) setNavigationError(error.message);
                    })}
                    onToggleReaction={(id, emoji) => void handleToggleReaction(id, emoji)}
                    onOpenThread={(id) => setActiveThreadRootId(id)}
                    onOpenReply={openMessage}
                    onCloseThread={() => setActiveThreadRootId(null)}
                    onOpenTerminal={openTerminalSession}
                    onOpenMedia={(attachments, selectedId) =>
                      setMediaViewer({ attachments, selectedId })
                    }
                    onOpenAgentProfile={openAgentProfile}
                    onUploadFile={handleUploadFile}
                    onSendMessage={handleSendMessage}
                    onSendThreadReply={handleSendThreadReply}
                  />
                </ComposerScopeProvider>
              </main>

              {detailPane && (
                <div className={workspaceStyles.details} data-pane={detailPane}>
                  {showPinsPanel && activeChannel && (
                    <ChannelPinsPanel
                      key={activeChannelId}
                      pins={pins}
                      participants={participants}
                      channelKind={activeChannel.kind}
                      loading={pinsLoading}
                      error={pinsError}
                      onRetry={() => setPinsRevision((revision) => revision + 1)}
                      onClose={closePins}
                      onOpenMessage={openMessage}
                      onUnpin={(message) => handleTogglePin({ ...message, pinned: true })}
                    />
                  )}

                  {/* Buzz-style Agent Profile Detail Panel */}
                  {selectedAgentProfileId && (
                    <AgentProfilePanel
                      key={selectedAgentProfileId}
                      agentId={selectedAgentProfileId}
                      currentUserId={currentUserId}
                      serverHttp={SERVER_HTTP}
                      allChannels={channels}
                      onClose={() => setSelectedAgentProfileId(null)}
                      onOpenDm={(agentId) => {
                        const target = agents.find((a) => a.id === agentId);
                        if (target) void handleOpenDm(target);
                      }}
                      onOpenChannel={openChannel}
                      onOpenTerminal={openTerminalSession}
                    />
                  )}

                  {/* Botmux Web Terminal & Session Controls */}
                  {terminalSessionId && (
                    <aside className={workspaceStyles.terminal} aria-label="Terminal">
                      <PanelHeader
                        icon={<TerminalWindowIcon size={16} />}
                        title={terminalSessionId}
                        actions={
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Button
                              variant="outline"
                              size="xs"
                              loading={sessionActionBusy === 'resume'}
                              onClick={() => void handleSessionAction('resume')}
                            >
                              Resume
                            </Button>
                            <Button
                              variant="outline"
                              size="xs"
                              loading={sessionActionBusy === 'restart'}
                              onClick={() => void handleSessionAction('restart')}
                            >
                              Restart
                            </Button>
                            <Button
                              variant="destructive"
                              size="xs"
                              loading={sessionActionBusy === 'close'}
                              onClick={() => void handleSessionAction('close')}
                            >
                              Close
                            </Button>
                            <IconButton
                              hint="familiar"
                              size="xs"
                              aria-label="Session history"
                              title="查看 Botmux 会话历史"
                              icon={<ClockIcon size={14} />}
                              onClick={() => void handleLoadSessionHistory()}
                            />
                            <IconButton
                              hint="familiar"
                              size="sm"
                              aria-label="Close terminal"
                              icon={<XIcon size={16} />}
                              onClick={() => setTerminalSessionId(null)}
                            />
                          </div>
                        }
                      />
                      {showSessionHistory ? (
                        <pre
                          style={{
                            flex: 1,
                            margin: 0,
                            padding: 16,
                            overflow: 'auto',
                            fontSize: 12,
                            fontFamily: 'var(--buzz-mono-family)',
                            background: 'var(--bg-subtle, #0b0d12)',
                          }}
                        >
                          {sessionHistoryData || 'Loading session history...'}
                        </pre>
                      ) : (
                        <div style={{ flex: 1, background: '#000' }}>
                          {terminalUrl ? (
                            <iframe
                              src={terminalUrl}
                              title={terminalSessionId}
                              style={{ width: '100%', height: '100%', border: 0 }}
                            />
                          ) : (
                            <div style={{ padding: 16 }} className="text-caption text-secondary">
                              正在加载 Botmux Web Terminal...
                            </div>
                          )}
                        </div>
                      )}
                    </aside>
                  )}
                </div>
              )}
            </div>
          </div>
        </Panel>
      </div>

      {activeChannel && (
        <ChannelMembersDialog
          key={activeChannelId}
          open={showMembersPanel}
          channelName={activeChannel.kind === 'dm' ? activeChannel.topic || activeChannel.name : activeChannel.name}
          currentUserId={currentUserId}
          ownerId={channelOwnerId}
          canManage={activeChannel.kind !== 'dm'}
          triggerRef={membersButton}
          members={channelMembersList}
          participants={participants}
          loading={membersLoading}
          error={membersError}
          onRetry={() => setMembersRevision((revision) => revision + 1)}
          onOpenChange={setShowMembersPanel}
          onAdd={(participant) => changeChannelMember('POST', participant.role === 'agent'
            ? { agentId: participant.id } : { userId: participant.id })}
          onRemove={(member) => changeChannelMember('DELETE', member.agentId
            ? { agentId: member.agentId } : { userId: member.userId || undefined })}
          onToggleAutoReply={(agentId, autoReply) => changeChannelMember('POST', { agentId, autoReply })}
          onOpenAgentProfile={openAgentProfile}
        />
      )}

      {/* Buzz In-App Media Viewer */}
      {mediaViewer && (
        <BuzzMediaViewer
          selection={mediaViewer}
          serverHttp={SERVER_HTTP}
          onSelectId={(selectedId) =>
            setMediaViewer((prev) => (prev ? { ...prev, selectedId } : null))
          }
          onClose={() => setMediaViewer(null)}
        />
      )}
    </div>
  );
}
