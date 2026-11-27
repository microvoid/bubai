import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityPanel, type ActivityItem } from './features/activity/ActivityPanel';
import { AgentProfilePanel } from './features/agent-profile/AgentProfilePanel';
import { TerminalPane } from './features/terminal/TerminalPane';
import { AppearanceControls } from './features/appearance/AppearanceControls';
import { ResizableSidebar } from './features/channel-navigation/ResizableSidebar';
import { SidebarFrame } from './features/channel-navigation/SidebarFrame';
import {
  ChannelHeaderIdentity,
  ChannelMembersDialog,
  type ChannelMember,
} from './features/channel-navigation/ChannelMembers';
import { ChannelPinsButton, ChannelPinsPanel } from './features/channel-navigation/ChannelPins';
import {
  SidebarChannelRow,
  type SidebarGroup,
} from './features/channel-navigation/SidebarChannelRow';
import sidebarRowStyles from './features/channel-navigation/SidebarChannelRow.module.css';
import { writeClipboardText } from './shared/clipboard';
import { activeModal } from './design-system/overlayLayer';
import { AlertDialog } from './design-system/ui/AlertDialog';
import {
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from './design-system/ui/Menu';
import { Select } from './design-system/ui/Select';
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
  type ProseMirrorComposerHandle,
  type UploadedAttachment,
} from './features/messages/ProseMirrorComposer';
import {
  buildMentionCandidates,
  type ChannelMembersState,
} from './features/conversation/MentionCompletions';
import type { ChatMessage as Message, MessageFocus, Participant } from './features/messages/types';
import { BuzzPageSearch } from './features/search/BuzzPageSearch';
import { NotificationSettingsDialog } from './features/settings/NotificationSettingsDialog';
import bubaiLogoUrl from './assets/bubai-logo.svg?no-inline';
import workspaceStyles from './Workspace.module.css';
import messageStyles from './features/messages/Messages.module.css';
import { appearance, useAppearance } from './shared/theme/service';
import { apiFetch, notifyUnauthorized } from './features/auth/auth-client';
import { useBubaiAuth } from './features/auth/AuthGate';
import { ProfileButton } from './features/auth/ProfileButton';
import {
  CommunityMembersDialog,
  CreateCommunityDialog,
  ProfileSettingsDialog,
} from './features/auth/AuthDialogs';
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
  ArchiveIcon,
  ArchiveOffIcon,
  BellIcon,
  BellSlashIcon,
  ChatCircleIcon,
  ClockIcon,
  DotsThreeIcon,
  GearIcon,
  HashIcon,
  LinkIcon,
  NotificationFilledIcon,
  NotificationIcon,
  PaletteIcon,
  PencilSimpleIcon,
  PlusIcon,
  SignOutIcon,
  SparklesIcon,
  TerminalWindowIcon,
  TrashIcon,
  XIcon,
} from './design-system/icons/index';

interface Channel {
  id: string;
  name: string;
  topic: string;
  kind?: 'channel' | 'dm';
  replyMode?: string;
  archived?: boolean;
  createdByUserId?: string;
  dmKey?: string;
  memberIds?: string[];
  unreadCount: number;
  threadUnreadCount?: number;
  mentionCount?: number;
  lastReadAt?: number;
  muted?: boolean;
  markedUnread?: boolean;
  starred?: boolean;
  groupId?: string;
  createdAt: number;
}

