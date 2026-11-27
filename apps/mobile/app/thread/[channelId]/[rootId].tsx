import { useMessageActions, useMessageScroll } from '@/store/useMessageActions';
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

  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useBuzzTheme();
  const {
    channels,
    client,
    serverUrl,
    authToken,
    currentUserId,
    participants,
    markThreadRead, wsState,
    subscribeWsEvents,
  } = useBubai();

  const participantMap = useMemo(
    () => new Map<string, Participant>(participants.map((p) => [p.id, p])),
    [participants],
  );

  const [root, setRoot] = useState<ChatMessage | null>(null);
  const [replies, setReplies] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const {draft, setDraft, editing, startEdit, cancelEdit, uploading, send: handleSendReply, attach, react: handleToggleReaction} =
    useMessageActions(channelId, rootId, (id, changes) => {
      if (id === rootId) setRoot(prev => prev ? {...prev, ...changes} : prev);
      setReplies(prev => prev.map(m => m.id === id ? {...m, ...changes} : m));
    });
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
      markThreadRead(channelId, rootId);
    } finally {
      setLoading(false);
    }
  }, [channelId, client, rootId, markThreadRead]);

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
        markThreadRead(channelId, rootId);
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
  }, [channelId, rootId, subscribeWsEvents, markThreadRead, router]);

  const allItems = useMemo(() => (root ? [root, ...replies] : replies), [replies, root]);
  const scroll = useMessageScroll(allItems, messageId);

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
            {...scroll}

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
          onCancelEdit={cancelEdit}
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
        onEdit={startEdit}
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
