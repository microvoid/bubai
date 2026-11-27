import { coalescedRefresh } from '@/store/coalescedRefresh';
import { BuzzButton, BuzzInput } from '@/components/BuzzComponents';
import { attachmentSource } from '@/services/attachments';
import { ChannelSettings } from '@/components/ChannelSettings';
import { useMessageActions, useMessageScroll } from '@/store/useMessageActions';
import type {
  ChannelMemberRow,
  ChatMessage,
  MessageAttachment,
  Participant,
} from '@buzz-botmux/chat-client';
import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BuzzAvatar } from '@/components/BuzzAvatar';
import { BuzzComposer } from '@/components/BuzzComposer';
import { BuzzMessageBubble, formatDayLabel } from '@/components/BuzzMessageBubble';
import { MessageActionSheet } from '@/components/MessageActionSheet';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

const GROUP_WINDOW_MS = 5 * 60 * 1000;

function sameGroup(prev: ChatMessage | undefined, curr: ChatMessage): boolean {
  if (!prev) return false;
  if (prev.senderId !== curr.senderId || prev.senderRole !== curr.senderRole) return false;
  if (Math.abs(curr.createdAt - prev.createdAt) > GROUP_WINDOW_MS) return false;
  return formatDayLabel(prev.createdAt) === formatDayLabel(curr.createdAt);
}

