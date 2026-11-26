import type { ChatMessage, Participant } from '@buzz-botmux/chat-client';
import { buzzGrid, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  const { channelId: rawCh, rootId: rawRoot } = useLocalSearchParams<{
    channelId: string;
    rootId: string;
  }>();
  const channelId = Array.isArray(rawCh) ? rawCh[0] : rawCh || '';
  const rootId = Array.isArray(rawRoot) ? rawRoot[0] : rawRoot || '';

  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useBuzzTheme();
  const {
    client,
    serverUrl,
    currentUserId,
    participants,
    sendWsMessage,
    subscribeWsEvents,
  } = useBubai();

  const participantMap = useMemo(
    () => new Map<string, Participant>(participants.map((p) => [p.id, p])),
    [participants],
  );

  const [root, setRoot] = useState<ChatMessage | null>(null);
  const [replies, setReplies] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [actionMessage, setActionMessage] = useState<ChatMessage | null>(null);

  const loadThread = useCallback(async () => {
    if (!client || !channelId || !rootId) return;
    setLoading(true);
    try {
      const data = await client.getThread(channelId, rootId);
      setRoot(data.root);
      setReplies(data.replies ?? []);
    } finally {
      setLoading(false);
    }
  }, [channelId, client, rootId]);

  useEffect(() => {
    void loadThread();
  }, [loadThread]);

  useEffect(() => {
    return subscribeWsEvents((event) => {
      if (event.type === 'message.created') {
        const msg = event.payload;
        if (msg.channelId !== channelId || msg.threadId !== rootId) return;
        setReplies((prev) => (prev.some((r) => r.id === msg.id) ? prev : [...prev, msg]));
      } else if (event.type === 'message.updated') {
        const msg = event.payload;
        if (msg.id === rootId) setRoot((prev) => (prev ? { ...prev, ...msg } : msg));
        if (msg.threadId === rootId) {
          setReplies((prev) => prev.map((r) => (r.id === msg.id ? { ...r, ...msg } : r)));
        }
      } else if (event.type === 'message.deleted') {
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
  }, [channelId, rootId, subscribeWsEvents]);

  const handleSendReply = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    const ok = sendWsMessage({ channelId, threadId: rootId, content: trimmed });
    if (ok) {
      setDraft('');
    } else {
      Alert.alert('未连接', 'WebSocket 正在重连，请稍后再试。');
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
            data={allItems}
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
          placeholder="Reply in thread… (可 @Agent)"
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