interface BotmuxSession {
  sessionId: string;
  larkAppId?: string;
  botName?: string;
  cliId?: string;
  state?: string;
  status?: string;
  title?: string;
  workingDir?: string;
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

const SERVER_HTTP =
  import.meta.env.VITE_SERVER_URL !== undefined
    ? import.meta.env.VITE_SERVER_URL || window.location.origin
    : import.meta.env.PROD
      ? window.location.origin
      : 'http://localhost:4000';
const SERVER_WS = SERVER_HTTP.replace(/^http/, 'ws') + '/ws';
const MESSAGE_SEND_TIMEOUT_MS = 10_000;
const THREAD_REPLY_PREVIEW_LIMIT = 5;
const DESKTOP_NOTIFICATIONS_KEY = 'bubai.desktopNotifications';

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
  userId?: string,
): Promise<HistoryPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (userId) query.set('userId', userId);
  if (cursor?.nextCursor != null) {
    query.set('before', String(cursor.nextCursor));
    if (cursor.nextCursorId) query.set('beforeId', cursor.nextCursorId);
  }
  const response = await apiFetch(
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
  channelMembers,
  channelMembersState,
  currentUserId,
  hasMore,
  loadingMore,
  onLoadOlder,
  activeThreadRootId,
  threadRoot,
  threadReplies,
  timelineFocus,
  replyFocus,
  unreadSince,
  typingLabels,
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
  onTyping,
  onUnarchiveChannel,
}: {
  activeChannel: Channel | undefined;
  messages: readonly Message[];
  participants: readonly Participant[];
  channelMembers: readonly ChannelMember[];
  channelMembersState: ChannelMembersState;
  currentUserId: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadOlder: () => void;
  activeThreadRootId: string | null;
  threadRoot: Message | null;
  threadReplies: readonly Message[];
  timelineFocus?: MessageFocus;
  replyFocus?: MessageFocus;
  unreadSince?: number | null;
  typingLabels?: readonly string[];
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
  onSendMessage: (content: string, attachments: UploadedAttachment[], messageId: string) => Promise<void>;
  onSendThreadReply: (
    content: string,
    attachments: UploadedAttachment[],
    messageId: string,
    replyToId?: string,
  ) => Promise<void>;
  onTyping?: () => void;
  onUnarchiveChannel?: (channel: Channel) => void;
}) {
  const dockRef = useComposerDockRef();
  const composerRef = useRef<ProseMirrorComposerHandle | null>(null);

  const channelMemberIds = useMemo(() => {
    const ids = new Set<string>();
    if (channelMembersState === 'ready') {
      for (const m of channelMembers) {
        if (m.userId) ids.add(m.userId);
        if (m.agentId) ids.add(m.agentId);
      }
      return ids;
    }
    if (activeChannel?.memberIds) {
      for (const id of activeChannel.memberIds) {
        if (id) ids.add(id);
      }
    }
    return ids;
  }, [channelMembers, channelMembersState, activeChannel?.memberIds]);

  const effectiveMembersState: ChannelMembersState =
    channelMembersState === 'ready' || activeChannel?.memberIds !== undefined
      ? 'ready'
      : channelMembersState;

  const channelMentionCandidates = useMemo(
    () =>
      buildMentionCandidates({
        participants,
        currentUserId,
        channelKind: activeChannel?.kind,
        dmKey: activeChannel?.dmKey,
        channelMemberIds: effectiveMembersState === 'ready' ? channelMemberIds : undefined,
        channelMembersState: effectiveMembersState,
        channelMessages: messages,
      }),
    [
      participants,
      currentUserId,
      activeChannel?.kind,
      activeChannel?.dmKey,
      channelMemberIds,
      effectiveMembersState,
      messages,
    ],
  );

  const threadMentionCandidates = useMemo(() => {
    const threadMsgs = threadRoot ? [threadRoot, ...threadReplies] : threadReplies;
    return buildMentionCandidates({
      participants,
      currentUserId,
      channelKind: activeChannel?.kind,
      dmKey: activeChannel?.dmKey,
      channelMemberIds: effectiveMembersState === 'ready' ? channelMemberIds : undefined,
      channelMembersState: effectiveMembersState,
      channelMessages: messages,
      threadMessages: threadMsgs,
    });
  }, [
    participants,
    currentUserId,
    activeChannel?.kind,
    activeChannel?.dmKey,
    channelMemberIds,
    effectiveMembersState,
    messages,
    threadRoot,
    threadReplies,
  ]);
  const isArchived = Boolean(activeChannel?.archived);
  const canUnarchive = Boolean(
    activeChannel &&
      isArchived &&
      (!activeChannel.createdByUserId || activeChannel.createdByUserId === currentUserId),
  );

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
        unreadSince={unreadSince}
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
        onMentionParticipant={(p) => composerRef.current?.insertMention(p)}
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

      {isArchived && activeChannel && (
        <div
          data-archived-banner="true"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            margin: '0 16px 8px',
            padding: '8px 12px',
            borderRadius: 'var(--radius-md, 8px)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-subtle, rgba(128,128,128,0.08))',
          }}
        >
          <span className="text-caption text-secondary">
            This channel is archived. Messages are read-only.
          </span>
          {canUnarchive && onUnarchiveChannel && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => onUnarchiveChannel(activeChannel)}
            >
              <ArchiveOffIcon size={13} aria-hidden="true" />
              Unarchive
            </Button>
          )}
        </div>
      )}

      {typingLabels && typingLabels.length > 0 && (
        <div
          data-typing-indicator="true"
          className="text-caption text-subtle"
          style={{ padding: '2px 24px 4px', minHeight: 20 }}
        >
          {typingLabels.length === 1
            ? `${typingLabels[0]} is typing…`
            : `${typingLabels.join(', ')} are typing…`}
        </div>
      )}

      <ProseMirrorComposer
        dockRef={dockRef}
        composerRef={composerRef}
        draftScope={JSON.stringify([currentUserId, activeChannel?.id])}
        candidates={channelMentionCandidates}
        disabled={!activeChannel || isArchived}
        serverHttp={SERVER_HTTP}
        onUploadFile={onUploadFile}
        onTyping={onTyping}
        onSend={onSendMessage}
        placeholder={
          isArchived
            ? 'This channel is archived (read-only)'
            : activeChannel?.kind === 'dm'
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
        mentionCandidates={threadMentionCandidates}
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
  const appearanceSnapshot = useAppearance();
  const auth = useBubaiAuth();
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  const [showCommunityMembers, setShowCommunityMembers] = useState(false);
  const [showCreateCommunity, setShowCreateCommunity] = useState(false);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [sidebarGroups, setSidebarGroups] = useState<SidebarGroup[]>([]);
  const [showArchivedChannels, setShowArchivedChannels] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [channelLifecycleDialog, setChannelLifecycleDialog] = useState<{
    action: 'archive' | 'delete' | 'leave';
    channel: Channel;
  } | null>(null);
  const [channelLifecyclePending, setChannelLifecyclePending] = useState(false);
  const [createGroupTarget, setCreateGroupTarget] = useState<Channel | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingGroupPending, setCreatingGroupPending] = useState(false);
  const [renameGroupTarget, setRenameGroupTarget] = useState<SidebarGroup | null>(null);
  const [renameGroupName, setRenameGroupName] = useState('');
  const [renamingGroupPending, setRenamingGroupPending] = useState(false);
  const [channelSettingsTarget, setChannelSettingsTarget] = useState<Channel | null>(null);
  const [settingsName, setSettingsName] = useState('');
  const [settingsTopic, setSettingsTopic] = useState('');
  const [settingsReplyMode, setSettingsReplyMode] = useState('follow_source');
  const [settingsPending, setSettingsPending] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [unreadDivider, setUnreadDivider] = useState<{ channelId: string; since: number } | null>(null);
  const [typingByChannel, setTypingByChannel] = useState<Record<string, Record<string, number>>>({});
  const [runningMessageChannelMap, setRunningMessageChannelMap] = useState<Record<string, string>>({});
  const [deleteMessageTarget, setDeleteMessageTarget] = useState<Message | null>(null);
  const [deleteMessagePending, setDeleteMessagePending] = useState(false);
  const [desktopNotifications, setDesktopNotifications] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const desktopNotificationsRef = useRef(desktopNotifications);
  desktopNotificationsRef.current = desktopNotifications;
  const [showSettings, setShowSettings] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const lastTypingSentRef = useRef(0);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const participantsRef = useRef(participants);
  participantsRef.current = participants;
  const [sessions, setSessions] = useState<BotmuxSession[]>([]);
  const [asks, setAsks] = useState<BotmuxPendingAsk[]>([]);
  const [botmuxStatus, setBotmuxStatus] = useState<BotmuxStatus | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const [activeChannelId, setActiveChannelId] = useState<string>('');
  const [currentUserId, setCurrentUserId] = useState<string>(() => auth.user?.id || 'u-owner');
  const currentUserIdRef = useRef(currentUserId);
  currentUserIdRef.current = currentUserId;

  useEffect(() => {
    if (auth.user?.id && auth.user.id !== currentUserId) {
      setCurrentUserId(auth.user.id);
    }
  }, [auth.user?.id, currentUserId]);

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
  const [membersLoadedChannelId, setMembersLoadedChannelId] = useState('');
  const membersLoadedChannelIdRef = useRef(membersLoadedChannelId);
  membersLoadedChannelIdRef.current = membersLoadedChannelId;
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

  // Activity / Unreads Panel
  const [showActivityPanel, setShowActivityPanel] = useState(false);
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // Agent Profile Panel
  const [selectedAgentProfileId, setSelectedAgentProfileId] = useState<string | null>(null);
  const [showArchivedAgents, setShowArchivedAgents] = useState(false);
  const [terminalReturnAgentId, setTerminalReturnAgentId] = useState<string | null>(null);
  const [terminalExpanded, setTerminalExpanded] = useState(false);

  const [creatingChannelTarget, setCreatingChannelTarget] = useState<string | null>(null);
  const [newChannelName, setNewChannelName] = useState('');
  const [createChannelError, setCreateChannelError] = useState<string | null>(null);
  const [creatingChannelPending, setCreatingChannelPending] = useState(false);

  // Botmux Web Terminal & History
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const [terminalLink, setTerminalLink] = useState<{ sessionId: string; url: string | null } | null>(null);
  const [sessionHistory, setSessionHistory] = useState<{ sessionId: string; content: string | null } | null>(null);
  const [sessionActionBusy, setSessionActionBusy] = useState<string | null>(null);
  const activeTerminalLink = terminalLink?.sessionId === terminalSessionId ? terminalLink : null;
  const activeSessionHistory = sessionHistory?.sessionId === terminalSessionId ? sessionHistory : null;

  const wsRef = useRef<WebSocket | null>(null);
  const wsReconnectRef = useRef<(() => void) | null>(null);
  const wsOpenWaitersRef = useRef<Set<(ws: WebSocket) => void>>(new Set());
  const pendingSends = useRef(new Map<string, (error?: Error) => void>());

  const contentMentionsCurrentUser = useCallback((content: string) => {
    if (!content) return false;
    if (/(?:^|[\s([{"'，。！？、])@(?:all|channel|here)(?=$|[\s)\]}"'，。！？、:：,.;!?])/i.test(content)) {
      return true;
    }
    const me = participantsRef.current.find((p) => p.id === currentUserIdRef.current);
    const cleanName = me?.name?.trim();
    if (!cleanName) return false;
    const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `(?:^|[\\s([{"'，。！？、])@${escaped}(?=$|[\\s)\\]}"'，。！？、:：,.;!?])`,
      'i',
    ).test(content);
  }, []);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const res = await apiFetch(
        `${SERVER_HTTP}/api/activity?userId=${encodeURIComponent(currentUserIdRef.current)}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { items?: ActivityItem[] };
      setActivityItems(data.items || []);
    } catch {
      // ignore transient network error
    } finally {
      setActivityLoading(false);
    }
  }, []);

  const totalUnreadCount = useMemo(
    () =>
      channels.reduce((sum, ch) => {
        if (ch.archived || ch.muted) return sum;
        return sum + (ch.unreadCount || 0) + (ch.threadUnreadCount || 0);
      }, 0),
    [channels],
  );

  useEffect(() => {
    if (showActivityPanel) {
      void loadActivity();
    }
  }, [showActivityPanel, totalUnreadCount, loadActivity]);

  const markChannelRead = (channelId: string, userId: string, includeThreads = false) => {
    setChannels((prev) =>
      prev.map((c) =>
        c.id === channelId
          ? {
              ...c,
              unreadCount: 0,
              ...(includeThreads ? { threadUnreadCount: 0, mentionCount: 0 } : c.threadUnreadCount ? {} : { mentionCount: 0 }),
              markedUnread: false,
              lastReadAt: Date.now(),
            }
          : c,
      ),
    );
    if (includeThreads && channelRef.current === channelId) {
      setMessages((prev) =>
        prev.map((m) => (m.unreadReplyCount ? { ...m, unreadReplyCount: 0 } : m)),
      );
    }
    void apiFetch(`${SERVER_HTTP}/api/channels/${encodeURIComponent(channelId)}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, includeThreads }),
    }).catch(() => undefined);
  };

  const markThreadRead = useCallback((channelId: string, rootMessageId: string, userId: string) => {
    let clearedCount = 0;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== rootMessageId || !m.unreadReplyCount) return m;
        clearedCount = m.unreadReplyCount;
        return { ...m, unreadReplyCount: 0 };
      }),
    );
    setChannels((prev) =>
      prev.map((c) => {
        if (c.id !== channelId || !c.threadUnreadCount) return c;
        const nextCount = Math.max(0, c.threadUnreadCount - Math.max(clearedCount, 1));
        return { ...c, threadUnreadCount: nextCount };
      }),
    );
    void apiFetch(
      `${SERVER_HTTP}/api/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(rootMessageId)}/read`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      },
    ).catch(() => undefined);
  }, []);

  useEffect(() => {
    const totalUnread = channels.reduce((sum, ch) => {
      if (ch.archived || ch.muted) return sum;
      return sum + (ch.unreadCount || 0) + (ch.threadUnreadCount || 0);
    }, 0);
    document.title = totalUnread > 0 ? `(${totalUnread}) BubAI` : 'BubAI';
  }, [channels]);

  useEffect(() => {
    apiFetch(`${SERVER_HTTP}/api/bootstrap?userId=${encodeURIComponent(currentUserId)}`)
      .then((r) => r.json())
      .then(
        (data: {
          channels: Channel[];
          participants: Participant[];
          sessions: BotmuxSession[];
          asks: BotmuxPendingAsk[];
          botmuxStatus: BotmuxStatus;
          sidebarGroups?: SidebarGroup[];
        }) => {
          const nextChannels = data.channels || [];
          setChannels(nextChannels);
          setSidebarGroups(data.sidebarGroups || []);
          setParticipants(data.participants || []);
          setSessions(data.sessions || []);
          setAsks(data.asks || []);
          setBotmuxStatus(data.botmuxStatus || null);
          if (nextChannels.length > 0) {
            const hashRaw = window.location.hash.replace(/^#/, '');
            const hashParams = new URLSearchParams(hashRaw);
            const hashChannelId = hashParams.get('channel') || '';
            const hashMessageId = hashParams.get('message') || '';
            const hashTarget = nextChannels.find((c) => c.id === hashChannelId);
            const defaultChannel =
              hashTarget || nextChannels.find((c) => !c.archived) || nextChannels[0];
            setActiveChannelId((prev) =>
              prev && nextChannels.some((c) => c.id === prev) ? prev : defaultChannel.id,
            );
            if (hashMessageId) {
              void apiFetch(
                `${SERVER_HTTP}/api/messages/${encodeURIComponent(hashMessageId)}?userId=${encodeURIComponent(currentUserId)}`,
              )
                .then((r) => (r.ok ? r.json() : null))
                .then((d: { message?: Message } | null) => {
                  if (d?.message) openMessage(d.message);
                })
                .catch(() => undefined);
            }
          }
        },
      )
      .catch(console.error);
  }, [currentUserId, auth.orgRevision]);

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

    const enteringChannel = channelsRef.current.find((c) => c.id === activeChannelId);
    if (enteringChannel && enteringChannel.unreadCount > 0 && enteringChannel.lastReadAt) {
      setUnreadDivider({ channelId: activeChannelId, since: enteringChannel.lastReadAt });
    } else {
      setUnreadDivider(null);
    }

    fetchMessagePage(activeChannelId, controller.signal, undefined, 50, currentUserId)
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
    apiFetch(`${SERVER_HTTP}/api/channels/${encodeURIComponent(activeChannelId)}/pins`, {
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
    if (!activeChannelId) {
      setChannelMembersList([]);
      setChannelOwnerId(undefined);
      setMembersLoadedChannelId('');
      setMembersLoading(false);
      setMembersError(null);
      return;
    }
    const controller = new AbortController();
    const isSameLoadedChannel = membersLoadedChannelIdRef.current === activeChannelId;
    if (!isSameLoadedChannel) {
      setChannelMembersList([]);
      setChannelOwnerId(undefined);
      setMembersLoadedChannelId('');
      setMembersLoading(true);
    }
    setMembersError(null);
    apiFetch(`${SERVER_HTTP}/api/channels/${encodeURIComponent(activeChannelId)}/members`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load channel members');
        const data = (await response.json()) as { members: ChannelMember[]; ownerId?: string };
        if (controller.signal.aborted) return;
        setChannelMembersList(data.members);
        setChannelOwnerId(data.ownerId ?? undefined);
        setMembersLoadedChannelId(activeChannelId);
        setMembersError(null);
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
        page = await fetchMessagePage(activeChannelId, controller.signal, cursor, 100, currentUserId);
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
    const belongsToThread = (message: Message) =>
      message.channelId === activeChannelId && message.threadId === activeThreadRootId;
    const cachedRoot =
      history.current.messages.find(
        (m) => m.channelId === activeChannelId && m.id === activeThreadRootId,
      ) ?? null;
    setThreadRoot((current) =>
      current?.channelId === activeChannelId && current.id === activeThreadRootId
        ? current
        : cachedRoot,
    );
    setThreadReplies((current) => current.filter(belongsToThread));
    markThreadRead(activeChannelId, activeThreadRootId, currentUserId);
    let cancelled = false;
    apiFetch(
      `${SERVER_HTTP}/api/channels/${encodeURIComponent(activeChannelId)}/threads/${encodeURIComponent(activeThreadRootId)}`,
    )
      .then((r) => r.json())
      .then((data: { root?: Message; replies?: Message[] }) => {
        if (cancelled) return;
        setThreadRoot(data.root || null);
        setThreadReplies((current) => {
          const replies = new Map((data.replies || []).map((reply) => [reply.id, reply]));
          for (const reply of current) {
            if (belongsToThread(reply)) replies.set(reply.id, reply);
          }
          return Array.from(replies.values());
        });
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
    const failPendingSends = () => {
      const error = new Error('Connection lost. Try sending again.');
      for (const finish of pendingSends.current.values()) finish(error);
    };

    const refreshThreadPreview = async (rootId: string) => {
      const channelId = channelRef.current;
      previewRequests.get(rootId)?.abort();
      const controller = new AbortController();
      previewRequests.set(rootId, controller);
      try {
        const response = await apiFetch(
          `${SERVER_HTTP}/api/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(rootId)}/preview`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const preview = (await response.json()) as Pick<Message, 'replyCount' | 'replyPreviews'>;
        if (controller.signal.aborted || channelRef.current !== channelId) return;
        setMessages((current) =>
          current.map((root) => root.id === rootId ? { ...root, ...preview } : root),
        );
      } catch (error) {
        if (!controller.signal.aborted) console.error('[Web] Could not refresh thread preview:', error);
      } finally {
        if (previewRequests.get(rootId) === controller) previewRequests.delete(rootId);
      }
    };

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let hasConnectedOnce = false;
    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const connect = () => {
      if (closed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const existing = wsRef.current;
      if (
        existing &&
        (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }
      stopHeartbeat();
      let opened = false;
      const ws = new WebSocket(SERVER_WS);
      wsRef.current = ws;

      ws.onopen = () => {
        opened = true;
        if (closed || wsRef.current !== ws) {
          ws.close();
          return;
        }
        setWsConnected(true);
        const isReconnect = hasConnectedOnce;
        hasConnectedOnce = true;
        ws.send(
          JSON.stringify({ type: 'presence.identify', payload: { userId: currentUserIdRef.current } }),
        );
        if (isReconnect && channelRef.current) {
          setMembersRevision((revision) => revision + 1);
        }
        for (const waiter of wsOpenWaitersRef.current) waiter(ws);
        wsOpenWaitersRef.current.clear();
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
          if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25_000);
      };

      ws.onmessage = (evt) => {
        if (wsRef.current !== ws) return;
        const activeChannelId = channelRef.current;
        try {
          const event = JSON.parse(evt.data) as { type: string; payload: unknown };
          if (event.type === 'message.created') {
            const msg = event.payload as Message;
            pendingSends.current.get(msg.id)?.();
            if (msg.card?.status === 'running') {
              setRunningMessageChannelMap((prev) => ({ ...prev, [msg.id]: msg.channelId }));
            }
            setTypingByChannel((prev) => {
              const chMap = prev[msg.channelId];
              if (!chMap || !chMap[msg.senderId]) return prev;
              const nextCh = { ...chMap };
              delete nextCh[msg.senderId];
              return { ...prev, [msg.channelId]: nextCh };
            });
            if (
              desktopNotificationsRef.current &&
              typeof Notification !== 'undefined' &&
              Notification.permission === 'granted' &&
              msg.senderId !== currentUserIdRef.current &&
              (document.hidden || msg.channelId !== activeChannelId)
            ) {
              const targetCh = channelsRef.current.find((c) => c.id === msg.channelId);
              if (targetCh && !targetCh.muted) {
                const sender = participantsRef.current.find((p) => p.id === msg.senderId);
                const chLabel = targetCh.kind === 'dm' ? targetCh.topic || targetCh.name : `#${targetCh.name}`;
                const title = `${sender?.name || msg.senderId} · ${chLabel}`;
                const body = msg.content.trim().slice(0, 120) || 'Sent an attachment';
                const notif = new Notification(title, { body });
                notif.onclick = () => {
                  window.focus();
                  openMessage(msg);
                };
              }
            }
            const isOwnHumanMessage =
              msg.senderRole === 'human' && msg.senderId === currentUserIdRef.current;
            const mentionsMe = !isOwnHumanMessage && contentMentionsCurrentUser(msg.content);
            if (msg.threadId) {
              const isViewingThisThread =
                msg.channelId === activeChannelId && msg.threadId === activeThreadRootRef.current;
              if (!isOwnHumanMessage && !isViewingThisThread) {
                setChannels((prev) =>
                  prev.map((c) =>
                    c.id === msg.channelId
                      ? {
                          ...c,
                          threadUnreadCount: (c.threadUnreadCount || 0) + 1,
                          ...(mentionsMe ? { mentionCount: (c.mentionCount || 0) + 1 } : {}),
                        }
                      : c,
                  ),
                );
              }
              if (msg.channelId !== activeChannelId) return;
              setMessages((prev) => prev.map((root) => {
                const previews = root.replyPreviews ?? [];
                if (root.id !== msg.threadId || previews.some((reply) => reply.id === msg.id)) {
                  return root;
                }
                return {
                  ...root,
                  replyCount: (root.replyCount ?? 0) + 1,
                  unreadReplyCount:
                    !isOwnHumanMessage && !isViewingThisThread
                      ? (root.unreadReplyCount ?? 0) + 1
                      : root.unreadReplyCount ?? 0,
                  replyPreviews: [...previews, msg]
                    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
                    .slice(-THREAD_REPLY_PREVIEW_LIMIT),
                };
              }));
              if (previewRequests.has(msg.threadId)) void refreshThreadPreview(msg.threadId);
              if (isViewingThisThread) {
                setThreadReplies((prev) =>
                  prev.some((r) => r.id === msg.id) ? prev : [...prev, msg],
                );
                if (!isOwnHumanMessage) {
                  markThreadRead(msg.channelId, msg.threadId, currentUserIdRef.current);
                }
              }
            } else {
              setMessages((prev) => {
                if (msg.channelId !== activeChannelId) return prev;
                if (prev.some((m) => m.id === msg.id)) return prev;
                return [...prev, msg];
              });
              if (!isOwnHumanMessage) {
                setChannels((prev) =>
                  prev.map((c) =>
                    c.id === msg.channelId && msg.channelId !== activeChannelId
                      ? {
                          ...c,
                          unreadCount: (c.unreadCount || 0) + 1,
                          ...(mentionsMe ? { mentionCount: (c.mentionCount || 0) + 1 } : {}),
                        }
                      : c,
                  ),
                );
              }
            }
          } else if (event.type === 'message.send_failed') {
            const { messageId, message } = event.payload as { messageId: string; message: string };
            pendingSends.current.get(messageId)?.(new Error(message));
          } else if (event.type === 'message.updated') {
            const msg = event.payload as Message;
            const activeChannelId = channelRef.current;
            setRunningMessageChannelMap((prev) => {
              if (msg.card?.status === 'running') {
                return prev[msg.id] === msg.channelId ? prev : { ...prev, [msg.id]: msg.channelId };
              }
              if (!(msg.id in prev)) return prev;
              const next = { ...prev };
              delete next[msg.id];
              return next;
            });
            if (msg.justCompleted) {
              if (msg.threadId) {
                const isViewingThisThread =
                  msg.channelId === activeChannelId && msg.threadId === activeThreadRootRef.current;
                if (!isViewingThisThread) {
                  setChannels((prev) =>
                    prev.map((c) =>
                      c.id === msg.channelId
                        ? { ...c, threadUnreadCount: (c.threadUnreadCount || 0) + 1 }
                        : c,
                    ),
                  );
                  if (msg.channelId === activeChannelId) {
                    setMessages((prev) =>
                      prev.map((root) =>
                        root.id === msg.threadId
                          ? { ...root, unreadReplyCount: (root.unreadReplyCount ?? 0) + 1 }
                          : root,
                      ),
                    );
                  }
                } else {
                  markThreadRead(msg.channelId, msg.threadId, currentUserIdRef.current);
                }
              } else if (msg.channelId !== activeChannelId) {
                setChannels((prev) =>
                  prev.map((c) =>
                    c.id === msg.channelId
                      ? { ...c, unreadCount: (c.unreadCount || 0) + 1 }
                      : c,
                  ),
                );
              }
            }
            const updateMessage = (row: Message) => row.id === msg.id
              ? { ...row, ...msg, pinned: row.pinned, replyCount: row.replyCount, unreadReplyCount: row.unreadReplyCount }
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
              prev.some((m) => m.id === messageId)
                ? prev.map((m) => (m.id === messageId ? { ...m, reactions } : m))
                : prev,
            );
            setThreadReplies((prev) =>
              prev.some((r) => r.id === messageId)
                ? prev.map((r) => (r.id === messageId ? { ...r, reactions } : r))
                : prev,
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
          } else if (event.type === 'channel.members.updated') {
            const { channelId, members, ownerId } = event.payload as {
              channelId: string;
              members: ChannelMember[];
              ownerId?: string;
            };
            const ids = new Set<string>();
            for (const m of members || []) {
              if (m.userId) ids.add(m.userId);
              if (m.agentId) ids.add(m.agentId);
            }
            if (ownerId) ids.add(ownerId);
            setChannels((prev) =>
              prev.map((c) => (c.id === channelId ? { ...c, memberIds: Array.from(ids) } : c)),
            );
            if (channelId === activeChannelId) {
              setChannelMembersList(members);
              setChannelOwnerId(ownerId ?? undefined);
              setMembersLoadedChannelId(channelId);
              setMembersLoading(false);
              setMembersError(null);
            }
          } else if (event.type === 'channel.created') {
            const ch = event.payload as Channel;
            setChannels((prev) => (prev.some((c) => c.id === ch.id) ? prev : [...prev, ch]));
          } else if (event.type === 'channel.updated') {
            const ch = event.payload as Channel;
            setChannels((prev) => {
              if (prev.some((c) => c.id === ch.id)) {
                return prev.map((c) =>
                  c.id === ch.id
                    ? {
                        ...c,
                        ...ch,
                        unreadCount:
                          ch.id === channelRef.current
                            ? 0
                            : Math.max(c.unreadCount || 0, ch.unreadCount || 0),
                      }
                    : c,
                );
              }
              // Auto-unhide DM when a new message arrives for currentUserId
              if (
                ch.kind === 'dm' &&
                ch.dmKey?.split('|').includes(`u:${currentUserIdRef.current}`)
              ) {
                return [
                  ...prev,
                  {
                    ...ch,
                    unreadCount: ch.id === channelRef.current ? 0 : ch.unreadCount || 1,
                  },
                ];
              }
              return prev;
            });
          } else if (event.type === 'channel.deleted') {
            const { id } = event.payload as { id: string };
            setChannels((prev) => {
              const remaining = prev.filter((c) => c.id !== id);
              if (channelRef.current === id) {
                const fallback = remaining.find((c) => !c.archived) || remaining[0];
                setActiveChannelId(fallback?.id || '');
              }
              return remaining;
            });
          } else if (event.type === 'typing.updated') {
            const { channelId: tChannelId, userId: tUserId } = event.payload as {
              channelId: string;
              userId: string;
            };
            if (tUserId && tUserId !== currentUserIdRef.current) {
              setTypingByChannel((prev) => ({
                ...prev,
                [tChannelId]: {
                  ...(prev[tChannelId] || {}),
                  [tUserId]: Date.now() + 3500,
                },
              }));
            }
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
        if (closed || wsRef.current !== ws) return;
        wsRef.current = null;
        setWsConnected(false);
        stopHeartbeat();
        failPendingSends();
        if (timer) clearTimeout(timer);
        if (auth.authRequired && !opened) {
          // Browser WebSocket hides HTTP 401 on handshake failure; probe session via raw fetch
          // (without mutating Better Auth's useSession store) so Workspace stays mounted under SessionExpiredOverlay.
          void fetch(`${SERVER_HTTP}/api/auth/get-session`, { credentials: 'include' })
            .then(async (res) => {
              if (closed) return;
              const data = res.ok
                ? ((await res.json().catch(() => null)) as { user?: unknown } | null)
                : null;
              if (!res.ok || !data?.user) {
                notifyUnauthorized();
                return;
              }
              timer = setTimeout(connect, 1000);
            })
            .catch(() => {
              if (!closed) {
                timer = setTimeout(connect, 1000);
              }
            });
          return;
        }
        timer = setTimeout(connect, 1000);
      };

      ws.onerror = () => {
        // onclose will follow and schedule reconnect
      };
    };

    const reconnectIfNeeded = () => {
      if (closed) return;
      const current = wsRef.current;
      if (!current || (current.readyState !== WebSocket.OPEN && current.readyState !== WebSocket.CONNECTING)) {
        connect();
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') reconnectIfNeeded();
    };

    wsReconnectRef.current = reconnectIfNeeded;
    window.addEventListener('online', reconnectIfNeeded);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    connect();
    return () => {
      closed = true;
      wsReconnectRef.current = null;
      window.removeEventListener('online', reconnectIfNeeded);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopHeartbeat();
      if (timer) clearTimeout(timer);
      for (const request of previewRequests.values()) request.abort();
      failPendingSends();
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [applyPins, auth.orgRevision]);

  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: 'presence.identify', payload: { userId: currentUserId } }),
      );
    }
  }, [currentUserId]);

  useEffect(() => {
    if (!terminalSessionId) {
      setTerminalLink(null);
      setSessionHistory(null);
      return;
    }
    const controller = new AbortController();
    apiFetch(`${SERVER_HTTP}/api/sessions/${encodeURIComponent(terminalSessionId)}/write-link`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((d: { url?: string | null }) => {
        if (!controller.signal.aborted) {
          setTerminalLink({ sessionId: terminalSessionId, url: d.url || null });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setTerminalLink({ sessionId: terminalSessionId, url: null });
        }
      });
    return () => controller.abort();
  }, [terminalSessionId]);

  const humans = participants.filter((p) => p.role === 'human');
  const agents = participants.filter((p) => p.role === 'agent');
  const activeAgents = agents.filter((a) => !a.archived);
  const archivedAgents = agents.filter((a) => a.archived);
  const validGroupIds = new Set(sidebarGroups.map((g) => g.id));
  const matchesUnreadFilter = (c: Channel) =>
    !unreadOnly ||
    c.id === activeChannelId ||
    ((c.unreadCount > 0 || Boolean(c.markedUnread)) && !c.muted);
  const starredChannels = channels.filter(
    (c) => !c.archived && c.starred && matchesUnreadFilter(c),
  );
  const groupedChannelsById = new Map<string, Channel[]>();
  for (const g of sidebarGroups) groupedChannelsById.set(g.id, []);
  for (const c of channels) {
    if (
      !c.archived &&
      !c.starred &&
      c.groupId &&
      validGroupIds.has(c.groupId) &&
      matchesUnreadFilter(c)
    ) {
      groupedChannelsById.get(c.groupId)!.push(c);
    }
  }
  const regularChannels = channels.filter(
    (c) =>
      c.kind !== 'dm' &&
      !c.archived &&
      !c.starred &&
      !(c.groupId && validGroupIds.has(c.groupId)) &&
      matchesUnreadFilter(c),
  );
  const archivedChannels = channels.filter((c) => c.kind !== 'dm' && c.archived);
  const dmChannels = channels.filter(
    (c) =>
      c.kind === 'dm' &&
      !c.starred &&
      !(c.groupId && validGroupIds.has(c.groupId)) &&
      matchesUnreadFilter(c),
  );
  const activeChannel = channels.find((c) => c.id === activeChannelId);
  const workingChannelIds = new Set(Object.values(runningMessageChannelMap));
  const activeTypingMap = typingByChannel[activeChannelId] || {};
  const activeTypingLabels = Object.entries(activeTypingMap)
    .filter(([, expiresAt]) => expiresAt > Date.now())
    .map(([uid]) => participants.find((p) => p.id === uid)?.name || uid);

  useEffect(() => {
    const hasEntries = Object.values(typingByChannel).some((m) => Object.keys(m).length > 0);
    if (!hasEntries) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setTypingByChannel((prev) => {
        let changed = false;
        const next: Record<string, Record<string, number>> = {};
        for (const [chId, usersMap] of Object.entries(prev)) {
          const kept: Record<string, number> = {};
          for (const [uid, exp] of Object.entries(usersMap)) {
            if (exp > now) kept[uid] = exp;
            else changed = true;
          }
          if (Object.keys(kept).length > 0) next[chId] = kept;
          else if (Object.keys(usersMap).length > 0) changed = true;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [typingByChannel]);

  useEffect(() => {
    if (!activeChannelId) return;
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (hashParams.get('channel') === activeChannelId) return;
    const nextUrl = `${window.location.pathname}${window.location.search}#channel=${encodeURIComponent(activeChannelId)}`;
    window.history.replaceState(null, '', nextUrl);
  }, [activeChannelId]);

  useEffect(() => {
    const onHashChange = () => {
      const hashRaw = window.location.hash.replace(/^#/, '');
      const hashParams = new URLSearchParams(hashRaw);
      const hashChannelId = hashParams.get('channel') || '';
      const hashMessageId = hashParams.get('message') || '';
      if (hashMessageId) {
        void apiFetch(
          `${SERVER_HTTP}/api/messages/${encodeURIComponent(hashMessageId)}?userId=${encodeURIComponent(currentUserIdRef.current)}`,
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { message?: Message } | null) => {
            if (d?.message) openMessage(d.message);
          })
          .catch(() => undefined);
      } else if (hashChannelId && channelsRef.current.some((c) => c.id === hashChannelId)) {
        openChannel(hashChannelId, { syncUrl: false });
      }
    };
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('popstate', onHashChange);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.altKey && !event.metaKey && !event.ctrlKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (activeModal(document)) return;
        const ordered: Channel[] = [
          ...starredChannels,
          ...sidebarGroups.flatMap((g) => groupedChannelsById.get(g.id) || []),
          ...regularChannels,
          ...dmChannels,
        ];
        const list = event.shiftKey
          ? ordered.filter((c) => ((c.unreadCount > 0 || c.markedUnread) && !c.muted) || c.id === activeChannelId)
          : ordered;
        if (list.length <= 1) return;
        event.preventDefault();
        const idx = list.findIndex((c) => c.id === activeChannelId);
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const nextIdx = idx === -1 ? 0 : (idx + delta + list.length) % list.length;
        openChannel(list[nextIdx]!.id);
        return;
      }
      if (event.key === 'Escape' && !event.altKey && !event.metaKey && !event.ctrlKey) {
        if (activeModal(document)) return;
        if (showPinsPanel) {
          event.preventDefault();
          closePins();
        } else if (selectedAgentProfileId) {
          event.preventDefault();
          setSelectedAgentProfileId(null);
        } else if (terminalSessionId) {
          event.preventDefault();
          setTerminalSessionId(null);
          setTerminalReturnAgentId(null);
        } else if (activeThreadRootId) {
          if (document.querySelector('.buzz-popover-popup:not([data-closed])')) {
            return;
          }
          event.preventDefault();
          setActiveThreadRootId(null);
          setMessageFocus((current) => (current?.reply ? { ...current, reply: undefined } : current));
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    starredChannels,
    sidebarGroups,
    groupedChannelsById,
    regularChannels,
    dmChannels,
    activeChannelId,
    showPinsPanel,
    selectedAgentProfileId,
    terminalSessionId,
    activeThreadRootId,
  ]);

  const handleTyping = () => {
    if (!activeChannelId || activeChannel?.archived || wsRef.current?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 1500) return;
    lastTypingSentRef.current = now;
    wsRef.current.send(
      JSON.stringify({
        type: 'typing.start',
        payload: { channelId: activeChannelId, userId: currentUserId },
      }),
    );
  };

  const changeDesktopNotifications = (enabled: boolean) => {
    setDesktopNotifications(enabled);
    try {
      localStorage.setItem(DESKTOP_NOTIFICATIONS_KEY, String(enabled));
    } catch {
      // ignore
    }
  };

  const requestDeleteMessage = (messageId: string) => {
    const target =
      messages.find((m) => m.id === messageId) ||
      threadReplies.find((m) => m.id === messageId) ||
      (threadRoot?.id === messageId ? threadRoot : null);
    if (target) {
      setDeleteMessageTarget(target);
    } else {
      void handleDeleteMessage(messageId);
    }
  };

  const handleConfirmDeleteMessage = async () => {
    if (!deleteMessageTarget || deleteMessagePending) return;
    setDeleteMessagePending(true);
    try {
      await handleDeleteMessage(deleteMessageTarget.id);
      setDeleteMessageTarget(null);
    } finally {
      setDeleteMessagePending(false);
    }
  };

  const handleToggleChannelMute = async (channel: Channel, muted: boolean) => {
    const res = await apiFetch(`${SERVER_HTTP}/api/channels/${encodeURIComponent(channel.id)}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId, muted }),
    });
    if (!res.ok) {
      setNavigationError('Could not update mute setting');
      return;
    }
    setChannels((prev) => prev.map((c) => (c.id === channel.id ? { ...c, muted } : c)));
  };

  const handleMarkChannelUnread = async (channel: Channel) => {
    const res = await apiFetch(`${SERVER_HTTP}/api/channels/${encodeURIComponent(channel.id)}/unread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId }),
    });
    if (!res.ok) {
      setNavigationError('Could not mark channel as unread');
      return;
    }
    setChannels((prev) =>
      prev.map((c) =>
        c.id === channel.id
          ? { ...c, markedUnread: true, unreadCount: Math.max(1, c.unreadCount) }
          : c,
      ),
    );
  };

  const handleCopyChannelLink = (channel: Channel) => {
    const url = `${window.location.origin}${window.location.pathname}#channel=${encodeURIComponent(channel.id)}`;
    void writeClipboardText(url).catch(() => undefined);
  };

  const handleSetChannelPlacement = async (
    channel: Channel,
    placement: { starred?: boolean; groupId?: string | null },
  ) => {
    const res = await apiFetch(
      `${SERVER_HTTP}/api/channels/${encodeURIComponent(channel.id)}/placement`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId, ...placement }),
      },
    );
    if (!res.ok) {
      setNavigationError('Could not move channel');
      return;
    }
    const data = (await res.json()) as { starred?: boolean; groupId?: string | null };
    setChannels((prev) =>
      prev.map((c) =>
        c.id === channel.id
          ? { ...c, starred: Boolean(data.starred), groupId: data.groupId || undefined }
          : c,
      ),
    );
  };

  const handleCreateSidebarGroup = async () => {
    const name = newGroupName.trim();
    if (!name || creatingGroupPending) return;
    setCreatingGroupPending(true);
    try {
      const res = await apiFetch(`${SERVER_HTTP}/api/sidebar-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId, name }),
      });
      if (!res.ok) {
        setNavigationError('Could not create section');
        return;
      }
      const data = (await res.json()) as { group: SidebarGroup };
      setSidebarGroups((prev) => [...prev, data.group]);
      const target = createGroupTarget;
      setCreateGroupTarget(null);
      setNewGroupName('');
      if (target) {
        await handleSetChannelPlacement(target, { starred: false, groupId: data.group.id });
      }
    } finally {
      setCreatingGroupPending(false);
    }
  };

  const handleRenameSidebarGroup = async () => {
    if (!renameGroupTarget || renamingGroupPending) return;
    const name = renameGroupName.trim();
    if (!name) return;
    setRenamingGroupPending(true);
    try {
      const res = await apiFetch(
        `${SERVER_HTTP}/api/sidebar-groups/${encodeURIComponent(renameGroupTarget.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: currentUserId, name }),
        },
      );
      if (!res.ok) {
        setNavigationError('Could not rename section');
        return;
      }
      const data = (await res.json()) as { group: SidebarGroup };
      setSidebarGroups((prev) =>
        prev.map((g) => (g.id === data.group.id ? data.group : g)),
      );
      setRenameGroupTarget(null);
      setRenameGroupName('');
    } finally {
      setRenamingGroupPending(false);
    }
  };

  const openChannelSettings = (channel: Channel) => {
    setChannelSettingsTarget(channel);
    setSettingsName(channel.name);
    setSettingsTopic(channel.topic || '');
    setSettingsReplyMode(channel.replyMode || 'follow_source');
    setSettingsError(null);
  };

  const handleSaveChannelSettings = async () => {
    if (!channelSettingsTarget || settingsPending) return;
    const trimmedName = settingsName.trim();
    if (!trimmedName) {
      setSettingsError('Channel name is required');
      return;
    }
    setSettingsPending(true);
    setSettingsError(null);
    try {
      const res = await apiFetch(
        `${SERVER_HTTP}/api/channels/${encodeURIComponent(channelSettingsTarget.id)}/settings`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: currentUserId,
            name: trimmedName,
            topic: settingsTopic.trim(),
            replyMode: settingsReplyMode,
          }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        setSettingsError(err?.error || 'Could not update channel settings');
        return;
      }
      const data = (await res.json()) as { channel: Channel };
      setChannels((prev) =>
        prev.map((c) => (c.id === data.channel.id ? { ...c, ...data.channel } : c)),
      );
      setChannelSettingsTarget(null);
    } finally {
      setSettingsPending(false);
    }
  };

  const handleDeleteSidebarGroup = async (groupId: string) => {
    const res = await apiFetch(
      `${SERVER_HTTP}/api/sidebar-groups/${encodeURIComponent(groupId)}?userId=${encodeURIComponent(currentUserId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setNavigationError('Could not delete section');
      return;
    }
    setSidebarGroups((prev) => prev.filter((g) => g.id !== groupId));
    setChannels((prev) =>
      prev.map((c) => (c.groupId === groupId ? { ...c, groupId: undefined } : c)),
    );
  };

  const handleSetChannelArchived = async (channel: Channel, archived: boolean) => {
    setChannelLifecyclePending(true);
    try {
      const res = await apiFetch(
        `${SERVER_HTTP}/api/channels/${encodeURIComponent(channel.id)}/archive`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: currentUserId, archived }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        setNavigationError(err?.error || 'Could not update channel archive state');
        return;
      }
      setChannels((prev) => {
        const next = prev.map((c) => (c.id === channel.id ? { ...c, archived } : c));
        if (archived && activeChannelId === channel.id) {
          const fallback = next.find((c) => !c.archived && c.id !== channel.id);
          if (fallback) setActiveChannelId(fallback.id);
        }
        return next;
      });
      setChannelLifecycleDialog(null);
    } finally {
      setChannelLifecyclePending(false);
    }
  };

  const handleDeleteChannel = async (channel: Channel) => {
    setChannelLifecyclePending(true);
    try {
      const res = await apiFetch(
        `${SERVER_HTTP}/api/channels/${encodeURIComponent(channel.id)}?userId=${encodeURIComponent(currentUserId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        setNavigationError(err?.error || 'Could not delete channel');
        return;
      }
      setChannels((prev) => {
        const remaining = prev.filter((c) => c.id !== channel.id);
        if (activeChannelId === channel.id) {
          const fallback = remaining.find((c) => !c.archived) || remaining[0];
          setActiveChannelId(fallback?.id || '');
        }
        return remaining;
      });
      setChannelLifecycleDialog(null);
    } finally {
      setChannelLifecyclePending(false);
    }
  };

  const handleLeaveChannel = async (channel: Channel) => {
    setChannelLifecyclePending(true);
    try {
      const res = await apiFetch(
        `${SERVER_HTTP}/api/channels/${encodeURIComponent(channel.id)}/members`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: currentUserId }),
        },
      );
      if (!res.ok) {
        setNavigationError('Could not leave channel');
        return;
      }
      setChannels((prev) => {
        const remaining = prev.filter((c) => c.id !== channel.id);
        if (activeChannelId === channel.id) {
          const fallback = remaining.find((c) => !c.archived) || remaining[0];
          setActiveChannelId(fallback?.id || '');
        }
        return remaining;
      });
      setChannelLifecycleDialog(null);
    } finally {
      setChannelLifecyclePending(false);
    }
  };

  const handleCloseDm = async (channel: Channel) => {
    const res = await apiFetch(`${SERVER_HTTP}/api/channels/${encodeURIComponent(channel.id)}/hide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId, hidden: true }),
    });
    if (!res.ok) {
      setNavigationError('Could not close conversation');
      return;
    }
    setChannels((prev) => {
      const remaining = prev.filter((c) => c.id !== channel.id);
      if (activeChannelId === channel.id) {
        const fallback = remaining.find((c) => !c.archived) || remaining[0];
        setActiveChannelId(fallback?.id || '');
      }
      return remaining;
    });
  };

  const openChannel = (channelId: string, options?: { syncUrl?: boolean }) => {
    setJumpTarget(null);
    setMessageFocus(null);
    setNavigationError(null);
    setActiveChannelId(channelId);
    if (options?.syncUrl !== false && channelId) {
      const nextHash = `#channel=${encodeURIComponent(channelId)}`;
      if (window.location.hash !== nextHash) {
        const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
        window.history.pushState(null, '', nextUrl);
      }
    }
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
    setTerminalReturnAgentId(null);
    setShowPinsPanel(false);
    setSelectedAgentProfileId(agentId);
  };

  const openTerminalSession = (
    sessionId: string,
    context?: { agentId?: string; channelId?: string },
  ) => {
    setSelectedAgentProfileId(null);
    setShowPinsPanel(false);
    setSessionHistory(null);
    setTerminalReturnAgentId(context?.agentId ?? null);
    setTerminalSessionId(sessionId);
  };

  const handleUploadFile = async (file: File): Promise<UploadedAttachment | null> => {
    const form = new FormData();
    form.append('file', file);
    const res = await apiFetch(`${SERVER_HTTP}/api/uploads`, {
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
      const data = await fetchMessagePage(activeChannelId, controller.signal, { nextCursor, nextCursorId }, 50, currentUserId);
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

  const ensureWsOpen = async (timeoutMs = 4000): Promise<WebSocket> => {
    const current = wsRef.current;
    if (current?.readyState === WebSocket.OPEN) {
      return current;
    }
    if (!current || current.readyState !== WebSocket.CONNECTING) {
      wsReconnectRef.current?.();
    }
    const afterReconnect = wsRef.current;
    if (afterReconnect?.readyState === WebSocket.OPEN) {
      return afterReconnect;
    }
    return await new Promise<WebSocket>((resolve, reject) => {
      const onOpen = (openWs: WebSocket) => {
        clearTimeout(waitTimer);
        wsOpenWaitersRef.current.delete(onOpen);
        resolve(openWs);
      };
      const waitTimer = setTimeout(() => {
        wsOpenWaitersRef.current.delete(onOpen);
        reject(new Error('Connection unavailable. Try sending again.'));
      }, timeoutMs);
      wsOpenWaitersRef.current.add(onOpen);
    });
  };

  const handleSendMessage = async (
    content: string,
    attachments: UploadedAttachment[],
    messageId: string,
    threadId?: string,
    replyToId?: string,
  ) => {
    if (!activeChannelId) throw new Error('Select a channel to send this message.');
    if (activeChannel?.archived) throw new Error('This channel is archived.');
    const ws = await ensureWsOpen();

    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        pendingSends.current.delete(messageId);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new Error('Message delivery was not confirmed. Try sending again.'));
      }, MESSAGE_SEND_TIMEOUT_MS);

      pendingSends.current.set(messageId, finish);
      try {
        ws.send(JSON.stringify({
          type: 'message.send',
          payload: {
            messageId,
            channelId: activeChannelId,
            senderId: currentUserId,
            content,
            threadId,
            replyToId,
            attachments: attachments.length > 0 ? attachments : undefined,
          },
        }));
      } catch {
        finish(new Error('Could not send this message. Try again.'));
      }
    });
  };

  const handleSendThreadReply = async (
    content: string,
    attachments: UploadedAttachment[],
    messageId: string,
    replyToId?: string,
  ) => {
    if (!activeThreadRootId) throw new Error('Open the thread to send this reply.');
    await handleSendMessage(content, attachments, messageId, activeThreadRootId, replyToId);
  };

  const handleTogglePin = async (msg: Message) => {
    const endpoint = `${SERVER_HTTP}/api/channels/${encodeURIComponent(msg.channelId)}/pins`;
    const response = msg.pinned
      ? await apiFetch(`${endpoint}/${encodeURIComponent(msg.id)}`, { method: 'DELETE' })
      : await apiFetch(endpoint, {
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
    await apiFetch(`${SERVER_HTTP}/api/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    setEditingMessageId(null);
    setEditingDraft('');
  };

  const handleDeleteMessage = async (messageId: string) => {
    await apiFetch(`${SERVER_HTTP}/api/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
  };

  const handleToggleReaction = async (messageId: string, emoji: string) => {
    await apiFetch(`${SERVER_HTTP}/api/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId, emoji }),
    });
  };

  const handleOpenDm = async (target: Participant) => {
    const res = await apiFetch(`${SERVER_HTTP}/api/dms`, {
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
    const response = await apiFetch(`${SERVER_HTTP}/api/channels/${encodeURIComponent(channelId)}/members`, {
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
      await apiFetch(
        `${SERVER_HTTP}/api/sessions/${encodeURIComponent(terminalSessionId)}/${op}`,
        { method: 'POST' },
      );
      if (op === 'close') {
        setTerminalSessionId((current) => current === terminalSessionId ? null : current);
      }
    } finally {
      setSessionActionBusy(null);
    }
  };

  const handleLoadSessionHistory = async () => {
    if (!terminalSessionId) return;
    if (activeSessionHistory) {
      setSessionHistory(null);
      return;
    }

    const request = { sessionId: terminalSessionId, content: null };
    setSessionHistory(request);
    let content: string;
    try {
      const res = await apiFetch(
        `${SERVER_HTTP}/api/sessions/${encodeURIComponent(terminalSessionId)}/history`,
      );
      content = JSON.stringify(await res.json(), null, 2);
    } catch {
      content = '无法加载 Botmux 会话历史。';
    }
    setSessionHistory((current) => current === request ? { ...request, content } : current);
  };

  const handleAnswerAsk = async (ask: BotmuxPendingAsk, optionKey: string) => {
    const currentHuman = humans.find((h) => h.id === currentUserId);
    await apiFetch(`${SERVER_HTTP}/api/asks/answer`, {
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

  const toggleCreateChannelTarget = (target: string) => {
    setCreateChannelError(null);
    setNewChannelName('');
    setCreatingChannelTarget((prev) => (prev === target ? null : target));
  };

  const handleCreateChannel = async (targetGroupId?: string | null) => {
    const name = newChannelName.trim();
    if (!name || creatingChannelPending) return;
    setCreateChannelError(null);
    setCreatingChannelPending(true);
    try {
      const res = await apiFetch(`${SERVER_HTTP}/api/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, userId: currentUserId }),
      });
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        setCreateChannelError(errData.error || `创建失败 (${res.status})`);
        return;
      }
      const data = (await res.json()) as { channel: Channel };
      const createdChannel: Channel = {
        ...data.channel,
        ...(targetGroupId ? { groupId: targetGroupId, starred: false } : {}),
      };
      setChannels((prev) =>
        prev.some((c) => c.id === createdChannel.id)
          ? prev.map((c) => (c.id === createdChannel.id ? { ...c, ...createdChannel } : c))
          : [...prev, createdChannel],
      );
      if (targetGroupId) {
        await handleSetChannelPlacement(createdChannel, {
          starred: false,
          groupId: targetGroupId,
        });
      }
      openChannel(createdChannel.id);
      setNewChannelName('');
      setCreateChannelError(null);
      setCreatingChannelTarget(null);
    } catch {
      setCreateChannelError('网络异常，创建频道失败');
    } finally {
      setCreatingChannelPending(false);
    }
  };

  const unreadThreadsInChannel = useMemo(
    () => messages.filter((m) => (m.unreadReplyCount ?? 0) > 0),
    [messages],
  );

  const detailPane = showActivityPanel
    ? 'activity'
    : showPinsPanel && activeChannel
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
                footer={
                  <ProfileButton
                    user={auth.user}
                    fallbackName={
                      participants.find((p) => p.id === currentUserId)?.name || 'Owner'
                    }
                    fallbackAvatarUrl={
                      participants.find((p) => p.id === currentUserId)?.avatarUrl
                    }
                    organizations={auth.organizations}
                    activeOrg={auth.activeOrg}
                    colorMode={appearanceSnapshot.preference}
                    onColorModeChange={(mode) => appearance.setMode(mode)}
                    onSwitchOrg={(orgId) => void auth.switchOrganization(orgId)}
                    onOpenCreateOrg={() => setShowCreateCommunity(true)}
                    onOpenCommunityMembers={() => setShowCommunityMembers(true)}
                    onOpenProfileSettings={() => setShowProfileSettings(true)}
                    onSignOut={() => void auth.signOut()}
                  />
                }
                header={
                  <div>
                    <PanelHeader
                      title="BubAI"
                      icon={
                        <img
                          className={workspaceStyles.brandMark}
                          src={bubaiLogoUrl}
                          alt=""
                          width={20}
                          height={20}
                        />
                      }
                      actions={
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Badge tone={wsConnected ? 'success' : 'neutral'}>
                            {wsConnected ? 'Live' : 'Offline'}
                          </Badge>
                          <IconButton
                            ref={settingsButton}
                            hint="familiar"
                            size="sm"
                            aria-label="Settings"
                            aria-haspopup="dialog"
                            title="Settings"
                            icon={<GearIcon size={16} />}
                            onClick={() => setShowSettings(true)}
                          />
                          <IconButton
                            hint="familiar"
                            size="sm"
                            aria-label="Filter unread"
                            aria-pressed={unreadOnly}
                            title={unreadOnly ? 'Showing unread only (click to show all)' : 'Filter unread'}
                            icon={
                              unreadOnly ? (
                                <NotificationFilledIcon size={16} />
                              ) : (
                                <NotificationIcon size={16} />
                              )
                            }
                            onClick={() => setUnreadOnly((v) => !v)}
                          />
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
                <div style={{ padding: '4px 6px 2px' }}>
                  <NavigationItem
                    data-activity-nav="true"
                    label="Activity"
                    selected={showActivityPanel}
                    unread={totalUnreadCount > 0 && !showActivityPanel}
                    icon={<BellIcon size={16} aria-hidden="true" />}
                    trailing={
                      totalUnreadCount > 0 ? (
                        <CountBadge
                          count={totalUnreadCount}
                          label={`${totalUnreadCount} unread items`}
                        />
                      ) : undefined
                    }
                    onClick={() => {
                      if (showActivityPanel) {
                        setShowActivityPanel(false);
                      } else {
                        setShowPinsPanel(false);
                        setSelectedAgentProfileId(null);
                        setTerminalSessionId(null);
                        setShowActivityPanel(true);
                      }
                    }}
                  />
                </div>
                  {starredChannels.length > 0 && (
                    <NavigationSection label="Starred">
                      {starredChannels.map((ch) => (
                        <SidebarChannelRow
                          key={ch.id}
                          channel={ch}
                          selected={ch.id === activeChannelId}
                          currentUserId={currentUserId}
                          sidebarGroups={sidebarGroups}
                          sectionTitle="Starred"
                          isWorking={workingChannelIds.has(ch.id)}
                          onOpen={() => openChannel(ch.id)}
                          onToggleMute={(muted) => void handleToggleChannelMute(ch, muted)}
                          onMarkRead={() => markChannelRead(ch.id, currentUserId, true)}
                          onMarkUnread={() => void handleMarkChannelUnread(ch)}
                          onCopyLink={() => handleCopyChannelLink(ch)}
                          onSetPlacement={(p) => void handleSetChannelPlacement(ch, p)}
                          onRequestCreateGroup={() => {
                            setCreateGroupTarget(ch);
                            setNewGroupName('');
                          }}
                          onOpenSettings={() => openChannelSettings(ch)}
                          onRequestArchive={() =>
                            setChannelLifecycleDialog({ action: 'archive', channel: ch })
                          }
                          onRequestUnarchive={() => void handleSetChannelArchived(ch, false)}
                          onRequestLeave={() =>
                            setChannelLifecycleDialog({ action: 'leave', channel: ch })
                          }
                          onRequestDelete={() =>
                            setChannelLifecycleDialog({ action: 'delete', channel: ch })
                          }
                          onCloseDm={() => void handleCloseDm(ch)}
                        />
                      ))}
                    </NavigationSection>
                  )}

                  {sidebarGroups.map((group) => {
                    const groupItems = groupedChannelsById.get(group.id) || [];
                    return (
                      <NavigationSection
                        key={group.id}
                        label={group.name}
                        action={
                          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                            <IconButton
                              hint="familiar"
                              size="sm"
                              aria-label={`New channel in ${group.name}`}
                              title={`New channel in ${group.name}`}
                              icon={<PlusIcon size={16} />}
                              onClick={() => toggleCreateChannelTarget(group.id)}
                            />
                            <MenuRoot>
                              <MenuTrigger
                                render={
                                  <IconButton
                                    hint="familiar"
                                    size="sm"
                                    aria-label={`More actions for ${group.name}`}
                                    title={`More actions for ${group.name}`}
                                    icon={<DotsThreeIcon size={16} aria-hidden="true" />}
                                  />
                                }
                              />
                              <MenuPopup side="bottom" align="end" size="compact">
                                <MenuItem
                                  onClick={() => {
                                    setRenameGroupTarget(group);
                                    setRenameGroupName(group.name);
                                  }}
                                >
                                  <MenuIcon>
                                    <PencilSimpleIcon size={14} />
                                  </MenuIcon>
                                  Rename section
                                </MenuItem>
                                <MenuSeparator />
                                <MenuItem
                                  tone="danger"
                                  onClick={() => void handleDeleteSidebarGroup(group.id)}
                                >
                                  <MenuIcon>
                                    <TrashIcon size={14} />
                                  </MenuIcon>
                                  Delete section
                                </MenuItem>
                              </MenuPopup>
                            </MenuRoot>
                          </div>
                        }
                      >
                        {creatingChannelTarget === group.id && (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              void handleCreateChannel(group.id);
                            }}
                            style={{ padding: '4px 6px' }}
                          >
                            <Input
                              value={newChannelName}
                              disabled={creatingChannelPending}
                              onChange={(e) => {
                                setNewChannelName(e.target.value);
                                if (createChannelError) setCreateChannelError(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.preventDefault();
                                  setCreatingChannelTarget(null);
                                  setNewChannelName('');
                                  setCreateChannelError(null);
                                }
                              }}
                              placeholder="channel-name"
                              autoFocus
                            />
                            {createChannelError && (
                              <div
                                className="text-caption"
                                role="alert"
                                style={{
                                  color: 'var(--text-danger, #e5484d)',
                                  marginTop: 4,
                                  paddingLeft: 2,
                                }}
                              >
                                {createChannelError}
                              </div>
                            )}
                          </form>
                        )}
                        {groupItems.map((ch) => (
                          <SidebarChannelRow
                            key={ch.id}
                            channel={ch}
                            selected={ch.id === activeChannelId}
                            currentUserId={currentUserId}
                            sidebarGroups={sidebarGroups}
                            sectionTitle={group.name}
                            isWorking={workingChannelIds.has(ch.id)}
                            onOpen={() => openChannel(ch.id)}
                            onToggleMute={(muted) => void handleToggleChannelMute(ch, muted)}
                            onMarkRead={() => markChannelRead(ch.id, currentUserId, true)}
                            onMarkUnread={() => void handleMarkChannelUnread(ch)}
                            onCopyLink={() => handleCopyChannelLink(ch)}
                            onSetPlacement={(p) => void handleSetChannelPlacement(ch, p)}
                            onRequestCreateGroup={() => {
                              setCreateGroupTarget(ch);
                              setNewGroupName('');
                            }}
                            onOpenSettings={() => openChannelSettings(ch)}
                            onRequestArchive={() =>
                              setChannelLifecycleDialog({ action: 'archive', channel: ch })
                            }
                            onRequestUnarchive={() => void handleSetChannelArchived(ch, false)}
                            onRequestLeave={() =>
                              setChannelLifecycleDialog({ action: 'leave', channel: ch })
                            }
                            onRequestDelete={() =>
                              setChannelLifecycleDialog({ action: 'delete', channel: ch })
                            }
                            onCloseDm={() => void handleCloseDm(ch)}
                          />
                        ))}
                      </NavigationSection>
                    );
                  })}

                  <NavigationSection
                    label="Channels"
                    action={
                      <IconButton
                        hint="familiar"
                        size="sm"
                        aria-label="New channel"
                        icon={<PlusIcon size={16} />}
                        onClick={() => toggleCreateChannelTarget('channels')}
                      />
                    }
                  >
                    {creatingChannelTarget === 'channels' && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handleCreateChannel(null);
                        }}
                        style={{ padding: '4px 6px' }}
                      >
                        <Input
                          value={newChannelName}
                          disabled={creatingChannelPending}
                          onChange={(e) => {
                            setNewChannelName(e.target.value);
                            if (createChannelError) setCreateChannelError(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setCreatingChannelTarget(null);
                              setNewChannelName('');
                              setCreateChannelError(null);
                            }
                          }}
                          placeholder="channel-name"
                          autoFocus
                        />
                        {createChannelError && (
                          <div
                            className="text-caption"
                            role="alert"
                            style={{
                              color: 'var(--text-danger, #e5484d)',
                              marginTop: 4,
                              paddingLeft: 2,
                            }}
                          >
                            {createChannelError}
                          </div>
                        )}
                      </form>
                    )}
                    {regularChannels.map((ch) => (
                      <SidebarChannelRow
                        key={ch.id}
                        channel={ch}
                        selected={ch.id === activeChannelId}
                        currentUserId={currentUserId}
                        sidebarGroups={sidebarGroups}
                        sectionTitle="Channels"
                        isWorking={workingChannelIds.has(ch.id)}
                        onOpen={() => openChannel(ch.id)}
                        onToggleMute={(muted) => void handleToggleChannelMute(ch, muted)}
                        onMarkRead={() => markChannelRead(ch.id, currentUserId, true)}
                        onMarkUnread={() => void handleMarkChannelUnread(ch)}
                        onCopyLink={() => handleCopyChannelLink(ch)}
                        onSetPlacement={(p) => void handleSetChannelPlacement(ch, p)}
                        onRequestCreateGroup={() => {
                          setCreateGroupTarget(ch);
                          setNewGroupName('');
                        }}
                        onOpenSettings={() => openChannelSettings(ch)}
                        onRequestArchive={() =>
                          setChannelLifecycleDialog({ action: 'archive', channel: ch })
                        }
                        onRequestUnarchive={() => void handleSetChannelArchived(ch, false)}
                        onRequestLeave={() =>
                          setChannelLifecycleDialog({ action: 'leave', channel: ch })
                        }
                        onRequestDelete={() =>
                          setChannelLifecycleDialog({ action: 'delete', channel: ch })
                        }
                        onCloseDm={() => void handleCloseDm(ch)}
                      />
                    ))}
                    {archivedChannels.length > 0 && (
                      <div style={{ padding: '4px 6px' }}>
                        <Button
                          variant="quiet"
                          size="xs"
                          onClick={() => setShowArchivedChannels((v) => !v)}
                        >
                          {showArchivedChannels
                            ? `隐藏已归档频道 (${archivedChannels.length})`
                            : `已归档频道 (${archivedChannels.length})`}
                        </Button>
                        {showArchivedChannels &&
                          archivedChannels.map((ch) => (
                            <SidebarChannelRow
                              key={ch.id}
                              channel={ch}
                              selected={ch.id === activeChannelId}
                              currentUserId={currentUserId}
                              sidebarGroups={sidebarGroups}
                              sectionTitle="Archived"
                              onOpen={() => openChannel(ch.id)}
                              onToggleMute={(muted) => void handleToggleChannelMute(ch, muted)}
                              onMarkRead={() => markChannelRead(ch.id, currentUserId, true)}
                              onMarkUnread={() => void handleMarkChannelUnread(ch)}
                              onCopyLink={() => handleCopyChannelLink(ch)}
                              onSetPlacement={(p) => void handleSetChannelPlacement(ch, p)}
                              onRequestCreateGroup={() => {
                                setCreateGroupTarget(ch);
                                setNewGroupName('');
                              }}
                              onOpenSettings={() => openChannelSettings(ch)}
                              onRequestArchive={() =>
                                setChannelLifecycleDialog({ action: 'archive', channel: ch })
                              }
                              onRequestUnarchive={() => void handleSetChannelArchived(ch, false)}
                              onRequestLeave={() =>
                                setChannelLifecycleDialog({ action: 'leave', channel: ch })
                              }
                              onRequestDelete={() =>
                                setChannelLifecycleDialog({ action: 'delete', channel: ch })
                              }
                              onCloseDm={() => void handleCloseDm(ch)}
                            />
                          ))}
                      </div>
                    )}
                  </NavigationSection>

                  {dmChannels.length > 0 && (
                    <NavigationSection label="Direct Messages">
                      {dmChannels.map((dm) => (
                        <SidebarChannelRow
                          key={dm.id}
                          channel={dm}
                          selected={dm.id === activeChannelId}
                          currentUserId={currentUserId}
                          sidebarGroups={sidebarGroups}
                          sectionTitle="Direct Messages"
                          isWorking={workingChannelIds.has(dm.id)}
                          onOpen={() => openChannel(dm.id)}
                          onToggleMute={(muted) => void handleToggleChannelMute(dm, muted)}
                          onMarkRead={() => markChannelRead(dm.id, currentUserId, true)}
                          onMarkUnread={() => void handleMarkChannelUnread(dm)}
                          onCopyLink={() => handleCopyChannelLink(dm)}
                          onSetPlacement={(p) => void handleSetChannelPlacement(dm, p)}
                          onRequestCreateGroup={() => {
                            setCreateGroupTarget(dm);
                            setNewGroupName('');
                          }}
                          onRequestArchive={() =>
                            setChannelLifecycleDialog({ action: 'archive', channel: dm })
                          }
                          onRequestUnarchive={() => void handleSetChannelArchived(dm, false)}
                          onRequestLeave={() =>
                            setChannelLifecycleDialog({ action: 'leave', channel: dm })
                          }
                          onRequestDelete={() =>
                            setChannelLifecycleDialog({ action: 'delete', channel: dm })
                          }
                          onCloseDm={() => void handleCloseDm(dm)}
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
                      topic={activeChannel.kind !== 'dm' ? activeChannel.topic : undefined}
                      members={channelMembersList}
                      participants={participants}
                      open={showMembersPanel}
                      canManage={activeChannel.kind !== 'dm'}
                      onOpen={() => setShowMembersPanel(true)}
                    />
                  ) : 'Select a channel'}
                  actions={activeChannel && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {unreadThreadsInChannel.length > 0 && (
                        <MenuRoot>
                          <MenuTrigger
                            render={
                              <Button
                                variant="quiet"
                                size="xs"
                                data-unread-threads-trigger="true"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  color: 'var(--accent-standard, #e5484d)',
                                  fontWeight: 600,
                                }}
                              >
                                <span
                                  aria-hidden="true"
                                  style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: '50%',
                                    background: 'var(--accent-standard, #e5484d)',
                                  }}
                                />
                                {unreadThreadsInChannel.length}{' '}
                                {unreadThreadsInChannel.length === 1 ? 'unread thread' : 'unread threads'}
                              </Button>
                            }
                          />
                          <MenuPopup align="end" size="compact">
                            {unreadThreadsInChannel.map((root) => (
                              <MenuItem
                                key={root.id}
                                data-unread-thread-jump={root.id}
                                onClick={() => {
                                  setThreadRoot(root);
                                  setActiveThreadRootId(root.id);
                                  openMessage(root);
                                }}
                              >
                                <span
                                  style={{
                                    maxWidth: 220,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {root.content.trim().slice(0, 48) || '[Attachment]'}
                                </span>
                                <span
                                  style={{
                                    marginLeft: 8,
                                    fontSize: 11,
                                    fontWeight: 600,
                                    color: 'var(--accent-standard, #e5484d)',
                                  }}
                                >
                                  {root.unreadReplyCount} new
                                </span>
                              </MenuItem>
                            ))}
                          </MenuPopup>
                        </MenuRoot>
                      )}
                      <ChannelPinsButton
                        ref={pinsButton}
                        open={showPinsPanel}
                        onToggle={() => {
                          if (showPinsPanel) closePins();
                          else {
                            setShowActivityPanel(false);
                            setSelectedAgentProfileId(null);
                            setTerminalSessionId(null);
                            setShowPinsPanel(true);
                          }
                        }}
                      />
                      <MenuRoot>
                        <MenuTrigger
                          render={
                            <IconButton
                              hint="familiar"
                              size="toolbar"
                              aria-label="Channel menu"
                              title="Channel actions"
                              icon={<DotsThreeIcon size={16} aria-hidden="true" />}
                            />
                          }
                        />
                        <MenuPopup align="end" size="compact">
                          {activeChannel.kind !== 'dm' &&
                            (!activeChannel.createdByUserId ||
                              activeChannel.createdByUserId === currentUserId) && (
                              <MenuItem onClick={() => openChannelSettings(activeChannel)}>
                                <MenuIcon>
                                  <GearIcon size={14} />
                                </MenuIcon>
                                Channel settings…
                              </MenuItem>
                            )}
                          <MenuItem
                            onClick={() =>
                              void handleToggleChannelMute(activeChannel, !activeChannel.muted)
                            }
                          >
                            <MenuIcon>
                              {activeChannel.muted ? <BellIcon size={14} /> : <BellSlashIcon size={14} />}
                            </MenuIcon>
                            {activeChannel.muted ? 'Unmute' : 'Mute'}
                          </MenuItem>
                          <MenuItem onClick={() => handleCopyChannelLink(activeChannel)}>
                            <MenuIcon>
                              <LinkIcon size={14} />
                            </MenuIcon>
                            Copy link
                          </MenuItem>
                          <MenuSeparator />
                          {activeChannel.kind === 'dm' ? (
                            <MenuItem onClick={() => void handleCloseDm(activeChannel)}>
                              <MenuIcon>
                                <XIcon size={14} />
                              </MenuIcon>
                              Close conversation
                            </MenuItem>
                          ) : activeChannel.archived ? (
                            (!activeChannel.createdByUserId ||
                              activeChannel.createdByUserId === currentUserId) && (
                              <MenuItem
                                onClick={() => void handleSetChannelArchived(activeChannel, false)}
                              >
                                <MenuIcon>
                                  <ArchiveOffIcon size={14} />
                                </MenuIcon>
                                Unarchive channel
                              </MenuItem>
                            )
                          ) : !activeChannel.createdByUserId ||
                            activeChannel.createdByUserId === currentUserId ? (
                            <>
                              <MenuItem
                                onClick={() =>
                                  setChannelLifecycleDialog({
                                    action: 'archive',
                                    channel: activeChannel,
                                  })
                                }
                              >
                                <MenuIcon>
                                  <ArchiveIcon size={14} />
                                </MenuIcon>
                                Archive channel
                              </MenuItem>
                              <MenuItem
                                tone="danger"
                                onClick={() =>
                                  setChannelLifecycleDialog({
                                    action: 'delete',
                                    channel: activeChannel,
                                  })
                                }
                              >
                                <MenuIcon>
                                  <TrashIcon size={14} />
                                </MenuIcon>
                                Delete channel
                              </MenuItem>
                            </>
                          ) : (
                            <MenuItem
                              tone="danger"
                              onClick={() =>
                                setChannelLifecycleDialog({
                                  action: 'leave',
                                  channel: activeChannel,
                                })
                              }
                            >
                              <MenuIcon>
                                <SignOutIcon size={14} />
                              </MenuIcon>
                              Leave channel
                            </MenuItem>
                          )}
                        </MenuPopup>
                      </MenuRoot>
                    </div>
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
                    channelMembers={channelMembersList}
                    channelMembersState={
                      !activeChannelId
                        ? 'loading'
                        : membersLoadedChannelId === activeChannelId
                          ? 'ready'
                          : membersError
                            ? 'error'
                            : 'loading'
                    }
                    currentUserId={currentUserId}
                    hasMore={hasMore}
                    loadingMore={loadingMore}
                    onLoadOlder={() => void handleLoadOlder()}
                    activeThreadRootId={activeThreadRootId}
                    threadRoot={threadRoot}
                    threadReplies={threadReplies}
                    timelineFocus={messageFocus?.channelId === activeChannelId ? messageFocus.timeline : undefined}
                    replyFocus={messageFocus?.channelId === activeChannelId ? messageFocus.reply : undefined}
                    unreadSince={unreadDivider?.channelId === activeChannelId ? unreadDivider.since : null}
                    typingLabels={activeTypingLabels}
                    editingMessageId={editingMessageId}
                    editingDraft={editingDraft}
                    onEditingDraftChange={setEditingDraft}
                    onStartEdit={(msg) => {
                      setEditingMessageId(msg.id);
                      setEditingDraft(msg.content);
                    }}
                    onSaveEdit={(id) => void handleSaveEdit(id)}
                    onCancelEdit={() => setEditingMessageId(null)}
                    onDelete={requestDeleteMessage}
                    onTogglePin={(msg) => void handleTogglePin(msg).catch((error: Error) => {
                      if (channelRef.current === msg.channelId) setNavigationError(error.message);
                    })}
                    onToggleReaction={(id, emoji) => void handleToggleReaction(id, emoji)}
                    onOpenThread={(id) => {
                      const cached = messages.find((m) => m.id === id) ?? null;
                      if (cached) setThreadRoot(cached);
                      setMessageFocus((current) => (current?.reply ? { ...current, reply: undefined } : current));
                      setActiveThreadRootId(id);
                    }}
                    onOpenReply={openMessage}
                    onCloseThread={() => {
                      setActiveThreadRootId(null);
                      setMessageFocus((current) => (current?.reply ? { ...current, reply: undefined } : current));
                    }}
                    onOpenTerminal={openTerminalSession}
                    onOpenMedia={(attachments, selectedId) =>
                      setMediaViewer({ attachments, selectedId })
                    }
                    onOpenAgentProfile={openAgentProfile}
                    onUploadFile={handleUploadFile}
                    onSendMessage={handleSendMessage}
                    onSendThreadReply={handleSendThreadReply}
                    onTyping={handleTyping}
                    onUnarchiveChannel={(channel) => void handleSetChannelArchived(channel, false)}
                  />
                </ComposerScopeProvider>
              </main>

              {detailPane && (
                <div
                  className={workspaceStyles.details}
                  data-pane={detailPane}
                  data-expanded={detailPane === 'terminal' && terminalExpanded ? 'true' : undefined}
                >
                  {showActivityPanel && (
                    <ActivityPanel
                      items={activityItems}
                      loading={activityLoading}
                      onRefresh={() => void loadActivity()}
                      onClose={() => setShowActivityPanel(false)}
                      onOpenMessage={(msg) => {
                        setShowActivityPanel(false);
                        openMessage(msg);
                      }}
                    />
                  )}

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
                      activeChannelId={activeChannelId}
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
                      onChannelMembersChanged={(channelId) => {
                        if (channelRef.current === channelId) {
                          setMembersRevision((revision) => revision + 1);
                        }
                      }}
                    />
                  )}

                  {/* Buzz-style Framed Botmux Terminal Pane */}
                  {terminalSessionId && (() => {
                    const activeTermSession = sessions.find(
                      (s) => s.sessionId === terminalSessionId,
                    );
                    const termAgentId =
                      activeTermSession?.larkAppId || terminalReturnAgentId || undefined;
                    const termAgent = termAgentId
                      ? agents.find((a) => a.id === termAgentId)
                      : undefined;
                    const siblingSessions = (
                      termAgentId
                        ? sessions.filter((s) => s.larkAppId === termAgentId)
                        : activeTermSession
                          ? [activeTermSession]
                          : []
                    ).map((s) => ({
                      sessionId: s.sessionId,
                      label: s.title || s.sessionId.slice(0, 8),
                      state: s.state || s.status || 'active',
                      workingDir: s.workingDir,
                    }));

                    return (
                      <TerminalPane
                        sessionId={terminalSessionId}
                        agent={termAgent}
                        sessionLabel={activeTermSession?.title}
                        sessionState={
                          activeTermSession?.state || activeTermSession?.status || 'active'
                        }
                        workingDir={activeTermSession?.workingDir}
                        siblingSessions={siblingSessions}
                        terminalUrl={activeTerminalLink?.url ?? null}
                        terminalLinkLoaded={Boolean(activeTerminalLink)}
                        historyContent={activeSessionHistory?.content ?? null}
                        showingHistory={Boolean(activeSessionHistory)}
                        actionBusy={sessionActionBusy}
                        expanded={terminalExpanded}
                        canReturnToProfile={Boolean(terminalReturnAgentId)}
                        onReturnToProfile={
                          terminalReturnAgentId
                            ? () => openAgentProfile(terminalReturnAgentId)
                            : undefined
                        }
                        onOpenAgentProfile={openAgentProfile}
                        onSelectSession={(nextSid) =>
                          openTerminalSession(nextSid, {
                            agentId: terminalReturnAgentId || termAgentId,
                          })
                        }
                        onSessionAction={(op) => void handleSessionAction(op)}
                        onToggleHistory={() => void handleLoadSessionHistory()}
                        onToggleExpand={() => setTerminalExpanded((v) => !v)}
                        onClose={() => {
                          setTerminalSessionId(null);
                          setTerminalReturnAgentId(null);
                        }}
                      />
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
        </Panel>
      </div>

      <NotificationSettingsDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        triggerRef={settingsButton}
        enabled={desktopNotifications}
        onEnabledChange={changeDesktopNotifications}
      />

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

      {/* Channel Lifecycle Confirmation Dialog (Archive / Delete / Leave) */}
      {channelLifecycleDialog && (
        <AlertDialog
          title={
            channelLifecycleDialog.action === 'delete'
              ? `Delete #${channelLifecycleDialog.channel.name}?`
              : channelLifecycleDialog.action === 'archive'
                ? `Archive #${channelLifecycleDialog.channel.name}?`
                : `Leave #${channelLifecycleDialog.channel.name}?`
          }
          description={
            channelLifecycleDialog.action === 'delete'
              ? '删除频道会永久移除该频道内的消息、置顶与成员记录，此操作不可撤销。'
              : channelLifecycleDialog.action === 'archive'
                ? '归档后该频道会折叠到「已归档频道」列表中，保留历史记录且随时可恢复。'
                : '退出后你将不再作为该频道成员接收自动推送，可随时重新加入。'
          }
          pending={channelLifecyclePending}
          onClose={() => setChannelLifecycleDialog(null)}
          actions={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button
                variant="quiet"
                size="sm"
                disabled={channelLifecyclePending}
                onClick={() => setChannelLifecycleDialog(null)}
              >
                Cancel
              </Button>
              <Button
                variant={channelLifecycleDialog.action === 'archive' ? 'primary' : 'destructive'}
                size="sm"
                loading={channelLifecyclePending}
                onClick={() => {
                  if (channelLifecycleDialog.action === 'delete') {
                    void handleDeleteChannel(channelLifecycleDialog.channel);
                  } else if (channelLifecycleDialog.action === 'archive') {
                    void handleSetChannelArchived(channelLifecycleDialog.channel, true);
                  } else {
                    void handleLeaveChannel(channelLifecycleDialog.channel);
                  }
                }}
              >
                {channelLifecycleDialog.action === 'delete'
                  ? 'Delete channel'
                  : channelLifecycleDialog.action === 'archive'
                    ? 'Archive channel'
                    : 'Leave channel'}
              </Button>
            </div>
          }
        />
      )}

      {/* Create Custom Sidebar Section Dialog */}
      {createGroupTarget && (
        <AlertDialog
          title="Create sidebar section"
          description={`新建自定义分组并将「${createGroupTarget.kind === 'dm' ? createGroupTarget.topic || createGroupTarget.name : `#${createGroupTarget.name}`}」移动到该分组。`}
          pending={creatingGroupPending}
          onClose={() => {
            setCreateGroupTarget(null);
            setNewGroupName('');
          }}
          actions={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button
                variant="quiet"
                size="sm"
                disabled={creatingGroupPending}
                onClick={() => {
                  setCreateGroupTarget(null);
                  setNewGroupName('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={creatingGroupPending}
                disabled={!newGroupName.trim()}
                onClick={() => void handleCreateSidebarGroup()}
              >
                Create &amp; Move
              </Button>
            </div>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreateSidebarGroup();
            }}
          >
            <Input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="Section name (e.g. Projects)"
              autoFocus
            />
          </form>
        </AlertDialog>
      )}

      {/* Rename Custom Sidebar Section Dialog */}
      {renameGroupTarget && (
        <AlertDialog
          title="Rename sidebar section"
          description={`修改自定义分组「${renameGroupTarget.name}」的名称。`}
          pending={renamingGroupPending}
          onClose={() => {
            setRenameGroupTarget(null);
            setRenameGroupName('');
          }}
          actions={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button
                variant="quiet"
                size="sm"
                disabled={renamingGroupPending}
                onClick={() => {
                  setRenameGroupTarget(null);
                  setRenameGroupName('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={renamingGroupPending}
                disabled={!renameGroupName.trim()}
                onClick={() => void handleRenameSidebarGroup()}
              >
                Save name
              </Button>
            </div>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleRenameSidebarGroup();
            }}
          >
            <Input
              value={renameGroupName}
              onChange={(e) => setRenameGroupName(e.target.value)}
              placeholder="Section name"
              autoFocus
            />
          </form>
        </AlertDialog>
      )}

      {/* Channel Settings Dialog (Rename / Topic / Bot Reply Mode) */}
      {channelSettingsTarget && (
        <AlertDialog
          title={`Channel settings · #${channelSettingsTarget.name}`}
          description="修改频道名称、主题说明以及 Bot 回复落点策略。"
          pending={settingsPending}
          onClose={() => {
            setChannelSettingsTarget(null);
            setSettingsError(null);
          }}
          actions={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button
                variant="quiet"
                size="sm"
                disabled={settingsPending}
                onClick={() => {
                  setChannelSettingsTarget(null);
                  setSettingsError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={settingsPending}
                disabled={!settingsName.trim()}
                onClick={() => void handleSaveChannelSettings()}
              >
                Save changes
              </Button>
            </div>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSaveChannelSettings();
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="text-caption text-subtle">Channel name</span>
              <Input
                value={settingsName}
                onChange={(e) => setSettingsName(e.target.value)}
                placeholder="channel-name"
                autoFocus
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="text-caption text-subtle">Topic</span>
              <Input
                value={settingsTopic}
                onChange={(e) => setSettingsTopic(e.target.value)}
                placeholder="What is this channel about?"
              />
            </label>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span className="text-caption text-subtle">Bot reply mode</span>
              <Select
                variant="compact"
                label="Bot reply mode"
                value={settingsReplyMode}
                groups={[
                  {
                    label: 'Reply destination',
                    options: [
                      { value: 'follow_source', label: 'Follow source (default)' },
                      { value: 'always_thread', label: 'Always thread' },
                      { value: 'always_main', label: 'Always main stream' },
                      { value: 'dm_main_channel_thread', label: 'DM main / Channel thread' },
                    ],
                  },
                ]}
                onValueChange={(value) => {
                  if (value) setSettingsReplyMode(value);
                }}
              />
            </div>
            {settingsError && (
              <div className="text-caption" style={{ color: 'var(--text-danger, #e5484d)' }} role="alert">
                {settingsError}
              </div>
            )}
          </form>
        </AlertDialog>
      )}

      {/* Delete Message Confirmation Dialog */}
      {deleteMessageTarget && (
        <AlertDialog
          title="Delete message?"
          description="删除后该消息将从频道中移除，此操作不可撤销。"
          pending={deleteMessagePending}
          onClose={() => setDeleteMessageTarget(null)}
          actions={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button
                variant="quiet"
                size="sm"
                disabled={deleteMessagePending}
                onClick={() => setDeleteMessageTarget(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                loading={deleteMessagePending}
                onClick={() => void handleConfirmDeleteMessage()}
              >
                Delete message
              </Button>
            </div>
          }
        >
          <div
            className="text-caption text-secondary"
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm, 6px)',
              background: 'var(--bg-subtle, rgba(128,128,128,0.08))',
              maxHeight: 80,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {deleteMessageTarget.content.trim().slice(0, 160) || '[Attachment]'}
          </div>
        </AlertDialog>
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

      {/* Phase 2 Auth & Community Dialogs */}
      <ProfileSettingsDialog
        open={showProfileSettings}
        user={auth.user}
        onOpenChange={setShowProfileSettings}
        onSaved={async () => {
          await auth.refreshSession();
        }}
      />
      <CommunityMembersDialog
        open={showCommunityMembers}
        activeOrg={auth.activeOrg}
        currentUserId={auth.user?.id}
        onOpenChange={setShowCommunityMembers}
      />
      <CreateCommunityDialog
        open={showCreateCommunity}
        onOpenChange={setShowCreateCommunity}
        onCreated={async (orgId) => {
          await auth.refreshOrganizations();
          await auth.switchOrganization(orgId);
        }}
      />
    </div>
  );
}
