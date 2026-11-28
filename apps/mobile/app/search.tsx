import type { ChatMessage } from '@buzz-botmux/chat-client';
import { buzzGrid, buzzRadii, buzzTypography } from '@buzz-botmux/design-tokens';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBubai } from '@/store/BubaiProvider';
import { useBuzzTheme } from '@/theme/ThemeProvider';

export default function SearchScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useBuzzTheme();
  const { client, currentUserId, channels, participants } = useBubai();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatMessage[]>([]);
  const [searching, setSearching] = useState(false);

  const channelMap = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);
  const participantMap = useMemo(
    () => new Map(participants.map((p) => [p.id, p])),
    [participants],
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || !client) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void client
        .searchMessages(trimmed, currentUserId)
        .then((res) => {
          if (!cancelled) setResults(res.results ?? res.messages ?? []);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, currentUserId, query]);

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
        <View
          style={[
            styles.searchBox,
            { backgroundColor: colors.surfaceContainerLow, borderColor: colors.outline },
          ]}
        >
          <Ionicons name="search" size={16} color={colors.onSurfaceVariant} />
          <TextInput
            testID="message-search-input"
            value={query}
            onChangeText={setQuery}
            autoFocus
            placeholder="搜索消息内容…"
            placeholderTextColor={colors.onSurfaceVariant}
            style={[buzzTypography.body, styles.input, { color: colors.onSurface }]}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <Pressable accessibilityRole="button" accessibilityLabel="清除搜索内容" onPress={() => setQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={colors.onSurfaceVariant} />
            </Pressable>
          )}
        </View>
      </View>

      {searching ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.onSurfaceVariant} />
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={[buzzTypography.bodySmall, { color: colors.onSurfaceVariant }]}>
                {query.trim() ? '无匹配消息' : '输入关键词搜索全频道与私聊记录'}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const ch = channelMap.get(item.channelId);
            const sender = participantMap.get(item.senderId);
            return (
              <TouchableOpacity
                testID={`search-result-${item.id}`}
                onPress={() => router.push(item.threadId
                  ? { pathname: '/thread/[channelId]/[rootId]', params: { channelId: item.channelId, rootId: item.threadId, messageId: item.id } }
                  : { pathname: '/channel/[id]', params: { id: item.channelId, messageId: item.id } })}
                style={[
                  styles.card,
                  { backgroundColor: colors.surfaceContainerLow, borderColor: colors.outline },
                ]}
              >
                <Text style={[buzzTypography.caption, { color: colors.onSurfaceVariant }]}>
                  #{ch?.name || item.channelId} · {sender?.name || item.senderId}
                </Text>
                <Text
                  style={[buzzTypography.bodySmall, { color: colors.onSurface }]}
                  numberOfLines={3}
                >
                  {item.content}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { padding: 4 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 38,
    borderRadius: buzzRadii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  input: {
    flex: 1,
    paddingVertical: 0,
  },
  center: {
    paddingVertical: 64,
    alignItems: 'center',
  },
  list: {
    padding: buzzGrid.gutter,
    gap: 10,
  },
  card: {
    padding: 12,
    borderRadius: buzzRadii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
});
