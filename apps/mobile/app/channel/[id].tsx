import type {
  ChannelMemberRow,
  ChatMessage,
  MessageAttachment,
  Participant,
} from '@buzz-botmux/chat-client';
import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  const { id } = useLocalSearchParams<{ id: string }>();
  const channelId = Array.isArray(id) ? id[0] : id || '';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useBuzzTheme();
  const {
    client,
    serverUrl,
    currentUserId,
    channels,
    participants,
    asks,
    answerAsk,
    sendWsMessage,
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
  const agents = useMemo(
    () => participants.filter((p) => p.role === 'agent' && !p.archived),
    [participants],
  );

  const dmAgent = useMemo(() => {
    if (channel?.kind !== 'dm' || !channel.dmKey) return undefined;
    return participants.find((p) => p.role === 'agent' && channel.dmKey?.includes(`a:${p.id}`));
  }, [channel, participants]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(null);
  const [actionMessage, setActionMessage] = useState<ChatMessage | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<MessageAttachment | null>(null);

  const [pins, setPins] = useState<ChatMessage[]>([]);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [members, setMembers] = useState<ChannelMemberRow[]>([]);
  const [membersOpen, setMembersOpen] = useState(false);

  const loadInitial = useCallback(async () => {
    if (!client || !channelId) return;
    setLoading(true);
    try {
      const [msgRes, pinRes, memRes] = await Promise.all([
        client.getChannelMessages(channelId, { limit: 50 }),
        client.getPins(channelId).catch(() => ({ pins: [] })),
        client.getChannelMembers(channelId).catch(() => ({ members: [] })),
      ]);
      setMessages(msgRes.messages ?? []);
      setHasMore(Boolean(msgRes.hasMore));
      setNextCursor(msgRes.nextCursor ?? null);
      setPins(pinRes.pins ?? []);
      setMembers(memRes.members ?? []);
      clearChannelUnread(channelId);
    } finally {
      setLoading(false);
    }
  }, [channelId, clearChannelUnread, client]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  // Live WS updates for this channel
  useEffect(() => {
    return subscribeWsEvents((event) => {
      if (event.type === 'message.created') {
        const msg = event.payload;
        if (msg.channelId !== channelId) return;
        if (msg.threadId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msg.threadId ? { ...m, replyCount: (m.replyCount ?? 0) + 1 } : m,
            ),
          );
          return;
        }
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        clearChannelUnread(channelId);
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
  }, [channelId, clearChannelUnread, subscribeWsEvents]);

  const loadOlder = async () => {
    if (!client || !channelId || !hasMore || !nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await client.getChannelMessages(channelId, { before: nextCursor, limit: 50 });
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const older = (res.messages ?? []).filter((m) => !seen.has(m.id));
        return [...older, ...prev];
      });
      setHasMore(Boolean(res.hasMore));
      setNextCursor(res.nextCursor ?? null);
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleSend = async () => {
    const trimmed = draft.trim();
    if (!trimmed || !channelId) return;

    if (editingMessage && client) {
      const target = editingMessage;
      setDraft('');
      setEditingMessage(null);
      try {
        const { message } = await client.editMessage(target.id, trimmed);
        setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, ...message } : m)));
      } catch (err) {
        Alert.alert('编辑失败', err instanceof Error ? err.message : '无法保存编辑');
      }
      return;
    }

    const ok = sendWsMessage({ channelId, content: trimmed });
    if (ok) {
      setDraft('');
    } else {
      Alert.alert('未连接', 'WebSocket 正在重连，请稍后再试。');
    }
  };

  const handlePickAttachment = async () => {
    if (!client || !channelId || uploading) return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('需要相册权限', '请在系统设置中允许 Bubai 访问照片以发送图片。');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.85,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      setUploading(true);
      const formData = new FormData();
      formData.append('file', {
        uri: asset.uri,
        name: asset.fileName || `photo-${Date.now()}.jpg`,
        type: asset.mimeType || 'image/jpeg',
      } as unknown as Blob);
      const attachment = await client.uploadFile(formData);
      const caption = draft.trim();
      const ok = sendWsMessage({
        channelId,
        content: caption || `[Image: ${attachment.name}]`,
        attachments: [attachment],
      });
      if (ok && caption) setDraft('');
      if (!ok) Alert.alert('未连接', '图片已上传，但 WebSocket 正在重连，请稍后重试。');
    } catch (err) {
      Alert.alert('上传失败', err instanceof Error ? err.message : '无法上传附件');
    } finally {
      setUploading(false);
    }
  };

  const handleToggleReaction = async (messageId: string, emoji: string) => {
    if (!client) return;
    try {
      const res = await client.toggleReaction(messageId, emoji, currentUserId);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === (res.messageId || messageId) ? { ...m, reactions: res.reactions ?? [] } : m,
        ),
      );
    } catch (err) {
      Alert.alert('表情操作失败', err instanceof Error ? err.message : '无法更新表情');
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

  const title =
    channel?.kind === 'dm'
      ? dmAgent?.name || channel.topic || channel.name
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
          {dmAgent && (
            <BuzzAvatar
              name={dmAgent.name}
              uri={dmAgent.avatarUrl}
              size={28}
              isAgent
              status={dmAgent.status}
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
          {channel?.kind !== 'dm' && (
            <Pressable onPress={() => setMembersOpen(true)} style={styles.iconBtn} hitSlop={6}>
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
                    : '输入 @ 召唤 Botmux Agent 开始协作对话。'}
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
              ? `Message ${dmAgent?.name || 'Agent'}…`
              : `Message #${channel?.name || 'channel'}… (输入 @ 召唤 Agent)`
          }
          participants={participants}
          editingLabel={editingMessage ? `正在编辑消息…` : null}
          onCancelEdit={() => {
            setEditingMessage(null);
            setDraft('');
          }}
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
        onEdit={(msg) => {
          setEditingMessage(msg);
          setDraft(msg.content);
        }}
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
              Channel Agents & Auto-Reply
            </Text>
            <Pressable onPress={() => setMembersOpen(false)} style={styles.iconBtn}>
              <Ionicons name="close" size={22} color={colors.onSurface} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={[styles.sheetScroll, { paddingBottom: Math.max(insets.bottom, 20) }]}>
            {agents.map((agent) => {
              const row = members.find((m) => m.agentId === agent.id);
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
                      自动响应频道消息（无需 @）
                    </Text>
                  </View>
                  <Switch
                    value={enabled}
                    onValueChange={(v) => void handleToggleAutoReply(agent.id, v)}
                  />
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
              source={{
                uri: /^https?:\/\//i.test(previewAttachment.url)
                  ? previewAttachment.url
                  : `${serverUrl || ''}${previewAttachment.url}`,
              }}
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