export default function ChannelScreen() {
  const { id, messageId } = useLocalSearchParams<{ id: string; messageId?: string }>();
  const focused = useRef(false);
  const loaded = useRef(false);
  const loadVersion = useRef(0);
  const channelId = Array.isArray(id) ? id[0] : id || '';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useBuzzTheme();
  const {
    client,
    serverUrl, authToken,
    currentUserId,
    channels,
    participants,
    asks,
    answerAsk,
    wsState,
    subscribeWsEvents,
    clearChannelUnread,
  } = useBubai();

  const channel = useMemo(
    () => channels.find((c) => c.id === channelId),
    [channelId, channels],
  );
  const participantMap = useMemo(
    () => new Map<string, Participant>(participants.map((p) => [p.id, p])),
    [participants],
  );

  const dmPeer = useMemo(() => {
    if (channel?.kind !== 'dm' || !channel.dmKey) return undefined;
    const keys = channel.dmKey.split('|');
    return participants.find(p => p.id !== currentUserId && keys.includes((p.role === 'agent' ? 'a:' : 'u:') + p.id));
  }, [channel, currentUserId, participants]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [nextCursorId, setNextCursorId] = useState<string>();
  const [loadingOlder, setLoadingOlder] = useState(false);

  const {draft, setDraft, editing: editingMessage, startEdit, cancelEdit, uploading, send: handleSend, attach: handlePickAttachment, react: handleToggleReaction} =
    useMessageActions(channelId, null, (id, changes) => setMessages(prev => prev.map(m => m.id === id ? {...m, ...changes} : m)));
  const [actionMessage, setActionMessage] = useState<ChatMessage | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<MessageAttachment | null>(null);

  const [pins, setPins] = useState<ChatMessage[]>([]);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [members, setMembers] = useState<ChannelMemberRow[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [membersOpen, setMembersOpen] = useState(false);

  const loadInitial = useCallback(async () => {
    if (!client || !channelId) return;
    const version = ++loadVersion.current;
    if (!loaded.current) setLoading(true);
    try {
      const [msgRes, pinRes, memRes] = await Promise.all([
        client.getChannelMessages(channelId, { limit: 50, userId: currentUserId }),
        client.getPins(channelId).catch(() => ({ pins: [] })),
        client.getChannelMembers(channelId).catch(() => ({ members: [] })),
      ]);
      if (!focused.current || version !== loadVersion.current) return;
      let page = msgRes;
      let history = page.messages;
      while (messageId && !history.some(m => m.id === messageId) && page.hasMore && page.nextCursor != null) {
        const older = await client.getChannelMessages(channelId, { userId: currentUserId, before: page.nextCursor, beforeId: page.nextCursorId, limit: 50 });
        if (!focused.current || !older.messages.length) break;
        history = [...older.messages, ...history];
        page = older;
      }
      if (!focused.current || version !== loadVersion.current) return;
      loaded.current = true;
      setMessages(history);
      setHasMore(Boolean(page.hasMore));
      setNextCursorId(page.nextCursorId);
      setNextCursor(page.nextCursor ?? null);
      setPins(pinRes.pins ?? []);
      setMembers(memRes.members ?? []);
      clearChannelUnread(channelId);
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [channelId, clearChannelUnread, client, currentUserId, messageId]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    if (!loaded.current || wsState === 'open') void loadInitial().catch(error => {
      if (error?.status !== 401 || !authToken) Alert.alert('加载失败', String(error));
    });
    return () => { focused.current = false; };
  }, [loadInitial, wsState, authToken]));

  // Live WS updates for this channel
  useEffect(() => {
    if (!client) return;
    const previews = coalescedRefresh((rootId: string) => client.getThreadPreview(channelId, rootId, currentUserId),
      (id, preview) => setMessages(prev => prev.map(m => m.id === id ? {...m, ...preview} : m)));
    const unsubscribe = subscribeWsEvents((event) => {
      if ((event.type === 'message.created' || event.type === 'message.updated' || event.type === 'message.deleted') &&
          event.payload.channelId === channelId && event.payload.threadId) {
        const rootId = event.payload.threadId;
        if (focused.current) previews.schedule(rootId);
      }
      if (event.type === 'message.created') {
        const msg = event.payload;
        if (msg.channelId !== channelId) return;
        if (msg.threadId) return;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        if (focused.current) clearChannelUnread(channelId);
      } else if (event.type === 'channel.members.updated' && event.payload.channelId === channelId) {
        setMembers(event.payload.members);
      } else if (event.type === 'message.updated') {
        const msg = event.payload;
        if (msg.channelId !== channelId) return;
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, ...msg } : m)));
      } else if (event.type === 'message.deleted') {
        if (event.payload.channelId !== channelId) return;
        setMessages((prev) => prev.filter((m) => m.id !== event.payload.id));
      } else if (event.type === 'reaction.updated') {
        const { messageId, reactions } = event.payload;
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
        );
      } else if (event.type === 'pins.updated') {
        if (event.payload.channelId !== channelId) return;
        setPins(event.payload.pins ?? []);
        const pinSet = new Set((event.payload.pins ?? []).map((p) => p.id));
        setMessages((prev) => prev.map((m) => ({ ...m, pinned: pinSet.has(m.id) })));
      }
    });
    return () => { unsubscribe(); previews.close(); };
  }, [channelId, clearChannelUnread, subscribeWsEvents, client, currentUserId]);

  const loadOlder = async () => {
    if (!client || !channelId || !hasMore || !nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await client.getChannelMessages(channelId, { before: nextCursor, beforeId: nextCursorId, userId: currentUserId, limit: 50 });
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const older = (res.messages ?? []).filter((m) => !seen.has(m.id));
        return [...older, ...prev];
      });
      setHasMore(Boolean(res.hasMore));
      setNextCursorId(res.nextCursorId);
      setNextCursor(res.nextCursor ?? null);
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleTogglePin = async (msg: ChatMessage) => {
    if (!client) return;
    try {
      const res = msg.pinned
        ? await client.unpinMessage(channelId, msg.id)
        : await client.pinMessage(channelId, msg.id, currentUserId);
      setPins(res.pins ?? []);
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, pinned: !msg.pinned } : m)),
      );
    } catch (err) {
      Alert.alert('置顶操作失败', err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleDelete = (msg: ChatMessage) => {
    Alert.alert('删除消息', '确定删除这条消息吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          if (!client) return;
          try {
            await client.deleteMessage(msg.id);
            setMessages((prev) => prev.filter((m) => m.id !== msg.id));
          } catch (err) {
            Alert.alert('删除失败', err instanceof Error ? err.message : '操作失败');
          }
        },
      },
    ]);
  };

  const handleToggleAutoReply = async (agentId: string, enabled: boolean) => {
    if (!client) return;
    try {
      await client.upsertChannelMember(channelId, { agentId, autoReply: enabled });
      const res = await client.getChannelMembers(channelId);
      setMembers(res.members ?? []);
    } catch (err) {
      Alert.alert('更新失败', err instanceof Error ? err.message : '无法更新自动回复设置');
    }
  };

  // Inverted list data: newest at index 0
  const invertedMessages = useMemo(() => [...messages].reverse(), [messages]);
  const scroll = useMessageScroll(invertedMessages, messageId);

  const title =
    channel?.kind === 'dm'
      ? dmPeer?.name || channel.topic || channel.name
      : `#${channel?.name || 'channel'}`;

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: colors.surface, paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      {/* Top Header */}
      <View
        style={[
          styles.header,
          { borderBottomColor: colors.outline, backgroundColor: colors.surface },
        ]}
      >
        <Pressable onPress={() => router.back()} style={styles.iconBtn} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </Pressable>

        <View style={styles.headerCenter}>
          {dmPeer && (
            <BuzzAvatar
              name={dmPeer.name}
              uri={dmPeer.avatarUrl}
              size={28}
              isAgent={dmPeer.role === 'agent'}
              status={dmPeer.status}
            />
          )}
          <View style={{ minWidth: 0 }}>
            <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]} numberOfLines={1}>
              {title}
            </Text>
            {!!channel?.topic && channel.kind !== 'dm' && (
              <Text
                style={[buzzTypography.micro, { color: colors.onSurfaceVariant }]}
                numberOfLines={1}
              >
                {channel.topic}
              </Text>
            )}
          </View>
        </View>

        <View style={styles.headerActions}>
          <Pressable onPress={() => setPinsOpen(true)} style={styles.iconBtn} hitSlop={6}>
            <Ionicons name="pin-outline" size={20} color={colors.onSurface} />
            {pins.length > 0 && (
              <Text style={[buzzTypography.micro, { color: colors.onSurfaceVariant }]}>
                {pins.length}
              </Text>
            )}
          </Pressable>
          {channel && (
            <Pressable accessibilityLabel="频道设置与成员" onPress={() => setMembersOpen(true)} style={styles.iconBtn} hitSlop={6}>
              <Ionicons name="people-outline" size={20} color={colors.onSurface} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Pending Asks Inline Bar */}
      {asks.length > 0 && (
        <View
          style={[
            styles.askBanner,
            { backgroundColor: colors.surfaceContainerLow, borderBottomColor: colors.outline },
          ]}
        >
          <View style={{ flex: 1 }}>
            <Text style={[buzzTypography.label, { color: colors.onSurface }]} numberOfLines={1}>
              {asks[0].botName || asks[0].larkAppId} 等待审批
            </Text>
            <Text
              style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}
              numberOfLines={1}
            >
              {asks[0].questions?.[0]?.question || asks[0].prompt || asks[0].title || asks[0].askId}
            </Text>
          </View>
          <Pressable
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              void answerAsk(asks[0], asks[0].questions?.[0]?.options?.[0]?.key || 'approve');
            }}
            style={[styles.askQuickBtn, { backgroundColor: colors.primary }]}
          >
            <Text style={[buzzTypography.micro, { color: colors.onPrimary }]}>
              {asks[0].questions?.[0]?.options?.[0]?.label || '批准'}
            </Text>
          </Pressable>
        </View>
      )}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.onSurfaceVariant} />
          </View>
        ) : (
          <FlatList
            {...scroll}
            inverted

            data={invertedMessages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.listContent}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onEndReached={() => void loadOlder()}
            onEndReachedThreshold={0.2}
            ListFooterComponent={
              loadingOlder ? (
                <View style={{ paddingVertical: 12 }}>
                  <ActivityIndicator size="small" color={colors.onSurfaceVariant} />
                </View>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Ionicons name="sparkles-outline" size={28} color={colors.onSurfaceVariant} />
                <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                  {title}
                </Text>
                <Text
                  style={[
                    buzzTypography.bodySmall,
                    { color: colors.onSurfaceVariant, textAlign: 'center' },
                  ]}
                >
                  {channel?.kind === 'dm'
                    ? '私聊模式：直接发消息即可与该 Agent 对话（无需 @）。'
                    : '输入 @ 提及 Agent 开始协作对话。'}
                </Text>
              </View>
            }
            renderItem={({ item, index }) => {
              // In inverted list, chronological previous is index + 1, next is index - 1
              const chronoPrev = invertedMessages[index + 1];
              const chronoNext = invertedMessages[index - 1];
              const stackPrevious = sameGroup(chronoPrev, item);
              const stackNext = chronoNext ? sameGroup(item, chronoNext) : false;
              const showDayDivider =
                !chronoPrev || formatDayLabel(chronoPrev.createdAt) !== formatDayLabel(item.createdAt);

              return (
                <BuzzMessageBubble
                  message={item}
                  sender={participantMap.get(item.senderId)}
                  currentUserId={currentUserId}
                  serverBaseUrl={serverUrl || ''}
                  stackPrevious={stackPrevious}
                  stackNext={stackNext}
                  showDayDivider={showDayDivider}
                  onLongPress={setActionMessage}
                  onToggleReaction={(mid, emoji) => void handleToggleReaction(mid, emoji)}
                  onOpenThread={(msg) =>
                    router.push(`/thread/${encodeURIComponent(channelId)}/${encodeURIComponent(msg.id)}`)
                  }
                  onOpenImage={setPreviewAttachment}
                  onOpenAgentProfile={(aid) =>
                    router.push(
                      `/agent/${encodeURIComponent(aid)}?channelId=${encodeURIComponent(channelId)}`,
                    )
                  }
                  onOpenTerminal={(sid) =>
                    router.push(
                      `/terminal/${encodeURIComponent(sid)}?agentId=${encodeURIComponent(item.senderId)}`,
                    )
                  }
                />
              );
            }}
          />
        )}

        <BuzzComposer
          value={draft}
          onChangeText={setDraft}
          onSend={() => void handleSend()}
          onPickAttachment={() => void handlePickAttachment()}
          uploading={uploading}
          placeholder={
            channel?.kind === 'dm'
              ? `Message ${dmPeer?.name || title}…`
              : `Message #${channel?.name || 'channel'}… (输入 @ 召唤 Agent)`
          }
          currentUserId={currentUserId}
          channel={channel} messages={messages}
          participants={participants}
          editingLabel={editingMessage ? `正在编辑消息…` : null}
          onCancelEdit={cancelEdit}
        />
      </KeyboardAvoidingView>

      {/* Long-Press Message Action Sheet */}
      <MessageActionSheet
        message={actionMessage}
        isOwn={Boolean(
          actionMessage &&
            actionMessage.senderRole === 'human' &&
            actionMessage.senderId === currentUserId,
        )}
        onClose={() => setActionMessage(null)}
        onReact={(mid, emoji) => void handleToggleReaction(mid, emoji)}
        onReplyThread={(msg) =>
          router.push(`/thread/${encodeURIComponent(channelId)}/${encodeURIComponent(msg.id)}`)
        }
        onTogglePin={(msg) => void handleTogglePin(msg)}
        onEdit={startEdit}
        onDelete={handleDelete}
      />

      {/* Pins Sheet */}
      <Modal visible={pinsOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPinsOpen(false)}>
        <View style={[styles.root, { backgroundColor: colors.surface, paddingTop: Platform.OS === 'android' ? insets.top : 8 }]}>
          <View style={[styles.header, { borderBottomColor: colors.outline }]}>
            <Text style={[buzzTypography.title, { color: colors.onSurface, flex: 1 }]}>
              Pinned Messages ({pins.length})
            </Text>
            <Pressable onPress={() => setPinsOpen(false)} style={styles.iconBtn}>
              <Ionicons name="close" size={22} color={colors.onSurface} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={[styles.sheetScroll, { paddingBottom: Math.max(insets.bottom, 20) }]}>
            {pins.length === 0 ? (
              <Text style={[buzzTypography.bodySmall, { color: colors.onSurfaceVariant }]}>
                暂无置顶消息
              </Text>
            ) : (
              pins.map((p) => (
                <View
                  key={p.id}
                  style={[
                    styles.pinCard,
                    { backgroundColor: colors.surfaceContainerLow, borderColor: colors.outline },
                  ]}
                >
                  <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
                    {participantMap.get(p.senderId)?.name || p.senderId}
                  </Text>
                  <Text style={[buzzTypography.bodySmall, { color: colors.onSurface }]}>
                    {p.content}
                  </Text>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Channel Members & Agent autoReply Sheet */}
      <Modal visible={membersOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setMembersOpen(false)}>
        <View style={[styles.root, { backgroundColor: colors.surface, paddingTop: Platform.OS === 'android' ? insets.top : 8 }]}>
          <View style={[styles.header, { borderBottomColor: colors.outline }]}>
            <Text style={[buzzTypography.title, { color: colors.onSurface, flex: 1 }]}>
              频道设置与成员
            </Text>
            <Pressable onPress={() => setMembersOpen(false)} style={styles.iconBtn}>
              <Ionicons name="close" size={22} color={colors.onSurface} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={[styles.sheetScroll, { paddingBottom: Math.max(insets.bottom, 20) }]}>
            {channel && <ChannelSettings channel={channel} leave={() => { setMembersOpen(false); router.replace('/(tabs)'); }} />}
            <BuzzInput placeholder="搜索成员" value={memberSearch} onChangeText={setMemberSearch} style={{ color: colors.onSurface }} />
            {participants.filter(p => !p.archived && p.name.toLowerCase().includes(memberSearch.toLowerCase())).map((agent) => {
              const row = members.find(m => (m.agentId || m.userId) === agent.id);
              const identity = agent.role === 'agent' ? { agentId: agent.id } : { userId: agent.id };
              const enabled = Boolean(row?.autoReply);
              return (
                <View
                  key={agent.id}
                  style={[
                    styles.memberRow,
                    { backgroundColor: colors.surfaceContainerLow, borderColor: colors.outline },
                  ]}
                >
                  <BuzzAvatar
                    name={agent.name}
                    uri={agent.avatarUrl}
                    size={36}
                    isAgent
                    status={agent.status}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={[buzzTypography.titleSmall, { color: colors.onSurface }]}>
                      {agent.name}
                    </Text>
                    <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
                      {agent.role} · {row ? '频道成员' : '频道外'}
                    </Text>
                  </View>
                  <BuzzButton title={row ? '移除' : '添加'} onPress={async () => {
                    if (!client) return;
                    try {
                      if (row) await client.removeChannelMember(channelId, identity);
                      else await client.upsertChannelMember(channelId, identity);
                      setMembers((await client.getChannelMembers(channelId)).members);
                    } catch (error) { Alert.alert('成员更新失败', String(error)); }
                  }} />
                  {row && agent.role === 'agent' && <Switch
                    value={enabled}
                    onValueChange={(v) => void handleToggleAutoReply(agent.id, v)}
                  />}
                </View>
              );
            })}
          </ScrollView>
        </View>
      </Modal>

      {/* Full-Screen Image Preview */}
      <Modal
        visible={Boolean(previewAttachment)}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewAttachment(null)}
      >
        <Pressable
          style={[styles.imageModal, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
          onPress={() => setPreviewAttachment(null)}
        >
          <Pressable
            onPress={() => setPreviewAttachment(null)}
            style={{
              position: 'absolute',
              top: insets.top + 12,
              right: 16,
              zIndex: 10,
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: 'rgba(255,255,255,0.18)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="close" size={22} color="#fff" />
          </Pressable>
          {previewAttachment && (
            <Image
              source={attachmentSource(serverUrl!, previewAttachment.url, authToken)}
              style={styles.fullImage}
              resizeMode="contain"
            />
          )}
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    height: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    padding: 6,
  },
  headerCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  askBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: buzzGrid.xs,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  askQuickBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: buzzRadii.pill,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    paddingVertical: 12,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 80,
    gap: 8,
  },
  sheetScroll: {
    padding: buzzGrid.gutter,
    gap: 10,
  },
  pinCard: {
    padding: 14,
    borderRadius: buzzRadii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: buzzRadii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  imageModal: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullImage: {
    width: '94%',
    height: '80%',
  },
});
