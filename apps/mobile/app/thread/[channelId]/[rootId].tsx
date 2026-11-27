import { useDraft } from '@/store/useDraft';
import { pickAttachments } from '@/services/pickAttachments';
import type { ChatMessage, Participant } from '@buzz-botmux/chat-client';
import { buzzGrid, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BuzzComposer } from '@/components/BuzzComposer';
import { BuzzMessageBubble } from '@/components/BuzzMessageBubble';
import { MessageActionSheet } from '@/components/MessageActionSheet';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

export default function ThreadScreen() {
  const { channelId: rawCh, rootId: rawRoot, messageId } = useLocalSearchParams<{
    channelId: string;
    rootId: string;
    messageId?: string;
  }>();
  const channelId = Array.isArray(rawCh) ? rawCh[0] : rawCh || '';
  const rootId = Array.isArray(rawRoot) ? rawRoot[0] : rawRoot || '';

  const list = useRef<FlatList<ChatMessage>>(null);
  const jumped = useRef<string | undefined>(undefined);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useBuzzTheme();
  const {
    channels,
    client,
    serverUrl,
    activeOrgId,
    authToken,
    currentUserId,
    participants,
    sendWsMessage,
    wsState,
    subscribeWsEvents,
  } = useBubai();

  const participantMap = useMemo(
    () => new Map<string, Participant>(participants.map((p) => [p.id, p])),
    [participants],
  );

  const [root, setRoot] = useState<ChatMessage | null>(null);
  const [replies, setReplies] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useDraft(serverUrl, activeOrgId, currentUserId, channelId, rootId);
  const [actionMessage, setActionMessage] = useState<ChatMessage | null>(null);

  const loaded = useRef(false);
  const loadThread = useCallback(async () => {
    if (!client || !channelId || !rootId) return;
    if (!loaded.current) setLoading(true);
    try {
      const data = await client.getThread(channelId, rootId);
      loaded.current = true;
      setRoot(data.root);
      setReplies(data.replies ?? []);
      await client.markThreadRead(channelId, rootId, currentUserId);
    } finally {
      setLoading(false);
    }
  }, [channelId, client, rootId, currentUserId]);

  useEffect(() => {
    if (!loaded.current || wsState === 'open') void loadThread().catch(error => {
      if (error?.status !== 401 || !authToken) Alert.alert('加载失败', String(error));
    });
  }, [loadThread, wsState, authToken]);

  useEffect(() => {
    return subscribeWsEvents((event) => {
      if (event.type === 'message.created') {
        const msg = event.payload;
        if (msg.channelId !== channelId || msg.threadId !== rootId) return;
        void client?.markThreadRead(channelId, rootId, currentUserId).catch(() => {});
        setReplies((prev) => (prev.some((r) => r.id === msg.id) ? prev : [...prev, msg]));
      } else if (event.type === 'message.updated') {
        const msg = event.payload;
        if (msg.id === rootId) setRoot((prev) => (prev ? { ...prev, ...msg } : msg));
        if (msg.threadId === rootId) {
          setReplies((prev) => prev.map((r) => (r.id === msg.id ? { ...r, ...msg } : r)));
        }
      } else if (event.type === 'message.deleted') {
        if (event.payload.channelId !== channelId) return;
        if (event.payload.id === rootId) {
          router.replace(`/channel/${encodeURIComponent(channelId)}`);
          return;
        }
        setReplies((prev) => prev.filter((r) => r.id !== event.payload.id));
      } else if (event.type === 'reaction.updated') {
        const { messageId, reactions } = event.payload;
        if (messageId === rootId) {
          setRoot((prev) => (prev ? { ...prev, reactions } : prev));
        }
        setReplies((prev) =>
          prev.map((r) => (r.id === messageId ? { ...r, reactions } : r)),
        );
      }
    });
  }, [channelId, rootId, subscribeWsEvents, client, currentUserId, router]);

  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const attach = async () => {
    if (!client || uploading) return;
    setUploading(true);
    try {
      const attachments = await pickAttachments(client);
      if (!attachments.length) return;
      await sendWsMessage({ channelId, threadId: rootId, content: draft, attachments });
      setDraft(value => value === draft ? '' : value);
    } catch (error) {
      Alert.alert('附件发送失败', String(error));
    } finally {
      setUploading(false);
    }
  };
  const handleSendReply = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    try {
      if (editing && client) {
        await client.editMessage(editing.id, trimmed);
        setEditing(null);
      } else {
        await sendWsMessage({ channelId, threadId: rootId, content: trimmed });
      }
      setDraft(current => current.trim() === trimmed ? '' : current);
    } catch (error) {
      Alert.alert('发送失败', error instanceof Error ? error.message : String(error));
    }
  };

  const handleToggleReaction = async (messageId: string, emoji: string) => {
    if (!client) return;
    try {
      const res = await client.toggleReaction(messageId, emoji, currentUserId);
      const targetId = res.messageId || messageId;
      const nextReactions = res.reactions ?? [];
      if (targetId === rootId) {
        setRoot((prev) => (prev ? { ...prev, reactions: nextReactions } : prev));
      }
      setReplies((prev) =>
        prev.map((r) => (r.id === targetId ? { ...r, reactions: nextReactions } : r)),
      );
    } catch (err) {
      Alert.alert('表情操作失败', err instanceof Error ? err.message : '无法更新表情');
    }
  };

  const allItems = useMemo(() => (root ? [root, ...replies] : replies), [replies, root]);

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: colors.surface, paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: colors.outline }]}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={[buzzTypography.titleSmall, { color: colors.onSurface, flex: 1 }]}>
          Thread · {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
        </Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.onSurfaceVariant} />
          </View>
        ) : (
          <FlatList
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            data={allItems}
            ref={list}
            onScrollToIndexFailed={info => list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })}
            onContentSizeChange={() => {
              const index = allItems.findIndex(item => item.id === messageId);
              if (index >= 0 && messageId !== jumped.current) {
                jumped.current = messageId; list.current?.scrollToIndex({index, animated: false});
              }
            }}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingVertical: 12 }}
            renderItem={({ item, index }) => (
              <View>
                <BuzzMessageBubble
                  message={item}
                  sender={participantMap.get(item.senderId)}
                  currentUserId={currentUserId}
                  serverBaseUrl={serverUrl || ''}
                  stackPrevious={false}
                  stackNext={false}
                  showDayDivider={false}
                  inThread
                  onOpenTerminal={sid => router.push(`/terminal/${encodeURIComponent(sid)}`)}
                  onLongPress={setActionMessage}
                  onToggleReaction={(mid, emoji) => void handleToggleReaction(mid, emoji)}
                />
                {index === 0 && root && (
                  <View
                    style={[
                      styles.divider,
                      { borderBottomColor: colors.outline },
                    ]}
                  >
                    <Text style={[buzzTypography.micro, { color: colors.onSurfaceVariant }]}>
                      {replies.length} REPLIES
                    </Text>
                  </View>
                )}
              </View>
            )}
          />
        )}

        <BuzzComposer
          value={draft}
          onChangeText={setDraft}
          onSend={handleSendReply}
          uploading={uploading}
          onPickAttachment={editing ? undefined : attach}
          editingLabel={editing ? '编辑消息' : null}
          onCancelEdit={() => { setEditing(null); setDraft(''); }}
          placeholder="Reply in thread… (可 @Agent)"
          currentUserId={currentUserId}
          channel={channels.find(c => c.id === channelId)} messages={allItems} threadMessages={replies}
          participants={participants}
        />
      </KeyboardAvoidingView>

      <MessageActionSheet
        message={actionMessage}
        isOwn={Boolean(
          actionMessage &&
            actionMessage.senderRole === 'human' &&
            actionMessage.senderId === currentUserId,
        )}
        inThread
        onEdit={msg => { setEditing(msg); setDraft(msg.content); }}
        onDelete={msg => Alert.alert('删除消息？', undefined, [
          { text: '取消', style: 'cancel' },
          { text: '删除', style: 'destructive', onPress: () => void client?.deleteMessage(msg.id).catch(error => Alert.alert('删除失败', String(error))) },
        ])}
        onClose={() => setActionMessage(null)}
        onReact={(mid, emoji) => void handleToggleReaction(mid, emoji)}
      />
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
    padding: 6,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    marginHorizontal: buzzGrid.xs,
    marginVertical: 12,
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
